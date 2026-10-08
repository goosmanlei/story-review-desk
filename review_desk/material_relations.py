"""Contextual production relations, selected execution routes and exact inputs.

Descriptive edges never schedule work. Only a plan's explicitly active inputs
participate in execution checks. A relationship is evidence, not a model call.
"""
from . import production as p

SEMANTICS = {'reference', 'reuse', 'variant', 'alternative', 'continuity', 'description'}
EXECUTABLE = {'reference', 'reuse', 'variant'}
NECESSITIES = {'required', 'optional', 'conditional', 'one_of'}


def validate(store, payload):
    upstream = p.ref_record(store, payload.get('upstream'), {'REQUIREMENT', 'ASSET'})
    if not p.ID.fullmatch(str(payload.get('downstream_id', ''))):
        raise ValueError('需求关系需要稳定的下游需求身份')
    p.ref_record(store, payload.get('context'))
    for key in ('purpose', 'preserve', 'change', 'check', 'type_id', 'type_label'):
        p._text(payload.get(key), key)
    if payload.get('semantics') not in SEMANTICS:
        raise ValueError('未知通用关系语义须显式使用 description')
    if payload.get('necessity') not in NECESSITIES:
        raise ValueError('关系必要性须为 required/optional/conditional/one_of')
    if payload.get('basis') not in ('source_fact', 'production_choice'):
        raise ValueError('关系须区分故事事实与制作选择')
    if type(payload.get('type_version')) is not int or payload['type_version'] < 1:
        raise ValueError('扩展关系需要准确类型定义版本')
    definition = payload.get('type_definition')
    if not isinstance(definition, dict) or definition.get('endpoints') != [upstream['kind'], 'REQUIREMENT'] or definition.get('direction') not in ('directed', 'symmetric'):
        raise ValueError('关系类型须定义端点、方向和属性含义')
    attrs, definitions = payload.get('attributes', {}), definition.get('attributes', {})
    if not isinstance(attrs, dict) or not isinstance(definitions, dict) or set(attrs) - set(definitions):
        raise ValueError('扩展属性必须有明确含义')
    for value in definitions.values():
        p._text(value, '扩展属性定义')
    if payload['semantics'] in EXECUTABLE and definition['direction'] != 'directed':
        raise ValueError('生产前置关系必须明确从上游指向下游')
    if payload['necessity'] == 'one_of':
        for key in ('group', 'route'):
            p._text(payload.get(key), key)
    if payload['necessity'] == 'conditional':
        p._text(payload.get('condition'), 'condition')
    p._list(payload, 'sources')


def rules(store, value, requirement_id=None):
    if value.get('relation'):
        relation = p.ref_record(store, value['relation'], {'MATERIAL_RELATION'})['payload']
        if requirement_id and relation['downstream_id'] != requirement_id:
            raise ValueError('方案关系不属于当前下游需求')
        target = p.ref_record(store, value['reference'])
        upstream = p.ref_record(store, relation['upstream'])
        if upstream['kind'] == 'ASSET':
            if target['id'] != upstream['id']:
                raise ValueError('准确参考与关系指定原件不同')
            return relation
        # An exact candidate must be a result of the relation's named material.
        if target['kind'] == 'REQUIREMENT':
            mid = target['object_id']
        else:
            mid = value.get('material_selection', {}).get('material_id')
        from .material_storage import canonical_id
        if not mid or canonical_id(store, mid) != canonical_id(store, relation['upstream']['object_id']):
            raise ValueError('准确参考与需求关系上游不同')
        return relation
    return {'semantics': value.get('semantics', 'reference'),
            'necessity': value.get('necessity', 'required'),
            **{k: value[k] for k in ('group', 'route', 'condition') if k in value}}


