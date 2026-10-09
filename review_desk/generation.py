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
CONTENT_MODEL = 'entity-content-v1'
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
        raise ValueError('generation acceptance requires an entity')
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
        if form['payload']['entity'] != scope['entity']:
            issues.append({'object_id':form['object_id'], 'code':'entity_changed', 'message':form['payload']['title']+'：基础信息已变化，需复核'})
        needs = [r for r in data['requirements'] if r['payload']['scope']==ref(form)]
        if form['payload']['reference_media']!='none' and form['payload'].get('reference_mode')!='description' and not any(r['payload']['required'] for r in needs):
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
    # Once a canonical decision exists it permanently supersedes old content
    # decisions, including after cancellation. Never fall back to an older yes.
    try:
        return p.record(store, decision_id(entity_id))
    except KeyError:
        row = store.db.execute("""SELECT r.id FROM objects o JOIN revisions r ON r.id=o.current_revision
            WHERE o.kind='JUDGMENT' AND json_extract(r.payload,'$.acceptance_model')='entity-current-v1'
            AND json_extract(r.payload,'$.target.object_id')=? ORDER BY r.created_at DESC,r.id DESC LIMIT 1""", (entity_id,)).fetchone()
        return p.record(store, revision_id=row[0]) if row else None


def accepted(store, entity_id, scope=None):
    d=decision(store,entity_id)
    scope = scope or current_scope(store,entity_id)
    return d if d and d['payload'].get('acceptance_model')==MODEL and d['payload']['verdict']=='accepted' and d['payload']['acceptance_scope']==scope and preparation(store,scope)['complete'] else None


def content_scope(store, entity_id, previous=None, rows=None):
    """Only reinstate an existing, unchanged legacy acknowledgement.

    This scope deliberately carries no generation plans or generation permission.
    New/incomplete content cannot obtain a fresh acknowledgement via this path.
    """
    from . import entity_review as er
    previous = previous or decision(store, entity_id)
    scope = previous['payload'].get('acceptance_scope', {}) if previous else {}
    if set(scope) != {'entity', 'states', 'media'}:
        return None
    return scope if scope == er.current_scope(store, entity_id, rows) else None


def validate_content_decision(store, object_id, payload, check_current=True):
    from . import entity_review as er
    scope = payload.get('acceptance_scope')
    if payload.get('acceptance_model') != CONTENT_MODEL or payload.get('verdict') not in ('accepted', 'revoked'):
        raise ValueError('unsupported content decision')
    if isinstance(scope, dict) and 'media' not in scope:
        # Content acknowledgement uses the same exact scope as generation, but
        # does not require preparation and can never authorize execution.
        validate_decision(store, object_id, {**payload, 'acceptance_model': MODEL, 'verdict': 'accepted'}, False)
        eid = scope['entity']['object_id']
        previous_ref = payload.get('previous_decision')
        previous = p.ref_record(store, previous_ref, {'JUDGMENT'}) if previous_ref else None
        if previous and (previous['payload'].get('acceptance_model') not in (MODEL, CONTENT_MODEL, er.ACCEPTANCE_MODEL)
                         or previous['payload']['target']['object_id'] != eid):
            raise ValueError('previous content decision belongs to another entity or model')
        if payload['verdict'] == 'revoked' and (not previous
                or previous['payload'].get('acceptance_model') != CONTENT_MODEL
                or previous['payload']['verdict'] != 'accepted'
                or previous['payload']['acceptance_scope'] != scope):
            raise ValueError('revoke must name the exact accepted content decision')
        if check_current:
            current = decision(store, eid)
            if (ref(current) if current else None) != previous_ref:
                raise Conflict('采纳记录已有变化，请刷新后操作。')
            if payload['verdict'] == 'accepted':
                if scope != current_scope(store, eid):
                    raise Conflict('设定、关系或生成方案已有更新，请刷新后采纳。')
                if current and current['payload']['verdict'] == 'accepted' and current['payload']['acceptance_scope'] == scope:
                    raise Conflict('当前内容已采纳。')
        return
    # Preserve the original validation contract for historical legacy cycles.
    er.validate_current_acceptance(store, {**payload, 'acceptance_model': er.ACCEPTANCE_MODEL, 'verdict': 'accepted'}, False)
    eid = scope['entity']['object_id']
    if object_id != decision_id(eid):
        raise ValueError('content decision requires canonical entity identity')
    previous = p.ref_record(store, payload.get('previous_decision'), {'JUDGMENT'})
    if (previous['payload'].get('acceptance_model') not in (MODEL, CONTENT_MODEL, er.ACCEPTANCE_MODEL)
            or previous['payload'].get('acceptance_scope') != scope
            or previous['payload']['verdict'] != ('revoked' if payload['verdict']=='accepted' else 'accepted')):
        raise ValueError('content decision must alternate on the exact previous scope')
    if check_current:
        current = decision(store, eid)
        if not current or ref(current) != payload['previous_decision']:
            raise Conflict('采纳记录已有变化，请刷新后操作。')
        if payload['verdict']=='accepted' and content_scope(store, eid, previous) != scope:
            raise Conflict('旧认可内容已有更新，不能重新采纳原范围；请完善当前方案。')


