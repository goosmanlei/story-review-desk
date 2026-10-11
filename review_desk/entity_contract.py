"""One entity contract, with AV_SHOT as the stored shot subtype.

The discriminator preserves existing addresses, composition, comments and writes.
These projections never create an ENTITY copy of a shot or a second relationship.
"""
from . import production as p

KINDS = frozenset(('ENTITY', 'AV_SHOT'))
CONTRACT = 'production-entity-v2'


def is_entity(row):
    return row.get('kind') in KINDS


def subtype(row):
    return 'shot' if row['kind'] == 'AV_SHOT' else row['payload'].get('entity_type', 'other')


def annotate(row):
    if is_entity(row):
        row.update(entity_contract=CONTRACT, entity_type=subtype(row))
    return row


def validate(kind, payload):
    if kind == 'AV_SHOT' and payload.get('entity_type', 'shot') != 'shot':
        raise ValueError('AV_SHOT is the shot entity subtype')
    if kind == 'ENTITY' and payload.get('entity_type') == 'shot':
        raise ValueError('shot entities use the existing AV_SHOT identity and composition')


def direct_materials(store, row):
    """All directly owned needs, including cameras omitted from products."""
    from . import list_reading as light
    found = {item['object_id']:p.record(store, item['object_id']) for item in light.rows(
        store, 'REQUIREMENT', "json_extract(r.payload,'$.scope.object_id')=? AND json_extract(r.payload,'$.scope.revision_id')=? "
        "AND COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn'", (row['object_id'], row['id']))}
    from .business_relations import scope_links
    for _, item in scope_links(store, {'object_id':row['object_id'],'revision_id':row['id']}):
        if item['kind']=='REQUIREMENT' and item['payload'].get('status')!='withdrawn':
            found[item['object_id']] = item
    return list(found.values())


def source_labels(store, row):
    labels = []
    for source in row['payload'].get('sources', []):
        episode = p.ref_record(store, source)
        scene = next((s for s in episode['payload'].get('scenes', []) if s['id'] == source.get('scene_id')), {})
        labels.append({**source, 'title':scene.get('heading') or scene.get('title') or scene.get('location') or episode['payload']['title']})
    row['review_sources'] = labels
    return row


def material_groups(row, needs):
    products = {item['requirement']['object_id']: item for item in row['payload'].get('products', [])}
    keys = [('camera', '机位参考'), ('image', '镜头首帧'), ('video', '镜头视频'),
            ('project', '字层工程'), ('audio', '声音素材'), ('other', '其他素材')]
    groups = {key: [] for key, _ in keys}
    for need in needs:
        value = need['payload']
        slot = value.get('slot', '')
        key = 'camera' if slot in ('camera', 'camera-reverse', 'camera-main') or slot.startswith('camera-') else value.get('media_type')
        if key not in groups: key = 'other'
        groups[key].append(need)
    order = {oid: i for i, oid in enumerate(products)}
    result = []
    for key, label in keys:
        values = groups[key]
        if not values: continue
        values.sort(key=lambda n: (n['payload'].get('slot') == 'camera-reverse', order.get(n['object_id'], -1), n['object_id']))
        ids = {n['object_id'] for n in values}
        result.append({'key': key, 'label': label, 'material_ids': [n['object_id'] for n in values],
                       'key_states': [state for state in row['payload'].get('key_states', [])
                                      if any(ref['object_id'] in ids for ref in state['requirements'])]})
    return result


def shot_workspace(store, object_id, revision_id=None):
    from . import material_plans, material_review, audiovisual
    from .store import canonical, digest
    row = source_labels(store, p.record(store, object_id, revision_id))
    if row['kind'] != 'AV_SHOT': raise ValueError('shot entity required')
    needs = direct_materials(store, row)
    versions = {need['object_id']: material_plans.snapshot(store, need['object_id']) for need in needs}
    contexts, targets = {}, {r['id']: r for r in [row, *needs]}
    from .shot_references import enrich_detail
    for need in needs:
        need['review_input_records'] = [p.ref_record(store, item['reference']) for item in need['payload'].get('generation', {}).get('inputs', [])]
        enrich_detail(store, {'record':need,'material_versions':{need['object_id']:versions[need['object_id']]}})
    for rounds in versions.values():
        for plan in rounds:
            for member in plan['members']:
                targets[member['id']] = member
                if member['kind'] == 'ASSET':
                    context = material_review.context(store, member)
                    contexts[member['id']] = context
                    if context.get('call'): targets[context['call']['id']] = context['call']
    scope = {'entity': {'object_id': object_id, 'revision_id': row['id']}, 'states': [],
             'requirements': [{'object_id': n['object_id'], 'revision_id': n['id']} for n in needs],
             'relationships': [], 'dependencies': []}
    return {'format': 'entity-workspace-v2', 'entity': row, 'states': [], 'retained_states': [],
            'requirements': needs, 'relationships': [], 'related_entities': [], 'media': [],
            'material_groups': material_groups(row, needs),
            'position': [{'object_id': r['object_id'], 'id': r['id'], 'kind': r['kind'],
                          'title': r['payload']['title']} for r in audiovisual.path(store, row)],
            'scope': scope, 'content_key': digest(canonical(scope).encode()), 'historical': False,
            'usages': {}, 'versions': {}, 'material_versions': versions, 'legacy_material_versions': {},
            'materialContexts': contexts, 'material_card_counts': material_plans.card_counts(store, versions),
            'comment_records': list(targets.values()),
            'comment_targets': [{'object_id': r['object_id'], 'revision_id': r['id']} for r in targets.values()]}


def graph(store, entities):
    """All real relationships between visible entities; never derive edges."""
    from . import entity_relations
    by_id = {row['object_id']: row for row in entities if row['payload'].get('status') != 'withdrawn'}
    edges = {}
    for row in p.current_records(store, {'RELATION'}):
        if not entity_relations.is_relationship(row) or row['payload'].get('status') == 'withdrawn': continue
        ends = entity_relations.endpoints(row)
        if len(ends) != 2 or not all(oid in by_id for oid in ends): continue
        edges[row['object_id']] = {'id': row['object_id'], 'endpoints': ends,
            'summary': row['payload'].get('summary') or row['payload'].get('label') or row['payload']['title'],
            'direction': row['payload'].get('direction', 'related'), 'derived': False}
    return {'contract': CONTRACT, 'edges': list(edges.values())}
