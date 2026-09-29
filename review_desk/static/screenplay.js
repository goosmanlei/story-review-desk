/* Episodes use the same renderer, Unicode selection and comment panel as sources. */
const scriptVersion=()=>state.screenplays.find(v=>v.object_id===state.screenplayVersion);
const scriptEpisode=()=>scriptVersion()?.episodes.find(e=>e.object_id===state.screenplayEpisode);
const scriptVersionLabel=version=>version.payload.title.replace(/^剧本(?=[一二三四五六七八九十百零〇\d])/u,'版本');
const durationLabel=seconds=>`${Math.floor(seconds/60)}分${seconds%60?String(seconds%60).padStart(2,'0')+'秒':''}`;
function chooseScript(versionId,episodeId,updateUrl=true){
  const version=state.screenplays.find(v=>v.object_id===versionId)||state.screenplays.at(-1);
  const episode=version?.episodes.find(e=>e.object_id===episodeId)||version?.episodes[0];
  state.screenplayVersion=version?.object_id||null;state.screenplayEpisode=episode?.object_id||null;
  if(version)state.expandedScreenplays.add(version.object_id);
  state.anchor=null;state.editing=null;state.selected=null;state.preview=null;state.suggestion=null;state.pending=null;
  getSelection()?.removeAllRanges();hideSelectionAction();
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('workspace','story.script');if(version)url.searchParams.set('script',version.object_id);if(episode)url.searchParams.set('episode',episode.object_id);history.replaceState(null,'',url)}
  renderScriptIndex();renderScriptReader();if(isScript())renderComments();$('#screenplay-reader').scrollTop=0;
}
function renderScriptIndex(){
  const nav=$('#screenplay-index'),scrollTop=nav.scrollTop;nav.replaceChildren();
  if(!state.screenplays.length)nodeText('p','source-no-results','尚未发布剧本。完整版本导入后在此审阅。',nav);
  for(const version of [...state.screenplays].reverse()){
    const open=state.expandedScreenplays.has(version.object_id),group=el('section','source-group');
    const button=nodeText('button','source-group-toggle',`${open?'▾':'▸'} ${scriptVersionLabel(version)}`,group);button.type='button';button.dataset.scriptId=version.object_id;button.setAttribute('aria-expanded',String(open));
    button.onclick=()=>{if(open)state.expandedScreenplays.delete(version.object_id);else state.expandedScreenplays.add(version.object_id);renderScriptIndex()};
    const list=el('div','source-group-items');list.hidden=!open;
    for(const episode of version.episodes){
      const item=nodeText('button','source-button'+(episode.object_id===state.screenplayEpisode?' active':''),episode.payload.title,list);item.type='button';item.dataset.episodeId=episode.object_id;
      item.setAttribute('aria-current',episode.object_id===state.screenplayEpisode?'page':'false');item.onclick=()=>chooseScript(version.object_id,episode.object_id);
    }group.append(list);nav.append(group);
  }nav.scrollTop=scrollTop;
}
function renderScriptReader(){
  hideSelectionAction();const root=$('#screenplay-reader'),scrollTop=root.scrollTop;root.replaceChildren();
  const version=scriptVersion(),episode=scriptEpisode();
  if(!episode){$('#screenplay-head').textContent='尚未发布剧本';$('#screenplay-detail').textContent='';nodeText('p','empty','完整分集影视剧本将在这里阅读和审阅。',root);return}
  const data=episode.payload;
  $('#screenplay-head').textContent=data.title;$('#screenplay-detail').textContent=`${scriptVersionLabel(version)} · 预计正片 ${durationLabel(data.estimated_seconds)} · 待审阅`;
  const doc=el('article','document screenplay-document');nodeText('h2',null,data.title,doc);
  nodeText('p','intro',`预计正片 ${durationLabel(data.estimated_seconds)}，不含片头、前情和片尾；这是制作估算，尚无成片实测。`,doc);
  const basis=el('details','screenplay-basis');nodeText('summary',null,'改编依据与版本说明',basis);
  nodeText('p',null,version.payload.notes,basis);
  for(const [key,label] of [['story','故事'],['structure','结构']]){
    const ref=data.basis[key],row=el('p');row.append(document.createTextNode(`${label}：${ref.title||ref.object_id}。修订 ${ref.revision_id}。`));
    const a=nodeText('a',null,' 阅读依据',row);a.href=key==='story'?`/?workspace=story.sources&source=${encodeURIComponent(ref.object_id)}`:`/?workspace=story.outline&structure_revision=${encodeURIComponent(ref.revision_id)}`;basis.append(row);
  }doc.append(basis);
  const text=el('section','source-text');text.id='screenplay-text';text.setAttribute('aria-label','分集剧本正文');
  const source={id:episode.object_id,target_revision_id:episode.id,blocks:data.blocks};
  for(const scene of data.scenes){
    nodeText('h3','section-title',`${scene.heading} · 预计 ${durationLabel(scene.estimated_seconds)}`,text);
    nodeText('p','screenplay-scene-meta',`${scene.location}｜${scene.time}`,text);
    for(const id of scene.block_ids){const index=data.blocks.findIndex(b=>b.id===id);text.append(renderBlock(source,data.blocks[index],index))}
  }doc.append(text);root.append(doc);root.scrollTop=scrollTop;
}
function locateScriptComment(comment){
  if(comment.anchor_state?.valid===false)return toast(`原引用已失效：${comment.anchor_state.reason}`);
  const version=state.screenplays.find(v=>v.episodes.some(e=>e.object_id===comment.target_object_id&&e.id===comment.target_revision_id));
  if(!version)return toast('未找到该评论的分集修订；原评论仍保留');
  if(state.screenplayEpisode!==comment.target_object_id)chooseScript(version.object_id,comment.target_object_id);
  state.selected=comment.id;renderScriptReader();renderComments();
  const block=$(`#screenplay-reader [data-block-id="${escapeSelector(comment.anchor.block_id)}"]`);
  if(block)(block.querySelector('.comment-mark.selected')||block).scrollIntoView({behavior:'smooth',block:'center'});
}
