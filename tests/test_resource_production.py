"""Cold production reads and late identity failures use isolated synthetic media.

FakeOSS supplies exact versions; real SHA and ffprobe validation remain enabled.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import wave

import test_production_current as fixtures
from test_resource_offline import FakeOSS
from review_desk import production as p, production_operations as operations
from review_desk import production_current as current, generation, resources as r, production_media
from review_desk import semantic_consolidation as semantic


class ProductionResourceTest(unittest.TestCase):
    for name in ('spec', 'put', 'ref', 'entity', 'full', 'need', 'setup_plans', 'media', 'migrate', 'submit', 'result'):
        locals()[name] = getattr(fixtures.CurrentProductionTest, name)

    def setUp(self):
        fixtures.CurrentProductionTest.setUp(self)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.migrate()

    def enable_cloud(self):
        config = {'format': r.FORMAT, 'provider': 'oss', 'instance_id': 'cold-production-test', 'project': 'cold-production-test', 'bucket': 'synthetic-only', 'region': 'cn-hongkong', 'cache_bytes': 16 * 1024 * 1024}
        (self.root / 'config').mkdir(exist_ok=True)
        (self.root / 'config/instance.json').write_text(json.dumps({'id': config['instance_id']}))
        (self.root / 'config/resource-storage.json').write_text(json.dumps(config))
        self.cloud = FakeOSS()
        catalog = {**config, 'entries': {}}
        self.observations, self.physical_reads, self.probes = ([], [], [])
        for asset in (self.root / 'export/assets').iterdir():
            if not asset.is_file():
                continue
            data = asset.read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            self.assertEqual(asset.suffix, '.wav')
            spec = {'key': config['project'] + '/originals/' + sha, 'version_id': 'exact-' + sha[:12], 'sha256': sha, 'verified_sha256': sha, 'bytes': len(data), 'mime': 'audio/wav'}
            self.cloud.objects[spec['key'], spec['version_id']] = (data, spec['mime'])
            catalog['entries']['export/assets/' + asset.name] = spec
            asset.unlink()
        (self.root / 'config/resource-catalog.json').write_text(json.dumps(catalog))

        def observe():
            self.observations.append({'in_transaction': self.store.db.in_transaction})
        self.cloud.on_get = observe
        self.env = patch.dict(os.environ, {'REVIEW_RESOURCES_OFFLINE': '0'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.remote = patch.object(r, 'client', return_value=self.cloud)
        self.remote.start()
        self.addCleanup(self.remote.stop)
        actual_open, actual_probe = (Path.open, production_media._probe)

        def traced_open(path, *args, **kwargs):
            mode = args[0] if args else kwargs.get('mode', 'r')
            if mode == 'rb' and path.parent.name == 'resource-cache':
                self.physical_reads.append({'in_transaction': self.store.db.in_transaction, 'name': path.name})
            return actual_open(path, *args, **kwargs)

        def traced_probe(path):
            self.probes.append({'in_transaction': self.store.db.in_transaction, 'name': path.name})
            return actual_probe(path)
        self.open_patch = patch.object(Path, 'open', traced_open)
        self.probe_patch = patch.object(production_media, '_probe', traced_probe)
        self.open_patch.start()
        self.addCleanup(self.open_patch.stop)
        self.probe_patch.start()
        self.addCleanup(self.probe_patch.stop)

    def assert_preflighted(self):
        self.assertGreater(len(self.observations), 0, 'must exercise a genuine cold cache')
        self.assertFalse(any((x['in_transaction'] for x in self.observations)), 'cloud GET occurred under SQLite write transaction')
        self.assertFalse(any((x['in_transaction'] for x in self.physical_reads)), 'full physical bytes read under SQLite write transaction')
        self.assertFalse(any((x['in_transaction'] for x in self.probes)), 'actual ffprobe under SQLite write transaction')
        self.assertEqual(list((self.root / 'export/assets').iterdir()), [])

    def setup_selected_input(self):
        self.submit('reference-source')
        source = self.result('reference-source')
        need = p.record(self.store, 'need-wet-overall')
        payload = copy.deepcopy(need['payload'])
        selection = {'material_id': 'need-full-overall', 'candidate_id': source['candidate_id']}
        payload['generation'].update(model='seed-audio-1.0', prompt='@音频1 保留原声源，改变湿润纸页声。', inputs=[{'reference': self.ref(source['object_id']), 'component_id': 'original', 'material_selection': selection, 'use': '音频1：同一纸页声源'}])
        self.put({'object_id': need['object_id'], 'kind': 'REQUIREMENT', 'expected_version': need['version'], 'payload': payload})
        need = p.record(self.store, need['object_id'])
        plan = generation.package(self.store, need['object_id'])
        return {'id': 'submit-with-reference', 'call_id': 'with-reference', 'requirement_id': need['object_id'], 'tool': 'test', 'expected_content': current.marker(need), 'package_sha256': current.checksum(plan)}

    def test_plain_production_import_original_preflights_before_write(self):
        asset = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        asset.pop('production', None)
        asset.pop('candidate_identity', None)
        asset['external_source'] = {'kind': 'upload', 'description': 'Synthetic imported original'}
        self.enable_cloud()
        result = p.import_records(self.store, {'format': 'production-import-v1', 'records': [{'object_id': 'cold-upload', 'kind': 'ASSET', 'expected_version': 0, 'payload': asset}]})
        self.assert_preflighted()
        self.assertTrue(self.physical_reads)
        self.assertTrue(self.probes, 'original metadata must actually be inspected')

    def test_submit_selected_exact_input_preflights_before_write(self):
        request = self.setup_selected_input()
        self.enable_cloud()
        result = operations.submit(self.store, request)
        self.assert_preflighted()

    def test_import_requirement_selected_input_preflights_before_write(self):
        self.setup_selected_input()
        need = p.record(self.store, 'need-wet-overall')
        payload = copy.deepcopy(need['payload'])
        payload['purpose'] = 'Synthetic reviewed purpose'
        self.enable_cloud()
        result = p.import_records(self.store, {'format': 'production-import-v1', 'records': [{'object_id': need['object_id'], 'kind': 'REQUIREMENT', 'expected_version': need['version'], 'payload': payload}]})
        self.assert_preflighted()

    def test_select_existing_exact_input_preflights_before_write(self):
        from review_desk.shot_references import input_key
        self.setup_selected_input()
        need = p.record(self.store, 'need-wet-overall')
        old = need['payload']['generation']['inputs'][0]
        request = {'id': 'select-exact', 'requirement_id': need['object_id'], 'expected_content': current.marker(need), 'index': 0, 'input_key': input_key(old), 'material_id': 'need-full-overall', 'candidate': old['reference'], 'component_id': old['component_id']}
        self.enable_cloud()
        result = operations.select(self.store, request)
        self.assert_preflighted()

    def test_reuse_candidate_selected_input_preflights_before_write(self):
        submit_request = self.setup_selected_input()
        submitted = operations.submit(self.store, submit_request)
        asset = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        asset.pop('candidate_identity', None)
        asset['candidate_requirements'] = [self.ref('need-wet-overall')]
        asset['states'] = [self.ref('wet')]
        asset['state_coverage'] = [{'state': self.ref('wet'), 'role': 'overall', 'component_id': 'original', 'detail': 'Synthetic returned original'}]
        finished = operations.finish(self.store, {'id': 'receipt-reference-completed', 'call_id': 'with-reference', 'submission_sha256': submitted['submission_sha256'], 'status': 'completed', 'asset': asset, 'response': {'id': 'synthetic-provider-result'}, 'cost': {'credits': 0}})
        need = p.record(self.store, 'need-wet-overall')
        self.enable_cloud()
        result = operations.reuse(self.store, {'id': 'reuse-exact', 'requirement_id': need['object_id'], 'expected_content': current.marker(need), 'candidate_id': finished['candidate_id']})
        self.assert_preflighted()

    def test_finish_returned_exact_component_preflights_before_write(self):
        _, submitted = self.submit('output-call')
        asset = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        asset.pop('candidate_identity', None)
        asset['candidate_requirements'] = [self.ref('need-full-overall')]
        asset['states'] = [self.ref('full')]
        asset['state_coverage'] = [{'state': self.ref('full'), 'role': 'overall', 'component_id': 'original', 'detail': 'Synthetic returned original'}]
        self.enable_cloud()
        result = operations.finish(self.store, {'id': 'receipt-completed', 'call_id': 'output-call', 'submission_sha256': submitted['submission_sha256'], 'status': 'completed', 'asset': asset, 'response': {'id': 'synthetic-provider-result'}, 'cost': {'credits': 0}})
        self.assert_preflighted()
        self.assertTrue(self.probes, 'returned original metadata must actually be inspected')

    def prepare_merge(self):
        self.put(self.need(state='full', slot='fold-detail', required=False))
        self.submit('merge-source')
        self.result('merge-source')
        return semantic.prepare(self.store, {'merges': [{'source': 'need-full-overall', 'target': 'need-wet-overall', 'reason': 'Synthetic reviewed consolidation of the same source'}]})

    def test_semantic_exact_candidate_preflights_before_write(self):
        plan = self.prepare_merge()
        self.assertTrue(plan['media'])
        self.enable_cloud()
        result = semantic.apply(self.store, plan)
        self.assert_preflighted()
        self.assertTrue(semantic.is_retired(p.record(self.store, 'need-full-overall')['payload']))
        self.assertTrue(semantic.apply(self.store, plan)['already_applied'])

    def test_semantic_interruption_rolls_back(self):
        plan = self.prepare_merge()
        before = p.record(self.store, 'need-full-overall')['payload']
        self.enable_cloud()
        with self.assertRaisesRegex(RuntimeError, 'interruption'):
            semantic.apply(self.store, plan, fault='before-commit')
        self.assertEqual(p.record(self.store, 'need-full-overall')['payload'], before)
        self.assertIsNone(self.store.db.execute('SELECT 1 FROM production_current_operations WHERE id=?', (plan['id'],)).fetchone())
        self.assert_preflighted()

    def change_cached_original(self):
        paths = [x for x in (self.root / '.runtime/resource-cache').iterdir() if x.suffix == '.wav']
        self.assertEqual(len(paths), 1)
        data = paths[0].read_bytes()
        paths[0].write_bytes(data[:-1] + bytes([data[-1] ^ 1]))

    def test_submit_final_identity_failure_rolls_back(self):
        request = self.setup_selected_input()
        self.enable_cloud()
        actual = operations.remember

        def changed_after_action(*args, **kwargs):
            result = actual(*args, **kwargs)
            self.assertTrue(self.store.db.in_transaction)
            self.change_cached_original()
            return result
        with patch.object(operations, 'remember', changed_after_action):
            with self.assertRaisesRegex(ValueError, 'media changed') as caught:
                operations.submit(self.store, request)
        persisted = self.store.db.execute('SELECT 1 FROM objects WHERE id=?', (request['call_id'],)).fetchone() is not None
        operation = self.store.db.execute('SELECT 1 FROM production_current_operations WHERE id=?', (request['id'],)).fetchone() is not None
        self.assertFalse(persisted, 'API reports failed identity validation but CALL was committed')
        self.assertFalse(operation)

    def test_import_final_identity_failure_rolls_back(self):
        asset = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        asset.pop('production', None)
        asset.pop('candidate_identity', None)
        asset['external_source'] = {'kind': 'upload', 'description': 'Synthetic race original'}
        self.enable_cloud()
        actual = self.store._put_object

        def changed_after_write(*args, **kwargs):
            result = actual(*args, **kwargs)
            self.assertTrue(self.store.db.in_transaction)
            if args[0] == 'race-upload':
                self.change_cached_original()
            return result
        with patch.object(self.store, '_put_object', changed_after_write):
            with self.assertRaisesRegex(ValueError, 'media changed') as caught:
                p.import_records(self.store, {'format': 'production-import-v1', 'records': [{'object_id': 'race-upload', 'kind': 'ASSET', 'expected_version': 0, 'payload': asset}]})
        persisted = self.store.db.execute("SELECT 1 FROM objects WHERE id='race-upload'").fetchone() is not None
        self.assertFalse(persisted, 'API reports failed identity validation but ASSET was committed')

    def test_store_put_final_identity_failure_rolls_back(self):
        asset = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        asset.pop('production', None)
        asset.pop('candidate_identity', None)
        asset['external_source'] = {'kind': 'upload', 'description': 'Synthetic Store race original'}
        self.enable_cloud()
        actual = self.store._put_object

        def changed_after_write(*args, **kwargs):
            result = actual(*args, **kwargs)
            self.assertTrue(self.store.db.in_transaction)
            self.change_cached_original()
            return result
        with patch.object(self.store, '_put_object', changed_after_write):
            with self.assertRaisesRegex(ValueError, 'media changed') as caught:
                self.store.put_object('race-store-upload', 'ASSET', asset)
        persisted = self.store.db.execute("SELECT 1 FROM objects WHERE id='race-store-upload'").fetchone() is not None
        self.assertFalse(persisted)

    def test_semantic_final_identity_failure_rolls_back(self):
        from review_desk import production_current_bundle
        plan = self.prepare_merge()
        before = p.record(self.store, 'need-full-overall')['payload']
        self.enable_cloud()
        actual = production_current_bundle.required_assets

        def changed_after_validation(*args, **kwargs):
            result = actual(*args, **kwargs)
            self.assertTrue(self.store.db.in_transaction)
            self.change_cached_original()
            return result
        with patch.object(production_current_bundle, 'required_assets', changed_after_validation):
            with self.assertRaisesRegex(ValueError, 'media changed') as caught:
                semantic.apply(self.store, plan)
        unchanged = p.record(self.store, 'need-full-overall')['payload'] == before
        persisted = self.store.db.execute('SELECT 1 FROM production_current_operations WHERE id=?', (plan['id'],)).fetchone() is not None
        self.assertTrue(unchanged)
        self.assertFalse(persisted)

    def detail_requirement(self, slot, inputs, links=None):
        row = self.need(state='full', slot=slot, required=False)
        plan = copy.deepcopy(p.record(self.store, 'need-wet-overall')['payload']['generation'])
        plan['inputs'] = inputs
        plan['output']['name'] = row['payload']['title']
        if links:
            plan['reference_links'] = links
        row['payload']['generation'] = plan
        return row

    def test_recursive_requirement_terminal_preflights(self):
        self.setup_selected_input()
        row = self.detail_requirement('recursive', [{'reference': self.ref('need-wet-overall'), 'use': 'Synthetic indirect requirement'}])
        self.enable_cloud()
        result = p.import_records(self.store, {'format': 'production-import-v1', 'records': [row]})
        self.assert_preflighted()

    def second_candidate(self):
        request = self.setup_selected_input()
        submitted = operations.submit(self.store, request)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(48000)
            stream.writeframes(b'\x01\x00' * 48000)
        buf.seek(0)
        component = production_media.ingest(self.root, buf, 'second.wav')
        self.assertNotEqual(component['sha256'], self.component['sha256'])
        asset = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        asset.pop('candidate_identity', None)
        asset.update(components=[component], candidate_requirements=[self.ref('need-wet-overall')], states=[self.ref('wet')], state_coverage=[{'state': self.ref('wet'), 'role': 'overall', 'component_id': 'original', 'detail': 'Synthetic different returned original'}])
        result = operations.finish(self.store, {'id': 'second-candidate', 'call_id': request['call_id'], 'submission_sha256': submitted['submission_sha256'], 'status': 'completed', 'asset': asset})
        return {'reference': self.ref('asset-' + request['call_id']), 'component_id': 'original', 'material_selection': {'material_id': 'need-wet-overall', 'candidate_id': result['candidate_id']}, 'use': 'Synthetic output from an exact upstream original'}

    @staticmethod
    def provenance_link(path):
        return {'key': 'origin', 'label': 'Synthetic exact source', 'purpose': 'Trace accurate original', 'path': path, 'material_id': 'need-full-overall'}

    def test_reference_path_checks_distinct_actual_call_original(self):
        second = self.second_candidate()
        row = self.detail_requirement('provenance', [second], [self.provenance_link([0, 0])])
        self.enable_cloud()
        result = p.import_records(self.store, {'format': 'production-import-v1', 'records': [row]})
        self.assert_preflighted()
        self.assertEqual(len(self.cloud.gets), 2, 'both distinct returned and actual source originals must be prepared')

    def test_batch_alias_reference_path_checks_distinct_call_original(self):
        second = self.second_candidate()
        first = self.detail_requirement('batch-middle', [second])
        last = self.detail_requirement('batch-consumer', [{'reference': {'object_id': first['object_id'], 'revision_id': '@' + first['object_id']}, 'use': 'Synthetic new requirement from the same batch'}], [self.provenance_link([0, 0, 0])])
        self.enable_cloud()
        result = p.import_records(self.store, {'format': 'production-import-v1', 'records': [first, last]})
        self.assert_preflighted()
        self.assertEqual(len(self.cloud.gets), 2)
        actual = p.record(self.store, last['object_id'])['payload']['generation']['inputs'][0]['reference']
        self.assertEqual(actual, self.ref(first['object_id']))

    def test_whole_references_preflights_legacy_partial_input(self):
        self.setup_selected_input()
        need = p.record(self.store, 'need-wet-overall')
        payload = copy.deepcopy(need['payload'])
        payload['generation']['inputs'][0]['range'] = {'start_seconds': 0.1, 'end_seconds': 0.8}
        # Seed the old partial-reference state that this explicit conversion repairs.
        from review_desk.store import canonical
        with self.store.db:
            self.store.db.execute('UPDATE production_current_records SET payload_sha256=? WHERE object_id=?', (current.checksum(payload), need['object_id']))
            self.store.db.execute('UPDATE revisions SET payload=? WHERE id=?', (canonical(payload), need['id']))
        need = p.record(self.store, need['object_id'])
        self.enable_cloud()
        result = operations.whole_references(self.store, {'id': 'whole-reference-test', 'requirements': [{'object_id': need['object_id'], 'expected_content': current.marker(need)}]})
        self.assert_preflighted()
        self.assertEqual(result['changed'], [{'object_id': need['object_id'], 'indices': [0]}])
        self.assertNotIn('range', p.record(self.store, need['object_id'])['payload']['generation']['inputs'][0])


if __name__ == '__main__':
    unittest.main()
