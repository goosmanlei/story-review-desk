/* Episode / scene navigation and all-shot rows share one exact context reader. */
let breakdownEpoch=0,breakdownSelectionEpoch=0;
function productionTab(){const p=new URL(location.href).searchParams;if(state.workspace==='materials.workspace')return 'materials';if(state.workspace==='production.workspace')return p.get('production_tab')==='history'?'history':'shots';return (['entities','materials','breakdown'].includes(p.get('production_tab'))?p.get('production_tab'):null)||((p.has('production_entity')||p.has('entity_state'))?'entities':'breakdown')}
function productionTabs(){if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs()}
function breakdownRoute(values){const url=new URL(location.href);for(const [k,v] of Object.entries(values)){if(v===null)url.searchParams.delete(k);else url.searchParams.set(k,v)}history.replaceState(history.state,'',url)}
function breakdownHeading(host){const h=nodeText('h1','production-heading',state.workspace==='production.workspace'?'全剧制作':'制作设定',host);productionTabs(host)}
function breakdownSceneTitle(row){return reviewPositionLabel('scene',row.payload.source?.scene_id||row.payload.scene_id)+' · '+row.payload.title.replace(/^\d+-\d+\s*/,'')}
function breakdownShotTitle(row){return reviewPositionLabel('shot',row.payload.number)+' · '+row.payload.title.replace(/^E\d+-\d+\s*/i,'')}
function breakdownEpisodeTitle(episode){
  if(!episode)return '';
  const title=String(episode.title||episode.payload?.title||''),number=episode.number??episode.payload?.number;
  if(number===undefined||number===null)return reviewPositionText(title);
  const name=title.replace(/^(?:第\s*\d+\s*集|E\d+)\s*[·:：-]?\s*/iu,'');
  return reviewPositionLabel('episode',number)+(name?' · '+name:'');
}
function breakdownFacetTitle(key,value,catalog){
  if(key==='episode')return breakdownEpisodeTitle(catalog.episodes.find(e=>e.object_id===value))||reviewPositionText(value);
  const scene=catalog.episodes.flatMap(e=>e.scenes||[]).find(s=>s.id===value);
  return scene?breakdownSceneTitle({payload:{source:{scene_id:scene.id},title:scene.title}}):reviewPositionLabel('scene',value);
}
function breakdownLevel(row){return ({INPUT_LOCK:'story',STORY:'story',EPISODE:'episode',PREPARATION:'scene',SHOT_DESIGN:'shot'})[row.kind]}
function breakdownScopeFilters(parent,onchange){
  const filters=el('div','production-filter-group breakdown-levels');filters.setAttribute('role','group');filters.setAttribute('aria-label','素材归属');nodeText('span','production-filter-label','素材归属',filters);state.breakdownLevels||=['story','episode','scene','shot','entity','state'];
  const choices=el('div','production-filter-options');filters.append(choices);
  for(const [id,title] of [['story','剧'],['episode','集'],['scene','场'],['shot','镜'],...(['entity','state'].filter(level=>state.breakdownSceneData?.shots.some(s=>s.context.materials.some(m=>m.placement_level===level))).map(level=>[level,level==='entity'?'实体':'状态']))]){const button=productionButton(choices,title,()=>{state.breakdownLevels=state.breakdownLevels.includes(id)?state.breakdownLevels.filter(v=>v!==id):[...state.breakdownLevels,id];button.setAttribute('aria-pressed',String(state.breakdownLevels.includes(id)));onchange()});button.className='production-filter-chip';button.setAttribute('aria-pressed',String(state.breakdownLevels.includes(id)))}parent.append(filters);
}
function breakdownShotText(parent,shot){
  const blocks=productionTextBlocks(shot);
  const text=reviewSurface(el('div'));text.dataset.productionBlocks=shot.id;text.reviewFocus=()=>{state.breakdownReviewFocus=(state.breakdownReviewFocus||0)+1;focusProductionReview(entityReviewDetail(shot),false)};text.onpointerdown=text.reviewFocus;text.onfocusin=text.reviewFocus;parent.append(text);
  for(const [key,label] of [['purpose','叙事目的'],['framing','构图'],['spatial','空间'],['action_start','起始'],['action_end','结束'],['motion','动作过程'],['continuity','承接']]){
    const block=blocks.find(b=>b.field===key||b.text===shot.payload[key]);if(!block)continue;const line=el('p');nodeText('b',null,label+'　',line);const span=nodeText('span',null,block.text,line);span.dataset.blockId=block.id;text.append(line);
  }
  const sounds=blocks.filter(b=>/^sound\.\d+\.(text|description)$/.test(b.field||''));
  if(sounds.length){const line=el('p');nodeText('b',null,'声音　',line);for(const [index,block] of sounds.entries()){if(index)line.append(document.createTextNode('；'));nodeText('span',null,block.text,line).dataset.blockId=block.id}text.append(line)}
  materialReferenceLink(parent,shot.payload.source,'查看本镜剧情依据',true);
}
function renderLinkedPrompt(parent,row,inputs,records,field){
  const block=productionTextBlocks(row).find(b=>b.field===field);if(!block)return;
  const pre=el('pre','shot-generation-prompt');pre.dataset.blockId=block.id;
  const refs=materialInputs(inputs,records),byLabel=new Map(refs.map(item=>[item.label,item]));
  const pattern=/@?(?:图片|图像|音频|声音|视频|输入)\s*\d+/gu;let offset=0;
  for(const match of block.text.matchAll(pattern)){
    pre.append(document.createTextNode(block.text.slice(offset,match.index)));const label=match[0].replace(/^@/,'').replace(/\s/g,'').replace(/^图像/,'图片').replace(/^声音/,'音频');const input=byLabel.get(label)||(/^输入\d+$/.test(label)?refs.find(i=>i.index===Number(label.slice(2))-1):null);
    if(input&&!input.missing){const a=el('a','prompt-reference');a.dataset.reviewDialogTrigger='';a.href=materialReferenceRequest(input.ref,false).url;a.textContent=match[0];a.onclick=e=>{e.preventDefault();if(getSelection()?.isCollapsed)openMaterialReference(input.ref,a)};pre.append(a)}else pre.append(document.createTextNode(match[0]));offset=match.index+match[0].length;
  }
  pre.append(document.createTextNode(block.text.slice(offset)));parent.append(pre);
}
function breakdownPrompt(parent,need,context){
  const detail=context.video_details?.[need.object_id],rounds=detail?.material_versions?.[need.object_id]||[];
  state.breakdownVideoSelections||={};const saved=state.breakdownVideoSelections[need.id]||{},round=rounds.find(r=>r.number===saved.number)||rounds[0];
  const candidates=(round?.results||[]).map(record=>({record,components:record.payload.components,component:record.payload.components.find(c=>c.role==='original')||record.payload.components[0]}));
  const model={need:round?(round.definition_records?round.definition_records.requirement:round.plan):need,identity:need,candidates,round,rounds,material_id:need.object_id};
  const selected=materialCandidateChoice(candidates,saved.candidate||materialDefaultCandidate(model,{adoptions:context.adoptions}));
  const selection={number:round?.number,candidate:selected?.record.id};state.breakdownVideoSelections[need.id]=selection;
  const section=el('section','shot-generation-content');parent.append(section);
  const repaint=()=>{rememberProductionDraft();section.remove();breakdownPrompt(parent,need,context);paintReviewCommentCounts()};
  const bar=el('div','production-toolbar');section.append(bar);
  if(round)materialRoundControl(bar,need.object_id,rounds,round,number=>{state.breakdownVideoSelections[need.id]={number};repaint()});
  if(candidates.length){const choice=el('select');choice.disabled=candidates.length===1;choice.setAttribute('aria-label','视频候选');for(const item of candidates)choice.append(new Option(reviewPositionText(item.record.payload.title),item.record.id));choice.value=selected.record.id;choice.onchange=()=>{selection.candidate=choice.value;repaint()};bar.append(choice)}
  if(selected){
    const actual=detail.review_contexts?.[selected.record.id],call=actual?.call;
    nodeText('h4',null,'所选视频的真实生成内容',section);
    if(!call){nodeText('p','production-issue','此候选未登记真实调用，无法还原输入与提示词',section);return}
    const host=materialTextSurface(section,call);renderMaterialInputs(host,call.payload.inputs||[],actual.inputs||[]);materialParameters(host,call,'call',call.payload.model);renderLinkedPrompt(host,call,call.payload.inputs||[],actual.inputs||[],'call.prompt');
  }else{
    const call=round?.definition_records?.call;if(call){const host=materialTextSurface(section,call);nodeText('h4',null,'已提交 · 尚无原件结果',host);renderMaterialInputs(host,call.payload.inputs||[],call.review_input_records||[]);materialParameters(host,call,'call',call.payload.model);renderLinkedPrompt(host,call,call.payload.inputs||[],call.review_input_records||[],'call.prompt');return}
    const plan=model.need?.payload.generation;if(!plan){nodeText('p','production-meta',round?'此视频版本未保留完整生成方案':'视频生成方案待完善',section);return}
    const host=materialTextSurface(section,model.need);nodeText('h4',null,'待生成 · 视频方案',host);renderMaterialInputs(host,plan.inputs||[],model.need.review_input_records||[],model.need);materialParameters(host,model.need,'generation',plan.model);renderLinkedPrompt(host,model.need,plan.inputs||[],model.need.review_input_records||[],'generation.prompt');
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
  for(const ep of data.episodes){const button=productionButton(episodes,breakdownEpisodeTitle(ep),()=>{breakdownRoute({breakdown_episode:ep.object_id,breakdown_scene:null,breakdown_object:null,breakdown_revision:null,production_object:null,production_revision:null});loadProductionBreakdown().catch(e=>toast(e.message))});button.className='source-button';button.classList.toggle('active',ep.object_id===data.episode);button.setAttribute('aria-current',ep.object_id===data.episode?'true':'false')}
  const layout=el('div','breakdown-scene-layout'),nav=el('aside','text-reader-index breakdown-scenes'),head=el('header'),sceneList=el('nav','breakdown-scene-list'),body=el('article','breakdown-body');nodeText('h2',null,'本集场次',head);nav.append(head,sceneList);sceneList.setAttribute('aria-label','场次导航');body.setAttribute('aria-label',productionTab()==='shots'?'镜头制作':'逐镜设计');layout.append(nav,body);host.append(layout);
  let selected=data.scenes.find(s=>s.object_id===params.get('breakdown_scene'));
  const targetId=params.get('breakdown_object')||params.get('production_object'),target=data.shots.find(r=>r.object_id===targetId)||data.scenes.find(r=>r.object_id===targetId);
  if(target)selected=target.kind==='PREPARATION'?target:data.scenes.find(s=>s.object_id===target.payload.parent?.object_id)||data.scenes.find(s=>s.payload.source.scene_id===target.payload.scene_id);
  selected||=data.scenes[0];
  for(const scene of data.scenes){const button=productionButton(sceneList,breakdownSceneTitle(scene),()=>showBreakdownScene(scene,body,sceneList,epoch));button.className='source-button';button.dataset.sceneId=scene.object_id}
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
  breakdownRoute({breakdown_episode:state.breakdownData.episode,breakdown_scene:scene.object_id,...(!restore?{breakdown_object:null,breakdown_revision:null,production_object:null,production_revision:null,material_id:null,material_version:null,material_round:null,material_target:null}:{breakdown_object:targetId||null,breakdown_revision:targetRevision||null})});
  const page=el('section','breakdown-scene');body.append(page);
  const header=el('header','text-reader-head breakdown-scene-head'),heading=el('div','breakdown-scene-heading');nodeText('h2',null,breakdownSceneTitle(data.scene),heading);materialReferenceLink(heading,data.scene.payload.source,'剧情依据',true);header.append(heading);page.append(header);
  nodeText('p','production-meta',[scene.source_meta?.location,scene.source_meta?.time].filter(Boolean).join(' · '),header);
  const surface=materialTextSurface(header,data.scene);for(const block of data.scene.payload.blocks||[]){const p=nodeText('p',null,block.text,surface);p.dataset.blockId=block.id}
  breakdownScopeFilters(header,renderMaterials);const rows=[];
  for(const item of data.shots){const shot=item.record,row=el('article','breakdown-row breakdown-shot');row.dataset.shotId=shot.object_id;
    const text=el('section','breakdown-shot-copy'),materials=el('aside','breakdown-shot-materials'),heading=el('header');nodeText('h3',null,breakdownShotTitle(shot),heading);nodeText('small',null,`${shot.payload.duration_frames/shot.payload.fps} 秒`,heading);text.append(heading);
    if(productionTab()==='shots'){const needs=item.context.requirements.filter(r=>r.payload.media_type==='video');for(const need of needs)breakdownPrompt(text,need,item.context);if(!needs.length)nodeText('p','production-meta','本镜视频生成方案待补齐',text)}else breakdownShotText(text,shot);
    row.append(text,materials);page.append(row);rows.push({item,materials});
  }
  function renderMaterials(){for(const {item,materials} of rows){
    materials.replaceChildren();nodeText('h4',null,productionTab()==='shots'?'本镜视频':'本镜素材',materials);
    const items=[...new Map((item.context.materials||[]).map(i=>[i.canonical_material_id||i.object_id,i])).values()].filter(i=>(productionTab()!=='shots'||i.media_type==='video')&&state.breakdownLevels.includes(i.placement_level||breakdownLevel({kind:i.placement_kind})||'shot'));
    for(const item of items)materialSmallCard(materials,item,trigger=>{const choice=state.breakdownVideoSelections?.[item.id],params=choice?.number?new URLSearchParams({material_id:item.object_id,material_version:choice.number,...(choice.candidate?{material_target:choice.candidate}:{})}):null;openUnifiedMaterial({object_id:item.object_id,revision_id:item.id,params},trigger)},false,{includesHistory:item.generation_scope==='history',showHistoryScope:true}).dataset.reviewDialogTrigger='';
    if(!items.length)nodeText('p','production-meta',state.breakdownLevels.length?'暂无符合归属的素材':'未选择素材归属',materials);
  }}
  renderMaterials();body.scrollTop=state.breakdownMemory[scene.object_id]||0;
  state.productionRecords=[...state.productionRecords,...(data.shared||[]).flatMap(c=>[c.record,...c.requirements,...c.entities,...c.states]),...data.shots.flatMap(s=>[s.record,...s.context.requirements])];
  // Comment focus remains exact without making a scene or shot a selectable region.
  const chosen=data.shots.find(s=>s.record.object_id===targetId)?.record||data.scene;focusProductionReview(entityReviewDetail(chosen),false);restoreProductionDraft();paintReviewCommentCounts();renderComments();
  if(targetId&&chosen.kind==='SHOT_DESIGN')page.querySelector(`[data-shot-id="${CSS.escape(chosen.object_id)}"]`)?.scrollIntoView({block:'start'});
}

async function openBreakdownMaterial(need,reader,selectionEpoch=null,restore=false){
  rememberProductionDraft();const read=++productionReadEpoch,workspace=state.workspace,params=restore?new URL(location.href).searchParams:new URLSearchParams();
  reader.replaceChildren();nodeText('p',null,'正在读取素材…',reader);
  if(!restore)breakdownRoute({material_id:null,material_version:null,material_round:null,material_target:null,production_entity:null,entity_state:null});
  try{const result=await readUnifiedCard(need.object_id,need.id||null,params);if(read!==productionReadEpoch||workspace!==state.workspace||selectionEpoch!==null&&selectionEpoch!==breakdownSelectionEpoch)return;
    result.allowDraftFocus=!restore;state.unifiedCardRoot=null;activateUnifiedCard(result);renderProductionReader();renderComments();
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
    const titles={media:'媒体类型',status:'生成结果（含历史版本）',episode:'所属集',scene:'所属场'};
    for(const key of ['media','status','episode','scene']){const options=Object.keys(result.facets[key]).map(v=>[v,!v?'全部':key==='media'?productionMediaLabels[v]:key==='status'?(v==='generated'?'有结果':'无结果'):breakdownFacetTitle(key,v,catalog)]);flatFilterGroup(facets,key,titles[key],options,filters[key],result.facets[key],change(key))}
    index.replaceChildren();nodeText('p','production-filter-summary',`${result.total} 项素材`,index);
    for(const media of Object.keys(productionMediaLabels)){const items=result.items.filter(i=>i.media_type===media);if(!items.length)continue;nodeText('h3',null,productionMediaLabels[media],index);const list=el('div','material-small-list');index.append(list);for(const item of items)materialSmallCard(list,item,()=>{for(const b of index.querySelectorAll('[data-material-id]'))b.setAttribute('aria-pressed',String(b.dataset.materialId===item.object_id));openBreakdownMaterial(item,reader)},false,{includesHistory:true})}
    if(result.focused_outside){nodeText('h3',null,'当前链接素材（筛选外）',index);materialSmallCard(index,result.focused_outside,()=>openBreakdownMaterial({object_id:params.get('production_object'),id:params.get('production_revision')||null},reader,null,true),true,{includesHistory:true})}
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
  if(detail.candidate_records?.length)productionButton(controls,adoption?'更换采用':'选择采用',()=>showProductionAdoption(controls,{requirement:detail.record,adoption,candidates:detail.candidate_records}));

}
function productionDraftKey(){
  const context=typeof materialCommentContext==='function'?materialCommentContext():null;
  return JSON.stringify([state.productionSelected?.id||null,context?.material_id||null,context?.number||null,context?.model||null]);
}
function rememberProductionDraft(){
  if(!isProduction()||!state.productionSelected||!state.anchor)return;
  if(state.productionDraftScope&&state.productionDraftScope!==productionDraftKey())return;
  state.productionDraftContexts||={};state.productionDraftContexts[state.productionDraftScope||productionDraftKey()]={anchor:state.anchor,editing:state.editing,selected:state.selected,scope:state.reviewCommentScope,draftKey:typeof draftKey==='function'?draftKey():null};
}
function restoreProductionDraft(){
  const key=productionDraftKey(),changed=state.productionDraftScope&&state.productionDraftScope!==key;state.productionDraftScope=key;
  const saved=state.productionDraftContexts?.[key];
  if(saved){state.anchor=saved.anchor;state.editing=saved.editing;state.selected=saved.selected;state.reviewCommentScope=saved.scope}
  else if(changed){state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null}
}
