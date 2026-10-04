const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'../review_desk/static'),plain=value=>JSON.parse(JSON.stringify(value));
// Real initialization and navigation functions; rendering is observed by exact target/key.
// Browser layout and keyboard behavior remain separate checks.
class Node{
 constructor(){this.dataset={};this.hidden=false;this.value='';this.listeners={};this.classList={add(){},remove(){},toggle(){}};this.scrollTop=0}
 addEventListener(name,fn){this.listeners[name]=fn}setAttribute(){}focus(){}replaceChildren(){}append(){}
}
const sourceAnchor={type:'text',block_id:'source-block',end_block_id:'source-block',start:0,end:6,quote:'source'};
const structureAnchor={type:'text',block_id:'structure-block',end_block_id:'structure-block',start:0,end:9,quote:'structure'};
const scriptAnchor={type:'text',block_id:'script-block',end_block_id:'script-block',start:0,end:6,quote:'script'};
const meta=(workspace,revision)=>'review-story-editor:'+JSON.stringify([workspace,revision]);
async function fixture({href='http://fixture/?workspace=story.sources&source=source',storage=new Map()}={}){
 const nodes=new Map(),listeners={},renders=[],requests=[];
 const node=key=>{if(!nodes.has(key))nodes.set(key,new Node());return nodes.get(key)};
 const c={URL,URLSearchParams,console,setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},CSS:{escape:v=>v},
 location:{href},history:{pushState(_a,_b,url){c.location.href=String(url)},replaceState(_a,_b,url){c.location.href=String(url)}},
 document:{addEventListener(){},querySelector:selector=>selector==='#comment-editor-text'?null:node(selector),querySelectorAll:()=>[],createElement:()=>new Node()},
 window:{addEventListener:(name,fn)=>listeners[name]=fn,scrollTo(){}},getSelection:()=>({removeAllRanges(){}}),
 localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)}};
 vm.createContext(c);for(const name of ['app.js','structure.js','screenplay.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),c,{filename:name});
 const ep=n=>({object_id:'episode-'+n,id:'episode-r'+n,payload:{number:n,title:'第'+n+'集',scenes:[{id:'s00'+n,block_ids:['script-block']}],blocks:[{id:'script-block',text:'script'}]}});
 const data={'/api/instance':{title:'Fixture'},'/api/sources?with_revision=1':[{id:'source',target_revision_id:'source-r1',blocks:[{id:'source-block',text:'source'}]},{id:'other-source',target_revision_id:'other-source-r1',blocks:[{id:'other-source-block',text:'other'}]}],'/api/comments':[],
 '/api/framework':{workspaces:['story.sources','story.outline','story.script','project.configuration','production.approach'].map(id=>({id,implemented:true}))},'/api/configurations':{},'/api/story-structure':{current_revision:'structure-r2',revisions:[{id:'structure-r2',version:2},{id:'structure-r1',version:1}]},'/api/screenplays':{versions:[{object_id:'script',payload:{title:'剧本一'},episodes:[ep(1),ep(2)]}]},'/api/screenplay-summaries':{episodes:[]}};
 c.fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>plain(data[url])}};
 vm.runInContext(`globalThis.state=state;globalThis.draftKeyNow=draftKey;globalThis.targetNow=commentTarget;
 applyFavicon=()=>{};renderWorkspaceNav=()=>{};openPanel=()=>{};closePanel=()=>{};hideSelectionAction=()=>{};watchTextSelection=()=>{};scheduleSourceChapter=()=>{};restoreSourceChapter=()=>{};
 renderSources=()=>{};renderDocument=()=>{};renderStructureReader=()=>{};renderScriptIndex=()=>{};renderScriptReader=()=>{};renderApproach=()=>{};renderConfigurations=()=>{};`,c);
 c.renderComments=()=>renders.push({target:plain(c.targetNow()),anchor:plain(c.state.anchor),key:c.draftKeyNow(),body:storage.get(c.draftKeyNow())||''});
 await c.init();assert.doesNotMatch(node('#source-view').textContent||'',/^加载失败/);
 const draft=(anchor,body)=>{c.startDraft(plain(anchor));storage.set(c.draftKeyNow(),body);c.renderComments();return c.draftKeyNow()};
 const pop=href=>{c.location.href=href;listeners.popstate()};
 return {c,nodes,storage,renders,requests,draft,pop,data};
}
function savedSource(storage){storage.set(meta('story.sources','source-r1'),JSON.stringify({anchor:sourceAnchor,target:{source_id:'source',target_revision_id:'source-r1'}}));storage.set('review-draft:source:new:'+JSON.stringify(sourceAnchor),'novel draft')}
function savedScript(storage,revision='episode-r1'){storage.set('review-script-editor:'+revision,JSON.stringify({anchor:scriptAnchor}));storage.set('review-draft:'+revision+':new:'+JSON.stringify(scriptAnchor),'script draft')}
test('source and structure drafts return to their own exact revision across workspace changes',async()=>{
 const f=await fixture();const sourceKey=f.draft(sourceAnchor,'novel draft');f.c.switchWorkspace('story.outline');const structureKey=f.draft(structureAnchor,'structure draft');f.c.switchWorkspace('project.configuration');f.c.switchWorkspace('story.sources');
 assert.deepEqual(plain(f.c.state.anchor),sourceAnchor);assert.equal(f.c.draftKeyNow(),sourceKey);assert.equal(f.renders.at(-1).body,'novel draft');f.c.switchWorkspace('story.outline');assert.deepEqual(plain(f.c.state.anchor),structureAnchor);assert.equal(f.c.draftKeyNow(),structureKey);assert.equal(f.renders.at(-1).body,'structure draft');
});
test('structure revision history restores only its exact saved selection and body',async()=>{
 const f=await fixture({href:'http://fixture/?workspace=story.outline&structure_revision=structure-r1'});const first=f.draft(structureAnchor,'first revision draft');f.c.chooseStructureRevision('structure-r2');assert.equal(f.c.state.anchor,null);f.draft({type:'global'},'second revision draft');f.pop('http://fixture/?workspace=story.outline&structure_revision=structure-r1');assert.equal(f.c.draftKeyNow(),first);assert.equal(f.renders.at(-1).body,'first revision draft');f.pop('http://fixture/?workspace=story.outline&structure_revision=structure-r2');assert.equal(f.renders.at(-1).body,'second revision draft');
});
test('refreshing a source cannot replace its draft with a stored draft from the hidden screenplay',async()=>{
 const storage=new Map();savedSource(storage);savedScript(storage);const original=JSON.parse(storage.get(meta('story.sources','source-r1')));const f=await fixture({storage});
 assert.deepEqual(plain(f.c.state.anchor),sourceAnchor);assert.equal(f.renders.at(-1).body,'novel draft');const restored=JSON.parse(storage.get(meta('story.sources','source-r1')));assert.deepEqual(restored.anchor,original.anchor);assert.deepEqual(restored.target,original.target);
});
test('history entering another script episode cannot overwrite the source draft that is being left',async()=>{
 const f=await fixture();const sourceKey=f.draft(sourceAnchor,'novel stays mine');savedScript(f.storage,'episode-r2');f.pop('http://fixture/?workspace=story.script&script=script&episode=episode-2&scene=s002');assert.deepEqual(plain(f.c.state.anchor),scriptAnchor);f.pop('http://fixture/?workspace=story.sources&source=source');assert.deepEqual(plain(f.c.state.anchor),sourceAnchor);assert.equal(f.c.draftKeyNow(),sourceKey);assert.equal(f.renders.at(-1).body,'novel stays mine');
});
test('source metadata for another revision or another target is never restored',async()=>{
 const storage=new Map();savedSource(storage);storage.set(meta('story.sources','source-r1'),JSON.stringify({anchor:sourceAnchor,target:{source_id:'other-source',target_revision_id:'source-r1'}}));const f=await fixture({storage});assert.equal(f.c.state.anchor,null);const unchanged=storage.get(meta('story.sources','source-r1'));f.c.state.current.target_revision_id='source-r2';f.c.restoreStoryDraft();assert.equal(f.c.state.anchor,null);assert.equal(storage.get(meta('story.sources','source-r1')),unchanged);
});
test('cancel removes current source metadata without discarding a structure draft',async()=>{
 const f=await fixture();f.draft(sourceAnchor,'cancel source');f.c.switchWorkspace('story.outline');const structureKey=f.draft(structureAnchor,'keep structure');f.c.switchWorkspace('story.sources');f.c.abandonDraft('cancelled');assert.equal(f.storage.has(meta('story.sources','source-r1')),false);assert.equal(f.storage.get(structureKey),'keep structure');f.c.switchWorkspace('story.outline');assert.equal(f.renders.at(-1).body,'keep structure');
});
test('a comment save completing after leaving the source does not resurrect an empty draft on return',async()=>{
 const f=await fixture();const key=f.draft(sourceAnchor,'save this opinion');const editor={value:'save this opinion',disabled:false,readOnly:false};const query=f.c.document.querySelector;
 f.c.document.querySelector=selector=>selector==='#comment-editor-text'?(f.c.state.workspace==='story.sources'?editor:null):query(selector);
 f.c.crypto=require('node:crypto').webcrypto;f.c.updateCommentEditorControls=()=>{};f.c.refreshComments=async()=>{};
 let finish;f.c.fetch=()=>new Promise(resolve=>finish=()=>resolve({ok:true,json:async()=>({id:'saved'})}));
 const saving=f.c.saveComment();f.c.switchWorkspace('project.configuration');finish();await saving;assert.equal(f.storage.has(key),false);f.c.switchWorkspace('story.sources');assert.equal(f.c.state.anchor,null);assert.equal(f.storage.has(meta('story.sources','source-r1')),false);
});

