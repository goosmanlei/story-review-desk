function businessCode(row){if(['SOURCE','STORY'].includes(row?.kind))return '';return row?.material_code||row?.business_code||(typeof state==='undefined'?null:state.businessCodes)?.get(row?.object_id||row?.id)||''}
function businessTitle(row,title=row?.payload?.title||row?.title||''){
  if(['SOURCE','STORY'].includes(row?.kind))return String(title);
  const code=businessCode(row),raw=row?.kind==='AV_SHOT'&&!code?String(title):readableProductionTitle(row,title);
  // A shot's stored local prefix is a legacy position, not a second identity.
  const positioned=row?.kind==='AV_SHOT'&&code?raw.replace(/^E\d+-\d+\s*/u,''):row?.business_scene_id?raw.replace(/^\d+-\d+\s*/,(row.business_scene_code||reviewPositionLabel('scene',row.business_scene_id))+' · '):raw;
  const text=reviewPositionText(positioned);
  if(!code||text===code||text.startsWith(code+' · '))return text;
  return code+' · '+(text.startsWith(code+' ')?text.slice(code.length).trim():text);
}
function readableProductionTitle(row,title=row?.payload?.title||row?.title||''){
  const raw=String(title).replace(/完整形态/gu,'实体状态'),scope=row?.payload?.scope||row?.scope;
  const sourceCode=(typeof state==='undefined'?null:state.businessCodes)?.get(scope?.object_id)||'';
  if(row?.kind==='AV_SHOT')return raw.replace(/^(?:E\d+-\d+\s*|\d+\s*·\s*A\d+\s*·\s*\d+\s+)/iu,'');
  if(sourceCode.startsWith('ASH'))return raw.replace(/\b\d+\s*·\s*A\d+\s*·\s*\d+\s+/u,sourceCode+' · ');
  return raw;
}
function renderBusinessCodeCatalog(root){
  const catalog=state.businessCodeCatalog;nodeText('p',null,catalog.allocation,root);
  const table=el('table','business-code-table'),head=el('tr');for(const title of ['类型','前缀','示例','唯一性范围'])nodeText('th',null,title,head);table.append(head);
  for(const entry of catalog.types){const row=el('tr');for(const key of ['type','prefix','example','scope'])nodeText('td',null,entry[key],row);table.append(row)}root.append(table);nodeText('p','production-meta',catalog.excluded,root);return renderDataModel(root);
}
/* View labels and tabs share the existing workspace/URL routing contract. */
function reviewPositionLabel(kind,value,episode=null){
  const prefix=({AV_EPISODE:'AE',AV_SCENE:'AS',AV_SHOT:'ASH'})[value?.kind]||({episode:'E',E:'E',EPISODE:'E',scene:'S',S:'S',AV_SCENE:'AS',shot:'SH',SH:'SH',AV_SHOT:'ASH'})[kind];
  if(!prefix)return String(value??'');
  if(value&&typeof value==='object'){const code=businessCode(value);if(code.startsWith(prefix)&&/^\d+$/.test(code.slice(prefix.length)))return code}
  if(prefix==='S'&&episode){const id=typeof episode==='string'?episode:episode.object_id||episode.id,scene=typeof value==='object'?value.id:value;const code=(typeof state==='undefined'?null:state.businessCodes)?.get('scene:'+id+':'+scene);if(code)return code}
  const raw=value&&typeof value==='object'?(value.payload?.number??value.number??value.payload?.episode_number??value.payload?.shot_number??value.scene_id??value.id):value;
  const text=String(raw??'').trim(),match=text.match(/^(?:E|S|SH)?0*(\d+)$/iu)||text.match(/^第\s*0*(\d+)\s*[集场鏡镜]$/u);
  if(match&&typeof state!=='undefined'&&state.businessCodes)return '第'+Number(match[1])+({E:'集',AE:'集',S:'场',AS:'场',SH:'镜',ASH:'镜'})[prefix];
  return match?prefix+match[1].padStart(prefix==='E'?2:3,'0'):text;
}
function reviewPositionText(value){
  const globalCodes=typeof state!=='undefined'&&state.businessCodes;
  const text=String(value??'').replace(/\bE(\d+)-(\d+)\b/giu,(_all,episode,shot)=>(typeof state==='undefined'?null:state.legacyShotCodes)?.get('E'+Number(episode)+'-'+Number(shot))||(globalCodes?`第${Number(episode)}集第${Number(shot)}镜`:reviewPositionLabel('episode',episode)+' / '+reviewPositionLabel('shot',shot)));
  // Prose numbers are positions, not allocated identities. Only an exact
  // legacy shot mapping may convert an old generated title to a global code.
  if(globalCodes)return text;
  return text.replace(/第\s*(\d+)\s*([集场镜])/gu,(_all,number,unit)=>reviewPositionLabel(({集:'E',场:'S',镜:'SH'})[unit],number))
    .replace(/\b(SH|E|S)0*(\d+)\b/giu,(_all,prefix,number)=>reviewPositionLabel(prefix.toUpperCase(),number));
}
const workspaceRoutes=new Map(),workspaceSubRoutes=new Map();
const workspacePositionSelectors=['#source-view','#source-list','#novel-index','#structure-reader','#structure-index','#screenplay-reader','#screenplay-scene-index','#production-reader','#production-index','.breakdown-body','.breakdown-scene-list','#approach-index','.skill-flow','.skill-file-tree'];
const workspacePositions=new Map();
// Per history entry, never shared storage: a new tab opens the link's target
// without inheriting another tab's last production selection.
function workspaceNavigationScope(){return [new URL(location.href).origin,typeof reviewURL==='function'?reviewURL('/'):'/',globalThis.REVIEW_DEPLOYMENT?.publication_id||'',typeof state==='undefined'?'':state.navigationInstanceId||''].join('|')}
function workspaceNavigationState(){
  const urls=new Set([...workspaceRoutes.values(),...workspaceSubRoutes.values(),location.href]);
  return {scope:workspaceNavigationScope(),routes:[...workspaceRoutes],subRoutes:[...workspaceSubRoutes],positions:[...workspacePositions].filter(([url])=>urls.has(url))};
}
function saveWorkspaceNavigation(){
  try{history.replaceState({...history.state,workspaceNavigation:workspaceNavigationState()},'',location.href)}catch{}
}
function restoreWorkspaceNavigation(){
  workspaceRoutes.clear();workspaceSubRoutes.clear();workspacePositions.clear();
  if(typeof history==='undefined')return;
  const saved=history.state?.workspaceNavigation;
  if(saved?.scope!==workspaceNavigationScope())return;
  for(const [map,entries] of [[workspaceRoutes,saved.routes],[workspaceSubRoutes,saved.subRoutes],[workspacePositions,saved.positions]]){
    if(!Array.isArray(entries))continue;
    for(const pair of entries){
      if(!Array.isArray(pair)||pair.length!==2)continue;
      const url=map===workspacePositions?pair[0]:pair[1];
      try{const parsed=new URL(url);if(parsed.origin!==new URL(location.href).origin||parsed.pathname!==(typeof reviewURL==='function'?reviewURL('/'):'/'))continue}catch{continue}
      map.set(pair[0],pair[1]);
    }
  }
}
function pushWorkspaceNavigation(url){history.pushState({workspaceNavigation:workspaceNavigationState()},'',url)}
function navigateApproachLink(target){
  rememberWorkspacePosition();rememberWorkspaceRoute();
  if(target.href!==location.href)pushWorkspaceNavigation(target);
  switchWorkspace('production.approach',false);
}
function workspaceGroup(id){return ['story.sources','story.outline','story.novel','story.script'].includes(id)?'story.sources':['settings.workspace','materials.workspace','production.workspace'].includes(id)?'settings.workspace':id}
function normalizeProductionWorkspace(id){
  const url=new URL(location.href),p=url.searchParams;
  if(id==='production.workspace'||id==='settings.workspace'&&p.get('production_tab')==='shots'){
    id='settings.workspace';p.set('workspace',id);
    if(p.get('production_tab')!=='history')p.set('production_tab','breakdown');
    history.replaceState(history.state,'',url);
  }
  return id;
}
function productionScopeKey(params){return JSON.stringify(['production_scope_episode','production_scope_revision','production_scope_scene','production_scope_shot'].map(key=>params.get(key)||''))}
function productionWorkingScopeKey(params){
  if(params.get('production_scope_episode')||params.get('workspace')!=='materials.workspace')return productionScopeKey(params);
  return JSON.stringify(['breakdown_episode','breakdown_episode_revision','breakdown_scene','breakdown_object'].map(key=>params.get(key)||''));
}
function rememberWorkspaceRoute(){
  const url=new URL(location.href),id=url.searchParams.get('workspace')||'production.approach';
  if(typeof state==='undefined'||id!==state.workspace)return;
  workspaceRoutes.set(workspaceGroup(id),url.href);
  if(['settings.workspace','materials.workspace','production.workspace'].includes(id)&&typeof productionTab==='function'){const key=workspaceGroup(id)+':'+productionTab();workspaceSubRoutes.set(key,url.href);workspaceSubRoutes.set(key+':'+productionScopeKey(url.searchParams),url.href);}
  if(id==='production.approach'){const tab=url.searchParams.get('tab');if(tab)workspaceSubRoutes.set('production.approach:'+tab,url.href);}
  saveWorkspaceNavigation();
}
function rememberWorkspacePosition(){
  if(typeof rememberSourceReadingPosition==='function')rememberSourceReadingPosition();
  const offsets={};
  for(const selector of workspacePositionSelectors){const node=document.querySelector(selector);if(node)offsets[selector]=[node.scrollLeft||0,node.scrollTop||0]}
  workspacePositions.set(location.href,{window:[window.scrollX||0,window.scrollY||0],offsets});
  saveWorkspaceNavigation();
  try{sessionStorage.setItem('review-view-position',JSON.stringify({url:location.href,position:workspacePositions.get(location.href)}))}catch{}
}
function restoreWorkspacePosition(){
  const href=location.href;
  const sourceGuard=typeof state!=='undefined'&&['story.sources','story.novel'].includes(state.workspace)&&typeof sourceReadingRestoreGuard==='function'?sourceReadingRestoreGuard():null;
  let position=workspacePositions.get(href);
  if(!position){try{const saved=JSON.parse(sessionStorage.getItem('review-view-position')||'null');if(saved?.url===href)position=saved.position}catch{}}
  if(!position)return;
  requestAnimationFrame(()=>{
    if(location.href!==href||sourceGuard&&!sourceGuard())return;
    for(const [selector,offset] of Object.entries(position.offsets||{})){const node=document.querySelector(selector);if(node){node.scrollLeft=Number(offset[0])||0;node.scrollTop=Number(offset[1])||0}}
    window.scrollTo(Number(position.window?.[0])||0,Number(position.window?.[1])||0);
  });
}
function navigateWorkspace(id){
  rememberWorkspacePosition();rememberWorkspaceRoute();
  const group=workspaceGroup(id),saved=workspaceRoutes.get(group);
  if(saved){
    const url=new URL(saved);if(url.href===location.href&&workspaceGroup(state.workspace)===group)return;if(url.href!==location.href)pushWorkspaceNavigation(url);
    switchWorkspace(url.searchParams.get('workspace')||id,false);
  }else{
    if(['settings.workspace','production.workspace'].includes(id)){
      const url=new URL(location.href),p=url.searchParams,tab=p.get('production_tab');
      const scoped=p.get('production_scope_episode')&&p.get('production_scope_revision');
      const allMaterials=tab==='materials'&&p.get('breakdown_episode')&&p.get('breakdown_episode_revision');
      if(['entities','materials','breakdown'].includes(tab)&&(scoped||allMaterials)){
        id=tab==='materials'?'materials.workspace':'settings.workspace';p.set('workspace',id);
        pushWorkspaceNavigation(url);switchWorkspace(id,false);return;
      }
      id='settings.workspace';url.searchParams.set('workspace',id);url.searchParams.set('production_tab','breakdown');
      for(const key of ['production_object','production_revision','production_entity','entity_state','entity_material_tab','material_id','material_version','material_round','material_target','material_baseline'])url.searchParams.delete(key);
      url.hash='';history.pushState(null,'',url);switchWorkspace(id,false);
    }else switchWorkspace(id);
  }
}
function configurationSectionFromRoute(){const section=new URL(location.href).searchParams.get('config_section');return ['SYSTEM','METHODS','CODES'].includes(section)?section:'PROJECT'}
function selectConfigurationSection(section){
  const url=new URL(location.href);url.searchParams.set('workspace','project.configuration');url.searchParams.set('config_section',['SYSTEM','METHODS','CODES'].includes(section)?section:'PROJECT');
  if(url.href!==location.href)history.pushState(null,'',url);
  state.configSection=configurationSectionFromRoute();renderConfigurations({preserve:true});renderWorkspaceTabs();
}
function selectProductionTab(tab){
  if(tab===productionTab())return;
  const source=new URL(location.href);
  rememberWorkspacePosition();rememberWorkspaceRoute();
  // The all-materials range has no filter scope. Its last working shot still
  // lives in the existing breakdown route and may continue in the other pages.
  if(productionTab()==='materials'&&!source.searchParams.get('production_scope_episode')){
    for(const [scope,working] of [['production_scope_episode','breakdown_episode'],['production_scope_revision','breakdown_episode_revision'],['production_scope_scene','breakdown_scene'],['production_scope_shot','breakdown_object']]){
      const value=source.searchParams.get(working);if(value)source.searchParams.set(scope,value);
    }
  }
  const workspace=tab==='materials'?'materials.workspace':'settings.workspace';
  const routeKey=workspaceGroup(workspace)+':'+tab;
  const saved=workspaceSubRoutes.get(routeKey+':'+productionScopeKey(source.searchParams))||workspaceSubRoutes.get(routeKey);
  const url=new URL(saved||location.href),sameScope=!!saved&&productionWorkingScopeKey(url.searchParams)===productionWorkingScopeKey(source.searchParams)&&!(tab==='materials'&&url.searchParams.get('production_scope_episode'));
  // Ordinary tab navigation starts at the full material library. Explicit
  // links, reloads and browser history bypass this entry and keep their scope.
  const allMaterials=tab==='materials';
  if(allMaterials&&(url.searchParams.get('production_scope_episode')||url.searchParams.get('production_scope_scene')||url.searchParams.get('production_scope_shot')))url.searchParams.set('material_page','1');
  for(const key of ['production_scope_episode','production_scope_revision','production_scope_scene','production_scope_shot']){
    const value=source.searchParams.get(key);if(value&&!allMaterials)url.searchParams.set(key,value);else url.searchParams.delete(key);
  }
  if(allMaterials)for(const [scope,working] of [['production_scope_episode','breakdown_episode'],['production_scope_revision','breakdown_episode_revision'],['production_scope_scene','breakdown_scene'],['production_scope_shot','breakdown_object']]){
    const value=source.searchParams.get(scope);if(value)url.searchParams.set(working,value);else url.searchParams.delete(working);
  }
  if(allMaterials&&!sameScope)url.searchParams.delete('breakdown_revision');
  url.searchParams.set('workspace',workspace);url.searchParams.set('production_tab',tab);
  if(!sameScope)for(const key of ['production_object','production_revision','production_entity','entity_state','entity_material_tab','material_id','material_version','material_round','material_target','material_baseline','shot_material_id','shot_plan','shot_candidate','shot_baseline','shot_component'])url.searchParams.delete(key);
  if(tab==='breakdown'&&source.searchParams.get('production_scope_episode')){
    const p=source.searchParams,shot=p.get('production_scope_shot');
    const same=sameScope&&url.searchParams.get('breakdown_episode_revision')===p.get('production_scope_revision')&&url.searchParams.get('breakdown_scene')===p.get('production_scope_scene')&&url.searchParams.get('breakdown_episode')===p.get('production_scope_episode')&&(!shot||url.searchParams.get('breakdown_object')===shot);
    if(!same){
      for(const key of ['shot_material_id','shot_plan','shot_candidate','shot_baseline','shot_component'])url.searchParams.delete(key);
      url.searchParams.set('breakdown_episode_revision',p.get('production_scope_revision')||'');url.searchParams.set('breakdown_episode',p.get('production_scope_episode'));url.searchParams.set('breakdown_scene',p.get('production_scope_scene')||'');url.searchParams.set('breakdown_object',shot||p.get('production_scope_episode'));
      if(shot)url.searchParams.delete('breakdown_revision');else url.searchParams.set('breakdown_revision',p.get('production_scope_revision')||'');
    }
  }
  url.hash='';if(url.href!==location.href)pushWorkspaceNavigation(url);switchWorkspace(workspace,false);
}
function workspaceTabItems(){
  const workspace=state.workspace;
  if(workspace==='production.approach'){
    const tabs=typeof approachTabs==='function'?approachTabs():[{id:'story',label:'故事创作'},{id:'materials',label:'生产制作'}];
    const params=new URL(location.href).searchParams,active=(typeof approachSelectedTab==='function'?approachSelectedTab(params):(tabs.find(tab=>tab.id===params.get('tab'))||tabs[0])).id;
    return tabs.map(({id,label})=>({id:'approach-tab-'+id,label,active:id===active,controls:'approach-body',open:()=>selectApproachTab(id)}));
  }
  if(['story.sources','story.outline','story.novel','story.script'].includes(workspace))return [
    ['story.sources','open-story-sources','故事采编','story-workspace'],['story.outline','open-story-structure','故事结构','structure-workspace'],['story.novel','open-story-novel','小说创作','story-workspace'],['story.script','open-story-script','故事剧本','screenplay-workspace']
  ].map(([value,id,label,controls])=>({id,label,controls,active:value===workspace,open:()=>{rememberWorkspacePosition();switchWorkspace(value)}}));
  if(workspace==='project.configuration')return [['PROJECT','故事项目'],['SYSTEM','系统与 AI']].map(([value,label])=>({id:'configuration-tab-'+value,label,controls:'configuration-view',active:value===configurationSectionFromRoute(),open:()=>selectConfigurationSection(value)}));
  if(['settings.workspace','materials.workspace','production.workspace'].includes(workspace)){
    const options=[['breakdown','视听制作'],['entities','实体管理'],['materials','素材管理']];
    return options.map(([value,label])=>({id:'production-tab-'+value,label,controls:'production-view',active:value===productionTab(),open:()=>selectProductionTab(value)}));
  }
  return [];
}
function renderWorkspaceTabs(){
  renderPageHeading();
  const root=document.querySelector('#workspace-subnav');if(!root)return;
  const focused=root.contains(document.activeElement)?document.activeElement.id:null,scroll=root.scrollLeft;
  root.replaceChildren();root.setAttribute('aria-label',({'production.approach':'制作思路','story.sources':'故事创作','settings.workspace':'生产制作','project.configuration':'系统管理'})[workspaceGroup(state.workspace)]+'子页面');
  const items=workspaceTabItems();
  for(const item of items){
    const button=nodeText('button','workspace-subtab'+(item.active?' active':''),item.label,root);button.type='button';button.id=item.id;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(item.active));button.setAttribute('aria-controls',item.controls);button.tabIndex=item.active?0:-1;
    button.onclick=()=>{if(!item.active)item.open()};
    button.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const current=items.indexOf(item),index=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowRight'?1:-1)+items.length)%items.length,next=items[index];
      if(!next.active)next.open();document.getElementById(next.id)?.focus({preventScroll:true});document.getElementById(next.id)?.scrollIntoView({block:'nearest',inline:'nearest'});
    };
  }
  root.scrollLeft=scroll;
  if(focused)document.getElementById(focused)?.focus({preventScroll:true});
}
function workspacePageDescriptor(workspace,params){
  if(workspace==='production.approach'){
    const tab=typeof approachSelectedTab==='function'?approachSelectedTab(params):null;
    if(tab?.sections?.some(section=>section.diagram?.type==='workflow'))return ['制作思路',tab.label,''];
    if(tab&&!['story','materials'].includes(tab.id))return ['制作思路',tab.label,''];
    return (tab?.id||params.get('tab'))==='materials'
      ?['从故事到影像','生产制作方法','了解定稿、素材准备、镜头制作与组合交付之间的输入、产物和检查条件。']
      :['从资料到故事','故事创作方法','了解采编、结构、小说与剧本的创作步骤，以及审阅意见如何推动修订。'];
  }
  const story={
    'story.sources':['SOURCE EVIDENCE','故事采编','阅读原始依据与整理稿，核对出处和版本；圈选原文提出审阅意见。'],
    'story.outline':['STORY STRUCTURE','故事结构','按稿次阅读人物、关系与故事线，结合图文审阅整体设计。'],
    'story.novel':['NOVEL WRITING','小说创作','按版本与章节阅读小说，圈选正文提出意见并复核修订。'],
    'story.script':['STORY → SCREENPLAY','剧本集场阅读与审阅','按版本、分集、场次阅读完整剧本并评论；预计时长是制作估算。']
  };if(story[workspace])return story[workspace];
  if(workspace==='project.configuration')return ({
    PROJECT:['STORY PROJECT','故事项目配置','设置本故事的创作阶段、背景与表达目标，为审阅和评论润色提供依据。'],
    SYSTEM:['SYSTEM & AI','系统与 AI','管理站点图标与评论润色选项；修改后统一保存配置。'],
    METHODS:['SKILL MANAGEMENT','SKILL管理','沿基础流程阅读方法、比较文件变化并提出意见。'],
    CODES:['DATA MODEL','数据模型','查阅编号，理解故事、制作、素材与方法之间的关系。']
  })[params.get('config_section')]||['STORY PROJECT','故事项目配置','设置本故事的创作阶段、背景与表达目标，为审阅和评论润色提供依据。'];
  if(params.get('production_tab')==='history')return ['页面不可用','页面已退役','此旧页面已移除，请从生产制作选择当前工作入口。'];
  const tab=workspace==='materials.workspace'?'materials':workspace==='production.workspace'||params.get('production_tab')==='shots'?'breakdown':(params.get('production_tab')||((params.has('production_entity')||params.has('entity_state'))?'entities':'breakdown'));
  return ({
    breakdown:['STORY → PRODUCTION','视听制作','按视听集、场、镜阅读设计，审阅各项素材方案与准确候选。'],
    entities:['ENTITIES & STATES','实体管理','按集场镜查看实体关系，打开实体与镜头审阅其素材。'],
    materials:['MATERIAL LIBRARY','素材管理','按素材分类浏览素材，筛选集场镜与结果，打开当前方案与真实候选。']
  })[tab]||['STORY REVIEW DESK','故事审阅台','选择页面，阅读并审阅当前故事实例。'];
}
function renderPageHeading(){
  const parts=workspacePageDescriptor(state.workspace,new URL(location.href).searchParams);
  for(const [index,id] of ['page-marker','page-title','page-purpose'].entries()){const node=document.getElementById(id);if(node)node.textContent=parts[index]}
}
if(typeof window!=='undefined')window.addEventListener?.('pagehide',()=>{rememberWorkspacePosition();rememberWorkspaceRoute()});

