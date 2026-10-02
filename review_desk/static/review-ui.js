/* A shared visual contract, only attached to content with real comment anchors. */
function reviewIcon(){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z M7 9h10 M7 13h7');svg.append(path);return svg;
}
function reviewSurface(host,kind='text'){
  host.classList.add('review-surface');host.dataset.reviewKind=kind;
  const cue=el('span','review-cue');cue.append(reviewIcon());cue.title=kind==='text'?'圈选文字后添加评论':kind==='image'?'圈选图像区域后添加评论':'拖动时间轴选段后添加评论';cue.setAttribute('aria-label',cue.title);host.prepend(cue);
  if(kind==='text'){host.tabIndex=0;host.setAttribute('aria-description','可圈选文字评论；键盘选择文字后也可添加评论。')}
  return host;
}
const reviewWaveCache=new Map();let reviewAudioContext;
async function reviewWaveform(url){
  if(reviewWaveCache.has(url))return reviewWaveCache.get(url);
  const promise=(async()=>{
    const response=await fetch(url);if(!response.ok)throw Error('音频无法读取');
    const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw Error('此浏览器不支持波形解码');
    reviewAudioContext ||= new Audio();const buffer=await reviewAudioContext.decodeAudioData(await response.arrayBuffer());
    const channels=Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i)),count=Math.min(1600,buffer.length),peaks=[];
    for(let i=0;i<count;i++){let peak=0;const a=Math.floor(i*buffer.length/count),b=Math.floor((i+1)*buffer.length/count);for(const values of channels)for(let j=a;j<b;j++)peak=Math.max(peak,Math.abs(values[j]));peaks.push(peak)}
    return {peaks,duration:buffer.duration};
  })();reviewWaveCache.set(url,promise);if(reviewWaveCache.size>12)reviewWaveCache.delete(reviewWaveCache.keys().next().value);return promise;
}
function reviewMediaPlayer(parent,component,record,selection={},review=true){
  const from=selection.range?.start_seconds??0,to=selection.range?.end_seconds??component.duration_seconds,span=to-from;
  const box=el('section','review-media-player');box.dataset.reviewRevision=record.id;
  const audio=component.mime.startsWith('audio/'),media=el(audio?'audio':'video');media.src='/api/production/files/'+encodeURIComponent(component.file);media.preload='metadata';media.dataset.componentId=component.id;if(audio)media.hidden=true;else media.controls=true;
  const focus=()=>{if(review)focusProductionReview({record,history:[record],uses:[]})};box.addEventListener('pointerdown',focus,true);box.addEventListener('focusin',focus,true);box.append(media);
  const top=el('div','review-audio-controls'),play=productionButton(top,'播放',()=>{if(media.paused){if(media.currentTime<from||media.currentTime>=to)media.currentTime=from;media.play().catch(e=>toast(e.message))}else media.pause()}),clock=nodeText('output','review-audio-clock','',top);
  const mute=productionButton(top,'静音',()=>{media.muted=!media.muted;mute.textContent=media.muted?'恢复声音':'静音'});box.append(top);
  const track=el('div','review-timeline');track.tabIndex=0;track.setAttribute('role','slider');track.setAttribute('aria-label',audio?'音频时间轴':'视频时间轴');track.setAttribute('aria-valuemin',String(from));track.setAttribute('aria-valuemax',String(to));
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 800 72');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');track.append(svg);
  const fallback=nodeText('span','review-wave-status',audio?'正在读取波形…':'视频时间轴',track),region=el('div','review-time-selection'),head=el('div','review-playhead');track.append(region,head);
  const aHandle=el('button','review-range-handle start'),bHandle=el('button','review-range-handle end');
  for(const [button,label] of [[aHandle,'选段起点'],[bHandle,'选段终点']]){button.type='button';button.setAttribute('role','slider');button.setAttribute('aria-label',label);button.setAttribute('aria-valuemin',String(from));button.setAttribute('aria-valuemax',String(to));track.append(button)}
  const markers=el('div','review-time-comments');track.append(markers);box.append(track);
  const axis=el('div','review-time-axis');nodeText('span',null,from.toFixed(2)+' 秒',axis);nodeText('span',null,to.toFixed(2)+' 秒',axis);box.append(axis);
  const tools=el('div','review-range-tools'),start=el('input'),end=el('input');
  for(const [input,label] of [[start,'选段起点（秒）'],[end,'选段终点（秒）']]){input.type='number';input.step='.01';input.min=from;input.max=to;input.setAttribute('aria-label',label);const wrap=el('label');nodeText('span',null,label,wrap);wrap.append(input);tools.append(wrap)}
  let range=null,stopAt=to,gesture=null;const clamp=v=>Math.max(from,Math.min(to,v)),percent=v=>100*(v-from)/span;
  const paint=()=>{
    const time=clamp(media.currentTime||from);clock.textContent=`${time.toFixed(2)} / ${to.toFixed(2)} 秒`;head.style.left=percent(time)+'%';track.setAttribute('aria-valuenow',String(time));track.setAttribute('aria-valuetext',time.toFixed(2)+' 秒');
    tools.hidden=!range;region.hidden=!range;aHandle.hidden=!range;bHandle.hidden=!range;play.textContent=media.paused?'播放':'暂停';
    if(range){region.style.left=percent(range[0])+'%';region.style.width=percent(range[1])-percent(range[0])+'%';aHandle.style.left=percent(range[0])+'%';bHandle.style.left=percent(range[1])+'%';if(document.activeElement!==start)start.value=range[0].toFixed(2);if(document.activeElement!==end)end.value=range[1].toFixed(2);aHandle.setAttribute('aria-valuenow',range[0]);bHandle.setAttribute('aria-valuenow',range[1])}
  };
  const select=(a,b)=>{a=clamp(a);b=clamp(b);if(a>=b)return false;range=[a,b];paint();return true};
  const seek=t=>{media.currentTime=clamp(t);media.dataset.reviewSeek=String(clamp(t));paint()};
  productionButton(tools,'试听选段',()=>{stopAt=range[1];seek(range[0]);media.play().catch(e=>toast(e.message))});
  if(review)productionButton(tools,'添加评论',()=>{focus();startDraft({type:'time',component_id:component.id,asset_file:component.file,start_seconds:range[0],end_seconds:range[1]})});
  productionButton(tools,'清除选段',()=>{range=null;stopAt=to;paint()});box.append(tools);
  for(const input of [start,end]){
    input.oninput=()=>{const a=Number(start.value),b=Number(end.value);if(start.value!==''&&end.value!==''&&from<=a&&a<b&&b<=to)select(a,b)};
    input.onchange=()=>{const a=Number(start.value),b=Number(end.value);if(!(from<=a&&a<b&&b<=to)){start.value=range[0].toFixed(2);end.value=range[1].toFixed(2);toast('起点须早于终点，且在此素材范围内')}};
  }
  const point=e=>{const rect=track.getBoundingClientRect();return clamp(from+(e.clientX-rect.left)/rect.width*span)};
  track.onpointerdown=e=>{if(e.button!==0||e.target.closest('.review-time-comments'))return;e.preventDefault();focus();media.pause();track.setPointerCapture(e.pointerId);gesture={x:e.clientX,time:point(e),mode:e.target===aHandle?'start':e.target===bHandle?'end':'new',pointer:e.pointerId};track.focus()};
  track.onpointermove=e=>{if(!gesture||e.pointerId!==gesture.pointer)return;const t=point(e);if(gesture.mode==='start')select(Math.min(t,range[1]-.01),range[1]);else if(gesture.mode==='end')select(range[0],Math.max(t,range[0]+.01));else if(Math.abs(e.clientX-gesture.x)>3)select(Math.min(t,gesture.time),Math.max(t,gesture.time))};
  track.onpointerup=e=>{if(!gesture||e.pointerId!==gesture.pointer)return;if(gesture.mode==='new'&&Math.abs(e.clientX-gesture.x)<=3)seek(point(e));gesture=null;stopAt=to};track.onpointercancel=()=>{gesture=null};
  track.onkeydown=e=>{if(e.target!==track)return;if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();seek(e.key==='Home'?from:e.key==='End'?to:media.currentTime+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.1))}else if(e.key===' '){e.preventDefault();play.click()}else if(e.key.toLowerCase()==='i'){e.preventDefault();select(clamp(media.currentTime),range?.[1]??to)}else if(e.key.toLowerCase()==='o'){e.preventDefault();select(range?.[0]??from,clamp(media.currentTime))}};
  track.title='点击定位，拖动选段；方向键定位，I / O 设起止点';
  for(const [handle,index] of [[aHandle,0],[bHandle,1]])handle.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const next=e.key==='Home'?from:e.key==='End'?to:range[index]+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?1:.1);select(index===0?next:range[0],index===1?next:range[1])};
  media.onloadedmetadata=()=>seek(Number(media.dataset.reviewSeek??from));media.ontimeupdate=()=>{const endAt=Math.min(to,stopAt);if(media.currentTime>=endAt){media.pause();if(media.currentTime>endAt)media.currentTime=endAt;stopAt=to}paint()};media.onplay=()=>{if(media.currentTime<from||media.currentTime>=to)seek(from);paint()};media.onpause=paint;media.onerror=()=>{fallback.textContent='音频读取失败，请检查原文件';play.disabled=true};
  box.reviewLocate=anchor=>{select(anchor.start_seconds,anchor.end_seconds);seek(anchor.start_seconds);track.focus();box.scrollIntoView({block:'center'})};
  if(review){
    reviewSurface(box,'audio');let commentKey='';
    box.reviewPaintComments=()=>{
      const comments=state.comments.filter(c=>c.target_revision_id===record.id&&c.anchor.type==='time'&&c.anchor.component_id===component.id&&c.anchor.asset_file===component.file&&c.anchor.start_seconds<to&&c.anchor.end_seconds>from),key=JSON.stringify(comments);
      if(key!==commentKey){commentKey=key;markers.replaceChildren();for(const comment of comments){
        const button=productionButton(markers,'',()=>locateComment(comment));button.append(reviewIcon());button.dataset.commentId=comment.id;button.style.left=percent(clamp(comment.anchor.start_seconds))+'%';button.title=comment.anchor.start_seconds.toFixed(2)+' 秒 · '+comment.body;button.setAttribute('aria-label','定位音频评论：'+comment.body);
      }}
      for(const button of markers.children)button.classList.toggle('active',button.dataset.commentId===state.selected);
    };box.reviewPaintComments();
  }
  parent.append(box);
  const active=state.anchor?.type==='time'&&state.productionSelected?.id===record.id?state.anchor:state.comments.find(c=>c.id===state.selected&&c.target_revision_id===record.id)?.anchor;
  if(active?.type==='time'&&active.component_id===component.id&&active.asset_file===component.file&&from<=active.start_seconds&&active.end_seconds<=to){range=[active.start_seconds,active.end_seconds];media.dataset.reviewSeek=String(active.start_seconds)}
  paint();
  if(audio)reviewWaveform(media.src).then(({peaks,duration})=>{
    if(!box.isConnected)return;fallback.hidden=true;const path=document.createElementNS(svg.namespaceURI,'path');let d='';
    const scale=Math.max(...peaks,.001);
    for(let i=0;i<400;i++){const t=from+i/399*span,j=Math.min(peaks.length-1,Math.floor(t/duration*peaks.length)),v=peaks[j]/scale*32;d+=`M${i*2},${36-v}V${36+v} `}path.setAttribute('d',d);svg.append(path);box.dataset.waveform='decoded';
  }).catch(()=>{fallback.textContent='波形不可用 · 可继续播放和选段';box.dataset.waveform='unavailable'});
  return box;
}
