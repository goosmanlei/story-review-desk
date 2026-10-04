const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
// Actual script navigation, readers and shared editor; browser gestures are verified separately.
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
function fixture(){
 const root=new Element('main'),nodes=new Map(),storage=new Map(),messages=[],requests=[];
 for(const id of ['source-view','comment-panel','comment-body','open-count','comments-toggle','screenplay-comments','toast']){const node=new Element();node.id=id;root.append(node);nodes.set('#'+id,node)}
 Object.defineProperty(nodes.get('#toast'),'textContent',{set:v=>messages.push(v),get:()=>messages.at(-1)||''});
 const context={URL,console,setTimeout:()=>0,clearTimeout(){},getSelection:()=>({removeAllRanges(){}}),window:{addEventListener(){},getSelection:()=>({isCollapsed:true})},location:{href:'http://fixture/'},history:{pushState(){},replaceState(){}},
 document:{addEventListener(){},querySelector:s=>nodes.get(s)||root.querySelector(s),querySelectorAll:s=>root.querySelectorAll(s),createElement:tag=>new Element(tag),createTextNode:text=>{const node=new Element('text');node.textContent=text;return node}},
 localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},fetch:(...args)=>{requests.push(args);throw Error('unexpected HTTP')}};
 vm.createContext(context);for(const name of ['navigation.js','app.js','screenplay.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',name),'utf8'),context);
 vm.runInContext('globalThis.state=state;globalThis.key=draftKey;hideSelectionAction=()=>{};globalThis.reviewSurface=node=>node;',context);
 return {root,nodes,storage,messages,requests,context,state:context.state};
}
Element.prototype.focus=function(){this.focused=true};
Element.prototype.getBoundingClientRect=function(){return {left:0,right:100,top:0,bottom:100}};
function setup(){
  const f=fixture();
  for(const id of ['screenplay-index','screenplay-episodes','screenplay-scene-index','screenplay-reader','screenplay-overview','screenplay-head','screenplay-detail']){const e=new Element();e.id=id;f.nodes.set('#'+id,e);f.root.append(e)}
  const episode=(name,n)=>({object_id:'episode-'+name,id:'revision-'+name,payload:{number:n,title:'第'+n+'集 '+name,estimated_seconds:10,blocks:[{id:'block-'+name,text:'Technical scene '+name}],scenes:[{id:'s'+n,heading:n+'-1 Technical '+name,location:'Fixture',time:'Day',estimated_seconds:10,block_ids:['block-'+name]}]}});
  const a=episode('A',1),b=episode('B',2);
  Object.assign(f.state,{workspace:'story.script',screenplays:[{object_id:'script',payload:{title:'版本一'},episodes:[a,b]}],screenplayVersion:'script',screenplayEpisode:a.object_id,screenplayScene:'s1',comments:[],anchor:null,editing:null});
  f.context.history.pushState=(_s,_t,url)=>{f.context.location.href=url.href};
  f.context.location.href='http://fixture/?workspace=story.script&script=script&episode=episode-A&scene=s1';
  f.context.renderScriptIndex();f.context.renderScriptReader();f.context.renderComments();f.nodes.get('#comment-panel').hidden=true;
  return f;
}
const anchor={type:'text',block_id:'block-A',end_block_id:'block-A',start:0,end:9,quote:'Technical'};
const fail=name=>()=>{const error=Error(name);error.name=name;throw error};

