import hashlib,json,os,shutil,sqlite3,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from review_desk import resources as r,resource_bundle as rb
from review_desk.store import Store
class RecoveryFixture:
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='bundle16-case-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.source=Store(self.root/'source/.runtime/review.sqlite3');self.addCleanup(self.source.close)
  self.dest=Store(self.root/'destination/.runtime/review.sqlite3');self.addCleanup(self.dest.close)
  self.config={'format':r.FORMAT,'provider':'oss','instance_id':'bundle-test','project':'bundle-test','bucket':'bundle-test-bucket','region':'cn-hongkong','cache_bytes':16*1024*1024}
  for name in ('source','destination'):
   root=self.root/name;(root/'config').mkdir();(root/'resource-bundle').mkdir();(root/'content').mkdir()
   (root/'config/instance.json').write_text(json.dumps({'id':'bundle-test'}));(root/'config/resource-storage.json').write_text(json.dumps(self.config));(root/'config/resource-catalog.json').write_text(json.dumps({**self.config,'entries':{}}))
  self.source.put_source(self.document('original'));self.source.create_comment({'id':'comment','source_id':'original','anchor':{'block_id':'body','end_block_id':'body','start':0,'end':8,'quote':'Original'},'body':'Exact opinion'})
  self.exports=self.root/'source/export';self.patch=patch.object(r,'upload',side_effect=self.fake_upload);self.patch.start();self.addCleanup(self.patch.stop)
  self.env=patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'1'});self.env.start();self.addCleanup(self.env.stop)
 @staticmethod
 def document(name):return {'id':name,'title':name,'version_type':'original','origin':'fixture','source_url':'https://example.org/source','collected_at':'2026-10-04','notes':'fixture','assets':[],'blocks':[{'id':'body','text':'Original text'}]}
 def fake_upload(self,root,source,**kwargs):
  sha=r.hash_file(source);data={'sha256':sha,'verified_sha256':sha,'bytes':source.stat().st_size,'mime':'application/vnd.sqlite3','key':'bundle-test/snapshots/local/'+sha,'version_id':'synthetic-'+sha[:12]}
  for name in ('source','destination'):shutil.copyfile(source,self.root/name/'resource-bundle'/sha)
  return data

class ResourceRecoveryTest(RecoveryFixture,unittest.TestCase):
 def test_round_trip_exact_tables_and_comment(self):
  manifest=rb.export(self.source,self.exports);rb.restore(self.dest,self.exports)
  self.assertEqual(self.dest.comments(),self.source.comments());self.assertEqual(rb.database_identity(self.dest.db_path),manifest['database'])
 def test_wrong_snapshot_bytes_leave_empty_db_and_restore_metadata(self):
  manifest=rb.export(self.source,self.exports);catalog=self.root/'destination/config/resource-catalog.json';previous=catalog.read_bytes()
  (self.root/'destination/resource-bundle'/manifest['snapshot']['sha256']).write_bytes(b'corrupted')
  with self.assertRaises(ValueError):rb.restore(self.dest,self.exports)
  self.assertEqual(self.dest.objects(),[]);self.assertEqual(catalog.read_bytes(),previous)
 def test_arrival_during_preflight_must_not_be_overwritten(self):
  rb.export(self.source,self.exports);original_verify=rb.verify_catalog
  def concurrent_write(*args,**kwargs):
   value=original_verify(*args,**kwargs);self.dest.put_source(self.document('arrival'));return value
  outcome=None
  with patch.object(rb,'verify_catalog',side_effect=concurrent_write):
   try:rb.restore(self.dest,self.exports);outcome='restored'
   except Exception as exc:outcome=type(exc).__name__
  present=[s['id'] for s in self.dest.sources()]
  self.assertIn('arrival',present,'restore overwrote a destination write committed during preflight')
 def test_offline_medium_excludes_configured_runtime_credentials(self):
  rb.export(self.source,self.exports)
  credentials=self.root/'source/config/runtime-reader.json'
  credentials.write_text(json.dumps({'project':'bundle-test','access_key_id':'synthetic-not-real','access_key_secret':'synthetic-not-real'}));credentials.chmod(0o600)
  with patch.dict(os.environ,{'REVIEW_OSS_CREDENTIALS_FILE':str(credentials)}):
   rb.offline_bundle(self.root/'source',self.root/'offline-medium')
  copied=(self.root/'offline-medium/config/runtime-reader.json').exists()
  self.assertFalse(copied,'supported runtime credential file was copied into the offline export')
 def test_private_row_added_after_initial_check_must_not_be_uploaded(self):
  original=tempfile.TemporaryDirectory
  def concurrent_private(*args,**kwargs):
   self.source.put_object('private-step','GUIDANCE',{'private':True,'blocks':[{'id':'local','text':'private creative note'}]});return original(*args,**kwargs)
  outcome=None;manifest=None
  with patch.object(rb.tempfile,'TemporaryDirectory',side_effect=concurrent_private):
   try:manifest=rb.export(self.source,self.exports);outcome='exported'
   except Exception as exc:outcome=type(exc).__name__
  leaked=False
  if manifest:
   snapshot=self.root/'source/resource-bundle'/manifest['snapshot']['sha256'];db=sqlite3.connect(snapshot)
   try:leaked=bool(db.execute("SELECT 1 FROM revisions WHERE json_extract(payload,'$.private')=1").fetchone())
   finally:db.close()
  self.assertFalse(leaked,'export uploaded a snapshot with a private record added after its live-db check')
if __name__=='__main__':unittest.main()
