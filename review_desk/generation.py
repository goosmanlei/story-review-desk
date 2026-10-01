"""Reviewed generation plans and exact, read-only execution packages.

No model calls or story-specific decisions live in this module.
"""
import copy
import json
import shutil
from pathlib import Path
from .store import Conflict, canonical, digest
from . import production as p
from .production_states import complete
from .production_media import validate_component

MODEL = 'entity-generation-v1'
PLAN = 'generation-plan-v1'


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def decision_id(entity_id):
    return 'entity-generation-' + digest(entity_id.encode())[:32]


def validate_plan(store, object_id, payload):
    plan = payload.get('generation')
    if plan is None:
        return
    if not isinstance(plan, dict) or plan.get('format') != PLAN or plan.get('method') not in ('generate', 'reuse'):
        raise ValueError('unsupported generation plan')
    for key in ('tool', 'model', 'prompt'):
        p._text(plan.get(key), 'generation ' + key)
    if not isinstance(plan.get('parameters'), dict) or not isinstance(plan.get('output'), dict):
        raise ValueError('generation parameters and output must be objects')
    for key in ('name', 'description'):
        p._text(plan['output'].get(key), 'generation output ' + key)
    criteria = p._list(plan['output'], 'review_criteria')
    if not criteria or any(not isinstance(s, str) or not s.strip() for s in criteria):
        raise ValueError('generation output requires review criteria')
    for issue in p._list(plan, 'blockers'):
        p._text(issue, 'execution blocker')
    inputs = p._list(plan, 'inputs')
    scope = p.ref_record(store, payload['scope'])
    if scope['kind'] != 'STATE' or not complete(scope):
        raise ValueError('generation plan requires a complete state')
    if payload['scope'] not in payload['states'] or scope['payload']['entity']['object_id'] not in {r['object_id'] for r in payload['entities']}:
        raise ValueError('generation plan must include its state and owning entity')
    if plan['method'] == 'reuse' and len(inputs) != 1:
        raise ValueError('reuse requires one exact upstream input')
    seen = set()
    for value in inputs:
        if not isinstance(value, dict):
            raise ValueError('generation input must be an object')
        p._text(value.get('use'), 'input purpose')
        target = p.ref_record(store, value.get('reference'), {'ASSET', 'REQUIREMENT'})
        key = canonical(value)
        if key in seen:
            raise ValueError('duplicate generation input')
        seen.add(key)
        if target['object_id'] == object_id:
            raise ValueError('generation dependency cycle')
        if target['kind'] == 'ASSET':
            _, component = p.component_for(store, value['reference'], value.get('component_id'))
            p.validate_selection(component, value)
        else:
            if value.get('component_id') or value.get('crop') or value.get('range'):
                raise ValueError('future requirement input resolves its exact adopted component and range')
            if target['payload'].get('status') == 'withdrawn':
                raise ValueError('generation input requirement is withdrawn')
            # Immutable references alone are acyclic, but object-level cycles
            # across successive revisions would make execution impossible.
            todo = [target]; visited = set()
            while todo:
                node = todo.pop()
                if node['object_id'] == object_id:
                    raise ValueError('generation dependency cycle')
                if node['id'] in visited:
                    continue
                visited.add(node['id'])
                for upstream in node['payload'].get('generation', {}).get('inputs', []):
                    linked = p.ref_record(store, upstream['reference'])
                    if linked['kind'] == 'REQUIREMENT':
                        todo.append(linked)
        if plan['method'] == 'reuse' and target['payload']['media_type'] != payload['media_type']:
            raise ValueError('reuse media type differs from output')


def requirements_for(rows, states):
    refs = {canonical(ref(s)) for s in states}
    return sorted((r for r in rows if r['kind'] == 'REQUIREMENT' and r['payload'].get('status') != 'withdrawn'
                   and canonical(r['payload']['scope']) in refs), key=lambda r: r['object_id'])


def current_scope(store, entity_id, rows=None):
    rows = rows if rows is not None else p.current_records(store)
    entity = p.record(store, entity_id)
    if entity['kind'] != 'ENTITY':
        raise ValueError('generation acceptance requires an entity')
    states = sorted((r for r in rows if complete(r) and r['payload']['entity']['object_id'] == entity_id), key=lambda r:r['object_id'])
    requirements = requirements_for(rows, states)
    dependencies = {}; todo = requirements[:]
    owned = {r['id'] for r in requirements}
    while todo:
        row = todo.pop()
        for item in row['payload'].get('generation', {}).get('inputs', []):
            target = p.ref_record(store, item['reference'], {'ASSET', 'REQUIREMENT'})
            if target['id'] in dependencies:
                continue
            dependencies[target['id']] = ref(target)
            if target['kind'] == 'REQUIREMENT':
                todo.append(target)
    return {'entity': ref(entity), 'states': [ref(r) for r in states],
            'requirements': [ref(r) for r in requirements],
            'dependencies': sorted((r for rid,r in dependencies.items() if rid not in owned), key=lambda r:(r['object_id'],r['revision_id']))}


