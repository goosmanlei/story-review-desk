/* Exact response navigation; the original comment owns its text and anchor. */
const commentReviewReads=new Map();
let commentReviewDialog=null;
function commentReviewTarget(){
  if(typeof isMethodsReading==='function'&&isMethodsReading())return {object_id:methodView.document.record.object_id,revision_id:methodView.document.record.revision_id,file:methodView.document.file};
  if(state.unifiedCardRoot&&state.productionSelected)return productionRef(state.productionSelected);
  return isStructure()?{object_id:'story-structure',revision_id:state.structureRevision}:
    ['story.sources','story.novel'].includes(state.workspace)&&state.current?{object_id:state.current.id,revision_id:state.current.target_revision_id}:
    typeof isProduction==='function'&&isProduction()&&state.productionSelected?productionRef(state.productionSelected):null;
}
function commentReviewURL(target,content=false){return '/api/comment-review'+(content?'/content':'')+'?'+new URLSearchParams(target)}
function commentReviewData(target){
  const key=JSON.stringify(target);
  if(!commentReviewReads.has(key))commentReviewReads.set(key,api(commentReviewURL(target)).finally(()=>commentReviewReads.delete(key)));
  return commentReviewReads.get(key);
}
function reviewRevisionLabel(ref){if(ref.file_version)return ref.file+' · 第 '+ref.file_version+' 版';const label=ref.unavailable?'准确稿件已不可用':ref.object_id==='story-structure'?`结构第 ${ref.version} 稿`:ref.version?`${ref.title} · 修订 ${ref.version}`:ref.title;return label+(ref.file?' · '+ref.file:'')}
function currentReviewComment(row){return state.comments.find(c=>c.id===row.comment.id)||row.comment}
function appendMethodReviewStatus(body){
  const target=commentReviewTarget(),section=el('section');body.append(section);
  const load=()=>{
    section.replaceChildren();nodeText('p','comment-help','正在核对原版本与回应…',section);
    commentReviewData(target).then(()=>{if(section.isConnected&&JSON.stringify(commentReviewTarget())===JSON.stringify(target))section.remove()})
      .catch(error=>{if(!section.isConnected||JSON.stringify(commentReviewTarget())!==JSON.stringify(target))return;section.replaceChildren();nodeText('p','structure-alert','评论依据读取失败：'+error.message,section);const retry=nodeText('button',null,'重试评论依据',section);retry.onclick=()=>renderComments()});
  };load();
}
async function openMethodCommentReview(comment,trigger){
  const target=commentReviewTarget(),data=await commentReviewData(target);
  if(!trigger.isConnected||JSON.stringify(commentReviewTarget())!==JSON.stringify(target))return;
  const row=data.reviews.find(row=>row.comment.id===comment.id);
  if(!row)throw Error('原意见读取失败，请重新读取；未替换其他意见');
  return openCommentReview(row,data.context,trigger);
}
function appendCrossVersionReview(body){
  const target=commentReviewTarget();if(!target||state.reviewCommentScope)return;
  const section=el('section','cross-version-comments');body.append(section);
  commentReviewData(target).then(data=>{
    if(!section.isConnected||JSON.stringify(commentReviewTarget())!==JSON.stringify(target))return;
    const historical=data.reviews.filter(row=>row.original.object_id!==target.object_id||row.original.revision_id!==target.revision_id);
    if(!historical.length){section.remove();return}
    const pending=historical.filter(row=>currentReviewComment(row).status==='OPEN');
    const answered=pending.filter(row=>row.responses.length).length;
    const details=el('section');
    nodeText('h3',null,`历史意见复核 · ${pending.length} 未关闭`,details);
    nodeText('p','comment-help',`${answered} 条可查作者回应。关闭与重开用于整理意见，不限制后续工作。`,details);
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
    if(closed.length){const history=el('section');nodeText('h4',null,`已关闭历史意见 · ${closed.length}`,history);for(const row of closed){add(row);history.append(list.lastChild)}details.append(history)}
    section.append(details);
  }).catch(error=>{if(section.isConnected)nodeText('p','structure-alert',`历史依据读取失败：${error.message}`,section)});
}
function appendCommentReviewAction(card,comment){
  const method=typeof isMethodsReading==='function'&&isMethodsReading();
  const label=method?nodeText('small','comment-original-version','原文件：'+comment.anchor.file+' · 正在核对原版本…',card):null;
  const target=(state.unifiedCardRoot||typeof isProduction==='function'&&isProduction())?{object_id:comment.target_object_id,revision_id:comment.target_revision_id}:commentReviewTarget();if(!target)return;
  commentReviewData(target).then(data=>{
    const row=data.reviews.find(row=>row.comment.id===comment.id);
    if(!row||!card.isConnected||method&&JSON.stringify(commentReviewTarget())!==JSON.stringify(target))return;
    if(label)label.textContent='原稿：'+reviewRevisionLabel(row.original);
    if(!row.responses.length)return;
    const button=nodeText('button',null,'复核回应与改动',card.querySelector('.card-actions'));
    button.onclick=()=>openCommentReview(row,data.context,button);
  }).catch(error=>{if(label&&card.isConnected)label.textContent='原文件：'+comment.anchor.file+' · 原版本读取失败：'+error.message});
}

