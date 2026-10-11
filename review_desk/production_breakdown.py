"""Scoped production navigation; exact hierarchy and explicit applicability."""
import json
from . import production as p
from .store import Conflict

POSITIONS = {'AV_EPISODE', 'AV_SCENE', 'AV_SHOT', 'INPUT_LOCK', 'STORY', 'EPISODE'}


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def validate_relation(store, value):
    scope = p.ref_record(store, value.get('scope'), POSITIONS | ({'STATE'} if value['relation_type']=='applicability' else set()))
    subject = p.ref_record(store, value.get('subject'), {'ENTITY', 'STATE', 'REQUIREMENT', 'ASSET'})
    p._text(value.get('reason'), 'relationship reason')
    if value.get('basis') not in ('source_fact', 'production_choice'):
        raise ValueError('relationship needs source_fact or production_choice')
    if value['relation_type'] == 'occurrence':
        if subject['kind'] not in ('ENTITY', 'STATE') or value.get('mode') not in ('visual', 'voice', 'visual_voice', 'mention'):
            raise ValueError('occurrence needs entity/state and presentation mode')
        if not value.get('sources'):
            raise ValueError('occurrence requires exact source evidence')
    if value.get('component_id'):
        if subject['kind'] != 'ASSET':
            raise ValueError('file applicability needs a candidate')
        _, component = p.component_for(store, value['subject'], value['component_id'])
        p.validate_selection(component, value)
    elif value.get('range') or value.get('crop'):
        raise ValueError('a media selection needs an exact component')


def rows(store, kind, condition='', params=()):
    sql = 'SELECT r.*,o.kind,o.current_revision FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind=?'
    from .business_relations import archived_ids
    archived = archived_ids(store)
    return [p.record_view(r) for r in store.db.execute(sql+(' AND '+condition if condition else '')+' ORDER BY o.id', (kind, *params)) if r['object_id'] not in archived]


def index(store, view, object_id=None, scope=None, scope_episode=None, scope_revision=None, scope_scene=None, scope_shot=None):
    kinds={'settings':('ENTITY','AV_SHOT','STATE')}.get(view)
    if not kinds:raise ValueError('unknown production index')
    values=[r for kind in kinds for r in rows(store,kind)]
    if object_id and not any(r['object_id']==object_id for r in values):
        selected=p.record(store,object_id)
        allowed={'ASSET','REQUIREMENT','CALL'}
        if selected['kind'] in allowed or (view=='settings' and selected['kind']=='RELATION' and selected['payload'].get('relation_type') in ('entity','business')):
            values.append(selected)
    result={'records':values,'material_assets':{}}
    if view=='settings':
        from .ui_projection import entity_summaries, material_entries
        entries=material_entries(store)
        from .entity_contract import is_entity, graph
        entities = [r for r in values if is_entity(r)]
        if scope == 'shot':
            from .production_scope import entity_focus, projection
            catalog, focus = entity_focus(store, scope_episode, scope_revision, scope_scene, scope_shot)
            projected = projection(store, entries, focus=focus)
            ids = set(projected['entity_locations'])
            entities = [row for row in entities if row['object_id'] in ids and row['payload'].get('status') != 'withdrawn']
            result['records'] = entities
            result.update(management_episodes=catalog, entity_scope=focus,
                          entity_locations=projected['entity_locations'])
        result.update(entity_summaries(store, entities, entries))
        if scope == 'shot':
            result.update(management_episodes=catalog, entity_locations=projected['entity_locations'])
        result['entity_graph'] = graph(store, entities)
        if scope == 'av':
            from .production_scope import projection
            projected=projection(store,entries,scope_episode,scope_revision,scope_scene)
            result.update({key:projected[key] for key in ('management_episodes','entity_locations')})
    return result


