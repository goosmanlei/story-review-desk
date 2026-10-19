"""Bounded browser signature reuse without caching ownership decisions."""
import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

from test_resource_cache import ResourceFixture, r
import test_resource_http as http_tests
from review_desk.server import ReviewHandler


class SignatureCacheTest(ResourceFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.relative, self.spec = self.add('signed')
        self.credentials = self.root / 'credentials.json'
        self.value = dict(project=self.config['project'], instance='local',
                          access_key_id='synthetic-id', access_key_secret='synthetic-secret')
        self.credentials.write_text(json.dumps(self.value))
        self.credentials.chmod(0o600)
        self.environment = patch.dict(os.environ, REVIEW_RESOURCES_OFFLINE='0',
                                      REVIEW_OSS_CREDENTIALS_FILE=str(self.credentials),
                                      REVIEW_RESOURCE_INSTANCE='local')
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.requests = []
        def presign(request, **options):
            self.requests.append(request)
            return SimpleNamespace(url='https://synthetic.invalid/signature-' + str(len(self.requests)))
        self.connection = patch.object(r, '_connection', return_value=SimpleNamespace(presign=presign))
        self.connection.start()
        self.addCleanup(self.connection.stop)
        r._signed_cache.clear()
        self.addCleanup(r._signed_cache.clear)

    def test_concurrent_hits_reuse_exact_signature_and_refresh_replaces_it(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            urls = list(pool.map(lambda _: r.signed_url(self.root, self.relative), range(24)))
        self.assertEqual(len(set(urls)), 1)
        self.assertEqual(len(self.requests), 1)
        refreshed = r.signed_url(self.root, self.relative, refresh=True)
        self.assertNotEqual(refreshed, urls[0])
        self.assertEqual(r.signed_url(self.root, self.relative), refreshed)

    def test_reuse_expires_before_signature_and_method_filename_are_separate(self):
        with patch.object(r.time, 'monotonic', return_value=100):
            first = r.signed_url(self.root, self.relative)
        with patch.object(r.time, 'monotonic', return_value=399):
            self.assertEqual(r.signed_url(self.root, self.relative), first)
        with patch.object(r.time, 'monotonic', return_value=400):
            self.assertNotEqual(r.signed_url(self.root, self.relative), first)
        values = [r.signed_url(self.root, self.relative, method='HEAD'),
                  r.signed_url(self.root, self.relative, download=True, filename='one.bin'),
                  r.signed_url(self.root, self.relative, download=True, filename='two.bin')]
        self.assertEqual(len(set(values)), 3)
        self.assertTrue(all(x.version_id == self.spec['version_id'] for x in self.requests))

    def test_warm_hit_rechecks_credential_rotation_permissions_and_ownership(self):
        first = r.signed_url(self.root, self.relative)
        self.value['access_key_secret'] = 'rotated-synthetic-secret'
        self.credentials.write_text(json.dumps(self.value))
        self.assertNotEqual(r.signed_url(self.root, self.relative), first)
        self.credentials.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private regular file'):
            r.signed_url(self.root, self.relative)
        self.credentials.chmod(0o600)
        with patch.dict(os.environ, REVIEW_RESOURCE_INSTANCE='vps'):
            with self.assertRaisesRegex(ValueError, 'another instance'):
                r.signed_url(self.root, self.relative)
        self.credentials.unlink()
        with self.assertRaises(FileNotFoundError):
            r.signed_url(self.root, self.relative)

    def test_warm_hit_rechecks_catalog_and_bounds_untrusted_filename_keys(self):
        r.signed_url(self.root, self.relative)
        for index in range(520):
            r.signed_url(self.root, self.relative, download=True, filename=str(index) + '.bin')
        self.assertEqual(len(r._signed_cache), 512)
        self.entries[self.relative]['key'] = 'another-project/originals/invalid'
        (self.root / 'config/resource-catalog.json').write_text(json.dumps({**self.config, 'entries': self.entries}))
        with self.assertRaisesRegex(ValueError, 'exact cloud version'):
            r.signed_url(self.root, self.relative)

    def test_browser_refresh_parameter_forces_new_signature(self):
        normal = http_tests.ResourceHttpTest.handler(self, '/api/production/files/original')
        refreshed = http_tests.ResourceHttpTest.handler(self, '/api/production/files/original?refresh=123')
        ReviewHandler._resource(normal, self.relative)
        ReviewHandler._resource(refreshed, self.relative)
        self.assertNotEqual(normal.response_headers['Location'], refreshed.response_headers['Location'])
        self.assertEqual(refreshed.response_headers['Cache-Control'], 'no-store')


if __name__ == '__main__':
    unittest.main()
