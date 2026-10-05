const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
// Real menu, route handlers and comment renderer; layout is synthetic, not browser acceptance.
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.className='';this.value='';this.scrollTop=0;this.clientHeight=600;this.scrollHeight=12000;this.rect=()=>({top:0,bottom:600});
    this.classList={contains:x=>this.className.split(' ').includes(x),add:x=>{if(!this.classList.contains(x))this.className+=' '+x},remove:x=>{this.className=this.className.split(' ').filter(y=>y!==x).join(' ')},toggle:(x,on)=>{on??=!this.classList.contains(x);on?this.classList.add(x):this.classList.remove(x);return on}}}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  setAttribute(k,v){this.attrs[k]=v}
  removeAttribute(k){delete this.attrs[k]}
  addEventListener(k,fn){this.listeners[k]=fn}
  focus(){this.focused=true}
  scrollIntoView(){this.located=true}
  getBoundingClientRect(){return this.rect()}
  getClientRects(){return [this.rect()]}
  all(){return this.children.flatMap(n=>[n,...n.all()])}
  matches(s){const attrs=[...s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];s=s.replace(/\[[^\]]+\]/g,'');
    for(const [,key,value] of attrs){const actual=key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]:this.attrs[key];if(actual===undefined||(value!==undefined&&actual!==value))return false}
    if(!s)return true;if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return s.slice(1).split('.').every(x=>this.classList.contains(x));return this.tag===s}
  querySelectorAll(selector){const parts=selector.split(' '),last=parts.pop();return this.all().filter(node=>{if(!node.matches(last))return false;let parent=node.parent;for(const part of [...parts].reverse()){while(parent&&!parent.matches(part))parent=parent.parent;if(!parent)return false;parent=parent.parent}return true})}
  querySelector(s){return this.querySelectorAll(s)[0]||null}
}
const sources=[
  {id:'refinement-a',title:'故事精修一',group:'story-refinements',target_revision_id:'source-a-r1',blocks:[{id:'chapter-1',text:'第一章 开始'},{id:'chapter-10',text:'第十章 回家'},{id:'notes',text:'后记'}]},
  {id:'refinement-b',title:'故事精修二',group:'story-refinements',target_revision_id:'source-b-r2',blocks:[{id:'chapter-1',text:'第一章 另一稿'},{id:'chapter-10',text:'第十章 另一结尾'}]},
  {id:'plain',title:'资料',target_revision_id:'plain-r1',blocks:[{id:'chapter-10',text:'普通段落同名 ID'}]}
];
const base='http://isolated/?workspace=story.sources&source=refinement-a';
async function fixture(href=base,{internal=true,settle=true}={}){
  const root=new Element(),nodes=new Map(),storage=new Map(),listeners={},frames=new Map(),writes=[],scrolls=[],requests=[];let frame=0,pageY=0;
  for(const id of ['source-list','source-view','selection-action','comment-body','open-count','comments-toggle','toast','instance-title','story-creation-shell','story-workspace','screenplay-workspace','structure-workspace','configuration-view','approach-view','placeholder-view','production-view','open-story-sources','open-story-structure','open-story-script','view-title','view-symbol','brand-home','screenplay-comments','comments-close']){const n=new Element();n.id=id;root.append(n);nodes.set('#'+id,n)}
  const topbar=new Element();topbar.className='workspace-topbar';topbar.rect=()=>({top:0,bottom:70});root.append(topbar);
  const reader=nodes.get('#source-view');reader.rect=()=>({top:200-pageY,bottom:800-pageY});
  reader.scrollTo=value=>{reader.scrollTop=value.top;scrolls.push({container:'reader',top:value.top,visible:!nodes.get('#story-workspace').hidden})};
  const context={URL,console,CSS:{escape:x=>x},setTimeout:()=>0,clearTimeout(){},
    requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame},cancelAnimationFrame:id=>frames.delete(id),
    location:{href},history:{pushState(_s,_t,url){context.location.href=String(url);writes.push({type:'push',url:String(url)})},replaceState(_s,_t,url){context.location.href=String(url);writes.push({type:'replace',url:String(url)})}},
    document:{addEventListener(){},querySelector:s=>root.querySelector(s),querySelectorAll:s=>root.querySelectorAll(s),createElement:t=>new Element(t),createTextNode:t=>{const n=new Element('text');n.textContent=t;return n},scrollingElement:{scrollTop:0,scrollHeight:12000}},
    window:{innerHeight:800,addEventListener:(name,fn)=>listeners[name]=fn,scrollBy:value=>{pageY+=value.top;scrolls.push({container:'window',top:pageY,visible:!nodes.get('#story-workspace').hidden})},scrollTo(_x,y){pageY=y}},
    getSelection:()=>({removeAllRanges(){}}),getComputedStyle:()=>({overflowY:internal?'auto':'visible'}),
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(app,context);
  const framework={workspaces:['story.sources','story.outline','story.script','production.approach','project.configuration'].map(id=>({id,implemented:true}))};
  context.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({'/api/business-codes':{objects:[],types:[]},'/api/instance':{title:'Isolated'},'/api/sources?with_revision=1':JSON.parse(JSON.stringify(sources)),'/api/comments':[], '/api/framework':framework,'/api/configurations':{},'/api/story-structure':{current_revision:null,revisions:[]},'/api/screenplays':{versions:[]},'/api/screenplay-summaries':{episodes:[]}}[url])}};
  vm.runInContext(`globalThis.state=state;globalThis.key=draftKey;globalThis.saves=commentSaves;
    applyFavicon=()=>{};renderWorkspaceNav=()=>{};closePanel=()=>{};openPanel=()=>{};hideSelectionAction=()=>{};watchTextSelection=()=>{};
    chooseScript=()=>{};resolveStructureRevision=()=>null;chooseStructureRevision=()=>{};
    renderApproach=()=>{};renderConfigurations=()=>{};renderStructureReader=()=>{};
    restoreScriptDraft=()=>{};renderScriptIndex=()=>{};renderScriptReader=()=>{};renderScriptCommentCounts=()=>{};scriptEpisode=()=>null;`,context);
  context.renderDocument=()=>{reader.replaceChildren();const text=new Element('section');text.id='source-text';reader.append(text);
    for(const [index,block] of (context.state.current?.blocks||[]).entries()){const n=new Element('p');n.id='block-'+block.id;n.dataset.blockId=block.id;n.rect=()=>({top:200+500+index*5000-pageY-(internal?reader.scrollTop:0)});text.append(n)}
    context.scheduleSourceChapter()};
  const flush=()=>{let count=0;while(frames.size){assert.ok(++count<10,'frames settle');const pending=[...frames.values()];frames.clear();for(const fn of pending)fn()}};
  await context.init();assert.doesNotMatch(reader.textContent||'',/^加载失败/);if(settle)flush();
  const chapter=(source,id)=>root.querySelector(`.source-chapter-button[data-source-id="${source}"][data-block-id="${id}"]`);
  const pop=(url,apply=true)=>{context.location.href=url;listeners.popstate();if(apply)flush()};
  return {context,root,nodes,reader,storage,frames,writes,scrolls,requests,flush,chapter,pop};
}

