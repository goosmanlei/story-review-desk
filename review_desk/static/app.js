// URL and browser persistence share one explicit environment/publication boundary.
const reviewDeployment=globalThis.REVIEW_DEPLOYMENT||{base_path:'',publication_id:'',experience:false};
function reviewURL(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//'))return value;
  const prefix=(globalThis.REVIEW_DEPLOYMENT||{}).base_path;
  if(!prefix||value===prefix||value.startsWith(prefix+'/'))return value;
  return prefix+value;
}
function reviewPublicationChanged(){
  if(typeof location!=='undefined')location.reload();
  throw Error('体验版本已更新，请刷新页面后重新操作');
}
function reviewStorage(name){
  const scope='review-env:'+encodeURIComponent(reviewDeployment.base_path||'/')+':';
  const identity=reviewDeployment.publication_id;
  const prefix=identity?scope+identity+':':'';
  const current=scope+'current';
  let tracked=false;
  function storage(){
    const native=globalThis[name];
    if(identity&&tracked&&native.getItem(current)!==identity)reviewPublicationChanged();
    return native;
  }
  if(identity){
    try{
      const native=globalThis[name],keys=[];
      for(let i=0;i<native.length;i++)keys.push(native.key(i));
      for(const key of keys)if(key?.startsWith(scope)&&key!==current&&!key.startsWith(prefix))native.removeItem(key);
      native.setItem(current,identity);
      tracked=true;
    }catch{ /* Existing draft failure handling remains responsible for unavailable storage. */ }
  }
  return {getItem:key=>storage().getItem(prefix+key),setItem:(key,value)=>storage().setItem(prefix+key,value),removeItem:key=>storage().removeItem(prefix+key),keys:()=>Array.from({length:storage().length},(_,i)=>storage().key(i)).filter(key=>key?.startsWith(prefix)).map(key=>key.slice(prefix.length))};
}
const localStorage=reviewDeployment.publication_id?reviewStorage('localStorage'):globalThis.localStorage,sessionStorage=reviewDeployment.publication_id?reviewStorage('sessionStorage'):globalThis.sessionStorage;
async function reviewFetch(path,options={}){
  const publication=(globalThis.REVIEW_DEPLOYMENT||{}).publication_id;
  const headers={...(options.headers||{}),...(publication?{'X-Review-Publication':publication}:{})};
  const response=await fetch(reviewURL(path),{...options,headers});
  if(response.status===409&&publication){
    const data=await response.clone().json().catch(()=>null);
    if(data?.publication_changed)reviewPublicationChanged();
  }
  return response;
}
const state={sources:[],comments:[],current:null,anchor:null,editing:null,selected:null,historyOpen:false,historyLimit:20,suggestion:null,preview:null,previewExpanded:false,framework:null,configurations:null,workspace:'story.sources',configSection:'PROJECT',expandedGroups:new Set(),expandedSources:new Set(),sourceChapter:null,structure:null,structureRevision:null,drawMode:null,screenplays:[],screenplaySummaries:new Map(),screenplayVersion:null,screenplayEpisode:null,screenplayScene:null};
const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node};
function unpackReviewGraph(graph){
  if(graph?.format!=='review-graph-v1'||!Array.isArray(graph.nodes)||graph.nodes.length>200000)throw Error('Unsupported review response');
  function read(value,upper=graph.nodes.length){
    if(value===null||typeof value!=='object')return value;
    const index=value.$;if(!Number.isInteger(index)||index<0||index>=upper)throw Error('Invalid review reference');
    const [kind,data]=graph.nodes[index];
    if(kind==='s')return data;
    if(kind==='a')return data.map(item=>read(item,index));
    if(kind==='o')return Object.fromEntries(data.map(([key,item])=>[key,read(item,index)]));
    throw Error('Invalid review node');
  }
  return read(graph.root);
}
const api=async(path,options={})=>{const response=await reviewFetch(path,{...options,headers:{'Content-Type':'application/json','Accept':'application/vnd.review-desk.graph+json, application/json',...(options.headers||{})}});let data;try{data=await response.json();if(response.headers?.get?.('Content-Type')?.includes('application/vnd.review-desk.graph+json'))data=unpackReviewGraph(data)}catch(error){error.status=response.status;throw error}if(!response.ok){const error=Error(data.error||`HTTP ${response.status}`);error.status=response.status;throw error}return data};
const chars=text=>Array.from(text);
const toast=message=>{const node=$('#toast');node.textContent=message;node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),3500)};
const isStructure=()=>state.workspace==='story.outline';
const isScript=()=>state.workspace==='story.script';
const isProduction=()=>['settings.workspace','materials.workspace','production.workspace'].includes(state.workspace);
let storyDataReady=false,storyDataRead=null,workspaceReadEpoch=0;
async function loadStoryDirectory(){
  const [sources,screenplays]=await Promise.all([api('/api/sources?with_revision=1&metadata=1'),api('/api/screenplays?metadata=1')]);
  if(!storyDataReady){state.sources=sources;state.screenplays=screenplays.versions}
}
function loadStoryData(){
  if(storyDataReady)return Promise.resolve();
  if(storyDataRead)return storyDataRead;
  storyDataRead=Promise.all([api('/api/sources?with_revision=1'),api('/api/story-structure'),api('/api/screenplays'),api('/api/screenplay-summaries').catch(()=>({episodes:[]}))]).then(([sources,structure,screenplays,summaries])=>{
    state.sources=sources.sort((a,b)=>Number(!!a.media)-Number(!!b.media)||(a.order||0)-(b.order||0)||a.id.localeCompare(b.id));
    state.structure=structure;state.structureRevision=structure.current_revision;state.screenplays=screenplays.versions;
    state.screenplaySummaries=new Map(summaries.episodes.map(item=>[item.object_id+':'+item.revision_id,item.summary]));storyDataReady=true;
  }).finally(()=>{storyDataRead=null});return storyDataRead;
}
function initializeStoryReaders(url){
  state.structureRevision=resolveStructureRevision(url.searchParams.get('structure_revision'));
  state.structureRouteError=url.searchParams.get('structure_revision')&&!state.structureRevision?'指定的结构修订不存在或已不可用；未打开其他稿次。请选择可用稿次。':null;
  chooseSource(url.searchParams.get('source')||state.sources[0]?.id,true,false,url.searchParams.has('source'));
  chooseScript(url.searchParams.get('script'),url.searchParams.get('episode'),url.searchParams.get('scene'),false);
}
const commentTarget=()=>state.reviewReferenceContext?{target_object_id:state.reviewReferenceContext.record.object_id,target_revision_id:state.reviewReferenceContext.record.id}:isProduction()?{target_object_id:state.productionSelected?.object_id,target_revision_id:state.productionSelected?.id}:isStructure()?{target_object_id:'story-structure',target_revision_id:state.structureRevision}:isScript()?{target_object_id:scriptEpisode()?.object_id,target_revision_id:scriptEpisode()?.id}:{source_id:state.current?.id,target_revision_id:state.current?.target_revision_id};
const legacyDraftKey=()=>state.anchor?`review-draft:${isProduction()?state.productionSelected?.id:isStructure()?state.structureRevision:isScript()?scriptEpisode()?.id:state.current?.id}:${state.editing||'new'}:${JSON.stringify(state.anchor)}`:null;
// Reload keeps this page's drafts. A new/duplicated/reopened document starts a
// separate editor; other saved local drafts are available through explicit recovery.
const commentPageId=(()=>{if(!globalThis.crypto?.randomUUID||!sessionStorage)return null;const idKey='review-comment-page';let id;try{if(['reload','back_forward'].includes(globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type))id=sessionStorage.getItem(idKey);id ||= crypto.randomUUID();sessionStorage.setItem(idKey,id)}catch{id=crypto.randomUUID()}return id})();
const editDraftBases=new Map();
const editDraftKey=()=>state.editing&&state.anchor?`review-comment-edit:${commentPageId||'page'}:${JSON.stringify([commentTarget(),state.editing,state.anchor])}`:null;
const draftKey=()=>{if(state.editing&&commentPageId)return editDraftKey();const key=legacyDraftKey(),context=!state.editing&&typeof materialCommentContext==='function'?materialCommentContext():null;return key&&context?`${key}:material:${JSON.stringify([context.material_id,context.number,...(context.model?[context.model]:[])])}`:key};
function editDraftBasis(key=draftKey()){
  if(!state.editing)return null;
  if(editDraftBases.has(key))return editDraftBases.get(key);
  try{const saved=JSON.parse(localStorage.getItem(key+':basis')||'null');if(saved?.editing===state.editing&&JSON.stringify(saved.target)===JSON.stringify(commentTarget())&&JSON.stringify(saved.anchor)===JSON.stringify(state.anchor)){editDraftBases.set(key,saved);return saved}}catch{}
  return null;
}
function rememberEditBasis(basis,key=draftKey()){
  editDraftBases.set(key,basis);localStorage.setItem(key+':basis',JSON.stringify(basis));
}
function beginCommentEdit(comment){
  const key=draftKey();if(editDraftBasis(key))return;
  // Legacy drafts have no provable start version. Keep the text, require review.
  let legacy=null;try{legacy=localStorage.getItem(legacyDraftKey())}catch{}
  const basis=JSON.parse(JSON.stringify({editing:comment.id,target:commentTarget(),anchor:state.anchor,version:legacy!==null?null:comment.version,body:legacy!==null?null:comment.body,workspace:state.workspace,owner:commentPageId,created_at:new Date().toISOString()}));
  editDraftBases.set(key,basis);
  try{rememberEditBasis(basis,key);if(legacy!==null&&localStorage.getItem(key)===null)localStorage.setItem(key,legacy)}catch{toast('本机草稿保存失败，开始编辑的依据与输入仍在当前页面；请复制留存。')}
}
function storedCommentEdits(){
  try{const keys=localStorage.keys?localStorage.keys():Array.from({length:localStorage.length},(_,i)=>localStorage.key(i));return keys.filter(k=>k?.startsWith('review-comment-edit:')&&k.endsWith(':basis')).flatMap(meta=>{const key=meta.slice(0,-6),basis=JSON.parse(localStorage.getItem(meta)||'null'),text=localStorage.getItem(key);return basis&&text!==null&&JSON.stringify(basis.target)===JSON.stringify(commentTarget())&&state.comments.some(c=>c.id===basis.editing&&c.target_revision_id===basis.target.target_revision_id)?[{key,basis,text}]:[]})}catch{return []}
}
function appendStoredCommentEdits(parent){
  const drafts=storedCommentEdits().filter(d=>d.key!==draftKey());if(!drafts.length)return;
  const section=el('details','context-preview');nodeText('summary',null,`未保存的评论修改 · ${drafts.length} 份`,section);
  nodeText('p','comment-help','这些文字只保存在本机，仍绑定原评论和原圈选。恢复另一页的草稿会在此页建立副本，不清除另一页输入。',section);
  for(const draft of drafts){const c=state.comments.find(c=>c.id===draft.basis.editing),row=el('section');nodeText('p',null,`${c.business_code||'评论'} · ${new Date(draft.basis.created_at).toLocaleString('zh-CN')} · ${anchorLabel(draft.basis.anchor)}`,row);nodeText('pre',null,draft.text,row);
    const restore=nodeText('button',null,`继续 ${c.business_code||'评论'} 的未保存修改`,row);restore.onclick=async()=>{if(commentSaves.has(draftKey()))return;await editComment(c);if(state.editing!==c.id||JSON.stringify(commentTarget())!==JSON.stringify(draft.basis.target))return;const key=draftKey();if(liveCommentDraft()?.value&&localStorage.getItem(key)!==null&&key!==draft.key){toast('此页已有未保存修改，请先处理后再恢复其他草稿。');return}try{localStorage.setItem(key,draft.text);rememberEditBasis({...draft.basis,owner:commentPageId},key);renderComments({replaceDraft:true})}catch{toast('恢复未完成，原草稿仍在本机。')}};
    const discard=nodeText('button','destructive','放弃这份本机草稿',row);discard.onclick=()=>{try{if(localStorage.getItem(draft.key)!==draft.text||localStorage.getItem(draft.key+':basis')!==JSON.stringify(draft.basis)){toast('这份草稿已变化，请重新打开核对后再放弃。');return}localStorage.removeItem(draft.key+':submission');localStorage.removeItem(draft.key+':basis');localStorage.removeItem(draft.key);renderComments();toast('所选本机草稿已放弃，已保存评论和其他草稿保留。')}catch{toast('草稿未能完全清除，请复制留存后重试。')}};section.append(row);
  }parent.append(section);
}
function appendEditConflict(editor){
  if(!state.editing)return;
  const basis=editDraftBasis(),latest=state.comments.find(c=>c.id===state.editing);if(!basis||!latest)return;
  nodeText('p','comment-help',`未保存修改 · 开始编辑依据：${basis.version===null?'旧草稿，版本未知':'评论版本 '+basis.version}`,editor);
  const notice=el('section','comment-edit-conflict');notice.setAttribute('role','status');
  if(basis.version!==latest.version||basis.conflict)nodeText('p','comment-help','这条评论已有新的保存内容，你的修改尚未保存。请查看最新内容，人工整理后再保存，或放弃此页修改。',notice);
  const view=nodeText('button',null,'查看最新已保存内容',notice);view.disabled=commentSaves.has(draftKey());view.onclick=async()=>{const key=draftKey(),action=commentAction;if(commentSaves.has(key))return;try{await refreshComments();if(key!==draftKey()||action!==commentAction)return;const current=state.comments.find(c=>c.id===state.editing);if(!current)throw Error('原评论已不可用；草稿仍保留');rememberEditBasis({...editDraftBasis(),reviewed:{version:current.version,body:current.body,status:current.status}},key);renderComments()}catch(error){if(key===draftKey()&&action===commentAction)toast(error.message)}};
  if(basis.reviewed){nodeText('p',null,`已保存 · 评论版本 ${basis.reviewed.version}${basis.reviewed.status==='CLOSED'?' · 已关闭':''}`,notice);nodeText('pre',null,basis.reviewed.body,notice);
    const use=nodeText('button',null,'已核对，按此版本继续修改',notice);use.disabled=commentSaves.has(draftKey());use.onclick=()=>{const key=draftKey(),current=state.comments.find(c=>c.id===state.editing),saved=editDraftBasis();if(commentSaves.has(key))return;if(!current||current.version!==saved.reviewed.version){toast('评论再次变化，请重新查看最新内容。');return}try{localStorage.setItem(key+':basis',JSON.stringify({...saved,version:saved.reviewed.version,body:saved.reviewed.body,reviewed:null,conflict:false}));localStorage.removeItem(key+':submission');editDraftBases.delete(key);commentRejections.delete(key);renderComments();toast('已更新保存依据，草稿原文未改；请人工整理后保存。')}catch{toast('本机保存依据未能更新，草稿仍保留。')}};
  }editor.append(notice);
}
const commentSaves=new Set();
const commentRejections=new Map();
const commentReceipts=new Map();
// Only failed local writes need a session fallback. Its identity includes the
// exact target revision: legacy SOURCE storage keys alone do not include it.
const commentDraftFallbacks=new Map();
const commentDraftActiveContexts=new Map();
const commentDraftIdentity=(key=draftKey(),target=commentTarget())=>JSON.stringify([key,target]);
const commentDraftContext=()=>JSON.stringify([state.workspace,commentTarget()]);
function markActiveCommentDraft(){commentDraftActiveContexts.set(commentDraftContext(),commentDraftIdentity())}
function forgetActiveCommentDraft(identity){for(const [scope,active] of commentDraftActiveContexts)if(active===identity)commentDraftActiveContexts.delete(scope)}
function liveCommentDraft(){
  const editor=$('.comment-editor'),key=draftKey(),target=commentTarget();
  if(!key||editor?.dataset?.draftKey!==key||editor.dataset.draftTarget!==JSON.stringify(target))return null;
  const input=editor.querySelector('textarea');if(!input)return null;
  return {value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection,intent:editor.querySelector('#material-revision-intent')?.checked};
}
function rememberCommentDraftFailure(){
  if(!state.anchor)return;
  const key=draftKey(),target=commentTarget(),identity=commentDraftIdentity(key,target);
  const previous=commentDraftFallbacks.get(identity),live=liveCommentDraft();
  const entry={...previous,...live,key,target,workspace:state.workspace,anchor:state.anchor,editing:state.editing,selected:state.selected};
  commentDraftFallbacks.delete(identity);commentDraftFallbacks.set(identity,entry);
  markActiveCommentDraft();
}
function fallbackCommentDraftMeta(){
  const entry=commentDraftFallbacks.get(commentDraftActiveContexts.get(commentDraftContext()));
  return entry&&(!entry.editing||state.comments.some(c=>c.id===entry.editing&&c.target_revision_id===entry.target.target_revision_id))?entry:null;
}
function readCommentDraftStorage(key){
  try{return localStorage.getItem(key)}catch{toast('本机草稿读取失败，当前页面中的输入仍保留，请复制留存后重试。');return null}
}
function pendingCommentSubmission(key,strict=false){
  try{
    const stored=localStorage.getItem(key+':submission'),value=JSON.parse(stored);
    if(!value?.id||!value.payload){commentRejections.delete(key);commentReceipts.delete(key);return null}
    const receipt=commentReceipts.get(key);if(receipt?.stored===stored)return {...value,acknowledged:true,local_receipt_only:!value.acknowledged};commentReceipts.delete(key);
    const known=commentRejections.get(key);if(known?.stored===stored)return {...value,rejection:known.rejection};commentRejections.delete(key);return value;
  }catch(error){if(strict)throw error;return null}
}
function appendCommentSubmissionNotice(editor,key,knownReceipt=null){
  if(!editor||!key)return;
  const pending=knownReceipt||pendingCommentSubmission(key);if(!pending||(state.editing&&!pending.acknowledged))return;
  const message=pending.acknowledged?'此评论已保存，但本机草稿尚未清除。原样再次保存只会重试清理，不会重复发送；修改内容后将按新内容提交。'+(pending.local_receipt_only?' 保存成功状态暂仅在当前页面，刷新后需用保留的原请求重新确认。':''):[400,409].includes(pending.rejection?.status)?`上次提交被拒绝（HTTP ${pending.rejection.status}）：${pending.rejection.message} 原草稿与圈选仍保留，请先核对相关内容后再提交。`:'上次提交尚未确认。原样重试可确认保存；修改内容后提交会作为一条新评论。';
  const notice=editor.querySelector('.comment-submission-notice')||nodeText('p','comment-help comment-submission-notice','',editor);notice.textContent=message;
  notice.setAttribute('role','status');
}
function markCommentSubmissionRejected(key,stored,submission,error){
  // Another tab may already own a newer attempt, even with the same server ID.
  try{if(localStorage.getItem(key+':submission')!==stored)return}catch{return false}
  const rejection={status:error.status,message:error.message};
  try{localStorage.setItem(key+':submission',JSON.stringify({...submission,rejection}));commentRejections.delete(key);return true}catch{commentRejections.set(key,{stored,rejection});return false}
}
function rememberCommentReceipt(key,stored,submission){
  // Keep the successful response even if persisting its local receipt fails.
  const receipt={...submission,acknowledged:true};commentReceipts.set(key,{stored,submission});
  try{
    if(localStorage.getItem(key+':submission')!==stored)return stored;
    const saved=JSON.stringify(receipt);localStorage.setItem(key+':submission',saved);
    commentReceipts.set(key,{stored:saved,submission});return saved;
  }catch{return stored}
}

