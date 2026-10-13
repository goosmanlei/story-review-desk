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
function renderReferenceCandidatePicker(line,item,need,card,workspace=null){
  const session=referencePickerConsumer(need),index=item.index;
  const workspaces=[workspace,state.entityReview,state.materialCommentCard?.data].filter(data=>data?.requirements?.some(r=>r.object_id===need.object_id));
  line.dataset.referenceInput=String(index);card.classList.add('reference-picker-card');
  const copy=card.querySelector('.material-small-copy'),detailButton=card.querySelector('.reference-material-name');
  copy.querySelector('.small-card-selection')?.remove();
  const picker=el('div','reference-candidate-picker'),choices=el('div','reference-candidate-choices'),status=nodeText('small','reference-picker-status','正在读取候选…',choices);
  picker.append(choices);copy.append(picker);status.setAttribute('role','status');
  let data=null,error='',loading=false,preview=null,previewKey=null,pinned=false,leaveTimer=null,cleanup=null,skipFocus=false;
  const current=()=>session.slots.find(s=>s.index===index)||item.slot;
  const closePreview=()=>{
    clearTimeout(leaveTimer);cleanup?.();cleanup=null;
    preview?.querySelectorAll('audio,video').forEach(p=>{p.pause();p.removeAttribute('src');p.load()});
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
    const display=original=>{
      mediaBox.querySelectorAll('audio,video').forEach(p=>{p.pause();p.removeAttribute('src');p.load()});mediaBox.replaceChildren();
      if(!original||original.issue){nodeText('p','production-issue',original?.issue||candidate.issue||'请选择准确原件',mediaBox);return}
      const image=original.mime.startsWith('image/'),file=reviewURL('/api/production/files/'+encodeURIComponent(original.file));
      const media=el(image?'img':original.mime.startsWith('audio/')?'audio':original.mime.startsWith('video/')?'video':'a');
      if(media.tagName==='A'){media.href=file;media.target='_blank';media.rel='noopener';media.textContent='查看原件文件'}
      else{media.src=file;if(image)media.alt=`候选 ${candidate.number} · ${original.id}`;else{media.controls=true;media.preload='none';media.tabIndex=0}}
      media.onerror=()=>{if(previewKey!==key)return;media.remove();const message=nodeText('p','production-issue','预览加载失败',mediaBox);productionButton(message,'重试预览',()=>display(original))};mediaBox.append(media);
    };
    if(candidate.originals.length>1){
      const originals=el('div','reference-originals');preview.append(originals);
      for(const original of candidate.originals){
        const choose=productionButton(originals,'原件 · '+original.id,()=>select(candidate,original,false));choose.className='reference-original-choice';choose.disabled=!!original.issue||!!session.busy||!!session.pending;
        choose.setAttribute('aria-pressed',String(referencePickerSame(current(),candidate,original)));choose.title=original.issue||'选择此准确原件';
        choose.onmouseenter=choose.onfocus=()=>display(original);
      }
    }
    preview.append(mediaBox);display(component||(candidate.originals.length===1?candidate.originals[0]:null));
    const rect=button.getBoundingClientRect(),width=Math.min(560,document.documentElement.clientWidth-24),height=Math.min(680,window.innerHeight-24);
    const fitHeight=limit=>{preview.style.maxHeight=limit+'px';preview.style.setProperty('--reference-preview-media-height',Math.max(40,limit-64)+'px')};
    preview.style.width=width+'px';fitHeight(height);
    const side=rect.right+width+24<document.documentElement.clientWidth?rect.right+12:rect.left-width-12>=12?rect.left-width-12:null;
    preview.style.left=(side??Math.max(12,Math.min(document.documentElement.clientWidth-width-12,rect.left)))+'px';
    preview.style.top=Math.max(12,Math.min(window.innerHeight-height-12,rect.top))+'px';
    preview.showPopover?.();
    const actualHeight=preview.getBoundingClientRect().height;
    if(side===null){
      const below=window.innerHeight-rect.bottom-12,above=rect.top-12,useBelow=below>=actualHeight||below>=above;
      fitHeight(Math.max(50,Math.min(height,useBelow?below:above)));
      preview.style.top=(useBelow?rect.bottom+8:Math.max(12,rect.top-preview.getBoundingClientRect().height-8))+'px';
    }else preview.style.top=Math.max(12,Math.min(window.innerHeight-actualHeight-12,rect.top))+'px';
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
      button.setAttribute('aria-pressed',String(same));button.classList.toggle('selected',same);button.disabled=!!session.busy||!!session.pending||!!session.conflict;button.setAttribute('aria-disabled',String(!same&&!!button.dataset.issue));
      button.querySelector('.reference-choice-check').textContent=same?'✓ ':'';
      button.title=button.dataset.issue||(same?'再次点击取消此参考选择':'点击选择；悬停或聚焦预览；触屏按住预览');
    }
  };
  const render=()=>{
    closePreview();choices.querySelectorAll('[data-candidate-revision],.reference-load-retry').forEach(b=>b.remove());
    for(const candidate of data.candidates){
      const single=candidate.originals.length===1?candidate.originals[0]:null,button=productionButton(choices,'',()=>{});
      button.className='reference-candidate-choice';button.dataset.candidateRevision=candidate.candidate.revision_id;
      nodeText('span','reference-choice-check','',button);nodeText('span',null,`候选 ${candidate.number}`,button);
      button.setAttribute('aria-label',`候选 ${candidate.number}`);button.setAttribute('aria-haspopup','dialog');
      const issue=candidate.issue||single?.issue;if(issue)button.dataset.issue=issue;
      bindPreview(button,candidate,single);
    }
    refresh();const selected=choices.querySelector('.selected');if(selected){choices.scrollLeft=Math.max(0,selected.offsetLeft-choices.offsetLeft-choices.clientWidth+selected.offsetWidth)}
  };
  const load=async(reload=false)=>{if(loading)return;loading=true;error='';refresh();
    try{data=await referencePickerLoad(item.slot.canonical_material_id||item.slot.material_id,item.slot.record?.payload.media_type||item.row?.payload.media_type||'',reload);if(!Array.isArray(data.candidates))throw Error('候选响应不可用');if(line.isConnected)render()}
    catch(exc){data=null;error='候选加载失败：'+exc.message;if(line.isConnected){refresh();const retry=productionButton(choices,'重试读取候选',()=>{retry.remove();load(true)});retry.className='reference-load-retry'}}finally{loading=false}
  };
  detailButton.onclick=()=>{closePreview();const slot=current();return openShotReference({slot,value:slot.value,ref:{...slot.value.reference,...slot.value}},{need:session.need,number:1,onSaved:result=>session.receipt(result)},detailButton)};
  for(const view of session.listeners)if(!view.connected())session.listeners.delete(view);
  session.listeners.add({connected:()=>line.isConnected,refresh,workspaces});
  if(typeof IntersectionObserver==='undefined')load();else{const observer=new IntersectionObserver(entries=>{if(!line.isConnected||entries.some(e=>e.isIntersecting)){observer.disconnect();if(line.isConnected)load()}},{rootMargin:'100px'});observer.observe(line)}
  return {session,load,refresh};
}
