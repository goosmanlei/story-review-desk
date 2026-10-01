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

    def decide(self, action='accept', scope=None, expected=None):
        current=er.snapshot(self.store,'songbook')
        return g.decide(self.store,{'entity_id':'songbook','action':action,'expected_version':current['decision_version'] if expected is None else expected,
            'scope':scope or current['scope'],'actor':'技术测试','reason':'隔离测试，非真实创作采纳'})

    def test_accept_revoke_reaccept_and_comments_do_not_depend_on_candidates(self):
        self.setup_plans();self.decide();first=g.decision(self.store,'songbook')
        self.store.create_comment({'target_object_id':'full','target_revision_id':self.ref('full')['revision_id'],'anchor':{'type':'global'},'body':'采纳后继续评论'})
        self.media();self.associate();self.assertTrue(er.snapshot(self.store,'songbook')['can_revoke'])
        self.assertEqual(g.accepted(self.store,'songbook')['id'],first['id'])
        ready=g.package(self.store,'need-full-overall');self.assertEqual(ready['acceptances'],[self.ref(first['object_id'])])
        self.decide('revoke');self.assertFalse(g.readiness(self.store,'need-full-overall')['ready'])
        self.assertEqual(er.snapshot(self.store,'songbook',first['id'])['accepted']['id'],first['id'])
        with self.assertRaises(Conflict):self.decide(expected=1)
        self.decide();self.assertEqual(g.decision(self.store,'songbook')['version'],3)
        self.assertTrue(g.readiness(self.store,'need-full-overall')['ready'])

    def test_changes_reject_stale_acceptance_atomically_and_require_every_plan(self):
        self.setup_plans();scope=g.current_scope(self.store,'songbook');self.decide()
        self.change('wet',production_description='边缘破损，完整描述改变。')
        self.assertIsNone(g.accepted(self.store,'songbook'))
        with self.assertRaises(Conflict):self.decide(scope=scope)
        self.assertFalse(er.snapshot(self.store,'songbook')['can_accept']) # old requirement no longer covers current state
        need=p.record(self.store,'need-wet-overall')['payload'];need=copy.deepcopy(need);need['scope']=self.ref('wet');need['states']=[self.ref('wet')]
        self.change('need-wet-overall',**need);self.decide()
        self.change('need-full-overall',generation={**p.record(self.store,'need-full-overall')['payload']['generation'],'prompt':'另一种处理'})
        self.assertIsNone(g.accepted(self.store,'songbook'))

    def test_pending_master_can_be_accepted_but_execution_requires_exact_adoption(self):
        self.setup_plans()
        plan=copy.deepcopy(p.record(self.store,'need-wet-overall')['payload']['generation'])
        plan['inputs']=[{'reference':self.ref('need-full-overall'),'use':'同一声源的干燥纸页母版'}]
        self.change('need-wet-overall',generation=plan);self.decide()
        self.assertTrue(g.accepted(self.store,'songbook'))
        self.assertFalse(g.readiness(self.store,'need-wet-overall')['ready'])
        self.media();self.associate(range={'start_seconds':.1,'end_seconds':.8});self.adopt(range={'start_seconds':.1,'end_seconds':.8})
        result=g.package(self.store,'need-wet-overall');self.assertEqual(result['inputs'][0]['range'],{'start_seconds':.1,'end_seconds':.8})
        path=self.root/'package';g.write_package(self.store,'need-wet-overall',path)
        self.assertTrue((path/json.loads((path/'manifest.json').read_text())['inputs'][0]['path']).is_file())
        old=copy.deepcopy(plan);plan=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation']);plan['prompt']='前置方案更新'
        self.change('need-full-overall',generation=plan)
        self.assertFalse(er.snapshot(self.store,'songbook')['preparation']['complete'])
        self.assertFalse(g.readiness(self.store,'need-wet-overall')['ready'])
        with self.assertRaises(ValueError):
            self.change('need-full-overall',generation={**plan,'inputs':[{'reference':self.ref('need-wet-overall'),'use':'构成循环'}]})

    def test_execution_call_checks_current_decision_and_exact_inputs(self):
        self.setup_plans();self.decide();package=g.package(self.store,'need-full-overall')
        call=self.spec('draw','CALL',method='generation',status='submitted',inputs=[],outputs=[],generation_requirement=package['requirement'],generation_acceptances=package['acceptances'],**{k:package[k] for k in ('tool','model','parameters','prompt')})
        wrong=copy.deepcopy(call);wrong['payload']['prompt']='未采纳的输入'
        with self.assertRaises(Conflict):self.put(wrong)
        self.put(call);self.decide('revoke')
        newer=copy.deepcopy(call);newer['object_id']='another'
        with self.assertRaises(Conflict):self.put(newer)
        self.assertEqual(p.record(self.store,'draw')['payload'],call['payload'])
        component=self.media()
        self.put(self.spec('generated','ASSET',media_type='audio',subjects=[],states=[],components=[component],production=self.ref('draw'),lineage={}))
        self.change('draw',status='completed',outputs=[self.ref('generated')])
        self.assertEqual(p.record(self.store,'draw')['payload']['generation_acceptances'],package['acceptances'])

    def test_candidate_association_is_not_generation_or_adoption(self):
        self.setup_plans();self.decide();before=g.accepted(self.store,'songbook')['id'];self.media();self.associate()
        self.change('voice',candidate_requirements=[self.ref('need-full-overall')])
        self.assertEqual(g.accepted(self.store,'songbook')['id'],before)
        self.assertFalse(p.readiness(self.store,'full')['inputs_ready'])
        with self.assertRaisesRegex(ValueError,'exact state'):
            self.change('voice',candidate_requirements=[self.ref('need-wet-overall')])

    def test_exact_plan_comments_cli_and_recovery(self):
        self.setup_plans()
        plan=copy.deepcopy(p.record(self.store,'need-full-overall')['payload']['generation']);plan['parameters']={'pitch':1.0,'epsilon':1e-7}
        self.change('need-full-overall',generation=plan)
        self.decide();need=p.record(self.store,'need-full-overall')
        self.assertEqual(need['review_parameter_text'],next(b['text'] for b in production_text_blocks(need['payload']) if b.get('field')=='generation.parameters'))
        block=next(b for b in production_text_blocks(need['payload']) if b.get('field')=='generation.prompt')
        anchor={'type':'text','block_id':block['id'],'end_block_id':block['id'],'start':0,'end':len(block['text']),'quote':block['text']}
        comment=self.store.create_comment({'target_object_id':need['object_id'],'target_revision_id':need['id'],'anchor':anchor,'body':'核对实际提示词'})
        self.decide('revoke');before=er.snapshot(self.store,'songbook')
        export(self.store,self.root/'export');dest=self.root/'recovered';shutil.copytree(self.root/'export',dest/'export')
        recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(recovered,dest/'export');self.assertEqual(er.snapshot(recovered,'songbook'),before)
            self.assertEqual(recovered.comment(comment['id']),comment)
        finally:recovered.close()
        (self.root/'config').mkdir();(self.root/'config/instance.json').write_text(json.dumps({'id':'test','title':'test'}))
        result=subprocess.run([sys.executable,'-m','review_desk','--instance',str(self.root),'production-generation-ready','need-full-overall'],capture_output=True,text=True,check=True)
        self.assertFalse(json.loads(result.stdout)['ready'])

if __name__=='__main__':unittest.main()
