"""Read-only card and list projections. No media creation or stored UI state."""
from . import production as p, generation as g
from . import production_breakdown as b
from . import list_reading as light


def material_entries(store):
    from .read_cache import read_json
    return read_json(store, 'material-entries-v1', lambda: _material_entries(store))


def _material_entries(store):
    needs=light.rows(store,'REQUIREMENT',"COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn'")
    assets=light.rows(store,'ASSET');results={};used=set()
    for raw in store.db.execute("SELECT m.material_id,r.*,o.kind,o.current_revision FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id JOIN objects o ON o.id=r.object_id WHERE m.role='result' ORDER BY r.created_at DESC,r.version DESC,r.id DESC"):
        row=p.record_view(raw);results.setdefault(raw['material_id'],[]).append(row)
        if raw['material_id']!=row['object_id']:used.add(row['object_id'])
    for asset in assets:
        for ref in asset['payload'].get('candidate_requirements',[]):
            if light.ref_record(store,ref).get('unavailable'):continue
            results.setdefault(ref['object_id'],[]).append(asset);used.add(asset['object_id'])
    links={};cache={};entries=[]
    for link in b.rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='applicability'"):
        links.setdefault(link['payload']['subject']['revision_id'],[]).append(link['payload']['scope'])
    for row in [*needs,*(a for a in assets if a['object_id'] not in used)]:
        value=row['payload'];scope=value.get('scope');owners={};locations=[]
        def add_scope(reference,relation):
            scoped=light.ref_record(store,reference)
            locations.extend({**loc,'relation':relation,'title':scoped['payload']['title']} for loc in b.locations(store,reference,cache))
            if scoped.get('unavailable'):
                if scoped.get('owner_object_id'):owners[scoped['owner_object_id']]=None
                return
            if scoped['kind']=='STATE':
                owners[scoped['payload']['entity']['object_id']]=scoped['payload']['entity']
                for source in scoped['payload'].get('sources',[]):
                    locations.append({'episode':source['object_id'],'scene':source.get('scene_id'),'kind':'STATE','scope':reference,'relation':'source'})
            elif scoped['kind']=='ENTITY':owners[scoped['object_id']]=b.ref(scoped)
        if scope:add_scope(scope,'mounted')
        for reference in links.get(row['id'],[]):add_scope(reference,'applicable')
        if row['kind']=='ASSET':
            for coverage in value.get('state_coverage',[]):add_scope(coverage['state'],'coverage')
            for reference in value.get('subjects',[]):owners[reference['object_id']]=reference
        candidates=results.get(row['object_id'],[]) if row['kind']=='REQUIREMENT' else [row]
        real=[a for a in candidates if not a['payload'].get('placeholder') and any(c['role']=='original' for c in a['payload'].get('components',[]))]
        preview=next((c for a in real for c in a['payload']['components'] if c['role']=='original' and c['mime'].startswith('image/')),None)
        entries.append({'object_id':row['object_id'],'id':row['id'],'kind':row['kind'],'title':value['title'],
                        'media_type':value['media_type'],'generated':bool(real),'preview':preview,
                        'generation_scope':'history' if row['kind']=='REQUIREMENT' else 'exact',
                        'slot':value.get('slot'),'scope':scope,'locations':locations,'entity_ids':list(owners)})
    from .material_storage import canonical_id, identity
    merged={}
    for item in entries:
        mid=canonical_id(store,item['object_id'])
        if mid not in merged or item['object_id']==mid:
            previous=merged.get(mid)
            merged[mid]={**item,'canonical_material_id':mid,'material_identity':identity(store,mid)}
            if previous:
                merged[mid]['locations']+=previous['locations']
                merged[mid]['entity_ids']=sorted(set(merged[mid]['entity_ids']+previous['entity_ids']))
                merged[mid]['generated']|=previous['generated']
                merged[mid]['preview']=merged[mid]['preview'] or previous['preview']
        else:
            merged[mid]['locations']+=item['locations']
            merged[mid]['entity_ids']=sorted(set(merged[mid]['entity_ids']+item['entity_ids']))
            merged[mid]['generated']|=item['generated']
            merged[mid]['preview']=merged[mid]['preview'] or item['preview']
    from .material_plans import card_counts
    metrics = card_counts(store, merged)
    for mid, item in merged.items():item.update(metrics[mid])
    from .list_associations import material_uses
    return material_uses(store, list(merged.values()))


