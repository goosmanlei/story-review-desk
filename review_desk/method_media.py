"""Method provenance at existing media plan, preparation and call boundaries."""
import copy
import json

from . import methods, production as p

ACTIVATION = 'method.activation.media-plan'


def brief(payload):
    return {k: copy.deepcopy(v) for k, v in payload.items()
            if k not in ('generation', 'method_basis', 'status', 'withdrawal_reason', 'required', 'blocks', 'method_adjustment', 'shot_reference_operation')}


def inputs(store, payload, baseline=None, supporting=None, include_relations=True,
           target_id=None, relation_contexts=None):
    context = brief(payload)
    # Keep each distinct range. Two references to the same source revision
    # can carry different block selections; neither may replace the other.
    refs = {methods.checksum(r): r for _, r in p.references(context)}
    records = []
    for ref in sorted(refs.values(), key=lambda r: (r['revision_id'], methods.checksum(r))):
        p.source_check(store, ref)
        row = p.ref_record(store, ref)
        content = copy.deepcopy(row['payload'])
        if row['kind'] == 'SOURCE':
            content = store.source(row['object_id'])
            methods.require(content and methods.checksum(content) == row['payload']['source_revision'],
                            '准确源资料已变化；请恢复原版本或新建步骤，不能用当前资料替换')
            if ref.get('block_ids'):
                content = {**content, 'blocks': [b for b in content['blocks'] if b['id'] in ref['block_ids']]}
        records.append({'object_id': row['object_id'], 'revision_id': row['id'], 'kind': row['kind'], 'payload': content})
    result = {'context': context, 'records': records}
    if include_relations:
        # Freeze the actual planned choices and the full exact relationship
        # readings. A later relationship revision cannot rewrite this method run.
        choices = copy.deepcopy(payload.get('generation', {}).get('inputs', []))
        result['generation_inputs'] = choices
        readings = {}
        for item in choices:
            for _, reference in p.references(item):
                p.source_check(store, reference)
                row = p.ref_record(store, reference)
                reading = {'object_id': row['object_id'], 'revision_id': row['id'], 'kind': row['kind']}
                if row['kind'] in ('ASSET', 'CALL'):
                    # The selected original is a live exact reference. Its
                    # historical candidate list is a document, not new inputs:
                    # it can legitimately retain retired/unavailable ancestors.
                    reading['content_json'] = json.dumps(row['payload'], ensure_ascii=False, sort_keys=True)
                else:
                    reading['payload'] = copy.deepcopy(row['payload'])
                readings[row['id']] = reading
        result['relation_readings'] = sorted(readings.values(), key=lambda r: r['revision_id'])
        if relation_contexts is None:
            from .business_relations import current
            related = {r['id']: r for oid in (target_id, payload.get('scope', {}).get('object_id')) if oid
                       for r in current(store, oid) if r['payload'].get('status') != 'withdrawn'}
            relation_contexts = [{'object_id': r['object_id'], 'revision_id': r['id']} for r in related.values()]
        result['contextual_relation_references'] = copy.deepcopy(relation_contexts)
        result['contextual_relations'] = []
        for reference in relation_contexts:
            row = p.ref_record(store, reference)
            result['contextual_relations'].append({'object_id': row['object_id'], 'revision_id': row['id'],
                                                  'kind': row['kind'], 'payload': copy.deepcopy(row['payload'])})
    if baseline:
        old = p.ref_record(store, baseline, {'REQUIREMENT'})
        result['baseline'] = {'reference': baseline, 'generation': old['payload'].get('generation')}
    if supporting is not None:
        methods.require(isinstance(supporting, list) and len(supporting) <= 100,
                        '补充材料应为有界的准确引用清单')
        result['supporting_references'] = copy.deepcopy(supporting)
        result['supporting_records'] = []
        for ref in supporting:
            p.source_check(store, ref)
            row = p.ref_record(store, ref)
            content = copy.deepcopy(row['payload'])
            if row['kind'] == 'SOURCE':
                content = store.source(row['object_id'])
                methods.require(content and methods.checksum(content) == row['payload']['source_revision'],
                                '补充源资料已变化；不能用当前正文替换原材料')
            if ref.get('block_ids'):
                content = {**content, 'blocks': [b for b in content.get('blocks', []) if b['id'] in ref['block_ids']]}
            # This is a read-only historical document, not a new graph of live
            # production references. Originals can legitimately mention retired
            # candidate requirements. Keep their bytes, but do not reactivate
            # those ancestors through the execution NOTE. The outer exact
            # reference is still checked above and on final consumption.
            result['supporting_records'].append({'reference': copy.deepcopy(ref), 'kind': row['kind'],
                                                'content_json': json.dumps(content, ensure_ascii=False, sort_keys=True)})
    return result


