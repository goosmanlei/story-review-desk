"""Independent cache/signing probes. All bytes are synthetic; no cloud calls."""
import hashlib,io,json,os,sys,tempfile,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit,parse_qs
from review_desk import resources as r
class ResourceFixture:
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='resource-case-');self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);(self.root/'config').mkdir();(self.root/'resource-bundle').mkdir()
  self.config={'format':r.FORMAT,'provider':'oss','instance_id':'independent-test','project':'independent-test','bucket':'independent-test-bucket','region':'cn-hongkong','cache_bytes':64}
  (self.root/'config/instance.json').write_text(json.dumps({'id':'independent-test'}));(self.root/'config/resource-storage.json').write_text(json.dumps(self.config))
  self.entries={};self.env=patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'1'});self.env.start();self.addCleanup(self.env.stop)
 def add(self,label,data=b'exact-synthetic'):
  sha=hashlib.sha256(data).hexdigest();relative='export/assets/'+label+'.bin'
  spec={'sha256':sha,'verified_sha256':sha,'bytes':len(data),'key':'independent-test/originals/'+sha,'version_id':'synthetic-version-'+label,'mime':'application/octet-stream'}
  self.entries[relative]=spec;(self.root/'resource-bundle'/sha).write_bytes(data)
  (self.root/'config/resource-catalog.json').write_text(json.dumps({**self.config,'entries':self.entries}))
  return relative,spec

