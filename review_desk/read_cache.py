"""Disposable, bounded read cache shared by local server processes.

Freshness is a token written in the authoritative transaction, never a TTL.
The cache has no business authority and every failure falls back to the reader.
"""
from collections import OrderedDict
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

SCHEMA = 1
MAX_BYTES = 128 * 1024 * 1024
MAX_ENTRY = 32 * 1024 * 1024
MAX_ENTRIES = 2048
L1_BYTES = 16 * 1024 * 1024
MAX_JSON = 64 * 1024 * 1024


def initialize(store):
    """Install journal tokens; no source rows, history or original files change."""
    if store.db.in_transaction:
        raise ValueError('read cache migration requires its own transaction')
    with store.db:
        store.db.execute('CREATE TABLE IF NOT EXISTS read_generations (name TEXT PRIMARY KEY, token TEXT NOT NULL)')
        tables = [r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='read_generations' ORDER BY name")]
        for table in tables:
            store.db.execute('INSERT OR IGNORE INTO read_generations VALUES (?,lower(hex(randomblob(16))))', (table,))
            quoted = '"'+table.replace('"', '""')+'"'
            literal = "'"+table.replace("'", "''")+"'"
            for operation in ('INSERT', 'UPDATE', 'DELETE'):
                name = 'read_generation_'+hashlib.sha256((table+operation).encode()).hexdigest()[:24]
                store.db.execute(f'CREATE TRIGGER IF NOT EXISTS "{name}" AFTER {operation} ON {quoted} '
                                 f'BEGIN UPDATE read_generations SET token=lower(hex(randomblob(16))) WHERE name={literal}; END')


def token(store, tables=None):
    values = [(r[0], r[1]) for r in store.db.execute('SELECT name,token FROM read_generations ORDER BY name')
              if tables is None or r[0] in tables]
    return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()


def source_version():
    digest = hashlib.sha256(str(SCHEMA).encode())
    root = Path(__file__).parent
    for path in sorted(root.glob('*.py')):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def layout_version(store):
    path = store.db_path.parent.parent / 'config/entity-relationship-layout.json'
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


class ReadCache:
    def __init__(self, store, *, maximum=MAX_BYTES, entries=MAX_ENTRIES, version=None):
        self.maximum, self.entries = maximum, entries
        self.path = store.db_path.parent / 'read-cache.sqlite3'
        identity = store.db_path.resolve().stat()
        self.identity = (identity.st_dev, identity.st_ino)
        self.namespace = hashlib.sha256(json.dumps([str(store.db_path.resolve()), *self.identity, version or source_version()]).encode()).hexdigest()
        self.db = None
        self.memory = OrderedDict()
        self.memory_bytes = 0
        self.hits = self.misses = self.failures = 0
        try:
            self.db = sqlite3.connect(self.path, timeout=.05, isolation_level=None)
            self.db.execute('PRAGMA auto_vacuum=INCREMENTAL')
            self.db.execute('PRAGMA journal_mode=DELETE')
            self.db.execute('PRAGMA synchronous=NORMAL')
            self.db.execute('PRAGMA journal_size_limit=1048576')
            self.db.execute(f'PRAGMA max_page_count={max(256, 2*maximum//4096)}')
            self.db.execute('CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, body BLOB NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, touched REAL NOT NULL)')
            self.db.execute('CREATE INDEX IF NOT EXISTS entries_lru ON entries(touched,key)')
            self.db.execute('CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, deadline REAL NOT NULL)')
        except sqlite3.Error:
            self.failures += 1
            if self.db:
                self.db.close()
            self.db = None

    def key(self, generation, identity):
        return hashlib.sha256(json.dumps([self.namespace, generation, identity], ensure_ascii=False,
                                          sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    def _remember(self, key, body):
        previous = self.memory.pop(key, None)
        if previous is not None:
            self.memory_bytes -= len(previous)
        if len(body) <= min(L1_BYTES, self.maximum):
            self.memory[key] = body
            self.memory_bytes += len(body)
        while self.memory and (self.memory_bytes > min(L1_BYTES, self.maximum) or len(self.memory) > self.entries):
            _, removed = self.memory.popitem(last=False)
            self.memory_bytes -= len(removed)

    def get(self, key):
        if key in self.memory:
            body = self.memory.pop(key)
            self.memory[key] = body
            self.hits += 1
            return body
        try:
            row = self.db.execute('SELECT body,digest FROM entries WHERE key=?', (key,)).fetchone() if self.db else None
            if row and hashlib.sha256(row[0]).hexdigest() == row[1]:
                self.db.execute('UPDATE entries SET touched=? WHERE key=? AND touched<?', (time.time(), key, time.time()-10))
                self._remember(key, row[0])
                self.hits += 1
                return row[0]
            if row:
                self.db.execute('DELETE FROM entries WHERE key=?', (key,))
        except sqlite3.Error:
            self.failures += 1
        self.misses += 1
        return None

    def put(self, key, body):
        if self.db is None or len(body) > min(MAX_ENTRY, self.maximum):
            return
        try:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?)',
                            (key, body, hashlib.sha256(body).hexdigest(), len(body), time.time()))
            size, count = self.db.execute('SELECT COALESCE(SUM(size),0),COUNT(*) FROM entries').fetchone()
            if size > self.maximum or count > self.entries:
                for old, length in self.db.execute('SELECT key,size FROM entries ORDER BY touched,key').fetchall():
                    if size <= self.maximum and count <= self.entries:
                        break
                    self.db.execute('DELETE FROM entries WHERE key=?', (old,))
                    size -= length
                    count -= 1
            self.db.execute('COMMIT')
            self.db.execute('PRAGMA incremental_vacuum(256)')
            self._remember(key, body)
        except sqlite3.Error:
            self.failures += 1
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')

    @contextmanager
    def lease(self, key):
        """One filler across processes, with finite crash recovery, no read lock."""
        owner = uuid.uuid4().hex
        acquired = self.db is None
        if self.db:
            try:
                self.db.execute('DELETE FROM leases WHERE deadline<?', (time.time(),))
                self.db.execute('INSERT OR IGNORE INTO leases VALUES (?,?,?)', (key, owner, time.time()+15))
                acquired = self.db.execute('SELECT owner FROM leases WHERE key=?', (key,)).fetchone()[0] == owner
            except sqlite3.Error:
                self.failures += 1
                acquired = True
        try:
            yield acquired
        finally:
            if acquired and self.db:
                try:
                    self.db.execute('DELETE FROM leases WHERE key=? AND owner=?', (key, owner))
                except sqlite3.Error:
                    self.failures += 1

    def close(self):
        self.memory.clear()
        self.memory_bytes = 0
        if self.db:
            self.db.close()


def attach(store, initialize_schema=True, version=None):
    if os.environ.get('REVIEW_READ_CACHE', '1') == '0':
        return
    if initialize_schema:
        initialize(store)
    store.read_cache = ReadCache(store, version=version)


def manage(store, action):
    """Operational status/clear; no original, comment or revision is deleted."""
    initialize(store)
    cache = ReadCache(store)
    try:
        if action == 'clear':
            # Logical invalidation reaches every live connection, including
            # its L1 and any filler finishing after this transaction commits.
            with store.db:
                store.db.execute('UPDATE read_generations SET token=lower(hex(randomblob(16)))')
            if cache.db:
                cache.db.execute('DELETE FROM entries')
                cache.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                cache.db.execute('PRAGMA incremental_vacuum')
        count, size = cache.db.execute('SELECT COUNT(*),COALESCE(SUM(size),0) FROM entries').fetchone() if cache.db else (0, 0)
        return {'cache': str(cache.path), 'available': cache.db is not None, 'entries': count,
                'bytes': size, 'maximum_bytes': cache.maximum, 'generation': token(store),
                'journal_mode': store.db.execute('PRAGMA journal_mode').fetchone()[0],
                'action': action}
    finally:
        cache.close()


def read_json(store, identity, reader):
    """Cache a successful projection from the request's exact read snapshot."""
    import zlib
    scope = getattr(store, '_production_reads', None)
    cache = getattr(store, 'read_cache', None)
    generation = scope.get('generation') if scope else None
    if not cache or not generation:
        return reader()
    key = cache.key(generation, ['projection', identity, layout_version(store)])
    raw = cache.get(key)
    if raw is not None:
        try:
            decoder = zlib.decompressobj()
            expanded = decoder.decompress(raw, MAX_JSON+1)
            if len(expanded) <= MAX_JSON and decoder.eof:
                return json.loads(expanded)
        except (ValueError, zlib.error):
            pass
    changes = store.db.total_changes
    value = reader()
    if store.db.total_changes == changes:
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        if len(raw) <= MAX_JSON:
            cache.put(key, zlib.compress(raw, 1))
    return value
