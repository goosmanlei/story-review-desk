"""Validate an optional offset-only reading map against immutable full text."""
import hashlib
from .review_text import production_text_blocks


def reading(row, specification):
    if not specification:
        return None
    if specification.get('format') != 'exact-prompt-reading-v1':
        raise ValueError('unsupported exact Prompt reading map')
    entry = specification.get('entries', {}).get(row['id'])
    if entry is None:
        return None
    if row['object_id'] != entry.get('object_id') or row['payload'].get('scope') != entry.get('scope'):
        raise ValueError('reading map exact owner differs')
    field = entry.get('field')
    if field not in ('generation.prompt', 'call.prompt'):
        raise ValueError('reading map must address a complete Prompt')
    block = next((b for b in production_text_blocks(row['payload']) if b.get('field') == field), None)
    if not block or hashlib.sha256(block['text'].encode()).hexdigest() != entry.get('sha256'):
        raise ValueError('reading map differs from exact Prompt')
    parts, previous = [], -1
    if not isinstance(entry.get('parts'), list) or not entry['parts']:
        raise ValueError('reading map requires ordered ranges')
    for part in entry['parts']:
        start, end, role = part.get('start'), part.get('end'), part.get('role')
        if (type(start) is not int or type(end) is not int or
                not 0 <= start < end <= len(block['text']) or start < previous or
                role not in ('action', 'voice', 'detail')):
            raise ValueError('invalid reading range')
        parts.append({'start': start, 'end': end, 'role': role, 'text': block['text'][start:end]})
        previous = end
    return {'field': field, 'block_id': block['id'], 'parts': parts}


def attach(value, specification):
    """Annotate the already selected snapshot; never query a newer record."""
    if isinstance(value, list):
        for item in value:
            attach(item, specification)
    elif isinstance(value, dict):
        if 'id' in value and 'object_id' in value and isinstance(value.get('payload'), dict):
            try:
                result = reading(value, specification)
                if result:
                    value['review_reading'] = result
            except ValueError as error:
                value['review_reading_error'] = str(error)
            return
        for item in list(value.values()):
            attach(item, specification)
