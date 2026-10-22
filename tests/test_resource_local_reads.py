"""Read-source policies with synthetic bytes and an instrumented OSS transport."""
import hashlib
import json
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_resource_cache import ResourceFixture
from review_desk import resources as r, resource_bundle as rb


class ResourceLocalReadTest(ResourceFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        env = patch.dict(os.environ, REVIEW_RESOURCES_OFFLINE='0', REVIEW_RESOURCE_READ_POLICY='local-first')
        env.start()
        self.addCleanup(env.stop)
        self.source = self.root / 'source-instance'
        (self.source / 'config').mkdir(parents=True)
        (self.source / 'resource-bundle').mkdir()
        for name in ('instance.json', 'resource-storage.json'):
            shutil.copyfile(self.root / 'config' / name, self.source / 'config' / name)
        r.set_local_sources(self.root, [self.source])

    def move_to_source(self, spec):
        shutil.move(self.root / 'resource-bundle' / spec['sha256'], self.source / 'resource-bundle' / spec['sha256'])

    def transport(self, bodies, denied=()):
        calls = []
        class Body:
            def __init__(self, data):
                self.data, self.closed = data, False
            def iter_bytes(self, chunk_size):
                yield self.data[:3]
                yield self.data[3:]
            def close(self):
                self.closed = True
        def get(request):
            calls.append((request.key, request.version_id))
            if request.version_id in denied:
                raise PermissionError('synthetic denied exact version')
            data, mime = bodies[request.version_id]
            return SimpleNamespace(body=Body(data), content_type=mime)
        return SimpleNamespace(get_object=get), calls

    def test_empty_cache_reuses_all_local_sources_and_repairs_corrupt_cache(self):
        relative, spec = self.add('reuse')
        self.move_to_source(spec)
        cache = r._cache_dir(self.root) / (spec['sha256'] + '.bin')
        with patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
            for corrupt in (False, True):
                if corrupt:
                    cache.write_bytes(b'X' * spec['bytes'])
                with r.read_scope('local-only'), r.read_statistics() as counts:
                    self.assertEqual(r.materialize(self.root, relative).read_bytes(), b'exact-synthetic')
                    self.assertEqual(r.materialize(self.root, relative), cache)
                self.assertEqual(counts['oss_gets'], 0)
                self.assertEqual(counts['source_copies'], 1)

    def test_new_task_inherits_registered_recovery_sources(self):
        relative, spec = self.add('inherited')
        self.move_to_source(spec)
        parent = self.root / 'parent-instance'
        (parent / 'config').mkdir(parents=True)
        for name in ('instance.json', 'resource-storage.json'):
            shutil.copyfile(self.root / 'config' / name, parent / 'config' / name)
        r.set_local_sources(parent, [self.source])
        r.set_local_sources(self.root, [parent])
        with r.read_scope('local-only'), patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
            self.assertEqual(r.materialize(self.root, relative).read_bytes(), b'exact-synthetic')
            with self.assertRaisesRegex(ValueError, 'cannot enable'):
                with r.read_scope('remote'):
                    pass

    def test_missing_original_derivative_and_snapshot_fetch_only_exact_missing_bytes(self):
        for category in ('original', 'derivative', 'snapshot'):
            with self.subTest(category=category):
                relative, spec = self.add(category, category.encode())
                (self.root / 'resource-bundle' / spec['sha256']).unlink()
                connection, calls = self.transport({spec['version_id']: (category.encode(), spec['mime'])})
                with r.read_scope('local-only'), patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
                    with self.assertRaisesRegex(FileNotFoundError, spec['sha256']):
                        r.materialize(self.root, relative, spec=spec)
                with patch.object(r, 'client', return_value=connection), r.read_statistics() as counts:
                    self.assertEqual(r.materialize(self.root, relative, spec=spec).read_bytes(), category.encode())
                    r.materialize(self.root, relative, spec=spec)
                self.assertEqual(calls, [(spec['key'], spec['version_id'])])
                self.assertEqual((counts['oss_gets'], counts['oss_bytes']), (1, spec['bytes']))

    def test_same_size_wrong_sha_and_stale_same_name_do_not_pass_local_check(self):
        relative, spec = self.add('wrong', b'right')
        (self.root / 'resource-bundle' / spec['sha256']).write_bytes(b'wrong')
        (self.root / relative).parent.mkdir(parents=True)
        (self.root / relative).write_bytes(b'older')
        with r.read_scope('local-only'), patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
            with self.assertRaisesRegex(ValueError, 'corrupt'):
                r.materialize(self.root, relative)
        self.assertEqual(list(r._cache_dir(self.root).glob('*.part')), [])

    def test_offline_and_medium_checks_reject_missing_bytes_with_warm_cache(self):
        relative, spec = self.add('medium')
        r.materialize(self.root, relative)
        self.move_to_source(spec)
        with patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
            with patch.dict(os.environ, REVIEW_RESOURCES_OFFLINE='1'):
                with self.assertRaisesRegex(FileNotFoundError, spec['sha256']):
                    r.materialize(self.root, relative)
            with r.read_scope('local-only', medium_only=True):
                with self.assertRaises(FileNotFoundError):
                    r.materialize(self.root, relative)

    def test_remote_verification_retains_cold_bytes_but_never_substitutes_a_version(self):
        relative, spec = self.add('remote', b'remote bytes')
        (self.root / 'resource-bundle' / spec['sha256']).unlink()
        connection, calls = self.transport({spec['version_id']: (b'remote bytes', spec['mime'])}, denied=('denied',))
        original_time = spec.get('verified_at')
        with patch.object(r, 'client', return_value=connection), r.read_statistics() as counts:
            receipt = r.verify_remote(self.root, spec, relative=relative)
            self.assertEqual(r.materialize(self.root, relative).read_bytes(), b'remote bytes')
            denied = {**spec, 'version_id': 'denied'}
            with r.read_scope('local-only'):
                self.assertTrue(r.materialize(self.root, relative, spec=denied).is_file())
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                r.verify_remote(self.root, denied, relative=relative)
        self.assertEqual(calls, [(spec['key'], spec['version_id']), (spec['key'], 'denied')])
        self.assertEqual(counts['oss_bytes'], spec['bytes'])
        self.assertEqual(spec.get('verified_at'), original_time)
        self.assertEqual(receipt['version_id'], spec['version_id'])
        self.assertEqual(receipt['verification'], 'full-remote-sha256')

    def test_strict_policy_blocks_explicit_cloud_entry(self):
        relative, spec = self.add('blocked')
        with r.read_scope('local-only'), patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
            with self.assertRaisesRegex(ValueError, 'disabled'):
                r.verify_remote(self.root, spec, relative=relative)

    def test_catalog_checks_variants_and_rejects_conflicts_before_fetching(self):
        relative, spec = self.add('catalog')
        derivative, derived = self.add('waveform', b'waveform')
        catalog = {**self.config, 'entries': {relative: {**spec, 'variants': {'waveform': derived}}}}
        self.move_to_source(derived)
        with patch.object(r, 'client', side_effect=AssertionError('network forbidden')):
            self.assertEqual(rb.verify_catalog(self.root, catalog, mode='local-only'), 2)
            self.assertFalse((self.root / '.runtime/resource-cache').exists(), 'complete verification copied a full local mirror')
            bad = {**spec, 'bytes': spec['bytes'] + 1}
            catalog['entries']['conflicting.bin'] = bad
            with self.assertRaisesRegex(ValueError, 'conflicting'):
                rb.verify_catalog(self.root, catalog)


if __name__ == '__main__':
    unittest.main()
