/* One composed player clock; editing never silently changes the shown output. */
const episodeEditing={epoch:0,contexts:new Map()};
function pauseEpisodePlayer(){document.querySelector('#production-view video[data-episode-player]')?.pause()}
const editCurrent=ctx=>ctx.epoch===episodeEditing.epoch&&ctx.readEpoch===productionReadEpoch&&state.workspace==='settings.workspace'&&productionTab()==='editing';
const editClone=value=>JSON.parse(JSON.stringify(value));
const editRate=p=>p.spec.fps.num/p.spec.fps.den;
// Chrome exposes media time rounded to microseconds; retain an exact frame seek.
const editFrameAtTime=(p,seconds)=>Math.floor(seconds*editRate(p)+1e-4);
const editTimelineFrame=(p,pixels,zoom)=>Math.max(0,Math.min(p.spec.duration_frames-1,Math.round(pixels/zoom*editRate(p))));
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
function editRemember(ctx){try{localStorage.setItem('episode-edit:'+location.pathname+':'+ctx.episode,JSON.stringify({output:ctx.output,variant:ctx.variant,frame:ctx.frame,zoom:ctx.zoom,ranges:ctx.ranges,timelineScroll:ctx.timelineScroll,draft:ctx.draft,basis:ctx.project?.id,selected:ctx.selected}));localStorage.setItem('episode-edit:last:'+location.pathname,ctx.episode)}catch{toast('本机草稿保存失败；当前草稿仍在页面中，请保存工程。')}}
function editChanged(ctx){return ctx.project&&JSON.stringify(ctx.draft)!==JSON.stringify(ctx.project.payload)}
function editMutation(ctx,fn){ctx.undo.push(editClone(ctx.draft));if(ctx.undo.length>40)ctx.undo.shift();ctx.redo=[];fn(ctx.draft);editRemember(ctx);renderEpisodeEditing(ctx)}
function clearEpisodeEditReview(){
  if(typeof rememberProductionDraft==='function')rememberProductionDraft();
  state.entityReview=null;state.materialReview=null;state.unifiedCardRoot=null;state.productionEntityId=null;state.productionSelected=null;state.productionDetail=null;state.reviewReferenceContext=null;state.reviewCommentScope=null;state.anchor=null;state.editing=null;state.selected=null;state.drawMode=null;
}
async function loadEpisodeEditing(){
  const readEpoch=++productionReadEpoch,workspace=state.workspace;clearEpisodeEditReview();renderComments();
  const epoch=++episodeEditing.epoch,host=$('#production-view');host.querySelector('video')?.pause();productionTabs();host.replaceChildren();nodeText('p',null,'正在读取成片工程…',host);
  try{
    const data=await api('/api/editing/catalog');if(epoch!==episodeEditing.epoch||readEpoch!==productionReadEpoch||workspace!==state.workspace||state.workspace!=='settings.workspace'||productionTab()!=='editing')return;
    const params=new URL(location.href).searchParams;let last;try{last=localStorage.getItem('episode-edit:last:'+location.pathname)}catch{}
    const episode=params.get('edit_episode')||last||data.episodes[0]?.id;
    let ctx=episodeEditing.contexts.get(episode);const project=data.projects.find(p=>p.payload.episode.object_id===episode);
    if(!ctx){let saved;try{saved=JSON.parse(localStorage.getItem('episode-edit:'+location.pathname+':'+episode)||'null')}catch{}
      ctx={episode,output:saved?.output,variant:saved?.variant||'subtitled',frame:saved?.frame||0,zoom:[2,4,8,16,96].includes(saved?.zoom)?saved.zoom:4,ranges:saved?.ranges||{},timelineScroll:saved?.timelineScroll||0,undo:[],redo:[],selected:saved?.selected,
        draft:saved&&project&&saved.basis===project.id?saved.draft:project?editClone(project.payload):null,project};episodeEditing.contexts.set(episode,ctx);
      if(saved?.draft&&saved.basis!==project?.id)ctx.recoverable=saved;
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
  if(ctx.recoverable){const recovery=el('div','edit-notice');nodeText('p',null,'另有基于旧工程的本机草稿，已保留。恢复后仍须按当前工程版本检查再保存。',recovery);productionButton(recovery,'恢复本机草稿',()=>{ctx.draft=ctx.recoverable.draft;ctx.recoverable=null;renderEpisodeEditing(ctx)});host.append(recovery)}
  if(editChanged(ctx)||output&&output.payload.snapshot&&JSON.stringify(project)!==JSON.stringify(ctx.draft))nodeText('p','edit-notice','工程草稿已有修改，当前预览尚未更新。播放器和时间线仍对应所选成片版本。',host);
  const layout=el('div','edit-layout'),nav=el('nav','edit-scenes breakdown-scene-list'),main=el('div','edit-main');nav.setAttribute('aria-label','场镜导航');layout.append(nav,main);host.append(layout);
  let media,rangeStart,rangeEnd,playhead,frameInput;
  const currentPlayer=()=>editCurrent(ctx)&&ctx.render===render&&ctx.output===output?.object_id&&media?.isConnected;
  const seek=frame=>{if(!currentPlayer()||!Number.isFinite(frame))return;media.pause();ctx.frame=Math.max(0,Math.min(project.spec.duration_frames-1,Math.round(frame)));frameInput.value=ctx.frame;media.currentTime=ctx.frame/editRate(project);if(playhead)playhead.style.left=ctx.frame/editRate(project)*ctx.zoom+'px';editRemember(ctx)};
  if(output){
    state.productionRecords=outputs;if(state.productionSelected?.id!==output.id)focusProductionReview({record:output,history:[output],uses:[]},false);
    const reader=el('section');reader.id='production-reader';main.append(reader);const player=el('section','review-media-player edit-player');player.dataset.reviewRevision=output.id;
    const component=output.payload.components.find(c=>c.id===ctx.variant);player.dataset.reviewFile=component.file;player.dataset.reviewFrom=0;player.dataset.reviewTo=component.duration_seconds;
    media=el('video');media.controls=true;media.preload='metadata';media.dataset.episodePlayer='true';media.dataset.componentId=component.id;media.src=reviewURL('/api/production/files/'+component.file);player.append(media);reader.append(player);
    player.reviewFocus=()=>focusProductionReview({record:output,history:[output],uses:[]},false);
    player.reviewLocate=a=>{if(a.asset_file!==component.file)return false;rangeStart.value=editFrameAtTime(project,a.start_seconds);rangeEnd.value=Math.ceil(a.end_seconds*editRate(project)-1e-4);ctx.ranges[output.object_id]=[Number(rangeStart.value),Number(rangeEnd.value)];seek(Number(rangeStart.value));return true};
    reviewSurface(player,'audio');
    const controls=el('div','edit-toolbar production-toolbar');main.append(controls);
    productionButton(controls,'上一帧',()=>seek(editFrameAtTime(project,media.currentTime)-1));productionButton(controls,'下一帧',()=>seek(editFrameAtTime(project,media.currentTime)+1));
    frameInput=editControl(controls,'播放帧','number',ctx.frame);frameInput.min=0;frameInput.max=project.spec.duration_frames-1;frameInput.onchange=()=>seek(Number(frameInput.value));
    const range=ctx.ranges[output.object_id]||[0,project.spec.duration_frames];
    rangeStart=editControl(controls,'范围起帧','number',range[0]);rangeEnd=editControl(controls,'范围止帧','number',range[1]);
    const validRange=()=>{const a=Number(rangeStart.value),b=Number(rangeEnd.value);return Number.isInteger(a)&&Number.isInteger(b)&&a>=0&&b>a&&b<=project.spec.duration_frames};
    const loop=productionButton(controls,'循环选段',()=>{if(!validRange()){toast('请输入成片范围内的整数帧。');return}ctx.loop=!ctx.loop;loop.setAttribute('aria-pressed',String(!!ctx.loop));if(ctx.loop){seek(Number(rangeStart.value));return media.play()}});loop.setAttribute('aria-pressed',String(!!ctx.loop));loop.dataset.editLoop='true';
    rangeStart.onchange=rangeEnd.onchange=()=>{ctx.ranges[output.object_id]=[Number(rangeStart.value),Number(rangeEnd.value)];if(!validRange()){ctx.loop=false;loop.setAttribute('aria-pressed','false')}editRemember(ctx)};
    productionButton(controls,'评论此范围',()=>{const a=Number(rangeStart.value),b=Number(rangeEnd.value);if(!(Number.isInteger(a)&&Number.isInteger(b)&&a>=0&&b>a&&b<=project.spec.duration_frames)){toast('请输入成片范围内的整数帧。');return}player.reviewFocus();startDraft({type:'time',component_id:component.id,asset_file:component.file,start_seconds:a/editRate(project),end_seconds:b/editRate(project)})});
    media.onloadedmetadata=()=>{if(!currentPlayer())return;media.currentTime=Math.min(ctx.frame/editRate(project),media.duration)};
    media.addEventListener('timeupdate',()=>{if(!currentPlayer())return;ctx.frame=editFrameAtTime(project,media.currentTime);if(document.activeElement!==frameInput)frameInput.value=ctx.frame;if(playhead)playhead.style.left=(media.currentTime*ctx.zoom)+'px';if(ctx.loop&&!media.paused&&media.currentTime>=Number(rangeEnd.value)/editRate(project)){media.currentTime=Number(rangeStart.value)/editRate(project);media.play().catch(()=>{})}});
    media.addEventListener('pause',()=>{if(currentPlayer())editRemember(ctx)});
    media.addEventListener('ended',()=>{if(currentPlayer()&&ctx.loop&&validRange()){media.currentTime=Number(rangeStart.value)/editRate(project);media.play().catch(()=>{})}});
    if(outputs.length>1){ctx.compare=ctx.compare&&ctx.compare!==output.object_id?ctx.compare:outputs.find(o=>o.object_id!==output.object_id).object_id;
      const comparison=el('details','edit-comparison');nodeText('summary',null,'比较成片版本',comparison);main.append(comparison);
      editChoices(comparison,'edit-compare','对照版本',outputs.filter(o=>o.object_id!==output.object_id).map(o=>[o.object_id,'版本 '+(outputs.indexOf(o)+1)]),ctx.compare,value=>{ctx.compare=value;for(const b of comparison.querySelectorAll('[data-filter-key=edit-compare]'))b.setAttribute('aria-pressed',String(b.dataset.filterValue===value))});
      const buttons=el('div','production-toolbar');comparison.append(buttons);productionButton(buttons,'定位同一内容',async()=>{try{const target=ctx.compare,read=ctx.readEpoch;const result=await editCall('compare',{source_output:output.object_id,target_output:target,frame:editFrameAtTime(project,media.currentTime)});if(!editCurrent(ctx)||read!==ctx.readEpoch||ctx.output!==output.object_id||ctx.compare!==target)return;if(!result.mapped){toast(result.reason);return}media.pause();ctx.output=target;ctx.frame=result.frame;ctx.loop=false;media.removeAttribute('data-episode-player');editRoute({edit_output:ctx.output});renderEpisodeEditing(ctx)}catch(e){toast(e.message)}})}
    for(const marker of project.markers||[]){productionButton(nav,marker.title,()=>seek(marker.frame));for(const c of project.clips.filter(c=>c.kind==='video'&&c.scene_id===marker.id))productionButton(nav,c.title||c.id,()=>{seek(c.timeline_start);ctx.selected=c.id;renderEditInspector(ctx,inspector)})}
    editChoices(main,'edit-zoom','时间线缩放',[[2,'全片概览'],[4,'标准'],[8,'细看'],[16,'精细'],[96,'逐帧']],Number(ctx.zoom),value=>{const view=host.querySelector('.edit-timeline-scroll'),offset=ctx.frame/editRate(project)*ctx.zoom-(ctx.timelineScroll||0),anchor=view&&offset>=0&&offset<=view.clientWidth?offset:(view?.clientWidth||600)/2;ctx.zoom=Number(value);ctx.timelineScroll=Math.max(0,ctx.frame/editRate(project)*ctx.zoom-anchor);editRemember(ctx);renderEpisodeEditing(ctx)});
    const scroll=el('div','edit-timeline-scroll'),timeline=el('div','edit-timeline');timeline.style.width=Math.max(600,project.spec.duration_frames/editRate(project)*ctx.zoom)+'px';scroll.append(timeline);main.append(scroll);const desiredScroll=ctx.timelineScroll||0;scroll.onscroll=()=>{if(!editCurrent(ctx)||ctx.render!==render||!scroll.isConnected)return;ctx.timelineScroll=scroll.scrollLeft;editRemember(ctx)};
    timeline.setAttribute('aria-label','成片时间线，点击任意位置定位到帧');
    timeline.onclick=event=>{if(event.detail>0&&currentPlayer())seek(editTimelineFrame(project,event.clientX-timeline.getBoundingClientRect().left,ctx.zoom))};
    timeline.style.setProperty('--edit-frame-width',ctx.zoom/editRate(project)+'px');timeline.classList.toggle('edit-frame-grid',ctx.zoom/editRate(project)>=2);
    const ruler=el('div','edit-ruler');timeline.append(ruler);const tickStep=[1,2,5,10,30,60].find(n=>n*ctx.zoom>=60)||60;for(let n=0;n<project.spec.duration_frames/editRate(project);n+=tickStep){const tick=nodeText('button',null,n+'s',ruler);tick.style.left=n*ctx.zoom+'px';tick.onclick=event=>{if(event.detail===0)seek(n*editRate(project))}}
    for(const track of project.tracks){const clips=project.clips.filter(c=>c.track_id===track.id);if(!clips.length)continue;const row=el('div','edit-track');row.setAttribute('aria-label',track.title);nodeText('span','edit-track-name',track.title,row);timeline.append(row);
      for(const c of clips){const unit=c.kind==='video'?editRate(project):project.spec.sample_rate,b=nodeText('button','edit-clip '+c.kind,c.title||c.id,row);b.type='button';b.onclick=event=>{if(!currentPlayer())return;ctx.selected=c.id;if(event.detail===0)seek(c.timeline_start/unit*editRate(project));renderEditInspector(ctx,inspector);editRemember(ctx)};b.style.left=c.timeline_start/unit*ctx.zoom+'px';b.style.width=Math.max(3,editLength(project,c)/unit*ctx.zoom)+'px';b.title=(c.title||c.id)+' · '+(c.timeline_start/unit).toFixed(3)+' 秒'}
    }
    if(project.subtitles?.length){const row=el('div','edit-track subtitles');nodeText('span','edit-track-name','字幕',row);timeline.append(row);for(const c of project.subtitles){const b=nodeText('button','edit-clip',c.text,row);b.style.left=c.start_frame/editRate(project)*ctx.zoom+'px';b.style.width=Math.max(3,(c.end_frame-c.start_frame)/editRate(project)*ctx.zoom)+'px';b.onclick=event=>{if(event.detail===0)seek(c.start_frame)}}}
    playhead=el('div','edit-playhead');timeline.append(playhead);playhead.style.left=ctx.frame/editRate(project)*ctx.zoom+'px';
    requestAnimationFrame(()=>{if(!currentPlayer()||!scroll.isConnected)return;scroll.scrollLeft=desiredScroll;ctx.timelineScroll=scroll.scrollLeft;editRemember(ctx)});
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
function renderEditInspector(ctx,host){
  host.replaceChildren();nodeText('h3',null,'工程草稿',host);const p=ctx.draft;
  if(!p.clips.some(c=>c.id===ctx.selected))ctx.selected=p.clips[0]?.id;const c=p.clips.find(c=>c.id===ctx.selected);if(!c)return;
  nodeText('p','edit-selected-clip',(c.kind==='video'?'画面 · ':'声音 · ')+(c.title||c.id),host);const selection=el('details','edit-clip-picker');nodeText('summary',null,'选择片段',selection);host.append(selection);
  for(const track of p.tracks)editChoices(selection,'edit-clip-'+track.id,track.title,p.clips.filter(x=>x.track_id===track.id).map(x=>[x.id,x.title||x.id]),ctx.selected,value=>{ctx.selected=value;editRemember(ctx);renderEditInspector(ctx,host)});
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
