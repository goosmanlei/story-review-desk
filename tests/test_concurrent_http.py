from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler

from review_desk.server import ReviewServer
from test_comment_source_reuse import document, source_row


class ConcurrentHttpTest(unittest.TestCase):
    def test_workers_serialize_expected_versions_and_cache_observes_writes(self):
        with tempfile.TemporaryDirectory() as root, ReviewServer(('127.0.0.1', 0), root, {'id': 'isolated', 'title': 'isolated'}) as server:
            server.store.put_source(document('source'))
            server.store.create_comment(source_row(server.store, 'source', 'race'))
            base = 'http://127.0.0.1:'+str(server.server_port)
            def request(path, value=None, method=None, headers=None):
                opener = build_opener(ProxyHandler({}))
                req = Request(base+path, data=json.dumps(value).encode() if value is not None else None,
                              method=method, headers=headers or {})
                try: response = opener.open(req, timeout=10)
                except HTTPError as error: response = error
                with response: return response.status, response.read(), response.headers
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
            thread.start()
            try:
                with ThreadPoolExecutor(max_workers=8) as pool:
                    barrier = threading.Barrier(2)
                    def edit(body):
                        barrier.wait()
                        return request('/api/comments/race', {'action': 'EDIT', 'expected_version': 1, 'body': body}, 'PATCH')
                    results = list(pool.map(edit, ['first', 'second']))
                    self.assertEqual(sorted(result[0] for result in results), [200, 409])
                    winner = json.loads(next(result[1] for result in results if result[0] == 200))
                    self.assertEqual(winner['version'], 2)
                    self.assertEqual(json.loads(request('/api/comments')[1])[0]['body'], winner['body'])
                    version = server.store.configuration('PROJECT')['version']
                    barrier = threading.Barrier(2)
                    def configure(_):
                        barrier.wait()
                        return request('/api/configurations/PROJECT', {'expected_version': version, 'updates': {}}, 'PATCH')[0]
                    self.assertEqual(sorted(pool.map(configure, [1, 2])), [200, 409])
                    codes = list(pool.map(lambda _: request('/api/business-codes'), range(12)))
                    self.assertTrue(all(item[0] == 200 for item in codes))
                    self.assertEqual(len({item[1] for item in codes}), 1)
                    self.assertTrue(any(item[2]['X-Review-Cache'] == 'hit' for item in codes))
                    self.assertEqual(sum(item[2]['X-Review-Cache'] == 'miss' for item in codes), 1)
                self.assertEqual(len(server._workers), 4)
                self.assertEqual(server._requests.maxsize, 8)
                self.assertEqual(server.store.comment('race')['version'], 2)
                self.assertEqual(len(server.store.events()), 2)
            finally:
                server.shutdown()
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive())

    def test_media_range_identity_and_revalidation_during_api_reads(self):
        with tempfile.TemporaryDirectory() as root, ReviewServer(('127.0.0.1', 0), root, {'id': 'isolated', 'title': 'isolated'}) as server:
            raw = b'original media fixture' * 10000
            name = hashlib.sha256(raw).hexdigest()+'.mp4'
            media = Path(root)/'export/assets'/name
            media.parent.mkdir(parents=True)
            media.write_bytes(raw)
            base = 'http://127.0.0.1:'+str(server.server_port)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01});thread.start()
            def request(path, headers=None):
                opener = build_opener(ProxyHandler({}))
                try: result = opener.open(Request(base+path, headers=headers or {}), timeout=10)
                except HTTPError as error: result = error
                with result: return result.status, result.read(), result.headers
            try:
                path = '/api/production/files/'+name
                code, body, headers = request(path)
                self.assertEqual((code, body), (200, raw))
                etag = headers['ETag']
                self.assertEqual(etag, '"'+hashlib.sha256(raw).hexdigest()+'"')
                self.assertEqual(request(path, {'If-None-Match': etag})[:2], (304, b''))
                partial = request(path, {'Range': 'bytes=1-10', 'If-Range': etag})
                self.assertEqual(partial[:2], (206, raw[1:11]))
                self.assertEqual(request(path, {'Range':'bytes=-12'})[:2], (206, raw[-12:]))
                self.assertEqual(request(path, {'Range':'bytes=999999-'})[0], 416)
                self.assertEqual(request(path, {'Range':'bytes=1-10','If-Range':'"old"'})[:2], (200, raw))
                with ThreadPoolExecutor(max_workers=8) as pool:
                    mixed = list(pool.map(lambda i:request(path if i%2 else '/api/instance'),range(24)))
                self.assertTrue(all(row[0] == 200 for row in mixed))
                self.assertTrue(all(row[1] == raw for row in mixed[1::2]))
                self.assertEqual(request('/api/production/files/../config/instance.json')[0], 400)
                media.write_bytes(b'corruption must never become a historic original')
                self.assertEqual(request(path, {'If-None-Match':etag})[0], 400)
                media.write_bytes(raw)
                self.assertEqual(request(path)[1], raw)
            finally:
                server.shutdown();thread.join(timeout=10)

    def test_bundles_match_sources_and_content_addressed_browser_validation(self):
        with tempfile.TemporaryDirectory() as root, ReviewServer(('127.0.0.1', 0), root, {'id': 'isolated', 'title': 'isolated'}) as server:
            self.assertEqual(len(server.web_assets.files), 2)
            for path, (raw, compressed, mime) in server.web_assets.files.items():
                self.assertEqual(gzip.decompress(compressed), raw)
                self.assertIn(hashlib.sha256(raw).hexdigest(), path)
                self.assertIn(path.encode(), server.web_assets.index)
            self.assertIn(b'function unpackReviewGraph(', next(value[0] for path, value in server.web_assets.files.items() if path.endswith('.js')))
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
            thread.start()
            try:
                opener = build_opener(ProxyHandler({}))
                path = next(iter(server.web_assets.files))
                url = 'http://127.0.0.1:'+str(server.server_port)+path
                with opener.open(Request(url, headers={'Accept-Encoding': 'gzip'}), timeout=5) as response:
                    etag = response.headers['ETag']
                    self.assertIn('immutable', response.headers['Cache-Control'])
                    self.assertEqual(response.read(), server.web_assets.files[path][1])
                with self.assertRaises(HTTPError) as caught:
                    opener.open(Request(url, headers={'Accept-Encoding': 'gzip', 'If-None-Match': etag}), timeout=5)
                self.assertEqual(caught.exception.code, 304)
                caught.exception.close()
            finally:
                server.shutdown()
                thread.join(timeout=10)
