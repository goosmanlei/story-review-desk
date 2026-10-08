"""Exact, read-only text projection for production comments.

Notes remain in their original immutable payload. Generated block IDs let the
shared text anchor address a field item without migrating existing revisions.
Keep this projection in sync with productionTextBlocks in production.js.
"""

import json


NOTE_FIELDS = ('facts', 'choices', 'unknowns')


def generation_parameter_text(payload):
    return json.dumps(payload['generation'].get('parameters', {}), ensure_ascii=False, sort_keys=True, indent=2)


def call_parameter_text(payload):
    parameters = {key: value for key, value in payload.get('parameters', {}).items()
                  if not (key == 'prompt' and value == payload.get('prompt'))}
    return json.dumps(parameters, ensure_ascii=False, sort_keys=True, indent=2)


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
    extra = [('production_description', payload.get('production_description'))]
    if payload.get('format') == 'production-av-shot-v1':
        extra += [(field,payload.get(field)) for field in ('purpose','framing','spatial','axis','movement','action_start','action_end','motion','performance','lighting','color','editing','continuity')]
    if payload.get('format') in ('production-av-episode-v1', 'production-av-scene-v1', 'production-material-relation-v1'):
        extra += [(field, payload.get(field)) for field in ('purpose', 'structure', 'rhythm', 'continuity', 'preserve', 'change', 'check')]
    if payload.get('relation_type') == 'entity':
        extra.append(('relationship.label', payload.get('label')))
    plan = payload.get('generation') or {}
    if plan:
        extra += [('generation.tool', plan.get('tool')), ('generation.model', plan.get('model')),
                  ('generation.parameters', generation_parameter_text(payload)),
                  ('generation.prompt', plan.get('prompt')),
                  ('generation.output.description', plan.get('output', {}).get('description')),
                  ('generation.output.review_criteria', '\n'.join(plan.get('output', {}).get('review_criteria', [])))]
        extra += [(f'generation.inputs.{i}.use', value.get('use')) for i,value in enumerate(plan.get('inputs', []))]
    if payload.get('format') == 'production-call-v1':
        extra += [('call.model', payload.get('model')),
                  ('call.parameters', call_parameter_text(payload)),
                  ('call.prompt', payload.get('prompt'))]
    for field,text in extra:
        if isinstance(text,str) and text.strip() and text not in body and text not in seen:
            seen.add(text)
            blocks.append({'id':prefix+field.replace('.', '/'), 'text':text, 'field':field})
    if payload.get('format') == 'production-av-shot-v1':
        for index, item in enumerate(payload.get('sound') or []):
            if isinstance(item, dict) and item.get('type') == 'source_action':
                continue
            name = 'text' if isinstance(item, str) or isinstance(item, dict) and item.get('text') else 'description'
            text = item if isinstance(item, str) else item.get(name) if isinstance(item, dict) else None
            if isinstance(text, str) and text.strip():
                field = f'sound.{index}.{name}'
                blocks.append({'id': prefix + field.replace('.', '/'), 'text': text, 'field': field})
    return blocks
