function businessCode(row){if(['SOURCE','STORY'].includes(row?.kind))return '';return row?.material_code||row?.business_code||(typeof state==='undefined'?null:state.businessCodes)?.get(row?.object_id||row?.id)||''}
function businessTitle(row,title=row?.payload?.title||row?.title||''){
  if(['SOURCE','STORY'].includes(row?.kind))return String(title);
  const code=businessCode(row),raw=String(title);
  // A shot's stored local prefix is a legacy position, not a second identity.
  const positioned=row?.kind==='SHOT_DESIGN'&&code?raw.replace(/^E\d+-\d+\s*/u,''):row?.business_scene_id?raw.replace(/^\d+-\d+\s*/,(row.business_scene_code||reviewPositionLabel('scene',row.business_scene_id))+' · '):raw;
  const text=reviewPositionText(positioned);
  if(!code||text===code||text.startsWith(code+' · '))return text;
  return code+' · '+(text.startsWith(code+' ')?text.slice(code.length).trim():text);
}
function renderBusinessCodeCatalog(root){
  const catalog=state.businessCodeCatalog;nodeText('p',null,catalog.allocation,root);
  const table=el('table','business-code-table'),head=el('tr');for(const title of ['类型','前缀','示例','唯一性范围'])nodeText('th',null,title,head);table.append(head);
  for(const entry of catalog.types){const row=el('tr');for(const key of ['type','prefix','example','scope'])nodeText('td',null,entry[key],row);table.append(row)}root.append(table);nodeText('p','production-meta',catalog.excluded,root);
}
/* View labels and tabs share the existing workspace/URL routing contract. */
function reviewPositionLabel(kind,value,episode=null){
  const prefix=({episode:'E',E:'E',EPISODE:'E',scene:'S',S:'S',PREPARATION:'S',shot:'SH',SH:'SH',SHOT_DESIGN:'SH'})[kind];
  if(!prefix)return String(value??'');
  if(value&&typeof value==='object'){const code=businessCode(value);if(code.startsWith(prefix)&&/^\d+$/.test(code.slice(prefix.length)))return code}
  if(prefix==='S'&&episode){const id=typeof episode==='string'?episode:episode.object_id||episode.id,scene=typeof value==='object'?value.id:value;const code=(typeof state==='undefined'?null:state.businessCodes)?.get('scene:'+id+':'+scene);if(code)return code}
  const raw=value&&typeof value==='object'?(value.payload?.number??value.number??value.payload?.episode_number??value.payload?.shot_number??value.scene_id??value.id):value;
  const text=String(raw??'').trim(),match=text.match(/^(?:E|S|SH)?0*(\d+)$/iu)||text.match(/^第\s*0*(\d+)\s*[集场鏡镜]$/u);
  if(match&&typeof state!=='undefined'&&state.businessCodes)return '第'+Number(match[1])+({E:'集',S:'场',SH:'镜'})[prefix];
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
const workspacePositionSelectors=['#source-view','#source-list','#structure-reader','#structure-index','#screenplay-reader','#screenplay-scene-index','#production-reader','#production-index','.breakdown-body','.breakdown-scene-list','#approach-index'];
const workspacePositions=new Map();
function workspaceGroup(id){return ['story.sources','story.outline','story.script'].includes(id)?'story.sources':['settings.workspace','materials.workspace'].includes(id)?'settings.workspace':id}
function rememberWorkspaceRoute(){
  const url=new URL(location.href),id=url.searchParams.get('workspace')||'production.approach';
  if(typeof state==='undefined'||id!==state.workspace)return;
  workspaceRoutes.set(workspaceGroup(id),url.href);
  if(['settings.workspace','materials.workspace','production.workspace'].includes(id)&&typeof productionTab==='function')workspaceSubRoutes.set(workspaceGroup(id)+':'+productionTab(),url.href);
}
function rememberWorkspacePosition(){
  const offsets={};
  for(const selector of workspacePositionSelectors){const node=document.querySelector(selector);if(node)offsets[selector]=[node.scrollLeft||0,node.scrollTop||0]}
  workspacePositions.set(location.href,{window:[window.scrollX||0,window.scrollY||0],offsets});
  try{sessionStorage.setItem('review-view-position',JSON.stringify({url:location.href,position:workspacePositions.get(location.href)}))}catch{}
}
function restoreWorkspacePosition(){
  const href=location.href;
  let position=workspacePositions.get(href);
  if(!position){try{const saved=JSON.parse(sessionStorage.getItem('review-view-position')||'null');if(saved?.url===href)position=saved.position}catch{}}
  if(!position)return;
  requestAnimationFrame(()=>{
    if(location.href!==href)return;
    for(const [selector,offset] of Object.entries(position.offsets||{})){const node=document.querySelector(selector);if(node){node.scrollLeft=Number(offset[0])||0;node.scrollTop=Number(offset[1])||0}}
    window.scrollTo(Number(position.window?.[0])||0,Number(position.window?.[1])||0);
  });
}
function navigateWorkspace(id){
  rememberWorkspacePosition();rememberWorkspaceRoute();
  const group=workspaceGroup(id),saved=workspaceRoutes.get(group);
  if(saved){
    const url=new URL(saved);if(url.href===location.href&&workspaceGroup(state.workspace)===group)return;if(url.href!==location.href)history.pushState(null,'',url);
    switchWorkspace(url.searchParams.get('workspace')||id,false);
  }else{
    if(['settings.workspace','production.workspace'].includes(id)){
      const url=new URL(location.href);url.searchParams.set('workspace',id);url.searchParams.set('production_tab',id==='settings.workspace'?'breakdown':'shots');
      for(const key of ['production_object','production_revision','production_entity','entity_state','material_id','material_version','material_round','material_target','material_baseline'])url.searchParams.delete(key);
      url.hash='';history.pushState(null,'',url);switchWorkspace(id,false);
    }else switchWorkspace(id);
  }
}
function configurationSectionFromRoute(){const section=new URL(location.href).searchParams.get('config_section');return ['SYSTEM','CODES'].includes(section)?section:'PROJECT'}
function selectConfigurationSection(section){
  const url=new URL(location.href);url.searchParams.set('workspace','project.configuration');url.searchParams.set('config_section',['SYSTEM','CODES'].includes(section)?section:'PROJECT');
  if(url.href!==location.href)history.pushState(null,'',url);
  state.configSection=configurationSectionFromRoute();renderConfigurations({preserve:true});renderWorkspaceTabs();
}
function selectProductionTab(tab){
  if(tab===productionTab())return;
  rememberWorkspacePosition();rememberWorkspaceRoute();
  const workspace=tab==='materials'?'materials.workspace':['shots','history'].includes(tab)?'production.workspace':'settings.workspace';
  const saved=workspaceSubRoutes.get(workspaceGroup(workspace)+':'+tab);
  if(saved){history.pushState(null,'',saved);switchWorkspace(workspace,false);return}
  const url=new URL(location.href);
  url.searchParams.set('workspace',workspace);url.searchParams.set('production_tab',tab);
  for(const key of ['production_object','production_revision','production_entity','entity_state','material_id','material_version','material_round','material_target','material_baseline'])url.searchParams.delete(key);
  url.hash='';if(url.href!==location.href)history.pushState(null,'',url);switchWorkspace(workspace,false);
}
function workspaceTabItems(){
  const workspace=state.workspace;
  if(workspace==='production.approach'){
    const active=new URL(location.href).searchParams.get('tab')==='materials'?'materials':'story';
    return [['story','故事创作'],['materials','生产制作']].map(([id,label])=>({id:'approach-tab-'+id,label,active:id===active,controls:'approach-body',open:()=>selectApproachTab(id)}));
  }
  if(['story.sources','story.outline','story.script'].includes(workspace))return [
    ['story.sources','open-story-sources','故事采编','story-workspace'],['story.outline','open-story-structure','故事结构','structure-workspace'],['story.script','open-story-script','剧本创作','screenplay-workspace']
  ].map(([value,id,label,controls])=>({id,label,controls,active:value===workspace,open:()=>{rememberWorkspacePosition();switchWorkspace(value)}}));
  if(workspace==='project.configuration')return [['PROJECT','故事项目'],['SYSTEM','系统与 AI'],['CODES','编号前缀']].map(([value,label])=>({id:'configuration-tab-'+value,label,controls:'configuration-view',active:value===configurationSectionFromRoute(),open:()=>selectConfigurationSection(value)}));
  if(['settings.workspace','materials.workspace','production.workspace'].includes(workspace)){
    const options=workspace==='production.workspace'?[['shots','镜头制作'],['history','组合与历史']]:[['breakdown','制作拆解'],['entities','实体管理'],['materials','素材管理']];
    return options.map(([value,label])=>({id:'production-tab-'+value,label,controls:'production-view',active:value===productionTab(),open:()=>selectProductionTab(value)}));
  }
  return [];
}
function renderWorkspaceTabs(){
  renderPageHeading();
  const root=document.querySelector('#workspace-subnav');if(!root)return;
  const focused=root.contains(document.activeElement)?document.activeElement.id:null,scroll=root.scrollLeft;
  root.replaceChildren();root.setAttribute('aria-label',({'production.approach':'制作思路','story.sources':'故事创作','settings.workspace':'制作设定','production.workspace':'全剧制作','project.configuration':'系统管理'})[workspaceGroup(state.workspace)]+'子页面');
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
  if(workspace==='production.approach')return params.get('tab')==='materials'
    ?['从故事到影像','生产制作方法','了解定稿、素材准备、镜头制作与组合交付之间的输入、产物和检查条件。']
    :['从资料到故事','故事创作方法','了解采编、结构、小说与剧本的创作步骤，以及审阅意见如何推动修订。'];
  const story={
    'story.sources':['SOURCE EVIDENCE','故事采编','阅读原始依据与整理稿，核对出处和版本；圈选原文提出审阅意见。'],
    'story.outline':['STORY STRUCTURE','故事结构','按稿次阅读人物、关系与故事线，结合图文审阅整体设计。'],
    'story.script':['STORY → SCREENPLAY','剧本集场阅读与审阅','按版本、分集、场次阅读完整剧本并评论；预计时长是制作估算。']
  };if(story[workspace])return story[workspace];
  if(workspace==='project.configuration')return ({
    PROJECT:['STORY PROJECT','故事项目配置','设置本故事的创作阶段、背景与表达目标，为审阅和评论润色提供依据。'],
    SYSTEM:['SYSTEM & AI','系统与 AI','管理站点图标与评论润色选项；修改后统一保存配置。'],
    CODES:['BUSINESS CODES','编号前缀','查阅对象编号的前缀、示例和唯一性范围，识别准确的版本与候选。']
  })[params.get('config_section')]||['STORY PROJECT','故事项目配置','设置本故事的创作阶段、背景与表达目标，为审阅和评论润色提供依据。'];
  const tab=workspace==='materials.workspace'?'materials':workspace==='production.workspace'?(params.get('production_tab')==='history'?'history':'shots'):(params.get('production_tab')||((params.has('production_entity')||params.has('entity_state'))?'entities':'breakdown'));
  return ({
    breakdown:['STORY → PRODUCTION','制作拆解','按集场阅读逐镜设计，核对剧情依据及本镜关联的实体与素材。'],
    entities:['ENTITIES & STATES','实体管理','按类型与集场审阅实体、完整状态和关系，评论或采纳当前内容。'],
    materials:['MATERIAL LIBRARY','素材管理','按集场查看素材方案、版本与真实候选，预览原件并审阅准确内容。'],
    shots:['SHOT PRODUCTION','镜头制作','按集场检查镜头方案，明确选择上游参考并审阅本镜视频候选。'],
    history:['COMPOSITION & HISTORY','组合与历史','查阅组合记录、准确采用及制作历史，核对成片所需的输入与缺项。']
  })[tab]||['STORY REVIEW DESK','故事审阅台','选择页面，阅读并审阅当前故事实例。'];
}
function renderPageHeading(){
  const parts=workspacePageDescriptor(state.workspace,new URL(location.href).searchParams);
  for(const [index,id] of ['page-marker','page-title','page-purpose'].entries()){const node=document.getElementById(id);if(node)node.textContent=parts[index]}
}
if(typeof window!=='undefined')window.addEventListener?.('pagehide',rememberWorkspacePosition);
