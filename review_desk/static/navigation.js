/* View labels and tabs share the existing workspace/URL routing contract. */
function reviewPositionLabel(kind,value){
  const prefix=({episode:'E',E:'E',EPISODE:'E',scene:'S',S:'S',PREPARATION:'S',shot:'SH',SH:'SH',SHOT_DESIGN:'SH'})[kind];
  if(!prefix)return String(value??'');
  const raw=value&&typeof value==='object'?(value.payload?.number??value.payload?.episode_number??value.payload?.shot_number??value.scene_id??value.id):value;
  const text=String(raw??'').trim(),match=text.match(/^(?:E|S|SH)?0*(\d+)$/iu)||text.match(/^第\s*0*(\d+)\s*[集场鏡镜]$/u);
  return match?prefix+match[1].padStart(prefix==='E'?2:3,'0'):text;
}
function reviewPositionText(value){
  return String(value??'').replace(/\bE(\d+)-(\d+)\b/giu,(_all,episode,shot)=>reviewPositionLabel('episode',episode)+' / '+reviewPositionLabel('shot',shot))
    .replace(/第\s*(\d+)\s*([集场镜])/gu,(_all,number,unit)=>reviewPositionLabel(({集:'E',场:'S',镜:'SH'})[unit],number))
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
      for(const key of ['production_object','production_revision','production_entity','entity_state','material_id','material_version','material_round','material_target'])url.searchParams.delete(key);
      url.hash='';history.pushState(null,'',url);switchWorkspace(id,false);
    }else switchWorkspace(id);
  }
}
function configurationSectionFromRoute(){return new URL(location.href).searchParams.get('config_section')==='SYSTEM'?'SYSTEM':'PROJECT'}
function selectConfigurationSection(section){
  const url=new URL(location.href);url.searchParams.set('workspace','project.configuration');url.searchParams.set('config_section',section==='SYSTEM'?'SYSTEM':'PROJECT');
  if(url.href!==location.href)history.pushState(null,'',url);
  state.configSection=configurationSectionFromRoute();showConfigurationSection();renderWorkspaceTabs();
}
function selectProductionTab(tab){
  if(tab===productionTab())return;
  rememberWorkspacePosition();rememberWorkspaceRoute();
  const workspace=tab==='materials'?'materials.workspace':['shots','history'].includes(tab)?'production.workspace':'settings.workspace';
  const saved=workspaceSubRoutes.get(workspaceGroup(workspace)+':'+tab);
  if(saved){history.pushState(null,'',saved);switchWorkspace(workspace,false);return}
  const url=new URL(location.href);
  url.searchParams.set('workspace',workspace);url.searchParams.set('production_tab',tab);
  for(const key of ['production_object','production_revision','production_entity','entity_state','material_id','material_version','material_round','material_target'])url.searchParams.delete(key);
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
  if(workspace==='project.configuration')return [['PROJECT','故事项目'],['SYSTEM','系统与 AI']].map(([value,label])=>({id:'configuration-tab-'+value,label,controls:'configuration-view',active:value===configurationSectionFromRoute(),open:()=>selectConfigurationSection(value)}));
  if(['settings.workspace','materials.workspace','production.workspace'].includes(workspace)){
    const options=workspace==='production.workspace'?[['shots','镜头制作'],['history','组合与历史']]:[['breakdown','制作拆解'],['entities','实体管理'],['materials','素材管理']];
    return options.map(([value,label])=>({id:'production-tab-'+value,label,controls:'production-view',active:value===productionTab(),open:()=>selectProductionTab(value)}));
  }
  return [];
}
function renderWorkspaceTabs(){
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
if(typeof window!=='undefined')window.addEventListener?.('pagehide',rememberWorkspacePosition);
