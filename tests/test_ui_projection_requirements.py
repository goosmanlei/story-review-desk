"""Independent task-0008 read projection regressions using disposable stores."""
import json
import threading
import unittest
import urllib.request
from urllib.parse import urlencode

import test_production as production_fixture
import test_complete_states as state_fixture
import test_generation as generation_fixture
import test_material_versions as material_fixture
from review_desk import production as p, ui_projection as ui


class UIProjectionRequirementsTest(unittest.TestCase):
    setUp = production_fixture.ProductionTest.setUp
    tearDown = production_fixture.ProductionTest.tearDown
    spec = production_fixture.ProductionTest.spec
    put = production_fixture.ProductionTest.put
    ref = production_fixture.ProductionTest.ref
    entity = production_fixture.ProductionTest.entity
    requirement = production_fixture.ProductionTest.requirement
    media = production_fixture.ProductionTest.media
    full = state_fixture.CompleteStatesTest.full
    need = state_fixture.CompleteStatesTest.need
    setup_plans = generation_fixture.GenerationTest.setup_plans
    change = generation_fixture.GenerationTest.change
    generate = material_fixture.MaterialVersionsTest.generate

    def scene_and_state(self):
        self.put(self.entity())
        self.put(self.full())
        self.put(self.need())
        from audiovisual_fixture import composition
        composition(self)

    def applicability(self, name, subject, scope):
        self.put(self.spec(name, 'RELATION', relation_type='applicability',
                           subject=self.ref(subject), scope=self.ref(scope),
                           basis='production_choice', reason='explicit fixture assignment'))

    def test_scene_occurrence_does_not_duplicate_explicit_shot_material_in_shared_area(self):
        self.scene_and_state()
        self.applicability('shot-use', 'need-full-overall', 'shot')
        data = ui.scene(self.store, 'scene')
        self.assertEqual([m['object_id'] for m in data['shots'][0]['context']['materials']],
                         ['need-full-overall'])
        self.assertFalse(any(m['object_id'] == 'need-full-overall'
                             for context in data['shared'] for m in context['materials']))
        self.assertEqual(data['shots'][0]['context']['adoptions'], [])

    def test_entity_and_state_applicability_do_not_invent_shot_material_use(self):
        self.scene_and_state()
        self.applicability('entity-on-scene', 'songbook', 'scene')
        self.applicability('state-on-shot', 'full', 'shot')
        data = ui.scene(self.store, 'scene')
        scene = next(c for c in data['shared'] if c['record']['kind'] == 'AV_SCENE')
        for context in (scene, data['shots'][0]['context']):
            self.assertEqual(context['materials'], [])
            self.assertEqual(context['adoptions'], [])

    def test_historical_scene_keeps_its_old_shot_after_current_shot_moves(self):
        self.scene_and_state()
        exact_shot = self.ref('shot'); old_parent = self.ref('scene')
        shot = p.record(self.store, 'shot')
        self.put({'object_id': 'shot', 'kind': 'AV_SHOT', 'expected_version': shot['version'],
                  'payload': {**shot['payload'], 'purpose': '新的表达目的'}})
        current = p.record(self.store, 'scene')
        self.put({'object_id': 'scene', 'kind': 'AV_SCENE', 'expected_version': current['version'],
                  'payload': {**current['payload'], 'shots': [self.ref('shot')]}})
        data = ui.scene(self.store, old_parent['object_id'], old_parent['revision_id'])
        self.assertEqual([s['record']['id'] for s in data['shots']], [exact_shot['revision_id']])

    def subject_only_asset(self):
        self.put(self.entity())
        self.media()
        asset = p.record(self.store, 'voice')
        self.put({'object_id': 'voice', 'kind': 'ASSET', 'expected_version': asset['version'],
                  'payload': {**asset['payload'], 'subjects': [self.ref('songbook')]}})

    def test_subject_only_legacy_asset_counts_once_for_its_entity(self):
        self.subject_only_asset()
        entries = ui.material_entries(self.store)
        asset_entry = next(r for r in entries if r['object_id'] == 'voice')
        self.assertEqual(asset_entry['entity_ids'], ['songbook'])
        result = ui.entity_summaries(self.store, [p.record(self.store, 'songbook')], entries)
        self.assertEqual(result['entity_material_counts']['songbook'], {'audio': 1})

    def test_subject_only_legacy_asset_card_restores_its_known_entity(self):
        self.subject_only_asset()
        card = ui.card(self.store, 'voice', self.ref('voice')['revision_id'])
        self.assertIsNotNone(card['entity_review'], 'a known entity subject is not an unowned asset')
        self.assertEqual(card['entity_review']['entity']['object_id'], 'songbook')

    def test_combined_facets_count_materials_and_retain_categories_for_zero_results(self):
        self.put(self.entity())
        self.put(self.requirement())
        self.media()
        normal = ui.material_list(self.store, media='audio', status='ungenerated')
        self.assertEqual(normal['total'], 1)
        self.assertEqual(normal['facets']['status'], {'': 2, 'generated': 1, 'ungenerated': 1})
        empty = ui.material_list(self.store, media='video', status='ungenerated')
        self.assertEqual(empty['total'], 0)
        self.assertIn('audio', empty['facets']['media'])
        self.assertEqual(empty['facets']['media']['audio'], 1)

    def test_candidates_and_new_plan_versions_do_not_inflate_entity_material_counts(self):
        self.setup_plans()
        entity = p.record(self.store, 'songbook')
        def counts():
            return ui.entity_summaries(self.store, [entity], ui.material_entries(self.store))['entity_material_counts']['songbook']
        self.assertEqual(counts(), {'audio': 2})
        self.generate()
        self.generate('second-call', 'second-result')
        self.assertEqual(counts(), {'audio': 2})
        plan = p.record(self.store, 'need-full-overall')['payload']['generation']
        self.change('need-full-overall', generation={**plan, 'prompt': 'different next version'})
        self.assertEqual(counts(), {'audio': 2})

    def paginated_historical_material(self):
        self.setup_plans()
        self.generate()
        exact = self.ref('generated')
        self.change('generated', title='New metadata for same historical candidate')
        plan = p.record(self.store, 'need-full-overall')['payload']['generation']
        self.change('need-full-overall', title='page-fixture linked material',
                    generation={**plan, 'prompt': 'New empty plan must not replace linked history'})
        for index in range(40):
            need = self.requirement(f'a-before-{index:02d}')
            need['payload']['slot'] = f'pagination-fixture-{index:02d}'
            need['payload']['title'] = f'page-fixture earlier material {index:02d}'
            self.put(need)
        return exact

    def test_focused_material_and_old_candidate_locate_item_41_without_changing_exact_card(self):
        exact = self.paginated_historical_material()
        ordinary = ui.material_list(self.store, search='page-fixture')
        self.assertEqual(ordinary['total'], 41)
        self.assertNotIn('need-full-overall', [r['object_id'] for r in ordinary['items']])
        for focus in ('need-full-overall', exact['object_id']):
            focused = ui.material_list(self.store, search='page-fixture', focus=focus)
            self.assertEqual((focused['offset'], focused['limit'], focused['total']), (40, 40, 41))
            self.assertEqual([r['object_id'] for r in focused['items']], ['need-full-overall'])
            self.assertIsNone(focused['focused_outside'])
            self.assertEqual(focused['facets'], ordinary['facets'])
        card = ui.card(self.store, exact['object_id'], exact['revision_id'])
        self.assertEqual(card['detail']['record']['id'], exact['revision_id'])
        versions = card['detail']['material_versions']['need-full-overall']
        self.assertEqual(versions[0]['results'], [])
        self.assertIn(exact['revision_id'], [r['id'] for version in versions[1:] for r in version['members']])

    def test_exact_generated_asset_recovers_owner_from_its_actual_call_requirement(self):
        self.setup_plans()
        self.generate()
        exact = self.ref('generated')
        form = self.ref('full')
        self.change('generated', title='Updated candidate metadata')
        old_plan = p.record(self.store, 'need-full-overall')['payload']['generation']
        self.change('need-full-overall', generation={**old_plan, 'prompt': 'New current plan'})
        card = ui.card(self.store, exact['object_id'], exact['revision_id'])
        self.assertEqual(card['detail']['record']['id'], exact['revision_id'])
        self.assertIsNotNone(card['entity_review'], 'the actual call identifies the exact requirement and entity')
        self.assertEqual(card['entity_review']['entity']['object_id'], 'songbook')
        self.assertEqual(card['form']['id'], form['revision_id'])

    def test_filter_excluded_focus_does_not_inflate_zero_or_nonzero_results(self):
        exact = self.paginated_historical_material()
        for search, count in (('earlier material', 40), ('no matching material', 0)):
            ordinary = ui.material_list(self.store, search=search)
            focused = ui.material_list(self.store, search=search, focus=exact['object_id'])
            self.assertEqual(focused['total'], count)
            self.assertEqual(focused['items'], ordinary['items'])
            self.assertEqual(focused['facets'], ordinary['facets'])
            self.assertEqual(focused['focused_outside']['object_id'], 'need-full-overall')
        self.assertIsNone(ui.material_list(self.store, focus='missing-material')['focused_outside'])

    def test_http_material_focus_and_empty_filter_keep_the_exact_historical_card(self):
        from review_desk.server import ReviewServer
        exact = self.paginated_historical_material()
        paths = [
            'materials?' + urlencode({'search': 'page-fixture', 'focus': exact['object_id']}),
            'materials?' + urlencode({'search': 'no matching material', 'focus': exact['object_id']}),
            'card?' + urlencode(exact),
        ]
        responses = []
        errors = []
        with ReviewServer(('127.0.0.1', 0), self.root, {'id': 'test', 'title': 'test'}) as server:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def client():
                try:
                    for path in paths:
                        with opener.open(f'http://127.0.0.1:{server.server_port}/api/production/{path}', timeout=5) as response:
                            responses.append(json.load(response))
                except Exception as error:
                    errors.append(repr(error))
            worker = threading.Thread(target=client, daemon=True)
            worker.start()
            server.timeout = 2
            for _ in paths:
                server.handle_request()
            worker.join(timeout=6)
            self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(responses), 3)
        self.assertEqual((responses[0]['offset'], responses[0]['total']), (40, 41))
        self.assertEqual(responses[1]['total'], 0)
        self.assertEqual(responses[1]['items'], [])
        self.assertEqual(responses[1]['focused_outside']['object_id'], 'need-full-overall')
        self.assertEqual(responses[2]['detail']['record']['id'], exact['revision_id'])

    def test_entity_demand_is_in_list_count_and_card_without_extending_approval(self):
        from review_desk import generation as g
        self.setup_plans()
        scope=g.current_scope(self.store,'songbook')
        need=self.requirement('entity-identity')
        need['payload']['scope']=self.ref('songbook')
        self.put(need)
        view=g.snapshot(self.store,'songbook')
        self.assertIn('entity-identity',[r['object_id'] for r in view['requirements']])
        self.assertIn('entity-identity',view['material_versions'])
        entries=ui.material_entries(self.store)
        self.assertIn('entity-identity',[r['object_id'] for r in entries])
        counts=ui.entity_summaries(self.store,[view['entity']],entries)['entity_material_counts']
        self.assertEqual(counts['songbook']['audio'],3)
        card=ui.card(self.store,'entity-identity',self.ref('entity-identity')['revision_id'])
        self.assertIn('entity-identity',card['entity_review']['material_versions'])

    def test_retired_need_does_not_hide_exact_subject_or_coverage(self):
        from unittest.mock import patch
        self.subject_only_asset()
        self.put(self.full())
        self.change('voice',states=[self.ref('full')],state_coverage=[{'state':self.ref('full'),'role':'overall','component_id':'original','detail':'完整覆盖'}])
        detail=p.snapshot(self.store,object_id='voice')
        detail['review_context']['requirements']=[{'unavailable':True,'payload':{}}]
        with patch.object(p,'snapshot',return_value=detail):
            card=ui.card(self.store,'voice')
        self.assertEqual(card['scope']['id'],self.ref('full')['revision_id'])
        self.assertEqual(card['entity_review']['entity']['object_id'],'songbook')
        self.assertEqual(card['form']['object_id'],'full')

    def test_each_shot_demand_has_complete_exact_source_navigation(self):
        self.scene_and_state()
        for oid,slot in [('shot-camera','camera'),('shot-frame','first_frame'),('shot-video','video')]:
            need=self.requirement(oid);need['payload'].update(scope=self.ref('shot'),slot=slot)
            self.put(need)
        for oid in ('shot-camera','shot-frame','shot-video'):
            card=ui.card(self.store,oid)
            self.assertIsNone(card['entity_review'])
            self.assertEqual(card['scope']['id'],self.ref('shot')['revision_id'])
            self.assertEqual({i['object_id'] for i in card['source_materials']},{'shot-camera','shot-frame','shot-video'})
        # A state's application to a shot remains a reference to that state's
        # demand, never a demand originating in this shot.
        self.applicability('applied-state-demand','need-full-overall','shot')
        card=ui.card(self.store,'shot-camera')
        self.assertNotIn('need-full-overall',{i['object_id'] for i in card['source_materials']})


if __name__ == '__main__':
    unittest.main()
