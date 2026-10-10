"""Versioned direct entity relationships, independent of media adoptions."""
from . import production as p


def is_relationship(row):
    return row['kind'] == 'RELATION' and row['payload'].get('relation_type') in ('entity', 'business')


def endpoints(row):
    return row['payload'].get('endpoints') or [e['object_id'] for e in row['payload']['entities']]


def for_entity(rows, entity_id):
    return sorted((r for r in rows if is_relationship(r)
                   and r['payload'].get('status') != 'withdrawn'
                   and entity_id in endpoints(r)),
                  key=lambda r: r['object_id'])


def validate(store, payload):
    entities = p._list(payload, 'entities')
    if len(entities) != 2:
        raise ValueError('entity relationship requires two distinct entities')
    for ref in entities:
        p.ref_record(store, ref, {'ENTITY'})
    if entities[0]['object_id'] == entities[1]['object_id']:
        raise ValueError('entity relationship requires two distinct entities')
    p._text(payload.get('label'), 'relationship label')
    if payload.get('direction') not in ('forward', 'mutual'):
        raise ValueError('relationship direction must be forward or mutual')
    if payload.get('category') not in ('personal', 'spatial', 'ownership', 'use', 'performance'):
        raise ValueError('unsupported entity relationship category')
    if payload.get('basis') not in ('script', 'production'):
        raise ValueError('relationship basis must distinguish script facts and production choices')
    sources = p._list(payload, 'sources')
    if not sources:
        raise ValueError('relationship requires exact supporting sources')
    for ref in sources:
        p.source_check(store, ref)
    for ref in p._list(payload, 'applies_to'):
        p.source_check(store, ref)
    if payload.get('status', 'active') not in ('active', 'withdrawn'):
        raise ValueError('invalid relationship status')


def nodes(store, relationships, historical=False):
    result = {}
    for row in relationships:
        refs = row['payload'].get('entities') or [{'object_id': oid} for oid in endpoints(row)]
        for ref in refs:
            result[ref['object_id']] = p.ref_record(store, ref) if historical and ref.get('revision_id') else p.record(store, ref['object_id'])
    return list(result.values())


def layout(store, entity_id, relationships):
    """Display priorities are instance configuration, never accepted story facts."""
    import json
    path = p.root_of(store) / 'config/entity-relationship-layout.json'
    if not path.exists():
        return {'primary': [], 'order': []}
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get('format') != 'entity-relationship-layout-v1':
        raise ValueError('unsupported relationship layout')
    selected = value.get('entities', {}).get(entity_id, {})
    allowed = {r['object_id'] for r in relationships}
    result = {}
    for key in ('primary', 'order'):
        ids = selected.get(key, [])
        if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
            raise ValueError('invalid relationship display order')
        # A withdrawn edge or historical scope can have fewer edges than config.
        from .business_relations import available
        aliases = dict(store.db.execute('SELECT alias_id,relation_id FROM business_relation_aliases')) if available(store) else {}
        result[key] = list(dict.fromkeys(aliases.get(oid, oid) for oid in ids if aliases.get(oid, oid) in allowed))
    return result