def output(payload):
    return {'requirement': brief(payload), 'generation': copy.deepcopy(payload['generation'])}


def validate_stage(store, execution, stage, value):
    if stage == 'review':
        methods.require(isinstance(value, dict) and isinstance(value.get('assessment'), str)
                        and bool(value['assessment'].strip()), '媒体回读需要实际检查记录')
        return
    methods.require(stage in ('draft', 'result') and isinstance(value, dict)
                    and value.get('requirement') == execution['payload']['inputs']['context'],
                    '媒体步骤产物与准确需求不一致')
    from .generation import validate_plan
    validate_plan(store, execution['payload']['target'],
                  {**value['requirement'], 'generation': value.get('generation')})
    methods.require(isinstance(value.get('generation'), dict), '媒体步骤缺少生成方案')


def prepare(store, value):
    payload = value['payload']
    current = store.db.execute('SELECT version,current_revision FROM objects WHERE id=?', (value['object_id'],)).fetchone()
    methods.require(value.get('expected_version') == (current['version'] if current else 0), '制作方案基线已变化；请回读准确版本后新建步骤')
    baseline = {'object_id': value['object_id'], 'revision_id': current['current_revision']} if current else None
    conditions = value.get('method_conditions', {})
    methods.require(isinstance(conditions, dict) and
                    ('media_type' not in conditions or conditions['media_type'] == payload['media_type']),
                    '方法选择条件不能改变素材媒体类型')
    request = {'work_type': 'media-plan', 'run_id': value['run_id'], 'step_id': value['step_id'],
               'target': value['object_id'], 'conditions': {**conditions, 'media_type': payload['media_type']},
               'inputs': inputs(store, payload, baseline, value.get('supporting_references'), target_id=value['object_id'])}
    execution = methods.prepare(store, request)
    methods.require(execution['payload']['package']['steps'] == ['draft', 'review', 'result'],
                    '媒体制作方法需按 draft、review、result 交付；请修正环节绑定')
    return {'request': request, 'execution': execution}


def activation(store):
    if not store.db.execute('SELECT 1 FROM objects WHERE id=?', (ACTIVATION,)).fetchone():
        return None
    return methods.read(store, ACTIVATION)


def activate(store):
    """Explicit one-time cutover. Call only within the coordinated write window."""
    if activation(store):
        return activation(store)
    methods.resolve(store, 'media-plan', {'media_type': 'video'})
    methods.resolve(store, 'media-plan', {'media_type': 'image'})
    methods.resolve(store, 'media-plan', {'media_type': 'audio'})
    frozen = []
    for row in store.db.execute("SELECT r.* FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='REQUIREMENT'"):
        item = p.record(store, revision_id=row['id'])
        if item['payload'].get('generation'):
            frozen.append({'object_id': item['object_id'], 'revision_id': item['id'], 'payload_sha256': methods.checksum(item['payload'])})
    return methods._save(store, ACTIVATION, {'format': methods.FORMATS['activation'], 'work_type': 'media-plan',
                                          'frozen': sorted(frozen, key=lambda r:r['revision_id'])}, 0)


def adjusted(payload, parent, operation, request, call=None):
    """Record a concrete existing UI choice, never a claim of authored method use."""
    payload['method_adjustment'] = {'parent': {'object_id': parent['object_id'], 'revision_id': parent['id']}, 'operation': operation,
                                    'request': copy.deepcopy(request)}
    if call:
        payload['method_adjustment']['call'] = {'object_id': call['object_id'], 'revision_id': call['id']}
    return payload



def administrative(store, object_id, payload, current):
    if not current or not (activation(store) or payload.get('method_basis')):
        return payload, None
    parent = p.record(store, revision_id=current['current_revision'])
    ignored = {'status', 'required', 'withdrawal_reason'}
    if parent['payload'] != payload and {k:v for k,v in parent['payload'].items() if k not in ignored} == {k:v for k,v in payload.items() if k not in ignored}:
        changed = copy.deepcopy(payload)
        changed['method_adjustment'] = {'parent': {'object_id':object_id, 'revision_id':parent['id']}, 'operation':'administrative'}
        return changed, {'revision_id':parent['id'], 'role':'payload.method_adjustment.parent'}
    return payload, None


