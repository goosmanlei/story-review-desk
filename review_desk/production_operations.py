"""Durable submit and exact plan reuse; these operations never call a provider."""
import copy
import json
from . import production as p, production_current as current
from .store import Conflict, canonical


def prior(store, operation, fingerprint):
    row = store.db.execute('SELECT * FROM production_current_operations WHERE id=?', (operation,)).fetchone()
    if row:
        if row['request_sha256'] != fingerprint:
            raise Conflict('操作编号已使用其他参数；请使用新的操作身份')
        return {**json.loads(row['result']), 'already_applied': True}


def remember(store, operation, fingerprint, result):
    store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)', (operation, fingerprint, canonical(result)))
    return result


def run(store, request, action):
    if not current.enabled(store):
        raise Conflict('需要先迁移为当前制作模型')
    operation = request.get('id')
    if not isinstance(operation, str) or not p.ID.fullmatch(operation):
        raise ValueError('需要唯一操作身份')
    fingerprint = current.checksum(request)
    store.db.execute('BEGIN IMMEDIATE')
    try:
        result = prior(store, operation, fingerprint)
        if result is None:
            result = action()
            result = remember(store, operation, fingerprint, result)
        store.db.commit()
        return result
    except BaseException:
        store.db.rollback()
        raise


def submit(store, request):
    """Commit submission before caller may dispatch. A replay means query only."""
    from .generation import package
    def action():
        need = p.record(store, request['requirement_id'])
        current.guard(store, need['object_id'], request.get('expected_content'))
        plan = package(store, need['object_id'])
        if current.checksum(plan) != request.get('package_sha256'):
            raise Conflict('准备包或准确输入已改变；禁止用旧准备包提交')
        payload = {'format': 'production-call-v1', 'title': request.get('title') or need['payload']['title'],
                   'blocks': [{'id': 'submission', 'text': '按提交时方案执行'}], 'status': 'submitted',
                   'tool': request['tool'], 'generation_requirement': plan['requirement'], 'outputs': [],
                   **{key: copy.deepcopy(plan[key]) for key in ('method','model','parameters','prompt','output','randomization','execution','method_basis') if key in plan},
                   'inputs': [{**item['asset'], 'component_id': item['component']['id'], 'sha256': item['component']['sha256'],
                               **{k: copy.deepcopy(item[k]) for k in ('crop','range','role','material_selection') if k in item}}
                              for item in plan['inputs']]}
        if request.get('provider_request') is not None:
            payload['request'] = copy.deepcopy(request['provider_request'])
        if need['payload']['media_type'] == 'image':
            parents = {item['asset']['object_id']: item['asset'] for item in plan['inputs']
                       if item['component']['mime'].startswith('image/')}
            payload['lineage'] = {'i2i_depth': plan['i2i_depth'], 'references': list(parents.values())}
        oid = request['call_id']
        if store.db.execute('SELECT 1 FROM objects WHERE id=?', (oid,)).fetchone():
            raise Conflict('调用身份已存在；请查询原调用，不重复提交')
        p._import_records(store, {'format': 'production-import-v1', 'records': [
            {'object_id': oid, 'kind': 'CALL', 'expected_version': 0, 'payload': payload}]}, transaction=False)
        return {'call_id': oid, 'submission_sha256': current.submission(store, oid)['snapshot_sha256'],
                'already_applied': False, 'recovery': 'query-existing-operation-before-any-resubmit'}
    return run(store, request, action)


def reuse(store, request):
    def action():
        need = p.record(store, request['requirement_id'])
        if need['kind'] != 'REQUIREMENT':
            raise ValueError('方案起点必须写入当前素材需求')
        current.guard(store, need['object_id'], request.get('expected_content'))
        row = store.db.execute('SELECT * FROM production_candidates WHERE id=?', (request['candidate_id'],)).fetchone()
        if not row or not store.db.execute('SELECT 1 FROM production_candidate_targets WHERE candidate_id=? AND material_id=?',
                                          (row['id'], need['object_id'])).fetchone():
            raise Conflict('候选与当前素材需求没有准确归属')
        saved = current.submission(store, row['operation_id'])['snapshot']
        source = next((r for r in saved.get('requirements', []) if r['object_id'] == need['object_id']), None)
        if not source or not source['payload'].get('generation'):
            raise Conflict('此候选缺少完整原方案，不能用当前内容补齐')
        plan = copy.deepcopy(source['payload']['generation'])
        actual = saved['request']
        for key in ('method','model','parameters','prompt','output','randomization','execution'):
            if key in actual:
                plan[key] = copy.deepcopy(actual[key])
        for item in plan['inputs']:
            ref = item['reference']
            target = p.ref_record(store, ref)
            if target.get('legacy_reference'):
                item['reference'] = {'object_id': target['object_id'], 'revision_id': target['id']}
            if target['kind'] != 'ASSET':
                raise Conflict('原方案存在未固定原件的输入；请重新准备，不自动选择最新文件')
            from .shot_references import slot
            issues = slot(store, item, 0)['issues']
            if issues:
                raise Conflict('原方案输入不可用：'+'；'.join(issues))
        payload = copy.deepcopy(need['payload'])
        payload['generation'] = plan
        from .method_media import adjusted
        adjusted(payload, need, 'candidate-copy', request)
        p.validate_payload(store, need['object_id'], 'REQUIREMENT', payload)
        result = store._put_object(need['object_id'], 'REQUIREMENT', payload, need['version'],
                                   [{'revision_id': r['revision_id'], 'role': role} for role,r in p.references(payload)])
        return {**result, 'already_applied': False, 'candidate_id': row['id']}
    return run(store, request, action)


