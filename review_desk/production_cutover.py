"""One-time, exact-baseline physical replacement of production structures.

The caller supplies the reviewed deletion identities and new authored records.
This backend has no story rules, provider calls, or public editing endpoint.
"""
import json
from pathlib import Path
from . import production as p, version_consolidation as vc
from .store import canonical, digest, Conflict
from .production_media import physical_file_hash

RETIRED_KINDS = {'PREPARATION', 'SHOT_DESIGN'}
REPLACEABLE = RETIRED_KINDS | {'REQUIREMENT', 'MATERIAL_RELATION', 'RELATION', 'JUDGMENT', 'REPRESENTATION'}
FORMAT = 'production-cutover-v1'


def checksum(value):
    return digest(canonical(value).encode())


def plan(store, removals, records, retention):
    """Read only; includes every business row and every retained original."""
    if store.db.in_transaction:
        raise ValueError('cutover inventory needs its own consistent read')
    with p.read_scope(store):
        objects = {r['id']: dict(r) for r in store.db.execute('SELECT * FROM objects')}
        if set(removals) - objects.keys():
            raise ValueError('unknown deletion identity')
        if any(objects[oid]['kind'] not in REPLACEABLE for oid in removals):
            raise ValueError('deletion outside replaceable production content')
        lost = set(removals)
        # Decisions and applicability lose their meaning when their exact target
        # disappears. Calls/assets are immutable provenance, handled separately.
        while True:
            revisions = {r['id'] for oid in lost for r in store.db.execute('SELECT id FROM revisions WHERE object_id=?', (oid,))}
            derived = {r['object_id'] for r in store.db.execute('SELECT d.to_revision,r.object_id,o.kind FROM dependencies d JOIN revisions r ON r.id=d.from_revision JOIN objects o ON o.id=r.object_id')
                       if r['to_revision'] in revisions and r['kind'] in ('RELATION', 'JUDGMENT', 'REPRESENTATION')}
            new = derived - lost
            if not new: break
            lost.update(new)
        blockers = [dict(r) for r in store.db.execute('SELECT d.*,r.object_id,o.kind FROM dependencies d JOIN revisions r ON r.id=d.from_revision JOIN objects o ON o.id=r.object_id')
                    if r['to_revision'] in revisions and r['object_id'] not in lost and r['kind'] not in ('CALL', 'ASSET')]
        if blockers:
            raise Conflict('retained business content refers to retired content: ' + canonical(blockers[:5]))
        retired = []
        for oid in sorted(lost):
            for r in store.db.execute('SELECT id,object_id,version,payload FROM revisions WHERE object_id=? ORDER BY version', (oid,)):
                retired.append({'revision_id': r['id'], 'object_id': oid, 'kind': objects[oid]['kind'],
                                'old_number': r['version'], 'sha256': checksum(json.loads(r['payload']))})
        comments = [r['id'] for r in store.db.execute('SELECT id,target_object_id FROM comments') if r['target_object_id'] in lost]
        files = {}
        for r in store.db.execute('SELECT object_id,payload FROM revisions'):
            if r['object_id'] in lost: continue
            for name in vc.file_references(json.loads(r['payload'])):
                if name in files: continue
                path = p.root_of(store)/'export/assets'/name
                if path.is_symlink() or not path.is_file():
                    raise ValueError('retained original unavailable: ' + name)
                files[name] = {'file': name, 'physical_sha256': physical_file_hash(path), 'physical_bytes': path.stat().st_size}
        body = {'format': FORMAT, 'baseline': vc.fingerprint(store), 'record_sha256': checksum(records),
                'delete_objects': sorted(lost), 'delete_revisions': retired, 'delete_comments': sorted(comments),
                'retention': retention, 'files': sorted(files.values(), key=lambda r: r['file'])}
        body['id'] = checksum(body)
        return body


def _delete(store, table, column, values):
    store.db.executemany('DELETE FROM '+table+' WHERE '+column+'=?', ((v,) for v in values))


def result_fingerprint(store, document):
    """Compare isolated/formal results without rewriting their creation times.

    Only creation timestamps for the exact newly imported records are ignored.
    All retained history, comments, decisions, provenance, and payloads remain
    part of the comparison. The pre-cutover baseline always uses raw rows.
    """
    row = store.db.execute('SELECT receipt FROM consolidation_runs WHERE id=?', (document['id'],)).fetchone()
    if not row:
        raise ValueError('cutover has not committed')
    heads = json.loads(row[0])['created_heads']
    revision_ids = set(heads.values())
    def normalize(table, value):
        fresh = ((table == 'objects' and value['id'] in heads) or
                 (table == 'revisions' and value['id'] in revision_ids) or
                 (table == 'material_rounds' and value['material_id'] in heads))
        if fresh:
            for key in ('created_at', 'updated_at'):
                if key in value:
                    value[key] = '<cutover creation time>'
        return value
    return vc.fingerprint(store, normalize=normalize)


