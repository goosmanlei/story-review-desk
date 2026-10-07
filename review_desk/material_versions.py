"""Material rounds are independent of immutable record revisions.

All mutators run inside the caller's SQLite transaction. History remains exact;
membership is an additional index, never a replacement for a revision link.
"""
import json
from .store import Conflict, canonical, digest, now
from . import production as p

TABLES = ('material_rounds', 'material_members', 'material_feedback', 'material_comment_scopes')


def result_identity(payload):
    return canonical({'call': (payload.get('production') or {}).get('object_id'),
                      'files': [c['sha256'] for c in payload.get('components', []) if c['role'] == 'original']})


def dump(store):
    return {name: [dict(r) for r in store.db.execute('SELECT * FROM ' + name + ' ORDER BY 1,2,3')]
            for name in TABLES}


def fingerprint(store):
    # Includes comments/events, so a migration cannot overwrite newer feedback.
    return digest(canonical({'objects': store.objects(), 'revisions': store.revisions(),
                             'dependencies': store.dependencies(), 'comments': store.comments(), 'events': store.events(), **dump(store)}).encode())


def latest(store, material_id):
    return store.db.execute('SELECT * FROM material_rounds WHERE material_id=? ORDER BY number DESC LIMIT 1', (material_id,)).fetchone()


def ensure(store, material_id):
    row = latest(store, material_id)
    if not row:
        root = p.record(store, material_id)
        if root['kind'] not in ('REQUIREMENT', 'ASSET'):
            raise ValueError('material identity must be a requirement or unassociated asset')
        store.db.execute('INSERT INTO material_rounds VALUES (?,?,?,?)', (material_id, 1, 'preparing', now()))
        row = latest(store, material_id)
    return row


def member(store, material_id, number, row, evidence):
    role = {'REQUIREMENT': 'plan', 'ASSET': 'result', 'CALL': 'call'}.get(row['kind'])
    if not role:
        raise ValueError('invalid material member kind')
    store.db.execute('INSERT OR IGNORE INTO material_members VALUES (?,?,?,?,?)',
                     (material_id, number, row['id'], role, evidence))
    if role == 'result' and not row['payload'].get('placeholder'):
        store.db.execute("UPDATE material_rounds SET state='produced' WHERE material_id=? AND number=?", (material_id, number))


def memberships(store, revision_id):
    return [dict(r) for r in store.db.execute('SELECT * FROM material_members WHERE revision_id=? ORDER BY material_id,number', (revision_id,))]


def register(store, row):
    """New plans/calls/results and metadata share a round; only feedback starts one."""
    payload = row['payload']
    if row['kind'] == 'REQUIREMENT':
        active = ensure(store, row['object_id'])
        member(store, row['object_id'], active['number'], row, 'requirement/plan update')
    elif row['kind'] == 'CALL':
        previous = store.db.execute("SELECT m.*,json_extract(r.payload,'$.status') AS call_status FROM material_members m JOIN revisions r ON r.id=m.revision_id WHERE r.object_id=? ORDER BY r.version DESC", (row['object_id'],)).fetchall()
        executed = [v for v in previous if v['call_status'] in ('submitted','completed')]
        targets = {(v['material_id'], v['number']) for v in executed or previous}
        if payload.get('generation_requirement') and (not targets or not executed and payload.get('status') in ('submitted','completed')):
            mid = payload['generation_requirement']['object_id']
            targets = {(mid, ensure(store, mid)['number'])}
        for mid, number in targets:
            member(store, mid, number, row, 'exact call lifecycle')
    elif row['kind'] == 'ASSET':
        call = p.ref_record(store, payload['production']) if payload.get('production') else None
        targets = {(v['material_id'], v['number']) for v in memberships(store, call['id'])} if call else set()
        # Association updates stay with the original call/file, even after a new round began.
        for ref in payload.get('candidate_requirements', []):
            mid = ref['object_id']
            old = store.db.execute('SELECT m.number,r.payload FROM material_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.role=\'result\' ORDER BY m.number DESC', (mid,)).fetchall()
            match = next((v for v in old if result_identity(json.loads(v['payload'])) == result_identity(payload)), None)
            if not any(t[0] == mid for t in targets):
                targets.add((mid, match['number'] if match else ensure(store, mid)['number']))
        if not targets:
            targets.add((row['object_id'], ensure(store, row['object_id'])['number']))
        for mid, number in targets:
            member(store, mid, number, row, 'exact result/association update')
            if call:
                member(store, mid, number, call, 'original submitted call')