function commentRevisionIntent(){
  if(state.editing)return null;
  return (typeof materialRevisionIntent==='function'?materialRevisionIntent():null)||pendingCommentSubmission(draftKey())?.payload.material_revision||null;
}
function recoverLegacyMaterialDraft(key,legacy){
  if(localStorage.getItem(key))return false;
  const text=localStorage.getItem(legacy);if(text===null)return false;
  // Write the destination completely before removing the only old copy.
  localStorage.setItem(key,text);
  const discussion=localStorage.getItem(legacy+':discussion');
  if(discussion!==null)localStorage.setItem(key+':discussion',discussion);
  localStorage.removeItem(legacy);localStorage.removeItem(legacy+':discussion');return true;
}
function appendLegacyMaterialDraft(editor,key){
  const legacy=legacyDraftKey(),text=legacy!==key?readCommentDraftStorage(legacy):null;if(state.editing||legacy===key||text===null)return;
  const details=el('details','context-preview');nodeText('summary',null,'有一份旧草稿，轮次无法确定',details);
  nodeText('p','comment-help','旧版本没有记录素材轮次，请核对后再恢复。已有本轮内容时不会覆盖，旧文字仍可查看和复制。',details);
  nodeText('pre',null,text,details);
  const context=materialCommentContext(),restore=nodeText('button',null,`恢复到当前第 ${context.number} 轮`,details);restore.type='button';restore.disabled=!!(editor.querySelector?.('textarea')?.value||readCommentDraftStorage(key));
  restore.onclick=()=>{if(draftKey()!==key||liveCommentDraft()?.value)return;try{if(recoverLegacyMaterialDraft(key,legacy)){commentDraftFallbacks.delete(commentDraftIdentity());renderComments({replaceDraft:true})}}catch(error){toast(error.message)}};
  editor.append(details);
}
const unscopedComments=()=>state.reviewReferenceContext?state.comments.filter(c=>c.target_revision_id===state.reviewReferenceContext.record.id):typeof isEntityReview==='function'&&isEntityReview()?entityReviewComments():typeof isMaterialReview==='function'&&isMaterialReview()?materialReviewComments():state.comments.filter(c=>isProduction()?c.target_object_id===state.productionSelected?.object_id&&c.target_revision_id===state.productionSelected?.id:isStructure()?c.target_object_id==='story-structure'&&c.target_revision_id===state.structureRevision:isScript()?c.target_object_id===scriptEpisode()?.object_id&&c.target_revision_id===scriptEpisode()?.id:c.target_object_id===state.current?.id&&c.target_revision_id===state.current?.target_revision_id);
const activeComments=()=>state.reviewCommentScope?reviewBlockComments(state.comments,state.reviewCommentScope):unscopedComments();
const newDraftAnchor=()=>state.anchor&&!state.editing?state.anchor:null;
const anchorLabel=a=>a.type==='global'?'整体意见':a.type==='time'?`时间段 ${a.start_seconds.toFixed(2)}–${a.end_seconds.toFixed(2)} 秒`:a.type==='visual'?'整张图像／图示':a.type==='region'?'图像／图示圈选区域':a.quote||'原文引用';
const renderActiveReader=()=>state.reviewReferenceContext?paintProductionReview():isProduction()?paintProductionReview():isStructure()?renderStructureReader():isScript()?renderScriptReader():renderDocument();
const escapeSelector=value=>CSS.escape(value);

function nodeText(tag,cls,text,parent){const node=el(tag,cls,text);parent.append(node);return node}
function link(label,url,parent){const a=el('a',null,label);a.href=reviewURL(url);a.target='_blank';a.rel='noopener noreferrer';parent.append(a);return a}

// Count records, including closed comments, on the exact displayed revision.
function revisionCommentCount(objectId,revisionId){
  return new Set(state.comments.filter(c=>c.target_object_id===objectId&&c.target_revision_id===revisionId).map(c=>c.id)).size;
}
function commentCountLabel(parent,count){
  const label=nodeText('small','revision-comment-count',`评论 ${count}`,parent);
  label.title='包含已关闭评论';return label;
}

function sourceChapters(source){
  if(source?.group!=='story-refinements')return [];
  return source.blocks.flatMap(block=>{
    const title=block.text.split(/\r?\n/,1)[0].trim();
    return /^第[零〇一二三四五六七八九十百千万两\d]+章(?:\s|[：:]|$)/u.test(title)?[{id:block.id,title}]:[];
  });
}

function renderSources(preserveScroll=true){
  const nav=$('#source-list'),scrollTop=preserveScroll?nav.scrollTop:0;nav.replaceChildren();
  const sources=state.sources;
  const addSource=(source,parent)=>{
    const button=el('button','source-button'+(source.id===state.current?.id?' active':''));button.type='button';
    button.dataset.sourceId=source.id;button.setAttribute('aria-current',source.id===state.current?.id?'true':'false');
    const title=businessTitle(source,source.group==='story-refinements'?source.title.replace(/^(故事精修([一二三四五六七八九十百零\d]+)[：:].*?)\s*第\2版$/,'$1'):source.title);
    const chapters=sourceChapters(source),open=state.expandedSources.has(source.id);
    if(chapters.length){
      button.classList.add('source-version-toggle');button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-controls',`source-chapters-${source.id}`);
      nodeText('span','source-version-arrow',open?'▾':'▸',button).setAttribute('aria-hidden','true');
    }
    const labels=el('span','source-labels');nodeText('strong',null,title,labels);commentCountLabel(labels,revisionCommentCount(source.id,source.target_revision_id));button.append(labels);
    button.addEventListener('click',()=>{
      if(chapters.length&&source.id===state.current?.id){
        if(open)state.expandedSources.delete(source.id);else state.expandedSources.add(source.id);
        renderSources();scheduleSourceChapter();
      }else chooseSource(source.id);
      $(`#source-list .source-button[data-source-id="${escapeSelector(source.id)}"]`)?.focus({preventScroll:true});
    });parent.append(button);
    if(chapters.length){
      const list=el('nav','source-chapters');list.id=`source-chapters-${source.id}`;list.setAttribute('aria-label',`${title}章节`);list.hidden=!open;
      for(const chapter of chapters){
        const item=el('button','source-chapter-button',chapter.title);item.type='button';item.dataset.sourceId=source.id;item.dataset.blockId=chapter.id;item.setAttribute('aria-controls','source-view');
        const current=source.id===state.current?.id&&chapter.id===(state.sourceChapter||chapters[0].id);
        item.classList.toggle('active',current);if(current)item.setAttribute('aria-current','location');
        item.onclick=()=>jumpSourceChapter(source.id,chapter.id);list.append(item);
      }parent.append(list);
    }
  };
  for(const source of sources.filter(item=>!item.group))addSource(source,nav);
  for(const [id,label] of [['folk-tales','民间小故事'],['expansion-directions','扩写方向'],['story-refinements','故事精修']]){
    const items=sources.filter(source=>source.group===id);
    if(!items.length)continue;
    const group=el('section','source-group'),header=el('button','source-group-toggle');header.type='button';
    const open=state.expandedGroups.has(id);
    header.setAttribute('aria-expanded',String(open));header.dataset.groupId=id;
    const labels=el('span','source-labels');nodeText('span',null,`${open?'▾':'▸'} ${label}`,labels);const totals=el('span','source-group-totals');nodeText('small',null,`资料 ${items.length} 项`,totals);commentCountLabel(totals,items.reduce((sum,item)=>sum+revisionCommentCount(item.id,item.target_revision_id),0));labels.append(totals);header.append(labels);
    header.onclick=()=>{if(state.expandedGroups.has(id))state.expandedGroups.delete(id);else state.expandedGroups.add(id);renderSources()};
    group.append(header);
    if(open){const children=el('div','source-group-items');for(const item of items)addSource(item,children);group.append(children)}
    nav.append(group);
  }
  for(const source of sources.filter(item=>item.group&&!['folk-tales','expansion-directions','story-refinements'].includes(item.group)))addSource(source,nav);
  if(!sources.length)nodeText('p','source-no-results','暂无资料。',nav);
  nav.scrollTop=scrollTop;
}

