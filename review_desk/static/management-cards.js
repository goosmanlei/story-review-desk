/* Shared four-column row pagination; viewport changes only change CSS layout. */
function groupedCardPage(groups,page=1,rowsPerPage=10){
  const rows=Math.max(1,Math.trunc(rowsPerPage)||10),totalRows=groups.reduce((n,g)=>n+Math.ceil(g.items.length/4),0),pages=Math.max(1,Math.ceil(totalRows/rows));
  page=Math.min(pages,Math.max(1,Math.trunc(page)||1));const start=(page-1)*rows,end=start+rows;let offset=0;const visible=[];
  for(const group of groups){const size=Math.ceil(group.items.length/4),from=Math.max(0,start-offset),to=Math.min(size,end-offset);if(to>from)visible.push({...group,continued:from>0,items:group.items.slice(from*4,to*4)});offset+=size}
  return {groups:visible,page,pages,totalRows,rowsPerPage:rows};
}
function reviewPagination(parent,model,change){
  const nav=el('nav','review-pagination');nav.setAttribute('aria-label','列表分页');
  for(const [label,page,disabled] of [['首页',1,model.page===1],['上一页',model.page-1,model.page===1]])productionButton(nav,label,()=>change(page,model.rowsPerPage)).disabled=disabled;
  const status=nodeText('span',null,`第 ${model.page} / ${model.pages} 页`,nav);status.setAttribute('aria-live','polite');
  for(const [label,page,disabled] of [['下一页',model.page+1,model.page===model.pages],['末页',model.pages,model.page===model.pages]])productionButton(nav,label,()=>change(page,model.rowsPerPage)).disabled=disabled;
  const label=el('label');nodeText('span',null,'每页行数',label);const select=el('select');select.setAttribute('aria-label','每页行数');for(const count of [5,10,20,50])select.append(new Option(String(count),String(count)));select.value=String(model.rowsPerPage);select.onchange=()=>change(1,Number(select.value));label.append(select);nav.append(label);
  nodeText('small','pagination-basis','行数按四列计算；窄屏仅重排',nav);parent.append(nav);return nav;
}
function managementMemory(key,params,prefix){
  state.managementLists||={};if(!state.managementLists[key])state.managementLists[key]={page:Number(params.get(prefix+'page'))||1,rows:Number(params.get(prefix+'rows'))||10,filters:{}};
  const memory=state.managementLists[key];if(![5,10,20,50].includes(memory.rows))memory.rows=10;return memory;
}
function managementRoute(prefix,memory){
  breakdownRoute({[prefix+'page']:memory.page,[prefix+'rows']:memory.rows,...Object.fromEntries(Object.entries(memory.filters).map(([k,v])=>[prefix+k,v||null]))});
}
function managementSections(parent,groups,card){
  for(const group of groups){const section=el('section','management-card-group');section.dataset.groupKey=group.key;nodeText('h3',null,group.title,section);const list=el('div','management-card-grid');section.append(list);for(const item of group.items)card(list,item);parent.append(section)}
}
function managementSceneLabel(id,episode,catalog){
  const ep=catalog.episodes.find(ep=>ep.object_id===episode),scene=ep?.scenes?.find(scene=>scene.id===id);
  if(scene){const name=String(scene.heading||scene.title||scene.location||'').replace(/^\d+-\d+\s*/u,'');return reviewPositionLabel('scene',scene,episode)+(name?' · '+name:'')}
  if(episode)return reviewPositionLabel('scene',id,episode);
  const codes=[...new Set(catalog.episodes.map(ep=>state.businessCodes?.get('scene:'+ep.object_id+':'+id)).filter(Boolean))];
  return codes.length?codes.join(' / '):reviewPositionLabel('scene',id);
}
function managementScopeFilters(parent,filters,catalog,locations,change){
  const present=new Set(locations.map(l=>l.episode).filter(Boolean));
  const episodes=[['','全部集'],...catalog.episodes.filter(ep=>present.has(ep.object_id)).map(ep=>[ep.object_id,reviewPositionLabel('episode',ep)])];
  const ids=[...new Set(locations.filter(l=>l.scene&&(!filters.episode||l.episode===filters.episode)).map(l=>l.scene))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(filters.scene&&!ids.includes(filters.scene))filters.scene='';
  const scenes=[['','全部场'],...ids.map(id=>[id,[...new Set(locations.filter(l=>l.scene===id&&(!filters.episode||l.episode===filters.episode)).map(l=>managementSceneLabel(id,l.episode,catalog)))].join(' / ')])];
  flatFilterGroup(parent,'episode','所属集',episodes,filters.episode,null,value=>{filters.episode=value;filters.scene='';change()});
  flatFilterGroup(parent,'scene','所属场',scenes,filters.scene,null,value=>{filters.scene=value;change()});
}
async function loadEntityManagement(result,{epoch,onReadStart}={}){
  const workspace=state.workspace,host=$('#production-view'),params=new URL(location.href).searchParams,memory=managementMemory('entities',params,'entity_');
  const keys=['episode','scene','category','acceptance','search'];for(const key of keys)memory.filters[key]??=params.get('entity_'+key)||'';const filters=memory.filters;
  const catalog={episodes:result.management_episodes||[]};if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;
  rememberProductionDraft();state.productionSelected=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const panel=el('section','production-filters');panel.setAttribute('aria-label','实体管理筛选');const controls=el('div','production-toolbar'),search=el('input');search.type='search';search.placeholder='搜索实体、别名或状态';search.setAttribute('aria-label','搜索制作记录');search.value=filters.search;controls.append(search);panel.append(controls);const scope=el('div','management-scope-filters'),facets=el('div');panel.append(scope,facets);host.append(panel);
  const summary=nodeText('p','production-filter-summary','',host);summary.setAttribute('role','status');const content=el('div','management-card-list');content.setAttribute('aria-label','制作实体');host.append(content);const bottom=el('div');host.append(bottom);
  const entities=productionWorkspaceRows(result.records,workspace,result.material_assets),types=[...new Set(entities.map(r=>r.payload.entity_type))];
  const text=new Map(entities.map(e=>[e.object_id,result.entity_search_fields?.[e.object_id]||[businessCode(e),e.payload.title]]));
  function matches(row,selection=filters){return (!selection.category||selection.category===row.payload.entity_type)&&(!selection.acceptance||result.entity_adoption_statuses[row.object_id]===selection.acceptance)&&readableSearchMatches(selection.search,text.get(row.object_id))&&(!(selection.episode||selection.scene)||(result.entity_locations[row.object_id]||[]).some(l=>(!selection.episode||l.episode===selection.episode)&&(!selection.scene||l.scene===selection.scene)))}
  const clear=productionButton(controls,'清除筛选',()=>{for(const key of keys)filters[key]='';search.value='';refresh()});search.oninput=()=>{filters.search=search.value.trim();refresh()};
  function refresh(reset=true){if(reset)memory.page=1;scope.replaceChildren();managementScopeFilters(scope,filters,catalog,Object.values(result.entity_locations).flat(),()=>refresh());facets.replaceChildren();
    for(const [key,label,options] of [['category','内容分类',[['','全部实体'],...types.map(t=>[t,productionLabels[t]||t])]],['acceptance','采纳状态',[['','全部'],['accepted','已采纳'],['unaccepted','未采纳'],['stale','需重新采纳']]]]){const counts=Object.fromEntries(options.map(([value])=>[value,entities.filter(e=>matches(e,{...filters,[key]:value})).length]));flatFilterGroup(facets,key,label,options,filters[key],counts,value=>{filters[key]=value;refresh()})}
    const rows=entities.filter(e=>matches(e));state.productionVisibleEntities=new Set(rows.map(r=>r.object_id));summary.textContent=`${rows.length} 个实体`;clear.disabled=!Object.values(filters).some(Boolean);
    const groups=types.map(t=>({key:t,title:productionLabels[t]||t,items:rows.filter(e=>e.payload.entity_type===t).sort((a,b)=>businessCode(a).localeCompare(businessCode(b),undefined,{numeric:true})||a.object_id.localeCompare(b.object_id))})).filter(g=>g.items.length),page=groupedCardPage(groups,memory.page,memory.rows);memory.page=page.page;content.replaceChildren();managementSections(content,page.groups,(list,row)=>entitySmallCard(list,row,{stateCount:result.entity_state_counts[row.object_id],materialCount:Object.values(result.entity_material_counts[row.object_id]||{}).reduce((sum,n)=>sum+n,0),adoption:result.entity_adoption_statuses[row.object_id],preview:result.entity_previews[row.object_id]}));if(!rows.length)nodeText('p','production-meta','没有符合筛选条件的实体',content);
    bottom.replaceChildren();reviewPagination(bottom,page,(p,rows)=>{memory.page=p;memory.rows=rows;refresh(false);content.scrollIntoView({block:'start'});bottom.querySelector('[aria-label="每页行数"]')?.focus({preventScroll:true})});managementRoute('entity_',memory);
  }
  let indexRequest=0,indexNotice=null;
  const ownsIndex=()=>workspace===state.workspace&&epoch===productionLoadEpoch&&panel.isConnected;
  state.refreshEntityIndex=async(savedMessage='')=>{
    if(!ownsIndex())return;
    const request=++indexRequest;
    try{
      const fresh=await api('/api/production/index?view=settings');
      if(!ownsIndex()||request!==indexRequest)return;
      indexNotice?.remove();indexNotice=null;
      const focused=document.activeElement,focusKey=focused?.dataset.filterKey,focusValue=focused?.dataset.filterValue,focusObject=focused?.dataset.objectId;
      Object.assign(result,fresh);refresh(false);
      if(focused&&!focused.isConnected){
        const replacement=[...host.querySelectorAll('button')].find(button=>focusKey!==undefined?button.dataset.filterKey===focusKey&&button.dataset.filterValue===focusValue:focusObject&&button.dataset.objectId===focusObject);
        replacement?.focus({preventScroll:true});
      }
    }catch(error){
      if(!ownsIndex()||request!==indexRequest)return;
      indexNotice?.remove();indexNotice=el('div','production-issue');indexNotice.setAttribute('role','status');
      nodeText('p',null,(savedMessage?savedMessage+'；':'')+`列表当前显示尚未更新：${error.message}。可重新读取列表或打开实体核对。`,indexNotice);
      productionButton(indexNotice,'重新读取列表',()=>state.refreshEntityIndex(savedMessage));panel.append(indexNotice);
    }
  };refresh(false);
  const target=params.get('production_object')||params.get('production_entity');if(target){onReadStart?.({workspace,loadEpoch:epoch,readEpoch:productionReadEpoch});await openUnifiedMaterial({object_id:target,revision_id:params.get('production_revision'),params},null)}
}
function readableSearchMatches(query,terms){
  const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' '),needle=normalized(query);
  return !needle||( /^(?:m|en|st|ash|as|ae)\d+$/u.test(needle)?terms.some(term=>normalized(term)===needle):terms.some(term=>normalized(term).includes(needle)));
}
function managementMaterialGroups(result,filters,catalog){
  const byId=new Map(result.items.map(i=>[i.canonical_material_id||i.object_id,i]));
  const groups=result.groups.map(g=>({...g,title:g.level==='scene'?`${reviewPositionLabel('episode',catalog.episodes.find(e=>e.object_id===g.episode)||g.episode_number)} / ${managementSceneLabel(g.scene,g.episode,catalog)}`:g.level==='episode'?`${reviewPositionLabel('episode',catalog.episodes.find(e=>e.object_id===g.episode)||g.episode_number)} · 集素材`:g.level==='story'?'全剧素材':'未关联集场',items:g.material_ids.map(id=>byId.get(id))}));
  if(!filters.search||filters.episode||filters.scene)return groups;
  return [{key:'identities',title:'查找结果',items:result.items.map(item=>({...item,usageGroups:groups.filter(group=>group.material_ids.includes(item.canonical_material_id||item.object_id))}))}];
}
function managementMaterialUses(parent,item,memory){
  if(!item.usageGroups?.length)return;
  const details=el('details','management-material-uses');nodeText('summary',null,'用途 · '+item.usageGroups.length+' 处',details);
  if(!memory.expandedUses){let saved=[];try{saved=JSON.parse(sessionStorage.getItem('review-material-uses')||'[]')}catch{}memory.expandedUses=new Set(saved)}
  const id=item.canonical_material_id||item.object_id;details.open=memory.expandedUses.has(id);
  details.addEventListener('toggle',()=>{if(details.open)memory.expandedUses.add(id);else memory.expandedUses.delete(id);try{sessionStorage.setItem('review-material-uses',JSON.stringify([...memory.expandedUses]))}catch{}});
  for(const group of item.usageGroups){
    const references=(item.locations||[]).filter(loc=>loc.episode===group.episode&&loc.scene===group.scene&&loc.scope);
    const exact=new Map();
    for(const loc of references){
      if(!loc.source&&references.some(other=>other.source&&other.scope.object_id===loc.scope.object_id&&other.scope.revision_id===loc.scope.revision_id))continue;
      const ref=loc.source||loc.scope,key=JSON.stringify([ref.object_id,ref.revision_id,ref.scene_id||'',loc.kind]),previous=exact.get(key);
      if(previous?.source)previous.source={...previous.source,block_ids:[...new Set([...(previous.source.block_ids||[]),...(ref.block_ids||[])])]};else exact.set(key,{...loc});
    }
    const unique=[...exact.values()],sourceLabel=loc=>group.title.replace(/ · .*$/u,'')+(loc.source_scene_name?' · '+String(loc.source_scene_name).replace(/^\d+-\d+\s*/u,''):'');
    const line=el('div','management-use-line');details.append(line);
    if(unique.length===1&&unique[0].source)productionRefLink(line,unique[0].source,sourceLabel(unique[0]));
    else {nodeText('p',null,group.title,line);for(const loc of unique)productionRefLink(line,loc.source||{...loc.scope,kind:loc.kind},loc.source?sourceLabel(loc)+' · 修订 '+loc.source_version:loc.title||group.title)}
  }
  parent.append(details);
}
function entitySmallCard(parent,row,{stateCount=0,materialCount=0,adoption='unaccepted',preview=null}={}){
  const label=({accepted:'已采纳',stale:'需重新采纳',unaccepted:'未采纳'})[adoption]||'未采纳';
  const button=reviewSmallCard(parent,{title:row.payload.title,business_code:businessCode(row),icon:row.payload.entity_type,preview,subtitle:`状态 ${stateCount} 个 · 素材 ${materialCount} 个 · ${label}`},trigger=>openUnifiedMaterial({object_id:row.object_id,defaultSelection:true},trigger));button.classList.add('entity-small-card');button.dataset.objectId=row.object_id;button.dataset.entityType=row.payload.entity_type;button.setAttribute('aria-haspopup','dialog');return button;
}
async function loadMaterialManagement(){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();const workspace=state.workspace,epoch=++productionLoadEpoch,host=$('#production-view'),params=new URL(location.href).searchParams,memory=managementMemory('materials',params,'material_');++productionReadEpoch;state.productionSelected=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const keys=['episode','scene','media','status','search'];for(const key of keys)memory.filters[key]??=params.get('material_'+key)||'';const filters=memory.filters,catalog={episodes:[]};if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;state.productionRecords=[];
  const panel=el('section','production-filters');panel.setAttribute('aria-label','素材管理筛选');const controls=el('div','production-toolbar'),search=el('input');search.type='search';search.placeholder='搜索素材';search.setAttribute('aria-label','搜索素材');search.value=filters.search;controls.append(search);panel.append(controls);const scope=el('div','management-scope-filters'),facets=el('div');panel.append(scope,facets);host.append(panel);const summary=nodeText('p','production-filter-summary','',host);summary.setAttribute('role','status');const content=el('div','management-card-list');content.setAttribute('aria-label','素材列表');host.append(content);const bottom=el('div');host.append(bottom);let request=0,result=null,timer;
  const clear=productionButton(controls,'清除筛选',()=>{for(const key of keys)filters[key]='';search.value='';refresh()});search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{filters.search=search.value.trim();refresh()},150)};
  function draw(){
    const groups=managementMaterialGroups(result,filters,catalog),page=groupedCardPage(groups,memory.page,memory.rows);memory.page=page.page;content.replaceChildren();
    managementSections(content,page.groups,(list,item)=>{const wrapper=el('div');list.append(wrapper);const button=materialSmallCard(wrapper,item,trigger=>openUnifiedMaterial({object_id:item.object_id,defaultSelection:true},trigger),false,{includesHistory:true});button.setAttribute('aria-haspopup','dialog');managementMaterialUses(wrapper,item,memory)});
    if(!result.total)nodeText('p','production-meta','没有符合筛选条件的素材；可清除搜索或调整集场、媒体与结果条件。',content);
    const identityView=!!filters.search&&!filters.episode&&!filters.scene;
    summary.textContent=`素材数 ${result.total} · 展示项数 ${identityView?result.total:result.display_total}`;summary.title=identityView?'按独立素材展示；用途保留在各素材下方':'素材数按唯一素材身份计数；同一素材在不同真实关联分组各展示一次';
    bottom.replaceChildren();reviewPagination(bottom,page,(p,rows)=>{memory.page=p;memory.rows=rows;draw();content.scrollIntoView({block:'start'});bottom.querySelector('[aria-label="每页行数"]')?.focus({preventScroll:true})});managementRoute('material_',memory);
  }
  async function refresh(reset=true){if(reset)memory.page=1;const token=++request;clear.disabled=!Object.values(filters).some(Boolean);try{const data=await api('/api/production/materials?'+new URLSearchParams({...filters,grouped:1,compact:1}));if(token!==request||epoch!==productionLoadEpoch||workspace!==state.workspace)return;result=data;catalog.episodes=result.management_episodes||catalog.episodes;facets.replaceChildren();for(const key of ['media','status']){const options=Object.keys(result.facets[key]).map(value=>[value,value?(key==='media'?productionMediaLabels[value]:value==='generated'?'有结果':'无结果'):'全部']);flatFilterGroup(facets,key,key==='media'?'媒体类型':'生成结果（含历史版本）',options,filters[key],result.facets[key],value=>{filters[key]=value;refresh()})}scope.replaceChildren();const locations=result.management_locations||[];managementScopeFilters(scope,filters,catalog,locations,()=>refresh());draw()}catch(error){if(token===request&&epoch===productionLoadEpoch){content.replaceChildren();nodeText('p','production-issue',error.message,content)}}}
  await refresh(false);if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;const target=params.get('production_object');if(target)await openUnifiedMaterial({object_id:target,revision_id:params.get('production_revision'),params},null);
}