class ResourceCacheTest(ResourceFixture, unittest.TestCase):
 def test_corrupt_cache_is_repaired_and_held_change_rejected(self):
  rel,spec=self.add('repair');cache=r._cache_dir(self.root)/(spec['sha256']+'.bin');cache.write_bytes(b'X'*spec['bytes'])
  with r.lease_scope():
   self.assertEqual(r.materialize(self.root,rel).read_bytes(),b'exact-synthetic')
   cache.write_bytes(b'Y'*spec['bytes'])
   with self.assertRaisesRegex(ValueError,'leased resource was changed'):r.materialize(self.root,rel)
 def test_capacity_preserves_active_lease_and_evicts_after_scope(self):
  one,a=self.add('a',b'A'*40);two,b=self.add('b',b'B'*40)
  with r.lease_scope():
   held=r.materialize(self.root,one)
   with self.assertRaisesRegex(ValueError,'capacity is leased'):r.materialize(self.root,two)
   self.assertTrue(held.exists());self.assertEqual(held.read_bytes(),b'A'*40)
  r.materialize(self.root,two);self.assertFalse(held.exists())
 def test_frozen_scope_allows_preflight_and_rejects_new_read(self):
  one,_=self.add('a');two,_=self.add('b',b'different')
  with r.lease_scope():
   value=r.materialize(self.root,one)
   with r.frozen_scope():
    self.assertEqual(r.materialize(self.root,one),value)
    with self.assertRaisesRegex(ValueError,'not preflighted'):r.materialize(self.root,two)
 def test_offline_missing_fails_without_enabling_partial_cache(self):
  rel,spec=self.add('missing');(self.root/'resource-bundle'/spec['sha256']).unlink()
  with self.assertRaises(FileNotFoundError):r.materialize(self.root,rel)
  self.assertFalse((r._cache_dir(self.root)/(spec['sha256']+'.bin')).exists())
 @patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'})
 def test_cloud_hash_verifies_all_bytes_and_closes_body(self):
  _,spec=self.add('remote',b'A'*8)
  class Body:
   def __init__(self,data):self.data=data;self.closed=False
   def iter_bytes(self,chunk_size):yield self.data[:3];yield self.data[3:]
   def close(self):self.closed=True
  for data,valid in [(b'A'*8,True),(b'B'*8,False),(b'A'*9,False)]:
   body=Body(data);connection=SimpleNamespace(get_object=lambda request:SimpleNamespace(body=body,content_type=spec['mime']));out=io.BytesIO()
   if valid:r._remote_hash(connection,self.config,spec,out);self.assertEqual(out.getvalue(),data)
   else:
    with self.assertRaises(ValueError):r._remote_hash(connection,self.config,spec,out)
   self.assertTrue(body.closed)
 @patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'})
 def test_get_and_head_presign_are_exact_and_distinct(self):
  rel,spec=self.add('sign')
  with patch.dict(os.environ,{'REVIEW_OSS_CREDENTIALS_FILE':'','REVIEW_OSS_ACCESS_KEY_ID':'synthetic-id','REVIEW_OSS_ACCESS_KEY_SECRET':'synthetic-secret'}):
   get=parse_qs(urlsplit(r.signed_url(self.root,rel,download=True)).query)
   head=parse_qs(urlsplit(r.signed_url(self.root,rel,method='HEAD')).query)
  self.assertEqual(get['versionId'],[spec['version_id']]);self.assertEqual(head['versionId'],[spec['version_id']]);self.assertTrue(898<=int(get['x-oss-expires'][0])<=900)
  self.assertNotEqual(get['x-oss-signature'],head['x-oss-signature']);self.assertIn('response-content-disposition',get);self.assertNotIn('response-content-disposition',head)
 @patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'})
 def test_unknown_put_queries_exact_key_then_verifies_without_reput(self):
  data=b'synthetic-upload';source=self.root/'upload.bin';source.write_bytes(data)
  class Missing(Exception):status_code=404
  class Body:
   def iter_bytes(self,chunk_size):yield data
   def close(self):pass
  class Connection:
   def __init__(self):self.puts=0;self.heads=0;self.gets=0
   def head_object(self,request):
    self.heads+=1
    if not self.puts:raise Missing()
    return SimpleNamespace(version_id='synthetic-after-unknown',content_type='application/octet-stream')
   def put_object(self,request):self.puts+=1;raise TimeoutError('synthetic unknown acknowledgement')
   def get_object(self,request):self.gets+=1;return SimpleNamespace(body=Body(),content_type='application/octet-stream')
  connection=Connection()
  with patch.object(r,'client',return_value=connection):spec=r.upload(self.root,source)
  self.assertEqual((connection.puts,connection.heads,connection.gets),(1,2,1));self.assertEqual(spec['verified_sha256'],hashlib.sha256(data).hexdigest())
 def test_owned_interrupted_part_is_cleaned_before_budgeting(self):
  rel,spec=self.add('known-part');cache=r._cache_dir(self.root)
  fd,temporary=tempfile.mkstemp(prefix='.download-',suffix='.part',dir=cache)
  with os.fdopen(fd,'wb') as stream:stream.write(b'X'*64)
  result=r.materialize(self.root,rel)
  self.assertEqual(result.stat().st_size,spec['bytes']);self.assertFalse(Path(temporary).exists())
  self.assertLessEqual(sum(p.stat().st_size for p in cache.iterdir() if p.is_file()),self.config['cache_bytes'])
 def test_unknown_partial_is_retained_and_counts_against_capacity(self):
  rel,spec=self.add('unknown-part');cache=r._cache_dir(self.root);unknown=cache/'not-owned.part';unknown.write_bytes(b'X'*64)
  with self.assertRaisesRegex(ValueError,'capacity is leased'):r.materialize(self.root,rel)
  self.assertTrue(unknown.exists());self.assertFalse((cache/(spec['sha256']+'.bin')).exists())
 def test_paths_and_project_identity_reject_foreign_inputs(self):
  for path in ('../outside','/absolute','./same','a//b','a/../b','a\\b'):
   with self.assertRaises(ValueError):r.safe_path(path)
  rel,spec=self.add('safe');bad={**spec,'key':'other-project/originals/'+spec['sha256']}
  with self.assertRaisesRegex(ValueError,'verified exact cloud version'):r.validate_descriptor(self.config,bad)
if __name__=='__main__':unittest.main()
