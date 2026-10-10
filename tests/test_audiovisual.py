import copy
import unittest

import test_production as fixtures
from review_desk import audiovisual as av, production as p, material_relations as mr
from review_desk import generation, material_plans


class AudiovisualTest(unittest.TestCase):
    setUp = fixtures.ProductionTest.setUp
    tearDown = fixtures.ProductionTest.tearDown
    spec = fixtures.ProductionTest.spec
    put = fixtures.ProductionTest.put
    ref = fixtures.ProductionTest.ref

    def setup_story(self):
        self.store.put_object('story', 'STORY', {'title': '隔离测试剧本', 'blocks': []})
        ep = p.record(self.store, 'episode')
        self.store.put_object('episode', 'EPISODE', {**ep['payload'], 'number': 1,
            'scenes': [{'id': 'scene', 'block_ids': ['a']}, {'id': 'second', 'block_ids': ['b']}]}, expected_version=1)
        self.sources = [{**self.ref('episode'), 'scene_id': scene, 'block_ids': [block]}
                        for scene, block in [('scene', 'a'), ('second', 'b')]]
        self.put(self.spec('lock', 'INPUT_LOCK', screenplay=self.ref('story'), episodes=[self.ref('episode')],
            approval={'actor': 'fixture', 'statement': '隔离测试，不是作品认可', 'scope': 'fixture'}, specification={}))

    def shot(self, oid='av-shot', source=None):
        return self.spec(oid, 'AV_SHOT', input_lock=self.ref('lock'), sources=copy.deepcopy(source or self.sources),
            purpose='观众看见歌本由完整变为浸湿', framing='中景，人物双手与歌本同框',
            spatial='女孩在门右，桌在左', axis='机位在门与桌轴线南侧', movement='固定机位',
            action_start='歌本在右手', action_end='歌本搁在桌上', performance='先检查再放下',
            lighting='窗边柔光', color='自然灰青', editing='动作收住后切', continuity='歌本不换手',
            fps=24, duration_frames=192, sound=['无对白；纸页和水滴声'], entities=[], states=[])

    def composition(self):
        self.setup_story()
        self.put(self.shot())
        self.put(self.spec('av-scene', 'AV_SCENE', input_lock=self.ref('lock'), sources=self.sources,
            purpose='表现物件变化', structure='跨两处故事正文，以歌本连接动作', rhythm='观察到放下',
            continuity='道具与手位连续', shots=[self.ref('av-shot')]))
        self.put(self.spec('av-episode', 'AV_EPISODE', input_lock=self.ref('lock'), sources=self.sources,
            story_episode=self.ref('episode'), number=1, purpose='传达损失', structure='单段完成前后变化',
            rhythm='先稳定再停顿', continuity='不增加人物知情', scenes=[self.ref('av-scene')]))

    def need(self, oid, inputs=None, **plan_extra):
        return self.spec(oid, 'REQUIREMENT', scope=self.ref('av-shot'), slot=oid, required=True,
            purpose='隔离测试需求', media_type='image', usage='generation_input', entities=[], states=[],
            specification={}, generation={'format': generation.PLAN, 'method': 'generate', 'model': 'fixture-only',
            'prompt': '隔离测试，不提交真实调用', 'parameters': {}, 'inputs': inputs or [], 'blockers': [],
            'output': {'name': '测试原件', 'description': '仅验证契约', 'review_criteria': ['fixture']}, **plan_extra})

    def test_two_story_scenes_and_exact_composition_survive_child_revision(self):
        self.composition()
        old = self.ref('av-shot')
        shot = self.shot(); shot['expected_version'] = 1; shot['payload']['framing'] = '新版特写'
        self.put(shot)
        catalog = av.catalog(self.store)
        self.assertEqual(catalog['shots'][0]['id'], old['revision_id'])
        self.assertEqual(len(catalog['scenes'][0]['payload']['sources']), 2)
        self.assertEqual(catalog['shots'][0]['payload']['framing'], '中景，人物双手与歌本同框')
        self.assertEqual(av.catalog(self.store, object_id='av-shot', revision_id=old['revision_id'])['design']['object_id'], 'av-episode')
        with self.assertRaisesRegex(ValueError, '未编入'):
            av.catalog(self.store, object_id='av-shot')

    def test_source_scene_block_and_child_scope_rejected_atomically(self):
        self.setup_story()
        bad = self.shot(); bad['payload']['sources'][0]['block_ids'] = ['b']
        with self.assertRaises(ValueError): self.put(bad)
        self.assertFalse(p.current_records(self.store, {'AV_SHOT'}))
        self.put(self.shot())
        bad_scene = self.spec('bad-scene', 'AV_SCENE', input_lock=self.ref('lock'), sources=self.sources[:1],
            purpose='test', structure='test', rhythm='test', continuity='test', shots=[self.ref('av-shot')])
        with self.assertRaisesRegex(ValueError, '超出'): self.put(bad_scene)

    def test_design_revision_reordering_never_moves_materials(self):
        self.composition(); self.put(self.need('front'), self.need('side'), self.need('first-frame'))
        from review_desk.production_breakdown import context
        old = self.ref('av-shot')
        shot = self.shot(); shot['expected_version'] = 1; shot['payload']['purpose'] = '新表达'
        self.put(shot)
        self.assertEqual(len(context(self.store, 'av-shot', old['revision_id'])['requirements']), 3)
        self.assertEqual(context(self.store, 'av-shot')['requirements'], [])

    def test_story_related_has_both_entity_and_av_evidence(self):
        self.composition()
        self.put(self.spec('book', 'ENTITY', entity_type='prop', aliases=[], facts=['歌本'], choices=[], unknowns=[], sources=self.sources))
        kinds = {r['record']['kind'] for r in av.related(self.store, self.sources[1])['items']}
        self.assertTrue({'ENTITY', 'AV_EPISODE', 'AV_SCENE', 'AV_SHOT'} <= kinds)

    def test_optional_and_unselected_routes_are_not_missing_inputs(self):
        self.composition(); self.put(self.need('upstream'))
        base = {'reference': self.ref('upstream'), 'use': '身份', 'selection_state': 'unselected'}
        plan = self.need('consumer', [
            {**base, 'necessity': 'optional'},
            {**base, 'necessity': 'conditional', 'condition': 'wet'},
            {**base, 'necessity': 'one_of', 'group': 'view', 'route': 'side'},
            {**base, 'necessity': 'one_of', 'group': 'view', 'route': 'front'}],
            conditions={'wet': False}, selected_routes={'view': 'front'})['payload']['generation']
        active, issues = mr.active_inputs(self.store, plan)
        self.assertEqual([i for i, _ in active], [3]); self.assertEqual(issues, [])
        plan['selected_routes'] = {}; plan['conditions'] = {}
        self.assertEqual(len(mr.active_inputs(self.store, plan)[1]), 2)

    def test_selected_cycle_blocks_readiness_but_not_draft_or_other_route(self):
        self.composition(); self.put(self.need('a'))
        self.put(self.need('b', [{'reference': self.ref('a'), 'use': '前置', 'selection_state': 'unselected'}]))
        update = self.need('a', [{'reference': self.ref('b'), 'use': '前置', 'selection_state': 'unselected',
            'necessity': 'conditional', 'condition': 'enabled'}], conditions={'enabled': False})
        update['expected_version'] = 1; self.put(update)
        self.assertEqual(mr.cycle_issues(self.store, p.record(self.store, 'a')), [])
        update['expected_version'] = 2; update['payload']['generation']['conditions']['enabled'] = True
        self.put(update)
        self.assertTrue(any('循环' in x for x in generation.readiness(self.store, 'a')['issues']))

    def test_unknown_custom_relation_remains_descriptive(self):
        self.composition(); self.put(self.need('upstream'),self.need('consumer'))
        relation = self.spec('relation', 'MATERIAL_RELATION', upstream=self.ref('upstream'), downstream_id='consumer',
            context=self.ref('av-shot'), purpose='未标准化的创作联想', preserve='不改变身份', change='仅说明', check='人工阅读',
            type_id='custom-motif', type_label='道具意象', type_version=1,
            type_definition={'endpoints': ['REQUIREMENT', 'REQUIREMENT'], 'direction': 'directed', 'attributes': {}},
            semantics='description', necessity='required', basis='production_choice', sources=self.sources)
        self.put(relation)
        value = {'reference': self.ref('upstream'), 'relation': self.ref('relation'), 'use': '意象关联'}
        revised=self.need('consumer', [value], relation_model='context-v1');revised['expected_version']=1
        self.put(revised)
        self.assertEqual(mr.active_inputs(self.store, p.record(self.store, 'consumer')['payload']['generation'], 'consumer'), ([], []))
        wrong = copy.deepcopy(relation); wrong['object_id'] = 'wrong'; wrong['payload']['semantics'] = 'magic'
        with self.assertRaises(ValueError): self.put(wrong)

    def test_route_choice_participates_in_frozen_definition(self):
        self.composition(); self.put(self.need('a', relation_model='context-v1', selected_routes={'x': 'front'}))
        before = material_plans.signature(p.record(self.store, 'a'), self.store)
        with self.store.db:
            self.store.db.execute("UPDATE material_plan_versions SET frozen=1 WHERE material_id='a'")
        changed = self.need('a', relation_model='context-v1', selected_routes={'x': 'side'}); changed['expected_version'] = 1
        self.put(changed)
        after = material_plans.signature(p.record(self.store, 'a'), self.store)
        self.assertNotEqual(before, after)
        self.assertEqual([r['number'] for r in material_plans.snapshot(self.store, 'a')], [2, 1])

    def test_acceptance_is_exact_and_concurrent_decisions_are_rejected(self):
        from review_desk import production_acceptance as acceptance
        from review_desk.store import Conflict
        self.composition()
        request = {'object_id': 'av-episode', 'expected_revision': self.ref('av-episode')['revision_id'],
                   'expected_decision': None, 'actor': '隔离测试', 'action': 'accept'}
        accepted = acceptance.decide(self.store, request)
        self.assertTrue(accepted['accepted'])
        self.assertEqual(len(accepted['scope']), 3)
        with self.assertRaises(Conflict): acceptance.decide(self.store, request)

        revoked = acceptance.decide(self.store, {**request, 'action': 'revoke',
            'expected_decision': p.record(self.store, accepted['decision']['object_id']) and
                acceptance.ref(accepted['decision'])})
        self.assertFalse(revoked['accepted'])
        previous = p.record(self.store, 'av-episode')
        self.put({'object_id': previous['object_id'], 'kind': previous['kind'], 'expected_version': previous['version'],
                  'payload': {**previous['payload'], 'purpose': '另一个明确意图'}})
        self.assertFalse(acceptance.snapshot(self.store, 'av-episode')['accepted'])
        with self.assertRaises(Conflict): acceptance.decide(self.store, request)

    def test_group_acceptance_child_override_and_restore_have_one_order(self):
        from review_desk import production_acceptance as a
        from review_desk.bundle import export, restore
        from review_desk.store import Store, Conflict
        import shutil
        self.composition(); self.put(self.need('need'))
        def decide(oid,action):
            view=a.snapshot(self.store,oid)
            return a.decide(self.store,{'object_id':oid,'expected_revision':view['target']['revision_id'],
                'expected_decision':a.ref(view['decision']) if view['decision'] else None,'action':action,'actor':'隔离测试'})
        parent=decide('av-episode','accept')
        self.assertTrue(a.snapshot(self.store,'av-shot')['accepted'])
        self.assertFalse(a.snapshot(self.store,'need')['accepted'])
        self.assertFalse(generation.readiness(self.store,'need')['ready'])
        decide('need','accept')
        self.assertTrue(a.snapshot(self.store,'av-shot')['accepted'])
        self.assertTrue(generation.readiness(self.store,'need')['ready'])
        decide('av-shot','revoke')
        self.assertFalse(generation.readiness(self.store,'need')['ready'])
        self.assertTrue(a.snapshot(self.store,'av-episode')['partial'])
        with self.assertRaises(Conflict):
            a.decide(self.store,{'object_id':'av-episode','expected_revision':self.ref('av-episode')['revision_id'],
                'expected_decision':a.ref(parent['decision']),'action':'revoke','actor':'隔离测试'})
        decide('av-episode','accept')
        self.assertTrue(generation.readiness(self.store,'need')['ready'])
        export(self.store,self.root/'export');dest=self.root/'acceptance-restore'
        shutil.copytree(self.root/'export',dest/'export');restored=Store(dest/'.runtime/review.sqlite3')
        try:
            restore(restored,dest/'export')
            self.assertEqual(a.snapshot(restored,'av-shot'),a.snapshot(self.store,'av-shot'))
        finally: restored.close()



if __name__ == '__main__':
    unittest.main()