let sourceChapterFrame=0,sourceChapterObserver=null;
function scheduleSourceChapter(){
  if(sourceChapterFrame)return;
  sourceChapterFrame=requestAnimationFrame(()=>{sourceChapterFrame=0;syncSourceChapter()});
}
function syncSourceChapter(){
  if(state.workspace!=='story.sources')return;
  const chapters=sourceChapters(state.current),reader=$('#source-view'),nav=$('#source-list');
  const blocks=chapters.map(chapter=>$(`#block-${escapeSelector(chapter.id)}`)).filter(Boolean);
  if(!blocks.length)return;
  const readingTop=Math.max(0,$('.workspace-topbar').getBoundingClientRect().bottom,reader.getBoundingClientRect().top)+12;
  let current=blocks[0];
  for(const block of blocks){if(block.getBoundingClientRect().top<=readingTop+1)current=block;else break}
  const internal=getComputedStyle(reader).overflowY==='auto',page=document.scrollingElement;
  if(internal?reader.scrollTop>0&&reader.scrollTop+reader.clientHeight>=reader.scrollHeight-2:page.scrollTop>0&&page.scrollTop+window.innerHeight>=page.scrollHeight-2)current=blocks.at(-1);
  state.sourceChapter=current.dataset.blockId;
  for(const button of nav.querySelectorAll('.source-chapter-button')){
    const active=button.dataset.sourceId===state.current.id&&button.dataset.blockId===state.sourceChapter;
    const changed=active&&!button.classList.contains('active');
    button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','location');else button.removeAttribute('aria-current');
    if(changed&&button.getClientRects().length){
      const rect=button.getBoundingClientRect(),bounds=nav.getBoundingClientRect();
      if(rect.top<bounds.top)nav.scrollTop+=rect.top-bounds.top;
      else if(rect.bottom>bounds.bottom)nav.scrollTop+=rect.bottom-bounds.bottom;
    }
  }
}
function watchSourceChapters(){
  sourceChapterObserver?.disconnect();
  sourceChapterObserver=new ResizeObserver(scheduleSourceChapter);
  for(const node of [$('#source-view'),$('#source-text'),$('.workspace-topbar')])if(node)sourceChapterObserver.observe(node);
  scheduleSourceChapter();
}
let sourceChapterRouteKey=null,sourceRouteFrame=0;
function sourceReadingRoute(url){
  const source=state.sources.find(item=>item.id===url.searchParams.get('source'));
  const chapter=sourceChapters(source).find(item=>item.id===url.searchParams.get('source_chapter'));
  return {source,chapter,key:JSON.stringify([source?.id||null,chapter?.id||null])};
}
function cancelSourceChapterRestore(){if(sourceRouteFrame)cancelAnimationFrame(sourceRouteFrame);sourceRouteFrame=0}
function scrollSourceChapter(blockId=null){
  const reader=$('#source-view'),target=blockId?$(`#block-${escapeSelector(blockId)}`):reader;if(!target)return;
  if(getComputedStyle(reader).overflowY==='auto')reader.scrollTo({top:blockId?reader.scrollTop+target.getBoundingClientRect().top-reader.getBoundingClientRect().top-12:0,behavior:'instant'});
  else window.scrollBy({top:target.getBoundingClientRect().top-Math.max(0,$('.workspace-topbar').getBoundingClientRect().bottom)-12,behavior:'instant'});
  scheduleSourceChapter();
}
function restoreSourceChapter(url,{initial=false,force=false}={}){
  const route=sourceReadingRoute(url),changed=route.key!==sourceChapterRouteKey;sourceChapterRouteKey=route.key;
  cancelSourceChapterRestore();
  if(state.workspace!=='story.sources'||(!changed&&!force)||(initial&&!route.chapter))return;
  const source=state.current,text=$('#source-text'),anchor=state.anchor,selected=state.selected,href=location.href;
  sourceRouteFrame=requestAnimationFrame(()=>{
    sourceRouteFrame=0;
    // A later comment location or editor action takes precedence over route scrolling.
    if(state.workspace!=='story.sources'||state.current!==source||$('#source-text')!==text||state.anchor!==anchor||state.selected!==selected||location.href!==href)return;
    scrollSourceChapter(route.source?.id===source?.id?route.chapter?.id:null);
  });
}
function jumpSourceChapter(sourceId,blockId){
  const source=state.sources.find(item=>item.id===sourceId);
  if(state.workspace!=='story.sources'||!sourceChapters(source).some(chapter=>chapter.id===blockId))return;
  cancelSourceChapterRestore();
  if(state.current?.id!==sourceId)chooseSource(sourceId,false,false);
  const url=new URL(location.href);url.searchParams.set('workspace','story.sources');url.searchParams.set('source',sourceId);url.searchParams.set('source_chapter',blockId);url.hash='';
  if(url.href!==location.href)history.pushState(null,'',url);
  sourceChapterRouteKey=sourceReadingRoute(url).key;
  scrollSourceChapter(blockId);
  $(`#source-list .source-chapter-button[data-source-id="${escapeSelector(sourceId)}"][data-block-id="${escapeSelector(blockId)}"]`)?.focus({preventScroll:true});
}

function renderWorkspaceNav(){
  const nav=$('#workspace-nav');nav.replaceChildren();
  const sections=[
    ['production.approach','制作思路','思路','故事创作与生产制作方法'],
    ['story.sources','故事创作','故事','故事采编、故事结构与分集剧本'],
    ['settings.workspace','生产制作','制作','视听制作、实体与素材'],
    ['project.configuration','系统管理','管理','故事项目与系统配置']
  ];
  for(const [id,title,index,description] of sections){
    const workspace=state.framework.workspaces.find(w=>w.id===id),active=workspace?.implemented;
    const selected=state.workspace===id||(id==='settings.workspace'&&state.workspace==='materials.workspace')||(id==='story.sources'&&['story.outline','story.script'].includes(state.workspace));
    const button=el('button','workspace-button'+(selected?' active':'')+(active?'':' planned'));button.type='button';
    button.setAttribute('aria-current',selected?'page':'false');
    nodeText('span','nav-index',index,button);const labels=el('span','nav-labels');nodeText('b',null,title,labels);nodeText('small',null,active?description:`${description} · 待开放`,labels);button.append(labels);
    button.onclick=()=>typeof navigateWorkspace==='function'?navigateWorkspace(id):switchWorkspace(id);nav.append(button);
  }
}

function storyDraftMetaKey(){
  if(!['story.sources','story.outline'].includes(state.workspace))return null;
  const ref=isStructure()?state.structureRevision:state.current?.target_revision_id;if(!ref)return null;
  return 'review-story-editor:'+JSON.stringify([state.workspace,ref])+(commentPageId?':page:'+commentPageId:'');
}
function rememberLiveCommentEdit(){if(!state.editing)return;const live=liveCommentDraft(),basis=editDraftBasis();if(live)localStorage.setItem(draftKey(),live.value);if(basis)rememberEditBasis(basis)}
function rememberStoryDraft(){const key=storyDraftMetaKey();if(!key||!state.anchor)return;markActiveCommentDraft();try{rememberLiveCommentEdit();localStorage.setItem(key,JSON.stringify({anchor:state.anchor,editing:state.editing,selected:state.selected,target:commentTarget()}))}catch{rememberCommentDraftFailure();toast('本机草稿定位信息保存失败，当前输入仍保留。')}}
function restoreStoryDraft(){const key=storyDraftMetaKey();if(!key||state.anchor)return;try{const saved=fallbackCommentDraftMeta()||JSON.parse(localStorage.getItem(key)||'null');if(saved?.anchor&&JSON.stringify(saved.target)===JSON.stringify(commentTarget())&&(!saved.editing||state.comments.some(c=>c.id===saved.editing&&c.target_revision_id===saved.target.target_revision_id))){state.anchor=saved.anchor;state.editing=saved.editing||null;state.selected=saved.selected||null}}catch{}}
function forgetStoryDraft(){const key=storyDraftMetaKey();if(key)localStorage.removeItem(key)}
function switchWorkspace(id,updateUrl=true){
  const read=++workspaceReadEpoch;
  if(typeof invalidateProductionReads==='function')invalidateProductionReads();
  if(['story.sources','story.outline','story.script'].includes(id)&&!storyDataReady){
    return loadStoryData().then(()=>{if(read!==workspaceReadEpoch)return;initializeStoryReaders(new URL(location.href));const result=switchWorkspace(id,updateUrl);restoreSourceChapter(new URL(location.href),{initial:true});return result}).catch(error=>{if(read===workspaceReadEpoch)toast(error.message)});
  }
  rememberStoryDraft();if(isScript())rememberScriptDraft();
  if(typeof rememberProductionDraft==='function')rememberProductionDraft();
  if(typeof pauseReviewMedia==='function')pauseReviewMedia();
  hideSelectionAction();
  if(id==='current')id='production.approach';
  if(typeof normalizeProductionWorkspace==='function')id=normalizeProductionWorkspace(id);
  if(!state.framework.workspaces.some(workspace=>workspace.id===id))id='production.approach';
  if(state.workspace!==id)cancelSourceChapterRestore();
  const previous=state.workspace,storyChild=['story.sources','story.outline','story.script'].includes(id);
  if(state.workspace!==id){state.reviewCommentScope=null;getSelection()?.removeAllRanges();state.anchor=null;state.editing=null;state.selected=null;state.suggestion=null;state.preview=null}
  if(typeof rememberWorkspaceRoute==='function')rememberWorkspaceRoute();
  state.workspace=id;
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('workspace',id);if(id==='story.outline'){const revision=resolveStructureRevision(state.structureRevision);if(revision)url.searchParams.set('structure_revision',revision);else url.searchParams.delete('structure_revision')}url.hash='';if(url.href!==location.href)history.pushState(null,'',url)}
  if(typeof renderWorkspaceTabs==='function')renderWorkspaceTabs();
  renderWorkspaceNav();const source=id==='story.sources';
  $('#story-creation-shell').hidden=!storyChild;
  $('#story-workspace').hidden=!source;$('#screenplay-workspace').hidden=id!=='story.script';$('#structure-workspace').hidden=id!=='story.outline';$('#configuration-view').hidden=id!=='project.configuration';$('#approach-view').hidden=id!=='production.approach';
  $('#placeholder-view').hidden=storyChild||isProduction()||id==='project.configuration'||id==='production.approach';
  $('#production-view').hidden=!isProduction();
  $('#comments-toggle').hidden=!storyChild&&!isProduction();closePanel();
  const titles={'story.sources':['故事创作','故'],'story.outline':['故事创作','故'],'story.script':['故事创作','故'],'settings.workspace':['生产制作','制'],'materials.workspace':['生产制作','制'],'project.configuration':['系统管理','管'],'production.approach':['制作思路','思']};
  $('#view-title').textContent=titles[id]?.[0]||'故事创作';$('#view-symbol').textContent=titles[id]?.[1]||'故';
  if(id==='project.configuration')renderConfigurations({preserve:true});if(id==='production.approach')Promise.resolve(renderApproach()).then(()=>{if(state.workspace===id&&typeof restoreWorkspacePosition==='function')restoreWorkspacePosition()});if(id==='story.outline'){restoreStoryDraft();renderStructureReader();renderComments()}
  if(source){restoreStoryDraft();renderDocument();renderComments();scheduleSourceChapter()}
  if(id==='story.script'){restoreScriptDraft();renderScriptIndex();renderScriptReader();renderComments()}
  if(isProduction()){
    const loading=loadProductionWorkspace(),loadEpoch=productionLoadEpoch;
    loading.then(()=>{if(read===workspaceReadEpoch&&loadEpoch===productionLoadEpoch&&state.workspace===id&&typeof restoreWorkspacePosition==='function')restoreWorkspacePosition()}).catch(e=>{if(read===workspaceReadEpoch&&loadEpoch===productionLoadEpoch)toast(e.message)});
  }else if(!storyChild&&id!=='project.configuration'&&id!=='production.approach')renderPlaceholder(id);

  if(!isProduction()&&id!=='production.approach'&&typeof restoreWorkspacePosition==='function')restoreWorkspacePosition();
  if(updateUrl&&!(storyChild&&['story.sources','story.outline','story.script'].includes(previous)))window.scrollTo(0,0);
}

function renderPlaceholder(id){
  const root=$('#placeholder-view');root.replaceChildren();const workspace=state.framework.workspaces.find(item=>item.id===id);
  const heading=el('header','placeholder-heading');nodeText('p',null,'STORY REVIEW DESK / WORKSPACE',heading);
  nodeText('h1',null,workspace.label,heading);root.append(heading);
  const card=el('section','placeholder-card');nodeText('small',null,'整体创作流程 · 已规划',card);
  nodeText('h2',null,'这个工作区将在后续阶段开放',card);
  nodeText('p',null,'当前故事实例处于资料采编阶段。此入口保留在完整系统框架中；尚未实现的创作、设定或制作功能不会假装可用，也不会产生隐含业务数据。',card);
  const button=nodeText('button','primary','返回故事采编',card);button.type='button';button.onclick=()=>switchWorkspace('story.sources');root.append(card);
}

function applyFavicon(){const previous=$("#site-favicon"),icon=state.configurations.favicon;if(previous&&icon){const link=document.createElement("link");link.id="site-favicon";link.rel="icon";link.type=icon.mime;link.href=reviewURL(icon.url);previous.replaceWith(link)}}

