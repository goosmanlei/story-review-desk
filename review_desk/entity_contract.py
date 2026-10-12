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


def direct_materials(store, row, *, metadata=False):
    """All directly owned needs, including cameras omitted from products."""
    from . import list_reading as light
    found = {item['object_id']:item for item in light.rows(
        store, 'REQUIREMENT', "json_extract(r.payload,'$.scope.object_id')=? AND json_extract(r.payload,'$.scope.revision_id')=? "
        "AND COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn'", (row['object_id'], row['id']))}
    return list(found.values()) if metadata else [p.record(store, oid) for oid in found]


def source_labels(store, row):
    labels = []
    for source in row['payload'].get('sources', []):
        episode = p.ref_record(store, source)
        scene = next((s for s in episode['payload'].get('scenes', []) if s['id'] == source.get('scene_id')), {})
        labels.append({**source, 'title':scene.get('heading') or scene.get('title') or scene.get('location') or episode['payload']['title']})
    row['review_sources'] = labels
    return row


def material_summary(row):
    """Membership and small-card fields, never a usable generation definition."""
    fields = ('format', 'title', 'media_type', 'slot', 'scope', 'status', 'components',
              'placeholder', 'candidate_requirements', 'production', 'candidate_identity')
    return {**{k: v for k, v in row.items() if k not in ('payload', 'submission')},
            'payload': {k: row['payload'][k] for k in fields if k in row['payload']},
            'deferred_detail': True, 'edit_token': row['version'], 'current_content': row['kind'] == 'REQUIREMENT'}


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


def shot_workspace(store, object_id, revision_id=None, *, deferred=False, material_id=None,
                   candidate_revision=None, load_selected=True):
    from . import material_plans, material_review, audiovisual
    from .store import canonical, digest
    row = source_labels(store, p.record(store, object_id, revision_id))
    if row['kind'] != 'AV_SHOT': raise ValueError('shot entity required')
    from .production_current import enabled
    # Legacy clients retain the complete workspace. The scene reader carries
    # every direct need but expands only the actual selection, on demand.
    deferred = deferred and enabled(store)
    needs = direct_materials(store, row, metadata=deferred)
    if deferred:
        needs = [material_summary(n) for n in needs]
    groups = material_groups(row, needs)
    selected = material_id or (groups[0]['material_ids'][0] if groups else None)
    if material_id and not any(n['object_id'] == material_id for n in needs):
        raise ValueError('准确镜头素材不属于此镜头')
    versions = {}
    for need in needs:
        p.check_read(store)
        mid = need['object_id']
        if not deferred:
            versions[mid] = material_plans.snapshot(store, mid)
        else:
            from . import list_reading as light
            from .production_current import CONTRACT as model
            from .material_storage import canonical_id
            results = [{**material_summary(light.record(store, item['asset_object_id'])),
                        'candidate_id': item['id'], 'candidate_number': item['number']} for item in store.db.execute('''
                SELECT c.asset_object_id,c.id,t.number FROM production_candidate_targets t
                JOIN production_candidates c ON c.id=t.candidate_id
                WHERE t.material_id=? ORDER BY t.number''', (canonical_id(store, mid),))]
            if candidate_revision and mid == selected:
                results = [p.record(store, r['object_id'], r['id']) if r['id'] == candidate_revision else r for r in results]
            plan = p.record(store, mid) if load_selected and mid == selected else need
            versions[mid] = [{'model': model, 'material_id': mid, 'canonical_material_id': canonical_id(store, mid),
                'number': 1, 'frozen': False, 'state': 'current', 'plan': plan, 'results': results,
                'members': [plan, *results], 'definition_records': {'requirement': plan, 'call': None},
                'feedback': [], 'current_content': True}]
    contexts, targets = {}, {r['id']: r for r in [row, *needs]}
    from .shot_references import enrich_detail
    for index, need in enumerate(needs):
        if deferred and (not load_selected or need['object_id'] != selected):
            continue
        need = versions[need['object_id']][0]['plan'] if deferred else need
        needs[index] = need
        need['review_input_records'] = [p.ref_record(store, item['reference']) for item in need['payload'].get('generation', {}).get('inputs', [])]
        enrich_detail(store, {'record':need,'material_cards':{need['object_id']:versions[need['object_id']]}})
    if candidate_revision and not any(r['id'] == candidate_revision for v in versions.get(selected, []) for r in v['results']):
        raise ValueError('准确镜头候选不属于此素材')
    for mid, rounds in versions.items():
        for plan in rounds:
            for member in plan['members']:
                targets[member['id']] = member
                if member['kind'] == 'ASSET' and (not deferred or mid == selected and member['id'] == candidate_revision):
                    context = material_review.context(store, member)
                    contexts[member['id']] = context
                    if context.get('call'): targets[context['call']['id']] = context['call']
    if candidate_revision and candidate_revision not in contexts:
        raise ValueError('准确镜头候选不属于此素材')
    scope = {'entity': {'object_id': object_id, 'revision_id': row['id']}, 'states': [],
             'requirements': [{'object_id': n['object_id'], 'revision_id': n['id']} for n in needs],
             'relationships': [], 'dependencies': []}
    return {'format': 'entity-workspace-v2', 'entity': row, 'states': [], 'retained_states': [],
            'requirements': needs, 'relationships': [], 'related_entities': [], 'media': [],
            'material_groups': groups,
            'position': [{'object_id': r['object_id'], 'id': r['id'], 'kind': r['kind'],
                          'title': r['payload']['title']} for r in audiovisual.path(store, row)],
            'scope': scope, 'content_key': digest(canonical(scope).encode()), 'historical': False,
            'usages': {}, 'versions': {}, 'material_cards': versions,
            'deferred_materials': [n['object_id'] for n in needs if deferred and (not load_selected or n['object_id'] != selected)],
            'deferred_candidates': [r['id'] for v in versions.values() for plan in v for r in plan['results'] if deferred and r['id'] not in contexts],
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
