const state={sources:[],comments:[],current:null,anchor:null,editing:null,selected:null,historyOpen:false,historyLimit:20,suggestion:null,preview:null,previewExpanded:false,framework:null,configurations:null,workspace:'story.sources',query:'',configSection:'PROJECT',expandedGroups:new Set(),expandedSources:new Set(),sourceChapter:null,structure:null,structureRevision:null,drawMode:null,screenplays:[],screenplaySummaries:new Map(),screenplayVersion:null,screenplayEpisode:null,screenplayScene:null};
const $=s=>document.querySelector(s);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node};
const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data};
const chars=text=>Array.from(text);
const toast=message=>{const node=$('#toast');node.textContent=message;node.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('show'),3500)};
const isStructure=()=>state.workspace==='story.outline';
const isScript=()=>state.workspace==='story.script';
const commentTarget=()=>isStructure()?{target_object_id:'story-structure',target_revision_id:state.structureRevision}:isScript()?{target_object_id:scriptEpisode()?.object_id,target_revision_id:scriptEpisode()?.id}:{source_id:state.current?.id};
const draftKey=()=>state.anchor?`review-draft:${isStructure()?state.structureRevision:isScript()?scriptEpisode()?.id:state.current?.id}:${state.editing||'new'}:${JSON.stringify(state.anchor)}`:null;
const commentSaves=new Set();
const activeComments=()=>state.comments.filter(c=>isStructure()?c.target_object_id==='story-structure'&&c.target_revision_id===state.structureRevision:isScript()?c.target_object_id===scriptEpisode()?.object_id&&c.target_revision_id===scriptEpisode()?.id:c.source_id===state.current?.id);
const newDraftAnchor=()=>state.anchor&&!state.editing?state.anchor:null;
const anchorLabel=a=>a.type==='global'?'整篇结构稿':a.type==='visual'?'整张图像／图示':a.type==='region'?'图像／图示圈选区域':a.quote||'原文引用';
const renderActiveReader=()=>isStructure()?renderStructureReader():isScript()?renderScriptReader():renderDocument();
const escapeSelector=value=>CSS.escape(value);

function nodeText(tag,cls,text,parent){const node=el(tag,cls,text);parent.append(node);return node}
function link(label,url,parent){const a=el('a',null,label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);return a}

function sourceChapters(source){
  if(source?.group!=='story-refinements')return [];
  return source.blocks.flatMap(block=>{
    const title=block.text.split(/\r?\n/,1)[0].trim();
    return /^第[零〇一二三四五六七八九十百千万两\d]+章(?:\s|[：:]|$)/u.test(title)?[{id:block.id,title}]:[];
  });
}

