/* The settings workspace is a review surface. Content changes use the shared tools. */
const isEntityReview=()=>state.workspace==='settings.workspace'&&!!state.entityReview;
const entityReviewDetail=record=>({record,history:[record],uses:[]});
const entityReviewRows=data=>[data.entity,...data.states,...(data.requirements||[]),...data.media.map(m=>m.record),...(data.comment_records||[])];
const entityReviewStateMedia=(data,form)=>form?data.media.filter(m=>m.state?.object_id===form.object_id&&m.state.revision_id===form.id):[];
const entityReviewUnassignedMedia=data=>data.media.filter(m=>!m.state);
const entityReviewMediaCount=items=>new Set(items.map(m=>m.record.id)).size;
const entityReviewShort=(row,entity)=>row.payload.title.startsWith(entity.payload.title)?row.payload.title.slice(entity.payload.title.length).replace(/^[\s·：:—-]+/u,'')||row.payload.title:row.payload.title;
function entityReviewFocus(row){focusProductionReview(entityReviewDetail(row))}
function entityReviewComments(){const data=state.entityReview,targets=[...data.comment_targets,...(data.historicalTarget?[productionRef(data.historicalTarget)]:[])];return state.comments.filter(c=>targets.some(t=>t.object_id===c.target_object_id&&t.revision_id===c.target_revision_id))}
function entityReviewCommentGroup(comment){const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id),label=row?.kind==='ENTITY'?'实体':row?.kind==='STATE'?'状态 · '+entityReviewShort(row,data.entity):row?.kind==='ASSET'?'素材 · '+row.payload.title:row?.kind==='REQUIREMENT'?'素材方案 · '+row.payload.title:'历史整体意见';return label+(row&&row.id!==row.current_revision?' · 历史版本 '+row.version:'')}
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
  state.entityReview.historicalTarget=null;state.entityReview.historicalMedia=null;state.entityReview.localVersions={};state.entityReview.unassignedOpen=false;state.productionEntityDetail=entityReviewDetail(state.entityReview.entity);
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
  select.onchange=async()=>{const data=state.entityReview,detail=await api('/api/production?'+new URLSearchParams({object_id:row.object_id,revision_id:select.value}));if(state.entityReview!==data)return;data.comment_records.push(detail.record);data.comment_targets.push(productionRef(detail.record));onchange(detail.record);entityReviewFocus(detail.record);renderProductionReader();renderComments()};parent.append(select);
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
function renderEntityReview(root){
  const data=state.entityReview,entity=state.productionEntityDetail.record,form=state.productionChildDetail?.record;
  const header=el('header','entity-review-header'),identity=el('div'),badge=el('small','production-pill production-entity-badge');badge.dataset.entityType=entity.payload.entity_type;badge.append(productionEntityIcon(entity.payload.entity_type));nodeText('span',null,productionLabels[entity.payload.entity_type],badge);identity.append(badge);nodeText('h2',null,entity.payload.title,identity);header.append(identity);
  const actions=el('div','production-toolbar');
  const accept=productionButton(actions,data.accepted?'取消采纳':'采纳',async()=>{
    accept.disabled=true;const action=data.accepted?'revoke':'accept',reason=action==='accept'?'采纳此实体的基础信息、全部完整状态和素材生成方案，允许推进素材生成。':'取消当前采纳，保留历史制作与意见。';
    try{await api('/api/production/entity-decision',{method:'POST',body:JSON.stringify({entity_id:data.entity.object_id,action,expected_version:data.decision_version,scope:data.scope,actor:'用户',reason})});if(state.entityReview===data){await reloadEntityReview();toast(action==='accept'?'已采纳，可推进素材生成':'已取消采纳')}}
    catch(error){if(state.entityReview===data)await reloadEntityReview();throw error}
  });accept.classList.add('entity-review-accept');accept.title='采纳基础信息、全部完整状态及素材生成方案，允许推进素材生成；仍可评论。';accept.disabled=(!data.can_accept&&!data.can_revoke)||!!data.historicalTarget||!!data.localVersions&&Object.values(data.localVersions).some(r=>r.id!==r.current_revision);
  if(data.accepted)nodeText('span','production-pill','已采纳',actions);
  if(data.history.length){const more=el('details','entity-review-more');nodeText('summary',null,'更多',more);for(const item of data.history)productionButton(more,`${item.verdict==='revoked'?'取消采纳':'采纳'} · ${new Date(item.created_at).toLocaleString('zh-CN')}`,()=>reloadEntityReview(item.revision_id));actions.append(more)}
  header.append(actions);root.append(header);
  if(data.historicalTarget||data.historical){const warning=el('div','entity-review-notice');nodeText('span',null,data.historical?'历史采纳范围':'历史内容',warning);productionButton(warning,'返回当前版本',()=>reloadEntityReview());root.append(warning)}
  if(data.historicalTarget?.kind==='REPRESENTATION'){const old=el('section');nodeText('h3',null,'历史关联说明',old);reviewTextBlocks(old,data.historicalTarget);root.append(old)}
  const basics=el('section','entity-review-basics');basics.setAttribute('aria-label','实体基础信息');const basicHeading=el('div','entity-review-local-heading');nodeText('h3',null,'基础信息',basicHeading);entityVersionControl(basicHeading,entity,row=>{state.productionEntityDetail=entityReviewDetail(row);data.historicalTarget=row.id===row.current_revision?null:row});basics.append(basicHeading);
  if(entity.payload.aliases?.length)nodeText('p','production-meta','别名：'+entity.payload.aliases.join('、'),basics);reviewTextBlocks(basics,entity);entitySources(basics,entity);root.append(basics);
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
  const p=need.payload,audio=p.media_type==='audio',box=el('div',audio?'entity-review-missing-audio':'entity-review-missing-image');
  box.append(productionEntityIcon(audio?'song':state.productionEntityDetail.record.payload.entity_type));box.setAttribute('aria-label',(p.generation?.output.name||p.title)+' · 未生成');nodeText('small',null,'未生成',box);
  if(!audio){const ratio=p.generation?.parameters?.aspect_ratio||'16:9';box.style.aspectRatio=ratio.replace(':',' / ')}parent.append(box);
}
function renderGenerationRecipe(parent,current,missing=false){
  const data=state.entityReview,need=data.localVersions?.[current.object_id]||current,p=need.payload,plan=p.generation,box=el('article','entity-review-recipe');box.dataset.requirementId=need.object_id;
  const heading=el('div','entity-review-local-heading');nodeText('h4',null,plan?.output.name||p.title,heading);entityVersionControl(heading,need,row=>{data.localVersions||={};data.localVersions[row.object_id]=row});box.append(heading);
  if(missing)renderMaterialPlaceholder(box,need);
  if(need.id!==need.current_revision)nodeText('small','production-pill','历史方案',box);
  if(!plan){nodeText('p','production-issue','生成方案待完善',box);parent.append(box);return}
  const text=reviewTextBlocks(box,need);const blocks=productionTextBlocks(need),field=(parent,name,label,tag='p')=>{const block=blocks.find(b=>b.field===name);if(!block)return;if(label)nodeText('h4',null,label,parent);const para=nodeText(tag,null,block.text,parent);para.dataset.blockId=block.id;return para};
  field(text,'generation.output.description',null);
  const specs=el('p','production-meta');specs.textContent=`${p.media_type==='audio'?'声音':'图像'} · ${plan.method==='reuse'?'复用已选原件':'生成'} · ${plan.model}`;box.append(specs);
  const detail=el('details','entity-review-generation-details');nodeText('summary',null,'模型、参数、提示词与参考输入',detail);text.append(detail);
  field(detail,'generation.tool','工具');field(detail,'generation.model','模型');field(detail,'generation.parameters','配置参数','pre');field(detail,'generation.prompt','提示词','pre');
  if(plan.inputs.length){nodeText('h4',null,'参考输入',detail);for(const [index,input] of plan.inputs.entries()){productionRefLink(detail,input.reference,(input.reference.object_id.startsWith('need-')?'待采用输出 · ':'准确素材 · ')+productionName(input.reference));field(detail,`generation.inputs.${index}.use`,null);if(input.component_id)nodeText('small','production-meta',input.component_id+(input.range?` · ${input.range.start_seconds}–${input.range.end_seconds} 秒`:''),detail)}}else nodeText('p',null,'文字生成，无参考文件',detail);
  field(detail,'generation.output.review_criteria','检查要点');
  if(plan.blockers?.length){const blocked=el('div','entity-review-generation-issues');for(const issue of plan.blockers)nodeText('p',null,issue,blocked);detail.append(blocked)}
  if(need.id===need.current_revision){const button=productionButton(detail,'检查生成输入',async()=>{const ready=await api('/api/production/generation-ready?requirement_id='+encodeURIComponent(need.object_id));result.replaceChildren();if(ready.ready){nodeText('p',null,'生成输入已齐备',result);const a=link('下载生成清单','/api/production/generation-package?requirement_id='+encodeURIComponent(need.object_id),result);a.download=need.object_id+'.json'}else for(const issue of ready.issues)nodeText('p',null,issue,result)});button.title='检查有效采纳和准确参考文件';const result=el('div','production-meta');detail.append(result)}
  if(data.openRecipe===need.object_id)detail.open=true;detail.ontoggle=()=>{if(detail.open)data.openRecipe=need.object_id;else if(data.openRecipe===need.object_id)data.openRecipe=null};parent.append(box);
}
function renderStateMaterials(parent,data,form){
  const needs=(data.requirements||[]).filter(r=>r.payload.scope.object_id===form.object_id&&r.payload.scope.revision_id===form.id),items=entityReviewStateMedia(data,form),groups=el('section','entity-review-materials');groups.setAttribute('aria-label','此状态的素材与生成方案');
  if(!needs.length&&!items.length){nodeText('p','production-meta',form.payload.reference_media==='none'?'仅被提及，无需生成素材':'此状态的素材方案待完善',parent);return}
  for(const type of ['image','audio','video']){
    const typed=needs.filter(r=>r.payload.media_type===type).sort((a,b)=>(a.payload.slot==='overall'?-2:a.payload.slot==='voice'?-1:0)-(b.payload.slot==='overall'?-2:b.payload.slot==='voice'?-1:0)),media=items.filter(m=>m.component.mime.startsWith(type+'/'));if(!typed.length&&!media.length)continue;
    const group=el('div','entity-review-material-group');nodeText('h3',null,({image:'图像',audio:'声音',video:'视频'})[type],group);
    if(media.length)renderEntityReviewMedia(group,media,form);
    for(const need of typed){const linked=media.some(m=>(m.record.payload.candidate_requirements||[]).some(r=>r.object_id===need.object_id&&r.revision_id===need.id));renderGenerationRecipe(group,need,!linked)}groups.append(group);
  }parent.append(groups);
}
function renderEntityReviewMedia(parent,items,form,selectionKey='entityReviewMedia'){
  for(const original of items){
    const data=state.entityReview,selected=data.localVersions?.[original.record.object_id],record=selected||original.record,component=selected?record.payload.components.find(c=>c.id===original.component.id):original.component;if(!component)continue;
    const current=selected?{...original,record,component,...(selected.id!==original.record.id?{range:null,crop:null}:{})}:original;
    const heading=el('div','entity-review-local-heading');nodeText('h4',null,current.label,heading);entityVersionControl(heading,record,row=>{data.localVersions||={};data.localVersions[row.object_id]=row});parent.append(heading);
    if(record.id!==record.current_revision)nodeText('small','production-pill','历史素材',parent);
    const pane=el('div','entity-review-media-pane');pane.dataset.reviewRevision=record.id;if(selectionKey==='entityReviewHistoricalMedia')pane.dataset.commentMedia='true';
    pane.addEventListener('pointerdown',()=>entityReviewFocus(record),true);pane.addEventListener('focusin',()=>entityReviewFocus(record),true);
    if(component.mime.startsWith('image/')){pane.append(renderStructureVisual({...component,title:current.label,alt:current.label,description:`${component.width} × ${component.height}`},true));if(current.crop)pane.querySelector('.structure-visual-stage').dataset.reviewCrop=JSON.stringify(current.crop)}
    else reviewMediaPlayer(pane,component,record,current);
    link('下载原文件','/api/production/files/'+encodeURIComponent(component.file),pane);parent.append(pane);
  }
}
function locateEntityReviewComment(comment){
  const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id);if(!row)return;
  data.historicalTarget=row.id!==row.current_revision?row:null;data.historicalMedia=null;data.unassignedOpen=false;data.localVersions={};
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
      if(component)data.historicalMedia={id:'history:'+row.id,label:row.payload.title,record:row,component,component_id:component.id,state:null,role:'related'};
    }
  }
  if(row.kind==='REPRESENTATION')data.historicalTarget=row;
  focusProductionReview(entityReviewDetail(row),false);state.selected=comment.id;renderProductionReader();
  // Expand any collapsed exact text before using the common locate behavior.
  for(const node of document.querySelectorAll('#production-blocks [data-block-id]'))if(node.dataset.blockId===comment.anchor.block_id){let parent=node.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement}}
  locateProductionComment(comment,true);
}
