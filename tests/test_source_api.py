"""The source API names the displayed revision without changing stored sources."""
import json
import tempfile
import threading
import unittest
import urllib.request
from review_desk.server import ReviewServer
from test_structure import direction

class SourceApiTest(unittest.TestCase):
    def test_current_revision_metadata_is_read_only_and_targets_comments(self):
        with tempfile.TemporaryDirectory() as root, ReviewServer(('127.0.0.1', 0), root, {'id': 'test', 'title': 'test'}) as server:
            source = direction('a', '测试资料')
            server.store.put_source(source)
            current = server.store.objects()[0]['current_revision']
            before = server.store.sources()
            url = f'http://127.0.0.1:{server.server_port}'
            result = {}
            def client():
                try:
                    with urllib.request.urlopen(url + '/api/sources?with_revision=1', timeout=5) as response:
                        result['sources'] = json.load(response)
                    with urllib.request.urlopen(url + '/api/sources', timeout=5) as response:
                        result['plain_sources'] = json.load(response)
                    payload = {'source_id': 'a', 'target_revision_id': current, 'anchor': {'block_id': 'summary', 'end_block_id': 'summary', 'start': 0, 'end': 2, 'quote': '李寄'}, 'body': '精确修订评论'}
                    request = urllib.request.Request(url + '/api/comments', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        result['comment'] = json.load(response)
                except Exception as error:
                    result['error'] = str(error)
            thread = threading.Thread(target=client, daemon=True); thread.start()
            server.timeout = 5
            # The server and SQLite remain on their owning thread.
            for _ in range(3): server.handle_request()
            thread.join(timeout=6)
            self.assertFalse(thread.is_alive())
            self.assertNotIn('error', result)
            self.assertEqual(result['sources'], [{**source, 'target_revision_id': current}])
            self.assertEqual(result['plain_sources'], [source])
            self.assertEqual(result['comment']['target_revision_id'], current)
            self.assertEqual(result['comment']['target_object_id'], 'a')
            self.assertEqual(server.store.sources(), before)