test('an old comment response cannot remove a newer selection draft on the same source revision',async()=>{
 const f=await fixture();const oldKey=f.draft(sourceAnchor,'submitted opinion'),editor={value:'submitted opinion',disabled:false,readOnly:false,focus(){}};const query=f.c.document.querySelector;
 f.c.document.querySelector=selector=>selector==='#comment-editor-text'?(f.c.state.workspace==='story.sources'?editor:null):query(selector);
 f.c.crypto=require('node:crypto').webcrypto;f.c.updateCommentEditorControls=()=>{};f.c.refreshComments=async()=>{};
 let finish;f.c.fetch=()=>new Promise(resolve=>finish=()=>resolve({ok:true,json:async()=>({id:'saved'})}));const saving=f.c.saveComment();
 const nextAnchor={...sourceAnchor,start:1,end:5,quote:'ourc'},nextKey=f.draft(nextAnchor,'new opinion');editor.value='new opinion';finish();await saving;
 assert.equal(f.storage.has(oldKey),false);assert.equal(f.storage.get(nextKey),'new opinion');assert.deepEqual(JSON.parse(f.storage.get(meta('story.sources','source-r1'))).anchor,nextAnchor);assert.deepEqual(plain(f.c.state.anchor),nextAnchor);
 f.c.switchWorkspace('project.configuration');f.c.switchWorkspace('story.sources');assert.equal(f.c.draftKeyNow(),nextKey);assert.equal(f.renders.at(-1).body,'new opinion');
});
test('an old response cannot discard a newer body at the same anchor',async()=>{
 const f=await fixture();const key=f.draft(sourceAnchor,'submitted opinion'),editor={value:'submitted opinion',disabled:false,readOnly:false};const query=f.c.document.querySelector;
 f.c.document.querySelector=selector=>selector==='#comment-editor-text'?(f.c.state.workspace==='story.sources'?editor:null):query(selector);
 f.c.crypto=require('node:crypto').webcrypto;f.c.updateCommentEditorControls=()=>{};f.c.refreshComments=async()=>{};
 let finish;f.c.fetch=()=>new Promise(resolve=>finish=()=>resolve({ok:true,json:async()=>({id:'saved'})}));const saving=f.c.saveComment();editor.value='newer unsent opinion';f.storage.set(key,editor.value);f.c.switchWorkspace('project.configuration');finish();await saving;
 assert.equal(f.storage.get(key),'newer unsent opinion');assert.deepEqual(JSON.parse(f.storage.get(meta('story.sources','source-r1'))).anchor,sourceAnchor);f.c.switchWorkspace('story.sources');assert.equal(f.renders.at(-1).body,'newer unsent opinion');
});
test('existing source and structure comment edits keep exact comment identity and unsaved text across pages',async()=>{
 const f=await fixture(),sourceComment={id:'source-comment',target_object_id:'source',target_revision_id:'source-r1',anchor:sourceAnchor,body:'saved source'},structureComment={id:'structure-comment',target_object_id:'story-structure',target_revision_id:'structure-r2',anchor:structureAnchor,body:'saved structure'};f.c.state.comments=[sourceComment,structureComment];
 f.c.startDraft(sourceAnchor,sourceComment);const sourceKey=f.c.draftKeyNow();f.storage.set(sourceKey,'unsaved source edit');f.c.switchWorkspace('story.outline');f.c.startDraft(structureAnchor,structureComment);const structureKey=f.c.draftKeyNow();f.storage.set(structureKey,'unsaved structure edit');
 f.pop('http://fixture/?workspace=story.sources&source=source');assert.equal(f.c.state.editing,'source-comment');assert.equal(f.c.state.selected,'source-comment');assert.equal(f.c.draftKeyNow(),sourceKey);assert.equal(f.renders.at(-1).body,'unsaved source edit');
 f.pop('http://fixture/?workspace=story.outline&structure_revision=structure-r2');assert.equal(f.c.state.editing,'structure-comment');assert.equal(f.c.state.selected,'structure-comment');assert.equal(f.c.draftKeyNow(),structureKey);assert.equal(f.renders.at(-1).body,'unsaved structure edit');
});
test('two sources with the same text anchor retain separate draft bodies through history changes',async()=>{
 const f=await fixture();const first=f.draft({type:'global'},'first source draft');f.pop('http://fixture/?workspace=story.sources&source=other-source');assert.equal(f.c.state.anchor,null);const second=f.draft({type:'global'},'second source draft');assert.notEqual(first,second);
 f.pop('http://fixture/?workspace=story.sources&source=source');assert.equal(f.c.draftKeyNow(),first);assert.equal(f.renders.at(-1).body,'first source draft');f.pop('http://fixture/?workspace=story.sources&source=other-source');assert.equal(f.c.draftKeyNow(),second);assert.equal(f.renders.at(-1).body,'second source draft');
});
