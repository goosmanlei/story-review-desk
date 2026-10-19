function materialCategoryLabel(category){return ({'character-image':'角色图像','scene-image':'场景图像','prop-image':'道具图像','shot-image':'镜头画面',voice:'人物音色','scene-sound':'场景音',song:'演唱',video:'视频','text-layer':'字层'})[category]||''}
/* One entity/material reader, whether embedded or opened over a scene. */
function materialModelKey(model){return model.material_id||model.need?.object_id||model.identity?.object_id||model.candidates[0]?.record.object_id}
function materialDefaultCandidate(model,data){
  if(model.round?.current_content&&model.need)return 'current';
  return materialCandidateChoice(model.candidates||[],null)?.record.id||null;
}
function reviewSmallCard(parent,item,activate,selected=false){
  const button=item.inlineControls?el('div'):productionButton(parent,'',()=>activate(button));if(item.inlineControls)parent.append(button);button.className='material-small-card';if(!item.inlineControls){button.setAttribute('aria-pressed',String(selected));button.title=item.title}
  const preview=el('span','material-small-preview');
  if(item.preview?.mime?.startsWith('image/')){const img=el('img');img.src=reviewURL('/api/production/files/'+encodeURIComponent(item.preview.file)+'?variant=small');img.alt='';img.loading='lazy';preview.append(img)}else preview.append(productionEntityIcon(item.icon));
  if(item.preview?.mime?.startsWith('image/')||(item.inlineControls&&item.icon==='image')){
    if(!item.preview?.mime?.startsWith('image/')){preview.dataset.placeholder='true';preview.setAttribute('role','img');preview.setAttribute('aria-label','未选定原件');preview.title='未选定原件'}
    button.append(preview);
  }
  const content=el('span','material-small-copy'),heading=item.inlineControls?productionButton(content,'',()=>activate(heading)):el('span','small-card-title'),icon=productionEntityIcon(item.icon);if(item.inlineControls){heading.className='small-card-title reference-material-name';heading.title=item.title}
  const type=materialCategoryLabel(item.material_category)||productionLabels[item.icon]||productionMediaLabels[item.icon]||item.icon||'对象';icon.setAttribute('aria-hidden','false');icon.setAttribute('role','img');icon.setAttribute('aria-label',type);icon.setAttribute('title',type);heading.append(icon);
  const name=nodeText('strong',null,item.title,heading);name.title=item.title;
  if(item.business_code)nodeText('span','small-card-code',item.business_code,heading);if(!item.inlineControls)content.append(heading);
  if(item.subtitle)nodeText('small','small-card-metrics',item.subtitle,content);
  if(item.selectionSubtitle)nodeText('small','small-card-selection',item.selectionSubtitle,content);
  button.append(content);return button;
}
function materialPositionText(item,value=item.title){
  const scope=item.placement||item.record?.payload.scope||item.scope;
  const same=row=>scope&&row?.object_id===scope.object_id&&row?.id===scope.revision_id;
  const location=(item.locations||[]).find(row=>row.kind==='AV_SCENE'&&scope&&row.scope?.object_id===scope.object_id&&row.scope?.revision_id===scope.revision_id);
  const owner=[state.unifiedScope,state.breakdownSceneData?.scene,...(state.productionRecords||[])].find(same);
  const scene=location?.scene||(owner?.kind==='AV_SCENE'&&(owner.payload.source?.scene_id||owner.payload.scene_id));
  const title=readableProductionTitle(item,value);return scene?reviewPositionText(title.replace(/^\d+-\d+\s*/,(businessCode(owner)||reviewPositionLabel('scene',scene,location?.episode||owner?.payload.source?.object_id))+' · ')):reviewPositionText(title);
}
function materialCountText(item){
  const count=(key,label)=>Number.isInteger(item[key])&&item[key]>=0?`${label} ${item[key]} 个`:`${label}未登记`;
  return count('candidate_count','候选');
}
function materialSmallCard(parent,item,activate,selected=false,{includesHistory=false,showHistoryScope=false,subtitle=null}={}){
  const counts=materialCountText(item);
  const button=reviewSmallCard(parent,{...item,title:materialPositionText(item),business_code:businessCode(item),icon:item.media_type,subtitle:counts,selectionSubtitle:subtitle},activate,selected);button.dataset.materialId=item.canonical_material_id||item.object_id;
  if(item.placement_title){const text=materialPositionText(item,item.placement_title);button.title+=' · '+text}
  return button;
}

