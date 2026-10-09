"""Accurate SOURCE context over real loopback HTTP, with all model calls mocked."""
import json
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from review_desk.server import ReviewHandler, ReviewServer
from review_desk.store import Store
from test_review import SOURCE
from test_methods import seed


class PolishRevisionHTTPTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='polish-revision-test-')
        self.root = Path(self.temp.name)
        store = Store(self.root / '.runtime/review.sqlite3')
        seed(store)
        store.put_source(SOURCE)
        self.old = next(row for row in store.objects() if row['id'] == SOURCE['id'])['current_revision']
        store.put_source({**SOURCE, 'id': 'other-source'})
        self.other = next(row for row in store.objects() if row['id'] == 'other-source')['current_revision']
        store.replace_source_metadata(SOURCE['id'], {'title': 'Technical current title'})
        self.current = next(row for row in store.objects() if row['id'] == SOURCE['id'])['current_revision']
        self.before = [tuple(row) for row in store.db.execute('SELECT * FROM revisions ORDER BY id')]
        store.close()
        ready = queue.Queue()

        class QuietHandler(ReviewHandler):
            def log_message(self, *_args):
                pass

        def serve():
            with ReviewServer(('127.0.0.1', 0), self.root, {'id': 'polish-test', 'title': 'Technical model stub only'}) as server:
                server.RequestHandlerClass = QuietHandler
                ready.put(server)
                server.serve_forever(poll_interval=.01)

        self.stub_patch = patch('review_desk.server.suggest', side_effect=lambda preview, store: {
            'suggestion': '[MOCK ONLY] technical opinion', 'saved': False,
            'context_sha256': preview['context_sha256']})
        self.stub = self.stub_patch.start()
        self.addCleanup(self.stub_patch.stop)
        self.thread = threading.Thread(target=serve, daemon=True)
        self.thread.start()
        self.server = ready.get(timeout=5)
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.http = build_opener(ProxyHandler({}))
        self.request = {'source_id': SOURCE['id'], 'target_revision_id': self.current,
                        'anchor': {'type': 'text', 'block_id': 'a', 'end_block_id': 'a', 'start': 1, 'end': 3, 'quote': '乙𪎊'},
                        'body': 'Technical opinion only'}

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())
        store = Store(self.root / '.runtime/review.sqlite3')
        self.assertEqual(store.comments(), [])
        self.assertEqual(store.events(), [])
        self.assertEqual([tuple(row) for row in store.db.execute('SELECT * FROM revisions ORDER BY id')], self.before)
        store.close()
        self.temp.cleanup()

    def post(self, endpoint, payload):
        request = Request(self.base + endpoint, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with self.http.open(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_explicit_stale_other_empty_or_unknown_revision_cannot_use_the_current_head(self):
        for revision in (self.old, self.other, '', 'unknown'):
            for endpoint in ('/api/comments/polish-context', '/api/comments/polish'):
                status, result = self.post(endpoint, {**self.request, 'target_revision_id': revision})
                self.assertEqual(status, 400, (revision, endpoint, result))
                self.assertIn('资料版本已变化或不可用', result['error'])
                self.assertIn('保留当前意见', result['error'])
        self.stub.assert_not_called()

    def test_current_revision_and_legacy_omitted_revision_preserve_context_and_stub_contract(self):
        for explicit in (True, False):
            value = dict(self.request)
            if not explicit:
                value.pop('target_revision_id')
            status, context = self.post('/api/comments/polish-context', value)
            self.assertEqual(status, 200, context)
            self.assertEqual(context['context']['source_documents'][0]['title'], 'Technical current title')
            self.assertEqual(context['context']['selected_quote'], '乙𪎊')
            self.assertFalse(context['saved'])
            status, suggestion = self.post('/api/comments/polish', {**value, 'expected_context_sha256': context['context_sha256']})
            self.assertEqual(status, 200, suggestion)
            self.assertTrue(suggestion['suggestion'].startswith('[MOCK ONLY]'))
            self.assertFalse(suggestion['saved'])
        self.assertEqual(self.stub.call_count, 2)

    def test_changed_context_digest_never_reaches_the_model_stub(self):
        status, result = self.post('/api/comments/polish', {**self.request, 'expected_context_sha256': 'stale-context'})
        self.assertEqual(status, 409)
        self.assertIn('上下文已变化', result['error'])
        self.stub.assert_not_called()
