/* Read, compare and discuss exact SKILL files. Authoring stays in the API. */
let methodView={category:'skill',selected:null,revision:null,requestedRevision:null,file:null,fileVersion:null,flowSelected:null,rootRevision:null,data:null,mode:'read',positions:{},stack:[],memories:{}};
let methodReadEpoch=0;
const isMethodsWorkspace=()=>state.workspace==='production.approach'&&new URL(location.href).searchParams.get('tab')==='foundation';
const isMethodsReading=()=>isMethodsWorkspace()&&!!methodView.document&&methodView.mode==='read';
const methodKey=()=>JSON.stringify([methodView.category,methodView.selected,methodView.revision,methodView.file]);
const methodStorageScope=()=>JSON.stringify([typeof REVIEW_DEPLOYMENT==='undefined'?'':REVIEW_DEPLOYMENT.publication_id,state.navigationInstanceId||'']);
function methodButton(parent,label,action){const b=nodeText('button',null,label,parent);b.type='button';b.onclick=action;return b}
function methodChoiceRow(parent,label,items,value,onChange){const row=el('div','method-choices');row.setAttribute('role','group');row.setAttribute('aria-label',label);parent.append(row);for(const [key,title]of items){const b=methodButton(row,title,()=>onChange(key));b.setAttribute('aria-pressed',String(key===value));b.classList.toggle('active',key===value)}return row}
function methodTitle(record){return record.payload.title||record.object_id}
function methodScene(){return Object.fromEntries(['category','selected','revision','requestedRevision','file','fileVersion','flowSelected','rootRevision'].map(k=>[k,methodView[k]]))}
function rememberMethodPosition(){if(methodView.document)methodView.positions[methodKey()]=window.scrollY;try{sessionStorage.setItem('method-reading',JSON.stringify({scope:methodStorageScope(),...methodScene(),positions:methodView.positions,stack:methodView.stack}))}catch{}}
window.addEventListener('scroll',()=>{if(isMethodsReading())rememberMethodPosition()},{passive:true});
function methodRoute(){const url=new URL(location.href);url.searchParams.set('workspace','production.approach');url.searchParams.set('tab','foundation');url.searchParams.delete('config_section');for(const key of ['method_group','method_range','method_file_type'])url.searchParams.delete(key);for(const [key,value]of Object.entries({method_category:methodView.category,method_object:methodView.selected,method_revision:methodView.revision||methodView.requestedRevision,method_file:methodView.file,method_file_version:methodView.fileVersion,method_node:methodView.flowSelected,method_node_revision:methodView.rootRevision})){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key)}history.replaceState(history.state,'',url);if(typeof rememberWorkspaceRoute==='function')rememberWorkspaceRoute()}
function methodEmbeddedResource(oid){return (methodView.rootRecord?.payload.resources||[]).some(ref=>ref.object_id===oid)}
function methodOpen(root,category,oid,rid,file,back=false,version=null){
 rememberMethodPosition();if(isMethodsReading()&&typeof rememberStoryDraft==='function')rememberStoryDraft();
 if(new URL(location.href).hash)history.replaceState(history.state,'',location.href.split('#')[0]);
 if(oid===methodView.flowSelected&&!rid&&!version)methodView.rootRevision=null;
 if(methodEmbeddedResource(oid))methodView.stack=[];else if(back)methodView.stack.push(methodScene());
 Object.assign(methodView,{category,selected:oid,revision:null,requestedRevision:rid,file,fileVersion:version,mode:'read',document:null});
 state.anchor=null;state.editing=null;state.selected=null;state.reviewCommentScope=null;hideSelectionAction();methodRoute();return drawMethods(root);
}
function methodSelectNode(root,id,file='SKILL.md'){methodView.stack=[];methodView.flowSelected=id;methodView.rootRevision=null;return methodOpen(root,'skill',id,null,file).then(()=>{if(matchMedia('(max-width:900px)').matches)methodView.content?.scrollIntoView({block:'start'})})}
async function renderMethods(root){
 const epoch=++methodReadEpoch;methodView.root=root;root.replaceChildren();const notice=nodeText('p','config-save-status','正在读取 SKILL…',root);
 try{const data=await api('/api/methods');if(epoch!==methodReadEpoch||!isMethodsWorkspace())return;methodView.data=data;return drawMethods(root)}catch(error){if(epoch===methodReadEpoch&&notice.isConnected){notice.textContent=error.message;methodButton(root,'重试读取',()=>renderMethods(root))}}
}
function methodFlow(parent,root){
 const flow=methodView.data.flow,nav=el('nav','skill-flow');nav.setAttribute('aria-label','创作基础流程');parent.append(nav);
 nodeText('h2',null,'基础流程',nav);const main=el('ol','skill-flow-main');nav.append(main);
 const draw=(entry,host)=>{const section=el('li','skill-flow-stage');section.dataset.flowNode=entry.id;host.append(section);const methods=entry.methods||[];const frame=el('div','skill-flow-frame');section.append(frame);const action=el('div','skill-flow-action');frame.append(action);
  if(methods.length===1){const m=methods[0],b=methodButton(action,entry.supports?m.title:entry.title,()=>methodSelectNode(root,m.object_id));b.dataset.methodNode=m.object_id;b.setAttribute('aria-current',String(m.object_id===methodView.flowSelected));b.classList.toggle('active',m.object_id===methodView.flowSelected)}
  else{nodeText('span','skill-flow-label',entry.title,action);if(methods.length){const choices=el('div','skill-flow-parallel');action.append(choices);let family=null,host=choices;for(const m of methods){if(m.group&&m.group!==family){family=m.group;host=el('div','skill-flow-family');choices.append(host);if(methods.filter(item=>item.group===family).length>1)nodeText('small','skill-flow-label',family,host)}const b=methodButton(host,m.title,()=>methodSelectNode(root,m.object_id,m.file));b.dataset.methodNode=m.object_id;const selected=m.object_id===methodView.flowSelected&&(!m.file||m.file===methodView.file);b.setAttribute('aria-current',String(selected));b.classList.toggle('active',selected)}}}

  if(entry.repeat?.methods?.length){const loop=el('div','skill-flow-repeat');action.append(loop);for(const m of entry.repeat.methods){const b=methodButton(loop,'↔ '+m.title,()=>methodSelectNode(root,m.object_id));b.setAttribute('aria-current',String(m.object_id===methodView.flowSelected));b.classList.toggle('active',m.object_id===methodView.flowSelected)}nodeText('small',null,entry.repeat.label,loop)}
  if(entry.output){nodeText('span','skill-flow-produce','产出',frame);nodeText('div','skill-flow-output',entry.output,frame);}
  for(const link of flow.returns||[])if(link.from===entry.id)nodeText('span','skill-flow-return','↶ '+link.label+' · '+flow.stages.find(n=>n.id===link.to).title,section);
 };
 for(const stage of flow.stages)draw(stage,main);
 const branches=el('ul','skill-flow-branches');nav.append(branches);for(const branch of flow.branches||[]){draw(branch,branches);nodeText('small','skill-flow-support','↖ '+(branch.support_label||branch.supports.map(id=>flow.stages.find(n=>n.id===id)?.title).filter(Boolean).join(' · ')),branches.lastElementChild)}
}
function methodFileTree(parent,record,directory,root,pinned=false){
 const group=el('section','skill-file-group');parent.append(group);nodeText('h3',null,record.payload.title,group);
 const current=directory.files.filter(f=>f.selected),removed=directory.files.filter(f=>!f.selected&&methodView.selected===record.object_id&&methodView.file===f.path);let lastFolder='';
 for(const item of [...current,...removed]){
  const file=item.path,folder=item.reading_group||file.split('/').slice(0,-1).join('/');if(folder!==lastFolder){if(folder)nodeText('p','skill-folder',folder,group);lastFolder=folder}
  const b=methodButton(group,(item.reading_label||file.split('/').at(-1))+(item.selected?'':' · 已移除'),()=>methodOpen(root,record.payload.format==='managed-method-skill-v1'?'skill':'resource',record.object_id,pinned&&item.selected?record.revision_id:null,file,false));
  b.title=file;b.dataset.methodPath=file;const active=methodView.selected===record.object_id&&methodView.file===file;b.classList.toggle('active',active);b.setAttribute('aria-current',String(active));
 }
}
async function drawMethods(root){
 const epoch=++methodReadEpoch;
 {const route=new URL(location.href).searchParams;
  if(route.has('method_object')){Object.assign(methodView,{category:route.get('method_category')||'skill',selected:route.get('method_object'),revision:route.get('method_revision'),requestedRevision:route.get('method_revision'),file:route.get('method_file'),fileVersion:Number(route.get('method_file_version'))||null,flowSelected:route.get('method_node')||((route.get('method_category')||'skill')==='skill'?route.get('method_object'):null),rootRevision:route.get('method_node_revision')});
   try{const saved=JSON.parse(sessionStorage.getItem('method-reading')||'null');if(saved?.scope===methodStorageScope()){methodView.positions=saved.positions||{};methodView.stack=saved.stack||[]}}catch{}
  }
 }
 const flow=methodView.data.flow;
 if(!methodView.selected){const first=[...flow.stages,...flow.branches||[]].flatMap(n=>n.methods||[])[0];if(first){methodView.selected=first.object_id;methodView.flowSelected=first.object_id;methodView.category='skill';methodView.file='SKILL.md'}}
 methodView.document=null;methodView.prose=null;renderComments();root.replaceChildren();const page=el('article','config-page methods-page skill-admin');root.append(page);methodView.page=page;methodView.root=root;
 const layout=el('div','skill-admin-layout');page.append(layout);methodFlow(layout,root);const content=el('section','skill-content');layout.append(content);methodView.content=content;

 if(!methodView.selected){nodeText('p',null,'此实例还没有已绑定的 SKILL。',content);return}
 const status=nodeText('p','config-save-status','正在读取准确文件…',content);status.setAttribute('role','status');
 const active=()=>epoch===methodReadEpoch&&page.isConnected&&isMethodsWorkspace();
 try{
  let rootId=methodView.flowSelected||methodView.selected;
  const record=await api('/api/methods/record?'+new URLSearchParams({object_id:rootId,...((methodView.rootRevision||(rootId===methodView.selected?methodView.requestedRevision:null))?{revision_id:methodView.rootRevision||methodView.requestedRevision}:{})}));if(!active())return;
  if(!methodView.flowSelected&&record.payload.format==='managed-method-skill-v1')methodView.flowSelected=rootId;
  methodView.rootRevision=record.revision_id;methodView.rootRecord=record;
  if(methodEmbeddedResource(methodView.selected))methodView.stack=[];
  if(methodView.stack.length&&!methodEmbeddedResource(methodView.selected))methodButton(content,'返回原阅读位置',()=>{rememberMethodPosition();if(isMethodsReading()&&typeof rememberStoryDraft==='function')rememberStoryDraft();Object.assign(methodView,methodView.stack.pop());state.anchor=null;state.editing=null;state.selected=null;drawMethods(root)});
  const own=await api('/api/methods/files?'+new URLSearchParams({object_id:record.object_id,revision_id:record.revision_id}));if(!active())return;
  const split=el('div','skill-reading-grid'),tree=el('nav','skill-file-tree');tree.setAttribute('aria-label','SKILL 文件结构');split.append(tree);
  methodFileTree(tree,record,own,root);
  // Exact source references keep their pinned package; ordinary own-file choices read latest.
  const refs=[...new Map((record.payload.resources||[]).map(r=>[r.revision_id,r])).values()];
  for(const ref of refs){const directory=await api('/api/methods/files?'+new URLSearchParams({object_id:ref.object_id,revision_id:ref.revision_id}));if(!active())return;methodView.data.referenced[ref.revision_id]=directory.record;methodFileTree(tree,directory.record,directory,root,true)}
  if(methodView.selected!==rootId&&!refs.some(r=>r.object_id===methodView.selected)){const directory=await api('/api/methods/files?'+new URLSearchParams({object_id:methodView.selected,...(methodView.requestedRevision?{revision_id:methodView.requestedRevision}:{})}));if(!active())return;methodFileTree(tree,directory.record,directory,root)}
  methodView.file ||= methodView.category==='skill'?'SKILL.md':own.files.find(f=>f.selected)?.path;
  const doc=await api('/api/methods/file?'+new URLSearchParams({object_id:methodView.selected,file:methodView.file,...(methodView.requestedRevision?{revision_id:methodView.requestedRevision}:{}),...(methodView.fileVersion?{version:methodView.fileVersion}:{})}));if(!active())return;
  for(const ref of doc.record.payload.resources||[]){if(!methodView.data.referenced[ref.revision_id]){const exact=await api('/api/methods/record?'+new URLSearchParams({object_id:ref.object_id,revision_id:ref.revision_id}));if(!active())return;methodView.data.referenced[ref.revision_id]=exact}}
  status.remove();methodView.document=doc;methodView.record=doc.record;methodView.revision=doc.record.revision_id;methodView.fileVersion=doc.file_version.version;
  nodeText('h2','skill-heading',methodTitle(record),content);content.append(split);
  const reader=el('div','skill-reader');split.append(reader);const heading=el('header','skill-file-heading');reader.append(heading);nodeText('h3',null,doc.file,heading);
  const tools=el('div','skill-file-tools');heading.append(tools);const comparison=methodButton(tools,'版本比较',()=>compareMethodFile(doc,comparison));comparison.disabled=doc.versions.length<2;
  methodChoiceRow(tools,'文件版本',doc.versions.map(v=>[v.version,'第 '+v.version+' 版']),doc.file_version.version,v=>methodOpen(root,methodView.category,doc.record.object_id,null,doc.file,false,v));
  methodButton(reader,'查看评论',()=>{openPanel();renderComments()});
  if(!doc.present)nodeText('p','production-issue','当前 SKILL 已移除或改名此文件；这里保留原文件历史。',reader);
  if(doc.record.payload.source)nodeText('p','method-source',doc.record.payload.source.files[doc.file]?.path||doc.file,reader);
  const prose=el('div','method-prose');prose.dataset.reviewRevision=doc.record.revision_id;prose.dataset.methodFile=doc.file;prose.dataset.reviewFile=doc.file;methodView.prose=prose;reader.append(prose);
  if(doc.media)renderMethodOriginal(prose,doc);else renderMethodBlocks(prose,doc,root);
  if(typeof restoreStoryDraft==='function')restoreStoryDraft();paintMethodComments();renderComments();methodRoute();window.scrollTo(0,methodView.positions[methodKey()]||0);rememberMethodPosition();restoreMethodAnchor();
 }catch(error){if(active()){status.textContent=error.message;if(!status.isConnected)content.append(status);methodButton(content,'重试准确文件',()=>drawMethods(root));if(methodView.requestedRevision)methodButton(content,'查看此文件的现存历史',()=>methodOpen(root,methodView.category,methodView.selected,null,methodView.file));methodRoute()}}
}
function renderMethodOriginal(parent,doc){
 const media=el(doc.media?.mime.startsWith('audio/')?'audio':doc.media?.mime.startsWith('video/')?'video':'img');
 media.src=doc.media?reviewURL('/api/methods/file-media?'+new URLSearchParams({object_id:doc.record.object_id,file:doc.file,version:doc.file_version.version})):'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(doc.content);
 if(media.tagName==='IMG')media.alt=doc.file;else{media.controls=true;media.preload='metadata'}
 media.onerror=()=>{media.remove();nodeText('p','production-issue','此版本的准确原件无法读取；未替换为其他原件。',parent);methodButton(parent,'重试原件',()=>{parent.replaceChildren();renderMethodOriginal(parent,doc)})};parent.append(media);
}
async function compareMethodFile(doc,trigger){
 const modal=openReviewDialog('版本比较 · '+doc.file,trigger,'method-comparison'),body=modal.body;let left=doc.versions[1].version,right=doc.versions[0].version,epoch=0;
 const selectors=el('div','method-compare-selectors'),result=el('div','method-diff');body.append(selectors,result);
 const options=doc.versions.map(v=>[v.version,'第 '+v.version+' 版']);
 const drawChoices=()=>{selectors.replaceChildren();for(const side of ['left','right']){const pane=el('section');nodeText('h3',null,side==='left'?'比较前':'比较后',pane);methodChoiceRow(pane,side==='left'?'左侧版本':'右侧版本',options,side==='left'?left:right,v=>{if(side==='left')left=v;else right=v;drawChoices();load()});selectors.append(pane)}};
 const load=async()=>{const request=++epoch;result.replaceChildren();const message=nodeText('p',null,'正在比较准确版本…',result);
  try{const data=await api('/api/methods/compare?'+new URLSearchParams({object_id:doc.record.object_id,file:doc.file,left,right}));if(request!==epoch||!modal.dialog.isConnected)return;result.replaceChildren();
   if(data.equal)nodeText('p','method-diff-equal','两版文件内容相同，无差异。',result);
   if(doc.media||/\.svg$/i.test(doc.file)){const originals=el('div','method-compare-originals');for(const [name,value]of [['左',data.left],['右',data.right]]){const pane=el('section');nodeText('h3',null,name+' · 第 '+value.file_version.version+' 版',pane);renderMethodOriginal(pane,value);originals.append(pane)}result.append(originals);return}
   if(data.equal)return;
   if(data.left.content.replace(/\r\n/g,'\n')===data.right.content.replace(/\r\n/g,'\n'))nodeText('p',null,'正文字符相同，差异来自行尾换行格式（CRLF / LF）。',result);
   if(data.left.content.endsWith('\n')!==data.right.content.endsWith('\n'))nodeText('p',null,(data.left.content.endsWith('\n')?'右':'左')+'侧版本的末行没有换行。',result);
   nodeText('p','method-diff-legend','− 删除　＋ 新增　未标记行保留上下文',result);
   const lines=el('div','method-diff-lines');result.append(lines);
   for(const change of data.changes){const add=(text,kind,index)=>{const row=el('div','method-diff-line '+kind);nodeText('span','method-diff-number',String(index),row);nodeText('span','method-diff-sign',kind==='removed'?'−':kind==='added'?'＋':' ',row);nodeText('pre',null,text.replace(/\r?\n$/,''),row);lines.append(row)};if(change.type==='equal')change.left.forEach((s,i)=>add(s,'context',change.left_start+i));else{change.left.forEach((s,i)=>add(s,'removed',change.left_start+i));change.right.forEach((s,i)=>add(s,'added',change.right_start+i))}}
  }catch(error){if(request===epoch&&modal.dialog.isConnected){message.textContent=error.message;methodButton(result,'重试比较',load)}}
 };drawChoices();await load();
}
function methodLink(root,doc,part,parent){
  const link=nodeText('a',null,part.text,parent),href=part.href;
  if(/^https:\/\//.test(href)){link.href=href;link.target='_blank';link.rel='noopener noreferrer';return}
  const raw=href.split('#')[0],hash=href.split('#')[1],base=doc.file.split('/').slice(0,-1),pieces=[...base,...raw.split('/')],out=[];for(const piece of pieces){if(piece==='..')out.pop();else if(piece&&piece!=='.')out.push(piece)}const path=out.join('/');
  const payload=doc.record.payload;
  if(payload.source&&(/\.(mp4|webm|mp3|wav|png|jpg|jpeg|webp)$/.test(href))){link.href=reviewURL('/api/methods/media?'+new URLSearchParams({object_id:doc.record.object_id,revision_id:doc.record.revision_id,file:doc.file,href}));link.target='_blank';link.rel='noopener';const media=el(/\.(mp3|wav)$/.test(href)?'audio':/\.(mp4|webm)$/.test(href)?'video':'img');media.src=link.href;if(media.tagName!=='IMG'){media.controls=true;media.preload='metadata'}else media.alt=part.text;media.onerror=()=>{media.remove();nodeText('p','production-issue','准确媒体未能读取，未替换为其他版本。',parent)};const figure=el('figure','approach-media');figure.append(media);parent.parentElement.append(figure);return;}
  let ref={category:methodView.category,object_id:doc.record.object_id,revision_id:doc.record.revision_id,file:raw?path:doc.file};
  if(!Object.hasOwn(payload.files,ref.file)){
    ref=null;
    const shared=path.match(/^shared\/(\d+)(?:\/(.+)|\.md)$/);
    for(const [index,r] of (payload.resources||[]).entries()){const resource=methodView.data.referenced[r.revision_id];
      if(shared&&Number(shared[1])!==index)continue;
      const wanted=shared?(shared[2]||resource?.payload.sections?.[r.section]):path;
      for(const file of Object.keys(resource?.payload.files||{}))if(file===wanted||resource.payload.source?.files[file]?.path===wanted){ref={category:'resource',object_id:r.object_id,revision_id:r.revision_id,file};break}if(ref)break
    }
  }
  const targetUrl=new URL(location.href);targetUrl.searchParams.set('workspace','production.approach');targetUrl.searchParams.set('tab','foundation');targetUrl.searchParams.delete('config_section');if(methodView.flowSelected)targetUrl.searchParams.set('method_node',methodView.flowSelected);if(methodView.rootRevision)targetUrl.searchParams.set('method_node_revision',methodView.rootRevision);if(ref){for(const [key,value] of Object.entries({method_category:ref.category,method_object:ref.object_id,method_revision:ref.revision_id,method_file:ref.file})){targetUrl.searchParams.set(key,value)}targetUrl.searchParams.delete('method_file_version');targetUrl.hash=hash?'method-section-'+hash:'';}link.href=ref?targetUrl.href:'#';link.onclick=e=>{e.preventDefault();if(!ref){toast('本准确包未包含此资料；请从源入口补取，未替换为最新版');return}
    if(ref.object_id===doc.record.object_id&&ref.file===doc.file&&hash){history.replaceState(history.state,'',targetUrl);restoreMethodAnchor();return}
    const reading=methodOpen(root,ref.category,ref.object_id,ref.revision_id,ref.file,true),epoch=methodReadEpoch;
    reading.then(()=>{if(epoch!==methodReadEpoch||!isMethodsReading()||methodView.document?.record.revision_id!==ref.revision_id||methodView.document.file!==ref.file)return;history.replaceState(history.state,'',targetUrl);restoreMethodAnchor();rememberWorkspaceRoute()});
  };

}
function renderMethodBlocks(parent,doc,root){
  if(/\.svg$/i.test(doc.file)){
    const body=doc.record.payload.files[doc.file],figure=el('figure','approach-media'),image=el('img');
    if(doc.blocks[0])figure.dataset.blockId=doc.blocks[0].id;
    image.alt=(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||doc.file).replace(/<[^>]*>/g,'').trim();
    image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(body);
    image.onerror=()=>{image.remove();nodeText('p','production-issue','准确图示无法显示；未替换为其他版本。',figure)};
    figure.append(image);parent.append(figure);reviewSurface(parent,'text');return;
  }
  let table=null,tableRow=null,lastRow=null;
  for(const block of doc.blocks){
    let node;
    if(block.type==='table-cell'){if(!table){table=el('table','approach-table');parent.append(table)}if(lastRow!==block.row){tableRow=el('tr');table.append(tableRow);lastRow=block.row}node=el('td');tableRow.append(node)}
    else{table=null;node=el(block.type==='heading'?'h'+Math.min(6,block.level+1):block.type==='code'?'pre':block.type==='quote'?'blockquote':'p',block.type==='list-item'?'method-list-item':null);parent.append(node)}
    node.dataset.blockId=block.id;
    if(block.type==='heading')node.dataset.section=block.section||block.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-');
    for(const part of block.parts){if(part.type==='link')methodLink(root,doc,part,node);else if(part.type==='image'){
        if(doc.record.payload.source&&/\.(png|jpg|jpeg|webp)$/.test(part.href)){methodLink(root,doc,part,node);continue;}
        nodeText('span',null,part.text,node);
        const path=part.href,files=doc.record.payload.files;
        const relative=[...doc.file.split('/').slice(0,-1),...path.split('/')].reduce((a,p)=>{if(p==='..')a.pop();else if(p&&p!=='.')a.push(p);return a},[]).join('/');
        if(files[relative]?.startsWith('<svg')||files[relative]?.includes('<svg')){const image=el('img');image.alt=part.text;image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(files[relative]);const figure=el('figure','approach-media');figure.append(image);parent.append(figure)}
      }else nodeText(part.type==='code'?'code':part.type==='strong'?'strong':'span',null,part.text,node)}
  }
  reviewSurface(parent,'text');
}
function paintMethodComments(){if(!isMethodsReading()||!methodView.prose)return;const doc=methodView.document;
  for(const node of methodView.prose.querySelectorAll('[data-block-id]')){for(const mark of node.querySelectorAll('.comment-mark'))mark.replaceWith(document.createTextNode(mark.textContent));node.normalize();const index=doc.blocks.findIndex(b=>b.id===node.dataset.blockId);for(const c of state.comments.filter(c=>c.target_revision_id===doc.record.revision_id&&c.anchor.file===doc.file))for(const r of textAnchorBlockRanges(c.anchor,doc.blocks,index))if(r.start<r.end)paintProductionTextMark(node,r.start,r.end,c)}paintReviewCommentCounts();
}
async function locateMethodComment(comment){
  const key=methodKey(),root=methodView.root;
  const record=await api('/api/methods/record?'+new URLSearchParams({object_id:comment.target_object_id,revision_id:comment.target_revision_id}));
  if(methodKey()!==key||!isMethodsReading())return false;
  await methodOpen(root,record.payload.format==='managed-method-skill-v1'?'skill':'resource',record.object_id,record.revision_id,comment.anchor.file,methodView.selected!==record.object_id||methodView.revision!==record.revision_id||methodView.file!==comment.anchor.file);
  if(!isMethodsReading()||methodView.document.record.revision_id!==comment.target_revision_id||methodView.document.file!==comment.anchor.file)return false;
  state.selected=comment.id;paintMethodComments();renderComments();methodView.prose?.querySelector('[data-block-id="'+CSS.escape(comment.anchor.block_id)+'"]')?.scrollIntoView({block:'center'});return true;
}
function appendMethodResponseAction(actions,comment,onSaved=null){
  methodButton(actions,'回应原意见',async()=>{
    const target=JSON.stringify(commentTarget());
    let current;
    try{current=await api('/api/methods/record?'+new URLSearchParams({object_id:comment.target_object_id}))}catch(error){if(actions.isConnected&&JSON.stringify(commentTarget())===target)toast('回应稿读取失败：'+error.message);return}
    if(!actions.isConnected||JSON.stringify(commentTarget())!==target)return;
    const modal=openReviewDialog('回应方法原意见',actions,'method-response'),dialog=modal.body;
    nodeText('blockquote',null,comment.body,dialog);nodeText('p',null,'回应关联原圈选与所选文件的准确当前稿；关闭评论仍由你决定。',dialog);
    let file=comment.anchor.file;
    if(!Object.hasOwn(current.payload.files,file)){
      nodeText('p','comment-help','当前稿已没有原文件 '+file+'。请选择回应实际对应的当前文件；原圈选仍保留原文件。',dialog);
      file='';const choice=el('div');dialog.append(choice);const draw=()=>{choice.replaceChildren();methodChoiceRow(choice,'回应所对应的当前文件',Object.keys(current.payload.files).map(name=>[name,name]),file,name=>{file=name;draw()})};draw();
    }
    const input=el('textarea');input.rows=5;input.setAttribute('aria-label','回应说明');dialog.append(input);const notice=nodeText('p','config-save-status','',dialog);
    const submit=methodButton(dialog,'保存回应',async()=>{submit.disabled=true;try{if(!file)throw Error('请选择回应实际对应的当前文件；输入仍保留。');await api('/api/methods/respond',{method:'POST',body:JSON.stringify({comment_id:comment.id,revision_id:current.revision_id,file,explanation:input.value})});modal.dialog.close();afterReviewDialogReturn(()=>{renderComments();onSaved?.()});toast('回应已保存，可复核原文与改动')}catch(error){notice.textContent=error.message;submit.disabled=false}});
  });
}

function restoreMethodAnchor(){
 if(!isMethodsReading())return;
 let hash;try{hash=decodeURIComponent(new URL(location.href).hash.slice(1)).replace(/^method-section-/, '')}catch{hash=new URL(location.href).hash.slice(1)}
 if(!hash)return;
 const target=[...methodView.prose.querySelectorAll('[data-section]')].find(n=>n.dataset.section===hash||n.dataset.section===hash.toLowerCase()||n.dataset.section===hash.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-')||n.dataset.section.replace(/-/g,'')===hash.toLowerCase().replace(/[-\s]/g,''));
 if(target)target.scrollIntoView({block:'start'});else if(!methodView.prose.querySelector('.method-anchor-issue'))nodeText('p','production-issue method-anchor-issue','此准确文件没有所指章节；保留原定位，未替换为其他章节。',methodView.prose);
}
