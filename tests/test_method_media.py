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


if __name__ == '__main__':
    unittest.main()
