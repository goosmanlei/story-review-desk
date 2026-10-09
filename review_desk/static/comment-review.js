/* Read-only evidence navigation. The existing comment ledger owns every decision. */
const commentReviewReads=new Map();
let commentReviewDialog=null;
function commentReviewTarget(){
  return isStructure()?{object_id:'story-structure',revision_id:state.structureRevision}:
    state.workspace==='story.sources'&&state.current?{object_id:state.current.id,revision_id:state.current.target_revision_id}:null;
}
function commentReviewURL(target,content=false){return '/api/comment-review'+(content?'/content':'')+'?'+new URLSearchParams(target)}
function commentReviewData(target){
  const key=JSON.stringify(target);
  if(!commentReviewReads.has(key))commentReviewReads.set(key,api(commentReviewURL(target)).catch(error=>{commentReviewReads.delete(key);throw error}));
  return commentReviewReads.get(key);
}
function reviewRevisionLabel(ref){return ref.unavailable?'准确稿件已不可用':ref.object_id==='story-structure'?`结构第 ${ref.version} 稿`:ref.title}
function currentReviewComment(row){return state.comments.find(c=>c.id===row.comment.id)||row.comment}
function appendCrossVersionReview(body){
  const target=commentReviewTarget();if(!target||state.reviewCommentScope)return;
  const section=el('section','cross-version-comments');body.append(section);
  commentReviewData(target).then(data=>{
    if(!section.isConnected||JSON.stringify(commentReviewTarget())!==JSON.stringify(target))return;
    const historical=data.reviews.filter(row=>row.original.object_id!==target.object_id||row.original.revision_id!==target.revision_id);
    if(!historical.length){section.remove();return}
    const pending=historical.filter(row=>currentReviewComment(row).status==='OPEN');
    const answered=pending.filter(row=>row.responses.length).length;
    const details=el('details');details.open=!activeComments().length;
    nodeText('summary',null,`历史意见复核 · ${pending.length} 未关闭`,details);
    nodeText('p','comment-help',`${answered} 条可查作者回应。未关闭表示仍待人工决定；未登记依据不能证明没有修改。`,details);
    const list=el('div','cross-version-list');details.append(list);
    const add=row=>{
      const comment=currentReviewComment(row),card=el('article','cross-version-row');
      nodeText('small',null,`${comment.business_code||'原意见'} · ${reviewRevisionLabel(row.original)} · ${comment.status==='OPEN'?'未关闭':'已关闭'}`,card);
      nodeText('p',null,comment.body,card);
      const review=nodeText('button',null,row.responses.length?'复核回应与改动':'查看原意见与证据缺口',card);
      review.onclick=()=>openCommentReview(row,data.context,review);list.append(card);
    };
    pending.forEach(add);
    const closed=historical.filter(row=>currentReviewComment(row).status==='CLOSED');
    if(closed.length){const history=el('details');nodeText('summary',null,`已关闭历史意见 · ${closed.length}`,history);for(const row of closed){add(row);history.append(list.lastChild)}details.append(history)}
    section.append(details);
  }).catch(error=>{if(section.isConnected)nodeText('p','structure-alert',`历史依据读取失败：${error.message}`,section)});
}
function appendCommentReviewAction(card,comment){
  const target=commentReviewTarget();if(!target)return;
  commentReviewData(target).then(data=>{
    const row=data.reviews.find(row=>row.comment.id===comment.id);
    if(!row||!row.responses.length||!card.isConnected)return;
    const button=nodeText('button',null,'复核回应与改动',card.querySelector('.card-actions'));
    button.onclick=()=>openCommentReview(row,data.context,button);
  }).catch(()=>{});
}

