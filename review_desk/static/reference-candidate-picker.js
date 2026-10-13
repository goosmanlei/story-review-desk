/* Choices belong to a consumer and an ordered input slot, never to a material. */
const referencePickerConsumers=new Map();
const referencePickerSummaries=new Map();
function referencePickerLoad(material,type,retry=false){
  const key=JSON.stringify([material,type]),cached=referencePickerSummaries.get(key);
  if(!retry&&cached&&Date.now()-cached.time<30000)return cached.promise;
  const promise=api('/api/production/reference-candidates?'+new URLSearchParams({material_id:material,media_type:type})).catch(error=>{referencePickerSummaries.delete(key);throw error});
  referencePickerSummaries.set(key,{promise,time:Date.now()});
  if(referencePickerSummaries.size>128)referencePickerSummaries.delete(referencePickerSummaries.keys().next().value);
  return promise;
}
function referencePickerConsumer(need){
  let session=referencePickerConsumers.get(need.object_id);
  if(!session){
    session={need,slots:need.review_shot_slots||need.input_slots||[],listeners:new Set(),tail:Promise.resolve(),pending:null,busy:0};
    session.notify=()=>{for(const view of session.listeners){if(view.connected())view.refresh();else session.listeners.delete(view)}};
    session.receipt=(result,savedWorkspaces=[])=>{
      if(result.requirement_id!==session.need.object_id||!Array.isArray(result.slots))throw Error('保存回执与消费方案不匹配，请重新打开核对');
      const marker=result.workspace_marker;
      for(const data of new Set([...savedWorkspaces,...[...session.listeners].filter(v=>v.connected()).flatMap(v=>v.workspaces||[])])){
        if(!marker||data.entity?.object_id!==marker.owner_id)continue;
        const known=new Map([data.entity,...(data.states||[]),...(data.requirements||[])].map(r=>[r.object_id,r]));
        if(marker.records.length!==known.size||marker.records.some(([id,revision,version])=>id!==session.need.object_id&&(known.get(id)?.id!==revision||known.get(id)?.version!==version)))continue;
        const own=known.get(session.need.object_id);
        Object.assign(own,{id:result.revision_id,current_revision:result.revision_id,version:result.edit_token,edit_token:result.edit_token,content_sha256:result.content_sha256,review_shot_slots:result.slots});
        if(own.payload?.generation)own.payload.generation.inputs=result.slots.map(s=>s.value);
        data.source_signature=marker.source_signature;
      }
      session.slots=result.slots;Object.assign(session.need,{id:result.revision_id,current_revision:result.revision_id,version:result.edit_token,edit_token:result.edit_token,content_sha256:result.content_sha256,review_shot_slots:result.slots});
      session.need.payload.generation.inputs=result.slots.map(s=>s.value);session.pending=null;session.notify();
    };
    referencePickerConsumers.set(need.object_id,session);
    // Only idle, unobserved readers can leave the small session cache.
    if(referencePickerConsumers.size>32)for(const [id,other] of referencePickerConsumers){if(id!==need.object_id&&!other.busy&&!other.pending&&![...other.listeners].some(v=>v.connected()))referencePickerConsumers.delete(id);if(referencePickerConsumers.size<=32)break}
  }else if(!session.busy&&!session.pending&&need.edit_token>session.need.edit_token){session.need=need;session.slots=need.review_shot_slots||need.input_slots||[]}
  return session;
}
function referencePickerSame(slot,candidate,component){return !!candidate&&slot?.candidate?.revision_id===candidate.candidate.revision_id&&slot.value.component_id===component.id}
function referencePickerSave(session,index,candidate,component){
  const workspaces=[...session.listeners].filter(v=>v.connected()).flatMap(v=>v.workspaces||[]);
  const choose=async()=>{
    if(session.conflict)throw Error('当前方案已被修改，请重新读取方案后选择');
    const slot=session.slots.find(s=>s.index===index);
    if(!slot?.material_id||slot.direct===false)throw Error('此输入不可在当前方案选择');
    if(!session.pending&&referencePickerSame(slot,candidate,component))return;
    const choice=JSON.stringify([index,candidate?.candidate||null,component?.id||null]);
    if(session.pending&&session.pending.choice!==choice)throw Error('上次保存结果待核对，请先重试原选择');
    if(!session.pending){session.pending={choice,workspaces,request:{id:'reference-card-'+crypto.randomUUID(),requirement_id:session.need.object_id,
      expected_content:{edit_token:session.need.edit_token,content_sha256:session.need.content_sha256},index,input_key:slot.input_key,
      material_id:slot.material_id,candidate:candidate?.candidate||null,...(candidate?{component_id:component.id,preserve_bounds:true}:{})}}}
    let result;
    try{result=await api('/api/production/shot-reference',{method:'POST',body:JSON.stringify(session.pending.request)})}
    catch(error){if([400,409].includes(error.status)){session.pending=null;session.conflict=error.status===409}throw error}
    if(!result.slots.some(s=>s.index===index))throw Error('保存回执缺少原输入位置，请重试核对');
    session.receipt(result,session.pending.workspaces);return result;
  };
  session.busy++;session.notify();
  const operation=session.tail.then(choose);session.tail=operation.catch(()=>{});
  return operation.finally(()=>{session.busy--;session.notify()});
}
// A second deliberate click is an explicit clear; saves and retries are never toggles.
function referencePickerToggle(session,index,candidate,component){
  const slot=session.slots.find(s=>s.index===index);
  const clear=slot?.candidate?.revision_id===candidate.candidate.revision_id;
  return referencePickerSave(session,index,clear?null:candidate,clear?null:component);
}
let referencePickerCloseActive=null;
function referencePreviewStop(box){box?.querySelectorAll('audio,video').forEach(media=>{media.pause();media.removeAttribute('src');media.load()})}
function referencePreviewDisplay(box,original,label,type='image',{placeholder=false}={}){
  referencePreviewStop(box);box.replaceChildren();
  if(!original||original.issue){
    if(!original&&placeholder){const empty=el('div','reference-preview-placeholder');empty.setAttribute('role','img');empty.setAttribute('aria-label','未选定原件');empty.append(productionEntityIcon(type));box.append(empty)}
    else nodeText('p','production-issue',original?.issue||'请选择准确原件',box);
    return;
  }
  const image=original.mime.startsWith('image/'),file=reviewURL('/api/production/files/'+encodeURIComponent(original.file));
  const media=el(image?'img':original.mime.startsWith('audio/')?'audio':original.mime.startsWith('video/')?'video':'a');
  if(media.tagName==='A'){media.href=file;media.target='_blank';media.rel='noopener';media.textContent='查看原件文件'}
  else{media.src=file;if(image)media.alt=label;else{media.controls=true;media.preload='none';media.tabIndex=0}}
  media.onerror=()=>{if(!media.isConnected)return;media.remove();const message=nodeText('p','production-issue','预览加载失败',box);productionButton(message,'重试预览',()=>referencePreviewDisplay(box,original,label,type,{placeholder}))};box.append(media);
}
function referencePreviewPosition(preview,anchor,extraHeader=0){
  const rect=anchor.getBoundingClientRect(),width=Math.min(560,document.documentElement.clientWidth-24),height=Math.min(680+extraHeader,window.innerHeight-24);
  const fitHeight=limit=>{preview.style.maxHeight=limit+'px';preview.style.setProperty('--reference-preview-media-height',Math.max(40,limit-64-extraHeader)+'px')};
  preview.style.width=width+'px';fitHeight(height);
  const side=rect.right+width+24<document.documentElement.clientWidth?rect.right+12:rect.left-width-12>=12?rect.left-width-12:null;
  preview.style.left=(side??Math.max(12,Math.min(document.documentElement.clientWidth-width-12,rect.left)))+'px';
  preview.style.top=Math.max(12,Math.min(window.innerHeight-height-12,rect.top))+'px';preview.showPopover?.();
  const actualHeight=preview.getBoundingClientRect().height;
  if(side===null){
    const below=window.innerHeight-rect.bottom-12,above=rect.top-12,useBelow=below>=actualHeight||below>=above;
    fitHeight(Math.max(50,Math.min(height,useBelow?below:above)));
    preview.style.top=(useBelow?rect.bottom+8:Math.max(12,rect.top-preview.getBoundingClientRect().height-8))+'px';
  }else preview.style.top=Math.max(12,Math.min(window.innerHeight-actualHeight-12,rect.top))+'px';
}
function referencePromptPreviewChoice(slot,candidates,hovered=null){
  const value=slot?.value||{},selected=slot?.candidate,candidate=hovered||candidates?.find(c=>c.candidate.revision_id===selected?.revision_id);
  if(candidate){
    const same=candidate.candidate.revision_id===selected?.revision_id;
    const original=same?candidate.originals.find(o=>o.id===value.component_id):candidate.originals.length===1?candidate.originals[0]:null;
    return {candidate,original:original||(same?{issue:'当前选定原件不可用'}:null),placeholder:!same&&!original};
  }
  const original=value.selection_state==='unselected'?null:slot?.component||slot?.record?.payload.components?.find(o=>o.id===value.component_id);
  return {candidate:null,original:original||(selected?{issue:'当前选定原件不可用'}:null),placeholder:!selected&&!original};
}
function bindPromptReferencePreview(anchor,item,need,{selectable=false,workspace=null}={}){
  if(!item.slot||item.slot.nonmedia)return null;
  const editable=!!(selectable&&need.kind==='REQUIREMENT'&&need.current_content&&!need.submission_only&&item.slot.material_id&&item.slot.direct!==false);
  const session=editable?referencePickerConsumer(need):null,index=item.index;
  const workspaces=[workspace,state.entityReview,state.materialCommentCard?.data].filter(data=>data?.requirements?.some(r=>r.object_id===need.object_id));
  const fallback={...item.slot,value:item.slot.value||item.value||{}};
  const current=()=>session?.slots.find(s=>s.index===index)||fallback;
  const type=item.slot.record?.payload.media_type||item.row?.payload.media_type||'image';
  let preview=null,choices=null,status=null,mediaBox=null,originals=null,retry=null,reconcile=null,data=null,error='',loading=false,hovered=null,hoveredOriginal=null,shownKey=null,leaveTimer=null,cleanup=null,pinned=false,skipFocus=false,touch=null,touchTimer=null,suppressClick=false,view=null;
  anchor.setAttribute('aria-haspopup','dialog');anchor.setAttribute('aria-expanded','false');
  const close=()=>{
    clearTimeout(leaveTimer);clearTimeout(touchTimer);cleanup?.();cleanup=null;referencePreviewStop(preview);preview?.remove();preview=null;hovered=null;hoveredOriginal=null;shownKey=null;pinned=false;anchor.setAttribute('aria-expanded','false');
    if(view)session.listeners.delete(view);if(referencePickerCloseActive===close)referencePickerCloseActive=null;
  };
  const laterClose=event=>{clearTimeout(leaveTimer);leaveTimer=setTimeout(()=>{if(event?.type==='mouseleave'? !pinned&&!preview?.matches(':hover'):!preview?.contains(document.activeElement)&&document.activeElement!==anchor)close()},180)};
  const display=()=>{
    if(!preview)return;
    choices.querySelectorAll('[data-candidate-revision]').forEach(button=>button.classList.toggle('previewing',button.dataset.candidateRevision===hovered?.candidate.revision_id));
    const choice=referencePromptPreviewChoice(current(),data?.candidates||[],hovered),original=hoveredOriginal||choice.original;
    const label=choice.candidate?`候选 ${choice.candidate.number} · ${original?.id||''}`:anchor.textContent;
    const key=JSON.stringify([original?.file,original?.id,original?.issue,choice.placeholder]);if(key===shownKey){const image=mediaBox.querySelector('img');if(image)image.alt=label;return}shownKey=key;
    referencePreviewDisplay(mediaBox,original,label,type,{placeholder:choice.placeholder});
  };
  const restorePreview=event=>{
    // A temporary audio/video audition must survive the move from its button to the player.
    if(mediaBox?.querySelector('audio,video')&&preview?.contains(event?.relatedTarget))return;
    hovered=null;hoveredOriginal=null;display();
  };
  const refresh=()=>{
    if(!preview)return;
    status.textContent=error||(!editable?'':!data?'正在读取候选…':!data.candidates.length?'暂无候选':session.pending?.request.index===index&&!session.busy?'上次保存结果待核对':'');status.title=status.textContent;status.hidden=!status.textContent;status.className=error?'reference-picker-status production-issue':'reference-picker-status';
    retry.hidden=!session?.pending||session.pending.request.index!==index||!!session.busy;reconcile.hidden=!session?.conflict;
    for(const button of choices.querySelectorAll('[data-candidate-revision]')){
      const same=current().candidate?.revision_id===button.dataset.candidateRevision;
      button.setAttribute('aria-pressed',String(same));button.classList.toggle('selected',same);button.disabled=!!session.busy||!!session.pending||!!session.conflict;button.setAttribute('aria-disabled',String(!same&&!!button.dataset.issue));button.querySelector('.reference-choice-check').textContent=same?'✓ ':'';
      button.title=button.dataset.issue||(same?'再次点击取消此参考选择':'点击选择；悬停或聚焦临时预览');
    }
    originals.querySelectorAll('button').forEach(button=>{button.disabled=!!button.dataset.issue||!!session?.busy||!!session?.pending||!!session?.conflict;button.setAttribute('aria-pressed',String(current().candidate?.revision_id===button.dataset.candidateRevision&&current().value.component_id===button.dataset.originalId))});display();
  };
  const save=async(candidate,original,toggle=true)=>{
    if(!session||session.busy||session.pending||session.conflict)return;error='';
    try{await (toggle?referencePickerToggle(session,index,candidate,original):referencePickerSave(session,index,candidate,original));originals.replaceChildren()}
    catch(exc){error='保存失败：'+exc.message}refresh();
  };
  const chooseOriginals=candidate=>{
    originals.replaceChildren();
    for(const original of candidate.originals){
      const button=productionButton(originals,'原件 · '+original.id,()=>save(candidate,original,false));button.className='reference-original-choice';button.dataset.candidateRevision=candidate.candidate.revision_id;button.dataset.originalId=original.id;if(original.issue)button.dataset.issue=original.issue;
      button.setAttribute('aria-pressed',String(referencePickerSame(current(),candidate,original)));button.title=original.issue||'选择此准确原件';
      button.onmouseenter=button.onfocus=()=>{hovered=candidate;hoveredOriginal=original;display()};button.onmouseleave=button.onblur=restorePreview;
    }
    refresh();
  };
  const renderChoices=()=>{
    choices.querySelectorAll('[data-candidate-revision],.reference-load-retry').forEach(button=>button.remove());
    for(const candidate of data.candidates){
      const single=candidate.originals.length===1?candidate.originals[0]:null,button=productionButton(choices,'',()=>{});button.className='reference-candidate-choice';button.dataset.candidateRevision=candidate.candidate.revision_id;
      nodeText('span','reference-choice-check','',button);nodeText('span',null,`候选 ${candidate.number}`,button);button.setAttribute('aria-label',`候选 ${candidate.number}`);
      const issue=candidate.issue||single?.issue;if(issue)button.dataset.issue=issue;
      button.onmouseenter=button.onfocus=()=>{hovered=candidate;hoveredOriginal=null;display()};button.onmouseleave=button.onblur=restorePreview;
      button.onclick=event=>{event.stopPropagation();if(session.busy||session.pending||session.conflict)return;const same=current().candidate?.revision_id===candidate.candidate.revision_id;if(issue&&!same)return;if(single||same)return save(candidate,single);chooseOriginals(candidate)};
    }
    refresh();const selected=choices.querySelector('.selected');if(selected)choices.scrollLeft=Math.max(0,selected.offsetLeft-choices.offsetLeft-choices.clientWidth+selected.offsetWidth);
  };
  const load=async(reload=false)=>{
    if(loading)return;loading=true;error='';refresh();
    try{const result=await referencePickerLoad(current().canonical_material_id||current().material_id,type,reload);if(!Array.isArray(result.candidates))throw Error('候选响应不可用');data=result;if(preview&&anchor.isConnected)renderChoices()}
    catch(exc){if(preview&&anchor.isConnected){data=null;error='候选加载失败：'+exc.message;refresh();const button=productionButton(choices,'重试读取候选',()=>{button.remove();load(true)});button.className='reference-load-retry'}}
    finally{loading=false}
  };
  const open=(persist=false)=>{
    if(!anchor.isConnected)return;
    if(preview){pinned||=persist;clearTimeout(leaveTimer);return}
    referencePickerCloseActive?.();referencePickerCloseActive=close;pinned=persist;
    if(view){for(const old of session.listeners)if(!old.connected())session.listeners.delete(old);session.listeners.add(view)}
    preview=el('div','reference-candidate-preview prompt-reference-preview');preview.id='prompt-reference-'+crypto.randomUUID();preview.setAttribute('popover','manual');preview.setAttribute('role','dialog');preview.setAttribute('aria-label',anchor.textContent+' 参考预览');document.body.append(preview);
    anchor.setAttribute('aria-expanded','true');anchor.setAttribute('aria-controls',preview.id);nodeText('strong','reference-preview-heading',anchor.textContent,preview);
    choices=el('div','reference-candidate-choices');choices.setAttribute('role','group');choices.setAttribute('aria-label','候选选择');choices.hidden=!editable;preview.append(choices);status=nodeText('small','reference-picker-status','',choices);status.setAttribute('role','status');
    reconcile=productionButton(choices,'重新读取方案',async()=>{try{session.receipt(await api('/api/production/shot-reference?requirement_id='+encodeURIComponent(need.object_id)),workspaces);session.conflict=false;error='';refresh()}catch(exc){error='读取失败：'+exc.message;refresh()}});reconcile.hidden=true;
    retry=productionButton(choices,'重试保存',async()=>{const request=session?.pending?.request;if(!request||request.index!==index)return;error='';try{await referencePickerSave(session,index,request.candidate?{candidate:request.candidate}:null,request.component_id?{id:request.component_id}:null)}catch(exc){error='保存失败：'+exc.message}refresh()});retry.hidden=true;
    originals=el('div','reference-originals');preview.append(originals);mediaBox=el('div','reference-preview-media');preview.append(mediaBox);refresh();if(editable){if(data)renderChoices();else load()}
    referencePreviewPosition(preview,anchor,editable?32:0);
    preview.onmouseenter=()=>clearTimeout(leaveTimer);preview.onmouseleave=laterClose;preview.onfocusin=()=>clearTimeout(leaveTimer);preview.onfocusout=laterClose;
    const events=new AbortController(),options={signal:events.signal,capture:true};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();skipFocus=true;anchor.focus({preventScroll:true});skipFocus=false}},options);
    document.addEventListener('pointerdown',event=>{if(event.target!==anchor&&!anchor.contains(event.target)&&!preview?.contains(event.target))close()},options);
    document.addEventListener('scroll',event=>{if(!preview?.contains(event.target))close()},options);window.addEventListener('resize',close,{signal:events.signal});
    const observer=new MutationObserver(()=>{if(!anchor.isConnected)close()});observer.observe(document.body,{childList:true,subtree:true});cleanup=()=>{events.abort();observer.disconnect()};
  };
  anchor.onmouseenter=()=>open();anchor.onmouseleave=laterClose;anchor.onfocus=()=>{if(!skipFocus)requestAnimationFrame(()=>{if(document.activeElement===anchor&&anchor.isConnected)open()})};anchor.onblur=laterClose;
  anchor.onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();open();(choices.querySelector('.selected')||choices.querySelector('[data-candidate-revision]')||preview.querySelector('audio,video'))?.focus()}else if(event.key==='Escape'){event.preventDefault();close()}};
  anchor.onpointerdown=event=>{if(event.pointerType!=='touch')return;touch={x:event.clientX,y:event.clientY};suppressClick=false;touchTimer=setTimeout(()=>{suppressClick=true;open(true)},450)};
  anchor.onpointermove=event=>{if(touch&&Math.hypot(event.clientX-touch.x,event.clientY-touch.y)>8){suppressClick=true;clearTimeout(touchTimer)}};anchor.onpointerup=()=>{clearTimeout(touchTimer);touch=null};anchor.onpointercancel=()=>{clearTimeout(touchTimer);touch=null;suppressClick=true};
  if(session)view={connected:()=>anchor.isConnected,refresh,workspaces};
  return {close,consumeClick:()=>{const suppressed=suppressClick;suppressClick=false;return suppressed},input:()=>{if(!session)return item;const slot=current(),row=slot.record||item.row;return {...item,slot,row,value:slot.value,ref:{...slot.value.reference,...slot.value,kind:row?.kind,reference_identity:slot,...(row?.submission_only||row?.unavailable||row?.component_snapshot?{snapshot_record:row}:{})}}}};
}
function renderReferenceCandidatePicker(line,item,need,card,workspace=null){
  const session=referencePickerConsumer(need),index=item.index;
  const workspaces=[workspace,state.entityReview,state.materialCommentCard?.data].filter(data=>data?.requirements?.some(r=>r.object_id===need.object_id));
  line.dataset.referenceInput=String(index);card.classList.add('reference-picker-card');
  const copy=card.querySelector('.material-small-copy'),detailButton=card.querySelector('.reference-material-name');
  const ownPrefix=item.slot?.own_candidate?detailButton.title.split('：')[0]:null;
  copy.querySelector('.small-card-selection')?.remove();
  const picker=el('div','reference-candidate-picker'),choices=el('div','reference-candidate-choices'),status=nodeText('small','reference-picker-status','正在读取候选…',choices);
  picker.append(choices);copy.append(picker);status.setAttribute('role','status');
  let data=null,error='',loading=false,preview=null,previewKey=null,pinned=false,leaveTimer=null,cleanup=null,skipFocus=false;
  const current=()=>session.slots.find(s=>s.index===index)||item.slot;
  const closePreview=()=>{
    clearTimeout(leaveTimer);cleanup?.();cleanup=null;
    referencePreviewStop(preview);
    preview?.remove();preview=null;previewKey=null;pinned=false;
    if(referencePickerCloseActive===closePreview)referencePickerCloseActive=null;
  };
  const laterClose=event=>{const pointerLeave=event?.type==='mouseleave';clearTimeout(leaveTimer);leaveTimer=setTimeout(()=>{if(pointerLeave?!pinned&&!preview?.matches(':hover'):!preview?.contains(document.activeElement))closePreview()},180)};
  const showPreview=(button,candidate,component=null,explicit=false)=>{
    const key=JSON.stringify([candidate.candidate,component?.id||null]);
    if(key===previewKey&&preview){pinned||=explicit;clearTimeout(leaveTimer);return}
    referencePickerCloseActive?.();closePreview();referencePickerCloseActive=closePreview;previewKey=key;pinned=explicit;
    preview=el('div','reference-candidate-preview');preview.setAttribute('popover','manual');preview.setAttribute('role','dialog');preview.setAttribute('aria-label',`候选 ${candidate.number} 预览`);picker.append(preview);
    const heading=el('div','reference-preview-heading');preview.append(heading);nodeText('strong',null,`候选 ${candidate.number}`,heading);
    const mediaBox=el('div','reference-preview-media');
    const display=original=>referencePreviewDisplay(mediaBox,original,`候选 ${candidate.number} · ${original?.id||''}`,candidate.media_type);
    if(candidate.originals.length>1){
      const originals=el('div','reference-originals');preview.append(originals);
      for(const original of candidate.originals){
        const choose=productionButton(originals,'原件 · '+original.id,()=>select(candidate,original,false));choose.className='reference-original-choice';choose.disabled=!!original.issue||!!session.busy||!!session.pending;
        choose.setAttribute('aria-pressed',String(referencePickerSame(current(),candidate,original)));choose.title=original.issue||'选择此准确原件';
        choose.onmouseenter=choose.onfocus=()=>display(original);
      }
    }
    preview.append(mediaBox);display(component||(candidate.originals.length===1?candidate.originals[0]:null));
    referencePreviewPosition(preview,button);
    preview.onmouseenter=()=>clearTimeout(leaveTimer);preview.onmouseleave=laterClose;preview.onfocusin=()=>clearTimeout(leaveTimer);preview.onfocusout=laterClose;
    const events=new AbortController(),options={signal:events.signal,capture:true};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closePreview();skipFocus=true;button.focus({preventScroll:true});skipFocus=false}},options);
    document.addEventListener('pointerdown',event=>{if(!picker.contains(event.target))closePreview()},options);
    document.addEventListener('scroll',event=>{if(!preview?.contains(event.target))closePreview()},options);
    window.addEventListener('resize',closePreview,{signal:events.signal});
    const observer=new MutationObserver(()=>{if(!line.isConnected)closePreview()});observer.observe(document.body,{childList:true,subtree:true});
    cleanup=()=>{events.abort();observer.disconnect()};
  };
  const select=async(candidate,component,toggle=true)=>{
    if(session.busy||(component?.issue&&current().candidate?.revision_id!==candidate.candidate.revision_id))return;closePreview();error='';
    try{await (toggle?referencePickerToggle(session,index,candidate,component):referencePickerSave(session,index,candidate,component))}
    catch(exc){error='保存失败：'+exc.message}refresh();
  };
  const reconcile=productionButton(choices,'重新读取方案',async()=>{try{const value=await api('/api/production/shot-reference?requirement_id='+encodeURIComponent(need.object_id));session.receipt(value);session.conflict=false;error='';refresh()}catch(exc){error='读取失败：'+exc.message;refresh()}});reconcile.hidden=true;
  const retry=productionButton(choices,'重试保存',async()=>{const request=session.pending?.request;if(!request)return;const candidate=request.candidate?{candidate:request.candidate}:null;error='';try{await referencePickerSave(session,index,candidate,request.component_id?{id:request.component_id}:null)}catch(exc){error='保存失败：'+exc.message}refresh()});retry.hidden=true;
  const bindPreview=(button,candidate,component)=>{
    let pointer=null,suppress=false,touchTimer=null;
    button.onmouseenter=()=>showPreview(button,candidate,component);button.onmouseleave=laterClose;
    button.onfocus=()=>{if(!skipFocus)requestAnimationFrame(()=>{if(document.activeElement===button&&line.isConnected)showPreview(button,candidate,component)})};button.onblur=laterClose;
    button.onkeydown=event=>{
      if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();showPreview(button,candidate,component);preview?.querySelector('.reference-original-choice,audio,video,a,button')?.focus()}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePreview()}
    };
    button.onpointerdown=event=>{if(event.pointerType!=='touch')return;pointer={x:event.clientX,y:event.clientY};suppress=false;touchTimer=setTimeout(()=>{suppress=true;showPreview(button,candidate,component,true)},450)};
    button.onpointermove=event=>{if(pointer&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>8){suppress=true;clearTimeout(touchTimer)}};
    button.onpointerup=()=>{clearTimeout(touchTimer);pointer=null};button.onpointercancel=()=>{clearTimeout(touchTimer);pointer=null;suppress=true};
    button.onclick=event=>{event.stopPropagation();if(suppress){suppress=false;return}if(session.busy||session.pending||session.conflict)return;
      const selected=current().candidate?.revision_id===candidate.candidate.revision_id;
      if(button.dataset.issue&&!selected)return showPreview(button,candidate,component);
      if(component||selected)return select(candidate,component);
      showPreview(button,candidate,null);
    };
  };
  const refresh=()=>{
    if(!line.isConnected)return;const slot=current();
    if(ownPrefix&&slot.candidate_number){const title=`${ownPrefix}：本素材候选${slot.candidate_number}`;detailButton.title=title;const heading=detailButton.querySelector('strong');heading.textContent=title;heading.title=title}
    if(data){
      const original=data.candidates.find(c=>c.candidate.revision_id===slot.candidate?.revision_id)?.originals.find(o=>o.id===slot.value.component_id);
      let thumbnail=card.querySelector('.material-small-preview');
      if(original?.mime.startsWith('image/')&&!original.issue){
        if(!thumbnail){thumbnail=el('span','material-small-preview');card.insertBefore(thumbnail,copy)}
        if(!thumbnail.querySelector('img')){thumbnail.textContent='';thumbnail.append(el('img'))}
        delete thumbnail.dataset.placeholder;thumbnail.removeAttribute('role');thumbnail.removeAttribute('aria-label');thumbnail.removeAttribute('title');
        const img=thumbnail.querySelector('img'),src=reviewURL('/api/production/files/'+encodeURIComponent(original.file));if(img.getAttribute('src')!==src)img.src=src;img.alt='';img.loading='lazy';
      }else if((item.slot?.media_type||item.row?.payload.media_type)==='image'){
        if(!thumbnail){thumbnail=el('span','material-small-preview');card.insertBefore(thumbnail,copy)}
        if(!thumbnail.dataset.placeholder){thumbnail.textContent='';thumbnail.append(productionEntityIcon('image'));thumbnail.dataset.placeholder='true'}
        const label=original?.issue?'准确原件不可用':'未选定原件';thumbnail.setAttribute('role','img');thumbnail.setAttribute('aria-label',label);thumbnail.title=label;
      }else thumbnail?.remove();
    }
    status.textContent=error||(!data?'正在读取候选…':!data.candidates.length?'暂无候选':'');status.title=error;status.hidden=!status.textContent;status.className=error?'reference-picker-status production-issue':'reference-picker-status';
    reconcile.hidden=!session.conflict;retry.hidden=!session.pending||!!session.busy;picker.setAttribute('aria-busy',String(!!session.busy));
    for(const button of choices.querySelectorAll('[data-candidate-revision]')){
      const same=slot.candidate?.revision_id===button.dataset.candidateRevision;
      const range=same&&slot.value.range,crop=same&&slot.value.crop;
      const label=`候选 ${button.dataset.candidateNumber}`+(range?` · ${range.start_seconds}–${range.end_seconds} 秒`:crop?' · 已登记裁切区域':'');
      button.querySelector('.reference-choice-label').textContent=label;button.setAttribute('aria-label',label);
      button.setAttribute('aria-pressed',String(same));button.classList.toggle('selected',same);button.disabled=!!session.busy||!!session.pending||!!session.conflict;button.setAttribute('aria-disabled',String(!same&&!!button.dataset.issue));
      button.querySelector('.reference-choice-check').textContent=same?'✓ ':'';
      button.title=button.dataset.issue||(same?'再次点击取消此参考选择':'点击选择；悬停或聚焦预览；触屏按住预览');
    }
  };
  const render=()=>{
    closePreview();choices.querySelectorAll('[data-candidate-revision],.reference-load-retry').forEach(b=>b.remove());
    for(const candidate of data.candidates){
      const single=candidate.originals.length===1?candidate.originals[0]:null,button=productionButton(choices,'',()=>{});
      button.className='reference-candidate-choice';button.dataset.candidateRevision=candidate.candidate.revision_id;button.dataset.candidateNumber=String(candidate.number);
      nodeText('span','reference-choice-check','',button);nodeText('span','reference-choice-label',`候选 ${candidate.number}`,button);
      button.setAttribute('aria-label',`候选 ${candidate.number}`);button.setAttribute('aria-haspopup','dialog');
      const issue=candidate.issue||single?.issue;if(issue)button.dataset.issue=issue;
      bindPreview(button,candidate,single);
    }
    refresh();const selected=choices.querySelector('.selected');if(selected){choices.scrollLeft=Math.max(0,selected.offsetLeft-choices.offsetLeft-choices.clientWidth+selected.offsetWidth)}
  };
  const view={connected:()=>line.isConnected,refresh,workspaces};
  const observe=()=>{if(!line.isConnected)return;for(const old of session.listeners)if(!old.connected())session.listeners.delete(old);session.listeners.add(view)};
  const load=async(reload=false)=>{if(loading)return;loading=true;error='';observe();refresh();
    try{data=await referencePickerLoad(item.slot.canonical_material_id||item.slot.material_id,item.slot.record?.payload.media_type||item.row?.payload.media_type||'',reload);if(!Array.isArray(data.candidates))throw Error('候选响应不可用');if(line.isConnected){observe();render()}}
    catch(exc){data=null;error='候选加载失败：'+exc.message;if(line.isConnected){observe();refresh();const retry=productionButton(choices,'重试读取候选',()=>{retry.remove();load(true)});retry.className='reference-load-retry'}}finally{loading=false}
  };
  detailButton.onclick=()=>{closePreview();const slot=current();return openShotReference({slot,value:slot.value,ref:{...slot.value.reference,...slot.value}},{need:session.need,number:1,onSaved:result=>session.receipt(result)},detailButton)};
  if(typeof IntersectionObserver==='undefined')load();else{const observer=new IntersectionObserver(entries=>{if(!line.isConnected||entries.some(e=>e.isIntersecting)){observer.disconnect();if(line.isConnected)load()}},{rootMargin:'100px'});observer.observe(line)}
  return {session,load,refresh};
}