def apply(store, document, records, *, fault=None):
    """One transaction; retry after commit verifies identities and returns receipt."""
    if document.get('format') != FORMAT or document.get('id') != checksum({k: v for k,v in document.items() if k != 'id'}) or document.get('record_sha256') != checksum(records):
        raise ValueError('cutover package checksum mismatch')
    prior = store.db.execute('SELECT receipt FROM consolidation_runs WHERE id=?', (document['id'],)).fetchone()
    if prior:
        receipt = json.loads(prior[0])
        if any(store.db.execute('SELECT 1 FROM objects WHERE id=?', (oid,)).fetchone() for oid in document['delete_objects']):
            raise Conflict('retired object resurrected')
        for oid, rid in receipt['created_heads'].items():
            row = store.db.execute('SELECT 1 FROM revisions WHERE id=? AND object_id=?', (rid, oid)).fetchone()
            if not row: raise Conflict('cutover output lost: '+oid)
        return {**receipt, 'already_applied': True}
    store.db.execute('PRAGMA secure_delete=ON')
    store.db.execute('BEGIN IMMEDIATE')
    store._material_migrating = True
    try:
        if vc.fingerprint(store) != document['baseline']:
            raise Conflict('database baseline changed; entire cutover refused')
        for item in document['files']:
            path = p.root_of(store)/'export/assets'/item['file']
            if path.is_symlink() or not path.is_file() or physical_file_hash(path) != item['physical_sha256']:
                raise Conflict('retained original changed: '+item['file'])
        lost = {r['revision_id'] for r in document['delete_revisions']}
        oids = set(document['delete_objects'])
        # Keep independent, still-valid material definitions. Other surviving
        # results become standalone materials indexed by their unchanged calls.
        retained_needs = {r[0] for r in store.db.execute("SELECT id FROM objects WHERE kind='REQUIREMENT'") if r[0] not in oids}
        rebuild = {r[0] for r in store.db.execute('SELECT DISTINCT material_id FROM material_plan_versions') if r[0] not in retained_needs}
        for table in ('material_plan_comments', 'material_definition_versions', 'material_plan_members', 'material_plan_versions',
                      'material_comment_scopes', 'material_feedback', 'material_members', 'material_rounds'):
            _delete(store, table, 'material_id', rebuild)
        _delete(store, 'business_candidates', 'material_id', rebuild)
        for field in ('material_id', 'alias_id'):
            _delete(store, 'material_aliases', field, oids)
        for table, field in (('comment_events','comment_id'), ('business_comments','comment_id'),
                             ('state_cleanup_comments','comment_id'), ('relation_redacted_comments','comment_id'), ('comments','id')):
            _delete(store, table, field, document['delete_comments'])
        for table, field in (('dependencies','from_revision'), ('dependencies','to_revision'),
                             ('material_candidate_members','revision_id'), ('state_cleanup_preserved','revision_id'),
                             ('relation_explanation_redactions','revision_id')):
            _delete(store, table, field, lost)
        for r in document['delete_revisions']:
            store.db.execute('INSERT INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(revision_id) DO UPDATE SET new_number=NULL,after_sha256=NULL,plan_id=excluded.plan_id',
                (r['revision_id'], r['object_id'], r['kind'], r['old_number'], None, r['sha256'], None, document['id']))
        _delete(store, 'revisions', 'id', lost)
        store.db.executemany('INSERT INTO consolidation_objects VALUES (?,?) ON CONFLICT(object_id) DO NOTHING', ((oid,document['id']) for oid in oids))
        _delete(store, 'objects', 'id', oids)
        # Never change a real CALL or ASSET body, signature identity, or bytes.
        # Missing historic dependencies have only an exact hash/tombstone entry.
        preserved = 0
        for row in store.db.execute("SELECT r.*,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind IN ('CALL','ASSET')"):
            payload = json.loads(row['payload'])
            missing = [(path, ref) for path, ref in p.references(payload, include_unavailable=True) if ref['revision_id'] in lost]
            if not missing: continue
            preserved += 1
            store.db.execute('INSERT OR IGNORE INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
                (row['id'],row['object_id'],row['kind'],row['version'],row['version'],checksum(payload),vc.row_hash(row['object_id'],row['version'],payload),document['id']))
            store.db.executemany('INSERT OR IGNORE INTO consolidation_missing VALUES (?,?,?,?)',
                ((row['id'],path,ref['object_id'],ref['revision_id']) for path,ref in missing))
        if fault == 'after_delete': raise RuntimeError('injected fault after deletion')
        from . import material_model as mm, material_plans as mp
        # The original plan can now be absent. The source material explicitly
        # reports that gap; no new authored plan impersonates the old call.
        for meta in store.db.execute("SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='CALL'").fetchall():
            row = p.record(store, revision_id=meta['id'])
            if vc.preserved(store, row['object_id'], row['payload']) and not store.db.execute(
                    "SELECT 1 FROM material_plan_members WHERE revision_id=? AND role='call'", (row['id'],)).fetchone():
                store.db.execute('INSERT INTO consolidation_signatures VALUES (?,?) ON CONFLICT(revision_id) DO UPDATE SET fingerprint=excluded.fingerprint', (row['id'],mm.signature(row,store)))
        rebuilt = []
        for asset in p.current_records(store, {'ASSET'}):
            if store.db.execute("SELECT 1 FROM material_plan_members WHERE revision_id=? AND role='result'", (asset['id'],)).fetchone(): continue
            mid = asset['object_id']
            producer = p.ref_record(store, asset['payload']['production'], {'CALL'})
            number = mp.version(store,mid,producer,freeze=True)
            for call in store.db.execute('SELECT id FROM revisions WHERE object_id=? ORDER BY version', (producer['object_id'],)).fetchall():
                mp.call_version(store,mid,p.record(store,revision_id=call['id']))
            # Preserve all retained exact asset revisions, not just the head.
            for r in store.db.execute('SELECT id FROM revisions WHERE object_id=?', (mid,)).fetchall():
                candidate = p.record(store,revision_id=r['id'])
                mp.bind(store,mid,number,candidate)
            store.db.execute('INSERT INTO material_rounds VALUES (?,?,?,?)', (mid,number,'produced',asset['created_at']))
            for row in store.db.execute('SELECT * FROM material_plan_members WHERE material_id=?', (mid,)).fetchall():
                store.db.execute('INSERT INTO material_members VALUES (?,?,?,?,?)', (mid,row['number'],row['revision_id'],row['role'],'retained exact production provenance'))
            for comment in store.db.execute('SELECT id,target_revision_id FROM comments WHERE target_object_id=?', (mid,)).fetchall():
                if mp.belongs(store,comment['target_revision_id'],mid,number):
                    store.db.execute('INSERT OR IGNORE INTO material_plan_comments VALUES (?,?,?)', (comment['id'],mid,number))
            from .business_codes import allocate_candidates
            allocate_candidates(store,asset['id'])
            rebuilt.append(mid)
        created = p._import_records(store, {'format':'production-import-v1','records':records}, transaction=False)
        if fault == 'after_import': raise RuntimeError('injected fault after import')
        # Retire compacted copies of obsolete planning exports. Actual provider
        # receipt components remain byte-for-byte recoverable via their recipes.
        keep_paths = {'export/assets/'+r['file'] for r in document['files']}
        archives = [r[0] for r in store.db.execute('SELECT path FROM material_archive_files') if r[0] not in keep_paths]
        _delete(store,'material_archive_files','path',archives)
        _delete(store,'consolidation_definitions','material_id',rebuild)
        gc = vc.collect_content(store)
        if store.db.execute('PRAGMA foreign_key_check').fetchone(): raise ValueError('cutover foreign key failure')
        mp.validate(store)
        receipt = {'format':'production-cutover-result-v1','id':document['id'],
                   'deleted_objects':len(oids),'deleted_revisions':len(lost),'deleted_comments':len(document['delete_comments']),
                   'preserved_provenance_revisions':preserved,'standalone_materials':len(rebuilt),
                   'retired_archive_entries':len(archives), **gc,
                   'created_heads':{r['id']:r['revision'] for r in created['records']}, 'actual_generation_calls':0}
        store.db.execute('INSERT INTO consolidation_runs VALUES (?,?,?)', (document['id'],checksum(document),canonical(receipt)))
        if fault == 'before_commit': raise RuntimeError('injected fault before commit')
        store.db.commit()
        if fault == 'after_commit': raise RuntimeError('injected interruption after commit')
        return receipt
    except BaseException:
        store.db.rollback()
        raise
    finally:
        store._material_migrating = False
