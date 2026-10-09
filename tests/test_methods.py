import copy
import json
import tempfile
import unittest
from pathlib import Path

from review_desk import methods
from review_desk.store import Store, Conflict


def seed(store, work_type='comment-polish', steps=None):
    resource = methods.save(store, {'category': 'resource', 'name': 'continuity', 'expected_version': 0,
                                   'payload': {'title': 'Continuity', 'files': {'references/main.md': 'Keep exact inputs; unknown stays unknown.'},
                                               'sections': {'main': 'references/main.md'}}})
    method = methods.save(store, {'category': 'skill', 'name': 'review', 'expected_version': 0,
                                 'payload': {'title': 'Review', 'purpose': 'Clarify the request', 'applies': 'Exact input available',
                                             'inputs': 'Current text', 'outputs': 'One comment', 'checks': 'No added facts',
                                             'work_types': [work_type], 'required_inputs': ['context'], 'steps': steps or ['result'],
                                             'files': {'SKILL.md': '---\nname: review\ndescription: Clarify a supplied review.\n---\nKeep the original meaning; return only the comment.'},
                                             'resources': [{**methods.reference(resource), 'section': 'main'}]}})
    binding = methods.save(store, {'category': 'binding', 'name': work_type, 'expected_version': 0,
                                  'payload': {'work_type': work_type, 'rules': [{**methods.reference(method), 'when': {}}]}})
    return resource, method, binding


class MethodsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / '.runtime/review.sqlite3')
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.resource, self.method, self.binding = seed(self.store, steps=['draft', 'review', 'result'])
        self.request = {'work_type': 'comment-polish', 'run_id': 'run-1', 'step_id': 'paragraph-1',
                        'target': 'source@revision-1', 'inputs': {'context': {'text': 'Original text', 'draft': 'Clarify it'}}}

    def test_snapshot_survives_method_update_and_new_work_uses_explicit_selection(self):
        old = methods.prepare(self.store, self.request)
        payload = copy.deepcopy(self.method['payload'])
        payload['files']['SKILL.md'] += '\nPreserve questions.'
        new = methods.save(self.store, {'category': 'skill', 'name': 'review', 'expected_version': 1, 'payload': payload})
        self.assertEqual(methods.prepare(self.store, self.request), old)
        self.assertEqual(methods.resolve(self.store, 'comment-polish')['version'], 1)
        methods.save(self.store, {'category': 'binding', 'name': 'comment-polish', 'expected_version': 1,
                                 'payload': {'work_type': 'comment-polish', 'rules': [{**methods.reference(new), 'when': {}}]}})
        self.assertEqual(methods.prepare(self.store, self.request), old)
        fresh = methods.prepare(self.store, {**self.request, 'step_id': 'paragraph-2'})
        self.assertEqual(fresh['payload']['package']['version'], 2)

    def test_conflict_does_not_overwrite_and_missing_chapter_is_rejected(self):
        payload = copy.deepcopy(self.method['payload'])
        payload['title'] = 'Other editor'
        methods.save(self.store, {'category': 'skill', 'name': 'review', 'expected_version': 1, 'payload': payload})
        with self.assertRaises(Conflict):
            methods.save(self.store, {'category': 'skill', 'name': 'review', 'expected_version': 1, 'payload': self.method['payload']})
        payload['resources'][0]['section'] = 'missing'
        with self.assertRaisesRegex(ValueError, '章节'):
            methods.save(self.store, {'category': 'skill', 'name': 'review', 'expected_version': 2, 'payload': payload})
        self.assertEqual(methods.read(self.store, self.method['object_id'])['payload']['title'], 'Other editor')

    def test_delivered_instructions_include_required_package_files(self):
        payload = copy.deepcopy(self.method['payload'])
        payload['files']['references/contract.md'] = 'Return the exact record shape.'
        method = methods.save(self.store, {'category': 'skill', 'name': 'review', 'expected_version': 1, 'payload': payload})
        binding = methods.save(self.store, {'category': 'binding', 'name': 'comment-polish', 'expected_version': 1,
            'payload': {'work_type': 'comment-polish', 'rules': [{**methods.reference(method), 'when': {}}]}})
        execution = methods.prepare(self.store, self.request)
        delivered = methods.instructions(execution['payload']['package'])
        self.assertIn(payload['files']['references/contract.md'], delivered)
        self.assertIn(self.resource['payload']['files']['references/main.md'], delivered)

    def test_resume_rejects_damaged_original_resource(self):
        methods.prepare(self.store, self.request)
        payload = copy.deepcopy(self.resource['payload'])
        payload['files']['references/main.md'] = 'A different text under a damaged original revision.'
        self.store.db.execute('UPDATE revisions SET payload=? WHERE id=?',
            (json.dumps(payload), self.resource['revision_id']))
        with self.assertRaisesRegex(ValueError, '恢复准确资源包'):
            methods.prepare(self.store, self.request)

    def test_wrong_target_run_work_or_inputs_cannot_reuse_receipt(self):
        execution = methods.prepare(self.store, self.request)
        identity = {k: self.request[k] for k in ('work_type', 'run_id', 'step_id', 'target')}
        for key in identity:
            with self.subTest(key=key), self.assertRaises(ValueError):
                methods.verify_execution(self.store, methods.reference(execution), {**identity, key: 'other'}, self.request['inputs'])
        with self.assertRaises(Conflict):
            methods.prepare(self.store, {**self.request, 'inputs': {'context': 'changed'}})
        with self.assertRaisesRegex(ValueError, '缺少必要输入'):
            methods.prepare(self.store, {**self.request, 'step_id': 'new', 'inputs': {}})

    def test_stages_are_ordered_immutable_and_generic_writer_cannot_forge(self):
        execution = methods.prepare(self.store, self.request)
        value = {**self.request, 'execution': methods.reference(execution), 'stage': 'result', 'output': 'Final'}
        with self.assertRaises(ValueError):
            methods.artifact(self.store, value)
        for stage in ['draft', 'review', 'result']:
            result = methods.artifact(self.store, {**value, 'stage': stage})
        self.assertEqual(methods.artifact(self.store, value), result)
        with self.assertRaises(ValueError):
            methods.artifact(self.store, {**value, 'output': 'Replaced'})
        with self.assertRaises(ValueError):
            self.store.put_object('forged', 'NOTE', execution['payload'])

    def test_condition_specificity_and_ambiguity(self):
        rules = [{**methods.reference(self.method), 'when': {'mode': 'video'}},
                 {**methods.reference(self.method), 'when': {'medium': 'video'}}]
        methods.save(self.store, {'category': 'binding', 'name': 'comment-polish', 'expected_version': 1,
                                 'payload': {'work_type': 'comment-polish', 'rules': rules}})
        with self.assertRaisesRegex(ValueError, '没有适用方法'):
            methods.resolve(self.store, 'comment-polish')
        with self.assertRaisesRegex(ValueError, '歧义'):
            methods.resolve(self.store, 'comment-polish', {'mode': 'video', 'medium': 'video'})
        self.assertEqual(methods.resolve(self.store, 'comment-polish', {'mode': 'video'})['method'], methods.reference(self.method))

    def test_schema_unchanged_and_bundle_preserves_history(self):
        from review_desk.bundle import export, restore
        before = list(self.store.db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"))
        execution = methods.prepare(self.store, self.request)
        folder = Path(self.tmp.name) / 'export'
        export(self.store, folder)
        restored = Store(Path(self.tmp.name) / 'restored/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        restore(restored, folder)
        self.assertEqual(methods.prepare(restored, self.request), execution)
        after = list(restored.db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"))
        self.assertEqual([tuple(r) for r in before], [tuple(r) for r in after])

    def test_private_work_is_portable_but_not_public(self):
        from review_desk.bundle import export
        request = {**self.request, 'private': True}
        execution = methods.prepare(self.store, request)
        for stage in ['draft', 'review', 'result']:
            methods.artifact(self.store, {**request, 'execution': methods.reference(execution), 'stage': stage, 'output': 'PRIVATE CANDIDATE'})
        folder = Path(self.tmp.name) / 'public'
        export(self.store, folder)
        self.assertNotIn('PRIVATE CANDIDATE', (folder / 'objects.json').read_text())
        archive = methods.export_registry(self.store, [execution['object_id']])
        restored = Store(Path(self.tmp.name) / 'private/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        result = methods.restore_registry(restored, archive)
        self.assertEqual(result['inserted'], 7)
        self.assertEqual(methods.prepare(restored, request), execution)
        self.assertEqual(methods.restore_registry(restored, archive)['inserted'], 0)
        with self.assertRaises(Conflict):
            methods.prepare(restored, self.request)

    def test_registry_conflict_rolls_back_and_markdown_has_one_writer(self):
        root = Path(self.tmp.name)
        (root / 'source.md').write_text('# Title\n<!-- section:one -->\nOriginal\n')
        spec = {'name': 'manual', 'title': 'Manual', 'expected_version': 0,
                'sections': {'one': {'path': 'source.md', 'section': 'one'}}}
        row = methods.sync_source(self.store, root, spec)
        with self.assertRaisesRegex(ValueError, 'Markdown'):
            methods.save(self.store, {'category': 'resource', 'name': 'manual', 'expected_version': 1, 'payload': row['payload']})
        self.assertEqual(methods.sync_source(self.store, root, spec), row)
        archive = methods.export_registry(self.store)
        restored = Store(root / 'other/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        methods.restore_registry(restored, archive)
        self.assertEqual(methods.read(restored, row['object_id']), row)
        payload = copy.deepcopy(self.method['payload']); payload['title'] = 'Updated'
        methods.save(restored, {'category': 'skill', 'name': 'review', 'expected_version': 1, 'payload': payload})
        with self.assertRaisesRegex(ValueError, '目标已更新'):
            methods.restore_registry(restored, archive)
        self.assertEqual(methods.read(restored, self.method['object_id'])['version'], 2)

    def test_restore_rejects_missing_lineage_even_with_recomputed_package_hash(self):
        execution = methods.prepare(self.store, self.request)
        archive = methods.export_registry(self.store, [execution['object_id']])
        next(r for r in archive['records'] if r['object_id'] == execution['object_id'])['dependencies'] = []
        archive['sha256'] = methods.checksum({k: v for k, v in archive.items() if k != 'sha256'})
        restored = Store(Path(self.tmp.name) / 'damaged/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        with self.assertRaisesRegex(ValueError, '步骤依赖'):
            methods.restore_registry(restored, archive)
        self.assertEqual(restored.db.execute('SELECT COUNT(*) FROM objects').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
