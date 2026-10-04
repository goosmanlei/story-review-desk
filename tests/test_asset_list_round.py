import hashlib
import json
import shutil
import unittest

import test_generation as fixtures
from review_desk import production as p, material_versions as mv
from review_desk.bundle import export, restore
from review_desk.store import Store


class AssetListRoundTest(unittest.TestCase):
    def setUp(self):
        from legacy_material_fixture import install
        install(self)
        self.fixture = fixtures.GenerationTest()
        self.fixture.setUp()
        self.fixture.setup_plans()

    def tearDown(self):
        self.fixture.tearDown()

    def associate(self, asset, states, requirements, production=None):
        f = self.fixture
        fields = {'states': [f.ref(state) for state in states],
                  'state_coverage': [{'state': f.ref(state), 'role': 'overall', 'component_id': 'original', 'detail': 'technical fixture'} for state in states],
                  'candidate_requirements': [f.ref(mid) for mid in requirements]}
        if production:
            fields['production'] = f.ref(production)
        f.change(asset, **fields)

    def next_round(self, mid):
        f = self.fixture
        f.store.create_comment({'target_object_id': mid, 'target_revision_id': f.ref(mid)['revision_id'],
                                'anchor': {'type': 'global'}, 'body': '技术修订测试',
                                'material_revision': {'material_id': mid, 'expected_round': 1}})

    def listed(self, asset):
        return next(row for row in p.current_records(self.fixture.store, {'ASSET'}) if row['object_id'] == asset)

    def test_next_preparing_round_and_metadata_updates_do_not_relabel_old_result(self):
        f = self.fixture
        f.media()
        self.associate('voice', ['full'], ['need-full-overall'])
        self.next_round('need-full-overall')
        self.assertEqual(mv.snapshot(f.store, 'need-full-overall')[0]['number'], 2)
        self.assertEqual(self.listed('voice')['material_version'], 1)
        f.change('voice', verification={'file_inspected': True})
        self.assertGreater(self.listed('voice')['version'], 1)
        f.media('new-voice')
        f.put(f.spec('new-recording', 'CALL', method='recording', tool='technical-fixture', status='submitted', inputs=[], outputs=[]))
        self.associate('new-voice', ['full'], ['need-full-overall'], 'new-recording')
        self.assertEqual(self.listed('new-voice')['material_version'], 2)
        before = mv.fingerprint(f.store)
        self.assertEqual(self.listed('voice')['material_version'], 1)
        self.assertEqual(mv.fingerprint(f.store), before)

    def test_shared_result_label_matches_default_material_card_not_largest_membership(self):
        f = self.fixture
        f.media('voice')
        self.associate('voice', ['full'], ['need-full-overall'])
        f.media('wet-first')
        f.put(f.spec('recording-other', 'CALL', method='recording', tool='technical-fixture', status='submitted', inputs=[], outputs=[]))
        self.associate('wet-first', ['wet'], ['need-wet-overall'], 'recording-other')
        self.next_round('need-wet-overall')
        self.associate('voice', ['full', 'wet'], ['need-full-overall', 'need-wet-overall'])
        detail = p.snapshot(f.store, object_id='voice')
        memberships = mv.memberships(f.store, detail['record']['id'])
        self.assertEqual({(m['material_id'], m['number']) for m in memberships}, {('need-full-overall', 1), ('need-wet-overall', 2), ('voice', 1)})
        first_material, rounds = next(iter(detail['material_versions'].items()))
        self.assertEqual(first_material, 'need-full-overall')
        shown = next(r for r in rounds if any(m['id'] == detail['record']['id'] for m in r['members']))
        self.assertEqual(self.listed('voice')['material_version'], shown['number'])
        self.assertEqual(self.listed('voice')['material_version'], 1)

    def test_unassociated_result_has_its_real_round_and_schema3_history_remains_unknown(self):
        f = self.fixture
        f.media()
        self.assertEqual(self.listed('voice')['material_version'], 1)
        self.next_round('voice')
        self.assertEqual(self.listed('voice')['material_version'], 1)
        export_path = f.root / 'export'
        export(f.store, export_path)
        document_path = export_path / 'objects.json'
        document = json.loads(document_path.read_text())
        for table in mv.TABLES:
            document.pop(table)
        document_path.write_text(json.dumps(document, ensure_ascii=False))
        manifest_path = export_path / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['schema_version'] = 3
        manifest['files']['objects.json'] = hashlib.sha256(document_path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        legacy_root = f.root / 'legacy'
        shutil.copytree(export_path, legacy_root / 'export')
        legacy = Store(legacy_root / '.runtime/review.sqlite3')
        try:
            restore(legacy, legacy_root / 'export')
            before = mv.fingerprint(legacy)
            asset = next(row for row in p.current_records(legacy, {'ASSET'}) if row['object_id'] == 'voice')
            self.assertIsNone(asset['material_version'])
            self.assertEqual(asset['id'], self.listed('voice')['id'])
            self.assertEqual(mv.fingerprint(legacy), before)
        finally:
            legacy.close()


if __name__ == '__main__':
    unittest.main()
