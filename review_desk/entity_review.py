"""Immutable whole-entity review submissions, shared by page, HTTP and CLI."""
from .store import Conflict
from . import production as p
from .production_states import complete

MODEL = 'entity-review-v1'


def submission(row):
    return row['kind'] == 'REPRESENTATION' and row['payload'].get('review_model') == MODEL


def full_states(rows, entity_id):
    return [r for r in rows if complete(r) and r['payload']['entity']['object_id'] == entity_id]


def freshness(store, payload, rows=None):
    rows = rows if rows is not None else p.current_records(store)
    entity = p.record(store, payload['entities'][0]['object_id'])
    issues = []
    if entity['id'] != payload['entities'][0]['revision_id']:
        issues.append({'code': 'entity_changed', 'object_id': entity['object_id']})
    expected = {r['object_id']: r['revision_id'] for r in payload['states']}
    current = {r['object_id']: r['id'] for r in full_states(rows, entity['object_id'])}
    for oid in sorted(expected.keys() | current.keys()):
        if expected.get(oid) != current.get(oid):
            issues.append({'code': 'state_changed' if oid in expected and oid in current else 'state_membership_changed', 'object_id': oid})
    return issues


def validate(store, object_id, payload, check_current=True):
    if len(payload['entities']) != 1 or not payload['states']:
        raise ValueError('entity review requires one entity and all complete states')
    entity_id = payload['entities'][0]['object_id']
    states = payload['states']
    if len({r['object_id'] for r in states}) != len(states):
        raise ValueError('duplicate entity review state')
    for ref in states:
        row = p.ref_record(store, ref, {'STATE'})
        if not complete(row) or row['payload']['entity']['object_id'] != entity_id:
            raise ValueError('entity review requires owned complete states')
    media = p._list(payload, 'media')
    seen = set()
    for item in media:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id'] or item['id'] in seen:
            raise ValueError('distinct entity review media ids required')
        seen.add(item['id'])
        if item.get('state') not in states or item.get('role') not in ('overall', 'detail'):
            raise ValueError('review media must belong to an included exact state')
        p._text(item.get('label'), 'review media label')
        asset, component = p.component_for(store, item.get('asset'), item.get('component_id'))
        if not component['mime'].startswith(('image/', 'audio/', 'video/')):
            raise ValueError('review media requires image, audio or video')
        p.validate_selection(component, item)
        keys = ('state', 'role', 'component_id', 'crop', 'range')
        if not any(all(c.get(k) == item.get(k) for k in keys) for c in asset['payload'].get('state_coverage', [])):
            raise ValueError('review media requires explicit exact state coverage including selection')
    if check_current:
        rows = p.current_records(store)
        if any(submission(r) and r['object_id'] != object_id and r['payload']['entities'][0]['object_id'] == entity_id for r in rows):
            raise Conflict('entity already has a review submission object; revise that object')
        if freshness(store, payload, rows):
            raise Conflict('entity review inputs changed; include the current entity and every complete state')


def validate_acceptance(store, target, check_current=True):
    if not check_current:
        return  # Historical decisions remain valid during a verified bundle restore.
    if target['id'] != target['current_revision'] or freshness(store, target['payload']):
        raise Conflict('送审内容已变化，请刷新并等待重新送审后认可。')


def _contents(store, row):
    payload = row['payload']
    entity = p.ref_record(store, payload['entities'][0], {'ENTITY'})
    states = [p.ref_record(store, ref, {'STATE'}) for ref in payload['states']]
    assets = {}
    media = []
    for item in payload['media']:
        key = item['asset']['revision_id']
        if key not in assets:
            assets[key] = p.ref_record(store, item['asset'], {'ASSET'})
        asset = assets[key]
        component = next(c for c in asset['payload']['components'] if c['id'] == item['component_id'])
        media.append({**item, 'record': asset, 'component': component})
    return {'entity': entity, 'states': states, 'media': media}


def snapshot(store, entity_id, revision_id=None):
    """Only explicitly submitted revisions enter this aggregate; never latest media."""
    entity = p.record(store, entity_id)
    if entity['kind'] != 'ENTITY':
        raise ValueError('entity review requires an ENTITY')
    rows = p.current_records(store)
    current = next((r for r in rows if submission(r) and r['payload']['entities'][0]['object_id'] == entity_id), None)
    history = []
    if current:
        history = [p.record(store, revision_id=r[0]) for r in store.db.execute('SELECT id FROM revisions WHERE object_id=? ORDER BY version DESC', (current['object_id'],))]
    selected = next((r for r in history if r['id'] == revision_id), None) if revision_id else current
    if revision_id and selected is None:
        raise ValueError('review revision does not belong to this entity')
    contents = _contents(store, selected) if selected else {'entity': entity, 'states': full_states(rows, entity_id), 'media': []}
    decisions = [p.record(store, revision_id=r[0]) for r in store.db.execute("SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='JUDGMENT' AND json_extract(r.payload,'$.verdict')='accepted' ORDER BY r.created_at DESC,r.rowid DESC")]
    history_ids = {r['id'] for r in history}
    decisions = [r for r in decisions if r['payload']['target']['revision_id'] in history_ids]
    accepted = next((r for r in decisions if selected and r['payload']['target']['revision_id'] == selected['id']), None)
    previous = next((r for r in history if any(d['payload']['target']['revision_id'] == r['id'] for d in decisions) and (not selected or r['id'] != selected['id'])), None)
    issues = freshness(store, selected['payload'], rows) if selected else []
    if selected and selected['id'] != current['id']:
        issues.append({'code': 'historical_submission', 'object_id': selected['object_id']})
    usages = {}
    for form in contents['states']:
        ref = {'object_id': form['object_id'], 'revision_id': form['id']}
        usages[form['id']] = []
        for row in rows:
            payload = row['payload']
            if row['kind'] == 'PREPARATION' and any(ref in occurrence['states'] for occurrence in payload['occurrences']):
                usages[form['id']].append({'kind': row['kind'], 'title': payload['title'], 'source': payload['source'], 'object_id': row['object_id'], 'revision_id': row['id']})
            elif row['kind'] == 'SHOT_DESIGN' and ref in payload['states']:
                usages[form['id']].append({'kind': row['kind'], 'title': payload['title'], 'source': payload['source'], 'object_id': row['object_id'], 'revision_id': row['id']})
    targets = [contents['entity'], *contents['states'], *(m['record'] for m in contents['media'])]
    if selected:
        targets.append(selected)
    comment_targets = list({r['id']: {'object_id': r['object_id'], 'revision_id': r['id']} for r in targets}.values())
    return {'format': MODEL, **contents, 'submission': selected, 'issues': issues,
            'can_accept': bool(selected and not issues and not accepted), 'accepted': accepted,
            'status': 'not_submitted' if not selected else 'outdated' if issues else 'accepted' if accepted else 'pending',
            'comment_targets': comment_targets, 'usages': usages,
            'history': [{'object_id': r['object_id'], 'revision_id': r['id'], 'version': r['version'], 'accepted': any(d['payload']['target']['revision_id'] == r['id'] for d in decisions)} for r in history],
            'previous_accepted': {'submission': previous, **_contents(store, previous)} if previous else None}
