"""Independent schema16 regressions, synthetic private filesystem only."""
import hashlib,json,os,sqlite3,unittest
from pathlib import Path
from unittest.mock import patch
from test_resource_recovery import RecoveryFixture,r,rb,Store

def schema(db):
 return [tuple(x) for x in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]

class ResourceRecoveryFaultTest(RecoveryFixture,unittest.TestCase):
 def test_empty_instance_round_trip_exact_schema(self):
  root=self.root/'empty'
  source=Store(root/'.runtime/review.sqlite3');self.addCleanup(source.close)
  (root/'config').mkdir();(root/'resource-bundle').mkdir();(root/'content').mkdir()
  for name in ('instance.json','resource-storage.json','resource-catalog.json'):(root/'config'/name).write_bytes((self.root/'source/config'/name).read_bytes())
  exported=rb.export(source,root/'export');rb.restore(self.dest,root/'export')
  self.assertEqual(rb.database_identity(self.dest.db_path),exported['database'])
  self.assertEqual(schema(self.dest.db),schema(source.db))
  self.assertEqual(self.dest.objects(),[]);self.assertEqual(self.dest.comments(),[])
  self.assertEqual(self.dest.db.execute('PRAGMA foreign_keys').fetchone()[0],1)
  self.assertEqual([x[1] for x in self.dest.db.execute('PRAGMA database_list')],['main','temp'])

 def test_comment_history_sequence_and_writes_after_round_trip(self):
  for action,body in [('EDIT','edited once'),('CLOSE',None),('REOPEN',None)]:
   self.source.change_comment('comment',action,self.source.comment('comment')['version'],body)
  self.source.db.execute("UPDATE sqlite_sequence SET seq=50 WHERE name='comment_events'");self.source.db.commit()
  manifest=rb.export(self.source,self.exports);rb.restore(self.dest,self.exports)
  self.assertEqual(rb.database_identity(self.dest.db_path),manifest['database'])
  self.assertEqual(schema(self.dest.db),schema(self.source.db))
  self.assertEqual(self.dest.events(),self.source.events());self.assertEqual(self.dest.comments(),self.source.comments())
  self.assertEqual([tuple(x) for x in self.dest.db.execute('SELECT * FROM sqlite_sequence ORDER BY name')],[tuple(x) for x in self.source.db.execute('SELECT * FROM sqlite_sequence ORDER BY name')])
  self.dest.change_comment('comment','EDIT',4,'edited after restore')
  self.assertEqual(self.dest.events()[-1]['id'],51)
  self.assertEqual(self.dest.comment('comment')['body'],'edited after restore')
  self.assertEqual(list(self.dest.db.execute('PRAGMA foreign_key_check')),[])
  self.dest.db.execute('SELECT * FROM material_memberships LIMIT 1').fetchall()

 def test_mid_install_insert_failure_rolls_back_schema_rows_metadata(self):
  manifest=rb.export(self.source,self.exports)
  before=rb.database_identity(self.dest.db_path);before_schema=schema(self.dest.db)
  catalog=self.root/'destination/config/resource-catalog.json';before_catalog=catalog.read_bytes()
  trace={'drops':0,'denials':0}
  def authorizer(action,first,second,db,origin):
   if action==sqlite3.SQLITE_DROP_TABLE and db=='main':trace['drops']+=1
   if action==sqlite3.SQLITE_INSERT and first=='sources' and db=='main' and not trace['denials']:
    trace['denials']+=1;return sqlite3.SQLITE_DENY
   return sqlite3.SQLITE_OK
  self.dest.db.set_authorizer(authorizer)
  try:
   with self.assertRaises(sqlite3.DatabaseError):rb.restore(self.dest,self.exports)
  finally:self.dest.db.set_authorizer(lambda *args: sqlite3.SQLITE_OK)
  self.assertGreater(trace['drops'],0);self.assertEqual(trace['denials'],1)
  self.assertEqual(rb.database_identity(self.dest.db_path),before);self.assertEqual(schema(self.dest.db),before_schema)
  self.assertEqual(catalog.read_bytes(),before_catalog);self.assertFalse(self.dest.db.in_transaction)
  self.assertEqual(self.dest.db.execute('PRAGMA foreign_keys').fetchone()[0],1)
  self.assertNotIn('recovery',[x[1] for x in self.dest.db.execute('PRAGMA database_list')])
  rb.restore(self.dest,self.exports);self.assertEqual(rb.database_identity(self.dest.db_path),manifest['database'])

 def test_arrival_between_empty_check_and_identity_must_survive(self):
  rb.export(self.source,self.exports);original_identity=rb.database_identity;injected=False
  def identity(path):
   nonlocal injected
   if Path(path)==self.dest.db_path and not injected:
    injected=True;self.dest.put_source(self.document('first-window-arrival'))
   return original_identity(path)
  outcome='restored'
  with patch.object(rb,'database_identity',side_effect=identity):
   try:rb.restore(self.dest,self.exports)
   except Exception as error:outcome=type(error).__name__+': '+str(error)
  present=[s['id'] for s in self.dest.sources()]
  self.assertIn('first-window-arrival',present,'a write after the emptiness check was adopted as the initial identity then overwritten')

 def test_online_catalog_checks_same_content_at_each_exact_version(self):
  data=b'same bytes';sha=hashlib.sha256(data).hexdigest()
  common={'sha256':sha,'verified_sha256':sha,'bytes':len(data),'mime':'application/octet-stream','key':'bundle-test/originals/'+sha}
  catalog={**self.config,'entries':{'export/assets/one.bin':{**common,'version_id':'version-exists'},'export/assets/two.bin':{**common,'version_id':'version-missing'}}}
  calls=[]
  def remote(connection,config,spec,destination=None):
   calls.append(spec['version_id'])
   if spec['version_id']=='version-missing':raise ValueError('synthetic missing exact version')
   if destination is not None:destination.write(data)
  root=self.root/'destination';(root/'config/resource-catalog.json').write_text(json.dumps(catalog))
  (root/'resource-bundle'/sha).write_bytes(data)
  r.materialize(root,'export/assets/one.bin')
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'client',return_value=object()),patch.object(r,'_remote_hash',side_effect=remote):
   with self.assertRaisesRegex(ValueError,'missing exact version'):rb.verify_catalog(root,catalog,mode='remote')
  self.assertEqual(calls,['version-exists','version-missing'])

 def test_online_restore_rechecks_snapshot_even_when_cache_is_warm(self):
  manifest=rb.export(self.source,self.exports);root=self.root/'destination'
  r.materialize(root,'database.sqlite3',spec=manifest['snapshot'])
  before=rb.database_identity(self.dest.db_path)
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'verify_remote',side_effect=ValueError('snapshot exact version unavailable')) as remote:
   with r.read_scope('remote'):
    with self.assertRaisesRegex(ValueError,'snapshot exact version unavailable'):rb.restore(self.dest,self.exports)
  self.assertEqual(remote.call_args.args[1]['version_id'],manifest['snapshot']['version_id'])
  self.assertEqual(rb.database_identity(self.dest.db_path),before)

 def test_conflicting_descriptors_for_one_version_must_not_deduplicate_verification(self):
  data=b'actual bytes';sha=hashlib.sha256(data).hexdigest();wrong=hashlib.sha256(b'wrong bytes!').hexdigest()
  common={'sha256':sha,'verified_sha256':sha,'bytes':len(data),'mime':'application/octet-stream','key':'bundle-test/originals/'+sha,'version_id':'one-exact-version'}
  catalog={**self.config,'entries':{'export/assets/one.bin':common,'export/assets/two.bin':{**common,'sha256':wrong,'verified_sha256':wrong}}}
  calls=[]
  def verify(root,spec):
   calls.append(spec['sha256'])
   if spec['sha256']!=sha:raise ValueError('synthetic declared checksum differs from exact version')
  outcome=None
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'verify_remote',side_effect=verify):
   try:outcome={'verified':rb.verify_catalog(self.root/'destination',catalog)}
   except ValueError as error:outcome={'rejected':str(error)}
  self.assertIn('rejected',outcome,'catalog verification skipped contradictory metadata sharing a key and version')

 def test_whitelist_rejects_effective_credentials_symlink_and_fields(self):
  root=self.root/'source';destination=self.root/'isolated-copy';destination.mkdir()
  allowed=root/'config/instance.json'
  with patch.dict(os.environ,{'REVIEW_OSS_CREDENTIALS_FILE':str(allowed)}):
   with self.assertRaisesRegex(ValueError,'credentials cannot be packaged'):rb.copy_instance_metadata(root,destination)
  original=allowed.read_bytes();allowed.unlink();outside=self.root/'synthetic-secret.json';outside.write_bytes(original);allowed.symlink_to(outside)
  with self.assertRaises(ValueError):rb.copy_instance_metadata(root,destination)
  allowed.unlink();allowed.write_text(json.dumps({'id':'bundle-test','nested':[{'access_key_secret':'synthetic-not-real'}]}))
  with self.assertRaisesRegex(ValueError,'credentials are forbidden'):rb.copy_instance_metadata(root,destination)

if __name__=='__main__':unittest.main()