function configurationDraft(scope,value){
  if(typeof sessionStorage==='undefined')return null;
  const key='review-configuration-draft:'+scope;
  try{
    if(value===undefined)return JSON.parse(sessionStorage.getItem(key)||'null');
    if(value===null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,JSON.stringify(value));
  }catch{if(value!==undefined)toast('当前配置输入仍保留在页面中；本机会话保存失败，刷新后可能无法恢复。')}
  return null;
}
function showConfigurationSection(){
  for(const section of $('#configuration-view').querySelectorAll('[data-config-section]'))section.hidden=section.dataset.configSection!==state.configSection;
}
function renderConfigurations({preserve=false}={}){
  const root=$('#configuration-view');
  if(typeof configurationSectionFromRoute==='function')state.configSection=configurationSectionFromRoute();
  if(state.configSection==='METHODS'){root.configurationMounted=false;renderMethods(root);return}
  if(state.configSection==='CODES'){root.replaceChildren();root.configurationMounted=false;renderBusinessCodeCatalog(root);return}
  if(state.configurations.favicon_assets===undefined){
    root.replaceChildren();root.configurationMounted=false;nodeText('p',null,'正在读取配置…',root);
    state.configurationRead ||= api('/api/configurations').then(data=>{state.configurations=data}).finally(()=>{state.configurationRead=null});
    state.configurationRead.then(()=>{if(state.workspace==='project.configuration')renderConfigurations()}).catch(error=>{if(state.workspace==='project.configuration'){root.replaceChildren();nodeText('p','production-issue',error.message,root)}});return;
  }
  if(preserve&&root.configurationMounted){showConfigurationSection();return}
  root.replaceChildren();root.configurationMounted=true;
  const layout=el('div','configuration-layout configuration-layout-unified'),article=el('article','config-page');
  layout.append(article);root.append(layout);
  const data=state.configurations;
  const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  const same=(left,right)=>JSON.stringify(ordered(left))===JSON.stringify(ordered(right));
  const rememberRecord=(scope,record)=>{if(record.version>=state.configurations.values[scope].version)state.configurations.values[scope]=record};
  const rememberSnapshot=snapshot=>{
    const current=state.configurations,values={...current.values};
    for(const scope of ['SYSTEM','PROJECT'])if(snapshot.values[scope].version>=values[scope].version)values[scope]=snapshot.values[scope];
    const favicon=snapshot.values.SYSTEM.version===values.SYSTEM.version?snapshot:current;
    state.configurations={...current,...snapshot,values,favicon:favicon.favicon,favicon_assets:favicon.favicon_assets,favicon_error:favicon.favicon_error};
  };
  for(const scope of ['SYSTEM','PROJECT']){const draft=configurationDraft(scope);let record=draft?.base?.scope===scope&&Number.isInteger(draft.base.version)&&draft.base.body?draft.base:data.values[scope];const initialBody={...record.body,...(draft?.updates||{})};const section=el('section','config-section');
    section.dataset.configSection=scope;
    const versionNote=nodeText('p','config-version',`配置版本 ${record.version} · Schema ${record.schema_version}`,section);
    const fields=data.catalog.scopes[scope],form=el('form');form.dataset.scope=scope;
    form.noValidate=true;
    const feature=(title,description)=>{const group=el('section','config-feature');nodeText('h2',null,title,group);nodeText('p','config-explanation',description,group);const content=el('div','config-feature-fields');group.append(content);form.append(group);return content};
    const iconFields=scope==='SYSTEM'?feature('站点图标','选择已有图标或上传新文件，预览确认后保存。'):null;
    const polishFields=scope==='SYSTEM'?feature('评论润色','选择模型及其支持的推理强度；润色建议仍需手动采用和保存。'):null;
    const effortOptions=data.catalog.model_efforts;let effortGroup,uploading=0,refreshIcon=()=>{};
    const validationFields=[];
    const validateField=(input,spec,error)=>{let message='';const value=String(input.value);
      if(spec.type==='env_name'&&!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))message='以字母或下划线开头，只含字母、数字和下划线，最多128个字符。';
      if(spec.type==='integer'&&(!value.trim()||!Number.isInteger(Number(value))||Number(value)<spec.min||Number(value)>spec.max))message=`请填写 ${spec.min}—${spec.max} 之间的整数。`;
      error.textContent=message;error.hidden=!message;input.setAttribute('aria-invalid',String(!!message));return message;
    };
    const radioChoices=(group,key,choices,selected)=>{group.replaceChildren();nodeText('legend',null,fields[key].label,group);
      const row=el('div','config-choice-row');for(const choice of choices){const label=el('label','config-choice');const input=el('input');input.type='radio';input.name=key;input.value=choice;input.checked=choice===selected;label.append(input,el('span',null,choice==='off'?'不适用':choice));row.append(label)}group.append(row)};
    for(const [key,spec] of Object.entries(fields)){
      if(spec.type==='model'||spec.type==='reasoning_effort'){const group=el('fieldset','config-choice-field');
        radioChoices(group,key,spec.type==='model'?Object.keys(effortOptions):effortOptions[initialBody.ai_polish_model]||[],initialBody[key]);
        if(spec.type==='model')group.addEventListener('change',()=>{const model=form.elements.ai_polish_model.value,allowed=effortOptions[model];const current=form.elements.ai_polish_effort.value;radioChoices(effortGroup,'ai_polish_effort',allowed,allowed.includes(current)?current:allowed.includes('medium')?'medium':allowed[0])});
        else effortGroup=group;(polishFields||form).append(group);continue}
      const label=el(spec.type==='favicon'?'div':'label','config-field');
      if(spec.type!=='favicon')nodeText('span',null,spec.label,label);
      let input;if(spec.type==='favicon'){
        input=el('select');const empty=el('option',null,'默认审阅台图标');empty.value='';input.append(empty);
        for(const name of data.favicon_assets||[]){const option=el('option',null,name);option.value=name;input.append(option)}
        if(initialBody[key]&&!Array.from(input.options).some(option=>option.value===initialBody[key])){const option=el('option',null,`${initialBody[key]}（不可用）`);option.value=initialBody[key];input.append(option)}
        input.value=initialBody[key];
        const previews=el('div','favicon-previews');
        const currentBox=el('div','favicon-preview'),pendingBox=el('div','favicon-preview');
        const currentPreview=el('img'),preview=el('img');for(const img of [currentPreview,preview]){img.width=40;img.height=40}
        currentPreview.alt='当前已保存图标';preview.alt='待保存图标预览';
        currentBox.append(currentPreview);nodeText('span',null,'当前图标',currentBox);pendingBox.append(preview);nodeText('span',null,'待保存预览',pendingBox);previews.append(currentBox,pendingBox);label.append(previews);
        const status=nodeText('p','favicon-status','',label);status.setAttribute('role','status');
        let unavailableFile=data.favicon_error?record.body[key]:'',errorStatus,uploadNote='';
        const show=()=>{
          preview.src=reviewURL(input.value&&input.value!==unavailableFile?'/assets/'+encodeURIComponent(input.value):'/default-favicon.svg');
          const changed=input.value!==record.body[key];status.textContent=uploadNote|| (changed?'选择已变化，尚未保存。':'预览与已保存选择一致。');
        };
        refreshIcon=()=>{currentPreview.src=reviewURL(state.configurations.favicon?.url||'/default-favicon.svg');if(input.value===record.body[key])uploadNote='';show()};refreshIcon();
        const selectLabel=el('label','favicon-select-label');nodeText('span',null,'选择已有图标',selectLabel);selectLabel.append(input);label.append(selectLabel);
        input.onchange=()=>{uploadNote='';show()};
        const actions=el('div','favicon-actions'),uploadLabel=el('label','favicon-upload');nodeText('span',null,'上传新图标',uploadLabel);
        const file=el('input');file.type='file';file.accept='.svg,.png,.ico';file.setAttribute('aria-label','上传站点图标');uploadLabel.append(file);actions.append(uploadLabel);
        file.onchange=async()=>{const selected=file.files[0];if(!selected)return;
          if(selected.size>256*1024){uploadNote='上传失败：图标须在 256 KiB 以内；当前选择已保留。';show();toast(uploadNote);file.value='';return}
          uploading++;uploadNote='正在上传，当前已保存图标仍有效。';show();updateSave();
          try{const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(selected)});
            const result=await api('/api/favicon',{method:'POST',body:JSON.stringify({name:selected.name,data:encoded})});
            let option=Array.from(input.options).find(option=>option.value===result.file);if(!option){option=el('option');option.value=result.file;input.append(option)}option.textContent=result.file;
            if(result.file===unavailableFile){unavailableFile='';if(errorStatus)errorStatus.remove()}input.value=result.file;
            uploadNote='图标已上传并选入预览，尚未应用；请保存配置。';show();toast(uploadNote)
          }catch(error){uploadNote=`上传失败：${error.message}；当前选择和其他输入已保留。`;show();toast(uploadNote)}finally{uploading--;updateSave();file.value=''}};
        const clear=nodeText('button','secondary','恢复默认图标',actions);clear.type='button';clear.onclick=()=>{input.value='';uploadNote='已选择默认图标，尚未保存。';show();updateSave()};label.append(actions);
        if(data.favicon_error){errorStatus=nodeText('small','config-field-error','当前图标不可用，暂用默认图标；请选择其他图标或恢复默认后保存。',label);errorStatus.setAttribute('role','status')}
        nodeText('small',null,'支持 SVG、PNG 或 PNG 编码的 ICO，至多 256 KiB。上传只登记文件，保存配置后才生效。',label);
      }
      else if(spec.type==='long_text'){input=el('textarea');input.rows=4;input.value=initialBody[key]}
      else if(spec.type==='stage'){input=el('select');for(const stage of state.framework.stages){const option=el('option',null,stage.label);option.value=stage.id;input.append(option)}input.value=initialBody[key]}
      else{input=el('input');input.type=spec.type==='integer'?'number':'text';input.value=initialBody[key]}
      input.name=key;input.setAttribute('aria-label',spec.label);
      if(spec.type!=='favicon')label.append(input);
      if(spec.type==='env_name'){input.autocomplete='off';nodeText('small',null,'只保存环境变量名，不保存密钥；变量需由服务容器提供。',label)}
      if(spec.type==='integer'){input.min=spec.min;input.max=spec.max;input.step=1;nodeText('small',null,`填写 ${spec.min}—${spec.max} 之间的整数，限制完整参考的字符总数，包含原文、意见、背景、来源信息与格式；完整圈选无法容纳时会提示调整。`,label)}
      if(['env_name','integer'].includes(spec.type)){
        const error=nodeText('small','config-field-error','',label);error.id=`config-${scope}-${key}-error`;error.hidden=true;input.setAttribute('aria-describedby',error.id);
        const check=()=>validateField(input,spec,error);input.onblur=check;input.oninput=()=>{if(!error.hidden)check()};validationFields.push({input,check});
      }
      (spec.type==='favicon'?iconFields:polishFields||form).append(label)}
    const save=nodeText('button','primary','保存配置',form);save.type='submit';
    const notice=nodeText('p','config-save-status','',form);notice.hidden=true;notice.setAttribute('role','status');
    let saving=false,pendingRequest=draft?.pendingRequest||null,confirmedBody=null;
    const ownsForm=()=>form.isConnected&&state.workspace==='project.configuration';
    const rawValues=()=>Object.fromEntries(Object.keys(fields).map(key=>[key,String(form.elements[key].value)]));
    const rawBody=body=>Object.fromEntries(Object.keys(fields).map(key=>[key,String(body[key])]));
    const inputValues=()=>Object.fromEntries(Object.entries(fields).map(([key,spec])=>[key,spec.type==='integer'?Number(form.elements[key].value):form.elements[key].value]));
    const savedValues=()=>confirmedBody&&Object.fromEntries(Object.keys(fields).map(key=>[key,confirmedBody[key]]));
    const persistDraft=()=>{const updates=rawValues();configurationDraft(scope,!pendingRequest&&same(updates,rawBody(record.body))?null:{base:record,updates,pendingRequest})};
    const updateSave=()=>{save.disabled=saving||uploading>0||!!confirmedBody&&same(rawValues(),rawBody(confirmedBody));if(!saving&&confirmedBody&&!same(rawValues(),rawBody(confirmedBody))&&notice.textContent.includes('已保存'))notice.textContent='已保存配置仍有效；当前新输入尚未保存。';persistDraft()};
    form.addEventListener('input',updateSave);form.addEventListener('change',updateSave);
    const message=text=>{if(ownsForm()){notice.hidden=false;notice.textContent=text;toast(text)}};
    const readAttempt=async request=>{
      const snapshot=await api('/api/configurations'),current=snapshot.values?.[scope];
      if(!current)throw Error('配置保存结果暂无法核实');
      if(current.version===request.expected_version+1&&same(current.body,request.body))return {record:current,snapshot};
      if(current.version===request.expected_version&&same(current.body,request.before))return {record:null,snapshot};
      throw Error('配置版本已有变化；当前输入已保留，请核对后再保存');
    };
    form.onsubmit=async event=>{
      event.preventDefault();if(saving||save.disabled||!ownsForm())return;
      const invalid=validationFields.filter(field=>field.check());if(invalid.length){invalid[0].input.focus?.();return message('请修正标出的配置项；当前图标选择和其他输入已保留。')}
      const updates=inputValues();saving=true;notice.hidden=true;updateSave();let committed=null,snapshot=null;
      try{
        if(pendingRequest){
          let result;try{result=await readAttempt(pendingRequest)}catch(error){throw Error(`${error.message}；上次保存结果待确认，当前输入已保留`)}
          if(!ownsForm())return;
          committed=result.record;snapshot=result.snapshot;
        }
        if(!committed){
          if(!pendingRequest||!same(updates,pendingRequest.updates))pendingRequest=JSON.parse(JSON.stringify({expected_version:record.version,updates,before:record.body,body:{...record.body,...updates}}));
          snapshot=null;persistDraft();
          try{committed=await api(`/api/configurations/${scope}`,{method:'PATCH',body:JSON.stringify({expected_version:pendingRequest.expected_version,updates:pendingRequest.updates})})}
          catch(error){
            if(!ownsForm())return;
            if(error.status===400||error.status===409){
              pendingRequest=null;
              throw Error(error.status===409?'本次保存未完成：配置版本已有变化。当前输入已保留，请核对最新配置后再保存。':`本次配置未保存：${error.message}。当前输入已保留，请修改后再保存。`);
            }
            let result;try{result=await readAttempt(pendingRequest)}catch(readError){throw Error(`${readError.message}；保存结果待确认，当前输入已保留`)}
            if(!result.record)throw Error(`${error.message}；尚未确认保存，当前输入已保留`);
            committed=result.record;snapshot=result.snapshot;
          }
        }
        rememberRecord(scope,committed);pendingRequest=null;
        const name=scope==='PROJECT'?'故事项目配置':'系统与 AI 配置';
        if(form.isConnected){record=committed;confirmedBody=committed.body;versionNote.textContent=`配置版本 ${record.version} · Schema ${record.schema_version}`}
        toast(`${name}已保存${ownsForm()&&!same(inputValues(),savedValues())?'；当前新输入尚未保存':''}`);
        try{snapshot||=await api('/api/configurations');rememberSnapshot(snapshot);applyFavicon();refreshIcon();if(ownsForm()){notice.hidden=false;notice.textContent=`${name}已保存并生效${!same(inputValues(),savedValues())?'；当前新输入尚未保存':''}。`}}
        catch(error){message(`${name}已保存；最新配置与图标暂未刷新：${error.message}。当前输入已保留。`)}
      }catch(error){message(error.message)}
      finally{saving=false;if(form.isConnected)updateSave()}
    };
    section.append(form);article.append(section)}
  showConfigurationSection()
}

