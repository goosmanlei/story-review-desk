"""A requirement's scope is its sole production origin; uses are independent."""
from . import production as p

CONTRACT = 'material-unique-origin-v1'
KINDS = frozenset(('ENTITY', 'STATE', 'AV_SHOT'))


def origin(store, payload, *, metadata=False):
    if metadata:
        from .list_reading import ref_record
    else:
        ref_record = p.ref_record
    row = ref_record(store, payload.get('scope'))
    if row.get('unavailable') or row['payload'].get('status') == 'withdrawn':
        raise ValueError('素材制作出处不可用')
    if row['kind'] not in KINDS:
        # Only the already registered legacy current-plan adapter may have an
        # original as its scope. It cannot manufacture a new material identity.
        if row['kind'] != 'ASSET' or payload.get('current_plan_for') != payload.get('scope'):
            raise ValueError('素材必须有一个实体、实体状态或镜头制作出处')
    return row


def validate(store, payload):
    row = origin(store, payload)
    entities = {v['object_id'] for v in payload.get('entities', [])}
    if row['kind'] == 'ENTITY' and row['object_id'] not in entities:
        raise ValueError('素材制作出处与实体身份不一致')
    if row['kind'] == 'STATE':
        if (payload['scope'] not in payload.get('states', []) or
                row['payload']['entity']['object_id'] not in entities):
            raise ValueError('素材制作出处与状态及其实体不一致')
    return row


def validate_state_ownership(store):
    """Check the final current tree, after all records in a transaction exist.

    A use in ``states`` never supplies ownership. Optional and audio needs are
    valid independent work, and no state is required for a plain identity.
    Historical submissions and retired receipts remain outside this tree.
    """
    from .production_current import enabled
    if not enabled(store):
        return
    rows = p.current_records(store, {'STATE', 'REQUIREMENT'})
    states = {r['object_id']: r for r in rows
              if r['kind'] == 'STATE' and r['payload'].get('status') != 'withdrawn'}
    owned = set()
    for row in rows:
        body = row['payload']
        if row['kind'] != 'REQUIREMENT' or body.get('status') == 'withdrawn':
            continue
        target = body.get('scope', {})
        state = states.get(target.get('object_id'))
        if state and target.get('revision_id') == state['id']:
            validate(store, body)
            owned.add(state['object_id'])
    missing = sorted(set(states) - owned)
    if missing:
        raise ValueError('有效实体状态必须拥有至少一项真实素材需求；使用范围不算拥有权：' + ', '.join(missing))


def validate_output_name(store, object_id, payload):
    """Reject newly inconsistent names without rewriting historical plans."""
    from .production_current import enabled
    plan = payload.get('generation')
    if not enabled(store) or not plan or payload.get('status') == 'withdrawn':
        return
    name = plan.get('output', {}).get('name')
    if name == payload.get('title'):
        return
    # Existing migration baselines may preserve an authentic old output name.
    # A title/output edit or a newly created plan must use one current name.
    try:
        old = p.record(store, object_id)['payload']
    except KeyError:
        old = {}
    if (old.get('title') != payload.get('title') or
            old.get('generation', {}).get('output', {}).get('name') != name):
        raise ValueError('当前素材标题与生成输出名称必须一致')
