/* Scene navigation is a view over immutable episode revisions. Comments stay episode-scoped. */
const scriptVersion=()=>state.screenplays.find(v=>v.object_id===state.screenplayVersion);
const scriptEpisode=()=>scriptVersion()?.episodes.find(e=>e.object_id===state.screenplayEpisode);
const scriptScene=()=>scriptEpisode()?.payload.scenes.find(s=>s.id===state.screenplayScene);
const scriptVersionLabel=(version,index)=>'版本'+(version.payload.title.match(/^(?:剧本|版本)\s*([一二三四五六七八九十百零〇\d]+)/u)?.[1]||String(index+1));
const durationLabel=seconds=>Math.floor(seconds/60)+'分'+(seconds%60?String(seconds%60).padStart(2,'0')+'秒':'');
const episodeCode=episode=>reviewPositionLabel('episode',episode);
function sceneCode(scene){
  if(scene.business_code)return scene.business_code;
  const numbered=scene.id.match(/^s0*(\d+)$/iu);
  if(numbered)return reviewPositionLabel('scene',numbered[1]);
  return reviewPositionLabel('scene',scene.id)||'场次';
}
const sceneTitle=scene=>reviewPositionText(scene.heading.replace(/^\d+-\d+\s*/u,''));
const episodeTitle=episode=>episode.payload.title.replace(/^第\s*\d+\s*集\s*/u,'')||episode.payload.title;
const scriptReadingPositions=new Map();
function styleScriptReader(){
  $('.screenplay-scene-side')?.classList.add('text-reader-index');
  $('.screenplay-reading-head')?.classList.add('text-reader-head');
}
function episodeSceneRange(episode){
  const scenes=episode.payload.scenes;
  if(!scenes.length)return '暂无场次';
  const first=sceneCode(scenes[0]),last=sceneCode(scenes.at(-1));
  return first===last?first:first+'–'+last;
}
const scriptEpisodeComments=episode=>state.comments.filter(comment=>comment.target_object_id===episode.object_id&&comment.target_revision_id===episode.id);
function scriptSceneCommentCounts(episode){
  const scenes=episode.payload.scenes,counts=new Map(scenes.map(scene=>[scene.id,0]));
  for(const comment of scriptEpisodeComments(episode)){
    const selected=new Set();
    for(const a of textAnchorSegments(comment.anchor)){
      const first=scenes.findIndex(scene=>scene.block_ids.includes(a.block_id)),last=scenes.findIndex(scene=>scene.block_ids.includes(a.end_block_id));
      if(first>=0)for(let index=first;index<=Math.max(first,last);index++)selected.add(scenes[index].id);
    }
    for(const id of selected)counts.set(id,counts.get(id)+1);
  }
  return counts;
}
function renderScriptCommentCounts(){
  const version=scriptVersion(),episode=scriptEpisode();
  for(const button of $('#screenplay-episodes').children){
    const item=version?.episodes.find(entry=>entry.object_id===button.dataset.episodeId);
    if(item)button.querySelector('.screenplay-episode-count').textContent='评论 '+scriptEpisodeComments(item).length;
  }
  if(!episode)return;
  const counts=scriptSceneCommentCounts(episode);
  for(const button of $('#screenplay-scene-index').children){
    button.querySelector('.screenplay-scene-count').textContent='评论 '+counts.get(button.dataset.sceneId);
  }
}
const scriptDraftMetaKey=episode=>'review-script-editor:'+episode.id+(commentPageId?':page:'+commentPageId:'');
function rememberScriptDraft(){
  const episode=scriptEpisode();
  if(!episode||!state.anchor)return;
  if(typeof markActiveCommentDraft==='function')markActiveCommentDraft();
  try{rememberLiveCommentEdit();localStorage.setItem(scriptDraftMetaKey(episode),JSON.stringify({anchor:state.anchor,editing:state.editing}))}
  catch{if(typeof rememberCommentDraftFailure==='function')rememberCommentDraftFailure();toast('本机草稿定位信息保存失败。当前仍可编辑，刷新后可能无法恢复原位置。')}
}
function forgetScriptDraft(){
  const episode=scriptEpisode();if(!episode)return;
  try{localStorage.removeItem(scriptDraftMetaKey(episode))}
  catch{toast('本机草稿定位信息未清理，刷新后可能重新打开原位置。')}
}
function restoreScriptDraft(){
  const episode=scriptEpisode();if(!episode||state.anchor)return;
  const fallback=typeof fallbackCommentDraftMeta==='function'?fallbackCommentDraftMeta():null;
  if(fallback){state.anchor=fallback.anchor;state.editing=fallback.editing||null;state.selected=fallback.selected||null;return}
  let raw,saved;
  try{raw=localStorage.getItem(scriptDraftMetaKey(episode))}
  catch{toast('本机草稿定位信息读取失败，本集正文仍可阅读。');return}
  try{saved=JSON.parse(raw||'null')}
  catch{
    try{localStorage.removeItem(scriptDraftMetaKey(episode))}
    catch{toast('本机草稿定位信息无法读取且未能清理，本集正文仍可阅读。')}
    return;
  }
  if(saved?.anchor&&(!saved.editing||state.comments.some(c=>c.id===saved.editing&&c.target_revision_id===episode.id))){
    state.anchor=saved.anchor;state.editing=saved.editing||null;
  }
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
  const version=versionId?state.screenplays.find(v=>v.object_id===versionId):state.screenplays.at(-1);
  const episode=episodeId?version?.episodes.find(e=>e.object_id===episodeId):version?.episodes[0];
  const scene=sceneId?episode?.payload.scenes.find(s=>s.id===sceneId):episode?.payload.scenes[0];
  state.screenplayRouteError=versionId&&!version?'指定的剧本版本不存在或已不可用':episodeId&&!episode?'指定的集不属于此剧本版本或已不可用':sceneId&&!scene?'指定的场次不属于本集或已不可用':null;
  const changedEpisode=episode?.id!==scriptEpisode()?.id,changedScene=changedEpisode||scene?.id!==state.screenplayScene;
  const reader=$('#screenplay-reader');
  if(changedEpisode&&isScript())rememberScriptDraft();
  if(reader.dataset.readingKey)scriptReadingPositions.set(reader.dataset.readingKey,Number(reader.scrollTop)||0);
  state.screenplayVersion=version?.object_id||null;state.screenplayEpisode=episode?.object_id||null;state.screenplayScene=scene?.id||null;
  if(changedEpisode&&isScript()){
    state.anchor=null;state.editing=null;state.selected=null;state.preview=null;state.suggestion=null;state.pending=null;
    restoreScriptDraft();
  }
  if(isScript()){getSelection()?.removeAllRanges();hideSelectionAction()}
  if(updateUrl){const url=scriptUrl();if(url.href!==location.href)history.pushState(null,'',url)}
  if(!state.screenplayRouteError&&!changedScene&&reader.dataset.readingKey===episode?.id+':'+(scene?.id||''))return;
  renderScriptIndex();renderScriptReader();if(isScript())renderComments();
}
function renderEpisodeCard(parent,episode,active,count,onchoose){
  const button=el('button','screenplay-episode source-button'+(active?' active':''));button.type='button';button.dataset.episodeId=episode.object_id;
  button.setAttribute('aria-current',active?'page':'false');
  const top=el('span','screenplay-episode-meta');button.append(top);
  nodeText('b',null,episodeCode(episode),top);nodeText('span',null,episodeSceneRange(episode),top);
  nodeText('strong',null,episodeTitle(episode),button);
  nodeText('small','screenplay-episode-count','评论 '+count,button).title='包含已关闭评论';
  button.onclick=onchoose;parent.append(button);return button;
}
function renderScriptIndex(){
  styleScriptReader();
  const versions=$('#screenplay-index'),episodes=$('#screenplay-episodes');
  const versionScroll=versions.scrollLeft,episodeScroll=episodes.scrollLeft;
  versions.replaceChildren();episodes.replaceChildren();
  if(!state.screenplays.length){nodeText('p','source-no-results','尚未发布剧本。',versions);return}
  for(const [index,version] of state.screenplays.entries()){
    const active=version.object_id===state.screenplayVersion;
    const button=nodeText('button','screenplay-version source-button'+(active?' active':''),scriptVersionLabel(version,index),versions);
    button.type='button';button.dataset.scriptId=version.object_id;button.setAttribute('aria-current',active?'page':'false');
    button.onclick=()=>{if(state.screenplayRouteError||version.object_id!==state.screenplayVersion)chooseScript(version.object_id,version.episodes[0]?.object_id)};
  }
  for(const episode of scriptVersion()?.episodes||[]){
    const active=episode.object_id===state.screenplayEpisode;
    const button=renderEpisodeCard(episodes,episode,active,scriptEpisodeComments(episode).length,
      ()=>{if(state.screenplayRouteError||episode.object_id!==state.screenplayEpisode)chooseScript(state.screenplayVersion,episode.object_id)});
  }
  versions.scrollLeft=versionScroll;episodes.scrollLeft=episodeScroll;
  for(const bar of [versions,episodes]){
    const selected=bar.querySelector('.active');
    if(!selected)continue;
    const item=selected.getBoundingClientRect(),edge=bar.getBoundingClientRect();
    if(item.left<edge.left)bar.scrollLeft+=item.left-edge.left;
    else if(item.right>edge.right)bar.scrollLeft+=item.right-edge.right;
  }
}
function renderScriptSceneIndex(episode){
  const directory=$('#screenplay-scene-index'),scrollTop=Number(directory.scrollTop)||0;directory.replaceChildren();
  if(!episode)return;
  const counts=scriptSceneCommentCounts(episode);
  for(const scene of episode.payload.scenes){
    const selected=scene.id===state.screenplayScene;
    const button=el('button','screenplay-scene-button source-button'+(selected?' active':''));button.type='button';button.dataset.sceneId=scene.id;
    button.setAttribute('aria-current',selected?'page':'false');
    nodeText('span','screenplay-scene-code',sceneCode(scene),button);
    nodeText('strong',null,sceneTitle(scene),button);
    nodeText('small',null,durationLabel(scene.estimated_seconds),button);
    const count=nodeText('span','screenplay-scene-count','评论 '+counts.get(scene.id),button);
    count.title='引用覆盖本场的评论，包含已关闭评论';
    button.onclick=()=>chooseScript(state.screenplayVersion,episode.object_id,scene.id);
    directory.append(button);
  }
  directory.scrollTop=scrollTop;
}
function renderScriptReader(){
  hideSelectionAction();styleScriptReader();const root=$('#screenplay-reader'),overview=$('#screenplay-overview');
  if(root.dataset.readingKey)scriptReadingPositions.set(root.dataset.readingKey,Number(root.scrollTop)||0);
  root.replaceChildren();overview.replaceChildren();
  const episode=scriptEpisode();
  renderScriptSceneIndex(episode);
  $('#comments-toggle').hidden=!!state.screenplayRouteError;$('#screenplay-comments').hidden=!!state.screenplayRouteError;
  if(state.screenplayRouteError){root.dataset.readingKey='';$('#screenplay-head').textContent='原链接目标不可用';$('#screenplay-detail').textContent='选择左侧场次或上方集与版本继续阅读。';const issue=nodeText('p','production-issue',state.screenplayRouteError+'；未打开其他内容。请选择可用目标。',root);issue.setAttribute('role','alert');return}
  if(!episode){root.dataset.readingKey='';$('#screenplay-head').textContent='尚未发布剧本';$('#screenplay-detail').textContent='';nodeText('p','empty','完整分集影视剧本将在这里阅读和审阅。',root);return}
  const data=episode.payload,scene=scriptScene();
  root.dataset.readingKey=episode.id+':'+(scene?.id||'');
  const heading=el('div','screenplay-overview-heading');overview.append(heading);
  nodeText('strong',null,episodeCode(episode)+' '+episodeTitle(episode),heading);
  nodeText('span',null,episodeSceneRange(episode)+' · '+data.scenes.length+' 场 · 预计正片 '+durationLabel(data.estimated_seconds),heading);
  const summary=state.screenplaySummaries.get(episode.object_id+':'+episode.id);
  if(summary)nodeText('p','screenplay-summary',summary,overview);
  $('#screenplay-head').textContent=scene?sceneCode(scene)+' '+sceneTitle(scene):'选择左侧场次阅读正文';
  $('#screenplay-detail').textContent=scene?scene.location+' · '+scene.time+' · 预计 '+durationLabel(scene.estimated_seconds):'本集场次按原剧本顺序排列';
  if(scene){
    const text=el('section','source-text');text.id='screenplay-text';reviewSurface(text);text.setAttribute('aria-label',sceneCode(scene)+' '+sceneTitle(scene)+'完整正文');
    const source={id:episode.object_id,target_revision_id:episode.id,blocks:data.blocks};
    const indexes=new Map(data.blocks.map((block,index)=>[block.id,index]));
    for(const id of scene.block_ids){const index=indexes.get(id);if(index!==undefined)text.append(renderBlock(source,data.blocks[index],index))}
    root.append(text);renderStoryProductionLinks(root,episode,scene);
  }else nodeText('p','screenplay-scene-empty','本集暂无场次。',root);
  root.scrollTop=scriptReadingPositions.get(root.dataset.readingKey)||0;
}
async function renderStoryProductionLinks(root,episode,scene){
  const box=el('section','story-production-links');nodeText('h3',null,'相关制作',box);root.append(box);
  const open=(record,trigger)=>{
    if(record.kind.startsWith('AV_')){
      rememberWorkspacePosition();rememberWorkspaceRoute();const url=new URL(location.href);url.search='';
      url.searchParams.set('workspace','settings.workspace');url.searchParams.set('production_tab','breakdown');
      url.searchParams.set('breakdown_object',record.object_id);url.searchParams.set('breakdown_revision',record.id);
      history.pushState(null,'',url);switchWorkspace('settings.workspace',false);
    }else if(['ENTITY','STATE','REQUIREMENT'].includes(record.kind))openUnifiedMaterial({...productionRef(record),work:{...productionRef(episode),scene_id:scene.id}},trigger);
    else openMaterialReference(productionRef(record),trigger);
  };
  try{
    const data=await api('/api/production/story-related?'+new URLSearchParams({object_id:episode.object_id,revision_id:episode.id,scene_id:scene.id}));
    if(!box.isConnected)return;
    for(const [label,kind] of [['整场视听设计','AV_SCENE'],['人物、场所与物件','ENTITY']]){
      const rows=data.items.filter(item=>item.record.kind===kind);if(!rows.length)continue;
      const group=el('nav');group.setAttribute('aria-label',label);nodeText('h4',null,label,group);
      for(const {record} of rows){const button=productionButton(group,businessTitle(record),()=>open(record,button));button.classList.add('material-reference')}
      box.append(group);
    }
    const remaining=data.items.filter(item=>!['AV_SCENE','ENTITY'].includes(item.record.kind));
    if(remaining.length){
      const select=el('select');select.setAttribute('aria-label','定位具体制作内容');select.append(new Option('定位具体镜头、状态或素材方案',''));
      for(const {record} of remaining)select.append(new Option(businessTitle(record),record.id));
      select.onchange=()=>{const row=remaining.find(item=>item.record.id===select.value)?.record;if(row)open(row,select);select.value=''};
      box.append(select);
    }
    if(!data.items.length)nodeText('p','production-meta','此准确故事场尚无关联制作',box);
  }catch(error){if(box.isConnected)nodeText('p','production-issue',error.message,box)}
}
function appendScriptCommentScope(card,comment){
  const episode=scriptEpisode(),first=sceneForBlock(episode,comment.anchor.block_id),last=sceneForBlock(episode,comment.anchor.end_block_id);
  if(!first)return;
  const line=nodeText('small','screenplay-comment-scope',first===last?sceneCode(first)+' '+sceneTitle(first):sceneCode(first)+' '+sceneTitle(first)+' → '+(last?sceneCode(last)+' '+sceneTitle(last):'后续场次'),card);
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
  if(block){
    revealLocatedComment();
    (block.querySelector('.comment-mark.selected')||block).scrollIntoView({behavior:'smooth',block:'center'});
  }
}