def contents(store, scope):
    return {'entity':p.ref_record(store, scope['entity'], {'ENTITY'}),
            'states':[p.ref_record(store, r, {'STATE'}) for r in scope['states']],
            'requirements':[p.ref_record(store, r, {'REQUIREMENT'}) for r in scope['requirements']]}


def preparation(store, scope):
    data = contents(store, scope); issues=[]
    for row in [data['entity'], *data['states']]:
        if not str(row['payload'].get('production_description', '')).strip():
            issues.append({'object_id':row['object_id'], 'code':'description_missing', 'message':row['payload']['title']+'：制作描述待完善'})
        for message in row['payload'].get('production_blockers', []):
            issues.append({'object_id':row['object_id'], 'code':'content_unresolved', 'message':message})
    if not data['states']:
        issues.append({'object_id':data['entity']['object_id'], 'code':'states_missing', 'message':'尚无完整状态'})
    for form in data['states']:
        if form['payload']['entity'] != scope['entity']:
            issues.append({'object_id':form['object_id'], 'code':'entity_changed', 'message':form['payload']['title']+'：基础信息已变化，需复核'})
        needs = [r for r in data['requirements'] if r['payload']['scope']==ref(form)]
        if form['payload']['reference_media']!='none' and not any(r['payload']['required'] for r in needs):
            issues.append({'object_id':form['object_id'], 'code':'materials_missing', 'message':form['payload']['title']+'：预期素材待明确'})
    for need in data['requirements']:
        if not need['payload'].get('generation'):
            issues.append({'object_id':need['object_id'], 'code':'plan_missing', 'message':need['payload']['title']+'：生成方案待完善'})
    for reference in scope['dependencies']:
        row=p.ref_record(store,reference)
        if row['kind']=='REQUIREMENT' and row['id']!=row['current_revision']:
            issues.append({'object_id':row['object_id'], 'code':'dependency_changed', 'message':row['payload']['title']+'：前置方案已变化，需复核'})
    return {'complete':not issues, 'issues':issues, 'state_count':len(data['states']), 'material_count':len(data['requirements'])}


def decision(store, entity_id):
    try:
        return p.record(store,decision_id(entity_id))
    except KeyError:
        return None


def accepted(store, entity_id, scope=None):
    d=decision(store,entity_id)
    scope = scope or current_scope(store,entity_id)
    return d if d and d['payload']['verdict']=='accepted' and d['payload']['acceptance_scope']==scope and preparation(store,scope)['complete'] else None


def validate_decision(store, object_id, payload, check_current=True):
    scope=payload.get('acceptance_scope')
    if payload.get('acceptance_model')!=MODEL or payload.get('verdict') not in ('accepted','revoked'):
        raise ValueError('unsupported generation decision')
    if not isinstance(scope,dict) or set(scope)!={'entity','states','requirements','dependencies'}:
        raise ValueError('generation acceptance requires exact content scope')
    data=contents(store,scope);eid=data['entity']['object_id']
    if object_id!=decision_id(eid) or payload['target']!=scope['entity']:
        raise ValueError('generation decision must use the entity decision identity')
    for refs in (scope['states'],scope['requirements'],scope['dependencies']):
        if len({canonical(r) for r in refs})!=len(refs):raise ValueError('duplicate accepted reference')
    if any(not complete(s) or s['payload']['entity']['object_id']!=eid for s in data['states']):
        raise ValueError('accepted state belongs to another entity')
    if any(r['payload']['scope'] not in scope['states'] for r in data['requirements']):
        raise ValueError('accepted requirement belongs to another state')
    for r in scope['dependencies']:p.ref_record(store,r,{'ASSET','REQUIREMENT'})
    if payload['verdict']=='revoked':
        previous=p.ref_record(store,payload.get('previous_decision'),{'JUDGMENT'})
        if previous['object_id']!=object_id or previous['payload'].get('verdict')!='accepted' or previous['payload'].get('acceptance_scope')!=scope:
            raise ValueError('revoke must name the exact accepted decision')
    if not check_current:return
    old=decision(store,eid)
    if payload['verdict']=='revoked':
        if not old or old['id']!=payload['previous_decision']['revision_id']:
            raise Conflict('采纳记录已有变化，请刷新后操作。')
    else:
        if scope!=current_scope(store,eid):raise Conflict('设定或生成方案已有更新，请刷新后采纳。')
        if not preparation(store,scope)['complete']:raise Conflict('制作描述或素材方案尚未完整。')
        if accepted(store,eid,scope):raise Conflict('当前方案已采纳。')


