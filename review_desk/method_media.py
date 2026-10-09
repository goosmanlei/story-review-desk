"""Method provenance at existing media plan, preparation and call boundaries."""
import copy

from . import methods, production as p

ACTIVATION = 'method.activation.media-plan'


def brief(payload):
    return {k: copy.deepcopy(v) for k, v in payload.items()
            if k not in ('generation', 'method_basis', 'status', 'withdrawal_reason', 'required', 'blocks')}


def inputs(store, payload, baseline=None):
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
            if ref.get('block_ids'):
                content = {**content, 'blocks': [b for b in content['blocks'] if b['id'] in ref['block_ids']]}
        records.append({'object_id': row['object_id'], 'revision_id': row['id'], 'kind': row['kind'], 'payload': content})
    result = {'context': context, 'records': records}
    if baseline:
        old = p.ref_record(store, baseline, {'REQUIREMENT'})
        result['baseline'] = {'reference': baseline, 'generation': old['payload'].get('generation')}
    return result


def output(payload):
    return {'requirement': brief(payload), 'generation': copy.deepcopy(payload['generation'])}


def prepare(store, value):
    payload = value['payload']
    current = store.db.execute('SELECT version,current_revision FROM objects WHERE id=?', (value['object_id'],)).fetchone()
    methods.require(value.get('expected_version') == (current['version'] if current else 0), '制作方案基线已变化；请回读准确版本后新建步骤')
    baseline = {'object_id': value['object_id'], 'revision_id': current['current_revision']} if current else None
    request = {'work_type': 'media-plan', 'run_id': value['run_id'], 'step_id': value['step_id'],
               'target': value['object_id'], 'conditions': {'media_type': payload['media_type']},
               'inputs': inputs(store, payload, baseline)}
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


def verify(store, object_id, payload, revision_id=None):
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
    methods.verify_execution(store, basis['execution'], identity, inputs(store, payload, baseline))
    artifact = methods.read(store, **basis['artifact'])
    value = artifact['payload']
    methods.require(value['format'] == methods.FORMATS['artifact'] and value['execution'] == basis['execution']
                    and value['stage'] == 'result' and value['output'] == output(payload),
                    '制作定稿与本步骤方法产物不一致；请回到准确步骤修订')
    methods.require(not execution['payload'].get('private'), '公开制作方案不能引用私有创作候选')
    return copy.deepcopy(basis)
