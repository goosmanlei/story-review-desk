/* Story structure reader. Review records use the shared comment panel and API in app.js. */
const STRUCTURE_SECTIONS={theme:'方向与主题',characters:'人物塑造',relationships:'人物关系',spaces:'空间关系',storylines:'故事线',timeline:'时间线'};
let structureDrawing=null;
let structureIndexFrame=0,structureIndexObserver=null;
function scheduleStructureIndex(){
  if(structureIndexFrame)return;
  structureIndexFrame=requestAnimationFrame(()=>{structureIndexFrame=0;syncStructureIndex()});
}
function syncStructureIndex(){
  if(!isStructure())return;
  const reader=$('#structure-reader'),index=$('#structure-index'),sections=[...reader.querySelectorAll('.structure-section')];
  if(!sections.length)return;
  const barBottom=$('.workspace-topbar').getBoundingClientRect().bottom,indexRect=index.getBoundingClientRect();
  let readingTop=Math.max(0,barBottom)+20;
  // The horizontal chapter menu also covers the manuscript on narrow screens.
  const indexStyle=getComputedStyle(index);
  if(indexStyle.display==='flex')readingTop=Math.max(readingTop,(parseFloat(indexStyle.top)||0)+indexRect.height+20);
  reader.style.setProperty('--structure-scroll-offset',`${readingTop}px`);
  let current=sections[0];
  for(const section of sections){if(section.getBoundingClientRect().top<=readingTop+1)current=section;else break}
  const page=document.scrollingElement;
  if(page.scrollTop>0&&page.scrollTop+window.innerHeight>=page.scrollHeight-2)current=sections.at(-1);
  for(const button of index.querySelectorAll('button')){
    const active=button.getAttribute('aria-controls')===current.id,changed=active&&!button.classList.contains('active');
    button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');
    if(changed&&index.scrollWidth>index.clientWidth){
      const rect=button.getBoundingClientRect();
      if(rect.left<indexRect.left)index.scrollLeft+=rect.left-indexRect.left;
      else if(rect.right>indexRect.right)index.scrollLeft+=rect.right-indexRect.right;
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
function structureBlocks(doc){return doc.sections.flatMap(s=>[{id:`heading-${s.id}`,text:s.title},...s.blocks])}
function structureVisuals(doc){return doc.sections.flatMap(s=>s.visuals||[])}
function structureSourceTitle(id){return state.sources.find(s=>s.id===id)?.title||id}
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
    for(const comment of activeComments().filter(c=>active&&c.anchor.type==='region'&&c.anchor.visual_id===visual&&(!isProduction()||c.target_revision_id===state.productionSelected?.id))){
      const polygon=drawPolygon(comment.anchor.points,'review-region'+(comment.status==='CLOSED'?' closed':''));polygon.onclick=()=>selectComment(comment.id);svg.append(polygon);
    }
    if(stage.dataset.reviewCrop){const c=JSON.parse(stage.dataset.reviewCrop);svg.append(drawPolygon([{x:c.x,y:c.y},{x:c.x+c.width,y:c.y},{x:c.x+c.width,y:c.y+c.height},{x:c.x,y:c.y+c.height}],'entity-review-crop'))}
    if(active&&draft?.type==='region'&&draft.visual_id===visual)svg.append(drawPolygon(draft.points,'review-region draft'));
    if(active&&structureDrawing?.visual===visual)svg.append(drawPolygon(structureDrawing.points,'review-region drawing'));
  });
}
function openStructureImage(visual,trigger){
  if(state.drawMode||structureDrawing||document.querySelector('.structure-image-dialog'))return;
  hideSelectionAction();
  const {dialog,body}=openReviewDialog(visual.title,trigger,'structure-image-dialog','关闭放大图');
  body.classList.add('structure-image-canvas');
  const image=el('img');image.src=`/assets/${encodeURIComponent(visual.file)}`;image.alt=visual.alt||visual.title;image.draggable=false;body.append(image);
  dialog.addEventListener('close',()=>document.body.classList.remove('structure-image-open'),{once:true});
  document.body.classList.add('structure-image-open');
}
function renderStructureVisual(visual,preview=false){
  const figure=reviewSurface(el('figure','structure-figure'),'image'),head=el('div','structure-figure-head');
  nodeText('strong',null,visual.title,head);nodeText('span',null,visual.kind==='diagram'?'结构图':'图片',head);figure.append(head);
  const viewport=el('div','structure-visual-viewport'),stage=el('div','structure-visual-stage');stage.dataset.visualId=visual.id;
  const img=el('img');img.src=`/assets/${encodeURIComponent(visual.file)}`;img.alt=visual.alt;stage.append(img);
  if(preview){
    img.classList.add('structure-image-trigger');img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',`放大查看：${visual.title}`);img.setAttribute('aria-haspopup','dialog');img.title='点击放大查看';img.draggable=false;
    img.onclick=()=>openStructureImage(visual,img);
    img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openStructureImage(visual,img)}};
  }
  const overlay=document.createElementNS('http://www.w3.org/2000/svg','svg');overlay.setAttribute('viewBox','0 0 100 100');overlay.setAttribute('preserveAspectRatio','none');overlay.classList.add('structure-overlay');stage.append(overlay);
  viewport.append(stage);figure.append(viewport);nodeText('figcaption',null,visual.description,figure);
  const actions=el('div','structure-visual-actions');const region=nodeText('button',null,'圈选评论',actions);region.type='button';region.onclick=()=>{state.drawMode=visual.id;document.querySelectorAll('.structure-visual-stage').forEach(s=>s.classList.toggle('drawing',s===stage));toast('在图上拖动圈选；按 Shift 可画矩形')};
  const whole=nodeText('button',null,'评论整图',actions);whole.type='button';whole.onclick=()=>startDraft({type:'visual',visual_id:visual.id,asset_file:visual.file});figure.append(actions);return figure;
}
function renderStructureReader(){
  hideSelectionAction();
  structureIndexObserver?.disconnect();
  if(!state.structure)return;
  const status=$('#structure-status'),index=$('#structure-index'),reader=$('#structure-reader');status.replaceChildren();index.replaceChildren();reader.replaceChildren();
  const selection=state.structure.selection,active=structureRevision();
  $('#structure-workspace .structure-layout').hidden=!active;
  $('#comments-toggle').hidden=!active;
  if(!selection){
    const box=el('section','structure-start');nodeText('small',null,'第一步 · 选择结构稿依据',box);
    nodeText('h3',null,'选择一个扩写方向',box);
    nodeText('p',null,'这里是故事结构的起点。你可以先回看候选全文，再选定一个方向；Codex 会依据所选资料的当前修订起草完整图文结构稿。',box);
    const choices=el('div','structure-direction-grid');
    for(const source of state.sources.filter(s=>s.group==='expansion-directions')){
      const card=el('article','structure-direction-card');nodeText('small',null,`方向 ${String(source.order||'').padStart(2,'0')} · ${source.version_type}`,card);
      nodeText('h4',null,source.title,card);nodeText('p',null,source.notes||source.origin,card);
      const actions=el('div','structure-direction-actions');
      const review=nodeText('button',null,'回看全文',actions);review.type='button';review.onclick=()=>{switchWorkspace('story.sources');chooseSource(source.id)};
      const select=nodeText('button','primary','选用这个方向',actions);select.type='button';select.onclick=()=>chooseStructureDirection(source.id);
      card.append(actions);choices.append(card);
    }
    box.append(choices);status.append(box);return;
  }
  if(state.structure.direction_changed){const alert=nodeText('p','structure-alert','所选方向已更新。当前结构稿仍引用原方向修订；请核对并导入针对新方向的完整结构稿。',status);alert.setAttribute('role','alert')}
  const versions=el('div','structure-versions');nodeText('span',null,'阅读版本：',versions);
  for(const revision of state.structure.revisions){const button=nodeText('button',revision.id===state.structureRevision?'active':'','',versions);button.type='button';button.dataset.revisionId=revision.id;button.setAttribute('aria-pressed',String(revision.id===state.structureRevision));nodeText('strong',null,`第 ${revision.version} 稿`,button);commentCountLabel(button,revisionCommentCount('story-structure',revision.id));button.onclick=()=>{state.structureRevision=revision.id;state.anchor=null;state.selected=null;renderStructureReader();renderComments()}}
  status.append(versions);nodeText('p','revision-count-help','评论数包含已关闭评论。',status);
  if(!active){nodeText('p','structure-empty','方向已选定。等待 Codex 通过 structure-import 导入完整图文结构初稿。',status);return}
  const doc=active.payload;
  if(doc.illustrative){nodeText('p','structure-alert','隔离验收示例：内容仅用于验证页面与改稿流程，不是本故事已确认的结构。',status)}
  const basisSelection=state.structure.selection_history?.find(item=>item.id===doc.direction_selection_revision);
  const basisSource=basisSelection?.payload.source_id;
  const title=el('header','structure-document-head');nodeText('small',null,`STORY STRUCTURE · 第 ${active.version} 稿`,title);nodeText('h2',null,doc.title,title);nodeText('p',null,`本稿依据「${structureSourceTitle(basisSource||'来源未知')}」的修订 ${basisSelection?.payload.source_revision.slice(0,16)||'UNKNOWN'} · ${active.created_at}`,title);reader.append(title);
  for(const section of doc.sections){
    const nav=nodeText('button',null,STRUCTURE_SECTIONS[section.id],index);nav.type='button';nav.setAttribute('aria-controls',`structure-section-${section.id}`);nav.onclick=()=>document.getElementById(nav.getAttribute('aria-controls'))?.scrollIntoView({behavior:'smooth',block:'start'});
    const area=el('section','structure-section');area.id=`structure-section-${section.id}`;nodeText('small',null,STRUCTURE_SECTIONS[section.id].toUpperCase(),area);
    area.append(structureBlockElement('h2',{id:`heading-${section.id}`,text:section.title},active));
    const content=reviewSurface(el('div','structure-review-text'));for(const block of section.blocks)content.append(structureBlockElement('p',block,active));area.append(content);
    for(const visual of section.visuals||[])area.append(renderStructureVisual(visual,true));reader.append(area);
  }
  const tail=el('section','structure-review-tail');nodeText('h2',null,'意见处理与版本记录',tail);
  if(doc.responses?.length){for(const item of doc.responses){const c=state.comments.find(c=>c.id===item.comment_id);const row=el('p');nodeText('b',null,c?`回应原稿意见：${c.body}`:`意见 ${item.comment_id}`,row);nodeText('span',null,item.explanation,row);if(c){const back=nodeText('button',null,'查看原稿意见',row);back.type='button';back.onclick=()=>locateComment(c)}tail.append(row)}}
  else nodeText('p',null,'本稿尚无关联意见处理说明。',tail);
  const allOpen=state.comments.filter(c=>c.target_object_id==='story-structure'&&c.status==='OPEN');nodeText('p',null,`待决意见 ${allOpen.length} 条；新稿不会自动关闭原稿意见。`,tail);
  const overall=nodeText('button',null,'添加整体意见',tail);overall.type='button';overall.onclick=()=>startDraft({type:'global'});
  reader.append(tail);paintStructureRegions();watchStructureIndex();
}
async function chooseStructureDirection(id){
  const current=state.structure.selection;
  if(current?.payload.source_id===id)return toast('当前已选择这个方向');
  const dialog=document.createElement('dialog');dialog.className='structure-confirm-dialog';
  nodeText('h2',null,`选择「${structureSourceTitle(id)}」`,dialog);
  nodeText('p',null,current?'旧结构稿仍保留原方向依据；页面会提示重新核对，Codex 需基于新方向导入完整新稿。':'系统会保存该方向当前的准确资料修订，供 Codex 起草结构初稿。',dialog);
  const actions=el('div'),cancel=nodeText('button',null,'返回',actions);cancel.type='button';cancel.onclick=()=>dialog.close();
  const commit=nodeText('button','primary','选择这个方向',actions);commit.type='button';commit.onclick=async()=>{
    commit.disabled=true;
    try{await api('/api/story-structure/select-direction',{method:'POST',body:JSON.stringify({source_id:id,expected_version:current?.version||0})});state.structure=await api('/api/story-structure');dialog.close();renderStructureReader();toast('方向选择已保存，等待 Codex 起草结构稿')}
    catch(error){commit.disabled=false;toast(error.message)}
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
document.addEventListener('pointerdown',event=>{const stage=event.target.closest('.structure-visual-stage');if(!stage||stage.dataset.visualId!==state.drawMode)return;event.preventDefault();const overlay=stage.querySelector('svg');overlay.setPointerCapture(event.pointerId);structureDrawing={stage,visual:state.drawMode,points:[structurePoint(event,stage)],rect:event.shiftKey,pointer:event.pointerId};paintStructureRegions()});
document.addEventListener('pointermove',event=>{if(!structureDrawing||event.pointerId!==structureDrawing.pointer)return;const stage=structureDrawing.stage;const point=structurePoint(event,stage),last=structureDrawing.points.at(-1);if(Math.hypot(point.x-last.x,point.y-last.y)<.002)return;structureDrawing.points.push(point);if(structureDrawing.points.length>260)structureDrawing.points=structureDrawing.points.filter((_,i)=>i%2===0);paintStructureRegions()});
document.addEventListener('pointerup',event=>{if(!structureDrawing||event.pointerId!==structureDrawing.pointer)return;const drawing=structureDrawing,stage=drawing.stage,visual=(isProduction()?productionVisuals():structureVisuals(structureRevision().payload)).find(v=>v.id===drawing.visual);drawing.points.push(structurePoint(event,stage));structureDrawing=null;state.drawMode=null;stage.classList.remove('drawing');let points=drawing.points;if(drawing.rect)points=structureRect(points[0],points.at(-1));const xs=points.map(p=>p.x),ys=points.map(p=>p.y),width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);if(width<.008||height<.008){toast('圈选区域太小，请重新拖动');paintStructureRegions();return}if(points.length<4||structureArea(points)<width*height*.06)points=structureRect({x:Math.min(...xs),y:Math.min(...ys)},{x:Math.max(...xs),y:Math.max(...ys)});points=points.map(p=>({x:Math.round(p.x*10000)/10000,y:Math.round(p.y*10000)/10000}));startDraft({type:'region',visual_id:visual.id,asset_file:visual.file,points});paintStructureRegions()});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.drawMode){state.drawMode=null;structureDrawing=null;document.querySelectorAll('.structure-visual-stage').forEach(s=>s.classList.remove('drawing'));paintStructureRegions()}});
document.addEventListener('scroll',scheduleStructureIndex,{capture:true,passive:true});
window.addEventListener('resize',scheduleStructureIndex);
window.addEventListener('DOMContentLoaded',()=>{$('#open-story-sources').onclick=()=>switchWorkspace('story.sources');$('#open-story-structure').onclick=()=>switchWorkspace('story.outline')});
