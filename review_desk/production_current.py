"""Mutable production content and immutable submission evidence.

The single revision envelope of a production object is an address, not a saved
draft. ``objects.version`` is only a compare-and-swap counter. Story revisions
and method records keep their existing immutable contracts.
"""
import copy
import json

from .store import Conflict, canonical, digest, now

CONTRACT = 'production-current-candidates-v1'
CURRENT_KINDS = frozenset(('ENTITY', 'STATE', 'INPUT_LOCK', 'RELATION',
                           'AV_EPISODE', 'AV_SCENE', 'AV_SHOT', 'REQUIREMENT'))
RECORD_KINDS = CURRENT_KINDS | {'ASSET', 'CALL', 'DELETED_STATE'}
TABLES = ('production_current_policy', 'production_current_records',
          'production_submissions', 'production_candidates', 'production_candidate_targets',
          'production_legacy_links', 'production_comment_quotes', 'production_current_operations',
          'production_current_baselines', 'production_response_excerpts')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS production_current_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), contract TEXT NOT NULL, migration_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_current_records (
 object_id TEXT PRIMARY KEY REFERENCES objects(id),
 revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id),
 edit_token INTEGER NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_submissions (
 operation_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL,
 snapshot_sha256 TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_candidates (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES production_submissions(operation_id),
 asset_object_id TEXT NOT NULL UNIQUE REFERENCES objects(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_candidate_targets (
 candidate_id TEXT NOT NULL REFERENCES production_candidates(id),
 material_id TEXT NOT NULL, number INTEGER NOT NULL,
 PRIMARY KEY(candidate_id,material_id), UNIQUE(material_id,number));
CREATE TABLE IF NOT EXISTS production_legacy_links (
 revision_id TEXT PRIMARY KEY, object_id TEXT NOT NULL, kind TEXT NOT NULL,
 target_object_id TEXT, target_revision_id TEXT, candidate_id TEXT,
 disposition TEXT NOT NULL, payload_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_comment_quotes (
 comment_id TEXT PRIMARY KEY REFERENCES comments(id), object_id TEXT NOT NULL,
 original_revision_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
 excerpt TEXT NOT NULL, target_kind TEXT NOT NULL, candidate_id TEXT);
CREATE TABLE IF NOT EXISTS production_current_operations (
 id TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_current_baselines (
 object_id TEXT PRIMARY KEY, payload_sha256 TEXT NOT NULL, original_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS production_response_excerpts (
 evidence_id TEXT NOT NULL, locator TEXT NOT NULL, object_id TEXT NOT NULL,
 original_revision_id TEXT NOT NULL, content_sha256 TEXT NOT NULL, excerpt TEXT NOT NULL,
 PRIMARY KEY(evidence_id,locator));
CREATE TRIGGER IF NOT EXISTS production_submission_immutable
 BEFORE UPDATE ON production_submissions BEGIN
 SELECT RAISE(ABORT,'submission snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS production_current_one_record
 BEFORE INSERT ON revisions
 WHEN EXISTS(SELECT 1 FROM production_current_records WHERE object_id=NEW.object_id)
 BEGIN SELECT RAISE(ABORT,'production content has one current record'); END;
CREATE TRIGGER IF NOT EXISTS production_current_no_old_writer
 BEFORE UPDATE ON objects
 WHEN EXISTS(SELECT 1 FROM production_current_records WHERE object_id=OLD.id)
 AND NEW.current_revision!=OLD.current_revision
 BEGIN SELECT RAISE(ABORT,'production current address cannot change'); END;
'''


def enabled(store):
    return bool(store.db.execute("SELECT 1 FROM sqlite_master WHERE name='production_current_policy'").fetchone()
                and store.db.execute('SELECT 1 FROM production_current_policy WHERE id=1').fetchone())


def address(object_id):
    return digest(canonical({'contract': CONTRACT, 'object_id': object_id}).encode())


def checksum(payload):
    return digest(canonical(payload).encode())


def guard(store, object_id, expected):
    row = store.db.execute('SELECT * FROM production_current_records WHERE object_id=?', (object_id,)).fetchone()
    if not row or not isinstance(expected, dict) or expected.get('edit_token') != row['edit_token'] or expected.get('content_sha256') != row['payload_sha256']:
        raise Conflict('当前制作内容已改变；请回读后保留草稿并重新准备：' + object_id)


def marker(row):
    return {'edit_token': row.get('edit_token', row['version']), 'content_sha256': checksum(row['payload'])}


def valid_record(store, oid, token, payload, rid):
    if not enabled(store):
        return False
    row = store.db.execute('SELECT * FROM production_current_records WHERE object_id=?', (oid,)).fetchone()
    if row is None and rid == address(oid):
        obj = store.db.execute('SELECT kind,version,current_revision FROM objects WHERE id=?', (oid,)).fetchone()
        return bool(obj and obj['kind'] in RECORD_KINDS and obj['version'] == token and obj['current_revision'] == rid)
    return bool(row and row['revision_id'] == rid == address(oid)
                and row['edit_token'] == token and row['payload_sha256'] == checksum(payload))


def annotate(store, value):
    if not enabled(store) or value.get('kind') not in RECORD_KINDS:
        return value
    value['current_content'] = value['kind'] in CURRENT_KINDS
    value['edit_token'] = value['version']
    value['content_sha256'] = checksum(value['payload'])
    candidate = store.db.execute('SELECT id,operation_id FROM production_candidates WHERE asset_object_id=?',
                                 (value['object_id'],)).fetchone()
    if candidate:
        value['candidate_id'] = candidate['id']
        value['submission'] = submission(store, candidate['operation_id'])
    return value


def submission(store, operation_id):
    row = store.db.execute('SELECT * FROM production_submissions WHERE operation_id=?', (operation_id,)).fetchone()
    if not row:
        raise KeyError('submission does not exist')
    snapshot = json.loads(row['snapshot'])
    if checksum(snapshot) != row['snapshot_sha256']:
        raise ValueError('submission snapshot checksum mismatch')
    return {**dict(row), 'snapshot': snapshot}


def save_submission(store, operation_id, snapshot, *, origin='submitted', created_at=None):
    """Caller owns the transaction; execute BEFORE handing a request to a tool."""
    old = store.db.execute('SELECT snapshot_sha256 FROM production_submissions WHERE operation_id=?',
                           (operation_id,)).fetchone()
    sha = checksum(snapshot)
    if old:
        if old[0] != sha:
            raise Conflict('operation already has different submitted inputs; use a new operation identity')
        return submission(store, operation_id)
    store.db.execute('INSERT INTO production_submissions VALUES (?,?,?,?,?)',
                     (operation_id, canonical(snapshot), sha, origin, created_at or now()))
    return submission(store, operation_id)


def capture_submission(store, object_id, payload):
    """Capture actual request plus the exact necessary plan and selected files.

    Receipts/status/outputs may become known later. They stay on the call;
    none of these later values is represented as a submitted fact.
    """
    from . import production as p
    fields = ('method', 'tool', 'model', 'parameters', 'prompt', 'inputs', 'output',
              'randomization', 'execution', 'method_basis', 'generation_requirement',
              'prepared_plan', 'request_id', 'request', 'lineage')
    result = {'format': 'production-submission-v1', 'operation_id': object_id,
              'request': {k: copy.deepcopy(payload[k]) for k in fields if k in payload},
              'requirements': [], 'input_contents': [], 'basis_contents': [], 'gaps': []}
    reference = payload.get('generation_requirement') or payload.get('prepared_plan')
    if reference:
        try:
            need = p.ref_record(store, reference, {'REQUIREMENT'})
            result['requirements'].append({'object_id': need['object_id'], 'revision_id': need['id'],
                                           'content_sha256': checksum(need['payload']),
                                           'payload': copy.deepcopy(need['payload'])})
        except (KeyError, ValueError):
            result['gaps'].append({'field': 'requirements', 'reference': reference,
                                   'reason': 'exact historical requirement unavailable'})
    else:
        result['gaps'].append({'field': 'requirements', 'reason': 'no saved submitted requirement'})
    for index, ref in enumerate(payload.get('inputs', [])):
        entry = {'index': index, 'reference': copy.deepcopy(ref)}
        try:
            row = p.ref_record(store, ref)
            entry.update(kind=row['kind'], content_sha256=checksum(row['payload']))
            if ref.get('component_id'):
                _, component = p.component_for(store, ref, ref['component_id'])
                p.validate_selection(component, ref)
                entry['component'] = copy.deepcopy(component)
                entry['title'] = row['payload'].get('title')
            else:
                body = row['payload']
                if row['kind'] == 'SOURCE':
                    body = store.source(row['object_id'])
                # Actual nonmedia input content is evidence. Do not recursively
                # copy its upstream dependencies or a whole production tree.
                entry['content'] = copy.deepcopy(body)
            result['input_contents'].append(entry)
        except (KeyError, ValueError) as exc:
            entry['unavailable'] = str(exc)
            result['input_contents'].append(entry)
            result['gaps'].append({'field': 'input_contents', 'index': index, 'reason': str(exc)})
    # Save the necessary state, purpose and selected story/method basis. Do not
    # traverse parent scene/episode compositions or archive upstream drafts.
    basis_kinds = {'ENTITY', 'STATE', 'INPUT_LOCK', 'SOURCE', 'EPISODE', 'STORY', 'GUIDANCE',
                   'AV_SHOT', 'AV_SCENE', 'AV_EPISODE'}
    pending = [ref for need in result['requirements'] for _, ref in p.references(need['payload'])]
    seen = set()
    while pending:
        ref = pending.pop(0)
        key = (ref['object_id'], ref['revision_id'], canonical({k:ref[k] for k in ('scene_id','block_ids') if k in ref}))
        if key in seen: continue
        seen.add(key)
        try:
            row = p.ref_record(store, ref)
            if row['kind'] not in basis_kinds: continue
            body = store.source(row['object_id']) if row['kind'] == 'SOURCE' else row['payload']
            original_sha = checksum(body)
            if row['kind'] in ('AV_SHOT','AV_SCENE','AV_EPISODE'):
                # The actually used scope and key states, never a saved copy of
                # the whole episode/scene composition or recursive parent tree.
                body = {k:copy.deepcopy(body[k]) for k in
                        ('format','title','purpose','key_states','source','sources','reading_contract') if k in body}
            if row['kind'] in ('SOURCE','EPISODE') and ref.get('block_ids'):
                body = {k:copy.deepcopy(body[k]) for k in ('format','title','number') if k in body}
                blocks = (store.source(row['object_id']) if row['kind']=='SOURCE' else row['payload']).get('blocks',[])
                body['blocks'] = [copy.deepcopy(b) for b in blocks if b['id'] in ref['block_ids']]
            # Method executions/artifacts may contain past full inputs. Their
            # immutable identity is enough; save method definitions, not runs.
            if row['kind'] == 'GUIDANCE' and body.get('format') not in ('managed-method-skill-v1', 'managed-method-binding-v1'):
                continue
            result['basis_contents'].append({'reference': copy.deepcopy(ref), 'kind': row['kind'],
                                             'content': copy.deepcopy(body), 'content_sha256': checksum(body),
                                             'source_content_sha256': original_sha})
            if row['kind'] in ('STATE','AV_SHOT','AV_SCENE','AV_EPISODE'):
                pending.extend(r for _, r in p.references(body))
        except (KeyError, ValueError) as exc:
            result['gaps'].append({'field': 'basis_contents', 'reference': ref, 'reason': str(exc)})
    return result


def write_record(store, object_id, kind, payload, current, dependencies):
    """Write exactly one content envelope; no hidden draft or parent history."""
    from .business_codes import allocate
    if kind not in RECORD_KINDS:
        raise ValueError('not a current production record')
    rid = address(object_id)
    token = (current['version'] if current else 0) + 1
    stamp = now()
    if kind == 'CALL' and payload.get('status') in ('submitted', 'completed', 'failed', 'unknown'):
        if not store.db.execute('SELECT 1 FROM production_submissions WHERE operation_id=?', (object_id,)).fetchone():
            if payload.get('status') != 'submitted':
                raise Conflict('a new call must persist submitted inputs before results or failure')
            save_submission(store, object_id, capture_submission(store, object_id, payload))
    if kind == 'ASSET':
        validate_candidate_update(store, object_id, payload, current)
        operation = payload.get('production', {}).get('object_id') or 'source:'+object_id
        payload = {**payload, 'candidate_identity': 'candidate-'+digest(canonical({'operation': operation}).encode())}
    sha = checksum(payload)
    if current:
        if current['current_revision'] != rid:
            raise Conflict('production migration is required before a current write')
        store.db.execute('UPDATE production_current_records SET edit_token=?,payload_sha256=? WHERE object_id=?',
                         (token, sha, object_id))
        store.db.execute('UPDATE revisions SET payload=?,version=? WHERE id=?', (canonical(payload), token, rid))
        store.db.execute('UPDATE objects SET version=?,updated_at=? WHERE id=?', (token, stamp, object_id))
        store.db.execute('DELETE FROM dependencies WHERE from_revision=?', (rid,))
    else:
        store.db.execute('INSERT INTO objects VALUES (?,?,?,?,?,?)', (object_id, kind, rid, token, stamp, stamp))
        store.db.execute('INSERT INTO revisions VALUES (?,?,?,?,?)', (rid, object_id, token, canonical(payload), stamp))
        store.db.execute('INSERT INTO production_current_records VALUES (?,?,?,?)', (object_id, rid, token, sha))
    for ref in dependencies:
        target = store.db.execute('SELECT id FROM revisions WHERE id=?', (ref['revision_id'],)).fetchone()
        if target:
            store.db.execute('INSERT OR IGNORE INTO dependencies VALUES (?,?,?)', (rid, target[0], ref['role']))
        elif kind not in ('CALL', 'ASSET'):
            raise Conflict('current production reference is unavailable')
    allocate(store, object_id, kind, payload)
    if kind == 'RELATION' and payload.get('relation_type') == 'business':
        from .business_relations import register
        register(store, object_id, payload)
    if kind == 'ASSET':
        register_candidate(store, object_id, payload)
    return {'id': object_id, 'kind': kind, 'revision': rid, 'version': token,
            'edit_token': token, 'content_sha256': sha}


def validate_candidate_update(store, oid, payload, current):
    components = payload.get('components', [])
    if payload.get('placeholder') or not any(c.get('role') == 'original' for c in components):
        raise ValueError('a candidate requires actual original files')
    if current:
        previous = json.loads(store.db.execute('SELECT payload FROM revisions WHERE id=?', (current['current_revision'],)).fetchone()[0])
        if previous.get('production') != payload.get('production'):
            raise Conflict('a candidate cannot change its actual production operation')
        if previous.get('external_source') != payload.get('external_source'):
            raise Conflict('a candidate cannot rewrite its actual external source')
        keyed = {c['id']: c for c in components}
        if any(keyed.get(c['id']) != c for c in previous.get('components', [])):
            raise Conflict('candidate files are immutable; metadata updates may only add missing components')


def register_candidate(store, oid, payload):
    operation = (payload.get('production') or {}).get('object_id')
    if not operation:
        operation = 'source:'+oid
        source = payload.get('external_source')
        if not source:
            raise ValueError('无调用原件须提供真实来源，不能虚构生成调用')
        save_submission(store, operation, {'format': 'production-submission-v1', 'operation_id': operation,
                         'source': source, 'request': {}, 'requirements': [], 'input_contents': [],
                         'gaps': [{'field': 'request', 'reason': 'external original; no model call'}]}, origin='external')
    submission(store, operation)
    cid = 'candidate-' + digest(canonical({'operation': operation}).encode())
    old = store.db.execute('SELECT asset_object_id FROM production_candidates WHERE operation_id=?', (operation,)).fetchone()
    if old and old[0] != oid:
        raise Conflict('the operation already has a candidate; append components to that candidate')
    store.db.execute('INSERT OR IGNORE INTO production_candidates VALUES (?,?,?,?)', (cid, operation, oid, now()))
    refs = payload.get('candidate_requirements', [])
    snap = submission(store, operation)['snapshot']
    targets = {r['object_id'] for r in refs} | {r['object_id'] for r in snap.get('requirements', [])}
    if not targets:
        targets = {oid}
    for mid in sorted(targets):
        if store.db.execute('SELECT 1 FROM production_candidate_targets WHERE candidate_id=? AND material_id=?', (cid, mid)).fetchone():
            continue
        number = store.db.execute('SELECT coalesce(max(number),0)+1 FROM production_candidate_targets WHERE material_id=?', (mid,)).fetchone()[0]
        store.db.execute('INSERT INTO production_candidate_targets VALUES (?,?,?)', (cid, mid, number))
    return cid


def remember_comment(store, comment):
    from . import production as p
    row = p.record(store, comment['target_object_id'], comment['target_revision_id'])
    if row['kind'] not in RECORD_KINDS:
        return
    anchor = comment['anchor']
    excerpt = {'anchor': copy.deepcopy(anchor), 'title': row['payload'].get('title')}
    # Quotes and original coordinates are enough for comments. An overall
    # comment is an overall comment, not permission to archive the whole draft.
    store.db.execute('INSERT INTO production_comment_quotes VALUES (?,?,?,?,?,?,?)',
                     (comment['id'], row['object_id'], row['id'], checksum(row['payload']),
                      canonical(excerpt), row['kind'], row.get('candidate_id') or
                      ('candidate-'+digest(canonical({'operation': row['payload'].get('production', {}).get('object_id') or 'source:'+row['object_id']}).encode()) if row['kind']=='ASSET' else None)))


def comment_context(store, comment):
    row = store.db.execute('SELECT * FROM production_comment_quotes WHERE comment_id=?', (comment['id'],)).fetchone()
    if not row:
        return comment
    value = dict(row)
    value['excerpt'] = json.loads(value['excerpt'])
    current = store.db.execute('SELECT payload_sha256 FROM production_current_records WHERE object_id=?', (row['object_id'],)).fetchone()
    value['matches_current'] = bool(current and current[0] == row['content_sha256'])
    if row['candidate_id'] and value['excerpt']['anchor'].get('type') in ('global', 'visual', 'time', 'region'):
        from . import production as p
        try:
            asset = p.record(store, row['object_id'])
            anchor = value['excerpt']['anchor']
            candidate = store.db.execute('SELECT asset_object_id FROM production_candidates WHERE id=?', (row['candidate_id'],)).fetchone()
            value['matches_current'] = bool(candidate and candidate[0] == row['object_id'] and
                (anchor['type'] == 'global' or any(c['file'] == anchor.get('asset_file') for c in asset['payload'].get('components', []))))
        except KeyError:
            value['matches_current'] = False
    comment['original_context'] = value
    return comment


def dump(store):
    return {table: [dict(r) for r in store.db.execute('SELECT * FROM '+table+' ORDER BY 1,2')]
            for table in TABLES}


# Read adapters for existing list/association queries. These are TEMP views,
# never exported, never writable and contain no historical version storage.
# Keep their removal independent of the on-disk migration/rollback contract.
LEGACY_TABLES = ('material_feedback', 'material_comment_scopes', 'material_members', 'material_rounds',
                 'material_plan_comments', 'material_candidate_members', 'material_plan_members',
                 'material_definition_versions', 'material_definitions', 'material_plan_versions',
                 'business_candidates')


def read_adapters(store):
    if not enabled(store):
        return
    views = {
        'material_plan_members': '''SELECT o.id material_id,1 number,o.current_revision revision_id,'plan' role
            FROM objects o WHERE o.kind='REQUIREMENT'
            UNION SELECT t.material_id,1,o.current_revision,'result'
            FROM production_candidate_targets t JOIN production_candidates c ON c.id=t.candidate_id
            JOIN objects o ON o.id=c.asset_object_id
            UNION SELECT t.material_id,1,o.current_revision,'call'
            FROM production_candidate_targets t JOIN production_candidates c ON c.id=t.candidate_id
            JOIN objects o ON o.id=c.operation_id''',
        'material_plan_versions': '''SELECT DISTINCT m.material_id,1 number,coalesce(c.payload_sha256,'') fingerprint,
            0 frozen,'current-content' evidence FROM material_plan_members m
            LEFT JOIN production_current_records c ON c.object_id=m.material_id''',
        'material_candidate_members': '''SELECT c.id candidate_id,o.current_revision revision_id
            FROM production_candidates c JOIN objects o ON o.id=c.asset_object_id''',
        'material_members': "SELECT *, 'current-content' evidence FROM material_plan_members",
        'material_rounds': "SELECT material_id,number,'current' state,'' created_at FROM material_plan_versions",
        'material_feedback': "SELECT '' comment_id,'' material_id,1 number WHERE 0",
        'material_comment_scopes': "SELECT '' comment_id,'' material_id,1 number WHERE 0",
        'material_plan_comments': "SELECT '' comment_id,'' material_id,1 number WHERE 0",
        'material_definition_versions': "SELECT '' material_id,1 number,'' definition_id,'{}' provenance,'[]' gaps WHERE 0",
        'material_definitions': "SELECT '' id WHERE 0",
        'business_candidates': 'SELECT material_id,1 version,candidate_id,number FROM production_candidate_targets',
    }
    for name, query in views.items():
        store.db.execute('CREATE TEMP VIEW IF NOT EXISTS '+name+' AS '+query)


def material_snapshot(store, mid):
    from . import production as p
    from .material_storage import canonical_id
    try:
        target = p.record(store, mid)
    except KeyError:
        target = None
    plan = target if target and target['kind'] == 'REQUIREMENT' else None
    if plan:
        plan['review_input_records'] = [p.ref_record(store, item['reference'])
                                      for item in plan['payload'].get('generation', {}).get('inputs', [])]
    rows = list(store.db.execute('''SELECT c.*,t.number FROM production_candidate_targets t
        JOIN production_candidates c ON c.id=t.candidate_id WHERE t.material_id=? ORDER BY t.number''', (mid,)))
    results = []
    for item in rows:
        candidate = p.record(store, item['asset_object_id'])
        candidate.update(candidate_id=item['id'], candidate_number=item['number'])
        results.append(candidate)
    return [{'model': CONTRACT, 'material_id': mid, 'canonical_material_id': canonical_id(store, mid),
             'number': 1, 'frozen': False, 'state': 'current', 'plan': plan,
             'results': results, 'members': ([plan] if plan else [])+results,
             'definition_records': {'requirement': plan, 'call': None},
             'feedback': [], 'current_content': True}]


def candidate_context(store, asset):
    from . import production as p
    op = (asset['payload'].get('production') or {}).get('object_id') or 'source:'+asset['object_id']
    saved = submission(store, op)
    snapshot = saved['snapshot']
    if saved['origin'] == 'external':
        return {'call': None, 'requirements': [], 'associated_requirements': [], 'inputs': [], 'submission': saved}
    call = p.record(store, op)
    call['submission_snapshot'] = snapshot
    plans = []
    for item in snapshot.get('requirements', []):
        plans.append({'object_id': item['object_id'], 'id': item['revision_id'], 'version': None,
                      'kind': 'REQUIREMENT', 'payload': item['payload'], 'submission_only': True,
                      'content_sha256': item['content_sha256'], 'operation_id': op})
    inputs = []
    for item in snapshot.get('input_contents', []):
        if item.get('component'):
            ref = item['reference'].get('reference', item['reference'])
            component = copy.deepcopy(item['component'])
            inputs.append({'object_id': ref['object_id'], 'id': ref['revision_id'], 'kind': 'ASSET',
                           'payload': {'title': item.get('title') or component['file'],
                                       'media_type': component['mime'].split('/')[0], 'components': [component]},
                           'submission_only': True, 'component_snapshot': True})
        elif item.get('content'):
            inputs.append({'object_id': item['reference']['object_id'], 'id': item['reference']['revision_id'],
                           'kind': item['kind'], 'payload': item['content'], 'submission_only': True})
    # Actual Prompt and parameters come from the immutable submitted request,
    # even if the mutable call's returned fields are later supplemented.
    call['payload'] = {**call['payload'], **copy.deepcopy(snapshot['request'])}
    call['review_input_records'] = inputs
    from .shot_references import slots
    call['input_slots'] = slots(store, call['payload'].get('inputs', []))
    return {'call': call, 'requirements': plans, 'associated_requirements': [],
            'inputs': inputs, 'submission': saved}


def input_slot(store, value, index):
    from . import production as p
    from .shot_references import input_key, with_identity
    from .production_media import validate_component
    result = {'index': index, 'input_key': input_key(value), 'material_id': None, 'number': None,
              'candidate': None, 'candidate_number': None, 'issues': [], 'value': value,
              'model': CONTRACT}
    try:
        target = p.ref_record(store, value.get('reference', value))
        result['record'] = target
        if target['kind'] not in ('ASSET', 'REQUIREMENT'):
            result['nonmedia'] = True
            return result
        selection = value.get('material_selection') or {}
        if target['kind'] == 'REQUIREMENT':
            result['material_id'] = target['object_id']
            result['issues'].append('尚未选定候选')
            return with_identity(store, result)
        candidate = store.db.execute('SELECT id FROM production_candidates WHERE asset_object_id=?', (target['object_id'],)).fetchone()
        if not candidate:
            raise ValueError('此引用没有真实候选')
        targets = list(store.db.execute('SELECT * FROM production_candidate_targets WHERE candidate_id=?', (candidate[0],)))
        mid = selection.get('material_id')
        if not mid and len(targets) == 1:
            mid = targets[0]['material_id']
        matched = next((t for t in targets if t['material_id'] == mid), None)
        if not matched:
            raise ValueError('需要明确候选的素材需求归属')
        if selection.get('candidate_id', candidate[0]) != candidate[0]:
            raise ValueError('参考候选身份不匹配')
        result.update(material_id=mid, number=1, candidate={'object_id': target['object_id'], 'revision_id': target['id']},
                      candidate_id=candidate[0], candidate_number=matched['number'])
        _, component = p.component_for(store, result['candidate'], value.get('component_id'))
        if component['role'] != 'original':
            raise ValueError('请选择准确原件组成')
        validate_component(p.root_of(store), component, inspect=False)
        if value.get('sha256', component['sha256']) != component['sha256']:
            raise ValueError('参考原件哈希不匹配')
        p.validate_selection(component, value)
        result['component'] = component
    except (KeyError, ValueError, OSError) as exc:
        result['issues'].append(str(exc))
    return with_identity(store, result)
