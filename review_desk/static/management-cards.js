/* Fixed baseline rows; viewport changes only change CSS layout. */
function groupedCardPage(groups,page=1,rowsPerPage=10,columns=4){
  const rows=Math.max(1,Math.trunc(rowsPerPage)||10),totalRows=groups.reduce((n,g)=>n+Math.ceil(g.items.length/columns),0),pages=Math.max(1,Math.ceil(totalRows/rows));
  page=Math.min(pages,Math.max(1,Math.trunc(page)||1));const start=(page-1)*rows,end=start+rows;let offset=0;const visible=[];
  for(const group of groups){const size=Math.ceil(group.items.length/columns),from=Math.max(0,start-offset),to=Math.min(size,end-offset);if(to>from)visible.push({...group,continued:from>0,items:group.items.slice(from*columns,to*columns)});offset+=size}
  return {groups:visible,page,pages,totalRows,rowsPerPage:rows,columns};
}
function reviewPagination(parent,model,change){
  const nav=el('nav','review-pagination');nav.setAttribute('aria-label','列表分页');
  for(const [label,page,disabled] of [['首页',1,model.page===1],['上一页',model.page-1,model.page===1]])productionButton(nav,label,()=>change(page,model.rowsPerPage)).disabled=disabled;
  const status=nodeText('span',null,`第 ${model.page} / ${model.pages} 页`,nav);status.setAttribute('aria-live','polite');
  for(const [label,page,disabled] of [['下一页',model.page+1,model.page===model.pages],['末页',model.pages,model.page===model.pages]])productionButton(nav,label,()=>change(page,model.rowsPerPage)).disabled=disabled;
  const label=el('label');nodeText('span',null,'每页行数',label);const select=el('select');select.setAttribute('aria-label','每页行数');for(const count of [5,10,20,50])select.append(new Option(String(count),String(count)));select.value=String(model.rowsPerPage);select.onchange=()=>change(1,Number(select.value));label.append(select);nav.append(label);
  nodeText('small','pagination-basis',`行数按${model.columns===5?'五':'四'}列计算；窄屏仅重排`,nav);parent.append(nav);return nav;
}
function managementMemory(key,params,prefix){
  state.managementLists||={};if(!state.managementLists[key])state.managementLists[key]={page:Number(params.get(prefix+'page'))||1,rows:Number(params.get(prefix+'rows'))||10,filters:{}};
  // A history/method return is an exact URL, not the last mounted list.
  const memory=state.managementLists[key];memory.page=Number(params.get(prefix+'page'))||1;memory.rows=Number(params.get(prefix+'rows'))||10;if(![5,10,20,50].includes(memory.rows))memory.rows=10;return memory;
}
function managementRoute(prefix,memory){
  breakdownRoute({[prefix+'page']:memory.page,[prefix+'rows']:memory.rows,...Object.fromEntries(Object.entries(memory.filters).filter(([k])=>!['episode','scene','shot','scope_revision'].includes(k)).map(([k,v])=>[prefix+k,v||null]))});managementScopeRoute(memory.filters);breakdownRoute({[prefix+'episode']:null,[prefix+'scene']:null});
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
  if(prefix==='material_')memory.filters.shot=params.get('production_scope_shot')||'';
  memory.legacyScope=params.has(prefix+'episode')||params.has(prefix+'scene');
}
function managementScopeRoute(filters){
  const params=new URL(location.href).searchParams,changed=params.get('production_scope_episode')!==(filters.episode||null)||params.get('production_scope_scene')!==(filters.scene||null)||params.get('production_scope_revision')!==(filters.scope_revision||null);
  breakdownRoute({production_scope_episode:filters.episode||null,production_scope_revision:filters.scope_revision||null,production_scope_scene:filters.scene||null,...('shot' in filters?{production_scope_shot:filters.shot||null}:changed?{production_scope_shot:null}:{})});
}
function managementScopeFilters(parent,filters,catalog,locations,change){
  const episodes=[['','全部集'],...catalog.episodes.map(ep=>[ep.object_id,reviewPositionLabel('episode',ep)])];
  const available=catalog.episodes.filter(ep=>!filters.episode||ep.object_id===filters.episode).flatMap(ep=>(ep.scenes||[]).map(sc=>({ep,sc}))),counts=new Map();
  for(const {sc} of available)counts.set(sc.id,(counts.get(sc.id)||0)+1);
  const choices=available.map(({ep,sc})=>({ep,sc,value:counts.get(sc.id)>1?JSON.stringify([ep.object_id,sc.id]):sc.id,label:(counts.get(sc.id)>1?reviewPositionLabel('episode',ep)+' / ':'')+managementSceneLabel(sc.id,ep.object_id,catalog)}));
  const scenes=[['','全部场'],...choices.map(({value,label})=>[value,label])];
  flatFilterGroup(parent,'episode','视听集',episodes,filters.episode,null,value=>{filters.episode=value;filters.scene='';filters.shot='';filters.scope_revision=catalog.episodes.find(ep=>ep.object_id===value)?.id||'';change()});
  flatFilterGroup(parent,'scene','视听场',scenes,filters.scene,null,value=>{const choice=choices.find(sc=>sc.value===value);filters.scene=choice?.sc.id||'';filters.shot='';if(choice){filters.episode=choice.ep.object_id;filters.scope_revision=choice.ep.id}change()});
  if(filters.scene){const scene=available.find(({ep,sc})=>ep.object_id===filters.episode&&sc.id===filters.scene)?.sc;
    flatFilterGroup(parent,'shot','镜头',[['','全部镜头'],...(scene?.shots||[]).map(row=>[row.object_id,businessTitle(row)])],filters.shot||'',null,value=>{filters.shot=value;change()});
  }
}
function managementLegacyNotice(parent,memory){
  if(memory.legacyScope)nodeText('p','production-issue','此旧链接按源剧本集场定位，可能对应多个视听场。请在上方重新选择视听制作范围。',parent);
}
function entityManagementScopeParams(params=new URL(location.href).searchParams){
  return {...managementScopeParams(params),scope:'shot',scope_shot:params.get('production_scope_shot')||''};
}
function entityScopeRoute(filters,{push=false}={}){
  const url=new URL(location.href),changed=['episode','scope_revision','scene','shot'].some((key,index)=>url.searchParams.get(['production_scope_episode','production_scope_revision','production_scope_scene','production_scope_shot'][index])!==(filters[key]||null));
  if(changed)for(const key of ['production_object','production_revision','production_entity','entity_state','entity_material_tab','material_id','material_version','material_round','material_target','material_baseline','shot_material_id','shot_plan','shot_candidate','shot_baseline','shot_component'])url.searchParams.delete(key);
  for(const [key,value] of Object.entries({production_scope_episode:filters.episode,production_scope_revision:filters.scope_revision,production_scope_scene:filters.scene,production_scope_shot:filters.shot})){
    if(value)url.searchParams.set(key,value);else url.searchParams.delete(key);
  }
  for(const key of ['entity_search','entity_category','entity_page','entity_rows','entity_episode','entity_scene'])url.searchParams.delete(key);
  if(url.href!==location.href)history[push?'pushState':'replaceState'](push?null:history.state,'',url);
}
function entityScopeFilters(parent,filters,catalog,change){
  const episode=catalog.episodes.find(ep=>ep.object_id===filters.episode),scenes=episode?.scenes||[],scene=scenes.find(sc=>sc.id===filters.scene),shots=scene?.shots||[];
  flatFilterGroup(parent,'episode','视听集',catalog.episodes.map(ep=>[ep.object_id,reviewPositionLabel('episode',ep)]),filters.episode,null,value=>{
    if(!value)return;const ep=catalog.episodes.find(ep=>ep.object_id===value),sc=ep?.scenes?.[0];Object.assign(filters,{episode:value,scope_revision:ep?.id||'',scene:sc?.id||'',shot:sc?.shots?.[0]?.object_id||''});change();
  });
  flatFilterGroup(parent,'scene','视听场',scenes.map(sc=>[sc.id,managementSceneLabel(sc.id,filters.episode,catalog)]),filters.scene,null,value=>{
    if(!value)return;const sc=scenes.find(sc=>sc.id===value);Object.assign(filters,{scene:value,shot:sc?.shots?.[0]?.object_id||''});change();
  });
  flatFilterGroup(parent,'shot','镜头',shots.map(row=>[row.object_id,businessTitle(row)]),filters.shot,null,value=>{if(!value)return;filters.shot=value;change()});
}
async function loadEntityManagement(result,{epoch,onReadStart}={}){
  const workspace=state.workspace,host=$('#production-view'),params=new URL(location.href).searchParams;
  const memory=managementMemory('entities',params,'entity_');memory.filters={...result.entity_scope};
  const filters=memory.filters,catalog={episodes:result.management_episodes||[]};let request=0;
  if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;
  rememberProductionDraft();state.productionSelected=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const panel=el('section','production-filters');panel.setAttribute('aria-label','实体管理范围');host.append(panel);
  const summary=nodeText('p','production-filter-summary','',host),content=el('div','management-entity-graph');host.append(content);
  const current=token=>token===request&&epoch===productionLoadEpoch&&workspace===state.workspace;
  function draw(){
    const rows=productionWorkspaceRows(result.records,workspace,result.material_assets);
    state.productionRecords=result.records;state.productionVisibleEntities=new Set(rows.map(row=>row.object_id));
    panel.replaceChildren();entityScopeFilters(panel,filters,catalog,()=>refresh(true));
    summary.textContent=rows.length+' 个实体';content.replaceChildren();
    if(!filters.episode)nodeText('p','production-meta','暂无视听集',content);
    else if(!filters.scene)nodeText('p','production-meta','本集暂无视听场',content);
    else if(!filters.shot)nodeText('p','production-meta','本场暂无镜头',content);
    else{
      const key=JSON.stringify([filters.episode,filters.scope_revision,filters.scene,filters.shot]);
      // A user range change starts a readable view. History reloads may restore it.
      if(memory.activeGraph!==key)memory.graphs={[key]:memory.graphs?.[key]||{}};
      memory.activeGraph=key;memory.graphs||={};memory.graphs[key]||={};
      renderManagementEntityGraph(content,rows,result,memory.graphs[key]);
    }
    entityScopeRoute(filters);
  }
  async function refresh(push=false){
    const token=++request;
    if(push){rememberProductionDraft();memory.graphs={};entityScopeRoute(filters,{push:true});}
    panel.replaceChildren();entityScopeFilters(panel,filters,catalog,()=>refresh(true));
    state.productionVisibleEntities=new Set();summary.textContent='正在读取实体…';content.replaceChildren();
    try{
      const data=await api('/api/production/index?'+new URLSearchParams({view:'settings',...entityManagementScopeParams()}));
      if(!current(token))return;result=data;catalog.episodes=data.management_episodes||[];Object.assign(filters,data.entity_scope);draw();
    }catch(error){
      if(!current(token))return;summary.textContent='实体读取失败';content.replaceChildren();nodeText('p','production-issue',error.message,content);productionButton(content,'重新读取列表',()=>refresh());
    }
  }
  state.refreshEntityIndex=()=>refresh();draw();
  const target=params.get('production_object')||params.get('production_entity');if(target){onReadStart?.({workspace,loadEpoch:epoch,readEpoch:productionReadEpoch});await openUnifiedMaterial({object_id:target,revision_id:params.get('production_revision'),params,restoreRoute:true},null)}
}
function readableSearchMatches(query,terms){
  const normalized=value=>String(value||'').normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' '),needle=normalized(query);
  return !needle||( /^(?:m|en|st|ash|as|ae)\d+$/u.test(needle)?terms.some(term=>normalized(term)===needle):terms.some(term=>normalized(term).includes(needle)));
}
function managementMaterialGroups(result){
  const unique=new Map();
  for(const item of result.items){
    const id=item.canonical_material_id||item.object_id;
    if(!unique.has(id))unique.set(id,item);
  }
  const options=result.material_categories?.flatMap(group=>group.categories);
  const types=options?options.map(item=>item.key):['image','audio','video','project','document'];
  const labels=options?Object.fromEntries(options.map(item=>[item.key,item.label])):{image:'图像',audio:'声音',video:'视频',project:'工程',document:'文档'};
  const groups=new Map(types.map(type=>[type,{key:type,title:labels[type],items:[]}]))
  for(const item of unique.values()){
    const type=options?item.material_category:item.media_type;
    if(!groups.has(type))throw new Error('素材分类未明确：'+(item.business_code||item.object_id));
    groups.get(type).items.push(item);
  }
  const code=item=>item.business_code||businessCode(item);
  for(const group of groups.values())group.items.sort((a,b)=>Number(!!b.generated)-Number(!!a.generated)||code(a).localeCompare(code(b),undefined,{numeric:true})||(a.canonical_material_id||a.object_id).localeCompare(b.canonical_material_id||b.object_id));
  return [...groups.values()].filter(group=>group.items.length);
}
function entitySmallCard(parent,row,{stateCount=0,materialCount=0,preview=null,references=[]}={}){
  const button=reviewSmallCard(parent,{title:row.kind==='AV_SHOT'?breakdownShotTitle(row).replace(/^ASH\d+ · /,''):row.payload.title,business_code:businessCode(row),icon:row.entity_type||row.payload.entity_type,preview,subtitle:`状态 ${stateCount} 个 · 素材 ${materialCount} 个`},trigger=>openManagementReferences(references,trigger,'选择此范围的准确实体版本',{object_id:row.object_id,defaultSelection:true}));button.classList.add('entity-small-card');button.dataset.objectId=row.object_id;button.dataset.entityType=row.entity_type||row.payload.entity_type;button.setAttribute('aria-haspopup','dialog');return button;
}
async function openManagementReferences(refs,trigger,title,fallback){
  if(refs.length>1){const {dialog,body}=openReviewDialog(title,trigger,'material-reference-dialog');for(const ref of refs)productionButton(body,ref.title+' · 记录修订 '+ref.version+(ref.use?' · '+({actual_input:'真实调用',planned_input:'计划拟用',alternative:'备选',mounted:'本场需求',applicability:'适用'}[ref.use]||'准确用途'):''),()=>{dialog.close();openUnifiedMaterial(ref,trigger)});return}
  return openUnifiedMaterial(refs[0]||fallback,trigger);
}
async function openManagementMaterial(item,trigger){
  return openUnifiedMaterial({object_id:item.canonical_material_id||item.object_id,defaultSelection:true},trigger);
}
function materialCategoryFilters(parent,families,selected,counts,onchange){
  const icons={'':'all',image:'image','character-image':'character','scene-image':'space','prop-image':'prop','shot-image':'shot',audio:'sound',voice:'voice','scene-sound':'scene-sound',song:'song',video:'video','text-layer':'text-layer'};
  const options=[['','全部']],segments=[];
  for(const family of families){const values=[[family.key,family.label],...family.categories.filter(item=>item.key!==family.key).map(item=>[item.key,item.label])];options.push(...values);segments.push({family,values})}
  const row=flatFilterGroup(parent,'media','素材分类',options,selected,counts,onchange,{iconFor:value=>icons[value]});row.classList.add('material-category-filter');
  const choices=row.querySelector('.production-filter-options'),buttons=[...choices.children];choices.replaceChildren(buttons[0]);let offset=1;
  for(const {family,values} of segments){
    const items=buttons.slice(offset,offset+values.length);offset+=values.length;
    if(items.length===1){choices.append(items[0]);continue}
    const group=el('div','material-category-family');group.setAttribute('role','group');group.setAttribute('aria-label',family.label);
    const boundary=el('div','material-category-parent'),children=el('div','material-category-children');boundary.append(items[0]);children.append(...items.slice(1));group.append(boundary,children);choices.append(group);
  }
}
async function loadMaterialManagement(){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();const workspace=state.workspace,epoch=++productionLoadEpoch,host=$('#production-view'),params=new URL(location.href).searchParams,memory=managementMemory('materials',params,'material_');++productionReadEpoch;state.productionSelected=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const keys=['episode','scene','shot','media','status','search'];for(const key of keys)memory.filters[key]=params.get('material_'+key)||'';managementScopeMemory(memory,params,'material_');const filters=memory.filters,catalog={episodes:[]};if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;state.productionRecords=[];
  const panel=el('section','production-filters');panel.setAttribute('aria-label','素材管理筛选');const controls=el('div','production-toolbar'),search=el('input');search.type='search';search.placeholder='搜索素材';search.setAttribute('aria-label','搜索素材');search.value=filters.search;controls.append(search);panel.append(controls);const scope=el('div','management-scope-filters'),facets=el('div');panel.append(facets,scope);managementLegacyNotice(panel,memory);host.append(panel);const summary=nodeText('p','production-filter-summary','',host);summary.setAttribute('role','status');const content=el('div','management-card-list');content.setAttribute('aria-label','素材列表');content.classList.add('material-management-list');host.append(content);const bottom=el('div');host.append(bottom);let request=0,result=null,timer;
  const clear=productionButton(controls,'清除筛选',()=>{for(const key of [...keys,'scope_revision'])filters[key]='';search.value='';refresh()});search.oninput=()=>{++request;clearTimeout(timer);timer=setTimeout(()=>{filters.search=search.value.trim();refresh()},150)};
  function draw(){
    const groups=managementMaterialGroups(result),items=groups.flatMap(group=>group.items),page=groupedCardPage(groups,memory.page,memory.rows,5);memory.page=page.page;content.replaceChildren();
    managementSections(content,page.groups,(list,item)=>{const button=materialSmallCard(list,item,trigger=>openManagementMaterial(item,trigger),false,{includesHistory:true});button.setAttribute('aria-haspopup','dialog')});
    if(!items.length)nodeText('p','production-meta','没有符合筛选条件的素材；可清除搜索或调整集场镜、素材分类与结果条件。',content);
    summary.textContent=`${items.length} 项素材；${items.filter(i=>i.generated).length} 项有结果，${items.filter(i=>!i.generated).length} 项无结果。`;summary.title='按唯一素材身份计数；有结果依据真实候选或原件，不表示人工认可';
    bottom.replaceChildren();reviewPagination(bottom,page,(p,rows)=>{memory.page=p;memory.rows=rows;draw();content.scrollIntoView({block:'start'});bottom.querySelector('[aria-label="每页行数"]')?.focus({preventScroll:true})});managementRoute('material_',memory);
  }
  async function refresh(reset=true){if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;if(reset)memory.page=1;const token=++request;managementRoute('material_',memory);summary.textContent='正在读取素材…';bottom.replaceChildren();content.replaceChildren();clear.disabled=!Object.values(filters).some(Boolean);try{const data=await api('/api/production/materials?'+new URLSearchParams({...filters,scope:'av',grouped:1,compact:1,cards:1}));if(token!==request||epoch!==productionLoadEpoch||workspace!==state.workspace)return;result=data;catalog.episodes=result.management_episodes||catalog.episodes;facets.replaceChildren();if(result.material_categories){
      if(filters.media==='project')filters.media='text-layer';
      materialCategoryFilters(facets,result.material_categories,filters.media,result.facets.media,value=>{filters.media=value;refresh()});
    }else{const options=Object.keys(result.facets.media).map(value=>[value,value?(productionMediaLabels[value]||value):'全部']);flatFilterGroup(facets,'media','素材分类',options,filters.media,result.facets.media,value=>{filters.media=value;refresh()})}
    const statuses=[['','全部'],['generated','有结果'],['ungenerated','无结果']];flatFilterGroup(facets,'status','生成结果',statuses,filters.status,result.facets.status,value=>{filters.status=value;refresh()});scope.replaceChildren();const locations=result.management_locations||[];managementScopeFilters(scope,filters,catalog,locations,()=>refresh());draw()}catch(error){if(token===request&&epoch===productionLoadEpoch&&workspace===state.workspace){summary.textContent='素材读取失败';content.replaceChildren();nodeText('p','production-issue',error.message,content);productionButton(content,'重新读取列表',()=>refresh(false));if(filters.episode||filters.scene||filters.shot||filters.scope_revision)productionButton(content,'重新选择制作范围',()=>{filters.episode='';filters.scene='';filters.shot='';filters.scope_revision='';managementScopeRoute(filters);refresh()})}}}
  await refresh(false);if(epoch!==productionLoadEpoch||workspace!==state.workspace)return;const target=params.get('production_object');if(target)await openUnifiedMaterial({object_id:target,revision_id:params.get('production_revision'),params,restoreRoute:true},null);
}