test('real chapter menu writes exact source and refresh restores after the workspace becomes visible',async()=>{
  const f=await fixture();f.chapter('refinement-a','chapter-10').onclick();f.flush();
  assert.equal(new URL(f.context.location.href).searchParams.get('source_chapter'),'chapter-10');assert.equal(f.writes.length,1);assert.equal(f.writes[0].type,'push');assert.equal(f.reader.scrollTop,5488);
  const reload=await fixture(f.context.location.href,{settle:false});assert.equal(reload.scrolls.length,0);reload.flush();
  assert.equal(reload.reader.scrollTop,5488);assert.ok(reload.scrolls.every(x=>x.visible));assert.equal(reload.context.state.sourceChapter,'chapter-10');assert.equal(reload.writes.length,0);
  reload.chapter('refinement-a','chapter-10').onclick();reload.flush();assert.equal(reload.writes.length,0);
});

test('same source back/forward restores explicit chapters and the route without a chapter returns to the document start',async()=>{
  const f=await fixture();f.chapter('refinement-a','chapter-1').onclick();const one=f.context.location.href;f.chapter('refinement-a','chapter-10').onclick();const ten=f.context.location.href;
  f.pop(one);assert.equal(f.reader.scrollTop,488);f.pop(ten);assert.equal(f.reader.scrollTop,5488);f.pop(base);assert.equal(f.reader.scrollTop,0);assert.equal(f.writes.length,2);
});

test('narrow layout uses window and still restores the selected chapter',async()=>{
  const f=await fixture(base,{internal:false});f.chapter('refinement-a','chapter-10').onclick();f.flush();
  assert.equal(f.scrolls.at(-1).container,'window');assert.equal(f.scrolls.at(-1).top,5618);assert.equal(f.reader.scrollTop,0);
  const reload=await fixture(f.context.location.href,{internal:false});assert.equal(reload.scrolls.at(-1).container,'window');assert.equal(reload.scrolls.at(-1).top,5618);
});

test('ordinary source selection clears chapter; cross-source chapter selection creates one complete history item',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-10');f.context.chooseSource('refinement-b');
  assert.equal(new URL(f.context.location.href).searchParams.get('source'),'refinement-b');assert.equal(new URL(f.context.location.href).searchParams.has('source_chapter'),false);
  f.context.jumpSourceChapter('refinement-a','chapter-10');assert.equal(f.writes.length,2);assert.equal(f.writes[1].type,'push');
  assert.equal(new URL(f.writes[1].url).searchParams.get('source'),'refinement-a');assert.equal(new URL(f.writes[1].url).searchParams.get('source_chapter'),'chapter-10');
});