function blockMarks(source,block,index){
  const out=[];
  for(const comment of state.comments.filter(c=>source.target_revision_id?c.target_object_id===source.id&&c.target_revision_id===source.target_revision_id:c.source_id===source.id)){
    const a=comment.anchor,first=source.blocks.findIndex(b=>b.id===a.block_id),last=source.blocks.findIndex(b=>b.id===a.end_block_id);
    if(first<0||last<first||index<first||index>last)continue;
    const start=index===first?a.start:0,end=index===last?a.end:chars(block.text).length;
    if(start<end)out.push({start,end,comment});
  }
  const draft=newDraftAnchor();
  if(draft&&draft.block_id){
    const first=source.blocks.findIndex(b=>b.id===draft.block_id),last=source.blocks.findIndex(b=>b.id===draft.end_block_id);
    if(first>=0&&last>=first&&index>=first&&index<=last){
      const start=index===first?draft.start:0,end=index===last?draft.end:chars(block.text).length;
      if(start<end)out.push({start,end,draft:true});
    }
  }
  return out;
}

function renderBlock(source,block,index,explicitMarks=null){
  const p=el('p');p.dataset.blockId=block.id;p.id=`block-${block.id}`;
  const marks=explicitMarks||blockMarks(source,block,index),length=chars(block.text).length;
  const cuts=new Set([0,length]);for(const m of marks){cuts.add(m.start);cuts.add(m.end)}
  const ordered=[...cuts].sort((a,b)=>a-b),letters=chars(block.text);
  for(let i=0;i<ordered.length-1;i++){
    const start=ordered[i],end=ordered[i+1],active=marks.filter(m=>m.start<=start&&m.end>=end);
    if(!active.length){p.append(document.createTextNode(letters.slice(start,end).join('')));continue}
    const comments=active.filter(m=>m.comment),draft=active.some(m=>m.draft);
    const mark=el('span','comment-mark'+(comments.length&&comments.every(m=>m.comment.status==='CLOSED')?' closed':'')+(comments.some(m=>m.comment.id===state.selected)?' selected':'')+(draft?' draft-mark':''),letters.slice(start,end).join(''));
    mark.dataset.commentIds=comments.map(m=>m.comment.id).join(' ');
    mark.title=draft?'正在添加的评论范围':comments.map(m=>m.comment.body).join(' / ');
    if(comments.length)mark.addEventListener('click',()=>{if(!window.getSelection()?.isCollapsed)return;selectComment(comments[0].comment.id)});
    p.append(mark);
  }
  return p;
}

function renderDocument(){
  hideSelectionAction();
  const source=state.current,root=$('#source-view');root.replaceChildren();if(!source){
    $('#reader-kind').textContent='资料';$('#reader-head-title').textContent='尚未登记资料';$('#reader-head-detail').textContent='';
    nodeText('p','empty','等待 Codex 准备资料后，可在这里阅读和评论。',root);return;
  }
  $('#reader-kind').textContent=source.version_type;
  $('#reader-head-title').textContent=businessTitle(source);
  $('#reader-head-detail').textContent=`${source.origin} · 采集于 ${source.collected_at}`;
  const doc=el('article','document');nodeText('div','overline','SOURCE DOCUMENT / 资料原文',doc);
  nodeText('h2',null,businessTitle(source),doc);nodeText('span','type-pill',source.version_type,doc);
  const meta=el('div','source-meta');
  for(const [label,value] of [['出处',source.origin],['采集日期',source.collected_at],['版本说明',source.edition||'—']]){const item=el('div');nodeText('b',null,label,item);nodeText('span',null,value,item);meta.append(item)}
  const item=el('div');nodeText('b',null,'来源页面',item);link('打开来源页面 ↗',source.source_url,item);meta.append(item);doc.append(meta);
  if(source.media){const media=el('section','source-media');nodeText('strong',null,source.media.file?'演出资料 · 本实例媒体':'演出资料 · 第三方平台',media);
    if(source.media.file){const url=`/assets/${encodeURIComponent(source.media.file)}`;
      if(source.media.kind==='audio')reviewMediaPlayer(media,{id:source.media.file,file:source.media.file,mime:'audio/mpeg'}, {id:source.target_revision_id,object_id:source.id}, {},false,{src:url});
      else{const player=el('video');player.controls=true;player.preload='metadata';player.src=reviewURL(url);player.playsInline=true;media.append(player);const download=el('a',null,'下载视频 ↓');download.href=reviewURL(url);download.download=source.media.file;media.append(download)}
    }
    if(source.media.url)link(source.media.label||'原始发布页面 ↗',source.media.url,media);
    nodeText('p',null,source.media.note||'请核对演出元数据和整理文本。',media);doc.append(media)}
  if(source.references?.length){const refs=el('section','source-references');nodeText('strong',null,'旁证与补充链接',refs);for(const reference of source.references){const row=el('p');link(reference.label,reference.url,row);refs.append(row)}doc.append(refs)}
  nodeText('p','intro',source.notes,doc);nodeText('h3','section-title',source.text_heading||'完整文本',doc);
  const text=el('section','source-text');text.id='source-text';text.setAttribute('aria-label','资料正文');
  source.blocks.forEach((block,index)=>text.append(renderBlock(source,block,index)));reviewSurface(text);doc.append(text);
  if(source.assets.length){nodeText('h3','section-title','图片与出处',doc);const gallery=el('section','image-grid');
    for(const asset of source.assets){const figure=renderStructureVisual({id:asset.file,file:asset.file,title:asset.title,kind:'image',alt:asset.alt||asset.title,description:asset.note||''});
      if(asset.source_url)link('图片来源／制作依据 ↗',asset.source_url,figure.querySelector('figcaption'));gallery.append(figure)}doc.append(gallery)}
  root.append(doc);
  paintStructureRegions();
  watchSourceChapters();
}

function chooseSource(id,keepScroll=false,updateUrl=true,expandGroup=true){
  const active=state.workspace==='story.sources';
  if(active){rememberStoryDraft();cancelSourceChapterRestore();state.reviewCommentScope=null;state.anchor=null;state.editing=null;state.selected=null;state.pending=null;state.sourceChapter=null}
  state.current=state.sources.find(s=>s.id===id)||state.sources[0];
  if(expandGroup&&state.current?.group)state.expandedGroups.add(state.current.group);
  if(sourceChapters(state.current).length)state.expandedSources.add(state.current.id);
  if(active)$('#selection-action').hidden=true;
  if(updateUrl&&state.current){const url=new URL(location.href);url.searchParams.set('source',state.current.id);url.searchParams.delete('source_chapter');history.replaceState(history.state,'',url);sourceChapterRouteKey=sourceReadingRoute(url).key}
  if(active)restoreStoryDraft();renderSources();renderDocument();if(active)renderComments();if(!keepScroll)$('#source-view').scrollTop=0;
}

function offsetIn(block,node,offset){const range=document.createRange();range.selectNodeContents(block);range.setEnd(node,offset);return chars(range.toString()).length}
function textSelectionAnchor(host,blocks,attribute){
  const selection=getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return null;
  const range=selection.getRangeAt(0);
  if(!host||!host.contains(range.startContainer)||!host.contains(range.endContainer))return null;
  // Browser drag endpoints may be element boundaries, including the gaps between blocks.
  // Intersect each block before measuring offsets, so markup and surrogate pairs stay exact.
  const touched=[];
  for(const node of host.querySelectorAll(`[${attribute}]`)){
    if(!range.intersectsNode(node))continue;
    const contents=document.createRange();contents.selectNodeContents(node);
    const part=range.cloneRange();
    if(part.compareBoundaryPoints(Range.START_TO_START,contents)<0)part.setStart(contents.startContainer,contents.startOffset);
    if(part.compareBoundaryPoints(Range.END_TO_END,contents)>0)part.setEnd(contents.endContainer,contents.endOffset);
    if(!part.toString())continue;
    const base=Number(node.dataset.anchorOffset||0);
    touched.push({id:node.getAttribute(attribute),start:base+offsetIn(node,part.startContainer,part.startOffset),end:base+offsetIn(node,part.endContainer,part.endOffset),segmented:node.hasAttribute('data-anchor-offset')});
  }
  if(!touched.length)return null;
  // Rearranged/collapsed review excerpts must never fabricate a cross-gap quote.
  if(touched.some(t=>t.segmented)&&touched.slice(1).some((t,i)=>t.id===touched[i].id&&t.start!==touched[i].end+1))return null;
  const first=blocks.findIndex(b=>b.id===touched[0].id),last=blocks.findIndex(b=>b.id===touched.at(-1).id);
  if(first<0||last<first)return null;
  const start=touched[0].start,end=touched.at(-1).end;
  if(first===last&&end<=start)return null;
  const pieces=blocks.slice(first,last+1).map(b=>chars(b.text));pieces[0]=pieces[0].slice(start);pieces[pieces.length-1]=pieces.length===1?chars(blocks[first].text).slice(start,end):pieces[pieces.length-1].slice(0,end);
  const quote=pieces.map(p=>p.join('')).join('\n');if(!quote.trim())return null;
  return {block_id:blocks[first].id,end_block_id:blocks[last].id,start,end,quote};
}
function selectedAnchor(){
  if(isProduction())return state.productionSelected?textSelectionAnchor(state.unifiedCardRoot?.querySelector('#production-blocks')||$('#production-blocks'),productionTextBlocks(state.productionSelected),'data-block-id'):null;
  if(isStructure())return selectedStructureAnchor();
  if(isScript())return scriptScene()?textSelectionAnchor($('#screenplay-text'),scriptEpisode().payload.blocks,'data-block-id'):null;
  if(state.workspace!=='story.sources'||!state.current)return null;
  return textSelectionAnchor($('#source-text'),state.current.blocks,'data-block-id');
}
let selectionFrame=0,selectionPointer=null;
function hideSelectionAction(){state.pending=null;$('#selection-action').hidden=true}
function selectionBounds(host){
  const bounds={left:8,top:8,right:innerWidth-8,bottom:innerHeight-8};
  for(let node=host;node;node=node.parentElement){
    const style=getComputedStyle(node),rect=node.getBoundingClientRect();
    if(/auto|scroll|hidden|clip/.test(style.overflowX)){bounds.left=Math.max(bounds.left,rect.left+8);bounds.right=Math.min(bounds.right,rect.right-8)}
    if(/auto|scroll|hidden|clip/.test(style.overflowY)){bounds.top=Math.max(bounds.top,rect.top+8);bounds.bottom=Math.min(bounds.bottom,rect.bottom-8)}
  }
  const topbar=$('.workspace-topbar');if(topbar)bounds.top=Math.max(bounds.top,topbar.getBoundingClientRect().bottom+8);
  return bounds;
}
function updateSelectionAction(){
  const anchor=selectionPointer===null&&!state.drawMode?selectedAnchor():null;
  if(!anchor){hideSelectionAction();return}
  const selection=getSelection(),range=selection.getRangeAt(0),host=isProduction()&&state.unifiedCardRoot?state.unifiedCardRoot:$(isProduction()?'#production-reader':isStructure()?'#structure-reader':isScript()?'#screenplay-reader':'#source-view'),bounds=selectionBounds(host);
  const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0&&r.right>bounds.left&&r.left<bounds.right&&r.bottom>bounds.top&&r.top<bounds.bottom);
  if(!rects.length){hideSelectionAction();return}
  // Stay by the visible end of the gesture, even when the beginning has scrolled away.
  const backwards=selection.focusNode===range.startContainer&&selection.focusOffset===range.startOffset;
  const rect=backwards?rects[0]:rects.at(-1),button=$('#selection-action');
  button.hidden=false;
  const width=button.offsetWidth,height=button.offsetHeight;
  if(bounds.right-bounds.left<width||bounds.bottom-bounds.top<height){hideSelectionAction();return}
  const x=(Math.max(bounds.left,rect.left)+Math.min(bounds.right,rect.right)-width)/2;
  const y=rect.top-height-8>=bounds.top?rect.top-height-8:rect.bottom+8;
  button.style.left=`${Math.max(bounds.left,Math.min(bounds.right-width,x))}px`;
  button.style.top=`${Math.max(bounds.top,Math.min(bounds.bottom-height,y))}px`;
  state.pending=anchor;
}
function scheduleSelection(){
  if(selectionFrame)return;
  selectionFrame=requestAnimationFrame(()=>{selectionFrame=0;updateSelectionAction()});
}
function watchTextSelection(){
  const button=$('#selection-action');
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0||button.contains(event.target))return;
    selectionPointer=event.pointerId;hideSelectionAction();
  },true);
  document.addEventListener('pointerup',event=>{
    if(event.pointerId===selectionPointer)selectionPointer=null;
    if(!button.contains(event.target))scheduleSelection();
  },true);
  document.addEventListener('pointercancel',()=>{selectionPointer=null;hideSelectionAction()},true);
  document.addEventListener('selectionchange',scheduleSelection);
  document.addEventListener('keyup',scheduleSelection);
  document.addEventListener('scroll',scheduleSelection,true);
  window.addEventListener('resize',scheduleSelection);
  window.addEventListener('blur',()=>{selectionPointer=null;hideSelectionAction()});
}

