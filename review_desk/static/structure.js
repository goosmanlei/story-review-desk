/* Story structure reader. Review records use the shared comment panel and API in app.js. */
const STRUCTURE_SECTIONS={theme:'方向与主题',characters:'人物塑造',relationships:'人物关系',spaces:'空间关系',storylines:'故事线',timeline:'时间线'};
let structureDrawing=null;
let structureIndexFrame=0,structureIndexObserver=null;
const structureReadingPositions=new Map(),structureVisualSizes=new Map();
let structureChapterRestore=null;
function cancelStructureChapterRestore(){structureChapterRestore=null}
function rememberStructurePosition(){
  const reader=$('#structure-reader');
  if(reader?.dataset.readingRevision)structureReadingPositions.set(reader.dataset.readingRevision,Number(reader.scrollTop)||0);
}
function revealStructureVersion(versions){
  if(!versions?.clientWidth)return;
  const active=versions.querySelector('.active');if(!active)return;
  const list=versions.getBoundingClientRect(),button=active.getBoundingClientRect();
  // Move only this horizontal strip. scrollIntoView would also move the page
  // and the sticky structure frame away from the current reading position.
  if(button.left<list.left+8)versions.scrollLeft+=button.left-list.left-8;
  else if(button.right>list.left+versions.clientWidth-8)versions.scrollLeft+=button.right-list.left-versions.clientWidth+8;
}
function restoreStructureChapter(){
  const pending=structureChapterRestore;if(!pending)return;
  const {reader,section,revision,anchor,selected}=pending;
  if(!isStructure()||reader!==$('#structure-reader')||!reader.contains(section)||revision!==state.structureRevision||anchor!==state.anchor||selected!==state.selected){cancelStructureChapterRestore();return}
  const header=reader.querySelector('.structure-document-head'),offset=(header?.getBoundingClientRect().height||0)+20;
  reader.scrollTo({top:Math.max(0,reader.scrollTop+section.getBoundingClientRect().top-reader.getBoundingClientRect().top-offset),behavior:'instant'});
  // Keep a clicked chapter anchored while original images change the layout.
  // Wheel/touch/keyboard/pointer input gives control back to the reader.
  if([...reader.querySelectorAll('img')].every(img=>img.complete))cancelStructureChapterRestore();
}
function scrollStructureSection(section){
  const reader=$('#structure-reader');if(!section||!reader)return;
  structureChapterRestore={reader,section,revision:state.structureRevision,anchor:state.anchor,selected:state.selected};
  restoreStructureChapter();scheduleStructureIndex();
}
function scheduleStructureIndex(){
  if(structureIndexFrame)return;
  structureIndexFrame=requestAnimationFrame(()=>{structureIndexFrame=0;restoreStructureChapter();syncStructureIndex()});
}
function syncStructureIndex(){
  if(!isStructure())return;
  const reader=$('#structure-reader'),index=$('#structure-index'),sections=[...reader.querySelectorAll('.structure-section')];
  if(!sections.length)return;
  const readerRect=reader.getBoundingClientRect();
  const header=reader.querySelector('.structure-document-head'),offset=(header?.getBoundingClientRect().height||0)+20;
  const readingTop=readerRect.top+offset;
  reader.style.setProperty('--structure-scroll-offset',`${offset}px`);
  let current=sections[0];
  for(const section of sections){if(section.getBoundingClientRect().top<=readingTop+1)current=section;else break}
  if(reader.scrollTop>0&&reader.scrollTop+reader.clientHeight>=reader.scrollHeight-2)current=sections.at(-1);
  for(const button of index.querySelectorAll('button')){
    const active=button.getAttribute('aria-controls')===current.id,changed=active&&!button.classList.contains('active');
    button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');
    if(changed){
      const directory=index.querySelector('.structure-chapters')||index,rect=button.getBoundingClientRect(),edge=directory.getBoundingClientRect();
      if(rect.top<edge.top)directory.scrollTop+=rect.top-edge.top;
      else if(rect.bottom>edge.bottom)directory.scrollTop+=rect.bottom-edge.bottom;
    }
  }
}
function watchStructureIndex(){
  structureIndexObserver?.disconnect();
  structureIndexObserver=new ResizeObserver(scheduleStructureIndex);
  for(const node of [$('#structure-reader'),$('#structure-index'),$('.workspace-topbar'),...document.querySelectorAll('.structure-section')])structureIndexObserver.observe(node);
  scheduleStructureIndex();
}
function structureRevision(){return state.structure?.revisions.find(r=>r.id===state.structureRevision)||null}
function resolveStructureRevision(id){
  const revisions=state.structure?.revisions||[];
  if(id)return revisions.some(revision=>revision.id===id)?id:null;
  return revisions.some(revision=>revision.id===state.structure.current_revision)?state.structure.current_revision:null;
}
function chooseStructureRevision(id,updateUrl=true){
  if(typeof rememberStoryDraft==='function')rememberStoryDraft();
  const revision=resolveStructureRevision(id),changed=revision!==state.structureRevision;
  state.structureRouteError=id&&!revision?'指定的结构修订不存在或已不可用；未打开其他稿次。请选择可用稿次。':null;
  if(changed){
    if(isStructure()){
      getSelection()?.removeAllRanges();hideSelectionAction();
      state.anchor=null;state.editing=null;state.selected=null;state.preview=null;state.previewExpanded=false;state.suggestion=null;state.pending=null;state.drawMode=null;state.reviewCommentScope=null;structureDrawing=null;
    }
    state.structureRevision=revision;
  }
  if(updateUrl){
    const url=new URL(location.href);
    if(revision)url.searchParams.set('structure_revision',revision);else url.searchParams.delete('structure_revision');
    if(url.href!==location.href)history.pushState(null,'',url);
  }
  if(changed&&isStructure()){if(typeof restoreStoryDraft==='function')restoreStoryDraft();renderStructureReader();renderComments()}
}
function structureBlocks(doc){return doc.sections.flatMap(s=>[{id:`heading-${s.id}`,text:s.title},...s.blocks])}
function structureVisuals(doc){return doc.sections.flatMap(s=>s.visuals||[])}
function structureSourceTitle(id){return state.sources.find(s=>s.id===id)?.title||id}
function openStructureResponseComment(comment){
  locateComment(comment);
  if(comment.anchor_state?.valid===false||!isStructure()||state.structureRevision!==comment.target_revision_id||state.selected!==comment.id)return false;
  const target=comment.anchor.type==='text'?document.querySelector(`[data-structure-block="${escapeSelector(comment.anchor.block_id)}"]`):comment.anchor.visual_id?document.querySelector(`[data-visual-id="${escapeSelector(comment.anchor.visual_id)}"]`):$('#structure-reader');
  if(!target)return false;
  if(comment.status==='CLOSED'){
    const index=activeComments().filter(item=>item.status==='CLOSED').findIndex(item=>item.id===comment.id);
    state.historyOpen=true;state.historyLimit=Math.max(state.historyLimit,index+1);renderComments();
  }
  openPanel();$('#comment-'+escapeSelector(comment.id))?.scrollIntoView({block:'nearest'});return true;
}
function structureMarkParts(block,revision){
  const blocks=structureBlocks(revision.payload),index=blocks.findIndex(b=>b.id===block.id),letters=chars(block.text),marks=[];
  for(const c of state.comments.filter(c=>c.target_revision_id===revision.id&&c.target_object_id==='story-structure'&&(!c.anchor.type||c.anchor.type==='text'))){
    const a=c.anchor,first=blocks.findIndex(b=>b.id===a.block_id),last=blocks.findIndex(b=>b.id===a.end_block_id);
    if(first<0||last<first||index<first||index>last)continue;
    marks.push({start:index===first?a.start:0,end:index===last?a.end:letters.length,comment:c});
  }
  const draft=newDraftAnchor();
  if(draft?.type==='text'){
    const first=blocks.findIndex(b=>b.id===draft.block_id),last=blocks.findIndex(b=>b.id===draft.end_block_id);
    if(first>=0&&last>=first&&index>=first&&index<=last){
      const start=index===first?draft.start:0,end=index===last?draft.end:letters.length;
      if(start<end)marks.push({start,end,draft:true});
    }
  }
  const cuts=[...new Set([0,letters.length,...marks.flatMap(m=>[m.start,m.end])])].sort((a,b)=>a-b),fragment=document.createDocumentFragment();
  for(let i=0;i<cuts.length-1;i++){
    const start=cuts[i],end=cuts[i+1],active=marks.filter(m=>m.start<=start&&m.end>=end),text=letters.slice(start,end).join('');
    if(!active.length)fragment.append(document.createTextNode(text));
    else{const comments=active.filter(m=>m.comment),draft=active.some(m=>m.draft);const mark=el('span','comment-mark'+(comments.length&&comments.every(m=>m.comment.status==='CLOSED')?' closed':'')+(comments.some(m=>m.comment.id===state.selected)?' selected':'')+(draft?' draft-mark':''),text);mark.title=draft?'正在添加的评论范围':comments.map(m=>m.comment.body).join(' / ');if(comments.length)mark.onclick=()=>{if(getSelection()?.isCollapsed)selectComment(comments[0].comment.id)};fragment.append(mark)}
  }
  return fragment;
}
function structureBlockElement(tag,block,revision){const node=el(tag,'structure-text-block');node.dataset.structureBlock=block.id;node.append(structureMarkParts(block,revision));return node}
function drawPolygon(points,cls){const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');polygon.setAttribute('points',points.map(p=>`${p.x*100},${p.y*100}`).join(' '));polygon.setAttribute('class',cls);return polygon}
function paintStructureRegions(){
  document.querySelectorAll('.structure-visual-stage').forEach(stage=>{
    const svg=stage.querySelector('svg');svg.replaceChildren();const visual=stage.dataset.visualId,draft=newDraftAnchor(),revision=stage.closest('[data-review-revision]')?.dataset.reviewRevision,active=!isProduction()||!revision||revision===state.productionSelected?.id;stage.classList.toggle('draft-visual',active&&draft?.type==='visual'&&draft.visual_id===visual);
    for(const comment of unscopedComments().filter(c=>active&&c.anchor.type==='region'&&c.anchor.visual_id===visual&&(!isProduction()||c.target_revision_id===state.productionSelected?.id))){
      const polygon=drawPolygon(comment.anchor.points,'review-region'+(comment.status==='CLOSED'?' closed':''));polygon.onclick=()=>selectComment(comment.id);svg.append(polygon);
    }
    if(stage.dataset.reviewCrop){const c=JSON.parse(stage.dataset.reviewCrop);svg.append(drawPolygon([{x:c.x,y:c.y},{x:c.x+c.width,y:c.y},{x:c.x+c.width,y:c.y+c.height},{x:c.x,y:c.y+c.height}],'entity-review-crop'))}
    if(active&&draft?.type==='region'&&draft.visual_id===visual)svg.append(drawPolygon(draft.points,'review-region draft'));
    if(active&&structureDrawing?.visual===visual)svg.append(drawPolygon(structureDrawing.points,'review-region drawing'));
  });
}
function openStructureImage(visual,trigger,mediaBase='/assets/'){
  if((mediaBase==='/assets/'&&(state.drawMode||structureDrawing))||document.querySelector('.structure-image-dialog'))return;
  hideSelectionAction();
  const {dialog,body}=openReviewDialog(visual.title,trigger,'structure-image-dialog','关闭放大图');
  body.classList.add('structure-image-canvas');
  const image=el('img');image.src=reviewURL(`${mediaBase}${encodeURIComponent(visual.file)}`);image.alt=visual.alt||visual.title;image.draggable=false;body.append(image);
  const size=nodeText('button','structure-image-size','原始尺寸',dialog.querySelector('.review-dialog-header'));
  size.type='button';size.setAttribute('aria-pressed','false');
  size.onclick=()=>{const original=body.classList.toggle('original-size');size.textContent=original?'适应窗口':'原始尺寸';size.setAttribute('aria-pressed',String(original))};
  dialog.addEventListener('close',()=>document.body.classList.remove('structure-image-open'),{once:true});
  document.body.classList.add('structure-image-open');
}
function renderStructureVisual(visual,preview=false){
  const figure=reviewSurface(el('figure','structure-figure'),'image'),head=el('div','structure-figure-head');
  nodeText('strong',null,visual.title,head);nodeText('span',null,visual.kind==='diagram'?'结构图':'图片',head);figure.append(head);
  const viewport=el('div','structure-visual-viewport'),stage=el('div','structure-visual-stage');stage.dataset.visualId=visual.id;figure.dataset.reviewFile=visual.file;
  const img=el('img'),size=structureVisualSizes.get(visual.file)||visual;
  if(Number(size.width)>0&&Number(size.height)>0){img.width=Number(size.width);img.height=Number(size.height)}
  img.addEventListener('load',()=>{if(img.naturalWidth&&img.naturalHeight){structureVisualSizes.set(visual.file,{width:img.naturalWidth,height:img.naturalHeight});img.width=img.naturalWidth;img.height=img.naturalHeight}scheduleStructureIndex()});
  img.addEventListener('error',scheduleStructureIndex);
  img.src=reviewURL(`/assets/${encodeURIComponent(visual.file)}`);img.alt=visual.alt;stage.append(img);
  if(preview){
    img.classList.add('structure-image-trigger');img.dataset.reviewDialogTrigger='';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',`放大查看：${visual.title}`);img.setAttribute('aria-haspopup','dialog');img.title='点击放大查看';img.draggable=false;
    img.onclick=()=>openStructureImage(visual,img);
    img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openStructureImage(visual,img)}};
  }
  const overlay=document.createElementNS('http://www.w3.org/2000/svg','svg');overlay.setAttribute('viewBox','0 0 100 100');overlay.setAttribute('preserveAspectRatio','none');overlay.classList.add('structure-overlay');stage.append(overlay);
  viewport.append(stage);figure.append(viewport);nodeText('figcaption',null,visual.description,figure);
  const actions=el('div','structure-visual-actions');const region=nodeText('button',null,'圈选评论',actions);region.type='button';region.onclick=()=>{state.drawMode=visual.id;document.querySelectorAll('.structure-visual-stage').forEach(s=>s.classList.toggle('drawing',s===stage));toast('在图上拖动圈选；按 Shift 可画矩形')};
  const whole=nodeText('button',null,'评论整图',actions);whole.type='button';whole.onclick=()=>startDraft({type:'visual',visual_id:visual.id,asset_file:visual.file});figure.append(actions);return figure;
}
function renderStructureReader(){
  cancelStructureChapterRestore();hideSelectionAction();
  structureIndexObserver?.disconnect();
  if(!state.structure)return;
  const status=$('#structure-status'),index=$('#structure-index'),reader=$('#structure-reader');
  rememberStructurePosition();
  const versionScroll=Number(status.querySelector('.structure-versions')?.scrollLeft)||0;
  const directoryScroll=Number(index.querySelector('.structure-chapters')?.scrollTop)||0;
  status.replaceChildren();index.replaceChildren();reader.replaceChildren();
  index.classList.add('text-reader-index');
  const selection=state.structure.selection,active=structureRevision();
  reader.dataset.readingRevision=active?.id||'';
  $('#structure-workspace .structure-layout').hidden=!active;
  $('#comments-toggle').hidden=!active;
  if(!selection){
    const directions=state.sources.filter(s=>s.group==='expansion-directions');
    if(!directions.length){nodeText('p','structure-empty','尚无扩写方向。等待 Codex 准备候选后，可在这里阅读并选择。',status);return}
    const box=el('section','structure-start');nodeText('small',null,'第一步 · 选择结构稿依据',box);
    nodeText('h3',null,'选择一个扩写方向',box);
    nodeText('p',null,'这里是故事结构的起点。你可以先回看候选全文，再选定一个方向；Codex 会依据所选资料的当前修订起草完整图文结构稿。',box);
    const choices=el('div','structure-direction-grid');
    for(const source of directions){
      const card=el('article','structure-direction-card');nodeText('small',null,`方向 ${String(source.order||'').padStart(2,'0')} · ${source.version_type}`,card);
      nodeText('h4',null,source.title,card);nodeText('p',null,source.notes||source.origin,card);
      const actions=el('div','structure-direction-actions');
      const review=nodeText('button',null,'回看全文',actions);review.type='button';review.onclick=()=>{switchWorkspace('story.sources');chooseSource(source.id)};
      const select=nodeText('button','primary','选用这个方向',actions);select.type='button';select.onclick=()=>chooseStructureDirection(source.id);
      card.append(actions);choices.append(card);
    }
    box.append(choices);status.append(box);return;
  }
  if(!active&&!state.structure.revisions.length){
    const source=state.sources.find(item=>item.id===selection.payload?.source_id),label=source?`已选「${source.title}」。`:'方向已选定。';
    nodeText('p','structure-empty',`${label}等待 Codex 准备完整结构稿。`,status);return;
  }
  if(state.structure.direction_changed){const alert=nodeText('p','structure-alert','所选方向已更新。当前结构稿仍引用原方向修订；请核对并导入针对新方向的完整结构稿。',status);alert.setAttribute('role','alert')}
  const versions=el('nav','structure-versions');versions.setAttribute('aria-label','结构稿版本');
  for(const revision of state.structure.revisions){const button=nodeText('button','source-button'+(revision.id===state.structureRevision?' active':''),'',versions);button.type='button';button.dataset.revisionId=revision.id;button.setAttribute('aria-pressed',String(revision.id===state.structureRevision));nodeText('strong',null,`第 ${revision.version} 稿`,button);commentCountLabel(button,revisionCommentCount('story-structure',revision.id));button.onclick=()=>chooseStructureRevision(revision.id)}
  status.append(versions);versions.scrollLeft=versionScroll;revealStructureVersion(versions);
  if(state.structureRouteError){const issue=nodeText('p','production-issue',state.structureRouteError,status);issue.setAttribute('role','alert');return}
  if(!active){nodeText('p','structure-empty','请选择一个结构稿版本继续阅读。',status);return}
  const doc=active.payload;
  const directoryHead=el('header');nodeText('h2',null,'章节目录',directoryHead);nodeText('p',null,'版本评论数包含已关闭评论。',directoryHead);index.append(directoryHead);
  const chapters=el('div','structure-chapters');index.append(chapters);
  if(doc.illustrative){nodeText('p','structure-alert','隔离验收示例：内容仅用于验证页面与改稿流程，不是本故事已确认的结构。',status)}
  const basisSelection=state.structure.selection_history?.find(item=>item.id===doc.direction_selection_revision);
  const basisSource=basisSelection?.payload.source_id;
  const title=el('header','structure-document-head text-reader-head'),titleText=el('div');title.append(titleText);nodeText('small',null,`STORY STRUCTURE · 第 ${active.version} 稿`,titleText);nodeText('h2',null,businessTitle({object_id:'story-structure'},doc.title),titleText);nodeText('p',null,`本稿依据「${structureSourceTitle(basisSource||'来源未知')}」的修订 ${basisSelection?.payload.source_revision.slice(0,16)||'UNKNOWN'} · ${active.created_at}`,titleText);reader.append(title);
  for(const section of doc.sections){
    const nav=nodeText('button','source-button',STRUCTURE_SECTIONS[section.id],chapters);nav.type='button';nav.setAttribute('aria-controls',`structure-section-${section.id}`);nav.onclick=()=>scrollStructureSection(document.getElementById(nav.getAttribute('aria-controls')));
    const area=el('section','structure-section');area.id=`structure-section-${section.id}`;nodeText('small',null,STRUCTURE_SECTIONS[section.id].toUpperCase(),area);
    area.append(structureBlockElement('h2',{id:`heading-${section.id}`,text:section.title},active));
    const content=reviewSurface(el('div','structure-review-text'));for(const block of section.blocks)content.append(structureBlockElement('p',block,active));area.append(content);
    for(const visual of section.visuals||[])area.append(renderStructureVisual(visual,true));reader.append(area);
  }
  const tail=el('section','structure-review-tail');nodeText('h2',null,'意见处理与版本记录',tail);
  if(doc.responses?.length){for(const item of doc.responses){const c=state.comments.find(c=>c.id===item.comment_id);const row=el('p');nodeText('b',null,c?`回应原稿意见：${c.body}`:`意见 ${item.comment_id}`,row);nodeText('span',null,item.explanation,row);if(c){const back=nodeText('button',null,'查看原稿意见',row);back.type='button';back.onclick=()=>openStructureResponseComment(c)}tail.append(row)}}
  else nodeText('p',null,'本稿尚无关联意见处理说明。',tail);
  const allOpen=state.comments.filter(c=>c.target_object_id==='story-structure'&&c.status==='OPEN');nodeText('p',null,`待决意见 ${allOpen.length} 条；新稿不会自动关闭原稿意见。`,tail);
  const overall=nodeText('button',null,'添加整体意见',tail);overall.type='button';overall.onclick=()=>startDraft({type:'global'});
  reader.append(tail);reader.scrollTop=structureReadingPositions.get(active.id)||0;chapters.scrollTop=directoryScroll;paintStructureRegions();watchStructureIndex();
}
async function chooseStructureDirection(id){
  const data=state.structure,current=data.selection;
  if(data.directionSave)return toast(data.directionSave.message||'方向选择正在提交，请等待结果。');
  if(current?.payload.source_id===id)return toast('当前已选择这个方向');
  const workspace=state.workspace,revision=state.structureRevision,status=$('#structure-status'),content=status.firstChild;
  const ownsPage=()=>state.workspace===workspace&&isStructure()&&state.structure===data&&state.structureRevision===revision&&status.firstChild===content;
  const dialog=document.createElement('dialog');dialog.className='structure-confirm-dialog';
  nodeText('h2',null,`选择「${structureSourceTitle(id)}」`,dialog);
  nodeText('p',null,current?'旧结构稿仍保留原方向依据；页面会提示重新核对，Codex 需基于新方向导入完整新稿。':'系统会保存该方向当前的准确资料修订，供 Codex 起草结构初稿。',dialog);
  const notice=nodeText('p','production-issue','',dialog);notice.hidden=true;notice.setAttribute('role','status');
  const actions=el('div'),cancel=nodeText('button',null,'返回',actions);cancel.type='button';cancel.onclick=()=>dialog.close();
  const commit=nodeText('button','primary','选择这个方向',actions);commit.type='button';commit.onclick=async()=>{
    if(data.directionSave||!ownsPage()||!dialog.open)return;
    commit.disabled=true;data.directionSave={message:''};const ownsDialog=()=>ownsPage()&&dialog.isConnected&&dialog.open;
    const savedMessage=`「${structureSourceTitle(id)}」的方向选择已保存`;
    try{await api('/api/story-structure/select-direction',{method:'POST',body:JSON.stringify({source_id:id,expected_version:current?.version||0})})}
    catch(error){data.directionSave.message=`方向选择结果待确认：${error.message}。请刷新页面核对后再操作。`;if(ownsDialog()){notice.hidden=false;notice.textContent=data.directionSave.message;toast(data.directionSave.message)}return}
    data.directionSave.message=savedMessage+'；请刷新页面核对当前状态。';const refresh=ownsDialog();if(dialog.isConnected)dialog.close();toast(savedMessage+'，等待 Codex 起草结构稿');if(!refresh)return;
    try{const result=await api('/api/story-structure');if(!ownsPage())return;state.structure=result;renderStructureReader()}
    catch(error){data.directionSave.message=savedMessage+`；当前显示尚未更新：${error.message}。请刷新页面核对。`;if(ownsPage()){nodeText('p','production-issue',data.directionSave.message,status);toast(data.directionSave.message)}}
  };dialog.append(actions);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
}
function selectedStructureAnchor(){
  const revision=structureRevision();if(!revision||state.drawMode)return null;
  const anchor=textSelectionAnchor($('#structure-reader'),structureBlocks(revision.payload),'data-structure-block');
  return anchor?{type:'text',...anchor}:null;
}
function structurePoint(event,stage){const rect=stage.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}}
function structureRect(a,b){return[{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y)},{x:Math.max(a.x,b.x),y:Math.min(a.y,b.y)},{x:Math.max(a.x,b.x),y:Math.max(a.y,b.y)},{x:Math.min(a.x,b.x),y:Math.max(a.y,b.y)}]}
function structureArea(points){return Math.abs(points.reduce((sum,p,i)=>sum+p.x*points[(i+1)%points.length].y-points[(i+1)%points.length].x*p.y,0))/2}
function structureDrawingReader(){return isProduction()?(state.unifiedCardRoot||$('#production-reader')):$(isStructure()?'#structure-reader':'#source-view')}
document.addEventListener('pointerdown',event=>{
  // A media focus repaint can detach the clicked comment polygon. The event
  // path still owns its original stage, including inside a modal card.
  const stage=event.composedPath?.().find(node=>node.matches?.('.structure-visual-stage'))||event.target.closest?.('.structure-visual-stage');
  if(!stage||stage.dataset.visualId!==state.drawMode)return;
  const visual=stage.dataset.visualId;stage.closest('.entity-review-media-pane')?.reviewFocus?.();
  event.preventDefault();const overlay=stage.querySelector('svg');overlay.setPointerCapture(event.pointerId);
  structureDrawing={stage,visual,points:[structurePoint(event,stage)],rect:event.shiftKey,pointer:event.pointerId,workspace:state.workspace,target:commentTarget(),reader:structureDrawingReader(),source:state.workspace==='story.sources'?{id:state.current?.id,revision:state.current?.target_revision_id}:null};paintStructureRegions();
},true);
document.addEventListener('pointermove',event=>{if(!structureDrawing||event.pointerId!==structureDrawing.pointer)return;const stage=structureDrawing.stage;const point=structurePoint(event,stage),last=structureDrawing.points.at(-1);if(Math.hypot(point.x-last.x,point.y-last.y)<.002)return;structureDrawing.points.push(point);if(structureDrawing.points.length>260)structureDrawing.points=structureDrawing.points.filter((_,i)=>i%2===0);paintStructureRegions()},true);
document.addEventListener('pointerup',event=>{
  if(!structureDrawing||event.pointerId!==structureDrawing.pointer)return;
  const drawing=structureDrawing,stage=drawing.stage;
  structureDrawing=null;state.drawMode=null;stage.classList.remove('drawing');
  if(state.workspace!==drawing.workspace||!drawing.target.target_revision_id||JSON.stringify(commentTarget())!==JSON.stringify(drawing.target)||drawing.reader!==structureDrawingReader()||!drawing.reader?.contains(stage)){paintStructureRegions();return}
  let visual;
  if(drawing.source){
    const source=state.current;
    // A source gesture owns this exact document and rendered image. Navigation
    // or a newer draft can detach the old stage before its pointerup arrives.
    if(state.workspace!=='story.sources'||source?.id!==drawing.source.id||source?.target_revision_id!==drawing.source.revision||!$('#source-view').contains(stage)){paintStructureRegions();return}
    const asset=source.assets.find(item=>item.file===drawing.visual&&item.file===stage.closest('figure')?.dataset.reviewFile);
    if(!asset){paintStructureRegions();toast('原图已不可用，请重新打开资料后圈选');return}
    visual={id:asset.file,file:asset.file};
  }else visual=(isProduction()?productionVisuals():structureVisuals(structureRevision().payload)).find(v=>v.id===drawing.visual);
  if(!visual){paintStructureRegions();return}
  drawing.points.push(structurePoint(event,stage));let points=drawing.points;if(drawing.rect)points=structureRect(points[0],points.at(-1));const xs=points.map(p=>p.x),ys=points.map(p=>p.y),width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);if(width<.008||height<.008){toast('圈选区域太小，请重新拖动');paintStructureRegions();return}if(points.length<4||structureArea(points)<width*height*.06)points=structureRect({x:Math.min(...xs),y:Math.min(...ys)},{x:Math.max(...xs),y:Math.max(...ys)});points=points.map(p=>({x:Math.round(p.x*10000)/10000,y:Math.round(p.y*10000)/10000}));startDraft({type:'region',visual_id:visual.id,asset_file:visual.file,points});paintStructureRegions()},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.drawMode){state.drawMode=null;structureDrawing=null;document.querySelectorAll('.structure-visual-stage').forEach(s=>s.classList.remove('drawing'));paintStructureRegions()}});
document.addEventListener('scroll',event=>{if(event.target===$('#structure-reader'))rememberStructurePosition();scheduleStructureIndex()},{capture:true,passive:true});
for(const type of ['wheel','pointerdown','touchstart'])document.addEventListener(type,cancelStructureChapterRestore,{capture:true,passive:true});
document.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' ','Escape'].includes(event.key))cancelStructureChapterRestore()},{capture:true});
window.addEventListener('resize',()=>{revealStructureVersion($('#structure-status .structure-versions'));scheduleStructureIndex()});
