"""Real HTTP commit-then-disconnect coverage for the shared comment editor."""
import hashlib
import json
import queue
import socket
import subprocess
import threading
import unittest
from pathlib import Path

import test_generation as fixtures
from test_structure import direction
from review_desk import production as p
from review_desk.server import ReviewHandler, ReviewServer
from review_desk.store import Store


class CommentRetryHTTPTest(unittest.TestCase):
    def test_committed_source_structure_and_material_requests_survive_refresh_retry(self):
        fixture = fixtures.GenerationTest()
        fixture.setUp()
        server = None
        try:
            fixture.setup_plans()
            fixture.media()
            fixture.associate()
            fixture.change('voice', candidate_requirements=[fixture.ref('need-full-overall')])
            plan = p.record(fixture.store, 'need-full-overall')
            source = direction('source-test', 'Isolated source')
            fixture.store.put_source(source)
            source_revision = fixture.store.db.execute('SELECT current_revision FROM objects WHERE id=?', (source['id'],)).fetchone()[0]
            structure = fixture.store.put_object('story-structure', 'STORY', {'title': 'Isolated structure', 'sections': [{'id': 'one', 'title': 'One', 'blocks': [{'id': 'block', 'text': 'Fixture only'}]}]})
            old = fixture.store.create_comment({'id': 'pre-existing', 'target_object_id': plan['object_id'], 'target_revision_id': plan['id'], 'anchor': {'type': 'global'}, 'body': 'original history'})
            fixture.store.change_comment(old['id'], 'CLOSE', old['version'])
            prior_comment, prior_events = fixture.store.comment(old['id']), fixture.store.events()
            revisions = [tuple(r) for r in fixture.store.db.execute('SELECT * FROM revisions ORDER BY id')]
            original = fixture.root / 'export/assets' / p.record(fixture.store, 'voice')['payload']['components'][0]['file']
            original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
            material = p.snapshot(fixture.store, object_id=plan['object_id'])
            quote = source['blocks'][0]['text']
            examples = [
                {'workspace': 'story.sources', 'object_id': source['id'], 'revision': source_revision, 'anchor': {'type': 'text', 'block_id': 'summary', 'end_block_id': 'summary', 'start': 0, 'end': len(quote), 'quote': quote}, 'body': 'retry source'},
                {'workspace': 'story.outline', 'object_id': 'story-structure', 'revision': structure['revision'], 'anchor': {'type': 'global'}, 'body': 'retry structure'},
                {'workspace': 'materials.workspace', 'object_id': plan['object_id'], 'revision': plan['id'], 'anchor': {'type': 'global'}, 'body': 'retry material', 'material': True},
            ]
            fixture.store.close()
            ready, events, dropped = queue.Queue(), [], set()
            drop_bodies = {row['body'] for row in examples} | {'changed first'}

            class DropAfterCommit(ReviewHandler):
                def log_message(self, *args):
                    pass

                def _json(self, value, status=200):
                    if self.command == 'POST' and self.path == '/api/comments':
                        event = {'id': value.get('id'), 'status': status, 'body': value.get('body')}
                        body = value.get('body')
                        if status == 201 and body in drop_bodies and body not in dropped:
                            dropped.add(body)
                            event['fault'] = 'socket closed after commit, before response headers'
                            events.append(event)
                            self.close_connection = True
                            self.connection.shutdown(socket.SHUT_RDWR)
                            self.connection.close()
                            return
                        events.append(event)
                    return super()._json(value, status)

            def serve():
                with ReviewServer(('127.0.0.1', 0), fixture.root, {'id': 'retry-test', 'title': 'Retry test'}) as current:
                    current.RequestHandlerClass = DropAfterCommit
                    ready.put(current)
                    current.serve_forever(poll_interval=.02)

            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            server = ready.get(timeout=5)
            proc = subprocess.run(['node', str(Path(__file__).with_name('comment-retry-http.cjs'))], input=json.dumps({'base_url': f'http://127.0.0.1:{server.server_port}', 'examples': examples, 'material': material}), text=True, capture_output=True, timeout=25)
            server.shutdown()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            result = json.loads(proc.stdout)
            store = Store(fixture.root / '.runtime/review.sqlite3')
            try:
                self.assertEqual(store.comment(old['id']), prior_comment)
                self.assertEqual([v for v in store.events() if v['comment_id'] == old['id']], prior_events)
                self.assertEqual([tuple(r) for r in store.db.execute('SELECT * FROM revisions ORDER BY id')], revisions)
                for row in result['results']:
                    cid = row['first']['id']
                    self.assertEqual(len([c for c in store.comments() if c['body'] == row['body']]), 1)
                    self.assertEqual(len([e for e in store.events() if e['comment_id'] == cid]), 1)
                feedback = result['results'][2]
                self.assertEqual(feedback['material_rounds_after_first'], [2, 1])
                self.assertEqual(store.comment(feedback['first']['id'])['material_scopes'], [{'material_id': plan['object_id'], 'number': 1}])
                self.assertEqual([tuple(r) for r in store.db.execute('SELECT material_id,number FROM material_feedback')], [(plan['object_id'], 2)])
                self.assertEqual(store.db.execute('SELECT COUNT(*) FROM material_rounds WHERE material_id=?', (plan['object_id'],)).fetchone()[0], 2)
                for body in ('changed first', 'changed second'):
                    self.assertEqual(len([c for c in store.comments() if c['body'] == body]), 1)
            finally:
                store.close()
            self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), original_hash)
            self.assertEqual(len([v for v in events if v.get('fault')]), 4)
            self.assertTrue(all(v['status'] == 201 for v in events))
            self.evidence = {'requests': result, 'http_events': events, 'prior_comment_unchanged': prior_comment,
                             'prior_events_unchanged': prior_events, 'immutable_revision_count_unchanged': len(revisions),
                             'original_sha256_unchanged': original_hash, 'server_stopped': not thread.is_alive()}
        finally:
            if server:
                server.shutdown()
            fixture.tearDown()


if __name__ == '__main__':
    unittest.main()