def feedback(store, comment, intent):
    if intent is None:
        return
    if not isinstance(intent, dict) or set(intent) != {'material_id', 'expected_round'}:
        raise ValueError('material_revision requires material_id and expected_round')
    mid, expected = intent['material_id'], intent['expected_round']
    active = latest(store, mid)
    if not active or type(expected) is not int or expected != active['number']:
        raise Conflict('素材修订轮次已变化，请刷新后提交。')
    scopes = memberships(store, comment['target_revision_id'])
    if not any(v['material_id'] == mid and v['number'] in (expected, expected - 1 if active['state'] == 'preparing' else expected) for v in scopes):
        raise Conflict('修订意见不属于当前素材轮次。')
    number = expected
    if active['state'] == 'produced':
        number += 1
        store.db.execute('INSERT INTO material_rounds VALUES (?,?,?,?)', (mid, number, 'preparing', now()))
        # Carry only the plan into the next round, never the previous result.
        plans = store.db.execute('SELECT m.revision_id FROM material_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.number=? AND m.role=\'plan\' ORDER BY r.version DESC LIMIT 1', (mid, expected)).fetchall()
        for plan in plans:
            member(store, mid, number, p.record(store, revision_id=plan[0]), 'plan at revision feedback')
    store.db.execute('INSERT INTO material_feedback VALUES (?,?,?)', (comment['id'], mid, number))


def comment_scope(store, comment, context=None, intent=None):
    scopes = memberships(store, comment['target_revision_id'])
    if context is not None:
        if not isinstance(context, dict) or set(context) != {'material_id', 'number'} or type(context['number']) is not int:
            raise ValueError('material_context requires material_id and number')
        if not any(v['material_id'] == context['material_id'] and v['number'] == context['number'] for v in scopes):
            raise Conflict('评论锚点不属于所选素材版本。')
        chosen = {context['material_id']: context['number']}
    else:
        chosen = {}
        for value in scopes:
            # Direct tools use the latest round containing this exact target.
            limit = intent['expected_round'] if isinstance(intent, dict) and intent.get('material_id') == value['material_id'] else value['number']
            if value['number'] <= limit:
                chosen[value['material_id']] = max(chosen.get(value['material_id'], 0), value['number'])
    for mid, number in chosen.items():
        store.db.execute('INSERT INTO material_comment_scopes VALUES (?,?,?)', (comment['id'], mid, number))


def snapshot(store, material_id):
    from .version_consolidation import version_route
    rounds = []
    for value in store.db.execute('SELECT * FROM material_rounds WHERE material_id=? ORDER BY number DESC', (material_id,)):
        rows = [p.record(store, revision_id=v[0]) for v in store.db.execute('SELECT revision_id FROM material_members WHERE material_id=? AND number=? ORDER BY revision_id', (material_id, value['number']))]
        for row in rows:
            if row['kind']=='REQUIREMENT':
                row['review_input_records']=[p.ref_record(store,v['reference']) for v in row['payload'].get('generation',{}).get('inputs',[])]
        plans = sorted((r for r in rows if r['kind'] == 'REQUIREMENT'), key=lambda r: r['version'])
        results = sorted((r for r in rows if r['kind'] == 'ASSET'), key=lambda r: (r['object_id'], r['version']))
        # Same file/call with metadata completion is one candidate; distinct originals remain.
        candidates = {}
        for row in results:
            key = result_identity(row['payload'])
            candidates[key] = row
        rounds.append({**dict(value), **version_route(store,material_id), 'plan': plans[-1] if plans else None,
                       'results': list(candidates.values()), 'members': rows,
                       'feedback': [r[0] for r in store.db.execute('SELECT comment_id FROM material_feedback WHERE material_id=? AND number=? ORDER BY comment_id', (material_id, value['number']))]})
    return rounds


def for_record(store, row):
    if row['kind'] == 'REQUIREMENT':
        ids = [row['object_id']]
    else:
        ids = sorted({v['material_id'] for v in memberships(store, row['id'])})
        ids.sort(key=lambda v: v == row['object_id'])
    return {mid: snapshot(store, mid) for mid in ids}


