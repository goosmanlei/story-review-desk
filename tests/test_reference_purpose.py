import unittest
import test_audiovisual as av_fixture
import test_production as fixture
from review_desk import production as p, material_relations as mr, material_plans


class ReferencePurposeTest(unittest.TestCase):
    setUp = fixture.ProductionTest.setUp
    tearDown = fixture.ProductionTest.tearDown
    spec = fixture.ProductionTest.spec
    put = fixture.ProductionTest.put
    ref = fixture.ProductionTest.ref
    setup_story = av_fixture.AudiovisualTest.setup_story
    shot = av_fixture.AudiovisualTest.shot
    composition = av_fixture.AudiovisualTest.composition
    need = av_fixture.AudiovisualTest.need
    media = fixture.ProductionTest.media

    def relation(self, oid='edge', upstream='master', downstream='consumer'):
        return self.spec(oid, 'MATERIAL_RELATION', upstream=self.ref(upstream), downstream_id=downstream,
                         context=self.ref('av-shot'), purpose='固定身份', preserve='比例', change='朝向', check='逐项核对',
                         type_id='identity', type_label='身份参考', type_version=1,
                         type_definition={'endpoints':['REQUIREMENT','REQUIREMENT'],'direction':'directed','attributes':{}},
                         semantics='reference', necessity='required', basis='production_choice', sources=self.sources)

    def prepare(self):
        self.composition(); self.put(self.need('master'), self.need('consumer'))
        self.put(self.relation())
        value={'reference':self.ref('master'),'relation':self.ref('edge'),'use':'保持身份'}
        updated=self.need('consumer',[value],relation_model='context-v1');updated['expected_version']=1;self.put(updated)

    def test_old_plan_uses_exact_edge_and_does_not_borrow_later_comparisons(self):
        self.prepare(); old=self.ref('consumer'); edge=self.ref('edge')
        new=self.relation();new['expected_version']=1;new['payload']['purpose']='新用途';self.put(new)
        self.put(self.need('other'));self.put(self.relation('new-edge','other'))
        updated=self.need('consumer',[],relation_model='context-v1');updated['expected_version']=2;self.put(updated)
        rows=mr.for_material(self.store,'consumer',old['revision_id'])
        self.assertEqual([r['id'] for r in rows],[edge['revision_id']])
        self.assertEqual(rows[0]['payload']['purpose'],'固定身份')
        self.assertEqual(rows[0]['downstream'],old)

    def test_current_master_exposes_old_reference_without_attributing_it_to_new_revision(self):
        self.prepare(); old=self.ref('master')
        changed=self.need('master');changed['expected_version']=1;changed['payload']['generation']['prompt']='新版';self.put(changed)
        rows=mr.for_material(self.store,'master')
        self.assertEqual(len(rows),1);self.assertFalse(rows[0]['upstream_matches'])
        self.assertEqual(rows[0]['payload']['upstream'],old)
        self.assertEqual(mr.for_material(self.store,'master',old['revision_id'])[0]['payload']['upstream'],old)

    def test_only_real_original_in_the_exact_downstream_plan_counts_as_result(self):
        self.prepare(); self.media('original')
        candidate=p.record(self.store,'original')
        material_plans.bind(self.store,'consumer',1,candidate);self.store.db.commit()
        row=mr.for_material(self.store,'master')[0]
        self.assertEqual(row['result'],self.ref('original'))
        # A new plan must not inherit the prior plan's original.
        with self.store.db:self.store.db.execute("UPDATE material_plan_versions SET frozen=1 WHERE material_id='consumer'")
        updated=self.need('consumer',[{'reference':self.ref('master'),'relation':self.ref('edge'),'use':'新用法'}],relation_model='context-v1')
        updated['expected_version']=2;updated['payload']['generation']['prompt']='新方案';self.put(updated)
        self.assertIsNone(mr.for_material(self.store,'master')[0]['result'])

    def test_historical_use_opinion_keeps_its_revision_text_and_anchor(self):
        self.prepare(); old=self.ref('edge')
        from review_desk.review_text import production_text_blocks
        block=next(b for b in production_text_blocks(p.record(self.store,'edge')['payload']) if b.get('field')=='purpose')
        anchor={'type':'text','block_id':block['id'],'end_block_id':block['id'],'start':0,'end':2,'quote':'固定'}
        comment=self.store.create_comment({'target_object_id':'edge','target_revision_id':old['revision_id'],
                                          'anchor':anchor,'body':'旧版用途意见'})
        changed=self.relation();changed['expected_version']=1;changed['payload']['purpose']='当前不同用途';self.put(changed)
        context=mr.review_context(self.store,'master')
        self.assertEqual(context['relations'][0]['payload']['purpose'],'当前不同用途')
        self.assertEqual(context['comment_records'][0]['id'],old['revision_id'])
        self.assertEqual(context['comment_records'][0]['payload']['purpose'],'固定身份')
        self.assertEqual(self.store.comment(comment['id'])['anchor'],anchor)