def finish(store, request):
    """Idempotent poll/callback receipt. No external dispatch occurs here."""
    def action():
        call = p.record(store, request['call_id'])
        saved = current.submission(store, call['object_id'])
        if saved['snapshot_sha256'] != request['submission_sha256']:
            raise Conflict('回执不属于该准确提交')
        status = request['status']
        if status not in ('submitted','unknown','failed','completed'):
            raise ValueError('调用状态无效')
        if call['payload']['status'] == 'completed' and status != 'completed':
            raise Conflict('迟到状态不能撤回已收到的真实结果')
        payload = copy.deepcopy(call['payload'])
        result_asset = request.get('asset')
        if result_asset:
            if status != 'completed':
                raise ValueError('只有实际返回的原件才能登记候选')
            oid = 'asset-'+call['object_id']
            old = store.db.execute('SELECT version FROM objects WHERE id=?', (oid,)).fetchone()
            asset = copy.deepcopy(result_asset)
            asset['production'] = {'object_id':call['object_id'],'revision_id':call['id']}
            p._import_records(store, {'format':'production-import-v1','records':[{'object_id':oid,'kind':'ASSET',
                'expected_version':old[0] if old else 0,'payload':asset}]}, transaction=False)
            row=p.record(store,oid)
            payload['outputs']=[{'object_id':oid,'revision_id':row['id']}]
        if status == 'completed' and not payload.get('outputs'):
            raise ValueError('无原件的请求不能制造空候选')
        payload['status'] = status
        # The original wire response and cost evidence remain on the single
        # operation; retries do not allocate candidates or duplicate billing.
        for field in ('response','cost','actual_seed','request_id'):
            if field in request:
                if field in payload and payload[field] != request[field]:
                    raise Conflict('原调用回执字段不同：'+field)
                payload[field] = copy.deepcopy(request[field])
        p._import_records(store, {'format':'production-import-v1','records':[{'object_id':call['object_id'],'kind':'CALL',
            'expected_version':call['version'],'payload':payload}]}, transaction=False)
        candidate=store.db.execute('SELECT id FROM production_candidates WHERE operation_id=?',(call['object_id'],)).fetchone()
        return {'call_id':call['object_id'],'candidate_id':candidate[0] if candidate else None,'status':status,'already_applied':False}
    return run(store, request, action)


def select(store, request):
    from .shot_references import input_key, slot, response
    def action():
        need = p.record(store, request['requirement_id'])
        current.guard(store, need['object_id'], request.get('expected_content'))
        payload = copy.deepcopy(need['payload'])
        items = payload.get('generation', {}).get('inputs', [])
        index = request['index']
        if type(index) is not int or not 0 <= index < len(items) or input_key(items[index]) != request['input_key']:
            raise Conflict('参考槽位已经改变')
        if request.get('path') not in (None, [index]):
            raise ValueError('间接参考应在所属素材需求中修改')
        old = items[index]
        origin = slot(store, old, index)
        from .material_storage import canonical_id
        mid = request['material_id']
        if not origin['material_id'] or canonical_id(store, mid) != canonical_id(store, origin['material_id']):
            raise ValueError('不能把槽位换成另一素材')
        candidate = p.ref_record(store, request['candidate'], {'ASSET'}) if request.get('candidate') else None
        target = candidate or p.record(store, mid)
        value = {k: v for k,v in old.items() if k not in ('component_id','crop','range','sha256','material_selection','selection_state')}
        value['reference'] = {'object_id': target['object_id'], 'revision_id': target['id']}
        if candidate:
            value.update(component_id=request['component_id'], material_selection={'material_id': mid, 'candidate_id': candidate['candidate_id']})
            value.update({k: copy.deepcopy(request[k]) for k in ('crop','range') if k in request})
        else:
            value['selection_state'] = 'unselected'
        issues = [x for x in slot(store,value,index)['issues'] if not (not candidate and x == '尚未选定候选')]
        if issues:
            raise Conflict('；'.join(issues))
        items[index] = value
        payload['shot_reference_operation'] = {'id': request['id'], 'fingerprint': input_key({k:v for k,v in request.items() if k != 'id'}), 'index': index}
        from .method_media import adjusted
        adjusted(payload, need, 'reference', request)
        p.validate_payload(store, need['object_id'], 'REQUIREMENT', payload)
        result = store._put_object(need['object_id'], 'REQUIREMENT', payload, need['version'],
                                   [{'revision_id': r['revision_id'], 'role': role} for role,r in p.references(payload)])
        return response(store, p.record(store, need['object_id']), False)
    return run(store, request, action)
