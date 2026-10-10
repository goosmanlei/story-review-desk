"""Explicit removal of retired audiovisual prose, with exact identity receipts.

Material plans and calls retain their immutable payloads. Historical composition
and relationship revisions keep their locators and executable facts; receipts
attest the reduced payload without retaining the removed text.
"""
import json
from .store import canonical, digest, Conflict
from .audiovisual import KINDS, READING_CONTRACT, RETIRED_FIELDS

RELATION_FIELDS = {'purpose', 'preserve', 'change', 'check', 'blocks', 'title'}
AV_FIELDS = RETIRED_FIELDS | {'purpose', 'blocks', 'authoring'}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS audiovisual_cleanup_receipts (
 revision_id TEXT PRIMARY KEY REFERENCES revisions(id), object_id TEXT NOT NULL,
 kind TEXT NOT NULL, original_sha256 TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
 facts_sha256 TEXT NOT NULL, removed_fields TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audiovisual_cleanup_runs (
 id TEXT PRIMARY KEY, object_ids TEXT NOT NULL, deleted_decisions TEXT NOT NULL);
'''
TABLES = ('audiovisual_cleanup_receipts', 'audiovisual_cleanup_runs')
COLUMNS = {
    TABLES[0]: ('revision_id','object_id','kind','original_sha256','payload_sha256','facts_sha256','removed_fields'),
    TABLES[1]: ('id','object_ids','deleted_decisions'),
}


def facts(kind, payload):
    removed = RELATION_FIELDS if kind == 'MATERIAL_RELATION' else AV_FIELDS
    return {k: v for k, v in payload.items()
            if k not in removed | {'retired_design_text', 'explanation_policy'}}


def cleaned(kind, payload):
    if kind == 'MATERIAL_RELATION':
        return {**facts(kind, payload), 'title': '素材输入关系', 'blocks': [],
                'explanation_policy': 'executable-only-v1'}
    # New purposes and state/product relationships are actual new revisions,
    # never presented as the prose of an earlier production execution.
    return {**facts(kind, payload), 'blocks': [], 'retired_design_text': True}


def verify_row(row, receipt):
    payload = json.loads(row['payload'])
    if (receipt['kind'] not in KINDS | {'MATERIAL_RELATION'}
            or row['id'] != receipt['revision_id'] or row['object_id'] != receipt['object_id']
            or payload != cleaned(receipt['kind'], payload)
            or digest(canonical(payload).encode()) != receipt['payload_sha256']
            or digest(canonical(facts(receipt['kind'], payload)).encode()) != receipt['facts_sha256']):
        raise ValueError('audiovisual cleanup receipt mismatch')


def dump(store):
    return {table: [dict(r) for r in store.db.execute('SELECT * FROM '+table+' ORDER BY 1')]
            for table in TABLES}


def restore(store, framework):
    for table in TABLES:
        for row in framework.get(table, []):
            columns = ','.join(COLUMNS[table])
            store.db.execute('INSERT INTO '+table+' ('+columns+') VALUES ('+
                             ','.join('?' for _ in COLUMNS[table])+')', tuple(row[k] for k in COLUMNS[table]))


def policy_ids(store):
    path = store.db_path.parent.parent/'config/instance.json'
    config = json.loads(path.read_text()) if path.exists() else {}
    return set(config.get('audiovisual_reading_policy', {}).get('object_ids', []))


def guard_restore(store, framework):
    expected = policy_ids(store)
    actual = {oid for run in (framework or {}).get('audiovisual_cleanup_runs', [])
              for oid in json.loads(run['object_ids'])}
    if not expected <= actual:
        raise Conflict('pre-cleanup audiovisual export cannot restore this instance')


def guard_write(store, object_id, kind, payload):
    retired = policy_ids(store)
    retired.update(oid for run in store.db.execute('SELECT object_ids FROM audiovisual_cleanup_runs')
                   for oid in json.loads(run[0]))
    # Once enabled, new audiovisual objects must also use the new contract.
    if kind in KINDS and retired and payload.get('reading_contract') != READING_CONTRACT:
        raise Conflict('retired audiovisual prose cannot be reimported')
    context = payload.get('context', {}).get('object_id')
    context_row = store.db.execute('SELECT kind FROM objects WHERE id=?', (context,)).fetchone() if context else None
    if kind == 'MATERIAL_RELATION' and retired and (context in retired or context_row and context_row['kind'] in KINDS):
        if payload.get('explanation_policy') != 'executable-only-v1' or (RELATION_FIELDS-{'title','blocks'}).intersection(payload):
            raise Conflict('retired material relationship explanations cannot be reimported')


def plan(store, object_ids):
    from . import production as p
    selected = set(object_ids)
    heads = {r['object_id']: r['id'] for r in p.current_records(store, KINDS) if r['object_id'] in selected}
    if selected != set(heads):
        raise ValueError('cleanup requires exact existing audiovisual objects')
    revisions, decisions, affected = [], [], set()
    for raw in store.db.execute("SELECT r.*,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind IN ('AV_EPISODE','AV_SCENE','AV_SHOT','MATERIAL_RELATION','JUDGMENT') ORDER BY r.object_id,r.version"):
        row = dict(raw); value = json.loads(row['payload']); kind = row['kind']
        if kind == 'JUDGMENT':
            if value.get('acceptance_model') == 'production-content-v1' and value.get('target', {}).get('object_id') in selected:
                decisions.append({'object_id': row['object_id'], 'revision_id': row['id'], 'payload_sha256': digest(row['payload'].encode())})
                affected.add(row['id'])
            continue
        applies = row['object_id'] in selected if kind in KINDS else value.get('context', {}).get('object_id') in selected
        if not applies or value.get('reading_contract') == READING_CONTRACT or value == cleaned(kind, value):
            continue
        removed = sorted((RELATION_FIELDS if kind == 'MATERIAL_RELATION' else AV_FIELDS).intersection(value))
        revisions.append({'object_id': row['object_id'], 'revision_id': row['id'], 'kind': kind,
                          'payload_sha256': digest(row['payload'].encode()), 'removed_fields': removed})
        affected.add(row['id'])
    comments = [c for c in store.comments() if c['target_revision_id'] in affected]
    # A future comment needs an explicit re-anchor plan. Never silently delete or
    # make its quoted wording unreviewable based on an earlier zero count.
    if comments:
        raise Conflict('new comments target audiovisual text scheduled for removal; preserve and re-anchor them first')
    return {'format': 'audiovisual-cleanup-v1', 'heads': heads,
            'revisions': revisions, 'decisions': decisions, 'comments': comments}


def apply(store, approved, validate_only=False, *, transaction=True):
    from .production import references
    if approved.get('format') != 'audiovisual-cleanup-v1':
        raise ValueError('unsupported audiovisual cleanup')
    if transaction:
        store.db.commit()
    elif not store.db.in_transaction or validate_only:
        raise ValueError('nested cleanup requires an owning transaction')
    try:
        if transaction:store.db.execute('BEGIN IMMEDIATE')
        if plan(store, approved['heads']) != approved:
            raise Conflict('audiovisual heads, history or comments changed; prepare a fresh cleanup')
        for item in approved['revisions']:
            row = store.db.execute('SELECT * FROM revisions WHERE id=?', (item['revision_id'],)).fetchone()
            original = json.loads(row['payload']); after = cleaned(item['kind'], original)
            if list(references(original)) != list(references(after)):
                raise ValueError('cleanup must preserve exact executable references')
            payload = canonical(after)
            store.db.execute('UPDATE revisions SET payload=? WHERE id=?', (payload, row['id']))
            receipt = (row['id'], row['object_id'], item['kind'], item['payload_sha256'],
                       digest(payload.encode()), digest(canonical(facts(item['kind'], original)).encode()),
                       canonical(item['removed_fields']))
            store.db.execute('INSERT INTO audiovisual_cleanup_receipts VALUES (?,?,?,?,?,?,?)', receipt)
        decision_ids = {r['revision_id'] for r in approved['decisions']}
        for rid in decision_ids:
            if any(r[0] not in decision_ids for r in store.db.execute('SELECT from_revision FROM dependencies WHERE to_revision=?', (rid,))):
                raise Conflict('a retired design approval is consumed by another object; inspect before deletion')
        for rid in decision_ids:
            store.db.execute('DELETE FROM dependencies WHERE from_revision=? OR to_revision=?', (rid, rid))
        for rid in decision_ids:
            store.db.execute('DELETE FROM revisions WHERE id=?', (rid,))
        for oid in {r['object_id'] for r in approved['decisions']}:
            store.db.execute('DELETE FROM objects WHERE id=?', (oid,))
        run_id = digest(canonical(approved).encode())
        store.db.execute('INSERT OR IGNORE INTO audiovisual_cleanup_runs VALUES (?,?,?)',
                         (run_id, canonical(sorted(approved['heads'])), canonical(approved['decisions'])))
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('audiovisual cleanup foreign key failure')
        if transaction:
            if validate_only:store.db.rollback()
            else:store.db.commit()
    except BaseException:
        if transaction:store.db.rollback()
        raise
    return {'run_id': run_id, 'redacted_revisions': len(approved['revisions']),
            'deleted_design_decisions': len(decision_ids), 'validate_only': validate_only}
