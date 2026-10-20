"""Independent synthetic probes; no network, credentials, or formal data."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from review_desk import resources as r


class ResourceReservationReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='resource-cache-review-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'config').mkdir()
        self.config = dict(format=r.FORMAT, provider='oss', instance_id='review-cache',
                           project='review-cache', bucket='review-cache-bucket',
                           region='cn-hongkong', cache_bytes=100)
        (self.root / 'config/instance.json').write_text(json.dumps({'id': 'review-cache'}))
        (self.root / 'config/resource-storage.json').write_text(json.dumps(self.config))
        self.entries, self.bodies = {}, {}
        for label in ('a', 'b'):
            data = label.encode() * 40
            sha = hashlib.sha256(data).hexdigest()
            self.bodies[sha] = data
            self.entries['export/assets/' + label + '.bin'] = dict(
                sha256=sha, verified_sha256=sha, bytes=40, key='review-cache/' + sha,
                version_id=label, mime='application/octet-stream')
        (self.root / 'config/resource-catalog.json').write_text(json.dumps({**self.config, 'entries': self.entries}))
        self.environment = patch.dict(os.environ, REVIEW_RESOURCES_OFFLINE='0')
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_pending_reservation_cannot_spend_the_same_disk_headroom(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def download(connection, config, spec, destination):
            calls.append(spec['version_id'])
            entered.set()
            if not release.wait(5):
                raise RuntimeError('synthetic transfer was not released')
            destination.write(self.bodies[spec['sha256']])
        with patch.object(r, 'client', return_value=None), \
                patch.object(r, '_remote_hash', side_effect=download), \
                patch('shutil.disk_usage', return_value=SimpleNamespace(free=64 * 1024 ** 2 + 50)):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(r.materialize, self.root, 'export/assets/a.bin')
                try:
                    self.assertTrue(entered.wait(2))
                    second = pool.submit(r.materialize, self.root, 'export/assets/b.bin')
                    with self.assertRaisesRegex(ValueError, 'disk headroom'):
                        second.result(timeout=2)
                    reservations = [json.loads(p.read_text()) for p in r._cache_dir(self.root).glob('*.reserve')]
                    self.assertEqual(sum(v['bytes'] for v in reservations), 40)
                    self.assertEqual(calls, ['a'])
                finally:
                    release.set()
                self.assertEqual(first.result(timeout=2).read_bytes(), b'a' * 40)

    def test_if_range_head_rechecks_a_previously_available_exact_version(self):
        spec = self.entries['export/assets/a.bin']
        class Missing(Exception):
            status_code = 404
        calls = []
        def head(request):
            calls.append((request.key, request.version_id))
            if len(calls) > 1:
                raise Missing()
            return SimpleNamespace(content_length=40, etag='"synthetic-etag"')
        sdk = SimpleNamespace(HeadObjectRequest=lambda **kwargs: SimpleNamespace(**kwargs))
        connection = SimpleNamespace(head_object=head)
        with patch.dict(sys.modules, alibabacloud_oss_v2=sdk), \
                patch.object(r, '_credentials', return_value=(None, 'synthetic-credential-identity')), \
                patch.object(r, '_connection', return_value=connection), \
                patch.object(r, 'client', return_value=connection):
            self.assertEqual(r.remote_etag(self.root, spec), '"synthetic-etag"')
            with self.assertRaisesRegex(ValueError, 'status 404'):
                r.remote_etag(self.root, spec)
        self.assertEqual(calls, [(spec['key'], spec['version_id'])] * 2)

    def test_different_small_object_finishes_while_large_transfer_is_blocked(self):
        self.config['cache_bytes'] = 2 * 1024 ** 2
        (self.root / 'config/resource-storage.json').write_text(json.dumps(self.config))
        for label, data in (('a', b'a' * 1024 ** 2), ('b', b'small')):
            sha = hashlib.sha256(data).hexdigest()
            self.bodies[sha] = data
            self.entries['export/assets/' + label + '.bin'].update(
                sha256=sha, verified_sha256=sha, bytes=len(data), key='review-cache/' + sha)
        (self.root / 'config/resource-catalog.json').write_text(json.dumps({**self.config, 'entries': self.entries}))
        entered, release = threading.Event(), threading.Event()
        def download(connection, config, spec, destination):
            if spec['version_id'] == 'a':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('synthetic transfer was not released')
            destination.write(self.bodies[spec['sha256']])
        with patch.object(r, 'client', return_value=None), patch.object(r, '_remote_hash', side_effect=download):
            with ThreadPoolExecutor(max_workers=2) as pool:
                large = pool.submit(r.materialize, self.root, 'export/assets/a.bin')
                try:
                    self.assertTrue(entered.wait(2))
                    small = pool.submit(r.materialize, self.root, 'export/assets/b.bin')
                    self.assertEqual(small.result(timeout=2).read_bytes(), b'small')
                    self.assertFalse(large.done())
                finally:
                    release.set()
                self.assertEqual(large.result(timeout=2).stat().st_size, 1024 ** 2)

    def test_same_object_has_one_download_for_concurrent_callers(self):
        entered, release, second_started = threading.Event(), threading.Event(), threading.Event()
        calls = []
        def download(connection, config, spec, destination):
            calls.append(spec['version_id'])
            entered.set()
            if not release.wait(5):
                raise RuntimeError('synthetic transfer was not released')
            destination.write(self.bodies[spec['sha256']])
        def second_read():
            second_started.set()
            return r.materialize(self.root, 'export/assets/a.bin')
        with patch.object(r, 'client', return_value=None), patch.object(r, '_remote_hash', side_effect=download):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(r.materialize, self.root, 'export/assets/a.bin')
                try:
                    self.assertTrue(entered.wait(2))
                    second = pool.submit(second_read)
                    self.assertTrue(second_started.wait(2))
                finally:
                    release.set()
                self.assertEqual(first.result(timeout=2), second.result(timeout=2))
                self.assertEqual(first.result().read_bytes(), b'a' * 40)
        self.assertEqual(calls, ['a'])

    def test_cancel_and_download_failure_clean_reservations_and_allow_retry(self):
        from review_desk.production import ReadCancelled
        for label, cancel in (('a', True), ('b', False)):
            with self.subTest(cancel=cancel):
                interrupted = threading.Event()
                def check():
                    if interrupted.is_set():
                        raise ReadCancelled('synthetic disconnected reader')
                def broken_download(connection, config, spec, destination):
                    destination.write(self.bodies[spec['sha256']][:5])
                    if cancel:
                        interrupted.set()
                        r._check_cancel()
                    raise RuntimeError('synthetic transfer failed')
                relative = 'export/assets/' + label + '.bin'
                spec = self.entries[relative]
                with patch.object(r, 'client', return_value=None), \
                        patch.object(r, '_remote_hash', side_effect=broken_download):
                    with self.assertRaises(ReadCancelled if cancel else RuntimeError):
                        with r.lease_scope(check):
                            r.materialize(self.root, relative)
                cache = r._cache_dir(self.root)
                self.assertEqual(list(cache.glob('*.part')), [])
                self.assertEqual(list(cache.glob('*.reserve')), [])
                self.assertFalse((cache / (spec['sha256'] + '.bin')).exists())
                with patch.object(r, 'client', return_value=None), \
                        patch.object(r, '_remote_hash', side_effect=lambda c, co, s, out: out.write(self.bodies[s['sha256']])):
                    self.assertEqual(r.materialize(self.root, relative).read_bytes(), label.encode() * 40)

    def test_orphan_reservation_is_recovered_but_unknown_partial_is_preserved(self):
        cache = r._cache_dir(self.root)
        target = self.entries['export/assets/a.bin']['sha256'] + '.bin'
        program = ('import fcntl,json,os,sys;from pathlib import Path;'
            'cache=Path(sys.argv[1]);name=sys.argv[2];'
            'lock=(cache/(name+".lock")).open("a");fcntl.flock(lock,fcntl.LOCK_EX);'
            '(cache/(name+".part")).write_bytes(b"interrupted");'
            '(cache/(name+".reserve")).write_text(json.dumps({"target":name,"bytes":40}));'
            'os._exit(0)')
        subprocess.run([sys.executable, '-c', program, str(cache), target], check=True, timeout=5)
        unknown = cache / 'unknown-owner.part'
        unknown.write_bytes(b'keep')
        # The child exited without cleanup. Its operating-system lock is now
        # gone; the next resolver must reclaim only that exact reservation.
        with patch.object(r, 'client', return_value=None), \
                patch.object(r, '_remote_hash', side_effect=lambda c, co, s, out: out.write(self.bodies[s['sha256']])):
            self.assertEqual(r.materialize(self.root, 'export/assets/b.bin').read_bytes(), b'b' * 40)
        self.assertFalse((cache / (target + '.part')).exists())
        self.assertFalse((cache / (target + '.reserve')).exists())
        self.assertEqual(unknown.read_bytes(), b'keep')


class DeletionReceiptReviewTest(unittest.TestCase):
    def test_rollback_cross_process_commit_restart_and_other_instance(self):
        from review_desk.store import Store
        from review_desk import read_cache, candidate_reset as reset
        from review_desk.server import ReviewHandler
        with tempfile.TemporaryDirectory(prefix='deletion-receipt-review-') as tmp:
            root = Path(tmp)
            store = Store(root / '.runtime/review.sqlite3')
            name = 'a' * 64 + '.png'
            body = dict(format=reset.FORMAT, erased_files={name: {'sha256': 'a' * 64}}, assets=[])
            def media_status(current_store):
                handler = SimpleNamespace(path='/api/production/files/' + name,
                    server=SimpleNamespace(store=current_store, web_assets=SimpleNamespace(serve=lambda *args: False)),
                    _json=lambda value, status=200: status, _resource=lambda *args: 200)
                return ReviewHandler._get(handler)
            try:
                read_cache.attach(store)
                self.assertEqual(media_status(store), 200)
                store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)',
                                 ('uncommitted', 'synthetic', json.dumps(body)))
                self.assertEqual(media_status(store), 410)
                store.db.rollback()
                self.assertEqual(media_status(store), 200)
                program = ('import sys;from review_desk.store import Store;'
                    's=Store.open_existing(sys.argv[1]);'
                    's.db.execute("INSERT INTO production_current_operations VALUES (?,?,?)",'
                    '("committed","synthetic",sys.argv[2]));s.db.commit();s.close()')
                subprocess.run([sys.executable, '-c', program, str(store.db_path), json.dumps(body)],
                               check=True, timeout=5)
                self.assertEqual(media_status(store), 410)
            finally:
                store.close()
            store = Store(root / '.runtime/review.sqlite3')
            other = Store(root / 'other/.runtime/review.sqlite3')
            try:
                read_cache.attach(store)
                read_cache.attach(other)
                self.assertEqual(media_status(store), 410)
                self.assertEqual(media_status(other), 200)
            finally:
                store.close()
                other.close()


if __name__ == '__main__':
    unittest.main()
