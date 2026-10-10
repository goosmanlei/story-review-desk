"""Method facts for mutable production: hashes and references, never drafts."""
import copy
import json
from . import methods, production as p, production_current as current
from .store import Conflict, canonical

INPUTS = 'production-method-inputs-v1'
OUTPUT = 'production-method-output-v1'
WORK_TYPES = {'media-plan', 'audiovisual-design', 'generation-preflight', 'material-assessment', 'result-review', 'text-layer'}


def compact_inputs(value):
    if value.get('format') == INPUTS:
        return copy.deepcopy(value)
    guards = []
    for key in ('records', 'relation_readings', 'contextual_relations', 'supporting_records'):
        for row in value.get(key, []):
            ref = row.get('reference') or {k: row[k] for k in ('object_id', 'revision_id')}
            content = row.get('payload')
            if content is None and row.get('content_json'):
                content = json.loads(row['content_json'])
            guards.append({'reference': ref, 'kind': row['kind'], 'sha256': methods.checksum(content)})
    return {'format': INPUTS, 'sha256': methods.checksum(value),
            'context': {'sha256': methods.checksum(value.get('context'))},
            'guards': guards, 'baseline_marker': value.get('baseline_marker'),
            'baseline': {'reference': value['baseline']['reference']} if value.get('baseline') else None}


def compact_output(value, target, stage):
    if isinstance(value, dict) and value.get('format') == OUTPUT:
        return copy.deepcopy(value)
    result = {'format': OUTPUT, 'target': target, 'stage': stage, 'sha256': methods.checksum(value)}
    if stage in ('draft', 'result') and isinstance(value, dict) and 'requirement' in value and 'generation' in value:
        result.update(requirement_sha256=methods.checksum(value['requirement']),
                      generation_sha256=methods.checksum(value['generation']))
    elif isinstance(value, dict) and isinstance(value.get('assessment'), str):
        result['assessment'] = value['assessment']
    return result


def verify_guards(store, value):
    for guard in value['guards']:
        row = p.ref_record(store, guard['reference'])
        payload = store.source(row['object_id']) if row['kind'] == 'SOURCE' else row['payload']
        if guard['reference'].get('block_ids'):
            payload = {**payload, 'blocks': [b for b in payload['blocks'] if b['id'] in guard['reference']['block_ids']]}
        if methods.checksum(payload) != guard['sha256']:
            raise Conflict('方法准备所读内容已改变；保留草稿并重新准备：' + row['object_id'])


def verify(store, object_id, payload):
    from .method_media import output, activation, check_adjustment
    sha = current.checksum(payload)
    old = store.db.execute('SELECT payload_sha256 FROM production_current_baselines WHERE object_id=?', (object_id,)).fetchone()
    if old and old[0] == sha:
        return copy.deepcopy(payload.get('method_basis')) or {'history': 'unknown', 'migration_verified': True}
    adjustment = payload.get('method_adjustment')
    if adjustment:
        op = 'method-adjustment-' + methods.checksum({'target': object_id, 'sha256': sha})
        saved = store.db.execute('SELECT result FROM production_current_operations WHERE id=?', (op,)).fetchone()
        if saved:
            return json.loads(saved[0])['basis']
        parent = check_adjustment(store, object_id, payload)
        basis = verify(store, object_id, parent['payload'])
        result = {'object_id': object_id, 'before_sha256': current.checksum(parent['payload']),
                  'after_sha256': sha, 'basis': basis, 'operation': adjustment['operation']}
        store.db.execute('INSERT INTO production_current_operations VALUES (?,?,?)', (op, sha, canonical(result)))
        return basis
    basis = payload.get('method_basis')
    if not basis:
        if not activation(store):
            return None
        raise ValueError('新制作方案缺少本步骤方法依据；先完成方法准备、草稿、回读与定稿')
    identity = {'work_type': 'media-plan', 'run_id': basis['run_id'], 'step_id': basis['step_id'], 'target': object_id}
    execution = methods.verify_execution(store, basis['execution'], identity)
    facts = execution['payload']['inputs']
    methods.require(facts.get('format') == INPUTS, '新的当前稿必须经过当前方法准备入口')
    artifact = methods.read(store, **basis['artifact'])
    expected = compact_output(output(payload), object_id, 'result')
    methods.require(artifact['payload']['execution'] == basis['execution'] and artifact['payload']['stage'] == 'result'
                    and artifact['payload']['output'] == expected, '当前稿与本步骤完成的定稿摘要不一致')
    methods.require(not execution['payload'].get('private'), '公开制作方案不能引用私有创作候选')
    current_row = store.db.execute('SELECT payload_sha256 FROM production_current_records WHERE object_id=?', (object_id,)).fetchone()
    # After publication, the result hash proves the already verified step. A
    # new write must still use the unchanged target and all preparation inputs.
    if not current_row or current_row[0] != sha:
        verify_guards(store, facts)
        if facts.get('baseline_marker'):
            current.guard(store, object_id, facts['baseline_marker'])
        elif current_row:
            raise Conflict('新建方案的目标已存在；请重新准备')
    return copy.deepcopy(basis)
