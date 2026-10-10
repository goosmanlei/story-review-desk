"""Explicit, transactional retirement of the production revision tree.

A plan contains hashes and identities, not a second copy of retired text. It
must be rehearsed on an isolated latest-state copy before formal application.
"""
import copy
import json
import sqlite3

from . import production as p, production_current as current
from .store import Conflict, canonical, digest


def statements(db, script):
    statement = ''
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            db.execute(statement)
            statement = ''


def inventory(store):
    """Bounded read of physical rows; never expand the complete content graph."""
    kinds = sorted(current.RECORD_KINDS | {'MATERIAL_RELATION'})
    marks = ','.join('?' for _ in kinds)
    entries = []
    for row in store.db.execute('''SELECT o.id,o.kind,o.current_revision,o.version,r.id revision_id,
        r.payload AS stored_payload FROM objects o JOIN revisions r ON r.object_id=o.id
        WHERE o.kind IN ('''+marks+') ORDER BY o.id,r.version', kinds):
        entries.append({'object_id': row['id'], 'kind': row['kind'], 'head': row['current_revision'],
                        'edit_token': row['version'], 'revision_id': row['revision_id'],
                        'stored_sha256': digest(row['stored_payload'].encode())})
    indexes = {}
    for table in (*current.LEGACY_TABLES, 'business_relation_aliases', 'material_aliases'):
        sha = __import__('hashlib').sha256()
        for row in store.db.execute('SELECT * FROM '+table+' ORDER BY '+','.join(str(i+1) for i, _ in enumerate(store.db.execute('PRAGMA table_info('+table+')')))):
            sha.update(canonical(dict(row)).encode())
            sha.update(b'\n')
        indexes[table] = sha.hexdigest()
    return {'records': entries, 'indexes': indexes}


def plan(store):
    if current.enabled(store):
        raise Conflict('production current model is already active')
    value = {'format': 'production-current-migration-v1', 'inventory': inventory(store),
             'contract': current.CONTRACT}
    return {**value, 'id': current.checksum(value)}


def _replace_references(value, addresses, aliases):
    if isinstance(value, dict):
        result = {k: _replace_references(v, addresses, aliases) for k, v in value.items()}
        if 'object_id' in value and 'revision_id' in value:
            oid = aliases.get(value['object_id'], value['object_id'])
            if oid in addresses:
                result.update(object_id=oid, revision_id=addresses[oid])
        if 'material_selection' in result:
            selection = result['material_selection']
            if isinstance(selection, dict):
                # The concrete candidate/component/range still identifies input.
                # A legacy business version never becomes a new working version.
                selection.pop('number', None)
                selection.pop('baseline_id', None)
                ref = result.get('reference', result)
                if 'revision_id' in ref:
                    selection['candidate_revision_id'] = ref['revision_id']
        return result
    if isinstance(value, list):
        return [_replace_references(v, addresses, aliases) for v in value]
    return value


