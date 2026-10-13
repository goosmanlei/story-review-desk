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
function referencePickerSame(slot,candidate,component){return slot?.candidate?.revision_id===candidate.candidate.revision_id&&slot.value.component_id===component.id}
function referencePickerSave(session,index,candidate,component){
  const workspaces=[...session.listeners].filter(v=>v.connected()).flatMap(v=>v.workspaces||[]);
  const choose=async()=>{
    if(session.conflict)throw Error('当前方案已被修改，请重新读取方案后选择');
    const slot=session.slots.find(s=>s.index===index);
    if(!slot?.material_id||slot.direct===false)throw Error('此输入不可在当前方案选择');
    if(!session.pending&&referencePickerSame(slot,candidate,component))return;
    const choice=JSON.stringify([index,candidate.candidate,component.id]);
    if(session.pending&&session.pending.choice!==choice)throw Error('上次保存结果待核对，请先重试原选择');
    if(!session.pending){session.pending={choice,workspaces,request:{id:'reference-card-'+crypto.randomUUID(),requirement_id:session.need.object_id,
      expected_content:{edit_token:session.need.edit_token,content_sha256:session.need.content_sha256},index,input_key:slot.input_key,
      material_id:slot.material_id,candidate:candidate.candidate,component_id:component.id,preserve_bounds:true}}}
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
function renderReferenceCandidatePicker(line,item,need,detailButton){
  const session=referencePickerConsumer(need),index=item.index;
  const workspaces=[state.entityReview,state.materialCommentCard?.data].filter(data=>data?.requirements?.some(r=>r.object_id===need.object_id));
  line.classList.add('reference-picker-card');line.dataset.referenceInput=String(index);
  const picker=el('div','reference-candidate-picker'),status=nodeText('small','production-meta','正在读取候选…',picker),choices=el('div','reference-candidate-choices');picker.append(choices);line.append(picker);
  const reconcile=productionButton(picker,'重新读取方案',async()=>{try{const value=await api('/api/production/shot-reference?requirement_id='+encodeURIComponent(need.object_id));session.receipt(value);session.conflict=false;error='';refresh()}catch(exc){error='读取失败：'+exc.message;refresh()}});reconcile.hidden=true;
  status.setAttribute('role','status');detailButton.querySelector('.small-card-selection')?.remove();
  let data=null,error='',loading=false,expanded=null,preview=null,previewKey=null,pinned=false;
  const current=()=>session.slots.find(s=>s.index===index)||item.slot;
  const rangeText=()=>{const value=current().value;return value.range?` · ${value.range.start_seconds}–${value.range.end_seconds} 秒`:value.crop?' · 已登记裁切区域':''};
  const closePreview=()=>{preview?.querySelectorAll('audio,video').forEach(p=>p.pause());preview?.remove();preview=null;previewKey=null;pinned=false};
  const showPreview=(button,candidate,component,explicit=false)=>{
    const original=component||candidate.originals.length===1&&candidate.originals[0];
    if(!original||original.issue)return;
    const image=original.mime.startsWith('image/');if(!image&&!explicit)return;
    const key=JSON.stringify([candidate.candidate,original.id]);
    if(key===previewKey){pinned||=explicit;return}
    closePreview();previewKey=key;pinned=explicit;
    preview=el('div','reference-candidate-preview');preview.setAttribute('role','region');preview.setAttribute('aria-label',`候选 ${candidate.number} · ${original.id} 预览`);picker.append(preview);
    nodeText('strong',null,`候选 ${candidate.number}${candidate.originals.length>1?' · '+original.id:''}`,preview);
    const file=reviewURL('/api/production/files/'+encodeURIComponent(original.file));
    const display=()=>{
      const media=el(image?'img':original.mime.startsWith('audio/')?'audio':original.mime.startsWith('video/')?'video':'a');
      if(media.tagName==='A'){media.href=file;media.target='_blank';media.rel='noopener';media.textContent='查看原件文件'}
      else{media.src=file;if(image)media.alt=`候选 ${candidate.number} · ${original.id}`;else{media.controls=true;media.preload='none'}}
      media.onerror=()=>{if(previewKey!==key)return;media.remove();pinned=true;const message=nodeText('p','production-issue','预览加载失败',preview);productionButton(message,'重试预览',()=>{message.remove();display()})};preview.append(media);
    };display();
    if(explicit)productionButton(preview,'关闭预览',closePreview);
    const rect=line.getBoundingClientRect(),width=Math.min(320,document.documentElement.clientWidth-24),height=Math.min(350,window.innerHeight*.45);
    preview.style.width=width+'px';preview.style.maxHeight=height+'px';
    const side=rect.right+width+24<document.documentElement.clientWidth?rect.right+12:rect.left-width-12>=12?rect.left-width-12:null;
    preview.style.left=(side??Math.max(12,Math.min(document.documentElement.clientWidth-width-12,rect.left)))+'px';
    preview.style.top=(side!==null?Math.max(12,Math.min(window.innerHeight-height-12,rect.top)):rect.top>height+12?rect.top-height-12:Math.min(window.innerHeight-height-12,rect.bottom+12))+'px';
  };
  const select=async(candidate,component)=>{if(component.issue)return;closePreview();error='';try{await referencePickerSave(session,index,candidate,component)}catch(exc){error='保存失败：'+exc.message}refresh()};
  const bindPreview=(button,candidate,component)=>{
    button.onmouseenter=()=>showPreview(button,candidate,component);button.onmouseleave=()=>{if(!pinned)closePreview()};
    button.onfocus=()=>showPreview(button,candidate,component);button.onblur=()=>{if(!pinned)closePreview()};
    button.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePreview()}};
  };
  const refresh=()=>{
    if(!line.isConnected)return;
    const slot=current(),selected=data?.candidates.find(c=>c.candidate.revision_id===slot.candidate?.revision_id),original=selected?.originals.length>1?' · 原件 '+slot.value.component_id:'';
    status.textContent=error||(!data?'正在读取候选…':!data.candidates.length?'暂无候选':session.busy?'正在保存…':slot.candidate_number?`已选候选 ${slot.candidate_number}`+original+rangeText():'请选择候选');
    status.className=error?'production-issue':'production-meta';
    reconcile.hidden=!session.conflict;
    if(!data)return;
    // Update pressed states without replacing focused controls on a save receipt.
    for(const button of choices.querySelectorAll('[data-candidate-revision]')){
      const same=slot.candidate?.revision_id===button.dataset.candidateRevision&&(!button.dataset.componentId||slot.value.component_id===button.dataset.componentId);
      button.setAttribute('aria-pressed',String(same));button.classList.toggle('selected',same);
      button.querySelector('.reference-choice-check').textContent=same?'✓ ':'';
    }
  };
  const render=()=>{
    closePreview();choices.replaceChildren();
    for(const candidate of data.candidates){
      const group=el('div','reference-candidate-group');choices.append(group);
      const single=candidate.originals.length===1?candidate.originals[0]:null;
      const button=productionButton(group,'',()=>{if(single)return select(candidate,single);expanded=expanded===candidate.number?null:candidate.number;render();refresh()});
      button.className='reference-candidate-choice';button.dataset.candidateRevision=candidate.candidate.revision_id;
      if(single)button.dataset.componentId=single.id;
      nodeText('span','reference-choice-check','',button);nodeText('span',null,`候选 ${candidate.number}`,button);
      button.setAttribute('aria-label',`候选 ${candidate.number}${single?'':' · 选择原件'}`);bindPreview(button,candidate,single);
      const issue=candidate.issue||single?.issue;if(issue){button.disabled=true;nodeText('small','production-issue',issue,group)}
      if(single&&!issue){const inspect=productionButton(group,'预览',()=>showPreview(inspect,candidate,single,true));inspect.className='reference-preview-button';inspect.setAttribute('aria-label',`预览候选 ${candidate.number}`)}
      if(!single&&expanded===candidate.number){
        button.setAttribute('aria-expanded','true');const originals=el('div','reference-originals');group.append(originals);
        for(const original of candidate.originals){const choose=productionButton(originals,'',()=>select(candidate,original));choose.className='reference-candidate-choice';choose.dataset.candidateRevision=candidate.candidate.revision_id;choose.dataset.componentId=original.id;nodeText('span','reference-choice-check','',choose);nodeText('span',null,'原件 · '+original.id,choose);choose.disabled=!!original.issue;bindPreview(choose,candidate,original);
          if(original.issue)nodeText('small','production-issue',original.issue,originals);else{const inspect=productionButton(originals,'预览',()=>showPreview(inspect,candidate,original,true));inspect.setAttribute('aria-label',`预览候选 ${candidate.number} 原件 ${original.id}`)}}
      }
    }refresh();
  };
  const load=async(retry=false)=>{if(loading)return;loading=true;error='';status.textContent='正在读取候选…';choices.replaceChildren();
    try{data=await referencePickerLoad(item.slot.canonical_material_id||item.slot.material_id,item.slot.record?.payload.media_type||item.row?.payload.media_type||'',retry);if(!Array.isArray(data.candidates))throw Error('候选响应不可用');if(line.isConnected)render()}
    catch(exc){data=null;error='候选加载失败：'+exc.message;if(line.isConnected){refresh();productionButton(choices,'重试读取候选',()=>load(true))}}finally{loading=false}
  };
  picker.onkeydown=event=>{if(event.key==='Escape'&&preview){event.preventDefault();event.stopPropagation();closePreview()}};
  detailButton.onclick=()=>{const slot=current();return openShotReference({slot,value:slot.value,ref:{...slot.value.reference,...slot.value}},{need:session.need,number:1,onSaved:result=>session.receipt(result)},detailButton)};
  session.listeners.add({connected:()=>line.isConnected,refresh,workspaces});
  if(typeof IntersectionObserver==='undefined')load();else{const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();load()}},{rootMargin:'100px'});observer.observe(line)}
  return {session,load,refresh};
}
