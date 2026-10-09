const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
// Real menu, route handlers and comment renderer; layout is synthetic, not browser acceptance.
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.className='';this.value='';this.scrollLeft=0;this.scrollTop=0;this.clientHeight=600;this.scrollHeight=12000;this.rect=()=>({top:0,bottom:600});
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
async function fixture(href=base,{internal=true,settle=true,historyState=null,navigation=false}={}){
  const root=new Element(),nodes=new Map(),storage=new Map(),listeners={},frames=new Map(),writes=[],scrolls=[],requests=[];let frame=0,pageY=0;
  for(const id of ['source-list','source-view','selection-action','comment-body','open-count','comments-toggle','toast','instance-title','story-creation-shell','story-workspace','screenplay-workspace','structure-workspace','configuration-view','approach-view','placeholder-view','production-view','open-story-sources','open-story-structure','open-story-script','view-title','view-symbol','brand-home','screenplay-comments','comments-close']){const n=new Element();n.id=id;root.append(n);nodes.set('#'+id,n)}
  const topbar=new Element();topbar.className='workspace-topbar';topbar.rect=()=>({top:0,bottom:70});root.append(topbar);
  const reader=nodes.get('#source-view');reader.rect=()=>({top:200-pageY,bottom:800-pageY});
  reader.scrollTo=value=>{reader.scrollTop=value.top;scrolls.push({container:'reader',top:value.top,visible:!nodes.get('#story-workspace').hidden})};
  const context={URL,console,CSS:{escape:x=>x},setTimeout:()=>0,clearTimeout(){},
    requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame},cancelAnimationFrame:id=>frames.delete(id),
    location:{href},history:{state:historyState,pushState(s,_t,url){this.state=s;context.location.href=String(url);writes.push({type:'push',url:String(url)})},replaceState(s,_t,url){this.state=s;if(String(url)!==context.location.href)writes.push({type:'replace',url:String(url)});context.location.href=String(url)}},
    document:{addEventListener(){},querySelector:s=>root.querySelector(s),querySelectorAll:s=>root.querySelectorAll(s),createElement:t=>new Element(t),createTextNode:t=>{const n=new Element('text');n.textContent=t;return n},scrollingElement:{scrollTop:0,scrollHeight:12000}},
    window:{innerHeight:800,addEventListener:(name,fn)=>listeners[name]=fn,scrollBy:value=>{pageY+=value.top;scrolls.push({container:'window',top:pageY,visible:!nodes.get('#story-workspace').hidden})},scrollTo(_x,y){pageY=y}},
    getSelection:()=>({removeAllRanges(){}}),getComputedStyle:()=>({overflowY:internal?'auto':'visible'}),
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(app,context);
  if(navigation){vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/navigation.js'),'utf8'),context);context.renderWorkspaceTabs=()=>{}}
  const framework={workspaces:['story.sources','story.outline','story.script','production.approach','project.configuration'].map(id=>({id,implemented:true}))};
  context.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({'/api/business-codes':{objects:[],types:[]},'/api/instance':{title:'Isolated'},'/api/sources?with_revision=1':JSON.parse(JSON.stringify(sources)),'/api/comments':[], '/api/framework':framework,'/api/configurations':{},'/api/configurations?summary=1':{},'/api/story-structure':{current_revision:null,revisions:[]},'/api/screenplays':{versions:[]},'/api/screenplays?metadata=1':{versions:[]},'/api/sources?with_revision=1&metadata=1':sources.map(({id,title,target_revision_id})=>({id,title,target_revision_id})),'/api/screenplay-summaries':{episodes:[]}}[url])}};
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
  const pop=(url,apply=true,s=null)=>{context.location.href=url;context.history.state=s;listeners.popstate({state:s});if(apply)flush()};
  const popAsync=async(url,apply=true,s=null)=>{context.location.href=url;context.history.state=s;await listeners.popstate({state:s});if(apply)flush()};
  return {context,root,nodes,reader,storage,frames,writes,scrolls,requests,flush,chapter,pop,popAsync};
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
  await f.popAsync(base+'&source_chapter=chapter-10');assert.equal(f.reader.scrollTop,5488);assert.ok(f.scrolls.every(x=>x.visible));
  f.reader.scrollTop=6000;f.context.switchWorkspace('project.configuration');f.context.switchWorkspace('story.sources');f.flush();assert.equal(f.reader.scrollTop,6000);
  f.pop(base+'&source_chapter=chapter-1',false);f.context.switchWorkspace('project.configuration');const before=f.scrolls.length;f.flush();assert.equal(f.scrolls.length,before);
});

