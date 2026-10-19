"""Signed media, same-origin download, and offline contracts. No network or real credentials."""
import fcntl,hashlib,io,json,os,unittest
from pathlib import Path
from types import SimpleNamespace,MethodType
from http.server import BaseHTTPRequestHandler
from unittest.mock import patch
from urllib.parse import parse_qs,urlsplit,quote
from test_resource_cache import ResourceFixture,r
from review_desk.server import ReviewHandler

class ResourceHttpTest(ResourceFixture,unittest.TestCase):
 def handler(self,path,method='GET',headers=None):
  value=SimpleNamespace(path=path,command=method,headers=headers or {},server=SimpleNamespace(root=self.root,_local=SimpleNamespace()),wfile=io.BytesIO(),responses=[],response_headers={})
  value.send_response=lambda code:value.responses.append(code)
  value.send_header=lambda key,text:value.response_headers.__setitem__(key,text)
  value.end_headers=lambda:None
  value._file=MethodType(ReviewHandler._file,value)
  value._file_stream=MethodType(ReviewHandler._file_stream,value)
  return value
 def test_local_exact_reference_rejects_changed_source_before_derivation_and_recovers(self):
  from PIL import Image
  (self.root/'config/resource-storage.json').unlink()
  relative='media/exact.png';source=self.root/relative;source.parent.mkdir()
  Image.new('RGB',(8,8),'red').save(source);original=source.read_bytes();sha=r.hash_file(source)
  Image.new('RGB',(8,8),'blue').save(source)
  handler=self.handler('/api/methods/media?variant=large')
  with self.assertRaises(ValueError):ReviewHandler._resource(handler,relative,'image/png',sha,len(original))
  self.assertEqual(handler.responses,[])
  source.write_bytes(original)
  ReviewHandler._resource(handler,relative,'image/png',sha,len(original))
  self.assertEqual(handler.responses,[200]);self.assertEqual(handler.response_headers['Content-Type'],'image/webp')
 def test_local_exact_reference_rejects_wrong_size_and_missing_original(self):
  (self.root/'config/resource-storage.json').unlink()
  relative='media/exact.bin';source=self.root/relative;source.parent.mkdir();source.write_bytes(b'exact-original')
  sha=r.hash_file(source);size=source.stat().st_size
  handler=self.handler('/api/methods/media')
  with self.assertRaises(ValueError):ReviewHandler._resource(handler,relative,'application/octet-stream',sha,size+1)
  source.unlink()
  with self.assertRaises(FileNotFoundError):ReviewHandler._resource(handler,relative,'application/octet-stream',sha,size)
  self.assertEqual(handler.responses,[])
 def synthetic_credentials(self):
  return patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0','REVIEW_OSS_CREDENTIALS_FILE':'','REVIEW_OSS_ACCESS_KEY_ID':'synthetic-only-id','REVIEW_OSS_ACCESS_KEY_SECRET':'synthetic-only-secret'})
 def test_runtime_credential_file_is_bound_to_its_own_instance(self):
  filename=self.root/'runtime-credentials.json'
  filename.write_text(json.dumps({'project':self.config['project'],'instance':'local','access_key_id':'synthetic-id','access_key_secret':'synthetic-secret'}));filename.chmod(0o600)
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0','REVIEW_OSS_CREDENTIALS_FILE':str(filename),'REVIEW_RESOURCE_INSTANCE':'vps'}):
   with self.assertRaisesRegex(ValueError,'another instance'):r.client(self.config)
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0','REVIEW_OSS_CREDENTIALS_FILE':str(filename),'REVIEW_RESOURCE_INSTANCE':'local'}):
   self.assertIsNotNone(r.client(self.config))
 def test_download_signing_preserves_utf8_name_and_exact_identity(self):
  relative,spec=self.add('named-download');filename='第 1 集·有字幕版.mp4'
  with self.synthetic_credentials():
   parsed=urlsplit(r.signed_url(self.root,relative,download=True,filename=filename));query=parse_qs(parsed.query)
  self.assertEqual(query['versionId'],[spec['version_id']]);self.assertEqual(parsed.path,'/'+spec['key'])
  self.assertEqual(query['response-content-disposition'],["attachment; filename*=UTF-8''"+quote(filename)])
  self.assertNotIn('synthetic-only-secret',parsed.query)
 def test_same_origin_download_preserves_name_and_does_not_forward_credentials(self):
  relative,spec=self.add('same-origin');filename='原件 with space.wav'
  r.materialize(self.root,relative)
  handler=self.handler('/api/production/files/example?download=1&filename='+quote(filename),headers={'Authorization':'Bearer synthetic-application-secret','X-Review-Publication':'synthetic-publication','Cookie':'session=synthetic-cookie'})
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'client',side_effect=AssertionError('warm exact cache must not contact cloud')),patch.object(r,'signed_url',side_effect=AssertionError('download must stay same origin')),r.lease_scope():
   ReviewHandler._resource(handler,relative,expected_sha=spec['sha256'],expected_bytes=spec['bytes'])
  self.assertEqual(handler.responses,[200]);self.assertEqual(handler.response_headers['Cache-Control'],'private, no-cache');self.assertNotIn('Location',handler.response_headers)
  self.assertEqual(handler.response_headers['Content-Disposition'],"attachment; filename*=UTF-8''"+quote(filename));self.assertEqual(handler.wfile.getvalue(),b'exact-synthetic')
  self.assertFalse(any('synthetic-application' in v or 'synthetic-publication' in v or 'synthetic-cookie' in v for v in handler.response_headers.values()))
 def test_same_origin_download_conditions_and_request_lease(self):
  data=b'0123456789';relative,spec=self.add('leased-download',data);cached=r.materialize(self.root,relative)
  etag='"'+spec['sha256']+'"'
  cases=[('GET',{'Range':'bytes=2-5','If-Range':etag},206,b'2345'),('GET',{'Range':'bytes=2-5','If-Range':'"old"'},200,data),('GET',{'If-None-Match':etag},304,b''),('HEAD',{'Range':'bytes=2-5'},206,b''),('GET',{'Range':'bytes=10-'},416,b'')]
  for method,headers,status,body in cases:
   template=self.handler('/api/production/files/original?download=1&filename=original.bin',method,headers)
   handler=object.__new__(ReviewHandler);handler.__dict__.update(template.__dict__)
   handler._file=MethodType(ReviewHandler._file,handler);handler._file_stream=MethodType(ReviewHandler._file_stream,handler)
   observed=[]
   def locked_end():
    observed.append(bool(r._leases.get()))
    with Path(str(cached)+'.lock').open('a') as lock:
     with self.assertRaises(BlockingIOError):fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   handler.end_headers=locked_end
   def simulated_base(instance):return ReviewHandler._resource(instance,relative,expected_sha=spec['sha256'])
   with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'client',side_effect=AssertionError('warm cache only')),patch.object(BaseHTTPRequestHandler,'handle_one_request',simulated_base):
    ReviewHandler.handle_one_request(handler)
   self.assertEqual(handler.responses,[status]);self.assertEqual(handler.wfile.getvalue(),body);self.assertEqual(observed,[True]);self.assertIsNone(r._leases.get())
   with Path(str(cached)+'.lock').open('a') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def test_local_get_head_and_range_have_attachment_name_and_exact_bytes(self):
  data=b'synthetic original bytes';sha=hashlib.sha256(data).hexdigest();filename='李寄 原片.mp4'
  for method,extra,status,body in [('GET',{},200,data),('HEAD',{},200,b''),('GET',{'Range':'bytes=2-7'},206,data[2:8])]:
   handler=self.handler('/api/production/files/original?download=1&filename='+quote(filename),method,extra)
   ReviewHandler._file_stream(handler,io.BytesIO(data),Path('local-original.mp4'),'video/mp4',data,sha)
   self.assertEqual(handler.responses,[status]);self.assertEqual(handler.response_headers['Content-Disposition'],"attachment; filename*=UTF-8''"+quote(filename));self.assertEqual(handler.wfile.getvalue(),body)
   self.assertEqual(handler.response_headers['ETag'],'"'+sha+'"')
 def test_invalid_filename_rejected_before_any_response(self):
  relative,spec=self.add('invalid-name')
  for filename in ('../outside.mp4','folder\\outside.mp4','bad\r\nX-Header: value'):
   with self.synthetic_credentials():
    with self.assertRaises(ValueError):r.signed_url(self.root,relative,download=True,filename=filename)
   data=b'synthetic';handler=self.handler('/api/production/files/original?download=1&filename='+quote(filename))
   with self.assertRaises(ValueError):ReviewHandler._file_stream(handler,io.BytesIO(data),Path('local-original.mp4'),'video/mp4',data,hashlib.sha256(data).hexdigest())
   self.assertEqual(handler.responses,[])
 def test_unsatisfiable_cloud_ranges_fail_without_redirect(self):
  relative,spec=self.add('range',b'0123456789')
  for value in ('bytes=10-','bytes=3-2','bytes=-0','bytes=','not-a-range','bytes=0-1,4-5'):
   handler=self.handler('/api/production/files/original',headers={'Range':value})
   with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'signed_url',side_effect=AssertionError('invalid Range must not reach cloud redirect')):
    ReviewHandler._resource(handler,relative)
   self.assertEqual(handler.responses,[416]);self.assertEqual(handler.response_headers['Content-Range'],'bytes */10');self.assertEqual(handler.response_headers['Content-Length'],'0')
 def test_if_range_uses_exact_cloud_etag_and_verified_local_bytes(self):
  data=b'0123456789';relative,spec=self.add('if-range',data);path=self.root/'synthetic-cached.bin';path.write_bytes(data)
  for supplied,status,body in [('"cloud-exact-etag"',206,b'2345'),('"older-cloud-etag"',200,data)]:
   handler=self.handler('/api/production/files/original',headers={'Range':'bytes=2-5','If-Range':supplied})
   handler._file=lambda p,mime,sha,expected_etag=None:ReviewHandler._file_stream(handler,io.BytesIO(data),p,mime,data,sha,expected_etag)
   with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'remote_etag',return_value='"cloud-exact-etag"') as head,patch.object(r,'materialize',return_value=path) as materialize:
    ReviewHandler._resource(handler,relative)
   self.assertEqual(head.call_args.args[1]['version_id'],spec['version_id']);self.assertEqual(materialize.call_args.kwargs['spec']['sha256'],spec['sha256'])
   self.assertEqual(handler.responses,[status]);self.assertEqual(handler.wfile.getvalue(),body);self.assertEqual(handler.response_headers['ETag'],'"cloud-exact-etag"')
   self.assertNotIn('Content-Disposition',handler.response_headers)
 @patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'})
 def test_remote_etag_heads_exact_version_and_rejects_size_drift(self):
  _,spec=self.add('etag');requests=[]
  def head(request):requests.append(request);return SimpleNamespace(content_length=spec['bytes'],etag='"cloud-etag"')
  with patch.object(r,'client',return_value=SimpleNamespace(head_object=head)):
   self.assertEqual(r.remote_etag(self.root,spec),'"cloud-etag"')
  self.assertEqual(requests[0].version_id,spec['version_id']);self.assertEqual(requests[0].key,spec['key'])
  with patch.object(r,'client',return_value=SimpleNamespace(head_object=lambda request:SimpleNamespace(content_length=spec['bytes']+1,etag='"cloud-etag"'))):
   with self.assertRaisesRegex(ValueError,'size differs'):r.remote_etag(self.root,spec)

if __name__=='__main__':unittest.main()
