/* Scene navigation is a view over immutable episode revisions. Comments stay episode-scoped. */
const scriptVersion=()=>state.screenplays.find(v=>v.object_id===state.screenplayVersion);
const scriptEpisode=()=>scriptVersion()?.episodes.find(e=>e.object_id===state.screenplayEpisode);
const scriptScene=()=>scriptEpisode()?.payload.scenes.find(s=>s.id===state.screenplayScene);
const scriptVersionLabel=version=>version.payload.title.replace(/^剧本(?=[一二三四五六七八九十百零〇\d])/u,'版本');
const durationLabel=seconds=>Math.floor(seconds/60)+'分'+(seconds%60?String(seconds%60).padStart(2,'0')+'秒':'');
const episodeCode=episode=>'E'+String(episode.payload.number).padStart(2,'0');
function sceneCode(scene){
  const numbered=scene.id.match(/^s0*(\d+)$/iu);
  if(numbered)return 'S'+numbered[1].padStart(2,'0');
  const index=scriptVersion()?.episodes.flatMap(episode=>episode.payload.scenes).findIndex(item=>item===scene);
  return index<0?'场次':'S'+String(index+1).padStart(2,'0');
}
const sceneTitle=scene=>scene.heading.replace(/^\d+-\d+\s*/u,'');
const episodeTitle=episode=>episode.payload.title.replace(/^第\d+集\s*/u,'')||episode.payload.title;
function episodeSceneRange(episode){
  const scenes=episode.payload.scenes;
  if(!scenes.length)return '暂无场次';
  const first=sceneCode(scenes[0]),last=sceneCode(scenes.at(-1));
  return first===last?first:first+'–'+last;
}
const scriptDraftMetaKey=episode=>'review-script-editor:'+episode.id;
function rememberScriptDraft(){
  const episode=scriptEpisode();
  if(episode&&state.anchor)localStorage.setItem(scriptDraftMetaKey(episode),JSON.stringify({anchor:state.anchor,editing:state.editing}));
}
function forgetScriptDraft(){const episode=scriptEpisode();if(episode)localStorage.removeItem(scriptDraftMetaKey(episode))}
function restoreScriptDraft(){
  const episode=scriptEpisode();if(!episode||state.anchor)return;
  try{
    const saved=JSON.parse(localStorage.getItem(scriptDraftMetaKey(episode))||'null');
    if(saved?.anchor&&(!saved.editing||state.comments.some(c=>c.id===saved.editing&&c.target_revision_id===episode.id))){
      state.anchor=saved.anchor;state.editing=saved.editing||null;
    }
  }catch{localStorage.removeItem(scriptDraftMetaKey(episode))}
}
function sceneForBlock(episode,blockId){return episode?.payload.scenes.find(scene=>scene.block_ids.includes(blockId))}
function scriptUrl(){
  const url=new URL(location.href);url.searchParams.set('workspace','story.script');
  if(state.screenplayVersion)url.searchParams.set('script',state.screenplayVersion);else url.searchParams.delete('script');
  if(state.screenplayEpisode)url.searchParams.set('episode',state.screenplayEpisode);else url.searchParams.delete('episode');
  if(state.screenplayScene)url.searchParams.set('scene',state.screenplayScene);else url.searchParams.delete('scene');
  return url;
}
function chooseScript(versionId,episodeId,sceneId=null,updateUrl=true){
  const version=state.screenplays.find(v=>v.object_id===versionId)||state.screenplays.at(-1);
  const episode=version?.episodes.find(e=>e.object_id===episodeId)||version?.episodes[0];
  const scene=episode?.payload.scenes.find(s=>s.id===sceneId)||null;
  const changedEpisode=episode?.id!==scriptEpisode()?.id;
  state.screenplayVersion=version?.object_id||null;state.screenplayEpisode=episode?.object_id||null;state.screenplayScene=scene?.id||null;
  if(changedEpisode){
    state.anchor=null;state.editing=null;state.selected=null;state.preview=null;state.suggestion=null;state.pending=null;
    restoreScriptDraft();
  }
  getSelection()?.removeAllRanges();hideSelectionAction();
  if(updateUrl){const url=scriptUrl();if(url.href!==location.href)history.pushState(null,'',url)}
  renderScriptIndex();renderScriptReader();if(isScript())renderComments();$('#screenplay-reader').scrollTop=0;
}
function renderScriptIndex(){
  const versions=$('#screenplay-index'),episodes=$('#screenplay-episodes');
  const versionScroll=versions.scrollLeft,episodeScroll=episodes.scrollLeft;
  versions.replaceChildren();episodes.replaceChildren();
  if(!state.screenplays.length){nodeText('p','source-no-results','尚未发布剧本。',versions);return}
  for(const version of state.screenplays){
    const active=version.object_id===state.screenplayVersion;
    const button=nodeText('button','screenplay-version'+(active?' active':''),scriptVersionLabel(version),versions);
    button.type='button';button.dataset.scriptId=version.object_id;button.setAttribute('aria-current',active?'page':'false');
    button.onclick=()=>chooseScript(version.object_id,version.episodes[0]?.object_id);
  }
  for(const episode of scriptVersion()?.episodes||[]){
    const active=episode.object_id===state.screenplayEpisode;
    const button=el('button','screenplay-episode'+(active?' active':''));button.type='button';button.dataset.episodeId=episode.object_id;
    button.setAttribute('aria-current',active?'page':'false');
    const top=el('span','screenplay-episode-meta');button.append(top);
    nodeText('b',null,episodeCode(episode),top);nodeText('span',null,episodeSceneRange(episode),top);
    nodeText('strong',null,episodeTitle(episode),button);
    button.onclick=()=>chooseScript(state.screenplayVersion,episode.object_id);
    episodes.append(button);
  }
  versions.scrollLeft=versionScroll;episodes.scrollLeft=episodeScroll;
}
function renderScriptSceneIndex(episode){
  const directory=$('#screenplay-scene-index');directory.replaceChildren();
  if(!episode)return;
  for(const scene of episode.payload.scenes){
    const selected=scene.id===state.screenplayScene;
    const button=el('button','screenplay-scene-button'+(selected?' active':''));button.type='button';button.dataset.sceneId=scene.id;
    button.setAttribute('aria-current',selected?'page':'false');
    nodeText('span','screenplay-scene-code',sceneCode(scene),button);
    nodeText('strong',null,sceneTitle(scene),button);
    nodeText('small',null,durationLabel(scene.estimated_seconds),button);
    button.onclick=()=>chooseScript(state.screenplayVersion,episode.object_id,scene.id);
    directory.append(button);
  }
}
function renderScriptReader(){
  hideSelectionAction();const root=$('#screenplay-reader'),scrollTop=root.scrollTop,overview=$('#screenplay-overview');root.replaceChildren();overview.replaceChildren();
  const episode=scriptEpisode();
  renderScriptSceneIndex(episode);
  if(!episode){$('#screenplay-head').textContent='尚未发布剧本';$('#screenplay-detail').textContent='';nodeText('p','empty','完整分集影视剧本将在这里阅读和审阅。',root);return}
  const data=episode.payload,scene=scriptScene();
  const heading=el('div','screenplay-overview-heading');overview.append(heading);
  nodeText('strong',null,episodeCode(episode)+' '+episodeTitle(episode),heading);
  nodeText('span',null,episodeSceneRange(episode)+' · '+data.scenes.length+' 场 · 预计正片 '+durationLabel(data.estimated_seconds),heading);
  const summary=state.screenplaySummaries.get(episode.object_id+':'+episode.id);
  if(summary)nodeText('p','screenplay-summary',summary,overview);
  $('#screenplay-head').textContent=scene?scene.heading:'选择左侧场次阅读正文';
  $('#screenplay-detail').textContent=scene?scene.location+' · '+scene.time+' · 预计 '+durationLabel(scene.estimated_seconds):'本集场次按原剧本顺序排列';
  if(scene){
    const text=el('section','source-text');text.id='screenplay-text';text.setAttribute('aria-label',scene.heading+'完整正文');
    const source={id:episode.object_id,target_revision_id:episode.id,blocks:data.blocks};
    const indexes=new Map(data.blocks.map((block,index)=>[block.id,index]));
    for(const id of scene.block_ids){const index=indexes.get(id);if(index!==undefined)text.append(renderBlock(source,data.blocks[index],index))}
    root.append(text);
  }else nodeText('p','screenplay-scene-empty','选择左侧场次，阅读该场完整正文。',root);
  root.scrollTop=scrollTop;
}
function appendScriptCommentScope(card,comment){
  const episode=scriptEpisode(),first=sceneForBlock(episode,comment.anchor.block_id),last=sceneForBlock(episode,comment.anchor.end_block_id);
  if(!first)return;
  const line=nodeText('small','screenplay-comment-scope',first===last?first.heading:first.heading+' → '+(last?.heading||'后续场次'),card);
  if(last&&last!==first){
    const button=nodeText('button','screenplay-comment-end','定位引用结尾',card);
    button.type='button';button.onclick=()=>locateScriptComment(comment,true);
    line.title='完整引用显示在上方；可分别定位开头和结尾';
  }
}
function locateScriptComment(comment,atEnd=false){
  if(comment.anchor_state?.valid===false)return toast('原引用已失效：'+comment.anchor_state.reason);
  const version=state.screenplays.find(v=>v.episodes.some(e=>e.object_id===comment.target_object_id&&e.id===comment.target_revision_id));
  if(!version)return toast('未找到该评论的分集修订；原评论仍保留');
  const episode=version.episodes.find(e=>e.object_id===comment.target_object_id&&e.id===comment.target_revision_id);
  const blockId=atEnd?comment.anchor.end_block_id:comment.anchor.block_id,scene=sceneForBlock(episode,blockId);
  if(!scene)return toast('未找到评论原场次；原评论仍保留');
  if(state.screenplayEpisode!==episode.object_id||state.screenplayScene!==scene.id)chooseScript(version.object_id,episode.object_id,scene.id);
  state.selected=comment.id;renderScriptReader();renderComments();
  const block=$('#screenplay-reader [data-block-id="'+escapeSelector(blockId)+'"]');
  if(block)(block.querySelector('.comment-mark.selected')||block).scrollIntoView({behavior:'smooth',block:'center'});
}
