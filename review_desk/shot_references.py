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
    from .production_current import input_slot
    return input_slot(store, value, index)


def with_identity(store,result):
    if result['material_id']:
        from .material_storage import canonical_id
        result['canonical_material_id']=canonical_id(store,result['material_id'])
        current = p.record(store, result['canonical_material_id'])
        result['material_category'] = current['payload'].get('material_category')
        result.update(mp.card_counts(store,[result['material_id']])[result['material_id']])
        code=store.db.execute('SELECT prefix,number FROM business_codes WHERE object_id=?',(result['canonical_material_id'],)).fetchone()
        if code:result['material_code']=code[0]+str(code[1]).zfill(3)
    return result


def slots(store, inputs):
    return [slot(store,v,i) for i,v in enumerate(inputs)]


def enrich_detail(store, detail):
    from .reference_paths import project, annotations
    targets = [detail.get('record'), *detail.get('history', [])]
    for rounds in detail.get('material_cards', {}).values():
        for version in rounds:
            targets.extend([version.get('plan'), *version.get('definition_records', {}).values()])
    for actual in detail.get('review_contexts', {}).values():
        targets.append(actual.get('call'))
    seen = set()
    for row in targets:
        if not row or id(row) in seen:
            continue
        seen.add(id(row))
        if row and row['kind'] in ('REQUIREMENT', 'CALL'):
            from .production_current import enabled
            if enabled(store) and row['kind'] == 'CALL':
                row['review_shot_slots'] = slots(store, inputs_for(store, row))
                row['review_reference_links'] = []
                row['review_prompt_links'] = []
                continue
            row['review_shot_slots'] = slots(store, inputs_for(store, row))
            from .business_relations import input_context
            basis = row if row['kind'] == 'REQUIREMENT' else None
            if row['kind'] == 'CALL':
                reference = row['payload'].get('generation_requirement') or row['payload'].get('prepared_plan')
                basis = p.ref_record(store, reference) if reference else None
            if basis:
                declared = basis['payload'].get('generation', {}).get('inputs', [])
                if row['kind'] == 'CALL':
                    from .material_relations import active_inputs
                    declared = [value for _, value in active_inputs(store, basis['payload'].get('generation', {}), basis['object_id'])[0]]
                for item, value in zip(row['review_shot_slots'], declared):
                    if row['kind'] == 'CALL':
                        actual = row['payload'].get('inputs', [])[item['index']]
                        if not (all(actual.get(k, actual.get('reference', {}).get(k)) == value['reference'].get(k) for k in ('object_id', 'revision_id'))
                                and all(actual.get(k) == value.get(k) for k in ('component_id', 'crop', 'range'))):
                            continue
                    item['relation_context'] = input_context(store, basis['object_id'], value)
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
        from .production_current import enabled, submission
        if enabled(store):
            return copy.deepcopy(submission(store, row['object_id'])['snapshot']['request'].get('inputs', []))
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
    from .production_operations import select as select_current
    return select_current(store, request)


def response(store, row, repeated):
    from .production_current import marker
    return {'requirement_id': row['object_id'], 'revision_id': row['id'], **marker(row),
            'already_applied': repeated, 'slots': slots(store, row['payload']['generation']['inputs'])}
