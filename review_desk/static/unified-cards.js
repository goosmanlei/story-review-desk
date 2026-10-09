/* One entity/material reader, whether embedded or opened over a scene. */
function materialModelKey(model){return model.material_id||model.need?.object_id||model.identity?.object_id||model.candidates[0]?.record.object_id}
function materialDefaultCandidate(model,data){
  return materialCandidateChoice(model.candidates||[],null)?.record.id||null;
}
function reviewSmallCard(parent,item,activate,selected=false){
  const button=productionButton(parent,'',()=>activate(button));button.className='material-small-card';button.setAttribute('aria-pressed',String(selected));button.title=item.title;
  const preview=el('span','material-small-preview');
  if(item.preview?.mime?.startsWith('image/')){const img=el('img');img.src=reviewURL('/api/production/files/'+encodeURIComponent(item.preview.file));img.alt='';img.loading='lazy';preview.append(img)}else preview.append(productionEntityIcon(item.icon));
  if(item.preview?.mime?.startsWith('image/'))button.append(preview);
  const content=el('span','material-small-copy'),heading=el('span','small-card-title'),icon=productionEntityIcon(item.icon);
  const type=productionLabels[item.icon]||productionMediaLabels[item.icon]||item.icon||'对象';icon.setAttribute('aria-hidden','false');icon.setAttribute('role','img');icon.setAttribute('aria-label',type);icon.setAttribute('title',type);heading.append(icon);
  const name=nodeText('strong',null,item.title,heading);name.title=item.title;
  if(item.business_code)nodeText('span','small-card-code',item.business_code,heading);content.append(heading);
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
  const title=String(value??'').replace(/完整形态/gu,'实体状态');return scene?reviewPositionText(title.replace(/^\d+-\d+\s*/,(businessCode(owner)||reviewPositionLabel('scene',scene,location?.episode||owner?.payload.source?.object_id))+' · ')):reviewPositionText(title);
}
function materialCountText(item){
  const count=(key,label)=>Number.isInteger(item[key])&&item[key]>=0?`${label} ${item[key]} 个`:`${label}未登记`;
  return count('version_count','版本')+' · '+count('candidate_count','候选');
}
function materialSmallCard(parent,item,activate,selected=false,{includesHistory=false,showHistoryScope=false,subtitle=null}={}){
  const counts=materialCountText(item);
  const button=reviewSmallCard(parent,{...item,title:materialPositionText(item),business_code:businessCode(item),icon:item.media_type,subtitle:counts,selectionSubtitle:subtitle},activate,selected);button.dataset.materialId=item.canonical_material_id||item.object_id;
  if(item.placement_title){const text=materialPositionText(item,item.placement_title);button.title+=' · '+text}
  return button;
}