def ancestors(store, row):
    """Exact revision chain, never a current-head substitution."""
    result = [ref(row)]
    if row['kind'] in {'AV_EPISODE', 'AV_SCENE', 'AV_SHOT'}:
        from .audiovisual import path
        chain = path(store, row)
        result = [ref(r) for r in reversed(chain)]
        result.extend(ancestors(store, p.ref_record(store, row['payload']['input_lock'])))
        return list({r['revision_id']: r for r in result}.values())
    if row['kind'] == 'EPISODE':
        # Legacy episodes have no exact input-lock parent. Recover an unambiguous
        # screenplay from immutable historical evidence, not today's lock head.
        parents={}
        for item in store.db.execute("SELECT r.*,o.kind,o.current_revision FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='INPUT_LOCK'"):
            locked=p.record_view(item)
            if ref(row) in locked['payload']['episodes']:
                parent=locked['payload']['screenplay'];parents[parent['revision_id']]=parent
        if len(parents)==1:result.extend(parents.values())
    elif row['kind'] == 'INPUT_LOCK':
        result.append(row['payload']['screenplay'])
    return result


def scene_shots(store, scene, exact=None):
    """Latest shot revision bound to this immutable parent, with exact override."""
    if scene['kind'] == 'AV_SCENE':
        from .audiovisual import children
        values = children(store, scene)
        if exact and exact['id'] not in {r['id'] for r in values}:
            raise ValueError('镜头不属于本版视听场')
        return values
    raise ValueError('视听场必须是 AV_SCENE')


def catalog(store, episode=None, object_id=None, revision_id=None, view=None, episode_revision=None):
    from .audiovisual import catalog as audiovisual_catalog
    return audiovisual_catalog(store, episode, object_id, revision_id, view, episode_revision)


def context(store, object_id, revision_id=None, *, metadata=False):
    from . import list_reading as light
    read_ref = light.ref_record if metadata else p.ref_record
    selected = p.record(store, object_id, revision_id)
    scope_revision = selected['id']
    direct = exact_scoped(store, 'REQUIREMENT', scope_revision, metadata=metadata)
    if selected['payload'].get('reading_contract') == 'audiovisual-three-part-v1':
        direct = [read_ref(store, item['requirement']) for item in selected['payload'].get('products', [])]
    links = [r for r in exact_scoped(store, 'RELATION', scope_revision) if r['payload']['relation_type'] in ('applicability','occurrence')]
    from .business_relations import archived_ids, scope_links
    unified = scope_links(store, ref(selected)) if selected['id'] == selected['current_revision'] else []
    if selected['id'] == selected['current_revision']:
        archived = archived_ids(store)
        links = [r for r in links if r['object_id'] not in archived]
    entities = list(selected['payload'].get('entities', []))
    states = list(selected['payload'].get('states', []))
    occurrences = list(selected['payload'].get('occurrences', []))
    needs = {r['object_id']: r for r in direct if r['payload'].get('status') != 'withdrawn'}
    for link, subject in unified:
        if subject['kind'] == 'REQUIREMENT':
            needs.setdefault(subject['object_id'], subject)
    for link in links:
        subject = read_ref(store, link['payload']['subject'])
        if subject['kind'] == 'REQUIREMENT':
            needs.setdefault(subject['object_id'], subject)
        if link['payload']['relation_type']=='occurrence':
            entity=subject if subject['kind']=='ENTITY' else p.ref_record(store,subject['payload']['entity'])
            entities.append(ref(entity))
            forms=[ref(subject)] if subject['kind']=='STATE' else []
            states.extend(forms)
            occurrences.append({'entity':ref(entity),'states':forms,'mode':link['payload']['mode'],
                'evidence':link['payload']['sources'],'basis':link['payload']['basis'],'relation':ref(link)})
    for occurrence in occurrences:
        entities.append(occurrence['entity'])
        states.extend(occurrence.get('states',[]))
    entities=list({r['revision_id']:r for r in entities}.values())
    states=list({r['revision_id']:r for r in states}.values())
    return {'record': selected, 'ancestors': ancestors(store, selected),
            'entities': [p.ref_record(store, r) for r in entities], 'states': [p.ref_record(store, r) for r in states],
            'continuity_states': [p.ref_record(store, r) for r in selected['payload'].get('continuity_context', [])],
            'occurrences': occurrences, 'relations': links, 'business_relations': [r for r, _ in unified], 'requirements': list(needs.values()),
            'adoptions': [r for r in exact_scoped(store, 'RELATION', scope_revision) if r['payload']['relation_type']=='adoption']}


