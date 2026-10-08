import hashlib
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch

from review_desk.server import ReviewServer
from review_desk.web_assets import WebAssets


class DeploymentTest(unittest.TestCase):
    def test_actual_prefixed_http_and_stale_write_boundary(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {
                'REVIEW_BASE_PATH':'/lijizhanshe', 'REVIEW_PUBLICATION_ID':'round-two',
                'REVIEW_ENVIRONMENT':'experience'}), ReviewServer(('127.0.0.1',0), folder, {'id':'test','title':'测试'}) as server:
            thread=threading.Thread(target=server.serve_forever);thread.start()
            base='http://127.0.0.1:'+str(server.server_port)
            def request(path, method='GET', headers=None, body=None):
                req=urllib.request.Request(base+path,method=method,headers=headers or {},data=body)
                try: response=urllib.request.urlopen(req,timeout=5)
                except urllib.error.HTTPError as exc: response=exc
                with response: return response.status,response.headers,response.read()
            try:
                status,headers,page=request('/lijizhanshe/?workspace=story.outline')
                self.assertEqual(status,200);self.assertEqual(headers['Cache-Control'],'no-store')
                self.assertIn('体验环境，操作将在下次发布时重置'.encode(),page)
                self.assertIn(b'"publication_id": "round-two"',page)
                import re
                resources=re.findall(rb'(?:src|href)="([^"]+)"',page)
                self.assertTrue(all(p.startswith(b'/lijizhanshe/') for p in resources))
                for path in resources:
                    self.assertEqual(request(path.decode())[0],200)
                self.assertEqual(request('/api/instance')[0],404)
                self.assertEqual(request('/lijizhanshex/api/instance')[0],404)
                self.assertEqual(request('/lijizhanshe/.runtime/review.sqlite3')[0],404)
                for header in [{},{'X-Review-Publication':'round-one'}]:
                    status,_,body=request('/lijizhanshe/api/configurations/PROJECT','PATCH',header,b'{}')
                    self.assertEqual(status,409);self.assertTrue(json.loads(body)['publication_changed'])
                status,_,body=request('/lijizhanshe/api/configurations/PROJECT','PATCH',{'X-Review-Publication':'round-two'},b'{}')
                self.assertIn(status,(400,409));self.assertNotIn('publication_changed',json.loads(body))
                _,_,config=request('/lijizhanshe/api/configurations')
                value=json.loads(config)['values']['PROJECT']
                payload=json.dumps({'expected_version':value['version'],'updates':{'story_background':'当前发布真实写入'}}).encode()
                self.assertEqual(request('/lijizhanshe/api/configurations/PROJECT','PATCH',{'X-Review-Publication':'round-two'},payload)[0],200)
                # A physical original still uses the existing media Range and ETag path.
                data=b'RIFF'+b'0'*96;name=hashlib.sha256(data).hexdigest()+'.wav'
                assets=Path(folder)/'export/assets';assets.mkdir(parents=True);(assets/name).write_bytes(data)
                path='/lijizhanshe/api/production/files/'+name
                status,headers,body=request(path,headers={'Range':'bytes=4-9'})
                self.assertEqual((status,body),(206,b'000000'))
                self.assertEqual(headers['Content-Range'],'bytes 4-9/100')
                self.assertEqual(request(path,headers={'If-None-Match':headers['ETag']})[0],304)
            finally:
                server.shutdown();thread.join()

    def test_root_bundle_and_invalid_configuration(self):
        self.assertIn(b'href="/static/',WebAssets().index)
        from review_desk.deployment import settings
        for value in ['/bad/../path','//host','/with space','relative']:
            with patch.dict('os.environ',{'REVIEW_BASE_PATH':value}):
                with self.assertRaises(ValueError):settings()
