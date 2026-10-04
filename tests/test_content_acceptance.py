import copy
import shutil
import unittest
import test_material_relationships as fixtures
from review_desk import generation as g, production as p, entity_review as er
from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store


class ContentAcceptanceTest(unittest.TestCase):
    setUp = fixtures.MaterialRelationshipsTest.setUp
    tearDown = fixtures.MaterialRelationshipsTest.tearDown
    spec = fixtures.MaterialRelationshipsTest.spec
    put = fixtures.MaterialRelationshipsTest.put
    ref = fixtures.MaterialRelationshipsTest.ref
    entity = fixtures.MaterialRelationshipsTest.entity
    full = fixtures.MaterialRelationshipsTest.full
    need = fixtures.MaterialRelationshipsTest.need
    media = fixtures.MaterialRelationshipsTest.media
    associate = fixtures.MaterialRelationshipsTest.associate
    change = fixtures.MaterialRelationshipsTest.change
    setup_plans = fixtures.MaterialRelationshipsTest.setup_plans
    relationship = fixtures.MaterialRelationshipsTest.relationship

    def request(self, action='accept'):
        view = g.snapshot(self.store, 'songbook')
        self.assertTrue(view['can_accept'] if action == 'accept' else view['can_revoke'])
        return dict(entity_id='songbook', action=action, expected_version=view['decision_version'],
                    scope=view['decision_scope'], acceptance_mode=view['acceptance_mode'],
                    decision_ref=view['revoke_target'], actor='技术测试', reason='隔离内容采纳测试')

    def test_first_incomplete_content_can_cycle_and_restore_without_generation_permission(self):
        self.put(self.entity()); self.put(self.full()); self.put(self.need())
        self.assertFalse(g.snapshot(self.store, 'songbook')['preparation']['complete'])
        for action in ('accept', 'revoke', 'accept'):
            request = self.request(action)
            g.decide(self.store, request)
            with self.assertRaises(Conflict):
                g.decide(self.store, request)
            self.assertIsNone(g.accepted(self.store, 'songbook'))
            self.assertFalse(g.readiness(self.store, 'need-full-overall')['ready'])
        current = g.snapshot(self.store, 'songbook')
        self.assertEqual(current['status'], 'accepted')
        self.assertEqual(current['content_accepted']['payload']['acceptance_scope'], current['scope'])
        self.assertIsNone(current['accepted'])
        historical = g.snapshot(self.store, 'songbook', current['content_accepted']['id'])
        self.assertFalse(historical['can_accept']); self.assertFalse(historical['can_revoke'])
        self.assertEqual(historical['scope'], current['scope'])
        self.assertIsNone(historical['accepted'])
        export(self.store, self.root / 'export')
        dest = self.root / 'restored'
        shutil.copytree(self.root / 'export', dest / 'export')
        recovered = Store(dest / '.runtime/review.sqlite3')
        try:
            restore(recovered, dest / 'export')
            self.assertEqual(g.snapshot(recovered, 'songbook'), current)
            self.assertEqual(g.snapshot(recovered, 'songbook', current['content_accepted']['id']), historical)
        finally:
            recovered.close()

    def test_new_media_does_not_trap_a_revoked_legacy_decision(self):
        self.put(self.entity()); self.put(self.full())
        scope = er.current_scope(self.store, 'songbook')
        self.put(self.spec('old-yes', 'JUDGMENT', acceptance_model=er.ACCEPTANCE_MODEL,
                           acceptance_scope=scope, target=scope['entity'], verdict='accepted', actor='用户', reason='旧认可'))
        original = p.record(self.store, 'old-yes')
        g.decide(self.store, self.request('revoke'))
        # Existing legacy content cycles remain readable and cancellable.
        request = self.request(); request['scope'] = scope
        g.decide(self.store, request)
        legacy = g.decision(self.store, 'songbook')
        self.assertTrue(g.snapshot(self.store, 'songbook', legacy['id'])['historical'])
        g.decide(self.store, self.request('revoke'))
        self.media(); self.associate()
        self.assertIsNone(g.content_scope(self.store, 'songbook'))
        for action in ('accept', 'revoke', 'accept'):
            g.decide(self.store, self.request(action))
        self.assertEqual(p.record(self.store, 'old-yes'), original)
        self.assertEqual(g.decision(self.store, 'songbook')['payload']['acceptance_scope'], g.current_scope(self.store, 'songbook'))
        self.assertIsNone(g.accepted(self.store, 'songbook'))

    def test_stale_upstream_allows_content_but_blocks_generation_and_stale_writes(self):
        self.setup_plans(); self.put(self.relationship())
        plan = copy.deepcopy(p.record(self.store, 'need-wet-overall')['payload']['generation'])
        plan['inputs'] = [{'reference': self.ref('need-full-overall'), 'use': '准确母版'}]
        self.change('need-wet-overall', generation=plan)
        upstream = copy.deepcopy(p.record(self.store, 'need-full-overall')['payload']['generation'])
        self.change('need-full-overall', generation={**upstream, 'prompt': '新版母版'})
        view = g.snapshot(self.store, 'songbook')
        self.assertIn('dependency_changed', [issue['code'] for issue in view['preparation']['issues']])
        request = self.request()
        with self.assertRaises(Conflict):
            g.decide(self.store, {**request, 'acceptance_mode': 'generation'})
        g.decide(self.store, request)
        self.assertIsNone(g.accepted(self.store, 'songbook'))
        self.assertFalse(g.readiness(self.store, 'need-wet-overall')['ready'])
        with self.assertRaises(Conflict):
            g.package(self.store, 'need-wet-overall')
        g.decide(self.store, self.request('revoke'))
        stale = self.request(); before = g.decision(self.store, 'songbook')
        self.change('belongs', label='保管歌本')
        with self.assertRaises(Conflict):
            g.decide(self.store, stale)
        self.assertEqual(g.decision(self.store, 'songbook'), before)
        g.decide(self.store, self.request())

    def test_plan_completion_does_not_upgrade_content_acceptance_automatically(self):
        self.setup_plans(); self.change('songbook', production_description='')
        g.decide(self.store, self.request())
        self.change('songbook', production_description='新的完整描述')
        for oid in ('full', 'wet'):
            self.change(oid, entity=self.ref('songbook'))
            self.change('need-' + oid + '-overall', scope=self.ref(oid), states=[self.ref(oid)], entities=[self.ref('songbook')])
        self.assertTrue(g.snapshot(self.store, 'songbook')['preparation']['complete'])
        self.assertIsNone(g.accepted(self.store, 'songbook'))
        g.decide(self.store, self.request('revoke'))
        g.decide(self.store, self.request())
        self.assertIsNotNone(g.accepted(self.store, 'songbook'))

    def test_content_import_rejects_missing_previous_and_wrong_scope(self):
        self.put(self.entity()); self.put(self.full())
        g.decide(self.store, self.request())
        old = g.decision(self.store, 'songbook')
        payload = copy.deepcopy(old['payload'])
        payload['verdict'] = 'revoked'
        with self.assertRaises(ValueError):
            self.put(dict(object_id=old['object_id'], kind='JUDGMENT', expected_version=old['version'], payload=payload))
        payload['previous_decision'] = g.ref(old)
        payload['acceptance_scope']['states'] = []
        with self.assertRaises(ValueError):
            self.put(dict(object_id=old['object_id'], kind='JUDGMENT', expected_version=old['version'], payload=payload))
        self.assertEqual(g.decision(self.store, 'songbook'), old)


if __name__ == '__main__':
    unittest.main()
