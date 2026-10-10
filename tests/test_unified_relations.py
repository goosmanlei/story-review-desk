import copy
import json
import shutil
import unittest

import test_generation as fixtures
from review_desk import business_relations as relations, production as p
from review_desk.bundle import export, restore
from review_desk.store import Conflict, Store


class UnifiedRelationsTest(unittest.TestCase):
    setUp = fixtures.GenerationTest.setUp
    tearDown = fixtures.GenerationTest.tearDown
    spec = fixtures.GenerationTest.spec
    put = fixtures.GenerationTest.put
    ref = fixtures.GenerationTest.ref
    entity = fixtures.GenerationTest.entity
    full = fixtures.GenerationTest.full
    need = fixtures.GenerationTest.need
    setup_plans = fixtures.GenerationTest.setup_plans
    media = fixtures.GenerationTest.media

    def relation(self, ends, direction='related', **values):
        return self.spec(relations.identity(ends), 'RELATION', relation_type='business',
                         endpoints=ends, direction=direction, summary='共同完成当前作品。',
                         sources=[self.source], contexts=[], **values)

    def test_pair_identity_direction_reverse_revision_and_recreation(self):
        self.setup_plans()
        ends = ['songbook', 'need-full-overall']
        first = self.relation(ends, 'forward')
        self.put(first)
        oid = first['object_id']
        initial = p.record(self.store, oid)
        code = relations.code(self.store, initial)
        self.assertEqual(relations.resolve_code(self.store, code)['object_id'], oid)
        a, b = initial['payload']['endpoints']
        from review_desk.business_codes import code as render, visible_codes
        codes = {r['object_id']: render(r) for r in visible_codes(self.store)}
        for value in ('R-'+codes[a]+'-'+codes[b], 'R-'+codes[b]+'->'+codes[a], 'R-'+codes[a]+'<-'+codes[b]):
            self.assertEqual(relations.resolve_code(self.store, value)['object_id'], oid)
        for status, direction in [('withdrawn', 'related'), ('active', 'reverse'), ('active', 'forward')]:
            row = self.relation(list(reversed(ends)), direction, status=status)
            row['expected_version'] = p.record(self.store, oid)['version']
            self.put(row)
            self.assertEqual(len(relations.current(self.store)), 1)
        with self.assertRaises(Conflict):
            self.put(first)
        self.assertEqual(p.record(self.store, oid, initial['id'])['payload'], initial['payload'])

    def test_missing_self_and_foreign_identity_rejected_atomically(self):
        self.setup_plans()
        with self.assertRaises(ValueError):
            self.relation(['songbook', 'songbook'])
        for ends in (['songbook', 'missing'], ['full', 'need-full-overall']):
            row = self.relation(ends)
            if 'missing' not in ends:
                row['object_id'] = 'different-identity'
            with self.assertRaises(ValueError):
                self.put(row)
        self.assertEqual(relations.current(self.store), [])

    def test_plan_choices_are_independent_of_graph_direction(self):
        self.setup_plans()
        record = self.relation(['need-full-overall', 'need-wet-overall'])
        self.put(record)
        from review_desk.material_relations import active_inputs
        item = {'reference': self.ref('need-full-overall'), 'relation': self.ref(record['object_id']),
                'use': '声音身份', 'semantics': 'reference', 'necessity': 'optional', 'enabled': False}
        plan = {'inputs': [item]}
        self.assertEqual(active_inputs(self.store, plan, 'need-wet-overall'), ([], []))
        item['enabled'] = True
        self.assertEqual(active_inputs(self.store, plan, 'need-wet-overall')[0], [(0, item)])
        item['necessity'] = 'one_of'; item['group'] = 'voice'; item['route'] = 'a'
        self.assertIn('请选择执行路线：voice', active_inputs(self.store, plan, 'need-wet-overall')[1])
        plan['selected_routes'] = {'voice': 'a'}
        self.assertEqual(len(active_inputs(self.store, plan, 'need-wet-overall')[0]), 1)
        item['reference'] = self.ref('songbook')
        with self.assertRaises(ValueError):
            active_inputs(self.store, plan, 'need-wet-overall')

    def test_exact_summary_never_follows_current_head(self):
        self.setup_plans()
        record = self.relation(['need-full-overall', 'need-wet-overall']); self.put(record)
        item = {'reference': self.ref('need-full-overall'), 'relation': self.ref(record['object_id'])}
        original = relations.input_context(self.store, 'need-wet-overall', item)
        revised = copy.deepcopy(record); revised['expected_version'] = 1
        revised['payload']['summary'] = '另一阶段的当前说明。'; self.put(revised)
        actual = relations.input_context(self.store, 'need-wet-overall', item)
        self.assertEqual(actual['record']['id'], original['record']['id'])
        self.assertEqual(actual['record']['payload'], original['record']['payload'])
        self.assertEqual(actual['summary'], original['summary'])

    def test_two_connections_cannot_recreate_the_reverse_pair(self):
        self.setup_plans()
        first = self.relation(['songbook', 'full'])
        second = self.relation(['full', 'songbook'])
        other = Store(self.store.db_path)
        try:
            self.put(first)
            with self.assertRaises(Conflict):
                p.import_records(other, {'format': 'production-import-v1', 'records': [second]})
            self.assertEqual(len(relations.current(other)), 1)
        finally:
            other.close()

    def test_method_reading_freezes_full_relation_and_scope_without_uploading(self):
        from review_desk import method_media as mm, methods
        from test_methods import seed
        self.setup_plans(); seed(self.store, 'media-plan', ['draft', 'review', 'result'])
        record = self.relation(['need-full-overall', 'full']); self.put(record)
        need = p.record(self.store, 'need-full-overall')
        prepared = mm.prepare(self.store, {'object_id': need['object_id'], 'payload': need['payload'],
                              'expected_version': need['version'], 'run_id': 'relationship-read', 'step_id': 'first'})
        frozen = prepared['request']['inputs']
        self.assertEqual(frozen['generation_inputs'], [])
        self.assertEqual(frozen['contextual_relations'][0]['payload'], p.record(self.store, record['object_id'])['payload'])
        revised = copy.deepcopy(record); revised['expected_version'] = 1
        revised['payload']['summary'] = '下一阶段。'; self.put(revised)
        actual = mm.inputs(self.store, need['payload'], self.ref(need['object_id']),
                           relation_contexts=frozen['contextual_relation_references'])
        self.assertEqual(actual, frozen)
        self.assertEqual(methods.prepare(self.store, prepared['request']), prepared['execution'])

    def test_entity_media_context_retains_call_relationship_revision(self):
        from review_desk import material_review
        self.setup_plans(); self.media()
        rel = self.relation(['voice', 'need-full-overall']); self.put(rel)
        need = p.record(self.store, 'need-full-overall')
        payload = copy.deepcopy(need['payload'])
        selected = {'reference': self.ref('voice'), 'component_id': 'original',
                    'range': {'start_seconds': 0, 'end_seconds': .5}, 'use': '身份',
                    'relation': self.ref(rel['object_id']), 'semantics': 'reference', 'necessity': 'required'}
        payload['generation']['inputs'] = [selected]
        self.put({'object_id': need['object_id'], 'kind': 'REQUIREMENT', 'expected_version': need['version'], 'payload': payload})
        call = self.spec('draft-call', 'CALL', method='generation', tool='test', status='planned',
                         inputs=[{**selected['reference'], 'component_id': 'original', 'range': selected['range']}],
                         outputs=[], generation_requirement=self.ref(need['object_id']))
        self.put(call)
        original = p.record(self.store, 'voice')
        inspected = copy.deepcopy(original)
        inspected['payload']['production'] = self.ref('draft-call')
        revised = copy.deepcopy(rel); revised['expected_version'] = 1
        revised['payload']['summary'] = '下一版的说明不能覆盖旧调用。'; self.put(revised)
        view = material_review.context(self.store, inspected)
        actual = view['call']['review_shot_slots'][0]['relation_context']
        self.assertEqual(actual['summary'], '共同完成当前作品。')
        self.assertEqual(actual['record']['version'], 1)

    def test_restore_refuses_missing_identity_index(self):
        self.setup_plans(); self.put(self.relation(['songbook', 'full']))
        self.store.db.execute('DELETE FROM business_relations'); self.store.db.commit()
        with self.assertRaisesRegex(ValueError, '索引'):
            relations.restore(self.store, {table: [] for table in relations.TABLES})

    def test_migration_archives_aliases_preserves_comments_and_roundtrips(self):
        self.setup_plans(); self.put(self.entity('owner'))
        old = []
        for oid in ('legacy-one', 'legacy-two'):
            value = self.spec(oid, 'RELATION', relation_type='entity', entities=[self.ref('owner'), self.ref('songbook')],
                              label='使用歌本', direction='forward', category='use', basis='script', sources=[self.source], applies_to=[])
            self.put(value); old.append(p.record(self.store, oid))
        comment = self.store.create_comment({'target_object_id': old[0]['object_id'], 'target_revision_id': old[0]['id'],
                                            'anchor': {'type': 'global'}, 'body': '原关系意见'})
        unified = self.relation(['owner', 'songbook'])
        plan = {'format': 'unified-relations-migration-v1', 'expected_heads': {r['object_id']: r['id'] for r in old},
                'aliases': {r['object_id']: unified['object_id'] for r in old}, 'records': [unified]}
        broken = copy.deepcopy(plan); broken['expected_heads']['legacy-one'] = 'stale'
        with self.assertRaises(Conflict):
            relations.apply_migration(self.store, broken)
        self.assertEqual(relations.current(self.store), [])
        result = relations.apply_migration(self.store, plan)
        self.assertEqual(result['merged_duplicates'], 1)
        self.assertTrue(relations.apply_migration(self.store, plan)['already_applied'])
        for row in old:
            self.assertEqual(p.record(self.store, row['object_id'], row['id']), row)
        self.assertEqual(len([r for r in p.current_records(self.store, {'RELATION'})]), 1)
        new_legacy = self.spec('legacy-new', 'RELATION', **{k:v for k,v in old[0]['payload'].items() if k not in ('format','title','blocks')})
        with self.assertRaises(ValueError):
            self.put(new_legacy)
        export(self.store, self.root/'export')
        self.assertEqual(json.loads((self.root/'export/manifest.json').read_text())['schema_version'], 12)
        dest = self.root/'restored'; shutil.copytree(self.root/'export', dest/'export')
        restored = Store(dest/'.runtime/review.sqlite3')
        try:
            restore(restored, dest/'export')
            self.assertEqual(relations.dump(restored), relations.dump(self.store))
            self.assertEqual(restored.comments(), self.store.comments())
            value = copy.deepcopy(unified); value['expected_version'] = 1; value['payload']['summary'] = '恢复后继续修订。'
            p.import_records(restored, {'format': 'production-import-v1', 'records': [value]})
            self.assertEqual(len(relations.current(restored)), 1)
        finally:
            restored.close()


if __name__ == '__main__':
    unittest.main()
