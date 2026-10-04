"""Single change conclusions, atomic concurrency and exact legacy consolidation."""
import copy
import json
from pathlib import Path
import shutil
import threading
import unittest

import test_production
from review_desk import production as p
from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store


class ChangeDecisionTest(unittest.TestCase):
    def setUp(self):
        self.f = test_production.ProductionTest(); self.f.setUp()
        self.store = self.f.store
        self.f.put(self.f.entity('upstream'))
        self.old = self.f.ref('upstream')
        self.f.put(self.f.spec('target', 'REPRESENTATION', entities=[self.old], states=[], sources=[], choices=[], unknowns=[]))
        self.target = self.f.ref('target')
        updated = self.f.entity('upstream'); updated['expected_version'] = 1; updated['payload']['facts'].append('New exact constraint')
        self.f.put(updated); self.new = self.f.ref('upstream')

    def tearDown(self): self.f.tearDown()

    def decision(self, oid='decision', action='keep', version=0, resolves=None, target=None):
        value = self.f.spec(oid, 'JUDGMENT', target=target or self.target, verdict='impact_resolved',
                            actor='Original explicit field, not inferred identity', reason='Technical exact change judgment',
                            change={'old': self.old, 'new': self.new, 'action': action})
        value['expected_version'] = version
        if resolves is not None: value['payload']['change']['resolves'] = resolves
        return value

    def legacy(self, *values):
        # Simulate records restored from a previously valid export, not a path
        # permitted to ordinary live HTTP/CLI import after this change.
        p._import_records(self.store, {'format': 'production-import-v1', 'records': list(values)}, check_current=False)

    def test_keep_can_be_revised_to_rework_with_same_id_and_immutable_history(self):
        self.f.put(self.decision())
        old = p.record(self.store, 'decision')
        self.assertEqual(p.stale_inputs(self.store, self.target['revision_id']), [])
        self.f.put(self.decision(action='rework', version=1))
        self.assertEqual(len(p.stale_inputs(self.store, self.target['revision_id'])), 1)
        history = p.snapshot(self.store, object_id='decision')['history']
        self.assertEqual([v['payload']['change']['action'] for v in history], ['rework', 'keep'])
        self.assertEqual(p.record(self.store, revision_id=old['id'])['payload'], old['payload'])
        with self.assertRaises(Conflict): self.f.put(self.decision(action='replace', version=1))
        self.assertEqual(p.record(self.store, 'decision')['version'], 2)

    def test_first_create_is_unique_across_two_real_connections(self):
        barrier = threading.Barrier(2); results = []
        path = self.store.db_path
        def writer(oid):
            store = Store(path)
            try:
                barrier.wait()
                try:
                    p.import_records(store, {'format': 'production-import-v1', 'records': [self.decision(oid)]})
                    results.append('saved')
                except Conflict: results.append('conflict')
            finally: store.close()
        threads = [threading.Thread(target=writer, args=(name,)) for name in ['window-a', 'window-b']]
        for thread in threads: thread.start()
        for thread in threads: thread.join(5); self.assertFalse(thread.is_alive())
        self.assertCountEqual(results, ['saved', 'conflict'])
        self.assertEqual(len(p.current_records(self.store, {'JUDGMENT'})), 1)

    def test_missing_version_and_same_batch_duplicates_leave_no_partial_data(self):
        value = self.decision(); value.pop('expected_version')
        with self.assertRaises(Conflict): self.f.put(value)
        with self.assertRaises(Conflict): self.f.put(self.decision('one'), self.decision('two'))
        with self.assertRaises(Conflict): self.f.put(self.decision('one'), self.decision('two'), validate=True)
        self.assertEqual(p.current_records(self.store, {'JUDGMENT'}), [])

    def test_legacy_conflicting_records_require_all_exact_heads_then_remain_history(self):
        self.legacy(self.decision('legacy-keep'), self.decision('legacy-rework', 'rework'))
        prior = [p.record(self.store, oid) for oid in ['legacy-keep', 'legacy-rework']]
        change = p.upstream_changes(self.store, self.target['revision_id'])[0]
        self.assertTrue(change['conflict']); self.assertIsNone(change['decision'])
        self.assertEqual(change['action'], 'needs_review')
        refs = [self.f.ref(row['object_id']) for row in prior]
        for wrong in [[], refs[:1], [refs[0], refs[0]]]:
            with self.assertRaises((Conflict, ValueError)): self.f.put(self.decision('unified', resolves=wrong))
        self.f.put(self.decision('unified', resolves=refs))
        self.assertEqual(p.stale_inputs(self.store, self.target['revision_id']), [])
        with self.assertRaises(Conflict): self.f.put(self.decision('legacy-keep', 'rework', 1))
        self.f.put(self.decision('unified', 'rework', 1, refs))
        self.assertEqual(len(p.stale_inputs(self.store, self.target['revision_id'])), 1)
        with self.assertRaises(Conflict): self.f.put(self.decision('unified', 'keep', 2, []))
        for old in prior: self.assertEqual(p.record(self.store, old['object_id'])['payload'], old['payload'])
        self.assertEqual(p.record(self.store, 'unified')['version'], 2)

    def test_legacy_equal_actions_also_need_explicit_consolidation(self):
        self.legacy(self.decision('a'), self.decision('b'))
        self.assertTrue(p.upstream_changes(self.store, self.target['revision_id'])[0]['conflict'])
        self.assertEqual(len(p.stale_inputs(self.store, self.target['revision_id'])), 1)

    def test_resolution_cannot_borrow_a_different_target_pair_or_stale_head(self):
        self.legacy(self.decision('a'), self.decision('b', 'rework'))
        refs = [self.f.ref('a'), self.f.ref('b')]
        # A historical import advancing one old head models a changed input
        # snapshot. Live edits of an unresolved group are themselves rejected.
        self.legacy(self.decision('b', 'replace', 1))
        with self.assertRaises(Conflict): self.f.put(self.decision('unified', resolves=refs))
        self.f.put(self.f.spec('other-target', 'REPRESENTATION', entities=[self.old], states=[], sources=[], choices=[], unknowns=[]))
        self.f.put(self.decision('other', target=self.f.ref('other-target')))
        with self.assertRaises(ValueError): self.f.put(self.decision('unified', resolves=[self.f.ref('a'), self.f.ref('other')]))
        self.assertEqual(len(p.current_records(self.store, {'JUDGMENT'})), 3)

    def test_existing_change_key_cannot_be_removed_or_retargeted(self):
        self.f.put(self.decision())
        for mode in ['remove', 'new-pair', 'scope']:
            value = self.decision(version=1)
            if mode == 'remove': value['payload'].pop('change')
            if mode == 'new-pair': value['payload']['target'] = self.new
            if mode == 'scope': value['payload']['change']['scope'] = 'state_title_only'
            with self.assertRaises((Conflict, ValueError)): self.f.put(value)
        self.assertEqual(p.record(self.store, 'decision')['version'], 1)

    def test_readiness_exposes_kept_review_for_revision_without_adding_pending_issue(self):
        self.f.put(self.f.entity('scope')); self.f.media()
        asset=p.record(self.store,'voice');payload=copy.deepcopy(asset['payload']);payload['subjects']=[self.old]
        self.f.put({'object_id':'voice','kind':'ASSET','expected_version':1,'payload':payload})
        need=self.f.requirement('need','scope');need['payload']['entities']=[self.old]
        self.f.put(need,self.f.adoption('use','scope'))
        ready=p.readiness(self.store,'scope');changes=ready['requirements'][0]['pending_changes']
        self.assertEqual(len(changes),2)
        for i,change in enumerate(changes):self.f.put(self.decision('review-'+str(i),target=change['target']))
        ready=p.readiness(self.store,'scope');row=ready['requirements'][0]
        self.assertTrue(ready['inputs_ready']);self.assertEqual(row['pending_changes'],[]);self.assertEqual(len(row['change_reviews']),2)
        self.assertTrue(all(change['decision']['version']==1 for change in row['change_reviews']))
        selected=changes[0]
        self.f.put(self.decision('review-0','rework',1,target=selected['target']))
        ready=p.readiness(self.store,'scope');self.assertFalse(ready['inputs_ready']);self.assertEqual(len(ready['requirements'][0]['pending_changes']),1)

    def test_legacy_and_consolidated_history_round_trip_without_dropping_records(self):
        self.legacy(self.decision('a'),self.decision('b','rework'))
        refs=[self.f.ref('a'),self.f.ref('b')]
        self.f.put(self.decision('unified',resolves=refs));self.f.put(self.decision('unified','replace',1,refs))
        before='\n'.join(self.store.db.iterdump())
        export(self.store,self.f.root/'export')
        recovered=Store(self.f.root/'restored/.runtime/review.sqlite3')
        try:
            shutil.copytree(self.f.root/'export',self.f.root/'restored/export')
            restore(recovered,self.f.root/'restored/export')
            self.assertEqual(recovered.objects(),self.store.objects())
            self.assertEqual(recovered.revisions(),self.store.revisions())
            self.assertEqual(recovered.dependencies(),self.store.dependencies())
            self.assertEqual(p.upstream_changes(recovered,self.target['revision_id']),p.upstream_changes(self.store,self.target['revision_id']))
        finally:recovered.close()
        self.assertEqual('\n'.join(self.store.db.iterdump()),before)


if __name__ == '__main__': unittest.main()
