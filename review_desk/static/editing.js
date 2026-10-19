/* One composed player clock; editing never silently changes the shown output. */
const episodeEditing={epoch:0,contexts:new Map()};
function pauseEpisodePlayer(){episodeEditing.timelineObserver?.disconnect();document.querySelector('#production-view video[data-episode-player]')?.pause()}
const editCurrent=ctx=>ctx.epoch===episodeEditing.epoch&&ctx.readEpoch===productionReadEpoch&&state.workspace==='settings.workspace'&&productionTab()==='editing';
const editClone=value=>JSON.parse(JSON.stringify(value));
const editRate=p=>p.spec.fps.num/p.spec.fps.den;
// Chrome exposes media time rounded to microseconds; retain an exact frame seek.
const editFrameAtTime=(p,seconds)=>Math.floor(seconds*editRate(p)+1e-4);
const editTimelineFrame=(p,pixels,zoom)=>Math.max(0,Math.min(p.spec.duration_frames-1,Math.round(pixels/zoom*editRate(p))));
const editZoomLevels=['overview','standard','detail','fine','frame'];
function editZoomScale(p,width,level){const fit=width/(p.spec.duration_frames/editRate(p));return level==='frame'?Math.max(4*editRate(p),fit*16):fit*2**Math.max(0,editZoomLevels.indexOf(level))}
const editSource=(p,c)=>p.sources.find(s=>s.id===c.source_id);
const editFraction=text=>{const [a,b=1]=String(text).split('/').map(Number);return a/b};
function editLength(p,c){const s=editSource(p,c);return Math.round((c.source_out-c.source_in)*(c.kind==='video'?editRate(p)/editFraction(s.video.fps):p.spec.sample_rate/s.audio.sample_rate))}
async function editCall(action,value={}){return api('/api/editing/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})}
function editRoute(values){const u=new URL(location.href);for(const [k,v] of Object.entries(values)){if(v===null)u.searchParams.delete(k);else u.searchParams.set(k,v)}history.replaceState(history.state,'',u)}
function editControl(host,label,type,value){const wrap=nodeText('label',null,'',host);nodeText('span',null,label,wrap);const input=el('input');input.type=type;input.value=value;input.setAttribute('aria-label',label);wrap.append(input);return input}
function editChoices(host,key,label,options,value,change){
  if(!options.length)return;
  const group=flatFilterGroup(host,key,label,options,value,null,()=>{}),buttons=[...group.querySelectorAll('button')];
  buttons.forEach((button,index)=>{button.onclick=()=>{if(button.getAttribute('aria-pressed')==='true')return;for(const b of buttons)b.setAttribute('aria-pressed',String(b===button));return Promise.resolve(change(options[index][0])).catch(e=>toast(e.message))}});return group;
}
function editRemember(ctx){try{localStorage.setItem('episode-edit:'+location.pathname+':'+ctx.episode,JSON.stringify({output:ctx.output,variant:ctx.variant,frame:ctx.frame,zoom:ctx.zoom,zoomLevel:ctx.zoomLevel,ranges:ctx.ranges,timelineScroll:ctx.timelineScroll,draft:ctx.draft,basis:ctx.project?.id,version:ctx.project?.version,dirty:!!editChanged(ctx),recoveries:ctx.recoveries,selected:ctx.selected,selectedTitle:ctx.selectedTitle}));localStorage.setItem('episode-edit:last:'+location.pathname,ctx.episode)}catch{toast('本机草稿保存失败；当前草稿仍在页面中，请保存工程。')}}
function editChanged(ctx){return ctx.project&&JSON.stringify(ctx.draft)!==JSON.stringify(ctx.project.payload)}
function editKeepRecovery(recoveries,saved){
  if(!saved?.basis||!saved.draft)return;
  if(!recoveries.some(r=>r.basis===saved.basis&&JSON.stringify(r.draft)===JSON.stringify(saved.draft)))recoveries.push({basis:saved.basis,version:saved.version,draft:editClone(saved.draft)});
}
function editRestoreDraft(ctx,recovery){
  if(!ctx.recoveries.includes(recovery))return;
  ctx.recoveries=ctx.recoveries.filter(r=>r!==recovery);
  // Restoring an older draft must not discard newer, unsaved work either.
  if(editChanged(ctx)&&JSON.stringify(ctx.draft)!==JSON.stringify(recovery.draft))editKeepRecovery(ctx.recoveries,{basis:ctx.project.id,version:ctx.project.version,draft:ctx.draft});
  editMutation(ctx,()=>{ctx.draft=editClone(recovery.draft)});
}
function editMutation(ctx,fn){ctx.undo.push(editClone(ctx.draft));if(ctx.undo.length>40)ctx.undo.shift();ctx.redo=[];fn(ctx.draft);editRemember(ctx);renderEpisodeEditing(ctx)}
function clearEpisodeEditReview(){
  if(typeof rememberProductionDraft==='function')rememberProductionDraft();
  state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionEntityId=null;state.productionSelected=null;state.productionDetail=null;state.reviewReferenceContext=null;state.reviewCommentScope=null;state.anchor=null;state.editing=null;state.selected=null;state.drawMode=null;
}
async function loadEpisodeEditing(){
  const readEpoch=++productionReadEpoch,workspace=state.workspace;clearEpisodeEditReview();renderComments();
  const epoch=++episodeEditing.epoch,host=$('#production-view');episodeEditing.timelineObserver?.disconnect();host.querySelector('video')?.pause();productionTabs();host.replaceChildren();nodeText('p',null,'正在读取成片工程…',host);
  try{
    const data=await api('/api/editing/catalog');if(epoch!==episodeEditing.epoch||readEpoch!==productionReadEpoch||workspace!==state.workspace||state.workspace!=='settings.workspace'||productionTab()!=='editing')return;
    const params=new URL(location.href).searchParams;let last;try{last=localStorage.getItem('episode-edit:last:'+location.pathname)}catch{}
    const episode=params.get('edit_episode')||last||data.episodes[0]?.id;
    let ctx=episodeEditing.contexts.get(episode);const project=data.projects.find(p=>p.payload.episode.object_id===episode);
    if(!ctx){let saved;try{saved=JSON.parse(localStorage.getItem('episode-edit:'+location.pathname+':'+episode)||'null')}catch{}
      ctx={episode,output:saved?.output,variant:saved?.variant||'subtitled',frame:saved?.frame||0,zoom:0,zoomLevel:editZoomLevels.includes(saved?.zoomLevel)?saved.zoomLevel:({2:'overview',4:'standard',8:'detail',16:'fine',96:'frame'}[saved?.zoom]||'overview'),ranges:saved?.ranges||{},timelineScroll:saved?.timelineScroll||0,undo:[],redo:[],selected:saved?.selected,selectedTitle:saved?.selectedTitle,
        draft:saved&&project&&saved.basis===project.id?saved.draft:project?editClone(project.payload):null,project,recoveries:[]};episodeEditing.contexts.set(episode,ctx);
      for(const recovery of Array.isArray(saved?.recoveries)?saved.recoveries:[])editKeepRecovery(ctx.recoveries,recovery);
      // Older storage has no dirty flag: preserve it conservatively once.
      if(saved?.draft&&saved.basis!==project?.id&&saved.dirty!==false)editKeepRecovery(ctx.recoveries,saved);
    }else if(project?.id!==ctx.project?.id&&!editChanged(ctx)){ctx.project=project;ctx.draft=project?editClone(project.payload):null}
    ctx.data=data;ctx.host=host;ctx.epoch=epoch;ctx.readEpoch=readEpoch;ctx.job=(data.jobs||[]).find(j=>j.episode_id===episode)||null;
    const outputs=data.outputs.filter(o=>o.payload.project.episode.object_id===episode);
    ctx.output=params.get('edit_output')||ctx.output||outputs.at(-1)?.object_id;
    if(ctx.output&&!outputs.some(o=>o.object_id===ctx.output)){if(params.has('edit_output'))throw Error('此准确成片版本不可用，请从本集入口重新选择。');ctx.output=outputs.at(-1)?.object_id;}
    editRoute({edit_episode:episode,edit_output:ctx.output||null});renderEpisodeEditing(ctx);
  }catch(error){if(epoch===episodeEditing.epoch&&readEpoch===productionReadEpoch&&workspace===state.workspace&&state.workspace==='settings.workspace'){host.replaceChildren();nodeText('p','production-issue',error.message,host)}}
}
function renderEpisodeEditing(ctx){
  if(!editCurrent(ctx))return;
  episodeEditing.timelineObserver?.disconnect();
  const render=ctx.render=(ctx.render||0)+1;
  const host=ctx.host,outputs=ctx.data.outputs.filter(o=>o.payload.project.episode.object_id===ctx.episode);
  const output=outputs.find(o=>o.object_id===ctx.output),project=output?.payload.project;
  const prior=host.querySelector('video[data-episode-player]');if(prior){if(prior.readyState>=1)ctx.frame=project?editFrameAtTime(project,prior.currentTime):Math.floor(prior.currentTime*24+1e-4);prior.pause()}
  host.replaceChildren();host.classList.add('episode-editing');productionTabs();
  const head=el('section','production-filters edit-filters');host.append(head);
  editChoices(head,'edit-episode','视听集',ctx.data.episodes.map(e=>[e.id,e.title]),ctx.episode,value=>{editRemember(ctx);editRoute({edit_episode:value,edit_output:null});loadEpisodeEditing()});
  if(outputs.length){
    editChoices(head,'edit-output','成片版本',outputs.map((o,i)=>[o.object_id,'版本 '+(i+1)]),ctx.output,value=>{editRemember(ctx);const old=host.querySelector('video');old?.pause();old?.removeAttribute('data-episode-player');ctx.output=value;ctx.frame=0;ctx.loop=false;editRoute({edit_output:ctx.output});renderEpisodeEditing(ctx)});
    editChoices(head,'edit-variant','字幕',[['subtitled','对白与唱词字幕'],['clean','无对白与唱词字幕']],ctx.variant,value=>{ctx.variant=value;editRemember(ctx);renderEpisodeEditing(ctx)});
    const downloads=el('details','edit-downloads');nodeText('summary',null,'下载',downloads);
    for(const [id,title] of [['subtitled','字幕版 MP4'],['clean','无字幕版 MP4'],['mix','混音母版 WAV'],['subtitles','字幕 SRT'],['project','可编辑工程 JSON'],['source-map','原件与来源映射']]){
      const c=output.payload.components.find(c=>c.id===id),a=nodeText('a',null,title,downloads);a.href=reviewURL('/api/production/files/'+encodeURIComponent(c.file));a.download=ctx.episode+'-'+id+'.'+c.file.split('.').at(-1);
    }head.append(downloads);
  }
  if(!output){clearEpisodeEditReview();renderComments()}
  if(!ctx.project){nodeText('p',null,'本集尚未建立剪辑工程。工程由制作任务导入后可在此继续编辑和审阅。',host);return}
  if(ctx.recoveries.length){const recovery=el('div','edit-notice');nodeText('p',null,'另有本机草稿，已保留。恢复后仍须按当前工程版本检查再保存。',recovery);ctx.recoveries.forEach((saved,i)=>productionButton(recovery,'恢复本机草稿'+(ctx.recoveries.length>1?' '+(i+1):'')+(saved.version?'（工程版本 '+saved.version+'）':''),()=>editRestoreDraft(ctx,saved)));host.append(recovery)}
  if(editChanged(ctx)||output&&output.payload.snapshot&&JSON.stringify(project)!==JSON.stringify(ctx.draft))nodeText('p','edit-notice','工程草稿已有修改，当前预览尚未更新。播放器和时间线仍对应所选成片版本。',host);
  const layout=el('div','edit-layout'),nav=el('nav','edit-scenes breakdown-scene-list'),main=el('div','edit-main');nav.setAttribute('aria-label','场镜导航');layout.append(nav,main);host.append(layout);
  let media,rangeStart,rangeEnd,playhead,frameFact,followPlayback=()=>{};
  const currentPlayer=()=>editCurrent(ctx)&&ctx.render===render&&ctx.output===output?.object_id&&media?.isConnected;
  const positionPlayhead=()=>{if(!playhead)return;playhead.style.left=ctx.frame/editRate(project)*ctx.zoom+'px';playhead.setAttribute('aria-valuenow',ctx.frame);playhead.setAttribute('aria-valuetext',ctx.frame+' 帧，'+(ctx.frame/editRate(project)).toFixed(3)+' 秒')};
  const seek=(frame,remember=true)=>{if(!currentPlayer()||!Number.isFinite(frame))return;media.pause();ctx.frame=Math.max(0,Math.min(project.spec.duration_frames-1,Math.round(frame)));frameFact.textContent=ctx.frame+' 帧';media.currentTime=ctx.frame/editRate(project);positionPlayhead();if(remember)editRemember(ctx)};
  if(output){
    state.productionRecords=outputs;if(state.productionSelected?.id!==output.id)focusProductionReview({record:output,history:[output],uses:[]},false);
    const reader=el('section');reader.id='production-reader';main.append(reader);const player=el('section','review-media-player edit-player');player.dataset.reviewRevision=output.id;
    const component=output.payload.components.find(c=>c.id===ctx.variant);player.dataset.reviewFile=component.file;player.dataset.reviewFrom=0;player.dataset.reviewTo=component.duration_seconds;
    media=el('video');media.controls=true;media.preload='metadata';media.dataset.episodePlayer='true';media.dataset.componentId=component.id;media.src=reviewURL('/api/production/files/'+component.file);player.append(media);reader.append(player);
    player.reviewFocus=()=>focusProductionReview({record:output,history:[output],uses:[]},false);
    player.reviewLocate=a=>{if(a.asset_file!==component.file)return false;rangeStart.value=editFrameAtTime(project,a.start_seconds);rangeEnd.value=Math.ceil(a.end_seconds*editRate(project)-1e-4);ctx.ranges[output.object_id]=[Number(rangeStart.value),Number(rangeEnd.value)];seek(Number(rangeStart.value));return true};
    reviewSurface(player,'audio');
    const tools=el('div','edit-timeline-tools');main.append(tools);
    const zoomGroup=el('div','edit-zoom-group');tools.append(zoomGroup);
    editChoices(zoomGroup,'edit-zoom','时间线缩放',editZoomLevels.map((level,i)=>[level,['全片概览','标准','细看','精细','逐帧'][i]]),ctx.zoomLevel,value=>{if(!currentPlayer())return;ctx.zoomLevel=value;layoutTimeline()});
    const position=el('div','edit-play-position');nodeText('span',null,'播放起点',position);frameFact=nodeText('output',null,ctx.frame+' 帧',position);frameFact.setAttribute('aria-label','播放起点');tools.append(position);
    const controls=el('div','edit-toolbar production-toolbar edit-range-controls');controls.setAttribute('aria-label','选帧范围');tools.append(controls);
    const range=ctx.ranges[output.object_id]||[0,project.spec.duration_frames];
    rangeStart=editControl(controls,'范围起帧','number',range[0]);rangeEnd=editControl(controls,'范围止帧','number',range[1]);
    const validRange=()=>{const a=Number(rangeStart.value),b=Number(rangeEnd.value);return Number.isInteger(a)&&Number.isInteger(b)&&a>=0&&b>a&&b<=project.spec.duration_frames};
    const loop=productionButton(controls,'循环选段',()=>{if(!validRange()){toast('请输入成片范围内的整数帧。');return}ctx.loop=!ctx.loop;loop.setAttribute('aria-pressed',String(!!ctx.loop));if(ctx.loop){seek(Number(rangeStart.value));return media.play()}});loop.setAttribute('aria-pressed',String(!!ctx.loop));loop.dataset.editLoop='true';
    rangeStart.onchange=rangeEnd.onchange=()=>{ctx.ranges[output.object_id]=[Number(rangeStart.value),Number(rangeEnd.value)];if(!validRange()){ctx.loop=false;loop.setAttribute('aria-pressed','false')}editRemember(ctx)};
    productionButton(controls,'评论此范围',()=>{const a=Number(rangeStart.value),b=Number(rangeEnd.value);if(!(Number.isInteger(a)&&Number.isInteger(b)&&a>=0&&b>a&&b<=project.spec.duration_frames)){toast('请输入成片范围内的整数帧。');return}player.reviewFocus();startDraft({type:'time',component_id:component.id,asset_file:component.file,start_seconds:a/editRate(project),end_seconds:b/editRate(project)})});
    media.onloadedmetadata=()=>{if(!currentPlayer())return;media.currentTime=Math.min(ctx.frame/editRate(project),media.duration)};
    media.addEventListener('timeupdate',()=>{if(!currentPlayer())return;ctx.frame=Math.min(project.spec.duration_frames-1,editFrameAtTime(project,media.currentTime));frameFact.textContent=ctx.frame+' 帧';positionPlayhead();followPlayback();if(ctx.loop&&!media.paused&&media.currentTime>=Number(rangeEnd.value)/editRate(project)){media.currentTime=Number(rangeStart.value)/editRate(project);media.play().catch(()=>{})}});
    media.addEventListener('play',()=>{if(currentPlayer())followPlayback()});
    media.addEventListener('pause',()=>{if(currentPlayer())editRemember(ctx)});
    media.addEventListener('ended',()=>{if(currentPlayer()&&ctx.loop&&validRange()){media.currentTime=Number(rangeStart.value)/editRate(project);media.play().catch(()=>{})}});
    for(const marker of project.markers||[]){productionButton(nav,marker.title,()=>seek(marker.frame));for(const c of project.clips.filter(c=>c.kind==='video'&&c.scene_id===marker.id))productionButton(nav,c.title||c.id,()=>{seek(c.timeline_start);ctx.selected=c.id;ctx.selectedTitle=null;renderEditInspector(ctx,inspector)})}
    const scroll=el('div','edit-timeline-scroll'),timeline=el('div','edit-timeline'),items=[];scroll.append(timeline);main.append(scroll);const desiredScroll=ctx.timelineScroll||0;scroll.onscroll=()=>{if(!editCurrent(ctx)||ctx.render!==render||!scroll.isConnected)return;ctx.timelineScroll=scroll.scrollLeft;editRemember(ctx)};
    followPlayback=()=>{if(!currentPlayer()||media.paused||!scroll.clientWidth)return;const x=ctx.frame/editRate(project)*ctx.zoom,width=scroll.clientWidth,left=scroll.scrollLeft;if(x>left+width*.8)scroll.scrollLeft=x-width*.8;else if(left>0&&x<left+width*.1)scroll.scrollLeft=Math.max(0,x-width*.2)};
    timeline.setAttribute('aria-label','成片时间线，点击任意位置定位到帧');
    timeline.onclick=event=>{if(event.detail>0&&currentPlayer())seek(editTimelineFrame(project,event.clientX-timeline.getBoundingClientRect().left,ctx.zoom))};
    const ruler=el('div','edit-ruler');timeline.append(ruler);
    for(const track of project.tracks){const clips=project.clips.filter(c=>c.track_id===track.id);if(!clips.length)continue;const row=el('div','edit-track');row.setAttribute('aria-label',track.title);nodeText('span','edit-track-name',track.title,row);timeline.append(row);
      for(const c of clips){const unit=c.kind==='video'?editRate(project):project.spec.sample_rate,b=nodeText('button','edit-clip '+c.kind,c.title||c.id,row);b.type='button';b.onclick=event=>{if(!currentPlayer())return;ctx.selected=c.id;ctx.selectedTitle=null;if(event.detail===0)seek(c.timeline_start/unit*editRate(project));renderEditInspector(ctx,inspector);editRemember(ctx)};items.push([b,c.timeline_start/unit,editLength(project,c)/unit]);b.title=(c.title||c.id)+' · '+(c.timeline_start/unit).toFixed(3)+' 秒'}
    }
    if(project.subtitles?.length){const row=el('div','edit-track subtitles');nodeText('span','edit-track-name','字幕',row);timeline.append(row);for(const c of project.subtitles){const b=nodeText('button','edit-clip',c.text,row);items.push([b,c.start_frame/editRate(project),(c.end_frame-c.start_frame)/editRate(project)]);b.onclick=event=>{if(event.detail===0)seek(c.start_frame)}}}
    const nameplates=(project.titles||[]).filter(c=>c.style==='nameplate');
    if(nameplates.length){const row=el('div','edit-track nameplates');row.setAttribute('aria-label','人名条');nodeText('span','edit-track-name','人名条',row);timeline.append(row);for(const c of nameplates){const b=nodeText('button','edit-clip',c.text.replace('\n',' · '),row);b.type='button';b.title=c.text+' · '+(c.start_frame/editRate(project)).toFixed(3)+' 秒';items.push([b,c.start_frame/editRate(project),(c.end_frame-c.start_frame)/editRate(project)]);b.onclick=event=>{if(!currentPlayer())return;ctx.selectedTitle=c.id;if(event.detail===0)seek(c.start_frame);renderEditInspector(ctx,inspector);editRemember(ctx)}}}
    playhead=el('div','edit-playhead');timeline.append(playhead);playhead.tabIndex=0;playhead.setAttribute('role','slider');playhead.setAttribute('aria-label','播放头');playhead.setAttribute('aria-valuemin','0');playhead.setAttribute('aria-valuemax',project.spec.duration_frames-1);playhead.title='拖动定位；方向键逐帧调整';
    let pointer=null,grabOffset=0,originX=0,dragging=false,suppressClick=false,captureTarget;
    const dragSeek=event=>seek(editTimelineFrame(project,event.clientX-timeline.getBoundingClientRect().left-grabOffset,ctx.zoom),false);
    // Keep native clip/subtitle hit targets. Capture on that same element so a
    // press without a drag still delivers its normal click and keyboard focus.
    timeline.onpointerdown=event=>{suppressClick=false;if(event.button!==0||pointer!==null||!currentPlayer())return;const offset=event.clientX-timeline.getBoundingClientRect().left-ctx.frame/editRate(project)*ctx.zoom;if(offset< -6||offset>8)return;pointer=event.pointerId;grabOffset=offset;originX=event.clientX;dragging=false;captureTarget=event.target;captureTarget.setPointerCapture(pointer)};
    timeline.onpointermove=event=>{if(pointer!==event.pointerId||!currentPlayer())return;if(!dragging&&Math.abs(event.clientX-originX)<3)return;dragging=true;playhead.classList.add('dragging');dragSeek(event)};
    const endDrag=event=>{if(pointer!==event.pointerId)return;if(dragging&&event.type==='pointerup'&&currentPlayer())dragSeek(event);suppressClick=dragging;pointer=null;playhead.classList.remove('dragging');if(captureTarget.hasPointerCapture(event.pointerId))captureTarget.releasePointerCapture(event.pointerId);if(currentPlayer())editRemember(ctx)};
    timeline.onpointerup=timeline.onpointercancel=timeline.onlostpointercapture=endDrag;
    timeline.addEventListener('click',event=>{if(suppressClick&&event.detail>0){suppressClick=false;event.preventDefault();event.stopPropagation()}},true);
    playhead.onclick=event=>event.stopPropagation();
    playhead.onkeydown=event=>{const frame=({ArrowLeft:ctx.frame-1,ArrowRight:ctx.frame+1,Home:0,End:project.spec.duration_frames-1})[event.key];if(frame!==undefined){event.preventDefault();seek(frame)}};
    let viewWidth=0;
    const layoutTimeline=(restore=false)=>{if(!currentPlayer()||!scroll.isConnected)return;const width=scroll.clientWidth;if(!width)return;const offset=ctx.frame/editRate(project)*ctx.zoom-scroll.scrollLeft,anchor=viewWidth&&offset>=0&&offset<=viewWidth?offset/viewWidth*width:width/2;viewWidth=width;ctx.zoom=editZoomScale(project,width,ctx.zoomLevel);const duration=project.spec.duration_frames/editRate(project);timeline.style.width=duration*ctx.zoom+'px';timeline.style.setProperty('--edit-frame-width',ctx.zoom/editRate(project)+'px');timeline.classList.toggle('edit-frame-grid',ctx.zoom/editRate(project)>=2);
      for(const [item,start,length] of items){item.style.left=start*ctx.zoom+'px';item.style.width=Math.max(3,length*ctx.zoom)+'px'}
      ruler.replaceChildren();const tickStep=[1,2,5,10,30,60,120,300,600].find(n=>n*ctx.zoom>=60)||600;for(let n=0;n<duration;n+=tickStep){const tick=nodeText('button',null,n+'s',ruler);tick.style.left=n*ctx.zoom+'px';tick.onclick=event=>{if(event.detail===0)seek(n*editRate(project))}}
      positionPlayhead();scroll.scrollLeft=ctx.zoomLevel==='overview'?0:restore?desiredScroll:Math.max(0,ctx.frame/editRate(project)*ctx.zoom-anchor);ctx.timelineScroll=scroll.scrollLeft;editRemember(ctx)};
    requestAnimationFrame(()=>{if(!currentPlayer())return;layoutTimeline(true);if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(()=>{if(!currentPlayer()||!scroll.isConnected){observer.disconnect();return}if(scroll.clientWidth!==viewWidth)layoutTimeline()});episodeEditing.timelineObserver=observer;observer.observe(scroll)}});
  }else{nodeText('p','edit-notice','工程已保存，尚无合成版本。完成渲染后在此播放和审阅。',main)}
  const inspector=el('section','edit-inspector');main.append(inspector);renderEditInspector(ctx,inspector);
  const actions=el('div','edit-toolbar production-toolbar edit-actions');main.append(actions);
  productionButton(actions,'撤销',()=>{if(!ctx.undo.length)return;ctx.redo.push(editClone(ctx.draft));ctx.draft=ctx.undo.pop();editRemember(ctx);renderEpisodeEditing(ctx)}).disabled=!ctx.undo.length;
  productionButton(actions,'重做',()=>{if(!ctx.redo.length)return;ctx.undo.push(editClone(ctx.draft));ctx.draft=ctx.redo.pop();editRemember(ctx);renderEpisodeEditing(ctx)}).disabled=!ctx.redo.length;
  productionButton(actions,'保存工程',async()=>{try{const saved=await editCall('save',{project:ctx.draft,expected_version:ctx.project.version});ctx.project=saved;editRemember(ctx);toast('工程已保存，成片预览尚未更新。');renderEpisodeEditing(ctx)}catch(e){toast(e.message)}});
  productionButton(actions,'渲染新版本',async()=>{try{const saved=await editCall('save',{project:ctx.draft,expected_version:ctx.project.version});ctx.project=saved;editRemember(ctx);const job=await editCall('submit',{project_id:saved.object_id,expected_version:saved.version,task_id:'browser-edit',request_id:crypto.randomUUID()});ctx.job=job;renderEditJob(ctx,jobHost);pollEditJob(ctx,jobHost)}catch(e){toast(e.message)}});
  const jobHost=el('div','edit-job');main.append(jobHost);if(ctx.job){renderEditJob(ctx,jobHost);pollEditJob(ctx,jobHost)}
  renderComments();paintReviewCommentCounts();editRemember(ctx);
}
function renderEditNameplate(ctx,host,item){
  const [name,detail='']=item.text.split('\n');nodeText('p','edit-selected-clip','人名条 · '+name,host);
  const fields=el('div','edit-fields');host.append(fields);
  const nameInput=editControl(fields,'姓名','text',name),detailInput=editControl(fields,'身份与说明','text',detail);
  const draft=ctx.draft,render=ctx.render;
  const current=()=>editCurrent(ctx)&&ctx.render===render&&host.isConnected&&nameInput.isConnected&&ctx.draft===draft&&ctx.selectedTitle===item.id&&draft.titles.includes(item);
  nameInput.maxLength=12;detailInput.maxLength=24;
  const start=editControl(fields,'人名条开始帧','number',item.start_frame),end=editControl(fields,'人名条结束帧（不含）','number',item.end_frame);
  start.min=0;end.min=1;start.max=ctx.draft.spec.duration_frames-1;end.max=ctx.draft.spec.duration_frames;
  let position=item.position||'lower-left';
  editChoices(host,'edit-nameplate-position','画面位置',[['lower-left','左下'],['lower-right','右下'],['upper-left','左上'],['upper-right','右上']],position,value=>{if(current())position=value});
  const buttons=el('div','edit-toolbar production-toolbar');host.append(buttons);
  productionButton(buttons,'应用人名条修改',()=>{if(!current())return;const a=Number(start.value),b=Number(end.value);if(!nameInput.value.trim()||!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<=a||b>ctx.draft.spec.duration_frames){toast('请填写姓名及成片范围内有效的起止帧。');return}editMutation(ctx,p=>{const target=p.titles.find(c=>c.id===item.id);target.text=[nameInput.value.trim(),detailInput.value.trim()].filter(Boolean).join('\n');target.start_frame=a;target.end_frame=b;target.position=position})});
  productionButton(buttons,'返回画面与声音片段',()=>{if(!current())return;ctx.selectedTitle=null;editRemember(ctx);renderEditInspector(ctx,host)});
  nodeText('p','edit-hint','人名条在两个字幕版本中都保留；修改工程并重新渲染后更新成片。',host);
}
function renderEditInspector(ctx,host){
  host.replaceChildren();nodeText('h3',null,'工程草稿',host);const p=ctx.draft;
  const nameplate=p.titles?.find(c=>c.id===ctx.selectedTitle&&c.style==='nameplate');
  if(nameplate){renderEditNameplate(ctx,host,nameplate);return}
  if(!p.clips.some(c=>c.id===ctx.selected))ctx.selected=p.clips[0]?.id;const c=p.clips.find(c=>c.id===ctx.selected);if(!c)return;
  nodeText('p','edit-selected-clip',(c.kind==='video'?'画面 · ':'声音 · ')+(c.title||c.id),host);const selection=el('details','edit-clip-picker');nodeText('summary',null,'选择片段',selection);host.append(selection);
  for(const track of p.tracks)editChoices(selection,'edit-clip-'+track.id,track.title,p.clips.filter(x=>x.track_id===track.id).map(x=>[x.id,x.title||x.id]),ctx.selected,value=>{ctx.selected=value;ctx.selectedTitle=null;editRemember(ctx);renderEditInspector(ctx,host)});
  const source=editSource(p,c),fields=el('div','edit-fields');host.append(fields);const unit=c.kind==='video'?'源帧':'源采样';
  const inputs={};for(const [key,title] of [['source_in','素材入点（'+unit+'）'],['source_out','素材出点（'+unit+'，不含）'],['timeline_start','时间线位置（'+(c.kind==='video'?'帧':'48 kHz 采样')+'）'],['fade_in','淡入长度'],['fade_out','淡出长度']]){inputs[key]=editControl(fields,title,'number',c[key]||0);inputs[key].step=1}
  if(c.kind==='audio'){inputs.gain_db=editControl(fields,'音量（dB）','number',c.gain_db||0);inputs.gain_db.step='.5'}
  let replacement=c.source_id;const replacementPanel=el('details','edit-replacement');nodeText('summary',null,'替换素材 · '+(source.title||source.id),replacementPanel);host.append(replacementPanel);editChoices(replacementPanel,'edit-replacement',null,p.sources.filter(s=>s[c.kind]).map(s=>[s.id,s.title||s.id]),c.source_id,value=>{replacement=value;for(const b of replacementPanel.querySelectorAll('[data-filter-key=edit-replacement]'))b.setAttribute('aria-pressed',String(b.dataset.filterValue===value))});
  const buttons=el('div','edit-toolbar production-toolbar');host.append(buttons);
  productionButton(buttons,'应用片段修改',()=>editMutation(ctx,p=>{const clip=p.clips.find(x=>x.id===c.id);for(const [key,input] of Object.entries(inputs))clip[key]=Number(input.value);clip.source_id=replacement}));
  productionButton(buttons,'在播放位置分割',()=>{const unit=c.kind==='video'?editRate(p):p.spec.sample_rate,position=Math.round(ctx.frame/editRate(p)*unit),offset=position-c.timeline_start,length=editLength(p,c);if(offset<=0||offset>=length){toast('播放位置须在所选片段内部。');return}if(offset<=(c.dissolve_in||0)){toast('请在入场叠化结束后分割。');return}
    editMutation(ctx,p=>{const clip=p.clips.find(x=>x.id===c.id),second=editClone(clip),cut=c.source_in+Math.round((c.source_out-c.source_in)*offset/length);second.id=c.id+'-split-'+Date.now();second.lineage_id=clip.lineage_id||clip.id;clip.lineage_id=second.lineage_id;second.source_in=cut;second.timeline_start=position;second.fade_in=0;second.dissolve_in=0;clip.source_out=cut;clip.fade_out=0;clip.fade_in=Math.min(clip.fade_in||0,offset);second.fade_out=Math.min(second.fade_out||0,length-offset);p.clips.splice(p.clips.indexOf(clip)+1,0,second)})});
  productionButton(buttons,'查看完整原片',()=>{ctx.loop=false;ctx.host.querySelector('[data-edit-loop]')?.setAttribute('aria-pressed','false');ctx.host.querySelector('video')?.pause();const dialog=el('dialog','edit-source-dialog');nodeText('h2',null,source.title||source.id,dialog);const v=el(source.video?'video':'audio');v.controls=true;v.src=reviewURL('/api/production/files/'+source.component.file);dialog.append(v);productionButton(dialog,'返回成片',()=>{v.pause();dialog.close();dialog.remove()});document.body.append(dialog);dialog.addEventListener('cancel',()=>{v.pause();dialog.remove()});dialog.showModal()});
  nodeText('p','edit-hint',c.kind==='audio'?(source.video?'此段使用原片的混合音轨；音量和淡变会在下一次渲染中生效。':'此段使用独立音频原件。'):'素材入出点使用原件帧率，时间线位置使用工程帧率。',host);
}
function renderEditJob(ctx,host){host.replaceChildren();const job=ctx.job;if(!job)return;nodeText('p',null,({queued:'等待渲染',running:'正在合成',succeeded:'成片已合成',failed:'合成失败',cancelled:'已取消',interrupted:'合成中断'})[job.status]||job.status,host);if(job.status==='running'){const progress=el('progress');progress.max=1;progress.value=job.progress;host.append(progress)}if(job.error)nodeText('p','production-issue','未生成完整的新成片。请核对工程和原件后重试；原成片仍可审阅。',host);if(['queued','running'].includes(job.status))productionButton(host,'取消渲染',async()=>{ctx.job=await editCall('cancel',{id:job.id});renderEditJob(ctx,host)});if(['failed','cancelled','interrupted'].includes(job.status))productionButton(host,'重新提交此快照',async()=>{ctx.job=await editCall('retry',{id:job.id});renderEditJob(ctx,host);pollEditJob(ctx,host)});if(job.status==='succeeded')productionButton(host,'打开新成片',()=>{ctx.output=job.output.object_id;ctx.job=null;ctx.frame=0;ctx.loop=false;editRoute({edit_output:ctx.output});loadEpisodeEditing()})}
async function pollEditJob(ctx,host){ctx.jobHost=host;if(ctx.polling)return;ctx.polling=true;try{while(editCurrent(ctx)&&ctx.jobHost?.isConnected&&ctx.job&&['queued','running'].includes(ctx.job.status)){await new Promise(r=>setTimeout(r,1500));if(!editCurrent(ctx)||!ctx.jobHost?.isConnected)break;const id=ctx.job.id,result=await api('/api/editing/status?id='+encodeURIComponent(id));if(!editCurrent(ctx))break;if(ctx.job?.id!==id)continue;ctx.job=result;renderEditJob(ctx,ctx.jobHost)}}catch(e){if(ctx.jobHost?.isConnected)nodeText('p','production-issue',e.message,ctx.jobHost)}finally{ctx.polling=false}}

function locateEpisodeEditComment(comment){
  if(state.workspace!=='settings.workspace'||productionTab()!=='editing')return false;
  const ctx=[...episodeEditing.contexts.values()].find(c=>c.epoch===episodeEditing.epoch),output=ctx?.data.outputs.find(o=>o.object_id===comment.target_object_id&&o.id===comment.target_revision_id);
  if(!output){toast('此评论所属的准确成片不可用，评论仍保留。');return true}
  const component=output.payload.components.find(c=>c.id===comment.anchor.component_id&&c.file===comment.anchor.asset_file);
  if(!component||!['subtitled','clean'].includes(component.id)){toast('此评论的准确文件无法在成片播放器中定位。');return true}
  const old=ctx.host.querySelector('video');old?.pause();old?.removeAttribute('data-episode-player');ctx.output=output.object_id;ctx.loop=false;ctx.variant=component.id;ctx.frame=editFrameAtTime(output.payload.project,comment.anchor.start_seconds);editRoute({edit_output:ctx.output});renderEpisodeEditing(ctx);
  locateProductionComment(comment,true);return true;
}
