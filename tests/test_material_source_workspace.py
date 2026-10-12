"""Source summaries keep exact membership and expand only the selected target."""
import copy
import unittest
from unittest.mock import patch
from test_production_current import CurrentProductionTest as Fixture
from review_desk import production as p
from review_desk.entity_contract import entity_workspace


class MaterialSourceWorkspaceTest(unittest.TestCase):
    for name in ('setUp', 'tearDown', 'spec', 'put', 'ref', 'entity', 'full',
                 'need', 'setup_plans', 'media', 'migrate'):
        locals()[name] = getattr(Fixture, name)

    def read(self, **options):
        with p.read_scope(self.store):
            return entity_workspace(self.store, 'songbook', deferred=True, **options)

    def test_summary_has_all_real_sources_without_loading_candidate_calls(self):
        self.migrate()
        calls = []
        original = p.record
        def record(store, oid, *args, **kwargs):
            value = original(store, oid, *args, **kwargs)
            calls.append(value['kind'])
            return value
        with patch.object(p, 'record', record):
            data = self.read(load_selected=False)
        self.assertEqual({g['key'] for g in data['material_groups']}, {'full', 'wet'})
        self.assertEqual(len(data['deferred_materials']), 2)
        self.assertTrue(all('generation' not in r['payload'] for r in data['requirements']))
        self.assertEqual(data['materialContexts'], {})
        self.assertNotIn('ASSET', calls)
        self.assertNotIn('CALL', calls)
        selected = self.read(material_id='need-wet-overall')
        self.assertIn('generation', next(r for r in selected['requirements'] if r['object_id']=='need-wet-overall')['payload'])
        self.assertNotIn('generation', next(r for r in selected['requirements'] if r['object_id']=='need-full-overall')['payload'])

    def test_missing_exact_targets_fail_and_source_edit_changes_signature(self):
        self.migrate()
        initial = self.read(load_selected=False)
        with self.assertRaises(ValueError): self.read(material_id='foreign')
        with self.assertRaises(ValueError): self.read(material_id='need-full-overall', candidate_revision='missing')
        state = p.record(self.store, 'wet')
        payload = copy.deepcopy(state['payload'])
        payload['production_description'] = '新增湿区说明'
        self.put({'object_id':'wet', 'kind':'STATE', 'expected_version':state['version'], 'payload':payload})
        after = self.read(material_id='need-full-overall')
        self.assertEqual(initial['entity']['id'], after['entity']['id'])
        self.assertNotEqual(initial['source_signature'], after['source_signature'])

    def test_true_empty_entity_has_no_invented_source_or_material(self):
        self.migrate()
        self.put(self.entity('mentioned'))
        with p.read_scope(self.store):
            data = entity_workspace(self.store, 'mentioned', deferred=True, load_selected=False)
        self.assertEqual(data['material_groups'], [])
        self.assertEqual(data['requirements'], [])
        self.assertEqual(data['material_versions'], {})
