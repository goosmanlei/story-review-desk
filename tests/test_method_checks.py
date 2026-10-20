import copy
import json
import tempfile
import unittest
from pathlib import Path

from review_desk import method_checks as checks, methods
from review_desk.production_current_methods import compact_output
from review_desk.store import Store, Conflict, canonical, now
from tests.test_methods import seed


class MethodChecksTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / '.runtime/review.sqlite3')
        self.addCleanup(self.store.close)
        seed(self.store, work_type='result-review')
        self.request = {'work_type': 'result-review', 'run_id': 'review', 'step_id': 'one',
                        'target': 'edit', 'inputs': {'context': 'Contextual playback, independently judged'}}
        self.execution = methods.prepare(self.store, self.request)
        self.project = {
            'format': 'episode-edit-v1', 'spec': {'fps': {'num': 24, 'den': 1},
                'sample_rate': 48000, 'width': 1280, 'height': 720, 'duration_frames': 144},
            'sources': [{'id': 's', 'candidate_id': 'original', 'video': {'fps': '24'},
                         'audio': {'sample_rate': 48000}}],
            'tracks': [{'id': 'picture', 'kind': 'video'}, {'id': 'sound', 'kind': 'audio'}],
            'clips': [{'id': f'v{i}', 'kind': 'video', 'track_id': 'picture',
                       'source_id': 's', 'source_in': i*48, 'source_out': (i+1)*48,
                       'timeline_start': i*48} for i in range(3)] + [
                      {'id': 'local-sound', 'kind': 'audio', 'track_id': 'sound', 'source_id': 's',
                       'source_in': 0, 'source_out': 12000, 'timeline_start': 180000}],
        }
        self.rev = self.store._insert_object('edit', 'EPISODE_EDIT', self.project)
        self.plan_rev = self.store._insert_object('plan', 'NOTE', {'end': 'pole on ground', 'note': 'unrelated'})

    def join(self, left, right, audio_scope='local'):
        return checks.capture(self.store, {'kind': 'edit-join',
            'reference': {'object_id': 'edit', 'revision_id': self.rev},
            'left': left, 'right': right, 'handles': 12, 'audio_scope': audio_scope})

    def item(self, cid, basis, **extra):
        return {'id': cid, 'basis': basis, 'level': 'edit', 'verdict': 'consistent',
                'observation': 'Continuous action inspected in context', 'observer': 'reviewer',
                'modality': 'dynamic_av', **extra}

    def coverage(self):
        return {'format': checks.FORMAT, 'coverage': ['a', 'b'],
                'items': [self.item('a', [self.join('v0', 'v1')]), self.item('b', [self.join('v1', 'v2')])]}

    def change(self, mutate):
        p = copy.deepcopy(self.project)
        mutate(p)
        # The fixture is deliberately not a playable project. Only store a
        # new ledger revision; source media preflight has its own integration tests.
        self.replace_fixture('edit', p)

    def replace_fixture(self, oid, payload):
        version = self.store.db.execute('SELECT version FROM objects WHERE id=?', (oid,)).fetchone()[0] + 1
        revision = methods.checksum({'object_id': oid, 'version': version, 'payload': payload})
        with self.store.db:
            self.store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)',
                                  (revision, oid, version, canonical(payload), now()))
            self.store.db.execute('UPDATE objects SET current_revision=?,version=? WHERE id=?',
                                  (revision, version, oid))

    def test_audio_and_remote_trim_only_invalidate_the_affected_join(self):
        value = self.coverage()
        self.change(lambda p: p['clips'][-1].update(gain_db=-4))
        self.assertEqual([r['state'] for r in checks.inspect(self.store, value)['coverage']], ['current', 'stale'])
        self.change(lambda p: p['clips'][2].update(source_in=97))
        self.assertEqual([r['state'] for r in checks.inspect(self.store, value)['coverage']], ['current', 'stale'])
        self.change(lambda p: p.update(markers=[{'id': 'note', 'text': 'Editorial note'}]))
        self.assertEqual(checks.inspect(self.store, value)['counts']['current'], 2)

    def test_candidate_order_and_in_out_changes_require_new_evidence(self):
        value = self.coverage()
        for mutate in (
            lambda p: p['sources'][0].update(candidate_id='replacement'),
            lambda p: p['clips'][1].update(timeline_start=110),
            lambda p: p['clips'][1].update(source_out=95),
        ):
            self.change(mutate)
            self.assertEqual(checks.inspect(self.store, value)['counts']['stale'], 2)
            with self.assertRaises(Conflict):
                checks.guard_new(self.store, value)

    def test_missing_inputs_and_unreviewed_coverage_cannot_be_passed(self):
        value = {'format': checks.FORMAT, 'coverage': ['missing', 'future'], 'items': [
            self.item('missing', [], verdict='blocked', missing=['right original candidate'],
                      next_action='Restore that exact original, then start a new review step')]}
        result = checks.inspect(self.store, value)
        self.assertEqual(result['counts'], {'current': 0, 'stale': 0, 'blocked': 1, 'unreviewed': 1})
        value['items'][0]['verdict'] = 'consistent'
        with self.assertRaises(ValueError):
            checks.validate(value)

    def test_final_mix_checks_include_distant_audio_normalization_inputs(self):
        value = {'format': checks.FORMAT, 'coverage': ['final-mix', 'local-source'], 'items': [
            self.item('final-mix', [checks.capture(self.store, {'kind': 'edit-join',
                'reference': {'object_id': 'edit', 'revision_id': self.rev},
                'left': 'v0', 'right': 'v1', 'handles': 12})]),
            self.item('local-source', [self.join('v0', 'v1')], modality='pre_mix_source')]}
        self.change(lambda p: p['clips'][-1].update(gain_db=-4))
        self.assertEqual([r['state'] for r in checks.inspect(self.store, value)['coverage']], ['stale', 'current'])
        self.change(lambda p: p['spec'].update(duration_frames=168))
        self.assertEqual([r['state'] for r in checks.inspect(self.store, value)['coverage']], ['stale', 'current'])

    def test_plan_fields_and_intentional_transition_keep_their_own_meaning(self):
        basis = checks.capture(self.store, {'kind': 'record', 'paths': ['/end'],
            'reference': {'object_id': 'plan', 'revision_id': self.plan_rev}})
        value = {'format': checks.FORMAT, 'coverage': ['planned'], 'items': [
            self.item('planned', [basis], level='plan', verdict='intentional',
                      modality='text', observation='A later scene deliberately starts after travel')]}
        self.replace_fixture('plan', {'end': 'pole on ground', 'note': 'changed note'})
        self.assertEqual(checks.inspect(self.store, value)['counts']['current'], 1)
        self.replace_fixture('plan', {'end': 'pole on shoulder'})
        self.assertEqual(checks.inspect(self.store, value)['counts']['stale'], 1)
        self.assertEqual(value['items'][0]['basis'][0]['value']['/end'], 'pole on ground')

    def test_artifact_readback_compaction_and_restore_preserve_history(self):
        value = self.coverage()
        output = {'assessment': 'A scoped review, not automatic acceptance', 'checks': value}
        compact = compact_output(output, 'edit', 'result')
        self.assertEqual(compact['checks'], value)
        request = {**self.request, 'execution': methods.reference(self.execution), 'stage': 'result', 'output': output}
        artifact = methods.artifact(self.store, request)
        self.change(lambda p: p['clips'][-1].update(gain_db=-4))
        self.assertEqual(methods.artifact(self.store, request), artifact)
        read = methods.stage_record(self.store, methods.reference(self.execution), 'result')
        self.assertEqual(read['checks']['counts']['stale'], 1)
        self.assertEqual(read['artifact']['payload']['output'], compact)
        self.assertEqual(len(checks.query(self.store, 'edit')['reviews']), 1)
        archive = methods.export_registry(self.store, executions=[self.execution['object_id']])
        restored = Store(Path(self.tmp.name) / 'empty/.runtime/review.sqlite3')
        self.addCleanup(restored.close)
        restored._insert_object('edit', 'EPISODE_EDIT', self.project)
        methods.restore_registry(restored, json.loads(json.dumps(archive)))
        recovered = methods.stage_record(restored, methods.reference(self.execution), 'result')
        self.assertEqual(recovered['artifact']['payload']['output'], compact)
        self.assertEqual(recovered['checks']['counts']['current'], 2)

    def test_stale_and_forged_basis_are_rejected_before_freezing(self):
        value = self.coverage()
        request = {**self.request, 'execution': methods.reference(self.execution), 'stage': 'result',
                   'output': {'checks': value}}
        self.change(lambda p: p['clips'][1].update(source_in=49))
        with self.assertRaises(Conflict):
            methods.artifact(self.store, request)
        self.assertIsNone(methods.stage_record(self.store, methods.reference(self.execution), 'result')['artifact'])
        value['items'][0]['basis'][0]['value'] = {}
        with self.assertRaises(ValueError):
            methods.artifact(self.store, request)

    def test_current_content_cannot_be_attributed_to_an_older_revision(self):
        value = self.coverage()
        self.change(lambda p: p['clips'][1].update(source_in=49))
        for item in value['items']:
            entry = item['basis'][0]
            entry['value'] = checks.selected(self.store, entry['selector'], current=True)
            entry['sha256'] = methods.checksum(entry['value'])
        self.assertEqual(checks.inspect(self.store, value)['counts']['current'], 2)
        with self.assertRaisesRegex(ValueError, '准确修订'):
            checks.guard_new(self.store, value)

    def test_changed_context_cannot_reuse_a_frozen_observation(self):
        value = self.coverage()
        entry = value['items'][0]['basis'][0]
        entry['selector']['handles'] = 13
        self.assertEqual(checks.inspect(self.store, value)['counts']['stale'], 1)
        with self.assertRaisesRegex(ValueError, '准确修订'):
            checks.guard_new(self.store, value)
        fresh = checks.capture(self.store, entry['selector'])
        self.assertEqual(fresh['value']['scope'],
                         {'kind': 'edit-join', 'handles': 13, 'audio_scope': 'local'})
        self.assertNotEqual(fresh['sha256'], entry['sha256'])

    def test_pointer_does_not_accept_python_negative_or_noncanonical_indices(self):
        value = {'items': ['first', 'last'], '-': 'literal object member', 'a/b': {'~': 1}}
        self.assertEqual(checks.pointer(value, '/items/0'), 'first')
        self.assertEqual(checks.pointer(value, '/-'), 'literal object member')
        self.assertEqual(checks.pointer(value, '/a~1b/~0'), 1)
        for path in ('/items/-1', '/items/01', '/items/-', '/items/١'):
            with self.assertRaises(ValueError):
                checks.pointer(value, path)

    def test_current_content_address_is_not_an_immutable_draft(self):
        from review_desk import production_current as current, production
        self.store.db.executescript(current.SCHEMA)
        self.store.db.execute('INSERT OR IGNORE INTO production_current_policy VALUES (1,?,?)',
                              (current.CONTRACT, 'test-checks'))
        def update(payload):
            old = self.store.db.execute('SELECT * FROM objects WHERE id=?', ('mutable-entity',)).fetchone()
            with self.store.db:
                current.write_record(self.store, 'mutable-entity', 'ENTITY', payload, old, [])
            return production.record(self.store, 'mutable-entity')
        first = update({'title': 'fixture', 'end': 'pole down', 'note': 'one'})
        selector = {'kind': 'record', 'reference': {'object_id': first['object_id'], 'revision_id': first['id']},
                    'paths': ['/end']}
        basis = checks.capture(self.store, selector)
        value = {'format': checks.FORMAT, 'coverage': ['state'], 'items': [
            self.item('state', [basis], level='plan')]}
        checks.guard_new(self.store, value)
        with self.assertRaisesRegex(ValueError, '历史稿'):
            checks.capture(self.store, {**selector, 'mode': 'exact'})
        second = update({'title': 'fixture', 'end': 'pole down', 'note': 'two'})
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(checks.inspect(self.store, value)['counts']['current'], 1)
        with self.assertRaisesRegex(Conflict, '正文已变化'):
            checks.guard_new(self.store, value)
        fresh = checks.capture(self.store, selector)
        self.assertNotEqual(fresh['selector']['content_guard'], basis['selector']['content_guard'])
        update({'title': 'fixture', 'end': 'pole raised', 'note': 'two'})
        self.assertEqual(checks.inspect(self.store, value)['counts']['stale'], 1)
        self.assertEqual(basis['value']['/end'], 'pole down')


if __name__ == '__main__':
    unittest.main()
