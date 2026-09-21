const state={sources:[],comments:[],current:null,anchor:null,editing:null,selected:null,historyOpen:false,historyLimit:20,suggestion:null};
const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node};
const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data};
const chars=text=>Array.from(text);
const toast=message=>{const node=$('#toast');node.textContent=message;node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),3500)};
const draftKey=()=>state.anchor?`review-draft:${state.current.id}:${state.editing||'new'}:${JSON.stringify(state.anchor)}`:null;
const escapeSelector=value=>CSS.escape(value);

function nodeText(tag,cls,text,parent){const node=el(tag,cls,text);parent.append(node);return node}
function link(label,url,parent){const a=el('a',null,label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);return a}

function renderSources(){
  const nav=$('#source-list');nav.replaceChildren();
  for(const source of state.sources){
    const button=el('button','source-button'+(source.id===state.current?.id?' active':''));button.type='button';
    nodeText('small',null,source.version_type,button);nodeText('strong',null,source.title,button);nodeText('span','sub',source.origin,button);
    button.addEventListener('click',()=>chooseSource(source.id));nav.append(button);
  }
  $('#source-count').textContent=`${state.sources.length} 份资料`;
}

function blockMarks(source,block,index){
  const out=[];
  for(const comment of state.comments.filter(c=>c.source_id===source.id)){
    const a=comment.anchor,first=source.blocks.findIndex(b=>b.id===a.block_id),last=source.blocks.findIndex(b=>b.id===a.end_block_id);
    if(first<0||last<first||index<first||index>last)continue;
    const start=index===first?a.start:0,end=index===last?a.end:chars(block.text).length;
    if(start<end)out.push({start,end,comment});
  }
  return out;
}

function renderBlock(source,block,index){
  const p=el('p');p.dataset.blockId=block.id;p.id=`block-${block.id}`;
  const marks=blockMarks(source,block,index),length=chars(block.text).length;
  const cuts=new Set([0,length]);for(const m of marks){cuts.add(m.start);cuts.add(m.end)}
  const ordered=[...cuts].sort((a,b)=>a-b),letters=chars(block.text);
  for(let i=0;i<ordered.length-1;i++){
    const start=ordered[i],end=ordered[i+1],active=marks.filter(m=>m.start<=start&&m.end>=end);
    if(!active.length){p.append(document.createTextNode(letters.slice(start,end).join('')));continue}
    const mark=el('span','comment-mark'+(active.every(m=>m.comment.status==='CLOSED')?' closed':'')+(active.some(m=>m.comment.id===state.selected)?' selected':''),letters.slice(start,end).join(''));
    mark.dataset.commentIds=active.map(m=>m.comment.id).join(' ');
    mark.title=active.map(m=>m.comment.body).join(' / ');
    mark.addEventListener('click',()=>{if(!window.getSelection()?.isCollapsed)return;selectComment(active[0].comment.id)});
    p.append(mark);
  }
  return p;
}

function renderDocument(){
  const source=state.current,root=$('#source-view');root.replaceChildren();if(!source)return;
  const doc=el('article','document');nodeText('div','overline','SOURCE DOCUMENT / 资料原文',doc);
  nodeText('h2',null,source.title,doc);nodeText('span','type-pill',source.version_type,doc);
  const meta=el('div','source-meta');
  for(const [label,value] of [['出处',source.origin],['采集日期',source.collected_at],['版本说明',source.edition||'—']]){const item=el('div');nodeText('b',null,label,item);nodeText('span',null,value,item);meta.append(item)}
  const item=el('div');nodeText('b',null,'原始链接',item);link('打开来源页面 ↗',source.source_url,item);meta.append(item);doc.append(meta);
  nodeText('p','intro',source.notes,doc);nodeText('h3','section-title',source.text_heading||'完整文本',doc);
  const text=el('section','source-text');text.id='source-text';text.setAttribute('aria-label','资料正文');
  source.blocks.forEach((block,index)=>text.append(renderBlock(source,block,index)));doc.append(text);
  if(source.assets.length){nodeText('h3','section-title','图片与出处',doc);const gallery=el('section','image-grid');
    for(const asset of source.assets){const figure=el('figure'),img=el('img');img.src=`/assets/${encodeURIComponent(asset.file)}`;img.alt=asset.alt||asset.title;figure.append(img);
      const caption=el('figcaption');nodeText('strong',null,asset.title,caption);caption.append(document.createElement('br'));nodeText('span',null,asset.note+' ',caption);link('图片来源／制作依据 ↗',asset.source_url,caption);figure.append(caption);gallery.append(figure)}doc.append(gallery)}
  root.append(doc);
  text.addEventListener('mouseup',scheduleSelection);text.addEventListener('keyup',scheduleSelection);
}

