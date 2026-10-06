const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const staticDir=process.env.READING_CONTEXT_STATIC||path.join(__dirname,'../review_desk/static');
// Exercise actual readers, comment rendering and callbacks; physical gestures,
// image loading and scroll visibility require the separate browser acceptance.
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.className='';this.hidden=false;this.value='';this.style={setProperty(){}};
    this.classList={contains:x=>this.className.split(' ').includes(x),add:x=>{if(!this.classList.contains(x))this.className+=' '+x},remove:x=>{this.className=this.className.split(' ').filter(y=>y!==x).join(' ')},toggle:(x,on)=>{on??=!this.classList.contains(x);on?this.classList.add(x):this.classList.remove(x)}}}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node)}}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes)}
  set textContent(value){this._text=String(value);this.children=[]}get textContent(){return (this._text||'')+this.children.map(n=>n.textContent).join('')}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='class')this.className=String(value)}getAttribute(key){return this.attrs[key]}
  addEventListener(key,callback){this.listeners[key]=callback}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  matches(s){const attrs=[...s.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];s=s.replace(/\[[^\]]+\]/g,'');
    for(const [,key,value] of attrs){const actual=key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_m,c)=>c.toUpperCase())]:this.attrs[key];if(actual===undefined||(value!==undefined&&actual!==value))return false}
    if(!s)return true;if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return s.slice(1).split('.').every(x=>this.classList.contains(x));return this.tag===s}
  querySelectorAll(selector){const parts=selector.split(' '),last=parts.pop();return this.all().filter(node=>{if(!node.matches(last))return false;let parent=node.parent;for(const part of [...parts].reverse()){while(parent&&!parent.matches(part))parent=parent.parent;if(!parent)return false;parent=parent.parent}return true})}
  querySelector(s){return this.querySelectorAll(s)[0]||null}
  closest(s){for(let node=this;node;node=node.parent)if(node.matches(s))return node;return null}
  scrollIntoView(options){this.scrolled=options}
}
const source=()=>({id:'source-a',target_revision_id:'source-rev',title:'Source A',version_type:'资料',origin:'technical fixture',collected_at:'2026-01-01',notes:'technical only',blocks:[{id:'paragraph',text:'Exact source text'}],assets:[{file:'original.png',title:'Original source image'}]});
function fixture(){
  const root=new Element('main'),nodes=new Map(),storage=new Map(),messages=[],events={};
  for(const id of ['source-view','reader-kind','reader-head-title','reader-head-detail','comment-panel','comment-body','open-count','comments-toggle','screenplay-comments','toast','structure-status','structure-index','structure-reader']){const node=new Element();node.id=id;root.append(node);nodes.set('#'+id,node)}
  const layout=new Element();nodes.set('#structure-workspace .structure-layout',layout);root.append(layout);
  Object.defineProperty(nodes.get('#toast'),'textContent',{set:v=>messages.push(v),get:()=>messages.at(-1)||''});
  const context={URL,console,CSS:{escape:x=>x},setTimeout:()=>0,clearTimeout(){},location:{href:'http://fixture/?workspace=story.sources'},history:{replaceState(){},pushState(){}},window:{addEventListener(){},getSelection:()=>({isCollapsed:true})},getSelection:()=>({removeAllRanges(){}}),
    document:{addEventListener:(name,fn)=>{(events[name]??=[]).push(fn)},querySelector:s=>nodes.get(s)||root.querySelector(s),querySelectorAll:s=>root.querySelectorAll(s),createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>{const n=new Element('text');n.textContent=text;return n}},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},fetch(){throw Error('no request is expected')}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);for(const file of ['app.js','structure.js','material-review.js'])vm.runInContext(fs.readFileSync(path.join(staticDir,file),'utf8'),context);
  vm.runInContext(`globalThis.state=state;globalThis.key=draftKey;globalThis.saves=commentSaves;hideSelectionAction=()=>{};watchSourceChapters=()=>{};watchStructureIndex=()=>{};globalThis.reviewSurface=node=>node;globalThis.scriptEpisode=()=>state.episode;globalThis.renderScriptCommentCounts=()=>{};globalThis.renderScriptReader=()=>{};globalThis.paintProductionReview=()=>{};globalThis.isEntityReview=()=>false;globalThis.forgetScriptDraft=()=>{};`,context);
  const state=context.state,current=source();Object.assign(state,{workspace:'story.sources',current,sources:[current],structure:{selection:{payload:{source_id:current.id}},revisions:[{id:'structure-rev',version:1,payload:{title:'Structure',sections:[],responses:[]},created_at:'fixture'}]},structureRevision:'structure-rev'});
  return {root,nodes,context,state,storage,messages,events};
}
function comment(anchor,extra={}){return {id:'opinion',target_object_id:'source-a',target_revision_id:'source-rev',anchor,anchor_state:{valid:true},body:'Technical opinion',status:'OPEN',updated_at:'2026-01-01',...extra}}
const visual={type:'visual',visual_id:'original.png',asset_file:'original.png'},region={...visual,type:'region',points:[{x:.1234,y:.2143},{x:.5432,y:.2143},{x:.5432,y:.8765}]};