def management_episodes(store):
    return [{'object_id':r['object_id'],'number':r['payload']['number']} for r in light.rows(store,'EPISODE')
            if isinstance(r['payload'].get('number'),int) and r['payload']['number']>0]


def entity_summaries(store, entities, entries):
    counts={row['object_id']:{} for row in entities};statuses={};adoption_statuses={};seen=set()
    for item in entries:
        for eid in set(item['entity_ids']):
            key=(eid,item.get('canonical_material_id',item['object_id']))
            if key in seen:continue
            seen.add(key)
            if eid in counts:counts[eid][item['media_type']]=counts[eid].get(item['media_type'],0)+1
    rows=None
    for entity in entities:
        eid=entity['object_id'];decision=g.decision(store,eid);accepted=False
        if decision and decision['payload']['verdict']=='accepted':
            if rows is None:rows=p.current_records(store)
            scope=g.current_scope(store,eid,rows)
            accepted=bool(g.accepted(store,eid,scope) or g.content_scope(store,eid,decision,rows) or
                decision['payload'].get('acceptance_model')==g.CONTENT_MODEL and decision['payload']['acceptance_scope']==scope)
        statuses[eid]='accepted' if accepted else 'unaccepted'
        adoption_statuses[eid]='accepted' if accepted else 'stale' if decision and decision['payload']['verdict']=='accepted' else 'unaccepted'
    from .entity_review import full_states
    from .list_associations import entity_locations
    rows = rows if rows is not None else p.current_records(store, {'ENTITY','STATE','AV_SCENE','AV_SHOT','RELATION'})
    return {'management_episodes':management_episodes(store),'entity_material_counts':counts,'entity_statuses':statuses,'entity_adoption_statuses':adoption_statuses,
            'entity_state_counts':{e['object_id']:len({r['object_id'] for r in full_states(rows,e['object_id'])}) for e in entities},
            'entity_locations':entity_locations(store,entities,rows),
            'entity_previews':{eid:next((item['preview'] for item in sorted(entries,key=lambda v:v.get('slot')!='overall') if eid in item['entity_ids'] and item.get('preview')),None) for eid in counts}}


def material_list(store, episode=None, scene=None, media=None, search='', status=None, offset=0, limit=40, focus=None, grouped=False, compact=False):
    if media and media not in ('image','audio','video','project','document'):raise ValueError('unknown media filter')
    if status and status not in ('generated','ungenerated'):raise ValueError('unknown status filter')
    values=material_entries(store);chosen={'episode':episode,'scene':scene,'media':media,'status':status}
    def matches(item,filters):
        if search and search.lower() not in item['title'].lower():return False
        if filters.get('media') and item['media_type']!=filters['media']:return False
        if filters.get('status') and item['generated']!=(filters['status']=='generated'):return False
        return not (filters.get('episode') or filters.get('scene')) or any(
            (not filters.get('episode') or loc['episode']==filters['episode']) and
            (not filters.get('scene') or loc['scene']==filters['scene']) for loc in item['locations'])
    options={'media':sorted({i['media_type'] for i in values}),'status':['generated','ungenerated'],
             'episode':sorted({l['episode'] for i in values for l in i['locations'] if l.get('episode')}),
             'scene':sorted({l['scene'] for i in values for l in i['locations'] if l.get('scene') and (not episode or l['episode']==episode)})}
    facets={key:{value:sum(matches(i,{**chosen,key:value}) for i in values) for value in ['',*opts]} for key,opts in options.items()}
    result=[item for item in values if matches(item,chosen)]
    if grouped:
        from .list_associations import material_groups
        result.sort(key=lambda i:(i['canonical_material_id'],i['id']))
        groups=material_groups(store,result,episode,scene)
        if compact:
            # All card identities and grouping rows stay available for instant
            # local pagination. Full association evidence is read on card open.
            result=[{**{k:v for k,v in item.items() if k not in ('material_identity','entity_ids','locations')},
                     'locations':[{k:v for k,v in loc.items() if k in ('scope','episode','scene','kind','relation','title')}
                                  for loc in item['locations'] if loc.get('kind') in ('AV_SCENE','AV_SHOT','AV_EPISODE')]}
                    for item in result]
        return {'management_episodes':management_episodes(store),'items':result,'total':len(result),'groups':groups,
                'display_total':sum(len(group['material_ids']) for group in groups),'facets':facets}
    focused=None
    if focus:
        from .material_storage import canonical_id
        focus=canonical_id(store,focus)
        focused=next((item for item in values if item['object_id']==focus),None)
        if focused is None:
            mids=[r['material_id'] for r in store.db.execute('SELECT DISTINCT m.material_id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE r.object_id=?',(focus,))]
            focused=next((item for item in values if item['object_id'] in mids),None)
        if focused in result and focused is not None:offset=result.index(focused)//limit*limit
    return {'items':result[offset:offset+limit],'total':len(result),'offset':offset,'limit':limit,'facets':facets,
            'focused_outside':focused if focused is not None and focused not in result else None}


