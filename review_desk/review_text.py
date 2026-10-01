"""Exact, read-only text projection for production comments.

Notes remain in their original immutable payload. Generated block IDs let the
shared text anchor address a field item without migrating existing revisions.
Keep this projection in sync with productionTextBlocks in production.js.
"""

NOTE_FIELDS = ('facts', 'choices', 'unknowns')


def production_text_blocks(payload):
    blocks = list(payload.get('blocks') or [])
    body = '\n'.join(block['text'] for block in blocks)
    prefix = '@review/'
    while any(block['id'].startswith(prefix) for block in blocks):
        prefix = '@' + prefix
    seen = set()
    for field in NOTE_FIELDS:
        for index, text in enumerate(payload.get(field) or []):
            if not isinstance(text, str) or not text.strip() or text in body or text in seen:
                continue
            seen.add(text)
            blocks.append({'id': f'{prefix}{field}/{index}', 'text': text,
                           'field': field, 'index': index})
    return blocks
