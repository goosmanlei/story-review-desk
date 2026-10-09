"""Resolve authored production descriptions without copying immutable text.

An explicit field, including an explicitly empty one, takes precedence. Legacy
description blocks and complete, typed dimensions keep their original authority;
arbitrary notes, titles and source quotations are not substitute descriptions.
"""


def description(payload, entity_type=None, attribute_definitions=()):
    if 'production_description' in payload:
        value = payload['production_description']
        return value.strip() if isinstance(value, str) else ''
    if payload.get('state_model') == 'complete-v1':
        from .production_states import DIMENSIONS
        fields = DIMENSIONS.get(entity_type, tuple(attribute_definitions))
        dimensions = payload.get('dimensions') or {}
        if fields and all(isinstance(dimensions.get(k), str) and dimensions[k].strip() for k in fields):
            return '\n'.join(dimensions[k].strip() for k in fields)
        return ''
    return '\n'.join(b['text'].strip() for b in payload.get('blocks', [])
                     if b.get('id') == 'description' and isinstance(b.get('text'), str) and b['text'].strip())
