"""Private HTTP and transaction probes; run from desk with PYTHONPATH=.:tests."""
from contextlib import contextmanager
import http.client
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from review_desk import editing_api, production as p, resources, read_cache
from review_desk.server import ReviewServer, ReviewHandler
from review_desk.store import Store


class CrossGroupProbe(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='read-contract-')
        self.root = Path(self.temp.name)
        self.store = Store(self.root / '.runtime/review.sqlite3')

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    @contextmanager
    def server(self):
        server = ReviewServer(('127.0.0.1', 0), self.root, {'title': 'Private cross-group review'})
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_real_http_disconnect_cancels_read_actions_and_releases_scopes(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        sample = {}
        original = ReviewHandler.handle_one_request

        def read(store, root, action, value):
            sample['transaction_during'] = store.db.in_transaction
            sample['resource_check_during'] = callable(resources._cancel.get())
            entered.set()
            if not release.wait(3):
                raise TimeoutError('private probe failed to release reader')
            try:
                check = resources._check_cancel if sample['resource'] else lambda: p.check_read(store)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    check()
                    # The client's FIN can arrive after the probe releases its
                    # barrier. Continue at bounded read boundaries until then.
                    time.sleep(.005)
            except p.ReadCancelled:
                sample['cancelled'] = True
                raise
            sample['continued'] = True
            return {}

        def handler(instance):
            try:
                return original(instance)
            finally:
                store = getattr(instance.server._local, 'store', None)
                sample['transaction_after'] = bool(store and store.db.in_transaction)
                sample['scope_after'] = hasattr(store, '_production_reads')
                sample['leases_after'] = resources._leases.get()
                sample['resource_check_after'] = resources._cancel.get()
                finished.set()

        with patch.object(editing_api, '_dispatch', read), \
             patch.object(ReviewHandler, 'handle_one_request', handler), \
             patch.object(ReviewHandler, 'log_message', lambda *args: None), self.server() as server:
            for method in ('GET', 'POST'):
                for index, action in enumerate(('catalog', 'get', 'status', 'review')):
                    with self.subTest(method=method, action=action):
                        sample.clear(); sample['resource'] = bool(index % 2)
                        entered.clear(); release.clear(); finished.clear()
                        client = socket.create_connection(server.server_address, timeout=3)
                        body = b'{}' if method == 'POST' else b''
                        request = (f'{method} /api/editing/{action} HTTP/1.1\r\nHost: 127.0.0.1\r\n'
                                   f'Connection: close\r\nContent-Length: {len(body)}\r\n\r\n').encode() + body
                        try:
                            client.sendall(request)
                            self.assertTrue(entered.wait(3))
                        finally:
                            client.shutdown(socket.SHUT_RDWR)
                            client.close()
                            release.set()
                        self.assertTrue(finished.wait(3))
                        self.assertTrue(sample['transaction_during'])
                        self.assertTrue(sample['resource_check_during'])
                        self.assertTrue(sample.get('cancelled'), dict(sample))
                        self.assertFalse(sample.get('continued'))
                        self.assertFalse(sample['transaction_after'])
                        self.assertFalse(sample['scope_after'])
                        self.assertIsNone(sample['leases_after'])
                        self.assertIsNone(sample['resource_check_after'])

    def test_dispatch_write_actions_do_not_take_read_cancellation_scope(self):
        def cancelled():
            self.fail('write action checked reader cancellation')

        def save(store, root, project, expected_version):
            self.assertFalse(hasattr(store, '_production_reads'))
            self.assertFalse(store.db.in_transaction)
            return {'saved': True}

        with patch.object(editing_api.edit, 'save', save):
            result = editing_api.dispatch(self.store, self.root, 'save',
                {'project': {}, 'expected_version': 1}, cancel_check=cancelled)
        self.assertEqual(result, {'saved': True})

    def test_comment_close_invalidates_comment_domain_but_source_change_invalidates_both(self):
        row = self.store.put_object('episode', 'EPISODE', {'title': 'First', 'blocks': [{'id': 'a', 'text': 'Source'}]})
        comment = self.store.create_comment({'target_object_id': 'episode', 'target_revision_id': row['revision'],
            'anchor': {'type': 'text', 'block_id': 'a', 'end_block_id': 'a', 'start': 0, 'end': 6, 'quote': 'Source'},
            'body': 'Private probe'})
        read_cache.attach(self.store)
        calls = {'content': 0, 'comment': 0}

        def title():
            calls['content'] += 1
            return p.record(self.store, 'episode')['payload']['title']

        def status():
            calls['comment'] += 1
            return self.store.comment(comment['id'])['status']

        def both():
            with p.read_scope(self.store):
                return (read_cache.read_json(self.store, 'cross-title', title, domain='content'),
                        read_cache.read_json(self.store, 'cross-comment', status))

        self.assertEqual(both()[0], 'First')
        fresh = self.store.create_comment({'target_object_id':'episode', 'target_revision_id':row['revision'],
            'anchor':{'type':'text','block_id':'a','end_block_id':'a','start':0,'end':6,'quote':'Source'},
            'body':'Another private comment'})
        self.assertTrue(self.store.comment(fresh['id']))
        self.assertEqual(both(), ('First', 'OPEN'))
        self.assertEqual(calls, {'content':1, 'comment':2})
        self.store.change_comment(comment['id'], 'CLOSE', 1)
        self.assertEqual(both(), ('First', 'CLOSED'))
        self.assertEqual(calls, {'content': 1, 'comment': 3})
        self.store.put_object('episode', 'EPISODE', {'title': 'Second', 'blocks': [{'id': 'a', 'text': 'Source'}]}, 1)
        self.assertEqual(both(), ('Second', 'CLOSED'))
        self.assertEqual(calls, {'content': 2, 'comment': 4})

    def test_http_summary_and_post_get_preserve_exact_output(self):
        episode = self.store._insert_object('episode', 'AV_EPISODE', {'title': 'Test', 'number': 1, 'scenes': []})
        reference = {'object_id': 'episode', 'revision_id': episode}
        payload = {'title': 'Frozen output', 'project': {'episode': reference}, 'components': []}
        revision = self.store._insert_object('film', 'EPISODE_FILM', payload)
        with self.server() as server:
            client = http.client.HTTPConnection(*server.server_address, timeout=3)
            try:
                client.request('GET', '/api/editing/catalog?summary=1')
                response = client.getresponse(); self.assertEqual(response.status, 200)
                selected = json.loads(response.read())['outputs'][0]
                self.assertEqual((selected['object_id'], selected['id']), ('film', revision))
                self.assertTrue(selected['summary'])
                client.request('POST', '/api/editing/get', json.dumps({'object_id': 'film', 'revision_id': revision}))
                response = client.getresponse(); self.assertEqual(response.status, 200)
                full = json.loads(response.read())
                self.assertEqual(full['payload'], payload)
                client.request('POST', '/api/editing/get', json.dumps({'object_id': 'wrong', 'revision_id': revision}))
                response = client.getresponse(); self.assertEqual(response.status, 400)
                response.read()
            finally:
                client.close()


if __name__ == '__main__':
    unittest.main()