test('passive highlighting preserves URL; an entry without a snapshot uses its accurate chapter',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-1');f.reader.scrollTop=5600;f.context.syncSourceChapter();assert.equal(f.context.state.sourceChapter,'chapter-10');assert.equal(new URL(f.context.location.href).searchParams.get('source_chapter'),'chapter-1');
  f.pop(base+'&source_chapter=chapter-1&structure_revision=unrelated');assert.equal(f.reader.scrollTop,488);assert.equal(f.writes.length,0);
});

test('nonstory entry loads no story text; entering the reader restores exact chapter and loads only once',async()=>{
  const f=await fixture('http://isolated/?workspace=project.configuration&source=refinement-b&source_chapter=chapter-10');
  assert.equal(f.requests.some(r=>r.url==='/api/sources?with_revision=1'),false);
  await f.context.switchWorkspace('story.sources');f.flush();
  assert.equal(f.context.state.current.id,'refinement-b');assert.equal(f.reader.scrollTop,5488);
  f.context.switchWorkspace('project.configuration');await f.context.switchWorkspace('story.sources');
  assert.equal(f.requests.filter(r=>r.url==='/api/sources?with_revision=1').length,1);
});

test('late first story load cannot replace a newer workspace and parallel entries share the read',async()=>{
  const f=await fixture('http://isolated/?workspace=project.configuration');
  const fetch=f.context.fetch;let release;const pending=new Promise(resolve=>release=resolve);
  f.context.fetch=async(...args)=>{if(args[0].startsWith('/api/sources'))await pending;return fetch(...args)};
  const first=f.context.switchWorkspace('story.sources'),second=f.context.switchWorkspace('story.outline');
  f.context.switchWorkspace('project.configuration');release();await Promise.all([first,second]);f.flush();
  assert.equal(f.context.state.workspace,'project.configuration');assert.equal(f.scrolls.length,0);
  assert.equal(f.requests.filter(r=>r.url==='/api/sources?with_revision=1').length,1);
  await f.context.switchWorkspace('story.sources');assert.equal(f.context.state.workspace,'story.sources');
});

test('failed first story read remains retryable without marking partial data ready',async()=>{
  const f=await fixture('http://isolated/?workspace=project.configuration'),fetch=f.context.fetch;
  f.context.fetch=async(...args)=>{if(args[0]==='/api/story-structure')throw Error('temporary read failure');return fetch(...args)};
  await f.context.switchWorkspace('story.sources');assert.equal(f.context.state.workspace,'project.configuration');
  f.context.fetch=fetch;await f.context.switchWorkspace('story.sources');f.flush();
  assert.equal(f.context.state.workspace,'story.sources');assert.equal(f.context.state.current.id,'plain');
});

// Controlled frame/response ordering supplements real browser history acceptance.
test('identical source URLs restore each entry snapshot, including long-block interior and reload',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-1'),c=f.context,href=c.location.href;
  f.reader.scrollTop=1400;c.rememberSourceReadingPosition();const a=JSON.parse(JSON.stringify(c.history.state));
  c.switchWorkspace('story.outline');c.switchWorkspace('story.sources');f.flush();
  assert.equal(c.location.href,href);f.reader.scrollTop=2200;c.rememberSourceReadingPosition();const b=JSON.parse(JSON.stringify(c.history.state));
  c.switchWorkspace('story.outline');f.pop(href,true,a);assert.equal(f.reader.scrollTop,1400);
  f.pop(href,true,b);assert.equal(f.reader.scrollTop,2200);f.pop(href,true,a);assert.equal(f.reader.scrollTop,1400);
  const reload=await fixture(href,{historyState:b});assert.equal(reload.reader.scrollTop,2200);
  // No URL cache may stand in for an entry without its own snapshot.
  f.pop(href,true,null);assert.equal(f.reader.scrollTop,488);
});