test('no source clears stale reader headings and explains the next content step',()=>{
 const f=fixture();f.context.renderDocument();f.state.current=null;f.state.sources=[];f.context.renderDocument();
 assert.equal(f.nodes.get('#reader-head-title').textContent,'尚未登记资料');assert.equal(f.nodes.get('#reader-head-detail').textContent,'');assert.match(f.nodes.get('#source-view').textContent,/等待 Codex 准备资料/);
});
test('no direction has no impossible selection instructions; existing candidates remain selectable',()=>{
 const f=fixture();f.state.workspace='story.outline';f.state.structure={selection:null,revisions:[]};f.state.structureRevision=null;f.context.renderStructureReader();
 assert.match(f.nodes.get('#structure-status').textContent,/尚无扩写方向.*等待 Codex 准备候选/);assert.equal(f.nodes.get('#structure-status').querySelector('button'),null);
 f.state.sources=[{id:'choice',group:'expansion-directions',title:'Direction A'}];f.context.renderStructureReader();assert.ok(f.nodes.get('#structure-status').all().find(n=>n.textContent==='选用这个方向'));
});
test('selected direction without a manuscript uses its real title and no empty version or comment legend',()=>{
 const f=fixture();f.state.workspace='story.outline';f.state.structure.revisions=[];f.state.structureRevision=null;f.context.renderStructureReader();const text=f.nodes.get('#structure-status').textContent;
 assert.match(text,/已选「Source A」。等待 Codex 准备完整结构稿/);assert.doesNotMatch(text,/阅读版本|评论数|structure-import/);
});
for(const workspace of ['story.sources','story.outline','story.script','materials.workspace'])test(`${workspace}: absent exact target hides both triggers and closes an empty panel`,()=>{
 const f=fixture();Object.assign(f.state,{workspace,current:null,structureRevision:null,episode:null,productionSelected:null});f.nodes.get('#comment-panel').hidden=false;f.context.renderComments();
 assert.equal(f.nodes.get('#comments-toggle').hidden,true);assert.equal(f.nodes.get('#screenplay-comments').hidden,true);assert.equal(f.nodes.get('#comment-panel').hidden,true);assert.equal(f.nodes.get('#comment-body').textContent,'');
});
for(const workspace of ['story.sources','story.outline','story.script','materials.workspace'])test(`${workspace}: an exact target with zero comments keeps the shared entry`,()=>{
 const f=fixture();Object.assign(f.state,{workspace,episode:{object_id:'episode',id:'episode-rev'},productionSelected:{object_id:'plan',id:'plan-rev'}});f.context.renderComments();
 assert.equal(f.nodes.get('#comments-toggle').hidden,false);assert.equal(f.nodes.get('#screenplay-comments').hidden,workspace!=='story.script');assert.match(f.nodes.get('#comment-body').textContent,/暂无待处理评论/);
});
test('unknown structure revision has no target; a historical revision retains historical pending comments',()=>{
 const f=fixture();f.state.workspace='story.outline';f.state.structureRevision='missing';f.context.renderComments();assert.equal(f.nodes.get('#comments-toggle').hidden,true);
 f.state.structureRevision='structure-rev';f.state.comments=[comment({type:'global'},{target_object_id:'story-structure',target_revision_id:'older'})];f.context.renderComments();assert.equal(f.nodes.get('#comments-toggle').hidden,false);assert.match(f.nodes.get('#comments-toggle').textContent,/本稿评论 0 · 历史待决 1/);
});
for(const [workspace,anchor] of [['story.sources',{type:'text',block_id:'paragraph',end_block_id:'paragraph',start:0,end:5,quote:'Exact'}],['story.sources',visual],['story.sources',region],['story.outline',region],['story.script',{type:'text',block_id:'line',start:0,end:2,quote:'Hi'}],['materials.workspace',{type:'global'}]])test(`${workspace} ${anchor.type}: collapse and existing toggle reopen the exact draft without clearing pending metadata`,()=>{
 const f=fixture();Object.assign(f.state,{workspace,anchor:JSON.parse(JSON.stringify(anchor)),episode:{object_id:'episode',id:'episode-rev'},productionSelected:{object_id:'plan',id:'plan-rev'}});
 if(workspace==='materials.workspace'){const row=f.state.productionSelected;f.state.materialReview={record:{object_id:'need'},history:[],material_versions:{need:[{number:2,state:'preparing',members:[row],plan:row}]},selectedMaterialRounds:{need:2}}}
 const key=f.context.key(),snapshot=JSON.stringify(f.state.anchor);f.storage.set(key,'exact draft');f.storage.set(key+':discussion','true');f.storage.set(key+':submission',JSON.stringify({id:'pending',payload:{body:'exact draft'}}));
 f.context.openPanel();f.context.renderComments();const input=f.root.querySelector('#comment-editor-text'),collapse=f.root.all().find(n=>n.tag==='button'&&n.textContent==='收起草稿');collapse.onclick();
 assert.equal(f.nodes.get('#comment-panel').hidden,true);assert.equal(JSON.stringify(f.state.anchor),snapshot);assert.equal(f.context.key(),key);assert.equal(f.root.querySelector('#comment-editor-text'),input);
 f.context.toggleCommentsFromReader();assert.equal(f.nodes.get('#comment-panel').hidden,false);assert.equal(f.root.querySelector('#comment-editor-text').value,'exact draft');assert.equal(f.storage.get(key+':discussion'),'true');assert.ok(f.storage.get(key+':submission'));assert.ok(f.root.querySelector('.comment-submission-notice'));
});
test('collapse retains edit identity; cancel still drops only the current draft and pending copy',()=>{
 const f=fixture(),c=comment(visual);f.state.comments=[c];f.state.anchor=visual;f.state.editing=c.id;f.context.renderComments();const key=f.context.key();f.storage.set(key,'unsaved editing');f.context.renderComments();f.root.all().find(n=>n.textContent==='收起草稿').onclick();assert.equal(f.state.editing,c.id);assert.equal(f.context.key(),key);
 f.context.togglePanel();f.root.all().find(n=>n.textContent==='取消编辑').onclick();assert.equal(f.state.anchor,null);assert.equal(f.state.editing,null);assert.equal(f.storage.has(key),false);assert.equal(c.body,'Technical opinion');
});
test('busy submission keeps collapse disabled',()=>{const f=fixture();f.state.anchor=visual;const key=f.context.key();f.storage.set(key,'pending');f.context.saves.add(key);f.context.renderComments();assert.equal(f.root.all().find(n=>n.textContent==='收起草稿').disabled,true)});
for(const anchor of [visual,region])test(`source ${anchor.type} locator uses the actual source renderer and ignores a same-id visual elsewhere`,()=>{
 const f=fixture(),other=f.context.renderStructureVisual({id:'original.png',file:'other.png',title:'Other workspace'});f.root.append(other);const c=comment(anchor);f.state.comments=[c];f.context.locateComment(c);
 const stage=f.nodes.get('#source-view').querySelector('[data-visual-id="original.png"]');assert.equal(stage.closest('figure').dataset.reviewFile,'original.png');assert.equal(stage.scrolled.block,'center');assert.equal(other.querySelector('.structure-visual-stage').scrolled,undefined);assert.equal(f.messages.length,0);
 if(anchor.type==='region')assert.equal(stage.querySelector('polygon').getAttribute('points'),anchor.points.map(p=>`${p.x*100},${p.y*100}`).join(' '));
});
for(const type of ['text',undefined])test(`source ${type||'legacy text'} locator retains the exact selected text mark`,()=>{const f=fixture(),c=comment({type,block_id:'paragraph',end_block_id:'paragraph',start:0,end:5,quote:'Exact'});f.state.comments=[c];f.context.locateComment(c);const mark=f.nodes.get('#source-view').querySelector('.comment-mark.selected');assert.equal(mark.textContent,'Exact');assert.equal(mark.scrolled.block,'center')});
for(const [label,change,pattern] of [
 ['different source',f=>f.state.current.id='source-b',/请先打开原资料/],
 ['different workspace',f=>f.state.workspace='story.outline',/请先打开原资料/],
 ['different revision',f=>f.state.current.target_revision_id='source-new',/不是评论引用的修订/],
 ['missing asset',f=>f.state.current.assets=[],/原引用已失效/],
 ['different file',(_f,c)=>c.anchor.asset_file='other.png',/原引用已失效/],
 ['invalid image',(_f,c)=>c.anchor_state={valid:false,reason:'原图已失效'},/原引用已失效.*原图已失效/]
])test(`source visual locator rejects ${label} without selecting another image`,()=>{const f=fixture(),c=comment({...visual});f.context.renderDocument();change(f,c);assert.notEqual(f.context.locateComment(c),true);assert.equal(f.state.selected,null);assert.match(f.messages.at(-1),pattern);assert.equal(f.root.querySelector('.structure-visual-stage').scrolled,undefined)});

