import copy
import unittest

import test_generation as fixtures
from test_methods import seed
from review_desk import generation as g, method_media as mm, methods, production as p
from review_desk.store import Conflict


class MediaMethodTest(unittest.TestCase):
    setUp = fixtures.GenerationTest.setUp
    tearDown = fixtures.GenerationTest.tearDown
    spec = fixtures.GenerationTest.spec
    put = fixtures.GenerationTest.put
    ref = fixtures.GenerationTest.ref
    entity = fixtures.GenerationTest.entity
    full = fixtures.GenerationTest.full
    need = fixtures.GenerationTest.need
    setup_plans = fixtures.GenerationTest.setup_plans
    decide = fixtures.GenerationTest.decide

    def test_supporting_inputs_freeze_exact_docs_and_validate_outer_references(self):
        import json
        self.setup_plans()
        seed(self.store, 'media-plan', ['draft', 'review', 'result'])
        old = p.record(self.store, 'need-full-overall')
        # Real originals can quote retired historical links. That document is
        # evidence, not a request to revive its transitive references.
        extra = self.store.put_object('support', 'NOTE', {'text': '原件比对', 'archive_text': json.dumps({'revision_id': 'retired'})})
        ref = self.ref('support')
        value = {'object_id': old['object_id'], 'payload': old['payload'], 'expected_version': old['version'],
                 'run_id': 'support-run', 'step_id': 'first', 'supporting_references': [ref],
                 'method_conditions': {'need_sound': True}}
        prepared = mm.prepare(self.store, value)
        inputs = prepared['request']['inputs']
        self.assertEqual(json.loads(inputs['supporting_records'][0]['content_json'])['text'], '原件比对')
        self.assertTrue(prepared['request']['conditions']['need_sound'])
        self.assertEqual(methods.prepare(self.store, prepared['request']), prepared['execution'])
        with self.assertRaisesRegex(ValueError, '媒体类型'):
            mm.prepare(self.store, {**value, 'method_conditions': {'media_type': 'video'}})
        with self.assertRaises((ValueError, KeyError)):
            mm.prepare(self.store, {**value, 'step_id': 'bad', 'supporting_references': [{'object_id':'missing','revision_id':'missing'}]})
        with self.assertRaises(ValueError):
            mm.prepare(self.store, {**value, 'step_id': 'too-many', 'supporting_references': [ref]*101})
        with self.assertRaises(Conflict):
            mm.prepare(self.store, {**value, 'supporting_references': []})

    def test_prepare_rejects_source_content_drift(self):
        import json
        from test_review import SOURCE
        self.store.put_source(SOURCE)
        source = self.store.db.execute("SELECT id,document FROM sources LIMIT 1").fetchone()
        reference = self.ref(source['id'])
        changed = json.loads(source['document']); changed['title'] += ' changed'
        self.store.db.execute('UPDATE sources SET document=? WHERE id=?', (json.dumps(changed), source['id']))
        with self.assertRaisesRegex(ValueError, '准确源资料已变化'):
            mm.inputs(self.store, {'source': reference})

    def test_cutover_uses_exact_frozen_plans_and_enforces_new_artifacts(self):
        self.setup_plans(); self.decide()
        seed(self.store, 'media-plan', ['draft', 'review', 'result'])
        activation = mm.activate(self.store)
        old = p.record(self.store, 'need-full-overall')
        package = g.package(self.store, old['object_id'])
        self.assertEqual(package['method_basis']['history'], 'unknown')
        self.assertNotIn('method_snapshot', package)
        changed = copy.deepcopy(old['payload'])
        changed['generation']['prompt'] = 'One clear page turn, then pause.'
        with self.assertRaisesRegex(ValueError, '缺少本步骤'):
            self.store.put_object(old['object_id'], old['kind'], changed, old['version'])
        prepared = mm.prepare(self.store, {'object_id': old['object_id'], 'payload': changed, 'expected_version': old['version'], 'run_id': 'author-run', 'step_id': 'page-turn'})
        request, execution = prepared['request'], prepared['execution']
        invalid = copy.deepcopy(changed); invalid['generation']['conditions'] = {'timing': 'needs listening'}
        with self.assertRaisesRegex(ValueError, '条件判断'):
            methods.artifact(self.store, {**request, 'execution': methods.reference(execution), 'stage': 'draft', 'output': mm.output(invalid)})
        with self.assertRaises(ValueError):
            methods.artifact(self.store, {**request, 'execution': methods.reference(execution), 'stage': 'result', 'output': mm.output(changed)})
        for stage in ('draft', 'review', 'result'):
            artifact = methods.artifact(self.store, {**request, 'execution': methods.reference(execution), 'stage': stage,
                                                   'output': {'assessment': 'Single action, exact source preserved.'} if stage == 'review' else mm.output(changed)})
        changed['method_basis'] = {'execution': methods.reference(execution), 'artifact': methods.reference(artifact), 'run_id': 'author-run', 'step_id': 'page-turn'}
        with self.assertRaises(ValueError):
            mm.verify(self.store, 'need-wet-overall', changed)
        forged = copy.deepcopy(changed); forged['generation']['prompt'] += ' Unreviewed addition.'
        with self.assertRaisesRegex(ValueError, '定稿'):
            mm.verify(self.store, old['object_id'], forged)
        self.put({'object_id': old['object_id'], 'kind': old['kind'], 'expected_version': old['version'], 'payload': changed})
        self.assertFalse(g.readiness(self.store, old['object_id'])['ready'])
        self.decide()
        package = g.package(self.store, old['object_id'])
        self.assertEqual(package['method_basis'], changed['method_basis'])
        self.assertEqual(package['method_snapshot']['package']['method'], execution['payload']['package']['method'])
        self.assertNotIn('SKILL', package['prompt'])
        call = self.spec('method-call', 'CALL', method='generation', status='submitted', tool='test', inputs=[], outputs=[],
                         generation_requirement=package['requirement'], generation_acceptances=package['acceptances'],
                         **{key: package[key] for key in ('model', 'parameters', 'prompt')})
        with self.assertRaisesRegex(Conflict, '方法依据'):
            self.put(call)
        call['payload']['method_basis'] = package['method_basis']
        self.put(call)
        self.assertEqual(mm.activate(self.store), activation)
        self.assertEqual(mm.verify(self.store, old['object_id'], old['payload'], old['id'])['history'], 'unknown')


