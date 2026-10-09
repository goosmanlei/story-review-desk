"""Exact per-slot shot inputs. Browsing has no write side effects."""
import copy
from . import production as p, material_plans as mp
from .store import Conflict, canonical, digest
from .production_media import validate_component


def applies(store, need):
    return need['kind']=='REQUIREMENT' and bool(need['payload'].get('generation'))


def input_key(value):
    return digest(canonical(value).encode())


def slot(store, value, index):
    result={'index':index,'input_key':input_key(value),'material_id':None,'number':None,'candidate':None,'candidate_number':None,'issues':[],'value':value}
    try:
        target=p.ref_record(store,value.get('reference',value))
        result['record']=target
        if target.get('unavailable'):
            raise ValueError(target['payload']['title'])
        if target['kind'] not in ('ASSET','REQUIREMENT'):
            result['nonmedia']=True
            return result
        choices=mp.memberships(store,target['id'])
        selection=value.get('material_selection')
        if value.get('selection_state') == 'unselected':
            if target['kind'] != 'REQUIREMENT' or selection is not None:
                raise ValueError('待选槽位不能携带已选候选或版本')
            result['material_id'] = target['object_id']
        elif selection is not None:
            if not isinstance(selection,dict):raise ValueError('参考版本选定格式无效')
            mid,number=selection.get('material_id'),selection.get('number')
            if isinstance(mid,str) and any(v['material_id']==mid for v in choices):result['material_id']=mid
            if not isinstance(mid,str) or type(number) is not int or number<1:
                result['issues'].append('缺少准确素材版本')
            elif not mp.belongs(store,target['id'],mid,number):
                result['issues'].append('素材版本与引用不匹配')
            else:result.update(material_id=mid,number=number)
        else:
            # Only exact historical membership can supply V/C. Never a default
            # round, title match, adoption or current object head.
            pairs={(v['material_id'],v['number']) for v in choices}
            own=[pair for pair in pairs if pair[0]==target['object_id']]
            if len(own)==1:pairs=set(own)
            if len(pairs)==1:result['material_id'],result['number']=next(iter(pairs))
            elif target['kind']=='REQUIREMENT':result['material_id']=target['object_id']
            elif len({pair[0] for pair in pairs})==1:result['material_id']=next(iter(pairs))[0]
        if not result['number']:result['issues'].append('尚未选定素材版本')
        if target['kind']!='ASSET':
            result['issues'].append('尚未选定候选')
            return with_identity(store,result)
        result['candidate']={'object_id':target['object_id'],'revision_id':target['id']}
        if selection is not None and selection.get('candidate_revision_id')!=target['id']:raise ValueError('版本与候选不匹配')
        if not mp.identity(target['payload']):raise ValueError('此引用没有真实候选原件')
        if result['number']:
            if not any(v['material_id']==result['material_id'] and v['number']==result['number'] and v['role']=='result' for v in choices):raise ValueError('候选不属于此素材版本')
        # Candidate identity is independent of whether its version was chosen.
        # A version mismatch remains a production error even when C is known.
        versions={v['number'] for v in choices if v['material_id']==result['material_id'] and v['role']=='result'}
        candidate_version=result['number'] if result['number'] in versions else next(iter(versions)) if len(versions)==1 else None
        if candidate_version is not None:
            code=store.db.execute('SELECT number FROM business_candidates WHERE material_id=? AND version=? AND candidate_id=?',(result['material_id'],candidate_version,mp.identity(target['payload']))).fetchone()
            if code:result['candidate_number']=code[0]
        if result['candidate_number'] is None:raise ValueError('候选编号缺失，需修复准确记录')
        _,component=p.component_for(store,result['candidate'],value.get('component_id'))
        if component['role']!='original':raise ValueError('请选择准确原件组成')
        validate_component(p.root_of(store),component,inspect=False)
        p.validate_selection(component,value)
        result['component']=component
    except (KeyError,ValueError,OSError) as exc:
        result['issues'].append({'missing media or byte size mismatch':'原件缺失或文件大小不匹配，请恢复准确原件','media checksum mismatch':'原件校验不一致，请核对准确原件'}.get(str(exc),str(exc)))
    return with_identity(store,result)


def with_identity(store,result):
    if result['material_id']:
        from .material_storage import canonical_id
        result['canonical_material_id']=canonical_id(store,result['material_id'])
        result.update(mp.card_counts(store,[result['material_id']])[result['material_id']])
        code=store.db.execute('SELECT prefix,number FROM business_codes WHERE object_id=?',(result['canonical_material_id'],)).fetchone()
        if code:result['material_code']=code[0]+str(code[1]).zfill(3)
    return result


