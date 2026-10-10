"""Independent list/card contracts, using isolated production records."""
import copy
import unittest
from unittest.mock import patch

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

    def mount_on_test_shot(self, subject):
        from audiovisual_fixture import composition
        composition(self, shot_values={'entities':[self.ref('songbook')], 'states':[self.ref('full')], 'state_model':'complete-v1'})
        self.put(self.spec('shot-use', 'RELATION', relation_type='applicability',
                           subject=self.ref(subject), scope=self.ref('shot'),
                           basis='production_choice', reason='explicit fixture assignment'))

    def test_generated_history_does_not_promote_the_empty_current_plan(self):
        self.setup_plans(); self.generate()
        original = self.ref('generated')
        plan = copy.deepcopy(p.record(self.store, 'need-full-overall')['payload']['generation'])
        self.change('need-full-overall', generation={**plan, 'prompt': 'A new ungenerated plan'})
        entries = {row['object_id']: row for row in ui.material_entries(self.store)}
        item = entries['need-full-overall']
        self.assertEqual((item['generated'], item['generation_scope']), (True, 'history'))
        versions = p.snapshot(self.store, object_id='need-full-overall')['material_versions']['need-full-overall']
        self.assertEqual(versions[0]['results'], [])
        self.assertTrue(any(r['id'] == original['revision_id'] for version in versions[1:] for r in version['members']))
        # A standalone exact asset and an empty demand have different scopes.
        self.assertEqual((entries['voice']['generated'], entries['voice']['generation_scope']), (True, 'exact'))
        self.assertEqual((entries['need-wet-overall']['generated'], entries['need-wet-overall']['generation_scope']), (False, 'history'))

    def test_scene_history_summary_preserves_its_exact_link_and_empty_current_plan(self):
        self.setup_plans(); self.generate()
        plan = copy.deepcopy(p.record(self.store, 'need-full-overall')['payload']['generation'])
        self.change('need-full-overall', generation={**plan, 'prompt': 'New current plan without a result'})
        exact = self.ref('need-full-overall')
        self.mount_on_test_shot('need-full-overall')
        data = ui.scene(self.store, 'scene')
        item = next(i for i in data['shots'][0]['context']['materials'] if i['object_id'] == exact['object_id'])
        self.assertEqual((item['generated'], item['generation_scope']), (True, 'history'))
        self.assertEqual(item['id'], exact['revision_id'])
        self.assertEqual(item['record']['id'], exact['revision_id'])
        self.assertEqual(item['association'], 'applicable')
        self.assertEqual(data['shots'][0]['context']['adoptions'], [])
        versions = ui.card(self.store, **{'object_id': exact['object_id'], 'revision_id': exact['revision_id']})['detail']['material_versions'][exact['object_id']]
        self.assertEqual(versions[0]['results'], [])

    def test_breakdown_reads_only_list_metadata_but_keeps_exact_card_and_counts(self):
        self.setup_plans(); self.generate(); self.mount_on_test_shot('need-full-overall')
        full = ui.scene(self.store, 'scene', view='shots')
        with patch.object(p, 'snapshot', wraps=p.snapshot) as snapshots:
            slim = ui.scene(self.store, 'scene', view='breakdown')
        self.assertEqual(slim['scene'], full['scene'])
        self.assertEqual(slim['shots'][0]['record'], full['shots'][0]['record'])
        old = full['shots'][0]['context']['materials']
        new = slim['shots'][0]['context']['materials']
        for item, expected in zip(new, old):
            self.assertEqual({k:v for k,v in item.items() if k!='record'},
                             {k:v for k,v in expected.items() if k!='record'})
            self.assertEqual(item['record']['id'], expected['record']['id'])
        target = new[0]['reference']
        detail = ui.card(self.store, target['object_id'], target['revision_id'])
        self.assertEqual(detail['detail']['record']['id'], target['revision_id'])
        self.assertIn('generation', detail['detail']['record']['payload'])
        self.assertEqual(slim['shots'][0]['context']['video_details'], full['shots'][0]['context']['video_details'])
        self.assertTrue(all(call.kwargs['object_id'] in {r['object_id'] for shot in slim['shots'] for r in shot['context']['requirements']} for call in snapshots.call_args_list))

    def test_scene_fallback_keeps_exact_scope_and_rejects_placeholder_or_preview_as_results(self):
        self.setup_plans(); self.media(); self.mount_on_test_shot('voice')
        exact = self.ref('voice'); saved = p.record(self.store, 'voice')
        original_ref_record = p.ref_record
        for placeholder, role, generated in ((False, 'original', True), (True, 'original', False), (False, 'preview', False)):
            with self.subTest(placeholder=placeholder, role=role):
                projected = copy.deepcopy(saved)
                projected['payload']['placeholder'] = placeholder
                projected['payload']['components'][0]['role'] = role
                def exact_row(store, reference, *args, **kwargs):
                    if reference == exact:
                        return copy.deepcopy(projected)
                    return original_ref_record(store, reference, *args, **kwargs)
                # A missing inventory entry forces the historical/exact fallback.
                # Preview-only data is injected at this read boundary: normal
                # production imports correctly require an original component.
                with patch.object(ui, 'material_entries', return_value=[]), patch.object(p, 'ref_record', side_effect=exact_row):
                    item = ui.scene(self.store, 'scene')['shots'][0]['context']['materials'][0]
                self.assertEqual((item['generated'], item['generation_scope']), (generated, 'exact'))
                self.assertEqual(item['id'], exact['revision_id'])
                self.assertEqual(item['record']['payload'], projected['payload'])
                self.assertEqual(item['usage_evidence'][0]['kind'], 'direct_requirement')
        self.assertEqual(p.record(self.store, 'voice'), saved, 'defensive projection fixtures must not mutate stored history')

    def test_shared_requirement_history_is_independent_of_alias_name_order(self):
        from review_desk import material_model, material_storage
        from test_production import ProductionTest
        self.setup_plans()
        component = ProductionTest.image(self)
        template = copy.deepcopy(p.record(self.store, 'need-full-overall')['payload'])
        template.update(media_type='image', usage='generation_input')
        template['generation'].update(model='test-image', parameters={'format': 'png'}, prompt='An isolated overall image fixture',
                                      output={'name': 'Overall image', 'description': 'An exact original for projection tests', 'review_criteria': ['Preserve the original']})
        for index, (canonical, alias) in enumerate((('z-source', 'a-alias'), ('a-source', 'z-alias'))):
            with self.subTest(canonical=canonical, alias=alias):
                source_form, alias_form = 'source-form-' + str(index), 'alias-form-' + str(index)
                forms = [self.full(source_form), self.full(alias_form)]
                for form in forms:
                    form['payload']['reference_media'] = 'image'
                self.put(*forms)
                source_payload = {**copy.deepcopy(template), 'title': canonical,
                                  'scope': self.ref(source_form), 'states': [self.ref(source_form)]}
                self.put({'object_id': canonical, 'kind': 'REQUIREMENT', 'expected_version': 0,
                          'payload': source_payload})
                reused = copy.deepcopy(template)
                reused['title'] = alias
                reused.update(scope=self.ref(alias_form), states=[self.ref(alias_form)])
                reused['generation'].update(method='reuse', inputs=[{'reference': self.ref(canonical), 'use': 'Explicitly share the same requirement'}])
                self.put({'object_id': alias, 'kind': 'REQUIREMENT', 'expected_version': 0, 'payload': reused})
                self.assertEqual(material_storage.canonical_id(self.store, alias), canonical)
                self.assertIn((alias, canonical), [(v['alias_id'], v['material_id']) for v in material_model.prove_aliases(self.store)])
                asset = 'alias-result-' + str(index)
                self.put(self.spec(asset, 'ASSET', media_type='image', subjects=[], states=[self.ref(alias_form)],
                                   components=[copy.deepcopy(component)], production=self.ref('draw'), lineage={'i2i_depth': 0, 'references': []},
                                   state_coverage=[{'state': self.ref(alias_form), 'role': 'overall', 'component_id': 'original', 'detail': 'Fixture exact coverage'}],
                                   candidate_requirements=[self.ref(alias)]))
                self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM material_plan_members WHERE material_id=? AND role='result'", (canonical,)).fetchone()[0], 0)
                self.assertGreater(self.store.db.execute("SELECT COUNT(*) FROM material_plan_members WHERE material_id=? AND role='result'", (alias,)).fetchone()[0], 0)
                items = [i for i in ui.material_entries(self.store) if i['canonical_material_id'] == canonical]
                self.assertEqual(len(items), 1)
                self.assertEqual(items[0]['object_id'], canonical)
                self.assertEqual(items[0]['generation_scope'], 'history')
                self.assertTrue(items[0]['generated'], 'a canonical list item must retain real results registered under its explicit reuse alias')
                self.assertEqual(items[0]['preview'], component, 'the available original image survives either canonical/alias order')
                self.assertEqual(p.record(self.store, asset)['payload']['components'][0], component)
                self.assertTrue((self.root / 'export/assets' / component['file']).is_file())


if __name__ == '__main__':
    unittest.main()
