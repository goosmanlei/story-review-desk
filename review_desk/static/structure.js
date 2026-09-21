/* Story structure reader. Review records use the shared comment panel and API in app.js. */
const STRUCTURE_SECTIONS={theme:'方向与主题',characters:'人物塑造',relationships:'人物关系',spaces:'空间关系',storylines:'故事线',timeline:'时间线'};
let structureDrawing=null;
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
  const cuts=[...new Set([0,letters.length,...marks.flatMap(m=>[m.start,m.end])])].sort((a,b)=>a-b),fragment=document.createDocumentFragment();
  for(let i=0;i<cuts.length-1;i++){
    const start=cuts[i],end=cuts[i+1],active=marks.filter(m=>m.start<=start&&m.end>=end),text=letters.slice(start,end).join('');
    if(!active.length)fragment.append(document.createTextNode(text));
    else{const mark=el('span','comment-mark'+(active.every(m=>m.comment.status==='CLOSED')?' closed':''),text);mark.title=active.map(m=>m.comment.body).join(' / ');mark.onclick=()=>{if(getSelection()?.isCollapsed)selectComment(active[0].comment.id)};fragment.append(mark)}
  }
  return fragment;
}
function structureBlockElement(tag,block,revision){const node=el(tag,'structure-text-block');node.dataset.structureBlock=block.id;node.append(structureMarkParts(block,revision));return node}
function drawPolygon(points,cls){const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');polygon.setAttribute('points',points.map(p=>`${p.x*100},${p.y*100}`).join(' '));polygon.setAttribute('class',cls);return polygon}
function paintStructureRegions(){
  document.querySelectorAll('.structure-visual-stage').forEach(stage=>{
    const svg=stage.querySelector('svg');svg.replaceChildren();const visual=stage.dataset.visualId;
    for(const comment of activeComments().filter(c=>c.anchor.type==='region'&&c.anchor.visual_id===visual)){
      const polygon=drawPolygon(comment.anchor.points,'review-region'+(comment.status==='CLOSED'?' closed':''));polygon.onclick=()=>selectComment(comment.id);svg.append(polygon);
    }
    if(structureDrawing?.visual===visual)svg.append(drawPolygon(structureDrawing.points,'review-region drawing'));
  });
}
function renderStructureVisual(visual){
  const figure=el('figure','structure-figure'),head=el('div','structure-figure-head');
  nodeText('strong',null,visual.title,head);nodeText('span',null,visual.kind==='diagram'?'结构图':'图片',head);figure.append(head);
  const viewport=el('div','structure-visual-viewport'),stage=el('div','structure-visual-stage');stage.dataset.visualId=visual.id;
  const img=el('img');img.src=`/assets/${encodeURIComponent(visual.file)}`;img.alt=visual.alt;stage.append(img);
  const overlay=document.createElementNS('http://www.w3.org/2000/svg','svg');overlay.setAttribute('viewBox','0 0 100 100');overlay.setAttribute('preserveAspectRatio','none');overlay.classList.add('structure-overlay');stage.append(overlay);
  viewport.append(stage);figure.append(viewport);nodeText('figcaption',null,visual.description,figure);
  const actions=el('div','structure-visual-actions');const region=nodeText('button',null,'圈选评论',actions);region.type='button';region.onclick=()=>{state.drawMode=visual.id;document.querySelectorAll('.structure-visual-stage').forEach(s=>s.classList.toggle('drawing',s.dataset.visualId===visual.id));toast('在图上拖动圈选；按 Shift 可画矩形')};
  const whole=nodeText('button',null,'评论整图',actions);whole.type='button';whole.onclick=()=>startDraft({type:'visual',visual_id:visual.id,asset_file:visual.file});figure.append(actions);return figure;
}
function renderStructureReader(){
  if(!state.structure)return;
  const status=$('#structure-status'),index=$('#structure-index'),reader=$('#structure-reader');status.replaceChildren();index.replaceChildren();reader.replaceChildren();
  const selection=state.structure.selection,active=structureRevision();
  if(!selection){
    const box=el('section','structure-empty');nodeText('h2',null,'先选择一个改编方向',box);nodeText('p',null,'方向由你在故事采编的三个候选中选择。选择后，Codex 才能据此导入结构初稿。',box);
    for(const source of state.sources.filter(s=>s.group==='expansion-directions')){
      const button=nodeText('button',null,source.title,box);button.type='button';button.onclick=()=>chooseStructureDirection(source.id);
    }
    status.append(box);return;
  }
  const basis=el('section','structure-basis');nodeText('small',null,'已选改编方向 · 精确资料修订',basis);nodeText('strong',null,structureSourceTitle(selection.payload.source_id),basis);
  nodeText('code',null,selection.payload.source_revision.slice(0,16),basis);
  const sourceButton=nodeText('button',null,'回看方向全文',basis);sourceButton.type='button';sourceButton.onclick=()=>{switchWorkspace('story.sources');chooseSource(selection.payload.source_id)};
  const change=el('details');nodeText('summary',null,'重新选择方向',change);for(const source of state.sources.filter(s=>s.group==='expansion-directions')){const button=nodeText('button',null,source.title,change);button.type='button';button.onclick=()=>chooseStructureDirection(source.id)}basis.append(change);status.append(basis);
  if(state.structure.direction_changed){const alert=nodeText('p','structure-alert','所选方向已更新。当前结构稿仍引用原方向修订；请核对并导入针对新方向的完整结构稿。',status);alert.setAttribute('role','alert')}
  const versions=el('div','structure-versions');nodeText('span',null,'阅读版本：',versions);
  for(const revision of state.structure.revisions){const button=nodeText('button',revision.id===state.structureRevision?'active':'',`第 ${revision.version} 稿`,versions);button.type='button';button.onclick=()=>{state.structureRevision=revision.id;state.anchor=null;state.selected=null;renderStructureReader();renderComments()}}
  status.append(versions);
  if(!active){nodeText('p','structure-empty','方向已选定。等待 Codex 通过 structure-import 导入完整图文结构初稿。',status);return}
  const doc=active.payload;
  if(doc.illustrative){nodeText('p','structure-alert','隔离验收示例：内容仅用于验证页面与改稿流程，不是本故事已确认的结构。',status)}
  const confirm=state.structure.confirmations.filter(c=>c.payload.structure_revision===active.id);
  if(confirm.length){nodeText('p','structure-confirmed',`此稿已有 ${confirm.length} 条确认记录；剧本交接锁定具体稿件修订。`,status)}
  const basisSelection=state.structure.selection_history?.find(item=>item.id===doc.direction_selection_revision);
  const basisSource=basisSelection?.payload.source_id;
  const title=el('header','structure-document-head');nodeText('small',null,`STORY STRUCTURE · 第 ${active.version} 稿`,title);nodeText('h2',null,doc.title,title);nodeText('p',null,`本稿依据「${structureSourceTitle(basisSource||'来源未知')}」的修订 ${basisSelection?.payload.source_revision.slice(0,16)||'UNKNOWN'} · ${active.created_at}`,title);reader.append(title);
  for(const section of doc.sections){
    const nav=nodeText('button',null,STRUCTURE_SECTIONS[section.id],index);nav.type='button';nav.onclick=()=>document.getElementById(`structure-section-${section.id}`)?.scrollIntoView({behavior:'smooth',block:'start'});
    const area=el('section','structure-section');area.id=`structure-section-${section.id}`;nodeText('small',null,STRUCTURE_SECTIONS[section.id].toUpperCase(),area);
    area.append(structureBlockElement('h2',{id:`heading-${section.id}`,text:section.title},active));
    for(const block of section.blocks)area.append(structureBlockElement('p',block,active));
    for(const visual of section.visuals||[])area.append(renderStructureVisual(visual));reader.append(area);
  }
  const tail=el('section','structure-review-tail');nodeText('h2',null,'意见处理与版本记录',tail);
  if(doc.responses?.length){for(const item of doc.responses){const c=state.comments.find(c=>c.id===item.comment_id);const row=el('p');nodeText('b',null,c?`回应原稿意见：${c.body}`:`意见 ${item.comment_id}`,row);nodeText('span',null,item.explanation,row);if(c){const back=nodeText('button',null,'查看原稿意见',row);back.type='button';back.onclick=()=>locateComment(c)}tail.append(row)}}
  else nodeText('p',null,'本稿尚无关联意见处理说明。',tail);
  const allOpen=state.comments.filter(c=>c.target_object_id==='story-structure'&&c.status==='OPEN');nodeText('p',null,`待决意见 ${allOpen.length} 条；新稿不会自动关闭原稿意见。`,tail);
  const overall=nodeText('button',null,'添加整体意见',tail);overall.type='button';overall.onclick=()=>startDraft({type:'global'});
  if(active.id===state.structure.current_revision&&!state.structure.direction_changed){const approve=nodeText('button','structure-confirm-button','确认此具体版本，供剧本创作',tail);approve.type='button';approve.onclick=()=>showStructureConfirmation(active)}
  reader.append(tail);paintStructureRegions();reader.onmouseup=()=>setTimeout(captureStructureSelection,0);reader.onkeyup=()=>setTimeout(captureStructureSelection,0);
}
async function chooseStructureDirection(id){
  const current=state.structure.selection;
  if(current?.payload.source_id===id)return toast('当前已选择这个方向');
  const dialog=document.createElement('dialog');dialog.className='structure-confirm-dialog';
  nodeText('h2',null,`选择「${structureSourceTitle(id)}」`,dialog);
  nodeText('p',null,'旧结构稿仍保留原方向依据；页面会提示重新核对，Codex 需基于新方向导入完整新稿。',dialog);
  const actions=el('div'),cancel=nodeText('button',null,'返回',actions);cancel.type='button';cancel.onclick=()=>dialog.close();
  const commit=nodeText('button','primary','选择这个方向',actions);commit.type='button';commit.onclick=async()=>{
    commit.disabled=true;
    try{await api('/api/story-structure/select-direction',{method:'POST',body:JSON.stringify({source_id:id,expected_version:current?.version||0})});state.structure=await api('/api/story-structure');dialog.close();renderStructureReader();toast('方向选择已保存，等待 Codex 起草结构稿')}
    catch(error){commit.disabled=false;toast(error.message)}
  };dialog.append(actions);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
}
function showStructureConfirmation(active){
  const pending=state.comments.filter(c=>c.target_object_id==='story-structure'&&c.status==='OPEN').length;
  const dialog=document.createElement('dialog');dialog.className='structure-confirm-dialog';
  const heading=nodeText('h2',null,`确认第 ${active.version} 稿`,dialog);nodeText('p',null,`确认对象：${active.id}。当前仍有 ${pending} 条待决意见，会随确认记录保留。后续实质调整需要新稿再审阅。`,dialog);
  const name=nodeText('input',null,undefined,dialog);name.placeholder='确认人姓名';name.setAttribute('aria-label','确认人姓名');
  const note=nodeText('textarea',null,undefined,dialog);note.placeholder='确认说明（可选）';note.setAttribute('aria-label','确认说明');
  const check=el('label');const checkbox=el('input');checkbox.type='checkbox';check.append(checkbox,document.createTextNode(' 我已审阅此具体版本及待决意见'));dialog.append(check);
  const actions=el('div');const cancel=nodeText('button',null,'继续审阅',actions);cancel.onclick=()=>dialog.close();const commit=nodeText('button','primary','确认此稿',actions);commit.onclick=async()=>{if(!checkbox.checked||!name.value.trim())return toast('请填写确认人并勾选已审阅');try{await api('/api/story-structure/confirm',{method:'POST',body:JSON.stringify({revision_id:active.id,reviewer:name.value,note:note.value})});state.structure=await api('/api/story-structure');dialog.close();renderStructureReader();toast('具体结构版本已确认')}catch(error){toast(error.message)}};dialog.append(actions);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();heading.focus?.();
}
function captureStructureSelection(){
  if(!isStructure()||state.drawMode)return;const selection=getSelection(),action=$('#selection-action');if(!selection||selection.isCollapsed||!selection.rangeCount){action.hidden=true;return}
  const range=selection.getRangeAt(0),reader=$('#structure-reader'),nodes=[...reader.querySelectorAll('[data-structure-block]')];if(!reader.contains(range.startContainer)||!reader.contains(range.endContainer))return;
  const touched=nodes.filter(node=>range.intersectsNode(node));if(!touched.length)return;
  const first=touched[0],last=touched.at(-1),start=offsetIn(first,range.startContainer,range.startOffset),end=offsetIn(last,range.endContainer,range.endOffset);
  const revision=structureRevision(),blocks=structureBlocks(revision.payload),firstIndex=blocks.findIndex(b=>b.id===first.dataset.structureBlock),lastIndex=blocks.findIndex(b=>b.id===last.dataset.structureBlock);
  if(firstIndex<0||lastIndex<firstIndex||first===last&&end<=start)return;
  const pieces=blocks.slice(firstIndex,lastIndex+1).map(b=>chars(b.text));pieces[0]=pieces[0].slice(start);pieces[pieces.length-1]=pieces.length===1?chars(blocks[firstIndex].text).slice(start,end):pieces[pieces.length-1].slice(0,end);
  const quote=pieces.map(part=>part.join('')).join('\n');if(!quote.trim())return;
  state.pending={type:'text',block_id:first.dataset.structureBlock,end_block_id:last.dataset.structureBlock,start,end,quote};
  const rect=range.getBoundingClientRect();action.style.left=`${Math.max(8,Math.min(innerWidth-145,rect.left))}px`;action.style.top=`${Math.max(8,rect.top-43)}px`;action.hidden=false;
}
function structurePoint(event,stage){const rect=stage.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}}
function structureRect(a,b){return[{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y)},{x:Math.max(a.x,b.x),y:Math.min(a.y,b.y)},{x:Math.max(a.x,b.x),y:Math.max(a.y,b.y)},{x:Math.min(a.x,b.x),y:Math.max(a.y,b.y)}]}
function structureArea(points){return Math.abs(points.reduce((sum,p,i)=>sum+p.x*points[(i+1)%points.length].y-points[(i+1)%points.length].x*p.y,0))/2}
document.addEventListener('pointerdown',event=>{const stage=event.target.closest('.structure-visual-stage');if(!stage||stage.dataset.visualId!==state.drawMode)return;event.preventDefault();const overlay=stage.querySelector('svg');overlay.setPointerCapture(event.pointerId);structureDrawing={visual:state.drawMode,points:[structurePoint(event,stage)],rect:event.shiftKey,pointer:event.pointerId};paintStructureRegions()});
document.addEventListener('pointermove',event=>{if(!structureDrawing||event.pointerId!==structureDrawing.pointer)return;const stage=document.querySelector(`.structure-visual-stage[data-visual-id="${CSS.escape(structureDrawing.visual)}"]`);const point=structurePoint(event,stage),last=structureDrawing.points.at(-1);if(Math.hypot(point.x-last.x,point.y-last.y)<.002)return;structureDrawing.points.push(point);if(structureDrawing.points.length>260)structureDrawing.points=structureDrawing.points.filter((_,i)=>i%2===0);paintStructureRegions()});
document.addEventListener('pointerup',event=>{if(!structureDrawing||event.pointerId!==structureDrawing.pointer)return;const drawing=structureDrawing,stage=document.querySelector(`.structure-visual-stage[data-visual-id="${CSS.escape(drawing.visual)}"]`),visual=structureVisuals(structureRevision().payload).find(v=>v.id===drawing.visual);drawing.points.push(structurePoint(event,stage));structureDrawing=null;state.drawMode=null;stage.classList.remove('drawing');let points=drawing.points;if(drawing.rect)points=structureRect(points[0],points.at(-1));const xs=points.map(p=>p.x),ys=points.map(p=>p.y),width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);if(width<.008||height<.008){toast('圈选区域太小，请重新拖动');paintStructureRegions();return}if(points.length<4||structureArea(points)<width*height*.06)points=structureRect({x:Math.min(...xs),y:Math.min(...ys)},{x:Math.max(...xs),y:Math.max(...ys)});points=points.map(p=>({x:Math.round(p.x*10000)/10000,y:Math.round(p.y*10000)/10000}));startDraft({type:'region',visual_id:visual.id,asset_file:visual.file,points});paintStructureRegions()});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.drawMode){state.drawMode=null;structureDrawing=null;document.querySelectorAll('.structure-visual-stage').forEach(s=>s.classList.remove('drawing'));paintStructureRegions()}});
window.addEventListener('DOMContentLoaded',()=>{$('#open-story-structure').onclick=()=>switchWorkspace('story.outline');$('#back-to-sources').onclick=()=>switchWorkspace('story.sources');$('#structure-comments').onclick=togglePanel});
