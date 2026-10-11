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