function modelSmallItem(model){
  const row=model.need||model.identity||model.candidates[0]?.record,real=(model.candidates||[]).filter(i=>!i.record.payload.placeholder&&i.record.payload.components.some(c=>c.role==='original'));
  return {...model.cardCounts,business_code:materialModelCode(model),object_id:materialModelKey(model),id:row.id,title:row.payload.generation?.output.name||row.payload.title,media_type:row.payload.media_type,material_category:row.payload.material_category,scope:row.payload.scope,slot:row.payload.slot,generated:real.length>0,preview:real.flatMap(i=>i.record.payload.components).find(c=>c.role==='original'&&c.mime.startsWith('image/'))||real.flatMap(i=>i.record.payload.components).find(c=>['preview','thumbnail'].includes(c.role)&&c.mime.startsWith('image/'))};
}
// Source help is transient information. Original comments use the existing
// exact-text reader, so hovering never enters or changes a review session.
function materialSourceText(parent,row,fields=null){
  const host=el('div','material-source-text');parent.append(host);
  for(const block of productionTextBlocks(row).filter(block=>!fields||fields.includes(block.field)||fields.includes(block.id)))nodeText('p',null,block.text,host);
  return host;
}
function materialSourceSection(parent,label,row,render){
  const section=el('section','material-source-group'),heading=el('div','material-source-heading');section.dataset.sourceRevision=row.id;section.setAttribute('aria-label',label);nodeText('h4',null,label,heading);section.append(heading);parent.append(section);
  const button=productionButton(heading,'',()=>open());button.className='material-source-question';button.append(productionEntityIcon('help'));button.setAttribute('aria-label',label+'来源说明');button.setAttribute('aria-expanded','false');
  let popup=null,timer=null;
  const close=()=>{clearTimeout(timer);popup?.remove();popup=null;button.setAttribute('aria-expanded','false')};
  const enclosingDialog=button.closest('dialog');enclosingDialog?.addEventListener('close',event=>{if(event.target===enclosingDialog)close()},{capture:true});
  const leave=()=>{clearTimeout(timer);timer=setTimeout(close,100)};
  const open=()=>{
    clearTimeout(timer);if(popup)return;
    popup=el('section','material-source-explanation');popup.setAttribute('role','tooltip');popup.setAttribute('aria-label',label+'来源说明');(button.closest('dialog')||document.body).append(popup);button.setAttribute('aria-expanded','true');
    const currentPopup=popup,body=el('div','material-source-description');popup.append(body);
    Promise.resolve(render(body)).catch(error=>{if(popup===currentPopup&&currentPopup.isConnected){body.replaceChildren();nodeText('p','production-issue','来源说明读取失败：'+error.message+'；重新悬停可重试。',body)}});
    const rect=button.getBoundingClientRect(),width=Math.min(420,window.innerWidth-24),below=window.innerHeight-rect.bottom-18,height=Math.min(520,below<280&&rect.top>280?rect.top-18:Math.max(160,below)),top=below<280&&rect.top>280?rect.top-height-6:Math.min(rect.bottom+6,window.innerHeight-height-12);popup.style.width=width+'px';popup.style.left=Math.max(12,Math.min(rect.left,window.innerWidth-width-12))+'px';popup.style.top=Math.max(12,top)+'px';popup.style.maxHeight=height+'px';
    popup.onmouseenter=()=>clearTimeout(timer);popup.onmouseleave=leave;
  };
  button.onmouseenter=open;button.onfocus=open;button.onmouseleave=leave;button.onblur=close;button.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}};
  section.closeSourceExplanation=close;return section;
}
function unifiedModelSelection(models,data){
  if(data===state.entityReview)return models.find(m=>materialModelKey(m)===data.unifiedMaterialId)||models[0];
  const target=state.productionSelected,card=state.materialCommentCard;
  const explicit=models.find(m=>card?.data===data&&materialModelKey(m)===card.material_id&&materialCommentRows(m.round).some(r=>r.id===target?.id))||models.find(m=>data.localVersions&&m.round?.members.some(r=>data.localVersions[r.object_id]?.id===r.id));
  const current=models.find(m=>materialModelKey(m)===data.unifiedMaterialId);
  const rank=m=>{const row=m.need||m.identity||m.candidates[0]?.record;return (row?.payload.media_type==='image'?0:row?.payload.media_type==='audio'?10:20)+(row?.payload.slot==='overall'?0:1)};
  return current||explicit||[...models].sort((a,b)=>rank(a)-rank(b))[0];
}
function saveUnifiedMaterialReader(data,key){
  if(!key)return;data.materialReaders||={};
  data.materialReaders[key]=Object.fromEntries(['productionSelected','anchor','editing','selected','reviewCommentScope','drawMode'].map(field=>[field,state[field]]));
}
function restoreUnifiedMaterialReader(data,key,row){
  const memory=data.materialReaders?.[key],card=state.materialCommentCard,round=card?.data===data&&data.material_cards?.[key]?.find(r=>r.number===card.number);
  const saved=memory&&(!round||materialCommentRows(round).some(r=>r.id===memory.productionSelected?.id))?memory:null;
  focusProductionReview(entityReviewDetail(saved?.productionSelected||row),false);
  if(saved)for(const field of ['anchor','editing','selected','reviewCommentScope','drawMode'])state[field]=saved[field];
  restoreProductionDraft();
}
function renderUnifiedModels(parent,models,data){
  if(!models.length)return;
  data.unifiedGroups||=[];data.unifiedGroups.push(...models);
  const list=el('div','material-small-list');list.setAttribute('aria-label','状态素材');parent.append(list);
  for(const model of models){const key=materialModelKey(model);materialSmallCard(list,modelSmallItem(model),()=>{
    for(const group of data.unifiedLeft?.querySelectorAll('.material-source-group')||[])group.closeSourceExplanation?.();
    rememberProductionDraft();saveUnifiedMaterialReader(data,data.unifiedMaterialId);data.unifiedMaterialId=key;state.materialCommentCard=null;
    data.selectedCandidates||={};data.selectedCandidates[key]||='current';
    const currentModel=data.unifiedGroups.find(m=>materialModelKey(m)===key)||model,row=currentModel.candidates.find(i=>i.record.id===data.selectedCandidates[key])?.record||currentModel.need||currentModel.identity;
    if(model.round)state.materialCommentCard={data,material_id:key,number:model.round.number};
    restoreUnifiedMaterialReader(data,key,row);renderUnifiedSelected(data);paintProductionReview();renderComments();
  },key===data.unifiedMaterialId)}
  if(!data.unifiedCollecting)renderUnifiedSelected(data);
}
function renderUnifiedSelected(data){
  const selected=unifiedModelSelection(data.unifiedGroups||[],data);if(!selected){
    data.unifiedMaterialId=null;state.materialCommentCard=null;
    const row=data.materialTab==='entity'?state.productionEntityDetail?.record:state.productionChildDetail?.record;
    if(row&&data.materialSwitchPending)focusProductionReview(entityReviewDetail(row),false);
    data.materialSwitchPending=false;return;
  }
  const changed=data.unifiedMaterialId!==materialModelKey(selected);
  data.unifiedMaterialId=materialModelKey(selected);
  for(const button of data.unifiedLeft?.querySelectorAll('[data-material-id]')||[])button.setAttribute('aria-pressed',String(button.dataset.materialId===data.unifiedMaterialId));
  const right=data.unifiedRight;if(!right)return;right.replaceChildren();
  const key=materialModelKey(selected);data.selectedCandidates||={};
  const explicit=state.productionSelected;
  if(selected.candidates.some(i=>i.record.id===explicit?.id)&&data.localVersions?.[explicit.object_id])data.selectedCandidates[key]=explicit.id;
  if(!data.selectedCandidates[key])data.selectedCandidates[key]='current';
  if(data.selectedCandidates[key]!=='current'&&!selected.candidates.some(i=>i.record.id===data.selectedCandidates[key])){nodeText('p','production-issue',deletedCandidateNotice(data,data.selectedCandidates[key]),right);return}
  if(selected.round)state.materialCommentCard={data,material_id:key,number:selected.round.number};
  const chosen=data.selectedCandidates[key]==='current'?null:materialCandidateChoice(selected.candidates,data.selectedCandidates[key]);
  if(changed||data.materialSwitchPending)restoreUnifiedMaterialReader(data,key,chosen?.record||selected.need||selected.identity);
  data.materialSwitchPending=false;
  const candidate=data.selectedCandidates[key];
  if(data.deferred_materials?.includes(key)||candidate!=='current'&&data.deferred_candidates?.includes(candidate)){
    nodeText('p','production-meta','正在读取素材方案…',right).setAttribute('role','status');
    loadEntityMaterial(data,key,candidate).then(()=>{
      const by=new Map(entityReviewMaterialModels(data.requirements,[],data).map(model=>[materialModelKey(model),model]));data.unifiedGroups=data.unifiedGroups.map(model=>by.get(materialModelKey(model))||model);
      if(!right.isConnected||state.entityReview!==data||data.unifiedMaterialId!==key||data.selectedCandidates[key]!==candidate)return;
      renderUnifiedSelected(data);paintProductionReview();renderComments();
    }).catch(error=>{if(!right.isConnected||data.unifiedMaterialId!==key||data.selectedCandidates[key]!==candidate)return;right.replaceChildren();nodeText('p','production-issue','素材方案读取失败：'+error.message,right);productionButton(right,'重试',()=>renderUnifiedSelected(data))});
    return;
  }
  const options=entityMaterialCandidateOptions(data,selected);
  renderMaterialCard(right,selected,{...options,planVersion:(h,row)=>entityVersionControl(h,row,next=>{data.localVersions||={};data.localVersions[next.object_id]=next}),assetVersion:(h,item)=>entityVersionControl(h,item.record,next=>{data.localVersions||={};data.localVersions[next.object_id]=next})});


}
function retainLoadedMaterialMembers(data,mid,rounds){
  const old=new Map((data.material_cards[mid]||[]).flatMap(r=>r.members||[]).filter(r=>!r.deferred_detail).map(r=>[r.id,r]));
  return rounds.map(round=>({...round,results:(round.results||[]).map(r=>r.deferred_detail&&old.has(r.id)?old.get(r.id):r),members:(round.members||[]).map(r=>r.deferred_detail&&old.has(r.id)?old.get(r.id):r)}));
}
function loadEntityMaterial(data,mid,candidate){
  data.materialDetailReads||=new Map();const key=mid+':'+candidate;if(data.materialDetailReads.has(key))return data.materialDetailReads.get(key);
  const before=data.requirements.find(r=>r.object_id===mid),token=data.entity.edit_token||data.entity.version;
  const request=api('/api/production/entity-material?'+new URLSearchParams({entity_id:data.entity.object_id,revision_id:data.entity.id,material_id:mid,...(candidate==='current'?{}:{candidate_revision:candidate})})).then(result=>{
    const after=result.requirements.find(r=>r.object_id===mid);
    if((result.entity.edit_token||result.entity.version)!==token||result.source_signature!==data.source_signature||!after||before.version!==after.version)throw Error('实体或素材已更新，请重新打开；保留原选择与草稿');
    data.requirements=data.requirements.map(r=>r.object_id===mid?after:r);data.material_cards[mid]=retainLoadedMaterialMembers(data,mid,result.material_cards[mid]);Object.assign(data.materialContexts,result.materialContexts);
    data.deferred_materials=data.deferred_materials.filter(id=>id!==mid);if(candidate!=='current')data.deferred_candidates=data.deferred_candidates.filter(id=>id!==candidate);
    data.comment_records=[...new Map([...data.comment_records,...result.comment_records].map(r=>[r.id,r])).values()];data.comment_targets=[...new Map([...data.comment_targets,...result.comment_targets].map(r=>[r.revision_id,r])).values()];return result;
  }).finally(()=>data.materialDetailReads.delete(key));data.materialDetailReads.set(key,request);return request;
}
function renderUnifiedCard(root){
  root.classList.add('unified-card-host');root.replaceChildren();
  if(state.materialReview?.record?.payload.format==='production-retirement-v1'){renderProductionRecord(root,state.materialReview);paintProductionReview();return}
  if(state.entityReview?.entity?.kind==='AV_SHOT'){renderShotEntityWorkspace(root,state.entityReview);paintProductionReview();return}
  const card=el('section','unified-card'),left=el('section','unified-card-context'),right=el('section','unified-card-material');card.append(left,right);root.append(card);
  if(state.positionReview){
    card.classList.add('unified-position-card');right.remove();left.classList.add('breakdown-scene');
    const data=state.positionReview,row=data.record,controls=el('div','production-toolbar');left.append(controls);
    const episode=data.shared?.find(item=>item.record.kind==='AV_EPISODE')?.record;
    nodeText('span','production-meta',[episode&&businessTitle(episode),breakdownSceneTitle(data.scene)].filter(Boolean).join(' / '),controls);
    if(row.kind==='AV_SCENE'){nodeText('h2',null,breakdownSceneTitle(row),left);renderAudiovisualSources(left,row)}
    for(const item of data.shots)renderBreakdownShot(left,item);
  }
  else if(state.entityReview){const data=state.entityReview;data.unifiedRight=right;data.unifiedLeft=left;data.unifiedGroups=[];data.unifiedCollecting=true;renderEntityReview(left);data.unifiedCollecting=false;renderUnifiedSelected(data)}
  else if(state.materialReview){
    const scope=state.unifiedScope,title=scope?.kind==='AV_SCENE'?breakdownSceneTitle(scope):scope?.kind==='AV_SHOT'?breakdownShotTitle(scope):scope?.kind==='EPISODE'?breakdownEpisodeTitle(scope):reviewPositionText(scope?.payload.title||'素材');nodeText('h2',null,title,left);
    if(scope){nodeText('p','production-meta',({INPUT_LOCK:'全剧',STORY:'全剧',EPISODE:'集',AV_SCENE:'场',AV_SHOT:'镜',STATE:'实体状态'})[scope.kind]||productionKinds[scope.kind],left);reviewTextBlocks(left,scope);if(scope.payload.source)materialReferenceLink(left,scope.payload.source,'剧情依据',true);for(const source of scope.payload.sources||[])materialReferenceLink(left,source,'剧情依据',true)}
    if(scope&&['AV_SCENE','AV_SHOT'].includes(scope.kind))productionRefLink(left,{...productionRef(scope),kind:scope.kind},'打开完整'+(scope.kind==='AV_SHOT'?'镜头':'场设计'));
    else nodeText('p','production-meta','历史原件未登记实体或制作位置归属',left);
    const detail=state.materialReview,row=detail.record,entries=Object.entries(detail.material_cards||{});
    const current=state.materialCommentCard?.data===detail?entries.find(([mid])=>mid===state.materialCommentCard.material_id):entries[0];
    const mid=current?.[0]||row.object_id,rounds=current?.[1]||[],identity=rounds.map(r=>r.definition_records?.requirement||r.plan).find(Boolean)||row;
    const counts=detail.material_card_counts?.[mid]||(rounds.length?{version_count:rounds.length,candidate_count:new Set(rounds.flatMap(r=>r.results||[]).filter(r=>r.kind==='ASSET'&&!r.payload.placeholder&&r.payload.components?.some(c=>c.role==='original')).map(r=>r.candidate_id||r.id)).size}:{});
    if(detail.sourceMaterials?.length){
      nodeText('h3',null,'素材需求',left);const list=el('div','material-small-list');list.setAttribute('aria-label','同来源素材需求');left.append(list);
      for(const item of detail.sourceMaterials)materialSmallCard(list,item,button=>switchUnifiedSourceMaterial(item,button),item.object_id===mid);
    }else{nodeText('h3',null,businessTitle(identity),left);nodeText('p','production-meta material-summary-counts',materialCountText(counts),left)}
    renderMaterialWorkspace(right,state.materialReview);
  }
  paintProductionReview();
}
async function switchUnifiedPosition(objectId,revisionId){
  const previous=state.positionReview,root=state.unifiedCardRoot,session=previous.session||={request:0,results:{}},request=++session.request;
  rememberProductionDraft();
  try{
    const result=session.results[revisionId]||await readUnifiedCard(objectId,revisionId);
    if(request!==session.request||state.positionReview!==previous||state.unifiedCardRoot!==root||!root?.isConnected)return;
    session.results[revisionId]=result;result.position_review.session=session;activateUnifiedCard(result);renderProductionReader();renderComments();
  }catch(error){if(request===session.request&&state.positionReview===previous&&state.unifiedCardRoot===root&&root?.isConnected){renderProductionReader();toast('准确设计版本不可用：'+error.message)}}
}
async function switchUnifiedSourceMaterial(item,trigger){
  const previous=state.materialReview,session=previous.sourceSession,root=state.unifiedCardRoot,scope=state.unifiedScope;
  rememberProductionDraft();saveUnifiedMaterialReader(previous,previous.record.object_id);
  const savedParams=new URLSearchParams(),urlParams=new URL(location.href).searchParams;
  for(const key of ['material_id','material_version','material_round','material_target','material_baseline'])if(urlParams.has(key))savedParams.set(key,urlParams.get(key));
  session.cards[previous.record.id].params=savedParams;
  const request=(session.request||0)+1;session.request=request;
  let result=session.cards[item.id];
  if(!result)result=await readUnifiedCard(item.object_id,item.id,new URLSearchParams());
  if(session.request!==request||state.materialReview!==previous||state.unifiedCardRoot!==root||state.unifiedScope!==scope||root&&!root.isConnected)return;
  session.cards[item.id]=result;result.detail.sourceSession=session;
  const restore=preserveCardPosition();activateUnifiedCard(result);
  restoreUnifiedMaterialReader(result.detail,item.object_id,result.detail.record);
  renderProductionReader();renderComments();restore();
  state.unifiedCardRoot?.querySelector(`[data-material-id="${CSS.escape(item.object_id)}"]`)?.focus({preventScroll:true});
}
async function readUnifiedCard(objectId,revisionId=null,params=null,work=currentReviewWork()){
  let result;
  validateMaterialRoute(params||new URLSearchParams());
  try{result=await api('/api/production/card?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{}),...(params?.get('production_entity')?{entity_id:params.get('production_entity')}:{}),...(work?{work_object:work.object_id,work_revision:work.revision_id,...(work.scene_id?{work_scene:work.scene_id}:{})}:{})}))}
  catch(error){if(error.message==='production record not found')throw Error('指定的对象或修订不可用；未打开其他版本。');throw error}
  result.params=params||new URLSearchParams();result.explicit=!!revisionId;validateUnifiedReference(result);return result;
}
function materialSavedDraft(result){
  const detail=result.detail,params=result.params;
  if(!result.allowDraftFocus||detail.record.kind!=='REQUIREMENT'||['production_revision','material_target','material_version','material_round'].some(key=>params.has(key)))return null;
  const mid=params.get('material_id')||Object.keys(detail.material_cards||{})[0],round=detail.material_cards?.[mid]?.[0];if(!round)return null;
  for(const [key,saved] of Object.entries(productionDraftContexts()).reverse()){
    let parts;try{parts=JSON.parse(key);if(!saved.anchor||!saved.draftKey||localStorage.getItem(saved.draftKey)===null)continue}catch{continue}
    if(parts[1]!==mid||parts[2]!==round.number||parts[3]!==round.model)continue;
    const row=materialCommentRows(round).find(r=>r.id===parts[0]);if(!row||(row.edit_token||null)!==(parts[4]||null))continue;
    detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number;state.materialCommentCard={data:detail,material_id:mid,number:round.number};return row;
  }
  return null;
}
function activateUnifiedCard(result){
  const detail=result.detail,row=detail.record,params=result.params;
  if(result.defaultSelection&&row.kind==='REQUIREMENT'&&!params.has('material_target'))params.set('material_target','current');
  detail.currentMaterialCards||=detail.material_cards;
  state.reviewWork=result.review_work||null;
  state.entityReview=result.entity_review;state.positionReview=result.position_review||null;state.materialReview=state.entityReview||!['ASSET','REQUIREMENT'].includes(row.kind)?null:detail;state.unifiedScope=result.scope;
  state.productionEntityId=state.entityReview?.entity.object_id||null;state.productionChildDetail=null;state.productionEntityDetail=null;
  if(row.payload.format==='production-retirement-v1'){focusProductionReview(detail,false);return}
  if(state.entityReview){
    const data=state.entityReview;data.requestedState=params.get('entity_state')||(row.kind==='STATE'?row.object_id:null);if(result.explicit&&!result.defaultSelection&&['ENTITY','STATE'].includes(row.kind)){data.localVersions||={};data.localVersions[row.object_id]=row;}if(params.get('production_entity')&&params.get('production_entity')!==data.entity.object_id)throw Error('准确实体不属于此素材');data.currentStates=data.states;data.states=[...new Map([...data.states,...(data.retained_states||[])].map(r=>[r.id,r])).values()];data.states.sort(productionStateOrder);state.productionEntityDetail=entityReviewDetail(result.explicit&&!result.defaultSelection&&row.kind==='ENTITY'?row:data.entity);
    const wanted=params.get('entity_state'),ownedStates=[...data.states,...(data.retained_states||[])],wantedForm=ownedStates.find(r=>r.object_id===wanted);if(wanted&&!wantedForm&&result.form?.object_id!==wanted)throw Error('准确状态不属于此实体');const currentForm=!result.form&&state.reviewWork&&['ASSET','REQUIREMENT'].includes(result.detail.record.kind)?data.states.find(r=>reviewWorkMatches(r)):null;const form=(wanted?(result.form?.object_id===wanted?result.form:wantedForm):currentForm||result.form)||data.states[0];state.productionChildDetail=form?entityReviewDetail(form):null;
    if(['ASSET','REQUIREMENT','CALL'].includes(row.kind)){const route=entityMaterialRoute(data,row,params,{defaultSelection:result.defaultSelection});const target=params.get('material_target');if(target){const exact=target==='current'?route.selected?.round.plan:materialCommentRows(route.selected?.round).find(r=>r.id===target);if(!exact)throw Error('准确候选不属于所选素材');route.row=exact}restoreEntityMaterialRoute(data,route);if((wanted||currentForm)&&form&&route.row.kind!=='CALL')state.productionChildDetail=entityReviewDetail(form);data.unifiedMaterialId=route.selected?.material_id||row.object_id}
    else {data.materialTab=row.kind==='STATE'?'states':params.get('entity_material_tab')==='entity'?'entity':'states';focusProductionReview(entityReviewDetail(row.kind==='STATE'?row:form||row),false)}
  }else{
    // This card owns its version route; a caller or parent card may still have
    // another material's exact version in the shared page URL.
    const url=new URL(location.href);for(const key of ['material_id','material_version','material_round','material_target','material_baseline']){const value=params.get(key);if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value)}history.replaceState(history.state,'',url);
    detail.explicitRevision=result.explicit&&!result.defaultSelection;detail.adoptionContext=result.adoption_context;
    detail.sourceMaterials=result.source_materials||[];
    detail.sourceSession||={cards:{[row.id]:result},request:0};
    const target=params.get('material_target');if(target&&target!=='current'&&!materialRows(detail).some(r=>r.id===target))throw Error(deletedCandidateNotice(detail,target));
    const draft=!target?materialSavedDraft(result):null;
    if(target||draft)detail.selectedCandidateId=target||draft.id;
    focusProductionReview(target&&target!=='current'?entityReviewDetail(materialRows(detail).find(r=>r.id===target)):draft?entityReviewDetail(draft):detail,false);
  }
  restoreProductionDraft();
}
function preserveUnifiedCommentReader(dialog){
  if(window.innerWidth<1200)return ()=>{};
  const body=dialog.querySelector(':scope > .review-dialog-body'),card=body?.querySelector('.unified-card');
  if(!card)return ()=>{};
  const restorers=[];
  for(const [scroller,content] of [[body,card.querySelector('.unified-card-context')],[card.querySelector('.unified-card-material'),card.querySelector('.unified-card-material')]]){
    if(!scroller||!content)continue;
    const visibleTop=()=>Math.max(body.getBoundingClientRect().top,scroller.getBoundingClientRect().top);
    const top=visibleTop(),bottom=Math.min(window.innerHeight,body.getBoundingClientRect().bottom,scroller.getBoundingClientRect().bottom);
    if(bottom<=top)continue;
    const visible=node=>{const r=node.getBoundingClientRect();return r.height>0&&r.bottom>top+2&&r.top<bottom};
    const focused=[document.activeElement,dialog.commentReturnFocus].map(node=>node?.closest?.('.review-media-player,[data-block-id]')).find(node=>node&&content.contains(node)&&visible(node));
    const target=focused||[...content.querySelectorAll('.comment-mark.selected')].find(visible)||[...content.querySelectorAll('p,h2,h3,h4,pre,img,video,.review-media-player')].find(visible);
    if(!target)continue;
    const rect=target.getBoundingClientRect();let anchor=target;
    if(target.matches('img,video,.review-media-player')){
      const fraction=Math.max(0,(top-rect.top)/rect.height),offset=rect.top+fraction*rect.height-top;
      restorers.push(()=>{if(target.isConnected){const next=target.getBoundingClientRect();scroller.scrollTop+=next.top+fraction*next.height-visibleTop()-offset}});
      continue;
    }
    for(let y=Math.max(top,rect.top)+8;y<Math.min(bottom,top+180);y+=8){
      const x=rect.left+Math.min(8,rect.width/2),caret=document.caretPositionFromPoint?.(x,y),range=caret?document.createRange():document.caretRangeFromPoint?.(x,y);
      if(caret)range.setStart(caret.offsetNode,caret.offset);
      const text=range?.startContainer;
      if(text?.nodeType!==Node.TEXT_NODE||!target.contains(text)||!/\S/.test(text.textContent[range.startOffset]||''))continue;
      range.setEnd(text,Math.min(text.length,range.startOffset+1));
      const glyph=range.getBoundingClientRect();if(glyph.height&&glyph.top>=top&&glyph.bottom<=bottom){anchor=range;break}
    }
    const offset=anchor.getBoundingClientRect().top-top;
    restorers.push(()=>{if(target.isConnected)scroller.scrollTop+=anchor.getBoundingClientRect().top-visibleTop()-offset});
  }
  return ()=>restorers.forEach(restore=>restore());
}

function renderUnifiedCardLoading(body,error=null,retry=null){
  body.replaceChildren();body.setAttribute('aria-busy',String(!error));
  const card=el('div','unified-card unified-card-loading'),left=el('section','unified-card-context'),right=el('section','unified-card-material');
  card.append(left,right);body.append(card);
  const message=el('div','unified-card-load-message');left.append(message);
  nodeText('p',error?'production-issue':null,error?'读取失败：'+error.message:'正在读取…',message).setAttribute('role',error?'alert':'status');
  if(retry)productionButton(message,'重试',retry);
  for(const [column,sizes] of [[left,['heading','text','text','text','cards']],[right,['heading','tabs','text','text','text','text']]]){
    const skeleton=el('div','unified-card-placeholder');skeleton.setAttribute('aria-hidden','true');column.append(skeleton);
    for(const size of sizes)skeleton.append(el('div','unified-card-placeholder-'+size));
  }
}
function unifiedDialogReadKey(ref){
  return JSON.stringify([ref.object_id,ref.revision_id||ref.id,ref.params?.toString(),ref.component_id,ref.work,ref.defaultSelection,ref.permission,ref.readingLabel,ref.shotReference?.need?.id,ref.shotReference?.slot?.key,ref.shotReference?.slot?.selection_owner]);
}
async function openUnifiedMaterial(ref,trigger,view=null){
  const top=typeof reviewDialogStack==='undefined'?null:reviewDialogStack.at(-1),key=unifiedDialogReadKey(ref);
  if(!view&&top?.unifiedLoad){
    if(top.unifiedReadKey===key)return top.unifiedRead;
    // A second request from outside a card is a replacement, not a
    // child. Real nested actions must originate inside the owning dialog.
    if(!top.contains(trigger)){top.reviewReturnTrigger=trigger;return top.unifiedLoad(ref)}
  }
  if(!state.unifiedCardRoot&&!state.reviewReferenceContext){if(typeof rememberStoryDraft==='function')rememberStoryDraft();if(typeof isScript==='function'&&isScript())rememberScriptDraft();}
  rememberProductionDraft();if(typeof pauseReviewMedia==='function')pauseReviewMedia();
  const workspace=state.workspace,epoch=productionLoadEpoch,owns=()=>state.workspace===workspace&&productionLoadEpoch===epoch;
  const fields=['reviewWork','reviewPermission','shotReferenceContext','productionDraftScope','productionSelected','productionDetail','productionEntityDetail','productionChildDetail','productionEntityId','entityReview','positionReview','materialReview','unifiedScope','unifiedCardRoot','anchor','editing','selected','reviewCommentScope','pending','drawMode','suggestion','preview','previewExpanded','materialCommentCard','reviewReferenceContext','historyOpen','historyLimit'];
  const saved=Object.fromEntries(fields.map(k=>[k,state[k]])),requestURL=location.href,returnURL=new URL(requestURL);
  if(ref.restoreRoute){for(const key of ['production_object','production_revision','production_entity','entity_state','entity_material_tab','material_id','material_version','material_round','material_target','material_baseline'])returnURL.searchParams.delete(key);history.replaceState(history.state,'',returnURL)}
  const url=returnURL.href,panel=$('#comment-panel'),parent=panel.parentNode,next=panel.nextSibling,hidden=panel.hidden;
  const toggle=$('#comments-toggle'),toggleParent=toggle?.parentNode,toggleNext=toggle?.nextSibling;
  const {dialog,title,body}=view||openReviewDialog(ref.readingLabel||'实体与素材详情',trigger,'unified-card-dialog');
  if(ref.restoreRoute)history.replaceState(history.state,'',requestURL);
  // The exact read is isolated; closing before it finishes cannot replace outer state.
  dialog.addEventListener('close',()=>{parent.insertBefore(panel,next?.parentNode===parent?next:null);if(toggleParent)toggleParent.insertBefore(toggle,toggleNext?.parentNode===toggleParent?toggleNext:null);if(!owns())return;rememberProductionDraft();Object.assign(state,saved);if(!dialog.closedByHistory)history.replaceState(history.state,'',url);renderComments();setPanelOpen(!hidden);paintProductionReview();ref.onClose?.();if(ref.shotReference?.saved&&!ref.shotReference.pending)ref.shotReference.onSaved(ref.shotReference.saved)},{once:true});
  let attempt=0;
  dialog.unifiedLoad=nextRef=>{
   if(dialog.unifiedActivated){
    rememberProductionDraft();Object.assign(state,saved);parent.insertBefore(panel,next?.parentNode===parent?next:null);
    if(toggleParent)toggleParent.insertBefore(toggle,toggleNext?.parentNode===toggleParent?toggleNext:null);
    dialog.unifiedActivated=false;
   }
   ref=nextRef;dialog.unifiedReadKey=unifiedDialogReadKey(ref);dialog.unifiedPending=true;
   const selectedRef=ref,current=++attempt,active=()=>dialog.isConnected&&owns()&&current===attempt;
   renderUnifiedCardLoading(body);
   const read=async()=>{
    try{const result=await readUnifiedCard(selectedRef.object_id,selectedRef.revision_id||selectedRef.id,selectedRef.params,Object.hasOwn(selectedRef,'work')?selectedRef.work:currentReviewWork());if(!active())return;
    while(typeof reviewDialogStack!=='undefined'&&reviewDialogStack.at(-1)!==dialog&&dialog.isConnected){const upper=reviewDialogStack.at(-1);await new Promise(resolve=>upper.addEventListener('close',resolve,{once:true}));if(!active())return;}
    if(ref.expectedOrigin&&(result.scope?.object_id!==ref.expectedOrigin.object_id||result.scope?.kind!==ref.expectedOrigin.kind))throw Error('原素材归属已变化：'+ref.expectedOrigin.object_id+'；未打开其他对象');
    result.defaultSelection=!!ref.defaultSelection;
    state.reviewPermission=!!ref.permission;
    state.shotReferenceContext=ref.shotReference?{...ref.shotReference,dialog,source:ref.shotReference,pageActive:owns}:null;
    if(ref.component_id){const data=result.entity_review||result.detail;data.selectedComponents||={};data.selectedComponents[ref.revision_id]=ref.component_id;if(!result.entity_review)result.detail.componentId=ref.component_id}
    state.unifiedCardRoot=body;panel.remove();dialog.append(panel);if(toggle)dialog.append(toggle);activateUnifiedCard(result);dialog.unifiedActivated=true;body.setAttribute('aria-busy','false');renderProductionReader();renderComments();
    if(ref.entry_id){const entry=[...body.querySelectorAll('[data-material-entry]')].find(n=>n.dataset.materialEntry===ref.entry_id&&n.closest('[data-review-revision]')?.dataset.reviewRevision===ref.revision_id);if(!entry)throw Error('准确字层条目不可用：'+ref.entry_id);entry.classList.add('selected');entry.scrollIntoView({block:'center'});}
    ref.onReady?.(dialog,result);
    }catch(error){if(active())renderUnifiedCardLoading(body,error,()=>dialog.unifiedLoad(selectedRef))}
    finally{if(active())dialog.unifiedPending=false}
   };
   return dialog.unifiedRead=read();
  };
  return dialog.unifiedLoad(ref);
}

function deletedCandidateNotice(data,target){
  const rounds=Array.isArray(data)?data:Object.values(data.material_cards||data.entity_review?.material_cards||{}).flat();
  return rounds.flatMap(r=>r.deleted_candidates||[]).find(item=>item.revision_ids.includes(target))?.reason||'准确候选已不可用；未替换为其他结果';
}
function validateUnifiedReference(result){
  // An old exact URL opens its retirement receipt, never another candidate.
  if(result.detail.record.payload.format==='production-retirement-v1')return;
  const params=result.params,detail=result.detail,data=result.entity_review||detail;
  const source=params.get('entity_state');if(source&&data.entity?.kind==='ENTITY'&&!data.states?.some(r=>r.object_id===source)&&detail.record.kind!=='STATE'&&detail.record.kind!=='ASSET'&&detail.record.kind!=='CALL')throw Error('准确状态已不可用；未替换为基础素材');
  const versions=data.material_cards;
  validateMaterialRoute(params,versions);
  const parameter=params.has('material_round')?'material_round':'material_version',mid=params.get('material_id');let number=Number(params.get(parameter));
  if(params.has(parameter)&&(!Number.isSafeInteger(number)||number<1))throw Error('准确素材版本无效；未替换为当前版本');
  if(mid&&!Object.hasOwn(versions||{},mid))throw Error('准确素材标识不存在；未替换为其他素材');
  const sets=Object.entries(versions||{}).filter(([id])=>!mid||id===mid),rounds=sets.flatMap(([,rs])=>rs);
  if(number&&!rounds.some(r=>r.number===number))throw Error('准确素材版本不存在；未替换为最新版本');
  const target=params.get('material_target');if(target&&target!=='current'&&!(number?rounds.filter(r=>r.number===number).flatMap(materialCommentRows):materialRows(detail)).some(r=>r.id===target))throw Error(deletedCandidateNotice(rounds,target));
}

// The same reader is mounted in a modal or directly in an audiovisual scene.
// Selection belongs to this shot, so another shot cannot inherit its material.
function writeShotWorkspaceRoute(data){
  const mid=data.unifiedMaterialId,candidate=data.selectedCandidates?.[mid];
  breakdownRoute({production_scope_shot:data.entity.object_id,shot_material_id:mid||null,shot_candidate:candidate&&candidate!=='current'?candidate:null,
    shot_component:candidate&&candidate!=='current'?data.selectedComponents?.[candidate]||null:null});
}
// One detail request at a time per reader. Visible cards enqueue automatically;
// explicit tab/candidate choices move ahead of speculative visible neighbours.
const shotDetailQueue=[];let shotDetailBusy=false;
function queueShotDetail(data,mid,candidate,card,priority=false){
  data.detailReads||=new Map();const key=mid+':'+(candidate||'current');
  if(data.detailReads.has(key))return data.detailReads.get(key);
  const epoch=breakdownDetailEpoch;
  const promise=new Promise((resolve,reject)=>{
    const job={data,mid,candidate,card,epoch,resolve,reject};
    if(priority)shotDetailQueue.unshift(job);else shotDetailQueue.push(job);
    drainShotDetails();
  }).finally(()=>data.detailReads.delete(key));
  data.detailReads.set(key,promise);return promise;
}
async function drainShotDetails(){
  if(shotDetailBusy)return;shotDetailBusy=true;
  try{while(shotDetailQueue.length){
    const jobs=[];
    while(shotDetailQueue.length&&jobs.length<3){
      const job=shotDetailQueue.shift();
      if(job.epoch!==breakdownDetailEpoch||!job.card.isConnected)job.reject(new DOMException('过时读取','AbortError'));
      else jobs.push(job);
    }
    if(!jobs.length)continue;
    let results;
    try{results=await readBreakdownAPI('/api/production/shot-materials?'+new URLSearchParams({items:JSON.stringify(jobs.map(({data,mid,candidate})=>({object_id:data.entity.object_id,revision_id:data.entity.id,material_id:mid,...(candidate?{candidate_revision:candidate}:{})})))}))}
    catch(error){for(const job of jobs)job.reject(error);continue}
    for(const [index,job] of jobs.entries()){
      const {data,mid,candidate,card,epoch}=job,result=results[index];
      try{
      if(epoch!==breakdownDetailEpoch||!card.isConnected)throw new DOMException('过时读取','AbortError');
      if(result.entity.id!==data.entity.id||result.entity.edit_token!==data.entity.edit_token||result.source_signature!==data.source_signature)throw Error('本镜设计或素材来源已更新，请重新打开当前场');
      const before=data.requirements.find(n=>n.object_id===mid),after=result.requirements.find(n=>n.object_id===mid);
      if(!after||before.version!==after.version)throw Error('此素材方案已更新，请重新打开当前场');
      data.requirements=data.requirements.map(n=>n.object_id===mid?after:n);
      data.material_cards[mid]=retainLoadedMaterialMembers(data,mid,result.material_cards[mid]);
      Object.assign(data.materialContexts,result.materialContexts);
      data.deferred_materials=data.deferred_materials.filter(id=>id!==mid);
      if(candidate)data.deferred_candidates=data.deferred_candidates.filter(id=>id!==candidate);
      data.comment_records=[...new Map([...data.comment_records,...result.comment_records].map(r=>[r.id,r])).values()];
      data.comment_targets=[...new Map([...data.comment_targets,...result.comment_targets].map(r=>[r.revision_id,r])).values()];
      job.resolve(result);
    }catch(error){job.reject(error)}
    }
  }}finally{shotDetailBusy=false}
}
function renderShotEntityWorkspace(root,data){
  const shot=data.entity,card=el('section','unified-card shot-entity-workspace'),left=el('section','unified-card-context'),right=el('section','unified-card-material');card.append(left,right);root.append(card);
  card.dataset.shotId=shot.object_id;card.dataset.shotRevision=shot.id;
  nodeText('h3',null,breakdownShotTitle(shot),left);
  const location=(data.position||[]).filter(p=>p.kind!=='AV_SHOT').map(p=>businessCode(p)+' · '+reviewPositionText(p.title)).join(' / ');if(location)nodeText('p','production-meta',location,left);
  const basics=el('section','entity-review-basics');basics.setAttribute('aria-label','镜头基础信息');left.append(basics);
  const surface=materialTextSurface(basics,shot);materialField(surface,shot,'purpose','叙事目的');entitySources(basics,shot);
  const groups=data.material_groups||[],panel=el('section','material-source-list');panel.setAttribute('aria-label','素材列表');nodeText('h3',null,'素材列表',left);left.append(panel);
  data.shotSelections||={};data.selectedCandidates||={};
  if(!groups.some(g=>g.key===data.shotTab))data.shotTab=groups.find(g=>g.material_ids.includes(data.unifiedMaterialId))?.key||groups[0]?.key;
  const focus=(row,restore=false)=>{if(!row)return;const model=by.get(data.unifiedMaterialId);state.materialCommentCard={data,material_id:data.unifiedMaterialId,number:model?.round?.number||1};if(restore)restoreUnifiedMaterialReader(data,data.unifiedMaterialId,row);else{focusProductionReview(entityReviewDetail(row),false);restoreProductionDraft()}if(root.closest?.('.breakdown-scene')){breakdownRoute({breakdown_object:shot.object_id,breakdown_revision:shot.id});writeShotWorkspaceRoute(data)}renderComments()};
  let by=new Map(),observer=null,drawEpoch=0;
  // Keep the previous reader mounted until the exact next plan is ready. The
  // zero-height notice cannot collapse the card or reset its scroll position.
  const pending=(message,error=false)=>{
    right.querySelector('.material-reader-status')?.remove();
    for(const child of right.children)child.inert=true;
    right.setAttribute('aria-busy',String(!error));
    const notice=el('div','material-reader-status');notice.setAttribute('role','status');right.prepend(notice);
    nodeText('p',error?'production-issue':'production-meta',message,notice);
    if(error)productionButton(notice,'重试',()=>draw(true,true));
  };
  const issue=message=>{right.replaceChildren();right.setAttribute('aria-busy','false');nodeText('p','production-issue',message,right)};
  function draw(priority=false,reuseList=false){
    observer?.disconnect();const selection=++drawEpoch;
    by=new Map(entityReviewMaterialModels(data.requirements,[],data).map(m=>[materialModelKey(m),m]));
    pauseReviewMedia?.(right);if(!reuseList){for(const group of panel.querySelectorAll('.material-source-group'))group.closeSourceExplanation?.();panel.replaceChildren()}
    const available=groups.flatMap(group=>group.material_ids).filter(id=>by.has(id));
    if(!available.length){nodeText('p','production-meta','本镜尚无独立素材需求',panel);return}
    let selected=data.unifiedMaterialId;if(selected&&!available.includes(selected)){issue('准确素材已不可用；未替换为首项');return}selected||=available[0];data.unifiedMaterialId=selected;
    const preserve=action=>{const body=card.closest('.breakdown-body'),top=card.getBoundingClientRect().top;action();if(body)body.scrollTop+=card.getBoundingClientRect().top-top};
    const select=id=>{if(id===data.unifiedMaterialId)return;for(const group of panel.querySelectorAll('.material-source-group'))group.closeSourceExplanation?.();rememberProductionDraft();saveUnifiedMaterialReader(data,data.unifiedMaterialId);data.unifiedMaterialId=id;const model=by.get(id);data.selectedCandidates[id]||=model.round?.plan?'current':model.candidates[0]?.record.id;focus(data.selectedCandidates[id]==='current'?model.need:model.candidates.find(i=>i.record.id===data.selectedCandidates[id])?.record,true);preserve(()=>draw(true,true));paintProductionReview()};
    if(!reuseList)for(const group of groups){
      const sections=new Map();
      for(const id of group.material_ids.filter(id=>by.has(id))){const states=(group.key_states||[]).filter(s=>s.requirements.some(ref=>ref.object_id===id)),key=states.map(s=>s.id).join('|');if(!sections.has(key))sections.set(key,{states,ids:[]});sections.get(key).ids.push(id)}
      for(const {states,ids} of sections.values()){
        const label=group.label+(sections.size>1&&states.length?' · '+states.map(s=>s.title||s.description.split(/[：:；。]/u)[0]).join('／'):'');
        const section=materialSourceSection(panel,label,shot,async body=>{
          if(states.length)materialSourceText(body,shot,states.map(keyState=>`key_states.${shot.payload.key_states.findIndex(s=>s.id===keyState.id)}.description`));
          else for(const id of ids){const summary=by.get(id).need;const result=await api('/api/production/material-source?'+new URLSearchParams({object_id:summary.object_id,revision_id:summary.id,expected_version:summary.version}));materialSourceText(body,result.record)}
        });
        const list=el('div','material-small-list');list.setAttribute('aria-label',label+'素材');section.append(list);for(const id of ids){const model=by.get(id);materialSmallCard(list,modelSmallItem(model),()=>select(id),selected===id)}
      }
    }
    const model=by.get(selected);if(!model){nodeText('p','production-meta','此组尚无素材',right);return}
    for(const button of panel.querySelectorAll('[data-material-id]'))button.setAttribute('aria-pressed',String(button.dataset.materialId===selected));
    if(!data.selectedCandidates[selected])data.selectedCandidates[selected]=model.round?.plan?'current':model.candidates[0]?.record.id;
    if(data.selectedCandidates[selected]!=='current'&&!model.candidates.some(i=>i.record.id===data.selectedCandidates[selected])){issue(deletedCandidateNotice(data,data.selectedCandidates[selected]));return}
    const candidate=data.selectedCandidates[selected];
    if(data.deferred_materials?.includes(selected)||candidate!=='current'&&data.deferred_candidates?.includes(candidate)){
      pending('正在读取 '+materialModelCode(model)+' · '+reviewPositionText(model.need.payload.title)+'…');
      const load=()=>{observer?.disconnect();queueShotDetail(data,selected,candidate==='current'?null:candidate,card,priority).then(()=>{
        if(selection!==drawEpoch||!card.isConnected)return;
        const body=card.closest('.breakdown-body'),anchor=card;
        const top=anchor.getBoundingClientRect().top,x=right.scrollLeft,y=right.scrollTop;
        draw(false,true);right.scrollLeft=x;right.scrollTop=y;
        if(anchor&&top!==undefined){const delta=anchor.getBoundingClientRect().top-top;if(body&&['auto','scroll'].includes(getComputedStyle(body).overflowY))body.scrollTop+=delta;else window.scrollTo(window.scrollX,window.scrollY+delta)}
        const current=data.requirements.find(n=>n.object_id===selected);
        if(state.productionSelected?.object_id===selected)focusProductionReview(entityReviewDetail(current),false);
        paintProductionReview();
      }).catch(error=>{if(selection!==drawEpoch||!card.isConnected||error.name==='AbortError')return;pending('素材方案读取失败：'+error.message,true)})};
      if(priority||typeof IntersectionObserver==='undefined')load();
      else {const body=root.closest('.breakdown-body');observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))load()},{root:body&&['auto','scroll'].includes(getComputedStyle(body).overflowY)?body:null,rootMargin:'500px'});observer.observe(card)}
      return;
    }
    const x=right.scrollLeft,y=right.scrollTop;
    const reader=renderMaterialCard(right,model,{workspace:data,selectedCandidateId:data.selectedCandidates[selected],selectedComponents:data.selectedComponents,multipleCards:true,selectCandidate:id=>{if(id===data.selectedCandidates[selected])return;rememberProductionDraft();data.selectedCandidates[selected]=id;focus(id==='current'?model.need:model.candidates.find(i=>i.record.id===id)?.record);preserve(()=>draw(true,true));paintProductionReview()},selectComponent:id=>{const candidate=model.candidates.find(i=>i.record.id===data.selectedCandidates[selected]);if(candidate&&id!==data.selectedComponents?.[candidate.record.id]){data.selectedComponents||={};data.selectedComponents[candidate.record.id]=id;preserve(()=>draw(false,true));paintProductionReview()}}});
    right.replaceChildren(reader);right.setAttribute('aria-busy','false');right.scrollLeft=x;right.scrollTop=y;
  }
  draw();return card;
}