def card(store, object_id, revision_id=None, entity_id=None):
    from . import entity_review
    detail=p.snapshot(store,object_id=object_id,revision_id=revision_id);row=detail['record'];scope=row['payload'].get('scope');form=None;owner=None
    if row['kind']=='ENTITY':owner=row
    elif row['kind']=='STATE':form=row
    elif row['kind']=='ASSET':
        needs=(detail.get('review_context') or {}).get('requirements',[])
        actual=(detail.get('review_context') or {}).get('call')
        call_need=(actual or {}).get('payload',{}).get('generation_requirement')
        references=[need['payload'].get('scope') for need in needs if not need.get('unavailable')]
        if call_need:
            call_record=p.ref_record(store,call_need)
            if not call_record.get('unavailable'):references.append(call_record['payload'].get('scope'))
        references.extend(item['state'] for item in row['payload'].get('state_coverage',[]))
        references.extend(row['payload'].get('subjects',[]))
        # A retired placeholder is evidence of absence, not a source. Try the
        # remaining exact evidence without replacing any referenced revision.
        scope=next((reference for reference in references if reference and
                    not p.ref_record(store,reference).get('unavailable')),None)
    scoped=p.ref_record(store,scope) if scope else None
    if scoped and scoped['kind']=='STATE':form=scoped
    elif scoped and scoped['kind']=='ENTITY':owner=scoped
    if form:
        if form.get('unavailable'):
            owner=p.record(store,form['owner_object_id']) if form.get('owner_object_id') else None
            form=None
        else:owner=p.ref_record(store,form['payload']['entity'])
    entity=entity_review.snapshot(store,entity_id or owner['object_id']) if entity_id or owner else None
    if entity_id:
        allowed={entity['entity']['object_id'],*(r['object_id'] for r in entity['states']),*(r['object_id'] for r in entity.get('retained_states',[])),*(r['object_id'] for r in entity.get('comment_records',[]))}
        if row.get('cleaned_target') and row['payload']['entity']['object_id']==entity_id:
            allowed.add(row['object_id'])
        if row['object_id'] not in allowed:
            raise ValueError('准确对象不属于所请求的实体')
        if form and form['payload']['entity']['object_id']!=entity_id:
            form=None
    if entity:
        entity['adoptions']=b.rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='adoption'")
        entity['reference_titles']=detail.get('reference_titles',[])
        # An explicit old demand/result remains reachable even when its source
        # has since advanced. This does not enter decision_scope or acceptance.
        if row['kind'] in ('REQUIREMENT','ASSET'):
            for field in ('material_versions','legacy_material_versions','material_card_counts'):
                entity[field]={**entity.get(field,{}),**detail.get(field,{})}
            exact_rows=[row,*[member for rounds in detail.get('material_versions',{}).values()
                            for version in rounds for member in version['members']]]
            entity['comment_records']=list({r['id']:r for r in [*entity['comment_records'],*exact_rows]}.values())
            entity['comment_targets']=[b.ref(r) for r in entity['comment_records']]
            if row['kind']=='REQUIREMENT' and not any(r['object_id']==row['object_id'] for r in entity['requirements']):
                entity['requirements'].append(row)
            if form and not any(r['id']==form['id'] for r in [*entity['states'],*entity.get('retained_states',[])]):
                entity['retained_states'].append(form)
    context=b.context(store,scoped['object_id'],scoped['id']) if scoped and not scoped.get('unavailable') else None
    source_materials=[]
    if context and not entity:
        from .material_plans import card_counts
        needs=[r for r in context['requirements'] if r['payload']['scope']==b.ref(scoped)]
        counts=card_counts(store,[r['object_id'] for r in needs])
        source_materials=[{'object_id':r['object_id'],'id':r['id'],'title':r['payload']['title'],
                           'media_type':r['payload']['media_type'],'scope':r['payload']['scope'],
                           **counts.get(r['object_id'],{})} for r in needs]
    return {'detail':detail,'entity_review':entity,'form':form,'scope':scoped,
            'source_materials':source_materials,'adoption_context':context}


