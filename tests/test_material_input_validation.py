import copy
import unittest

from current_material_fixture import MaterialFixture
from review_desk import production as p, generation as g
from review_desk import material_input_validation as validation
from review_desk.production_current import checksum
from review_desk.shot_references import enrich_detail
from review_desk import production_current as current, production_operations as operations


class ReferenceValidationTest(MaterialFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.setup_plans()

    def input(self, oid, **values):
        return {'reference': self.ref(oid), 'use': '隔离参考用途', **values}

    def plan(self, oid, inputs, **values):
        row = p.record(self.store, oid)
        plan = copy.deepcopy(row['payload']['generation'])
        plan.update(inputs=inputs, **values)
        return plan

    def test_current_self_and_selected_cycle_rollback_the_entire_write(self):
        first, second = 'need-full-overall', 'need-wet-overall'
        before = p.record(self.store, first)
        with self.assertRaisesRegex(ValueError, '循环'):
            self.change(first, generation=self.plan(first, [self.input(first)]))
        self.assertEqual(checksum(p.record(self.store, first)), checksum(before))
        self.change(first, generation=self.plan(first, [self.input(second)]))
        before = p.record(self.store, second)
        with self.assertRaisesRegex(ValueError, '循环'):
            self.change(second, generation=self.plan(second, [self.input(first)]))
        self.assertEqual(checksum(p.record(self.store, second)), checksum(before))
        self.assertFalse(g.readiness(self.store, first)['ready'])

    def test_unselected_routes_are_gaps_and_do_not_make_a_cycle(self):
        oid = 'need-full-overall'
        inputs = [self.input(oid, necessity='optional', enabled=False),
                  self.input(oid, necessity='conditional', condition='later'),
                  self.input(oid, necessity='one_of', group='choice', route='self')]
        self.change(oid, generation=self.plan(oid, inputs))
        self.assertEqual(validation.issues(self.store, p.record(self.store, oid)), [])
        self.assertFalse(g.readiness(self.store, oid)['ready'])
        with self.assertRaisesRegex(ValueError, '循环'):
            self.change(oid, generation=self.plan(oid, inputs, selected_routes={'choice': 'self'}))

    def test_business_relationship_cycle_does_not_schedule_generation(self):
        from review_desk import business_relations as relations
        for ends in (['need-full-overall', 'need-wet-overall'],
                     ['need-wet-overall', 'songbook'], ['songbook', 'need-full-overall']):
            self.put(self.spec(relations.identity(ends), 'RELATION', relation_type='business',
                endpoints=ends, direction='forward', summary='共同制作关联，未选为生成输入。',
                sources=[self.source], contexts=[]))
        validation.validate_tree(self.store)
        self.assertTrue(g.readiness(self.store, 'need-full-overall')['ready'])

    def test_exact_own_candidate_terminal_and_frozen_history(self):
        self.generate()
        oid = 'need-full-overall'
        value = self.input('generated', component_id='original', range={'start_seconds': .1, 'end_seconds': .8})
        asset = p.record(self.store, 'generated')
        saved = copy.deepcopy(asset['submission'])
        self.change(oid, generation=self.plan(oid, [value], method='reuse', model=None))
        need = p.record(self.store, oid)
        enrich_detail(self.store, {'record': need})
        self.assertTrue(need['review_shot_slots'][0]['own_candidate'])
        self.assertTrue(g.readiness(self.store, oid)['ready'])
        self.assertEqual(p.record(self.store, 'generated')['submission'], saved)
        other = p.record(self.store, 'need-wet-overall')
        self.change(other['object_id'], generation=self.plan(other['object_id'], [value]))
        other = p.record(self.store, other['object_id'])
        enrich_detail(self.store, {'record': other})
        self.assertFalse(other['review_shot_slots'][0]['own_candidate'])

    def test_bad_component_hash_membership_range_and_missing_target_are_rejected(self):
        self.generate()
        oid = 'need-full-overall'
        value = self.input('generated', component_id='original')
        for change in ({'component_id': 'absent'}, {'sha256': '0' * 64},
                       {'material_selection': {'material_id': 'need-wet-overall'}},
                       {'material_selection': {'candidate_id': 'wrong', 'material_id': oid}},
                       {'range': {'start_seconds': 0, 'end_seconds': 1000}},
                       {'reference': {'object_id': 'absent', 'revision_id': '0' * 64}}):
            with self.subTest(change=change), self.assertRaises((ValueError, KeyError)):
                self.change(oid, generation=self.plan(oid, [{**value, **change}]))

    def test_withdrawn_selected_upstream_is_rejected(self):
        first, second = 'need-full-overall', 'need-wet-overall'
        self.change(first, generation=self.plan(first, [self.input(second)]))
        with self.assertRaisesRegex(ValueError, '撤回'):
            self.change(second, status='withdrawn', required=False, withdrawal_reason='隔离反例')
        self.assertNotEqual(p.record(self.store, second)['payload'].get('status'), 'withdrawn')

    def test_atomic_import_uses_final_graph_instead_of_intermediate_cycle(self):
        first, second = 'need-full-overall', 'need-wet-overall'
        self.change(first, generation=self.plan(first, [self.input(second)]))
        records = []
        for oid, inputs in ((second, [self.input(first)]), (first, [])):
            row = p.record(self.store, oid)
            payload = copy.deepcopy(row['payload'])
            payload['generation'] = self.plan(oid, inputs)
            records.append({'object_id': oid, 'kind': 'REQUIREMENT', 'expected_version': row['version'], 'payload': payload})
        self.put(*records)
        validation.validate_tree(self.store)
        self.assertFalse(p.record(self.store, first)['payload']['generation']['inputs'])

    def test_selection_replay_and_stale_marker_keep_exact_input(self):
        self.generate()
        oid = 'need-full-overall'
        self.change(oid, generation=self.plan(oid, [self.input('generated', component_id='original')]))
        need = p.record(self.store, oid)
        from review_desk.shot_references import input_key
        asset = p.record(self.store, 'generated')
        request = {'id': 'isolated-selection', 'requirement_id': oid,
                   'expected_content': current.marker(need), 'index': 0,
                   'input_key': input_key(need['payload']['generation']['inputs'][0]),
                   'material_id': oid, 'candidate': self.ref('generated'),
                   'candidate_id': asset['candidate_id'], 'component_id': 'original',
                   'range': {'start_seconds': .1, 'end_seconds': .8}}
        result = operations.select(self.store, request)
        saved = p.record(self.store, oid)
        self.assertTrue(operations.select(self.store, request)['already_applied'])
        self.assertEqual(p.record(self.store, oid), saved)
        from review_desk.store import Conflict
        with self.assertRaises(Conflict):
            operations.select(self.store, {**request, 'id': 'stale-selection'})
        self.assertEqual(p.record(self.store, oid), saved)

    def test_export_guard_detects_a_corrupt_existing_route_without_rewriting_history(self):
        from unittest.mock import patch
        from review_desk.bundle import export
        self.generate()
        oid = 'need-full-overall'
        history = copy.deepcopy(p.record(self.store, 'generated')['submission'])
        with patch.object(validation, 'validate_write'):
            self.change(oid, generation=self.plan(oid, [self.input(oid)]))
        self.assertFalse(g.readiness(self.store, oid)['ready'])
        with self.assertRaisesRegex(ValueError, '循环'):
            export(self.store, self.root / 'export')
        self.change(oid, generation=self.plan(oid, []))
        export(self.store, self.root / 'export')
        self.assertEqual(p.record(self.store, 'generated')['submission'], history)

    def test_readiness_and_package_locate_a_missing_stored_target(self):
        from unittest.mock import patch
        oid = 'need-full-overall'
        with patch.object(validation, 'validate_write'):
            row = p.record(self.store, oid)
            payload = copy.deepcopy(row['payload'])
            payload['generation']['inputs'] = [self.input('need-wet-overall')]
            self.put({'object_id':oid, 'kind':'REQUIREMENT', 'expected_version':row['version'], 'payload':payload})
        # Simulate a broken external read without changing shared or real data.
        original = p.ref_record
        def missing(store, value, *args, **kwargs):
            if value.get('object_id') == 'need-wet-overall':
                raise KeyError('isolated missing exact target')
            return original(store, value, *args, **kwargs)
        with patch.object(p, 'ref_record', side_effect=missing):
            ready = g.readiness(self.store, oid)
            self.assertFalse(ready['ready'])
            self.assertIn('参考 1', '；'.join(ready['issues']))
            from review_desk.store import Conflict
            with self.assertRaisesRegex(Conflict, 'missing exact target'):
                g.package(self.store, oid)

    def test_restore_rejects_a_corrupt_route_before_touching_empty_destination(self):
        from unittest.mock import patch
        from review_desk.bundle import export, restore
        from review_desk.store import Store
        oid = 'need-full-overall'
        with patch.object(validation, 'validate_write'):
            self.change(oid, generation=self.plan(oid, [self.input(oid)]))
        # Only the isolated source's route check is bypassed to construct the
        # bad bundle. Normal restore must perform the real check again.
        with patch.object(validation, 'validate_tree'):
            export(self.store, self.root / 'export')
        recovered = Store(self.root / 'rejected-restore/.runtime/review.sqlite3')
        self.addCleanup(recovered.close)
        with self.assertRaisesRegex(ValueError, '循环'):
            restore(recovered, self.root / 'export')
        self.assertFalse(recovered.objects())

    def test_missing_original_blocks_then_recovers_on_the_same_exact_bytes(self):
        self.generate()
        oid = 'need-full-overall'
        self.change(oid, generation=self.plan(oid, [self.input('generated', component_id='original')]))
        component = p.record(self.store, 'generated')['payload']['components'][0]
        path = self.root / 'export/assets' / component['file']
        original = path.read_bytes()
        path.unlink()
        try:
            self.assertFalse(g.readiness(self.store, oid)['ready'])
            with self.assertRaises((OSError, ValueError)):
                validation.validate_tree(self.store)
        finally:
            path.write_bytes(original)
        self.assertTrue(g.readiness(self.store, oid)['ready'])


if __name__ == '__main__':
    unittest.main()