def decide(store, value):
    eid=value['entity_id'];scope=value['scope'];old=decision(store,eid)
    if type(value.get('expected_version')) is not int:raise ValueError('expected_version required')
    action=value.get('action')
    if action not in ('accept','revoke'):raise ValueError('action must be accept or revoke')
    if action=='revoke' and (not old or old['payload']['verdict']!='accepted'):
        raise Conflict('没有可取消的当前采纳。')
    payload={'format':'production-judgment-v1','title':p.ref_record(store,scope['entity'])['payload']['title']+' · '+('采纳生成方案' if action=='accept' else '取消采纳'),
             'blocks':[{'id':'decision','text':value['reason']}], 'target':scope['entity'],'verdict':'accepted' if action=='accept' else 'revoked',
             'acceptance_model':MODEL,'acceptance_scope':scope,'actor':value['actor'],'reason':value['reason']}
    if action=='revoke':payload['previous_decision']=ref(old)
    return p.judge(store,{'object_id':decision_id(eid),'expected_version':value['expected_version'],'payload':payload})


def snapshot(store, entity_id, revision_id=None):
    from . import entity_review as er
    if revision_id:
        selected=p.record(store,revision_id=revision_id)
        if selected['payload'].get('acceptance_model')!=MODEL:
            result=er.legacy_snapshot(store,entity_id,revision_id)
            result.update({'legacy_acceptance':True,'can_accept':False,'can_revoke':False,'requirements':[]})
            return result
        if selected['object_id']!=decision_id(entity_id):raise ValueError('historical decision belongs to another entity')
        scope=selected['payload']['acceptance_scope']
    else:
        selected=None;scope=current_scope(store,entity_id)
    data=contents(store,scope);rows=p.current_records(store)
    # Legacy aggregation keeps historical comments and precise media coverage;
    # no legacy acceptance can serve as a generation authorization.
    base=er.legacy_snapshot(store,entity_id)
    media=er.related_media(store,rows,entity_id,data['states'])
    data['media']=er.scope_contents(store,{'entity':scope['entity'],'states':scope['states'],'media':media})['media']
    targets={r['id']:r for r in [*base['comment_records'],data['entity'],*data['states'],*data['requirements'],*(m['record'] for m in data['media'])]}
    need_ids={r['object_id'] for r in data['requirements']}
    for c in store.comments():
        if c.get('target_object_id') in need_ids and c.get('target_revision_id') not in targets:
            r=p.record(store,c['target_object_id'],c['target_revision_id']);targets[r['id']]=r
    d=decision(store,entity_id);a=selected if selected and selected['payload']['verdict']=='accepted' else (accepted(store,entity_id,scope) if not revision_id else None)
    history=[]
    if d:
        for row in store.db.execute('SELECT id FROM revisions WHERE object_id=? ORDER BY version DESC',(d['object_id'],)):
            h=p.record(store,revision_id=row[0]);history.append({'revision_id':h['id'],'created_at':h['created_at'],'actor':h['payload']['actor'],'verdict':h['payload']['verdict']})
    prep=preparation(store,scope)
    versions={r['object_id']:[{'id':v[0],'version':v[1]} for v in store.db.execute('SELECT id,version FROM revisions WHERE object_id=? ORDER BY version DESC',(r['object_id'],))]
              for r in [data['entity'],*data['states'],*data['requirements'],*(m['record'] for m in data['media'])]}
    return {**base,**data,'format':'entity-workspace-v2','scope':scope,'content_key':digest(canonical(scope).encode()),'historical':bool(revision_id),
            'accepted':a,'status':'accepted' if a else 'unaccepted','can_accept':not revision_id and not a and prep['complete'],
            'can_revoke':not revision_id and bool(a),'decision_version':d['version'] if d else 0,'preparation':prep,'history':history,
            'previous_accepted':None,'versions':versions,'comment_records':list(targets.values()),'comment_targets':[ref(r) for r in targets.values()]}