def material_comment_targets(store, revision):
    """Exact comment identities, without reading definitions merely to count them."""
    from . import list_reading as light
    needs={r['object_id']:r for r in exact_scoped(store,'REQUIREMENT',revision,metadata=True)
           if r['payload'].get('status')!='withdrawn'}
    shot = light.record(store, revision_id=revision)
    for item in shot['payload'].get('products', []):
        need = light.ref_record(store, item['requirement'])
        needs[need['object_id']] = need
    for link in exact_scoped(store,'RELATION',revision,metadata=True):
        if link['payload']['relation_type'] in ('applicability','occurrence'):
            subject=light.ref_record(store,link['payload']['subject'])
            if subject['kind']=='REQUIREMENT':needs.setdefault(subject['object_id'],subject)
    targets=[]
    for need in needs.values():
        for version in store.db.execute('''SELECT v.number,d.provenance FROM material_plan_versions v
            LEFT JOIN material_definition_versions d ON d.material_id=v.material_id AND d.number=v.number
            WHERE v.material_id=? ORDER BY v.number DESC''',(need['object_id'],)):
            targets.extend(dict(r) for r in store.db.execute('''SELECT r.id,r.object_id FROM material_plan_members m
                JOIN revisions r ON r.id=m.revision_id WHERE m.material_id=? AND m.number=? ORDER BY r.id''',
                (need['object_id'],version['number'])))
            provenance=json.loads(version['provenance']) if version['provenance'] else {}
            for field in ('requirements','generation'):
                source=provenance.get(field)
                if source:
                    row=light.ref_record(store,source['record'])
                    if field=='requirements' or row['kind']=='CALL':targets.append(row)
    return targets


