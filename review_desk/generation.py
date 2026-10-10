"""Generation plans and exact, read-only execution packages.

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

PLAN = 'generation-plan-v1'


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}




def validate_plan(store, object_id, payload):
    plan = payload.get('generation')
    if plan is None:
        return
    if not isinstance(plan, dict) or plan.get('format') != PLAN or plan.get('method') not in ('generate', 'reuse'):
        raise ValueError('unsupported generation plan')
    for key in ('model', 'prompt'):
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
    from .video_modes import validate_shape
    validate_shape(plan.get('execution'), inputs)
    scope = p.ref_record(store, payload['scope'])
    if scope['kind'] == 'STATE':
        if not complete(scope):
            raise ValueError('generation plan requires a complete state')
        if payload['scope'] not in payload['states'] or scope['payload']['entity']['object_id'] not in {r['object_id'] for r in payload['entities']}:
            raise ValueError('generation plan must include its state and owning entity')
    elif scope['kind'] not in ('ENTITY', 'INPUT_LOCK', 'STORY', 'EPISODE', 'AV_EPISODE', 'AV_SCENE', 'AV_SHOT'):
        raise ValueError('generation scope must be a complete state or production position')
    from .material_plans import randomization
    from .input_contracts import check_parameters, check_declared
    check_parameters(plan['model'],plan['parameters'])
    strategy=randomization(plan)
    if strategy['mode']=='random' and 'seed' in plan['parameters']:raise ValueError('random plan cannot set a fixed parameter seed')
    if plan['method'] == 'reuse' and len(inputs) != 1:
        raise ValueError('reuse requires one exact upstream input')
    seen = set()
    media_types = []
    for value in inputs:
        if not isinstance(value, dict):
            raise ValueError('generation input must be an object')
        p._text(value.get('use'), 'input purpose')
        target = p.ref_record(store, value.get('reference'), {'ASSET', 'REQUIREMENT'})
        media_types.append(target['payload']['media_type'])
        if 'selection_state' in value and (value['selection_state'] != 'unselected' or target['kind'] != 'REQUIREMENT' or value.get('material_selection') is not None):
            raise ValueError('invalid unselected reference slot')
        key = canonical(value)
        if key in seen:
            raise ValueError('duplicate generation input')
        seen.add(key)
        if target['kind'] == 'ASSET':
            _, component = p.component_for(store, value['reference'], value.get('component_id'))
            p.validate_selection(component, value)
        elif value.get('component_id') or value.get('crop') or value.get('range'):
            raise ValueError('future input requires an exact candidate before choosing a media range')
        if plan['method'] == 'reuse' and target['payload']['media_type'] != payload['media_type']:
            raise ValueError('reuse media type differs from output')
    from .material_relations import active_inputs
    selected_inputs, _ = active_inputs(store, plan, object_id)
    media_types = [p.ref_record(store, value['reference'])['payload']['media_type'] for _, value in selected_inputs]
    contract_issues = check_declared(plan['model'],plan['prompt'],media_types)
    if contract_issues:raise ValueError('；'.join(contract_issues))
    if plan.get('reference_links') or plan.get('prompt_links'):
        from .reference_paths import validate
        validate(store, {'object_id': object_id, 'id': '@'+object_id, 'kind': 'REQUIREMENT', 'payload': payload})


def requirements_for(rows, states):
    refs = {canonical(ref(s)) for s in states}
    return sorted((r for r in rows if r['kind'] == 'REQUIREMENT' and r['payload'].get('status') != 'withdrawn'
                   and canonical(r['payload']['scope']) in refs), key=lambda r: r['object_id'])


def current_scope(store, entity_id, rows=None):
    rows = rows if rows is not None else p.current_records(store)
    entity = p.record(store, entity_id)
    if entity['kind'] != 'ENTITY':
        raise ValueError('generation scope requires an entity')
    states = sorted((r for r in rows if complete(r) and r['payload'].get('status') != 'withdrawn'
                     and r['payload']['entity']['object_id'] == entity_id), key=lambda r:r['object_id'])
    requirements = requirements_for(rows, states)
    dependencies = {}; todo = requirements[:]
    owned = {r['id'] for r in requirements}
    while todo:
        row = todo.pop()
        from .material_relations import active_inputs
        selected_inputs, _ = active_inputs(store, row['payload'].get('generation', {}), row['object_id'])
        for _, item in selected_inputs:
            target = p.ref_record(store, item['reference'], {'ASSET', 'REQUIREMENT'})
            if target['id'] in dependencies:
                continue
            dependencies[target['id']] = ref(target)
            if target['kind'] == 'REQUIREMENT':
                todo.append(target)
    from .entity_relations import for_entity
    return {'entity': ref(entity), 'states': [ref(r) for r in states],
            'relationships': [ref(r) for r in for_entity(rows, entity_id)],
            'requirements': [ref(r) for r in requirements],
            'dependencies': sorted((r for rid,r in dependencies.items() if rid not in owned), key=lambda r:(r['object_id'],r['revision_id']))}


def contents(store, scope):
    return {'entity':p.ref_record(store, scope['entity'], {'ENTITY'}),
            'states':[p.ref_record(store, r, {'STATE'}) for r in scope['states']],
            'requirements':[p.ref_record(store, r, {'REQUIREMENT'}) for r in scope.get('requirements', [])],
            'relationships':[p.ref_record(store, r, {'RELATION'}) for r in scope.get('relationships', [])]}


def preparation(store, scope):
    data = contents(store, scope); issues=[]
    from .production_description import description
    for row in [data['entity'], *data['states']]:
        if not description(row['payload'], data['entity']['payload']['entity_type'],
                           data['entity']['payload'].get('attribute_definitions', {})):
            issues.append({'object_id':row['object_id'], 'code':'description_missing', 'message':row['payload']['title']+'：制作描述待完善'})
        for message in row['payload'].get('production_blockers', []):
            issues.append({'object_id':row['object_id'], 'code':'content_unresolved', 'message':message})
    if not data['states']:
        issues.append({'object_id':data['entity']['object_id'], 'code':'states_missing', 'message':'尚无完整状态'})
    for form in data['states']:
        needs = [r for r in data['requirements'] if r['payload']['scope']==ref(form)]
        if form['payload']['reference_media']!='none' and form['payload'].get('reference_mode')!='description' and not any(r['payload']['required'] for r in needs):
            issues.append({'object_id':form['object_id'], 'code':'materials_missing', 'message':form['payload']['title']+'：预期素材待明确'})
    for need in data['requirements']:
        if not need['payload'].get('generation'):
            issues.append({'object_id':need['object_id'], 'code':'plan_missing', 'message':need['payload']['title']+'：生成方案待完善'})
    return {'complete':not issues, 'issues':issues, 'state_count':len(data['states']), 'material_count':len(data['requirements'])}














def snapshot(store, entity_id, revision_id=None):
    # Cross-request reuse is tied to the transaction's authoritative generation.
    # Write validation and caller-owned transactions always read their own data.
    with p.read_scope(store):
        from .read_cache import read_json
        return read_json(store, ['entity-review', entity_id, revision_id], lambda: _snapshot(store, entity_id, revision_id))


def _snapshot(store, entity_id, revision_id=None):
    from . import entity_review as er, entity_relations as rel, material_review as media_review
    # This reader needs state requirements, entity relations and exact usage
    # locations. Shot-output plans and applicability edges are read by the
    # breakdown page, not copied through every entity's acceptance calculation.
    rows=[p.record_view(r) for r in store.db.execute("""SELECT r.*,o.kind,o.current_revision
        FROM objects o JOIN revisions r ON r.id=o.current_revision
        WHERE o.kind IN ('STATE','ASSET','AV_SCENE','AV_SHOT')
        OR (o.kind='RELATION' AND json_extract(r.payload,'$.relation_type') IN ('entity','business'))
        OR (o.kind='REQUIREMENT' AND json_extract(r.payload,'$.scope.object_id') IN
            (SELECT s.id FROM objects s JOIN revisions sr ON sr.id=s.current_revision
             WHERE s.kind='STATE' AND json_extract(sr.payload,'$.entity.object_id')=?)) ORDER BY o.id""", (entity_id,))]
    from .business_relations import archived_ids
    archived = archived_ids(store)
    rows=[r for r in rows if r['payload'].get('format') in p.FORMATS and r['object_id'] not in archived]
    from .production_current import annotate as annotate_current, enabled as current_enabled
    rows = [annotate_current(store, r) for r in rows]
    # Match the complete record projection used by current_records for assets.
    for row in rows:
        if row['kind']=='ASSET':
            member=store.db.execute('SELECT number FROM material_plan_members WHERE revision_id=? ORDER BY (material_id=?),material_id,number DESC LIMIT 1',(row['id'],row['object_id'])).fetchone() or store.db.execute('SELECT number FROM material_members WHERE revision_id=? ORDER BY (material_id=?),material_id,number DESC LIMIT 1',(row['id'],row['object_id'])).fetchone()
            row['material_version']=member[0] if member else None
    if revision_id:
        target = p.record(store, entity_id, revision_id)
        if target.get('unavailable') or target['kind'] != 'ENTITY':
            raise ValueError('准确实体版本不可用；旧审批链接不能替换为当前内容')
    scope=current_scope(store,entity_id,rows)
    if revision_id:
        scope['entity'] = ref(target)
    data=contents(store,scope)
    base={'comment_records': [], 'usages': {}}
    for form in data['states']:
        base['usages'][form['id']] = [
            {'kind':row['kind'], 'title':row['payload']['title'],
             'sources':row['payload'].get('sources', []), **ref(row)}
            for row in rows if row['kind']=='AV_SHOT' and ref(form) in row['payload'].get('states', [])]
    owned_ids={entity_id, *(r['object_id'] for r in rows if r['kind']=='STATE' and r['payload']['entity']['object_id']==entity_id)}
    for comment in store.comments():
        row=p.record(store,comment['target_object_id'],comment['target_revision_id'])
        if row['object_id'] in owned_ids or row['kind']=='ASSET' and er.related_media(store,[row],entity_id,[]):
            base['comment_records'].append(row)
    media=er.related_media(store,rows,entity_id,data['states'])
    data['media']=er.scope_contents(store,{'entity':scope['entity'],'states':scope['states'],'media':media})['media']
    # Retained states and cross-entity coverage are browsing context only.
    # They never enter the current generation/acceptance scope.
    retained_states=[r for r in rows if r['kind']=='STATE' and r['payload'].get('entity',{}).get('object_id')==entity_id and r['id'] not in {v['id'] for v in data['states']}]
    for item in data['media']:
        asset=item['record']
        refs=[v['state'] for v in asset['payload'].get('state_coverage',[]) if v.get('component_id')==item['component_id']]
        if not refs:refs=asset['payload'].get('states',[])
        exact_states=[(r,p.ref_record(store,r,{'STATE'})) for r in refs]
        owned=[r for r,s in exact_states if not s.get('unavailable') and s['payload']['entity']['object_id']==entity_id]
        if not item.get('state') and len({r['revision_id'] for r in owned})==1:item['review_state']=owned[0]
        item['associated_states']=[{'state':s,'entity':p.ref_record(store,s['payload']['entity'],{'ENTITY'})} for r,s in exact_states if not s.get('unavailable')]
        item['missing_states']=[s for _,s in exact_states if s.get('unavailable')]
    contexts=media_review.enrich_media(store,data['media'])
    calls=[c['call'] for c in contexts.values() if c['call']]
    for oid in {m['record']['object_id'] for m in data['media']}:
        for history in store.db.execute('SELECT id FROM revisions WHERE object_id=?',(oid,)):
            asset=p.record(store,revision_id=history[0])
            if asset['id'] not in contexts:contexts[asset['id']]=media_review.context(store,asset)
            if contexts[asset['id']]['call']:calls.append(contexts[asset['id']]['call'])
    targets={r['id']:r for r in [*base['comment_records'],data['entity'],*data['states'],*retained_states,*data['requirements'],*data['relationships'],*calls,*(m['record'] for m in data['media'])]}
    related_ids={r['object_id'] for r in [*data['requirements'],*data['relationships'],*calls]}
    # Keep opinions on withdrawn relationships and earlier actual inputs discoverable.
    for c in store.comments():
        rid=c.get('target_revision_id')
        if not rid or rid in targets:continue
        r=p.record(store,c['target_object_id'],rid)
        if r['object_id'] in related_ids or rel.for_entity([r],entity_id):targets[rid]=r
    prep=preparation(store,scope)
    if not revision_id:
        own = ref(data['entity'])
        from .production_breakdown import exact_scoped
        entity_needs = [r for r in exact_scoped(store, 'REQUIREMENT', own['revision_id'])
                        if r['payload'].get('status') != 'withdrawn']
        data['requirements'] = list({r['id']: r for r in [*data['requirements'], *entity_needs]}.values())
        for need in entity_needs:targets[need['id']] = need
    versions={r['object_id']:[{'id':v[0],'version':v[1]} for v in store.db.execute('SELECT id,version FROM revisions WHERE object_id=? ORDER BY version DESC',(r['object_id'],))]
              for r in [data['entity'],*data['states'],*retained_states,*data['requirements'],*data['relationships'],*(m['record'] for m in data['media'])]}
    from .material_plans import snapshot as material_snapshot, memberships as plan_memberships
    from .material_storage import identity as material_identity
    for need in data['requirements']:
        need['material_identity']=material_identity(store,need['object_id'])
        need['review_input_records'] = [p.ref_record(store, v['reference']) for v in need['payload'].get('generation', {}).get('inputs', [])]
    material_versions = {r['object_id']: material_snapshot(store, r['object_id']) for r in data['requirements']}
    for need in data['requirements']:
        mid=need['material_identity']['id']
        if mid not in material_versions:material_versions[mid]=material_snapshot(store,mid)
    for item in data['media']:
        # Shared media may have its production requirement on another entity.
        # Read that same round without extending this entity's acceptance scope.
        for mid in sorted({item['record']['object_id'],*[m['material_id'] for m in plan_memberships(store,item['record']['id'])]}):
            if mid not in material_versions:
                rounds=material_snapshot(store,mid)
                if rounds:material_versions[mid]=rounds
    for rounds in material_versions.values():
        for round in rounds:
            for row in [*round['members'],*[v for v in round.get('definition_records',{}).values() if v]]:
                targets[row['id']] = row
                if row['kind'] == 'ASSET':
                    if row['id'] not in contexts:contexts[row['id']]=media_review.context(store,row)
                    for related in [contexts[row['id']]['call'], *contexts[row['id']]['requirements']]:
                        if related:targets[related['id']] = related
    from .material_versions import memberships as legacy_memberships, snapshot as legacy_snapshot
    legacy_versions={}
    for row in ([] if current_enabled(store) else [*data['requirements'],*[item['record'] for item in data['media']]]):
        ids=[row['object_id']] if row['kind']=='REQUIREMENT' else sorted({m['material_id'] for m in legacy_memberships(store,row['id'])},key=lambda mid:(mid==row['object_id'],mid))
        for mid in ids:
            if mid not in legacy_versions:legacy_versions[mid]=legacy_snapshot(store,mid)
    if not any(material_versions.values()):material_versions=legacy_versions
    from .material_plans import card_counts
    # All switchable originals bring their exact historical use names. These
    # are labels only; they never extend the entity's acceptance scope.
    title_refs = {ref['revision_id']: ref for row in targets.values() if row['kind'] == 'ASSET'
                  for item in row['payload'].get('state_coverage', []) for ref in [item['state']]}
    reference_titles = []
    for reference in title_refs.values():
        target = p.ref_record(store, reference)
        if not target.get('unavailable'):
            reference_titles.append({**reference, 'title': target['payload']['title']})
    return {'reference_titles': reference_titles,**base,**data,'material_card_counts':card_counts(store,material_versions),'retained_states':retained_states,'legacy_material_versions':legacy_versions,'material_versions':material_versions,'materialContexts':contexts,'related_entities':rel.nodes(store,data['relationships'],bool(revision_id)),
            'relationship_layout':rel.layout(store,entity_id,data['relationships']),
            'format':'entity-workspace-v2','scope':scope,'content_key':digest(canonical(scope).encode()),'historical':bool(revision_id),
            'preparation':prep,
            'adoptions':[r for r in p.current_records(store,{'RELATION'}) if r['payload'].get('relation_type')=='adoption'],'versions':versions,'comment_records':list(targets.values()),'comment_targets':[ref(r) for r in targets.values()]}


def readiness(store, requirement_id):
    need=p.record(store,requirement_id)
    if need['kind']!='REQUIREMENT':raise ValueError('generation needs a requirement')
    plan=need['payload'].get('generation');issues=[];inputs=[]
    from .version_consolidation import deleted, NOTICE
    # Unselected alternatives remain inspectable, but do not block the active route.
    from .material_relations import active_inputs
    selected_inputs, route_issues = active_inputs(store, plan or {}, need['object_id'])
    inspected = {**need['payload'], 'generation': {**(plan or {}), 'inputs': [v for _, v in selected_inputs]}}
    missing = [path for path, reference in p.references(inspected, include_unavailable=True)
               if reference.get('unavailable') or deleted(store, reference['revision_id'])]
    if missing or need['payload'].get('consolidation_identity_only'):
        return {'requirement':need,'plan':plan,'inputs':[], 'i2i_depth':0,
                'issues':[NOTICE+' '+path for path in missing] or ['保留产物的原始需求方案未登记'], 'ready':False}
    if not plan:issues.append('尚无生成方案')
    method_basis = None
    if plan:
        from .method_media import verify
        try:
            method_basis = verify(store, need['object_id'], need['payload'], need['id'])
        except (KeyError, ValueError) as exc:
            issues.append(str(exc))
    if need['payload'].get('status')=='withdrawn':issues.append('素材需求已撤回')
    if plan:
        issues.extend(plan.get('blockers',[]))
        from .shot_references import applies, slots
        exact_slots=slots(store,plan['inputs']) if applies(store,need) else None
        from .material_relations import active_inputs, cycle_issues
        selected_inputs, route_issues = active_inputs(store, plan, need['object_id'])
        issues.extend(cycle_issues(store, need))
        for index,item in selected_inputs:
            if item.get('selection_state')=='unselected':
                issues.append('参考 '+str(index+1)+'：尚未选定素材版本和候选')
                continue
            if exact_slots is not None and exact_slots[index]['issues']:
                issues.extend('参考 '+str(index+1)+'：'+issue for issue in exact_slots[index]['issues'])
                continue
            target=p.ref_record(store,item['reference']);selection=item
            if target['kind']=='REQUIREMENT':
                row=p._input_readiness(store,target['payload']['scope']['object_id'],p._package_component_validator(store),exact_requirement=target)['requirements'][0]
                if not row or row['issues']:
                    issues.append(target['payload']['title']+'：尚未选定可用原件');continue
                selection=row['adoption']['payload']
                target=p.ref_record(store,selection['asset'],{'ASSET'})
            try:
                asset,component=p.component_for(store,ref(target),selection['component_id'])
                validate_component(p.root_of(store),component,inspect=False);p.validate_selection(component,selection)
                if asset['payload'].get('placeholder'):raise ValueError('占位素材不能作为生成参考')
                inputs.append({'asset':ref(asset),'component':component,'use':item['use'],
                               **{k:selection[k] for k in ('crop','range') if k in selection},
                               **{k:copy.deepcopy(item[k]) for k in ('role','material_selection') if k in item},
                               'plan_input_index':index+1})
            except (KeyError,ValueError,OSError) as exc:issues.append(str(exc))
    contract = None
    if plan and plan['method'] == 'generate':
        from .input_contracts import planned_contract, label_inputs, check
        declarations = [{'media_type': p.ref_record(store, item['reference'])['payload']['media_type'],
                         'role': item.get('role')} for _, item in selected_inputs]
        contract = planned_contract(plan, declarations)
        issues.extend(contract['issues'])
        mode = contract.get('mode_check')
        if mode and not mode['verified']:
            issues.extend(mode['unknowns'])
        if len(inputs) == len(selected_inputs):
            actual_contract = check(plan['model'], plan['prompt'], label_inputs(inputs),
                                    parameters=plan['parameters'], execution=plan.get('execution'))
            issues.extend(actual_contract['issues'])
            contract['selected_inputs'] = actual_contract
    images=[v for v in inputs if v['component']['mime'].startswith('image/')] if need['payload']['media_type']=='image' else []
    depths=[p.ref_record(store,v['asset'])['payload'].get('lineage',{}).get('i2i_depth') for v in images]
    if any(type(d) is not int for d in depths):issues.append('图像参考谱系未知，应回到可追溯的干净母版')
    depth=1+max((d for d in depths if type(d) is int),default=-1)
    if plan and plan['method']=='generate' and images and depth>2:issues.append('图像参考超过两代，应回到干净母版')
    return {'requirement':need,'plan':plan,'inputs':inputs,'i2i_depth':max(depth,0),
            'input_contract':contract,'method_basis':method_basis,'issues':list(dict.fromkeys(issues)),'ready':not issues}


def package(store, requirement_id):
    ready=readiness(store,requirement_id)
    if not ready['ready']:raise Conflict('；'.join(ready['issues']))
    plan=ready['plan']
    from .input_contracts import label_inputs, check
    from .material_plans import randomization
    inputs=label_inputs(ready['inputs'])
    contract=check(plan['model'],plan['prompt'],inputs,parameters=plan['parameters'],execution=plan.get('execution'))
    if contract['issues']:raise Conflict('；'.join(contract['issues']))
    method_snapshot = None
    if (ready.get('method_basis') or {}).get('execution'):
        from .methods import read
        method_snapshot = read(store, **ready['method_basis']['execution'])['payload']
    from .production_current import enabled, marker, checksum
    current_fields = {}
    if enabled(store):
        basis = {r['object_id']: r for _, r in p.references(ready['requirement']['payload'])}
        current_fields = {'current_marker': marker(ready['requirement']),
                          'current_basis': [{**r, 'content_sha256': checksum(p.ref_record(store,r)['payload'])} for r in basis.values()]}
    return {'format':'generation-package-v1','requirement':ref(ready['requirement']), **current_fields,
            **({'method_basis': ready['method_basis']} if ready.get('method_basis') else {}),
            **({'method_snapshot': method_snapshot} if method_snapshot else {}),
            'method':plan['method'],'model':plan['model'],'parameters':copy.deepcopy(plan['parameters']),
            'randomization':randomization(plan),
            **({'execution':copy.deepcopy(plan['execution'])} if 'execution' in plan else {}),
            'prompt':plan['prompt'],'output':copy.deepcopy(plan['output']),'inputs':inputs,'input_contract':contract,'i2i_depth':ready['i2i_depth'],
            'execution_note':'执行前重新检查任务授权、准确参考文件、平台可用性及现有额度；此包不表示已经调用模型。'}


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
    try:old=p.record(store,object_id)
    except KeyError:old=None
    # Finishing a submitted call keeps its already executed inputs, even when
    # the next plan has changed. Old retired references remain historical only.
    executed = old and store.db.execute("SELECT 1 FROM revisions WHERE object_id=? AND json_extract(payload,'$.status') IN ('submitted','completed','failed','unknown') LIMIT 1", (object_id,)).fetchone()
    if executed:
        if old['payload'].get('actual_seed') is not None and payload.get('actual_seed')!=old['payload']['actual_seed']:raise Conflict('cannot rewrite actual random seed')
        for key in ('generation_requirement','generation_acceptances','prepared_plan','material_definition_id','method','tool','model','parameters','prompt','inputs','output','randomization','execution','method_basis'):
            if payload.get(key)!=old['payload'].get(key):raise Conflict('调用状态登记不能改写已经执行的输入')
        from .production_current import enabled, submission
        if enabled(store):
            if old['payload']['status'] == 'completed' and payload['status'] != 'completed':
                raise Conflict('已完成的真实调用不能被迟到状态撤回')
            for field in ('response', 'cost', 'request_id'):
                if field in old['payload'] and payload.get(field) != old['payload'][field]:
                    raise Conflict('不能改写原调用回执：'+field)
            request = submission(store,object_id)['snapshot']['request']
            for key, value in request.items():
                if payload.get(key) != value:
                    raise Conflict('提交快照不可改写：'+key)
        return
    if 'generation_acceptances' in payload:
        raise ValueError('新调用不接受已退役的审批字段')
    if payload.get('status') not in ('submitted','completed','failed','unknown'):return
    if not payload.get('generation_requirement'):
        from .method_media import activation
        if activation(store):
            raise Conflict('新媒体调用必须关联准确生成方案与方法依据；不能绕过统一准备入口')
        if payload.get('prepared_plan'):
            from .shot_references import applies
            if applies(store,p.ref_record(store,payload['prepared_plan'])):
                raise Conflict('新镜头调用必须提供准确生成依据并通过统一生产校验')
        return
    need=p.ref_record(store,payload['generation_requirement'],{'REQUIREMENT'})
    if payload['status'] in ('failed','unknown'):
        from .shot_references import applies
        from .method_media import activation
        if not applies(store,need) and not activation(store):return
    manifest=package(store,need['object_id'])
    if manifest.get('method_basis') != payload.get('method_basis'):
        raise Conflict('实际调用缺少同一准备包的方法依据')
    if (manifest['inputs'] or manifest.get('execution')) and not manifest['input_contract']['verified']:
        raise Conflict('参考输入的模型契约尚未核实，不能登记新执行调用')
    if manifest['requirement']!=payload['generation_requirement']:
        raise Conflict('生成依据已变化')
    for field in ('model','parameters','prompt','execution'):
        if manifest.get(field)!=payload.get(field):raise Conflict('实际生成输入不同于准备方案：'+field)
    if manifest.get('execution') and payload.get('tool') != manifest['execution']['channel']:
        raise Conflict('实际调用渠道不同于准备依据')
    from .material_plans import randomization
    if manifest['randomization']!=randomization(payload):raise Conflict('实际随机策略不同于准备方案')
    expected=[{'object_id':v['asset']['object_id'],'revision_id':v['asset']['revision_id'],'component_id':v['component']['id'],**{k:v[k] for k in ('crop','range','role') if k in v}} for v in manifest['inputs']]
    actual=[v for v in payload['inputs'] if v.get('component_id')]
    if expected!=actual:raise Conflict('实际生成参考不同于准备包')
