"""Authored review links into exact production inputs, never inferred from names.

Paths index the immutable plan or the actual CALL behind a selected candidate.
They describe provenance; only a one-element path is a direct input slot.
"""
from . import production as p
from . import shot_references as sr
from .material_storage import canonical_id


def owner_for(store, target):
    if target['kind'] == 'REQUIREMENT':
        return target
    if target['kind'] == 'ASSET':
        return p.ref_record(store, target['payload']['production'], {'CALL'})
    raise ValueError('参考路径没有准确上游方案或真实调用')


def resolve(store, row, path):
    if not isinstance(path, list) or not path or len(path) > 16 or any(type(i) is not int or i < 0 for i in path):
        raise ValueError('参考路径必须是非负输入序号列表')
    owner = row
    trail = []
    for depth, index in enumerate(path):
        inputs = sr.inputs_for(store, owner)
        if index >= len(inputs):
            raise ValueError('准确上游参考槽位不存在')
        selected = sr.slot(store, inputs[index], index)
        if not selected.get('record') or selected.get('nonmedia'):
            raise ValueError('准确上游素材引用失效')
        trail.append({'owner': {'object_id': owner['object_id'], 'revision_id': owner['id']},
                      'index': index, 'input_key': selected['input_key']})
        if depth < len(path) - 1:
            owner = owner_for(store, selected['record'])
    return {**selected, 'path': path, 'trail': trail, 'direct': len(path) == 1,
            'selection_owner': {'object_id': owner['object_id'], 'revision_id': owner['id']},
            'selection_owner_title': owner['payload']['title']}


def validate(store, row):
    plan = row['payload'].get('generation', {})
    links = plan.get('reference_links', [])
    spans = plan.get('prompt_links', [])
    if not isinstance(links, list) or not isinstance(spans, list):
        raise ValueError('参考链接与 Prompt 标记必须是列表')
    keys = {}
    for link in links:
        if not isinstance(link, dict) or not isinstance(link.get('key'), str) or not p.ID.fullmatch(link['key']) or link['key'] in keys:
            raise ValueError('参考链接缺少唯一标识')
        p._text(link.get('label'), 'reference label')
        p._text(link.get('purpose'), 'reference purpose')
        slot = resolve(store, row, link.get('path'))
        mid = link.get('material_id')
        if not isinstance(mid, str) or not slot.get('material_id') or canonical_id(store, mid) != slot['canonical_material_id']:
            raise ValueError('参考路径与素材身份不一致')
        if link.get('state'):
            state = p.ref_record(store, link['state'], {'STATE'})
            target = slot['record']['payload']
            states = target.get('states', []) + [v['state'] for v in target.get('state_coverage', [])]
            if target.get('scope'):
                states.append(target['scope'])
            if link['state'] not in states:
                raise ValueError('参考路径未覆盖准确完整状态')
            if link.get('entity') != state['payload']['entity']:
                raise ValueError('参考状态与准确实体不一致')
        elif link.get('entity'):
            raise ValueError('实体参考必须说明准确完整状态')
        keys[link['key']] = slot
    end = 0
    for span in spans:
        if not isinstance(span, dict):
            raise ValueError('Prompt 标记必须是对象')
        start, stop = span.get('start'), span.get('end')
        if type(start) is not int or type(stop) is not int or start < end or stop <= start or stop > len(plan['prompt']):
            raise ValueError('Prompt 标记范围重叠或无效')
        if span.get('reference_key') not in keys or plan['prompt'][start:stop] != span.get('quote'):
            raise ValueError('Prompt 标记文本或参考目标失配')
        end = stop
    return keys


def annotations(store, row):
    if row['kind'] == 'CALL':
        source = row['payload'].get('generation_requirement') or row['payload'].get('prepared_plan')
        if not source:
            return {}
        plan = p.ref_record(store, source, {'REQUIREMENT'})['payload'].get('generation', {})
        # Historical annotations belong to the exact submitted Prompt. Never
        # borrow today's scheme or add links to a different actual Prompt.
        return plan if plan.get('prompt') == row['payload'].get('prompt') else {}
    return row['payload'].get('generation', {})


def project(store, row):
    """Read declared links only; an unrelated material lineage is not a shot cast."""
    plan = annotations(store, row)
    result = []
    for link in plan.get('reference_links', []):
        try:
            value = resolve(store, row, link['path'])
            result.append({**value, 'key': link['key'], 'label': link['label'], 'purpose': link['purpose']})
        except (KeyError, ValueError, OSError) as exc:
            result.append({'key': link.get('key'), 'label': link.get('label'), 'path': link.get('path'),
                           'issues': [str(exc)], 'invalid': True})
    return result
