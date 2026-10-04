/* Episode / scene navigation and all-shot rows share one exact context reader. */
let breakdownEpoch=0,breakdownSelectionEpoch=0;
function productionTab(){const p=new URL(location.href).searchParams;if(state.workspace==='materials.workspace')return 'materials';if(state.workspace==='production.workspace')return p.get('production_tab')==='history'?'history':'shots';return (['entities','materials','breakdown'].includes(p.get('production_tab'))?p.get('production_tab'):null)||((p.has('production_entity')||p.has('entity_state'))?'entities':'breakdown')}
function productionTabs(root){
  const nav=el('div','story-creation-tabs production-tabs');nav.setAttribute('role','tablist');nav.setAttribute('aria-label','制作子页面');
  const options=state.workspace==='production.workspace'?[['shots','镜头制作'],['history','组合与历史']]:[['breakdown','制作拆解'],['entities','实体管理'],['materials','素材管理']];
  for(const [id,title] of options){const button=productionButton(nav,title,()=>{const url=new URL(location.href);url.searchParams.set('production_tab',id);for(const key of ['production_object','production_revision','production_entity','entity_state','material_id','material_version','material_round','material_target'])url.searchParams.delete(key);history.pushState(null,'',url);switchWorkspace(id==='materials'?'materials.workspace':state.workspace==='production.workspace'?'production.workspace':'settings.workspace')});button.classList.toggle('active',productionTab()===id);button.setAttribute('role','tab');button.setAttribute('aria-selected',String(productionTab()===id));button.setAttribute('aria-current',productionTab()===id?'page':'false')}
  root.append(nav);
}
function breakdownRoute(values){const url=new URL(location.href);for(const [k,v] of Object.entries(values)){if(v===null)url.searchParams.delete(k);else url.searchParams.set(k,v)}history.replaceState(history.state,'',url)}
function breakdownHeading(host){const h=nodeText('h1','production-heading',state.workspace==='production.workspace'?'全剧制作':'制作设定',host);productionTabs(host)}
function breakdownLevel(row){return ({INPUT_LOCK:'story',STORY:'story',EPISODE:'episode',PREPARATION:'scene',SHOT_DESIGN:'shot'})[row.kind]}
function breakdownScopeFilters(parent,onchange){
  const filters=el('fieldset','breakdown-levels');nodeText('legend',null,'素材归属',filters);state.breakdownLevels||=['story','episode','scene','shot'];
  for(const [id,title] of [['story','剧'],['episode','集'],['scene','场'],['shot','镜']]){const label=el('label'),input=el('input');input.type='checkbox';input.value=id;input.checked=state.breakdownLevels.includes(id);input.onchange=()=>{state.breakdownLevels=[...filters.querySelectorAll('input:checked')].map(n=>n.value);onchange()};label.append(input,document.createTextNode(title));filters.append(label)}parent.append(filters);
}
function breakdownSelect(row,container){
  if(!row)return;rememberProductionDraft();state.breakdownSelected=row;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.materialCommentCard=null;
  breakdownRoute({breakdown_object:row.object_id,breakdown_revision:row.id});
  for(const node of [container,...container.querySelectorAll('[data-selection-id]')]){const selected=node.dataset.selectionId===row.object_id;node.classList.toggle('selected',selected);node.setAttribute('aria-current',selected?'true':'false')}
  focusProductionReview(entityReviewDetail(row),false);restoreProductionDraft();paintProductionReview();renderComments();
}
function breakdownShotText(parent,shot){
  const text=reviewSurface(el('div'));text.dataset.productionBlocks=shot.id;text.reviewFocus=()=>{state.breakdownReviewFocus=(state.breakdownReviewFocus||0)+1;focusProductionReview(entityReviewDetail(shot),false)};text.onpointerdown=text.reviewFocus;text.onfocusin=text.reviewFocus;parent.append(text);
  for(const [key,label] of [['purpose','叙事目的'],['framing','构图'],['spatial','空间'],['action_start','起始'],['action_end','结束'],['motion','动作过程'],['continuity','承接']]){
    const block=productionTextBlocks(shot).find(b=>b.field===key||b.text===shot.payload[key]);if(!block)continue;const line=el('p');nodeText('b',null,label+'　',line);const span=nodeText('span',null,block.text,line);span.dataset.blockId=block.id;text.append(line);
  }
  if(shot.payload.sound?.length)nodeText('p',null,'声音　'+shot.payload.sound.filter(s=>s.type!=='source_action').map(s=>typeof s==='string'?s:s.text||s.description||'').join('；'),parent);
  materialReferenceLink(parent,shot.payload.source,'查看本镜剧情依据',true);
}
function renderLinkedPrompt(parent,row,inputs,records,field){
  const block=productionTextBlocks(row).find(b=>b.field===field);if(!block)return;
  const pre=el('pre','shot-generation-prompt');pre.dataset.blockId=block.id;
  const refs=materialInputs(inputs,records),byLabel=new Map(refs.map(item=>[item.label,item]));
  const pattern=/@?(?:图片|图像|音频|声音|视频|输入)\s*\d+/gu;let offset=0;
  for(const match of block.text.matchAll(pattern)){
    pre.append(document.createTextNode(block.text.slice(offset,match.index)));const label=match[0].replace(/^@/,'').replace(/\s/g,'').replace(/^图像/,'图片').replace(/^声音/,'音频');const input=byLabel.get(label)||(/^输入\d+$/.test(label)?refs.find(i=>i.index===Number(label.slice(2))-1):null);
    if(input&&!input.missing){const a=el('a','prompt-reference');a.href=materialReferenceRequest(input.ref,false).url;a.textContent=match[0];a.onclick=e=>{e.preventDefault();if(getSelection()?.isCollapsed)openMaterialReference(input.ref,a)};pre.append(a)}else pre.append(document.createTextNode(match[0]));offset=match.index+match[0].length;
  }
  pre.append(document.createTextNode(block.text.slice(offset)));parent.append(pre);
}
function breakdownPrompt(parent,need,context){
  const detail=context.video_details?.[need.object_id],rounds=detail?.material_versions?.[need.object_id]||[];
  state.breakdownVideoSelections||={};const saved=state.breakdownVideoSelections[need.id]||{},round=rounds.find(r=>r.number===saved.number)||rounds[0];
  const candidates=(round?.results||[]).map(record=>({record,components:record.payload.components,component:record.payload.components.find(c=>c.role==='original')||record.payload.components[0]}));
  const model={need:round?.plan||need,identity:need,candidates,round,rounds,material_id:need.object_id};
  const selected=materialCandidateChoice(candidates,saved.candidate||materialDefaultCandidate(model,{adoptions:context.adoptions}));
  const selection={number:round?.number,candidate:selected?.record.id};state.breakdownVideoSelections[need.id]=selection;
  const section=el('section','shot-generation-content');parent.append(section);
  const repaint=()=>{rememberProductionDraft();section.remove();breakdownPrompt(parent,need,context);paintReviewCommentCounts()};
  const bar=el('div','production-toolbar');section.append(bar);
  if(round)materialRoundControl(bar,need.object_id,rounds,round,number=>{state.breakdownVideoSelections[need.id]={number};repaint()});
  if(candidates.length>1){const choice=el('select');choice.setAttribute('aria-label','视频候选');for(const item of candidates)choice.append(new Option(item.record.payload.title,item.record.id));choice.value=selected.record.id;choice.onchange=()=>{selection.candidate=choice.value;repaint()};bar.append(choice)}
  if(selected){
    const actual=detail.review_contexts?.[selected.record.id],call=actual?.call;
    nodeText('h4',null,'所选视频的真实生成内容',section);
    if(!call){nodeText('p','production-issue','此候选未登记真实调用，无法还原输入与提示词',section);return}
    const host=materialTextSurface(section,call);renderMaterialInputs(host,call.payload.inputs||[],actual.inputs||[]);materialParameters(host,call,'call',call.payload.model);renderLinkedPrompt(host,call,call.payload.inputs||[],actual.inputs||[],'call.prompt');
  }else{
    const plan=model.need?.payload.generation;if(!plan){nodeText('p','production-meta','视频生成方案待完善',section);return}
    const host=materialTextSurface(section,model.need);nodeText('h4',null,'待生成 · 视频方案',host);renderMaterialInputs(host,plan.inputs||[],model.need.review_input_records||need.review_input_records||[],model.need);materialParameters(host,model.need,'generation',plan.model);renderLinkedPrompt(host,model.need,plan.inputs||[],model.need.review_input_records||need.review_input_records||[],'generation.prompt');
    if(plan.blockers?.length){nodeText('h4',null,'生成前仍需',host);for(const issue of plan.blockers)nodeText('p','production-issue',issue,host)}
  }
}
async function loadProductionBreakdown(){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();const epoch=++breakdownEpoch,workspace=state.workspace,params=new URL(location.href).searchParams,host=$('#production-view');
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionSelected=null;state.productionEntityId=null;
  host.replaceChildren();breakdownHeading(host);const loading=nodeText('p',null,'正在读取本集镜头…',host);
  const data=await api('/api/production/breakdown?'+new URLSearchParams({episode:params.get('breakdown_episode')||''}));if(epoch!==breakdownEpoch||workspace!==state.workspace)return;loading.remove();state.breakdownData=data;
  state.productionRecords=[data.lock,...data.scenes,...data.shots].filter(Boolean);
  const episodes=el('nav','screenplay-episodes breakdown-episode-tabs');episodes.setAttribute('aria-label','分集导航');host.append(episodes);
  for(const ep of data.episodes){const button=productionButton(episodes,ep.title,()=>{breakdownRoute({breakdown_episode:ep.object_id,breakdown_scene:null,breakdown_object:null,breakdown_revision:null,production_object:null,production_revision:null});loadProductionBreakdown().catch(e=>toast(e.message))});button.className='source-button';button.classList.toggle('active',ep.object_id===data.episode);button.setAttribute('aria-current',ep.object_id===data.episode?'true':'false')}
  const layout=el('div','breakdown-scene-layout'),nav=el('aside','text-reader-index breakdown-scenes'),head=el('header'),sceneList=el('nav','breakdown-scene-list'),body=el('article','breakdown-body');nodeText('h2',null,'本集场次',head);nav.append(head,sceneList);sceneList.setAttribute('aria-label','场次导航');body.setAttribute('aria-label',productionTab()==='shots'?'镜头制作':'逐镜设计');layout.append(nav,body);host.append(layout);
  let selected=data.scenes.find(s=>s.object_id===params.get('breakdown_scene'));
  const targetId=params.get('breakdown_object')||params.get('production_object'),target=data.shots.find(r=>r.object_id===targetId)||data.scenes.find(r=>r.object_id===targetId);
  if(target)selected=target.kind==='PREPARATION'?target:data.scenes.find(s=>s.object_id===target.payload.parent?.object_id)||data.scenes.find(s=>s.payload.source.scene_id===target.payload.scene_id);
  selected||=data.scenes[0];
  for(const scene of data.scenes){const button=productionButton(sceneList,scene.payload.title,()=>showBreakdownScene(scene,body,sceneList,epoch));button.className='source-button';button.dataset.sceneId=scene.object_id}
  if(selected)await showBreakdownScene(selected,body,sceneList,epoch,params);else nodeText('p',null,'本集尚无场次设计',body);
}
async function showBreakdownScene(scene,body,nav,epoch,restore=null){
  rememberProductionDraft();const request=++breakdownSelectionEpoch;state.breakdownMemory||={};if(body.dataset.sceneId)state.breakdownMemory[body.dataset.sceneId]=body.scrollTop;
  const targetId=restore?.get('breakdown_object')||restore?.get('production_object'),targetRevision=restore?.get('breakdown_revision')||restore?.get('production_revision');
  let exact=targetId===scene.object_id?targetRevision:null,historicalShot=null;
  if(targetId&&targetId!==scene.object_id&&targetRevision){const detail=await api('/api/production?'+new URLSearchParams({object_id:targetId,revision_id:targetRevision}));if(epoch!==breakdownEpoch||request!==breakdownSelectionEpoch)return;if(detail.record.kind==='SHOT_DESIGN'){historicalShot=detail.record;if(historicalShot.payload.parent){scene={...scene,object_id:historicalShot.payload.parent.object_id,id:historicalShot.payload.parent.revision_id};exact=scene.id}}}
  body.replaceChildren();nodeText('p',null,'正在读取本场…',body);for(const button of nav.querySelectorAll('button'))button.classList.toggle('active',button.dataset.sceneId===scene.object_id);
  const data=await api('/api/production/scene?'+new URLSearchParams({object_id:scene.object_id,revision_id:exact||scene.id,...(historicalShot?{shot_revision:historicalShot.id}:{})}));if(epoch!==breakdownEpoch||request!==breakdownSelectionEpoch)return;
  if(historicalShot){const item=data.shots.find(s=>s.record.object_id===historicalShot.object_id);if(item)item.record=historicalShot;else throw Error('准确历史镜头不属于所请求的场次')}
  body.dataset.sceneId=scene.object_id;body.replaceChildren();state.breakdownSceneData=data;
  breakdownRoute({breakdown_episode:state.breakdownData.episode,breakdown_scene:scene.object_id});
  const page=el('section','breakdown-scene');page.dataset.selectionId=data.scene.object_id;page.tabIndex=0;body.append(page);
  const header=el('header','text-reader-head');nodeText('h2',null,data.scene.payload.title,header);materialReferenceLink(header,data.scene.payload.source,'剧情依据',true);page.append(header);
  nodeText('p','production-meta',[scene.source_meta?.location,scene.source_meta?.time].filter(Boolean).join(' · '),page);
  page.onclick=e=>{if(e.target===page&&getSelection()?.isCollapsed)breakdownSelect(data.scene,page)};page.onkeydown=e=>{if(e.target===page&&['Enter',' '].includes(e.key)){e.preventDefault();breakdownSelect(data.scene,page)}};
  const top=el('div','breakdown-row breakdown-common'),sceneInfo=el('section'),shared=el('aside','breakdown-shared-materials');top.append(sceneInfo,shared);page.append(top);
  const surface=materialTextSurface(sceneInfo,data.scene);for(const block of data.scene.payload.blocks||[]){const p=nodeText('p',null,block.text,surface);p.dataset.blockId=block.id}
  const scopes=el('div');shared.append(scopes);breakdownScopeFilters(shared,renderMaterials);
  const sharedCards=el('div');shared.append(sharedCards);const rows=[];
  for(const item of data.shots){const shot=item.record,row=el('article','breakdown-row breakdown-shot');row.dataset.selectionId=shot.object_id;row.tabIndex=0;
    const text=el('section','breakdown-shot-copy'),materials=el('aside','breakdown-shot-materials'),heading=el('header');nodeText('h3',null,`${String(shot.payload.number).padStart(2,'0')} · ${shot.payload.title}`,heading);nodeText('small',null,`${shot.payload.duration_frames/shot.payload.fps} 秒`,heading);text.append(heading);
    if(productionTab()==='shots'){const needs=item.context.requirements.filter(r=>r.payload.media_type==='video');for(const need of needs)breakdownPrompt(text,need,item.context);if(!needs.length)nodeText('p','production-meta','本镜视频生成方案待补齐',text)}else breakdownShotText(text,shot);
    row.append(text,materials);page.append(row);rows.push({item,materials});
    row.onclick=e=>{if(!e.target.closest('button,a,select,input,textarea,.review-surface')&&getSelection()?.isCollapsed)breakdownSelect(shot,page)};row.onkeydown=e=>{if(e.target===row&&['Enter',' '].includes(e.key)){e.preventDefault();breakdownSelect(shot,page)}};
  }
  function cards(parent,context){const video=productionTab()==='shots';const items=context.materials.filter(i=>!video||i.media_type==='video');for(const item of items)materialSmallCard(parent,item,trigger=>{const choice=state.breakdownVideoSelections?.[item.id],params=choice?.number?new URLSearchParams({material_id:item.object_id,material_version:choice.number,...(choice.candidate?{material_target:choice.candidate}:{})}):null;openUnifiedMaterial({object_id:item.object_id,revision_id:item.id,params},trigger)});if(!items.length)nodeText('p','production-meta',video?'此处尚无视频素材':'此处尚无关联素材',parent)}
  function renderMaterials(){sharedCards.replaceChildren();for(const level of ['story','episode','scene']){if(!state.breakdownLevels.includes(level))continue;const contexts=data.shared.filter(c=>breakdownLevel(c.record)===level),materials=[...new Map(contexts.flatMap(c=>c.materials).map(i=>[i.object_id,i])).values()].filter(i=>productionTab()!=='shots'||i.media_type==='video');if(!materials.length)continue;const section=el('section','breakdown-shared-group');nodeText('h3',null,({story:'全剧素材',episode:'本集素材',scene:'本场素材'})[level],section);cards(section,{materials});sharedCards.append(section)}for(const {item,materials} of rows){materials.replaceChildren();if(state.breakdownLevels.includes('shot')){nodeText('h4',null,'本镜素材',materials);cards(materials,item.context)}}}
  renderMaterials();body.scrollTop=state.breakdownMemory[scene.object_id]||0;
  state.productionRecords=[...state.productionRecords,...data.shared.flatMap(c=>[c.record,...c.requirements,...c.entities,...c.states]),...data.shots.flatMap(s=>[s.record,...s.context.requirements])];
  const chosen=data.shots.find(s=>s.record.object_id===restore?.get('breakdown_object'))?.record||data.scene;breakdownSelect(chosen,page);paintReviewCommentCounts();
}
async function openBreakdownMaterial(need,reader,selectionEpoch=null,restore=false){
  rememberProductionDraft();const read=++productionReadEpoch,workspace=state.workspace,params=restore?new URL(location.href).searchParams:new URLSearchParams();
  reader.replaceChildren();nodeText('p',null,'正在读取素材…',reader);
  if(!restore)breakdownRoute({material_id:null,material_version:null,material_round:null,material_target:null,production_entity:null,entity_state:null});
  try{const result=await readUnifiedCard(need.object_id,need.id||null,params);if(read!==productionReadEpoch||workspace!==state.workspace||selectionEpoch!==null&&selectionEpoch!==breakdownSelectionEpoch)return;
    state.unifiedCardRoot=null;activateUnifiedCard(result);renderProductionReader();renderComments();
    const mid=state.entityReview?.unifiedMaterialId||Object.keys(result.detail.material_versions||{})[0]||result.detail.record.object_id;
    for(const button of document.querySelectorAll('.material-index [data-material-id]'))button.setAttribute('aria-pressed',String(button.dataset.materialId===mid));
  }catch(error){if(read===productionReadEpoch){reader.replaceChildren();nodeText('p','production-issue',error.message,reader)}}
}
function flatFilterGroup(parent,key,label,options,selected,counts,onchange){
  const group=el('div','production-filter-group');group.setAttribute('role','group');group.setAttribute('aria-label',label);nodeText('span','production-filter-label',label,group);const choices=el('div','production-filter-options');group.append(choices);
  for(const [value,title] of options){const button=productionButton(choices,'',()=>onchange(selected===value?'':value));button.className='production-filter-chip';button.setAttribute('aria-pressed',String(selected===value));button.dataset.filterKey=key;button.dataset.filterValue=value;nodeText('span',null,title,button);nodeText('b','production-filter-count',String(counts?.[value]||0),button)}parent.append(group);
}
async function loadProductionMaterials(){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();const epoch=++breakdownEpoch,workspace=state.workspace,host=$('#production-view'),params=new URL(location.href).searchParams;
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;state.productionEntityId=null;state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;host.replaceChildren();breakdownHeading(host);
  const catalog=await api('/api/production/breakdown');if(epoch!==breakdownEpoch||workspace!==state.workspace)return;
  state.productionRecords=[catalog.lock,...catalog.scenes,...catalog.shots].filter(Boolean);
  const filters=Object.fromEntries(['episode','scene','media','status','search'].map(k=>[k,params.get('material_'+k)||'']));let request=0,offset=0,initial=true;
  const panel=el('section','production-filters'),toolbar=el('div','production-toolbar'),search=el('input');search.type='search';search.placeholder='搜索素材';search.setAttribute('aria-label','搜索素材');search.value=filters.search;toolbar.append(search);productionButton(toolbar,'清除筛选',()=>{for(const k in filters)filters[k]='';search.value='';offset=0;refresh()});panel.append(toolbar);const facets=el('div');panel.append(facets);host.append(panel);
  const layout=el('div','production-board unified-management'),index=el('nav','production-index material-index'),reader=el('article','production-reader');reader.id='production-reader';layout.append(index,reader);host.append(layout);
  async function refresh(){const token=++request,restore=initial;initial=false;rememberProductionDraft();++productionReadEpoch;state.materialReview=null;state.entityReview=null;
    breakdownRoute(Object.fromEntries(Object.entries(filters).map(([k,v])=>['material_'+k,v])));const result=await api('/api/production/materials?'+new URLSearchParams({...filters,offset,...(restore&&params.get('production_object')?{focus:params.get('material_id')||params.get('production_object')}:{})}));if(token!==request||epoch!==breakdownEpoch)return;offset=result.offset??offset;
    facets.replaceChildren();const change=key=>value=>{filters[key]=value;if(key==='episode')filters.scene='';offset=0;refresh()};
    const titles={media:'媒体类型',status:'生成状态',episode:'所属集',scene:'所属场'};
    for(const key of ['media','status','episode','scene']){const options=Object.keys(result.facets[key]).map(v=>[v,!v?'全部':key==='media'?productionMediaLabels[v]:key==='status'?(v==='generated'?'已生成':'未生成'):key==='episode'?(catalog.episodes.find(e=>e.object_id===v)?.title||v):(catalog.episodes.flatMap(e=>e.scenes||[]).find(s=>s.id===v)?.title||v)]);flatFilterGroup(facets,key,titles[key],options,filters[key],result.facets[key],change(key))}
    index.replaceChildren();nodeText('p','production-filter-summary',`${result.total} 项素材`,index);
    for(const media of Object.keys(productionMediaLabels)){const items=result.items.filter(i=>i.media_type===media);if(!items.length)continue;nodeText('h3',null,productionMediaLabels[media],index);const list=el('div','material-small-list');index.append(list);for(const item of items)materialSmallCard(list,item,()=>{for(const b of index.querySelectorAll('[data-material-id]'))b.setAttribute('aria-pressed',String(b.dataset.materialId===item.object_id));openBreakdownMaterial(item,reader)})}
    if(result.focused_outside){nodeText('h3',null,'当前链接素材（筛选外）',index);materialSmallCard(index,result.focused_outside,()=>openBreakdownMaterial({object_id:params.get('production_object'),id:params.get('production_revision')||null},reader,null,true),true)}
    if(offset)productionButton(index,'上一页',()=>{offset=Math.max(0,offset-result.limit);refresh()});if(offset+result.limit<result.total)productionButton(index,'下一页',()=>{offset+=result.limit;refresh()});
    reader.replaceChildren();if(!result.total&&!result.focused_outside){nodeText('p','production-meta','没有符合筛选条件的素材',reader);state.productionSelected=null;renderComments();return}
    const linked=restore&&params.get('production_object'),selected=linked||result.items[0]?.object_id;for(const button of index.querySelectorAll('[data-material-id]'))button.setAttribute('aria-pressed',String(button.dataset.materialId===selected));await openBreakdownMaterial(linked?{object_id:linked,id:params.get('production_revision')||null}:result.items[0],reader,null,restore);
    const active=state.entityReview?.unifiedMaterialId||state.materialCommentCard?.material_id||Object.keys(state.materialReview?.material_versions||{})[0]||state.materialReview?.record.object_id||selected;for(const button of index.querySelectorAll('[data-material-id]'))button.setAttribute('aria-pressed',String(button.dataset.materialId===active));
  }
  let timer;search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{filters.search=search.value;offset=0;refresh()},150)};await refresh();
}
function renderMaterialAdoptionControls(reader,detail){
  if(!detail.adoptionContext)return;
  reader.querySelector('[data-adoption-controls]')?.remove();
  const controls=el('section','production-toolbar');controls.dataset.adoptionControls='true';reader.append(controls);
  const adoption=detail.adoptionContext.adoptions.find(r=>r.payload.slot===detail.record.payload.slot);
  if(adoption)materialReferenceLink(controls,{...adoption.payload.asset,component_id:adoption.payload.component_id,...(adoption.payload.range?{range:adoption.payload.range}:{}),...(adoption.payload.crop?{crop:adoption.payload.crop}:{})},'已采用的准确原件');
  if(detail.candidate_records?.length)productionButton(controls,adoption?'更换采用':'选择采用',()=>showProductionAdoption(controls,{requirement:detail.record,adoption}));

}
function productionDraftKey(){
  const context=typeof materialCommentContext==='function'?materialCommentContext():null;
  return JSON.stringify([state.productionSelected?.id||null,context?.material_id||null,context?.number||null,context?.model||null]);
}
function rememberProductionDraft(){
  if(!isProduction()||!state.productionSelected||!state.anchor)return;
  state.productionDraftContexts||={};state.productionDraftContexts[state.productionDraftScope||productionDraftKey()]={anchor:state.anchor,editing:state.editing,selected:state.selected,scope:state.reviewCommentScope};
}
function restoreProductionDraft(){
  const key=productionDraftKey(),changed=state.productionDraftScope&&state.productionDraftScope!==key;state.productionDraftScope=key;
  const saved=state.productionDraftContexts?.[key];
  if(saved){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected;state.reviewCommentScope=saved.scope}
  else if(changed){state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null}
}
