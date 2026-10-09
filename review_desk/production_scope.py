"""Read-only ranges over immutable AV compositions and concrete uses.

Source text is evidence, never an inverse mapping to a production scene.
"""
from collections import defaultdict
from . import list_reading as light, production_breakdown as b
from .material_storage import canonical_id


def graph(store, episode=None, revision=None, scene=None):
    editions = sorted(light.rows(store, 'AV_EPISODE'), key=lambda r: (r['payload']['number'], r['object_id']))
    if scene and not episode:raise ValueError('视听场需要准确所属视听集，请重新选择制作范围')
    if revision and not episode: raise ValueError('准确视听版本需要指定视听集')
    if episode:
        try:selected = light.record(store, episode, revision)
        except (KeyError,ValueError) as error:raise ValueError('链接指定的视听集或准确版本不存在，请重新选择制作范围') from error
        if selected.get('unavailable') or selected['kind'] != 'AV_EPISODE':
            raise ValueError('视听集或准确版本不可用，请重新选择制作范围')
        editions = [selected if row['object_id'] == episode else row for row in editions]
        if not any(row['object_id'] == episode for row in editions): editions.append(selected)
    catalog, positions = [], []
    for edition in editions:
        scenes = [light.ref_record(store, ref) for ref in edition['payload']['scenes']]
        if any(row.get('unavailable') or row['kind'] != 'AV_SCENE' for row in scenes):
            raise ValueError('本版视听集的准确子场不可用')
        catalog.append({'object_id': edition['object_id'], 'id': edition['id'], 'kind': 'AV_EPISODE',
                        'number': edition['payload']['number'], 'title': edition['payload']['title'],
                        'version': edition['version'], 'scenes': [
                            {'id': row['object_id'], 'revision_id': row['id'], 'kind': 'AV_SCENE', 'title': row['payload']['title']}
                            for row in scenes]})
        base = {'episode': edition['object_id'], 'episode_revision': edition['id']}
        positions.append((edition, {**base, 'scene': None}))
        for sc in scenes:
            loc = {**base, 'scene': sc['object_id'], 'scene_revision': sc['id']}
            positions.append((sc, loc))
            for ref in sc['payload']['shots']:
                shot = light.ref_record(store, ref)
                if shot.get('unavailable') or shot['kind'] != 'AV_SHOT': raise ValueError('本版视听场的准确子镜不可用')
                positions.append((shot, loc))
    if scene and not any(loc.get('scene') == scene and (not episode or loc['episode'] == episode) for _, loc in positions):
        raise ValueError('视听场不属于本版视听集，请重新选择制作范围')
    return catalog, positions