for(const scoped of [false,true])test(`storage failure: reader toggle preserves unique DOM input with scope reset ${scoped}`,()=>{
 const f=fixture();f.state.anchor=region;const key=f.context.key();f.storage.set(key,'old durable text');f.context.renderComments();const input=f.root.querySelector('#comment-editor-text');f.context.localStorage.setItem=()=>{throw Error('local storage unavailable')};input.value='unique live opinion';assert.doesNotThrow(()=>input.listeners.input());assert.match(f.messages.at(-1),/本机草稿保存失败.*当前输入仍保留/);if(scoped)f.state.reviewCommentScope={kind:'image',revision:'source-rev'};
 f.root.all().find(n=>n.textContent==='收起草稿').onclick();f.context.toggleCommentsFromReader();assert.equal(f.root.querySelector('#comment-editor-text').value,'unique live opinion');assert.equal(f.state.reviewCommentScope,null);assert.equal(f.storage.get(key),'old durable text');assert.equal(f.context.key(),key);if(!scoped)assert.equal(f.root.querySelector('#comment-editor-text'),input);
});
test('reader toggle never copies another exact target editor into a new source or revision',()=>{for(const changed of ['id','target_revision_id']){const f=fixture();f.state.anchor=region;f.context.renderComments();const input=f.root.querySelector('#comment-editor-text');input.value='A unique input';f.context.closePanel();f.state.current={...f.state.current,[changed]:'different-exact-target'};f.context.toggleCommentsFromReader();assert.notEqual(f.root.querySelector('#comment-editor-text'),input);assert.equal(f.root.querySelector('#comment-editor-text').value,'')}});
test('scope reset preserves a live plan comment draft when storage has failed',()=>{const f=fixture();Object.assign(f.state,{workspace:'materials.workspace',anchor:{type:'global'},productionSelected:{object_id:'plan',id:'plan-rev'}});const row=f.state.productionSelected;f.state.materialReview={record:{object_id:'need'},history:[],material_versions:{need:[{number:2,state:'preparing',members:[row],plan:row}]},selectedMaterialRounds:{need:2}};f.context.renderComments();f.context.localStorage.setItem=()=>{throw Error('storage failure')};const input=f.root.querySelector('#comment-editor-text');input.value='unsaved material opinion';assert.doesNotThrow(()=>input.listeners.input());assert.match(f.messages.at(-1),/本机草稿保存失败.*当前输入仍保留/);assert.equal(f.root.querySelector('#material-revision-intent'),null);f.state.reviewCommentScope={kind:'text'};f.context.closePanel();f.context.toggleCommentsFromReader();assert.equal(f.root.querySelector('#comment-editor-text').value,'unsaved material opinion');assert.equal(f.root.querySelector('#material-revision-intent'),null)});

test('structure reread and revision return retain independent scroll positions and exact document targets',()=>{
 const f=fixture();f.state.workspace='story.outline';
 const reader=f.nodes.get('#structure-reader');
 f.context.renderStructureReader();reader.scrollTop=480;
 f.context.renderStructureReader();assert.equal(reader.scrollTop,480);
 f.state.structure.revisions.push({id:'structure-other',version:2,payload:{title:'Another structure',sections:[],responses:[]},created_at:'fixture'});
 f.state.structureRevision='structure-other';f.context.renderStructureReader();assert.equal(reader.scrollTop,0);assert.match(reader.textContent,/Another structure/);reader.scrollTop=95;
 f.state.structureRevision='structure-rev';f.context.renderStructureReader();assert.equal(reader.scrollTop,480);assert.equal(reader.dataset.readingRevision,'structure-rev');
 f.state.structureRevision='structure-other';f.context.renderStructureReader();assert.equal(reader.scrollTop,95);
 assert.equal(f.nodes.get('#structure-index').querySelector('h2').textContent,'章节目录');
});
