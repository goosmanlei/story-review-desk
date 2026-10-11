"""Explicit, idempotent initialization of a legacy material's working plan.

The internal REQUIREMENT owns editable content; its canonical identity remains
the original material. Candidate numbers, calls and submitted snapshots stay put.
"""
import copy
from . import production as p, production_current as current
from .store import Conflict, canonical, digest


def plan_id(material_id):
    return 'current-plan-'+digest(material_id.encode())[:24]


def initial_payload(store, material_id):
    rows = list(store.db.execute('''SELECT c.* FROM production_candidate_targets t
        JOIN production_candidates c ON c.id=t.candidate_id
        WHERE t.material_id=? ORDER BY t.number DESC''', (material_id,)))
    if not rows: raise ValueError('material has no actual candidate')
    source = next((r for r in rows if current.submission(store, r['operation_id'])['snapshot'].get('request')), rows[0])
    asset = p.record(store, source['asset_object_id'])
    identity = store.db.execute('SELECT kind FROM objects WHERE id=?', (material_id,)).fetchone()
    if identity and identity[0] != 'ASSET':
        raise ValueError('material already has its own current requirement')
    if identity: asset = p.record(store, material_id)
    saved = current.submission(store, source['operation_id'])
    request = saved['snapshot'].get('request', {})
    title = asset['payload']['title']
    inputs, blockers = [], []
    for item in request.get('inputs', []):
        ref = item.get('reference', item)
        frozen = next((v for v in saved['snapshot'].get('input_contents', []) if v.get('reference', {}).get('revision_id') == ref.get('revision_id')), {})
        if frozen.get('kind') not in ('ASSET','REQUIREMENT') and not frozen.get('component'):continue
        row = p.ref_record(store, ref)
        if row['kind'] not in ('ASSET', 'REQUIREMENT'): continue
        if row.get('unavailable') or row['kind'] == 'ASSET' and not any(c['id'] == item.get('component_id') for c in row['payload'].get('components', [])):
            blockers.append('历史参考已不可用，制作前需重新选定：'+row['payload'].get('title',row['object_id']))
            continue
        value = {k:copy.deepcopy(item[k]) for k in ('component_id','range','crop','role') if k in item}
        value.update(reference={'object_id':row['object_id'],'revision_id':row['id']}, use=item.get('use') or '沿用该候选登记的参考素材')
        inputs.append(value)
    method = 'generate' if request.get('method') in ('generation','generate') else 'external-edit'
    generation = {'format':'generation-plan-v1','method':method,
        'model':request.get('model'), 'tool':request.get('tool'),
        'parameters':copy.deepcopy(request.get('parameters', {})), 'prompt':request.get('prompt') or '',
        'inputs':inputs, 'blockers':blockers, 'output':{'name':title,'description':title,
            'review_criteria':['核对当前制作目的、参考范围与交付原件']}}
    for key in ('randomization','execution'):
        if key in request:generation[key]=copy.deepcopy(request[key])
    reference = {'object_id':asset['object_id'],'revision_id':asset['id']}
    result = {'format':'production-requirement-v1','title':title,'blocks':[{'id':'purpose','text':title}],
        'scope':reference,'current_plan_for':reference,
        'initial_plan_source':{'operation_id':source['operation_id'],'snapshot_sha256':saved['snapshot_sha256']},
        'slot':'current-plan','purpose':title,'media_type':asset['payload']['media_type'],
        'required':False,'usage':'generation_input','specification':{},'entities':[],'states':[],
        'sources':copy.deepcopy(asset['payload'].get('sources', [])), 'generation':generation}
    if not identity:
        result['initial_plan_source']['material_id'] = material_id
        result['slot'] = plan_id(material_id)
    return result


def validate_identity(store, object_id, payload):
    ref = payload['current_plan_for']
    mid = payload['initial_plan_source'].get('material_id')
    if mid:
        if object_id != plan_id(mid) or not store.db.execute('''SELECT 1 FROM production_candidate_targets t
            JOIN production_candidates c ON c.id=t.candidate_id
            WHERE t.material_id=? AND c.asset_object_id=? AND c.operation_id=?''',
            (mid, ref['object_id'], payload['initial_plan_source']['operation_id'])).fetchone():
            raise ValueError('working plan must keep its exact legacy material identity')
    elif object_id != plan_id(ref['object_id']):
        raise ValueError('invalid legacy plan identity')
    if payload['scope'] != ref:raise ValueError('invalid legacy plan scope')


def verify_initial(store, object_id, payload):
    ref = payload.get('current_plan_for')
    if not ref:raise ValueError('invalid legacy plan identity')
    validate_identity(store, object_id, payload)
    mid = payload['initial_plan_source'].get('material_id') or ref['object_id']
    if payload != initial_payload(store, mid):
        raise ValueError('legacy initialization must match its exact submitted evidence; edits require the normal authoring method')
    return {'history':'exact-submission-initialization','source':payload['initial_plan_source']}


def initialize(store):
    if not current.enabled(store):raise ValueError('current production migration is required')
    ids = [r[0] for r in store.db.execute('SELECT DISTINCT material_id FROM production_candidate_targets ORDER BY material_id')]
    created, existing = [], []
    store.db.execute('BEGIN IMMEDIATE')
    try:
        for mid in ids:
            if current.material_snapshot(store, mid)[0]['plan']:
                existing.append(mid);continue
            plans = list(store.db.execute('''SELECT o.id FROM material_aliases a JOIN objects o ON o.id=a.alias_id
                WHERE a.material_id=? AND o.kind='REQUIREMENT' ''', (mid,)))
            if plans:
                existing.append(mid);continue
            oid = plan_id(mid)
            if store.db.execute('SELECT 1 FROM objects WHERE id=?',(oid,)).fetchone():
                raise Conflict('working plan identity already exists without its material binding')
            payload = initial_payload(store, mid)
            p._import_records(store, {'format':'production-import-v1','records':[
                {'object_id':oid,'kind':'REQUIREMENT','expected_version':0,'payload':payload}]}, transaction=False)
            created.append(mid)
        store.db.commit()
    except BaseException:
        store.db.rollback();raise
    return {'created':created,'existing':existing}
