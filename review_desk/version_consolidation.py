"""Exact, read-only inventory for a one-time production version baseline.

Selection uses plan membership and verified originals, never UI defaults or
filenames. Plans contain identities and hashes, not discarded business text.
"""
from collections import defaultdict
import hashlib
import json
import sqlite3
from pathlib import Path

from .store import canonical, digest, Conflict
from . import material_archives, production as p
from .production_media import physical_file_hash


CORE_KINDS = ('ENTITY', 'STATE', 'AV_SHOT')
NOTICE = '此准确版本已删除；原引用不可用，请重新选择。'
TABLES = ('consolidation_revisions', 'consolidation_missing',
          'consolidation_objects', 'consolidation_runs')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS consolidation_revisions (
 revision_id TEXT PRIMARY KEY, object_id TEXT NOT NULL, kind TEXT NOT NULL,
 old_number INTEGER NOT NULL, new_number INTEGER, before_sha256 TEXT NOT NULL,
 after_sha256 TEXT, plan_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consolidation_missing (
 revision_id TEXT NOT NULL, path TEXT NOT NULL, target_object TEXT NOT NULL,
 target_revision TEXT NOT NULL, PRIMARY KEY(revision_id,path));
CREATE TABLE IF NOT EXISTS consolidation_runs (
 id TEXT PRIMARY KEY, inventory_sha256 TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consolidation_objects (
 object_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS consolidation_no_revision_resurrection BEFORE INSERT ON revisions
WHEN EXISTS (
 SELECT 1 FROM consolidation_revisions WHERE revision_id=NEW.id AND new_number IS NULL)
BEGIN SELECT RAISE(ABORT,'deleted revision cannot be restored'); END;
CREATE TRIGGER IF NOT EXISTS consolidation_no_object_resurrection BEFORE INSERT ON objects
WHEN EXISTS (SELECT 1 FROM consolidation_objects WHERE object_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'deleted object cannot be recreated'); END;
'''


def initialize(store):
    for name in ('consolidation_no_revision_resurrection','consolidation_no_object_resurrection'):
        row=store.db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",(name,)).fetchone()
        if row and 'material_model_migrating' in row[0]:store.db.execute('DROP TRIGGER '+name)
    store.db.executescript(SCHEMA)
    store.db.commit()


def available(store):
    return bool(store.db.execute("SELECT 1 FROM sqlite_master WHERE name='consolidation_revisions'").fetchone())


def deleted(store, revision_id):
    if not available(store):
        return None
    row = store.db.execute('SELECT * FROM consolidation_revisions WHERE revision_id=? AND new_number IS NULL', (revision_id,)).fetchone()
    return dict(row) if row else None


def missing_view(receipt, store=None):
    """A missing target is never the current revision of its old object."""
    kind = receipt['kind']
    owner = receipt['object_id'] if kind == 'ENTITY' else None
    if store is not None and kind == 'STATE':
        row = store.db.execute("SELECT json_extract(r.payload,'$.entity.object_id') FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.id=?",(receipt['object_id'],)).fetchone()
        owner = row[0] if row else None
    retired = kind in ('JUDGMENT', 'REPRESENTATION')
    comments = []
    if retired and store is not None:
        for row in store.db.execute("SELECT DISTINCT comment_id FROM comment_events WHERE action='HISTORY_IMPORT' AND json_extract(body,'$.source_revision')=?", (receipt['revision_id'],)):
            comments.append(store.comment(row[0]))
    return {'id': receipt['revision_id'], 'object_id': receipt['object_id'], 'kind': kind,
            'version': receipt['old_number'], 'current_revision': None, 'created_at': '',
            'retired_review': retired, 'history_comments': comments,
            'owner_object_id': owner,
            'cleaned_target': True, 'unavailable': True, 'material_round_numbers': {},
            'payload': {'format': 'version-deletion-receipt-v1', 'title': '此审批记录已退役；有实际内容的历史意见保存在原准确内容的评论中。' if retired else NOTICE,
                        'blocks': [], 'sources': [], 'entities': [], 'states': [], 'inputs': [],
                        'components': [], 'facts': [], 'choices': [], 'unknowns': [],
                        'status': 'unavailable', 'placeholder': True}}


def row_hash(object_id, version, payload):
    return digest(canonical({'object_id': object_id, 'version': version, 'payload': payload}).encode())


def new_identity(store, object_id, version, payload):
    from .production_current import enabled, address
    if enabled(store) and payload.get('format', '').startswith('production-'):
        return address(object_id)
    epoch = None
    if available(store):
        row = store.db.execute('SELECT plan_id FROM consolidation_revisions WHERE object_id=? AND new_number IS NOT NULL LIMIT 1', (object_id,)).fetchone()
        epoch = row[0] if row else None
    value = {'object_id': object_id, 'version': version, 'payload': payload}
    if epoch:
        value['baseline'] = epoch
    return digest(canonical(value).encode())


def valid_identity(store, object_id, version, payload, revision_id):
    from .production_current import valid_record, enabled, RECORD_KINDS
    if enabled(store):
        obj=store.db.execute('SELECT kind FROM objects WHERE id=?',(object_id,)).fetchone()
        if obj and obj[0] in RECORD_KINDS:
            return valid_record(store, object_id, version, payload, revision_id)
    if available(store):
        row = store.db.execute('SELECT object_id,new_number,after_sha256 FROM consolidation_revisions WHERE revision_id=?', (revision_id,)).fetchone()
        if row:
            return row[0] == object_id and row[1] == version and row[2] == row_hash(object_id, version, payload)
    # Unchanged historical rows keep their original content identity even when
    # a different row of the same object needed reference repair. New writes
    # use the baseline salt; an explicit deletion receipt above always wins.
    return revision_id in (row_hash(object_id, version, payload),
                           new_identity(store, object_id, version, payload))





def verify_row(row, receipt):
    if receipt['new_number'] is None or row['object_id'] != receipt['object_id'] or row['version'] != receipt['new_number'] or row_hash(row['object_id'], row['version'], json.loads(row['payload'])) != receipt['after_sha256']:
        raise ValueError('consolidated revision checksum mismatch')


def preserved(store, object_id, payload):
    if not available(store):
        return False
    for row in store.db.execute('SELECT * FROM consolidation_revisions WHERE object_id=? AND new_number IS NOT NULL', (object_id,)):
        if row_hash(object_id, row['new_number'], payload) == row['after_sha256']:
            return True
    return False


def guard_write(store, object_id, payload):
    if not available(store):
        return
    if not store.db.execute('SELECT 1 FROM objects WHERE id=?', (object_id,)).fetchone() and store.db.execute('SELECT 1 FROM consolidation_revisions WHERE object_id=?', (object_id,)).fetchone():
        raise Conflict('deleted object identity cannot be recreated')
    for path, ref in p.references(payload, include_unavailable=True):
        if ref.get('unavailable') or deleted(store, ref['revision_id']):
            if retained_call_reference(store, object_id, path, ref):
                continue
            raise Conflict(NOTICE)


def retained_call_reference(store, object_id, path, ref):
    """Only an unchanged retired approval reference in a real old CALL survives.

    validate_call independently checks all frozen execution fields. This is not
    permission for a new call to consume a deleted record.
    """
    receipt = deleted(store, ref.get('revision_id'))
    if not receipt or receipt['kind'] not in ('JUDGMENT', 'REPRESENTATION') or receipt['object_id'] != ref.get('object_id'):
        return False
    row = store.db.execute("SELECT r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.id=? AND o.kind='CALL'", (object_id,)).fetchone()
    if not row or not store.db.execute("SELECT 1 FROM revisions WHERE object_id=? AND json_extract(payload,'$.status') IN ('submitted','completed','failed','unknown')", (object_id,)).fetchone():
        return False
    return dict(p.references(json.loads(row[0]), include_unavailable=True)).get(path) == ref


def preserve_call_references(store, object_id, revision_id, version, payload):
    refs = [(path,ref) for path,ref in p.references(payload) if retained_call_reference(store, object_id, path, ref)]
    if not refs:
        return
    plan_id = deleted(store, refs[0][1]['revision_id'])['plan_id']
    raw = canonical(payload)
    store.db.execute('INSERT INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
        (revision_id,object_id,'CALL',version,version,digest(raw.encode()),row_hash(object_id,version,payload),plan_id))
    store.db.executemany('INSERT INTO consolidation_missing VALUES (?,?,?,?)',
        [(revision_id,path,ref['object_id'],ref['revision_id']) for path,ref in refs])


def dump(store):
    if not available(store):
        return {}
    return {t: [dict(r) for r in store.db.execute('SELECT * FROM '+t+' ORDER BY 1,2')]
            for t in TABLES}


def ledger_hash(data):
    return digest(canonical({t: data.get(t, []) for t in TABLES}).encode())


def guard_restore(store, data):
    path = p.root_of(store)/'config/instance.json'
    policy = json.loads(path.read_text()).get('version_consolidation_policy') if path.exists() else None
    if policy and (policy.get('format') != 'version-consolidation-policy-v1' or
                   policy.get('ledger_sha256') != ledger_hash(data or {})):
        raise Conflict('pre-consolidation export is not an effective recovery source')


def restore(store, data):
    for table in TABLES:
        columns = [r['name'] for r in store.db.execute('PRAGMA table_info('+table+')')]
        for row in (data or {}).get(table, []):
            if set(row) != set(columns):
                raise ValueError('invalid consolidation receipt columns')
            store.db.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in columns)+')', tuple(row[c] for c in columns))























def _delete_ids(store, table, field, values):
    store.db.executemany('DELETE FROM '+table+' WHERE '+field+'=?', ((v,) for v in values))


def file_references(value):
    """Only explicit local asset references; never infer files from prose."""
    if isinstance(value, dict):
        for key,item in value.items():
            if isinstance(item,str) and key in ('file','filename','input_file','source_file'):
                part = Path(item)
                if item.startswith('export/assets/'):
                    if len(part.parts) != 3 or '..' in part.parts:
                        raise ValueError('unsafe retained original path')
                    yield part.name
                elif not part.is_absolute() and len(part.parts) == 1 and len(part.stem) == 64 and all(c in '0123456789abcdef' for c in part.stem):
                    yield part.name
            yield from file_references(item)
    elif isinstance(value,list):
        for item in value:yield from file_references(item)


def collect_content(store):
    """Mark exact roots and sweep unreferenced immutable nodes, one node at a time."""
    import base64
    import zlib
    nodes = {r[0] for r in store.db.execute('SELECT id FROM material_content')}
    def keys(value):
        if isinstance(value,dict):
            for v in value.values():yield from keys(v)
        elif isinstance(value,list):
            for v in value:yield from keys(v)
        elif isinstance(value,str) and value in nodes:yield value
    roots = set()
    for r in store.db.execute('SELECT payload AS stored_payload FROM revisions'):
        roots.update(keys(json.loads(r[0])))
    for r in store.db.execute('SELECT container FROM material_archive_files'):
        roots.update(keys(json.loads(r[0])))
    marked = set();todo = list(roots)
    while todo:
        key = todo.pop()
        if key in marked:continue
        body = store.db.execute('SELECT body FROM material_content WHERE id=?',(key,)).fetchone()[0]
        if digest(body.encode()) != key:raise ValueError('corrupt shared content')
        value = json.loads(body)
        if 'archive_recipe_zlib' in value:
            value = json.loads(zlib.decompress(base64.b64decode(value['archive_recipe_zlib'],validate=True)))
        marked.add(key);todo.extend(keys(value))
    removed = nodes-marked
    size = sum(store.db.execute('SELECT length(CAST(body AS BLOB)) FROM material_content WHERE id=?',(key,)).fetchone()[0] for key in removed)
    _delete_ids(store,'material_content','id',removed)
    return {'removed_content_nodes':len(removed),'removed_content_bytes':size,'retained_shared_nodes':len(marked)}