async function openCommentReview(row,context,trigger){
  commentReviewDialog?.close();
  const position=typeof window!=='undefined'?{x:window.scrollX,y:window.scrollY}:null;
  const dialog=document.createElement('dialog');dialog.className='comment-review-dialog';dialog.setAttribute('aria-label',`复核 ${currentReviewComment(row).business_code||'旧意见'}`);
  const header=el('header');nodeText('h2',null,`复核 ${currentReviewComment(row).business_code||'旧意见'}`,header);
  const back=nodeText('button',null,'返回阅读位置',header);back.onclick=()=>dialog.close();dialog.append(header);
  nodeText('p','comment-help',`从「${reviewRevisionLabel(context)}」进入。`,dialog);
  const navigation=el('nav','comment-review-navigation');navigation.setAttribute('aria-label','复核步骤');dialog.append(navigation);
  const body=el('div','comment-review-body');dialog.append(body);
  const decision=el('section','comment-review-decision');dialog.append(decision);
  const notice=nodeText('p','structure-alert','',dialog);notice.hidden=true;notice.setAttribute('role','alert');
  let read=0;
  const readingTarget=JSON.stringify(commentReviewTarget());
  const ownsRead=epoch=>epoch===read&&dialog.open&&JSON.stringify(commentReviewTarget())===readingTarget;
  const showDecision=()=>{
    decision.replaceChildren();const comment=currentReviewComment(row);
    nodeText('h3',null,`${comment.business_code||'原意见'} · ${comment.status==='OPEN'?'尚未关闭':'已关闭'}`,decision);
    nodeText('q',null,anchorLabel(comment.anchor),decision);nodeText('p',null,comment.body,decision);
    const actions=el('div','card-actions');decision.append(actions);
    const original=nodeText('button',null,'回原意见',actions);original.onclick=()=>{activate(originalStep);showOriginal()};
    const close=nodeText('button',null,comment.status==='OPEN'?'关闭评论':'重新打开',actions);
    close.disabled=commentChanges.has(comment.id);
    close.onclick=()=>changeComment(comment,comment.status==='OPEN'?'CLOSE':'REOPEN');
    if(context.kind==='GUIDANCE'&&typeof appendMethodResponseAction==='function')appendMethodResponseAction(actions,comment,async()=>{
      const target=commentReviewTarget();
      try{const data=await commentReviewData(target);if(!dialog.open||JSON.stringify(target)!==readingTarget||JSON.stringify(commentReviewTarget())!==readingTarget)return;const updated=data.reviews.find(r=>r.comment.id===comment.id);if(updated)openCommentReview(updated,data.context,trigger)}catch(error){if(dialog.open)dialog.reviewError(error.message)}
    });
    const keep=nodeText('button',null,'返回阅读位置',actions);keep.onclick=()=>dialog.close();
  };
  const showContent=async(ref,anchor,label)=>{
    const epoch=++read;body.replaceChildren();nodeText('p',null,'正在读取准确稿件…',body);
    if(ref.production_excerpt){
      body.replaceChildren();nodeText('h3',null,label+' · '+ref.title,body);
      const original=ref.production_excerpt.anchor;for(const a of original?.segments||[original])if(a?.quote)nodeText('blockquote',null,a.quote,body);
      nodeText('p','comment-help',ref.matches_current?'当前内容仍与此处理记录一致。':'当前内容后来已修改；以上是当时保留的局部摘录。',body);
      if(ref.current_reference){const open=nodeText('button',null,'打开当前内容',body);open.onclick=()=>{dialog.close();openUnifiedMaterial(ref.current_reference,trigger)}}
      return;
    }
    try{
      const file=ref.file||anchor?.file;
      const data=await api(commentReviewURL({object_id:ref.object_id,revision_id:ref.revision_id,...(file?{file}:{})},true));
      if(!ownsRead(epoch))return;
      body.replaceChildren();nodeText('h3',null,`${label} · ${reviewRevisionLabel(ref)}`,body);
      renderCommentReviewContent(body,data.record,anchor);
      body.querySelector('mark')?.scrollIntoView({block:'center',behavior:'instant'});
    }catch(error){if(ownsRead(epoch)){body.replaceChildren();nodeText('p','structure-alert',error.message,body);const retry=nodeText('button',null,'重试准确稿件',body);retry.onclick=()=>showContent(ref,anchor,label);if(label==='当前稿'&&ref.file){const all=nodeText('button',null,'阅读当前稿的全部文件',body);all.onclick=()=>showContent({...ref,file:null},null,'当前稿')}}}
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
      const open=nodeText('button',null,'阅读回应所针对的稿件',body);open.onclick=()=>showContent({...response.response,...(context.kind==='GUIDANCE'?{file:response.evidence?.[0]?.anchor?.file||row.original.file}:{})},null,'回应稿');
    });
    for(const evidence of response.evidence||[]){
      const b=button(context.kind==='GUIDANCE'?'回应稿改动 · '+(evidence.anchor?.quote?.slice(0,18)||evidence.label):evidence.label,()=>showContent(evidence,evidence.anchor,evidence.reason||'改动依据'));
      b.disabled=evidence.anchor_state?.valid===false&&!evidence.production_excerpt;
      if(b.disabled){b.textContent+='（引用不可用）';b.title='准确引用已不可用，未替换为其他稿件'}
    }
  });
  if(context.kind==='GUIDANCE')button('当前稿',()=>showContent({...context.latest||context,file:row.original.file},null,'当前稿'));
  if(!row.responses.length)nodeText('p','comment-help',context.kind==='GUIDANCE'?'尚未回应。可用“回应原意见”保存处理说明及准确稿件。':'尚无可用作者处理记录。没有记录不能证明没有修改。',dialog);
  dialog.reviewRefresh=showDecision;
  dialog.reviewError=message=>{notice.textContent=message||'';notice.hidden=!message};
  dialog.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation()});
  dialog.addEventListener('close',()=>{++read;for(const media of dialog.querySelectorAll('audio,video'))media.pause();dialog.remove();if(commentReviewDialog===dialog)commentReviewDialog=null;if(position)window.scrollTo(position.x,position.y);trigger?.isConnected&&trigger.focus({preventScroll:true})});
  document.body.append(dialog);commentReviewDialog=dialog;dialog.showModal();showDecision();await showOriginal();
}

