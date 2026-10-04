/* Scoped readers use the existing material cards, source modal and comments. */
let breakdownEpoch=0,breakdownSelectionEpoch=0;
function productionTab(){const p=new URL(location.href).searchParams;if(state.workspace==='materials.workspace')return 'materials';if(state.workspace==='production.workspace')return p.get('production_tab')==='history'?'history':'shots';return (['entities','materials','breakdown'].includes(p.get('production_tab'))?p.get('production_tab'):null)||((p.has('production_entity')||p.has('entity_state'))?'entities':'breakdown')}
function productionTabs(root){
  const nav=el('nav','breakdown-tabs');nav.setAttribute('aria-label','制作子页面');
  const options=state.workspace==='production.workspace'?[['shots','镜头制作'],['history','组合与历史']]:[['breakdown','制作拆解'],['entities','实体管理'],['materials','素材管理']];
  for(const [id,title] of options){const button=productionButton(nav,title,()=>{const url=new URL(location.href);url.searchParams.set('production_tab',id);for(const key of ['production_object','production_revision','production_entity','entity_state','material_version','material_round','material_target'])url.searchParams.delete(key);history.pushState(null,'',url);switchWorkspace(id==='materials'?'materials.workspace':state.workspace==='production.workspace'?'production.workspace':'settings.workspace')});button.classList.toggle('active',productionTab()===id);button.setAttribute('aria-current',productionTab()===id?'page':'false')}
  root.append(nav);
}
function breakdownRoute(values){const url=new URL(location.href);for(const [k,v] of Object.entries(values)){if(v===null)url.searchParams.delete(k);else url.searchParams.set(k,v)}history.replaceState(null,'',url)}
function breakdownHeading(host){nodeText('h1',null,state.workspace==='production.workspace'?'全剧制作':'制作设定',host);productionTabs(host)}
async function loadProductionBreakdown(){
  rememberProductionDraft();const epoch=++breakdownEpoch,workspace=state.workspace,params=new URL(location.href).searchParams,host=$('#production-view');
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;state.productionEntityId=null;state.entityReview=null;state.materialReview=null;state.productionSelected=null;
  host.replaceChildren();breakdownHeading(host);const loading=nodeText('p',null,'正在读取本集镜头…',host);
  const data=await api('/api/production/breakdown?'+new URLSearchParams({episode:params.get('breakdown_episode')||''}));
  if(epoch!==breakdownEpoch||workspace!==state.workspace)return;loading.remove();
  const explicitObject=params.get('breakdown_object')||params.get('production_object');
  const explicitRevision=params.get('breakdown_revision')||(explicitObject===params.get('production_object')?params.get('production_revision'):null);
  if(explicitObject&&explicitRevision){
    const current=[...data.shots,...data.scenes].find(r=>r.object_id===explicitObject);
    if(current&&current.id!==explicitRevision){
      const historical=await api('/api/production?'+new URLSearchParams({object_id:explicitObject,revision_id:explicitRevision}));
      if(epoch!==breakdownEpoch||workspace!==state.workspace)return;
      const key=historical.record.kind==='SHOT_DESIGN'?'shots':'scenes';data[key]=data[key].map(r=>r.object_id===explicitObject?historical.record:r);
    }
  }
  const memory=state.breakdownMemory||={};state.breakdownData=data;
  state.productionRecords=[data.lock,...data.scenes,...data.shots].filter(Boolean);
  const layout=el('div','breakdown-layout'),nav=el('nav','breakdown-episodes'),body=el('article','breakdown-body'),aside=el('aside','breakdown-context');
  nav.setAttribute('aria-label','分集导航');body.setAttribute('aria-label',productionTab()==='shots'?'镜头制作':'逐镜设计');aside.setAttribute('aria-label','当前场镜的实体与素材');
  for(const ep of data.episodes){const b=productionButton(nav,ep.title,()=>{memory[data.episode]=body.scrollTop;breakdownRoute({breakdown_episode:ep.object_id,breakdown_object:null,breakdown_revision:null,production_object:null,production_revision:null});loadProductionBreakdown().catch(e=>toast(e.message))});b.classList.toggle('active',ep.object_id===data.episode)}
  layout.append(nav,body,aside);host.append(layout);
  const shared=el('div','breakdown-shared');body.append(shared);
  if(data.lock)productionButton(shared,'全剧共用',()=>selectBreakdown(data.lock,aside,body));
  const ep=data.episodes.find(e=>e.object_id===data.episode);
  if(ep)productionButton(shared,'本集共用',()=>selectBreakdown({object_id:ep.object_id,id:ep.id},aside,body));
  for(const scene of data.scenes){
    const section=el('section','breakdown-scene'),header=el('header','breakdown-scene-heading');section.dataset.objectId=scene.object_id;
    const title=productionButton(header,scene.payload.title,()=>selectBreakdown(scene,aside,body));title.classList.add('breakdown-scene-title');
    materialReferenceLink(header,scene.payload.source,'剧情依据',true);section.append(header);
    const shots=data.shots.filter(s=>s.payload.scene_id===scene.payload.source.scene_id);
    nodeText('p','production-meta',[scene.source_meta?.location,scene.source_meta?.time].filter(Boolean).join(' · '),section);
    if(shots.length)nodeText('p',null,'本场推进：'+shots[0].payload.purpose+(shots.length>1?'；'+shots[shots.length-1].payload.purpose:''),section);
    if(!shots.length)nodeText('p','production-meta','本场逐镜设计待补齐',section);
    for(const shot of shots){
      const card=el('article','breakdown-shot');card.dataset.objectId=shot.object_id;card.tabIndex=0;
      const top=el('header');nodeText('h3',null,`${String(shot.payload.number).padStart(2,'0')} · ${shot.payload.title}`,top);nodeText('span','production-meta',`${shot.payload.duration_frames/shot.payload.fps} 秒`,top);card.append(top);
      if(shot.id!==shot.current_revision)nodeText('p','production-meta','正在查看此链接保存的历史镜头设计。',card);
      const text=reviewSurface(el('div'));text.dataset.productionBlocks=shot.id;
      text.reviewFocus=()=>{state.breakdownReviewFocus=(state.breakdownReviewFocus||0)+1;state.entityReview=null;focusProductionReview({record:shot,history:[shot],uses:[]},false)};text.onpointerdown=text.reviewFocus;text.onfocusin=text.reviewFocus;card.append(text);
      for(const [key,label] of [['purpose','叙事目的'],['framing','构图'],['spatial','空间'],['action_start','起始'],['action_end','结束'],['motion','动作过程'],['continuity','承接']]){const line=el('p');nodeText('b',null,label+'　',line);const value=shot.payload[key]||'见动作起止',span=nodeText('span',null,value,line),block=productionTextBlocks(shot).find(b=>b.field===key||b.text===value);if(block)span.dataset.blockId=block.id;text.append(line)}
      if(shot.payload.sound?.length)nodeText('p',null,'声音　'+shot.payload.sound.filter(s=>s.type!=='source_action').map(s=>typeof s==='string'?s:s.text||s.description||'').join('；'),card);
      materialReferenceLink(card,shot.payload.source,'查看本镜剧情依据',true);
      const choose=()=>{memory[data.episode]=body.scrollTop;selectBreakdown(shot,aside,body).catch(e=>toast(e.message))};
      card.onclick=e=>{if(!e.target.closest('button,a,select,input,textarea,.review-surface')&&getSelection()?.isCollapsed)choose()};card.onkeydown=e=>{if(e.target===card&&['Enter',' '].includes(e.key)){e.preventDefault();choose()}};
      productionButton(card,productionTab()==='shots'?'查看输入与生成方案':'查看实体与素材',choose);section.append(card);
    }body.append(section);
  }
  body.scrollTop=memory[data.episode]||0;
  let selected=[data.lock,...data.episodes,...data.shots,...data.scenes].filter(Boolean).find(r=>r.object_id===(params.get('breakdown_object')||params.get('production_object')))||data.shots[0]||data.scenes[0];
  const exact=params.get('breakdown_revision')||(params.get('production_object')===selected?.object_id?params.get('production_revision'):null);
  if(exact&&selected?.id!==exact){const historical=await api('/api/production?'+new URLSearchParams({object_id:selected.object_id,revision_id:exact}));if(epoch!==breakdownEpoch)return;selected=historical.record}
  if(selected)await selectBreakdown(selected,aside,body,params);else nodeText('p',null,'本集尚无制作设计',aside);
}
async function selectBreakdown(selected,aside,body,restore=null){
  rememberProductionDraft();const epoch=++breakdownSelectionEpoch,workspace=state.workspace;
  ++productionReadEpoch;state.materialReview=null;state.entityReview=null;state.productionEntityDetail=null;state.productionChildDetail=null;
  aside.replaceChildren();nodeText('p',null,'正在读取…',aside);
  breakdownRoute({breakdown_episode:state.breakdownData.episode,breakdown_object:selected.object_id,breakdown_revision:selected.id,...(!restore?{material_version:null,material_round:null,material_target:null}:{})});
  for(const node of body.querySelectorAll('[data-object-id]'))node.classList.toggle('selected',node.dataset.objectId===selected.object_id);
  const context=await api('/api/production/context?'+new URLSearchParams({object_id:selected.object_id,revision_id:selected.id}));
  if(epoch!==breakdownSelectionEpoch||workspace!==state.workspace)return;
  aside.replaceChildren();nodeText('h2',null,context.record.payload.title,aside);
  state.productionRecords=[...state.productionRecords,...context.entities,...context.states,...context.requirements];
  const entities=el('section','breakdown-entities');
  const modes={visual:'出镜',voice:'发声',visual_voice:'出镜、发声',mention:'提及'};
  for(const entity of context.entities){const group=el('div');nodeText('b',null,entity.payload.title,group);const occurrences=context.occurrences.filter(o=>o.entity.revision_id===entity.id);const labels=[...new Set(occurrences.map(o=>modes[o.mode]||o.mode))];if(labels.length)nodeText('small','production-meta','　'+labels.join('；'),group);for(const form of context.states.filter(s=>s.payload.entity.object_id===entity.object_id))nodeText('p',null,form.payload.title,group);for(const occurrence of occurrences)for(const source of occurrence.evidence||[])materialReferenceLink(group,source,'出现依据',true);entities.append(group)}aside.append(entities);
  const detail={record:context.record,history:[context.record],uses:[]};focusProductionReview(detail,false);
  const actions=el('div','production-toolbar');productionButton(actions,selected.kind==='PREPARATION'?'评论本场设计':selected.kind==='SHOT_DESIGN'?'评论镜头设计':'评论此范围',()=>{state.breakdownReviewFocus=(state.breakdownReviewFocus||0)+1;focusProductionReview(detail,false);restoreProductionDraft();if(!state.anchor)startDraft({type:'global'});else{openPanel();renderComments()}});aside.append(actions);
  const needs=el('nav','breakdown-needs');needs.setAttribute('aria-label','此处素材需求');aside.append(needs);
  const reader=el('section','production-reader');reader.id='production-reader';aside.append(reader);
  for(const need of context.requirements)productionButton(needs,need.payload.title,()=>openBreakdownMaterial(need,reader,epoch));
  if(!context.requirements.length)nodeText('p','production-meta','此范围尚无直接素材需求',reader);
  else {
    const linked=restore?.get('production_object');
    const preferred=context.requirements.find(r=>r.object_id===linked)||(productionTab()==='shots'?context.requirements.find(r=>r.payload.slot==='shot-video'):null);
    await openBreakdownMaterial(context.requirements.some(r=>r.object_id===linked)?{object_id:linked,id:restore.get('production_revision')||undefined}:preferred||context.requirements[0],reader,epoch,!!restore);
  }
  renderComments();
}
async function openBreakdownMaterial(need,reader,selectionEpoch=null,restore=false){
  rememberProductionDraft();const read=++productionReadEpoch,workspace=state.workspace;reader.replaceChildren();nodeText('p',null,'正在读取素材…',reader);
  const reviewIntent=state.breakdownReviewFocus||0;
  const savedTarget=restore?new URL(location.href).searchParams.get('material_target'):null;
  if(!restore)breakdownRoute({material_version:null,material_round:null,material_target:null});
  let detail;
  try{detail=await api('/api/production?'+new URLSearchParams({object_id:need.object_id,...(need.id?{revision_id:need.id}:{})}))}
  catch(error){if(read===productionReadEpoch){reader.replaceChildren();nodeText('p','production-issue','素材读取失败：'+error.message,reader)}return}
  if(read!==productionReadEpoch||workspace!==state.workspace||selectionEpoch!==null&&selectionEpoch!==breakdownSelectionEpoch)return;
  state.entityReview=null;state.materialReview=detail;state.materialCommentCard=null;state.productionEntityDetail=null;state.productionChildDetail=null;
  detail.explicitRevision=!!need.id;
  if(new URL(location.href).searchParams.has('material_round')&&Object.keys(detail.legacy_material_versions||{}).length)detail.material_versions=detail.legacy_material_versions;
  const target=savedTarget&&materialRows(detail).find(r=>r.id===savedTarget);
  if(target)detail.selectedCandidateId=target.id;
  if(reviewIntent===(state.breakdownReviewFocus||0)){focusProductionReview(target?{record:target,history:[target],uses:[]}:detail,false);renderProductionReader();restoreProductionDraft()}
  else renderMaterialWorkspace(reader,detail);
  renderComments();
  if(detail.record.kind==='REQUIREMENT'){
    const candidates=detail.candidate_records||[];
    state.productionRecords=[...state.productionRecords,...candidates];
    const context=await api('/api/production/context?'+new URLSearchParams(detail.record.payload.scope));
    if(read!==productionReadEpoch||!reader.isConnected)return;
    detail.adoptionContext=context;renderMaterialAdoptionControls(reader,detail);
  }
}
function renderMaterialAdoptionControls(reader,detail){
  if(!detail.adoptionContext)return;
  reader.querySelector('[data-adoption-controls]')?.remove();
  const controls=el('section','production-toolbar');controls.dataset.adoptionControls='true';reader.append(controls);
  const adoption=detail.adoptionContext.adoptions.find(r=>r.payload.slot===detail.record.payload.slot);
  if(adoption)materialReferenceLink(controls,{...adoption.payload.asset,component_id:adoption.payload.component_id,...(adoption.payload.range?{range:adoption.payload.range}:{}),...(adoption.payload.crop?{crop:adoption.payload.crop}:{})},'已采用的准确原件');
  if(detail.candidate_records?.length)productionButton(controls,adoption?'更换采用':'选择采用',()=>showProductionAdoption(controls,{requirement:detail.record,adoption}));

}
async function loadProductionMaterials(){
  rememberProductionDraft();const epoch=++breakdownEpoch,workspace=state.workspace,host=$('#production-view'),params=new URL(location.href).searchParams;
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;state.productionEntityId=null;state.entityReview=null;state.materialReview=null;host.replaceChildren();breakdownHeading(host);
  const catalog=await api('/api/production/breakdown');if(epoch!==breakdownEpoch||workspace!==state.workspace)return;
  state.productionRecords=[catalog.lock,...catalog.scenes,...catalog.shots].filter(Boolean);
  const filters=el('div','production-toolbar'),ep=el('select'),scene=el('select'),media=el('select'),status=el('select'),search=el('input');
  ep.setAttribute('aria-label','素材所属集');scene.setAttribute('aria-label','素材所属场');media.setAttribute('aria-label','媒体类型');status.setAttribute('aria-label','生成状态');search.setAttribute('aria-label','搜索素材');search.type='search';
  ep.append(new Option('全部集',''));for(const e of catalog.episodes)ep.append(new Option(e.title,e.object_id));ep.value=params.get('material_episode')||'';
  media.append(new Option('全部媒体',''));for(const [id,label] of Object.entries(productionMediaLabels))media.append(new Option(label,id));
  status.append(new Option('全部状态',''),new Option('未生成','ungenerated'),new Option('已生成','generated'));media.value=params.get('material_media')||'';status.value=params.get('material_status')||'';search.value=params.get('material_search')||'';filters.append(ep,scene,media,status,search);host.append(filters);
  const layout=el('div','breakdown-materials'),index=el('nav','breakdown-material-index'),reader=el('article','production-reader');reader.id='production-reader';layout.append(index,reader);host.append(layout);
  let request=0,offset=0,initialRead=true;
  const refresh=async()=>{const n=++request,restore=initialRead;initialRead=false;if(!restore){rememberProductionDraft();state.materialReview=null;++productionReadEpoch;reader.replaceChildren()}breakdownRoute({material_episode:ep.value,material_scene:scene.value,material_media:media.value,material_status:status.value,material_search:search.value});const result=await api('/api/production/materials?'+new URLSearchParams({episode:ep.value,scene:scene.value,media:media.value,status:status.value,search:search.value,offset}));if(n!==request||epoch!==breakdownEpoch)return;index.replaceChildren();nodeText('p','production-meta',`${result.total} 项素材需求`,index);for(const item of result.items){const b=productionButton(index,item.title,()=>openBreakdownMaterial(item,reader));nodeText('small',null,item.generated?'已生成':'未生成',b)}if(offset)productionButton(index,'上一页',()=>{offset=Math.max(0,offset-result.limit);refresh()});if(offset+result.limit<result.total)productionButton(index,'下一页',()=>{offset+=result.limit;refresh()});if(!state.materialReview&&result.items.length){const initial=restore&&params.get('production_object')?{object_id:params.get('production_object'),id:params.get('production_revision')||undefined}:result.items[0];await openBreakdownMaterial(initial,reader,null,restore)}};
  const scenes=()=>{scene.replaceChildren(new Option('全部场',''));const selected=catalog.episodes.find(e=>e.object_id===ep.value);for(const s of selected?.scenes||[])scene.append(new Option(s.title||s.id,s.id));scene.value=params.get('material_scene')||''};
  ep.onchange=()=>{offset=0;scenes();refresh()};for(const input of [scene,media,status])input.onchange=()=>{offset=0;refresh()};let timer;search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{offset=0;refresh()},150)};scenes();await refresh();
}

function rememberProductionDraft(){
  if(!isProduction()||!state.productionSelected||!state.anchor)return;
  state.productionDraftContexts||={};state.productionDraftContexts[state.productionSelected.id]={anchor:state.anchor,editing:state.editing,selected:state.selected};
}
function restoreProductionDraft(){
  const saved=state.productionDraftContexts?.[state.productionSelected?.id];
  if(saved){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected}
}