test('snapshot identity rejects a different source, revision or route and preserves other history state',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-10'),c=f.context;c.history.state={unrelated:{keep:42}};
  f.reader.scrollTop=6300;c.rememberSourceReadingPosition();assert.equal(c.history.state.unrelated.keep,42);
  const saved=JSON.parse(JSON.stringify(c.history.state));
  for(const field of ['source','revision','url']){const invalid=JSON.parse(JSON.stringify(saved));invalid.sourceReading[field]='different';f.pop(c.location.href,true,invalid);assert.equal(f.reader.scrollTop,5488)}
});

test('queued entry and ordinary tab restoration yield to the last same-URL chapter, comment or editor',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-10',{navigation:true}),c=f.context,href=c.location.href;
  f.reader.scrollTop=6200;c.rememberWorkspacePosition();const saved=JSON.parse(JSON.stringify(c.history.state));
  f.pop(href,false,saved);f.chapter('refinement-a','chapter-10').onclick();f.flush();assert.equal(f.reader.scrollTop,5488);
  c.restoreWorkspacePosition();f.chapter('refinement-a','chapter-10').onclick();f.flush();assert.equal(f.reader.scrollTop,5488);
  f.pop(href,false,saved);const comment={id:'old',target_object_id:'refinement-a',target_revision_id:'source-a-r1',anchor:{type:'text',block_id:'chapter-1',quote:'first'}};
  c.locateComment(comment);const block=f.root.querySelector('#block-chapter-1');assert.equal(block.located,true);const before=f.reader.scrollTop;f.flush();assert.equal(f.reader.scrollTop,before);
  f.pop(href,false,saved);c.startDraft(comment.anchor);const editor=f.root.querySelector('#comment-editor-text');editor.value='original source draft';editor.listeners.input();f.flush();assert.equal(editor.value,'original source draft');assert.equal(c.state.anchor,comment.anchor);assert.ok(f.requests.every(r=>!r.method));
});

test('layout changes use verified text within the block; missing text falls back to the accurate chapter',async()=>{
  const f=await fixture(base+'&source_chapter=chapter-10'),c=f.context;f.reader.scrollTop=6100;c.rememberSourceReadingPosition();
  const saved=JSON.parse(JSON.stringify(c.history.state));saved.sourceReading.layout=['old layout'];saved.sourceReading.point={block:'chapter-10',offset:1,quote:'confirmed',gap:4};
  const block=f.root.querySelector('#block-chapter-10');block.textContent='xconfirmed';let located=false;c.sourceTextPointRect=()=>{located=true;return {top:300}};
  f.pop(c.location.href,true,saved);assert.ok(located);assert.notEqual(f.reader.scrollTop,6100);
  saved.sourceReading.point.quote='changed text';located=false;f.pop(c.location.href,true,saved);assert.equal(located,false);assert.equal(f.reader.scrollTop,5488);
});

test('late history story-read success or failure cannot displace a newer workspace',async()=>{
  for(const failure of [false,true]){
    const f=await fixture('http://isolated/?workspace=project.configuration'),c=f.context,fetch=c.fetch;let release;const pending=new Promise(resolve=>release=resolve);
    c.fetch=async(...args)=>{if(args[0]==='/api/sources?with_revision=1'){await pending;if(failure)throw Error('late failure')}return fetch(...args)};
    const old=f.popAsync(base+'&source_chapter=chapter-10',false);c.switchWorkspace('production.approach');release();await old;f.flush();assert.equal(c.state.workspace,'production.approach');assert.equal(f.scrolls.length,0);
  }
});
