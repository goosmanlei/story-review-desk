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
function breakdownShotText(parent,shot){
  const blocks=productionTextBlocks(shot);
  const text=reviewSurface(el('div'));text.dataset.productionBlocks=shot.id;text.reviewFocus=()=>{state.breakdownReviewFocus=(state.breakdownReviewFocus||0)+1;focusProductionReview(entityReviewDetail(shot),false)};text.onpointerdown=text.reviewFocus;text.onfocusin=text.reviewFocus;parent.append(text);
  for(const [key,label] of [['purpose','叙事目的'],['framing','构图'],['spatial','空间'],['action_start','起始'],['action_end','结束'],['motion','动作过程'],['continuity','承接']]){
    const block=blocks.find(b=>b.field===key||b.text===shot.payload[key]);if(!block)continue;const line=el('p');nodeText('b',null,label+'　',line);const span=nodeText('span',null,block.text,line);span.dataset.blockId=block.id;text.append(line);
  }
  const sounds=blocks.filter(b=>/^sound\.\d+\.(text|description)$/.test(b.field||''));
  if(sounds.length){const line=el('p');nodeText('b',null,'声音　',line);for(const [index,block] of sounds.entries()){if(index)line.append(document.createTextNode('；'));nodeText('span',null,block.text,line).dataset.blockId=block.id}text.append(line)}
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
  state.breakdownVideoSelections||={};const saved=state.breakdownVideoSelections[need.id]||{},round=rounds.find(r=>r.number===saved.number)||materialDefaultRound(rounds);
  const candidates=(round?.results||[]).map(record=>({record,components:record.payload.components,component:record.payload.components.find(c=>c.role==='original')||record.payload.components[0]}));
  const model={need:round?(round.definition_records?round.definition_records.requirement:round.plan):need,identity:need,candidates,round,rounds,material_id:need.object_id};
  const selected=materialCandidateChoice(candidates,saved.candidate||materialDefaultCandidate(model,{adoptions:context.adoptions}));
  const selection={number:round?.number,candidate:selected?.record.id,reference:productionRef(selected?.record||model.need||round?.definition_records?.call||need)};state.breakdownVideoSelections[need.id]=selection;
  const section=el('section','shot-generation-content');parent.append(section);
  const repaint=()=>{rememberProductionDraft();section.remove();breakdownPrompt(parent,need,context);paintReviewCommentCounts()};
  const bar=el('div','production-toolbar');section.append(bar);
  if(round)materialRoundControl(bar,need.object_id,rounds,round,number=>{state.breakdownVideoSelections[need.id]={number};repaint()});
  if(candidates.length)reviewChoiceButtons(section,'视频候选',candidates.map((item,index)=>({id:item.record.id,label:'候选'+(item.record.candidate_number||index+1)})),selected.record.id,id=>{selection.candidate=id;repaint()});
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
function breakdownEpisodeCount(ep){
  const targets=new Set((ep.comment_targets||[]).map(r=>r.object_id+':'+r.revision_id));
  return new Set((state.comments||[]).filter(c=>c.status!=='DELETED'&&targets.has(c.target_object_id+':'+c.target_revision_id)).map(c=>c.id)).size;
}
function renderBreakdownCommentCounts(){
  for(const ep of state.breakdownData?.episodes||[]){const button=document.querySelector('.breakdown-episode-tabs [data-episode-id="'+CSS.escape(ep.object_id)+'"]');const count=button?.querySelector('.screenplay-episode-count');if(count)count.textContent='评论 '+breakdownEpisodeCount(ep)}
}
function breakdownNavigate(values){
  rememberProductionDraft();const url=new URL(location.href);
  for(const key of ['production_object','production_revision','material_id','material_version','material_round','material_target','production_entity','entity_state'])url.searchParams.delete(key);
  for(const [key,value] of Object.entries(values)){if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value)}
  history.pushState(null,'',url);return loadProductionBreakdown().catch(e=>toast(e.message));
}
function breakdownSelect(row,nav,updateRoute=true){
  state.breakdownCurrent=row;
  for(const button of nav.querySelectorAll('[data-object-id]')){const active=button.dataset.objectId===row.object_id&&button.dataset.revisionId===row.id;button.classList.toggle('active',active);button.setAttribute('aria-current',active?'location':'false')}
  if(updateRoute){const active=nav.querySelector('[aria-current="location"]');if(active?.getBoundingClientRect&&nav.getBoundingClientRect){const r=active.getBoundingClientRect(),edge=nav.getBoundingClientRect();if(r.bottom>edge.bottom)nav.scrollTop+=r.bottom-edge.bottom;if(r.top<edge.top)nav.scrollTop+=r.top-edge.top}}
  if(updateRoute)breakdownRoute({breakdown_object:row.object_id,breakdown_revision:row.id});
}
function breakdownPosition(body){
  return {key:body.dataset.readingKey,scrollTop:body.scrollTop,windowY:window.scrollY};
}
function rememberBreakdownPosition(body){
  const position=breakdownPosition(body);state.breakdownMemory||={};state.breakdownMemory[position.key]=position;
  history.replaceState({...history.state,breakdownPosition:position},'',location.href);
}
function scrollBreakdownTarget(body,target){
  const header=body.querySelector('.breakdown-scene-head'),offset=header?.getBoundingClientRect().height||0;
  body.style.setProperty('--breakdown-header-height',offset+'px');
  if(target===header){body.scrollTop=0;if(matchMedia('(max-width:700px)').matches)header.scrollIntoView({block:'start'});return}
  target.scrollIntoView({block:'start'});
}
async function loadProductionBreakdown(){
  state.productionVisibleEntities=null;state.refreshEntityIndex=null;rememberProductionDraft();
  const oldBody=document.querySelector('.breakdown-body');if(oldBody?.dataset.readingKey){state.breakdownMemory||={};state.breakdownMemory[oldBody.dataset.readingKey]=breakdownPosition(oldBody)}
  const epoch=++breakdownEpoch,workspace=state.workspace,params=new URL(location.href).searchParams,host=$('#production-view'),savedPosition=history.state?.breakdownPosition;
  ++breakdownSelectionEpoch;++productionLoadEpoch;++productionReadEpoch;
  state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionSelected=null;state.productionEntityId=null;
  delete state.breakdownLevels;
  host.replaceChildren();breakdownHeading(host);const loading=nodeText('p',null,'正在读取本集镜头…',host);
  const targetId=params.get('breakdown_object'),targetRevision=params.get('breakdown_revision');
  const query=new URLSearchParams({episode:params.get('breakdown_episode')||''});
  if(targetId){query.set('object_id',targetId);if(targetRevision)query.set('revision_id',targetRevision)}
  const data=await api('/api/production/breakdown?'+query);if(epoch!==breakdownEpoch||workspace!==state.workspace)return;
  loading.remove();state.breakdownData=data;state.productionRecords=[data.lock,...data.scenes,...data.shots].filter(Boolean);
  const episodes=el('nav','screenplay-episodes breakdown-episode-tabs');episodes.setAttribute('aria-label','分集导航');host.append(episodes);
  for(const ep of data.episodes)renderEpisodeCard(episodes,{...ep,payload:{number:ep.number,title:ep.title,scenes:ep.scenes}},ep.object_id===data.episode,breakdownEpisodeCount(ep),()=>{if(ep.object_id!==data.episode)breakdownNavigate({breakdown_episode:ep.object_id,breakdown_scene:null,breakdown_object:null,breakdown_revision:null})});
  const active=episodes.querySelector('.active');if(active){const r=active.getBoundingClientRect(),edge=episodes.getBoundingClientRect();if(r.right>edge.right)episodes.scrollLeft+=r.right-edge.right;if(r.left<edge.left)episodes.scrollLeft+=r.left-edge.left}
  const layout=el('div','breakdown-scene-layout'),nav=el('aside','text-reader-index breakdown-scenes'),head=el('header'),sceneList=el('nav','breakdown-scene-list'),body=el('article','breakdown-body');
  nodeText('h2',null,'本集场镜',head);nav.append(head,sceneList);sceneList.setAttribute('aria-label','场镜导航');body.setAttribute('aria-label',productionTab()==='shots'?'镜头制作':'逐镜设计');layout.append(nav,body);host.append(layout);
  const target=data.shots.find(r=>r.object_id===targetId&&(!targetRevision||r.id===targetRevision))||data.scenes.find(r=>r.object_id===targetId&&(!targetRevision||r.id===targetRevision));
  if(targetId&&!target)throw Error('准确场镜不在此目录；未替换为同名或最新对象');
  const selected=(target?.kind==='SHOT_DESIGN'?data.scenes.find(r=>r.id===target.payload.parent?.revision_id):target)||data.scenes.find(r=>r.object_id===params.get('breakdown_scene'))||data.scenes[0];
  state.breakdownExpanded||={};
  for(const scene of data.scenes){
    const group=el('section','breakdown-directory-scene'),line=el('div','breakdown-directory-heading'),children=el('div','breakdown-directory-shots'),key=scene.id;
    const toggle=productionButton(line,'',()=>{children.hidden=!children.hidden;state.breakdownExpanded[key]=!children.hidden;toggle.textContent=children.hidden?'▸':'▾';toggle.setAttribute('aria-expanded',String(!children.hidden))});
    toggle.className='breakdown-directory-toggle';toggle.setAttribute('aria-label','展开／收起 '+breakdownSceneTitle(scene));children.hidden=state.breakdownExpanded[key]===false;toggle.textContent=children.hidden?'▸':'▾';toggle.setAttribute('aria-expanded',String(!children.hidden));
    const choose=row=>()=>breakdownNavigate({breakdown_episode:data.episode,breakdown_scene:scene.object_id,breakdown_object:row.object_id,breakdown_revision:row.id});
    const button=productionButton(line,breakdownSceneTitle(scene),choose(scene));button.className='source-button';button.dataset.objectId=scene.object_id;button.dataset.revisionId=scene.id;
    for(const shot of data.shots.filter(r=>r.payload.parent?.revision_id===scene.id)){const button=productionButton(children,breakdownShotTitle(shot),choose(shot));button.className='source-button';button.dataset.objectId=shot.object_id;button.dataset.revisionId=shot.id}
    group.append(line,children);sceneList.append(group);
  }
  if(selected)await showBreakdownScene(selected,body,sceneList,epoch,params,savedPosition);else nodeText('p',null,'本集尚无场次设计',body);
  const materialTarget=params.get('production_object');
  if(epoch===breakdownEpoch&&workspace===state.workspace&&materialTarget&&params.has('material_id')&&!data.scenes.some(r=>r.object_id===materialTarget)&&!data.shots.some(r=>r.object_id===materialTarget)){
    breakdownRoute({material_id:null,material_version:null,material_round:null,material_target:null,production_entity:null,entity_state:null});
    await openUnifiedMaterial({object_id:materialTarget,revision_id:params.get('production_revision'),params},null);
  }
}
function groupedShotMaterials(items){
  const unique=[...new Map(items.map(i=>[i.canonical_material_id||i.object_id,i])).values()],groups=new Map();
  for(const item of unique){const c=item.classification||{key:item.media_type+':other',label:(productionLabels[item.media_type]||({image:'图像',audio:'音频',video:'视频'})[item.media_type]||item.media_type)+'—其他'};if(!groups.has(c.key))groups.set(c.key,{...c,items:[]});groups.get(c.key).items.push(item)}
  const media=['image','audio','video','project','document'];return [...groups.values()].sort((a,b)=>media.indexOf(a.key.split(':')[0])-media.indexOf(b.key.split(':')[0])||a.label.localeCompare(b.label,'zh-CN'));
}
async function showBreakdownScene(scene,body,nav,epoch,restore=null,savedPosition=null){
  const request=++breakdownSelectionEpoch,workspace=state.workspace,targetId=restore?.get('breakdown_object'),targetRevision=restore?.get('breakdown_revision'),shot=(state.breakdownData.shots||[]).find(r=>r.object_id===targetId&&r.id===targetRevision);
  const data=await api('/api/production/scene?'+new URLSearchParams({object_id:scene.object_id,revision_id:scene.id,...(shot?{shot_revision:shot.id}:{})}));if(epoch!==breakdownEpoch||request!==breakdownSelectionEpoch||workspace!==state.workspace)return;
  body.replaceChildren();state.breakdownSceneData=data;body.dataset.sceneId=scene.object_id;body.dataset.readingKey=scene.id+':'+(shot?.id||'');
  breakdownRoute({breakdown_episode:state.breakdownData.episode,breakdown_scene:scene.object_id});
  const page=el('section','breakdown-scene');body.append(page);
  const header=el('header','text-reader-head breakdown-scene-head'),heading=el('div','breakdown-scene-heading');nodeText('h2',null,breakdownSceneTitle(data.scene),heading);materialReferenceLink(heading,data.scene.payload.source,'剧情依据','full_scene');header.append(heading);page.append(header);
  for(const item of data.shots){const shot=item.record,row=el('article','breakdown-row breakdown-shot');row.dataset.shotId=shot.object_id;row.dataset.shotRevision=shot.id;
    const text=el('section','breakdown-shot-copy'),materials=el('aside','breakdown-shot-materials'),heading=el('header'),title=el('div','breakdown-shot-heading');nodeText('h3',null,breakdownShotTitle(shot),title);materialReferenceLink(title,shot.payload.source,'查看本镜剧情依据','full_scene');heading.append(title);nodeText('small',null,`${shot.payload.duration_frames/shot.payload.fps} 秒`,heading);text.append(heading);
    if(productionTab()==='shots'){const needs=item.context.requirements.filter(r=>r.payload.media_type==='video');for(const need of needs)breakdownPrompt(text,need,item.context);if(!needs.length)nodeText('p','production-meta','本镜视频生成方案待补齐',text)}else breakdownShotText(text,shot);
    row.append(text,materials);page.append(row);nodeText('h4',null,productionTab()==='shots'?'本镜视频':'本镜素材',materials);
    const items=(item.context.materials||[]).filter(i=>productionTab()!=='shots'||i.media_type==='video');
    for(const group of groupedShotMaterials(items)){const section=el('section','breakdown-material-group');nodeText('h5',null,group.label,section);materials.append(section);
      for(const item of group.items)materialSmallCard(section,item,trigger=>{const choice=state.breakdownVideoSelections?.[item.id],params=choice?.number?new URLSearchParams({material_id:item.object_id,material_version:choice.number,...(choice.candidate?{material_target:choice.candidate}:{})}):item.canonical_material_id?new URLSearchParams({material_id:item.canonical_material_id}):null;
        openUnifiedMaterial({...item.reference,...choice?.reference,object_id:choice?.reference?.object_id||item.reference?.object_id||item.object_id,revision_id:choice?.reference?.revision_id||item.reference?.revision_id||item.id,params,defaultSelection:!choice&&item.association!=='adoption'&&item.record?.kind!=='ASSET'},trigger)},false,{includesHistory:item.generation_scope==='history',showHistoryScope:true}).dataset.reviewDialogTrigger='';
    }
    if(!items.length)nodeText('p','production-meta','本镜暂无关联素材',materials);
  }
  state.productionRecords=[...state.productionRecords,...data.shots.map(s=>s.record),data.scene,...(data.shared||[]).flatMap(c=>[c.record,...c.requirements,...c.entities,...c.states]),...data.shots.flatMap(s=>s.context.requirements)];
  const chosen=data.shots.find(s=>s.record.object_id===targetId&&(!targetRevision||s.record.id===targetRevision))?.record||data.scene;
  focusProductionReview(entityReviewDetail(chosen),false);restoreProductionDraft();breakdownSelect(chosen,nav);paintReviewCommentCounts();renderComments();
  const target=chosen.kind==='SHOT_DESIGN'?page.querySelector('[data-shot-id="'+CSS.escape(chosen.object_id)+'"]'):header;
  const memory=savedPosition?.key===body.dataset.readingKey?savedPosition:!targetId?state.breakdownMemory?.[body.dataset.readingKey]:null;
  scrollBreakdownTarget(body,target);if(memory){body.scrollTop=memory.scrollTop;window.scrollTo(0,memory.windowY)}
  let frame=null;
  const track=()=>{if(frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;if(epoch!==breakdownEpoch||!body.isConnected||document.querySelector('dialog[open]'))return;
    const edge=body.getBoundingClientRect(),limit=matchMedia('(max-width:700px)').matches?Math.max(0,document.querySelector('.workspace-topbar')?.getBoundingClientRect().bottom||0)+20:Math.max(edge.top,parseFloat(getComputedStyle(header).top)||0)+header.getBoundingClientRect().height+20;
    const rows=[...page.querySelectorAll('[data-shot-id]')],visible=rows.filter(r=>r.getBoundingClientRect().top<=limit).at(-1);
    const current=visible?data.shots.find(s=>s.record.id===visible.dataset.shotRevision)?.record:data.scene;if(current)breakdownSelect(current,nav,false);rememberBreakdownPosition(body);
  })};body.onscroll=track;
  // The narrow reader scrolls with the window. Old listeners remove themselves.
  const windowTrack=()=>{if(epoch!==breakdownEpoch){window.removeEventListener('scroll',windowTrack);return}if(matchMedia('(max-width:700px)').matches)track()};window.addEventListener('scroll',windowTrack,{passive:true});
  rememberBreakdownPosition(body);
}

