import copy
import json
import shutil
import unittest

import test_material_plans as fixtures
from review_desk import version_consolidation as vc, production as p, material_plans as mp, bundle, generation
from review_desk.store import Store, Conflict


class ConsolidationTest(unittest.TestCase):
    for _name in ('setUp','tearDown','spec','put','ref','entity','full','need','media','change','setup_plans','generate'):
        locals()[_name] = getattr(fixtures.PlanVersionsTest, _name)

    def prepared(self):
        self.setup_plans()
        self.generate()
        self.generate('call2', 'second')
        self.change('recording', status='completed', outputs=[self.ref('voice')])
        self.first = self.ref('songbook')
        self.change('songbook', production_description='A later entity definition')
        plan = p.record(self.store, 'need-full-overall')['payload']['generation']
        self.change('need-full-overall', generation={**plan, 'prompt':'an ungenerated later draft'})
        return vc.plan(self.store)

    def test_latest_output_keeps_all_candidates_and_old_identity_never_reappears(self):
        approved = self.prepared()
        before = vc.fingerprint(self.store)
        self.assertEqual(vc.plan(self.store), approved)
        self.assertEqual(before, vc.fingerprint(self.store))
        kept = next(v for v in approved['objects'] if v['object_id']=='need-full-overall')
        self.assertEqual(kept['old_number'],1)
        self.assertEqual(len(kept['versions'][0]['candidates']),2)
        vc.apply_database(self.store, approved)
        self.assertTrue(p.ref_record(self.store,self.first)['unavailable'])
        self.assertEqual(p.record(self.store,'songbook')['version'],1)
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')),1)
        self.assertEqual(len(mp.snapshot(self.store,'need-full-overall')[0]['results']),2)
        row=p.record(self.store,'songbook')
        self.change('songbook', production_description='a subsequent legitimate edit')
        self.assertEqual(p.record(self.store,'songbook')['version'],2)
        self.assertNotEqual(p.record(self.store,'songbook')['id'],self.first['revision_id'])
        self.assertTrue(vc.apply_database(self.store,approved)['already_applied'])
        self.assertFalse(self.store.db.execute('PRAGMA foreign_key_check').fetchall())

    def test_drift_and_failure_do_not_partially_delete(self):
        approved=self.prepared();before=vc.fingerprint(self.store)
        with self.assertRaisesRegex(RuntimeError,'injected'):
            vc.apply_database(self.store,approved,fault='before_commit')
        self.assertEqual(before,vc.fingerprint(self.store))
        self.store.create_comment({'target_object_id':'songbook','target_revision_id':self.ref('songbook')['revision_id'],
                                   'anchor':{'type':'global'},'body':'concurrent reviewer'})
        changed=vc.fingerprint(self.store)
        with self.assertRaises(Conflict):vc.apply_database(self.store,approved)
        self.assertEqual(changed,vc.fingerprint(self.store))

    def test_missing_file_blocks_plan_and_commit_interruption_resumes(self):
        approved=self.prepared()
        component=p.record(self.store,'generated')['payload']['components'][0]
        original=self.root/'export/assets'/component['file'];moved=original.with_suffix('.test-moved')
        original.rename(moved)
        try:
            self.assertTrue(vc.inventory(self.store)['anomalies'])
            with self.assertRaises(Conflict):vc.plan(self.store)
            before=vc.fingerprint(self.store)
            with self.assertRaises(Conflict):vc.apply_database(self.store,approved)
            self.assertEqual(before,vc.fingerprint(self.store))
        finally:moved.rename(original)
        with self.assertRaisesRegex(RuntimeError,'after database commit'):
            vc.apply_database(self.store,approved,fault='after_commit')
        self.assertEqual(vc.apply_database(self.store,approved)['additional_deletions'],0)

    def test_empty_restore_and_policy_reject_old_snapshot(self):
        approved=self.prepared()
        shutil.copytree(self.root/'export/assets',self.root/'old-export/assets')
        bundle.export(self.store,self.root/'old-export')
        vc.apply_database(self.store,approved)
        bundle.export(self.store,self.root/'export')
        destination=self.root/'recovered';shutil.copytree(self.root/'export',destination/'export')
        (destination/'config').mkdir()
        (destination/'config/instance.json').write_text(json.dumps({'version_consolidation_policy':{
            'format':'version-consolidation-policy-v1','ledger_sha256':vc.ledger_hash(vc.dump(self.store))}}))
        restored=Store(destination/'.runtime/review.sqlite3')
        try:
            with self.assertRaises(Conflict):bundle.restore(restored,self.root/'old-export')
            bundle.restore(restored,destination/'export')
            self.assertEqual(vc.dump(restored),vc.dump(self.store))
            self.assertEqual(restored.comments(),self.store.comments())
        finally:restored.close()

    def test_baseline_blocks_missing_inputs_and_next_plan_is_v2(self):
        approved=self.prepared();vc.apply_database(self.store,approved)
        self.assertFalse(generation.readiness(self.store,'need-full-overall')['ready'])
        row=p.record(self.store,'need-full-overall');value=copy.deepcopy(row['payload'])
        # Explicitly repair exact references in a new authoring operation.
        def repair(v):
            if isinstance(v,dict):
                if v.get('unavailable'):
                    current=p.record(self.store,v['object_id'])
                    return {'object_id':current['object_id'],'revision_id':current['id']}
                return {k:repair(x) for k,x in v.items()}
            return [repair(x) for x in v] if isinstance(v,list) else v
        value=repair(value);value['generation']['prompt']='An explicitly revised second plan'
        self.store.put_object(row['object_id'],'REQUIREMENT',value,row['version'])
        self.assertEqual([r['number'] for r in mp.snapshot(self.store,row['object_id'])],[2,1])
        self.assertEqual(len(mp.snapshot(self.store,row['object_id'])[1]['results']),2)
        self.assertTrue(vc.version_route(self.store,row['object_id'])['baseline_id'])
        frozen=vc.fingerprint(self.store)
        readonly=Store.open_readonly(self.store.db_path)
        try:self.assertEqual(vc.fingerprint(readonly),frozen)
        finally:readonly.close()
        self.assertEqual(vc.fingerprint(self.store),frozen)

    def test_latest_of_multiple_produced_versions_and_shared_file(self):
        self.setup_plans();self.generate();self.change('recording',status='completed',outputs=[self.ref('voice')])
        earlier=self.ref('generated');old_call=self.ref('call1')
        plan=p.record(self.store,'need-full-overall')['payload']['generation']
        self.change('need-full-overall',generation={**plan,'prompt':'a second produced plan'})
        self.generate('call2','other');self.generate('call3','third')
        approved=vc.plan(self.store)
        chosen=next(r for r in approved['objects'] if r['object_id']=='need-full-overall')
        self.assertEqual(chosen['old_number'],2)
        vc.apply_database(self.store,approved)
        self.assertTrue(vc.deleted(self.store,earlier['revision_id']))
        kept=mp.snapshot(self.store,'need-full-overall')
        self.assertEqual(len(kept),1);self.assertEqual(len(kept[0]['results']),2)
        original=self.root/'export/assets'/kept[0]['results'][0]['payload']['components'][0]['file']
        self.assertTrue(original.exists())
        with self.assertRaisesRegex(Exception,'deleted object'):
            self.store.db.execute('INSERT INTO objects VALUES (?,?,?,?,?,?)',('call1','CALL','fake',1,'now','now'))
        self.store.db.rollback()
