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
  // A history/method return is an exact URL, not the last mounted list.
  const memory=state.managementLists[key];memory.page=Number(params.get(prefix+'page'))||1;memory.rows=Number(params.get(prefix+'rows'))||10;if(![5,10,20,50].includes(memory.rows))memory.rows=10;return memory;
}
function managementRoute(prefix,memory){
  breakdownRoute({[prefix+'page']:memory.page,[prefix+'rows']:memory.rows,...Object.fromEntries(Object.entries(memory.filters).filter(([k])=>!['episode','scene','scope_revision'].includes(k)).map(([k,v])=>[prefix+k,v||null]))});managementScopeRoute(memory.filters);breakdownRoute({[prefix+'episode']:null,[prefix+'scene']:null});
}
function managementSections(parent,groups,card){
  for(const group of groups){const section=el('section','management-card-group');section.dataset.groupKey=group.key;nodeText('h3',null,group.title,section);const list=el('div','management-card-grid');section.append(list);for(const item of group.items)card(list,item);parent.append(section)}
}
function managementSceneLabel(id,episode,catalog){
  const ep=catalog.episodes.find(ep=>ep.object_id===episode),scene=ep?.scenes?.find(scene=>scene.id===id);
  if(scene?.kind==='AV_SCENE')return businessCode({object_id:scene.id,kind:scene.kind})+' · '+String(scene.title||'').replace(/^第\s*\d+\s*集\s*·\s*/u,'');
  if(scene){const name=String(scene.heading||scene.title||scene.location||'').replace(/^\d+-\d+\s*/u,'');return reviewPositionLabel('scene',scene,episode)+(name?' · '+name:'')}
  if(episode)return reviewPositionLabel('scene',id,episode);
  const codes=[...new Set(catalog.episodes.map(ep=>state.businessCodes?.get('scene:'+ep.object_id+':'+id)).filter(Boolean))];
  return codes.length?codes.join(' / '):reviewPositionLabel('scene',id);
}
function managementScopeParams(params=new URL(location.href).searchParams){
  return {scope:'av',scope_episode:params.get('production_scope_episode')||'',scope_revision:params.get('production_scope_revision')||'',scope_scene:params.get('production_scope_scene')||''};
}
function managementScopeMemory(memory,params,prefix){
  const scope=managementScopeParams(params),key=JSON.stringify(scope);
  if(memory.scopeKey!==undefined&&memory.scopeKey!==key)memory.page=1;memory.scopeKey=key;
  memory.filters.episode=scope.scope_episode;memory.filters.scene=scope.scope_scene;memory.filters.scope_revision=scope.scope_revision;
  memory.legacyScope=params.has(prefix+'episode')||params.has(prefix+'scene');
}
function managementScopeRoute(filters){
  breakdownRoute({production_scope_episode:filters.episode||null,production_scope_revision:filters.scope_revision||null,production_scope_scene:filters.scene||null});
}
function managementScopeFilters(parent,filters,catalog,locations,change){
  const episodes=[['','全部集'],...catalog.episodes.map(ep=>[ep.object_id,reviewPositionLabel('episode',ep)])];
  const available=catalog.episodes.filter(ep=>!filters.episode||ep.object_id===filters.episode).flatMap(ep=>(ep.scenes||[]).map(sc=>({ep,sc}))),counts=new Map();
  for(const {sc} of available)counts.set(sc.id,(counts.get(sc.id)||0)+1);
  const choices=available.map(({ep,sc})=>({ep,sc,value:counts.get(sc.id)>1?JSON.stringify([ep.object_id,sc.id]):sc.id,label:(counts.get(sc.id)>1?reviewPositionLabel('episode',ep)+' / ':'')+managementSceneLabel(sc.id,ep.object_id,catalog)}));
  const scenes=[['','全部场'],...choices.map(({value,label})=>[value,label])];
  flatFilterGroup(parent,'episode','视听集',episodes,filters.episode,null,value=>{filters.episode=value;filters.scene='';filters.scope_revision=catalog.episodes.find(ep=>ep.object_id===value)?.id||'';change()});
  flatFilterGroup(parent,'scene','视听场',scenes,filters.scene,null,value=>{const choice=choices.find(sc=>sc.value===value);filters.scene=choice?.sc.id||'';if(choice){filters.episode=choice.ep.object_id;filters.scope_revision=choice.ep.id}change()});
}
function managementLegacyNotice(parent,memory){
  if(memory.legacyScope)nodeText('p','production-issue','此旧链接按源剧本集场定位，可能对应多个视听场。请在上方重新选择视听制作范围。',parent);
}
async function loadEntityManagement(result,{epoch,onReadStart}={}){
  const workspace=state.workspace,host=$('#production-view'),params=new URL(location.href).searchParams;
  const memory=managementMemory('entities',params,'entity_');memory.filters={};managementScopeMemory(memory,params,'entity_');
  const filters=memory.filters,catalog={episodes:result.management_episodes||[]};
  if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;
  rememberProductionDraft();state.productionSelected=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const panel=el('section','production-filters');panel.setAttribute('aria-label','实体管理范围');host.append(panel);
  const summary=nodeText('p','production-filter-summary','',host),content=el('div','management-entity-graph');host.append(content);
  function refresh(){
    const entities=productionWorkspaceRows(result.records,workspace,result.material_assets);
    const rows=entities.filter(row=>!(filters.episode||filters.scene)||(result.entity_locations[row.object_id]||[]).some(loc=>(!filters.episode||loc.episode===filters.episode)&&(!filters.scene||loc.scene===filters.scene)));
    state.productionVisibleEntities=new Set(rows.map(row=>row.object_id));
    panel.replaceChildren();managementScopeFilters(panel,filters,catalog,[],refresh);
    summary.textContent=rows.length+' 个实体';content.replaceChildren();
    const key=JSON.stringify([filters.episode,filters.scene]);memory.graphs||={};memory.graphs[key]||={};
    renderManagementEntityGraph(content,rows,result,memory.graphs[key]);
    managementScopeRoute(filters);
    breakdownRoute({entity_search:null,entity_category:null,entity_page:null,entity_rows:null,entity_episode:null,entity_scene:null});
  }
  state.refreshEntityIndex=async()=>{const fresh=await api('/api/production/index?'+new URLSearchParams({view:'settings',...managementScopeParams()}));if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;Object.assign(result,fresh);catalog.episodes=fresh.management_episodes||[];refresh()};
  refresh();
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
  const details=el('section','management-material-uses');
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
function entitySmallCard(parent,row,{stateCount=0,materialCount=0,preview=null,references=[]}={}){
  const button=reviewSmallCard(parent,{title:row.kind==='AV_SHOT'?breakdownShotTitle(row).replace(/^ASH\d+ · /,''):row.payload.title,business_code:businessCode(row),icon:row.entity_type||row.payload.entity_type,preview,subtitle:`状态 ${stateCount} 个 · 素材 ${materialCount} 个`},trigger=>openManagementReferences(references,trigger,'选择此范围的准确实体版本',{object_id:row.object_id,defaultSelection:true}));button.classList.add('entity-small-card');button.dataset.objectId=row.object_id;button.dataset.entityType=row.entity_type||row.payload.entity_type;button.setAttribute('aria-haspopup','dialog');return button;
}
async function openManagementReferences(refs,trigger,title,fallback){
  if(refs.length>1){const {dialog,body}=openReviewDialog(title,trigger,'material-reference-dialog');for(const ref of refs)productionButton(body,ref.title+' · 记录修订 '+ref.version+(ref.use?' · '+({actual_input:'真实调用',planned_input:'计划拟用',alternative:'备选',mounted:'本场需求',applicability:'适用'}[ref.use]||'准确用途'):''),()=>{dialog.close();openUnifiedMaterial(ref,trigger)});return}
  return openUnifiedMaterial(refs[0]||fallback,trigger);
}
async function openManagementMaterial(item,trigger){
  return openManagementReferences(item.scope_references||[],trigger,'选择此范围的准确素材版本',{object_id:item.object_id,defaultSelection:true});
}
async function loadMaterialManagement(){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();const workspace=state.workspace,epoch=++productionLoadEpoch,host=$('#production-view'),params=new URL(location.href).searchParams,memory=managementMemory('materials',params,'material_');++productionReadEpoch;state.productionSelected=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const keys=['episode','scene','media','status','search'];for(const key of keys)memory.filters[key]=params.get('material_'+key)||'';managementScopeMemory(memory,params,'material_');const filters=memory.filters,catalog={episodes:[]};if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;state.productionRecords=[];
  const panel=el('section','production-filters');panel.setAttribute('aria-label','素材管理筛选');const controls=el('div','production-toolbar'),search=el('input');search.type='search';search.placeholder='搜索素材';search.setAttribute('aria-label','搜索素材');search.value=filters.search;controls.append(search);panel.append(controls);const scope=el('div','management-scope-filters'),facets=el('div');panel.append(scope,facets);managementLegacyNotice(panel,memory);host.append(panel);const summary=nodeText('p','production-filter-summary','',host);summary.setAttribute('role','status');const content=el('div','management-card-list');content.setAttribute('aria-label','素材列表');host.append(content);const bottom=el('div');host.append(bottom);let request=0,result=null,timer;
  const clear=productionButton(controls,'清除筛选',()=>{for(const key of [...keys,'scope_revision'])filters[key]='';search.value='';refresh()});search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{filters.search=search.value.trim();refresh()},150)};
  function draw(){
    const sourceGroups=managementMaterialGroups(result,filters,catalog),groups=[...sourceGroups.map(g=>({...g,key:g.key+':results',title:g.title+' · 已有原件',items:g.items.filter(i=>i.generated)})),...sourceGroups.map(g=>({...g,key:g.key+':preparing',title:g.title+' · 尚无结果',items:g.items.filter(i=>!i.generated)}))].filter(g=>g.items.length),page=groupedCardPage(groups,memory.page,memory.rows);memory.page=page.page;content.replaceChildren();
    managementSections(content,page.groups,(list,item)=>{const wrapper=el('div');list.append(wrapper);const button=materialSmallCard(wrapper,item,trigger=>openManagementMaterial(item,trigger),false,{includesHistory:true});button.setAttribute('aria-haspopup','dialog');managementMaterialUses(wrapper,item,memory)});
    if(!result.total)nodeText('p','production-meta','没有符合筛选条件的素材；可清除搜索或调整集场、媒体与结果条件。',content);
    const identityView=!!filters.search&&!filters.episode&&!filters.scene;
    summary.textContent=`${result.items.filter(i=>i.generated).length} 项已有原件可比较；${result.items.filter(i=>!i.generated).length} 项尚无结果。制作准备不要求逐项审阅。`;summary.title=identityView?'按独立素材展示；用途保留在各素材下方':'素材数按唯一素材身份计数；同一素材在不同真实关联分组各展示一次';
    bottom.replaceChildren();reviewPagination(bottom,page,(p,rows)=>{memory.page=p;memory.rows=rows;draw();content.scrollIntoView({block:'start'});bottom.querySelector('[aria-label="每页行数"]')?.focus({preventScroll:true})});managementRoute('material_',memory);
  }
  async function refresh(reset=true){if(reset)memory.page=1;const token=++request;clear.disabled=!Object.values(filters).some(Boolean);try{const data=await api('/api/production/materials?'+new URLSearchParams({...filters,scope:'av',grouped:1,compact:1}));if(token!==request||epoch!==productionLoadEpoch||workspace!==state.workspace)return;result=data;catalog.episodes=result.management_episodes||catalog.episodes;facets.replaceChildren();for(const key of ['media','status']){const options=Object.keys(result.facets[key]).map(value=>[value,value?(key==='media'?productionMediaLabels[value]:value==='generated'?'有结果':'无结果'):'全部']);flatFilterGroup(facets,key,key==='media'?'媒体类型':'生成结果',options,filters[key],result.facets[key],value=>{filters[key]=value;refresh()})}scope.replaceChildren();const locations=result.management_locations||[];managementScopeFilters(scope,filters,catalog,locations,()=>refresh());draw()}catch(error){if(token===request&&epoch===productionLoadEpoch){content.replaceChildren();nodeText('p','production-issue',error.message,content);if(filters.episode||filters.scene||filters.scope_revision)productionButton(content,'重新选择制作范围',()=>{filters.episode='';filters.scene='';filters.scope_revision='';managementScopeRoute(filters);refresh()})}}}
  await refresh(false);if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;const target=params.get('production_object');if(target)await openUnifiedMaterial({object_id:target,revision_id:params.get('production_revision'),params},null);
}
