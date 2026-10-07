"""Scoped production navigation; exact hierarchy and explicit applicability."""
import json
from . import production as p
from .store import Conflict

POSITIONS = {'INPUT_LOCK', 'STORY', 'EPISODE', 'PREPARATION', 'SHOT_DESIGN'}


def ref(row):
    return {'object_id': row['object_id'], 'revision_id': row['id']}


def validate_relation(store, value):
    scope = p.ref_record(store, value.get('scope'), POSITIONS | ({'STATE'} if value['relation_type']=='applicability' else set()))
    subject = p.ref_record(store, value.get('subject'), {'ENTITY', 'STATE', 'REQUIREMENT', 'ASSET', 'REPRESENTATION'})
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


def validate_parent(store, value):
    if 'parent' not in value:
        return
    parent = p.ref_record(store, value['parent'], {'PREPARATION'})
    if any(parent['payload']['source'][k] != value['episode'][k] for k in ('object_id','revision_id')) or parent['payload']['source']['scene_id'] != value['scene_id']:
        raise ValueError('shot direct parent differs from episode/scene')


def rows(store, kind, condition='', params=()):
    sql = 'SELECT r.*,o.kind,o.current_revision FROM objects o JOIN revisions r ON r.id=o.current_revision WHERE o.kind=?'
    return [p.record_view(r) for r in store.db.execute(sql+(' AND '+condition if condition else '')+' ORDER BY o.id', (kind, *params))]


def index(store, view, object_id=None):
    kinds={'settings':('ENTITY','STATE','REPRESENTATION'), 'history':('INPUT_LOCK','PREPARATION','ASSEMBLY','DELIVERABLE')}.get(view)
    if not kinds:raise ValueError('unknown production index')
    values=[r for kind in kinds for r in rows(store,kind)]
    if object_id and not any(r['object_id']==object_id for r in values):
        selected=p.record(store,object_id)
        allowed={'ASSET','REQUIREMENT','CALL','JUDGMENT'} if view=='settings' else {'SHOT_DESIGN','REQUIREMENT','ASSET','CALL','JUDGMENT'}
        if selected['kind'] in allowed or (view=='settings' and selected['kind']=='RELATION' and selected['payload'].get('relation_type')=='entity'):
            values.append(selected)
    result={'records':values,'material_assets':{}}
    if view=='settings':
        from .ui_projection import entity_summaries, material_entries
        result.update(entity_summaries(store,[r for r in values if r['kind']=='ENTITY'],material_entries(store)))
    return result


def ancestors(store, row):
    """Exact revision chain, never a current-head substitution."""
    result = [ref(row)]
    if row['kind'] == 'SHOT_DESIGN':
        payload = row['payload']
        if payload.get('parent'):
            parent = p.ref_record(store, payload['parent'], {'PREPARATION'})
            result.extend(ancestors(store, parent))
        else:
            # Legacy shots have an exact episode + scene locator, but no scene
            # preparation revision. Do not invent one from the current tree.
            result.extend(ancestors(store,p.ref_record(store,payload['episode'],{'EPISODE'})))
    elif row['kind'] == 'PREPARATION':
        source = row['payload']['source']
        episode=p.ref_record(store,{'object_id': source['object_id'], 'revision_id': source['revision_id']},{'EPISODE'})
        if row['payload'].get('input_lock'):
            result.append(ref(episode))
            result.extend(ancestors(store,p.ref_record(store,row['payload']['input_lock'],{'INPUT_LOCK'})))
        else:
            result.extend(ancestors(store,episode))
    elif row['kind'] == 'EPISODE':
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
    shots=[p.record_view(r) for r in store.db.execute("""SELECT r.*,o.kind,o.current_revision
        FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='SHOT_DESIGN'
        AND json_extract(r.payload,'$.parent.revision_id')=? AND NOT EXISTS(
            SELECT 1 FROM revisions n WHERE n.object_id=r.object_id AND n.version>r.version
            AND json_extract(n.payload,'$.parent.revision_id')=?)""",(scene['id'],scene['id']))]
    if exact:
        if exact['kind']!='SHOT_DESIGN' or exact['payload'].get('parent')!=ref(scene):
            raise ValueError('exact shot does not belong to the selected scene')
        shots=[r for r in shots if r['object_id']!=exact['object_id']]+[exact]
    return sorted(shots,key=lambda r:(r['payload']['number'],r['object_id']))


