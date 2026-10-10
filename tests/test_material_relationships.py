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

    def relationship(self):
        self.put(self.entity('owner'))
        return self.spec('belongs','RELATION',relation_type='entity',entities=[self.ref('owner'),self.ref('songbook')],
            label='使用歌本',direction='forward',category='use',basis='script',sources=[self.source],applies_to=[self.source])




    def test_media_keeps_its_requirement_round_when_the_plan_is_no_longer_in_current_preparation(self):
        self.setup_plans();self.media();self.associate('detail')
        optional=self.need(slot='voice-detail',required=False)
        optional['payload']['generation']=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation'])
        self.put(optional)
        self.change('voice',candidate_requirements=[self.ref('need-full-voice-detail')])
        self.change('need-full-voice-detail',status='withdrawn',withdrawal_reason='当前准备不再使用，保留原件与历史轮次')
        view=g.snapshot(self.store,'songbook')
        self.assertNotIn('need-full-voice-detail',[r['object_id'] for r in view['requirements']])
        rounds=view['material_versions']['need-full-voice-detail']
        self.assertIn('voice',[r['object_id'] for version in rounds for r in version['results']])

    def test_relationship_revision_preserves_the_original_comment_and_evidence_after_restore(self):
        self.setup_plans();self.put(self.relationship())
        old=p.record(self.store,'belongs');text=old['payload']['blocks'][0]['text']
        self.store.create_comment({'target_object_id':old['object_id'],'target_revision_id':old['id'],
            'anchor':{'type':'text','block_id':'notes','end_block_id':'notes','start':0,'end':len(text),'quote':text},
            'body':'关系旧版的准确意见'})
        original_comments=self.store.comments();original_source=p.source_excerpt(self.store,old['payload']['sources'][0])
        self.change('belongs',label='保管歌本')
        latest=p.record(self.store,'belongs')
        self.assertEqual(p.record(self.store,revision_id=old['id']),{**old,'current_revision':latest['id']})
        self.assertEqual(self.store.comments(),original_comments)
        export(self.store,self.root/'export');dest=self.root/'relationship-restored'
        shutil.copytree(self.root/'export',dest/'export');restored=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(restored,dest/'export')
            self.assertEqual(restored.comments(),original_comments)
            self.assertEqual(p.record(restored,revision_id=old['id']),{**old,'current_revision':latest['id']})
            self.assertEqual(p.source_excerpt(restored,old['payload']['sources'][0]),original_source)
            self.assertEqual(p.record(restored,'belongs')['payload']['label'],'保管歌本')
        finally:restored.close()

    def test_material_provenance_stays_on_exact_call_and_fields_are_commentable(self):
        self.setup_plans();plan=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation']);plan.pop('tool')
        plan['parameters']={'prompt':plan['prompt'],'pitch':1.0,'epsilon':1e-7,'nested':{'中文':'原参数'}}
        self.change('need-full-overall',generation=plan);manifest=g.package(self.store,'need-full-overall')
        self.assertNotIn('tool',manifest)
        call=self.spec('actual','CALL',method='generation',tool='external-cli',status='submitted',inputs=[],outputs=[],
                       generation_requirement=manifest['requirement'], 
                       **{k:manifest[k] for k in ('model','parameters','prompt')})
        self.put(call);original=self.ref('actual');component=self.media()
        saved=p.record(self.store,'actual');parameters=next(b for b in production_text_blocks(saved['payload']) if b.get('field')=='call.parameters')
        self.assertEqual(saved['review_call_parameter_text'],parameters['text'])
        self.assertIn('1.0',parameters['text']);self.assertIn('1e-07',parameters['text'])
        self.assertNotIn('prompt',parameters['text']);self.assertEqual(saved['payload']['parameters'],plan['parameters'])
        parameter_anchor={'type':'text','block_id':parameters['id'],'end_block_id':parameters['id'],'start':0,'end':len(parameters['text']),'quote':parameters['text']}
        self.store.create_comment({'target_object_id':'actual','target_revision_id':original['revision_id'],'anchor':parameter_anchor,'body':'保留准确参数字符'})
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
