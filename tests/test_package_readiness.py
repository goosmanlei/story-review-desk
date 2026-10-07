"""Download availability follows the real exact package, not optional row policy."""
import copy
import io
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, ProxyHandler, build_opener
import wave

import test_production as fixtures
from review_desk import production as p, production_media as media
from review_desk.server import ReviewServer
from review_desk.store import Conflict, Store


class PackageReadinessTest(unittest.TestCase):
    setUp = fixtures.ProductionTest.setUp
    tearDown = fixtures.ProductionTest.tearDown
    spec = fixtures.ProductionTest.spec
    put = fixtures.ProductionTest.put
    ref = fixtures.ProductionTest.ref
    entity = fixtures.ProductionTest.entity
    media = fixtures.ProductionTest.media
    requirement = fixtures.ProductionTest.requirement
    adoption = fixtures.ProductionTest.adoption

    def audio(self, sample):
        data = io.BytesIO()
        with wave.open(data, 'wb') as out:
            out.setnchannels(1);out.setsampwidth(2);out.setframerate(48000)
            out.writeframes(bytes([sample, 0]) * 48000)
        data.seek(0)
        return media.ingest(self.root, data, 'technical.wav')

    def required(self):
        self.put(self.entity());component = self.media()
        self.put(self.requirement(), self.adoption())
        return component

    def optional(self, selected=True, specification=None):
        requirement = self.requirement('optional')
        requirement['payload'].update(slot='detail', required=False, specification=specification or {})
        self.put(requirement)
        if not selected:
            return None
        component = self.audio(1)
        payload = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        payload.update(title='Optional recording', components=[component])
        self.put({'object_id': 'optional-asset', 'kind': 'ASSET', 'expected_version': 0, 'payload': payload})
        use = self.adoption('optional-use');use['payload'].update(slot='detail', asset=self.ref('optional-asset'))
        self.put(use)
        return component

    def test_required_counts_and_unselected_optional_keep_the_existing_contract(self):
        self.put(self.entity())
        empty = p.readiness(self.store, 'songbook')
        self.assertFalse(empty['inputs_ready']);self.assertFalse(empty['package_available'])
        self.assertEqual((empty['required_count'], empty['missing_count']), (0, 0))
        self.media();self.put(self.requirement())
        missing = p.readiness(self.store, 'songbook')
        self.assertEqual((missing['required_count'], missing['missing_count']), (1, 1))
        self.assertFalse(missing['package_available'])
        with self.assertRaises(Conflict):p.package_manifest(self.store, 'songbook')
        self.put(self.adoption());self.optional(selected=False)
        ready = p.readiness(self.store, 'songbook')
        self.assertTrue(ready['inputs_ready']);self.assertTrue(ready['package_available'])
        self.assertIsNone(ready['package_issue'])
        self.assertEqual((ready['required_count'], ready['missing_count']), (1, 0))
        self.assertEqual(ready['requirements'][1]['issues'], ['missing_adoption'])
        self.assertEqual(p.package_manifest(self.store, 'songbook')['readiness'], ready)

    def test_optional_quality_warning_remains_packable_and_selected_original_is_included(self):
        self.required();optional = self.optional(specification={'minimum_sample_rate': 96000})
        ready = p.readiness(self.store, 'songbook')
        self.assertTrue(ready['inputs_ready']);self.assertTrue(ready['package_available'])
        self.assertIn('below_minimum_sample_rate', ready['requirements'][1]['issues'])
        manifest = p.package_manifest(self.store, 'songbook')
        self.assertIn(optional['file'], manifest['files'])
        self.assertEqual(manifest['readiness'], ready)
        self.assertEqual(manifest['readiness']['creative_acceptance'], [])

    def test_missing_and_same_size_corrupt_optional_block_package_without_recounting_or_history_changes(self):
        self.required();optional = self.optional()
        before = '\n'.join(self.store.db.iterdump())
        path = self.root/'export/assets'/optional['file'];original = path.read_bytes()
        for fault in ('missing', 'corrupt'):
            with self.subTest(fault=fault):
                if fault == 'missing':path.unlink()
                else:path.write_bytes(original[:-1]+bytes([original[-1]^1]))
                ready = p.readiness(self.store, 'songbook')
                self.assertTrue(ready['inputs_ready']);self.assertFalse(ready['package_available'])
                self.assertEqual((ready['required_count'], ready['missing_count']), (1, 0))
                issue = ready['package_issue']
                self.assertEqual((issue['object_id'], issue['component_id'], issue['file']), ('optional-asset', 'original', optional['file']))
                self.assertEqual(issue['revision_id'], self.ref('optional-asset')['revision_id'])
                self.assertEqual(issue['reason'], 'missing media or byte size mismatch' if fault == 'missing' else 'media checksum mismatch')
                with self.assertRaisesRegex(ValueError, issue['reason']):p.package_manifest(self.store, 'songbook')
                output = self.root/'failed-package'
                with self.assertRaises(ValueError):p.write_package(self.store, 'songbook', output)
                self.assertFalse(output.exists())
                self.assertEqual('\n'.join(self.store.db.iterdump()), before)
                path.write_bytes(original)
        self.assertTrue(p.readiness(self.store, 'songbook')['package_available'])

    def test_historical_call_input_failure_is_reported_even_when_current_adopted_rows_are_valid(self):
        original = self.required();historical = self.ref('voice')
        self.put(self.spec('derived', 'CALL', method='editing', tool='fixture', status='submitted', inputs=[{**historical, 'component_id': 'original'}], outputs=[]))
        current = self.audio(2)
        payload = copy.deepcopy(p.record(self.store, 'voice')['payload'])
        payload.update(components=[current], production=self.ref('derived'))
        self.put({'object_id': 'voice', 'kind': 'ASSET', 'expected_version': 1, 'payload': payload})
        use = self.adoption();use['expected_version'] = 1;self.put(use)
        valid = p.package_manifest(self.store, 'songbook')
        self.assertEqual(set(valid['files']), {original['file'], current['file']})
        (self.root/'export/assets'/original['file']).unlink()
        ready = p.readiness(self.store, 'songbook')
        self.assertTrue(ready['inputs_ready']);self.assertEqual(ready['requirements'][0]['issues'], [])
        self.assertFalse(ready['package_available']);self.assertEqual(ready['package_issue']['revision_id'], historical['revision_id'])
        with self.assertRaises(ValueError):p.package_manifest(self.store, 'songbook')

    def test_one_check_hashes_reused_components_once_and_later_download_rechecks(self):
        component = self.required()
        extra = self.requirement('second');extra['payload'].update(slot='second')
        use = self.adoption('second-use');use['payload'].update(slot='second')
        self.put(extra, use)
        with patch.object(media, 'file_hash', wraps=media.file_hash) as hashed:
            self.assertTrue(p.readiness(self.store, 'songbook')['package_available'])
            self.assertEqual(hashed.call_count, 1)
            p.package_manifest(self.store, 'songbook')
            self.assertEqual(hashed.call_count, 2)
        path = self.root/'export/assets'/component['file'];original = path.read_bytes()
        path.write_bytes(original[:-1]+bytes([original[-1]^1]))
        with self.assertRaises(Conflict):p.package_manifest(self.store, 'songbook')

    def test_request_cache_rejects_changes_during_dependency_validation_and_checks_metadata(self):
        component = self.required();path = self.root/'export/assets'/component['file'];original = path.read_bytes()
        collect = p._package_contents
        def changed(store, ready, validate):
            path.write_bytes(original[:-1]+bytes([original[-1]^1]))
            return collect(store, ready, validate)
        with patch.object(p, '_package_contents', side_effect=changed):
            ready = p.readiness(self.store, 'songbook')
        self.assertTrue(ready['inputs_ready']);self.assertFalse(ready['package_available'])
        self.assertEqual(ready['package_issue']['reason'], 'media checksum mismatch')
        path.write_bytes(original)
        validate = p._package_component_validator(self.store);validate(component)
        with self.assertRaisesRegex(ValueError, 'byte size'):validate({**component, 'bytes': component['bytes']+1})
        replacement = path.with_suffix('.replacement');replacement.write_bytes(original)
        path.unlink();path.symlink_to(replacement)
        with self.assertRaisesRegex(ValueError, 'symlink'):validate(component)

    def test_http_and_cli_share_availability_failure_and_exact_success_manifest(self):
        self.required();optional = self.optional();path = self.root/'export/assets'/optional['file'];original = path.read_bytes()
        from review_desk.read_cache import initialize
        initialize(self.store)
        original_history = '\n'.join(self.store.db.iterdump())
        self.store.close()
        ready_queue = queue.Queue()
        def serve():
            with ReviewServer(('127.0.0.1', 0), self.root, {'id': 'package-test', 'title': 'Package test'}) as server:
                ready_queue.put(server);server.serve_forever(poll_interval=.02)
        thread = threading.Thread(target=serve, daemon=True);thread.start();server = ready_queue.get(timeout=10)
        opener = build_opener(ProxyHandler({}))
        def get(route):
            try:response = opener.open('http://127.0.0.1:'+str(server.server_port)+route, timeout=10)
            except HTTPError as error:response = error
            with response:return response.status, json.load(response)
        try:
            status, ready = get('/api/production/readiness?scope=songbook')
            self.assertEqual(status, 200);self.assertTrue(ready['package_available'])
            path.unlink()
            status, ready = get('/api/production/readiness?scope=songbook')
            self.assertEqual(status, 200);self.assertTrue(ready['inputs_ready']);self.assertFalse(ready['package_available'])
            status, failed = get('/api/production/package?scope=songbook')
            self.assertEqual(status, 400);self.assertIn(ready['package_issue']['reason'], failed['error'])
            path.write_bytes(original)
            status, manifest = get('/api/production/package?scope=songbook')
            self.assertEqual(status, 200);self.assertTrue(manifest['readiness']['package_available'])
        finally:
            server.shutdown();thread.join(timeout=10);self.assertFalse(thread.is_alive())
            self.store = Store(self.root/'.runtime/review.sqlite3')
        self.assertEqual('\n'.join(self.store.db.iterdump()), original_history)
        (self.root/'config').mkdir();(self.root/'config/instance.json').write_text('{"id":"package-test","title":"Package test"}')
        output = self.root/'output'
        run = subprocess.run([sys.executable, '-m', 'review_desk', '--instance', str(self.root), 'production-package', 'songbook', '--output', str(output)], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads((output/'manifest.json').read_text()), manifest)
        for name, component in manifest['files'].items():self.assertEqual(media.file_hash(output/'assets'/name), component['sha256'])
        path.unlink()
        failed = subprocess.run([sys.executable, '-m', 'review_desk', '--instance', str(self.root), 'production-package', 'songbook', '--output', str(self.root/'failed-output')], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
        self.assertNotEqual(failed.returncode, 0);self.assertIn('missing media or byte size mismatch', failed.stderr)
        self.assertFalse((self.root/'failed-output').exists())


if __name__ == '__main__':
    unittest.main()