def validate_decision(store, object_id, payload, check_current=True):
    scope=payload.get('acceptance_scope')
    if payload.get('acceptance_model')!=MODEL or payload.get('verdict') not in ('accepted','revoked'):
        raise ValueError('unsupported generation decision')
    if not isinstance(scope,dict):raise ValueError('decision requires exact scope')
    entity=p.ref_record(store,scope.get('entity'),{'ENTITY'});eid=entity['object_id']
    if object_id!=decision_id(eid) or payload['target']!=scope['entity']:
        raise ValueError('generation decision must use the entity decision identity')
    if payload['verdict']=='revoked':
        previous=p.ref_record(store,payload.get('previous_decision'),{'JUDGMENT'})
        if (previous['payload'].get('acceptance_model') not in (MODEL,'entity-current-v1')
                or previous['payload'].get('verdict')!='accepted'
                or previous['payload'].get('acceptance_scope')!=scope
                or previous['payload']['target']['object_id']!=eid):
            raise ValueError('revoke must name the exact accepted decision')
        if check_current:
            old=decision(store,eid)
            if not old or ref(old)!=payload['previous_decision']:
                raise Conflict('采纳记录已有变化，请刷新后操作。')
        return
    if set(scope) not in ({'entity','states','requirements','dependencies'}, {'entity','states','requirements','dependencies','relationships'}):
        raise ValueError('generation acceptance requires exact content scope')
    data=contents(store,scope)
    for refs in (scope['states'],scope['requirements'],scope['dependencies'],scope.get('relationships',[])):
        if len({canonical(r) for r in refs})!=len(refs):raise ValueError('duplicate accepted reference')
    if any(not complete(s) or s['payload']['entity']['object_id']!=eid for s in data['states']):
        raise ValueError('accepted state belongs to another entity')
    if any(r['payload']['scope'] not in scope['states'] for r in data['requirements']):
        raise ValueError('accepted requirement belongs to another state')
    from .entity_relations import for_entity
    if for_entity(data['relationships'],eid)!=data['relationships']:
        raise ValueError('accepted relationships must directly involve this entity')
    for r in scope['dependencies']:p.ref_record(store,r,{'ASSET','REQUIREMENT'})
    if not check_current:return
    if scope!=current_scope(store,eid):raise Conflict('设定、关系或生成方案已有更新，请刷新后采纳。')
    if not preparation(store,scope)['complete']:raise Conflict('制作描述或素材方案尚未完整。')
    if accepted(store,eid,scope):raise Conflict('当前方案已采纳。')


