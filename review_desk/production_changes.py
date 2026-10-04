"""One revisable judgment for an exact target and upstream revision pair.

Legacy independent judgments remain immutable history. They become one current
conclusion only when an explicit new judgment references every legacy head.
"""
from .store import Conflict


def key(payload):
    change = payload.get('change')
    if not change:
        return None
    refs = [payload.get('target', {}), change.get('old', {}), change.get('new', {})]
    return tuple(part for ref in refs for part in (ref.get('object_id'), ref.get('revision_id'))) + (change.get('scope') or 'target',)


def exact(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def ref_set(refs):
    return {(ref.get('object_id'), ref.get('revision_id')) for ref in refs}


def current(rows):
    if len(rows) == 1:
        return rows[0]
    # No author/time priority. An explicitly consolidated head must account for
    # all the other heads, including their exact revisions.
    resolved = [row for row in rows if ref_set(row['payload'].get('change', {}).get('resolves', [])) ==
                ref_set([exact(other) for other in rows if other['object_id'] != row['object_id']])]
    return resolved[0] if len(resolved) == 1 else None


def validate(store, object_id, payload, check_current):
    from .production import current_records, record, ref_record
    business_key = key(payload)
    previous = store.db.execute('SELECT current_revision FROM objects WHERE id=?', (object_id,)).fetchone()
    if check_current and previous:
        previous_key = key(record(store, object_id)['payload'])
        if previous_key != business_key and (previous_key or business_key):
            raise Conflict('变更复核的准确对象和版本范围不能改变，请重新检查')
    if business_key is None:
        return
    resolves = payload['change'].get('resolves', [])
    if not isinstance(resolves, list):
        raise ValueError('change resolves must be exact judgment references')
    identities = []
    for ref in resolves:
        prior = ref_record(store, ref, {'JUDGMENT'})
        if set(ref) != {'object_id', 'revision_id'} or prior['object_id'] == object_id or key(prior['payload']) != business_key:
            raise ValueError('resolved judgment must have the same exact change scope')
        identities.append(prior['object_id'])
    if len(identities) != len(set(identities)):
        raise ValueError('resolved judgments must not repeat an object')
    if not check_current:
        return
    rows = [row for row in current_records(store, {'JUDGMENT'}) if key(row['payload']) == business_key]
    selected = current(rows)
    if selected:
        if selected['object_id'] != object_id:
            raise Conflict('这项变更已有复核结论，请重新检查后修改该结论')
        if ref_set(resolves) != ref_set(selected['payload'].get('change', {}).get('resolves', [])):
            raise Conflict('统一结论所依据的旧复核记录不能改变')
    elif rows:
        if any(row['object_id'] == object_id for row in rows) or ref_set(resolves) != ref_set([exact(row) for row in rows]):
            raise Conflict('旧复核结论不止一份或已经变化，请核对全部记录后保存统一结论')
    elif resolves:
        raise Conflict('待统一的旧复核记录已经变化，请重新检查')


def review(judgments, target, old, new, scope='target'):
    wanted = key({'target': target, 'change': {'old': old, 'new': new, 'scope': scope}})
    rows = [row for row in judgments if key(row['payload']) == wanted]
    selected = current(rows)
    return {'decision': selected, 'decisions': rows,
            'conflict': len(rows) > 1 and selected is None}