function chooseSource(id,keepScroll=false){
  state.current=state.sources.find(s=>s.id===id)||state.sources[0];state.anchor=null;state.editing=null;state.selected=null;
  $('#selection-action').hidden=true;
  const url=new URL(location.href);url.searchParams.set('source',state.current.id);history.replaceState(null,'',url);
  renderSources();renderDocument();renderComments();if(!keepScroll)$('#reader').scrollTop=0;
}

function closestBlock(node){const element=node.nodeType===Node.ELEMENT_NODE?node:node.parentElement;return element?.closest('[data-block-id]')}
function offsetIn(block,node,offset){const range=document.createRange();range.selectNodeContents(block);range.setEnd(node,offset);return chars(range.toString()).length}
function selectedAnchor(){
  const selection=getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
  const range=selection.getRangeAt(0),startBlock=closestBlock(range.startContainer),endBlock=closestBlock(range.endContainer),host=$('#source-text');
  if(!startBlock||!endBlock||!host.contains(startBlock)||!host.contains(endBlock))return null;
  const blocks=state.current.blocks,first=blocks.findIndex(b=>b.id===startBlock.dataset.blockId),last=blocks.findIndex(b=>b.id===endBlock.dataset.blockId);
  if(first<0||last<first)return null;
  const start=offsetIn(startBlock,range.startContainer,range.startOffset),end=offsetIn(endBlock,range.endContainer,range.endOffset);
  if(first===last&&end<=start)return null;
  const pieces=blocks.slice(first,last+1).map(b=>chars(b.text));pieces[0]=pieces[0].slice(start);pieces[pieces.length-1]=pieces.length===1?chars(blocks[first].text).slice(start,end):pieces[pieces.length-1].slice(0,end);
  const quote=pieces.map(p=>p.join('')).join('\n');if(!quote.trim())return null;
  return {block_id:blocks[first].id,end_block_id:blocks[last].id,start,end,quote};
}
function scheduleSelection(){setTimeout(()=>{const anchor=selectedAnchor(),button=$('#selection-action');if(!anchor){button.hidden=true;return}state.pending=anchor;const box=getSelection().getRangeAt(0).getBoundingClientRect();button.style.left=`${Math.max(8,Math.min(innerWidth-145,box.left+box.width/2-65))}px`;button.style.top=`${Math.max(8,box.top-43)}px`;button.hidden=false},0)}

function openPanel(){const panel=$('#comment-panel');panel.hidden=false;$('#comments-toggle').setAttribute('aria-expanded','true')}
function closePanel(){$('#comment-panel').hidden=true;$('#comments-toggle').setAttribute('aria-expanded','false')}
function startDraft(anchor,comment=null){state.anchor=anchor;state.editing=comment?.id||null;state.selected=comment?.id||null;state.suggestion=null;getSelection()?.removeAllRanges();$('#selection-action').hidden=true;openPanel();renderDocument();renderComments();$('#comment-editor-text')?.focus()}

function commentCard(comment){
  const card=el('article','comment-card'+(state.selected===comment.id?' selected':''));card.id=`comment-${comment.id}`;
  nodeText('small',null,(comment.status==='OPEN'?'待处理':'已关闭')+` · ${new Date(comment.updated_at).toLocaleString('zh-CN')}`,card);
  nodeText('q',null,comment.anchor.quote,card);nodeText('p',null,comment.body,card);
  const actions=el('div','card-actions');
  const locate=nodeText('button',null,'定位原圈选',actions);locate.onclick=()=>locateComment(comment);
  if(comment.status==='OPEN'){
    const edit=nodeText('button',null,'编辑',actions);edit.onclick=()=>startDraft(comment.anchor,comment);
    const close=nodeText('button',null,'关闭评论',actions);close.onclick=()=>changeComment(comment,'CLOSE');
  }else{const reopen=nodeText('button',null,'重新打开',actions);reopen.onclick=()=>changeComment(comment,'REOPEN')}
  card.append(actions);return card;
}