async function openBreakdownMaterial(need,reader,selectionEpoch=null,restore=false){
  rememberProductionDraft();const read=++productionReadEpoch,workspace=state.workspace,params=restore?new URL(location.href).searchParams:new URLSearchParams();
  reader.replaceChildren();nodeText('p',null,'正在读取素材…',reader);
  if(!restore)breakdownRoute({material_id:null,material_version:null,material_round:null,material_target:null,production_entity:null,entity_state:null});
  try{const result=await readUnifiedCard(need.object_id,need.id||null,params);if(read!==productionReadEpoch||workspace!==state.workspace||selectionEpoch!==null&&selectionEpoch!==breakdownSelectionEpoch)return;
    result.allowDraftFocus=!restore;result.defaultSelection=!restore;state.unifiedCardRoot=null;activateUnifiedCard(result);renderProductionReader();renderComments();
    const mid=state.entityReview?.unifiedMaterialId||Object.keys(result.detail.material_versions||{})[0]||result.detail.record.object_id;
    for(const button of document.querySelectorAll('.material-index [data-material-id]'))button.setAttribute('aria-pressed',String(button.dataset.materialId===mid));
  }catch(error){if(read===productionReadEpoch){reader.replaceChildren();nodeText('p','production-issue',error.message,reader)}}
}
function flatFilterGroup(parent,key,label,options,selected,counts,onchange){
  const group=el('div','production-filter-group');group.setAttribute('role','group');group.setAttribute('aria-label',label);nodeText('span','production-filter-label',label,group);const choices=el('div','production-filter-options');group.append(choices);
  for(const [value,title] of options){const button=productionButton(choices,'',()=>onchange(selected===value?'':value));button.className='production-filter-chip';button.setAttribute('aria-pressed',String(selected===value));button.dataset.filterKey=key;button.dataset.filterValue=value;nodeText('span',null,title,button);nodeText('b','production-filter-count',String(counts?.[value]||0),button)}parent.append(group);
}
async function loadProductionMaterials(){return loadMaterialManagement()}

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

async function openBreakdownSceneNotes(row,comment){
  const {dialog,body}=openReviewDialog('历史制作说明 · '+breakdownSceneTitle(row),document.activeElement,'material-reference-dialog');
  const detail=await api('/api/production?'+new URLSearchParams({object_id:row.object_id,revision_id:row.id}));if(!dialog.isConnected)return;
  const session=referenceReviewSession(dialog,detail);const surface=materialTextSurface(body,detail.record);
  for(const block of productionTextBlocks(detail.record))nodeText('p',null,block.text,surface).dataset.blockId=block.id;
  session.focus();state.selected=comment.id;paintReviewCommentCounts();openPanel();renderComments();surface.querySelector('[data-block-id="'+CSS.escape(comment.anchor.block_id)+'"]')?.scrollIntoView({block:'center'});
}
