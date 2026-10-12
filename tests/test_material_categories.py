import copy
import tempfile
import unittest
from pathlib import Path

from review_desk import material_categories as categories, methods, method_media, production as p
from review_desk.store import Store, Conflict
from test_methods import seed


class MaterialCategoriesTest(unittest.TestCase):
    def test_deferred_small_cards_keep_category_without_loading_plan(self):
        from review_desk.entity_contract import material_summary
        full = {'object_id': 'song', 'kind': 'REQUIREMENT', 'version': 1,
                'payload': {**self.payload('song'), 'generation': {'prompt': 'full song'}}}
        summary = material_summary(full)
        self.assertEqual(summary['payload']['material_category'], 'song')
        self.assertNotIn('generation', summary['payload'])
        self.assertTrue(summary['deferred_detail'])

    def test_shot_owned_character_reference_is_not_a_first_frame(self):
        from review_desk.entity_contract import material_groups
        needs = [{'object_id': name, 'payload': {'slot': slot, 'media_type': 'image',
                  'material_category': category}} for name, slot, category in (
                    ('helpers', 'overall', 'character-image'),
                    ('camera', 'camera-main', 'shot-image'),
                    ('start', 'first-frame', 'shot-image'))]
        groups = material_groups({'payload': {}}, needs)
        self.assertEqual([(g['label'], g['material_ids']) for g in groups], [
            ('独立素材参考', ['helpers']), ('机位参考', ['camera']), ('镜头首帧', ['start'])])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / '.runtime/review.sqlite3')
        self.addCleanup(self.store.close)
        _, self.original, self.binding = seed(self.store, 'media-plan', ['draft', 'review', 'result'])

    def cutover(self):
        saved = {}
        for family, _, _, name in categories.CATEGORIES.values():
            if name in saved:
                continue
            payload = copy.deepcopy(self.original['payload'])
            if family == 'image':
                for key, spec in categories.CATEGORIES.items():
                    if spec[0] == 'image':
                        payload['files']['references/' + key + '.md'] = 'SPECIALTY-' + key
            saved[name] = methods.save(self.store, {'category': 'skill', 'name': name,
                'expected_version': 0, 'payload': payload})
        return methods.save(self.store, {'category': 'binding', 'name': 'media-plan',
            'expected_version': self.binding['version'], 'payload': {'work_type': 'media-plan',
                'rules': [{**methods.reference(saved[spec[3]]), 'when': {'material_category': key}}
                          for key, spec in categories.CATEGORIES.items()]}})

    def payload(self, category):
        result = {'media_type': categories.CATEGORIES[category][2], 'material_category': category}
        if category == 'text-layer':
            result.update(blocks=[{'id': 'exact', 'text': '一日两升'}], specification={'format': 'SVG'})
        return result

    def test_nine_categories_select_without_manual_audio_or_scope_heuristics(self):
        self.cutover()
        for key, spec in categories.CATEGORIES.items():
            with self.subTest(category=key):
                payload = {**self.payload(key), 'scope': {'object_id': 'same-shot'}, 'title': '首帧里的人在唱歌'}
                package = categories.package(self.store, payload)
                self.assertEqual(package['method']['object_id'], 'method.skill.' + spec[3])
                if spec[0] == 'image':
                    self.assertEqual(package['applicable_files'], ['SKILL.md', 'references/' + key + '.md'])
                    text = methods.instructions(package)
                    self.assertIn('SPECIALTY-' + key, text)
                    self.assertEqual(text.count('SPECIALTY-'), 1)
        with self.assertRaisesRegex(ValueError, '分类'):
            categories.package(self.store, {'media_type': 'audio', 'title': '音色'})
        with self.assertRaisesRegex(ValueError, '不兼容'):
            categories.package(self.store, {**self.payload('song'), 'media_type': 'image'})
        with self.assertRaisesRegex(ValueError, '不能改变'):
            categories.package(self.store, self.payload('song'), {'audio_type': 'voice'})
        self.assertNotIn('audio_type', categories.conditions(self.store, self.payload('song'), {'audio_type': 'song'}))

    def test_frozen_execution_survives_cutover_new_work_requires_category(self):
        request = {'work_type': 'media-plan', 'run_id': 'run', 'step_id': 'old', 'target': 'item',
                   'conditions': {'media_type': 'audio'}, 'inputs': {'context': {'media_type': 'audio'}}}
        old = methods.prepare(self.store, request)
        self.cutover()
        self.assertEqual(methods.prepare(self.store, request), old)
        with self.assertRaisesRegex(ValueError, '分类'):
            methods.prepare(self.store, {**request, 'step_id': 'new'})
        changed = {**request, 'conditions': categories.conditions(self.store, self.payload('song')),
                   'inputs': {'context': self.payload('song')}}
        with self.assertRaises(Conflict):
            methods.prepare(self.store, changed)
        fresh = methods.prepare(self.store, {**changed, 'step_id': 'song'})
        self.assertEqual(fresh['payload']['package']['method']['object_id'], 'method.skill.song-plan')
        with self.assertRaisesRegex(ValueError, '不能改变'):
            methods.prepare(self.store, {**changed, 'step_id': 'wrong',
                'conditions': {'media_type': 'audio', 'material_category': 'voice'}})

    def test_media_prepare_resumes_old_envelope_after_cutover(self):
        value = {'object_id': 'new-item', 'expected_version': 0, 'run_id': 'run', 'step_id': 'prepare',
                 'payload': {'media_type': 'image', 'purpose': 'exact original'}}
        old = method_media.prepare(self.store, value)
        self.cutover()
        self.assertEqual(method_media.prepare(self.store, value), old)
        with self.assertRaisesRegex(ValueError, '分类'):
            method_media.prepare(self.store, {**value, 'step_id': 'fresh'})

    def test_text_layer_stages_preserve_exact_text_and_do_not_invent_generation(self):
        self.cutover()
        payload = self.payload('text-layer')
        prepared = method_media.prepare(self.store, {'object_id': 'text', 'expected_version': 0,
            'payload': payload, 'run_id': 'run', 'step_id': 'text'})
        request, execution = prepared['request'], prepared['execution']
        for stage in ('draft', 'review', 'result'):
            value = {'assessment': '准确正文不变；没有模型调用。'} if stage == 'review' else method_media.output(payload)
            artifact = methods.artifact(self.store, {**request, 'execution': methods.reference(execution),
                'stage': stage, 'output': value})
            self.assertEqual(methods.stage_record(self.store, methods.reference(execution), stage)['artifact'], artifact)
        authored = {**payload, 'method_basis': {'execution': methods.reference(execution),
            'artifact': methods.reference(artifact), 'run_id': 'run', 'step_id': 'text'}}
        method_media.verify(self.store, 'text', authored)
        tampered = copy.deepcopy(authored); tampered['blocks'][0]['text'] = '三升'
        with self.assertRaisesRegex(ValueError, '定稿'):
            method_media.verify(self.store, 'text', tampered)
        with self.assertRaisesRegex(ValueError, '字层'):
            method_media.validate_stage(self.store, execution, 'result', {
                **method_media.output(payload), 'text_layer': {'blocks': [], 'specification': {}}})

    def test_missing_specialty_and_ambiguous_binding_fail_explicitly(self):
        binding = self.cutover()
        row = methods.read(self.store, 'method.skill.image-plan')
        payload = copy.deepcopy(row['payload']); del payload['files']['references/prop-image.md']
        changed = methods.save(self.store, {'category': 'skill', 'name': 'image-plan',
            'expected_version': row['version'], 'payload': payload})
        rules = copy.deepcopy(binding['payload']['rules'])
        for rule in rules:
            if rule['object_id'] == changed['object_id']: rule['revision_id'] = changed['revision_id']
        current = methods.save(self.store, {'category': 'binding', 'name': 'media-plan',
            'expected_version': binding['version'], 'payload': {'work_type': 'media-plan', 'rules': rules}})
        with self.assertRaisesRegex(ValueError, '专项'):
            categories.package(self.store, self.payload('prop-image'))
        self.assertEqual(categories.package(self.store, self.payload('character-image'))['method']['revision_id'], changed['revision_id'])
        # Two equally specific conditions can both match, even without duplicate rules.
        rules.append({**rules[0], 'when': {'extra': True}})
        methods.save(self.store, {'category': 'binding', 'name': 'media-plan',
            'expected_version': current['version'], 'payload': {'work_type': 'media-plan', 'rules': rules}})
        with self.assertRaisesRegex(ValueError, '兜底|歧义'):
            categories.package(self.store, self.payload('character-image'), {'extra': True})

    def test_category_counts_keep_one_material_across_locations_and_search_status(self):
        from review_desk.ui_projection import _material_filter_facets
        rows = [dict(object_id=key, material_category=category, media_type=categories.CATEGORIES[category][2],
                     generated=generated, search_fields=[title], locations=locations)
                for key, category, generated, title, locations in [
                    ('dog', 'character-image', True, 'dog', [{'episode': 'e1', 'scene': 's1'}]*2),
                    ('frame', 'shot-image', False, 'dog enters', [{'episode': 'e1', 'scene': 's1'}, {'episode': 'e2', 'scene': 's1'}]),
                    ('voice', 'voice', True, 'voice', [{'episode': 'e1', 'scene': 's1'}]),
                    ('song', 'song', True, 'song', [{'episode': 'e2', 'scene': 's1'}]),
                    ('text', 'text-layer', False, 'dog sign', [{'episode': 'e1', 'scene': 's1'}])]]
        chosen = {'episode': 'e1', 'scene': 's1', 'media': None, 'status': None}
        facets, result = _material_filter_facets(rows, chosen, '', True)
        self.assertEqual(len(result), 4)
        self.assertEqual(facets['media']['image'], 2)
        self.assertEqual(facets['media']['image'], sum(facets['media'][key] for key, spec in categories.CATEGORIES.items() if spec[0]=='image'))
        self.assertEqual(facets['media']['audio'], 1)
        self.assertEqual(facets['media']['text-layer'], 1)
        self.assertEqual(facets['media']['scene-sound'], 0)
        facets, result = _material_filter_facets(rows, {**chosen, 'media': 'image', 'status': 'ungenerated'}, 'dog', True)
        self.assertEqual([row['object_id'] for row in result], ['frame'])
        self.assertEqual(facets['media']['image'], 1)
        self.assertEqual(facets['media']['text-layer'], 1)
        _, result = _material_filter_facets(rows, {**chosen, 'media': 'scene-sound'}, '', True)
        self.assertEqual(result, [])

    def test_existing_distinct_references_in_one_legacy_slot_remain_editable(self):
        episode = self.store.put_object('entity', 'ENTITY', {
            'format': 'production-entity-v1', 'title': 'characters', 'entity_type': 'character',
            'blocks': [{'id': 'line', 'text': 'two characters'}], 'aliases': [], 'facts': [],
            'choices': [], 'unknowns': [], 'sources': []})
        owner = {'object_id': 'entity', 'revision_id': episode['revision']}
        payload = {'format': 'production-requirement-v1', 'title': 'one',
            'blocks': [{'id': 'purpose', 'text': 'one reference'}],
            'scope': owner,
            'slot': 'overall', 'required': True, 'purpose': 'independent reference',
            'media_type': 'audio', 'usage': 'post_audio', 'entities': [owner], 'states': [], 'specification': {}}
        one = {'object_id': 'one', 'kind': 'REQUIREMENT', 'expected_version': 0, 'payload': payload}
        p.import_records(self.store, {'format': 'production-import-v1', 'records': [one]})
        two = {**one, 'object_id': 'two', 'payload': {**payload, 'title': 'two'}}
        # Reproduce a retained semantic migration, not an author-created duplicate.
        p._import_records(self.store, {'format': 'production-import-v1', 'records': [two]}, check_current=False)
        revised = {**one, 'expected_version': 1, 'payload': {**payload, 'purpose': 'clarified reference'}}
        p.import_records(self.store, {'format': 'production-import-v1', 'records': [revised]})
        self.assertEqual(p.record(self.store, 'one')['payload']['purpose'], 'clarified reference')
        with self.assertRaises(Conflict):
            p.import_records(self.store, {'format': 'production-import-v1', 'records': [{**one, 'object_id': 'three'}]})

    def test_whole_tree_rejects_partial_cutover_and_zero_count_missing_method(self):
        from unittest.mock import patch
        binding = self.cutover()
        rows = [{'payload': self.payload('voice')}, {'payload': {'media_type': 'image'}}]
        with patch.object(p, 'current_records', return_value=rows):
            with self.assertRaisesRegex(ValueError, '分类缺失'):
                categories.validate_tree(self.store)
            rows[1]['payload'] = self.payload('shot-image')
            categories.validate_tree(self.store)
            rules = [r for r in binding['payload']['rules'] if r['when'].get('material_category') != 'scene-sound']
            methods.save(self.store, {'category': 'binding', 'name': 'media-plan',
                'expected_version': binding['version'], 'payload': {'work_type': 'media-plan', 'rules': rules}})
            with self.assertRaisesRegex(ValueError, '方法|匹配|分类'):
                categories.validate_tree(self.store)

    def test_category_change_rejects_old_result_and_new_step_gets_new_specialty(self):
        self.cutover()
        payload = self.payload('text-layer')
        prepared = method_media.prepare(self.store, {'object_id': 'text', 'expected_version': 0,
            'payload': payload, 'run_id': 'change', 'step_id': 'before'})
        request, execution = prepared['request'], prepared['execution']
        for stage in ('draft', 'review', 'result'):
            value = {'assessment': '完整回读'} if stage == 'review' else method_media.output(payload)
            artifact = methods.artifact(self.store, {**request, 'execution': methods.reference(execution),
                'stage': stage, 'output': value})
        authored = {**payload, 'material_category': 'shot-image', 'media_type': 'image',
            'method_basis': {'execution': methods.reference(execution), 'artifact': methods.reference(artifact),
                             'run_id': 'change', 'step_id': 'before'}}
        with self.assertRaises(ValueError):
            method_media.verify(self.store, 'text', authored)
        new_payload = self.payload('shot-image')
        fresh = method_media.prepare(self.store, {'object_id': 'text', 'expected_version': 0,
            'payload': new_payload, 'run_id': 'change', 'step_id': 'after'})
        self.assertEqual(fresh['execution']['payload']['package']['applicable_files'],
                         ['SKILL.md', 'references/shot-image.md'])

    def test_reuse_package_keeps_exact_range_without_fictional_model_or_random_seed(self):
        from unittest.mock import patch
        from review_desk import generation
        selected = {'asset': {'object_id': 'original', 'revision_id': 'exact'},
                    'component': {'id': 'original', 'mime': 'audio/wav'},
                    'range': {'start_seconds': 1.2, 'end_seconds': 5.6}, 'use': 'voice identity'}
        plan = {'method': 'reuse', 'parameters': {}, 'output': {'description': 'same original'}}
        ready = {'ready': True, 'plan': plan, 'requirement': {'object_id': 'voice', 'id': 'current'},
                 'inputs': [selected], 'i2i_depth': 0}
        with patch.object(generation, 'readiness', return_value=ready), patch('review_desk.production_current.enabled', return_value=False):
            package = generation.package(self.store, 'voice')
        self.assertFalse({'model', 'prompt', 'randomization'} & package.keys())
        self.assertEqual(package['inputs'][0]['range'], selected['range'])
        self.assertEqual(package['inputs'][0]['asset'], selected['asset'])


if __name__ == '__main__':
    unittest.main()
