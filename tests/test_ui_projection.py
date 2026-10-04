"""Independent list/card contracts, using isolated production records."""
import copy
import unittest

import test_material_plans as fixtures
from review_desk import generation as g, production as p, ui_projection as ui


class UiProjectionTest(unittest.TestCase):
    setUp = fixtures.PlanVersionsTest.setUp
    tearDown = fixtures.PlanVersionsTest.tearDown
    spec = fixtures.PlanVersionsTest.spec
    put = fixtures.PlanVersionsTest.put
    ref = fixtures.PlanVersionsTest.ref
    entity = fixtures.PlanVersionsTest.entity
    full = fixtures.PlanVersionsTest.full
    need = fixtures.PlanVersionsTest.need
    media = fixtures.PlanVersionsTest.media
    change = fixtures.PlanVersionsTest.change
    setup_plans = fixtures.PlanVersionsTest.setup_plans
    decide = fixtures.PlanVersionsTest.decide
    generate = fixtures.PlanVersionsTest.generate

    def summary(self):
        return ui.entity_summaries(self.store, [p.record(self.store, 'songbook')], ui.material_entries(self.store))

    def test_candidates_and_metadata_revisions_do_not_inflate_material_counts(self):
        self.setup_plans()
        baseline = self.summary()['entity_material_counts']['songbook']
        self.assertEqual(baseline, {'audio': 2})
        self.generate()
        self.generate('call-two', 'other-result')
        self.change('generated', verification={'checked': True})
        self.assertEqual(self.summary()['entity_material_counts']['songbook'], baseline)
        entries = ui.material_entries(self.store)
        self.assertEqual(sum(i['object_id'] == 'need-full-overall' for i in entries), 1)
        self.assertTrue(next(i for i in entries if i['object_id'] == 'need-full-overall')['generated'])

    def test_current_acceptance_filter_tracks_content_changes_and_cancellation(self):
        self.setup_plans()
        self.assertEqual(self.summary()['entity_statuses']['songbook'], 'unaccepted')
        self.decide()
        self.assertEqual(self.summary()['entity_statuses']['songbook'], 'accepted')
        self.change('songbook', production_description='当前基础描述已改变')
        view = g.snapshot(self.store, 'songbook')
        self.assertTrue(view['can_revoke'])
        self.assertEqual(view['status'], 'unaccepted')
        self.assertEqual(self.summary()['entity_statuses']['songbook'], 'unaccepted')
        request = {'entity_id': 'songbook', 'action': 'revoke', 'decision_ref': view['revoke_target'],
                   'expected_version': view['decision_version'], 'scope': view['decision_scope'],
                   'acceptance_mode': view['acceptance_mode'], 'actor': 'fixture', 'reason': 'fixture only'}
        g.decide(self.store, request)
        self.assertEqual(self.summary()['entity_statuses']['songbook'], 'unaccepted')

    def test_facets_keep_other_filters_and_categories_remain_present_at_zero_results(self):
        self.setup_plans(); self.generate()
        result = ui.material_list(self.store, media='audio', status='generated')
        self.assertEqual(result['facets']['status']['generated'], result['total'])
        self.assertGreater(result['facets']['status']['ungenerated'], 0)
        empty = ui.material_list(self.store, search='no such material')
        self.assertEqual(empty['total'], 0)
        self.assertIn('audio', empty['facets']['media'])
        self.assertEqual(empty['facets']['media']['audio'], 0)

    def test_unassigned_historical_asset_counts_under_its_explicit_entity_subject(self):
        self.setup_plans(); self.media()
        self.change('voice', subjects=[self.ref('songbook')], states=[], state_coverage=[])
        item = next(i for i in ui.material_entries(self.store) if i['object_id'] == 'voice')
        self.assertEqual(item['entity_ids'], ['songbook'])
        self.assertEqual(self.summary()['entity_material_counts']['songbook'], {'audio': 3})

    def test_card_reader_preserves_the_requested_exact_requirement_and_its_plan(self):
        self.setup_plans(); self.generate()
        original = self.ref('need-full-overall')
        plan = copy.deepcopy(p.record(self.store, 'need-full-overall')['payload']['generation'])
        self.change('need-full-overall', generation={**plan, 'prompt': '新方案'})
        result = ui.card(self.store, original['object_id'], original['revision_id'])
        self.assertEqual(result['detail']['record']['id'], original['revision_id'])
        self.assertEqual(result['detail']['record']['payload']['generation']['prompt'], plan['prompt'])
        current = result['entity_review']['material_versions']['need-full-overall'][0]
        self.assertEqual(current['number'], 2)
        self.assertEqual(current['results'], [])


if __name__ == '__main__':
    unittest.main()
