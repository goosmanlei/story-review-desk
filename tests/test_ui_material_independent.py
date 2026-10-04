"""Independent task-0009 regressions; no browser or production instance writes."""
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from review_desk import material_archives as archives
from review_desk import material_model as model
from review_desk import material_plans as plans
from review_desk import material_storage as storage
from review_desk import production
from review_desk.store import Conflict, Store, canonical


class IndependentMaterialContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / '.runtime/review.sqlite3')

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def need(self, name='need', **changes):
        payload = {
            'format': 'production-requirement-v1', 'title': name,
            'blocks': [{'id': 'purpose', 'text': '准确的共同素材要求'}],
            'scope': {'object_id': 'state', 'revision_id': 'state-r1'},
            'states': [], 'entities': [], 'slot': 'voice', 'required': True,
            'purpose': '复核同一声音', 'media_type': 'audio', 'usage': 'generation_input',
            'specification': {'minimum_sample_rate': 48000},
            'generation': {
                'format': 'generation-plan-v1', 'method': 'generate', 'model': 'independent-model',
                'parameters': {}, 'prompt': '保留同一音色，独立测试不调用生成。', 'inputs': [],
                'output': {'name': '声音', 'description': '单人近讲录音', 'review_criteria': ['声音身份一致']},
                'blockers': [],
            },
        }
        payload.update(changes)
        # Exercise the Store write entry directly, independently of HTTP/import wrappers.
        self.store.put_object(name, 'REQUIREMENT', payload)
        return production.record(self.store, name)

    def change(self, row, **changes):
        payload = copy.deepcopy(row['payload'])
        payload.update(changes)
        self.store.put_object(row['object_id'], row['kind'], payload, expected_version=row['version'])
        return production.record(self.store, row['object_id'])

    def failed_call(self, need, name='call', binding='generation_requirement', status='failed'):
        generation = need['payload']['generation']
        self.store.put_object(name, 'CALL', {
            'format': 'production-call-v1', 'title': name,
            'blocks': [{'id': 'call', 'text': '真实失败调用的隔离技术夹具'}],
            'method': 'generation', 'tool': 'independent-fixture', 'status': status,
            'model': generation['model'], 'parameters': copy.deepcopy(generation['parameters']),
            'prompt': generation['prompt'], 'inputs': [], 'outputs': [],
            binding: {'object_id': need['object_id'], 'revision_id': need['id']},
        })
        return production.record(self.store, name)

    def test_complete_definition_changes_create_new_version_after_failure(self):
        changes = [
            ('purpose', lambda p: p.update(purpose='不同用途')),
            ('blocks', lambda p: p['blocks'][0].update(text='不同素材要求')),
            ('specification', lambda p: p['specification'].update(minimum_sample_rate=96000)),
            ('output', lambda p: p['generation']['output'].update(description='不同输出')),
            ('checks', lambda p: p['generation']['output']['review_criteria'].append('新增检查')),
            ('model', lambda p: p['generation'].update(model='other-model')),
        ]
        for index, (name, mutate) in enumerate(changes):
            with self.subTest(field=name):
                need = self.need('need-' + str(index))
                self.failed_call(need, 'call-' + str(index))
                before = plans.snapshot(self.store, need['object_id'])
                self.assertTrue(before[0]['frozen'])
                payload = copy.deepcopy(need['payload'])
                mutate(payload)
                changed = self.change(need, **payload)
                after = plans.snapshot(self.store, need['object_id'])
                self.assertEqual(len(after), len(before) + 1)
                self.assertFalse(after[0]['results'])
                self.assertNotEqual(after[0]['definition_id'], after[1]['definition_id'])
                self.assertEqual(production.record(self.store, revision_id=need['id'])['payload'], need['payload'])
                self.assertEqual(changed['version'], need['version'] + 1)

    def test_unknown_call_also_locks_and_title_changes_do_not_create_version(self):
        need = self.need()
        call = self.failed_call(need, status='unknown')
        self.assertTrue(plans.snapshot(self.store, 'need')[0]['frozen'])
        self.change(need, title='仅变显示名称')
        self.assertEqual(len(plans.snapshot(self.store, 'need')), 1)
        with self.assertRaises(Conflict):
            self.change(call, prompt='试图改写已提交内容')

    def test_executed_call_cannot_rebind_prepared_requirement(self):
        first = self.need('first')
        second = self.need('second', purpose='实质不同要求')
        call = self.failed_call(first, binding='prepared_plan')
        with self.assertRaises(Conflict):
            self.change(call, prepared_plan={'object_id': second['object_id'], 'revision_id': second['id']})

    def test_shared_alias_detaches_after_material_requirement_changes(self):
        source = self.need('source')
        generation = copy.deepcopy(source['payload']['generation'])
        generation.update(method='reuse', inputs=[{'reference': {'object_id': source['object_id'], 'revision_id': source['id']}, 'use': '明确共享'}])
        alias = self.need('alias', generation=generation, scope={'object_id': 'other-state', 'revision_id': 'other-state-r1'})
        rows = model.prove_aliases(self.store)
        self.assertEqual([(r['alias_id'], r['material_id']) for r in rows], [('alias', 'source')])
        with self.store.db:
            for row in rows:
                self.store.db.execute('INSERT OR REPLACE INTO material_aliases VALUES (?,?,?)', (row['alias_id'], row['material_id'], row['evidence']))
        self.assertEqual(storage.canonical_id(self.store, 'alias'), 'source')
        self.change(alias, specification={'minimum_sample_rate': 96000})
        self.assertEqual(storage.canonical_id(self.store, 'alias'), 'alias')
        self.assertEqual(production.record(self.store, revision_id=alias['id'])['payload'], alias['payload'])

    def test_physical_prompt_is_one_leaf_across_revisions_definitions_and_archives(self):
        need = self.need()
        self.failed_call(need)
        prompt = need['payload']['generation']['prompt']
        self.change(need, title='重命名')
        archive = ('{ "request": ' + json.dumps(prompt, ensure_ascii=True) + ', "receipt": ' + json.dumps(prompt, ensure_ascii=False) + ' }\r\n').encode()
        packed = archives.encode(self.store, archive)
        self.assertEqual(archives.decode(packed, lambda key: storage.expand(self.store, key)), archive)
        prompt_rows = [r for r in self.store.db.execute('SELECT body FROM material_content') if json.loads(r[0]).get('value') == prompt]
        self.assertEqual(len(prompt_rows), 1)
        for row in storage.physical_revisions(self.store):
            self.assertNotIn(prompt, row['payload'])
            self.assertIn('_material_fields', json.loads(row['payload']))

    def test_archive_restores_exact_whitespace_unicode_escapes_numbers_and_duplicate_keys(self):
        raw = '{\r\n "x":1.0,"x":1e-07, "voice":"李寄", "escaped":"\\u674e\\u5bc4", "slash":"a\\/b", "emoji":"\\ud83e\\uddf5"\r\n}\n'.encode()
        packed = archives.encode(self.store, raw)
        self.assertEqual(archives.decode(packed, lambda key: storage.expand(self.store, key)), raw)

    def test_noncanonical_revision_layout_restores_original_bytes(self):
        payload = self.need()['payload']
        original = json.dumps(payload, ensure_ascii=True, indent=2) + '\r\n'
        encoded = storage.encode(self.store, payload, raw=original)
        self.assertEqual(storage.hydrate(self.store, encoded), original)

    def test_wrong_material_comment_membership_rolls_back_atomically(self):
        first = self.need('first')
        self.need('second', purpose='另一个独立要求')
        before = (len(self.store.comments()), len(self.store.events()), plans.dump(self.store))
        with self.assertRaises(Conflict):
            self.store.create_comment({
                'id': 'wrong-membership', 'target_object_id': first['object_id'], 'target_revision_id': first['id'],
                'anchor': {'type': 'global'}, 'body': '不能挂到另一素材',
                'material_context': {'material_id': 'second', 'number': 1, 'model': 'plan-v1'},
            })
        self.assertEqual((len(self.store.comments()), len(self.store.events()), plans.dump(self.store)), before)

    def test_verify_rejects_alias_mapping_to_an_unrelated_material(self):
        source = self.need('source')
        self.need('unrelated', purpose='不能误合并的另一需求')
        generation = copy.deepcopy(source['payload']['generation'])
        generation.update(method='reuse', inputs=[{'reference': {'object_id': source['object_id'], 'revision_id': source['id']}, 'use': '明确共享'}])
        self.need('alias', generation=generation)
        rows = model.prove_aliases(self.store)
        with self.store.db:
            for row in rows:
                self.store.db.execute('INSERT OR REPLACE INTO material_aliases VALUES (?,?,?)', (row['alias_id'], row['material_id'], row['evidence']))
        with self.assertRaises((ValueError, sqlite3.IntegrityError)):
            with self.store.db:
                self.store.db.execute("UPDATE material_aliases SET material_id='unrelated' WHERE alias_id='alias'")
            model.verify(self.store)

    def test_verify_rejects_frozen_version_bound_to_another_complete_definition(self):
        first = self.need('first')
        self.failed_call(first)
        self.need('second', purpose='实质不同完整定义')
        other = self.store.db.execute("SELECT definition_id FROM material_definition_versions WHERE material_id='second' AND number=1").fetchone()[0]
        with self.assertRaises((ValueError, sqlite3.IntegrityError)):
            with self.store.db:
                self.store.db.execute("UPDATE material_definition_versions SET definition_id=? WHERE material_id='first' AND number=1", (other,))
            model.verify(self.store)

    def test_verify_rejects_frozen_version_missing_its_complete_definition(self):
        need = self.need()
        self.failed_call(need)
        with self.assertRaises((ValueError, sqlite3.IntegrityError)):
            with self.store.db:
                self.store.db.execute("DELETE FROM material_definition_versions WHERE material_id='need' AND number=1")
            model.verify(self.store)

    def test_prepared_plan_only_failure_and_unknown_lock_before_any_result_exists(self):
        for index, status in enumerate(('failed', 'unknown')):
            with self.subTest(status=status):
                need = self.need('prepared-only-' + str(index))
                call = self.failed_call(need, 'prepared-call-' + str(index), binding='prepared_plan', status=status)
                before = plans.snapshot(self.store, need['object_id'])
                frozen = [r for r in before if r['frozen'] and any(m['id'] == call['id'] for m in r['members'])]
                self.assertEqual(len(frozen), 1)
                self.assertFalse(frozen[0]['results'])
                self.change(need, purpose='首次提交后要求实质变化')
                after = plans.snapshot(self.store, need['object_id'])
                self.assertEqual(len(after), len(before) + 1)
                self.assertEqual(after[1]['definition_id'], frozen[0]['definition_id'])

    def test_definition_provenance_comment_membership_is_exact_and_does_not_expand_reuse_chain(self):
        source = self.need('canonical')
        generation = copy.deepcopy(source['payload']['generation'])
        generation.update(method='reuse', inputs=[{'reference': {'object_id': source['object_id'], 'revision_id': source['id']}, 'use': '明确共享'}])
        bridge = self.need('bridge', generation=generation)
        through_bridge = copy.deepcopy(generation)
        through_bridge['inputs'][0]['reference'] = {'object_id': bridge['object_id'], 'revision_id': bridge['id']}
        alias = self.need('alias', generation=through_bridge)
        call = self.failed_call(alias)
        version = next(r for r in plans.snapshot(self.store, 'alias') if any(m['id'] == call['id'] for m in r['members']))
        self.assertNotIn(source['id'], [m['id'] for m in version['members']])
        self.assertTrue(plans.belongs(self.store, source['id'], 'alias', version['number']))
        self.assertFalse(plans.belongs(self.store, bridge['id'], 'alias', version['number']))
        self.assertFalse(plans.belongs(self.store, source['id'], 'alias', version['number'] + 1))
        changed = self.change(source, purpose='下一份真实不同要求')
        self.assertFalse(plans.belongs(self.store, changed['id'], 'alias', version['number']))
        self.assertTrue(plans.belongs(self.store, source['id'], 'alias', version['number']))
        count = len(plans.snapshot(self.store, 'alias'))
        self.store.create_comment({
            'id': 'exact-source-comment', 'target_object_id': source['object_id'], 'target_revision_id': source['id'],
            'anchor': {'type': 'global'}, 'body': '评论旧版本定义的准确来源',
            'material_context': {'material_id': 'alias', 'number': version['number'], 'model': 'plan-v1'},
        })
        self.assertEqual(len(plans.snapshot(self.store, 'alias')), count)
        with self.assertRaises(Conflict):
            self.store.create_comment({
                'id': 'new-source-wrong-comment', 'target_object_id': changed['object_id'], 'target_revision_id': changed['id'],
                'anchor': {'type': 'global'}, 'body': '新来源不能挂旧版本',
                'material_context': {'material_id': 'alias', 'number': version['number'], 'model': 'plan-v1'},
            })

    def test_nested_json_archive_payload_shares_prompt_leaf_without_retaining_full_payload_text(self):
        need = self.need()
        original = json.dumps(need['payload'], ensure_ascii=False, indent=2)
        raw = json.dumps({'revisions': [{'payload': original}], 'request': need['payload']['generation']}, ensure_ascii=True, indent=2).encode() + b'\r\n'
        packed = archives.encode(self.store, raw)
        self.assertEqual(archives.decode(packed, lambda key: storage.expand(self.store, key)), raw)
        values = [json.loads(r[0]).get('value') for r in self.store.db.execute('SELECT body FROM material_content')]
        self.assertEqual(sum(v == need['payload']['generation']['prompt'] for v in values), 1)
        self.assertNotIn(original, values)

    def test_two_incomplete_historical_calls_are_not_evidence_of_the_same_scheme(self):
        need = self.need()
        versions = []
        for name in ('missing-call-a', 'missing-call-b'):
            self.store.put_object(name, 'CALL', {
                'format': 'production-call-v1', 'title': name,
                'blocks': [{'id': 'call', 'text': '保留缺失制作定义的历史调用'}],
                'method': 'generation', 'tool': 'legacy', 'status': 'unknown', 'model': 'unknown',
                'parameters': {}, 'inputs': [], 'outputs': [],
                'generation_requirement': {'object_id': need['object_id'], 'revision_id': need['id']},
            })
            call = production.record(self.store, name)
            versions.append(plans.memberships(self.store, call['id'])[0]['number'])
        self.assertNotEqual(versions[0], versions[1])

    def test_unknown_result_with_a_complete_scheme_still_retries_in_the_same_version(self):
        need = self.need()
        first = self.failed_call(need, 'complete-a', status='unknown')
        second = self.failed_call(need, 'complete-b', status='unknown')
        a = plans.memberships(self.store, first['id'])[0]['number']
        b = plans.memberships(self.store, second['id'])[0]['number']
        self.assertEqual(a, b)
        self.assertTrue(plans.snapshot(self.store, 'need')[0]['frozen'])

    def test_same_definition_retry_preserves_locked_provenance_and_old_source_comment(self):
        source = self.need('canonical')
        generation = copy.deepcopy(source['payload']['generation'])
        generation.update(method='reuse', inputs=[{'reference': {'object_id': source['object_id'], 'revision_id': source['id']}, 'use': '同一素材要求'}])
        alias = self.need('alias', generation=generation)
        first = self.failed_call(alias, 'first')
        number = plans.memberships(self.store, first['id'])[0]['number']
        before = model.projection(self.store, 'alias', number)
        self.store.create_comment({
            'id': 'locked-source', 'target_object_id': source['object_id'], 'target_revision_id': source['id'],
            'anchor': {'type': 'global'}, 'body': '锁定来源上的旧意见',
            'material_context': {'material_id': 'alias', 'number': number, 'model': 'plan-v1'},
        })
        renamed = self.change(source, title='仅改显示标题')
        generation['inputs'][0]['reference']['revision_id'] = renamed['id']
        alias = self.change(alias, generation=generation)
        retry = self.failed_call(alias, 'retry')
        self.assertEqual(plans.memberships(self.store, retry['id'])[0]['number'], number)
        self.assertEqual(model.projection(self.store, 'alias', number)['definition_provenance'], before['definition_provenance'])
        self.assertTrue(plans.belongs(self.store, source['id'], 'alias', number))
        plans.validate(self.store)

    def test_archive_scope_reads_its_uncommitted_writer_without_borrowing_other_instances(self):
        self.store.db.commit()
        self.store.db.execute('BEGIN EXCLUSIVE')
        raw = b'{"prompt":"uncommitted transaction-local fixture"}\r\n'
        container = archives.encode(self.store, raw)
        path = self.root / 'export/assets/transaction.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(container))
        blocked = sqlite3.connect(self.store.db_path, timeout=0)
        try:
            with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                blocked.execute('SELECT COUNT(*) FROM material_content').fetchone()
            with tempfile.TemporaryDirectory() as other_dir, tempfile.TemporaryDirectory() as unknown_dir:
                other_root = Path(other_dir)
                other = Store(other_root / '.runtime/review.sqlite3')
                try:
                    other_path = other_root / 'export/assets/transaction.json'
                    other_path.parent.mkdir(parents=True)
                    other_path.write_text(json.dumps(container))
                    unknown_path = Path(unknown_dir) / 'transaction.json'
                    unknown_path.write_text(json.dumps(container))
                    with archives.read_scope(self.store):
                        self.assertEqual(archives.read_bytes(path), raw)
                        with self.assertRaisesRegex(ValueError, 'content graph is missing|missing archive content'):
                            archives.read_bytes(other_path)
                        with self.assertRaisesRegex(ValueError, 'outside a known instance'):
                            archives.read_bytes(unknown_path)
                        self.assertEqual(archives.read_bytes(path), raw)
                        self.assertTrue(self.store.db.in_transaction)
                        self.assertEqual(self.store.db.execute('SELECT 1').fetchone()[0], 1)
                finally:
                    other.close()
        finally:
            blocked.close()
            self.store.db.rollback()

    def test_archive_scope_exception_rolls_back_and_does_not_reuse_cached_uncommitted_nodes(self):
        before = self.store.db.execute('SELECT COUNT(*) FROM material_content').fetchone()[0]
        path = self.root / 'export/assets/rolled-back.json'
        path.parent.mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, 'abort independent fixture'):
            with archives.read_scope(self.store), self.store.db:
                raw = b'{"prompt":"must disappear after rollback"}'
                path.write_text(json.dumps(archives.encode(self.store, raw)))
                self.assertEqual(archives.read_bytes(path), raw)
                raise RuntimeError('abort independent fixture')
        self.assertFalse(self.store.db.in_transaction)
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM material_content').fetchone()[0], before)
        with self.assertRaisesRegex(ValueError, 'content graph is missing|missing archive content'):
            archives.read_bytes(path)
        with archives.read_scope(self.store):
            with self.assertRaisesRegex(ValueError, 'missing or corrupt material content'):
                archives.read_bytes(path)
        self.assertEqual(self.store.db.execute('SELECT 1').fetchone()[0], 1)

    def test_nested_archive_scopes_restore_outer_instance_after_inner_exception(self):
        def archive_file(store, root, label):
            raw = json.dumps({'prompt': label}).encode()
            path = root / 'export/assets/nested.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(archives.encode(store, raw)))
            store.db.commit()
            return path, raw
        outer_path, outer_raw = archive_file(self.store, self.root, 'outer instance')
        with tempfile.TemporaryDirectory() as other_dir:
            other_root = Path(other_dir)
            other = Store(other_root / '.runtime/review.sqlite3')
            try:
                inner_path, inner_raw = archive_file(other, other_root, 'inner instance')
                self.store.db.execute('BEGIN EXCLUSIVE')
                with archives.read_scope(self.store):
                    self.assertEqual(archives.read_bytes(outer_path), outer_raw)
                    with self.assertRaisesRegex(RuntimeError, 'inner scope failure'):
                        with archives.read_scope(other):
                            self.assertEqual(archives.read_bytes(inner_path), inner_raw)
                            raise RuntimeError('inner scope failure')
                    # The outer connection is still the only reader that can
                    # read its exclusively locked DB after the inner scope exits.
                    self.assertEqual(archives.read_bytes(outer_path), outer_raw)
                    self.assertEqual(self.store.db.execute('SELECT 1').fetchone()[0], 1)
            finally:
                self.store.db.rollback()
                other.close()


if __name__ == '__main__':
    unittest.main()
