"""Multipart failure and resume reconciliation without cloud writes."""
import hashlib,json,os,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from test_resource_cache import ResourceFixture,r

class Missing(Exception):status_code=404
class Connection:
 def __init__(self):
  self.initiations=0;self.listings=0;self.parts={};self.uploads=[];self.completions=[];self.versions=[];self.fail_init=False;self.fail_part_once=False;self.fail_complete_once=False;self.list_hook=None;self.mime='application/octet-stream'
 def head_object(self,request):
  if self.versions:return SimpleNamespace(version_id=self.versions[-1],content_type=self.mime)
  raise Missing()
 def initiate_multipart_upload(self,request):
  self.initiations+=1;self.mime=request.content_type
  if self.fail_init:raise TimeoutError('synthetic unknown initiation acknowledgement')
  return SimpleNamespace(upload_id='upload-synthetic-1')
 def list_parts(self,request):
  self.listings+=1
  if self.list_hook:self.list_hook()
  return SimpleNamespace(parts=list(self.parts.values()),is_truncated=False)
 def upload_part(self,request):
  self.uploads.append({'number':request.part_number,'bytes':len(request.body)})
  part=SimpleNamespace(part_number=request.part_number,size=len(request.body),etag='"'+hashlib.md5(request.body).hexdigest().upper()+'"')
  self.parts[part.part_number]=part
  if self.fail_part_once:self.fail_part_once=False;raise TimeoutError('synthetic unknown part acknowledgement')
  return part
 def complete_multipart_upload(self,request):
  numbers=[x.part_number for x in request.complete_multipart_upload.parts]
  self.completions.append({'parts':numbers,'bytes':sum(self.parts[x].size for x in numbers)})
  version='synthetic-completed-'+str(len(self.completions));self.versions.append(version)
  if self.fail_complete_once:self.fail_complete_once=False;raise TimeoutError('synthetic unknown completion acknowledgement')
  return SimpleNamespace(version_id=version)

class ResourceMultipartTest(ResourceFixture,unittest.TestCase):
 def setUp(self):
  super().setUp();self.online=patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'});self.online.start();self.addCleanup(self.online.stop);self.source=self.root/'original.bin';self.source.write_bytes(b'A'*4096);self.connection=Connection();self.spec=self.specification()
 def specification(self):
  sha=r.hash_file(self.source);return {'sha256':sha,'bytes':self.source.stat().st_size,'mime':'application/octet-stream','key':'independent-test/originals/'+sha[:2]+'/'+sha}
 def checkpoint(self):
  return self.root/'.runtime/resources/uploads'/(hashlib.sha256(self.spec['key'].encode()).hexdigest()+'.json')
 def run_multipart(self):return r._multipart(self.root,self.connection,self.config,self.spec,self.source)
 def test_unknown_initiation_blocks_duplicate_rpc_until_reconciled(self):
  self.connection.fail_init=True
  with self.assertRaises(TimeoutError):self.run_multipart()
  with self.assertRaisesRegex(ValueError,'initiation result unknown'):self.run_multipart()
  self.assertEqual(self.connection.initiations,1);self.assertEqual(self.connection.listings,0);self.assertEqual(self.connection.completions,[])
  self.assertNotIn('upload_id',json.loads(self.checkpoint().read_text()))
 def test_unknown_part_ack_reconciles_and_skips_exact_existing_part(self):
  self.connection.fail_part_once=True
  with self.assertRaises(TimeoutError):self.run_multipart()
  result=self.run_multipart()
  self.assertEqual(result.version_id,'synthetic-completed-1');self.assertEqual(self.connection.initiations,1)
  self.assertEqual(self.connection.uploads,[{'number':1,'bytes':4096}]);self.assertEqual(self.connection.listings,2)
 def test_existing_part_mismatch_rejects_before_upload_or_completion(self):
  self.connection.fail_part_once=True
  with self.assertRaises(TimeoutError):self.run_multipart()
  self.connection.parts[1].etag='"'+'0'*32+'"'
  with self.assertRaisesRegex(ValueError,'differs from exact original'):self.run_multipart()
  self.assertEqual(len(self.connection.uploads),1);self.assertEqual(self.connection.completions,[])
 def test_parts_are_bounded_to_32_mib(self):
  with self.source.open('r+b') as stream:stream.truncate(33*1024**2)
  self.spec=self.specification();self.run_multipart()
  self.assertEqual([x['bytes'] for x in self.connection.uploads],[32*1024**2,1024**2])
  self.assertEqual(json.loads(self.checkpoint().read_text())['completed_version_id'],'synthetic-completed-1')
 def test_file_growth_after_hash_must_not_complete_an_oversized_object(self):
  def grow():
   with self.source.open('ab') as stream:stream.write(b'B'*17)
  self.connection.list_hook=grow
  outcome='completed'
  try:self.run_multipart()
  except Exception as error:outcome=type(error).__name__+': '+str(error)
  result={'outcome':outcome,'declared_bytes':self.spec['bytes'],'uploaded_parts':self.connection.uploads,'completions':self.connection.completions,'resources_sha256':r.hash_file(Path(r.__file__))}
  self.assertEqual(self.connection.completions,[],'multipart completed changed bytes under the old declared identity')
 def test_unknown_completion_is_resolved_by_head_and_exact_version_verify(self):
  with self.source.open('r+b') as stream:stream.truncate(129*1024**2)
  self.connection.fail_complete_once=True;verified=[]
  def verify(connection,config,spec,destination=None):verified.append((spec['key'],spec['version_id'],spec['bytes']))
  with patch.object(r,'client',return_value=self.connection),patch.object(r,'_remote_hash',side_effect=verify):
   result=r.upload(self.root,self.source)
   again=r.upload(self.root,self.source)
  self.assertEqual(result['version_id'],'synthetic-completed-1');self.assertEqual(again['version_id'],result['version_id'])
  self.assertEqual(self.connection.initiations,1);self.assertEqual(len(self.connection.completions),1);self.assertEqual(len(verified),2)
  self.assertEqual(verified[0][1],'synthetic-completed-1')
 def test_same_length_change_after_hash_must_not_complete_old_identity(self):
  def change():self.source.write_bytes(b'B'*self.spec['bytes'])
  self.connection.list_hook=change
  outcome='completed'
  try:self.run_multipart()
  except Exception as error:outcome=type(error).__name__+': '+str(error)
  result={'outcome':outcome,'declared_sha256':self.spec['sha256'],'changed_sha256':r.hash_file(self.source),'completions':self.connection.completions,'resources_sha256':r.hash_file(Path(r.__file__))}
  self.assertEqual(self.connection.completions,[],'multipart completed changed same-size bytes under the old SHA key')
 def test_test_namespace_isolated_and_rejects_invalid_scope(self):
  self.config['test_namespace']='task-independent-review';(self.root/'config/resource-storage.json').write_text(json.dumps(self.config))
  # Existing-object branch verifies selected namespace; no upload RPC needed.
  self.connection.versions.append('synthetic-existing')
  with patch.object(r,'client',return_value=self.connection),patch.object(r,'_remote_hash'),patch.dict(os.environ,{'REVIEW_RESOURCE_INSTANCE':'vps'}):
   result=r.upload(self.root,self.source)
  self.assertTrue(result['key'].startswith('independent-test/tests/vps/task-independent-review/originals/'))
  with patch.object(r,'client',return_value=self.connection),patch.dict(os.environ,{'REVIEW_RESOURCE_INSTANCE':'other'}):
   with self.assertRaisesRegex(ValueError,'invalid isolated'):r.upload(self.root,self.source)

if __name__=='__main__':unittest.main()