function renderSources(preserveScroll=true){
  const nav=$('#source-list'),scrollTop=preserveScroll?nav.scrollTop:0;nav.replaceChildren();
  const filtered=state.sources.filter(source=>!state.query||[source.title,source.origin,source.version_type,...source.blocks.map(block=>block.text)].join('\n').toLocaleLowerCase().includes(state.query));
  const addSource=(source,parent)=>{
    const button=el('button','source-button'+(source.id===state.current?.id?' active':''));button.type='button';
    button.dataset.sourceId=source.id;button.setAttribute('aria-current',source.id===state.current?.id?'true':'false');
    const title=source.group==='story-refinements'?source.title.replace(/^(故事精修([一二三四五六七八九十百零\d]+)[：:].*?)\s*第\2版$/,'$1'):source.title;
    const chapters=sourceChapters(source),open=state.expandedSources.has(source.id);
    if(chapters.length){
      button.classList.add('source-version-toggle');button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-controls',`source-chapters-${source.id}`);
      nodeText('span','source-version-arrow',open?'▾':'▸',button).setAttribute('aria-hidden','true');
    }
    nodeText('strong',null,title,button);
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
  for(const source of filtered.filter(item=>!item.group))addSource(source,nav);
  for(const [id,label] of [['folk-tales','民间小故事'],['expansion-directions','扩写方向'],['story-refinements','故事精修']]){
    const items=filtered.filter(source=>source.group===id);
    if(!items.length)continue;
    const group=el('section','source-group'),header=el('button','source-group-toggle');header.type='button';
    const open=state.expandedGroups.has(id);
    header.setAttribute('aria-expanded',String(open));header.dataset.groupId=id;
    nodeText('span',null,`${open?'▾':'▸'} ${label}`,header);nodeText('small',null,`${items.length} 项`,header);
    header.onclick=()=>{if(state.expandedGroups.has(id))state.expandedGroups.delete(id);else state.expandedGroups.add(id);renderSources()};
    group.append(header);
    if(open){const children=el('div','source-group-items');for(const item of items)addSource(item,children);group.append(children)}
    nav.append(group);
  }
  for(const source of filtered.filter(item=>item.group&&!['folk-tales','expansion-directions','story-refinements'].includes(item.group)))addSource(source,nav);
  if(!filtered.length)nodeText('p','source-no-results','未找到匹配的资料。',nav);
  $('#source-count').textContent=state.query?`${filtered.length} / ${state.sources.length} 份资料`:`${state.sources.length} 份资料`;
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
function jumpSourceChapter(sourceId,blockId){
  if(state.current?.id!==sourceId)chooseSource(sourceId);
  const reader=$('#source-view'),target=$(`#block-${escapeSelector(blockId)}`);if(!target)return;
  if(getComputedStyle(reader).overflowY==='auto')reader.scrollTo({top:reader.scrollTop+target.getBoundingClientRect().top-reader.getBoundingClientRect().top-12,behavior:'instant'});
  else window.scrollBy({top:target.getBoundingClientRect().top-Math.max(0,$('.workspace-topbar').getBoundingClientRect().bottom)-12,behavior:'instant'});
  scheduleSourceChapter();
  $(`#source-list .source-chapter-button[data-source-id="${escapeSelector(sourceId)}"][data-block-id="${escapeSelector(blockId)}"]`)?.focus({preventScroll:true});
}

function renderWorkspaceNav(){
  const nav=$('#workspace-nav');nav.replaceChildren();
  const sections=[
    ['production.approach','制作思路','思路','故事创作与生产制作方法'],
    ['story.sources','故事创作','故事','故事采编、故事结构与分集剧本'],
    ['settings.workspace','故事设定','设定','主体、空间与实体关系'],
    ['materials.workspace','素材管理','素材','需求、制作与素材审阅'],
    ['production.workspace','全剧制作','制作','镜头、场景与分集成片'],
    ['project.configuration','系统管理','管理','系统配置、数据与运行']
  ];
  for(const [id,title,index,description] of sections){
    const workspace=state.framework.workspaces.find(w=>w.id===id),active=workspace?.implemented;
    const button=el('button','workspace-button'+(state.workspace===id?' active':'')+(active?'':' planned'));button.type='button';
    button.setAttribute('aria-current',state.workspace===id?'page':'false');
    nodeText('span','nav-index',index,button);const labels=el('span','nav-labels');nodeText('b',null,title,labels);nodeText('small',null,active?description:`${description} · 待开放`,labels);button.append(labels);
    button.onclick=()=>switchWorkspace(id);nav.append(button);
  }
}

function renderStageLabel(){const current=state.configurations.values.PROJECT.body.current_stage;
  const stage=state.framework.stages.find(item=>item.id===current);
  $('#sidebar-current-stage').textContent=`当前阶段 · ${stage?.label||current}`;
}

function switchWorkspace(id,updateUrl=true){
  hideSelectionAction();
  if(id==='current')id='production.approach';
  if(!state.framework.workspaces.some(workspace=>workspace.id===id))id='production.approach';
  const previous=state.workspace,storyChild=['story.sources','story.outline','story.script'].includes(id);
  if(state.workspace!==id){getSelection()?.removeAllRanges();state.anchor=null;state.editing=null;state.selected=null;state.suggestion=null;state.preview=null}
  state.workspace=id;renderWorkspaceNav();const source=id==='story.sources';
  $('#story-creation-shell').hidden=!storyChild;
  $('#story-workspace').hidden=!source;$('#screenplay-workspace').hidden=id!=='story.script';$('#structure-workspace').hidden=id!=='story.outline';$('#configuration-view').hidden=id!=='project.configuration';$('#approach-view').hidden=id!=='production.approach';
  $('#placeholder-view').hidden=storyChild||id==='project.configuration'||id==='production.approach';
  for(const [tab,selected] of [['#open-story-sources',source],['#open-story-structure',id==='story.outline'],['#open-story-script',id==='story.script']]){
    const button=$(tab);button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));
  }
  $('#comments-toggle').hidden=!storyChild;closePanel();
  $('#source-search').closest('.search-box').hidden=!source;$('#source-search').hidden=!source;$('#source-count').hidden=!source;
  const titles={'story.sources':['故事创作','故'],'story.outline':['故事创作','故'],'story.script':['故事创作','故'],'settings.workspace':['故事设定','设'],'materials.workspace':['素材管理','素'],'production.workspace':['全剧制作','制'],'project.configuration':['系统管理','管'],'production.approach':['制作思路','思']};
  $('#view-title').textContent=titles[id]?.[0]||'故事创作';$('#view-symbol').textContent=titles[id]?.[1]||'故';
  if(id==='project.configuration')renderConfigurations();if(id==='production.approach')renderApproach();if(id==='story.outline'){renderStructureReader();renderComments()}
  if(source){renderComments();scheduleSourceChapter()}
  if(id==='story.script'){restoreScriptDraft();renderScriptIndex();renderScriptReader();renderComments()}
  if(!storyChild&&id!=='project.configuration'&&id!=='production.approach')renderPlaceholder(id);
  if(updateUrl){const url=new URL(location.href);url.searchParams.set('workspace',id);url.hash='';if(url.href!==location.href)history.pushState(null,'',url)}
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

function renderConfigurations(){
  const root=$('#configuration-view');root.replaceChildren();
  const header=el('header','management-heading');nodeText('h1',null,'系统管理',header);
  nodeText('p',null,'当前故事实例 · 系统与故事项目配置',header);root.append(header);
  const tabs=el('nav','management-tabs');tabs.setAttribute('aria-label','系统管理模块');
  for(const [label,ready] of [['使用与初始化',false],['系统配置',true],['数据与运行',false],['系统架构',false]]){
    const button=nodeText('button',ready?'active':'',ready?label:`${label} · 待开放`,tabs);button.type='button';button.disabled=!ready;
    button.setAttribute('aria-current',ready?'page':'false');
  }root.append(tabs);
  const layout=el('div','configuration-layout'),sections=el('nav','configuration-sections');sections.setAttribute('aria-label','系统配置分组');
  const article=el('article','config-page');
  const showSection=()=>{for(const section of article.querySelectorAll('[data-config-section]'))section.hidden=section.dataset.configSection!==state.configSection;
    for(const button of sections.querySelectorAll('button'))button.classList.toggle('active',button.dataset.section===state.configSection)};
  for(const [id,label] of [['PROJECT','故事项目'],['SYSTEM','系统与 AI']]){
    const button=nodeText('button',null,label,sections);button.type='button';button.dataset.section=id;button.onclick=()=>{state.configSection=id;showSection()};
  }
  layout.append(sections,article);root.append(layout);
  const data=state.configurations;
  for(const scope of ['SYSTEM','PROJECT']){const record=data.values[scope],section=el('section','config-section');
    section.dataset.configSection=scope;
    nodeText('h2','section-title',scope==='SYSTEM'?'系统与 AI 配置':'故事项目配置',section);
    nodeText('p','config-explanation',scope==='SYSTEM'?'系统功能和 AI 能力的通用选项，随版本演进。':'当前故事实例的创作阶段与背景，仅影响本实例。',section);
    nodeText('p','config-version',`配置版本 ${record.version} · Schema ${record.schema_version}`,section);
    const fields=data.catalog.scopes[scope],form=el('form');form.dataset.scope=scope;
    const effortOptions=data.catalog.model_efforts;let effortGroup;
    const radioChoices=(group,key,choices,selected)=>{group.replaceChildren();nodeText('legend',null,fields[key].label,group);
      const row=el('div','config-choice-row');for(const choice of choices){const label=el('label','config-choice');const input=el('input');input.type='radio';input.name=key;input.value=choice;input.checked=choice===selected;label.append(input,el('span',null,choice==='off'?'不适用':choice));row.append(label)}group.append(row)};
    for(const [key,spec] of Object.entries(fields)){
      if(spec.type==='model'||spec.type==='reasoning_effort'){const group=el('fieldset','config-choice-field');
        radioChoices(group,key,spec.type==='model'?Object.keys(effortOptions):effortOptions[record.body.ai_polish_model],record.body[key]);
        if(spec.type==='model')group.addEventListener('change',()=>{const model=form.elements.ai_polish_model.value,allowed=effortOptions[model];const current=form.elements.ai_polish_effort.value;radioChoices(effortGroup,'ai_polish_effort',allowed,allowed.includes(current)?current:allowed.includes('medium')?'medium':allowed[0])});
        else effortGroup=group;form.append(group);continue}
      const label=el('label','config-field');nodeText('span',null,spec.label,label);
      let input;if(spec.type==='long_text'){input=el('textarea');input.rows=4;input.value=record.body[key]}
      else if(spec.type==='stage'){input=el('select');for(const stage of state.framework.stages){const option=el('option',null,stage.label);option.value=stage.id;input.append(option)}input.value=record.body[key]}
      else{input=el('input');input.type=spec.type==='integer'?'number':'text';input.value=record.body[key]}
      if(spec.type==='env_name'){input.autocomplete='off';nodeText('small',null,'只保存环境变量名，不保存密钥；变量需由服务容器提供。',label)}
      input.name=key;label.append(input);form.append(label)}
    const save=nodeText('button','primary','保存配置',form);save.type='submit';form.onsubmit=async event=>{event.preventDefault();const updates={};for(const [key,spec] of Object.entries(fields)){let value=form.elements[key].value;if(spec.type==='integer')value=Number(value);updates[key]=value}
      try{await api(`/api/configurations/${scope}`,{method:'PATCH',body:JSON.stringify({expected_version:record.version,updates})});state.configurations=await api('/api/configurations');renderConfigurations();renderWorkspaceNav();renderStageLabel();toast('配置已保存')}
      catch(error){toast(error.message)}};
    section.append(form);article.append(section)}
  showSection()
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

function renderBlock(source,block,index){
  const p=el('p');p.dataset.blockId=block.id;p.id=`block-${block.id}`;
  const marks=blockMarks(source,block,index),length=chars(block.text).length;
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
  const source=state.current,root=$('#source-view');root.replaceChildren();if(!source)return;
  $('#reader-kind').textContent=source.version_type;
  $('#reader-head-title').textContent=source.title;
  $('#reader-head-detail').textContent=`${source.origin} · 采集于 ${source.collected_at}`;
  const doc=el('article','document');nodeText('div','overline','SOURCE DOCUMENT / 资料原文',doc);
  nodeText('h2',null,source.title,doc);nodeText('span','type-pill',source.version_type,doc);
  const meta=el('div','source-meta');
  for(const [label,value] of [['出处',source.origin],['采集日期',source.collected_at],['版本说明',source.edition||'—']]){const item=el('div');nodeText('b',null,label,item);nodeText('span',null,value,item);meta.append(item)}
  const item=el('div');nodeText('b',null,'来源页面',item);link('打开来源页面 ↗',source.source_url,item);meta.append(item);doc.append(meta);
  if(source.media){const media=el('section','source-media');nodeText('strong',null,source.media.file?'演出资料 · 本实例媒体':'演出资料 · 第三方平台',media);
    if(source.media.file){const url=`/assets/${encodeURIComponent(source.media.file)}`,player=el(source.media.kind==='video'?'video':'audio');player.controls=true;player.preload='metadata';player.src=url;if(source.media.kind==='video')player.playsInline=true;media.append(player);
      const download=el('a',null,`下载${source.media.kind==='video'?'视频':'音频'} ↓`);download.href=url;download.download=source.media.file;media.append(download)}
    if(source.media.url)link(source.media.label||'原始发布页面 ↗',source.media.url,media);
    nodeText('p',null,source.media.note||'请核对演出元数据和整理文本。',media);doc.append(media)}
  if(source.references?.length){const refs=el('section','source-references');nodeText('strong',null,'旁证与补充链接',refs);for(const reference of source.references){const row=el('p');link(reference.label,reference.url,row);refs.append(row)}doc.append(refs)}
  nodeText('p','intro',source.notes,doc);nodeText('h3','section-title',source.text_heading||'完整文本',doc);
  const text=el('section','source-text');text.id='source-text';text.setAttribute('aria-label','资料正文');
  source.blocks.forEach((block,index)=>text.append(renderBlock(source,block,index)));doc.append(text);
  if(source.assets.length){nodeText('h3','section-title','图片与出处',doc);const gallery=el('section','image-grid');
    for(const asset of source.assets){const figure=renderStructureVisual({id:asset.file,file:asset.file,title:asset.title,kind:'image',alt:asset.alt||asset.title,description:asset.note||''});
      if(asset.source_url)link('图片来源／制作依据 ↗',asset.source_url,figure.querySelector('figcaption'));gallery.append(figure)}doc.append(gallery)}
  root.append(doc);
  paintStructureRegions();
  watchSourceChapters();
}

function chooseSource(id,keepScroll=false,updateUrl=true,expandGroup=true){
  state.current=state.sources.find(s=>s.id===id)||state.sources[0];state.anchor=null;state.editing=null;state.selected=null;state.pending=null;state.sourceChapter=null;
  if(expandGroup&&state.current?.group)state.expandedGroups.add(state.current.group);
  if(sourceChapters(state.current).length)state.expandedSources.add(state.current.id);
  $('#selection-action').hidden=true;
  if(updateUrl&&state.current){const url=new URL(location.href);url.searchParams.set('source',state.current.id);history.replaceState(null,'',url)}
  renderSources();renderDocument();renderComments();if(!keepScroll)$('#source-view').scrollTop=0;
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
    touched.push({id:node.getAttribute(attribute),start:offsetIn(node,part.startContainer,part.startOffset),end:offsetIn(node,part.endContainer,part.endOffset)});
  }
  if(!touched.length)return null;
  const first=blocks.findIndex(b=>b.id===touched[0].id),last=blocks.findIndex(b=>b.id===touched.at(-1).id);
  if(first<0||last<first)return null;
  const start=touched[0].start,end=touched.at(-1).end;
  if(first===last&&end<=start)return null;
  const pieces=blocks.slice(first,last+1).map(b=>chars(b.text));pieces[0]=pieces[0].slice(start);pieces[pieces.length-1]=pieces.length===1?chars(blocks[first].text).slice(start,end):pieces[pieces.length-1].slice(0,end);
  const quote=pieces.map(p=>p.join('')).join('\n');if(!quote.trim())return null;
  return {block_id:blocks[first].id,end_block_id:blocks[last].id,start,end,quote};
}
function selectedAnchor(){
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
  const selection=getSelection(),range=selection.getRangeAt(0),host=$(isStructure()?'#structure-reader':isScript()?'#screenplay-reader':'#source-view'),bounds=selectionBounds(host);
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

function setPanelOpen(open){
  $('#comment-panel').hidden=!open;
  for(const trigger of ['#comments-toggle','#reader-comments','#screenplay-comments'])$(trigger).setAttribute('aria-expanded',String(open));
}
function openPanel(){setPanelOpen(true)}
function closePanel(){setPanelOpen(false)}
function togglePanel(){setPanelOpen($('#comment-panel').hidden)}
function startDraft(anchor,comment=null){state.anchor=anchor;state.editing=comment?.id||null;state.selected=comment?.id||null;state.suggestion=null;state.preview=null;state.previewExpanded=false;if(isScript())rememberScriptDraft();getSelection()?.removeAllRanges();hideSelectionAction();openPanel();renderActiveReader();renderComments();$('#comment-editor-text')?.focus()}
function abandonDraft(message){const key=draftKey();if(key)localStorage.removeItem(key);if(isScript())forgetScriptDraft();state.anchor=null;state.editing=null;state.selected=null;state.suggestion=null;state.preview=null;state.previewExpanded=false;state.pending=null;renderActiveReader();renderComments();toast(message)}

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
  for(const button of editor.querySelectorAll('.editor-actions button'))button.disabled=busy;
  editor.querySelector('[data-comment-submit]').disabled=busy||!textarea.value.trim();
  editor.querySelector('[data-polish]').disabled=busy||!textarea.value.trim();
}

function commentCard(comment){
  const card=el('article','comment-card'+(state.selected===comment.id?' selected':''));card.id=`comment-${comment.id}`;
  nodeText('small',null,(comment.status==='OPEN'?'待处理':'已关闭')+` · ${new Date(comment.updated_at).toLocaleString('zh-CN')}`,card);
  nodeText('q',null,anchorLabel(comment.anchor),card);if(comment.anchor_state?.valid===false)nodeText('p','structure-alert',`原引用已失效：${comment.anchor_state.reason}`,card);nodeText('p',null,comment.body,card);
  if(isScript())appendScriptCommentScope(card,comment);
  const actions=el('div','card-actions');
  const locate=nodeText('button',null,'定位原圈选',actions);locate.onclick=()=>locateComment(comment);
  if(comment.status==='OPEN'){
    const edit=nodeText('button',null,'编辑',actions);edit.onclick=()=>startDraft(comment.anchor,comment);
    const close=nodeText('button',null,'关闭评论',actions);close.onclick=()=>changeComment(comment,'CLOSE');
  }else{const reopen=nodeText('button',null,'重新打开',actions);reopen.onclick=()=>changeComment(comment,'REOPEN')}
  card.append(actions);return card;
}

function renderComments(){
  if(isScript())renderScriptCommentCounts();
  if((isScript()&&!scriptEpisode())||(!isStructure()&&!isScript()&&!state.current)){$('#comment-body').replaceChildren();$('#open-count').textContent='0';$('#comments-toggle').textContent='0';return;}const body=$('#comment-body');body.replaceChildren();
  const own=activeComments(),open=own.filter(c=>c.status==='OPEN'),closed=own.filter(c=>c.status==='CLOSED');
  $('#open-count').textContent=`${open.length} 待处理`;
  const older=isStructure()?state.comments.filter(c=>c.target_object_id==='story-structure'&&c.target_revision_id!==state.structureRevision&&c.status==='OPEN').length:0;
  $('#comments-toggle').textContent=isStructure()?`本稿评论 ${open.length} · 历史待决 ${older}`:`查看评论 · ${open.length}`;
  nodeText('p','comment-help',isStructure()?'选中文字、圈选图像或留下整体意见。评论始终绑定当前稿件修订。':isScript()?'选中动作或对白添加评论。意见与草稿绑定这个剧本版本的本集修订；关闭后仍保留历史。':'选中正文后添加评论。评论锚点绑定资料与原文区间；关闭后仍保留历史，可重新打开。',body);
  if(state.anchor){const editor=el('section','comment-editor');nodeText('strong',null,state.editing?'编辑评论':'添加新评论',editor);nodeText('q',null,anchorLabel(state.anchor),editor);
    const label=nodeText('label',null,'修改意见',editor);label.htmlFor='comment-editor-text';const textarea=el('textarea');textarea.id='comment-editor-text';textarea.value=localStorage.getItem(draftKey())??(state.editing?state.comments.find(c=>c.id===state.editing)?.body||'':'');
    textarea.addEventListener('input',()=>{localStorage.setItem(draftKey(),textarea.value);state.preview=null;state.previewExpanded=false;state.suggestion=null;updateCommentEditorControls()});editor.append(textarea);
    nodeText('small','comment-help','输入框内：⌘+Enter 提交／保存；Esc 取消并放弃未提交内容；Enter 换行。',editor);
    const actions=el('div','editor-actions'),save=nodeText('button','primary',state.editing?'保存修改':'提交评论',actions);save.dataset.commentSubmit='true';save.onclick=saveComment;
    const inspect=nodeText('button',null,'查看润色参考',actions);inspect.onclick=previewPolish;
    const polish=nodeText('button',null,'AI 润色修改意见',actions);polish.dataset.polish='true';polish.disabled=!textarea.value.trim();polish.onclick=polishComment;
    const collapse=nodeText('button',null,'收起草稿',actions);collapse.onclick=()=>{state.anchor=null;state.editing=null;state.suggestion=null;state.preview=null;state.previewExpanded=false;renderActiveReader();renderComments();toast('草稿已留在本机，重新圈选同一内容可继续编辑')};
    const cancel=nodeText('button','destructive',state.editing?'取消编辑':'取消本次评论',actions);cancel.onclick=()=>abandonDraft(state.editing?'未保存的编辑已放弃':'本次未提交评论已取消');editor.append(actions);
    bindCommentEditorShortcuts(textarea,{submit:save,cancel});
    if(state.preview){const basis=el('details','context-preview');basis.open=state.previewExpanded;basis.addEventListener('toggle',()=>{state.previewExpanded=basis.open});const summary=el('summary',null,'本次润色参考 · 可核对');basis.append(summary);
      const context=state.preview.context;nodeText('p',null,`创作阶段：${context.creative_stage.label}；故事背景：${context.story_background}；创作背景：${context.creative_background}`,basis);
      nodeText('p',null,`载体：${context.target_medium}；受众：${context.audience}；风格：${context.style}`,basis);
      nodeText('p',null,`当前圈选：${context.selected_quote}；上下文段落：${context.neighbor_blocks.map(b=>b.text).join(' / ')}`,basis);
      if(context.visual)nodeText('p',null,`图像／图示：${context.visual.title} · ${context.visual.file}；圈选点：${context.region_points?JSON.stringify(context.region_points):'整图'}`,basis);
      for(const doc of context.source_documents){const row=el('p');nodeText('strong',null,`${doc.title} · ${doc.version_type} · ${doc.truncated?'节选':'全文'}：`,row);nodeText('span',null,doc.text,row);basis.append(row)}
      nodeText('small',null,`上下文 SHA-256：${state.preview.context_sha256}`,basis);editor.append(basis)}
    if(state.suggestion){const preview=el('section','suggestion');nodeText('strong',null,'AI 建议 · 尚未保存',preview);nodeText('p',null,state.suggestion,preview);nodeText('small',null,'请核对是否引入未证实的史实或额外任务；采用后仍需手动保存。',preview);
      const apply=nodeText('button','secondary','采用到草稿',preview);apply.disabled=commentSaves.has(draftKey());apply.onclick=()=>{const accepted=state.suggestion;state.suggestion=null;localStorage.setItem(draftKey(),accepted);renderComments()};editor.append(preview)}body.append(editor);updateCommentEditorControls()}
  nodeText('h3',null,`未关闭评论 · ${open.length}`,body);if(!open.length)nodeText('p','empty','暂无待处理评论。圈选原文即可添加。',body);
  for(const comment of open)body.append(commentCard(comment));
  const head=el('div','history-head');nodeText('h3',null,`已关闭评论 · ${closed.length}`,head);
  const toggle=nodeText('button',null,state.historyOpen?'收起历史':'展开历史',head);toggle.onclick=()=>{state.historyOpen=!state.historyOpen;renderComments()};body.append(head);
  if(state.historyOpen){for(const comment of closed.slice(0,state.historyLimit))body.append(commentCard(comment));if(closed.length>state.historyLimit){const more=nodeText('button','secondary','显示更多',body);more.onclick=()=>{state.historyLimit+=20;renderComments()}}}
}

async function refreshComments(){
  const comments=await api('/api/comments');
  // Refocusing the window fetches comments asynchronously. A no-op refresh must not
  // replace the text nodes underneath a selection gesture (or the current editor).
  if(JSON.stringify(comments)===JSON.stringify(state.comments))return;
  state.comments=comments;renderActiveReader();renderComments();
}
async function saveComment(){
  const textarea=$('#comment-editor-text'),key=draftKey();
  if(!key||!textarea||textarea.disabled||textarea.readOnly||commentSaves.has(key))return;
  const text=textarea.value.trim();if(!text)return toast('请先填写修改意见');
  const editing=state.editing,request={id:crypto.randomUUID(),...commentTarget(),anchor:state.anchor,body:text};
  commentSaves.add(key);updateCommentEditorControls();
  try{
    if(editing){const c=state.comments.find(x=>x.id===editing);await api(`/api/comments/${c.id}`,{method:'PATCH',body:JSON.stringify({action:'EDIT',expected_version:c.version,body:text})})}
    else await api('/api/comments',{method:'POST',body:JSON.stringify(request)});
    localStorage.removeItem(key);
    if(draftKey()===key){if(isScript())forgetScriptDraft();state.anchor=null;state.editing=null;state.suggestion=null;state.preview=null;state.previewExpanded=false}
    await refreshComments();toast('评论已保存');
  }catch(error){toast(error.message)}
  finally{commentSaves.delete(key);updateCommentEditorControls()}
}
const sameDraft=(key,text)=>draftKey()===key&&$('#comment-editor-text')?.value.trim()===text;
async function polishComment(){
  const text=$('#comment-editor-text').value.trim();if(!text)return toast('请先填写修改意见');
  const key=draftKey(),request={...commentTarget(),anchor:state.anchor,body:text};
  $('[data-polish]').disabled=true;
  try{
    const preview=await api('/api/comments/polish-context',{method:'POST',body:JSON.stringify(request)});
    if(!sameDraft(key,text))return;
    state.preview=preview;state.previewExpanded=false;
    const result=await api('/api/comments/polish',{method:'POST',body:JSON.stringify({...request,expected_context_sha256:preview.context_sha256})});
    if(!sameDraft(key,text))return;
    state.suggestion=result.suggestion;renderComments();toast('润色建议已生成，原草稿未修改');
  }catch(error){if(sameDraft(key,text)){renderComments();toast(error.message)}}
}
async function previewPolish(){
  const text=$('#comment-editor-text').value.trim();if(!text)return toast('请先填写修改意见');
  const key=draftKey(),request={...commentTarget(),anchor:state.anchor,body:text};
  try{
    const preview=await api('/api/comments/polish-context',{method:'POST',body:JSON.stringify(request)});
    if(!sameDraft(key,text))return;
    state.preview=preview;state.previewExpanded=true;renderComments();$('#comment-editor-text').value=text;toast('已列出 AI 将参考的资料与创作上下文');
  }catch(error){if(sameDraft(key,text))toast(error.message)}
}
async function changeComment(comment,action){try{await api(`/api/comments/${comment.id}`,{method:'PATCH',body:JSON.stringify({action,expected_version:comment.version})});await refreshComments();toast(action==='CLOSE'?'评论已关闭':'评论已重新打开')}catch(error){toast(error.message)}}
function selectComment(id){state.selected=id;openPanel();renderActiveReader();renderComments();setTimeout(()=>$('#comment-'+escapeSelector(id))?.scrollIntoView({block:'nearest'}),0)}
function locateComment(comment){if(isScript())return locateScriptComment(comment);if(comment.anchor_state?.valid===false){toast(`原引用已失效：${comment.anchor_state.reason}`);return}if(comment.target_object_id==='story-structure'){if(!isStructure())switchWorkspace('story.outline');state.structureRevision=comment.target_revision_id;state.selected=comment.id;renderStructureReader();renderComments();const target=comment.anchor.type==='text'?document.querySelector(`[data-structure-block="${escapeSelector(comment.anchor.block_id)}"]`):comment.anchor.visual_id?document.querySelector(`[data-visual-id="${escapeSelector(comment.anchor.visual_id)}"]`):$('#structure-reader');if(!target){toast('原引用已失效；评论仍保留在原稿');return}(target.querySelector('.comment-mark.selected')||target).scrollIntoView({behavior:'smooth',block:'center'});target.classList.add('comment-flash');setTimeout(()=>target.classList.remove('comment-flash'),1600);return}state.selected=comment.id;renderDocument();renderComments();const block=$('#block-'+escapeSelector(comment.anchor.block_id));if(!block){toast('原引用已失效；评论仍保留');return}(block.querySelector('.comment-mark.selected')||block).scrollIntoView({behavior:'smooth',block:'center'})}

async function init(){try{
  const [instance,sources,comments,framework,configurations,structure,screenplays,summaries]=await Promise.all([api('/api/instance'),api('/api/sources'),api('/api/comments'),api('/api/framework'),api('/api/configurations'),api('/api/story-structure'),api('/api/screenplays'),api('/api/screenplay-summaries').catch(()=>({episodes:[]}))]);
  $('#instance-title').textContent=instance.title;document.title=`${instance.title} · 故事审阅台`;state.sources=sources.sort((a,b)=>Number(!!a.media)-Number(!!b.media)||(a.order||0)-(b.order||0)||a.id.localeCompare(b.id));state.comments=comments;state.framework=framework;state.configurations=configurations;state.structure=structure;state.structureRevision=structure.current_revision;state.screenplays=screenplays.versions;state.screenplaySummaries=new Map(summaries.episodes.map(item=>[item.object_id+':'+item.revision_id,item.summary]));
  renderStageLabel();
  const initialUrl=new URL(location.href);
  if(structure.revisions.some(r=>r.id===initialUrl.searchParams.get('structure_revision')))state.structureRevision=initialUrl.searchParams.get('structure_revision');
  chooseSource(initialUrl.searchParams.get('source')||state.sources[0]?.id,true,false,initialUrl.searchParams.has('source'));
  chooseScript(initialUrl.searchParams.get('script'),initialUrl.searchParams.get('episode'),initialUrl.searchParams.get('scene'),false);
  switchWorkspace(initialUrl.searchParams.get('workspace')||(initialUrl.searchParams.has('source')?'story.sources':'production.approach'),false);
  window.addEventListener('popstate',()=>{
    const url=new URL(location.href),source=url.searchParams.get('source');
    if(source&&source!==state.current?.id)chooseSource(source,true,false);
    const structureRevision=url.searchParams.get('structure_revision');
    if(state.structure.revisions.some(r=>r.id===structureRevision))state.structureRevision=structureRevision;
    if(url.searchParams.get('workspace')==='story.script'){
      const version=url.searchParams.get('script'),episode=url.searchParams.get('episode'),scene=url.searchParams.get('scene');
      if(version!==state.screenplayVersion||episode!==state.screenplayEpisode||scene!==state.screenplayScene)chooseScript(version,episode,scene,false);
    }
    switchWorkspace(url.searchParams.get('workspace')||(source?'story.sources':'production.approach'),false);
  });
  $('#brand-home').onclick=()=>location.assign('/');
  $('#reader-comments').onclick=togglePanel;$('#screenplay-comments').onclick=togglePanel;
  $('#open-story-script').onclick=()=>switchWorkspace('story.script');
  $('#source-search').oninput=event=>{state.query=event.target.value.trim().toLocaleLowerCase();renderSources(false)};
  $('#source-search').onkeydown=event=>{if(event.key==='Enter'){const first=$('#source-list .source-button');if(first){event.preventDefault();first.click()}}};
  $('#comments-toggle').onclick=togglePanel;$('#comments-close').onclick=closePanel;
  document.addEventListener('keydown',event=>{
    const panel=$('#comment-panel');if(event.key!=='Escape'||panel.hidden)return;
    event.preventDefault();const focusInside=panel.contains(document.activeElement);closePanel();
    if(focusInside)$('#comments-toggle').focus();
  });
  document.addEventListener('pointerdown',event=>{
    const panel=$('#comment-panel');
    if(panel.hidden||panel.contains(event.target)||$('#comments-toggle').contains(event.target)||$('#reader-comments').contains(event.target)||$('#screenplay-comments').contains(event.target))return;
    closePanel();
  });
  $('#selection-action').addEventListener('mousedown',event=>event.preventDefault());$('#selection-action').onclick=()=>{if(state.pending)startDraft(state.pending)};
  watchTextSelection();
  document.addEventListener('scroll',scheduleSourceChapter,{capture:true,passive:true});
  window.addEventListener('resize',scheduleSourceChapter);
  window.addEventListener('focus',()=>refreshComments().catch(()=>{}));
}catch(error){$('#source-view').textContent=`加载失败：${error.message}`}}
document.addEventListener('DOMContentLoaded',init,{once:true});