async function openCommentReview(row,context,trigger){
  commentReviewDialog?.close();
  const dialog=document.createElement('dialog');dialog.className='comment-review-dialog';dialog.setAttribute('aria-label',`复核 ${currentReviewComment(row).business_code||'旧意见'}`);
  const header=el('header');nodeText('h2',null,`复核 ${currentReviewComment(row).business_code||'旧意见'}`,header);
  const back=nodeText('button',null,'返回阅读位置',header);back.onclick=()=>dialog.close();dialog.append(header);
  nodeText('p','comment-help',`从「${reviewRevisionLabel(context)}」进入。作者回应与人工关闭分别保存。`,dialog);
  const navigation=el('nav','comment-review-navigation');navigation.setAttribute('aria-label','复核步骤');dialog.append(navigation);
  const body=el('div','comment-review-body');dialog.append(body);
  const decision=el('section','comment-review-decision');dialog.append(decision);
  const notice=nodeText('p','structure-alert','',dialog);notice.hidden=true;notice.setAttribute('role','alert');
  let read=0;
  const showDecision=()=>{
    decision.replaceChildren();const comment=currentReviewComment(row);
    nodeText('h3',null,`${comment.business_code||'原意见'} · ${comment.status==='OPEN'?'尚未关闭':'已关闭'}`,decision);
    nodeText('q',null,anchorLabel(comment.anchor),decision);nodeText('p',null,comment.body,decision);
    const actions=el('div','card-actions');decision.append(actions);
    const original=nodeText('button',null,'回原意见',actions);original.onclick=()=>{activate(originalStep);showOriginal()};
    const close=nodeText('button',null,comment.status==='OPEN'?'关闭评论':'重新打开',actions);
    close.disabled=commentChanges.has(comment.id);
    close.onclick=()=>changeComment(comment,comment.status==='OPEN'?'CLOSE':'REOPEN');
    const keep=nodeText('button',null,'保留当前决定并返回',actions);keep.onclick=()=>dialog.close();
  };
  const showContent=async(ref,anchor,label)=>{
    const epoch=++read;body.replaceChildren();nodeText('p',null,'正在读取准确稿件…',body);
    try{
      const data=await api(commentReviewURL({object_id:ref.object_id,revision_id:ref.revision_id},true));
      if(epoch!==read||!dialog.open)return;
      body.replaceChildren();nodeText('h3',null,`${label} · ${reviewRevisionLabel(ref)}`,body);
      renderCommentReviewContent(body,data.record,anchor);
      body.querySelector('mark')?.scrollIntoView({block:'center',behavior:'instant'});
    }catch(error){if(epoch===read&&dialog.open){body.replaceChildren();nodeText('p','structure-alert',error.message,body)}}
  };
  const activate=b=>{for(const n of navigation.children)n.setAttribute('aria-pressed',String(n===b))};
  const button=(label,action)=>{const b=nodeText('button',null,label,navigation);b.onclick=()=>{activate(b);action()};return b};
  const showOriginal=()=>showContent(row.original,currentReviewComment(row).anchor,'原圈选');
  const originalStep=button('原圈选',showOriginal);activate(originalStep);
  row.responses.forEach((response,index)=>{
    button(`作者回应 · ${reviewRevisionLabel(response.response)}`,()=>{
      ++read;body.replaceChildren();nodeText('h3',null,`作者回应 · ${reviewRevisionLabel(response.response)}`,body);
      if(response.decision)nodeText('strong',null,response.decision,body);
      nodeText('p',null,response.explanation,body);
      nodeText('p','comment-help',row.current_evidence.length?'当前所读稿有准确内容依据可核对，是否满足意见仍由你决定。':'未登记当前稿保留修改的依据；曾有回应不能证明当前稿仍满足意见。',body);
      if(response.provenance){const source=el('details');nodeText('summary',null,'处理依据来源',source);nodeText('p',null,response.provenance.file,source);nodeText('code',null,response.provenance.sha256,source);body.append(source)}
      const open=nodeText('button',null,'阅读回应所针对的稿件',body);open.onclick=()=>showContent(response.response,null,'回应稿');
    });
    for(const evidence of response.evidence||[]){
      const b=button(evidence.label,()=>showContent(evidence,evidence.anchor,evidence.reason||'改动依据'));
      b.disabled=evidence.anchor_state?.valid===false;
      if(b.disabled){b.textContent+='（引用不可用）';b.title='准确引用已不可用，未替换为其他稿件'}
    }
  });
  if(!row.responses.length)nodeText('p','comment-help','尚无可用作者处理记录。没有记录不能证明没有修改。',dialog);
  dialog.reviewRefresh=showDecision;
  dialog.reviewError=message=>{notice.textContent=message||'';notice.hidden=!message};
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation()});
  dialog.addEventListener('close',()=>{++read;dialog.remove();if(commentReviewDialog===dialog)commentReviewDialog=null;trigger?.isConnected&&trigger.focus({preventScroll:true})});
  document.body.append(dialog);commentReviewDialog=dialog;dialog.showModal();showDecision();await showOriginal();
}