def material_comment_targets_many(store, positions):
    """Current plan/candidate comment identities in one bounded directory pass.

    No Prompt, submitted snapshot or media bytes are needed to count comments.
    Legacy edition reads keep their original exact version membership contract.
    """
    from .production_current import enabled
    if not enabled(store):
        return {row['id']: material_comment_targets(store, row['id']) for row in positions}
    scopes = {row['id']: row for row in positions}
    needs = {rid: {} for rid in scopes}
    raw_scopes = json.dumps(list(scopes))
    for row in store.db.execute('''SELECT r.id,r.object_id,r.payload FROM revisions r
        JOIN objects o ON o.id=r.object_id
        WHERE o.kind='REQUIREMENT'
        AND json_extract(r.payload,'$.scope.revision_id') IN (SELECT value FROM json_each(?))
        AND COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn'
        AND NOT EXISTS(SELECT 1 FROM revisions newer WHERE newer.object_id=r.object_id
            AND newer.version>r.version AND json_extract(newer.payload,'$.scope.revision_id')=json_extract(r.payload,'$.scope.revision_id'))''', (raw_scopes,)):
        scope = json.loads(row['payload'])['scope']['revision_id']
        needs[scope][row['object_id']] = {'object_id': row['object_id'], 'id': row['id']}
    for row in positions:
        for item in row['payload'].get('products', []):
            reference = item['requirement']
            needs[row['id']][reference['object_id']] = {'object_id': reference['object_id'], 'id': reference['revision_id']}
    # A reviewed shared camera can be directly owned by several shots through
    # one business relation per scope, while keeping its original stable need.
    from . import list_reading as light
    positions_by_id = {row['object_id']: row for row in positions}
    ids = json.dumps(list(positions_by_id))
    for raw in store.db.execute('''SELECT r.payload FROM business_relations b
        JOIN objects o ON o.id=b.object_id JOIN revisions r ON r.id=o.current_revision
        WHERE (b.endpoint_a IN (SELECT value FROM json_each(?))
            OR b.endpoint_b IN (SELECT value FROM json_each(?)))
        AND COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn' ''', (ids, ids)):
        value = json.loads(raw[0])
        for endpoint in value['endpoints']:
            position = positions_by_id.get(endpoint)
            if position is None or ref(position) not in value.get('contexts', []):
                continue
            other = next(e for e in value['endpoints'] if e != endpoint)
            subject = light.record(store, other)
            if subject['kind']=='REQUIREMENT' and subject['payload'].get('status')!='withdrawn':
                needs[position['id']][other] = {'object_id':other,'id':subject['id']}
    # These are only direct applicability/occurrence needs. Shared upstream
    # inputs are intentionally outside the episode-comment counting boundary.
    from . import list_reading as light
    for row in store.db.execute('''SELECT r.payload FROM revisions r JOIN objects o ON o.id=r.object_id
        WHERE o.kind='RELATION' AND json_extract(r.payload,'$.relation_type') IN ('applicability','occurrence')
        AND json_extract(r.payload,'$.scope.revision_id') IN (SELECT value FROM json_each(?))
        AND NOT EXISTS(SELECT 1 FROM revisions newer WHERE newer.object_id=r.object_id AND newer.version>r.version
            AND json_extract(newer.payload,'$.scope.revision_id')=json_extract(r.payload,'$.scope.revision_id'))''', (raw_scopes,)):
        value = json.loads(row[0]); subject = light.ref_record(store, value['subject'])
        if subject['kind'] == 'REQUIREMENT':
            needs[value['scope']['revision_id']].setdefault(subject['object_id'], {'object_id': subject['object_id'], 'id': subject['id']})
    aliases = dict(store.db.execute("SELECT alias_id,COALESCE(json_extract(evidence,'$.canonical_material_id'),material_id) FROM material_aliases"))
    mids = {aliases.get(mid, mid) for values in needs.values() for mid in values}
    candidates = {}
    for row in store.db.execute('''SELECT t.material_id,a.id,a.object_id,c.operation_id,call.current_revision AS call_revision
        FROM production_candidate_targets t JOIN production_candidates c ON c.id=t.candidate_id
        JOIN objects o ON o.id=c.asset_object_id JOIN revisions a ON a.id=o.current_revision
        LEFT JOIN objects call ON call.id=c.operation_id
        WHERE t.material_id IN (SELECT value FROM json_each(?)) ORDER BY t.number''', (json.dumps(list(mids)),)):
        targets = candidates.setdefault(row['material_id'], [])
        targets.append({'object_id': row['object_id'], 'id': row['id']})
        # External candidates have no invented model call.
        if row['call_revision']:
            targets.append({'object_id': row['operation_id'], 'id': row['call_revision']})
    return {rid: list({r['id']: r for mid, need in values.items()
                      for r in [need, *candidates.get(aliases.get(mid, mid), [])]}.values())
            for rid, values in needs.items()}


def comment_index(store):
    """Fresh counting identities only, including deletes and closed comments."""
    return [dict(r) for r in store.db.execute('''SELECT id,target_object_id,target_revision_id,status,version
        FROM comments ORDER BY id''')]


def exact_scoped(store, kind, revision, metadata=False):
    # Historical reading uses the latest revision *bound to that exact scope*,
    # even when a current object moved elsewhere. Current heads never rebind it.
    from . import list_reading as light
    columns='r.id,r.object_id,r.version,r.payload AS stored_payload,r.created_at' if metadata else 'r.*'
    reader=light.project if metadata else lambda _store,row:p.record_view(row)
    return [reader(store,r) for r in store.db.execute(f"""SELECT {columns},o.kind,o.current_revision
        FROM revisions r JOIN objects o ON o.id=r.object_id
        WHERE o.kind=? AND json_extract(r.payload,'$.scope.revision_id')=?
        AND NOT EXISTS(SELECT 1 FROM revisions newer WHERE newer.object_id=r.object_id
            AND newer.version>r.version AND json_extract(newer.payload,'$.scope.revision_id')=?)
        ORDER BY r.object_id""", (kind,revision,revision))]


