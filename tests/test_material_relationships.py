import copy
import shutil
import unittest
import test_generation as fixtures
from review_desk import generation as g, production as p, entity_review as er
from review_desk.bundle import export, restore
from review_desk.store import Store, Conflict
from review_desk.review_text import production_text_blocks


class MaterialRelationshipsTest(unittest.TestCase):
    setUp=fixtures.GenerationTest.setUp
    tearDown=fixtures.GenerationTest.tearDown
    spec=fixtures.GenerationTest.spec
    put=fixtures.GenerationTest.put
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

    def relationship(self):
        self.put(self.entity('owner'))
        return self.spec('belongs','RELATION',relation_type='entity',entities=[self.ref('owner'),self.ref('songbook')],
            label='使用歌本',direction='forward',category='use',basis='script',sources=[self.source],applies_to=[self.source])

    def test_legacy_acceptance_can_be_cancelled_without_a_complete_plan_and_never_reappears(self):
        self.put(self.entity());self.put(self.full())
        scope=er.current_scope(self.store,'songbook')
        self.put(self.spec('old-yes','JUDGMENT',acceptance_model=er.ACCEPTANCE_MODEL,acceptance_scope=scope,
                           target=scope['entity'],verdict='accepted',actor='用户',reason='旧版认可'))
        before=er.snapshot(self.store,'songbook');old=p.record(self.store,'old-yes')
        self.assertTrue(before['can_revoke']);self.assertFalse(before['can_accept']);self.assertIsNone(before['accepted'])
        request={'entity_id':'songbook','action':'revoke','decision_ref':self.ref('old-yes'),'expected_version':0,'actor':'用户','reason':'取消旧认可'}
        g.decide(self.store,request)
        self.assertEqual(p.record(self.store,'old-yes'),old)
        after=er.snapshot(self.store,'songbook');self.assertFalse(after['can_revoke']);self.assertEqual(len(after['history']),2)
        with self.assertRaises(Conflict):g.decide(self.store,request)
        cancelled=g.decision(self.store,'songbook');self.assertFalse(er.snapshot(self.store,'songbook',cancelled['id'])['can_accept'])
        export(self.store,self.root/'export');dest=self.root/'restored';shutil.copytree(self.root/'export',dest/'export')
        recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(recovered,dest/'export');self.assertEqual(er.snapshot(recovered,'songbook'),after)
        finally:recovered.close()

    def test_changed_relationship_invalidates_generation_but_keeps_cancel_and_media_adoption(self):
        self.setup_plans();self.put(self.relationship());self.decide();old=g.decision(self.store,'songbook')
        self.assertEqual(er.snapshot(self.store,'owner')['relationships'][0]['object_id'],'belongs')
        self.media();self.associate();self.adopt()
        self.assertTrue(p.readiness(self.store,'full')['requirements'][0]['adoption'])
        self.change('belongs',label='保管歌本')
        self.assertIsNone(g.accepted(self.store,'songbook'));self.assertTrue(er.snapshot(self.store,'songbook')['can_revoke'])
        self.assertEqual(er.snapshot(self.store,'songbook',old['id'])['relationships'][0]['payload']['label'],'使用歌本')
        self.decide('revoke');self.assertFalse(er.snapshot(self.store,'songbook')['can_revoke'])
        self.decide();self.assertTrue(g.accepted(self.store,'songbook'))
        self.change('belongs',status='withdrawn');self.assertIsNone(g.accepted(self.store,'songbook'))

    def test_material_provenance_stays_on_exact_call_and_fields_are_commentable(self):
        self.setup_plans();plan=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation']);plan.pop('tool')
        self.change('need-full-overall',generation=plan);self.decide();manifest=g.package(self.store,'need-full-overall')
        self.assertNotIn('tool',manifest)
        call=self.spec('actual','CALL',method='generation',tool='external-cli',status='submitted',inputs=[],outputs=[],
                       generation_requirement=manifest['requirement'],generation_acceptances=manifest['acceptances'],
                       **{k:manifest[k] for k in ('model','parameters','prompt')})
        self.put(call);original=self.ref('actual');component=self.media()
        self.put(self.spec('result','ASSET',media_type='audio',subjects=[self.ref('songbook')],states=[self.ref('full')],components=[component],production=original,lineage={}))
        self.change('actual',status='completed',outputs=[self.ref('result')])
        read=p.snapshot(self.store,object_id='result');self.assertEqual(read['review_context']['call']['id'],original['revision_id'])
        field=next(b for b in production_text_blocks(call['payload']) if b.get('field')=='call.prompt')
        anchor={'type':'text','block_id':field['id'],'end_block_id':field['id'],'start':0,'end':len(field['text']),'quote':field['text']}
        c=self.store.create_comment({'target_object_id':'actual','target_revision_id':original['revision_id'],'anchor':anchor,'body':'准确生成输入意见'})
        self.assertIn(c['target_revision_id'],{r['revision_id'] for r in er.snapshot(self.store,'songbook')['comment_targets']})
        self.assertTrue(self.store.anchor_state('actual',original['revision_id'],anchor)['valid'])

    def test_invalid_relationship_reference_is_rejected(self):
        self.setup_plans();row=self.relationship();row['payload']['entities'][1]=self.ref('full')
        with self.assertRaises(ValueError):self.put(row)


if __name__=='__main__':unittest.main()