function renderCommentReviewContent(root,record,anchor){
  const doc=record.payload;
  const blocks=record.kind==='SOURCE'?doc.blocks:structureBlocks(doc);
  const visuals=record.kind==='SOURCE'?(doc.assets||[]).map(a=>({...a,id:a.file})):structureVisuals(doc);
  const focus=el('section','comment-review-exact');root.append(focus);
  if(anchor?.type==='visual'||anchor?.type==='region'){
    const visual=visuals.find(v=>v.id===anchor.visual_id&&(!anchor.asset_file||v.file===anchor.asset_file));
    if(!visual){nodeText('p','structure-alert','准确原图已不可用；未替换为新图。',focus);return}
    appendReviewVisual(focus,visual,anchor);
  }else{
    const start=anchor?.block_id?blocks.findIndex(b=>b.id===anchor.block_id):0;
    const end=anchor?.block_id?blocks.findIndex(b=>b.id===(anchor.end_block_id||anchor.block_id)):blocks.length-1;
    if(start<0||end<start){nodeText('p','structure-alert','准确正文位置已不可用；未查找相似句替代。',focus);return}
    for(let i=start;i<=end;i++){
      const block=blocks[i],p=nodeText('p',null,'',focus);p.dataset.reviewBlock=block.id;
      const text=Array.from(block.text),from=anchor?.type==='text'?(i===start?anchor.start:0):0,to=anchor?.type==='text'?(i===end?anchor.end:text.length):0;
      const left=anchor?.type==='text'?Math.max(0,from-200):0,right=anchor?.type==='text'?Math.min(text.length,to+200):text.length;
      p.append(document.createTextNode((left?'…':'')+text.slice(left,from).join('')));
      if(to>from)nodeText('mark',null,text.slice(from,to).join(''),p);
      p.append(document.createTextNode(text.slice(to||from,right).join('')+(right<text.length?'…':'')));
    }
  }
  if(anchor){const full=el('details','comment-review-full');nodeText('summary',null,'阅读这份准确稿件的完整图文',full);full.addEventListener('toggle',()=>{if(!full.open||full.dataset.loaded)return;full.dataset.loaded='true';for(const block of blocks)nodeText('p',null,block.text,full);for(const visual of visuals)appendReviewVisual(full,visual)});root.append(full)}
}
function appendReviewVisual(root,visual,anchor){
  const figure=el('figure'),frame=el('div','comment-review-image'),img=el('img');
  img.src=reviewURL('/assets/'+encodeURIComponent(visual.file));img.alt=visual.alt||visual.title;frame.append(img);
  img.addEventListener('error',()=>{nodeText('p','structure-alert','准确原图文件不可用；未替换为其他图像。',frame)});
  if(anchor?.type==='region'){
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1 1');svg.setAttribute('preserveAspectRatio','none');
    const polygon=document.createElementNS(svg.namespaceURI,'polygon');polygon.setAttribute('points',anchor.points.map(p=>`${p.x},${p.y}`).join(' '));svg.append(polygon);frame.append(svg);
  }
  if(anchor)frame.classList.add('original-selection');figure.append(frame);nodeText('figcaption',null,visual.title,figure);nodeText('p',null,visual.description||visual.note||'',figure);root.append(figure);
}
