// Only successful entity decisions invalidate in-flight entity detail reads.
const entityDecisionReads=new Map();
async function readEntityDecisionView(url){
  for(let attempt=0;attempt<2;attempt++){
    const started=new Map(entityDecisionReads),result=await api(url),owner=(result.entity_review||result).entity?.object_id;
    if(!owner||(started.get(owner)||0)===(entityDecisionReads.get(owner)||0))return result;
  }
  throw Error('实体决定在读取期间已更新，请重新打开核对当前状态。');
}
/* The settings workspace is a review surface. Content changes use the shared tools. */
const isEntityReview=()=>isProduction()&&!!state.entityReview;
const entityReviewDetail=record=>({record,history:[record],uses:[]});
const entityReviewRows=data=>[data.entity,...data.states,...(data.requirements||[]),...(data.relationships||[]),...data.media.map(m=>m.record),...(data.comment_records||[])];
const entityReviewStateMedia=(data,form)=>form?data.media.filter(m=>(m.state||m.review_state)?.object_id===form.object_id&&(m.state||m.review_state).revision_id===form.id):[];
const entityReviewUnassignedMedia=data=>data.media.filter(m=>!(m.state||m.review_state));
const entityReviewMediaCount=items=>new Set(items.map(m=>m.record.id)).size;
const entityReviewShort=(row,entity)=>row.payload.title.startsWith(entity.payload.title)?row.payload.title.slice(entity.payload.title.length).replace(/^[\s·：:—-]+/u,'')||row.payload.title:row.payload.title;
function entityReviewFocus(row){focusProductionReview(entityReviewDetail(row))}
function entityReviewComments(){const data=state.entityReview,targets=[...data.comment_targets,...(data.historicalTarget?[productionRef(data.historicalTarget)]:[])];return state.comments.filter(c=>targets.some(t=>t.object_id===c.target_object_id&&t.revision_id===c.target_revision_id))}
function entityReviewCommentGroup(comment){const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id),label=row?.kind==='ENTITY'?'实体':row?.kind==='STATE'?'状态 · '+entityReviewShort(row,data.entity):row?.kind==='ASSET'?'素材 · '+row.payload.title:row?.kind==='REQUIREMENT'?'素材方案 · '+row.payload.title:row?.kind==='MATERIAL_RELATION'?'参考用途 · '+(typeof materialRelationTitle==='function'?materialRelationTitle(row):row.payload.title):row?.kind==='RELATION'?'关系 · '+row.payload.title:row?.kind==='CALL'?'实际生成 · '+row.payload.title:'历史整体意见';const round=typeof materialRecordRound==='function'&&['ASSET','REQUIREMENT','CALL'].includes(row?.kind)?comment.material_plan_scopes?.[0]?.number||comment.material_scopes?.[0]?.number||materialRecordRound(row):null;return reviewPositionText(label)+(round?' · 版本 '+round:row&&row.id!==row.current_revision?' · 历史版本 '+row.version:'')}
function appendEntityReviewComments(parent,comments){
  const groups=new Map();for(const comment of comments){const key=entityReviewCommentGroup(comment);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(comment)}
  for(const [label,rows] of groups){nodeText('h4','entity-review-comment-group',`${label} · ${rows.length}`,parent);for(const row of rows)parent.append(commentCard(row))}
}
// An entity URL may focus one of its exact material members without changing
// the workspace's index groups or treating an unrelated object as its content.
function entityMaterialRouteOwner(row,param){
  if(!['ASSET','REQUIREMENT','CALL'].includes(row?.kind))return null;
  const owner=param.get('production_entity');
  if(owner&&!(state.productionRecords||[]).some(r=>r.object_id===owner&&r.kind==='ENTITY'))throw new Error('此素材链接的实体不存在，请核对原链接。');
  return owner||null;
}
function entityMaterialRoute(data,row,param,{defaultSelection=false}={}){
  data.planMaterialVersions||=data.material_versions;
  const routeVersions=param.has('material_round')?data.legacy_material_versions:data.material_versions;
  if(Object.values(routeVersions||{}).some(rs=>rs.some(r=>r.baseline_id)))normalizeConsolidatedMaterialRoute(param,routeVersions);
  if(param.has('material_round')&&Object.keys(data.legacy_material_versions||{}).length)data.material_versions=data.legacy_material_versions;
  const same=r=>r.object_id===row.object_id&&r.id===row.id;
  const entries=Object.entries(data.material_versions||{}).flatMap(([material_id,rounds])=>rounds.filter(round=>materialVersionCommentRows(round).some(same)).map(round=>({material_id,round})));
  const mid=param.get('material_id'),number=param.get(materialVersionParam(data));
  const choices=entries.filter(e=>(!mid||e.material_id===mid)&&(!number||String(e.round.number)===number));
  if((mid||number)&&!choices.length)throw new Error('此实体中的素材版本已不可用，请从实体内重新选择；原链接未改动。');
  const contexts=[...Object.values(data.materialContexts||{}),...data.media.map(item=>item.review_context)].filter(Boolean);
  const known=[...entityReviewRows(data),...contexts.flatMap(context=>[context.call,...(context.requirements||[])].filter(Boolean))];
  if(!entries.length&&!known.some(same))throw new Error('此准确素材版本不属于当前实体，请核对原链接。');
  const stateId=param.get('entity_state');
  const preferred=mid||(defaultSelection?row.material_identity?.id:null)||row.object_id;
  let selected=(stateId?choices.find(e=>e.round.plan?.payload.scope?.object_id===stateId):null)||choices.find(e=>e.material_id===preferred)||choices[0]||null;
  if(defaultSelection&&row.kind==='REQUIREMENT'&&row.id===row.current_revision&&selected&&!number&&!param.has('material_target')){
    selected={material_id:selected.material_id,round:materialDefaultRound(data.material_versions[selected.material_id])};
    row=selected.round.plan||row;
  }
  return {row,selected};
}
function restoreEntityMaterialRoute(data,route){
  const {row,selected}=route;
  if(!(data.comment_records||[]).some(r=>r.id===row.id)){data.comment_records||=[];data.comment_records.push(row)}
  if(!(data.comment_targets||[]).some(r=>r.object_id===row.object_id&&r.revision_id===row.id)){data.comment_targets||=[];data.comment_targets.push(productionRef(row))}
  if(selected){data.selectedMaterialRounds||={};data.selectedMaterialRounds[selected.material_id]=selected.round.number;state.materialCommentCard={data,material_id:selected.material_id,number:selected.round.number}}
  data.localVersions||={};if(['ASSET','REQUIREMENT'].includes(row.kind))data.localVersions[row.object_id]=row;
  const scope=selected?.round.plan?.payload.scope||(row.kind==='REQUIREMENT'?row.payload.scope:null);
  const form=scope&&data.states.find(r=>r.object_id===scope.object_id&&r.id===scope.revision_id);
  if(form)state.productionChildDetail=entityReviewDetail(form);
  const assets=row.kind==='ASSET'?[row]:(selected?.round.results||[]),assetIds=new Set(assets.map(r=>r.object_id));
  const items=data.media.filter(item=>assetIds.has(item.record.object_id));
  if(!form){const item=items.find(item=>item.state?.revision_id===state.productionChildDetail?.record.id)||items.find(item=>item.state&&data.states.some(s=>s.id===item.state.revision_id));const covered=item&&data.states.find(s=>s.id===item.state.revision_id&&s.object_id===item.state.object_id);if(covered)state.productionChildDetail=entityReviewDetail(covered)}
  const retained=selected&&data.media.some(item=>!item.state&&(data.material_versions[selected.material_id]||[]).some(round=>round.members.some(member=>member.kind==='ASSET'&&member.object_id===item.record.object_id&&member.id===item.record.id)));
  if(retained||items.some(item=>!item.state))data.unassignedOpen=true;
  if(row.kind==='REQUIREMENT')data.openRecipe=row.object_id;
  // Schema-1 snapshots have exact media/context but no material rounds.
  if(row.kind==='CALL'&&!selected)data.historicalCall=row;
  if(row.kind==='ASSET'&&!items.length){const component=row.payload.components.find(c=>/^(image|audio|video)\//.test(c.mime));if(component)data.historicalMedia={id:'history:'+row.id,label:row.payload.title,record:row,component,component_id:component.id,state:null,role:'related',review_context:data.materialContexts?.[row.id]}}
  if(row.id!==row.current_revision)data.historicalTarget=row;
  focusProductionReview(entityReviewDetail(row),false);
}
async function openEntityReview(owner,detail,epoch,exactRevision,view=null){
  const workspace=state.workspace,cardRoot=state.unifiedCardRoot||null,url=new URL(location.href),same=state.productionEntityId===owner||url.searchParams.get('production_entity')===owner||!url.searchParams.has('production_entity')&&url.searchParams.get('production_object')===owner;
  const reviewRevision=same?url.searchParams.get('entity_acceptance'):null;
  const query=new URLSearchParams({entity_id:owner,...(reviewRevision?{revision_id:reviewRevision}:{})});
  const data=await readEntityDecisionView('/api/production/entity-review?'+query);
  data.planMaterialVersions=data.material_versions;
  if(epoch!==productionReadEpoch||(state.unifiedCardRoot||null)!==cardRoot||!isProduction()||state.workspace!==workspace||workspace==='settings.workspace'&&!state.unifiedCardRoot&&state.productionVisibleEntities&&!state.productionVisibleEntities.has(owner)&&!(exactRevision&&data.entity.payload.status==='withdrawn'))return;
  const retained=view?.();
  const materialRoute=['ASSET','REQUIREMENT','CALL'].includes(detail.record.kind)?entityMaterialRoute(data,detail.record,url.searchParams):null;
  const rows=[data.entity,...data.states],match=rows.find(r=>r.id===detail.record.id);
  data.historicalTarget=exactRevision&&!match&&['ENTITY','STATE'].includes(detail.record.kind)?detail.record:null;
  data.currentStates=data.states;data.states=[...data.states,...(data.retained_states||[])];data.states.sort(productionStateOrder);
  const remembered=same?(data.states.find(r=>r.object_id===url.searchParams.get('entity_state'))||(materialRoute?(state.productionRecords||[]).find(r=>r.kind==='STATE'&&r.object_id===url.searchParams.get('entity_state')&&r.payload.entity?.object_id===owner):null)):null;
  const form=data.states.find(r=>r.id===retained?.stateId)||(detail.record.kind==='STATE'?(match||(exactRevision?detail.record:data.states.find(r=>r.object_id===detail.record.object_id)||data.states[0])):remembered||data.states[0]||null);
  state.entityReview=data;state.productionEntityId=owner;
  state.productionEntityDetail=entityReviewDetail(data.historicalTarget?.kind==='ENTITY'?data.historicalTarget:data.entity);
  state.productionChildDetail=form?entityReviewDetail(form):null;state.entityReviewMedia=null;state.entityReviewUnassignedMedia=null;
  // Current browsing follows live content; only a deliberate historical link
  // keeps an acceptance revision. Legacy workflow URLs return to the entity.
  url.searchParams.delete('entity_submission');
  if(!reviewRevision)url.searchParams.delete('entity_acceptance');
  url.searchParams.set('production_entity',owner);if(form)url.searchParams.set('entity_state',form.object_id);history.replaceState(history.state,'',url);
  if(materialRoute)restoreEntityMaterialRoute(data,materialRoute);
  else focusProductionReview(entityReviewDetail(exactRevision&&detail.record.kind==='ENTITY'?state.productionEntityDetail.record:form||data.entity),false);
  if(retained){
    Object.assign(data,retained.fields);
    state.materialCommentCard=null;
  }
  if(!state.unifiedCardRoot)for(const button of document.querySelectorAll('#production-index button')){
    const selected=button.dataset.objectId===owner;
    button.classList.toggle('active',selected);
    if(button.dataset.objectId)button.setAttribute('aria-pressed',String(selected));
  }
  renderProductionReader();renderComments();
  return true;
}
async function reloadEntityReview(revision=null){
  const data=state.entityReview,form=state.productionChildDetail?.record;
  const fields=['unifiedMaterialId','selectedMaterialRounds','selectedCandidates','selectedComponents','stateMaterialViews','roundDrafts','materialReaders'];
  const view=revision?null:()=>({stateId:state.productionChildDetail?.record.id,fields:Object.fromEntries(fields.filter(key=>data[key]!==undefined).map(key=>[key,data[key]]))});
  const restore=typeof preserveCardPosition==='function'?preserveCardPosition():()=>{};
  const url=new URL(location.href);url.searchParams.delete('entity_submission');url.searchParams.delete('entity_acceptance');if(revision)url.searchParams.set('entity_acceptance',revision);history.replaceState(history.state,'',url);
  const loaded=await openEntityReview(data.entity.object_id,entityReviewDetail(revision?data.entity:form||data.entity),++productionReadEpoch,null,view);
  if(loaded)restore();
}
function selectEntityReviewState(row){
  const data=state.entityReview,previous=state.productionChildDetail?.record;
  if(previous?.id===row.id)return;
  cancelMaterialCommentLocation();rememberProductionDraft();
  data.stateMaterialViews||={};
  const fields=['selectedMaterialRounds','selectedCandidates','selectedComponents','roundDrafts'];
  if(previous)data.stateMaterialViews[previous.id]={unifiedMaterialId:data.unifiedMaterialId,...Object.fromEntries(fields.map(key=>[key,{...(data[key]||{})}]))};
  const saved=data.stateMaterialViews[row.id];
  for(const key of fields)data[key]={...(saved?.[key]||{})};
  data.unifiedMaterialId=saved?.unifiedMaterialId||null;state.materialCommentCard=null;
  state.entityReview.historicalTarget=null;state.entityReview.historicalMedia=null;state.entityReview.historicalCall=null;state.entityReview.historicalRelation=null;state.entityReview.localVersions={};state.entityReview.unassignedOpen=false;state.productionEntityDetail=entityReviewDetail(state.entityReview.entity);
  state.productionChildDetail=entityReviewDetail(row);state.entityReviewMedia=null;
  focusProductionReview(state.productionChildDetail,false);renderProductionReader();renderComments();
}
function entityReviewScope(row){
  const scenes=[...new Map((state.entityReview.usages[row.id]||[]).filter(u=>u.kind==='AV_SHOT').flatMap(u=>(u.sources||[]).map(source=>[source.object_id+source.scene_id,source]))).values()];
  if(!scenes.length)return row.payload.reference_media==='none'?'仅被提及':'尚未关联实际出场';
  const sceneName=ref=>{const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.object_id===ref.object_id&&e.id===ref.revision_id);return `${(ep?.payload.number||ep?.payload.episode_number)?reviewPositionLabel('episode',ep)+' · ':''}${reviewPositionLabel('scene',ref.scene_id,ref.object_id)}`};
  return scenes.length===1?sceneName(scenes[0]):`${sceneName(scenes[0])} 至 ${sceneName(scenes.at(-1))} · ${scenes.length} 场`;
}
function entityVersionControl(parent,row,onchange){
  const data=state.entityReview,versions=data.versions?.[row.object_id]||[{id:row.id,version:row.version}];
  if(row.kind==='RELATION')return;
  const bar=reviewChoiceButtons(parent,reviewPositionText(row.payload.title)+'的版本',[...versions].sort((a,b)=>a.version-b.version).map(v=>({id:v.id,label:'版本 '+v.version})),row.id,async id=>{
    data.versionRequests||={};const token=(data.versionRequests[row.object_id]||0)+1;data.versionRequests[row.object_id]=token;
    const epoch=productionReadEpoch,formId=state.productionChildDetail?.record.object_id;
    try{const detail=await api('/api/production?'+new URLSearchParams({object_id:row.object_id,revision_id:id}));
      if(data.versionRequests[row.object_id]!==token||state.entityReview!==data||productionReadEpoch!==epoch||!bar.isConnected||row.kind==='STATE'&&state.productionChildDetail?.record.object_id!==formId)return;
      if(!data.comment_records.some(r=>r.id===detail.record.id))data.comment_records.push(detail.record);
      if(!data.comment_targets.some(r=>r.revision_id===detail.record.id))data.comment_targets.push(productionRef(detail.record));
      onchange(detail.record);entityReviewFocus(detail.record);renderProductionReader();renderComments();
    }catch(error){if(state.entityReview===data&&data.versionRequests[row.object_id]===token)toast(error.message)}
  },{repeat:true});
}
function entitySources(parent,row){
  const data=state.entityReview,sources=el('div','entity-review-sources'),unique=new Map();
  for(const source of row.payload.sources||[]){const key=source.revision_id+source.scene_id;if(!unique.has(key))unique.set(key,{...source,block_ids:[]});unique.get(key).block_ids.push(...source.block_ids)}
  const uses=(data.usages[row.id]||[]).filter(u=>u.kind==='AV_SHOT');
  data.evidenceViews||={};const saved=data.evidenceViews[row.id]||={open:false,tab:null};
  const appendSources=host=>{if(!unique.size)nodeText('p','production-meta','此版本未登记剧情依据',host);for(const source of unique.values()){source.block_ids=[...new Set(source.block_ids)].sort();productionRefLink(host,source,source.scene_id?reviewPositionLabel('scene',source.scene_id,source.object_id):'正文')}};
  if(row.kind!=='STATE'){
    const detail=el('details','entity-evidence-frame');detail.open=saved.open;nodeText('summary',null,`剧情依据 · ${unique.size} 场`,detail);appendSources(detail);detail.ontoggle=()=>{saved.open=detail.open};sources.append(detail);
  }else{
    const frame=el('section','entity-evidence-frame'),tabs=el('div','entity-evidence-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','选定状态的依据');frame.append(tabs);
    const content=el('div','entity-evidence-content');content.id='evidence-'+row.id;content.setAttribute('role','tabpanel');frame.append(content);
    const buttons=[];for(const [key,label] of [['sources',`剧情依据 · ${unique.size} 场`],['shots',`关联镜头 · ${uses.length} 镜`]]){
      const button=productionButton(tabs,label,()=>{saved.open=!(saved.open&&saved.tab===key);saved.tab=saved.open?key:null;draw()});button.setAttribute('role','tab');button.setAttribute('aria-controls',content.id);buttons.push([key,button]);
      button.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const target=event.key==='Home'?'sources':event.key==='End'?'shots':key==='sources'?'shots':'sources';buttons.find(([key])=>key===target)[1].focus({preventScroll:true})}};
    }
    const draw=()=>{for(const [key,button] of buttons){button.setAttribute('aria-selected',String(saved.open&&key===saved.tab));button.setAttribute('aria-expanded',String(saved.open&&key===saved.tab));button.tabIndex=0}content.hidden=!saved.open;content.replaceChildren();if(!saved.open)return;if(saved.tab==='sources')appendSources(content);else if(uses.length)for(const use of uses)productionRefLink(content,use,use.title);else nodeText('p','production-meta','此版本未关联镜头',content)};
    draw();sources.append(frame);
  }
  parent.append(sources);
}
function reviewTextBlocks(parent,row){
  const host=reviewSurface(el('div','entity-review-text'));host.dataset.productionBlocks=row.id;if(state.productionSelected?.id===row.id)host.id='production-blocks';
  host.onpointerdown=()=>entityReviewFocus(row);host.onfocusin=()=>entityReviewFocus(row);
  for(const block of row.payload.blocks){let offset=0;for(const line of block.text.split('\n')){const para=nodeText('p',null,line,host);para.dataset.blockId=block.id;para.dataset.anchorOffset=offset;offset+=Array.from(line).length+1}}
  const description=productionTextBlocks(row).find(b=>b.field==='production_description');if(description){const para=nodeText('p',null,description.text,host);para.dataset.blockId=description.id}
  reviewNotes(host,row);parent.append(host);return host;
}
function reviewNotes(parent,row){
  const notes=productionTextBlocks(row).slice(row.payload.blocks.length);
  for(const [key,label] of [['facts','剧本事实'],['choices','制作选择'],['unknowns','待确认']]){
    const values=notes.filter(block=>block.field===key);if(!values.length)continue;
    const section=el('section','entity-review-notes'+(key==='unknowns'?' entity-review-unknowns':''));section.setAttribute('aria-label',label);nodeText('h4',null,label,section);
    for(const block of values){const para=nodeText('p',null,block.text,section);para.dataset.blockId=block.id}parent.append(section);
  }
}
function entityReviewHasHistoricalContent(data,entity,form){
  return !!data.historicalTarget||!!data.historical||entity.id!==data.entity.id||
    !!form&&(data.retained_states||[]).some(row=>row.id===form.id)||
    !!form&&!data.states.some(row=>row.object_id===form.object_id&&row.id===form.id)||
    Object.values(data.localVersions||{}).some(row=>['ENTITY','STATE'].includes(row.kind)&&row.id!==row.current_revision);
}
function entityReviewWithdrawals(data,entity,form){
  // A historical acceptance contains its old scope, not today's entity payload.
  const current=!data.historical&&data.entity.payload.status==='withdrawn'?data.entity:null;
  const withdrawn=current||(entity.payload.status==='withdrawn'?entity:null),rows=[];
  if(withdrawn)rows.push({record:withdrawn,label:current&&entity.id!==current.id?'此实体当前已撤回':withdrawn.id===withdrawn.current_revision?'此实体已撤回':'此实体版本已撤回'});
  if(form?.payload.status==='withdrawn')rows.push({record:form,label:form.id===form.current_revision?'此状态已撤回':'此状态版本已撤回'});
  return rows;
}
function renderEntityWithdrawals(parent,rows){
  if(!rows.length)return;
  const section=el('section','entity-review-notes'),reasons=new Set();section.setAttribute('aria-label','撤回说明');
  for(const {record,label} of rows){
    nodeText('p',null,label,section);
    const reason=record.payload.withdrawal_reason;
    if(typeof reason==='string'&&reason.trim()&&!reasons.has(reason)){nodeText('p',null,reason,section);reasons.add(reason)}
    const refs=record.payload.merged_into;if(!Array.isArray(refs))continue;
    const valid=refs.filter(ref=>ref?.object_id&&ref.revision_id);
    if(valid.length){const links=el('div','production-toolbar');nodeText('span',null,(record.kind==='ENTITY'?'实体':'状态')+'归并至：',links);for(const [index,ref] of valid.entries()){
      const exact=state.productionRecords?.find(row=>row.object_id===ref.object_id&&row.id===ref.revision_id);
      productionRefLink(links,ref,exact?.payload.title||`查看归并去向 ${index+1}`);
    }section.append(links)}
  }
  parent.append(section);
}
function renderEntityReview(root){
  const data=state.entityReview,entity=state.productionEntityDetail.record,form=state.productionChildDetail?.record;
  if(data.retained_states?.length){data.currentStates||=data.states;data.states=[...new Map([...data.states,...data.retained_states].map(row=>[row.id,row])).values()];data.states.sort(productionStateOrder)}
  const viewingHistory=entityReviewHasHistoricalContent(data,entity,form),withdrawals=entityReviewWithdrawals(data,entity,form),withdrawnEntity=withdrawals.some(item=>item.record.kind==='ENTITY');
  const header=el('header','entity-review-header'),identity=el('div'),badge=el('small','production-pill production-entity-badge');badge.dataset.entityType=entity.payload.entity_type;badge.append(productionEntityIcon(entity.payload.entity_type));nodeText('span',null,productionLabels[entity.payload.entity_type],badge);const title=nodeText('h2','entity-card-title',businessTitle(entity),identity);title.append(badge);header.append(identity);
  const actions=el('div','production-toolbar');
  let saveNotice;const showSaveNotice=message=>{if(!saveNotice){saveNotice=nodeText('p','production-issue',message,actions);saveNotice.setAttribute('role','status')}else saveNotice.textContent=message};
  if(data.decisionSave?.message)showSaveNotice(data.decisionSave.message);
  const accept=productionButton(actions,data.can_revoke?'取消采纳':'采纳',async()=>{
    if(data.decisionSave||!isEntityReview()||state.entityReview!==data||entityReviewHasHistoricalContent(data,state.productionEntityDetail.record,state.productionChildDetail?.record)||entityReviewWithdrawals(data,state.productionEntityDetail.record,state.productionChildDetail?.record).length)return;
    accept.disabled=true;const action=data.can_revoke?'revoke':'accept',reason=action==='accept'?(data.acceptance_mode==='content'?'采纳当前基础信息、关系、实体状态及状态素材方案；实体自身的素材需求独立审阅。生成前仍需完善并认可方案。':'采纳此实体的基础信息、关系、全部实体状态和素材生成方案，允许推进素材生成。'):'取消当前采纳，保留历史制作与意见。';
    const refreshIndex=state.refreshEntityIndex;
    const epoch=productionReadEpoch,owns=()=>isEntityReview()&&state.entityReview===data&&productionReadEpoch===epoch&&accept.isConnected;
    const label=action==='accept'?'采纳':'取消采纳',savedMessage=`「${data.entity.payload.title}」的${label}已保存`;
    data.decisionSave={message:''};
    try{await api('/api/production/entity-decision',{method:'POST',body:JSON.stringify({entity_id:data.entity.object_id,action,decision_ref:data.revoke_target,expected_version:data.decision_version,scope:data.decision_scope||data.scope,acceptance_mode:data.acceptance_mode,actor:'用户',reason})})}
    catch(error){
      const outcome=error.status===409?'版本已变化，本次未保存':error.status>=400&&error.status<500?'本次未保存':'结果待确认';
      data.decisionSave.message=`${label}${outcome}：${error.message}。请重新打开此实体核对后再操作。`;
      if(owns()){showSaveNotice(data.decisionSave.message);toast(data.decisionSave.message)}return;
    }
    entityDecisionReads.set(data.entity.object_id,(entityDecisionReads.get(data.entity.object_id)||0)+1);
    data.decisionSave.message=savedMessage+'；请重新打开此实体核对当前状态。';toast(savedMessage);
    // Saving belongs to the submitted entity; its list outlives this detail.
    // Capture that list, never a replacement page's callback after the POST.
    const indexRefresh=refreshIndex?.(savedMessage);
    if(!owns()){await indexRefresh;return}
    const refresh=reloadEntityReview(),refreshEpoch=productionReadEpoch;
    try{await refresh}
    catch(error){data.decisionSave.message=savedMessage+`；当前显示尚未更新：${error.message}。请重新打开此实体核对。`;if(isEntityReview()&&state.entityReview===data&&productionReadEpoch===refreshEpoch&&accept.isConnected){showSaveNotice(data.decisionSave.message);toast(data.decisionSave.message)}}
    await indexRefresh;
  });accept.classList.add('entity-review-accept');accept.title=withdrawals.length?withdrawals[0].label+'；保留历史内容与评论，不对此版本采纳或取消。':viewingHistory?'正在查看历史内容，不能执行采纳或取消；请查看当前状态。':data.acceptance_mode==='content'?'采纳当前基础信息、关系、实体状态及状态素材方案；实体自身的素材需求独立审阅。生成前仍需完善并认可方案。':'采纳基础信息、关系、全部实体状态及状态素材方案；实体自身的素材需求独立审阅。生成前仍需核对准确认可。';accept.disabled=!!data.decisionSave||(!data.can_accept&&!data.can_revoke)||viewingHistory||!!withdrawals.length;
  const scopeInfo=el('details','entity-decision-scope');nodeText('summary',null,'整体采纳范围与理由',scopeInfo);
  nodeText('p',null,'覆盖下列准确基础信息、直接关系、全部实体状态及状态素材方案；实体自身需求独立审阅。状态方案可单独采纳，也可使用有效的整体生成许可。两条路径择一，原件选择与生成前检查仍须满足。',scopeInfo);
  renderDecisionScope(scopeInfo,data.decision_scope||data.scope,data.decision_scope_records||[]);
  nodeText('p','production-meta',data.acceptance_mode==='content'?'本次仅认可内容；完整生成方案仍需完善后重新认可。':'本次包含完整方案许可；采纳不调用模型，结果及采用分别决定。',scopeInfo);
  if(data.decision){nodeText('p',null,'最新整体决定：'+reviewDecisionLabel(data.decision)+' · '+data.decision.payload.actor+' · '+reviewDecisionTime(data.decision.created_at),scopeInfo);nodeText('p',null,data.decision.payload.reason,scopeInfo)}
  if(data.history?.length){const history=el('details');nodeText('summary',null,'整体决定历史 · '+data.history.length,history);for(const item of data.history){if(!item.decision)continue;const decision=renderReviewDecision(history,item.decision,{historical:true});renderDecisionScope(decision,item.decision.payload.acceptance_scope,item.scope_records||[])}scopeInfo.append(history)}
  actions.append(scopeInfo);
  identity.classList.add('entity-review-identity');entityVersionControl(identity,entity,row=>{state.productionEntityDetail=entityReviewDetail(row);data.historicalTarget=row.id===row.current_revision?null:row});header.append(actions);root.append(header);renderEntityWithdrawals(root,withdrawals);
  if(data.historicalTarget?.kind==='REPRESENTATION'){const old=el('section');nodeText('h3',null,'历史关联说明',old);reviewTextBlocks(old,data.historicalTarget);root.append(old)}
  const basics=el('section','entity-review-basics');basics.setAttribute('aria-label','实体基础信息');const basicHeading=el('div','entity-review-local-heading');nodeText('h3',null,'基础信息',basicHeading);basics.append(basicHeading);
  if(entity.payload.aliases?.length)nodeText('p','production-meta','别名：'+entity.payload.aliases.join('、'),basics);reviewTextBlocks(basics,entity);entitySources(basics,entity);root.append(basics);
  const ownNeeds=(data.requirements||[]).filter(r=>r.payload.scope?.object_id===entity.object_id&&r.payload.scope.revision_id===entity.id);
  if(ownNeeds.length){const materials=el('section','entity-state-materials');materials.setAttribute('aria-label','实体素材需求');nodeText('h3',null,'实体素材需求',materials);root.append(materials);renderUnifiedModels(materials,entityReviewMaterialModels(ownNeeds,[],data),data)}
  renderEntityRelations(root,data);
  if(data.historicalCall)renderActualGeneration(root,{call:data.historicalCall,inputs:[]});
  if(data.historicalRelation){const old=el('section');nodeText('h3',null,'历史关系',old);reviewTextBlocks(old,data.historicalRelation);root.append(old)}
  const nav=el('section','production-entity-context');nav.setAttribute('aria-label','选择状态');const currentStates=[...new Map((data.currentStates||data.states).filter(r=>productionCompleteState(r)&&r.payload.status!=='withdrawn').map(r=>[r.object_id,r])).values()],historyCount=data.states.filter(r=>!currentStates.some(s=>s.object_id===r.object_id)).length;nodeText('h3','production-entity-title',`实体状态 · ${currentStates.length}`+(historyCount?`（历史保留 ${historyCount}）`:''),nav);const choices=el('div','production-entity-options');
  for(const [index,row] of data.states.entries()){
    const needs=(data.requirements||[]).filter(r=>r.payload.scope.revision_id===row.id),materialCount=entityReviewMaterialModels(needs,entityReviewMaterialItems(data,entityReviewStateMedia(data,row)),data).length,button=productionButton(choices,'',()=>selectEntityReviewState(row));nodeText('span',null,((data.retained_states||[]).some(r=>r.id===row.id)?'历史保留 · ':index===0?'基础状态 · ':'')+businessTitle(row,entityReviewShort(row,entity)),button);button.title=entityReviewShort(row,entity)+' · '+entityReviewScope(row);if(materialCount)nodeText('small',null,materialCount+' 项素材',button);button.setAttribute('aria-pressed',String(row.object_id===form?.object_id));button.dataset.stateId=row.object_id;
  }nav.append(choices);if(data.states.length||!withdrawnEntity)root.append(nav);
  if(form){
    const selectedState=el('section','entity-review-selected-state');selectedState.setAttribute('aria-label','选定状态');root.append(selectedState);
    const heading=el('div','entity-review-local-heading');nodeText('h3',null,businessTitle(form,entityReviewShort(form,entity)),heading);entityVersionControl(heading,form,row=>{state.productionChildDetail=entityReviewDetail(row);data.historicalTarget=row.id===row.current_revision?null:row});selectedState.append(heading);
    const description=el('section','entity-review-description');description.setAttribute('aria-label','实体状态描述');reviewTextBlocks(description,form);entitySources(description,form);selectedState.append(description);
    const materials=el('section','entity-state-materials');materials.setAttribute('aria-label','状态素材');selectedState.append(materials);renderStateMaterials(materials,data,form,!!withdrawals.length);
  }
  if(data.historicalMedia){const original=el('section','entity-review-secondary');original.setAttribute('aria-label','评论对应的素材版本');nodeText('h3',null,'评论对应的素材版本',original);renderEntityReviewMedia(original,[data.historicalMedia],null,'entityReviewHistoricalMedia');root.append(original)}
  const unassigned=entityReviewUnassignedMedia(data);
  if(unassigned.length){const pending=el('details','entity-review-secondary entity-review-unassigned');pending.setAttribute('aria-label',withdrawnEntity?'保留的历史素材':'关联素材');pending.open=!!data.unassignedOpen;nodeText('summary',null,`${withdrawnEntity?'保留素材':'关联素材'} · ${entityReviewMediaCount(unassigned)} 份候选`,pending);const preview=el('section','entity-review-media');pending.append(preview);let loaded=false;const show=()=>{if(!loaded){for(const item of unassigned){for(const related of item.associated_states||[]){const links=el('p','production-meta');materialReferenceLink(links,productionRef(related.entity),businessTitle(related.entity));materialReferenceLink(links,productionRef(related.state),businessTitle(related.state));preview.append(links)}}renderEntityReviewMedia(preview,unassigned,null,'entityReviewUnassignedMedia');loaded=true}};if(pending.open)show();pending.ontoggle=()=>{if(!pending.isConnected||state.entityReview!==data)return;data.unassignedOpen=pending.open;if(pending.open)show()};root.append(pending)}
  if(entity.payload.lyrics?.length){const lyrics=el('section','entity-review-lyrics');nodeText('h3',null,'歌词原文与段落',lyrics);for(const lyric of entity.payload.lyrics){nodeText('h4',null,lyric.section,lyrics);nodeText('p',null,lyric.text,lyrics);productionRefLink(lyrics,lyric.source,'查看歌词依据')}root.append(lyrics)}
  if(data.preparation?.issues.length&&!withdrawnEntity){const issues=el('div','entity-review-generation-issues');nodeText('strong',null,'生成前待完善',issues);for(const issue of data.preparation.issues)nodeText('p',null,issue.message,issues);root.append(issues)}
}
function renderMaterialPlaceholder(parent,need){
  const p=need.payload,type=p.media_type,box=el('div',type==='audio'?'entity-review-missing-audio':'entity-review-missing-image');
  box.dataset.requirementRevision=need.id;box.dataset.mediaType=type;box.append(productionEntityIcon(type));
  const status=p.generation?.method==='reuse'?'复用方案':'未生成';
  box.setAttribute('aria-label',reviewPositionText(p.generation?.output.name||p.title)+' · '+status);nodeText('small',null,(productionMediaLabels[type]||'素材')+' · '+status,box);
  parent.append(box);
}
function entityReviewMaterialItems(data,items){
  return items.map(original=>{
    const record=data.localVersions?.[original.record.object_id]||original.record,component=record.payload.components.find(c=>c.id===original.component_id)||record.payload.components.find(c=>c.role==='original')||record.payload.components[0];
    return {...original,record,component,components:record.payload.components,review_context:data.materialContexts?.[record.id]||(record.id===original.record.id?original.review_context:null),...(record.id!==original.record.id?{crop:null,range:null,placement_requirements:original.record.payload.candidate_requirements||[]}:{})};
  }).filter(i=>i.component);
}
function entityReviewMaterialModels(needs,items,data){
  const card=state.materialCommentCard,rounds=card?.data===data?data.material_versions?.[card.material_id]:null;
  const selected=rounds?.find(round=>round.number===card.number);
  const target=state.productionSelected;
  const owns=selected?.members.some(row=>row.object_id===target?.object_id&&row.id===target.id)&&items.some(item=>rounds.some(round=>round.members.some(row=>row.kind==='ASSET'&&row.object_id===item.record.object_id&&row.id===item.record.id)));
  // Unassigned media can share several real cards. Preserve the already
  // verified card choice without adding cards or changing their membership.
  const modelData=owns?{...data,material_versions:{[card.material_id]:rounds,...Object.fromEntries(Object.entries(data.material_versions).filter(([mid])=>mid!==card.material_id))}}:data;
  // Normal state browsing follows the explicitly shared material. An exact
  // alias URL/comment retains its old material/version numbering and members.
  const associations=new Map(),sharedNeeds=[];
  for(const need of needs){
    const canonical=need.material_identity?.id,exact=card?.data===data&&card.material_id===need.object_id||data.localVersions?.[need.object_id];
    const alias=card?.data===data&&card.material_id!==need.object_id&&need.material_identity?.aliases?.includes(card.material_id)?[(data.requirements||[]).find(r=>r.object_id===card.material_id),...(data.material_versions?.[card.material_id]||[]).flatMap(r=>[r.plan,r.definition_records?.requirement])].find(r=>r?.kind==='REQUIREMENT'&&r.object_id===card.material_id):null;
    const shared=canonical&&[(data.requirements||[]).find(r=>r.object_id===canonical),...(data.material_versions?.[canonical]||[]).flatMap(r=>[r.plan,r.definition_records?.requirement])].find(r=>r?.kind==='REQUIREMENT'&&r.object_id===canonical);
    const current=alias||(!exact&&canonical&&canonical!==need.object_id?shared||need:need);
    if(!associations.has(current.object_id)){associations.set(current.object_id,need);sharedNeeds.push(current)}
  }
  return materialRoundModels(sharedNeeds,items,modelData).map(model=>{
    model.cardCounts=data.material_card_counts?.[materialModelKey(model)];
    model.association_need=associations.get(model.material_id||model.need?.object_id);
    const target=Object.values(data.localVersions||{}).find(row=>row.kind==='ASSET'&&model.round?.members.some(r=>r.id===row.id&&r.object_id===row.object_id));
    if(target)model.candidates=materialExactCandidates({record:target,review_context:data.materialContexts?.[target.id]},model.candidates,target.id,model.round);
    return model;
  });
}
function entityMaterialCandidateOptions(data,model){
  const key=model.material_id||model.need?.object_id||model.candidates[0]?.record.object_id;
  return {multipleCards:true,selectedComponents:data.selectedComponents,selectComponent:id=>{const chosen=materialCandidateChoice(model.candidates,data.selectedCandidates?.[key]);if(!chosen)return;data.selectedComponents||={};data.selectedComponents[chosen.record.id]=id;renderProductionReader();renderComments();document.querySelector(`[data-material-key="${CSS.escape(key)}"] select[aria-label="原件与预览组成"]`)?.focus({preventScroll:true})},selectedCandidateId:data.selectedCandidates?.[key],selectCandidate:id=>{rememberProductionDraft();data.selectedCandidates||={};data.selectedCandidates[key]=id;state.selected=null;const item=model.candidates.find(i=>i.record.id===id);if(item)focusProductionReview(entityReviewDetail(item.record),false);restoreProductionDraft();renderProductionReader();renderComments();document.querySelector(`[data-material-key="${CSS.escape(key)}"] select[aria-label="本轮候选"]`)?.focus({preventScroll:true})}};
}
function renderStateMaterials(parent,data,form,withdrawn=false){
  const needs=(data.requirements||[]).filter(r=>r.payload.scope.object_id===form.object_id&&r.payload.scope.revision_id===form.id).map(r=>data.localVersions?.[r.object_id]||r);
  const items=entityReviewMaterialItems(data,entityReviewStateMedia(data,form));
  if(!needs.length&&!items.length){if(!withdrawn)nodeText('p','production-meta',form.payload.reference_media==='none'?'仅被提及，无需生成素材':form.payload.reference_mode==='description'?'按状态描述随镜头生成':'此状态的素材方案待完善',parent);return}
  if(data.unifiedRight)return renderUnifiedModels(parent,entityReviewMaterialModels(needs,items,data),data);
  const grid=el('section','entity-review-materials');grid.setAttribute('aria-label','此状态的素材与生成方案');
  const change=row=>{data.localVersions||={};data.localVersions[row.object_id]=row};
  for(const model of entityReviewMaterialModels(needs,items,data))renderMaterialCard(grid,model,{...entityMaterialCandidateOptions(data,model),roundChange:number=>{switchMaterialRound(data,model.material_id,number);renderProductionReader();renderComments();focusMaterialRoundControl(model.material_id)},planVersion:(h,row)=>entityVersionControl(h,row,change),assetVersion:(h,item)=>entityVersionControl(h,item.record,change)});
  parent.append(grid);
}
function renderEntityReviewMedia(parent,items,form,selectionKey='entityReviewMedia'){
  const data=state.entityReview;
  if(data.unifiedRight)return renderUnifiedModels(parent,entityReviewMaterialModels([],entityReviewMaterialItems(data,items),data),data);
  const grid=el('section','entity-review-materials');parent.append(grid);
  for(const model of entityReviewMaterialModels([],entityReviewMaterialItems(data,items),data)){
    const card=renderMaterialCard(grid,model,{...entityMaterialCandidateOptions(data,model),roundChange:number=>{switchMaterialRound(data,model.material_id,number);renderProductionReader();renderComments();focusMaterialRoundControl(model.material_id)}});
    if(selectionKey==='entityReviewHistoricalMedia')for(const pane of card.querySelectorAll('.entity-review-media-pane'))pane.dataset.commentMedia='true';
  }
}
function locateEntityReviewComment(comment){
  if(typeof locateMaterialRelationComment==='function'&&locateMaterialRelationComment(comment))return true;
  cancelMaterialCommentLocation();
  const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id);
  const issue=productionCommentLocationIssue(comment,row);if(issue){toast(issue);return false}
  if(typeof rememberProductionDraft==='function')rememberProductionDraft();
  if(!selectCommentMaterialRound(data,row,comment))return false;
  data.historicalTarget=row.id!==row.current_revision?row:null;data.historicalMedia=null;data.historicalCall=null;data.historicalRelation=null;data.unassignedOpen=false;data.localVersions={};
  state.productionEntityDetail=entityReviewDetail(data.entity);
  const currentForm=data.states.find(r=>r.id===state.productionChildDetail?.record.id)||data.states[0];
  state.productionChildDetail=currentForm?entityReviewDetail(currentForm):null;
  if(row.kind==='ENTITY')state.productionEntityDetail=entityReviewDetail(row);
  if(row.kind==='STATE')state.productionChildDetail=entityReviewDetail(row);
  if(row.kind==='REQUIREMENT'){const form=data.states.find(s=>s.object_id===row.payload.scope.object_id);if(form)state.productionChildDetail=entityReviewDetail(form);data.localVersions[row.object_id]=row;data.openRecipe=row.object_id}
  if(row.kind==='ASSET'){
    const componentId=comment.anchor.component_id||comment.anchor.visual_id,candidates=data.media.filter(m=>m.record.id===row.id);
    if(componentId){data.selectedComponents||={};data.selectedComponents[row.id]=componentId}
    data.localVersions[row.object_id]=row;
    const card=state.materialCommentCard;if(card?.data===data)data.unifiedMaterialId=card.material_id;
    const contains=item=>comment.anchor.type!=='time'||!item.range||(item.range.start_seconds<=comment.anchor.start_seconds&&comment.anchor.end_seconds<=item.range.end_seconds);
    const item=candidates.find(m=>(m.state||m.review_state)?.revision_id===currentForm?.id&&contains(m))||candidates.find(contains);
    if(item){
      const scope=item.state||item.review_state;
      let form=scope&&data.states.find(r=>r.id===scope.revision_id&&r.object_id===scope.object_id);
      const retained=item.associated_states?.find(s=>s.state?.id===scope?.revision_id&&s.state.object_id===scope.object_id&&s.state.payload?.entity?.object_id===data.entity.object_id)?.state;
      if(!form&&retained&&!retained.unavailable){data.retained_states||=[];data.retained_states.push(retained);data.states.push(retained);form=retained}
      if(form){state.productionChildDetail=entityReviewDetail(form);state.entityReviewMedia=item.id}
      else if(scope){const component=row.payload.components.find(c=>componentId?c.id===componentId:/^(image|audio|video)\//.test(c.mime));data.historicalMedia={...item,component,component_id:component.id,state:null,review_state:null,range:null,crop:null}}
      else{data.unassignedOpen=true;state.entityReviewUnassignedMedia=item.id}
    }else{
      const component=row.payload.components.find(c=>componentId?c.id===componentId:/^(image|audio|video)\//.test(c.mime));
      if(component)data.historicalMedia={id:'history:'+row.id,label:row.payload.title,record:row,component,component_id:component.id,state:null,role:'related',review_context:data.materialContexts?.[row.id]};
    }
  }
  if(row.kind==='CALL'){
    const item=data.media.find(m=>m.review_context?.call?.id===row.id);const form=item?.state&&data.states.find(s=>s.id===item.state.revision_id);
    if(form){state.productionChildDetail=entityReviewDetail(form);data.historicalTarget=null}else data.historicalCall=row;
  }
  if(row.kind==='RELATION'){data.selectedRelation=row.object_id;if((data.relationships||[]).some(r=>r.object_id===row.object_id))data.localVersions[row.object_id]=row;else data.historicalRelation=row}
  if(row.kind==='REPRESENTATION')data.historicalTarget=row;
  data.selectedCandidates||={};for(const [mid,rounds] of Object.entries(data.material_versions||{})){if(rounds.some(round=>round.members.some(member=>member.id===row.id)))data.selectedCandidates[mid]=row.id}
  state.reviewCommentScope=null;focusProductionReview(entityReviewDetail(row),false);state.selected=comment.id;renderProductionReader();
  // Expand any collapsed exact text before using the common locate behavior.
  for(const node of document.querySelectorAll('#production-blocks [data-block-id]'))if(node.dataset.blockId===comment.anchor.block_id){let parent=node.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement}}
  if(materialPlanCommentNeedsHistory(row,comment))return openMaterialPlanHistory(row,comment).then(()=>true);return locateProductionComment(comment,true)!==false;
}