def migrate(store, document, validate_only=False):
    """Apply a reviewed, complete membership map against an exact live fingerprint."""
    store.db.execute('BEGIN IMMEDIATE')
    try:
        if document.get('format') != 'material-round-migration-v1':
            raise ValueError('unsupported material migration')
        # Idempotence requires all existing rows to match; never apply a stale map over new work.
        proposed = document['members']
        if not isinstance(proposed,list) or not proposed:
            raise ValueError('nonempty material membership map required')
        if all(store.db.execute('SELECT 1 FROM material_members WHERE material_id=? AND number=? AND revision_id=? AND evidence=?', (v['material_id'], v['number'], v['revision_id'], v['evidence'])).fetchone() for v in proposed):
            store.db.rollback()
            return {'already_applied': True, 'members': len(proposed)}
        if fingerprint(store) != document.get('expected_fingerprint'):
            raise Conflict('正式数据已变化，重新核对迁移对应表。')
        if any(latest(store, v['material_id']) for v in proposed):
            raise Conflict('素材已有轮次记录，不能覆盖。')
        for value in proposed:
            mid, number = value['material_id'], value['number']
            if type(number) is not int or number < 1 or not value['evidence'].strip():
                raise ValueError('migration needs a positive round and evidence')
            ensure(store, mid)
            for n in range(2, number + 1):
                store.db.execute('INSERT OR IGNORE INTO material_rounds VALUES (?,?,?,?)', (mid, n, 'preparing', now()))
            member(store, mid, number, p.record(store, revision_id=value['revision_id']), value['evidence'])
        for scope in document.get('comment_scopes', []):
            store.db.execute('INSERT INTO material_comment_scopes VALUES (?,?,?)', (scope['comment_id'], scope['material_id'], scope['number']))
        validate(store, dump(store))
        if validate_only:
            store.db.rollback()
        else:
            store.db.commit()
    except BaseException:
        store.db.rollback()
        raise
    return {'already_applied': False, 'validated_only': validate_only, 'members': len(proposed)}


def validate(store, data):
    seen = set()
    for value in data.get('material_rounds', []):
        mid, number = value['material_id'], value['number']
        if p.record(store, mid)['kind'] not in ('REQUIREMENT', 'ASSET') or type(number) is not int or number < 1 or value['state'] not in ('preparing', 'produced') or (mid, number) in seen:
            raise ValueError('invalid material round')
        seen.add((mid, number))
    for mid, number in seen:
        if number > 1 and (mid, number - 1) not in seen:
            raise ValueError('nonconsecutive material rounds')
    for v in data.get('material_members', []):
        row = p.record(store, revision_id=v['revision_id'])
        if (v['material_id'], v['number']) not in seen or v['role'] != {'REQUIREMENT': 'plan', 'ASSET': 'result', 'CALL': 'call'}.get(row['kind']) or not v['evidence'].strip():
            raise ValueError('invalid material membership')
        if row['kind'] == 'REQUIREMENT' and row['object_id'] != v['material_id']:
            raise ValueError('plan belongs to a different requirement')
    for v in data.get('material_feedback', []):
        if (v['material_id'], v['number']) not in seen or not store.comment(v['comment_id']):
            raise ValueError('invalid material feedback')
    for v in data.get('material_comment_scopes', []):
        comment = store.comment(v['comment_id'])
        if not comment or (v['material_id'], v['number']) not in seen or not any(m['material_id'] == v['material_id'] and m['number'] == v['number'] and m['revision_id'] == comment['target_revision_id'] for m in data.get('material_members', [])):
            raise ValueError('comment is outside its material round')


def restore(store, data):
    validate(store, data)
    for name in TABLES:
        for value in data.get(name, []):
            store.db.execute('INSERT INTO ' + name + ' VALUES (' + ','.join('?' for _ in value) + ')', tuple(value[k] for k in {
                'material_rounds': ('material_id', 'number', 'state', 'created_at'),
                'material_members': ('material_id', 'number', 'revision_id', 'role', 'evidence'),
                'material_feedback': ('comment_id', 'material_id', 'number'),
                'material_comment_scopes': ('comment_id', 'material_id', 'number')}[name]))
