"""Story illustrations, structure import and region history use cloud originals."""
import hashlib,json,os,unittest
from unittest.mock import patch
from review_desk import resources as r,resource_bundle as rb
from review_desk.structure import import_structure,select_direction
from review_desk.store import Conflict
from test_resource_recovery import RecoveryFixture
from test_resource_offline import FakeOSS
from test_structure import direction,document

class StoryResourceTest(RecoveryFixture,unittest.TestCase):
 def setUp(self):
  super().setUp()
  self.data=b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'
  sha=hashlib.sha256(self.data).hexdigest()
  self.spec={'sha256':sha,'verified_sha256':sha,'bytes':len(self.data),'mime':'image/svg+xml','key':'bundle-test/originals/'+sha,'version_id':'synthetic-exact-svg'}
  for name in ('source','destination'):
   root=self.root/name
   (root/'resource-bundle'/sha).write_bytes(self.data)
   (root/'config/resource-catalog.json').write_text(json.dumps({**self.config,'entries':{'export/assets/relation.svg':self.spec}}))
  self.anchor={'type':'region','visual_id':'relation-graph','asset_file':'relation.svg','points':[{'x':.1,'y':.1},{'x':.9,'y':.1},{'x':.9,'y':.9}]}
 def test_cloud_source_region_round_trip_preserves_exact_history_without_legacy_files(self):
  source=self.document('illustrated');source['assets']=[{'id':'relation-graph','file':'relation.svg','title':'Exact figure','source_url':'https://example.org/figure'}]
  self.source.put_source(source)
  cloud=FakeOSS();cloud.objects[self.spec['key'],self.spec['version_id']]=(self.data,self.spec['mime'])
  def outside_write():self.assertFalse(self.source.db.in_transaction,'media download ran inside the write transaction')
  cloud.on_get=outside_write
  with patch.dict(os.environ,{'REVIEW_RESOURCES_OFFLINE':'0'}),patch.object(r,'client',return_value=cloud):
   comment=self.source.create_comment({'id':'region','source_id':'illustrated','anchor':self.anchor,'body':'Exact region'})
  self.assertEqual(len(cloud.gets),1);self.assertFalse((self.root/'source/export/assets').exists())
  self.source.change_comment(comment['id'],'EDIT',1,'Revised region opinion')
  manifest=rb.export(self.source,self.exports);rb.restore(self.dest,self.exports)
  self.assertEqual(self.dest.comment('region'),self.source.comment('region'))
  self.assertEqual(self.dest.events(),self.source.events());self.assertEqual(rb.database_identity(self.dest.db_path),manifest['database'])
  self.assertTrue(self.dest.anchor_state('illustrated',comment['target_revision_id'],self.anchor)['valid'])
 def test_structure_import_and_region_comment_resolve_catalog_then_reject_missing_exact_bytes(self):
  self.source.put_source(direction('direction','Direction'))
  selected=select_direction(self.source,'direction',0)
  revision=import_structure(self.source,document(selected['revision']),0)
  comment=self.source.create_comment({'id':'structure-region','target_object_id':'story-structure','target_revision_id':revision['revision'],'anchor':self.anchor,'body':'Structure region'})
  self.assertEqual(comment['anchor'],self.anchor);self.assertFalse((self.root/'source/export/assets').exists())
  for path in r._cache_dir(self.root/'source').glob(self.spec['sha256']+'*'):
   if path.suffix!='.lock':path.unlink()
  (self.root/'source/resource-bundle'/self.spec['sha256']).unlink()
  with self.assertRaises(Conflict):self.source.create_comment({'id':'missing-region','target_object_id':'story-structure','target_revision_id':revision['revision'],'anchor':self.anchor,'body':'Must fail'})
  self.assertIsNone(self.source.comment('missing-region'))

if __name__=='__main__':unittest.main()