def slots(store, inputs):
    return [slot(store,v,i) for i,v in enumerate(inputs)]


def enrich_detail(store, detail):
    from .reference_paths import project, annotations
    targets = [detail.get('record'), *detail.get('history', [])]
    for rounds in detail.get('material_versions', {}).values():
        for version in rounds:
            targets.extend([version.get('plan'), *version.get('definition_records', {}).values()])
    for actual in detail.get('review_contexts', {}).values():
        targets.append(actual.get('call'))
    for row in targets:
        if row and row['kind'] in ('REQUIREMENT', 'CALL'):
            row['review_shot_slots'] = slots(store, inputs_for(store, row))
            if row['kind']=='REQUIREMENT' and row['payload'].get('generation'):
                from .material_relations import active_inputs, rules
                plan=row['payload']['generation']
                active={index for index,_ in active_inputs(store,plan,row['object_id'])[0]}
                for item in row['review_shot_slots']:
                    item['active']=item['index'] in active
                    item['rule']=rules(store,plan['inputs'][item['index']],row['object_id'])
            row['review_reference_links'] = project(store, row)
            row['review_prompt_links'] = annotations(store, row).get('prompt_links', [])
    return detail


def inputs_for(store,row):
    inputs=copy.deepcopy(row['payload'].get('generation',{}).get('inputs',[]) if row['kind']=='REQUIREMENT' else row['payload'].get('inputs',[]))
    if row['kind']=='CALL':
        source=row['payload'].get('generation_requirement') or row['payload'].get('prepared_plan')
        from .material_relations import active_inputs
        need=p.ref_record(store,source) if source else None
        plan=[value for _,value in active_inputs(store,need['payload'].get('generation',{}),need['object_id'])[0]] if need else []
        for actual,declared in zip(inputs,plan):
            if actual.get('material_selection') is not None or declared.get('material_selection') is None:continue
            if all(actual.get(k)==declared.get('reference',{}).get(k) for k in ('object_id','revision_id')) and all(actual.get(k)==declared.get(k) for k in ('component_id','crop','range')):
                actual['material_selection']=copy.deepcopy(declared['material_selection'])
    return inputs


