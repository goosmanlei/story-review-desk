/* Immutable film review. Browser storage here never reads or overwrites edit drafts. */
const episodeEditing={epoch:0,contexts:new Map()};
const editClone=value=>JSON.parse(JSON.stringify(value));
const editRate=p=>p.spec.fps.num/p.spec.fps.den;
const editFrameAtTime=(p,seconds)=>Math.floor(seconds*editRate(p)+1e-4);
const editTimelineFrame=(p,pixels,zoom,end=false)=>Math.max(0,Math.min(p.spec.duration_frames-(end?0:1),Math.round(pixels/zoom*editRate(p))));
const editZoomLevels=['overview','standard','detail','fine','frame'];
function editZoomScale(p,width,level){const fit=width/(p.spec.duration_frames/editRate(p));return level==='frame'?Math.max(4*editRate(p),fit*16):fit*2**Math.max(0,editZoomLevels.indexOf(level))}
function editTime(p,frame){const ms=Math.round(frame*p.spec.fps.den*1000/p.spec.fps.num);return Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0')}
function editParseTime(p,text){
  const match=/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if(!match||match[1]&&Number(match[2])>=60)return null;
  const ms=(Number(match[1]||0)*60+Number(match[2]))*1000+Number((match[3]||'').padEnd(3,'0'));
  return Math.round(ms*p.spec.fps.num/(1000*p.spec.fps.den));
}
const editElementKey=e=>JSON.stringify([e.track_key,e.element_type,e.element_id]);
function editIntersections(review,range){return review.elements.filter(e=>range.tracks.includes(e.track_key)&&e.start_frame<range.end&&e.end_frame>range.start)}
function editRangeIssue(p,review,range){
  if(!Number.isInteger(range.start)||!Number.isInteger(range.end))return '请填写完整的整数帧或分:秒.毫秒时间。';
  if(range.start<0||range.end>p.spec.duration_frames)return '范围须在 0–'+p.spec.duration_frames+' 帧之间。';
  if(range.start>=range.end)return '止帧须大于起帧，至少选择一帧。';
  if(!range.tracks.length)return '请选择至少一条轨道。';
  if(!editIntersections(review,range).length)return '选段没有相交素材，请调整时间或轨道。';
  return '';
}
function editAnchor(output,review,variant,range){
  const p=output.payload.project,component=output.payload.components.find(c=>c.id===variant);
  const issue=editRangeIssue(p,review,range);if(issue)throw Error(issue);
  return {type:'time',component_id:component.id,asset_file:component.file,start_seconds:range.start/editRate(p),end_seconds:range.end/editRate(p),
    edit_selection:{snapshot:output.payload.snapshot,association:review.association,start_frame:range.start,end_frame:range.end,
      tracks:range.tracks,track_titles:review.tracks.filter(t=>range.tracks.includes(t.key)).map(t=>t.title),
      elements:editIntersections(review,range).map(e=>Object.fromEntries(['track_key','element_type','element_id','element_digest','binding'].filter(k=>k in e).map(k=>[k,e[k]])))}};
}
const editCurrent=ctx=>ctx.epoch===episodeEditing.epoch&&ctx.readEpoch===productionReadEpoch&&state.workspace==='settings.workspace'&&productionTab()==='editing';
function pauseEpisodePlayer(){episodeEditing.timelineObserver?.disconnect();episodeEditing.abort?.abort();document.querySelector('#production-view video[data-episode-player]')?.pause()}
async function editCall(action,value={}){return api('/api/editing/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})}
function editRoute(values){const u=new URL(location.href);for(const [k,v] of Object.entries(values)){if(v===null)u.searchParams.delete(k);else u.searchParams.set(k,v)}history.replaceState(history.state,'',u)}
function editControl(host,label,value){const wrap=nodeText('label',null,'',host);nodeText('span',null,label,wrap);const input=el('input');input.type='text';input.value=value;input.setAttribute('aria-label',label);wrap.append(input);return input}
function editChoices(host,key,label,options,value,change){
  if(!options.length)return;
  const group=flatFilterGroup(host,key,label,options,value,null,()=>{}),buttons=[...group.querySelectorAll('button')];
  buttons.forEach((button,index)=>{button.onclick=()=>{if(button.getAttribute('aria-pressed')==='true')return;return Promise.resolve(change(options[index][0])).catch(e=>toast(e.message))}});return group;
}
function editRemember(ctx){try{localStorage.setItem('episode-review:'+location.pathname+':'+ctx.episode,JSON.stringify({output:ctx.output,variant:ctx.variant,views:ctx.views}));localStorage.setItem('episode-review:last:'+location.pathname,ctx.episode)}catch{if(!ctx.storageWarning){ctx.storageWarning=true;toast('审阅位置未能保存到本机；当前选择仍保留。')}}}
function clearEpisodeEditReview(){
  if(typeof rememberProductionDraft==='function')rememberProductionDraft();
  state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionEntityId=null;state.productionSelected=null;state.productionDetail=null;state.reviewReferenceContext=null;state.reviewCommentScope=null;state.anchor=null;state.editing=null;state.selected=null;state.drawMode=null;
}
async function loadEpisodeEditing(){
  pauseEpisodePlayer();const readEpoch=++productionReadEpoch;clearEpisodeEditReview();renderComments();
  const epoch=++episodeEditing.epoch,host=$('#production-view');productionTabs();host.replaceChildren();nodeText('p',null,'正在读取成片…',host);
  try{
    const data=await api('/api/editing/catalog');if(epoch!==episodeEditing.epoch||readEpoch!==productionReadEpoch||state.workspace!=='settings.workspace'||productionTab()!=='editing')return;
    const params=new URL(location.href).searchParams;let last;try{last=localStorage.getItem('episode-review:last:'+location.pathname)}catch{}
    const episode=params.get('edit_episode')||last||data.episodes[0]?.id;
    let ctx=episodeEditing.contexts.get(episode);
    if(!ctx){let saved;try{saved=JSON.parse(localStorage.getItem('episode-review:'+location.pathname+':'+episode)||'null')}catch{}
      ctx={episode,output:saved?.output,variant:saved?.variant||'subtitled',views:saved?.views||{},reviews:{}};episodeEditing.contexts.set(episode,ctx);
    }
    Object.assign(ctx,{data,host,epoch,readEpoch});
    const outputs=data.outputs.filter(o=>o.payload.project.episode.object_id===episode);
    ctx.output=params.get('edit_output')||ctx.output||outputs.at(-1)?.object_id;
    if(ctx.output&&!outputs.some(o=>o.object_id===ctx.output)){if(params.has('edit_output'))throw Error('此准确成片版本不可用；未替换为其他版本。');ctx.output=outputs.at(-1)?.object_id;}
    await loadEditOutput(ctx);
    const selected=params.get('edit_element');if(selected&&editCurrent(ctx)){const element=ctx.review?.elements.find(e=>editElementKey(e)===selected);if(element)await openEditElement(ctx,element,null)}
  }catch(error){if(epoch===episodeEditing.epoch&&readEpoch===productionReadEpoch){host.replaceChildren();nodeText('p','production-issue',error.message,host)}}
}
async function loadEditOutput(ctx){
  const output=ctx.data.outputs.find(o=>o.object_id===ctx.output),id=ctx.output;
  if(output){const review=await editCall('review',{object_id:output.object_id,revision_id:output.id});if(!editCurrent(ctx)||ctx.output!==id)return;ctx.review=review;ctx.reviews[output.id]=review}
  else ctx.review=null;
  editRoute({edit_episode:ctx.episode,edit_output:ctx.output||null});renderEpisodeEditing(ctx);
}
function editView(ctx,output){return ctx.views[output.id]||=( {frame:0,zoomLevel:'overview',scroll:0,range:{start:0,end:output.payload.project.spec.duration_frames,tracks:[]},selected:null} )}
async function openEditElement(ctx,element,trigger){
  if(!editCurrent(ctx)||ctx.selecting)return;
  const output=ctx.data.outputs.find(o=>o.object_id===ctx.output),v=editView(ctx,output),p=output.payload.project;
  ctx.host.querySelector('video')?.pause();v.selected=editElementKey(element);ctx.paintSelection?.();editRemember(ctx);
  if(element.unavailable||!element.binding){toast(element.unavailable||'原素材关联不可用：'+element.element_id);return}
  const b=element.binding,range={start:Math.max(0,Math.floor(element.start_frame)),end:Math.min(p.spec.duration_frames,Math.ceil(element.end_frame)),tracks:[element.track_key]};
  const anchor=editAnchor(output,ctx.review,ctx.variant,range);
  editRoute({edit_element:editElementKey(element)});
  await openUnifiedMaterial({...b.asset,component_id:b.component.id,entry_id:b.entry_id,expectedOrigin:b.origin,
    onClose:()=>editRoute({edit_element:null}),
    onReady:(dialog,result)=>{
      const banner=el('section','edit-context production-toolbar');dialog.insertBefore(banner,dialog.querySelector('.review-dialog-body'));
      nodeText('p',null,'成片片段 · '+ctx.review.tracks.find(t=>t.key===element.track_key).title+' · '+element.title+' · '+editTime(p,range.start)+'–'+editTime(p,range.end),banner);
      const source=result.detail;
      const focusClip=()=>{focusProductionReview({record:output,history:[output],uses:[]},false);state.reviewCommentScope=null;restoreProductionDraft();};
      productionButton(banner,'评论此片段',()=>{focusClip();startDraft(anchor)});
      productionButton(banner,'源素材评论',()=>{focusProductionReview(source,false);state.reviewCommentScope=null;restoreProductionDraft();if(!state.anchor)startDraft({type:'global'});else{openPanel();renderComments()}});
      focusClip();if(!state.anchor)state.anchor=anchor;renderComments();
    }},trigger);
}
function renderEpisodeEditing(ctx){
  if(!editCurrent(ctx))return;
  episodeEditing.timelineObserver?.disconnect();episodeEditing.abort?.abort();const abort=episodeEditing.abort=new AbortController();
  ctx.host.querySelector('video')?.pause();const render=ctx.render=(ctx.render||0)+1,host=ctx.host;
  const outputs=ctx.data.outputs.filter(o=>o.payload.project.episode.object_id===ctx.episode),output=outputs.find(o=>o.object_id===ctx.output),project=output?.payload.project;
  host.replaceChildren();host.classList.add('episode-editing');productionTabs();
  const head=el('section','production-filters edit-filters');host.append(head);
  editChoices(head,'edit-episode','视听集',ctx.data.episodes.map(e=>[e.id,e.title]),ctx.episode,value=>{editRemember(ctx);editRoute({edit_episode:value,edit_output:null,edit_element:null});loadEpisodeEditing()});
  if(!output){clearEpisodeEditReview();nodeText('p',null,'本集尚无可审阅成片。',host);renderComments();return}
  const v=editView(ctx,output),review=ctx.review;ctx.selecting=false;
  if(!editZoomLevels.includes(v.zoomLevel))v.zoomLevel='overview';
  editChoices(head,'edit-output','成片版本',outputs.map((o,i)=>[o.object_id,'版本 '+(i+1)]),ctx.output,async value=>{editRemember(ctx);ctx.host.querySelector('video')?.pause();ctx.output=value;ctx.loop=false;editRoute({edit_output:value,edit_element:null});clearEpisodeEditReview();await loadEditOutput(ctx)});
  editChoices(head,'edit-variant','字幕',[['subtitled','对白与唱词字幕'],['clean','无对白与唱词字幕']],ctx.variant,value=>{ctx.variant=value;ctx.loop=false;clearEpisodeEditReview();renderEpisodeEditing(ctx)});
  const downloads=el('details','edit-downloads');nodeText('summary',null,'下载',downloads);
  for(const [id,title] of [['subtitled','字幕版 MP4'],['clean','无字幕版 MP4'],['mix','混音母版 WAV'],['subtitles','字幕 SRT'],['project','可编辑工程 JSON'],['source-map','原件与来源映射']]){const c=output.payload.components.find(c=>c.id===id),a=nodeText('a',null,title,downloads);a.href=reviewURL('/api/production/files/'+encodeURIComponent(c.file));a.download=ctx.episode+'-'+id+'.'+c.file.split('.').at(-1)}head.append(downloads);
  state.productionRecords=outputs;focusProductionReview({record:output,history:[output],uses:[]},false);
  const layout=el('div','edit-layout'),nav=el('nav','edit-scenes breakdown-scene-list'),main=el('div','edit-main');nav.setAttribute('aria-label','场镜导航');layout.append(nav,main);host.append(layout);
  const reader=el('section');reader.id='production-reader';main.append(reader);
  const player=el('section','review-media-player edit-player'),component=output.payload.components.find(c=>c.id===ctx.variant),media=el('video');
  Object.assign(player.dataset,{reviewRevision:output.id,reviewFile:component.file,reviewFrom:0,reviewTo:project.spec.duration_frames/editRate(project)});
  media.controls=true;media.preload='metadata';media.dataset.episodePlayer='true';media.dataset.componentId=component.id;media.src=reviewURL('/api/production/files/'+component.file);player.append(media);reader.append(player);
  player.reviewFocus=()=>focusProductionReview({record:output,history:[output],uses:[]},false);reviewSurface(player,'audio');
  const current=()=>editCurrent(ctx)&&ctx.render===render&&ctx.output===output.object_id&&media.isConnected;
  const tools=el('div','edit-timeline-tools');main.append(tools);const zoomGroup=el('div','edit-zoom-group');tools.append(zoomGroup);
  editChoices(zoomGroup,'edit-zoom','时间线缩放',editZoomLevels.map((level,i)=>[level,['全片概览','标准','细看','精细','逐帧'][i]]),v.zoomLevel,value=>{v.zoomLevel=value;for(const b of zoomGroup.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b.dataset.filterValue===value));layoutTimeline()});
  const position=el('div','edit-play-position');nodeText('span',null,'播放起点',position);const clock=nodeText('output',null,v.frame+' 帧',position);clock.setAttribute('aria-label','播放起点');tools.append(position);
  const controls=el('div','edit-toolbar production-toolbar edit-range-controls');controls.setAttribute('aria-label','选帧范围');tools.append(controls);
  const selectButton=productionButton(controls,'选择',()=>setSelecting(!ctx.selecting));selectButton.setAttribute('aria-pressed','false');
  const inputs={start:editControl(controls,'范围起帧',v.range.start),end:editControl(controls,'范围止帧',v.range.end),startTime:editControl(controls,'起点时间',editTime(project,v.range.start)),endTime:editControl(controls,'终点时间',editTime(project,v.range.end))};
  inputs.start.inputMode=inputs.end.inputMode='numeric';inputs.startTime.placeholder=inputs.endTime.placeholder='分:秒.毫秒';
  const loop=productionButton(controls,'循环选段',()=>{if(rangeIssue)return;ctx.loop=!ctx.loop;loop.setAttribute('aria-pressed',String(!!ctx.loop));if(ctx.loop){seek(v.range.start);return media.play()}});loop.setAttribute('aria-pressed',String(!!ctx.loop));
  const comment=productionButton(controls,'评论此范围',()=>{if(rangeIssue)return;media.pause();player.reviewFocus();startDraft(editAnchor(output,review,ctx.variant,v.range))});
  productionButton(controls,'清除选择',()=>{v.range.tracks=[];ctx.loop=false;paintSelection();editRemember(ctx)});
  const trackTools=el('div','edit-track-choices production-filter-group');trackTools.setAttribute('aria-label','选中轨道');main.append(trackTools);nodeText('span','production-filter-label','轨道',trackTools);
  const trackButtons=review.tracks.map(track=>{const b=productionButton(trackTools,track.title,()=>{const keys=new Set(v.range.tracks);if(keys.has(track.key))keys.delete(track.key);else keys.add(track.key);v.range.tracks=review.tracks.map(t=>t.key).filter(k=>keys.has(k));paintSelection();editRemember(ctx)});b.className='production-filter-chip';return b});
  const hint=nodeText('p','edit-hint','起帧包含，止帧不含；时间显示到毫秒，实际范围以整数帧为准。',main),feedback=nodeText('p','edit-range-feedback','',main);feedback.setAttribute('role','status');
  let rangeIssue='',fieldIssue='';
  const scroll=el('div','edit-timeline-scroll'),timeline=el('div','edit-timeline');scroll.append(timeline);main.append(scroll);timeline.setAttribute('aria-label','成片多轨时间线');
  const labelWidth=112,content=el('div','edit-timeline-content');timeline.append(content);const ruler=el('div','edit-ruler');content.append(ruler);
  const rows=[],buttons=[],overlays=[];
  for(const track of review.tracks){
    const row=el('div','edit-track');row.dataset.trackKey=track.key;row.setAttribute('aria-label',track.title);content.append(row);rows.push(row);
    const shade=el('div','edit-range-shade');row.append(shade);overlays.push(shade);
    const name=nodeText('span','edit-track-name',track.title,row);name.title=track.title;
    for(const item of review.elements.filter(e=>e.track_key===track.key)){const button=nodeText('button','edit-clip '+(item.element_type==='clip'?(project.clips.find(c=>c.id===item.element_id)?.kind||''):'text-layer'),item.title,row);button.type='button';button.dataset.elementKey=editElementKey(item);button.title=item.title+' · '+editTime(project,Math.floor(item.start_frame))+'–'+editTime(project,Math.ceil(item.end_frame));button.onclick=event=>{event.stopPropagation();if(!current()||ctx.selecting||suppressClick)return;if(event.detail===0)seek(item.start_frame);else seek(eventFrame(event));return openEditElement(ctx,item,button).catch(e=>toast(e.message))};buttons.push([button,item]);}
  }
  const playhead=el('div','edit-playhead');content.append(playhead);playhead.tabIndex=0;playhead.setAttribute('role','slider');playhead.setAttribute('aria-label','播放头');playhead.setAttribute('aria-valuemin',0);playhead.setAttribute('aria-valuemax',project.spec.duration_frames-1);
  let zoom=0,viewWidth=0,gesture=null,suppressClick=false;
  function positionHead(){playhead.style.left=(labelWidth+v.frame/editRate(project)*zoom)+'px';playhead.setAttribute('aria-valuenow',v.frame);clock.textContent=v.frame+' 帧'}
  function seek(frame,remember=true){if(!current()||!Number.isFinite(frame))return;media.pause();v.frame=Math.max(0,Math.min(project.spec.duration_frames-1,Math.round(frame)));media.currentTime=v.frame/editRate(project);positionHead();if(remember)editRemember(ctx)}
  const eventFrame=event=>editTimelineFrame(project,event.clientX-content.getBoundingClientRect().left-labelWidth,zoom,true);
  const inPlot=event=>event.clientX>=scroll.getBoundingClientRect().left+labelWidth&&!event.target.closest('.edit-track-name');
  function syncInputs(){inputs.start.value=v.range.start??'';inputs.end.value=v.range.end??'';inputs.startTime.value=Number.isInteger(v.range.start)?editTime(project,v.range.start):'';inputs.endTime.value=Number.isInteger(v.range.end)?editTime(project,v.range.end):'';fieldIssue='';paintSelection()}
  function paintSelection(){
    rangeIssue=fieldIssue||editRangeIssue(project,review,v.range);feedback.textContent=rangeIssue||'已选：'+review.tracks.filter(t=>v.range.tracks.includes(t.key)).map(t=>t.title).join('、')+' · '+editTime(project,v.range.start)+'–'+editTime(project,v.range.end);
    comment.disabled=loop.disabled=!!rangeIssue;if(rangeIssue){ctx.loop=false;loop.setAttribute('aria-pressed','false')}
    trackButtons.forEach((b,i)=>b.setAttribute('aria-pressed',String(v.range.tracks.includes(review.tracks[i].key))));
    const valid=Number.isInteger(v.range.start)&&Number.isInteger(v.range.end)&&v.range.end>v.range.start&&!fieldIssue;
    rows.forEach((row,i)=>{const selected=valid&&v.range.tracks.includes(review.tracks[i].key);row.classList.toggle('range-selected',selected);const shade=overlays[i];shade.hidden=!selected;shade.style.left=labelWidth+v.range.start/editRate(project)*zoom+'px';shade.style.width=(v.range.end-v.range.start)/editRate(project)*zoom+'px'});
    for(const [button,item] of buttons){const selected=valid&&v.range.tracks.includes(item.track_key)&&item.start_frame<v.range.end&&item.end_frame>v.range.start;button.classList.toggle('range-selected',selected);button.setAttribute('aria-pressed',String(v.selected===editElementKey(item)))}
  }
  ctx.paintSelection=paintSelection;
  for(const [key,input] of Object.entries(inputs)){
    input.oninput=()=>{const field=key.startsWith('start')?'start':'end';const frame=key.endsWith('Time')?editParseTime(project,input.value):/^\d+$/.test(input.value)?Number(input.value):null;v.range[field]=frame;
      if(Number.isInteger(frame)){if(key.endsWith('Time'))inputs[field].value=frame;else inputs[field+'Time'].value=editTime(project,frame)}
      fieldIssue=Object.values(inputs).some(i=>!i.value.trim())||frame===null?'请填写完整的整数帧或分:秒.毫秒时间。':'';paintSelection();editRemember(ctx)};
    const commit=()=>{if(v.range.start!==null&&v.range.end!==null&&!fieldIssue)syncInputs()};input.onblur=commit;input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();commit()}};
  }
  function setSelecting(value){ctx.selecting=value;selectButton.setAttribute('aria-pressed',String(value));timeline.classList.toggle('selecting',value);if(value)media.pause()}
  function finishGesture(cancel=false){if(!gesture)return;const g=gesture;gesture=null;if(cancel&&g.kind==='range'){v.range=g.previous;syncInputs()}suppressClick=g.moved||g.kind==='range';if(g.target.hasPointerCapture(g.id))g.target.releasePointerCapture(g.id);playhead.classList.remove('dragging');editRemember(ctx)}
  timeline.onpointerdown=event=>{
    suppressClick=false;if(event.button!==0||!current()||!inPlot(event))return;
    const row=event.target.closest('.edit-track'),x=event.clientX,frame=eventFrame(event);
    if(ctx.selecting){if(!row)return;event.preventDefault();media.pause();gesture={kind:'range',id:event.pointerId,target:timeline,x,y:event.clientY,frame,previous:editClone(v.range),moved:false};}
    else{const headX=content.getBoundingClientRect().left+labelWidth+v.frame/editRate(project)*zoom;if(Math.abs(x-headX)>8)return;gesture={kind:'head',id:event.pointerId,target:event.target,x,offset:x-headX,moved:false};}
    gesture.target.setPointerCapture(event.pointerId);
  };
  timeline.onpointermove=event=>{
    if(!gesture||event.pointerId!==gesture.id||!current())return;const g=gesture;if(!g.moved&&Math.hypot(event.clientX-g.x,event.clientY-(g.y||event.clientY))<3)return;g.moved=true;event.preventDefault();
    if(g.kind==='head'){playhead.classList.add('dragging');seek(editTimelineFrame(project,event.clientX-content.getBoundingClientRect().left-labelWidth-g.offset,zoom),false);return}
    const edge=scroll.getBoundingClientRect();if(event.clientX>edge.right)scroll.scrollLeft+=Math.min(30,event.clientX-edge.right);else if(event.clientX<edge.left+labelWidth)scroll.scrollLeft-=Math.min(30,edge.left+labelWidth-event.clientX);
    const end=eventFrame(event),start=Math.min(g.frame,end),stop=Math.max(g.frame,end);if(stop===start)return;
    const y1=Math.min(g.y,event.clientY),y2=Math.max(g.y,event.clientY);v.range={start,end:stop,tracks:review.tracks.filter((t,i)=>{const r=rows[i].getBoundingClientRect();return r.top<y2&&r.bottom>y1}).map(t=>t.key)};syncInputs();
  };
  timeline.onpointerup=()=>finishGesture(false);timeline.onpointercancel=()=>finishGesture(true);timeline.onlostpointercapture=()=>{if(gesture)finishGesture(true)};
  timeline.addEventListener('click',event=>{if(suppressClick||ctx.selecting&&event.target.closest('.edit-track')){event.preventDefault();event.stopPropagation();suppressClick=false}},true);
  timeline.onclick=event=>{if(event.detail>0&&current()&&inPlot(event)&&!ctx.selecting)seek(eventFrame(event))};
  playhead.onclick=event=>event.stopPropagation();playhead.onkeydown=event=>{const f=({ArrowLeft:v.frame-1,ArrowRight:v.frame+1,Home:0,End:project.spec.duration_frames-1})[event.key];if(f!==undefined&&!ctx.selecting){event.preventDefault();seek(f)}};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&current()&&!state.unifiedCardRoot&&(ctx.selecting||gesture)){event.preventDefault();event.stopImmediatePropagation();if(gesture)finishGesture(true);else setSelecting(false)}},{capture:true,signal:abort.signal});
  scroll.onscroll=()=>{if(current()){v.scroll=scroll.scrollLeft;editRemember(ctx)}};
  function follow(){if(!current()||media.paused||ctx.selecting)return;const x=v.frame/editRate(project)*zoom,width=scroll.clientWidth-labelWidth;if(x>scroll.scrollLeft+width*.8)scroll.scrollLeft=x-width*.8;else if(x<scroll.scrollLeft+width*.1)scroll.scrollLeft=Math.max(0,x-width*.2)}
  function layoutTimeline(restore=false){if(!current())return;const width=scroll.clientWidth-labelWidth;if(width<=0)return;const offset=v.frame/editRate(project)*zoom-scroll.scrollLeft,anchor=viewWidth&&offset>=0&&offset<=viewWidth?offset/viewWidth*width:width/2;viewWidth=width;zoom=editZoomScale(project,width,v.zoomLevel);const duration=project.spec.duration_frames/editRate(project);content.style.width=(labelWidth+duration*zoom)+'px';content.style.setProperty('--edit-frame-width',zoom/editRate(project)+'px');content.classList.toggle('edit-frame-grid',zoom/editRate(project)>=2);
    for(const [button,item] of buttons){button.style.left=labelWidth+item.start_frame/editRate(project)*zoom+'px';button.style.width=Math.max(2,(item.end_frame-item.start_frame)/editRate(project)*zoom)+'px'}
    ruler.replaceChildren();const step=[1,2,5,10,30,60,120,300,600].find(n=>n*zoom>=60)||600;for(let n=0;n<duration;n+=step){const tick=nodeText('button',null,n+'s',ruler);tick.style.left=labelWidth+n*zoom+'px';tick.onclick=event=>{if(event.detail===0)seek(n*editRate(project))}}
    positionHead();scroll.scrollLeft=v.zoomLevel==='overview'?0:restore?v.scroll||0:Math.max(0,v.frame/editRate(project)*zoom-anchor);paintSelection();editRemember(ctx);
  }
  player.reviewLocate=a=>{if(a.asset_file!==component.file)return false;v.range=a.edit_selection?{start:a.edit_selection.start_frame,end:a.edit_selection.end_frame,tracks:[...a.edit_selection.tracks]}:{start:Math.round(a.start_seconds*editRate(project)),end:Math.round(a.end_seconds*editRate(project)),tracks:[]};syncInputs();seek(v.range.start);feedback.textContent=a.edit_selection?feedback.textContent:'历史混合范围 · '+editTime(project,v.range.start)+'–'+editTime(project,v.range.end);return true};
  for(const marker of project.markers||[]){productionButton(nav,marker.title,()=>seek(marker.frame));for(const c of project.clips.filter(c=>c.kind==='video'&&c.scene_id===marker.id))productionButton(nav,c.title||c.id,()=>seek(c.timeline_start))}
  media.onloadedmetadata=()=>{if(current())media.currentTime=Math.min(v.frame/editRate(project),media.duration)};
  media.addEventListener('timeupdate',()=>{if(!current())return;v.frame=Math.min(project.spec.duration_frames-1,editFrameAtTime(project,media.currentTime));positionHead();follow();if(ctx.loop&&!rangeIssue&&!media.paused&&media.currentTime>=v.range.end/editRate(project)){media.currentTime=v.range.start/editRate(project);media.play().catch(()=>{})}});
  media.addEventListener('play',follow);media.addEventListener('pause',()=>{if(current())editRemember(ctx)});
  media.addEventListener('ended',()=>{if(current()&&ctx.loop&&!rangeIssue){media.currentTime=v.range.start/editRate(project);media.play().catch(()=>{})}});
  requestAnimationFrame(()=>{if(!current())return;layoutTimeline(true);if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{if(!current()){observer.disconnect();return}if(scroll.clientWidth-labelWidth!==viewWidth)layoutTimeline()});episodeEditing.timelineObserver=observer;observer.observe(scroll)}});
  renderComments();editRemember(ctx);
}
function isEpisodeEditComment(comment){return [...episodeEditing.contexts.values()].some(c=>c.data?.outputs.some(o=>o.object_id===comment.target_object_id&&o.id===comment.target_revision_id))}
async function locateEpisodeEditComment(comment){
  const ctx=[...episodeEditing.contexts.values()].find(c=>c.epoch===episodeEditing.epoch),output=ctx?.data.outputs.find(o=>o.object_id===comment.target_object_id&&o.id===comment.target_revision_id);
  if(!output)return false;
  if(state.unifiedCardRoot){focusProductionReview({record:output,history:[output],uses:[]},false);state.selected=comment.id;renderComments();return true}
  const component=output.payload.components.find(c=>c.id===comment.anchor.component_id&&c.file===comment.anchor.asset_file);
  if(!component||!['subtitled','clean'].includes(component.id)){toast('此评论的准确成片组件不可用。');return true}
  ctx.host.querySelector('video')?.pause();ctx.output=output.object_id;ctx.loop=false;ctx.variant=component.id;
  const review=await editCall('review',{object_id:output.object_id,revision_id:output.id,association:comment.anchor.edit_selection?.association});if(!editCurrent(ctx))return false;ctx.review=review;
  editRoute({edit_output:ctx.output});renderEpisodeEditing(ctx);return locateProductionComment(comment,true);
}
