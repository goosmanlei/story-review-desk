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

    def test_retired_demand_keeps_identity_and_snapshot_without_resurrecting_object(self):
        self.setup_plans();self.media()
        migration.apply(self.store,migration.plan(self.store))
        mid='retired-voice-demand'
        with self.store.db:
            self.store.db.execute('UPDATE production_candidate_targets SET material_id=? WHERE material_id=?',(mid,'voice'))
            self.store.db.execute('INSERT INTO business_codes VALUES (?, ?, ?)',(mid,'M',999))
        before=c.dump(self.store)
        self.assertIsNone(c.material_snapshot(self.store,mid)[0]['plan'])
        self.assertEqual(c.dump(self.store),before,'page reads must not initialize')
        self.assertIn(mid,legacy.initialize(self.store)['created'])
        self.assertFalse(self.store.db.execute('SELECT 1 FROM objects WHERE id=?',(mid,)).fetchone())
        plan=c.material_snapshot(self.store,mid)[0]['plan']
        self.assertEqual(plan['object_id'],legacy.plan_id(mid))
        from review_desk.material_storage import canonical_id, identity
        self.assertEqual(canonical_id(self.store,plan['object_id']),mid)
        self.assertEqual(identity(self.store,mid)['id'],mid)
        from review_desk.business_codes import annotate
        self.assertEqual(annotate(self.store,plan)['material_code'],'M999')
        self.assertEqual(material_plans.card_counts(self.store,[plan['object_id']])[plan['object_id']]['candidate_count'],1)
        through_plan=c.material_snapshot(self.store,plan['object_id'])[0]
        through_material=c.material_snapshot(self.store,mid)[0]
        self.assertEqual(through_plan['canonical_material_id'],mid)
        self.assertEqual(through_plan['plan'],through_material['plan'])
        self.assertEqual(through_plan['results'],through_material['results'])
        self.assertEqual(legacy.initialize(self.store)['created'],[])
        altered=copy.deepcopy(plan['payload']);altered['initial_plan_source']['snapshot_sha256']='0'*64
        with self.assertRaises(Conflict):
            c.write_record(self.store,plan['object_id'],'REQUIREMENT',altered,
                           self.store.db.execute('SELECT * FROM objects WHERE id=?',(plan['object_id'],)).fetchone(),[])
        for table in ('production_submissions','production_candidates','production_candidate_targets'):
            self.assertEqual(c.dump(self.store)[table],before[table])
        export(self.store,self.root/'export')
        recovered=Store(self.root/'recovered/.runtime/review.sqlite3')
        try:
            restore(recovered,self.root/'export')
            self.assertEqual(c.material_snapshot(recovered,mid),c.material_snapshot(self.store,mid))
            self.assertEqual(legacy.initialize(recovered)['created'],[])
        finally:recovered.close()

    def test_interrupted_initialization_rolls_back_and_same_inputs_resume(self):
        from unittest.mock import patch
        self.setup_plans();self.media()
        migration.apply(self.store,migration.plan(self.store))
        before=c.dump(self.store)
        original=p._import_records
        def interrupted(*args,**kwargs):
            original(*args,**kwargs)
            raise RuntimeError('interrupted before commit')
        with patch.object(p,'_import_records',side_effect=interrupted):
            with self.assertRaises(RuntimeError):legacy.initialize(self.store)
        self.assertEqual(c.dump(self.store),before)
        self.assertEqual(legacy.initialize(self.store)['created'],['voice'])

    def test_same_identity_idempotence_edits_and_empty_recovery(self):
        self.setup_plans();self.media()
        GenerationTest.change(self,'voice',subjects=[self.ref('songbook')])
        migration.apply(self.store,migration.plan(self.store))
        tables=('business_codes','production_submissions','production_candidates','production_candidate_targets')
        before={t:[tuple(r) for r in self.store.db.execute('SELECT * FROM '+t)] for t in tables}
        result=legacy.initialize(self.store)
        self.assertEqual(result['created'],['voice'])
        self.assertEqual(legacy.initialize(self.store),{'created':[],'existing':['voice']})
        for table, rows in before.items():self.assertEqual([tuple(r) for r in self.store.db.execute('SELECT * FROM '+table)], rows)
        plan=p.record(self.store,legacy.plan_id('voice'))
        from review_desk import ui_projection
        card=ui_projection.card(self.store,plan['object_id'])
        self.assertEqual(card['entity_review']['entity']['object_id'],'songbook')
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