def readiness(store, requirement_id):
    need=p.record(store,requirement_id)
    if need['kind']!='REQUIREMENT':raise ValueError('generation needs a requirement')
    plan=need['payload'].get('generation');issues=[];inputs=[];approvals=[]
    if not plan:issues.append('尚无生成方案')
    if need['payload'].get('status')=='withdrawn':issues.append('素材需求已撤回')
    for entity in need['payload']['entities']:
        a=accepted(store,entity['object_id'])
        if not a:issues.append(p.ref_record(store,entity)['payload']['title']+'：当前生成方案未采纳')
        elif ref(need) not in a['payload']['acceptance_scope']['requirements']:issues.append('素材方案不在当前采纳范围内')
        else:approvals.append(ref(a))
    if plan:
        issues.extend(plan.get('blockers',[]))
        for item in plan['inputs']:
            target=p.ref_record(store,item['reference']);selection=item
            if target['kind']=='REQUIREMENT':
                if target['id']!=target['current_revision']:
                    issues.append(target['payload']['title']+'：前置需求已有新版本');continue
                row=next((r for r in p.readiness(store,target['payload']['scope']['object_id'])['requirements'] if r['requirement']['id']==target['id']),None)
                if not row or row['issues']:
                    issues.append(target['payload']['title']+'：尚未明确采用可用原件');continue
                selection=row['adoption']['payload']
                target=p.ref_record(store,selection['asset'],{'ASSET'})
            try:
                asset,component=p.component_for(store,ref(target),selection['component_id'])
                validate_component(p.root_of(store),component,inspect=False);p.validate_selection(component,selection)
                if asset['payload'].get('placeholder'):raise ValueError('占位素材不能作为生成参考')
                inputs.append({'asset':ref(asset),'component':component,'use':item['use'],**{k:selection[k] for k in ('crop','range') if k in selection}})
            except (KeyError,ValueError,OSError) as exc:issues.append(str(exc))
    images=[v for v in inputs if v['component']['mime'].startswith('image/')]
    depths=[p.ref_record(store,v['asset'])['payload'].get('lineage',{}).get('i2i_depth') for v in images]
    if any(type(d) is not int for d in depths):issues.append('图像参考谱系未知，应回到可追溯的干净母版')
    depth=1+max((d for d in depths if type(d) is int),default=-1)
    if plan and plan['method']=='generate' and images and depth>2:issues.append('图像参考超过两代，应回到干净母版')
    if plan and any(r['revision_id']!=p.record(store,r['object_id'])['id'] for r in need['payload']['states']):issues.append('素材状态已有更新')
    return {'requirement':need,'plan':plan,'acceptances':approvals,'inputs':inputs,'i2i_depth':max(depth,0),'issues':issues,'ready':not issues}


def package(store, requirement_id):
    ready=readiness(store,requirement_id)
    if not ready['ready']:raise Conflict('；'.join(ready['issues']))
    plan=ready['plan']
    return {'format':'generation-package-v1','requirement':ref(ready['requirement']),'acceptances':ready['acceptances'],
            'method':plan['method'],'tool':plan['tool'],'model':plan['model'],'parameters':copy.deepcopy(plan['parameters']),
            'prompt':plan['prompt'],'output':copy.deepcopy(plan['output']),'inputs':ready['inputs'],'i2i_depth':ready['i2i_depth'],
            'execution_note':'执行前重新检查有效采纳、参考文件、平台可用性及现有额度；此包不表示已经调用模型。'}


def write_package(store, requirement_id, output):
    result=package(store,requirement_id);target=Path(output)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):raise ValueError('package output must be an empty directory')
    target.mkdir(parents=True,exist_ok=True);(target/'assets').mkdir(exist_ok=True)
    for value in result['inputs']:
        c=value['component'];path=validate_component(p.root_of(store),c,inspect=False)
        shutil.copyfile(path,target/'assets'/c['file']);value['path']='assets/'+c['file']
    (target/'manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    return result


def validate_call(store, object_id, payload):
    if not payload.get('generation_requirement') or payload.get('status') not in ('submitted','completed'):return
    try:old=p.record(store,object_id)
    except KeyError:old=None
    # Finishing a real submitted call keeps its already executed inputs, even
    # when the user has since revoked approval or revised the next plan.
    if payload['status']=='completed' and old and old['payload'].get('status') in ('submitted','completed'):
        for key in ('generation_requirement','generation_acceptances','tool','model','parameters','prompt','inputs'):
            if payload.get(key)!=old['payload'].get(key):raise Conflict('完成记录不能改写已经执行的生成输入')
        return
    need=p.ref_record(store,payload['generation_requirement'],{'REQUIREMENT'})
    manifest=package(store,need['object_id'])
    if manifest['requirement']!=payload['generation_requirement'] or manifest['acceptances']!=payload.get('generation_acceptances'):
        raise Conflict('生成依据或采纳已变化')
    for field in ('tool','model','parameters','prompt'):
        if manifest[field]!=payload.get(field):raise Conflict('实际生成输入不同于采纳方案：'+field)
    expected=[{'object_id':v['asset']['object_id'],'revision_id':v['asset']['revision_id'],'component_id':v['component']['id'],**{k:v[k] for k in ('crop','range') if k in v}} for v in manifest['inputs']]
    actual=[v for v in payload['inputs'] if v.get('component_id')]
    if expected!=actual:raise Conflict('实际生成参考不同于准备包')