function preserveCommentReaderLine(){
  const panel=$('#comment-panel');
  if(panel.parentNode?.matches?.('.unified-card-dialog')&&typeof preserveUnifiedCommentReader==='function')return preserveUnifiedCommentReader(panel.parentNode);
  if(panel.parentNode!==document.body||!(window.innerWidth>=1200)||$('#story-creation-shell').hidden)return ()=>{};
  const reader=['#source-view','#structure-reader','#screenplay-reader'].map($).find(r=>r.getClientRects().length);
  if(!reader)return ()=>{};
  const visibleTop=()=>Math.max(70,reader.getBoundingClientRect().top,reader.querySelector('.structure-document-head')?.getBoundingClientRect().bottom||0);
  const top=visibleTop(),bottom=Math.min(window.innerHeight,reader.getBoundingClientRect().bottom);
  if(bottom<=top)return ()=>{};
  const selected=[...reader.querySelectorAll('.comment-mark.selected')].find(mark=>{const r=mark.getBoundingClientRect();return r.top>=top&&r.top<bottom});
  if(selected){const offset=selected.getBoundingClientRect().top-top;return ()=>{reader.scrollTop+=selected.getBoundingClientRect().top-visibleTop()-offset}}
  const paragraph=[...reader.querySelectorAll('.source-text p,.structure-section p')].find(p=>{const r=p.getBoundingClientRect();return r.bottom>top+2&&r.top<bottom});
  if(!paragraph){
    const image=[...reader.querySelectorAll('img')].find(img=>{const r=img.getBoundingClientRect();return img.complete&&r.height>0&&r.bottom>top+2&&r.top<bottom});
    if(!image)return ()=>{};
    const rect=image.getBoundingClientRect(),fraction=Math.max(0,(top-rect.top)/rect.height),offset=rect.top+fraction*rect.height-top;
    return ()=>{const next=image.getBoundingClientRect();reader.scrollTop+=next.top+fraction*next.height-visibleTop()-offset};
  }
  const rect=paragraph.getBoundingClientRect(),x=rect.left+Math.min(8,rect.width/2);
  let anchor=paragraph;
  // A point in a blank line can resolve to a newline above the clipped edge.
  // Choose a fully visible glyph so repeated open/close does not drift by a line.
  for(let y=Math.max(top,rect.top)+8;y<Math.min(bottom,top+180);y+=8){
    const caret=document.caretPositionFromPoint?.(x,y),range=caret?document.createRange():document.caretRangeFromPoint?.(x,y);
    if(caret)range.setStart(caret.offsetNode,caret.offset);
    const text=range?.startContainer;
    if(text?.nodeType!==Node.TEXT_NODE||!paragraph.contains(text)||!/\S/.test(text.textContent[range.startOffset]||''))continue;
    range.setEnd(text,Math.min(text.length,range.startOffset+1));
    const glyph=range.getBoundingClientRect();if(glyph.height&&glyph.top>=top&&glyph.bottom<=bottom){anchor=range;break}
  }
  const before=anchor.getBoundingClientRect().top-top;
  // Keep the same visible text through line wrapping, rather than the old pixel scroll offset.
  return ()=>{reader.scrollTop+=anchor.getBoundingClientRect().top-visibleTop()-before};
}
function setPanelOpen(open){
  const panel=$('#comment-panel'),dialog=panel.parentNode?.matches?.('.unified-card-dialog')?panel.parentNode:null,opening=open&&panel.hidden,restore=panel.hidden===open?preserveCommentReaderLine():()=>{};
  if(opening&&dialog&&!panel.contains(document.activeElement))dialog.commentReturnFocus=document.activeElement;
  const returnFocus=!open&&dialog&&panel.contains(document.activeElement);
  panel.hidden=!open;restore();
  if(opening&&dialog&&window.innerWidth<1200)$('#comments-close').focus({preventScroll:true});
  if(returnFocus){const target=dialog.commentReturnFocus;((target?.isConnected&&dialog.contains(target)&&target.getClientRects().length)?target:dialog.querySelector('.review-dialog-close'))?.focus({preventScroll:true})}
  for(const trigger of ['#comments-toggle','#screenplay-comments'])$(trigger).setAttribute('aria-expanded',String(open));
}
function openPanel(){setPanelOpen(true)}
function closePanel(){setPanelOpen(false)}
function togglePanel(){setPanelOpen($('#comment-panel').hidden)}
function toggleCommentsFromReader(){
  const editor=$('.comment-editor'),key=draftKey(),same=key&&editor?.dataset.draftKey===key&&editor.dataset.draftTarget===JSON.stringify(commentTarget());
  const scope=state.reviewCommentScope;
  state.reviewCommentScope=null;togglePanel();
  // Reopening an unchanged editor must not read an older persisted value over
  // the only live input when localStorage is unavailable.
  if(same&&!scope)return;
  const input=same?editor.querySelector('textarea'):null,intent=same?editor.querySelector('#material-revision-intent'):null;
  const draft=input?{value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection,intent:intent?.checked}:null;
  renderComments();
  if(draft&&draftKey()===key){
    const next=$('#comment-editor-text');if(!next)return;
    next.value=draft.value;if(Number.isInteger(draft.start))next.setSelectionRange?.(draft.start,draft.end,draft.direction);
    const check=$('#material-revision-intent');if(check&&draft.intent!==undefined)check.checked=draft.intent;
    updateCommentEditorControls();
  }
}
let commentAction=0,commentRefreshEpoch=0;
function startDraft(anchor,comment=null){try{rememberLiveCommentEdit()}catch{rememberCommentDraftFailure()}++commentAction;if(typeof cancelMaterialCommentLocation==='function')cancelMaterialCommentLocation();state.anchor=anchor;state.editing=comment?.id||null;state.selected=comment?.id||null;if(comment)beginCommentEdit(comment);state.suggestion=null;state.preview=null;state.previewExpanded=false;if(isScript())rememberScriptDraft();rememberStoryDraft();getSelection()?.removeAllRanges();hideSelectionAction();openPanel();renderActiveReader();renderComments();$('#comment-editor-text')?.focus()}
function abandonDraft(message){
  ++commentAction;
  const key=draftKey();
  try{if(key){localStorage.removeItem(key);localStorage.removeItem(key+':discussion');localStorage.removeItem(key+':submission');localStorage.removeItem(key+':basis');commentRejections.delete(key);commentReceipts.delete(key)}forgetStoryDraft();editDraftBases.delete(key)}
  catch{rememberCommentDraftFailure();toast('本机草稿未能完全清除，取消未完成。当前输入仍保留，请复制留存后重试。');return}
  commentDraftFallbacks.delete(commentDraftIdentity());forgetActiveCommentDraft(commentDraftIdentity());
  if(isScript())forgetScriptDraft();state.anchor=null;state.editing=null;state.selected=null;state.suggestion=null;state.preview=null;state.previewExpanded=false;state.pending=null;renderActiveReader();renderComments();toast(message)
}

// Every comment editor binds here. Buttons own validation and submission state;
// shortcuts invoke those same actions, and never handle unrelated inputs.
function bindCommentEditorShortcuts(textarea,{submit,cancel}){
  let composing=false;
  textarea.addEventListener('compositionstart',()=>{composing=true});
  textarea.addEventListener('compositionend',()=>{composing=false});
  textarea.addEventListener('keydown',event=>{
    const action=event.key==='Escape'?cancel:event.key==='Enter'&&event.metaKey&&!event.ctrlKey&&!event.altKey?submit:null;
    if(!action)return;
    // Do not let IME Escape bubble to the panel's existing close handler.
    event.stopPropagation();
    if(composing||event.isComposing||event.keyCode===229)return;
    event.preventDefault();
    if(event.repeat||textarea.disabled||textarea.readOnly||action.disabled)return;
    action.click();
  });
}
function updateCommentEditorControls(){
  const editor=$('.comment-editor'),textarea=editor?.querySelector('textarea');if(!textarea)return;
  const busy=commentSaves.has(draftKey());textarea.readOnly=busy;
  const intent=editor.querySelector('#material-revision-intent');if(intent)intent.disabled=busy;
  for(const button of editor.querySelectorAll('.editor-actions button'))button.disabled=busy;
  for(const button of editor.querySelectorAll('.comment-edit-conflict button'))button.disabled=busy;
  editor.querySelector('[data-comment-submit]').disabled=busy||!textarea.value.trim();
  editor.querySelector('[data-polish]').disabled=busy||isProduction()||!textarea.value.trim();
}

async function editComment(comment){
  const action=++commentAction,workspace=state.workspace;
  try{
    let located=true;
    if(state.reviewReferenceContext)located=state.reviewReferenceContext.record.id===comment.target_revision_id;
    else if(typeof isEntityReview==='function'&&isEntityReview())located=await locateEntityReviewComment(comment);
    else if(typeof isMaterialReview==='function'&&isMaterialReview())located=await locateMaterialComment(comment);
    if(located===false||action!==commentAction||state.workspace!==workspace)return;
    const target=commentTarget();if(target.target_revision_id!==comment.target_revision_id||(target.target_object_id||target.source_id)!==(comment.target_object_id||comment.source_id)){toast('请先打开这条评论的准确原稿；未将修改转移到当前版本。');return}
    startDraft(comment.anchor,comment);
  }catch(error){if(action===commentAction&&state.workspace===workspace)toast(error.message)}
}
function commentCard(comment){
  const card=el('article','comment-card'+(state.selected===comment.id?' selected':''));card.id=`comment-${comment.id}`;
  nodeText('small',null,(comment.business_code?comment.business_code+' · ':'')+(comment.status==='OPEN'?'待处理':'已关闭')+` · ${new Date(comment.updated_at).toLocaleString('zh-CN')}`,card);
  nodeText('q',null,anchorLabel(comment.anchor),card);if(comment.anchor_state?.valid===false)nodeText('p','structure-alert',`原引用已失效：${comment.anchor_state.reason}`,card);nodeText('p',null,comment.body,card);
  if(isScript())appendScriptCommentScope(card,comment);
  const actions=el('div','card-actions');
  const locate=nodeText('button',null,'定位原圈选',actions);locate.onclick=async()=>{++commentAction;try{await locateComment(comment)}catch(error){toast(error.message)}};
  if(comment.status==='OPEN'){
    const edit=nodeText('button',null,'编辑',actions);edit.onclick=()=>editComment(comment);
    const close=nodeText('button',null,'关闭评论',actions);close.onclick=()=>changeComment(comment,'CLOSE');
  }else{const reopen=nodeText('button',null,'重新打开',actions);reopen.onclick=()=>changeComment(comment,'REOPEN')}
  card.append(actions);if(typeof appendCommentReviewAction==='function')appendCommentReviewAction(card,comment);return card;
}

