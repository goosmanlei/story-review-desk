import copy
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
import test_complete_states as fixtures
from review_desk import generation as g, production as p, entity_review as er
from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store
from review_desk.review_text import production_text_blocks


class GenerationTest(unittest.TestCase):
    setUp=fixtures.CompleteStatesTest.setUp
    tearDown=fixtures.CompleteStatesTest.tearDown
    spec=fixtures.CompleteStatesTest.spec
    put=fixtures.CompleteStatesTest.put
    ref=fixtures.CompleteStatesTest.ref
    entity=fixtures.CompleteStatesTest.entity
    full=fixtures.CompleteStatesTest.full
    media=fixtures.CompleteStatesTest.media
    need=fixtures.CompleteStatesTest.need
    associate=fixtures.CompleteStatesTest.associate
    adopt=fixtures.CompleteStatesTest.adopt

    def change(self, oid, **values):
        row=p.record(self.store,oid);payload=copy.deepcopy(row['payload']);payload.update(values)
        self.put({'object_id':oid,'kind':row['kind'],'expected_version':row['version'],'payload':payload})

    def setup_plans(self):
        e=self.entity();e['payload']['production_description']='掌中大小，灰蓝布封，使用压线缝合。';self.put(e)
        self.put(self.full(production_description='完整干燥歌本，纸页平整。'), self.full('wet',production_description='封面洇湿，外沿卷起。'))
        for form in ('full','wet'):
            need=self.need(form);need['payload']['generation']={'format':g.PLAN,'method':'generate','tool':'test','model':'test-audio',
                'parameters':{'format':'wav'},'prompt':'翻页后停顿，保留🧵动作间隔。','inputs':[],
                'output':{'name':'翻页声','description':'用于核对干湿纸页差异','review_criteria':['听清动作，无失真']},'blockers':[]}
            self.put(need)





    def test_adoption_does_not_select_a_plan_input_and_changes_require_acceptance(self):
        self.setup_plans()
        plan=copy.deepcopy(p.record(self.store,'need-wet-overall')['payload']['generation'])
        plan['inputs']=[{'reference':self.ref('need-full-overall'),'use':'同一声源的干燥纸页母版'}]
        self.change('need-wet-overall',generation=plan)
        self.assertFalse(g.readiness(self.store,'need-wet-overall')['ready'])
        self.media();self.associate(range={'start_seconds':.1,'end_seconds':.8});self.adopt(range={'start_seconds':.1,'end_seconds':.8})
        self.assertFalse(g.readiness(self.store,'need-wet-overall')['ready'])
        from review_desk import material_plans as mp, shot_references as sr
        self.change('voice',candidate_requirements=[self.ref('need-full-overall')])
        need=p.record(self.store,'need-wet-overall')
        membership=next(v for v in mp.memberships(self.store,self.ref('voice')['revision_id']) if v['material_id']=='need-full-overall' and v['role']=='result')
        sr.select(self.store,{'id':'explicit-reference','requirement_id':need['object_id'],'expected_revision':need['id'],
            'plan_number':1,'index':0,'input_key':sr.input_key(plan['inputs'][0]),'material_id':'need-full-overall',
            'number':membership['number'],'candidate':self.ref('voice'),'component_id':'original','range':{'start_seconds':.1,'end_seconds':.8}})
        result=g.package(self.store,'need-wet-overall');self.assertEqual(result['inputs'][0]['range'],{'start_seconds':.1,'end_seconds':.8})
        path=self.root/'package';g.write_package(self.store,'need-wet-overall',path)
        self.assertTrue((path/json.loads((path/'manifest.json').read_text())['inputs'][0]['path']).is_file())
        old=copy.deepcopy(plan);plan=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation']);plan['prompt']='前置方案更新'
        self.change('need-full-overall',generation=plan)
        self.assertTrue(g.readiness(self.store,'need-wet-overall')['ready'])
        self.change('need-full-overall',generation={**plan,'inputs':[{'reference':self.ref('need-full-overall'),'use':'循环草稿'}]})
        self.assertTrue(any('循环' in issue for issue in g.readiness(self.store,'need-full-overall')['issues']))



    def test_candidate_association_is_not_generation_or_adoption(self):
        self.setup_plans();self.media();self.associate()
        self.change('voice',candidate_requirements=[self.ref('need-full-overall')])
        self.assertFalse(p.readiness(self.store,'full')['inputs_ready'])
        with self.assertRaisesRegex(ValueError,'exact state'):
            self.change('voice',candidate_requirements=[self.ref('need-wet-overall')])

    def test_exact_plan_comments_cli_and_recovery(self):
        self.setup_plans()
        plan=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation']);plan['parameters']={'pitch':1.0,'epsilon':1e-7}
        self.change('need-full-overall',generation=plan)
        need=p.record(self.store,'need-full-overall')
        self.assertEqual(need['review_parameter_text'],next(b['text'] for b in production_text_blocks(need['payload']) if b.get('field')=='generation.parameters'))
        block=next(b for b in production_text_blocks(need['payload']) if b.get('field')=='generation.prompt')
        anchor={'type':'text','block_id':block['id'],'end_block_id':block['id'],'start':0,'end':len(block['text']),'quote':block['text']}
        comment=self.store.create_comment({'target_object_id':need['object_id'],'target_revision_id':need['id'],'anchor':anchor,'body':'核对实际提示词'})
        before=er.snapshot(self.store,'songbook')
        export(self.store,self.root/'export');dest=self.root/'recovered';shutil.copytree(self.root/'export',dest/'export')
        recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(recovered,dest/'export');self.assertEqual(er.snapshot(recovered,'songbook'),before)
            self.assertEqual(recovered.comment(comment['id']),comment)
        finally:recovered.close()
        (self.root/'config').mkdir();(self.root/'config/instance.json').write_text(json.dumps({'id':'test','title':'test'}))
        result=subprocess.run([sys.executable,'-m','review_desk','--instance',str(self.root),'production-generation-ready','need-full-overall'],capture_output=True,text=True,check=True)
        self.assertTrue(json.loads(result.stdout)['ready'])

if __name__=='__main__':unittest.main()
