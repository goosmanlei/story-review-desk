"""MIME regressions with entirely synthetic in-memory OSS responses."""
import hashlib,io,json,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_resource_cache import ResourceFixture,r
from test_resource_multipart import Connection as MultipartConnection
from review_desk import production_media,media_previews
class Missing(Exception):status_code=404
class Body:
 def __init__(self,data):self.data=data;self.closed=False
 def iter_bytes(self,chunk_size):yield self.data
 def close(self):self.closed=True
class Connection:
 def __init__(self):self.versions={};self.latest={};self.puts=[];self.gets=[];self.bodies=[]
 def seed(self,key,data,mime):
  version='version-'+str(len(self.versions)+1);self.versions[version]=(key,data,mime);self.latest[key]=version;return version
 def head_object(self,request):
  version=request.version_id or self.latest.get(request.key)
  if version not in self.versions:raise Missing()
  key,data,mime=self.versions[version];return SimpleNamespace(version_id=version,content_type=mime,content_length=len(data))
 def put_object(self,request):
  data=request.body.read();self.puts.append({'key':request.key,'mime':request.content_type,'bytes':len(data)})
  return SimpleNamespace(version_id=self.seed(request.key,data,request.content_type))
 def get_object(self,request):
  self.gets.append((request.key,request.version_id));key,data,mime=self.versions[request.version_id]
  body=Body(data);self.bodies.append(body);return SimpleNamespace(body=body,content_type=mime)
class ResourceMimeTest(ResourceFixture,unittest.TestCase):
 def setUp(self):
  super().setUp();self.online=patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'});self.online.start();self.addCleanup(self.online.stop)
 def test_remote_hash_checks_mime_and_closes_body_on_mismatch(self):
  _,spec=self.add('mime',b'exact');spec['mime']='image/webp'
  for content_type,allowed in [('Image/WebP; charset=binary',True),('application/octet-stream',False)]:
   body=Body(b'exact');conn=SimpleNamespace(get_object=lambda request:SimpleNamespace(content_type=content_type,body=body));out=io.BytesIO()
   if allowed:r._remote_hash(conn,self.config,spec,out);self.assertEqual(out.getvalue(),b'exact')
   else:
    with self.assertRaisesRegex(ValueError,'MIME differs'):r._remote_hash(conn,self.config,spec,out)
    self.assertEqual(out.getvalue(),b'')
   self.assertTrue(body.closed)
 def test_wrong_mime_existing_object_retains_old_and_verifies_new_version(self):
  source=self.root/'original.webp';source.write_bytes(b'exact-webp');sha=r.hash_file(source);key=self.config['project']+'/originals/'+sha[:2]+'/'+sha
  conn=Connection();old=conn.seed(key,source.read_bytes(),'application/octet-stream')
  with patch.object(r,'client',return_value=conn):spec=r.upload(self.root,source,mime='image/webp')
  self.assertEqual(spec['mime'],'image/webp');self.assertNotEqual(spec['version_id'],old);self.assertIn(old,conn.versions);self.assertEqual(len(conn.puts),1)
  self.assertEqual(conn.gets,[(key,spec['version_id'])]);self.assertTrue(all(x.closed for x in conn.bodies))
 def test_publish_derivative_uses_explicit_preview_mime_without_platform_registry(self):
  source=self.root/'original.png';source.write_bytes(b'exact-png');preview=self.root/'preview.webp';preview.write_bytes(b'exact-webp');conn=Connection()
  data={'sha256':r.hash_file(preview),'bytes':preview.stat().st_size,'mime':'image/webp','recipe':'synthetic'}
  with patch.object(r,'client',return_value=conn),patch.object(r.mimetypes,'guess_type',side_effect=lambda name:('image/png',None) if str(name).endswith('.png') else (None,None)),patch.object(media_previews,'prepare',return_value=(preview,data)):
   spec=r.publish_file(self.root,'export/assets/original.png',source)
  self.assertEqual(spec['variants']['small']['mime'],'image/webp');self.assertEqual(spec['variants']['large']['mime'],'image/webp')
  self.assertEqual([x['mime'] for x in conn.puts],['image/png','image/webp'])
 def test_ingest_preserves_inspected_original_mime_when_platform_registry_missing(self):
  conn=Connection();data=b'synthetic-webp';preview=self.root/'preview.webp';preview.write_bytes(b'synthetic-preview')
  preview_meta={'sha256':r.hash_file(preview),'bytes':preview.stat().st_size,'mime':'image/webp'}
  with patch.object(r,'client',return_value=conn),patch.object(r.mimetypes,'guess_type',return_value=(None,None)),patch.object(production_media,'probe',return_value={'mime':'image/webp','width':1,'height':1}),patch.object(media_previews,'prepare',return_value=(preview,preview_meta)):
   result=production_media.ingest(self.root,io.BytesIO(data),'candidate.webp')
  descriptor=r.descriptor(self.root,'export/assets/'+result['file'])
  evidence={'returned_mime':result['mime'],'catalog_mime':descriptor['mime'],'variants':list(descriptor.get('variants',{})),'puts':conn.puts,'resources_sha256':r.hash_file(Path(r.__file__))}
  self.assertEqual(descriptor['mime'],result['mime']);self.assertEqual(set(descriptor['variants']),{'small','large'})
 def test_resumed_multipart_does_not_complete_with_stale_mime(self):
  source=self.root/'source.webp';source.write_bytes(b'synthetic-webp');sha=r.hash_file(source)
  spec={'key':self.config['project']+'/originals/'+sha[:2]+'/'+sha,'sha256':sha,'bytes':source.stat().st_size,'mime':'application/octet-stream'}
  conn=MultipartConnection();conn.fail_part_once=True
  with self.assertRaises(TimeoutError):r._multipart(self.root,conn,self.config,spec,source)
  expected={**spec,'mime':'image/webp'};outcome='completed'
  try:r._multipart(self.root,conn,self.config,expected,source)
  except Exception as e:outcome=type(e).__name__+': '+str(e)
  evidence={'outcome':outcome,'initiations':conn.initiations,'completed_count':len(conn.completions),'actual_initiated_mime':conn.mime,'requested_resumed_mime':expected['mime'],'resources_sha256':r.hash_file(Path(r.__file__))}
  self.assertFalse(conn.completions and conn.mime!=expected['mime'],'resumed upload completed stale MIME metadata')
if __name__=='__main__':unittest.main()