def check_adjustment(store, object_id, payload):
    receipt = payload['method_adjustment']
    parent = p.ref_record(store, receipt['parent'], {'REQUIREMENT'})
    methods.require(parent['object_id'] == object_id, '制作选择依据属于其他素材')
    old = parent['payload']
    if receipt['operation'] == 'relation-contract':
        from .business_relations import CHOICES, exact_input_relation, is_business, legacy_endpoints, pair
        from .material_relations import rules
        before, after = copy.deepcopy(old), copy.deepcopy(payload)
        before.pop('method_adjustment', None); after.pop('method_adjustment', None)
        aa, bb = before['generation']['inputs'], after['generation']['inputs']
        methods.require(len(aa) == len(bb), '统一关系不能增减或重排准确输入')
        for index, (a, b) in enumerate(zip(aa, bb)):
            if not a.get('relation'):
                methods.require(a == b, '统一关系不能改变没有关系的输入')
                continue
            original = p.ref_record(store, a['relation'])
            current = exact_input_relation(store, object_id, b)
            methods.require(current and is_business(current) and pair(legacy_endpoints(original)) == pair(current['payload']['endpoints']), '统一关系端点不匹配')
            expected = copy.deepcopy(a)
            expected['relation'] = copy.deepcopy(b['relation'])
            for key, value in rules(store, a, object_id).items():
                if key in CHOICES:
                    expected[key] = value
            methods.require(expected == b, '统一关系不能改变原选择、必要性、候选或范围')
            aa[index] = copy.deepcopy(b)
        methods.require(before == after, '关系契约迁移不能夹带创作修订')
        return parent
    if receipt['operation'] == 'administrative':
        ignored = {'method_adjustment', 'status', 'required', 'withdrawal_reason'}
        methods.require({k:v for k,v in old.items() if k not in ignored} == {k:v for k,v in payload.items() if k not in ignored}, '撤回或必需性调整不能改写方案')
        return parent
    excluded = {'generation', 'method_adjustment', 'shot_reference_operation'}
    methods.require({k:v for k,v in old.items() if k not in excluded} ==
                    {k:v for k,v in payload.items() if k not in excluded}, '素材选择不能更改创作需求或方法依据')
    a, b = copy.deepcopy(old['generation']), copy.deepcopy(payload['generation'])
    request = receipt['request']
    from .shot_references import input_key, slot
    op = payload.get('shot_reference_operation', {})
    methods.require(request.get('requirement_id') == object_id and op.get('id') == request.get('id')
                    and op.get('fingerprint') == input_key({k:v for k,v in request.items() if k != 'id'}),
                    '素材选择与准确操作记录不一致')
    if receipt['operation'] == 'route':
        from .material_relations import rules
        action, key, value = request.get('action'), request.get('key'), request.get('value')
        options = [rules(store, i, object_id) for i in a['inputs']]
        if action == 'route':
            methods.require(any(r.get('necessity') == 'one_of' and r.get('group') == key and r.get('route') == value for r in options), '不存在该执行路线')
            a.setdefault('selected_routes', {})[key] = value
        elif action == 'condition':
            methods.require(type(value) is bool and any(r.get('necessity') == 'conditional' and r.get('condition') == key for r in options), '不存在该执行条件')
            a.setdefault('conditions', {})[key] = value
        elif action == 'optional':
            methods.require(type(key) is int and 0 <= key < len(options) and options[key]['necessity'] == 'optional' and type(value) is bool, '不存在该可选输入')
            a['inputs'][key]['enabled'] = value
        else:
            raise ValueError('未知素材选择操作')
        methods.require(a == b, '路线选择不能改写 Prompt、参数或其他输入')
    elif receipt['operation'] == 'reference':
        # Historical actual calls may have resolved the declared active inputs.
        # Their exact creative fields remain authoritative; no new free text.
        if receipt.get('call'):
            call = p.ref_record(store, receipt['call'], {'CALL'})
            basis = call['payload'].get('generation_requirement') or call['payload'].get('prepared_plan')
            methods.require(basis == receipt['parent'], '历史调用与制作选择依据不一致')
            from .material_plans import scheme
            actual_scheme = scheme(call['payload'], 'CALL')
            for key in ('method', 'model', 'parameters', 'prompt', 'randomization', 'execution'):
                if key in actual_scheme:
                    a[key] = copy.deepcopy(actual_scheme[key])
        aa, bb = a.pop('inputs'), b.pop('inputs')
        methods.require(a == b and len(aa) == len(bb), '参考选择不能改写 Prompt、参数或输入顺序')
        editable = {'reference', 'component_id', 'crop', 'range', 'sha256', 'material_selection', 'selection_state'}
        index = op.get('index')
        methods.require(type(index) is int and 0 <= index < len(aa), '参考选择槽位无效')
        for i, (before, after) in enumerate(zip(aa, bb)):
            methods.require({k:v for k,v in before.items() if k not in editable} == {k:v for k,v in after.items() if k not in editable}, '参考选择不能改写输入用途或规则')
            if before == after:
                continue
            origin, chosen = slot(store, before, i), slot(store, after, i)
            from .material_storage import canonical_id
            methods.require(origin['material_id'] and chosen['material_id'] and canonical_id(store, origin['material_id']) == canonical_id(store, chosen['material_id']), '参考选择不能更换素材身份')
            if i == index:
                methods.require(chosen['material_id'] == request['material_id'] and chosen['number'] == request['number'] and
                                chosen['candidate'] == request.get('candidate') and
                                all(after.get(k) == request.get(k) for k in ('crop', 'range')), '参考选择与提交内容不一致')
            else:
                methods.require(bool(receipt.get('call')), '参考选择不能更改其他槽位')
                actual = call['payload'].get('inputs', [])
                methods.require(any(all(after.get('reference', {}).get(k) == v.get(k, v.get('reference', {}).get(k)) for k in ('object_id', 'revision_id')) and all(after.get(k) == v.get(k) for k in ('component_id', 'crop', 'range')) for v in actual), '其他槽位不是历史调用的准确输入')
    else:
        raise ValueError('未知制作选择依据')
    return parent


