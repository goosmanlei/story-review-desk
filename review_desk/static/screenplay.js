/* Scene navigation is a view over immutable episode revisions. Comments stay episode-scoped. */
const scriptVersion=()=>state.screenplays.find(v=>v.object_id===state.screenplayVersion);
const scriptEpisode=()=>scriptVersion()?.episodes.find(e=>e.object_id===state.screenplayEpisode);
const scriptScene=()=>scriptEpisode()?.payload.scenes.find(s=>s.id===state.screenplayScene);
const scriptVersionLabel=version=>version.payload.title.replace(/^剧本(?=[一二三四五六七八九十百零〇\d])/u,'版本');
const durationLabel=seconds=>Math.floor(seconds/60)+'分'+(seconds%60?String(seconds%60).padStart(2,'0')+'秒':'');
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
  if(version)state.expandedScreenplays.add(version.object_id);
  if(changedEpisode){
    state.anchor=null;state.editing=null;state.selected=null;state.preview=null;state.suggestion=null;state.pending=null;
    restoreScriptDraft();
  }
  getSelection()?.removeAllRanges();hideSelectionAction();
  if(updateUrl){const url=scriptUrl();if(url.href!==location.href)history.pushState(null,'',url)}
  renderScriptIndex();renderScriptReader();if(isScript())renderComments();$('#screenplay-reader').scrollTop=0;
}
function renderScriptIndex(){
  const nav=$('#screenplay-index'),scrollTop=nav.scrollTop;nav.replaceChildren();
  if(!state.screenplays.length)nodeText('p','source-no-results','尚未发布剧本。完整版本导入后在此审阅。',nav);
  for(const version of [...state.screenplays].reverse()){
    const open=state.expandedScreenplays.has(version.object_id),group=el('section','source-group');
    const button=nodeText('button','source-group-toggle'+(version.object_id===state.screenplayVersion?' active':''),(open?'▾':'▸')+' '+scriptVersionLabel(version),group);
    button.type='button';button.dataset.scriptId=version.object_id;button.setAttribute('aria-expanded',String(open));
    button.onclick=()=>{
      if(version.object_id!==state.screenplayVersion)chooseScript(version.object_id,version.episodes[0]?.object_id);
      else{if(open)state.expandedScreenplays.delete(version.object_id);else state.expandedScreenplays.add(version.object_id);renderScriptIndex()}
    };
    const list=el('div','source-group-items');list.hidden=!open;
    for(const episode of version.episodes){
      const item=nodeText('button','source-button'+(episode.object_id===state.screenplayEpisode?' active':''),episode.payload.title,list);
      item.type='button';item.dataset.episodeId=episode.object_id;item.setAttribute('aria-current',episode.object_id===state.screenplayEpisode?'page':'false');
      item.onclick=()=>chooseScript(version.object_id,episode.object_id);
    }group.append(list);nav.append(group);
  }nav.scrollTop=scrollTop;
}
function scriptSceneDirectory(episode,parent){
  const directory=el('nav','screenplay-scene-list');directory.setAttribute('aria-label',episode.payload.title+'场次目录');
  for(const scene of episode.payload.scenes){
    const button=el('button','screenplay-scene-button');button.type='button';button.dataset.sceneId=scene.id;
    nodeText('strong',null,scene.heading,button);
    nodeText('span',null,scene.location+' · '+scene.time,button);
    nodeText('small',null,'预计 '+durationLabel(scene.estimated_seconds),button);
    button.onclick=()=>chooseScript(state.screenplayVersion,episode.object_id,scene.id);directory.append(button);
  }parent.append(directory);
}
function renderScriptReader(){
  hideSelectionAction();const root=$('#screenplay-reader'),scrollTop=root.scrollTop;root.replaceChildren();
  const version=scriptVersion(),episode=scriptEpisode();
  if(!episode){$('#screenplay-head').textContent='尚未发布剧本';$('#screenplay-detail').textContent='';nodeText('p','empty','完整分集影视剧本将在这里阅读和审阅。',root);return}
  const data=episode.payload,scene=scriptScene();
  $('#screenplay-head').textContent=scene?scene.heading:data.title;
  $('#screenplay-detail').textContent=scriptVersionLabel(version)+' · '+data.title+' · '+(scene?'本场预计 '+durationLabel(scene.estimated_seconds):'本集预计正片 '+durationLabel(data.estimated_seconds))+' · 待审阅';
  const doc=el('article','document screenplay-document');
  const breadcrumb=el('div','screenplay-breadcrumb');
  const back=nodeText('button',null,data.title,breadcrumb);back.type='button';back.onclick=()=>chooseScript(version.object_id,episode.object_id);
  if(scene)nodeText('span',null,' / '+scene.heading,breadcrumb);
  doc.append(breadcrumb);nodeText('h2',null,scene?scene.heading:data.title,doc);
  if(!scene){
    nodeText('p','intro','本集 '+data.scenes.length+' 场，预计正片 '+durationLabel(data.estimated_seconds)+'。时长含场间转换，不含片头、前情和片尾；这是制作估算，尚无成片实测。选择下方场次阅读完整正文。',doc);
    scriptSceneDirectory(episode,doc);
    const basis=el('details','screenplay-basis');nodeText('summary',null,'改编依据与版本说明',basis);
    nodeText('p',null,version.payload.notes,basis);
    for(const [key,label] of [['story','故事'],['structure','结构']]){
      const ref=data.basis[key],row=el('p');row.append(document.createTextNode(label+'：'+(ref.title||ref.object_id)+'。修订 '+ref.revision_id+'。'));
      const a=nodeText('a',null,' 阅读依据',row);a.href=key==='story'?'/?workspace=story.sources&source='+encodeURIComponent(ref.object_id):'/?workspace=story.outline&structure_revision='+encodeURIComponent(ref.revision_id);basis.append(row);
    }doc.append(basis);
  }else{
    nodeText('p','screenplay-scene-meta',scene.location+'｜'+scene.time+'｜预计 '+durationLabel(scene.estimated_seconds)+'（制作估算）',doc);
    const text=el('section','source-text');text.id='screenplay-text';text.setAttribute('aria-label',scene.heading+'完整正文');
    const source={id:episode.object_id,target_revision_id:episode.id,blocks:data.blocks};
    const indexes=new Map(data.blocks.map((block,index)=>[block.id,index]));
    for(const id of scene.block_ids){const index=indexes.get(id);if(index!==undefined)text.append(renderBlock(source,data.blocks[index],index))}
    doc.append(text);
    const position=data.scenes.indexOf(scene),next=data.scenes[position+1],previous=data.scenes[position-1];
    const pager=el('nav','screenplay-scene-pager');pager.setAttribute('aria-label','场次切换');
    if(previous){const button=nodeText('button',null,'← '+previous.heading,pager);button.onclick=()=>chooseScript(version.object_id,episode.object_id,previous.id)}
    if(next){const button=nodeText('button',null,next.heading+' →',pager);button.onclick=()=>chooseScript(version.object_id,episode.object_id,next.id)}
    doc.append(pager);
  }
  root.append(doc);root.scrollTop=scrollTop;
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
