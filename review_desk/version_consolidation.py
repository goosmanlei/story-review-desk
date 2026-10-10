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
TABLES = ('consolidation_revisions', 'consolidation_versions', 'consolidation_missing',
          'consolidation_definitions', 'consolidation_signatures', 'consolidation_objects', 'consolidation_runs')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS consolidation_revisions (
 revision_id TEXT PRIMARY KEY, object_id TEXT NOT NULL, kind TEXT NOT NULL,
 old_number INTEGER NOT NULL, new_number INTEGER, before_sha256 TEXT NOT NULL,
 after_sha256 TEXT, plan_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consolidation_versions (
 material_id TEXT NOT NULL, old_number INTEGER NOT NULL, new_number INTEGER,
 plan_id TEXT NOT NULL, PRIMARY KEY(material_id,old_number));
CREATE TABLE IF NOT EXISTS consolidation_missing (
 revision_id TEXT NOT NULL, path TEXT NOT NULL, target_object TEXT NOT NULL,
 target_revision TEXT NOT NULL, PRIMARY KEY(revision_id,path));
CREATE TABLE IF NOT EXISTS consolidation_definitions (
 material_id TEXT NOT NULL, number INTEGER NOT NULL, binding_sha256 TEXT NOT NULL,
 plan_id TEXT NOT NULL, PRIMARY KEY(material_id,number));
CREATE TABLE IF NOT EXISTS consolidation_runs (
 id TEXT PRIMARY KEY, inventory_sha256 TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consolidation_signatures (
 revision_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
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
    epoch = None
    if available(store):
        row = store.db.execute('SELECT plan_id FROM consolidation_revisions WHERE object_id=? AND new_number IS NOT NULL LIMIT 1', (object_id,)).fetchone()
        epoch = row[0] if row else None
    value = {'object_id': object_id, 'version': version, 'payload': payload}
    if epoch:
        value['baseline'] = epoch
    return digest(canonical(value).encode())


def valid_identity(store, object_id, version, payload, revision_id):
    if available(store):
        row = store.db.execute('SELECT object_id,new_number,after_sha256 FROM consolidation_revisions WHERE revision_id=?', (revision_id,)).fetchone()
        if row:
            return row[0] == object_id and row[1] == version and row[2] == row_hash(object_id, version, payload)
    # Unchanged historical rows keep their original content identity even when
    # a different row of the same object needed reference repair. New writes
    # use the baseline salt; an explicit deletion receipt above always wins.
    return revision_id in (row_hash(object_id, version, payload),
                           new_identity(store, object_id, version, payload))


def saved_signature(store, row):
    if not available(store) or not preserved(store, row['object_id'], row['payload']):
        return None
    saved = store.db.execute('SELECT fingerprint FROM consolidation_signatures WHERE revision_id=?', (row['id'],)).fetchone()
    return saved[0] if saved else None


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


def binding_preserved(store, row):
    if not available(store):
        return False
    receipt = store.db.execute('SELECT binding_sha256 FROM consolidation_definitions WHERE material_id=? AND number=?', (row['material_id'], row['number'])).fetchone()
    return bool(receipt and digest(canonical(dict(row)).encode()) == receipt[0])


def material_epoch(store, material_id):
    if not available(store):
        return None
    row = store.db.execute('SELECT plan_id FROM consolidation_versions WHERE material_id=? LIMIT 1', (material_id,)).fetchone()
    return row[0] if row else None


def version_route(store, material_id):
    if not available(store):
        return {}
    rows = list(store.db.execute('SELECT * FROM consolidation_versions WHERE material_id=?',(material_id,)))
    return {'baseline_id':rows[0]['plan_id'], 'previous_numbers':{str(r['old_number']):r['new_number'] for r in rows}} if rows else {}


def fingerprint(store, *, normalize=None):
    """Hash physical rows one at a time, including comments and decisions."""
    cursor = store.db.cursor()
    cursor.row_factory = sqlite3.Row
    tables = [r[0] for r in cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    result = {}
    for table in tables:
        if table == 'read_generations':
            continue  # Disposable cache generations are deliberately random.
        h = hashlib.sha256()
        count = size = 0
        columns = len(cursor.execute('PRAGMA table_info("'+table+'")').fetchall())
        order = ','.join(str(n+1) for n in range(columns))
        for row in cursor.execute('SELECT * FROM "'+table+'" ORDER BY '+order):
            value = normalize(table, dict(row)) if normalize else row
            body = canonical(list(value.values()) if isinstance(value, dict) else list(value)).encode()
            h.update(len(body).to_bytes(8, 'big')); h.update(body)
            size += len(body); count += 1
        if count or table not in TABLES:
            result[table] = {'count': count, 'bytes': size, 'sha256': h.hexdigest()}
    return result


def inventory(store):
    objects = {r['id']: dict(r) for r in store.db.execute('SELECT * FROM objects')}
    revisions = {r['id']: dict(r) for r in store.db.execute(
        'SELECT id,object_id,version FROM revisions')}
    by_object = defaultdict(list)
    for r in revisions.values():
        by_object[r['object_id']].append(r)
    members = defaultdict(list)
    for r in store.db.execute('SELECT * FROM material_plan_members ORDER BY material_id,number,revision_id'):
        members[(r['material_id'], r['number'])].append(dict(r))
    versions = defaultdict(list)
    for r in store.db.execute('SELECT * FROM material_plan_versions ORDER BY material_id,number'):
        versions[r['material_id']].append(dict(r))
    definitions = {(r['material_id'], r['number']): dict(r) for r in store.db.execute(
        'SELECT * FROM material_definition_versions')}
    candidates = defaultdict(set)
    for r in store.db.execute('SELECT * FROM material_candidate_members'):
        candidates[r['revision_id']].add(r['candidate_id'])
    files = {}
    anomalies = []
    selected = []
    keep_material = set()
    root = p.root_of(store)
    with material_archives.read_scope(store):
        for mid, rows in sorted(versions.items()):
            evidence = []
            for version in rows:
                number = version['number']
                real = set()
                for member in members[(mid, number)]:
                    if member['role'] != 'result':
                        continue
                    row = p.record(store, revision_id=member['revision_id'])
                    payload = row['payload']
                    original = [c for c in payload.get('components', []) if c['role'] == 'original']
                    if payload.get('placeholder') or not original:
                        continue
                    from .material_plans import identity
                    cid = identity(payload)
                    if cid not in candidates[row['id']]:
                        anomalies.append({'code': 'candidate_identity_mismatch', 'revision_id': row['id']})
                        continue
                    try:
                        call = p.ref_record(store, payload['production'], {'CALL'})
                        terminal = p.record(store, call['object_id'])
                        # Assets lock the submitted input revision. Completion
                        # is a later revision of that same call, not a rewrite
                        # of the asset's provenance.
                        if call['payload']['status'] not in ('submitted', 'completed') or terminal['payload']['status'] != 'completed':
                            raise ValueError('candidate call has no completed lifecycle')
                        from .material_plans import scheme
                        if scheme(call['payload'], 'CALL') != scheme(terminal['payload'], 'CALL'):
                            raise ValueError('completed lifecycle changed actual inputs')
                        if not any(ref.get('object_id') == row['object_id'] for ref in terminal['payload'].get('outputs', [])):
                            raise ValueError('completed call does not register this result')
                        for component in payload['components']:
                            name = component['file']
                            if name not in files:
                                path = root/'export/assets'/name
                                if path.is_symlink() or not path.is_file():
                                    raise ValueError('missing or symbolic original: '+name)
                                container = material_archives.reference(path)
                                if container:
                                    data = material_archives.read_bytes(path)
                                    logical_hash, size = digest(data), len(data)
                                else:
                                    logical_hash, size = physical_file_hash(path), path.stat().st_size
                                files[name] = {'file': name, 'sha256': logical_hash, 'bytes': size,
                                               'physical_sha256': physical_file_hash(path),
                                               'physical_bytes': path.stat().st_size}
                            f = files[name]
                            if f['sha256'] != component['sha256'] or f['bytes'] != component['bytes']:
                                raise ValueError('component checksum/size mismatch: '+name)
                        real.add(cid)
                    except (ValueError, KeyError, OSError) as exc:
                        anomalies.append({'code': 'invalid_candidate_original', 'material_id': mid,
                                          'number': number, 'revision_id': row['id'], 'error': str(exc)})
                evidence.append({'number': number, 'candidates': sorted(real)})
            produced = [r['number'] for r in evidence if r['candidates']]
            keep = max(produced) if produced else max(r['number'] for r in rows)
            selected.append({'kind': 'MATERIAL', 'object_id': mid, 'old_number': keep,
                             'new_number': 1, 'reason': 'latest_verified_output' if produced else 'latest_plan',
                             'versions': evidence, 'delete_numbers': [r['number'] for r in rows if r['number'] != keep]})
            keep_material.update(r['revision_id'] for r in members[(mid, keep)])
            binding = definitions.get((mid, keep))
            if not binding:
                anomalies.append({'code': 'missing_complete_definition', 'material_id': mid, 'number': keep})
            else:
                # Definition provenance is part of the retained version, even
                # where the legacy membership did not index its exact source.
                keep_material.update(ref['revision_id'] for _, ref in p.references(json.loads(binding['provenance'])))
    deleted = set()
    for oid, obj in sorted(objects.items()):
        if obj['kind'] in CORE_KINDS:
            rows = sorted(by_object[oid], key=lambda r: r['version'])
            if rows[-1]['id'] != obj['current_revision']:
                anomalies.append({'code': 'head_is_not_latest', 'object_id': oid})
            lost = [r['id'] for r in rows if r['id'] != obj['current_revision']]
            selected.append({'kind': obj['kind'], 'object_id': oid, 'keep_revision': obj['current_revision'],
                             'old_number': obj['version'], 'new_number': 1, 'reason': 'latest_revision',
                             'delete_revisions': lost})
            deleted.update(lost)
        elif obj['kind'] in ('REQUIREMENT', 'CALL', 'ASSET'):
            if obj['kind'] == 'REQUIREMENT' and oid not in versions:
                anomalies.append({'code': 'unindexed_requirement', 'object_id': oid})
            deleted.update(r['id'] for r in by_object[oid] if r['id'] not in keep_material)
    affected = []
    for r in store.db.execute('SELECT d.*,o.kind,r.object_id FROM dependencies d JOIN revisions r ON r.id=d.from_revision JOIN objects o ON o.id=r.object_id ORDER BY d.from_revision,d.role'):
        if r['to_revision'] in deleted and r['from_revision'] not in deleted:
            affected.append(dict(r))
    return {'format': 'version-consolidation-inventory-v1', 'objects': selected,
            'delete_revisions': sorted(deleted), 'retained_material_members': sorted(keep_material),
            'affected_references': affected, 'verified_files': sorted(files.values(), key=lambda r:r['file']),
            'anomalies': anomalies}


def plan(store):
    if available(store) and store.db.execute('SELECT 1 FROM consolidation_runs').fetchone():
        raise Conflict('this instance already has a consolidated baseline')
    with p.read_scope(store):
        result = inventory(store)
        if result['anomalies']:
            raise Conflict('unresolved original/identity anomalies; inventory must be reviewed')
        lost = set(result['delete_revisions'])
        objects = {r['id']: dict(r) for r in store.db.execute('SELECT * FROM objects')}
        revisions = {r['id']: dict(r) for r in store.db.execute('SELECT id,object_id,version FROM revisions')}
        by_object = defaultdict(set)
        for r in revisions.values():
            by_object[r['object_id']].add(r['id'])
        deps = [dict(r) for r in store.db.execute('SELECT * FROM dependencies')]
        selection = {r['object_id']: r['old_number'] for r in result['objects'] if r['kind'] == 'MATERIAL'}
        def invalid_selection(value):
            if isinstance(value,dict):
                chosen=value.get('material_selection',{})
                if chosen.get('material_id') in selection and chosen.get('number')!=selection[chosen['material_id']]:
                    return True
                return any(invalid_selection(v) for v in value.values())
            return isinstance(value,list) and any(invalid_selection(v) for v in value)
        changed_scopes = {r['id'] for r in store.db.execute(
            "SELECT r.id,r.payload FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind IN ('ENTITY','STATE','AV_SHOT','REQUIREMENT')")
            if r['id'] not in lost and invalid_selection(json.loads(r['payload']))}
        # A decision or relation with a deleted exact subject/scope cannot
        # remain active. Do not resurrect an earlier acceptance as its head.
        while True:
            damaged = changed_scopes | {d['from_revision'] for d in deps if d['to_revision'] in lost and
                       objects[revisions[d['from_revision']]['object_id']]['kind'] in (*CORE_KINDS,'REQUIREMENT')}
            extra = set()
            for d in deps:
                kind=objects[revisions[d['from_revision']]['object_id']]['kind']
                # A previous-decision link is audit history, not the scope of a
                # still-valid approval. Clear that link without revoking the
                # user's unchanged current decision. Changed input scopes do
                # lose their former permission even if their exact id survives.
                invalid=(d['to_revision'] in lost or kind=='JUDGMENT' and d['to_revision'] in damaged)
                if invalid and kind in ('JUDGMENT','RELATION','REPRESENTATION') and not (kind=='JUDGMENT' and d['role'].startswith('payload.previous_decision')):
                    extra.add(d['from_revision'])
            for oid, obj in objects.items():
                if obj['current_revision'] in extra and obj['kind'] in ('JUDGMENT', 'RELATION', 'REPRESENTATION'):
                    extra.update(by_object[oid])
            if extra <= lost:
                break
            lost |= extra
        removed = []
        for rid in sorted(lost):
            row = store.db.execute('SELECT * FROM revisions WHERE id=?', (rid,)).fetchone()
            removed.append({'revision_id': rid, 'object_id': row['object_id'],
                            'kind': objects[row['object_id']]['kind'], 'old_number': row['version'],
                            'payload_sha256': digest(row['payload'].encode()), 'logical_bytes': len(row['payload'].encode())})
        comments = {r[0] for r in store.db.execute('SELECT id,target_revision_id FROM comments') if r[1] in lost}
        selection = {r['object_id']: r['old_number'] for r in result['objects'] if r['kind'] == 'MATERIAL'}
        scoped = defaultdict(list)
        for r in store.db.execute('SELECT * FROM material_plan_comments'):
            scoped[r['comment_id']].append(r)
        for cid, scopes in scoped.items():
            if not any(r['number'] == selection.get(r['material_id']) for r in scopes):
                comments.add(cid)
        identity_only = []
        for mid in sorted(selection):
            if by_object[mid] <= lost:
                row = p.record(store, mid)
                # Some legacy reused candidates predate every plan of their
                # consuming requirement. Keep the distinct demand's placement,
                # not its discarded later draft or an invented historical plan.
                keys = ('format','title','scope','states','entities','slot','media_type','required','usage')
                payload = {k: row['payload'][k] for k in keys if k in row['payload']}
                payload.update(blocks=[{'id':'missing-original-plan','text':'保留产物的此需求原始方案未登记；原件与真实调用仍可审阅，补全准确输入后才能继续生成。'}],
                               purpose='原始需求方案未登记', specification={}, consolidation_identity_only=True)
                identity_only.append({'object_id':mid,'source_revision':row['id'],'payload':payload})
        aliases = []
        for row in store.db.execute('SELECT * FROM material_aliases'):
            proof = json.loads(row['evidence'])
            involved = [p.record(store, row[k]) for k in ('alias_id','material_id')]
            if any(ref['revision_id'] in lost for _,ref in p.references(proof)) or any(
                r['id'] in lost or any(ref['revision_id'] in lost for _,ref in p.references(r['payload'])) for r in involved):
                aliases.append(row['alias_id'])
        result.update(format='version-consolidation-plan-v1', baseline=fingerprint(store),
                      delete_revisions=removed, delete_comments=sorted(comments),
                      identity_only=identity_only, delete_aliases=sorted(aliases),
                      delete_objects=sorted(oid for oid, ids in by_object.items() if ids <= lost and oid not in selection),
                      affected_references=[{**d, 'kind': objects[revisions[d['from_revision']]['object_id']]['kind']}
                                           for d in deps if d['from_revision'] not in lost and d['to_revision'] in lost])
        result['id'] = digest(canonical(result).encode())
        return result


def clear_references(value, lost, selection, path='payload', missing=None):
    """Replace a discarded binding with an explicit, non-selectable gap."""
    if isinstance(value, list):
        return [clear_references(v, lost, selection, path+'.'+str(i), missing) for i, v in enumerate(value)]
    if not isinstance(value, dict):
        return value
    if 'object_id' in value and value.get('revision_id') in lost:
        if missing is not None:
            missing.append((path, value['object_id'], value['revision_id']))
        return {'object_id': value['object_id'], 'revision_id': value['revision_id'], 'unavailable': True}
    result = {k: clear_references(v, lost, selection, path+'.'+k, missing) for k, v in value.items()}
    selected = result.get('material_selection')
    if isinstance(selected, dict) and selected.get('material_id') in selection:
        if selected.get('number') == selection[selected['material_id']] and not result.get('reference', {}).get('unavailable'):
            result['material_selection'] = {**selected, 'number': 1}
        else:
            result.pop('material_selection')
            result['selection_state'] = 'unselected'
    if result.get('reference', {}).get('unavailable'):
        result.pop('material_selection', None)
        result['selection_state'] = 'unselected'
    return result


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
    store.db.execute('DELETE FROM material_definitions WHERE id NOT IN (SELECT definition_id FROM material_definition_versions)')
    roots = {r[0] for r in store.db.execute('SELECT id FROM material_definitions')}
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


def apply_database(store, approved, *, fault=None, original_root=None):
    """One atomic database change. File publication is a resumable next step."""
    from . import material_storage as storage, material_plans as mp
    if approved.get('format') != 'version-consolidation-plan-v1' or approved.get('id') != digest(canonical({k:v for k,v in approved.items() if k != 'id'}).encode()):
        raise ValueError('consolidation plan checksum mismatch')
    if not available(store):
        raise ValueError('initialize consolidation schema before applying')
    old = store.db.execute('SELECT receipt FROM consolidation_runs WHERE id=?', (approved['id'],)).fetchone()
    if old:
        if any(store.db.execute('SELECT 1 FROM revisions WHERE id=?', (r['revision_id'],)).fetchone() for r in approved['delete_revisions']):
            raise Conflict('deleted revision was restored after consolidation')
        return {**json.loads(old[0]), 'already_applied': True, 'additional_deletions': 0}
    store.db.commit()
    store.db.execute('BEGIN IMMEDIATE')
    store._material_migrating = True
    try:
        if fingerprint(store) != approved['baseline']:
            raise Conflict('database head changed; no consolidation applied')
        for item in approved['verified_files']:
            path = (Path(original_root) if original_root is not None else p.root_of(store)/'export/assets')/item['file']
            if not path.is_file() or physical_file_hash(path) != item['physical_sha256']:
                raise Conflict('original file changed; no consolidation applied: '+item['file'])
        lost = {r['revision_id'] for r in approved['delete_revisions']}
        selection = {r['object_id']: r['old_number'] for r in approved['objects'] if r['kind'] == 'MATERIAL'}
        reset = {r['object_id'] for r in approved['objects'] if r['kind'] in CORE_KINDS}
        bindings = [dict(r) for r in store.db.execute('SELECT * FROM material_definition_versions') if r['number'] == selection.get(r['material_id'])]
        versions = [dict(r) for r in store.db.execute('SELECT * FROM material_plan_versions') if r['number'] == selection.get(r['material_id'])]
        members = [dict(r) for r in store.db.execute('SELECT * FROM material_plan_members') if r['number'] == selection.get(r['material_id']) and r['revision_id'] not in lost]
        comments = [dict(r) for r in store.db.execute('SELECT * FROM material_plan_comments') if r['number'] == selection.get(r['material_id']) and r['comment_id'] not in approved['delete_comments']]
        member_keys = {(r['material_id'], r['revision_id']) for r in members}
        legacy_scopes = [dict(r) for r in store.db.execute('SELECT s.*,c.target_revision_id FROM material_comment_scopes s JOIN comments c ON c.id=s.comment_id')
                         if r['comment_id'] not in approved['delete_comments'] and (r['material_id'],r['target_revision_id']) in member_keys]
        feedback = [dict(r) for r in store.db.execute('SELECT * FROM material_feedback') if r['comment_id'] not in approved['delete_comments'] and r['material_id'] in selection]
        created = {r['material_id']:r['created_at'] for r in store.db.execute('SELECT * FROM material_rounds ORDER BY number DESC')}
        # Capture before deleting any referenced source. These hashes retain no
        # prompt/body and preserve the original plan/call equivalence relation.
        signatures = {}
        for rid in sorted({r['revision_id'] for r in members if r['role'] in ('plan', 'call')}):
            row = p.record(store, revision_id=rid)
            signatures[rid] = mp.signature(row, store)
        for table in ('material_plan_comments', 'material_plan_members', 'material_definition_versions', 'material_plan_versions',
                      'material_feedback', 'material_comment_scopes', 'material_members', 'material_rounds'):
            store.db.execute('DELETE FROM '+table)
        for table, field in (('comment_events','comment_id'), ('business_comments','comment_id'), ('state_cleanup_comments','comment_id'), ('relation_redacted_comments','comment_id'), ('comments','id')):
            _delete_ids(store, table, field, approved['delete_comments'])
        for table, field in (('dependencies','from_revision'), ('dependencies','to_revision'),
                             ('material_candidate_members','revision_id'), ('state_cleanup_preserved','revision_id'),
                             ('relation_explanation_redactions','revision_id')):
            _delete_ids(store, table, field, lost)
        for r in approved['delete_revisions']:
            store.db.execute('INSERT INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
                             (r['revision_id'], r['object_id'], r['kind'], r['old_number'], None, r['payload_sha256'], None, approved['id']))
        _delete_ids(store, 'revisions', 'id', lost)
        for table, field in (('material_aliases','alias_id'), ('material_aliases','material_id')):
            _delete_ids(store, table, field, approved['delete_objects'])
        _delete_ids(store, 'material_aliases', 'alias_id', approved['delete_aliases'])
        store.db.executemany('INSERT INTO consolidation_objects VALUES (?,?)',((oid,approved['id']) for oid in approved['delete_objects']))
        _delete_ids(store, 'objects', 'id', approved['delete_objects'])
        for item in approved['identity_only']:
            oid = item['object_id']
            body = clear_references(item['payload'], lost, selection)
            rid = digest(canonical({'object_id':oid,'version':1,'payload':body,'baseline':approved['id']}).encode())
            at = store.db.execute('SELECT created_at FROM objects WHERE id=?',(oid,)).fetchone()[0]
            store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)', (rid, oid, 1, storage.encode(store, body), at))
            store.db.execute('UPDATE objects SET current_revision=?,version=1 WHERE id=?', (rid, oid))
            store.db.execute('INSERT INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
                (rid, oid, 'REQUIREMENT', 0, 1, digest(canonical(item['payload']).encode()), row_hash(oid,1,body), approved['id']))
            store.db.executemany('INSERT INTO dependencies VALUES (?,?,?)',
                ((rid, ref['revision_id'], path) for path,ref in p.references(body)))
        # Business numbers remain reserved in business_codes. No deleted
        # identity can be reused by a later object or misleading old link.
        changed = 0
        for meta in list(store.db.execute('SELECT r.id,r.object_id,r.version,o.kind FROM revisions r JOIN objects o ON o.id=r.object_id ORDER BY r.id')):
            raw = store.db.execute('SELECT payload FROM revisions WHERE id=?', (meta['id'],)).fetchone()[0]
            payload = json.loads(raw)
            missing = []
            modified = clear_references(payload, lost, selection, missing=missing)
            # A real call is immutable evidence, including its lost sources.
            # Its missing edges live solely in the explicit receipt index.
            body = payload if meta['kind'] == 'CALL' else modified
            number = 1 if meta['object_id'] in reset else meta['version']
            changed_payload = body != payload
            if changed_payload or number != meta['version'] or meta['id'] in signatures or missing:
                store.db.execute('INSERT OR IGNORE INTO consolidation_revisions VALUES (?,?,?,?,?,?,?,?)',
                    (meta['id'], meta['object_id'], meta['kind'], meta['version'], number,
                     digest(raw.encode()), row_hash(meta['object_id'], number, body), approved['id']))
                if changed_payload:
                    store.db.execute('UPDATE revisions SET payload=?,version=? WHERE id=?',
                                     (storage.encode(store, body), number, meta['id']))
                    changed += 1
                elif number != meta['version']:
                    store.db.execute('UPDATE revisions SET version=? WHERE id=?', (number, meta['id']))
                store.db.executemany('INSERT INTO consolidation_missing VALUES (?,?,?,?)',
                                     ((meta['id'], *item) for item in missing))
                if changed_payload:
                    store.db.execute('DELETE FROM dependencies WHERE from_revision=?', (meta['id'],))
                    store.db.executemany('INSERT OR IGNORE INTO dependencies VALUES (?,?,?)',
                        ((meta['id'], ref['revision_id'], path) for path, ref in p.references(body)))
        for obj in list(store.db.execute('SELECT * FROM objects')):
            rows = store.db.execute('SELECT id,version FROM revisions WHERE object_id=? ORDER BY version DESC', (obj['id'],)).fetchall()
            if not rows:
                raise ValueError('consolidation left an object without a head')
            if not any(r['id'] == obj['current_revision'] for r in rows) or obj['id'] in reset:
                store.db.execute('UPDATE objects SET current_revision=?,version=? WHERE id=?', (rows[0]['id'], rows[0]['version'], obj['id']))
        fingerprint_map = {}
        for row in bindings:
            old_content = storage.expand(store, row['definition_id'])
            content = clear_references(old_content, lost, selection)
            key = storage.intern(store, content)
            store.db.execute('INSERT OR IGNORE INTO material_definitions VALUES (?)', (key,))
            row.update(number=1, definition_id=key)
            row['provenance'] = canonical(clear_references(json.loads(row['provenance']), lost, selection))
            if content != old_content:
                row['gaps'] = canonical(sorted(set(json.loads(row['gaps'])) | {'consolidation_missing_reference'}))
            old_version = next(v for v in versions if v['material_id'] == row['material_id'])
            # Complete definitions use their canonical value as the signature.
            # Incomplete historic calls also carry the exact call identity.
            source = json.loads(row['provenance']).get('generation', {}).get('record', {})
            source_row = p.ref_record(store, source)
            identity = {'definition': content, 'incomplete_call': source_row['object_id']} if source_row['kind'] == 'CALL' and not mp.known(source_row) else content
            new_fp = digest(canonical(identity).encode())
            fingerprint_map[old_version['fingerprint']] = new_fp
            old_version['fingerprint'] = new_fp
        for row in versions:
            store.db.execute('INSERT INTO material_plan_versions VALUES (?,?,?,?,?)', (row['material_id'], 1, row['fingerprint'], row['frozen'], row['evidence']))
            has_result = any(r['material_id'] == row['material_id'] and r['role'] == 'result' for r in members)
            store.db.execute('INSERT INTO material_rounds VALUES (?,?,?,?)', (row['material_id'], 1, 'produced' if has_result else 'preparing', created.get(row['material_id'],'')))
        for row in bindings:
            store.db.execute('INSERT INTO material_definition_versions VALUES (?,?,?,?,?)', tuple(row[k] for k in ('material_id','number','definition_id','provenance','gaps')))
            store.db.execute('INSERT INTO consolidation_definitions VALUES (?,?,?,?)', (row['material_id'], 1, digest(canonical(row).encode()), approved['id']))
        for row in members:
            store.db.execute('INSERT INTO material_plan_members VALUES (?,?,?,?)', (row['material_id'], 1, row['revision_id'], row['role']))
            store.db.execute('INSERT INTO material_members VALUES (?,?,?,?,?)', (row['material_id'], 1, row['revision_id'], row['role'], 'retained exact plan member'))
        for row in comments:
            store.db.execute('INSERT INTO material_plan_comments VALUES (?,?,?)', (row['comment_id'], row['material_id'], 1))
            store.db.execute('INSERT OR IGNORE INTO material_comment_scopes VALUES (?,?,?)', (row['comment_id'], row['material_id'], 1))
        for row in legacy_scopes:
            store.db.execute('INSERT OR IGNORE INTO material_comment_scopes VALUES (?,?,?)', (row['comment_id'], row['material_id'], 1))
        for row in feedback:
            store.db.execute('INSERT INTO material_feedback VALUES (?,?,?)', (row['comment_id'], row['material_id'], 1))
        for r in approved['objects']:
            if r['kind'] == 'MATERIAL':
                for v in r['versions']:
                    store.db.execute('INSERT INTO consolidation_versions VALUES (?,?,?,?)', (r['object_id'], v['number'], 1 if v['number'] == r['old_number'] else None, approved['id']))
        store.db.executemany('INSERT INTO consolidation_signatures VALUES (?,?)', ((rid, fingerprint_map.get(fp, fp)) for rid, fp in signatures.items()))
        # Candidate identity is retained; the displayed number is local to V1.
        existing = [dict(r) for r in store.db.execute('SELECT * FROM business_candidates')]
        store.db.execute('DELETE FROM business_candidates')
        for mid in selection:
            ids = {r[0] for r in store.db.execute('SELECT DISTINCT c.candidate_id FROM material_candidate_members c JOIN material_plan_members m ON m.revision_id=c.revision_id WHERE m.material_id=?', (mid,))}
            values = sorted((r for r in existing if r['material_id'] == mid and r['version'] == selection[mid] and r['candidate_id'] in ids), key=lambda r:r['number'])
            for r in values:
                columns = [v['name'] for v in store.db.execute('PRAGMA table_info(business_candidates)')]
                r['version'] = 1
                store.db.execute('INSERT INTO business_candidates VALUES ('+','.join('?' for _ in columns)+')', tuple(r[k] for k in columns))
        archive_before=store.db.execute('SELECT count(*) FROM material_archive_files').fetchone()[0]
        _delete_ids(store,'material_archive_files','path',approved.get('archive_deletions',[]))
        deleted_archives=archive_before-store.db.execute('SELECT count(*) FROM material_archive_files').fetchone()[0]
        content_receipt = collect_content(store)
        if store.db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('consolidation foreign key failure')
        receipt = {**content_receipt,'deleted_archive_entries':deleted_archives,
                   'deleted_revisions': len(lost), 'deleted_objects': len(approved['delete_objects']),
                   'deleted_comments': len(approved['delete_comments']), 'rewritten_references_in_revisions': changed,
                   'missing_references': store.db.execute('SELECT COUNT(*) FROM consolidation_missing').fetchone()[0]}
        receipt['database_head_sha256'] = digest(canonical({k:v for k,v in fingerprint(store).items() if k!='consolidation_runs'}).encode())
        store.db.execute('INSERT INTO consolidation_runs VALUES (?,?,?)', (approved['id'], digest(canonical(approved).encode()), canonical(receipt)))
        if fault == 'before_commit':
            raise RuntimeError('injected failure before database commit')
        store.db.commit()
        if fault == 'after_commit':
            raise RuntimeError('injected interruption after database commit')
        return receipt
    except BaseException:
        store.db.rollback()
        raise
    finally:
        store._material_migrating = False
