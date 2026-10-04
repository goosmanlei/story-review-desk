"""Read-only card and list projections. No media creation or stored UI state."""
from . import production as p, generation as g
from . import production_breakdown as b


def material_entries(store):
    needs=b.rows(store,'REQUIREMENT',"COALESCE(json_extract(r.payload,'$.status'),'')!='withdrawn'")
    assets=b.rows(store,'ASSET');results={};used=set()
    for raw in store.db.execute("SELECT m.material_id,r.*,o.kind,o.current_revision FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id JOIN objects o ON o.id=r.object_id WHERE m.role='result' ORDER BY r.created_at DESC,r.version DESC,r.id DESC"):
        row=p.record_view(raw);results.setdefault(raw['material_id'],[]).append(row)
        if raw['material_id']!=row['object_id']:used.add(row['object_id'])
    for asset in assets:
        for ref in asset['payload'].get('candidate_requirements',[]):
            results.setdefault(ref['object_id'],[]).append(asset);used.add(asset['object_id'])
    links={};cache={};entries=[]
    for link in b.rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='applicability'"):
        links.setdefault(link['payload']['subject']['revision_id'],[]).append(link['payload']['scope'])
    for row in [*needs,*(a for a in assets if a['object_id'] not in used)]:
        value=row['payload'];scope=value.get('scope');owners={};locations=[]
        def add_scope(reference,relation):
            scoped=p.ref_record(store,reference)
            locations.append({**b.location(store,reference,cache),'relation':relation,'title':scoped['payload']['title']})
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
                        'slot':value.get('slot'),'scope':scope,'locations':locations,'entity_ids':list(owners)})
    return entries


def entity_summaries(store, entities, entries):
    counts={row['object_id']:{} for row in entities};statuses={}
    for item in entries:
        for eid in set(item['entity_ids']):
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
    return {'entity_material_counts':counts,'entity_statuses':statuses}


def material_list(store, episode=None, scene=None, media=None, search='', status=None, offset=0, limit=40, focus=None):
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
    focused=None
    if focus:
        focused=next((item for item in values if item['object_id']==focus),None)
        if focused is None:
            mids=[r['material_id'] for r in store.db.execute('SELECT DISTINCT m.material_id FROM material_plan_members m JOIN revisions r ON r.id=m.revision_id WHERE r.object_id=?',(focus,))]
            focused=next((item for item in values if item['object_id'] in mids),None)
        if focused in result and focused is not None:offset=result.index(focused)//limit*limit
    return {'items':result[offset:offset+limit],'total':len(result),'offset':offset,'limit':limit,'facets':facets,
            'focused_outside':focused if focused is not None and focused not in result else None}


def card(store, object_id, revision_id=None):
    from . import entity_review
    detail=p.snapshot(store,object_id=object_id,revision_id=revision_id);row=detail['record'];scope=row['payload'].get('scope');form=None;owner=None
    if row['kind']=='ENTITY':owner=row
    elif row['kind']=='STATE':form=row
    elif row['kind']=='ASSET':
        needs=(detail.get('review_context') or {}).get('requirements',[])
        actual=(detail.get('review_context') or {}).get('call')
        call_need=(actual or {}).get('payload',{}).get('generation_requirement')
        if needs:scope=needs[0]['payload']['scope']
        elif call_need:scope=p.ref_record(store,call_need)['payload']['scope']
        elif row['payload'].get('state_coverage'):scope=row['payload']['state_coverage'][0]['state']
        elif row['payload'].get('subjects'):
            known=[p.ref_record(store,ref) for ref in row['payload']['subjects']]
            owner=next((item for item in known if item['kind']=='ENTITY'),None)
    scoped=p.ref_record(store,scope) if scope else None
    if scoped and scoped['kind']=='STATE':form=scoped
    elif scoped and scoped['kind']=='ENTITY':owner=scoped
    if form:owner=p.ref_record(store,form['payload']['entity'])
    entity=entity_review.snapshot(store,owner['object_id']) if owner else None
    if entity:
        entity['adoptions']=b.rows(store,'RELATION',"json_extract(r.payload,'$.relation_type')='adoption'")
    return {'detail':detail,'entity_review':entity,'form':form,'scope':scoped,
            'adoption_context':b.context(store,scoped['object_id'],scoped['id']) if scoped else None}


