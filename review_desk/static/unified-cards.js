/* One entity/material reader, whether embedded or opened over a scene. */
function materialModelKey(model){return model.material_id||model.need?.object_id||model.identity?.object_id||model.candidates[0]?.record.object_id}
function materialDefaultCandidate(model,data){
  const candidates=model.candidates||[],adoptions=data?.adoptions||data?.adoptionContext?.adoptions||[];
  const need=model.need||model.identity,scope=need?.payload.scope;
  const adopted=adoptions.find(a=>a.payload.slot===need?.payload.slot&&(!scope||a.payload.scope?.revision_id===scope.revision_id&&a.payload.scope?.object_id===scope.object_id)&&candidates.some(i=>i.record.id===a.payload.asset.revision_id&&i.record.object_id===a.payload.asset.object_id));
  if(adopted){data.selectedComponents||={};data.selectedComponents[adopted.payload.asset.revision_id]??=adopted.payload.component_id;const item=candidates.find(i=>i.record.id===adopted.payload.asset.revision_id),same=data.selectedComponents[item.record.id]===adopted.payload.component_id;item.crop=same?adopted.payload.crop||null:null;item.range=same?adopted.payload.range||null:null}
  return adopted?.payload.asset.revision_id||materialCandidateChoice(candidates,null)?.record.id||null;
}
function materialSmallCard(parent,item,activate,selected=false){
  const button=productionButton(parent,'',()=>activate(button));button.className='material-small-card';button.dataset.materialId=item.object_id;button.setAttribute('aria-pressed',String(selected));
  const preview=el('span','material-small-preview');
  if(item.preview?.mime?.startsWith('image/')){const img=el('img');img.src='/api/production/files/'+encodeURIComponent(item.preview.file);img.alt='';img.loading='lazy';preview.append(img)}else preview.append(productionEntityIcon(item.media_type));
  button.append(preview);const content=el('span','material-small-copy');nodeText('strong',null,item.title,content);
  nodeText('small',null,[productionMediaLabels[item.media_type]||item.media_type,({overall:'整体参考',voice:'音色','shot-video':'镜头视频',angles:'补充角度',layout:'空间布局','shared-style':'风格参考','video':'视频',detail:'局部细节','blocking-map':'场级调度','composition':'构图参考','sound-reference':'声音参考'})[item.slot]||item.slot,item.generated?'已生成':'未生成'].filter(Boolean).join(' · '),content);
  if(item.placement_title)nodeText('small','material-placement',({mounted:'挂载',applicable:'适用',state:'状态素材适用'})[item.association]+' · '+item.placement_title,content);
  button.append(content);return button;
}
function modelSmallItem(model){
  const row=model.need||model.identity||model.candidates[0]?.record,real=(model.candidates||[]).filter(i=>!i.record.payload.placeholder&&i.record.payload.components.some(c=>c.role==='original'));
  return {object_id:materialModelKey(model),id:row.id,title:row.payload.generation?.output.name||row.payload.title,media_type:row.payload.media_type,slot:row.payload.slot,generated:real.length>0,preview:real.flatMap(i=>i.record.payload.components).find(c=>c.role==='original'&&c.mime.startsWith('image/'))};
}
function unifiedModelSelection(models,data){
  const target=state.productionSelected,card=state.materialCommentCard;
  const explicit=models.find(m=>card?.data===data&&materialModelKey(m)===card.material_id&&m.round?.members.some(r=>r.id===target?.id))||models.find(m=>data.localVersions&&m.round?.members.some(r=>data.localVersions[r.object_id]?.id===r.id));
  const current=models.find(m=>materialModelKey(m)===data.unifiedMaterialId);
  const rank=m=>{const row=m.need||m.identity||m.candidates[0]?.record;return (row?.payload.media_type==='image'?0:row?.payload.media_type==='audio'?10:20)+(row?.payload.slot==='overall'?0:1)};
  return explicit||current||[...models].sort((a,b)=>rank(a)-rank(b))[0];
}
function renderUnifiedModels(parent,models,data){
  if(!models.length)return;
  data.unifiedGroups||=[];data.unifiedGroups.push(...models);
  const list=el('div','material-small-list');list.setAttribute('aria-label','状态素材');parent.append(list);
  for(const model of models){const key=materialModelKey(model);materialSmallCard(list,modelSmallItem(model),()=>{
    rememberProductionDraft();data.unifiedMaterialId=key;state.materialCommentCard=null;data.localVersions={};
    const row=model.candidates.find(i=>i.record.id===(data.selectedCandidates?.[key]||materialDefaultCandidate(model,data)))?.record||model.need||model.identity;
    if(model.round)state.materialCommentCard={data,material_id:key,number:model.round.number};
    focusProductionReview(entityReviewDetail(row),false);restoreProductionDraft();renderProductionReader();renderComments();
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
  if(chosen){if(chosen.record.payload.blocks?.length)reviewTextBlocks(right,chosen.record);}
}
function renderUnifiedCard(root){
  root.classList.add('unified-card-host');root.replaceChildren();
  const card=el('section','unified-card'),left=el('section','unified-card-context'),right=el('section','unified-card-material');card.append(left,right);root.append(card);
  if(state.entityReview){const data=state.entityReview;data.unifiedRight=right;data.unifiedLeft=left;data.unifiedGroups=[];data.unifiedCollecting=true;renderEntityReview(left);data.unifiedCollecting=false;renderUnifiedSelected(data);if(!right.childNodes.length)nodeText('p','production-meta','此状态尚无素材需求或原件',right)}
  else if(state.materialReview){
    const scope=state.unifiedScope;nodeText('h2',null,scope?.payload.title||'素材',left);
    if(scope){nodeText('p','production-meta',({INPUT_LOCK:'全剧',STORY:'全剧',EPISODE:'集',PREPARATION:'场',SHOT_DESIGN:'镜',STATE:'完整状态'})[scope.kind]||productionKinds[scope.kind],left);reviewTextBlocks(left,scope);if(scope.payload.source)materialReferenceLink(left,scope.payload.source,'剧情依据',true)}
    else nodeText('p','production-meta','历史原件未登记实体或制作位置归属',left);
    const row=state.materialReview.record;materialSmallCard(left,{object_id:row.object_id,id:row.id,title:row.payload.title,media_type:row.payload.media_type,slot:row.payload.slot,generated:row.kind==='ASSET'||!!state.materialReview.candidate_records?.length},()=>{},true);
    renderMaterialWorkspace(right,state.materialReview);
  }
  paintProductionReview();
}
async function readUnifiedCard(objectId,revisionId=null,params=null){
  const result=await api('/api/production/card?'+new URLSearchParams({object_id:objectId,...(revisionId?{revision_id:revisionId}:{})}));
  result.params=params||new URLSearchParams();result.explicit=!!revisionId;validateUnifiedReference(result);return result;
}
function activateUnifiedCard(result){
  const detail=result.detail,row=detail.record,params=result.params;
  state.entityReview=result.entity_review;state.materialReview=state.entityReview||!['ASSET','REQUIREMENT'].includes(row.kind)?null:detail;state.unifiedScope=result.scope;
  state.productionEntityId=state.entityReview?.entity.object_id||null;state.productionChildDetail=null;state.productionEntityDetail=null;
  if(state.entityReview){
    const data=state.entityReview;data.states.sort(productionStateOrder);state.productionEntityDetail=entityReviewDetail(data.entity);
    const form=result.form||data.states[0];state.productionChildDetail=form?entityReviewDetail(form):null;
    if(['ASSET','REQUIREMENT','CALL'].includes(row.kind)){const route=entityMaterialRoute(data,row,params);const target=params.get('material_target');if(target){const exact=route.selected?.round.members.find(r=>r.id===target);if(!exact)throw Error('准确候选不属于所选素材版本');route.row=exact}restoreEntityMaterialRoute(data,route);data.unifiedMaterialId=route.selected?.material_id||row.object_id}
    else focusProductionReview(entityReviewDetail(row.kind==='STATE'?row:form||row),false);
  }else{
    detail.explicitRevision=result.explicit;detail.adoptionContext=result.adoption_context;
    if(params.has('material_round')&&Object.keys(detail.legacy_material_versions||{}).length)detail.material_versions=detail.legacy_material_versions;
    const target=params.get('material_target');if(target&&!materialRows(detail).some(r=>r.id===target))throw Error('准确候选引用不存在；未替换为最新结果');
    if(target)detail.selectedCandidateId=target;
    focusProductionReview(target?entityReviewDetail(materialRows(detail).find(r=>r.id===target)):detail,false);
  }
  restoreProductionDraft();
}
async function openUnifiedMaterial(ref,trigger){
  rememberProductionDraft();
  const workspace=state.workspace,epoch=productionLoadEpoch,owns=()=>state.workspace===workspace&&productionLoadEpoch===epoch;
  const fields=['productionDraftScope','productionSelected','productionDetail','productionEntityDetail','productionChildDetail','productionEntityId','entityReview','materialReview','unifiedScope','unifiedCardRoot','anchor','editing','selected','reviewCommentScope','pending','drawMode','suggestion','preview','previewExpanded','materialCommentCard','reviewReferenceContext','historyOpen','historyLimit'];
  const saved=Object.fromEntries(fields.map(k=>[k,state[k]])),url=location.href,panel=$('#comment-panel'),parent=panel.parentNode,next=panel.nextSibling,hidden=panel.hidden;
  const {dialog,body}=openReviewDialog('实体与素材',trigger,'unified-card-dialog');nodeText('p',null,'正在读取…',body);
  // The exact read is isolated; closing before it finishes cannot replace outer state.
  dialog.addEventListener('close',()=>{parent.insertBefore(panel,next?.parentNode===parent?next:null);if(!owns())return;rememberProductionDraft();Object.assign(state,saved);if(!dialog.closedByHistory)history.replaceState(history.state,'',url);renderComments();panel.hidden=hidden;paintProductionReview()},{once:true});
  try{const result=await readUnifiedCard(ref.object_id,ref.revision_id||ref.id,ref.params);if(!dialog.isConnected||!owns())return;
    state.unifiedCardRoot=body;panel.remove();dialog.append(panel);activateUnifiedCard(result);renderProductionReader();renderComments();
  }catch(error){if(dialog.isConnected){body.replaceChildren();nodeText('p','production-issue',error.message,body)}}
}

function validateUnifiedReference(result){
  const params=result.params,detail=result.detail,data=result.entity_review||detail;
  const versions=params.has('material_round')?data.legacy_material_versions:data.material_versions;
  const parameter=params.has('material_round')?'material_round':'material_version',number=Number(params.get(parameter)),mid=params.get('material_id');
  if(params.has(parameter)&&(!Number.isSafeInteger(number)||number<1))throw Error('准确素材版本无效；未替换为当前版本');
  if(mid&&!Object.hasOwn(versions||{},mid))throw Error('准确素材标识不存在；未替换为其他素材');
  const sets=Object.entries(versions||{}).filter(([id])=>!mid||id===mid),rounds=sets.flatMap(([,rs])=>rs);
  if(number&&!rounds.some(r=>r.number===number))throw Error('准确素材版本不存在；未替换为最新版本');
  const target=params.get('material_target');if(target&&!(number?rounds.filter(r=>r.number===number).flatMap(r=>r.members):materialRows(detail)).some(r=>r.id===target))throw Error('准确候选不存在；未替换为最新结果');
}
