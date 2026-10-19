"""Offline creation, exact cloud promotion, and complete recovery with synthetic bytes."""
import contextlib, copy, hashlib, io, json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from review_desk import resources as r, resource_bundle as rb
from review_desk.store import Store


class Missing(Exception):
    status_code = 404


class Body(io.BytesIO):
    def iter_bytes(self, chunk_size):
        while block := self.read(chunk_size):
            yield block


class FakeOSS:
    def __init__(self):
        self.objects, self.puts, self.gets = {}, [], []
        self.fail_get = None
        self.on_get = None

    def head_object(self, request):
        choices = [(key, version) for key, version in self.objects if key == request.key]
        if not choices:
            raise Missing()
        selected = (request.key, request.version_id) if request.version_id else choices[-1]
        if selected not in self.objects:
            raise Missing()
        data, mime = self.objects[selected]
        return SimpleNamespace(content_length=len(data), content_type=mime,
                               version_id=selected[1], etag=hashlib.md5(data).hexdigest())

    def put_object(self, request):
        data = request.body.read()
        version = 'fake-v' + str(len(self.puts) + 1)
        self.objects[request.key, version] = data, request.content_type
        self.puts.append((request.key, version, request.content_type, len(data)))
        return SimpleNamespace(version_id=version)

    def get_object(self, request):
        self.gets.append((request.key, request.version_id))
        if self.on_get:
            self.on_get()
        if self.fail_get and self.fail_get(request):
            raise Missing()
        if (request.key, request.version_id) not in self.objects:
            raise Missing()
        data, mime = self.objects[request.key, request.version_id]
        return SimpleNamespace(body=Body(data), content_type=mime)


class OfflineCandidatesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='review-offline-candidate-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'config').mkdir()
        (self.root / 'content').mkdir()
        (self.root / '.runtime').mkdir()
        self.config = {'format': r.FORMAT, 'provider': 'oss', 'instance_id': 'offline-test',
                       'project': 'offline-test', 'bucket': 'offline-test-bucket',
                       'region': 'cn-hongkong', 'cache_bytes': 16 * 1024 * 1024}
        (self.root / 'config/instance.json').write_text(json.dumps({'id': 'offline-test'}))
        (self.root / 'config/resource-storage.json').write_text(json.dumps(self.config))
        self.catalog = self.root / 'config/resource-catalog.json'
        r.atomic_json(self.catalog, {k: self.config[k] for k in ('format', 'project', 'bucket', 'region')} | {'entries': {}})
        self.env = patch.dict(os.environ, {'REVIEW_RESOURCES_OFFLINE': '1'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.block = patch.object(r, 'client', side_effect=AssertionError('real cloud is forbidden'))
        self.block.start(); self.addCleanup(self.block.stop)
        self.fake = FakeOSS()
        r._catalog_cache.clear()

    @property
    def runtime_catalog(self):
        return self.root / '.runtime/resources/catalog.json'

    def publish_json(self, name='candidate.json', body=b'{"candidate":"synthetic"}'):
        path = self.root / 'input.json'; path.write_bytes(body)
        return r.publish_file(self.root, name, path)

    def publish_image(self):
        from PIL import Image
        path = self.root / 'input.png'
        Image.new('RGB', (800, 80), '#174a80').save(path)
        return r.publish_file(self.root, 'candidate.png', path)

    @contextlib.contextmanager
    def online(self):
        with patch.dict(os.environ, {'REVIEW_RESOURCES_OFFLINE': '0'}), patch.object(r, 'client', return_value=self.fake):
            yield

    def assert_offline(self, spec):
        self.assertEqual(spec['source'], 'offline-candidate')
        self.assertEqual(spec['verification'], 'full-local-sha256')
        self.assertNotIn('key', spec); self.assertNotIn('version_id', spec)
        path = self.root / 'resource-bundle' / spec['sha256']
        self.assertEqual(path.stat().st_size, spec['bytes']); self.assertEqual(r.hash_file(path), spec['sha256'])

    def test_original_and_image_variants_are_durable_and_idempotent(self):
        spec = self.publish_image()
        self.assertEqual(set(spec['variants']), {'small', 'large'})
        for selected in (spec, *spec['variants'].values()):
            self.assert_offline(selected)
        again = self.publish_image()
        self.assertEqual(r.content_identity(again), r.content_identity(spec))
        self.assertEqual(len([p for p in (self.root / 'resource-bundle').iterdir() if p.suffix != '.lock']),
                         len({s['sha256'] for s in (spec, *spec['variants'].values())}))

    def test_warm_cache_cannot_hide_corrupt_durable_local_original(self):
        spec = self.publish_json()
        warm = r.materialize(self.root, 'candidate.json')
        self.assertTrue(warm.is_file())
        durable = self.root / 'resource-bundle' / spec['sha256']
        durable.write_bytes(b'x' * spec['bytes'])
        with self.assertRaisesRegex(ValueError, 'durable offline'):
            r.materialize(self.root, 'candidate.json')

    def test_evicted_cache_can_reload_durable_local_original(self):
        spec = self.publish_json()
        warm = r.materialize(self.root, 'candidate.json'); expected = warm.read_bytes(); warm.unlink()
        self.assertEqual(r.materialize(self.root, 'candidate.json').read_bytes(), expected)
        self.assert_offline(spec)

    def test_online_access_rejects_local_candidate_even_after_warming(self):
        spec = self.publish_json(); r.materialize(self.root, 'candidate.json')
        with self.online():
            for operation in (lambda: r.descriptor(self.root, 'candidate.json'),
                              lambda: r.materialize(self.root, 'candidate.json', spec=spec),
                              lambda: r.signed_url(self.root, 'candidate.json'),
                              lambda: r.remote_etag(self.root, spec),
                              lambda: r.verify_remote(self.root, spec),
                              lambda: r.freeze_catalog(self.root, self.root / 'rejected.json')):
                with self.subTest(operation=operation), self.assertRaisesRegex(ValueError, 'offline candidate'):
                    operation()
        self.assertEqual(self.fake.puts, []); self.assertEqual(self.fake.gets, [])

    def test_offline_runtime_explicitly_disables_remote_client(self):
        # Stop only the fail-fast stub here; real client rejects before SDK/credentials.
        self.block.stop()
        with self.assertRaisesRegex(ValueError, 'cloud access is disabled'):
            r.client(self.config)

    def test_actual_git_ancestor_is_rejected_before_durable_write(self):
        (self.root / '.git').mkdir()
        with self.assertRaisesRegex(ValueError, 'outside every Git'):
            self.publish_json()
        self.assertFalse((self.root / 'resource-bundle').exists())

    def test_offline_creation_cannot_downgrade_existing_cloud_identity(self):
        body = b'{"candidate":"synthetic"}'; digest = hashlib.sha256(body).hexdigest()
        cloud = {'sha256': digest, 'verified_sha256': digest, 'bytes': len(body), 'mime': 'application/json',
                 'key': 'offline-test/originals/' + digest, 'version_id': 'original-cloud-version', 'variants': {}}
        r.register(self.root, 'candidate.json', cloud)
        self.assertEqual(self.publish_json(), cloud)
        self.assertEqual(r.descriptor(self.root, 'candidate.json'), cloud)

    def test_promotion_all_variants_keeps_content_identity_and_freezes_via_cli(self):
        from review_desk.__main__ import main
        before = self.publish_image(); r.freeze_catalog(self.root, self.catalog)
        output = io.StringIO()
        with self.online(), patch.object(sys, 'argv', ['review_desk', '--instance', str(self.root), 'resource-promote']), contextlib.redirect_stdout(output):
            main()
            after = r.descriptor(self.root, 'candidate.png')
            self.assertEqual(r._catalog(self.root, self.config), json.loads(self.catalog.read_text())['entries'])
        self.assertGreaterEqual(json.loads(output.getvalue())['promoted_objects'], 2)
        for old, new in [(before, after), *[(before['variants'][k], after['variants'][k]) for k in before['variants']]]:
            self.assertEqual(r.content_identity(old), r.content_identity(new))
            self.assertNotIn('source', new); self.assertNotIn('category', new); self.assertNotIn('verification', new)
            self.assertTrue(new['version_id']); self.assertIn((new['key'], new['version_id']), self.fake.gets)
        self.assertTrue(all(mime != 'application/octet-stream' for _, _, mime, _ in self.fake.puts))

    def test_failed_derivative_promotion_keeps_both_catalogs_byte_for_byte_and_can_resume(self):
        self.publish_image(); r.freeze_catalog(self.root, self.catalog)
        before = (self.catalog.read_bytes(), self.runtime_catalog.read_bytes())
        self.fake.fail_get = lambda request: '/derivatives/' in request.key
        with self.online(), self.assertRaisesRegex(ValueError, 'exact cloud resource unavailable'):
            r.promote(self.root)
        self.assertEqual(before, (self.catalog.read_bytes(), self.runtime_catalog.read_bytes()))
        self.assertTrue(r.materialize(self.root, 'candidate.png').is_file())
        first_puts = len(self.fake.puts); self.fake.fail_get = None
        with self.online():
            r.promote(self.root)
            self.assertNotEqual(r.descriptor(self.root, 'candidate.png').get('source'), 'offline-candidate')
        self.assertLessEqual(len(self.fake.puts), first_puts + 1, 'retry should reuse already uploaded accurate objects')

    def test_corrupt_local_bytes_do_not_change_catalog_on_promotion(self):
        spec = self.publish_json(); before = self.runtime_catalog.read_bytes()
        (self.root / 'resource-bundle' / spec['sha256']).write_bytes(b'corrupt')
        with self.online(), self.assertRaisesRegex(ValueError, 'checksum differs'):
            r.promote(self.root)
        self.assertEqual(before, self.runtime_catalog.read_bytes()); self.assertEqual(self.fake.puts, [])

    def test_concurrent_catalog_addition_is_not_lost_during_promotion(self):
        self.publish_json(); old = json.loads(self.runtime_catalog.read_text())
        newer = copy.deepcopy(old); newer['entries']['newer.json'] = newer['entries']['candidate.json']
        def change():
            self.fake.on_get = None
            r.atomic_json(self.runtime_catalog, newer)
        self.fake.on_get = change
        with self.online(), self.assertRaisesRegex(ValueError, 'catalog changed'):
            r.promote(self.root)
        self.assertEqual(json.loads(self.runtime_catalog.read_text()), newer)


    def test_offline_schema16_snapshot_restore_and_comment_roundtrip(self):
        self.publish_json()
        store = Store(self.root / '.runtime/review.sqlite3'); self.addCleanup(store.close)
        store.put_source({'id': 'synthetic', 'title': 'Synthetic', 'version_type': 'original', 'origin': 'fixture',
                          'source_url': 'https://example.invalid/source', 'collected_at': '2026-10-20',
                          'notes': 'private fixture', 'assets': [], 'blocks': [{'id': 'body', 'text': 'Test text'}]})
        store.create_comment({'id': 'comment', 'source_id': 'synthetic',
                              'anchor': {'block_id': 'body', 'end_block_id': 'body', 'start': 0, 'end': 4, 'quote': 'Test'},
                              'body': 'Synthetic exact review'})
        manifest = rb.export(store, self.root / 'export'); self.assert_offline(manifest['snapshot'])
        destination = self.root / 'restored'
        rb.copy_instance_metadata(self.root, destination)
        shutil.copytree(self.root / 'resource-bundle', destination / 'resource-bundle')
        restored = Store(destination / '.runtime/review.sqlite3'); self.addCleanup(restored.close)
        rb.restore(restored, self.root / 'export')
        self.assertEqual(restored.comments(), store.comments())
        self.assertEqual(rb.database_identity(restored.db_path), manifest['database'])
        self.assertEqual(r.materialize(destination, 'candidate.json').read_bytes(), b'{"candidate":"synthetic"}')


    def test_wrong_declared_size_fails_before_promotion_catalog_switch(self):
        from review_desk.__main__ import main
        self.publish_json()
        value = json.loads(self.runtime_catalog.read_text())
        value['entries']['candidate.json']['bytes'] += 1
        r.atomic_json(self.runtime_catalog, value)
        r.freeze_catalog(self.root, self.catalog)
        before = (self.catalog.read_bytes(), self.runtime_catalog.read_bytes())
        with self.online(), patch.object(sys, 'argv', ['review_desk', '--instance', str(self.root), 'resource-promote']), self.assertRaises(ValueError):
            main()
        self.assertEqual(before, (self.catalog.read_bytes(), self.runtime_catalog.read_bytes()),
                         'failed promotion changed the original local catalog after accepting wrong declared size')

if __name__ == '__main__':
    unittest.main()