function modelSmallItem(model){
  const row=model.need||model.identity||model.candidates[0]?.record,real=(model.candidates||[]).filter(i=>!i.record.payload.placeholder&&i.record.payload.components.some(c=>c.role==='original'));
  return {...model.cardCounts,business_code:materialModelCode(model),object_id:materialModelKey(model),id:row.id,title:row.payload.generation?.output.name||row.payload.title,media_type:row.payload.media_type,scope:row.payload.scope,slot:row.payload.slot,generated:real.length>0,preview:real.flatMap(i=>i.record.payload.components).find(c=>c.role==='original'&&c.mime.startsWith('image/'))||real.flatMap(i=>i.record.payload.components).find(c=>['preview','thumbnail'].includes(c.role)&&c.mime.startsWith('image/'))};
}
function unifiedModelSelection(models,data){
  const target=state.productionSelected,card=state.materialCommentCard;
  const explicit=models.find(m=>card?.data===data&&materialModelKey(m)===card.material_id&&materialVersionCommentRows(m.round).some(r=>r.id===target?.id))||models.find(m=>data.localVersions&&m.round?.members.some(r=>data.localVersions[r.object_id]?.id===r.id));
  const current=models.find(m=>materialModelKey(m)===data.unifiedMaterialId);
  const rank=m=>{const row=m.need||m.identity||m.candidates[0]?.record;return (row?.payload.media_type==='image'?0:row?.payload.media_type==='audio'?10:20)+(row?.payload.slot==='overall'?0:1)};
  return current||explicit||[...models].sort((a,b)=>rank(a)-rank(b))[0];
}
function saveUnifiedMaterialReader(data,key){
  if(!key)return;data.materialReaders||={};
  data.materialReaders[key]=Object.fromEntries(['productionSelected','anchor','editing','selected','reviewCommentScope','drawMode'].map(field=>[field,state[field]]));
}
function restoreUnifiedMaterialReader(data,key,row){
  const saved=data.materialReaders?.[key];
  focusProductionReview(entityReviewDetail(saved?.productionSelected||row),false);
  if(saved)for(const field of ['anchor','editing','selected','reviewCommentScope','drawMode'])state[field]=saved[field];
  restoreProductionDraft();
}
function renderUnifiedModels(parent,models,data){
  if(!models.length)return;
  data.unifiedGroups||=[];data.unifiedGroups.push(...models);
  const list=el('div','material-small-list');list.setAttribute('aria-label','状态素材');parent.append(list);
  for(const model of models){const key=materialModelKey(model);materialSmallCard(list,modelSmallItem(model),()=>{
    rememberProductionDraft();saveUnifiedMaterialReader(data,data.unifiedMaterialId);data.unifiedMaterialId=key;state.materialCommentCard=null;
    const row=model.candidates.find(i=>i.record.id===(data.selectedCandidates?.[key]||materialDefaultCandidate(model,data)))?.record||model.need||model.identity;
    if(model.round)state.materialCommentCard={data,material_id:key,number:model.round.number};
    restoreUnifiedMaterialReader(data,key,row);renderProductionReader();renderComments();
  },key===data.unifiedMaterialId)}
  if(!data.unifiedCollecting)renderUnifiedSelected(data);
}
function renderUnifiedSelected(data){
  const selected=unifiedModelSelection(data.unifiedGroups||[],data);if(!selected)return;
  data.unifiedMaterialId=materialModelKey(selected);
  for(const button of data.unifiedLeft?.querySelectorAll('[data-material-id]')||[])button.setAttribute('aria-pressed',String(button.dataset.materialId===data.unifiedMaterialId));
  const right=data.unifiedRight;if(!right)return;right.replaceChildren();
  const key=materialModelKey(selected);data.selectedCandidates||={};
  const explicit=state.productionSelected;
  if(selected.candidates.some(i=>i.record.id===explicit?.id)&&data.localVersions?.[explicit.object_id])data.selectedCandidates[key]=explicit.id;
  if(!selected.candidates.some(i=>i.record.id===data.selectedCandidates[key]))data.selectedCandidates[key]=materialDefaultCandidate(selected,data);
  if(selected.round)state.materialCommentCard={data,material_id:key,number:selected.round.number};
  const chosen=materialCandidateChoice(selected.candidates,data.selectedCandidates[key]);
  const options=entityMaterialCandidateOptions(data,selected);
  renderMaterialCard(right,selected,{...options,roundChange:number=>{
    rememberProductionDraft();switchMaterialRound(data,key,number);delete data.selectedCandidates[key];renderProductionReader();renderComments();focusMaterialRoundControl(key);
  },planVersion:(h,row)=>entityVersionControl(h,row,next=>{data.localVersions||={};data.localVersions[next.object_id]=next}),assetVersion:(h,item)=>entityVersionControl(h,item.record,next=>{data.localVersions||={};data.localVersions[next.object_id]=next})});
  if(chosen?.record.payload.blocks?.length){nodeText('h3',null,'生成结果自检',right);reviewTextBlocks(right,chosen.record)}
  if(chosen)renderMaterialUses(right,chosen.record,data.reference_titles||[]);
}
function renderUnifiedCard(root){
  root.classList.add('unified-card-host');root.replaceChildren();
  const card=el('section','unified-card'),left=el('section','unified-card-context'),right=el('section','unified-card-material');card.append(left,right);root.append(card);
  if(state.entityReview){const data=state.entityReview;data.unifiedRight=right;data.unifiedLeft=left;data.unifiedGroups=[];data.unifiedCollecting=true;renderEntityReview(left);data.unifiedCollecting=false;renderUnifiedSelected(data);if(!right.childNodes.length)nodeText('p','production-meta','此状态尚无素材需求或原件',right)}
  else if(state.materialReview){
    const scope=state.unifiedScope,title=scope?.kind==='AV_SCENE'?breakdownSceneTitle(scope):scope?.kind==='AV_SHOT'?breakdownShotTitle(scope):scope?.kind==='EPISODE'?breakdownEpisodeTitle(scope):reviewPositionText(scope?.payload.title||'素材');nodeText('h2',null,title,left);
    if(scope){nodeText('p','production-meta',({INPUT_LOCK:'全剧',STORY:'全剧',EPISODE:'集',AV_SCENE:'场',AV_SHOT:'镜',STATE:'实体状态'})[scope.kind]||productionKinds[scope.kind],left);reviewTextBlocks(left,scope);if(scope.payload.source)materialReferenceLink(left,scope.payload.source,'剧情依据',true);for(const source of scope.payload.sources||[])materialReferenceLink(left,source,'剧情依据',true)}
    else nodeText('p','production-meta','历史原件未登记实体或制作位置归属',left);
    const detail=state.materialReview,row=detail.record,entries=Object.entries(detail.material_versions||{});
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
async function readUnifiedCard(objectId,revisionId=null,params=null){
  const result=await api('/api/production/card?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{}),...(params?.get('production_entity')?{entity_id:params.get('production_entity')}:{})}));
  result.params=params||new URLSearchParams();result.explicit=!!revisionId;validateUnifiedReference(result);return result;
}
function materialSavedDraft(result){
  const detail=result.detail,params=result.params;
  if(!result.allowDraftFocus||detail.record.kind!=='REQUIREMENT'||['production_revision','material_target','material_version','material_round'].some(key=>params.has(key)))return null;
  const mid=params.get('material_id')||Object.keys(detail.material_versions||{})[0],round=detail.material_versions?.[mid]?.[0];if(!round)return null;
  for(const [key,saved] of Object.entries(state.productionDraftContexts||{}).reverse()){
    let parts;try{parts=JSON.parse(key);if(!saved.anchor||!saved.draftKey||localStorage.getItem(saved.draftKey)===null)continue}catch{continue}
    if(parts[1]!==mid||parts[2]!==round.number||parts[3]!==round.model)continue;
    const row=materialVersionCommentRows(round).find(r=>r.id===parts[0]);if(!row)continue;
    detail.selectedMaterialRounds||={};detail.selectedMaterialRounds[mid]=round.number;state.materialCommentCard={data:detail,material_id:mid,number:round.number};return row;
  }
  return null;
}
function activateUnifiedCard(result){
  const detail=result.detail,row=detail.record,params=result.params;
  state.entityReview=result.entity_review;state.materialReview=state.entityReview||!['ASSET','REQUIREMENT'].includes(row.kind)?null:detail;state.unifiedScope=result.scope;
  state.productionEntityId=state.entityReview?.entity.object_id||null;state.productionChildDetail=null;state.productionEntityDetail=null;
  if(state.entityReview){
    const data=state.entityReview;if(result.explicit&&!result.defaultSelection&&['ENTITY','STATE'].includes(row.kind)){data.localVersions||={};data.localVersions[row.object_id]=row;}if(params.get('production_entity')&&params.get('production_entity')!==data.entity.object_id)throw Error('准确实体不属于此素材');data.states.sort(productionStateOrder);state.productionEntityDetail=entityReviewDetail(result.explicit&&!result.defaultSelection&&row.kind==='ENTITY'?row:data.entity);
    const wanted=params.get('entity_state'),ownedStates=[...data.states,...(data.retained_states||[])],wantedForm=ownedStates.find(r=>r.object_id===wanted);if(wanted&&!wantedForm&&result.form?.object_id!==wanted)throw Error('准确状态不属于此实体');const form=(wanted?(result.form?.object_id===wanted?result.form:wantedForm):result.form)||data.states[0];state.productionChildDetail=form?entityReviewDetail(form):null;
    if(['ASSET','REQUIREMENT','CALL'].includes(row.kind)){const route=entityMaterialRoute(data,row,params,{defaultSelection:result.defaultSelection});const target=params.get('material_target');if(target){const exact=materialVersionCommentRows(route.selected?.round).find(r=>r.id===target);if(!exact)throw Error('准确候选不属于所选素材版本');route.row=exact}restoreEntityMaterialRoute(data,route);if(wanted&&form)state.productionChildDetail=entityReviewDetail(form);data.unifiedMaterialId=route.selected?.material_id||row.object_id}
    else focusProductionReview(entityReviewDetail(row.kind==='STATE'?row:form||row),false);
  }else{
    // This card owns its version route; a caller or parent card may still have
    // another material's exact version in the shared page URL.
    const url=new URL(location.href);for(const key of ['material_id','material_version','material_round','material_target','material_baseline']){const value=params.get(key);if(value===null)url.searchParams.delete(key);else url.searchParams.set(key,value)}history.replaceState(history.state,'',url);
    detail.explicitRevision=result.explicit&&!result.defaultSelection;detail.adoptionContext=result.adoption_context;
    detail.sourceMaterials=result.source_materials||[];
    detail.sourceSession||={cards:{[row.id]:result},request:0};
    if(params.has('material_round')&&Object.keys(detail.legacy_material_versions||{}).length)detail.material_versions=detail.legacy_material_versions;
    const target=params.get('material_target');if(target&&!materialRows(detail).some(r=>r.id===target))throw Error('准确候选引用不存在；未替换为最新结果');
    const draft=!target?materialSavedDraft(result):null;
    if(target||draft)detail.selectedCandidateId=target||draft.id;
    focusProductionReview(target?entityReviewDetail(materialRows(detail).find(r=>r.id===target)):draft?entityReviewDetail(draft):detail,false);
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

async function openUnifiedMaterial(ref,trigger){
  rememberProductionDraft();if(typeof pauseReviewMedia==='function')pauseReviewMedia();
  const workspace=state.workspace,epoch=productionLoadEpoch,owns=()=>state.workspace===workspace&&productionLoadEpoch===epoch;
  const fields=['shotReferenceContext','productionDraftScope','productionSelected','productionDetail','productionEntityDetail','productionChildDetail','productionEntityId','entityReview','materialReview','unifiedScope','unifiedCardRoot','anchor','editing','selected','reviewCommentScope','pending','drawMode','suggestion','preview','previewExpanded','materialCommentCard','reviewReferenceContext','historyOpen','historyLimit'];
  const saved=Object.fromEntries(fields.map(k=>[k,state[k]])),url=location.href,panel=$('#comment-panel'),parent=panel.parentNode,next=panel.nextSibling,hidden=panel.hidden;
  const {dialog,body}=openReviewDialog('实体与素材详情',trigger,'unified-card-dialog');nodeText('p',null,'正在读取…',body);
  // The exact read is isolated; closing before it finishes cannot replace outer state.
  dialog.addEventListener('close',()=>{parent.insertBefore(panel,next?.parentNode===parent?next:null);if(!owns())return;rememberProductionDraft();Object.assign(state,saved);if(!dialog.closedByHistory)history.replaceState(history.state,'',url);renderComments();setPanelOpen(!hidden);paintProductionReview();if(ref.shotReference?.saved)ref.shotReference.onSaved(ref.shotReference.saved)},{once:true});
  try{const result=await readUnifiedCard(ref.object_id,ref.revision_id||ref.id,ref.params);if(!dialog.isConnected||!owns())return;
    while(typeof reviewDialogStack!=='undefined'&&reviewDialogStack.at(-1)!==dialog&&dialog.isConnected){const upper=reviewDialogStack.at(-1);await new Promise(resolve=>upper.addEventListener('close',resolve,{once:true}));if(!dialog.isConnected||!owns())return;}
    result.defaultSelection=!!ref.defaultSelection;
    state.shotReferenceContext=ref.shotReference?{...ref.shotReference,dialog,source:ref.shotReference,pageActive:owns}:null;
    if(ref.component_id){const data=result.entity_review||result.detail;data.selectedComponents||={};data.selectedComponents[ref.revision_id]=ref.component_id;if(!result.entity_review)result.detail.componentId=ref.component_id}
    state.unifiedCardRoot=body;panel.remove();dialog.append(panel);activateUnifiedCard(result);renderProductionReader();renderComments();
  }catch(error){if(dialog.isConnected){body.replaceChildren();nodeText('p','production-issue',error.message,body)}}
}

function validateUnifiedReference(result){
  const params=result.params,detail=result.detail,data=result.entity_review||detail;
  const versions=params.has('material_round')?data.legacy_material_versions:data.material_versions;
  normalizeConsolidatedMaterialRoute(params,versions);
  const parameter=params.has('material_round')?'material_round':'material_version',mid=params.get('material_id');let number=Number(params.get(parameter));
  if(params.has(parameter)&&(!Number.isSafeInteger(number)||number<1))throw Error('准确素材版本无效；未替换为当前版本');
  if(mid&&!Object.hasOwn(versions||{},mid))throw Error('准确素材标识不存在；未替换为其他素材');
  const sets=Object.entries(versions||{}).filter(([id])=>!mid||id===mid),rounds=sets.flatMap(([,rs])=>rs);
  if(number&&!rounds.some(r=>r.number===number))throw Error('准确素材版本不存在；未替换为最新版本');
  const target=params.get('material_target');if(target&&!(number?rounds.filter(r=>r.number===number).flatMap(materialVersionCommentRows):materialRows(detail)).some(r=>r.id===target))throw Error('准确候选不存在；未替换为最新结果');
}
