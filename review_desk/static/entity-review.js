/* The settings workspace is a review surface. Content changes use the shared tools. */
const isEntityReview=()=>state.workspace==='settings.workspace'&&!!state.entityReview;
const entityReviewDetail=record=>({record,history:[record],uses:[]});
const entityReviewRows=data=>[data.entity,...data.states,...data.media.map(m=>m.record),...(data.comment_records||[])];
const entityReviewStateMedia=(data,form)=>form?data.media.filter(m=>m.state?.object_id===form.object_id&&m.state.revision_id===form.id):[];
const entityReviewUnassignedMedia=data=>data.media.filter(m=>!m.state);
const entityReviewMediaCount=items=>new Set(items.map(m=>m.record.id)).size;
const entityReviewShort=(row,entity)=>row.payload.title.startsWith(entity.payload.title)?row.payload.title.slice(entity.payload.title.length).replace(/^[\s·：:—-]+/u,'')||row.payload.title:row.payload.title;
function entityReviewFocus(row){focusProductionReview(entityReviewDetail(row))}
function entityReviewComments(){const data=state.entityReview,targets=[...data.comment_targets,...(data.historicalTarget?[productionRef(data.historicalTarget)]:[])];return state.comments.filter(c=>targets.some(t=>t.object_id===c.target_object_id&&t.revision_id===c.target_revision_id))}
function entityReviewCommentGroup(comment){const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id),label=row?.kind==='ENTITY'?'实体':row?.kind==='STATE'?'状态 · '+entityReviewShort(row,data.entity):row?.kind==='ASSET'?'素材 · '+row.payload.title:'历史整体意见';return label+(row&&row.id!==row.current_revision?' · 历史版本 '+row.version:'')}
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
  const form=detail.record.kind==='STATE'?(match||(exactRevision?detail.record:data.states.find(r=>r.object_id===detail.record.object_id)||data.states[0])):data.states[0]||null;
  state.entityReview=data;state.productionEntityId=owner;
  state.productionEntityDetail=entityReviewDetail(data.historicalTarget?.kind==='ENTITY'?data.historicalTarget:data.entity);
  state.productionChildDetail=form?entityReviewDetail(form):null;state.entityReviewMedia=null;state.entityReviewUnassignedMedia=null;
  // Current browsing follows live content; only a deliberate historical link
  // keeps an acceptance revision. Legacy workflow URLs return to the entity.
  url.searchParams.delete('entity_submission');
  if(!reviewRevision)url.searchParams.delete('entity_acceptance');
  url.searchParams.set('production_entity',owner);history.replaceState(null,'',url);
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
  state.entityReview.historicalTarget=null;state.entityReview.historicalMedia=null;state.entityReview.unassignedOpen=false;state.productionEntityDetail=entityReviewDetail(state.entityReview.entity);
  state.productionChildDetail=entityReviewDetail(row);state.entityReviewMedia=null;
  focusProductionReview(state.productionChildDetail,false);renderProductionReader();renderComments();
}
function entityReviewScope(row){
  const scenes=[...new Map((state.entityReview.usages[row.id]||[]).filter(u=>u.kind==='PREPARATION').map(u=>[u.source.object_id+u.source.scene_id,u.source])).values()];
  if(!scenes.length)return row.payload.reference_media==='none'?'仅被提及':'尚未关联实际出场';
  const sceneName=ref=>{const ep=state.screenplays.flatMap(s=>s.episodes).find(e=>e.object_id===ref.object_id&&e.id===ref.revision_id);return `${(ep?.payload.number||ep?.payload.episode_number)?'第'+(ep.payload.number||ep.payload.episode_number)+'集 · ':''}${ref.scene_id}`};
  return scenes.length===1?sceneName(scenes[0]):`${sceneName(scenes[0])} 至 ${sceneName(scenes.at(-1))} · ${scenes.length} 场`;
}
function reviewTextBlocks(parent,row){
  const host=el('div','entity-review-text');host.dataset.productionBlocks=row.id;if(state.productionSelected?.id===row.id)host.id='production-blocks';
  host.onpointerdown=()=>entityReviewFocus(row);host.onfocusin=()=>entityReviewFocus(row);
  for(const block of row.payload.blocks){
    let offset=0;
    for(const line of block.text.split('\n')){
      const para=el('p',null,line);para.dataset.blockId=block.id;para.dataset.anchorOffset=offset;
      host.append(para);
      offset+=Array.from(line).length+1;
    }
  }
  reviewNotes(host,row);
  parent.append(host);
}
function reviewNotes(parent,row){
  const notes=productionTextBlocks(row).slice(row.payload.blocks.length);
  for(const [key,label] of [['facts','剧本事实'],['choices','制作选择'],['unknowns','待确认']]){
    const values=notes.filter(block=>block.field===key);
    if(!values.length)continue;
    const section=el('section','entity-review-notes'+(key==='unknowns'?' entity-review-unknowns':''));section.setAttribute('aria-label',label);nodeText('h4',null,label,section);
    if(key==='unknowns')nodeText('small','entity-review-note-hint','圈选文字，可通过评论补充信息。',section);
    for(const block of values){const para=nodeText('p',null,block.text,section);para.dataset.blockId=block.id}
    parent.append(section);
  }
}
function renderEntityReview(root){
  const data=state.entityReview,entity=state.productionEntityDetail.record,form=state.productionChildDetail?.record;
  const header=el('header','entity-review-header'),identity=el('div'),badge=el('small','production-pill production-entity-badge');badge.dataset.entityType=entity.payload.entity_type;badge.append(productionEntityIcon(entity.payload.entity_type));nodeText('span',null,productionLabels[entity.payload.entity_type],badge);identity.append(badge);nodeText('h2',null,entity.payload.title,identity);
  const status=data.accepted?'已采纳':data.previous_accepted?'内容已更新 · 当前版本未采纳':'未采纳';
  nodeText('p','entity-review-status',`${data.historical?'历史内容':'当前内容'} · 基础信息版本 ${entity.version} · ${status}`,identity);header.append(identity);
  const actions=el('div','production-toolbar');
  productionButton(actions,'评论整个实体',()=>{entityReviewFocus(entity);startDraft({type:'global'})});
  const accept=productionButton(actions,data.accepted?'已采纳':'采纳当前版本',async()=>{
    if(!data.can_accept||data.historicalTarget)return;accept.disabled=true;
    const target=productionRef(data.entity),reason=`采纳${entity.payload.title}当前版本：基础信息、${data.states.length} 个完整状态及页面列出的 ${entityReviewMediaCount(data.media)} 份素材。`;
    try{await api('/api/production/judgment',{method:'POST',body:JSON.stringify({object_id:'entity-accept-'+data.content_key,expected_version:0,payload:{format:'production-judgment-v1',title:entity.payload.title+' · 版本采纳',blocks:[{id:'decision',text:reason}],target,verdict:'accepted',acceptance_model:'entity-current-v1',acceptance_scope:data.scope,actor:'用户',reason}})});if(state.entityReview===data){await reloadEntityReview();toast('已采纳当前版本，仍可继续添加审阅意见')}}
    catch(error){if(state.entityReview===data){await reloadEntityReview();toast(error.message)}throw error}
  });accept.classList.add('entity-review-accept');accept.disabled=!data.can_accept||!!data.historicalTarget;header.append(actions);root.append(header);
  nodeText('p','entity-review-scope',`采纳范围：基础信息、全部 ${data.states.length} 个完整状态及下方列出的 ${entityReviewMediaCount(data.media)} 份素材。采纳后仍可评论。`,root);
  if(data.historicalTarget||data.historical){const warning=el('div','entity-review-notice');nodeText('p',null,data.historicalTarget?`正在查看「${data.historicalTarget.payload.title}」的历史版本 ${data.historicalTarget.version}，意见仍绑定原内容。`:'正在查看此前采纳的版本，意见仍绑定当时的内容。',warning);productionButton(warning,'返回当前版本',()=>reloadEntityReview());root.append(warning)}
  if(data.historicalTarget?.kind==='REPRESENTATION'){const old=el('section','entity-review-secondary');nodeText('h3',null,'历史关联说明',old);reviewTextBlocks(old,data.historicalTarget);root.append(old)}
  const basics=el('section','entity-review-basics');basics.setAttribute('aria-label','实体基础信息');nodeText('h3',null,'基础信息',basics);
  if(entity.payload.aliases?.length)nodeText('p','production-meta','别名：'+entity.payload.aliases.join('、'),basics);
  reviewTextBlocks(basics,entity);root.append(basics);
  const nav=el('section','production-entity-context');nav.setAttribute('aria-label','选择完整状态');nodeText('h3','production-entity-title',`完整状态 · ${data.states.length}`,nav);const choices=el('div','production-entity-options');
  for(const [index,row] of data.states.entries()){
    const button=productionButton(choices,'',()=>selectEntityReviewState(row));nodeText('span',null,(index===0?'基础状态 · ':'')+entityReviewShort(row,entity),button);nodeText('small',null,`${entityReviewScope(row)} · ${entityReviewMediaCount(entityReviewStateMedia(data,row))} 份素材`,button);button.setAttribute('aria-pressed',String(row.id===form?.id));button.dataset.stateId=row.object_id;
  }nav.append(choices);root.append(nav);
  if(form){
    const heading=el('div','entity-review-state-heading');nodeText('h3',null,entityReviewShort(form,entity),heading);productionButton(heading,'评论此状态',()=>{entityReviewFocus(form);startDraft({type:'global'})});root.append(heading);
    const media=entityReviewStateMedia(data,form),layout=el('div','entity-review-layout'),visuals=el('section','entity-review-media');visuals.setAttribute('aria-label','此状态的参考素材');
    renderEntityReviewMedia(visuals,media,form);layout.append(visuals);
    const description=el('section','entity-review-description');description.setAttribute('aria-label','完整状态描述');
    const base=data.states[0],changes=base&&base.id!==form.id?Object.keys(form.payload.dimensions||{}).filter(k=>form.payload.dimensions[k]!==base.payload.dimensions[k]):[];
    if(changes.length)nodeText('p','entity-review-changes','相对基础状态变化：'+changes.map(k=>productionDimensionLabels[k]||k).join('、'),description);
    nodeText('h4',null,'完整状态描述',description);reviewTextBlocks(description,form);layout.append(description);root.append(layout);
  }
  if(data.historicalMedia){const original=el('section','entity-review-secondary');original.setAttribute('aria-label','评论对应的素材版本');nodeText('h3',null,'评论对应的素材版本',original);nodeText('p',null,'以下为原意见绑定的文件，未将它关联到当前选中的状态。',original);renderEntityReviewMedia(original,[data.historicalMedia],null,'entityReviewHistoricalMedia');root.append(original)}
  const unassigned=entityReviewUnassignedMedia(data);
  if(unassigned.length){
    const pending=el('details','entity-review-secondary entity-review-unassigned');pending.setAttribute('aria-label','待关联状态的素材');pending.open=!!data.unassignedOpen;
    nodeText('summary',null,`待关联状态的素材 · ${entityReviewMediaCount(unassigned)} 份`,pending);
    nodeText('p',null,'这些候选尚未确认对应哪个当前状态，暂不作为任何状态的参考。可先审阅并评论，由 Codex 核对后关联。',pending);
    const preview=el('section','entity-review-media');pending.append(preview);let loaded=false;
    const show=()=>{if(!loaded){renderEntityReviewMedia(preview,unassigned,null,'entityReviewUnassignedMedia');loaded=true}};
    if(pending.open)show();pending.ontoggle=()=>{data.unassignedOpen=pending.open;if(pending.open)show()};root.append(pending);
  }
  if(entity.payload.lyrics?.length){const lyrics=el('section','entity-review-lyrics');nodeText('h3',null,'歌词原文与段落',lyrics);for(const lyric of entity.payload.lyrics){nodeText('h4',null,lyric.section,lyrics);nodeText('p',null,lyric.text,lyrics);productionRefLink(lyrics,lyric.source,'查看歌词依据')}root.append(lyrics)}
  renderEntityReviewHistory(root,data,form);
}
function renderEntityPlaceholder(parent,form,audio=false){
  const entity=state.productionEntityDetail.record,type=entity.payload.entity_type,label=productionLabels[type]||'实体',box=el('div','entity-review-placeholder');box.dataset.entityType=type;
  const illustration=el('div','entity-review-placeholder-art');illustration.setAttribute('role','img');illustration.setAttribute('aria-label',label+'占位图');illustration.append(productionEntityIcon(type));box.append(illustration);
  nodeText('strong',null,entity.payload.title,box);
  nodeText('p',null,audio?'声音参考':form?.payload.reference_media==='none'?'仅被提及，无媒体制作要求':'此状态暂无关联素材',box);
  if(!audio&&form?.payload.reference_media!=='none')nodeText('small',null,'可先审阅状态描述并提出意见',box);
  parent.append(box);
}
function renderEntityReviewMedia(parent,items,form,selectionKey='entityReviewMedia'){
  if(!items.length){nodeText('h4',null,'参考素材',parent);renderEntityPlaceholder(parent,form);return}
  const ordered=[...items].sort((a,b)=>(a.role==='overall'?0:1)-(b.role==='overall'?0:1));
  const current=ordered.find(m=>m.id===state[selectionKey])||ordered[0];state[selectionKey]=current.id;
  const roleLabel=item=>item.role==='overall'?'整体参考':item.role==='detail'?'补充参考':selectionKey==='entityReviewHistoricalMedia'?'原素材':'待关联状态';
  const labels=el('div','entity-review-media-options');
  for(const item of ordered){const button=productionButton(labels,'',()=>{state[selectionKey]=item.id;entityReviewFocus(item.record);renderProductionReader()});button.setAttribute('aria-pressed',String(item===current));
    if(item.component.mime.startsWith('image/')){const thumb=el('img');thumb.src='/api/production/files/'+encodeURIComponent(item.component.file);thumb.alt='';thumb.loading='lazy';button.append(thumb)}
    nodeText('span',null,`${roleLabel(item)} · ${item.label}`,button);
  }
  nodeText('h4',null,`${roleLabel(current)} · 素材版本 ${current.record.version}`,parent);
  const pane=el('div','entity-review-media-pane');pane.dataset.reviewRevision=current.record.id;
  if(selectionKey==='entityReviewHistoricalMedia')pane.dataset.commentMedia='true';
  pane.addEventListener('pointerdown',()=>entityReviewFocus(current.record),true);pane.addEventListener('click',()=>entityReviewFocus(current.record),true);pane.addEventListener('focusin',()=>entityReviewFocus(current.record),true);
  const component=current.component,url='/api/production/files/'+encodeURIComponent(component.file);
  if(component.mime.startsWith('image/')){
    pane.append(renderStructureVisual({...component,title:current.label,alt:current.label,description:`${component.width} × ${component.height}`},true));
    if(current.crop){nodeText('p','production-meta',`参考范围：左 ${(current.crop.x*100).toFixed(1)}% / 上 ${(current.crop.y*100).toFixed(1)}% / 宽 ${(current.crop.width*100).toFixed(1)}% / 高 ${(current.crop.height*100).toFixed(1)}%（原图坐标）`,pane);pane.querySelector('.structure-visual-stage').dataset.reviewCrop=JSON.stringify(current.crop)}
  }else{
    if(component.mime.startsWith('audio/'))renderEntityPlaceholder(pane,form,true);
    const player=el(component.mime.startsWith('audio/')?'audio':'video');player.controls=true;player.preload='metadata';player.src=url;player.dataset.componentId=component.id;pane.append(player);
    const from=current.range?.start_seconds||0,to=current.range?.end_seconds||component.duration_seconds;
    player.addEventListener('loadedmetadata',()=>{player.currentTime=Number(player.dataset.reviewSeek??from)});player.addEventListener('play',()=>{entityReviewFocus(current.record);if(player.currentTime<from||player.currentTime>=to)player.currentTime=from});player.addEventListener('timeupdate',()=>{if(current.range&&player.currentTime>=to)player.pause()});
    nodeText('p','production-meta',`参考时间：${from.toFixed(2)}–${to.toFixed(2)} 秒`,pane);
    const range=el('div','production-toolbar'),start=el('input'),end=el('input');for(const [input,label,value] of [[start,'评论开始秒',from],[end,'评论结束秒',Math.min(from+3,to)]]){input.type='number';input.step='.01';input.min=from;input.max=to;input.value=value.toFixed(2);input.setAttribute('aria-label',label);range.append(input)}
    productionButton(range,'取当前为起点',()=>{start.value=player.currentTime.toFixed(2)});productionButton(range,'取当前为终点',()=>{end.value=player.currentTime.toFixed(2)});
    productionButton(range,'评论此时间段',()=>{const a=Number(start.value),b=Number(end.value);if(!(from<=a&&a<b&&b<=to))throw Error('评论范围须在所选参考时间段内');entityReviewFocus(current.record);startDraft({type:'time',component_id:component.id,asset_file:component.file,start_seconds:a,end_seconds:b})});pane.append(range);
  }
  link('下载原文件',url,pane);parent.append(pane,labels);
}
function renderEntityReviewHistory(parent,data,form){
  if(data.previous_accepted){const previous=data.previous_accepted,comparison=el('details','entity-review-secondary');nodeText('summary',null,'此前采纳的内容',comparison);
    const changed=data.states.filter(r=>!previous.states.some(old=>old.id===r.id)),removed=previous.states.filter(old=>!data.states.some(r=>r.object_id===old.object_id));
    nodeText('p',null,`${previous.entity.id===data.entity.id?'基础信息未变':'基础信息已更新'}；${changed.length} 个状态新增或更新，${removed.length} 个状态移出；此前关联素材 ${new Set(previous.media.map(m=>m.record.id)).size} 份，当前 ${new Set(data.media.map(m=>m.record.id)).size} 份。`,comparison);
    const compare=el('div','production-compare');for(const [title,snapshot] of [['此前已采纳',previous],['当前内容',data]]){const column=el('div');nodeText('h4',null,title,column);const old=snapshot.states.find(r=>r.object_id===form?.object_id);nodeText('p',null,old?.payload.blocks.map(b=>b.text).join('\n')||'当时尚无此状态。',column);const media=entityReviewStateMedia(snapshot,old);for(const item of media){nodeText('p',null,item.label+' · 素材版本 '+item.record.version,column);productionMedia(column,item.component,false)}compare.append(column)}comparison.append(compare);productionButton(comparison,'查看此前采纳的版本',()=>reloadEntityReview(previous.decision.id));parent.append(comparison)}
  const sources=el('details','entity-review-secondary');nodeText('summary',null,'剧情依据、出场与相关镜头',sources);
  for(const row of [data.entity,...(form?[form]:[])]){nodeText('h4',null,row.payload.title,sources);for(const ref of row.payload.sources||[])productionRefLink(sources,ref,`${productionName(ref)} · ${ref.scene_id||'正文'}`)}
  for(const usage of data.usages[form?.id]||[])productionRefLink(sources,usage,`${productionKinds[usage.kind]} · ${usage.title}`);parent.append(sources);
  const history=el('details','entity-review-secondary');nodeText('summary',null,'采纳记录',history);
  if(!data.history.length)nodeText('p',null,'尚无采纳记录，可直接评论当前内容。',history);
  for(const version of data.history)productionButton(history,`${new Date(version.created_at).toLocaleString('zh-CN')} · ${version.actor} · 基础信息版本 ${version.entity_version}`,()=>reloadEntityReview(version.revision_id));
  if(data.accepted)nodeText('p',null,`${data.accepted.payload.actor} · ${new Date(data.accepted.created_at).toLocaleString('zh-CN')} · ${data.accepted.payload.reason}`,history);
  nodeText('p','production-meta','采纳表达对具体版本的认可，评论始终开放。镜头实际使用哪些素材仍单独记录。',history);parent.append(history);
}
function locateEntityReviewComment(comment){
  const data=state.entityReview,row=[...entityReviewRows(data),data.historicalTarget].find(r=>r?.id===comment.target_revision_id);if(!row)return;
  data.historicalTarget=row.id!==row.current_revision?row:null;data.historicalMedia=null;data.unassignedOpen=false;
  state.productionEntityDetail=entityReviewDetail(data.entity);
  const currentForm=data.states.find(r=>r.object_id===state.productionChildDetail?.record.object_id)||data.states[0];
  state.productionChildDetail=currentForm?entityReviewDetail(currentForm):null;
  if(row.kind==='ENTITY')state.productionEntityDetail=entityReviewDetail(row);
  if(row.kind==='STATE')state.productionChildDetail=entityReviewDetail(row);
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
