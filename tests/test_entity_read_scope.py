"""Changes remain visible between HTTP-style reads; one read stays consistent."""
import copy
import shutil
import unittest
import test_generation as fixtures
from review_desk import production as p, generation as g, entity_review as er
from review_desk.bundle import export, restore
from review_desk.store import Store


class EntityReadScopeTest(unittest.TestCase):
    setUp=fixtures.GenerationTest.setUp
    tearDown=fixtures.GenerationTest.tearDown
    put=fixtures.GenerationTest.put
    spec=fixtures.GenerationTest.spec
    ref=fixtures.GenerationTest.ref
    entity=fixtures.GenerationTest.entity
    full=fixtures.GenerationTest.full
    need=fixtures.GenerationTest.need
    media=fixtures.GenerationTest.media
    associate=fixtures.GenerationTest.associate
    adopt=fixtures.GenerationTest.adopt
    change=fixtures.GenerationTest.change
    setup_plans=fixtures.GenerationTest.setup_plans
    decide=fixtures.GenerationTest.decide

    def read(self, revision=None):
        value=er.snapshot(self.store,'songbook',revision)
        self.assertFalse(hasattr(self.store,'_production_reads'))
        self.assertFalse(self.store.db.in_transaction)
        return value

    def test_entity_state_plan_asset_relation_comment_decision_import_and_history_are_fresh(self):
        self.setup_plans();self.decide();accepted=g.decision(self.store,'songbook');before=self.read()
        self.change('songbook',facts=['外部确认的新事实'])
        self.assertEqual(self.read()['entity']['payload']['facts'],['外部确认的新事实'])
        self.change('full',production_description='修改后的完整状态')
        self.assertEqual(self.read()['states'][0]['id'],self.ref('full')['revision_id'])
        payload=copy.deepcopy(p.record(self.store,'need-full-overall')['payload'])
        payload.update(scope=self.ref('full'),states=[self.ref('full')]);payload['generation']['prompt']='新版提示词'
        self.change('need-full-overall',**payload)
        latest=self.read();self.assertEqual(next(r for r in latest['requirements'] if r['object_id']=='need-full-overall')['payload']['generation']['prompt'],'新版提示词')
        self.media();self.associate();self.change('voice',subjects=[self.ref('songbook')],candidate_requirements=[self.ref('need-full-overall')])
        self.assertTrue(self.read()['media'])
        self.change('voice',blocks=[{'id':'notes','text':'原件关联的新说明'}])
        self.assertEqual(self.read()['media'][0]['record']['id'],self.ref('voice')['revision_id'])
        self.put(self.entity('owner'))
        self.put(self.spec('belongs','RELATION',relation_type='entity',entities=[self.ref('owner'),self.ref('songbook')],label='使用歌本',direction='forward',category='use',basis='script',sources=[self.source],applies_to=[self.source]))
        self.assertEqual(self.read()['relationships'][0]['payload']['label'],'使用歌本')
        self.change('belongs',label='保管歌本')
        self.assertEqual(self.read()['relationships'][0]['payload']['label'],'保管歌本')
        self.adopt();self.read();self.assertEqual(p.record(self.store,'use-full-overall')['payload']['asset'],self.ref('voice'))
        comment=self.store.create_comment({'target_object_id':'voice','target_revision_id':self.ref('voice')['revision_id'],'anchor':{'type':'global'},'body':'新增评论'})
        self.assertIn(comment['target_revision_id'],{r['id'] for r in self.read()['comment_records']})
        self.store.change_comment(comment['id'],'CLOSE',1)
        self.read();self.assertEqual(self.store.comment(comment['id'])['status'],'CLOSED')
        self.decide('revoke');self.assertEqual(self.read()['decision_version'],2)
        new=self.full('imported',production_description='导入的新状态');self.put(new)
        self.assertIn('imported',{r['object_id'] for r in self.read()['states']})
        historical=self.read(accepted['id']);self.assertEqual(historical['scope'],before['scope'])
        self.assertEqual(historical['entity']['id'],before['entity']['id'])
        export(self.store,self.root/'export');dest=self.root/'empty';shutil.copytree(self.root/'export',dest/'export')
        other=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(other,dest/'export');self.assertEqual(er.snapshot(other,'songbook'),self.read())
            self.assertEqual(other.comment(comment['id']),self.store.comment(comment['id']))
        finally:other.close()

    def test_concurrent_writer_does_not_mix_heads_and_next_read_observes_it(self):
        self.setup_plans();self.store.db.execute("PRAGMA journal_mode=WAL");other=Store(self.store.db_path)
        try:
            with p.read_scope(self.store):
                old=p.record(self.store,'songbook');p.current_records(self.store)
                payload=copy.deepcopy(old['payload']);payload['facts']=['另一连接写入']
                p.import_records(other,{'format':'production-import-v1','records':[{'object_id':'songbook','kind':'ENTITY','expected_version':old['version'],'payload':payload}]})
                self.assertEqual(p.record(self.store,'songbook')['id'],old['id'])
                self.assertEqual(next(r for r in p.current_records(self.store) if r['object_id']=='songbook')['id'],old['id'])
            self.assertEqual(self.read()['entity']['payload']['facts'],['另一连接写入'])
        finally:other.close()

    def test_failure_clears_cache_and_does_not_rollback_callers_transaction(self):
        self.setup_plans()
        with self.assertRaises(KeyError):er.snapshot(self.store,'missing')
        self.assertFalse(hasattr(self.store,'_production_reads'));self.assertFalse(self.store.db.in_transaction)
        self.store.db.execute('BEGIN')
        with p.read_scope(self.store):
            with p.read_scope(self.store):self.assertTrue(p.record(self.store,'songbook'))
        self.assertTrue(self.store.db.in_transaction);self.store.db.rollback();self.read()
