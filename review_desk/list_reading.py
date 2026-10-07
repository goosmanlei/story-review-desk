"""Request-local list metadata, without expanding unrelated definition text.

The full revision reader remains authoritative for details and validation. These
private projections only supply list membership, location and preview metadata.
No result survives production.read_scope or is used for a write decision.
"""
import json

from .store import digest
from . import material_storage


def field(store, key, path):
    scope = getattr(store, '_production_reads', None)
    nodes = scope.setdefault('list_content_nodes', {}) if scope is not None else {}
    for part in path:
        if key not in nodes:
            row = store.db.execute('SELECT body FROM material_content WHERE id=?', (key,)).fetchone()
            if row is None or digest(row[0].encode()) != key:
                raise ValueError('missing or corrupt material content: ' + str(key))
            nodes[key] = json.loads(row[0])
        node = nodes[key]
        if set(node) != {'object'}:
            return None
        pairs = node['object']
        if len({p[0] for p in pairs}) != len(pairs):
            raise ValueError('duplicate material object key')
        key = dict(pairs).get(part)
        if key is None:
            return None
    return material_storage.expand(store, key)


def project(store, raw):
    row = dict(raw)
    value = json.loads(row.pop('stored_payload'))
    key = value.pop(material_storage.MARKER, None)
    value.pop('_material_raw', None)
    if key:
        # List usage depends on actual/planned inputs, never on prompts, block
        # text, generation parameters or archived lexical layouts.
        if row['kind'] == 'REQUIREMENT':
            inputs = field(store, key, ('generation', 'inputs'))
            method = field(store, key, ('generation', 'method'))
            value['generation'] = {k:v for k,v in (('inputs',inputs),('method',method)) if v is not None}
        elif row['kind'] == 'CALL':
            inputs = field(store, key, ('inputs',))
            if inputs is not None:value['inputs'] = inputs
    row['payload'] = value
    scope = getattr(store, '_production_reads', None)
    if scope is not None:
        cache = scope.setdefault('list_records', {})
        cache[(row['object_id'], row['id'])] = row
        cache[(None, row['id'])] = row
        if row['id'] == row['current_revision']:
            cache[(row['object_id'], None)] = row
    return row


def record(store, object_id=None, revision_id=None):
    scope = getattr(store, '_production_reads', None)
    cache = scope.setdefault('list_records', {}) if scope is not None else {}
    key = (object_id, revision_id)
    if key not in cache:
        query = ('SELECT r.id,r.object_id,r.version,r.payload AS stored_payload,r.created_at,'
                 'o.kind,o.current_revision FROM revisions r JOIN objects o ON o.id=r.object_id ')
        raw = store.db.execute(query + ('WHERE r.id=?' if revision_id else 'WHERE o.id=? AND r.id=o.current_revision'),
                               (revision_id or object_id,)).fetchone()
        if raw is None:raise KeyError('unknown production object or revision')
        if object_id and raw['object_id'] != object_id:raise ValueError('revision belongs to another object')
        cache[key] = project(store, raw)
    return cache[key]


def ref_record(store, reference):
    if not isinstance(reference, dict) or not isinstance(reference.get('object_id'), str) or not isinstance(reference.get('revision_id'), str):
        raise ValueError('an exact object/revision reference is required')
    return record(store, reference['object_id'], reference['revision_id'])


def rows(store, kind, condition='', params=()):
    sql = ('SELECT r.id,r.object_id,r.version,r.payload AS stored_payload,r.created_at,'
           'o.kind,o.current_revision FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind=?')
    return [project(store, row) for row in store.db.execute(sql + (' AND ' + condition if condition else '') + ' ORDER BY o.id', (kind, *params))]
