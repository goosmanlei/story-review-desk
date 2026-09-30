import base64
import json
import shutil
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from review_desk import bundle, favicon
from review_desk.configuration import migrate
from review_desk.store import Conflict, Store

SVG=b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#abc"/></svg>'

class FaviconTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/'export/assets').mkdir(parents=True)
        self.store=Store(self.root/'.runtime/review.sqlite3')
    def tearDown(self):
        self.store.close();self.temp.cleanup()
    def put(self):
        return favicon.upload(self.root,'light.svg',base64.b64encode(SVG).decode())
    def test_migration_default_and_versioned_persistence(self):
        for schema in (1,2,3,4):
            self.assertEqual(migrate('SYSTEM',schema,{})['site_favicon'],'')
        name=self.put();record=self.store.set_configuration('SYSTEM',{'site_favicon':name},0)
        with self.assertRaises(Conflict):self.store.set_configuration('SYSTEM',{'site_favicon':''},0)
        self.store.close();self.store=Store(self.root/'.runtime/review.sqlite3')
        self.assertEqual(self.store.configuration('SYSTEM'),record)
        self.assertEqual(favicon.current(self.root,record['body'])[1],SVG)
        self.store.set_configuration('SYSTEM',{'site_favicon':''},1)
        self.assertEqual(len(self.store.configuration_events()),2)
        self.assertEqual(favicon.current(self.root,self.store.configuration('SYSTEM')['body'])[2]['file'],'')
    def test_bad_references_and_upload_leave_configuration_unchanged(self):
        for name in ('missing.svg','../bad.svg','https://x/a.png','bad.txt',None):
            with self.assertRaises(ValueError):self.store.set_configuration('SYSTEM',{'site_favicon':name},0)
        (self.root/'export/assets/unsafe.svg').write_bytes(SVG.replace(b'<rect',b'<script'))
        with self.assertRaises(ValueError):self.store.set_configuration('SYSTEM',{'site_favicon':'unsafe.svg'},0)
        for svg in (SVG.replace(b'<rect',b'<image href="https://example.com"'),SVG.replace(b'fill="#abc"',b'onload="alert(1)"'),SVG.replace(b'fill="#abc"',b'fill="url(http://example.com)"')):
            with self.assertRaises(ValueError):favicon.validate_image(svg,'.svg')
        (self.root/'export/assets/link.svg').symlink_to(self.root/'export/assets/unsafe.svg')
        with self.assertRaises(ValueError):self.store.set_configuration('SYSTEM',{'site_favicon':'link.svg'},0)
        self.assertEqual(self.store.configuration('SYSTEM')['version'],0)
        self.assertEqual(self.store.configuration_events(),[])
    def test_png_ico_and_corruption(self):
        def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
        png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,16,8,6,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\xaa\0\xff'*16)*16))+chunk(b'IEND',b'')
        favicon.validate_image(png,'.png')
        ico=struct.pack('<HHH',0,1,1)+struct.pack('<BBBBHHII',16,16,0,0,1,32,len(png),22)+png
        favicon.validate_image(ico,'.ico')
        for image,suffix in ((png[:-1],'.png'),(ico[:-1],'.ico'),(b'fake','.png')):
            with self.assertRaises(ValueError):favicon.validate_image(image,suffix)
    def test_export_restore_checksum_and_manifest_membership(self):
        name=self.put();self.store.set_configuration('SYSTEM',{'site_favicon':name},0)
        manifest=bundle.export(self.store,self.root/'export')
        self.assertIn('assets/'+name,manifest['files'])
        restored=self.root/'restored';shutil.copytree(self.root/'export',restored/'export')
        target=Store(restored/'.runtime/review.sqlite3')
        bundle.restore(target,restored/'export')
        self.assertEqual(favicon.current(restored,target.configuration('SYSTEM')['body'])[1],SVG)
        self.assertEqual(bundle.export(target,restored/'export'),manifest);target.close()
        manifest['files'].pop('assets/'+name)
        (restored/'export/manifest.json').write_text(json.dumps(manifest))
        target=Store(self.root/'empty/.runtime/review.sqlite3')
        with self.assertRaisesRegex(ValueError,'unmanifested favicon'):bundle.restore(target,restored/'export')
        self.assertEqual(target.configuration('SYSTEM')['version'],0);target.close()
        (self.root/'export/assets'/name).write_bytes(b'broken')
        with self.assertRaises(ValueError):bundle.export(self.store,self.root/'export')

if __name__=='__main__':unittest.main()

class FaviconHTTPTests(unittest.TestCase):
    def test_upload_save_conflict_missing_and_mime(self):
        import queue, threading
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        from review_desk.server import ReviewServer
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ready=queue.Queue()
            def serve():
                with ReviewServer(('127.0.0.1',0),root,{'id':'test','title':'Test'}) as server:
                    ready.put(server);server.serve_forever(poll_interval=.01)
            thread=threading.Thread(target=serve);thread.start();server=ready.get(timeout=5)
            base='http://127.0.0.1:'+str(server.server_port)
            def request(path,method='GET',value=None):
                req=Request(base+path,data=json.dumps(value).encode() if value is not None else None,method=method,headers={'Content-Type':'application/json'})
                return urlopen(req)
            try:
                with request('/api/favicon','POST',{'name':'light.svg','data':base64.b64encode(SVG).decode()}) as response:
                    name=json.load(response)['file'];self.assertEqual(response.status,201)
                with request('/api/configurations/SYSTEM','PATCH',{'expected_version':0,'updates':{'site_favicon':name}}) as response:self.assertEqual(json.load(response)['version'],1)
                with request('/api/configurations') as response: icon=json.load(response)['favicon']
                self.assertTrue(icon['url'].startswith('/assets/'+name+'?v='))
                with request(icon['url']) as response: self.assertEqual(response.read(),SVG)
                with request('/favicon.ico?v=old') as response:
                    self.assertEqual(response.read(),SVG);self.assertEqual(response.headers['Content-Type'],'image/svg+xml');self.assertEqual(response.headers['Cache-Control'],'no-store')
                with self.assertRaises(HTTPError) as error:request('/api/configurations/SYSTEM','PATCH',{'expected_version':0,'updates':{'site_favicon':''}})
                self.assertEqual(error.exception.code,409)
                with self.assertRaises(HTTPError) as error:request('/api/favicon','POST',{'name':'bad.png','data':base64.b64encode(b'fake').decode()})
                self.assertEqual(error.exception.code,400)
                (root/'export/assets'/name).unlink()
                with self.assertRaises(HTTPError) as error:request('/favicon.ico')
                self.assertEqual(error.exception.code,503)
                with request('/api/configurations/SYSTEM','PATCH',{'expected_version':1,'updates':{'site_favicon':''}}) as response:self.assertEqual(json.load(response)['body']['site_favicon'],'')
                with request('/api/configurations') as response: icon=json.load(response)['favicon']
                self.assertTrue(icon['url'].startswith('/default-favicon.svg?v='))
                with request(icon['url']) as response:self.assertIn(b'<svg',response.read())
                with request('/favicon.ico') as response:self.assertIn(b'<svg',response.read())
            finally:server.shutdown();thread.join(timeout=5)
