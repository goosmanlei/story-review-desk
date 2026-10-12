"""Read exact media production inputs, never substitute a current plan or call."""
from . import production as p


def context(store, asset):
    from .production_current import candidate_context
    return candidate_context(store, asset)


def enrich_media(store, media):
    cache = {}
    for item in media:
        asset = item['record']
        if asset['id'] not in cache:
            cache[asset['id']] = context(store, asset)
        item['review_context'] = cache[asset['id']]
    return cache