def scene(store, object_id, revision_id=None, shot_revision=None, view=None):
    if view not in (None, 'breakdown', 'shots'):
        raise ValueError('unknown scene view')
    # Full video definitions are read below for this scene's shots only. Other
    # materials and ancestor contexts retain the lightweight list projection.
    metadata = view is not None
    read_ref = light.ref_record if metadata else p.ref_record
    selected=p.record(store,object_id,revision_id)
    if selected['kind']!='AV_SCENE':raise ValueError('scene reader requires a scene')
    shots=b.scene_shots(store,selected,p.record(store,revision_id=shot_revision) if shot_revision else None)
    chain=b.ancestors(store,selected);contexts=[]
    for reference in chain:
        row=p.ref_record(store,reference)
        if row['kind'] in ('AV_SCENE','AV_EPISODE','EPISODE','INPUT_LOCK','STORY'):
            contexts.append(b.context(store,row['object_id'],row['id'],metadata=metadata))
    all_entries={i['object_id']:i for i in material_entries(store)}
    def enrich(context):
        from .material_storage import canonical_id
        from . import material_plans
        scoped=context['record'];needs={};context['missing_materials']=[]
        def add(row,relation,evidence):
            if row.get('unavailable'):
                context['missing_materials'].append({'reference':b.ref(row),'message':row['payload']['title'],'evidence':evidence})
                return
            if row['kind'] not in ('REQUIREMENT','ASSET'):return
            mid=canonical_id(store,row['object_id'])
            if row['kind']=='ASSET':
                selection=evidence.get('reference',{}).get('material_selection',{})
                selected=selection.get('material_id')
                memberships={canonical_id(store,v['material_id']) for v in material_plans.memberships(store,row['id']) if v['role']=='result'}
                mids=memberships|{canonical_id(store,v['object_id']) for v in row['payload'].get('candidate_requirements',[]) if not read_ref(store,v).get('unavailable')}
                if selected and canonical_id(store,selected) in mids:mid=canonical_id(store,selected)
                elif len(mids)==1:mid=next(iter(mids))
            if mid in needs:
                needs[mid][2].append(evidence)
                if row['kind']=='REQUIREMENT':needs[mid][:2]=[row,relation]
            else:needs[mid]=[row,relation,[evidence]]
        for need in context['requirements']:
            add(need,'mounted' if need['payload']['scope']==b.ref(scoped) else 'applicable',
                {'kind':'direct_requirement','record':b.ref(need),'scope':b.ref(scoped)})
            if not metadata:
                need['review_input_records']=[p.ref_record(store,v['reference']) for v in need['payload'].get('generation',{}).get('inputs',[])]
            for value in need['payload'].get('generation',{}).get('inputs',[]):
                add(read_ref(store,value['reference']),'planned_input',
                    {'kind':'planned_input','record':b.ref(need),'reference':value})
            for membership in material_plans.memberships(store,need['id']):
                for call_ref in store.db.execute("SELECT revision_id FROM material_plan_members WHERE material_id=? AND number=? AND role='call'",(membership['material_id'],membership['number'])):
                    call=(light.record if metadata else p.record)(store,revision_id=call_ref[0])
                    for value in call['payload'].get('inputs',[]):
                        exact=value.get('reference',value)
                        add(read_ref(store,exact),'actual_input',
                            {'kind':'actual_input','record':b.ref(call),'reference':value})
        for link in context['relations']:
            if link['payload']['relation_type']=='applicability':
                subject=read_ref(store,link['payload']['subject'])
                # A state/entity applicability link expresses suitability, not
                # the use of every material attached to that state/entity.
                add(subject,'applicable',{'kind':'direct_requirement','record':b.ref(link),'scope':b.ref(scoped)})
        for adoption in context['adoptions']:
            add(p.ref_record(store,adoption['payload']['asset']),'adoption',
                {'kind':'adoption','record':b.ref(adoption),'selection':adoption['payload']})
        context['materials']=[]
        levels={'AV_EPISODE':'episode','AV_SCENE':'scene','AV_SHOT':'shot','STORY':'story','INPUT_LOCK':'story','EPISODE':'episode','ENTITY':'entity','STATE':'state'}
        for mid,(row,relation,evidence) in needs.items():
            item=all_entries.get(mid)
            if not item:
                value=row['payload'];item={'object_id':row['object_id'],'media_type':value['media_type'],'slot':value.get('slot'),'generated':row['kind']=='ASSET' and not value.get('placeholder') and any(c['role']=='original' for c in value.get('components',[])),'generation_scope':'exact','preview':next((c for c in value.get('components',[]) if c['mime'].startswith('image/')),None)}
                item.update(material_plans.card_counts(store,[mid])[mid])
            placement=row['payload'].get('scope') or item.get('scope')
            owner=p.ref_record(store,placement) if placement else scoped
            context['materials'].append({**item,'id':row['id'],'title':item.get('title',row['payload']['title']),'association':relation,
                'canonical_material_id':mid,'usage_evidence':evidence,
                'placement':b.ref(owner),'placement_level':levels.get(owner['kind'],'shot'),
                'placement_title':owner['payload']['title'],'record':row,
                'reference':b.ref(row),'classification':material_classification(store,row,item,owner)})
        context['video_details']={r['object_id']:p.snapshot(store,object_id=r['object_id'],revision_id=r['id']) for r in context['requirements'] if scoped['kind']=='AV_SHOT'}
        return context
    source_scenes=[p.source_excerpt(store,source) for source in selected['payload']['sources']]
    return {'scene':selected,'source_scenes':source_scenes,'shared':[enrich(c) for c in reversed(contexts)],
            'shots':[{'record':r,'context':enrich(b.context(store,r['object_id'],r['id'],metadata=metadata))} for r in shots]}



