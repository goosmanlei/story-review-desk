"""Exact judgments keep independent opinions and immutable historical targets."""
import unittest
import test_ui_projection as fixtures
from review_desk import production as p, review_decisions as decisions, ui_projection as ui


class ReviewDecisionsTest(unittest.TestCase):
    setUp = fixtures.UiProjectionTest.setUp
    tearDown = fixtures.UiProjectionTest.tearDown
    spec = fixtures.UiProjectionTest.spec
    put = fixtures.UiProjectionTest.put
    ref = fixtures.UiProjectionTest.ref
    entity = fixtures.UiProjectionTest.entity
    full = fixtures.UiProjectionTest.full
    need = fixtures.UiProjectionTest.need
    media = fixtures.UiProjectionTest.media
    change = fixtures.UiProjectionTest.change
    setup_plans = fixtures.UiProjectionTest.setup_plans
    decide = fixtures.UiProjectionTest.decide
    generate = fixtures.UiProjectionTest.generate

    def opinion(self, oid, verdict, target='generated'):
        self.put(self.spec(oid, 'JUDGMENT', target=self.ref(target), verdict=verdict,
                           actor='隔离审阅者', reason='仅核对准确记录'))

    def test_independent_opposing_opinions_are_not_collapsed_by_time(self):
        self.setup_plans(); self.generate()
        original = p.record(self.store, 'generated')
        self.opinion('master', 'accepted'); self.opinion('revision-needed', 'changes_requested')
        view = decisions.snapshot(self.store, 'generated')
        self.assertEqual({r['object_id'] for r in view['current']}, {'master', 'revision-needed'})
        self.assertTrue(view['conflicting'])
        self.assertEqual(p.record(self.store, 'generated'), original)
        card = ui.card(self.store, 'generated')
        context = card['entity_review']['materialContexts'][original['id']]
        self.assertEqual(context['judgments'], view)

    def test_old_revision_and_another_candidate_do_not_inherit_approval(self):
        self.setup_plans(); self.generate(); self.opinion('master', 'accepted')
        old = self.ref('generated')
        self.change('generated', verification={'technical_note': 'metadata revision'})
        self.assertEqual(decisions.snapshot(self.store, 'generated')['current'], [])
        self.assertEqual(len(decisions.snapshot(self.store, 'generated')['history']), 1)
        self.assertEqual(len(decisions.snapshot(self.store, 'generated', old['revision_id'])['current']), 1)
        self.generate('another-call', 'another-result')
        self.assertEqual(decisions.snapshot(self.store, 'another-result')['current'], [])
        self.assertEqual(decisions.snapshot(self.store, 'another-result')['history'], [])
        with self.assertRaises(ValueError):
            decisions.snapshot(self.store, 'another-result', old['revision_id'])

    def test_revising_one_opinion_preserves_history_without_resolving_another(self):
        self.setup_plans(); self.generate()
        self.opinion('master', 'accepted'); self.opinion('review', 'passed')
        self.change('review', verdict='rejected', reason='更正此记录，其他认可独立')
        view = decisions.snapshot(self.store, 'generated')
        self.assertTrue(view['conflicting'])
        self.assertEqual({r['payload']['verdict'] for r in view['current']}, {'accepted', 'rejected'})
        self.assertEqual([r['payload']['verdict'] for r in view['history']], ['passed'])