function hasCommentTarget(){
  if(!['story.sources','story.outline','story.script'].includes(state.workspace)&&!isProduction())return false;
  if(isScript()&&state.screenplayRouteError)return false;
  const target=commentTarget();
  if(!(target.target_object_id||target.source_id)||!target.target_revision_id)return false;
  return !isStructure()||!!state.structure?.revisions.some(revision=>revision.id===target.target_revision_id);
}
function renderComments({replaceDraft=false}={}){
  const retained=replaceDraft?null:liveCommentDraft()||commentDraftFallbacks.get(commentDraftIdentity());
  if(typeof paintReviewCommentCounts==='function')paintReviewCommentCounts();
  if(isScript())renderScriptCommentCounts();
  if(typeof renderBreakdownCommentCounts==='function')renderBreakdownCommentCounts();
  const available=hasCommentTarget();$('#comments-toggle').hidden=!available;$('#screenplay-comments').hidden=!isScript()||!available;
  if(!available){closePanel();$('#comment-body').replaceChildren();$('#open-count').textContent='0';return;}const body=$('#comment-body');body.replaceChildren();
  const own=activeComments(),open=own.filter(c=>c.status==='OPEN'),closed=own.filter(c=>c.status==='CLOSED');
  $('#open-count').textContent=`${open.length} 待处理`;
  const older=isStructure()?state.comments.filter(c=>c.target_object_id==='story-structure'&&c.target_revision_id!==state.structureRevision&&c.status==='OPEN').length:0;
  $('#comments-toggle').textContent=isStructure()?`本稿评论 ${open.length} · 历史待决 ${older}`:`查看评论 · ${open.length}`;
  if(typeof appendCrossVersionReview==='function')appendCrossVersionReview(body);
  if(state.reviewCommentScope){nodeText('p','comment-help',`此块全部评论 · ${own.length}`,body);if(!own.length)nodeText('p',null,'此块暂无评论',body)}
  if(!state.reviewCommentScope)nodeText('p','comment-help',state.reviewReferenceContext?'评论绑定当前引用的准确版本、文件与范围。':typeof isEntityReview==='function'&&isEntityReview()?'本面板汇总整个实体的评论。选中文字、圈选图片或指定时间段，可对具体内容提出意见。':isStructure()?'选中文字、圈选图像或留下整体意见。评论始终绑定当前稿件修订。':isScript()?'选中动作或对白添加评论。意见与草稿绑定这个剧本版本的本集修订；关闭后仍保留历史。':'选中正文后添加评论。评论锚点绑定资料与原文区间；关闭后仍保留历史，可重新打开。',body);
  appendStoredCommentEdits(body);
  if(state.anchor){const editor=el('section','comment-editor');editor.dataset.draftKey=draftKey();editor.dataset.draftTarget=JSON.stringify(commentTarget());nodeText('strong',null,state.editing?'编辑评论':'添加新评论',editor);nodeText('q',null,anchorLabel(state.anchor),editor);if(isProduction()&&state.productionSelected?.payload){
      const row=state.productionSelected,component=row.payload.components?.find(c=>c.id===(state.anchor.component_id||state.anchor.visual_id)&&c.file===state.anchor.asset_file);
      const label=component?({original:'原件',preview:'预览',thumbnail:'缩略图'})[component.role]||'媒体':'';
      nodeText('small',null,'评论对象：'+(row.kind==='REPRESENTATION'?'整个实体':row.payload.title)+(label?' · '+label:''),editor);
    }
    const label=nodeText('label',null,'修改意见',editor);label.htmlFor='comment-editor-text';const textarea=el('textarea');textarea.id='comment-editor-text';textarea.value=retained?.value??readCommentDraftStorage(draftKey())??(state.editing?state.comments.find(c=>c.id===state.editing)?.body||'':'');
    if(Number.isInteger(retained?.start))textarea.setSelectionRange?.(retained.start,retained.end,retained.direction);
    textarea.addEventListener('input',()=>{try{localStorage.setItem(draftKey(),textarea.value);if(state.editing)rememberEditBasis(editDraftBasis());if(commentDraftFallbacks.has(commentDraftIdentity()))rememberCommentDraftFailure()}catch{rememberCommentDraftFailure();toast('本机草稿保存失败，当前输入仍保留，请复制留存后重试。')}state.preview=null;state.previewExpanded=false;state.suggestion=null;updateCommentEditorControls()});editor.append(textarea);
    const help=nodeText('p','comment-help','输入框内：⌘+Enter 提交／保存；Esc 取消并放弃未提交内容；Enter 换行。',editor);help.id='comment-editor-shortcuts';textarea.setAttribute('aria-describedby',help.id);
    appendLegacyMaterialDraft(editor,draftKey());
    appendCommentSubmissionNotice(editor,draftKey());
    appendEditConflict(editor);
    const revisionIntent=commentRevisionIntent();
    if(revisionIntent){const label=el('label','comment-intent'),check=el('input');check.type='checkbox';check.checked=retained?.intent??(readCommentDraftStorage(draftKey()+':discussion')!=='true');check.id='material-revision-intent';check.onchange=()=>{try{localStorage.setItem(draftKey()+':discussion',String(!check.checked));if(commentDraftFallbacks.has(commentDraftIdentity()))rememberCommentDraftFailure()}catch{rememberCommentDraftFailure();toast('本机草稿保存失败，当前选择仅在本页面保留。')}};label.append(check,document.createTextNode('作为素材修订意见'));editor.append(label)}
    const actions=el('div','editor-actions'),save=nodeText('button','primary',state.editing?'保存修改':'提交评论',actions);save.dataset.commentSubmit='true';save.onclick=saveComment;
    const inspect=nodeText('button',null,'查看润色参考',actions);inspect.onclick=previewPolish;inspect.hidden=isProduction();
    const polish=nodeText('button',null,'AI 润色修改意见',actions);polish.dataset.polish='true';polish.disabled=!textarea.value.trim();polish.onclick=polishComment;polish.hidden=isProduction();
    const collapse=nodeText('button',null,'收起草稿',actions);collapse.onclick=closePanel;
    const cancel=nodeText('button','destructive',state.editing?'放弃此页修改':'取消本次评论',actions);cancel.onclick=()=>abandonDraft(state.editing?'此页未保存修改已放弃，已保存评论与其他页草稿仍保留':'本次未提交评论已取消');editor.append(actions);
    bindCommentEditorShortcuts(textarea,{submit:save,cancel});
    if(state.preview){const basis=el('details','context-preview');basis.open=state.previewExpanded;basis.addEventListener('toggle',()=>{state.previewExpanded=basis.open});const summary=el('summary',null,'本次润色参考 · 可核对');basis.append(summary);
      const context=state.preview.context;nodeText('p',null,context.review_task||`${context.creative_stage.label}审阅`,basis);
      if(state.preview.budget)nodeText('small',null,`参考共 ${state.preview.budget.used} / ${state.preview.budget.limit} 字符（含原文、意见、背景、来源信息与格式）。`,basis);
      nodeText('p',null,`当前圈选：${context.selected_quote||'整体／图像意见'}`,basis);
      if(context.project_background)nodeText('p',null,`项目背景：${Object.values(context.project_background).map(value=>typeof value==='object'?value.label:value).join('；')}`,basis);
      if(context.visual)nodeText('p',null,`图像／图示：${context.visual.title} · ${context.visual.file}；圈选点：${context.region_points?JSON.stringify(context.region_points):'整图'}`,basis);
      for(const doc of context.source_documents){const row=el('div');nodeText('strong',null,`${doc.title} · ${doc.role==='comparison'?'仅供比较':doc.role==='basis'?'准确改编依据':'当前评论依据'} · ${doc.identity_only?'版本身份':doc.truncated?'节选':'全文'}`,row);nodeText('p',null,doc.purpose||doc.version_type,row);if(!doc.identity_only)nodeText('p',null,doc.text||'总预算内未容纳正文；以完整圈选为准，不推断缺失内容。',row);const identity=el('details');nodeText('summary',null,'版本与出处',identity);nodeText('small',null,`${doc.id} · ${doc.revision}；${doc.origin||''} ${doc.source_url||''}${Number.isInteger(doc.start)?`；原文字符 ${doc.start}—${doc.end} / ${doc.total_chars}`:''}`,identity);row.append(identity);basis.append(row)}
      for(const notice of context.notices||[])nodeText('p','config-field-error',notice,basis);
      const back=nodeText('button',null,'回到意见',basis);back.onclick=()=>{state.previewExpanded=false;basis.open=false;textarea.focus({preventScroll:true});textarea.scrollIntoView({block:'nearest'})};editor.append(basis)}
    if(state.suggestion){const preview=el('section','suggestion');nodeText('strong',null,'AI 建议 · 尚未保存',preview);nodeText('p',null,state.suggestion,preview);nodeText('small',null,'请核对是否引入未证实的史实或额外任务；采用后仍需手动保存。',preview);
      const apply=nodeText('button','secondary','采用到草稿',preview);apply.disabled=commentSaves.has(draftKey());apply.onclick=()=>{try{localStorage.setItem(draftKey(),state.suggestion)}catch{rememberCommentDraftFailure();toast('本机草稿保存失败，原输入与润色建议仍保留，请复制留存后重试。');return}state.suggestion=null;state.preview=null;state.previewExpanded=false;commentDraftFallbacks.delete(commentDraftIdentity());renderComments({replaceDraft:true})};editor.append(preview)}body.append(editor);updateCommentEditorControls()}
  nodeText('h3',null,`未关闭评论 · ${open.length}`,body);if(!open.length)nodeText('p','empty','暂无待处理评论。圈选原文即可添加。',body);
  if(typeof isEntityReview==='function'&&isEntityReview())appendEntityReviewComments(body,open);else for(const comment of open)body.append(commentCard(comment));
  const head=el('div','history-head');nodeText('h3',null,`已关闭评论 · ${closed.length}`,head);
  const toggle=nodeText('button',null,state.historyOpen?'收起历史':'展开历史',head);toggle.onclick=()=>{state.historyOpen=!state.historyOpen;renderComments()};body.append(head);
  if(state.historyOpen){if(typeof isEntityReview==='function'&&isEntityReview())appendEntityReviewComments(body,closed.slice(0,state.historyLimit));else for(const comment of closed.slice(0,state.historyLimit))body.append(commentCard(comment));if(closed.length>state.historyLimit){const more=nodeText('button','secondary','显示更多',body);more.onclick=()=>{state.historyLimit+=20;renderComments()}}}
}

