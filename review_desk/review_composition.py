"""Read-only, authored arrangements of exact production text.

The author accounts for every source block. Ranges are never fuzzy-matched and
an invalid arrangement is ignored as a whole. Semantic coverage is an authoring
judgment, not something this validator purports to prove.
"""
import hashlib

from .review_text import production_text_blocks


def composition(row, specification):
    if not specification:
        return None
    entry = specification.get('entries', {}).get(row['id'])
    if entry is None:
        return None
    if specification.get('format') != 'exact-review-composition-v1':
        raise ValueError('unsupported review composition')
    if entry.get('object_id') != row['object_id']:
        raise ValueError('review composition owner differs')
    blocks = {b['id']: b for b in production_text_blocks(row['payload'])}
    accounting = entry.get('sources', {})
    if set(accounting) != set(blocks):
        raise ValueError('review composition must account for every original block')
    for key, block in blocks.items():
        source = accounting[key]
        if source.get('sha256') != hashlib.sha256(block['text'].encode()).hexdigest():
            raise ValueError('review composition original text differs')
        if source.get('disposition') not in ('display', 'represented', 'preparation', 'outside_scope') or not source.get('reason'):
            raise ValueError('review composition requires an explicit source disposition')
    sections, shown = [], set()
    for section in entry.get('sections', []):
        parts = []
        for part in section.get('parts', []):
            key, start, end = part.get('block_id'), part.get('start'), part.get('end')
            if key not in blocks or type(start) is not int or type(end) is not int or not 0 <= start < end <= len(blocks[key]['text']):
                raise ValueError('review composition range is invalid')
            if accounting[key]['disposition'] != 'display':
                raise ValueError('review composition disposition contradicts display')
            shown.add(key)
            parts.append(dict(block_id=key, start=start, end=end, text=blocks[key]['text'][start:end]))
        if parts:
            sections.append(dict(label=section.get('label', ''), parts=parts))
    if shown != {key for key, source in accounting.items() if source['disposition'] == 'display'}:
        raise ValueError('review composition has undisplayed content')
    requires = entry.get('requires', [])
    if not isinstance(requires, list) or any(not isinstance(r, str) or not r for r in requires):
        raise ValueError('invalid composition companions')
    return {'sections': sections, 'requires': requires}


def attach(value, specification):
    if isinstance(value, list):
        for item in value:
            attach(item, specification)
    elif isinstance(value, dict):
        if 'id' in value and 'object_id' in value and isinstance(value.get('payload'), dict):
            try:
                result = composition(value, specification)
                if result is not None:
                    value['review_composition'] = result
            except (ValueError, TypeError, KeyError) as error:
                value['review_composition_error'] = str(error)
            return
        for item in list(value.values()):
            attach(item, specification)
