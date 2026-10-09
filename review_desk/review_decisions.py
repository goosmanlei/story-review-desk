"""Project existing judgments without granting approval to another revision."""
from . import production as p


def scope_records(store, scope):
    references = scope if isinstance(scope, list) else [r for value in (scope or {}).values()
                                                      for r in (value if isinstance(value, list) else [value])]
    result = []
    for reference in references:
        if not isinstance(reference, dict) or not reference.get('revision_id'):
            continue
        row = p.ref_record(store, reference)
        result.append({k: row.get(k) for k in ('object_id', 'id', 'kind', 'version', 'business_code')}
                      | {'title': row['payload']['title']})
    return result


def snapshot(store, object_id, revision_id=None):
    target = p.record(store, object_id, revision_id)
    rows = [p.record(store, revision_id=r[0]) for r in store.db.execute("""
        SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id
        WHERE o.kind='JUDGMENT' AND json_extract(r.payload,'$.target.object_id')=?
        ORDER BY r.created_at DESC,r.version DESC,r.id DESC""", (target['object_id'],))]
    for row in rows:
        exact = p.ref_record(store, row['payload']['target'])
        row['target_version'] = exact.get('version')
    current = [r for r in rows if r['id'] == r['current_revision'] and
               r['payload']['target']['revision_id'] == target['id']]
    # Independent opinions remain independent. Chronology is not a resolution
    # rule; revising one judgment supersedes only that judgment's old revision.
    opinions = [r for r in current if not r['payload'].get('acceptance_model') and
                not r['payload'].get('change')]
    positive = any(r['payload']['verdict'] in ('accepted', 'passed') for r in opinions)
    negative = any(r['payload']['verdict'] in ('changes_requested', 'rejected') for r in opinions)
    ids = {r['id'] for r in current}
    return {'target': {'object_id': target['object_id'], 'revision_id': target['id']}, 'current': current,
            'history': [r for r in rows if r['id'] not in ids],
            'conflicting': positive and negative}
