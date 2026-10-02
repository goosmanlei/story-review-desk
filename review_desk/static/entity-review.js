/* The settings workspace is a review surface. Content changes use the shared tools. */
const isEntityReview=()=>state.workspace==='settings.workspace'&&!!state.entityReview;
const entityReviewDetail=record=>({record,history:[record],uses:[]});
const entityReviewRows=data=>[data.entity,...data.states,...(data.requirements||[]),...(data.relationships||[]),...data.media.map(m=>m.record),...(data.comment_records||[])];
const entityReviewStateMedia=(data,form)=>form?data.media.filter(m=>m.state?.object_id===form.object_id&&m.state.revision_id===form.id):[];
const entityReviewUnassignedMedia=data=>data.media.filter(m=>!m.state);
const entityReviewMediaCount=items=>new Set(items.map(m=>m.record.id)).size;
const entityReviewShort=(row,entity)=>row.payload.title.startsWith(entity.payload.title)?row.payload.title.slice(entity.payload.title.length).replace(/^[\s·：:—-]+/u,'')||row.payload.title:row.payload.title;
function entityReviewFocus(row){focusProductionReview(entityReviewDetail(row))}
function entityReviewComments(){const data=state.entityReview,targets=[...data.comment_targets,...(data.historicalTarget?[productionRef(data.historicalTarget)]:[])];return state.comments.filter(c=>targets.some(t=>t.object_id===c.target_object_id&&t.revision_id===c.target_revision_id))}
function entityReviewCommentGroup(comment){const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id),label=row?.kind==='ENTITY'?'实体':row?.kind==='STATE'?'状态 · '+entityReviewShort(row,data.entity):row?.kind==='ASSET'?'素材 · '+row.payload.title:row?.kind==='REQUIREMENT'?'素材方案 · '+row.payload.title:row?.kind==='RELATION'?'关系 · '+row.payload.title:row?.kind==='CALL'?'实际生成 · '+row.payload.title:'历史整体意见';return label+(row&&row.id!==row.current_revision?' · 历史版本 '+row.version:'')}
function appendEntityReviewComments(parent,comments){
  const groups=new Map();for(const comment of comments){const key=entityReviewCommentGroup(comment);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(comment)}
  for(const [label,rows] of groups){nodeText('h4','entity-review-comment-group',`${label} · ${rows.length}`,parent);for(const row of rows)parent.append(commentCard(row))}
}
async function openEntityReview(owner,detail,epoch,exactRevision){
  const url=new URL(location.href),same=state.productionEntityId===owner||url.searchParams.get('production_entity')===owner;
  const reviewRevision=same?url.searchParams.get('entity_acceptance'):null;
  const query=new URLSearchParams({entity_id:owner,...(reviewRevision?{revision_id:reviewRevision}:{})});
  const data=await api('/api/production/entity-review?'+query);
  if(epoch!==productionReadEpoch||state.workspace!=='settings.workspace')return;
  const rows=[data.entity,...data.states],match=rows.find(r=>r.id===detail.record.id);
  data.historicalTarget=exactRevision&&!match&&['ENTITY','STATE'].includes(detail.record.kind)?detail.record:null;
  data.states.sort(productionStateOrder);
  const remembered=same?data.states.find(r=>r.object_id===url.searchParams.get('entity_state')):null;
  const form=detail.record.kind==='STATE'?(match||(exactRevision?detail.record:data.states.find(r=>r.object_id===detail.record.object_id)||data.states[0])):remembered||data.states[0]||null;
  state.entityReview=data;state.productionEntityId=owner;
  state.productionEntityDetail=entityReviewDetail(data.historicalTarget?.kind==='ENTITY'?data.historicalTarget:data.entity);
  state.productionChildDetail=form?entityReviewDetail(form):null;state.entityReviewMedia=null;state.entityReviewUnassignedMedia=null;
  // Current browsing follows live content; only a deliberate historical link
  // keeps an acceptance revision. Legacy workflow URLs return to the entity.
  url.searchParams.delete('entity_submission');
  if(!reviewRevision)url.searchParams.delete('entity_acceptance');
  url.searchParams.set('production_entity',owner);if(form)url.searchParams.set('entity_state',form.object_id);history.replaceState(null,'',url);
  focusProductionReview(entityReviewDetail(exactRevision&&detail.record.kind==='ENTITY'?state.productionEntityDetail.record:form||data.entity),false);
  for(const button of document.querySelectorAll('#production-index button'))button.classList.toggle('active',button.dataset.objectId===owner);
  renderProductionReader();renderComments();
}
async function reloadEntityReview(revision=null){
  const data=state.entityReview,form=state.productionChildDetail?.record;
  const url=new URL(location.href);url.searchParams.delete('entity_submission');url.searchParams.delete('entity_acceptance');if(revision)url.searchParams.set('entity_acceptance',revision);history.replaceState(null,'',url);
  await openEntityReview(data.entity.object_id,entityReviewDetail(revision?data.entity:form||data.entity),++productionReadEpoch,null);
}
function selectEntityReviewState(row){
  state.entityReview.historicalTarget=null;state.entityReview.historicalMedia=null;state.entityReview.historicalCall=null;state.entityReview.historicalRelation=null;state.entityReview.localVersions={};state.entityReview.unassignedOpen=false;state.productionEntityDetail=entityReviewDetail(state.entityReview.entity);
  state.productionChildDetail=entityReviewDetail(row);state.entityReviewMedia=null;
  focusProductionReview(state.productionChildDetail,false);renderProductionReader();renderComments();
}
function entityReviewScope(row){
  const scenes=[...new Map((state.entityReview.usages[row.id]||[]).filter(u=>u.kind==='PREPARATION').map(u=>[u.source.object_id+u.source.scene_id,u.source])).values()];
  if(!scenes.length)return row.payload.reference_media==='none'?'仅被提及':'尚未关联实际出场';
  const sceneName=ref=>{const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.object_id===ref.object_id&&e.id===ref.revision_id);return `${(ep?.payload.number||ep?.payload.episode_number)?'第'+(ep.payload.number||ep.payload.episode_number)+'集 · ':''}${ref.scene_id}`};
  return scenes.length===1?sceneName(scenes[0]):`${sceneName(scenes[0])} 至 ${sceneName(scenes.at(-1))} · ${scenes.length} 场`;
}
function entityVersionControl(parent,row,onchange){
  const versions=state.entityReview.versions?.[row.object_id]||[];if(versions.length<2)return;
  const select=el('select','entity-review-version');select.setAttribute('aria-label',row.payload.title+'的版本');
  for(const v of versions)select.append(new Option(`版本 ${v.version}${v.id===row.current_revision?' · 当前':''}`,v.id));select.value=row.id;
  select.onchange=async()=>{const data=state.entityReview,detail=await api('/api/production?'+new URLSearchParams({object_id:row.object_id,revision_id:select.value}));if(state.entityReview!==data)return;data.comment_records.push(detail.record);data.comment_targets.push(productionRef(detail.record));if(detail.review_context){data.materialContexts||={};data.materialContexts[detail.record.id]=detail.review_context;for(const row of [detail.review_context.call,...detail.review_context.requirements].filter(Boolean)){data.comment_records.push(row);data.comment_targets.push(productionRef(row))}}onchange(detail.record);entityReviewFocus(detail.record);renderProductionReader();renderComments()};parent.append(select);
}
function entitySources(parent,row){
  const sources=el('div','entity-review-sources'),unique=new Map();
  for(const source of row.payload.sources||[]){const key=source.revision_id+source.scene_id;if(!unique.has(key))unique.set(key,{...source,block_ids:[]});unique.get(key).block_ids.push(...source.block_ids)}
  if(unique.size){const detail=el('details');nodeText('summary',null,`剧情依据 · ${unique.size} 场`,detail);for(const source of unique.values()){source.block_ids=[...new Set(source.block_ids)].sort();productionRefLink(detail,source,source.scene_id||'正文')}sources.append(detail)}
  const uses=(state.entityReview.usages[row.id]||[]).filter(u=>u.kind==='SHOT_DESIGN');if(uses.length){const detail=el('details');nodeText('summary',null,`关联镜头 · ${uses.length} 镜`,detail);for(const use of uses)productionRefLink(detail,use,use.title);sources.append(detail)}
  if(sources.childNodes.length)parent.append(sources);
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
    !!form&&!data.states.some(row=>row.object_id===form.object_id&&row.id===form.id)||
    Object.values(data.localVersions||{}).some(row=>row.id!==row.current_revision);
}
function renderEntityReview(root){
  const data=state.entityReview,entity=state.productionEntityDetail.record,form=state.productionChildDetail?.record;
  const viewingHistory=entityReviewHasHistoricalContent(data,entity,form);
  const header=el('header','entity-review-header'),identity=el('div'),badge=el('small','production-pill production-entity-badge');badge.dataset.entityType=entity.payload.entity_type;badge.append(productionEntityIcon(entity.payload.entity_type));nodeText('span',null,productionLabels[entity.payload.entity_type],badge);identity.append(badge);nodeText('h2',null,entity.payload.title,identity);header.append(identity);
  const actions=el('div','production-toolbar');
  const accept=productionButton(actions,data.can_revoke?'取消采纳':'采纳',async()=>{
    accept.disabled=true;const action=data.can_revoke?'revoke':'accept',reason=action==='accept'?(data.acceptance_mode==='content'?'重新认可原基础信息、完整状态与关联素材；不授予生成许可。':'采纳此实体的基础信息、关系、全部完整状态和素材生成方案，允许推进素材生成。'):'取消当前采纳，保留历史制作与意见。';
    try{await api('/api/production/entity-decision',{method:'POST',body:JSON.stringify({entity_id:data.entity.object_id,action,decision_ref:data.revoke_target,expected_version:data.decision_version,scope:data.decision_scope||data.scope,acceptance_mode:data.acceptance_mode,actor:'用户',reason})});if(state.entityReview===data){await reloadEntityReview();toast(action==='accept'?(data.acceptance_mode==='content'?'已重新认可原内容，生成方案仍待完善':'已采纳，可推进素材生成'):'已取消采纳')}}
    catch(error){if(state.entityReview===data)await reloadEntityReview();throw error}
  });accept.classList.add('entity-review-accept');accept.title=data.acceptance_mode==='content'?'重新认可原基础信息、完整状态与关联素材；生成方案仍需单独完善和认可。':'采纳基础信息、关系、全部完整状态及素材生成方案，允许推进素材生成；仍可评论。';accept.disabled=(!data.can_accept&&!data.can_revoke)||viewingHistory;
  header.append(actions);root.append(header);if(data.acceptance_mode==='content')nodeText('p','production-meta','此操作认可原基础信息、完整状态和关联素材；生成方案完善并获认可后才可推进生成。',root);
  if(data.historicalTarget?.kind==='REPRESENTATION'){const old=el('section');nodeText('h3',null,'历史关联说明',old);reviewTextBlocks(old,data.historicalTarget);root.append(old)}
  const basics=el('section','entity-review-basics');basics.setAttribute('aria-label','实体基础信息');const basicHeading=el('div','entity-review-local-heading');nodeText('h3',null,'基础信息',basicHeading);entityVersionControl(basicHeading,entity,row=>{state.productionEntityDetail=entityReviewDetail(row);data.historicalTarget=row.id===row.current_revision?null:row});basics.append(basicHeading);
  if(entity.payload.aliases?.length)nodeText('p','production-meta','别名：'+entity.payload.aliases.join('、'),basics);reviewTextBlocks(basics,entity);entitySources(basics,entity);root.append(basics);
  renderEntityRelations(root,data);
  if(data.historicalCall)renderActualGeneration(root,{call:data.historicalCall,inputs:[]});
  if(data.historicalRelation){const old=el('section');nodeText('h3',null,'历史关系',old);reviewTextBlocks(old,data.historicalRelation);root.append(old)}
  const nav=el('section','production-entity-context');nav.setAttribute('aria-label','选择完整状态');nodeText('h3','production-entity-title',`完整状态 · ${data.states.length}`,nav);const choices=el('div','production-entity-options');
  for(const [index,row] of data.states.entries()){
    const needs=(data.requirements||[]).filter(r=>r.payload.scope.revision_id===row.id),button=productionButton(choices,'',()=>selectEntityReviewState(row));nodeText('span',null,(index===0?'基础状态 · ':'')+entityReviewShort(row,entity),button);nodeText('small',null,`${entityReviewScope(row)}${needs.length?' · '+needs.length+' 项素材':''}`,button);button.setAttribute('aria-pressed',String(row.object_id===form?.object_id));button.dataset.stateId=row.object_id;
  }nav.append(choices);root.append(nav);
  if(form){
    const heading=el('div','entity-review-local-heading');nodeText('h3',null,entityReviewShort(form,entity),heading);entityVersionControl(heading,form,row=>{state.productionChildDetail=entityReviewDetail(row);data.historicalTarget=row.id===row.current_revision?null:row});root.append(heading);
    const description=el('section','entity-review-description');description.setAttribute('aria-label','完整状态描述');reviewTextBlocks(description,form);entitySources(description,form);root.append(description);
    renderStateMaterials(root,data,form);
  }
  if(data.historicalMedia){const original=el('section','entity-review-secondary');original.setAttribute('aria-label','评论对应的素材版本');nodeText('h3',null,'评论对应的素材版本',original);renderEntityReviewMedia(original,[data.historicalMedia],null,'entityReviewHistoricalMedia');root.append(original)}
  const unassigned=entityReviewUnassignedMedia(data);
  if(unassigned.length){const pending=el('details','entity-review-secondary entity-review-unassigned');pending.setAttribute('aria-label','待关联状态的素材');pending.open=!!data.unassignedOpen;nodeText('summary',null,`待关联状态 · ${entityReviewMediaCount(unassigned)} 份候选`,pending);const preview=el('section','entity-review-media');pending.append(preview);let loaded=false;const show=()=>{if(!loaded){renderEntityReviewMedia(preview,unassigned,null,'entityReviewUnassignedMedia');loaded=true}};if(pending.open)show();pending.ontoggle=()=>{data.unassignedOpen=pending.open;if(pending.open)show()};root.append(pending)}
  if(entity.payload.lyrics?.length){const lyrics=el('section','entity-review-lyrics');nodeText('h3',null,'歌词原文与段落',lyrics);for(const lyric of entity.payload.lyrics){nodeText('h4',null,lyric.section,lyrics);nodeText('p',null,lyric.text,lyrics);productionRefLink(lyrics,lyric.source,'查看歌词依据')}root.append(lyrics)}
  if(data.preparation?.issues.length){const issues=el('div','entity-review-generation-issues');nodeText('strong',null,'采纳前待完善',issues);for(const issue of data.preparation.issues)nodeText('p',null,issue.message,issues);root.append(issues)}
}
function renderMaterialPlaceholder(parent,need){
  const p=need.payload,type=p.media_type,box=el('div',type==='audio'?'entity-review-missing-audio':'entity-review-missing-image');
  box.dataset.requirementRevision=need.id;box.dataset.mediaType=type;box.append(productionEntityIcon(type));
  box.setAttribute('aria-label',(p.generation?.output.name||p.title)+' · 未生成');nodeText('small',null,(productionMediaLabels[type]||'素材')+' · 未生成',box);
  if(type==='image'||type==='video'){const ratio=p.generation?.parameters?.aspect_ratio||'16:9';box.style.aspectRatio=ratio.replace(':',' / ')}parent.append(box);
}
function renderStateMaterials(parent,data,form){
  const needs=(data.requirements||[]).filter(r=>r.payload.scope.object_id===form.object_id&&r.payload.scope.revision_id===form.id).map(r=>data.localVersions?.[r.object_id]||r);
  const items=entityReviewStateMedia(data,form).map(original=>{
    const record=data.localVersions?.[original.record.object_id]||original.record,component=record.payload.components.find(c=>c.id===original.component_id)||record.payload.components.find(c=>c.role==='original')||record.payload.components[0];
    return {...original,record,component,review_context:data.materialContexts?.[record.id]||(record.id===original.record.id?original.review_context:null),...(record.id!==original.record.id?{crop:null,range:null,placement_requirements:original.record.payload.candidate_requirements||[]}:{})};
  }).filter(i=>i.component);
  if(!needs.length&&!items.length){nodeText('p','production-meta',form.payload.reference_media==='none'?'仅被提及，无需生成素材':form.payload.reference_mode==='description'?'按状态描述随镜头生成':'此状态的素材方案待完善',parent);return}
  const grid=el('section','entity-review-materials');grid.setAttribute('aria-label','此状态的素材与生成方案');
  const change=row=>{data.localVersions||={};data.localVersions[row.object_id]=row};
  for(const model of materialCardModels(needs,items))renderMaterialCard(grid,model,{planVersion:(h,row)=>entityVersionControl(h,row,change),assetVersion:(h,item)=>entityVersionControl(h,item.record,change)});
  parent.append(grid);
}
function renderEntityReviewMedia(parent,items,form,selectionKey='entityReviewMedia'){
  const grid=el('section','entity-review-materials');parent.append(grid);
  for(const item of items){const card=renderMaterialCard(grid,{need:null,candidates:[item]});if(selectionKey==='entityReviewHistoricalMedia')card.querySelector('.entity-review-media-pane').dataset.commentMedia='true'}
}
function locateEntityReviewComment(comment){
  const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id);if(!row)return;
  data.historicalTarget=row.id!==row.current_revision?row:null;data.historicalMedia=null;data.historicalCall=null;data.historicalRelation=null;data.unassignedOpen=false;data.localVersions={};
  state.productionEntityDetail=entityReviewDetail(data.entity);
  const currentForm=data.states.find(r=>r.object_id===state.productionChildDetail?.record.object_id)||data.states[0];
  state.productionChildDetail=currentForm?entityReviewDetail(currentForm):null;
  if(row.kind==='ENTITY')state.productionEntityDetail=entityReviewDetail(row);
  if(row.kind==='STATE')state.productionChildDetail=entityReviewDetail(row);
  if(row.kind==='REQUIREMENT'){const form=data.states.find(s=>s.object_id===row.payload.scope.object_id);if(form)state.productionChildDetail=entityReviewDetail(form);data.localVersions[row.object_id]=row;data.openRecipe=row.object_id}
  if(row.kind==='ASSET'){
    const componentId=comment.anchor.component_id||comment.anchor.visual_id,candidates=data.media.filter(m=>m.record.id===row.id&&(!componentId||m.component_id===componentId));
    const contains=item=>comment.anchor.type!=='time'||!item.range||(item.range.start_seconds<=comment.anchor.start_seconds&&comment.anchor.end_seconds<=item.range.end_seconds);
    const item=candidates.find(m=>m.state?.revision_id===currentForm?.id&&contains(m))||candidates.find(contains);
    if(item){
      const form=item.state&&data.states.find(r=>r.id===item.state.revision_id&&r.object_id===item.state.object_id);
      if(form){state.productionChildDetail=entityReviewDetail(form);state.entityReviewMedia=item.id}
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
  focusProductionReview(entityReviewDetail(row),false);state.selected=comment.id;renderProductionReader();
  // Expand any collapsed exact text before using the common locate behavior.
  for(const node of document.querySelectorAll('#production-blocks [data-block-id]'))if(node.dataset.blockId===comment.anchor.block_id){let parent=node.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement}}
  locateProductionComment(comment,true);
}