def location(store, scope, cache):
    rid=scope['revision_id']
    if rid in cache:return cache[rid]
    from .list_reading import ref_record
    value=ref_record(store,scope);payload=value['payload']
    episode=payload.get('episode') or payload.get('source') or next(iter(payload.get('sources', [])), None)
    result={'scope':scope,'episode':episode.get('object_id') if episode else (value['object_id'] if value['kind']=='EPISODE' else None),
        'scene':payload.get('scene_id') or (episode or {}).get('scene_id'),'kind':value['kind'],
        'audiovisual': value['object_id'] if value['kind'].startswith('AV_') else None}
    cache[rid]=result
    return result


def locations(store, scope, cache):
    base = location(store, scope, cache)
    if not base['kind'].startswith('AV_'):
        return [base]
    from .list_reading import ref_record
    row = ref_record(store, scope)
    return [{**base, 'episode': s['object_id'], 'scene': s['scene_id'], 'source': s}
            for s in row['payload']['sources']]


def materials(store, episode=None, scene=None, media=None, search='', status=None, offset=0, limit=40):
    if media and media not in ('image','audio','video','project','document'):raise ValueError('unknown media filter')
    if status and status not in ('generated','ungenerated'):raise ValueError('unknown status filter')
    values=rows(store,'REQUIREMENT',"COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn'")
    associated={r[0] for r in store.db.execute("SELECT DISTINCT r.object_id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE m.role='result' AND m.material_id!=r.object_id")}
    generated_ids={r[0] for r in store.db.execute("SELECT DISTINCT material_id FROM material_plan_members WHERE role='result'")}
    values.extend(a for a in rows(store,'ASSET') if a['object_id'] not in associated and not a['payload'].get('candidate_requirements'))
    links={};cache={}
    for link in rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='applicability'"):
        links.setdefault(link['payload']['subject']['revision_id'],[]).append(link['payload']['scope'])
    from .business_relations import material_bindings
    for _, subject, scope in material_bindings(store):
        links.setdefault(subject['revision_id'], []).append(scope)
    result=[]
    for row in values:
        value=row['payload']
        if media and value.get('media_type')!=media or search and search.lower() not in (value.get('title','')+' '+value.get('purpose','')).lower():continue
        generated=row['kind']=='ASSET' or row['object_id'] in generated_ids
        if status and generated!=(status=='generated'):continue
        scopes=([value['scope']] if value.get('scope') else [])+links.get(row['id'],[])
        locs=[location(store,s,cache) for s in scopes]
        if (episode or scene) and not any((not episode or l['episode']==episode) and (not scene or l['scene']==scene) for l in locs):continue
        result.append({'object_id':row['object_id'],'id':row['id'],'kind':row['kind'],'title':value['title'],
            'media_type':value['media_type'],'generated':generated,'locations':locs})
    return {'items':result[offset:offset+limit],'total':len(result),'offset':offset,'limit':limit}


def summary(store, object_id, revision_id=None):
    selected=p.record(store,object_id,revision_id);target=ref(selected)
    descendants=[r for kind in ('AV_SHOT','AV_SCENE','AV_EPISODE') for r in rows(store,kind)
        if target in ancestors(store,r)[1:]]
    direct=context(store,object_id,revision_id)
    return {'record':selected,'direct_entities':direct['entities'],'direct_requirements':direct['requirements'],
        'descendant_positions':[ref(r) for r in descendants],
        'derived_entities':list({e['id']:ref(e) for r in descendants for e in context(store,r['object_id'],r['id'])['entities']}.values()),
        'actual_uses':[r for r in rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='adoption'")
            if r['payload']['scope'] in [target,*[ref(d) for d in descendants]]],
        'note':'子级出现向上汇总；不表示每个下级都出现或已实际提交生成。实际采用保留准确位置修订。'}
