import copy
import json
import unittest
from test_generation import GenerationTest
from review_desk import production as p, production_current as c, production_current_migration as migration
from review_desk import legacy_material_plans as legacy, material_plans
from test_methods import seed
from review_desk import method_media, methods
from review_desk.bundle import export, restore
from review_desk.store import Store, Conflict


class LegacyPlanTest(unittest.TestCase):
    for name in ('setUp','tearDown','spec','put','ref','entity','full','need','setup_plans','media'):
        locals()[name] = getattr(GenerationTest, name)

    def test_same_identity_idempotence_edits_and_empty_recovery(self):
        self.setup_plans();self.media()
        migration.apply(self.store,migration.plan(self.store))
        tables=('business_codes','production_submissions','production_candidates','production_candidate_targets')
        before={t:[tuple(r) for r in self.store.db.execute('SELECT * FROM '+t)] for t in tables}
        result=legacy.initialize(self.store)
        self.assertEqual(result['created'],['voice'])
        self.assertEqual(legacy.initialize(self.store),{'created':[],'existing':['voice']})
        for table, rows in before.items():self.assertEqual([tuple(r) for r in self.store.db.execute('SELECT * FROM '+table)], rows)
        plan=p.record(self.store,legacy.plan_id('voice'))
        snapshot=c.material_snapshot(self.store,'voice')[0]
        self.assertEqual(snapshot['plan']['object_id'],plan['object_id'])
        self.assertEqual(material_plans.card_counts(self.store,[plan['object_id']])[plan['object_id']]['candidate_count'],1)
        original=copy.deepcopy(snapshot['results'])
        payload=copy.deepcopy(plan['payload']);payload['generation']['prompt']='补充当前制作意图🧵。'
        seed(self.store,'media-plan',['draft','review','result']);method_media.activate(self.store)
        prepared=method_media.prepare(self.store,{'object_id':plan['object_id'],'payload':payload,'expected_version':plan['version'],'run_id':'legacy-edit','step_id':'a'})
        request,execution=prepared['request'],prepared['execution']
        for stage in ('draft','review','result'):
            artifact=methods.artifact(self.store,{**request,'execution':methods.reference(execution),'stage':stage,'output':{'assessment':'当前修改保留历史原件'} if stage=='review' else method_media.output(payload)})
        payload['method_basis']={'execution':methods.reference(execution),'artifact':methods.reference(artifact),'run_id':'legacy-edit','step_id':'a'}
        self.put({'object_id':plan['object_id'],'kind':'REQUIREMENT','expected_version':plan['version'],'payload':payload})
        with self.assertRaises(Conflict):self.put({'object_id':plan['object_id'],'kind':'REQUIREMENT','expected_version':plan['version'],'payload':payload})
        changed=p.record(self.store,plan['object_id']);payload.pop('current_plan_for')
        with self.assertRaises((Conflict,ValueError)):self.put({'object_id':plan['object_id'],'kind':'REQUIREMENT','expected_version':changed['version'],'payload':payload})
        self.assertEqual(c.material_snapshot(self.store,'voice')[0]['results'],original)
        export(self.store,self.root/'export')
        recovered=Store(self.root/'recovered/.runtime/review.sqlite3')
        try:
            restore(recovered,self.root/'export')
            self.assertEqual(c.material_snapshot(recovered,'voice'),c.material_snapshot(self.store,'voice'))
            self.assertEqual(legacy.initialize(recovered)['created'],[])
        finally:recovered.close()