async function refreshComments(){
  const epoch=++commentRefreshEpoch;
  const comments=await api('/api/comments');
  if(epoch!==commentRefreshEpoch)return;
  // Refocusing the window fetches comments asynchronously. A no-op refresh must not
  // replace the text nodes underneath a selection gesture (or the current editor).
  if(JSON.stringify(comments)===JSON.stringify(state.comments))return;
  state.comments=comments;renderSources();renderActiveReader();renderComments();
}
async function saveComment(){
  const textarea=$('#comment-editor-text'),key=draftKey();
  if(!key||!textarea||textarea.disabled||textarea.readOnly||commentSaves.has(key))return;
  const text=textarea.value.trim();if(!text)return toast('请先填写修改意见');
  if(state.editing&&!Number.isInteger(editDraftBasis(key)?.version)){renderComments();return toast('旧草稿的开始版本无法确定，请查看最新内容并明确核对后再保存。')}
  const editorMetaKey=isScript()?scriptDraftMetaKey(scriptEpisode()):storyDraftMetaKey();
  const editing=state.editing,draftText=textarea.value,payload={...commentTarget(),anchor:state.anchor,body:text};
  const fallbackIdentity=commentDraftIdentity(),fallback=commentDraftFallbacks.get(fallbackIdentity);
  if(!editing&&typeof materialCommentContext==='function'){const context=materialCommentContext();if(context)payload.material_context=context}
  if(!editing&&$('#material-revision-intent')?.checked){const intent=commentRevisionIntent();if(intent)payload.material_revision=intent}
  let submission,storedSubmission,sent=false,acknowledged=false,cleaned=false;
  commentSaves.add(key);updateCommentEditorControls();
  try{
    try{
      const pending=pendingCommentSubmission(key,true),samePayload=pending&&JSON.stringify(pending.payload)===JSON.stringify(payload)&&(!editing?!pending.editing:pending.editing===editing);
      if(samePayload&&pending.acknowledged){
        submission=pending;storedSubmission=localStorage.getItem(key+':submission');acknowledged=true;
      }else{
        localStorage.setItem(key,draftText);
        const basis=editing?editDraftBasis(key):null;
        if(editing&&!Number.isInteger(basis?.version))throw Error('旧草稿的开始版本无法确定，请查看最新内容并明确核对后再保存。');
        submission=editing?{id:editing,editing,payload,expected_version:basis.version}:samePayload?{id:pending.id,payload:pending.payload}:{id:crypto.randomUUID(),payload};
        submission.attempt_id=crypto.randomUUID();
        storedSubmission=JSON.stringify(submission);localStorage.setItem(key+':submission',storedSubmission);commentRejections.delete(key);commentReceipts.delete(key);
      }
    }catch{
      const receipt=commentReceipts.get(key);if(receipt&&JSON.stringify(receipt.submission.payload)===JSON.stringify(payload)){acknowledged=true;submission=receipt.submission;throw Error('无法核对本机草稿')}
      throw Error('本机草稿保存失败，评论尚未发送。当前输入仍保留，请复制留存后重试。')
    }
    if(!acknowledged){
      if(editing){sent=true;await api(`/api/comments/${editing}`,{method:'PATCH',body:JSON.stringify({action:'EDIT',expected_version:submission.expected_version,body:text})})}
      else{sent=true;await api('/api/comments',{method:'POST',body:JSON.stringify({id:submission.id,...submission.payload})})}
      acknowledged=true;storedSubmission=rememberCommentReceipt(key,storedSubmission,submission);
    }
    const sameSubmission=localStorage.getItem(key+':submission')===storedSubmission,storedDraft=localStorage.getItem(key);
    const ownDraft=sameSubmission&&(storedDraft===draftText||storedDraft===null)&&commentDraftFallbacks.get(fallbackIdentity)===fallback;
    const stillHere=ownDraft&&commentDraftIdentity()===fallbackIdentity&&$('#comment-editor-text')?.value===draftText;
    if(ownDraft){
      if(editorMetaKey){const meta=JSON.parse(localStorage.getItem(editorMetaKey)||'null');if(meta&&JSON.stringify(meta.anchor)===JSON.stringify(payload.anchor)&&(meta.editing||null)===(editing||null))localStorage.removeItem(editorMetaKey)}
      localStorage.removeItem(key);localStorage.removeItem(key+':discussion');localStorage.removeItem(key+':submission');localStorage.removeItem(key+':basis');editDraftBases.delete(key);commentRejections.delete(key);commentReceipts.delete(key);commentDraftFallbacks.delete(fallbackIdentity);forgetActiveCommentDraft(fallbackIdentity)}
    cleaned=true;
    if(stillHere){if(isScript())forgetScriptDraft();forgetStoryDraft();state.anchor=null;state.editing=null;state.suggestion=null;state.preview=null;state.previewExpanded=false;renderActiveReader();renderComments()}
    if(stillHere&&payload.material_revision){const url=new URL(location.href);url.searchParams.delete('material_round');history.replaceState(history.state,'',url);if(isEntityReview())await reloadEntityReview();else if(isMaterialReview())await openProductionRecord(state.materialReview.record.object_id)}
    await refreshComments();toast('评论已保存');
  }catch(error){
    if(acknowledged){
      if(!cleaned&&draftKey()===key&&$('#comment-editor-text')===textarea&&textarea.value===draftText)appendCommentSubmissionNotice($('.comment-editor'),key,pendingCommentSubmission(key)||{...submission,acknowledged:true,local_receipt_only:true});
      toast(cleaned?'评论已保存，但页面未能更新，请刷新后查看。':'评论已保存，但本机草稿未能完全清除。当前输入仍保留；本机记录不可用时，请勿刷新后另建同一条评论。');
    }else{
      let message=error.message;if(sent&&submission&&[400,409].includes(error.status)&&markCommentSubmissionRejected(key,storedSubmission,submission,error)===false)message+=' 拒绝状态未能写入本机；原草稿仍保留，请复制留存。';
      if(editing&&error.status===409){const basis=editDraftBases.get(key);if(basis){editDraftBases.set(key,{...basis,conflict:true});try{localStorage.setItem(key+':basis',JSON.stringify(editDraftBases.get(key)))}catch{}}await refreshComments().catch(()=>{});if(draftKey()===key)renderComments();message='评论已被另一页修改，此页原稿仍保留。请查看最新已保存内容，核对后人工整理，或放弃此页修改。'}
      if(sent&&draftKey()===key)appendCommentSubmissionNotice($('.comment-editor'),key);toast(message)
    }
  }finally{commentSaves.delete(key);updateCommentEditorControls()}
}
const sameDraft=(key,text,target,action=commentAction)=>action===commentAction&&draftKey()===key&&$('#comment-editor-text')?.value.trim()===text&&(!target||JSON.stringify(commentTarget())===JSON.stringify(target));
function renderPolishFeedback(key,text,target,action=commentAction){
  if(!sameDraft(key,text,target,action))return false;
  const input=$('#comment-editor-text'),value=input.value,start=input.selectionStart,end=input.selectionEnd,direction=input.selectionDirection;
  renderComments();
  if(draftKey()!==key||JSON.stringify(commentTarget())!==JSON.stringify(target))return false;
  const next=$('#comment-editor-text');if(!next)return false;
  next.value=value;if(Number.isInteger(start))next.setSelectionRange?.(start,end,direction);updateCommentEditorControls();return true;
}
async function polishComment(){
  const text=$('#comment-editor-text').value.trim();if(!text)return toast('请先填写修改意见');
  const key=draftKey(),target=commentTarget(),action=commentAction,request={...target,anchor:state.anchor,body:text};
  $('[data-polish]').disabled=true;
  try{
    const preview=state.preview&&state.previewRequest===JSON.stringify(request)?state.preview:await api('/api/comments/polish-context',{method:'POST',body:JSON.stringify(request)});
    if(!sameDraft(key,text,target,action))return;
    state.preview=preview;state.previewRequest=JSON.stringify(request);state.previewExpanded=false;
    const result=await api('/api/comments/polish',{method:'POST',body:JSON.stringify({...request,expected_context_sha256:preview.context_sha256})});
    if(!sameDraft(key,text,target,action))return;
    state.suggestion=result.suggestion;if(renderPolishFeedback(key,text,target,action))toast('润色建议已生成，原草稿未修改');
  }catch(error){if(renderPolishFeedback(key,text,target,action))toast(error.message)}
}
async function previewPolish(){
  const text=$('#comment-editor-text').value.trim();if(!text)return toast('请先填写修改意见');
  const key=draftKey(),target=commentTarget(),action=commentAction,request={...target,anchor:state.anchor,body:text};
  try{
    const preview=await api('/api/comments/polish-context',{method:'POST',body:JSON.stringify(request)});
    if(!sameDraft(key,text,target,action))return;
    state.preview=preview;state.previewRequest=JSON.stringify(request);state.previewExpanded=true;if(renderPolishFeedback(key,text,target,action))toast('已列出本次润色使用的准确参考');
  }catch(error){if(sameDraft(key,text,target,action))toast(error.message)}
}
const commentChanges=new Set();
async function changeComment(comment,action){
  if(commentChanges.has(comment.id))return;
  commentChanges.add(comment.id);commentReviewDialog?.reviewRefresh?.();
  commentReviewDialog?.reviewError?.('');
  try{await api(`/api/comments/${comment.id}`,{method:'PATCH',body:JSON.stringify({action,expected_version:comment.version})});await refreshComments();toast(action==='CLOSE'?'评论已关闭':'评论已重新打开')}
  catch(error){toast(error.message);commentReviewDialog?.reviewError?.(error.message);if(error.status===409)await refreshComments().catch(()=>{})}
  finally{commentChanges.delete(comment.id);commentReviewDialog?.reviewRefresh?.()}
}
function selectComment(id){state.selected=id;openPanel();renderActiveReader();renderComments();setTimeout(()=>$('#comment-'+escapeSelector(id))?.scrollIntoView({block:'nearest'}),0)}
function revealLocatedComment(){
  if(window.innerWidth<1200){
    const panel=$('#comment-panel');
    closePanel();
    if(panel.parentNode===document.body)$('#comments-toggle').focus({preventScroll:true});
  }
}
function locateSourceComment(comment){
  const source=state.current,anchor=comment.anchor,type=anchor.type||'text';
  if(state.workspace!=='story.sources'||(comment.target_object_id||comment.source_id)!==source?.id){toast('请先打开原资料，再定位这条评论');return false}
  if(comment.target_revision_id!==source.target_revision_id){toast('当前资料不是评论引用的修订；评论仍保留');return false}
  if(['visual','region'].includes(type)&&!source.assets.some(asset=>asset.file===anchor.visual_id&&asset.file===anchor.asset_file)){toast('原引用已失效；评论仍保留');return false}
  state.selected=comment.id;renderDocument();renderComments();
  const root=$('#source-view'),target=type==='text'?root.querySelector(`#block-${escapeSelector(anchor.block_id)}`):['visual','region'].includes(type)?root.querySelector(`[data-visual-id="${escapeSelector(anchor.visual_id)}"]`):type==='global'?root:null;
  if(!target||(['visual','region'].includes(type)&&target.closest('figure')?.dataset.reviewFile!==anchor.asset_file)){toast('原引用已失效；评论仍保留');return false}
  revealLocatedComment();
  (target.querySelector('.comment-mark.selected')||target).scrollIntoView({behavior:'smooth',block:'center'});
  target.classList.add('comment-flash');setTimeout(()=>target.classList.remove('comment-flash'),1600);return true;
}
function locateComment(comment){
  const panel=$('#comment-panel');
  if(window.innerWidth<1200&&panel.parentNode?.matches?.('.unified-card-dialog'))closePanel();
  if(state.reviewReferenceContext){const dialog=state.reviewReferenceContext.dialog;state.selected=comment.id;if(comment.anchor.type==='time')dialog.querySelector('.review-media-player')?.reviewLocate(comment.anchor);else dialog.querySelector(`[data-block-id="${CSS.escape(comment.anchor.block_id||'')}"]`)?.scrollIntoView({block:'center'});paintProductionReview();renderComments();return}if(isProduction())return locateProductionComment(comment);if(isScript())return locateScriptComment(comment);if(comment.anchor_state?.valid===false){toast(`原引用已失效：${comment.anchor_state.reason}`);return}if(comment.target_object_id==='story-structure'){if(!state.structure?.revisions.some(revision=>revision.id===comment.target_revision_id)){toast('原稿已不可用；评论仍保留');return}chooseStructureRevision(comment.target_revision_id,isStructure());if(!isStructure())switchWorkspace('story.outline');state.selected=comment.id;renderStructureReader();renderComments();const target=comment.anchor.type==='text'?document.querySelector(`[data-structure-block="${escapeSelector(comment.anchor.block_id)}"]`):comment.anchor.visual_id?document.querySelector(`[data-visual-id="${escapeSelector(comment.anchor.visual_id)}"]`):$('#structure-reader');if(!target){toast('原引用已失效；评论仍保留在原稿');return}revealLocatedComment();(target.querySelector('.comment-mark.selected')||target).scrollIntoView({behavior:'smooth',block:'center'});target.classList.add('comment-flash');setTimeout(()=>target.classList.remove('comment-flash'),1600);return}return locateSourceComment(comment)}

async function init(){try{
  const initialUrl=new URL(location.href),initialWorkspace=initialUrl.searchParams.get('workspace')||(initialUrl.searchParams.has('source')?'story.sources':'production.approach');
  const [instance,comments,framework,configurations,codes]=await Promise.all([api('/api/instance'),api('/api/comments'),api('/api/framework'),api(initialWorkspace==='project.configuration'?'/api/configurations':'/api/configurations?summary=1'),api('/api/business-codes'),['story.sources','story.outline','story.script'].includes(initialWorkspace)?loadStoryData():loadStoryDirectory()]);
  state.businessCodeCatalog=codes;state.businessCodes=new Map(codes.objects.map(row=>[row.object_id,row.display_code||row.prefix+String(row.number).padStart(3,'0')]));
  state.legacyShotCodes=new Map();for(const row of codes.objects.filter(r=>r.legacy_position)){const key=row.legacy_position,label=[row.episode_code,row.display_code].filter(Boolean).join(' / ');state.legacyShotCodes.set(key,state.legacyShotCodes.has(key)?null:label)}
  $('#instance-title').textContent=instance.title;document.title=`${instance.title} · 故事审阅台`;state.comments=comments;state.framework=framework;state.configurations=configurations;applyFavicon();
  if(storyDataReady)initializeStoryReaders(initialUrl);
  switchWorkspace(initialWorkspace,false);
  restoreSourceChapter(initialUrl,{initial:true});
  window.addEventListener('popstate',async()=>{
    const url=new URL(location.href),source=url.searchParams.get('source'),workspace=url.searchParams.get('workspace')||(source?'story.sources':'production.approach'),previous=state.workspace;
    if(['story.sources','story.outline','story.script'].includes(workspace)&&!storyDataReady){const read=++workspaceReadEpoch;try{await loadStoryData()}catch(error){if(read===workspaceReadEpoch)toast(error.message);return}if(read!==workspaceReadEpoch||location.href!==url.href)return;initializeStoryReaders(url)}
    const nextSource=state.sources.find(item=>item.id===source)||state.sources[0],sourceChanged=workspace==='story.sources'&&nextSource?.id!==state.current?.id;
    if(sourceChanged)chooseSource(nextSource?.id,true,false);
    else if(storyDataReady&&workspace!=='story.sources'&&source&&source!==state.current?.id)chooseSource(source,true,false);
    if(url.searchParams.get('workspace')==='story.outline')chooseStructureRevision(url.searchParams.get('structure_revision'),false);
    if(url.searchParams.get('workspace')==='story.script'){
      const version=url.searchParams.get('script'),episode=url.searchParams.get('episode'),scene=url.searchParams.get('scene');
      if(version!==state.screenplayVersion||episode!==state.screenplayEpisode||scene!==state.screenplayScene)chooseScript(version,episode,scene,false);
    }
    if(workspace!=='story.sources'||previous!==workspace)switchWorkspace(workspace,false);
    restoreSourceChapter(url,{force:sourceChanged||previous!==state.workspace});
  });
  $('#brand-home').onclick=()=>location.assign(reviewURL('/'));
  $('#screenplay-comments').onclick=togglePanel;
  $('#comments-toggle').onclick=toggleCommentsFromReader;$('#comments-close').onclick=closePanel;
  document.addEventListener('keydown',event=>{
    const panel=$('#comment-panel');if(event.key!=='Escape'||panel.hidden)return;
    event.preventDefault();const focusInside=panel.contains(document.activeElement);closePanel();
    if(focusInside)$('#comments-toggle').focus();
  });
  let commentActionAtPointerDown=commentAction;
  document.addEventListener('pointerdown',()=>{commentActionAtPointerDown=commentAction},{capture:true});
  // Finish hit testing before docked comments change the reader layout.
  // A region drag can open a fresh draft on pointerup, before its trailing click.
  document.addEventListener('click',event=>{
    const panel=$('#comment-panel');
    if(panel.hidden||(event.detail>0&&commentActionAtPointerDown!==commentAction)||event.target.closest?.('dialog,.review-cue,.material-reference,[data-review-dialog-trigger]')||panel.contains(event.target)||$('#comments-toggle').contains(event.target)||$('#screenplay-comments').contains(event.target))return;
    closePanel();
  },{capture:true});
  $('#selection-action').addEventListener('mousedown',event=>event.preventDefault());$('#selection-action').onclick=()=>{if(state.pending)startDraft(state.pending)};
  watchTextSelection();
  document.addEventListener('scroll',scheduleSourceChapter,{capture:true,passive:true});
  window.addEventListener('resize',scheduleSourceChapter);
  window.addEventListener('focus',()=>refreshComments().catch(()=>{}));
}catch(error){$('#source-view').textContent=`加载失败：${error.message}`}}
document.addEventListener('DOMContentLoaded',init,{once:true});
