"""Card totals follow registered versions and exact real candidate identities."""
import copy
from test_ui_projection import UiProjectionTest
from review_desk import material_plans as mp, production as p, ui_projection as ui, generation as g


class CardCountsTest(UiProjectionTest):
    def count(self):
        return mp.card_counts(self.store, ['need-full-overall'])['need-full-overall']

    def test_empty_plan_repeated_candidate_revision_and_new_unproduced_version(self):
        self.setup_plans()
        self.assertEqual(self.count(), {'version_count': 1, 'candidate_count': 0})
        self.generate()
        self.generate('second-call', 'second-result')
        self.assertEqual(self.count(), {'version_count': 1, 'candidate_count': 2})
        self.change('generated', title='same candidate, changed metadata')
        self.assertEqual(self.count(), {'version_count': 1, 'candidate_count': 2})
        plan = copy.deepcopy(p.record(self.store, 'need-full-overall')['payload']['generation'])
        self.change('need-full-overall', generation={**plan, 'prompt': 'new empty plan'})
        self.assertEqual(self.count(), {'version_count': 2, 'candidate_count': 2})
        entry = next(i for i in ui.material_entries(self.store) if i['object_id'] == 'need-full-overall')
        self.assertEqual((entry['version_count'], entry['candidate_count']), (2, 2))
        exact = ui.card(self.store, 'generated')
        self.assertEqual(exact['entity_review']['material_card_counts']['need-full-overall'], self.count())

    def test_missing_registration_is_unknown_and_duplicate_association_is_one_material(self):
        self.setup_plans()
        self.assertEqual(mp.card_counts(self.store, ['missing'])['missing'],
                         {'version_count': None, 'candidate_count': None})
        entries = ui.material_entries(self.store)
        entity = p.record(self.store, 'songbook')
        normal = ui.entity_summaries(self.store, [entity], entries)
        duplicate = ui.entity_summaries(self.store, [entity], entries + entries)
        self.assertEqual(normal['entity_material_counts'], duplicate['entity_material_counts'])

    def test_failed_call_does_not_create_candidate(self):
        self.setup_plans();self.decide()
        plan = g.package(self.store, 'need-full-overall')
        self.put(self.spec('failed-count-call', 'CALL', status='failed', method='generation', tool='test',
                           outputs=[], inputs=[], generation_requirement=plan['requirement'],
                           generation_acceptances=plan['acceptances'],
                           **{k:plan[k] for k in ('model','parameters','prompt')}))
        self.assertEqual(self.count(), {'version_count': 1, 'candidate_count': 0})
