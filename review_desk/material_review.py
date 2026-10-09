"""Read exact media production inputs, never substitute a current plan or call."""
from . import production as p


def context(store, asset):
    call_ref = asset['payload'].get('production')
    call = p.ref_record(store, call_ref, {'CALL'}) if call_ref else None
    plans = [p.ref_record(store, ref, {'REQUIREMENT'})
             for ref in asset['payload'].get('candidate_requirements', [])]
    inputs = []
    if call:
        for value in call['payload'].get('inputs', []):
            if value.get('revision_id'):
                inputs.append(p.ref_record(store, value))
    from .material_storage import canonical_id
    from .material_model import definition
    unique={}
    for plan in plans:
        unique.setdefault(canonical_id(store,plan['object_id']),plan)
    if call:
        _,provenance,_=definition(store,call)
        evidence=provenance.get('requirements')
        if evidence:
            exact=p.ref_record(store,evidence['record'])
            unique[canonical_id(store,exact['object_id'])]=exact
    from .review_decisions import snapshot
    return {'call': call, 'requirements': list(unique.values()), 'associated_requirements':plans,
            'inputs': inputs, 'judgments': snapshot(store, asset['object_id'], asset['id'])}


def enrich_media(store, media):
    cache = {}
    for item in media:
        asset = item['record']
        if asset['id'] not in cache:
            cache[asset['id']] = context(store, asset)
        item['review_context'] = cache[asset['id']]
    return cache
