"""Shared entity, complete-state and exact original projections."""
from .store import Conflict, canonical, digest
from . import production as p
from .production_states import complete


def full_states(rows, entity_id):
    return [r for r in rows if complete(r) and r['payload'].get('status') != 'withdrawn'
            and r['payload']['entity']['object_id'] == entity_id]


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
            linked = [p.ref_record(store, r, {'STATE'}) for r in payload.get('states', [])]
            owned = any((s.get('owner_object_id') if s.get('unavailable') else s['payload']['entity']['object_id']) == entity_id for s in linked)
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


def scope_contents(store, scope):
    media=[]
    for item in scope['media']:
        asset=p.ref_record(store,item['asset'],{'ASSET'})
        component=next(c for c in asset['payload']['components'] if c['id']==item['component_id'])
        media.append({**item,'record':asset,'component':component})
    return {'entity':p.ref_record(store,scope['entity'],{'ENTITY'}),
            'states':[p.ref_record(store,value,{'STATE'}) for value in scope['states']], 'media':media}


def snapshot(store, entity_id, revision_id=None):
    from .generation import snapshot as generation_snapshot
    return generation_snapshot(store, entity_id, revision_id)