def catalog(store, episode=None, object_id=None, revision_id=None, view=None):
    locks = rows(store, 'INPUT_LOCK')
    target=p.record(store,object_id,revision_id) if object_id else None
    exact_scene=None;exact_shot=None
    if target:
        if target['kind']=='SHOT_DESIGN':
            exact_shot=target
            if not target['payload'].get('parent'):
                raise ValueError('historical shot has no exact scene parent; refusing current substitution')
            exact_scene=p.ref_record(store,target['payload']['parent'],{'PREPARATION'})
        elif target['kind']=='PREPARATION':exact_scene=target
        else:raise ValueError('breakdown target must be a scene or shot')
    lock=locks[-1] if locks else None
    if exact_scene and exact_scene['payload'].get('input_lock'):
        lock=p.ref_record(store,exact_scene['payload']['input_lock'],{'INPUT_LOCK'})
    if not lock:return {'episodes': [], 'scenes': [], 'shots': [], 'lock': None}
    episodes = [p.ref_record(store, r, {'EPISODE'}) for r in lock['payload']['episodes']]
    if exact_scene:
        source=exact_scene['payload']['source'];episode=source['object_id']
        exact_episode=p.ref_record(store,source,{'EPISODE'})
        episodes=[exact_episode if e['object_id']==episode else e for e in episodes]
        if not any(e['object_id']==episode for e in episodes):episodes.append(exact_episode)
    chosen = next((e for e in episodes if e['object_id'] == episode), None) if episode else episodes[0]
    if chosen is None:raise KeyError('episode outside exact production input')
    entries=[];chosen_scenes=[];chosen_shots=[]
    for ep in episodes:
        scenes=[p.record_view(r) for r in store.db.execute("""SELECT r.*,o.kind,o.current_revision
            FROM revisions r JOIN objects o ON o.id=r.object_id WHERE o.kind='PREPARATION'
            AND json_extract(r.payload,'$.source.object_id')=? AND json_extract(r.payload,'$.source.revision_id')=?
            AND NOT EXISTS(SELECT 1 FROM revisions n WHERE n.object_id=r.object_id AND n.version>r.version
                AND json_extract(n.payload,'$.source.revision_id')=?)""",(ep['object_id'],ep['id'],ep['id']))]
        if exact_scene and ep['object_id']==episode:
            scenes=[r for r in scenes if r['object_id']!=exact_scene['object_id']]+[exact_scene]
        order={s['id']:i for i,s in enumerate(ep['payload']['scenes'])}
        scenes.sort(key=lambda r:(order.get(r['payload']['source']['scene_id'],len(order)),r['object_id']))
        shots=[shot for sc in scenes for shot in scene_shots(store,sc,
               exact_shot if exact_shot and exact_shot['payload']['parent']==ref(sc) else None)]
        targets=[*scenes,*shots]
        if view=='shots':
            for shot in shots:
                targets.extend(material_comment_targets(store,shot['id']))
        entries.append({'object_id':ep['object_id'],'id':ep['id'],'number':ep['payload']['number'],
            'title':ep['payload']['title'],'scenes':[{'id':s['id'],'title':s.get('heading',s['id'])} for s in ep['payload']['scenes']],
            'comment_targets':list({r['id']:ref(r) for r in targets}.values())})
        if ep['id']==chosen['id']:chosen_scenes=scenes;chosen_shots=shots
    return {'lock':lock,'episodes':entries,'episode':chosen['object_id'],
            'scenes':chosen_scenes,'shots':chosen_shots,'target':ref(target) if target else None}


def context(store, object_id, revision_id=None):
    selected = p.record(store, object_id, revision_id)
    scope_revision = selected['id']
    direct = exact_scoped(store, 'REQUIREMENT', scope_revision)
    links = [r for r in exact_scoped(store, 'RELATION', scope_revision) if r['payload']['relation_type'] in ('applicability','occurrence')]
    entities = list(selected['payload'].get('entities', []))
    states = list(selected['payload'].get('states', []))
    occurrences = list(selected['payload'].get('occurrences', []))
    if selected['kind'] == 'PREPARATION':
        entities = [o['entity'] for o in occurrences]
        states = [s for o in occurrences for s in o['states']]
    needs = {r['object_id']: r for r in direct if r['payload'].get('status') != 'withdrawn'}
    for link in links:
        subject = p.ref_record(store, link['payload']['subject'])
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
            'occurrences': occurrences, 'relations': links, 'requirements': list(needs.values()),
            'adoptions': [r for r in exact_scoped(store, 'RELATION', scope_revision) if r['payload']['relation_type']=='adoption']}


def material_comment_targets(store, revision):
    """Exact comment identities, without reading definitions merely to count them."""
    from . import list_reading as light
    needs={r['object_id']:r for r in exact_scoped(store,'REQUIREMENT',revision,metadata=True)
           if r['payload'].get('status')!='withdrawn'}
    for link in exact_scoped(store,'RELATION',revision,metadata=True):
        if link['payload']['relation_type'] in ('applicability','occurrence'):
            subject=light.ref_record(store,link['payload']['subject'])
            if subject['kind']=='REQUIREMENT':needs.setdefault(subject['object_id'],subject)
    targets=[]
    for need in needs.values():
        if need['payload']['media_type']!='video':continue
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
    episode=payload.get('episode') or payload.get('source')
    result={'scope':scope,'episode':episode.get('object_id') if episode else (value['object_id'] if value['kind']=='EPISODE' else None),
        'scene':payload.get('scene_id') or (payload.get('source') or {}).get('scene_id'),'kind':value['kind']}
    cache[rid]=result
    return result


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
    descendants=[r for kind in ('SHOT_DESIGN','PREPARATION','EPISODE') for r in rows(store,kind)
        if target in ancestors(store,r)[1:]]
    direct=context(store,object_id,revision_id)
    return {'record':selected,'direct_entities':direct['entities'],'direct_requirements':direct['requirements'],
        'descendant_positions':[ref(r) for r in descendants],
        'derived_entities':list({e['id']:ref(e) for r in descendants for e in context(store,r['object_id'],r['id'])['entities']}.values()),
        'actual_uses':[r for r in rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='adoption'")
            if r['payload']['scope'] in [target,*[ref(d) for d in descendants]]],
        'note':'子级出现向上汇总；不表示每个下级都出现或已实际提交生成。实际采用保留准确位置修订。'}