def apply(store, approved, *, fault=None, transaction=True):
    expected_id = current.checksum({k: v for k, v in approved.items() if k != 'id'})
    if approved.get('format') != 'production-current-migration-v1' or approved.get('id') != expected_id:
        raise ValueError('invalid current production migration plan')
    if current.enabled(store):
        active = store.db.execute('SELECT migration_id FROM production_current_policy WHERE id=1').fetchone()[0]
        if active != approved['id']:
            raise Conflict('another production migration is active')
        return {'already_applied': True, 'id': active}
    if transaction and store.db.in_transaction:
        raise Conflict('migration must own its transaction')
    if transaction:
        store.db.execute('BEGIN IMMEDIATE')
    elif not store.db.in_transaction:
        raise Conflict('nested migration requires an owning transaction')
    store._material_migrating = True
    try:
        if inventory(store) != approved['inventory']:
            raise Conflict('production baseline changed; prepare a fresh exact migration')
        statements(store.db, current.SCHEMA)
        aliases = dict(store.db.execute('SELECT alias_id,relation_id FROM business_relation_aliases'))
        retired = set(aliases)
        retired.update(r[0] for r in store.db.execute("SELECT id FROM objects WHERE kind='MATERIAL_RELATION'"))
        objects = {r['id']: dict(r) for r in store.db.execute('SELECT * FROM objects')
                   if r['kind'] in current.RECORD_KINDS and r['id'] not in retired}
        addresses = {oid: current.address(oid) for oid in objects}
        # Disk staging keeps large production payloads out of a second Python
        # object graph while aliases and old revision IDs are being rewritten.
        store.db.execute('CREATE TEMP TABLE current_migration_rows (object_id TEXT PRIMARY KEY,payload TEXT NOT NULL)')
        for oid, obj in objects.items():
            row = p.record(store, oid)
            # record() projects retired states for readers. Migration preserves
            # the stored tombstone, not that presentation-only state view.
            payload = json.loads(store.db.execute('SELECT payload FROM revisions WHERE id=?',
                                                  (obj['current_revision'],)).fetchone()[0])
            if obj['kind'] == 'CALL':
                saved = current.capture_submission(store, oid, payload)
                current.save_submission(store, oid, saved, origin='historical', created_at=row['created_at'])
                # Real request/response fields remain byte-for-byte logical data.
                # They are evidence, not live edges into today's production tree.
            else:
                original_sha = current.checksum(payload)
                payload = _replace_references(payload, addresses, aliases)
                if obj['kind'] == 'ENTITY' and 'choices' in payload:
                    payload['choices'] = [
                        '造型、色彩、空间布置和声音方向为当前制作选择。'
                        if choice == '造型、色彩、空间布置和声音方向为本次提出的制作选择，随此版本一起审阅。'
                        else choice for choice in payload['choices']]
                if obj['kind'] == 'ASSET':
                    components = payload.setdefault('components', [])
                    known = {(c['file'], c['sha256'], c['role']) for c in components}
                    ids = {c['id'] for c in components}
                    for previous in store.db.execute('SELECT payload FROM revisions WHERE object_id=? ORDER BY version', (oid,)):
                        for component in json.loads(previous[0]).get('components', []):
                            key = (component['file'], component['sha256'], component['role'])
                            if key in known:
                                continue
                            component = copy.deepcopy(component)
                            if component['id'] in ids:
                                component['id'] += '-'+component['sha256'][:12]
                            components.append(component); known.add(key); ids.add(component['id'])
                    operation = payload.get('production', {}).get('object_id')
                    if not operation:
                        operation = 'source:'+oid
                        payload.setdefault('external_source', {'kind': 'historical', 'description': '原件未登记模型调用，来源沿原记录保留'})
                    payload['candidate_identity'] = 'candidate-' + digest(canonical({'operation': operation}).encode())
                store.db.execute('INSERT INTO production_current_baselines VALUES (?,?,?)',
                                 (oid, current.checksum(payload), original_sha))
            store.db.execute('INSERT INTO current_migration_rows VALUES (?,?)', (oid, canonical(payload)))
        # Record minimal old-link identities and the original comment excerpts
        # before removing any text. Candidate aliases resolve to actual outputs;
        # a retired draft is never silently presented as its old content.
        quote_count = 0
        for comment in store.comments():
            if comment['target_object_id'] in objects or comment['target_object_id'] in retired:
                current.remember_comment(store, comment)
                quote_count += 1
        from .production_current_comments import retain
        for row in store.db.execute("SELECT r.payload FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind='GUIDANCE' AND json_extract(r.payload,'$.format')='comment-handling-v1'"):
            retain(store, json.loads(row[0]))
        for row in store.db.execute('''SELECT r.*,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id
                                      ORDER BY r.object_id,r.version'''):
            if row['object_id'] not in objects and row['object_id'] not in retired:
                continue
            obj = objects.get(row['object_id'])
            kind = row['kind']
            payload = json.loads(row['payload'])
            mapped_oid = aliases.get(row['object_id'], row['object_id'])
            cid = None
            if kind == 'ASSET':
                operation = payload.get('production', {}).get('object_id')
                if operation:
                    cid = 'candidate-' + digest(canonical({'operation': operation}).encode())
            store.db.execute('INSERT INTO production_legacy_links VALUES (?,?,?,?,?,?,?,?)',
                             (row['id'], row['object_id'], kind, mapped_oid if mapped_oid in addresses else None,
                              addresses.get(mapped_oid), cid,
                              'candidate' if kind == 'ASSET' else 'operation' if kind == 'CALL' else 'retired-draft',
                              current.checksum(payload)))
        if fault == 'after-snapshots':
            raise RuntimeError('injected migration interruption')
        # Remove old indexes before deleting their source rows. No replacement
        # table has a business version or a saved draft field.
        counts = {table: store.db.execute('SELECT count(*) FROM '+table).fetchone()[0]
                  for table in current.LEGACY_TABLES}
        for trigger in ('material_frozen_definition_update', 'material_frozen_version_update'):
            store.db.execute('DROP TRIGGER IF EXISTS '+trigger)
        for table in current.LEGACY_TABLES:
            store.db.execute('DROP TABLE '+table)
        store.db.execute('ALTER TABLE business_relation_aliases RENAME TO production_old_relation_aliases')
        store.db.execute('CREATE TABLE business_relation_aliases (alias_id TEXT PRIMARY KEY,relation_id TEXT NOT NULL REFERENCES business_relations(object_id))')
        store.db.execute('INSERT INTO business_relation_aliases SELECT * FROM production_old_relation_aliases')
        store.db.execute('DROP TABLE production_old_relation_aliases')
        # Historical cleanup receipts are hashes, but their old FK targets are
        # now represented in production_legacy_links. Migration run receipts stay.
        for table in ('relation_explanation_redactions', 'state_cleanup_receipts',
                      'state_cleanup_preserved', 'audiovisual_cleanup_receipts'):
            store.db.execute('DELETE FROM '+table+' WHERE revision_id IN (SELECT revision_id FROM production_legacy_links)')
        store.db.execute('DELETE FROM dependencies WHERE from_revision IN (SELECT revision_id FROM production_legacy_links) OR to_revision IN (SELECT revision_id FROM production_legacy_links)')
        for oid, obj in objects.items():
            payload = json.loads(store.db.execute('SELECT payload FROM current_migration_rows WHERE object_id=?', (oid,)).fetchone()[0])
            rid, token = addresses[oid], obj['version']+1
            store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)', (rid, oid, token, canonical(payload), obj['updated_at']))
            store.db.execute('UPDATE objects SET current_revision=?,version=? WHERE id=?', (rid, token, oid))
            store.db.execute('INSERT INTO production_current_records VALUES (?,?,?,?)', (oid, rid, token, current.checksum(payload)))
            store.db.execute('UPDATE comments SET target_revision_id=? WHERE target_object_id=?', (rid, oid))
        # Retired relation comments require an explicit owner, never dropped text.
        for old in retired:
            if store.db.execute('SELECT 1 FROM comments WHERE target_object_id=?', (old,)).fetchone():
                target = aliases.get(old)
                if target not in addresses:
                    raise Conflict('retired commented relation needs an explicit current target: '+old)
                store.db.execute('UPDATE comments SET target_object_id=?,target_revision_id=? WHERE target_object_id=?',
                                 (target, addresses[target], old))
        old_revision_count = store.db.execute('SELECT count(*) FROM production_legacy_links').fetchone()[0]
        store.db.execute('DELETE FROM revisions WHERE id IN (SELECT revision_id FROM production_legacy_links)')
        for oid in sorted(retired):
            store.db.execute('DELETE FROM objects WHERE id=?', (oid,))
        for oid, obj in objects.items():
            payload = json.loads(store.db.execute('SELECT payload FROM current_migration_rows WHERE object_id=?', (oid,)).fetchone()[0])
            for role, ref in p.references(payload):
                if store.db.execute('SELECT 1 FROM revisions WHERE id=?', (ref['revision_id'],)).fetchone():
                    store.db.execute('INSERT OR IGNORE INTO dependencies VALUES (?,?,?)', (addresses[oid], ref['revision_id'], role))
            if obj['kind'] == 'ASSET':
                current.register_candidate(store, oid, payload)
        store.db.execute('INSERT INTO production_current_policy VALUES (1,?,?)', (current.CONTRACT, approved['id']))
        store.db.execute('DROP TABLE current_migration_rows')
        current.read_adapters(store)
        from .version_consolidation import collect_content
        gc = collect_content(store)
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('current production migration left a foreign key error')
        if fault == 'before-commit':
            raise RuntimeError('injected migration interruption')
        receipt = {'id': approved['id'], 'already_applied': False, 'old_revisions_removed': old_revision_count,
                   'retired_objects_removed': len(retired), 'current_records': len(objects),
                   'comment_quotes': quote_count, 'legacy_index_rows_removed': counts,
                   'candidates': store.db.execute('SELECT count(*) FROM production_candidates').fetchone()[0], **gc}
        if transaction: store.db.commit()
        return receipt
    except BaseException:
        if transaction: store.db.rollback()
        raise
    finally:
        store._material_migrating = False