def projection(store, entries, episode=None, revision=None, scene=None):
    catalog, positions = graph(store, episode, revision, scene)
    materials, entities = defaultdict(list), defaultdict(list)
    candidate_owners = defaultdict(set)
    for row in store.db.execute("SELECT DISTINCT m.material_id,r.object_id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.role='result'"):
        candidate_owners[row['object_id']].add(canonical_id(store, row['material_id']))
    identities = {item['canonical_material_id'] for item in entries}
    additional = {}
    scoped = defaultdict(list)
    for kind in ('REQUIREMENT', 'RELATION'):
        for raw in store.db.execute('''SELECT r.id,r.object_id,r.version,r.payload AS stored_payload,r.created_at,o.kind,o.current_revision
            FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind=?
            AND json_extract(r.payload,'$.scope.revision_id') IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM revisions newer WHERE newer.object_id=r.object_id AND newer.version>r.version
                AND json_extract(newer.payload,'$.scope.revision_id')=json_extract(r.payload,'$.scope.revision_id'))''', (kind,)):
            row = light.project(store, raw); scoped[row['payload']['scope']['revision_id']].append(row)

    def owner(reference, loc, evidence):
        row = light.ref_record(store, reference)
        if row.get('unavailable'): return
        if row['kind'] == 'ENTITY': entities[row['object_id']].append({**loc, 'reference':{**b.ref(row),'version':row['version'],'title':row['payload']['title']}, 'evidence': evidence})
        elif row['kind'] == 'STATE': owner(row['payload']['entity'], loc, evidence)

    def add(row, loc, evidence):
        if row.get('unavailable') or row['kind'] not in ('REQUIREMENT', 'ASSET'): return
        mid = canonical_id(store, row['object_id'])
        if row['kind']=='REQUIREMENT' and mid not in identities:
            value=row['payload'];additional[mid]={'canonical_material_id':mid,'object_id':row['object_id'],'id':row['id'],'kind':row['kind'],'title':value['title'],'media_type':value['media_type'],'generated':False,'preview':None,'search_fields':[value['title']],'scope':value.get('scope'),'entity_ids':[]}
            identities.add(mid)
        mids = {mid} if mid in identities else candidate_owners[row['object_id']]
        for identity in mids:
            materials[identity].append({**loc, 'kind': 'AV_SCENE' if loc['scene'] else 'AV_EPISODE',
                                       'scope': evidence['position'], 'title': evidence['title'],
                                       'relation': evidence['kind'], 'evidence': evidence})

    contextual = defaultdict(list)
    for row in light.rows(store, 'MATERIAL_RELATION'):
        contextual[row['payload']['context']['revision_id']].append(row)

    for position, loc in positions:
        evidence = {'position': b.ref(position), 'title': position['payload']['title'], 'kind': 'production_use'}
        seen = set()
        def visit(row, reason, descend=True):
            if row.get('unavailable'): return
            add(row, loc, {**evidence, **reason, 'record': b.ref(row)})
            if not descend or row['id'] in seen: return
            seen.add(row['id'])
            for reference in [*row['payload'].get('entities', []),*row['payload'].get('states', []),*row['payload'].get('subjects', [])]: owner(reference, loc, evidence)
            if row['payload'].get('scope'):owner(row['payload']['scope'],loc,evidence)
            if row['kind'] != 'REQUIREMENT': return
            plan = row['payload'].get('generation', {})
            from .material_relations import active_inputs
            active = {index for index, _ in active_inputs(store, plan, row['object_id'])[0]}
            for index, value in enumerate(plan.get('inputs', [])):
                target = light.ref_record(store, value['reference'])
                visit(target, {'kind': 'planned_input' if index in active else 'alternative',
                               'consumer': b.ref(row), 'input': value}, index in active)
            for raw in store.db.execute("SELECT DISTINCT r.id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.role='call'", (row['object_id'],)):
                call = light.record(store, revision_id=raw[0]); need = call['payload'].get('generation_requirement')
                if need and light.ref_record(store, need)['payload'].get('scope') != row['payload'].get('scope'): continue
                for value in call['payload'].get('inputs', []):
                    visit(light.ref_record(store, value.get('reference', value)),
                          {'kind': 'actual_input', 'call': b.ref(call), 'input': value}, False)
        def at_scope(reference):
            for edge in contextual[reference['revision_id']]:
                visit(light.ref_record(store, edge['payload']['upstream']),
                      {'kind': 'alternative' if edge['payload']['semantics']=='alternative' else 'material_relation', 'relation_record': b.ref(edge)}, False)
            for row in scoped[reference['revision_id']]:
                value = row['payload']
                if row['kind'] == 'REQUIREMENT' and value.get('status') != 'withdrawn': visit(row, {'kind': 'mounted'})
                elif row['kind'] == 'RELATION':
                    kind = value.get('relation_type'); ref = value.get('asset') if kind == 'adoption' else value.get('subject')
                    if ref and kind in ('occurrence', 'applicability', 'adoption'):
                        owner(ref, loc, {**evidence, 'kind': kind, 'record': b.ref(row)})
                        visit(light.ref_record(store, ref), {'kind': kind, 'relation_record': b.ref(row)})
        at_scope(b.ref(position))
        refs = [*position['payload'].get('entities', []), *position['payload'].get('states', []), *position['payload'].get('continuity_context', [])]
        for occurrence in position['payload'].get('occurrences', []): refs += [occurrence['entity'], *occurrence.get('states', [])]
        for transition in position['payload'].get('state_transitions', []): refs += [transition['from'], transition['to']]
        for reference in refs:
            owner(reference, loc, evidence)
            row = light.ref_record(store, reference)
            if row['kind'] == 'STATE': at_scope(reference)
    if additional:
        from .material_plans import card_counts
        from .navigation_search import codes, material_fields
        metrics=card_counts(store,additional);mapping=codes(store)
        for mid,item in additional.items():
            item.update(metrics[mid]);item['search_fields']=material_fields(store,item,mapping)
            for raw in store.db.execute("SELECT DISTINCT r.id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.role='result'",(mid,)):
                asset=light.record(store,revision_id=raw[0])['payload']
                if not asset.get('placeholder') and any(c['role']=='original' for c in asset.get('components',[])):item['generated']=True
    projected = [{**item, 'locations': materials[item['canonical_material_id']]} for item in [*entries,*additional.values()]]
    return {'management_episodes': catalog, 'entity_locations': dict(entities), 'entries': projected}
