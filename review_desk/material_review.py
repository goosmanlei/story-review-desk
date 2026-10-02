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
    return {'call': call, 'requirements': plans, 'inputs': inputs}


def enrich_media(store, media):
    cache = {}
    for item in media:
        asset = item['record']
        if asset['id'] not in cache:
            cache[asset['id']] = context(store, asset)
        item['review_context'] = cache[asset['id']]
    return cache