function renderCommentReviewContent(root,record,anchor){
  const doc=record.payload;
  const production=String(doc.format||'').startsWith('production-');
  const blocks=record.review_blocks|| (record.kind==='SOURCE'?doc.blocks:production?(record.review_blocks||productionTextBlocks(record)):record.kind==='EPISODE'?doc.blocks:structureBlocks(doc));
  const visuals=doc.format?.startsWith('managed-method-')?[]:record.kind==='SOURCE'?(doc.assets||[]).map(a=>({...a,id:a.file})):record.kind==='EPISODE'?[]:production?(doc.components||[]).filter(c=>c.mime.startsWith('image/')).map(c=>({...c,title:doc.title})):structureVisuals(doc);
  const focus=el('section','comment-review-exact');root.append(focus);
  if(!anchor){appendReviewManuscript(focus,record);return}
  if(anchor?.type==='time'){
    const component=(doc.components||[]).find(c=>c.id===anchor.component_id&&c.file===anchor.asset_file);
    if(!component){nodeText('p','structure-alert','准确音视频文件已不可用；未替换为其他原件。',focus);return}
    appendReviewMedia(focus,component,anchor);
  }else if(anchor?.type==='visual'||anchor?.type==='region'){
    const visual=visuals.find(v=>v.id===anchor.visual_id&&(!anchor.asset_file||v.file===anchor.asset_file));
    if(!visual){nodeText('p','structure-alert','准确原图已不可用；未替换为新图。',focus);return}
    appendReviewVisual(focus,visual,anchor);
  }else{
    for(const part of anchor?.segments||[anchor]){
    const start=part?.block_id?blocks.findIndex(b=>b.id===part.block_id):0;
    const end=part?.block_id?blocks.findIndex(b=>b.id===(part.end_block_id||part.block_id)):blocks.length-1;
    if(start<0||end<start){nodeText('p','structure-alert','准确正文位置已不可用；未查找相似句替代。',focus);return}
    for(let i=start;i<=end;i++){
      const block=blocks[i],p=nodeText('p',null,'',focus);p.dataset.reviewBlock=block.id;
      const text=Array.from(block.text),textAnchor=anchor?.type==='text'||(!anchor?.type&&anchor?.block_id),from=textAnchor?(i===start?part.start:0):0,to=textAnchor?(i===end?part.end:text.length):0;
      const left=textAnchor?Math.max(0,from-200):0,right=textAnchor?Math.min(text.length,to+200):text.length;
      p.append(document.createTextNode((left?'…':'')+text.slice(left,from).join('')));
      if(to>from)nodeText('mark',null,text.slice(from,to).join(''),p);
      p.append(document.createTextNode(text.slice(to||from,right).join('')+(right<text.length?'…':'')));
    }
    }
  }
  const full=el('details','comment-review-full');nodeText('summary',null,'阅读这份准确稿件的完整图文',full);
  full.addEventListener('toggle',()=>{
    focus.hidden=full.open;
    if(!full.open||full.dataset.loaded)return;
    full.dataset.loaded='true';appendReviewManuscript(full,record);
  });root.append(full);
}
function appendReviewManuscript(root,record){
  const doc=record.payload;
  if(String(doc.format||'').startsWith('production-')){
    for(const block of record.review_blocks||productionTextBlocks(record))nodeText('p',null,block.text,root);
    for(const component of doc.components||[]){
      if(component.mime.startsWith('image/'))appendReviewVisual(root,{...component,title:doc.title});
      else if(/^(audio|video)\//.test(component.mime))appendReviewMedia(root,component);
    }
  }else if(record.kind==='EPISODE'){
    for(const scene of doc.scenes){nodeText('h4',null,scene.heading||scene.title,root);for(const id of scene.block_ids){const block=doc.blocks.find(b=>b.id===id);if(block)nodeText('p',null,block.text,root)}}
  }else if(record.kind==='SOURCE'){
    for(const block of doc.blocks)nodeText('p',null,block.text,root);
    for(const asset of doc.assets||[])appendReviewVisual(root,{...asset,id:asset.file});
  }else if(doc.format?.startsWith('managed-method-')){
    for(const file of record.review_file?[record.review_file]:Object.keys(doc.files)){nodeText('h4',null,file,root);for(const block of record.review_blocks.filter(b=>b.file===file))nodeText('p',null,block.text,root)}
  }else{
    for(const section of doc.sections){
      nodeText('h4',null,section.title,root);
      for(const block of section.blocks)nodeText('p',null,block.text,root);
      for(const visual of section.visuals||[])appendReviewVisual(root,visual);
    }
  }
}
function appendReviewVisual(root,visual,anchor){
  const figure=el('figure'),frame=el('div','comment-review-image'),img=el('img');
  img.src=reviewURL('/assets/'+encodeURIComponent(visual.file));img.alt=visual.alt||visual.title;frame.append(img);
  img.classList.add('structure-image-trigger');img.dataset.reviewDialogTrigger='';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',`放大查看：${visual.title}`);img.setAttribute('aria-haspopup','dialog');img.title='点击放大查看';img.draggable=false;
  let unavailable=false;
  img.onclick=()=>{if(!unavailable)openStructureImage(visual,img)};
  img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();img.click()}};
  img.addEventListener('error',()=>{unavailable=true;img.setAttribute('aria-disabled','true');nodeText('p','structure-alert','准确原图文件不可用；未替换为其他图像。',frame)},{once:true});
  if(anchor?.type==='region'){
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1 1');svg.setAttribute('preserveAspectRatio','none');
    const polygon=document.createElementNS(svg.namespaceURI,'polygon');polygon.setAttribute('points',anchor.points.map(p=>`${p.x},${p.y}`).join(' '));svg.append(polygon);frame.append(svg);
  }
  if(anchor)frame.classList.add('original-selection');figure.append(frame);nodeText('figcaption',null,visual.title,figure);nodeText('p',null,visual.description||visual.note||'',figure);root.append(figure);
}

function appendReviewMedia(root,component,anchor){
  const media=el(component.mime.startsWith('audio/')?'audio':'video');media.controls=true;media.preload='metadata';media.src=reviewURL('/assets/'+encodeURIComponent(component.file));media.setAttribute('aria-label','准确原件'+(anchor?` · ${anchor.start_seconds}–${anchor.end_seconds} 秒`:''));
  if(anchor){
    nodeText('p',null,`原意见范围：${anchor.start_seconds}–${anchor.end_seconds} 秒`,root);
    media.addEventListener('loadedmetadata',()=>{media.currentTime=anchor.start_seconds});
    media.addEventListener('play',()=>{if(media.currentTime<anchor.start_seconds||media.currentTime>=anchor.end_seconds)media.currentTime=anchor.start_seconds});
    media.addEventListener('timeupdate',()=>{if(!media.paused&&media.currentTime>=anchor.end_seconds)media.pause()});
  }
  media.addEventListener('error',()=>nodeText('p','structure-alert','准确原件读取失败；未替换文件。',root),{once:true});root.append(media);
}