function renderComments(){
  if(!state.current)return;const body=$('#comment-body');body.replaceChildren();
  const own=state.comments.filter(c=>c.source_id===state.current.id),open=own.filter(c=>c.status==='OPEN'),closed=own.filter(c=>c.status==='CLOSED');
  $('#open-count').textContent=`${open.length} 待处理`;$('#comments-toggle').textContent=`查看评论 · ${open.length}`;
  nodeText('p','comment-help','选中正文后添加评论。评论锚点绑定资料与原文区间；关闭后仍保留历史，可重新打开。',body);
  if(state.anchor){const editor=el('section','comment-editor');nodeText('strong',null,state.editing?'编辑评论':'添加新评论',editor);nodeText('q',null,state.anchor.quote,editor);
    const label=nodeText('label',null,'修改意见',editor);label.htmlFor='comment-editor-text';const textarea=el('textarea');textarea.id='comment-editor-text';textarea.value=localStorage.getItem(draftKey())??(state.editing?state.comments.find(c=>c.id===state.editing)?.body||'':'');
    textarea.addEventListener('input',()=>localStorage.setItem(draftKey(),textarea.value));editor.append(textarea);
    const actions=el('div','editor-actions'),save=nodeText('button','primary',state.editing?'保存修改':'提交评论',actions);save.onclick=saveComment;
    const polish=nodeText('button',null,'AI 润色修改意见',actions);polish.onclick=polishComment;
    const cancel=nodeText('button',null,'取消',actions);cancel.onclick=()=>{localStorage.removeItem(draftKey());state.anchor=null;state.editing=null;state.suggestion=null;renderDocument();renderComments()};editor.append(actions);
    if(state.suggestion){const preview=el('section','suggestion');nodeText('strong',null,'AI 建议 · 尚未保存',preview);nodeText('p',null,state.suggestion,preview);
      const apply=nodeText('button','secondary','采用到草稿',preview);apply.onclick=()=>{const accepted=state.suggestion;state.suggestion=null;localStorage.setItem(draftKey(),accepted);renderComments()};editor.append(preview)}body.append(editor)}
  nodeText('h3',null,`未关闭评论 · ${open.length}`,body);if(!open.length)nodeText('p','empty','暂无待处理评论。圈选原文即可添加。',body);
  for(const comment of open)body.append(commentCard(comment));
  const head=el('div','history-head');nodeText('h3',null,`已关闭评论 · ${closed.length}`,head);
  const toggle=nodeText('button',null,state.historyOpen?'收起历史':'展开历史',head);toggle.onclick=()=>{state.historyOpen=!state.historyOpen;renderComments()};body.append(head);
  if(state.historyOpen){for(const comment of closed.slice(0,state.historyLimit))body.append(commentCard(comment));if(closed.length>state.historyLimit){const more=nodeText('button','secondary','显示更多',body);more.onclick=()=>{state.historyLimit+=20;renderComments()}}}
}

async function refreshComments(){state.comments=await api('/api/comments');renderDocument();renderComments()}
async function saveComment(){
  const text=$('#comment-editor-text').value.trim();if(!text)return toast('请先填写修改意见');
  try{
    if(state.editing){const c=state.comments.find(x=>x.id===state.editing);await api(`/api/comments/${c.id}`,{method:'PATCH',body:JSON.stringify({action:'EDIT',expected_version:c.version,body:text})})}
    else{await api('/api/comments',{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),source_id:state.current.id,anchor:state.anchor,body:text})})}
    localStorage.removeItem(draftKey());
    state.anchor=null;state.editing=null;state.suggestion=null;await refreshComments();toast('评论已保存');
  }catch(error){toast(error.message)}
}
async function polishComment(){
  const text=$('#comment-editor-text').value.trim();if(!text)return toast('请先填写修改意见');
  try{const result=await api('/api/comments/polish',{method:'POST',body:JSON.stringify({source_id:state.current.id,anchor:state.anchor,body:text})});state.suggestion=result.suggestion;renderComments();$('#comment-editor-text').value=text;toast('润色建议已生成，原草稿未修改')}
  catch(error){toast(error.message)}
}
async function changeComment(comment,action){try{await api(`/api/comments/${comment.id}`,{method:'PATCH',body:JSON.stringify({action,expected_version:comment.version})});await refreshComments();toast(action==='CLOSE'?'评论已关闭':'评论已重新打开')}catch(error){toast(error.message)}}
function selectComment(id){state.selected=id;openPanel();renderDocument();renderComments();setTimeout(()=>$('#comment-'+escapeSelector(id))?.scrollIntoView({block:'nearest'}),0)}
function locateComment(comment){state.selected=comment.id;renderDocument();renderComments();const block=$('#block-'+escapeSelector(comment.anchor.block_id));block?.scrollIntoView({behavior:'smooth',block:'center'});block?.focus?.()}

async function init(){try{
  const [instance,sources,comments]=await Promise.all([api('/api/instance'),api('/api/sources'),api('/api/comments')]);
  $('#instance-title').textContent=instance.title;document.title=`${instance.title} · 原始资料审阅台`;state.sources=sources;state.comments=comments;
  chooseSource(new URL(location.href).searchParams.get('source')||sources[0]?.id,true);
  $('#comments-toggle').onclick=()=>$('#comment-panel').hidden?openPanel():closePanel();$('#comments-close').onclick=closePanel;
  $('#selection-action').addEventListener('mousedown',event=>event.preventDefault());$('#selection-action').onclick=()=>{if(state.pending)startDraft(state.pending)};
  window.addEventListener('focus',()=>refreshComments().catch(()=>{}));
}catch(error){$('#source-view').textContent=`加载失败：${error.message}`}}
init();
