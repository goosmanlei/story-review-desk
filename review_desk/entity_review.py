"""Read current creative output directly; optionally accept its exact versions.

Legacy representation validation remains solely for existing records/recovery.
Current browsing and acceptance never create or depend on a submission object.
"""
from .store import Conflict, canonical, digest
from . import production as p
from .production_states import complete

MODEL = 'entity-review-v1'
ACCEPTANCE_MODEL = 'entity-current-v1'


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


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def related_media(store, rows, entity_id, states):
    """Expose linked candidates immediately, without inventing state coverage."""
    state_refs = [ref(row) for row in states]
    result = []
    for asset in rows:
        if asset['kind'] != 'ASSET':
            continue
        payload = asset['payload']
        owned = any(r['object_id'] == entity_id for r in payload.get('subjects', []))
        if not owned:
            owned = any(p.ref_record(store, r, {'STATE'})['payload']['entity']['object_id'] == entity_id
                        for r in payload.get('states', []))
        if not owned:
            continue
        covered = set()
        for index, item in enumerate(payload.get('state_coverage', [])):
            if item['state'] not in state_refs:
                continue
            component = next(c for c in payload['components'] if c['id'] == item['component_id'])
            if not component['mime'].startswith(('image/', 'audio/', 'video/')):
                continue
            covered.add(component['id'])
            result.append({'id': asset['object_id'] + ':coverage:' + str(index), 'label': payload['title'],
                           'asset': ref(asset), **{k: item[k] for k in ('state', 'component_id', 'role', 'crop', 'range') if k in item}})
        # Existing entity references are already reviewable, even before a full
        # state mapping is established. They must not satisfy state readiness.
        for component in payload['components']:
            if component['id'] not in covered and component['mime'].startswith(('image/', 'audio/', 'video/')):
                result.append({'id': asset['object_id'] + ':component:' + component['id'], 'label': payload['title'],
                               'asset': ref(asset), 'state': None, 'component_id': component['id'], 'role': 'related'})
    return sorted(result, key=lambda item: item['id'])


def current_scope(store, entity_id, rows=None):
    rows = p.current_records(store) if rows is None else rows
    entity = p.record(store, entity_id)
    if entity['kind'] != 'ENTITY':
        raise ValueError('entity review requires an ENTITY')
    states = sorted(full_states(rows, entity_id), key=lambda row: row['object_id'])
    return {'entity': ref(entity), 'states': [ref(row) for row in states],
            'media': related_media(store, rows, entity_id, states)}


def scope_key(scope):
    return digest(canonical(scope).encode())


def scope_contents(store, scope):
    return _contents(store, {'payload': {'entities': [scope['entity']], 'states': scope['states'], 'media': scope['media']}})


def validate_current_acceptance(store, payload, check_current=True):
    if payload.get('acceptance_model') != ACCEPTANCE_MODEL or payload.get('verdict') != 'accepted':
        raise ValueError('unsupported entity acceptance')
    scope = payload.get('acceptance_scope')
    if not isinstance(scope, dict) or set(scope) != {'entity', 'states', 'media'}:
        raise ValueError('entity acceptance requires exact content scope')
    entity = p.ref_record(store, scope['entity'], {'ENTITY'})
    if payload['target'] != scope['entity']:
        raise ValueError('acceptance target differs from entity version')
    state_refs = p._list(scope, 'states')
    if len({r['object_id'] for r in state_refs}) != len(state_refs):
        raise ValueError('duplicate accepted state')
    states = [p.ref_record(store, r, {'STATE'}) for r in state_refs]
    if any(not complete(r) or r['payload']['entity']['object_id'] != entity['object_id'] for r in states):
        raise ValueError('accepted states must belong to the entity')
    media = p._list(scope, 'media')
    if len({item['id'] for item in media}) != len(media):
        raise ValueError('duplicate accepted media')
    assets = {item['asset']['revision_id']: p.ref_record(store, item['asset'], {'ASSET'}) for item in media}
    allowed = related_media(store, list(assets.values()), entity['object_id'], states)
    if any(item not in allowed for item in media):
        raise ValueError('accepted media differs from exact entity/state association')
    if check_current and scope != current_scope(store, entity['object_id']):
        raise Conflict('内容已有更新，请刷新后采纳当前版本。')