def material_classification(store, row, item, placement):
    """Classify from actual object relations; names carry no type information."""
    entities={};scopes=[]
    def add(value):
        if not value:return
        record=p.ref_record(store,value)
        if record.get('unavailable'):return
        if record['kind']=='STATE':add(record['payload']['entity'])
        elif record['kind']=='ENTITY':entities[record['object_id']]=record
        elif record['kind'] in b.POSITIONS:scopes.append(record)
    add(row['payload'].get('scope'))
    for value in row['payload'].get('subjects',[]):add(value)
    for value in row['payload'].get('state_coverage',[]):add(value['state'])
    for value in row['payload'].get('candidate_requirements',[]):
        add(p.ref_record(store,value)['payload'].get('scope'))
    for eid in item.get('entity_ids',[]):
        if eid not in entities:add(b.ref(p.record(store,eid)))
    labels={'character':'角色','space':'场景','prop':'道具','song':'歌曲'}
    if len(entities)>1:kind='shared';label='共有'
    elif entities:
        entity=next(iter(entities.values()));kind=entity['payload']['entity_type']
        label=labels.get(kind) or entity['payload'].get('entity_type_label') or '其他'
    else:
        kinds={r['kind'] for r in scopes} or {placement['kind']}
        kind=next(iter(kinds)) if len(kinds)==1 else 'shared'
        label={'AV_SHOT':'视听镜头','AV_SCENE':'视听场','AV_EPISODE':'视听集','EPISODE':'分集','INPUT_LOCK':'全剧','STORY':'全剧','shared':'共有'}.get(kind,'其他')
    kind={'AV_SCENE':'space','AV_SHOT':'shot','AV_EPISODE':'episode','EPISODE':'episode','INPUT_LOCK':'story','STORY':'story'}.get(kind,kind)
    media=row['payload']['media_type']
    return {'key':media+':'+kind,'label':label+'-'+{'image':'图像','audio':'声音','video':'视频','project':'工程','document':'文档'}.get(media,'其他'),
            'entity_refs':[b.ref(r) for r in entities.values()],'placement_refs':[b.ref(r) for r in scopes]}