def scene(store, object_id, revision_id=None, shot_revision=None):
    selected=p.record(store,object_id,revision_id)
    if selected['kind']!='PREPARATION':raise ValueError('scene reader requires a scene')
    # Exact parents prevent current rearrangements from rebinding historical shots.
    shots=[p.record_view(r) for r in store.db.execute("""SELECT r.*,o.kind,o.current_revision FROM revisions r JOIN objects o ON o.id=r.object_id
        WHERE o.kind='SHOT_DESIGN' AND json_extract(r.payload,'$.parent.revision_id')=?
        AND NOT EXISTS(SELECT 1 FROM revisions n WHERE n.object_id=r.object_id AND n.version>r.version AND json_extract(n.payload,'$.parent.revision_id')=?)""",(selected['id'],selected['id']))]
    shots.sort(key=lambda r:(r['payload']['number'],r['object_id']))
    if shot_revision:
        exact=p.record(store,revision_id=shot_revision)
        if exact['kind']!='SHOT_DESIGN' or exact['payload'].get('parent')!=b.ref(selected):raise ValueError('exact shot does not belong to the selected scene')
        shots=[exact if r['object_id']==exact['object_id'] else r for r in shots]
    chain=b.ancestors(store,selected);contexts=[]
    for reference in chain:
        row=p.ref_record(store,reference)
        if row['kind'] in ('PREPARATION','EPISODE','INPUT_LOCK','STORY'):
            contexts.append(b.context(store,row['object_id'],row['id']))
    all_entries={i['object_id']:i for i in material_entries(store)}
    def enrich(context):
        scoped=context['record'];direct={r['object_id'] for r in b.exact_scoped(store,'REQUIREMENT',scoped['id'])}
        needs={r['object_id']:(r,'mounted' if r['object_id'] in direct else 'applicable') for r in context['requirements']}
        # Only explicit scope/applicability supplies material placement. A state
        # occurring in a scene alone does not make all its media shared there.
        for link in context['relations']:
            if link['payload']['relation_type']!='applicability':continue
            subject=p.ref_record(store,link['payload']['subject'])
            if subject['kind']=='ASSET':needs.setdefault(subject['object_id'],(subject,'applicable'))
            elif subject['kind'] in ('ENTITY','STATE'):
                forms=[subject] if subject['kind']=='STATE' else [r for r in b.rows(store,'STATE') if r['payload'].get('entity')==b.ref(subject)]
                for form in forms:
                    for need in b.exact_scoped(store,'REQUIREMENT',form['id']):
                        if need['payload'].get('status')!='withdrawn':needs.setdefault(need['object_id'],(need,'applicable'))
        for need in context['requirements']:
            need['review_input_records']=[p.ref_record(store,v['reference']) for v in need['payload'].get('generation',{}).get('inputs',[])]
        context['materials']=[]
        for row,relation in needs.values():
            item=all_entries.get(row['object_id'])
            if not item:
                value=row['payload'];item={'object_id':row['object_id'],'media_type':value['media_type'],'slot':value.get('slot'),'generated':row['kind']=='ASSET' and not value.get('placeholder'),'preview':next((c for c in value.get('components',[]) if c['mime'].startswith('image/')),None)}
            context['materials'].append({**item,'id':row['id'],'title':row['payload']['title'],'association':relation,
                'placement':b.ref(scoped),'placement_title':scoped['payload']['title'], 'record':row})
        context['video_details']={r['object_id']:p.snapshot(store,object_id=r['object_id'],revision_id=r['id']) for r in context['requirements'] if r['payload']['media_type']=='video'}
        return context
    return {'scene':selected,'shared':[enrich(c) for c in reversed(contexts)],
            'shots':[{'record':r,'context':enrich(b.context(store,r['object_id'],r['id']))} for r in shots]}