class ActivatedReferenceTest(unittest.TestCase):
    from test_shot_references import ShotReferenceTest as Fixture
    for name in ('setUp', 'tearDown', 'spec', 'put', 'ref', 'entity', 'full', 'need', 'media', 'change', 'setup_plans', 'decide', 'generate', 'scene_shot', 'request', 'approve'):
        locals()[name] = getattr(Fixture, name)

    def prepare(self, complete=False):
        old = self.Fixture.prepare(self, complete)
        seed(self.store, 'media-plan', ['draft', 'review', 'result'])
        mm.activate(self.store)
        return old

    test_reference_selection = Fixture.test_draft_save_is_atomic_per_slot_idempotent_and_keeps_other_inputs
    test_reference_conflict = Fixture.test_another_connection_conflicts_without_partial_changes
    test_exact_call_reference_selection = Fixture.test_submitted_failed_unknown_are_locked_and_change_creates_new_plan
    test_clear_historic_range = Fixture.test_clearing_range_on_frozen_plan_does_not_restore_old_bounds
    test_reference_export_recovery = Fixture.test_export_restore_keeps_selection_receipt_and_exact_history

    def test_reference_receipt_cannot_author_a_prompt(self):
        from review_desk import shot_references as sr
        self.prepare(); sr.select(self.store, self.request())
        row = p.record(self.store, 'video')
        self.assertEqual(mm.verify(self.store, 'video', row['payload'])['history'], 'unknown')
        self.assertEqual(len(mm.verify(self.store, 'video', row['payload'])['adjustments']), 1)
        changed = copy.deepcopy(row['payload']); changed['generation']['prompt'] += 'Forged authorship.'
        with self.assertRaisesRegex(ValueError, '不能改写 Prompt'):
            self.store.put_object('video', 'REQUIREMENT', changed, row['version'])

    def test_withdrawal_preserves_authorship_and_cannot_rewrite_plan(self):
        old = self.prepare()
        changed = copy.deepcopy(old['payload'])
        changed.update(status='withdrawn', required=False, withdrawal_reason='不再用于当前制作')
        self.put({'object_id':'video','kind':'REQUIREMENT','expected_version':old['version'],'payload':changed})
        row = p.record(self.store,'video')
        self.assertEqual(mm.verify(self.store,'video',row['payload'])['history'],'unknown')
        self.assertEqual(row['payload']['method_adjustment']['operation'],'administrative')
        actual = {(d['to_revision'], d['role']) for d in self.store.db.execute(
            'SELECT to_revision,role FROM dependencies WHERE from_revision=?', (row['id'],))}
        expected = {(ref['revision_id'], path) for path, ref in p.references(row['payload'])}
        self.assertEqual(actual, expected)
        changed = copy.deepcopy(row['payload']); changed['generation']['prompt'] += 'Changed.'
        with self.assertRaisesRegex(ValueError,'不能改写方案'):
            mm.verify(self.store,'video',changed)

    def test_route_choice_remains_exact_without_claiming_new_authorship(self):
        from review_desk import material_relations as mr
        old = self.Fixture.prepare(self)
        payload = copy.deepcopy(old['payload'])
        payload['generation']['inputs'][0].update(necessity='optional', enabled=False)
        self.put({'object_id':'video','kind':'REQUIREMENT','expected_version':old['version'],'payload':payload})
        seed(self.store, 'media-plan', ['draft', 'review', 'result']); mm.activate(self.store)
        row = p.record(self.store, 'video')
        result = mr.choose_route(self.store, {'id':'option-choice','requirement_id':'video','expected_revision':row['id'],'action':'optional','key':0,'value':True})
        selected = p.record(self.store, 'video')
        self.assertEqual(selected['id'], result['revision_id'])
        self.assertEqual(mm.verify(self.store, 'video', selected['payload'])['history'], 'unknown')
        changed = copy.deepcopy(selected['payload']); changed['generation']['parameters']['seed'] = 123
        with self.assertRaisesRegex(ValueError, '不能改写 Prompt'):
            mm.verify(self.store, 'video', changed)


if __name__ == '__main__':
    unittest.main()