test('invalid source or chapter cannot borrow an unrelated source block or a nonchapter block',async()=>{
  for(const query of ['source=unknown&source_chapter=chapter-10','source=refinement-a&source_chapter=notes','source=refinement-a&source_chapter=missing','source=plain&source_chapter=chapter-10','source_chapter=chapter-10']){
    const f=await fixture('http://isolated/?workspace=story.sources&'+query);assert.equal(f.scrolls.length,0,query);assert.equal(f.writes.length,0);
    const current=f.context.state.current;f.context.jumpSourceChapter('missing','chapter-10');f.context.jumpSourceChapter('plain','chapter-10');f.context.jumpSourceChapter('refinement-a','notes');assert.equal(f.context.state.current,current);assert.equal(f.writes.length,0);
  }
  const f=await fixture(base+'&source_chapter=chapter-10');f.pop(base+'&source_chapter=notes');assert.equal(f.reader.scrollTop,0);
});

test('same-source chapter click and history preserve the actual editor node, anchor, edit ID, draft and busy state',async()=>{
  const f=await fixture();const comment={id:'saved-comment',anchor:{block_id:'chapter-1',quote:'quote'},body:'old opinion'};
  f.context.startDraft(comment.anchor,comment);const editor=f.root.querySelector('#comment-editor-text');editor.value='new unique opinion';editor.listeners.input();const key=f.context.key(),anchor=f.context.state.anchor;
  f.context.saves.add(key);f.context.updateCommentEditorControls();assert.equal(editor.readOnly,true);
  f.chapter('refinement-a','chapter-10').onclick();f.flush();f.pop(base+'&source_chapter=chapter-1');
  assert.equal(f.root.querySelector('#comment-editor-text'),editor);assert.equal(editor.value,'new unique opinion');assert.equal(editor.readOnly,true);assert.equal(f.context.state.anchor,anchor);assert.equal(f.context.state.editing,'saved-comment');assert.equal(f.context.key(),key);assert.equal(f.storage.get(key),'new unique opinion');
});

test('cross-source drafts and unconfirmed submissions remain with the original exact source',async()=>{
  const f=await fixture();f.context.startDraft({block_id:'chapter-1',quote:'first'});const editor=f.root.querySelector('#comment-editor-text');editor.value='source A opinion';editor.listeners.input();const key=f.context.key(),pending='{"id":"one-operation","payload":{}}';f.storage.set(key+':submission',pending);
  f.context.chooseSource('refinement-b');assert.equal(f.root.querySelector('#comment-editor-text'),null);f.context.startDraft({block_id:'chapter-1',quote:'first'});assert.notEqual(f.context.key(),key);assert.equal(f.root.querySelector('#comment-editor-text').value,'');
  f.context.chooseSource('refinement-a');f.context.startDraft({block_id:'chapter-1',quote:'first'});assert.equal(f.root.querySelector('#comment-editor-text').value,'source A opinion');assert.equal(f.storage.get(key+':submission'),pending);
  assert.ok(f.requests.every(r=>!r.method));
});

test('pending route scroll yields to actual comment location, editor changes and rapid route changes',async()=>{
  const f=await fixture();f.pop(base+'&source_chapter=chapter-10',false);
  const comment={id:'location',target_object_id:'refinement-a',target_revision_id:'source-a-r1',anchor:{type:'text',block_id:'chapter-1',quote:'first'},anchor_state:{valid:true}};f.context.locateComment(comment);const block=f.root.querySelector('#block-chapter-1');assert.equal(block.located,true);const before=f.scrolls.length;f.flush();assert.equal(f.scrolls.length,before);
  f.pop(base+'&source_chapter=chapter-1',false);f.context.startDraft({block_id:'chapter-10',quote:'new choice'});const beforeDraft=f.scrolls.length;f.flush();assert.equal(f.scrolls.length,beforeDraft);
  f.pop(base+'&source_chapter=chapter-10',false);f.pop(base+'&source_chapter=chapter-1',false);f.flush();assert.equal(f.reader.scrollTop,488);
});

test('hidden source does not scroll; cross-workspace history applies only after it is visible; manual return keeps the live position',async()=>{
  const hidden='http://isolated/?workspace=project.configuration&source=refinement-a&source_chapter=chapter-10',f=await fixture(hidden);assert.equal(f.scrolls.length,0);
  f.pop(base+'&source_chapter=chapter-10');assert.equal(f.reader.scrollTop,5488);assert.ok(f.scrolls.every(x=>x.visible));
  f.reader.scrollTop=6000;f.context.switchWorkspace('project.configuration');f.context.switchWorkspace('story.sources');f.flush();assert.equal(f.reader.scrollTop,6000);
  f.pop(base+'&source_chapter=chapter-1',false);f.context.switchWorkspace('project.configuration');const before=f.scrolls.length;f.flush();assert.equal(f.scrolls.length,before);
});

test('passive scroll highlighting and unrelated same-source history do not write routes or move the reader',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-1');f.reader.scrollTop=5600;f.context.syncSourceChapter();assert.equal(f.context.state.sourceChapter,'chapter-10');assert.equal(new URL(f.context.location.href).searchParams.get('source_chapter'),'chapter-1');
  f.pop(base+'&source_chapter=chapter-1&structure_revision=unrelated');assert.equal(f.reader.scrollTop,5600);assert.equal(f.writes.length,0);
});