let modelGraphObserver=null;
async function renderDataModel(root){
 modelGraphObserver?.disconnect();
 const host=el('section','data-model');root.append(host);const notice=nodeText('p',null,'正在读取数据模型…',host);
 try{const data=await api('/api/data-model');if(!host.isConnected)return;host.replaceChildren();if(!data)return;
  nodeText('h2',null,data.title,host);nodeText('p','model-lead',data.lead,host);
  const redraw=[],allNodes=new Map(data.diagrams.flatMap(d=>d.nodes).map(n=>[n.id,n]));
  for(const diagram of data.diagrams){const figure=el('figure','model-diagram');nodeText('figcaption',null,diagram.title,figure);host.append(figure);
   const graph=el('div','model-graph');figure.append(graph);const nodes=new Map(diagram.nodes.map(n=>[n.id,n])),elements=new Map();
   const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('model-lines');svg.setAttribute('aria-hidden','true');graph.append(svg);
   const defs=document.createElementNS(svg.namespaceURI,'defs'),marker=document.createElementNS(svg.namespaceURI,'marker'),tip=document.createElementNS(svg.namespaceURI,'path');const markerId='model-arrow-'+diagram.nodes[0].id;
   for(const [k,v]of Object.entries({id:markerId,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'}))marker.setAttribute(k,v);tip.setAttribute('d','M1 1L9 5L1 9');marker.append(tip);defs.append(marker);svg.append(defs);
   for(const group of diagram.groups){const area=el('section','model-group');graph.append(area);if(group.title)nodeText('h3','model-group-title',group.title,area);
    for(const row of group.rows){const line=el('div','model-row');line.style.setProperty('--model-columns',row.length);area.append(line);
     for(const id of row){const value=nodes.get(id),card=el('div','model-node');card.id='model-'+id;card.tabIndex=-1;nodeText('h4',null,value.title,card);nodeText('p',null,value.text,card);line.append(card);elements.set(id,card);
      if(value.version||value.comments){const properties=el('dl','model-properties');card.append(properties);for(const [label,text]of [['版本',value.version],['评论',value.comments]])if(text){nodeText('dt',null,label,properties);nodeText('dd',null,text,properties)}}
      if(value.related?.length){const related=el('ul','model-related');card.append(related);for(const ref of value.related){const item=el('li');nodeText('span',null,ref.label+' → ',item);const link=nodeText('a',null,allNodes.get(ref.to).title,item);link.href='#model-'+ref.to;link.onclick=event=>{event.preventDefault();const target=elements.get(ref.to)||document.getElementById('model-'+ref.to);target?.focus({preventScroll:true});target?.scrollIntoView({block:'start',behavior:'instant'})};related.append(item)}}
      const links=el('ul','model-mobile-links');for(const edge of diagram.connections.filter(e=>e.from===id)){const item=el('li');nodeText('span',null,(edge.style==='dashed'?'⇢ ':'→ ')+edge.label+' · '+nodes.get(edge.to).title,item);links.append(item)}card.append(links);
     }
    }
   }
   const paths=diagram.connections.map(edge=>{const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('marker-end','url(#'+markerId+')');if(edge.style==='dashed')path.setAttribute('stroke-dasharray','5 5');svg.append(path);const label=nodeText('span','model-edge-label',edge.label,graph);return {edge,path,label}});
   redraw.push(()=>{const bounds=graph.getBoundingClientRect();svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);
    for(const {edge,path,label}of paths){const a=elements.get(edge.from).getBoundingClientRect(),b=elements.get(edge.to).getBoundingClientRect();let x1,y1,x2,y2,d,lx,ly;
     if(Math.abs(a.top-b.top)<5){const right=a.left<b.left;x1=(right?a.right:a.left)-bounds.left;y1=(a.top+a.bottom)/2-bounds.top;x2=(right?b.left:b.right)-bounds.left;y2=(b.top+b.bottom)/2-bounds.top;d=`M${x1} ${y1}L${x2} ${y2}`;lx=(x1+x2)/2;ly=(y1+y2)/2}
     else{x1=(a.left+a.right)/2-bounds.left;y1=a.bottom-bounds.top;x2=(b.left+b.right)/2-bounds.left;y2=b.top-bounds.top;const mid=(y1+y2)/2;d=`M${x1} ${y1}V${mid}H${x2}V${y2}`;lx=(x1+x2)/2;ly=mid}
     path.setAttribute('d',d);label.style.left=lx+'px';label.style.top=ly+'px';
    }
   });
   if(diagram.note)nodeText('p','model-note',diagram.note,figure);
  }
  const examples=el('div','model-examples');for(const value of data.examples||[]){const item=el('p'),link=nodeText('a',null,value.title,item);link.href=reviewURL(value.href);nodeText('span',null,' · '+value.text,item);examples.append(item)}host.append(examples);
  modelGraphObserver=new ResizeObserver(()=>{if(host.isConnected)redraw.forEach(fn=>fn());else modelGraphObserver?.disconnect()});modelGraphObserver.observe(host);redraw.forEach(fn=>fn());
 }catch(error){if(host.isConnected){notice.textContent='数据模型读取失败：'+error.message;host.replaceChildren(notice);const retry=nodeText('button',null,'重试数据模型',host);retry.onclick=()=>{host.remove();renderDataModel(root)}}}
}

function normalizeApproachWorkspace(id){
 const url=new URL(location.href),p=url.searchParams;
 if(id==='project.configuration'&&['METHODS','CODES'].includes(p.get('config_section'))){
  p.set('tab',p.get('config_section')==='METHODS'?'foundation':'model');p.set('workspace','production.approach');p.delete('config_section');history.replaceState(history.state,'',url);return 'production.approach';
 }
 return id;
}
