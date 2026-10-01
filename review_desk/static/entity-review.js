/* The settings workspace is a review surface. Content changes use the shared tools. */
const isEntityReview=()=>state.workspace==='settings.workspace'&&!!state.entityReview;
const entityReviewDetail=record=>({record,history:[record],uses:[]});
const entityReviewRows=data=>[data.entity,...data.states,...data.media.map(m=>m.record),...(data.submission?[data.submission]:[])];
const entityReviewShort=(row,entity)=>row.payload.title.startsWith(entity.payload.title)?row.payload.title.slice(entity.payload.title.length).replace(/^[\s·：:—-]+/u,'')||row.payload.title:row.payload.title;
function entityReviewFocus(row){focusProductionReview(entityReviewDetail(row))}
function entityReviewComments(){const data=state.entityReview,targets=[...data.comment_targets,...(data.historicalTarget?[productionRef(data.historicalTarget)]:[])];return state.comments.filter(c=>targets.some(t=>t.object_id===c.target_object_id&&t.revision_id===c.target_revision_id))}
function entityReviewCommentGroup(comment){const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id);return row?.kind==='ENTITY'?'实体基础信息':row?.kind==='STATE'?'状态 · '+entityReviewShort(row,data.entity):row?.kind==='ASSET'?'素材 · '+row.payload.title:'整个实体'}
function appendEntityReviewComments(parent,comments){
  const groups=new Map();for(const comment of comments){const key=entityReviewCommentGroup(comment);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(comment)}
  for(const [label,rows] of groups){nodeText('h4','entity-review-comment-group',`${label} · ${rows.length}`,parent);for(const row of rows)parent.append(commentCard(row))}
}
async function openEntityReview(owner,detail,epoch,exactRevision){
  const url=new URL(location.href),same=state.productionEntityId===owner||url.searchParams.get('production_entity')===owner;
  const reviewRevision=detail.record.payload.review_model==='entity-review-v1'?detail.record.id:same?url.searchParams.get('entity_submission'):null;
  const query=new URLSearchParams({entity_id:owner,...(reviewRevision?{revision_id:reviewRevision}:{})});
  const data=await api('/api/production/entity-review?'+query);
  if(epoch!==productionReadEpoch||state.workspace!=='settings.workspace')return;
  const rows=entityReviewRows(data),match=rows.find(r=>r.id===detail.record.id);
  data.historicalTarget=exactRevision&&!match&&['ENTITY','STATE'].includes(detail.record.kind)?detail.record:null;
  data.states.sort(productionStateOrder);
  const form=detail.record.kind==='STATE'?(match||(exactRevision?detail.record:data.states.find(r=>r.object_id===detail.record.object_id)||data.states[0])):data.states[0]||null;
  state.entityReview=data;state.productionEntityId=owner;
  state.productionEntityDetail=entityReviewDetail(data.historicalTarget?.kind==='ENTITY'?data.historicalTarget:data.entity);
  state.productionChildDetail=form?entityReviewDetail(form):null;state.entityReviewMedia=null;
  // Preserve the submitted snapshot in the URL independently of the comment target.
  if(data.submission)url.searchParams.set('entity_submission',data.submission.id);else url.searchParams.delete('entity_submission');
  url.searchParams.set('production_entity',owner);history.replaceState(null,'',url);
  focusProductionReview(entityReviewDetail(exactRevision&&detail.record.kind==='ENTITY'?state.productionEntityDetail.record:form||data.entity),false);
  for(const button of document.querySelectorAll('#production-index button'))button.classList.toggle('active',button.dataset.objectId===owner);
  renderProductionReader();renderComments();
}
async function reloadEntityReview(revision=null){
  const data=state.entityReview,form=state.productionChildDetail?.record;
  const url=new URL(location.href);url.searchParams.delete('entity_submission');if(revision)url.searchParams.set('entity_submission',revision);history.replaceState(null,'',url);
  await openEntityReview(data.entity.object_id,entityReviewDetail(revision?data.entity:form||data.entity),++productionReadEpoch,null);
}
function selectEntityReviewState(row){
  state.productionChildDetail=entityReviewDetail(row);state.entityReviewMedia=null;
  focusProductionReview(state.productionChildDetail,false);renderProductionReader();renderComments();
}
function entityReviewScope(row){
  const scenes=[...new Map((state.entityReview.usages[row.id]||[]).filter(u=>u.kind==='PREPARATION').map(u=>[u.source.object_id+u.source.scene_id,u.source])).values()];
  if(!scenes.length)return row.payload.reference_media==='none'?'仅被提及':'尚未关联实际出场';
  const sceneName=ref=>{const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.object_id===ref.object_id&&e.id===ref.revision_id);return `${(ep?.payload.number||ep?.payload.episode_number)?'第'+(ep.payload.number||ep.payload.episode_number)+'集 · ':''}${ref.scene_id}`};
  return scenes.length===1?sceneName(scenes[0]):`${sceneName(scenes[0])} 至 ${sceneName(scenes.at(-1))} · ${scenes.length} 场`;
}
function reviewTextBlocks(parent,row,{compact=false}={}){
  const host=el('div','entity-review-text');host.dataset.productionBlocks=row.id;if(state.productionSelected?.id===row.id)host.id='production-blocks';
  host.onpointerdown=()=>entityReviewFocus(row);host.onfocusin=()=>entityReviewFocus(row);
  const deferred=[];
  for(const block of row.payload.blocks){
    let offset=0;
    for(const line of block.text.split('\n')){
      const para=el('p',null,line);para.dataset.blockId=block.id;para.dataset.anchorOffset=offset;
      // Collapse only generic uncertainty wording; concrete uncertain observations stay visible.
      const boilerplate=compact&&/^(服装：除上述明确服装外|伤势：除上述明示体征外|健康：本阶段健康细节未明确|疲劳：本阶段未明确持续疲劳|随身物：随身及手持物以本场)/u.test(line);
      if(boilerplate)deferred.push(para);else host.append(para);
      offset+=Array.from(line).length+1;
    }
  }
  if(deferred.length){const details=el('details','entity-review-secondary');nodeText('summary',null,`其他完整状态说明与未明确事项 · ${deferred.length} 项`,details);for(const para of deferred)details.append(para);host.append(details)}
  parent.append(host);
}
function reviewNotes(parent,row){
  const body=row.payload.blocks.map(b=>b.text).join('\n'),seen=new Set();
  for(const [key,label] of [['facts','剧本事实'],['choices','制作选择'],['unknowns','待确认']]){
    const values=(row.payload[key]||[]).filter(value=>{if(typeof value!=='string'||body.includes(value)||seen.has(value))return false;seen.add(value);return true});
    if(values.length){const section=key==='unknowns'?el('details','entity-review-secondary'):el('section','entity-review-notes');nodeText(key==='unknowns'?'summary':'h4',null,label,section);for(const value of values)nodeText('p',null,value,section);parent.append(section)}
  }
}
function renderEntityReview(root){
  const data=state.entityReview,entity=state.productionEntityDetail.record,form=state.productionChildDetail?.record;
  const header=el('header','entity-review-header'),identity=el('div');nodeText('small','production-pill',productionLabels[entity.payload.entity_type],identity);nodeText('h2',null,entity.payload.title,identity);
  const status=data.accepted&&data.issues.length?(data.issues.some(i=>i.code==='historical_submission')?'历史送审 · 已认可':'此前已认可 · 内容已变化'):{not_submitted:'尚未送审',outdated:'内容已变化 · 待重新送审',accepted:'已认可',pending:'待认可'}[data.status];
  nodeText('p','entity-review-status',`${data.submission?'送审版本 '+data.submission.version:'基础信息版本 '+entity.version} · ${status}`,identity);header.append(identity);
  const actions=el('div','production-toolbar');const comments=productionButton(actions,'',openPanel);comments.dataset.entityReviewCount='true';
  productionButton(actions,'评论整个实体',()=>{entityReviewFocus(data.submission||entity);startDraft({type:'global'})});
  const accept=productionButton(actions,data.accepted?'已认可整个实体':'认可整个实体',async()=>{
    if(!data.can_accept||data.historicalTarget)return;accept.disabled=true;
    const target=productionRef(data.submission),reason=`认可${entity.payload.title}送审版本 ${data.submission.version}：基础信息、${data.states.length} 个完整状态及 ${data.media.length} 项送审素材。`;
    try{await api('/api/production/judgment',{method:'POST',body:JSON.stringify({object_id:'entity-accept-'+data.submission.id,expected_version:0,payload:{format:'production-judgment-v1',title:entity.payload.title+' · 整实体认可',blocks:[{id:'decision',text:reason}],target,verdict:'accepted',actor:'用户',reason}})});if(state.entityReview===data){await reloadEntityReview(data.submission.id);toast('已记录整实体认可')}}
    catch(error){if(state.entityReview===data){await reloadEntityReview();toast(error.message)}throw error}
  });accept.classList.add('entity-review-accept');accept.disabled=!data.can_accept||!!data.historicalTarget;header.append(actions);root.append(header);
  nodeText('p','entity-review-scope',`认可范围：基础信息、全部 ${data.states.length} 个完整状态、${data.media.length} 项送审素材。`,root);
  if(data.historicalTarget){const warning=el('div','entity-review-notice');nodeText('p',null,'正在查看单项历史版本，保留当时的文字与评论。',warning);productionButton(warning,'返回当前送审',()=>reloadEntityReview());root.append(warning)}
  else if(data.issues.length){const warning=el('div','entity-review-notice');nodeText('p',null,data.issues.some(i=>i.code==='historical_submission')?'正在查看历史送审及当时的认可。':'设定或状态已更新，当前仍显示原送审内容；重新送审后才能认可新版。',warning);productionButton(warning,'读取最新送审',()=>reloadEntityReview());root.append(warning)}
  const basics=el('section','entity-review-basics');basics.setAttribute('aria-label','实体基础信息');nodeText('h3',null,'基础信息',basics);
  if(entity.payload.aliases?.length)nodeText('p','production-meta','别名：'+entity.payload.aliases.join('、'),basics);
  reviewTextBlocks(basics,entity);reviewNotes(basics,entity);productionButton(basics,'评论基础信息',()=>{entityReviewFocus(entity);startDraft({type:'global'})});root.append(basics);
  const nav=el('section','production-entity-context');nav.setAttribute('aria-label','选择完整状态');nodeText('h3','production-entity-title',`完整状态 · ${data.states.length}`,nav);const choices=el('div','production-entity-options');
  for(const [index,row] of data.states.entries()){
    const button=productionButton(choices,'',()=>selectEntityReviewState(row));nodeText('span',null,(index===0?'基础状态 · ':'')+entityReviewShort(row,entity),button);nodeText('small',null,entityReviewScope(row),button);button.setAttribute('aria-pressed',String(row.id===form?.id));button.dataset.stateId=row.object_id;
  }nav.append(choices);root.append(nav);
  if(form){
    const heading=el('div','entity-review-state-heading');nodeText('h3',null,entityReviewShort(form,entity),heading);productionButton(heading,'评论此状态',()=>{entityReviewFocus(form);startDraft({type:'global'})});root.append(heading);
    const media=data.media.filter(m=>m.state.revision_id===form.id),layout=el('div','entity-review-layout'+(media.length?'':' no-media')),visuals=el('section','entity-review-media');visuals.setAttribute('aria-label','当前状态送审素材');
    renderEntityReviewMedia(visuals,media,form);layout.append(visuals);
    const description=el('section','entity-review-description');description.setAttribute('aria-label','完整状态描述');
    const base=data.states[0],changes=base&&base.id!==form.id?Object.keys(form.payload.dimensions||{}).filter(k=>form.payload.dimensions[k]!==base.payload.dimensions[k]):[];
    if(changes.length)nodeText('p','entity-review-changes','相对基础状态变化：'+changes.map(k=>productionDimensionLabels[k]||k).join('、'),description);
    nodeText('h4',null,'完整状态描述',description);reviewTextBlocks(description,form,{compact:true});reviewNotes(description,form);layout.append(description);root.append(layout);
  }
  if(entity.payload.lyrics?.length){const lyrics=el('section','entity-review-lyrics');nodeText('h3',null,'歌词原文与段落',lyrics);for(const lyric of entity.payload.lyrics){nodeText('h4',null,lyric.section,lyrics);nodeText('p',null,lyric.text,lyrics);productionRefLink(lyrics,lyric.source,'查看歌词依据')}root.append(lyrics)}
  renderEntityReviewHistory(root,data,form);updateEntityReviewCounts();
}
function renderEntityReviewMedia(parent,items,form){
  if(!items.length){nodeText('p','entity-review-empty',form.payload.reference_media==='none'?'此状态仅被提及，无媒体制作要求。':'此状态尚未提交参考素材，可先审阅文字设定。',parent);return}
  const ordered=[...items].sort((a,b)=>(a.role==='overall'?0:1)-(b.role==='overall'?0:1));
  const current=ordered.find(m=>m.id===state.entityReviewMedia)||ordered[0];state.entityReviewMedia=current.id;
  const labels=el('div','entity-review-media-options');
  for(const item of ordered){const button=productionButton(labels,'',()=>{state.entityReviewMedia=item.id;entityReviewFocus(item.record);renderProductionReader()});button.setAttribute('aria-pressed',String(item===current));
    if(item.component.mime.startsWith('image/')){const thumb=el('img');thumb.src='/api/production/files/'+encodeURIComponent(item.component.file);thumb.alt='';thumb.loading='lazy';button.append(thumb)}
    nodeText('span',null,`${item.role==='overall'?'整体参考':'补充参考'} · ${item.label}`,button);
  }
  nodeText('h4',null,`送审${current.role==='overall'?'整体参考':'补充参考'} · 素材版本 ${current.record.version}`,parent);
  const pane=el('div','entity-review-media-pane');pane.dataset.reviewRevision=current.record.id;
  pane.addEventListener('pointerdown',()=>entityReviewFocus(current.record),true);pane.addEventListener('click',()=>entityReviewFocus(current.record),true);pane.addEventListener('focusin',()=>entityReviewFocus(current.record),true);
  const component=current.component,url='/api/production/files/'+encodeURIComponent(component.file);
  if(component.mime.startsWith('image/')){
    pane.append(renderStructureVisual({...component,title:current.label,alt:current.label,description:`${component.width} × ${component.height}`},true));
    if(current.crop){nodeText('p','production-meta',`送审范围：左 ${(current.crop.x*100).toFixed(1)}% / 上 ${(current.crop.y*100).toFixed(1)}% / 宽 ${(current.crop.width*100).toFixed(1)}% / 高 ${(current.crop.height*100).toFixed(1)}%（原图坐标）`,pane);pane.querySelector('.structure-visual-stage').dataset.reviewCrop=JSON.stringify(current.crop)}
  }else{
    const player=el(component.mime.startsWith('audio/')?'audio':'video');player.controls=true;player.preload='metadata';player.src=url;player.dataset.componentId=component.id;pane.append(player);
    const from=current.range?.start_seconds||0,to=current.range?.end_seconds||component.duration_seconds;
    player.addEventListener('loadedmetadata',()=>{player.currentTime=Number(player.dataset.reviewSeek??from)});player.addEventListener('play',()=>{entityReviewFocus(current.record);if(player.currentTime<from||player.currentTime>=to)player.currentTime=from});player.addEventListener('timeupdate',()=>{if(current.range&&player.currentTime>=to)player.pause()});
    nodeText('p','production-meta',`送审时间：${from.toFixed(2)}–${to.toFixed(2)} 秒`,pane);
    const range=el('div','production-toolbar'),start=el('input'),end=el('input');for(const [input,label,value] of [[start,'评论开始秒',from],[end,'评论结束秒',Math.min(from+3,to)]]){input.type='number';input.step='.01';input.min=from;input.max=to;input.value=value.toFixed(2);input.setAttribute('aria-label',label);range.append(input)}
    productionButton(range,'取当前为起点',()=>{start.value=player.currentTime.toFixed(2)});productionButton(range,'取当前为终点',()=>{end.value=player.currentTime.toFixed(2)});
    productionButton(range,'评论此时间段',()=>{const a=Number(start.value),b=Number(end.value);if(!(from<=a&&a<b&&b<=to))throw Error('评论范围须在本次送审时间段内');entityReviewFocus(current.record);startDraft({type:'time',component_id:component.id,asset_file:component.file,start_seconds:a,end_seconds:b})});pane.append(range);
  }
  link('下载原文件',url,pane);parent.append(pane,labels);
}
function renderEntityReviewHistory(parent,data,form){
  if(data.previous_accepted){const previous=data.previous_accepted,comparison=el('details','entity-review-secondary');nodeText('summary',null,`此前已认可 · 送审版本 ${previous.submission.version}`,comparison);
    const changed=data.states.filter(r=>!previous.states.some(old=>old.id===r.id)),removed=previous.states.filter(old=>!data.states.some(r=>r.object_id===old.object_id));
    nodeText('p',null,`${previous.entity.id===data.entity.id?'基础信息未变':'基础信息已更新'}；${changed.length} 个状态新增或更新，${removed.length} 个状态移出；此前送审素材 ${previous.media.length} 项，本次 ${data.media.length} 项。`,comparison);
    const compare=el('div','production-compare');for(const [title,snapshot] of [['此前已认可',previous],['本次送审',data]]){const column=el('div');nodeText('h4',null,title,column);const old=snapshot.states.find(r=>r.object_id===form?.object_id);nodeText('p',null,old?.payload.blocks.map(b=>b.text).join('\n')||'这个送审版本不包含当前状态。',column);const media=snapshot.media.filter(m=>m.state.revision_id===old?.id);for(const item of media){nodeText('p',null,item.label+' · 素材版本 '+item.record.version,column);productionMedia(column,item.component,false)}compare.append(column)}comparison.append(compare);productionButton(comparison,'打开此前完整送审',()=>reloadEntityReview(previous.submission.id));parent.append(comparison)}
  const sources=el('details','entity-review-secondary');nodeText('summary',null,'剧情依据、出场与相关镜头',sources);
  for(const row of [data.entity,...(form?[form]:[])]){nodeText('h4',null,row.payload.title,sources);for(const ref of row.payload.sources||[])productionRefLink(sources,ref,`${productionName(ref)} · ${ref.scene_id||'正文'}`)}
  for(const usage of data.usages[form?.id]||[])productionRefLink(sources,usage,`${productionKinds[usage.kind]} · ${usage.title}`);parent.append(sources);
  const history=el('details','entity-review-secondary');nodeText('summary',null,'送审版本与认可记录',history);
  if(!data.history.length)nodeText('p',null,'尚未创建整实体送审版本。',history);
  for(const version of data.history)productionButton(history,`送审版本 ${version.version} · ${version.accepted?'已认可':'未认可'}`,()=>reloadEntityReview(version.revision_id));
  if(data.accepted)nodeText('p',null,`${data.accepted.payload.actor} · ${new Date(data.accepted.created_at).toLocaleString('zh-CN')} · ${data.accepted.payload.reason}`,history);
  nodeText('p','production-meta','认可只记录本次送审范围。素材采用和镜头输入就绪另行核对。',history);parent.append(history);
}
function updateEntityReviewCounts(){if(!isEntityReview())return;const count=entityReviewComments().filter(c=>c.status==='OPEN').length;for(const button of document.querySelectorAll('[data-entity-review-count]'))button.textContent=`查看评论 · ${count}`}
function locateEntityReviewComment(comment){
  const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id);if(!row)return;
  if(row.kind==='STATE')state.productionChildDetail=entityReviewDetail(row);
  if(row.kind==='ASSET'){const item=data.media.find(m=>m.record.id===row.id&&(m.component_id===(comment.anchor.component_id||comment.anchor.visual_id)||!comment.anchor.component_id&&!comment.anchor.visual_id));if(item){state.productionChildDetail=entityReviewDetail(data.states.find(r=>r.id===item.state.revision_id));state.entityReviewMedia=item.id}}
  focusProductionReview(entityReviewDetail(row),false);state.selected=comment.id;renderProductionReader();
  // Expand any collapsed exact text before using the common locate behavior.
  for(const node of document.querySelectorAll('#production-blocks [data-block-id]'))if(node.dataset.blockId===comment.anchor.block_id){let parent=node.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement}}
  locateProductionComment(comment,true);
}