def verify(store, object_id, payload, revision_id=None):
    adjustments, seen = [], set()
    while payload.get('method_adjustment'):
        parent = check_adjustment(store, object_id, payload)
        methods.require(parent['id'] not in seen, '制作选择依据循环')
        seen.add(parent['id'])
        adjustments.append({'parent': {'object_id': parent['object_id'], 'revision_id': parent['id']}, 'operation': payload['method_adjustment']['operation'],
                            'payload_sha256': methods.checksum(payload)})
        payload, revision_id = parent['payload'], parent['id']
    basis = verify_authored(store, object_id, payload, revision_id)
    return {**(basis or {'history': 'unknown'}), 'adjustments': adjustments} if adjustments else basis


def verify_authored(store, object_id, payload, revision_id=None):
    """Old exact plans stay unknown; no task-wide or later-step exemption."""
    policy = activation(store)
    basis = payload.get('method_basis')
    if not basis:
        if not policy:
            return None
        sha = methods.checksum(payload)
        for frozen in policy['payload']['frozen']:
            if frozen['object_id'] == object_id and frozen['payload_sha256'] == sha and (revision_id is None or frozen['revision_id'] == revision_id):
                old = store.db.execute('SELECT object_id,payload FROM revisions WHERE id=?', (frozen['revision_id'],)).fetchone()
                if old and old['object_id'] == object_id and methods.checksum(p.record(store, revision_id=frozen['revision_id'])['payload']) == sha:
                    return {'history': 'unknown', 'frozen_plan': {k: frozen[k] for k in ('object_id', 'revision_id')}}
        raise ValueError('新制作方案缺少本步骤方法依据；先通过媒体方法准备入口取得方法并完成草稿、回读与定稿')
    identity = {'work_type': 'media-plan', 'run_id': basis['run_id'], 'step_id': basis['step_id'], 'target': object_id}
    execution = methods.verify_execution(store, basis['execution'], identity)
    baseline = execution['payload']['inputs'].get('baseline', {}).get('reference')
    methods.require(not baseline or baseline['object_id'] == object_id, '方法起稿依据属于其他制作对象')
    methods.verify_execution(store, basis['execution'], identity,
                             inputs(store, payload, baseline, execution['payload']['inputs'].get('supporting_references'),
                                    include_relations='relation_readings' in execution['payload']['inputs'],
                                    relation_contexts=execution['payload']['inputs'].get('contextual_relation_references', [])))
    artifact = methods.read(store, **basis['artifact'])
    value = artifact['payload']
    methods.require(value['format'] == methods.FORMATS['artifact'] and value['execution'] == basis['execution']
                    and value['stage'] == 'result' and value['output'] == output(payload),
                    '制作定稿与本步骤方法产物不一致；请回到准确步骤修订')
    methods.require(not execution['payload'].get('private'), '公开制作方案不能引用私有创作候选')
    return copy.deepcopy(basis)
