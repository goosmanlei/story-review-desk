import copy
import json
import shutil
import unittest
from unittest.mock import patch
import test_material_versions as fixtures
from review_desk import material_plans as mp, production as p, generation as g
from review_desk.bundle import export, restore
from review_desk.store import Store, Conflict


class PlanVersionsTest(unittest.TestCase):
    setUp=fixtures.fixtures.GenerationTest.setUp
    tearDown=fixtures.MaterialVersionsTest.tearDown
    spec=fixtures.MaterialVersionsTest.spec
    put=fixtures.MaterialVersionsTest.put
    ref=fixtures.MaterialVersionsTest.ref
    entity=fixtures.MaterialVersionsTest.entity
    full=fixtures.MaterialVersionsTest.full
    need=fixtures.MaterialVersionsTest.need
    media=fixtures.MaterialVersionsTest.media
    change=fixtures.MaterialVersionsTest.change
    setup_plans=fixtures.MaterialVersionsTest.setup_plans
    generate=fixtures.MaterialVersionsTest.generate

    def test_same_scheme_multiple_calls_and_association_updates_are_one_version(self):
        self.setup_plans();self.generate();self.generate('call2','other')
        versions=mp.snapshot(self.store,'need-full-overall')
        self.assertEqual(len(versions),1)
        self.assertEqual(len(versions[0]['results']),2)
        cid=versions[0]['results'][0]['candidate_id']
        self.change('generated',verification={'checked':True})
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')[0]['results']),2)
        self.assertIn(cid,[r['candidate_id'] for r in mp.snapshot(self.store,'need-full-overall')[0]['results']])
        asset=p.record(self.store,'generated')['payload'];renamed=copy.deepcopy(asset)
        renamed['components'][0]['id']='renamed-file-label'
        self.assertEqual(mp.identity(asset),mp.identity(renamed))
        self.change('need-full-overall',title='metadata only')
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')),1)

    def test_draft_edits_then_frozen_scheme_changes(self):
        self.setup_plans()
        plan=p.record(self.store,'need-full-overall')['payload']['generation']
        self.change('need-full-overall',generation={**plan,'prompt':'draft correction'})
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')),1)
        self.generate()
        self.change('need-full-overall',generation={**plan,'prompt':'new scheme'})
        versions=mp.snapshot(self.store,'need-full-overall')
        self.assertEqual(len(versions),2);self.assertFalse(versions[0]['results']);self.assertEqual(len(versions[1]['results']),1)
        mp.validate(self.store)

    def test_comments_never_create_versions_and_wrong_anchor_rolls_back(self):
        self.setup_plans();self.generate()
        data={'id':'opinion','target_object_id':'generated','target_revision_id':self.ref('generated')['revision_id'],
              'body':'revise next plan','anchor':{'type':'global'},'material_context':{'material_id':'need-full-overall','number':1,'model':'plan-v1'}}
        self.store.create_comment(data);self.store.create_comment(data)
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')),1)
        self.assertEqual(len(self.store.events()),1)
        with self.assertRaises(Conflict):self.store.create_comment({**data,'id':'wrong','material_context':{**data['material_context'],'number':2}})
        with self.assertRaises(Conflict):self.store.create_comment({**data,'material_context':{**data['material_context'],'number':2}})
        self.assertEqual(len(self.store.events()),1)

    def test_random_strategy_and_exact_reference_signatures(self):
        plan={'generation':{'method':'generate','model':'x','parameters':{},'prompt':'p','inputs':[], 'randomization':{'mode':'random'}}}
        base=mp.scheme(plan,'REQUIREMENT')
        call={**plan['generation'],'parameters':{'seed':123},'actual_seed':123}
        self.assertEqual(base,mp.scheme(call,'CALL'))
        call['parameters']['seed']=456;self.assertEqual(base,mp.scheme(call,'CALL'))
        call['randomization']={'mode':'fixed','seed':456};self.assertNotEqual(base,mp.scheme(call,'CALL'))
        for key,val in [('model','other'),('prompt','other'),('parameters',{'resolution':'720p'}),('inputs',[{'reference':{'object_id':'a','revision_id':'r'},'component_id':'one','crop':{'x':0}}])]:
            altered=copy.deepcopy(plan);altered['generation'][key]=val
            self.assertNotEqual(base,mp.scheme(altered,'REQUIREMENT'))

    def test_failed_unknown_calls_freeze_scheme_and_do_not_create_results(self):
        self.setup_plans()
        for name,status in [('failed','failed'),('unknown','unknown')]:
            plan=p.record(self.store,'need-full-overall')['payload']['generation']
            with patch.object(g,'validate_call'): # seed existing failed provider history
                self.put(self.spec(name,'CALL',status=status,method='generation',tool='test',outputs=[],inputs=[],generation_requirement=self.ref('need-full-overall'),**{k:plan[k] for k in ('model','parameters','prompt')}))
            with self.assertRaises(Conflict):self.change(name,prompt='rewrite history')
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')),1)
        self.assertEqual(mp.snapshot(self.store,'need-full-overall')[0]['results'],[])

    def test_schema5_roundtrip_and_migration_is_idempotent(self):
        self.setup_plans();self.generate()
        export(self.store,self.root/'export')
        dest=self.root/'recover';shutil.copytree(self.root/'export',dest/'export')
        recovered=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(recovered,dest/'export')
            self.assertEqual(mp.dump(self.store),mp.dump(recovered))
            plan=mp.migration_plan(recovered)
            self.assertTrue(mp.migrate(recovered,plan)['already_applied'])
        finally:recovered.close()

    def test_outputs_of_one_call_do_not_inherit_each_others_uses(self):
        self.setup_plans();self.generate()
        # An explicit second-state use is attached to only the second output.
        original=p.record(self.store,'generated')['payload']
        second=copy.deepcopy(original)
        second['states']=[self.ref('wet')]
        second['state_coverage']=[{'state':self.ref('wet'),'role':'overall','component_id':'original','detail':'second output only'}]
        second['candidate_requirements']=[self.ref('need-wet-overall')]
        self.put(self.spec('second-output','ASSET',**{k:v for k,v in second.items() if k not in ('format','title','blocks')}))
        self.assertFalse(any(v['material_id']=='need-wet-overall' for v in mp.memberships(self.store,self.ref('generated')['revision_id'])))
        # The first pass may attach the already completed call receipt to its
        # newly associated use; it must not associate the other output there.
        mp.migrate(self.store,mp.migration_plan(self.store))
        self.assertFalse(any(v['material_id']=='need-wet-overall' for v in mp.memberships(self.store,self.ref('generated')['revision_id'])))
        before=mp.dump(self.store)
        self.assertTrue(mp.migrate(self.store,mp.migration_plan(self.store))['already_applied'])
        self.assertEqual(before,mp.dump(self.store))
