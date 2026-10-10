import unittest
import test_generation as fixtures
from review_desk import generation as g, production as p
from review_desk.production_description import description


class ProductionDescriptionTest(unittest.TestCase):
    setUp = fixtures.GenerationTest.setUp
    tearDown = fixtures.GenerationTest.tearDown
    spec = fixtures.GenerationTest.spec
    put = fixtures.GenerationTest.put
    ref = fixtures.GenerationTest.ref
    entity = fixtures.GenerationTest.entity
    full = fixtures.GenerationTest.full
    need = fixtures.GenerationTest.need
    change = fixtures.GenerationTest.change
    setup_plans = fixtures.GenerationTest.setup_plans

    def test_legacy_description_and_dimensions_do_not_require_duplicate_field(self):
        self.setup_plans()
        for oid in ('songbook', 'full', 'wet'):
            row = p.record(self.store, oid); value = row['payload'].copy()
            text = value.pop('production_description')
            if oid == 'songbook': value['blocks'] = [{'id': 'description', 'text': text}]
            self.put({'object_id': oid, 'kind': row['kind'], 'expected_version': row['version'], 'payload': value})
        # Rebind requirements to the changed, complete states. Description
        # resolution itself must not transfer acceptance or candidate choices.
        for oid in ('full', 'wet'):
            self.change('need-'+oid+'-overall', scope=self.ref(oid), states=[self.ref(oid)])
            self.change(oid, entity=self.ref('songbook'))
            self.change('need-'+oid+'-overall', scope=self.ref(oid), states=[self.ref(oid)])
        self.assertTrue(g.preparation(self.store, g.current_scope(self.store, 'songbook'))['complete'])
        self.assertTrue(g.readiness(self.store, 'need-full-overall')['ready'])

    def test_empty_explicit_value_and_unrelated_notes_are_not_descriptions(self):
        self.assertEqual(description({'production_description': '', 'blocks': [{'id':'description','text':'旧文'}]}), '')
        self.assertEqual(description({'blocks': [{'id':'purpose','text':'一个标题'}], 'facts':['引文']}), '')
        self.assertEqual(description({'state_model':'complete-v1', 'dimensions':{'layout':'岸船'}}, 'space'), '')
        self.assertEqual(description({'state_model':'complete-v1', 'dimensions':{'custom':'完整'}}, 'custom', {'custom': {}}), '完整')

    def test_optional_review_cannot_replace_required_generation_state(self):
        self.setup_plans()
        with self.assertRaises(ValueError): self.change('need-full-overall', required=False, usage='review_reference')
        self.change('full', reference_mode='description')
        self.change('need-full-overall', scope=self.ref('full'), states=[self.ref('full')], required=False, usage='review_reference')
        with self.assertRaises(ValueError): self.change('need-full-overall', usage='generation_input')
        with self.assertRaises(ValueError): self.change('need-full-overall', media_type='image')
        self.assertFalse(p.readiness(self.store, 'full')['state_coverage']['issues'])