def legacy_snapshot(store, entity_id, revision_id=None):
    """Read current versions, or the exact content of an earlier acceptance.

This operation is read-only. No submission, initialization or other workflow
transition is required before viewing, commenting or accepting output.
"""
    rows = p.current_records(store)
    scope = current_scope(store, entity_id, rows)
    decisions = []
    for row in store.db.execute("SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='JUDGMENT' AND json_extract(r.payload,'$.acceptance_model')=? ORDER BY r.created_at DESC,r.id DESC", (ACCEPTANCE_MODEL,)):
        decision = p.record(store, revision_id=row[0])
        if decision['payload']['target']['object_id'] == entity_id:
            decisions.append(decision)
    selected = next((d for d in decisions if d['id'] == revision_id), None) if revision_id else None
    if revision_id and selected is None:
        # Old exact links remain readable without reinstating an active workflow.
        old = p.record(store, revision_id=revision_id)
        if not submission(old) or old['payload']['entities'][0]['object_id'] != entity_id:
            raise ValueError('historical review does not belong to this entity')
        scope = {'entity': old['payload']['entities'][0], 'states': old['payload']['states'], 'media': old['payload']['media']}
    elif selected:
        scope = selected['payload']['acceptance_scope']
    contents = scope_contents(store, scope)
    accepted = selected or next((d for d in decisions if d['payload']['acceptance_scope'] == scope), None)
    previous = next((d for d in decisions if d['payload']['acceptance_scope'] != scope), None) if not revision_id else None
    usages = {}
    for form in contents['states']:
        usages[form['id']] = []
        for row in rows:
            payload = row['payload']
            if ((row['kind'] == 'PREPARATION' and any(ref(form) in occurrence['states'] for occurrence in payload['occurrences'])) or
                    (row['kind'] == 'SHOT_DESIGN' and ref(form) in payload['states'])):
                usages[form['id']].append({'kind': row['kind'], 'title': payload['title'], 'source': payload['source'], **ref(row)})
    targets = [contents['entity'], *contents['states'], *(m['record'] for m in contents['media'])]
    related_ids = {entity_id, *(r['object_id'] for r in rows if r['kind'] == 'STATE' and r['payload']['entity']['object_id'] == entity_id),
                   *(r['object_id'] for r in rows if submission(r) and r['payload']['entities'][0]['object_id'] == entity_id),
                   *(m['asset']['object_id'] for m in scope['media'])}
    # Preserve earlier-version opinions in this entity's review panel. Each
    # comment still navigates to its original immutable text or media version.
    comment_records = {row['id']: row for row in targets}
    for comment in store.comments():
        oid, rid = comment.get('target_object_id'), comment.get('target_revision_id')
        if not rid or rid in comment_records:
            continue
        # A later revision can remove an association; keep the opinion on the
        # earlier, genuinely linked asset discoverable from this entity.
        row = p.record(store, oid, rid)
        linked_asset = row['kind'] == 'ASSET' and bool(related_media(store, [row], entity_id, []))
        if oid in related_ids or linked_asset:
            comment_records[rid] = row
    return {'format': 'entity-workspace-v1', **contents, 'scope': scope, 'content_key': scope_key(scope),
            'historical': bool(revision_id), 'can_accept': not revision_id and not accepted,
            'accepted': accepted, 'status': 'accepted' if accepted else 'unaccepted',
            'comment_targets': [ref(r) for r in comment_records.values()], 'comment_records': list(comment_records.values()),
            'usages': usages, 'history': [{'revision_id': d['id'], 'created_at': d['created_at'], 'actor': d['payload']['actor'],
                                         'entity_version': p.ref_record(store, d['payload']['target'])['version']} for d in decisions],
            'previous_accepted': {'decision': previous, **scope_contents(store, previous['payload']['acceptance_scope'])} if previous else None}


def snapshot(store, entity_id, revision_id=None):
    from .generation import snapshot as generation_snapshot
    return generation_snapshot(store, entity_id, revision_id)
