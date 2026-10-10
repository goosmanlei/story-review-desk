import gzip
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

from review_desk import production, read_cache, json_transport
from review_desk.store import Store
import test_generation as generation_tests
import test_entity_read_scope as scope_tests


class CachedGenerationTest(generation_tests.GenerationTest):
    """Run the actual import/accept/revoke/history tests through the cache."""
    def setUp(self):
        super().setUp()
        read_cache.attach(self.store)


class CachedEntityReadScopeTest(scope_tests.EntityReadScopeTest):
    def setUp(self):
        super().setUp()
        read_cache.attach(self.store)


class CacheTest(unittest.TestCase):
    def test_retired_table_tokens_are_removed_without_resetting_live_tokens(self):
        self.store.db.execute('CREATE TABLE retired_cache_fixture (id INTEGER)')
        self.store.db.commit()
        read_cache.initialize(self.store)
        before = dict(self.store.db.execute('SELECT name,token FROM read_generations'))
        self.store.db.execute('DROP TABLE retired_cache_fixture')
        self.store.db.commit()
        read_cache.initialize(self.store)
        after = dict(self.store.db.execute('SELECT name,token FROM read_generations'))
        self.assertEqual(after, {k: v for k, v in before.items() if k != 'retired_cache_fixture'})
        tables = {r[0] for r in self.store.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='read_generations'")}
        self.assertEqual(set(after), tables)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.store = Store(self.root/'.runtime/review.sqlite3')
        read_cache.attach(self.store)

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def test_transactional_invalidation_external_writer_rollback_and_restart(self):
        calls = []
        def reader():
            calls.append(True)
            return self.store.objects()
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'objects', reader), [])
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'objects', reader), [])
        self.assertEqual(len(calls), 1)
        old = read_cache.token(self.store)
        self.store.db.execute("INSERT INTO sources VALUES ('x','{}','x')")
        self.assertNotEqual(read_cache.token(self.store), old)
        self.store.db.rollback()
        self.assertEqual(read_cache.token(self.store), old)
        # A separate process need not import or call the caching module.
        subprocess.run([sys.executable, '-c',
            "from review_desk.store import Store; import sys; s=Store(sys.argv[1]); s.put_object('new','EPISODE',{'title':'new','blocks':[]}); s.close()",
            str(self.store.db_path)], check=True, capture_output=True)
        self.assertNotEqual(read_cache.token(self.store), old)
        with production.read_scope(self.store):
            result = read_cache.read_json(self.store, 'objects', reader)
        self.assertEqual(result[0]['id'], 'new')
        self.assertEqual(len(calls), 2)
        self.store.close()
        self.store = Store(self.root/'.runtime/review.sqlite3')
        read_cache.attach(self.store)
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'objects', lambda: self.fail('persisted cache was not reused')), result)

    def test_uncommitted_values_failures_and_instance_isolation(self):
        before = read_cache.token(self.store)
        self.store.db.execute("INSERT INTO sources VALUES ('uncommitted','{}','x')")
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'x', lambda: 'uncommitted'), 'uncommitted')
        self.store.db.rollback()
        self.assertEqual(read_cache.token(self.store), before)
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'x', lambda: 'committed'), 'committed')
            def failure():
                raise ValueError('read failed')
            with self.assertRaises(ValueError):
                read_cache.read_json(self.store, 'failure', failure)
            self.assertEqual(read_cache.read_json(self.store, 'failure', lambda: 'retry'), 'retry')
        other = Store(self.root/'other/.runtime/review.sqlite3')
        try:
            read_cache.attach(other)
            self.assertNotEqual(self.store.read_cache.namespace, other.read_cache.namespace)
            with production.read_scope(other):
                self.assertEqual(read_cache.read_json(other, 'x', lambda: 'other'), 'other')
        finally:
            other.close()

    def test_capacity_corruption_and_expired_filler(self):
        cache = read_cache.ReadCache(self.store, maximum=2000, entries=3)
        other = read_cache.ReadCache(self.store, maximum=2000, entries=3)
        try:
            for i in range(20):
                cache.put(str(i), bytes([i])*700)
            size, count = cache.db.execute('SELECT SUM(size),COUNT(*) FROM entries').fetchone()
            self.assertLessEqual(size, 2000)
            self.assertLessEqual(count, 3)
            self.assertLessEqual(cache.memory_bytes, 2000)
            cache.memory.clear()
            cache.memory_bytes = 0
            cache.db.execute("UPDATE entries SET body=x'00' WHERE key='19'")
            self.assertIsNone(cache.get('19'))
            with cache.lease('one') as owned:
                self.assertTrue(owned)
                with other.lease('one') as owned:
                    self.assertFalse(owned)
            cache.db.execute('INSERT INTO leases VALUES (?,?,?)', ('dead', 'gone', time.time()-1))
            with other.lease('dead') as owned:
                self.assertTrue(owned)
        finally:
            cache.close()
            other.close()

    def test_layout_change_invalidates_projection_without_database_write(self):
        (self.root/'config').mkdir()
        path = self.root/'config/entity-relationship-layout.json'
        path.write_text('{}')
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'layout', lambda: path.read_text()), '{}')
        path.write_text('{"primary":[]}')
        with production.read_scope(self.store):
            self.assertEqual(read_cache.read_json(self.store, 'layout', lambda: path.read_text()), '{"primary":[]}')

    def test_clear_reaches_live_connections_and_failed_cache_rebuilds(self):
        sibling = Store.open_existing(self.store.db_path)
        read_cache.attach(sibling, initialize_schema=False)
        try:
            with production.read_scope(sibling):
                self.assertEqual(read_cache.read_json(sibling, 'clear-me', lambda: 'before'), 'before')
            result = read_cache.manage(self.store, 'clear')
            self.assertEqual((result['entries'], result['bytes']), (0, 0))
            with production.read_scope(sibling):
                self.assertEqual(read_cache.read_json(sibling, 'clear-me', lambda: 'rebuilt'), 'rebuilt')
            sibling.read_cache.close()
            sibling.read_cache = None
            self.store.read_cache.close()
            cache_path = self.store.db_path.parent/'read-cache.sqlite3'
            cache_path.write_bytes(b'corrupt disposable fixture')
            damaged = read_cache.ReadCache(self.store)
            try:
                self.assertIsNone(damaged.db)
                self.store.read_cache = damaged
                with production.read_scope(self.store):
                    self.assertEqual(read_cache.read_json(self.store, 'authoritative', lambda: 'correct'), 'correct')
            finally:
                damaged.close()
                self.store.read_cache = None
            cache_path.unlink()
            read_cache.attach(self.store)
            with production.read_scope(self.store):
                self.assertEqual(read_cache.read_json(self.store, 'authoritative', lambda: 'correct'), 'correct')
        finally:
            sibling.close()

    def test_shared_process_lease_prevents_duplicate_fill(self):
        # Another process sees the very same entry namespace and lease. It does
        # not need shared Python objects or an invalidation message subscriber.
        cache = self.store.read_cache
        key = cache.key(read_cache.token(self.store), 'cross-process-fill')
        program = """
import json,sys
from review_desk.store import Store
from review_desk import read_cache
s=Store.open_existing(sys.argv[1]);read_cache.attach(s,initialize_schema=False)
with s.read_cache.lease(sys.argv[2]) as owned:
 print(json.dumps({'owned':owned,'body':(s.read_cache.get(sys.argv[2]) or b'').decode()}))
s.close()
"""
        cache.put(key, b'exact committed bytes')
        with cache.lease(key) as owned:
            self.assertTrue(owned)
            completed = subprocess.run([sys.executable, '-c', program, str(self.store.db_path), key],
                                       check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(completed.stdout), {'owned': False, 'body': 'exact committed bytes'})

    def test_transport_preserves_types_order_and_repeated_record_differences(self):
        value = {'a': [True, 1, 1.0, None, {'$': 1}, {'__proto__': {'x': 1}}], 'records': [
            {'id': 'r', 'object_id': 'o', 'payload': {'text': '中文'*100}},
            {'id': 'r', 'object_id': 'o', 'payload': {'text': '中文'*100}, 'candidate_number': 2}]}
        packed = json.loads(gzip.decompress(json_transport.encode(value, graph=True, compressed=True)))
        def unpack(node):
            if not isinstance(node, dict):
                return node
            kind, data = packed['nodes'][node['$']]
            if kind == 's': return data
            if kind == 'a': return [unpack(item) for item in data]
            return {key: unpack(item) for key, item in data}
        self.assertEqual(json.dumps(unpack(packed['root']), ensure_ascii=False), json.dumps(value, ensure_ascii=False))