def decide(store, value):
    eid=value['entity_id'];old=decision(store,eid)
    if type(value.get('expected_version')) is not int:raise ValueError('expected_version required')
    version=old['version'] if old and old['object_id']==decision_id(eid) else 0
    if value['expected_version'] != version:
        raise Conflict('采纳记录已有变化，请刷新后操作。')
    action=value.get('action')
    if action not in ('accept','revoke'):raise ValueError('action must be accept or revoke')
    if action=='revoke':
        if not old or old['payload']['verdict']!='accepted':raise Conflict('没有可取消的当前采纳。')
        if value.get('decision_ref') is not None and value['decision_ref']!=ref(old):raise Conflict('采纳记录已有变化，请刷新后操作。')
        if old['payload'].get('acceptance_model')!='entity-generation-v1' and value.get('decision_ref')!=ref(old):
            raise Conflict('取消旧采纳须指定准确决定。')
        scope=old['payload']['acceptance_scope']
    else:scope=value['scope']
    mode = value.get('acceptance_mode', 'generation')
    if mode not in ('generation', 'content'):
        raise ValueError('unsupported acceptance mode')
    model = CONTENT_MODEL if (action=='accept' and mode=='content') or (action=='revoke' and old['payload'].get('acceptance_model')==CONTENT_MODEL) else MODEL
    payload={'format':'production-judgment-v1','title':p.ref_record(store,scope['entity'])['payload']['title']+' · '+('采纳生成方案' if action=='accept' else '取消采纳'),
             'blocks':[{'id':'decision','text':value['reason']}], 'target':scope['entity'],'verdict':'accepted' if action=='accept' else 'revoked',
             'acceptance_model':model,'acceptance_scope':scope,'actor':value['actor'],'reason':value['reason']}
    if model==CONTENT_MODEL:
        payload['title']=p.ref_record(store,scope['entity'])['payload']['title']+' · '+('采纳当前内容' if action=='accept' else '取消内容认可')
    if old and (action=='revoke' or model==CONTENT_MODEL):payload['previous_decision']=ref(old)
    return p.judge(store,{'object_id':decision_id(eid),'expected_version':value['expected_version'],'payload':payload})


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
        WHERE o.kind IN ('STATE','ASSET','REPRESENTATION','AV_SCENE','AV_SHOT')
        OR (o.kind='RELATION' AND json_extract(r.payload,'$.relation_type')='entity')
        OR (o.kind='REQUIREMENT' AND json_extract(r.payload,'$.scope.object_id') IN
            (SELECT s.id FROM objects s JOIN revisions sr ON sr.id=s.current_revision
             WHERE s.kind='STATE' AND json_extract(sr.payload,'$.entity.object_id')=?)) ORDER BY o.id""", (entity_id,))]
    rows=[r for r in rows if r['payload'].get('format') in p.FORMATS]
    # Match the complete record projection used by current_records for assets.
    for row in rows:
        if row['kind']=='ASSET':
            member=store.db.execute('SELECT number FROM material_plan_members WHERE revision_id=? ORDER BY (material_id=?),material_id,number DESC LIMIT 1',(row['id'],row['object_id'])).fetchone() or store.db.execute('SELECT number FROM material_members WHERE revision_id=? ORDER BY (material_id=?),material_id,number DESC LIMIT 1',(row['id'],row['object_id'])).fetchone()
            row['material_version']=member[0] if member else None
    if revision_id:
        selected=p.record(store,revision_id=revision_id)
        legacy=selected['payload'].get('acceptance_model') not in (MODEL,CONTENT_MODEL)
        legacy_cancel=selected['payload'].get('acceptance_model') in (MODEL,CONTENT_MODEL) and 'media' in selected['payload'].get('acceptance_scope',{})
        if legacy or legacy_cancel:
            if legacy_cancel and selected['object_id']!=decision_id(entity_id):raise ValueError('historical decision belongs to another entity')
            if legacy_cancel:
                original=selected
                while original['payload'].get('acceptance_model') != er.ACCEPTANCE_MODEL:
                    original=p.ref_record(store,original['payload']['previous_decision'])
                result=er.legacy_snapshot(store,entity_id,original['id'])
            else:result=er.legacy_snapshot(store,entity_id,revision_id)
            result.update({'legacy_acceptance':True,'can_accept':False,'can_revoke':False,'requirements':[], 'relationships':[], 'related_entities':[]})
            if legacy_cancel:result.update(accepted=None,content_accepted=selected if selected['payload']['verdict']=='accepted' else None,status=selected['payload']['verdict'])
            result['materialContexts']=media_review.enrich_media(store,result['media'])
            return result
        if selected['object_id']!=decision_id(entity_id):raise ValueError('historical decision belongs to another entity')
        scope=selected['payload']['acceptance_scope']
    else:
        selected=None;scope=current_scope(store,entity_id,rows)
    data=contents(store,scope)
    base=er.legacy_snapshot(store,entity_id,rows=rows)
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
    d=decision(store,entity_id);a=selected if selected and selected['payload'].get('acceptance_model')==MODEL and selected['payload']['verdict']=='accepted' else (accepted(store,entity_id,scope) if not revision_id else None)
    revoke=d if not revision_id and d and d['payload']['verdict']=='accepted' else None
    history=[]
    from .review_decisions import scope_records
    for row in store.db.execute("""SELECT r.id FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='JUDGMENT'
            AND json_extract(r.payload,'$.acceptance_model') IN ('entity-current-v1','entity-generation-v1','entity-content-v1')
            AND json_extract(r.payload,'$.target.object_id')=? ORDER BY r.created_at DESC,r.version DESC,r.id DESC""",(entity_id,)):
        h=p.record(store,revision_id=row[0]);history.append({'revision_id':h['id'],'created_at':h['created_at'],'actor':h['payload']['actor'],'verdict':h['payload']['verdict'],
            'decision':h,'scope_records':scope_records(store,h['payload'].get('acceptance_scope'))})
    prep=preparation(store,scope)
    compatible=content_scope(store,entity_id,d,rows) if not revision_id else None
    content_decision=selected if revision_id else d
    content_accepted=content_decision if content_decision and content_decision['payload']['verdict']=='accepted' and (
        compatible or (content_decision['payload'].get('acceptance_model')==CONTENT_MODEL and content_decision['payload']['acceptance_scope']==scope)) else None
    acceptance_mode='generation' if prep['complete'] else 'content'
    # Entity-level demands are browsing context. Keep the immutable decision
    # scope and preparation above unchanged; displaying them grants no approval.
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
    for row in [*data['requirements'],*[item['record'] for item in data['media']]]:
        ids=[row['object_id']] if row['kind']=='REQUIREMENT' else sorted({m['material_id'] for m in legacy_memberships(store,row['id'])},key=lambda mid:(mid==row['object_id'],mid))
        for mid in ids:
            if mid not in legacy_versions:legacy_versions[mid]=legacy_snapshot(store,mid)
    if not any(material_versions.values()):material_versions=legacy_versions
    from .material_plans import card_counts
    from .review_decisions import scope_records
    return {**base,**data,'decision_scope_records':scope_records(store,scope),'material_card_counts':card_counts(store,material_versions),'retained_states':retained_states,'legacy_material_versions':legacy_versions,'material_versions':material_versions,'materialContexts':contexts,'related_entities':rel.nodes(store,data['relationships'],bool(revision_id)),
            'relationship_layout':rel.layout(store,entity_id,data['relationships']),
            'format':'entity-workspace-v2','scope':scope,'content_key':digest(canonical(scope).encode()),'historical':bool(revision_id),
            'accepted':a,'content_accepted':content_accepted,'status':'accepted' if a or content_accepted else 'unaccepted',
            'acceptance_mode':acceptance_mode,'decision_scope':scope,
            'can_accept':not revision_id and not a and not revoke,
            'can_revoke':bool(revoke),'revoke_target':ref(revoke) if revoke else None,
            'decision':d,'decision_version':d['version'] if d and d['object_id']==decision_id(entity_id) else 0,'preparation':prep,'history':history,
            'adoptions':[r for r in p.current_records(store,{'RELATION'}) if r['payload'].get('relation_type')=='adoption'],'previous_accepted':None,'versions':versions,'comment_records':list(targets.values()),'comment_targets':[ref(r) for r in targets.values()]}


def readiness(store, requirement_id):
    need=p.record(store,requirement_id)
    if need['kind']!='REQUIREMENT':raise ValueError('generation needs a requirement')
    plan=need['payload'].get('generation');issues=[];inputs=[];approvals=[]
    from .version_consolidation import deleted, NOTICE
    # Unselected alternatives remain inspectable, but do not block the active route.
    from .material_relations import active_inputs
    selected_inputs, route_issues = active_inputs(store, plan or {}, need['object_id'])
    inspected = {**need['payload'], 'generation': {**(plan or {}), 'inputs': [v for _, v in selected_inputs]}}
    missing = [path for path, reference in p.references(inspected, include_unavailable=True)
               if reference.get('unavailable') or deleted(store, reference['revision_id'])]
    if missing or need['payload'].get('consolidation_identity_only'):
        return {'requirement':need,'plan':plan,'acceptances':[], 'inputs':[], 'i2i_depth':0,
                'issues':[NOTICE+' '+path for path in missing] or ['保留产物的原始需求方案未登记'], 'ready':False}
    if not plan:issues.append('尚无生成方案')
    if need['payload'].get('status')=='withdrawn':issues.append('素材需求已撤回')
    scope=p.ref_record(store,need['payload']['scope'])
    from .production_acceptance import snapshot as content_acceptance
    chosen = content_acceptance(store, need['object_id'], need['id'])
    if chosen['accepted']:
        approvals.extend(chosen['acceptances'])
    elif scope['kind'] != 'STATE':
        issues.append('此准确制作方案尚未采纳')
    for entity in need['payload']['entities'] if scope['kind']=='STATE' and not chosen['accepted'] else []:
        a=accepted(store,entity['object_id'])
        if not a:issues.append(p.ref_record(store,entity)['payload']['title']+'：当前生成方案未采纳')
        elif ref(need) not in a['payload']['acceptance_scope']['requirements']:issues.append('素材方案不在当前采纳范围内')
        else:approvals.append(ref(a))
    if scope['kind'].startswith('AV_'):
        design = content_acceptance(store, scope['object_id'], scope['id'])
        if design['accepted']: approvals.extend(design['acceptances'])
        else: issues.append('所用准确视听设计尚未采纳')
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
    if plan and any(r['revision_id']!=p.record(store,r['object_id'])['id'] for r in need['payload']['states']):issues.append('素材状态已有更新')
    return {'requirement':need,'plan':plan,'acceptances':approvals,'inputs':inputs,'i2i_depth':max(depth,0),
            'input_contract':contract,'issues':list(dict.fromkeys(issues)),'ready':not issues}


def package(store, requirement_id):
    ready=readiness(store,requirement_id)
    if not ready['ready']:raise Conflict('；'.join(ready['issues']))
    plan=ready['plan']
    from .input_contracts import label_inputs, check
    from .material_plans import randomization
    inputs=label_inputs(ready['inputs'])
    contract=check(plan['model'],plan['prompt'],inputs,parameters=plan['parameters'],execution=plan.get('execution'))
    if contract['issues']:raise Conflict('；'.join(contract['issues']))
    return {'format':'generation-package-v1','requirement':ref(ready['requirement']),'acceptances':ready['acceptances'],
            'method':plan['method'],'model':plan['model'],'parameters':copy.deepcopy(plan['parameters']),
            'randomization':randomization(plan),
            **({'execution':copy.deepcopy(plan['execution'])} if 'execution' in plan else {}),
            'prompt':plan['prompt'],'output':copy.deepcopy(plan['output']),'inputs':inputs,'input_contract':contract,'i2i_depth':ready['i2i_depth'],
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
    try:old=p.record(store,object_id)
    except KeyError:old=None
    # Finishing a real submitted call keeps its already executed inputs, even
    # when the user has since revoked approval or revised the next plan.
    executed = old and store.db.execute("SELECT 1 FROM revisions WHERE object_id=? AND json_extract(payload,'$.status') IN ('submitted','completed','failed','unknown') LIMIT 1", (object_id,)).fetchone()
    if executed:
        if old['payload'].get('actual_seed') is not None and payload.get('actual_seed')!=old['payload']['actual_seed']:raise Conflict('cannot rewrite actual random seed')
        for key in ('generation_requirement','generation_acceptances','prepared_plan','material_definition_id','method','tool','model','parameters','prompt','inputs','output','randomization','execution'):
            if payload.get(key)!=old['payload'].get(key):raise Conflict('调用状态登记不能改写已经执行的输入')
        return
    if payload.get('status') not in ('submitted','completed','failed','unknown'):return
    if not payload.get('generation_requirement'):
        if payload.get('prepared_plan'):
            from .shot_references import applies
            if applies(store,p.ref_record(store,payload['prepared_plan'])):
                raise Conflict('新镜头调用必须提供准确生成依据并通过统一生产校验')
        return
    need=p.ref_record(store,payload['generation_requirement'],{'REQUIREMENT'})
    if payload['status'] in ('failed','unknown'):
        from .shot_references import applies
        if not applies(store,need):return
    manifest=package(store,need['object_id'])
    if (manifest['inputs'] or manifest.get('execution')) and not manifest['input_contract']['verified']:
        raise Conflict('参考输入的模型契约尚未核实，不能登记新执行调用')
    if manifest['requirement']!=payload['generation_requirement'] or manifest['acceptances']!=payload.get('generation_acceptances'):
        raise Conflict('生成依据或采纳已变化')
    for field in ('model','parameters','prompt','execution'):
        if manifest.get(field)!=payload.get(field):raise Conflict('实际生成输入不同于采纳方案：'+field)
    if manifest.get('execution') and payload.get('tool') != manifest['execution']['channel']:
        raise Conflict('实际调用渠道不同于准备依据')
    from .material_plans import randomization
    if manifest['randomization']!=randomization(payload):raise Conflict('实际随机策略不同于采纳方案')
    expected=[{'object_id':v['asset']['object_id'],'revision_id':v['asset']['revision_id'],'component_id':v['component']['id'],**{k:v[k] for k in ('crop','range','role') if k in v}} for v in manifest['inputs']]
    actual=[v for v in payload['inputs'] if v.get('component_id')]
    if expected!=actual:raise Conflict('实际生成参考不同于准备包')