test('quota in metadata keeps actual selection editor usable; comment save still requires durable body and request identity',async()=>{
 const f=setup();f.context.localStorage.setItem=fail('QuotaExceededError');
 assert.doesNotThrow(()=>f.context.startDraft(anchor));assert.equal(f.nodes.get('#comment-panel').hidden,false);
 const input=f.root.querySelector('#comment-editor-text');assert.ok(input);assert.deepEqual(f.state.anchor,anchor);assert.match(f.messages.at(-1),/定位信息保存失败.*仍可编辑.*可能无法恢复/);
 input.value='unique live opinion';assert.doesNotThrow(()=>input.listeners.input());await f.context.saveComment();
 assert.equal(f.root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'unique live opinion');assert.equal(f.requests.length,0);assert.match(f.messages.at(-1),/评论尚未发送.*当前输入仍保留/);
});
test('SecurityError during restore does not leave B target behind A reader or URL',()=>{
 const f=setup();for(const method of ['getItem','setItem','removeItem'])f.context.localStorage[method]=fail('SecurityError');
 assert.doesNotThrow(()=>f.nodes.get('#screenplay-episodes').children[1].onclick());
 assert.equal(f.state.screenplayEpisode,'episode-B');assert.match(f.nodes.get('#screenplay-reader').textContent,/Technical scene B/);assert.equal(new URL(f.context.location.href).searchParams.get('episode'),'episode-B');assert.equal(f.state.anchor,null);assert.match(f.messages.at(-1),/定位信息读取失败.*正文仍可阅读/);
});
for(const removeFails of [false,true])test(`invalid JSON cleanup ${removeFails?'unavailable':'available'} preserves actual episode navigation and unrelated draft`,()=>{
 const f=setup(),key='review-script-editor:revision-B';f.storage.set(key,'{broken');f.storage.set('review-draft:unrelated','keep');
 if(removeFails)f.context.localStorage.removeItem=fail('SecurityError');
 assert.doesNotThrow(()=>f.nodes.get('#screenplay-episodes').children[1].onclick());assert.match(f.nodes.get('#screenplay-reader').textContent,/Technical scene B/);assert.equal(f.state.anchor,null);assert.equal(f.storage.has(key),removeFails);assert.equal(f.storage.get('review-draft:unrelated'),'keep');
 if(removeFails)assert.match(f.messages.at(-1),/未能清理.*正文仍可阅读/);
});
test('exact episode revision restores its prior anchor and body after visiting another episode',()=>{
 const f=setup();f.context.startDraft(anchor);const key=f.context.key(),input=f.root.querySelector('#comment-editor-text');input.value='exact A opinion';input.listeners.input();
 f.nodes.get('#screenplay-episodes').children[1].onclick();assert.equal(f.state.anchor,null);f.nodes.get('#screenplay-episodes').children[0].onclick();
 assert.equal(JSON.stringify(f.state.anchor),JSON.stringify(anchor));assert.equal(f.context.key(),key);assert.equal(f.root.querySelector('#comment-editor-text').value,'exact A opinion');assert.equal(f.messages.length,0);
});
test('edit metadata still requires an existing comment on that exact episode revision',()=>{
 for(const revision of ['revision-A','revision-B']){const f=setup();f.state.comments=[{id:'edit-id',target_revision_id:revision}];f.storage.set('review-script-editor:revision-A',JSON.stringify({anchor,editing:'edit-id'}));f.context.restoreScriptDraft();assert.equal(f.state.editing,revision==='revision-A'?'edit-id':null);assert.equal(Boolean(f.state.anchor),revision==='revision-A')}
});
test('new revision never restores another episode revision metadata',()=>{
 const f=setup();f.storage.set('review-script-editor:older-A',JSON.stringify({anchor,editing:null}));f.context.restoreScriptDraft();assert.equal(f.state.anchor,null);assert.equal(f.storage.has('review-script-editor:older-A'),true);
});
test('failed metadata removal does not throw or alter body/pending identity',()=>{
 const f=setup();f.context.startDraft(anchor);const key=f.context.key();f.storage.set(key,'body');f.storage.set(key+':submission','pending-id');f.context.localStorage.removeItem=fail('SecurityError');
 assert.doesNotThrow(()=>f.context.forgetScriptDraft());assert.equal(f.storage.get(key),'body');assert.equal(f.storage.get(key+':submission'),'pending-id');assert.equal(f.storage.has('review-script-editor:revision-A'),true);assert.match(f.messages.at(-1),/未清理.*重新打开原位置/);
});
test('normal cancel still clears only current body and metadata through actual callback',()=>{
 const f=setup();f.context.startDraft(anchor);const key=f.context.key();f.storage.set(key,'body');f.storage.set(key+':submission','pending');f.storage.set('other-draft','keep');
 f.root.all().find(n=>n.textContent==='取消本次评论').onclick();assert.equal(f.state.anchor,null);assert.equal(f.root.querySelector('#comment-editor-text'),null);assert.equal(f.storage.has(key),false);assert.equal(f.storage.has(key+':submission'),false);assert.equal(f.storage.has('review-script-editor:revision-A'),false);assert.equal(f.storage.get('other-draft'),'keep');
});

test('same scene, episode and version clicks preserve the live editor and reading position',()=>{
 const f=setup(),reader=f.nodes.get('#screenplay-reader');f.context.startDraft(anchor);
 const input=f.root.querySelector('#comment-editor-text');input.value='live unsaved exact text';reader.scrollTop=310;
 const paragraph=reader.children[0];
 f.nodes.get('#screenplay-scene-index').children[0].onclick();
 f.nodes.get('#screenplay-episodes').children[0].onclick();
 f.nodes.get('#screenplay-index').children[0].onclick();
 assert.equal(reader.children[0],paragraph);assert.equal(reader.scrollTop,310);
 assert.equal(f.root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'live unsaved exact text');
});
test('scene positions restore by exact episode revision and scene without crossing versions',()=>{
 const f=setup(),reader=f.nodes.get('#screenplay-reader');reader.scrollTop=370;
 f.nodes.get('#screenplay-episodes').children[1].onclick();assert.equal(reader.scrollTop,0);reader.scrollTop=90;
 f.nodes.get('#screenplay-episodes').children[0].onclick();assert.equal(reader.scrollTop,370);
 f.context.renderScriptReader();assert.equal(reader.scrollTop,370);
 f.state.screenplays[0].episodes[0].id='new-revision-A';f.context.renderScriptReader();assert.equal(reader.scrollTop,0);
 f.nodes.get('#screenplay-episodes').children[1].onclick();assert.equal(reader.scrollTop,90);
});
test('clicking the active episode or version leaves a later scene selected',()=>{
 const f=setup(),ep=f.state.screenplays[0].episodes[0];
 ep.payload.blocks.push({id:'block-later',text:'Later exact scene'});
 ep.payload.scenes.push({id:'s-later',heading:'Later scene',location:'Fixture',time:'Night',estimated_seconds:10,block_ids:['block-later']});
 f.context.chooseScript('script',ep.object_id,'s-later');
 f.nodes.get('#screenplay-episodes').children[0].onclick();f.nodes.get('#screenplay-index').children[0].onclick();
 assert.equal(f.state.screenplayScene,'s-later');assert.match(f.nodes.get('#screenplay-reader').textContent,/Later exact scene/);
});