def active_inputs(store, plan, requirement_id=None):
    """Indices stay original so UI selection and submitted input order agree."""
    active, issues, groups = [], [], {}
    routes = plan.get('selected_routes', {})
    conditions = plan.get('conditions', {})
    if not isinstance(routes, dict) or not isinstance(conditions, dict) or any(type(v) is not bool for v in conditions.values()):
        raise ValueError('路线选择和条件判断格式无效')
    for index, item in enumerate(plan.get('inputs', [])):
        rule = rules(store, item, requirement_id)
        semantic, necessity = rule.get('semantics'), rule.get('necessity')
        if semantic not in SEMANTICS or necessity not in NECESSITIES:
            raise ValueError('输入关系语义或必要性无效')
        if 'enabled' in item and type(item['enabled']) is not bool:
            raise ValueError('可选输入的选择必须为布尔值')
        if semantic not in EXECUTABLE:
            continue
        if necessity == 'one_of':
            group, route = rule.get('group'), rule.get('route')
            if not group or not route:
                raise ValueError('择一路线需要 group 和 route')
            groups.setdefault(group, set()).add(route)
            if routes.get(group) != route:
                continue
        if necessity == 'conditional':
            condition = rule.get('condition')
            if not condition:
                raise ValueError('条件输入缺少条件名称')
            if condition not in conditions:
                issues.append('条件尚未判断：'+condition)
                continue
            if not conditions[condition]:
                continue
        if necessity == 'optional':
            selected = item.get('enabled', item.get('selection_state') != 'unselected' and
                                p.ref_record(store, item['reference'])['kind'] == 'ASSET')
            if not selected: continue
        active.append((index, item))
    for group, choices in groups.items():
        if routes.get(group) not in choices:
            issues.append('请选择执行路线：'+group)
    return active, issues


def cycle_issues(store, need):
    issues, finished = [], set()

    def visit(row, chain):
        if row['object_id'] in chain:
            issues.append('所选执行路线存在循环：'+' → '.join([*chain, row['object_id']]))
            return
        if row['id'] in finished:
            return
        inputs, unresolved = active_inputs(store, row['payload'].get('generation', {}), row['object_id'])
        issues.extend(unresolved)
        for _, value in inputs:
            target = p.ref_record(store, value['reference'])
            if target['kind'] == 'REQUIREMENT':
                visit(target, [*chain, row['object_id']])
        finished.add(row['id'])

    visit(need, [])
    return list(dict.fromkeys(issues))


def for_material(store, material_id):
    result = [r for r in p.current_records(store, {'MATERIAL_RELATION'})
              if material_id in (r['payload']['upstream']['object_id'], r['payload']['downstream_id'])]
    for row in result:
        try:
            target = p.record(store, row['payload']['downstream_id'])
            row['downstream'] = {'object_id': target['object_id'], 'revision_id': target['id']}
        except KeyError:
            row['downstream'] = None
    return result


def choose_route(store, request):
    """Save an explicit execution choice against one exact current plan."""
    import copy
    from .store import Conflict, canonical, digest
    from . import material_plans as mp
    op = request.get('id')
    if not isinstance(op,str) or not p.ID.fullmatch(op):raise ValueError('需要选择操作编号')
    fingerprint = digest(canonical({k:v for k,v in request.items() if k!='id'}).encode())
    store.db.execute('BEGIN IMMEDIATE')
    try:
        old = store.db.execute("SELECT id FROM revisions WHERE json_extract(payload,'$.shot_reference_operation.id')=?",(op,)).fetchone()
        if old:
            row=p.record(store,revision_id=old['id'])
            if row['payload']['shot_reference_operation']['fingerprint']!=fingerprint:raise Conflict('选择编号已被另一操作使用')
        else:
            need=p.record(store,request['requirement_id'])
            if need['kind']!='REQUIREMENT' or need['id']!=request['expected_revision']:raise Conflict('素材方案已变化，请重新读取')
            payload=copy.deepcopy(need['payload']);plan=payload.get('generation')
            if not plan:raise ValueError('尚无完整生成方案')
            choices={};conditions=set();optional=set()
            for index,item in enumerate(plan['inputs']):
                rule=rules(store,item,need['object_id'])
                if rule['necessity']=='one_of':choices.setdefault(rule['group'],set()).add(rule['route'])
                if rule['necessity']=='conditional':conditions.add(rule['condition'])
                if rule['necessity']=='optional':optional.add(index)
            action=request.get('action');key=request.get('key');value=request.get('value')
            if action=='route' and key in choices and value in choices[key]:plan.setdefault('selected_routes',{})[key]=value
            elif action=='condition' and key in conditions and type(value) is bool:plan.setdefault('conditions',{})[key]=value
            elif action=='optional' and type(key) is int and key in optional and type(value) is bool:plan['inputs'][key]['enabled']=value
            else:raise ValueError('此方案没有该路线或条件选项')
            payload['shot_reference_operation']={'id':op,'fingerprint':fingerprint,'operation':'route'}
            p.validate_payload(store,need['object_id'],'REQUIREMENT',payload)
            result=store._put_object(need['object_id'],'REQUIREMENT',payload,need['version'],
                [{'revision_id':ref['revision_id'],'role':path} for path,ref in p.references(payload)])
            row=p.record(store,revision_id=result['revision']);mp.register(store,row)
        store.db.commit()
        from .shot_references import response
        return response(store,row,bool(old))
    except BaseException:
        store.db.rollback();raise