def select(store, request):
    """Optimistic, atomic selection; the revision itself is the durable receipt."""
    if not isinstance(request,dict):raise ValueError('reference selection must be an object')
    if request.get('path') is not None and request['path'] != [request.get('index')]:
        raise ValueError('间接参考归上游方案选定，不能作为本镜独立输入写回')
    op=request.get('id')
    if not isinstance(op,str) or not p.ID.fullmatch(op):raise ValueError('selection id is required')
    fingerprint=input_key({k:v for k,v in request.items() if k!='id'})
    store.db.execute('BEGIN IMMEDIATE')
    try:
        previous=store.db.execute("SELECT id FROM revisions WHERE json_extract(payload,'$.shot_reference_operation.id')=?",(op,)).fetchone()
        if previous:
            row=p.record(store,revision_id=previous[0])
            if row['payload']['shot_reference_operation']['fingerprint']!=fingerprint:raise Conflict('此保存编号已用于另一选择')
            result=response(store,row,True)
        else:
            need=p.record(store,request['requirement_id'])
            if not applies(store,need):raise ValueError('只能选定具有完整方案的素材参考')
            if need['id']!=request['expected_revision']:raise Conflict('素材方案已被修改，请重新打开后选择')
            rounds=mp.snapshot(store,need['object_id'])
            chosen=next((r for r in rounds if r['number']==request['plan_number']),None)
            if not chosen:raise ValueError('素材方案版本不存在')
            source=chosen.get('definition_records',{}).get('requirement') or chosen.get('plan')
            call=chosen.get('definition_records',{}).get('call')
            # Locked calls may have resolved inputs absent from the original plan.
            base=source or need
            inputs=inputs_for(store,call or base)
            index=request['index']
            if type(index) is not int or not 0<=index<len(inputs):raise ValueError('参考槽位不存在')
            old=inputs[index]
            if input_key(old)!=request['input_key']:raise Conflict('参考槽位已被修改，请重新打开')
            origin=slot(store,old,index)
            mid=request['material_id']
            if not origin['material_id']:raise ValueError('引用身份缺失，需先修复此槽位')
            from .material_storage import canonical_id
            if canonical_id(store,origin['material_id'])!=canonical_id(store,mid):raise ValueError('不能把槽位换成另一素材')
            if request.get('candidate') is None:
                number=request.get('number')
                if type(number) is not int or number<1:raise ValueError('请选择准确素材版本')
                target_round=next((r for r in mp.snapshot(store,mid) if r['number']==number),None)
                definition=target_round and (target_round.get('definition_records',{}).get('requirement') or target_round.get('plan'))
                if not definition or not mp.belongs(store,definition['id'],mid,number):
                    raise ValueError('此历史版本没有可单独选定的准确方案；请选择真实候选')
                value={**old,'reference':{'object_id':definition['object_id'],'revision_id':definition['id']},
                       'material_selection':{'material_id':mid,'number':number}}
                for key in ('component_id','range','crop','sha256'):value.pop(key,None)
            else:
                candidate=p.ref_record(store,request['candidate'],{'ASSET'})
                value={**old,'reference':request['candidate'],'component_id':request['component_id'],
                       'material_selection':{'material_id':mid,'number':request['number'],'candidate_revision_id':candidate['id']}}
            for key in ('crop', 'range'):
                if key in request:
                    value[key] = copy.deepcopy(request[key])
                elif request.get('candidate') is not None:
                    value.pop(key, None)
            value.pop('selection_state',None)
            # CALL inputs are flat exact references; the new draft uses the
            # generation-plan form without losing crop/range or ordered use.
            for key in ('object_id','revision_id','kind'):value.pop(key,None)
            checked=slot(store,value,index)
            issues=[issue for issue in checked['issues'] if not (request.get('candidate') is None and issue=='尚未选定候选')]
            if issues:raise Conflict('；'.join(issues))
            payload=copy.deepcopy(base['payload'])
            if call:
                from .generation import PLAN
                definition=chosen['definition']['generation']
                original=base['payload'].get('generation',need['payload'].get('generation',{}))
                payload['generation']={**copy.deepcopy(original),'format':PLAN,**{k:copy.deepcopy(definition[k]) for k in ('method','model','parameters','prompt','randomization','execution') if k in definition}}
                for i,entry in enumerate(inputs):
                    if 'reference' not in entry:
                        exact={k:entry[k] for k in ('object_id','revision_id')}
                        inputs[i]={'reference':exact,**{k:entry[k] for k in ('component_id','crop','range','role') if k in entry},'use':original.get('inputs',[])[i].get('use','准确历史参考') if i<len(original.get('inputs',[])) else '准确历史参考'}
                value.setdefault('use',inputs[index].get('use','准确历史参考'))
                # A real call contains only the active route. A new draft must
                # still retain the other declared alternatives and constraints.
                if original.get('inputs'):
                    from .material_relations import active_inputs
                    selected=active_inputs(store,original,need['object_id'])[0]
                    if len(selected)!=len(inputs):raise Conflict('实际调用与原方案槽位无法准确对应')
                    merged=copy.deepcopy(original['inputs'])
                    for (declared_index,declared),actual in zip(selected,inputs):
                        merged[declared_index]={**declared,**actual}
                    declared_index,declared=selected[index]
                    inputs=merged;index=declared_index
                    value={**declared,**value}
                    for key in ('crop','range'):
                        if key not in request:value.pop(key,None)
            if not payload.get('generation'):raise ValueError('历史制作版本没有完整方案，需先补齐')
            inputs[index]=value;payload['generation']['inputs']=inputs
            payload['shot_reference_operation']={'id':op,'fingerprint':fingerprint,'source_number':chosen['number']}
            p.validate_payload(store,need['object_id'],'REQUIREMENT',payload)
            deps=[{'revision_id':ref['revision_id'],'role':path} for path,ref in p.references(payload)]
            put=store._put_object(need['object_id'],'REQUIREMENT',payload,need['version'],deps)
            row=p.record(store,revision_id=put['revision']);mp.register(store,row)
            result=response(store,row,False)
        store.db.commit()
        return result
    except BaseException:
        store.db.rollback()
        raise


def response(store, row, repeated):
    members=mp.memberships(store,row['id'])
    return {'requirement_id':row['object_id'],'revision_id':row['id'],'number':next(v['number'] for v in members if v['material_id']==row['object_id']),
            'already_applied':repeated,'slots':slots(store,row['payload']['generation']['inputs'])}
