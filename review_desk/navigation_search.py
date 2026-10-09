"""Explicit readable search fields. References are followed only to the owner.

Neither stored JSON, internal IDs, nor transitive media dependencies are terms.
The projection does not change any immutable record or usage relationship.
"""
import re
import unicodedata
from . import business_codes, list_reading as light


def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', value).lower().split())


def fields(value):
    terms = []
    for key in ('title', 'name', 'description', 'production_description', 'purpose',
                'action_start', 'action_end', 'performance'):
        if isinstance(value.get(key), str):terms.append(value[key])
    for key in ('aliases', 'facts', 'choices', 'unknowns'):
        terms.extend(item for item in value.get(key, []) if isinstance(item, str))
    terms.extend(block['text'] for block in value.get('blocks', []) if isinstance(block.get('text'), str))
    return terms


def codes(store):
    return {row['object_id']: business_codes.code(row) for row in business_codes.visible_codes(store)}


def material_fields(store, item, mapping):
    row = light.record(store, item['object_id'], item['id'])
    terms = [mapping.get(item['canonical_material_id'], ''), *fields(row['payload'])]
    scope = row['payload'].get('scope')
    if scope:
        owner = light.ref_record(store, scope)
        if not owner.get('unavailable'):
            value=owner['payload']
            terms.extend([mapping.get(owner['object_id'], ''), value.get('title',''), *value.get('aliases',[])])
            if owner.get('kind')=='AV_SHOT':
                terms.extend(value.get(key,'') for key in ('purpose','action_start','action_end','performance'))
    return list(dict.fromkeys(normalize(term) for term in terms if term))


def entity_fields(entities, states, mapping):
    result = {}
    for entity in entities:
        related = [entity, *(row for row in states if row['payload'].get('entity', {}).get('object_id') == entity['object_id'])]
        result[entity['object_id']] = list(dict.fromkeys(normalize(term) for row in related
            for term in [mapping.get(row['object_id'], ''), *fields(row['payload'])] if term))
    return result


def matches(query, terms):
    query = normalize(query)
    # A full displayed business code is an identity, not a partial title match.
    if re.fullmatch(r'(?:m|en|st|ash|as|ae)\d+', query):return query in terms
    return not query or any(query in term for term in terms)
