"""Instance-owned creative flow projected through the live method bindings."""
import json


def load(root, catalog):
    path = root / 'content/skill-flow.json'
    if not path.exists():
        # An instance without a flow still exposes its actual bound capabilities.
        specification = {'format': 'skill-flow-v1', 'stages': [
            {'id': b['object_id'], 'title': b['payload']['work_type'],
             'capabilities': [{'work_type': b['payload']['work_type']}]} for b in catalog['binding']], 'branches': []}
    else:
        specification = json.loads(path.read_text())
    if specification.get('format') != 'skill-flow-v1':
        raise ValueError('基础流程格式无效')
    bindings = {r['payload']['work_type']: r for r in catalog['binding']}
    skills = {r['object_id']: r for r in catalog['skill']}
    def resolve(selectors):
        found = []
        for selector in selectors:
            binding = bindings.get(selector['work_type'])
            for rule in binding['payload']['rules'] if binding else []:
                if 'when' in selector and rule['when'] != selector['when']:
                    continue
                skill = skills.get(rule['object_id'])
                if skill and not any(m['object_id'] == skill['object_id'] and m.get('file') == selector.get('file') for m in found):
                    found.append({'object_id': skill['object_id'], 'title': selector.get('title') or skill['payload']['title'], **{k: selector[k] for k in ('file', 'group') if k in selector}})
        return found
    ids = set()
    for stage in [*specification['stages'], *specification.get('branches', [])]:
        if not isinstance(stage.get('id'), str) or not stage['id'] or not isinstance(stage.get('title'), str) or not stage['title'] or stage['id'] in ids:
            raise ValueError('基础流程节点缺少名称或身份重复')
        ids.add(stage['id'])
        if 'output' in stage and (not isinstance(stage['output'], str) or not stage['output'].strip()):
            raise ValueError('基础流程产出说明无效')
        stage['methods'] = resolve(stage.get('capabilities', []))
        if 'repeat' in stage:
            if not isinstance(stage['repeat'].get('label'), str) or not stage['repeat']['label'].strip():
                raise ValueError('多轮协作缺少说明')
            stage['repeat']['methods'] = resolve(stage['repeat'].get('capabilities', []))
    stages = {n['id'] for n in specification['stages']}
    for edge in specification.get('returns', []):
        if edge.get('from') not in stages or edge.get('to') not in stages or not edge.get('label'):
            raise ValueError('回读关系缺少准确端点或含义')
    for branch in specification.get('branches', []):
        if not branch.get('supports') or not set(branch['supports']) <= stages:
            raise ValueError('反馈支路缺少准确支持节点')
    return specification
