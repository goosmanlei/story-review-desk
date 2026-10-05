const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
const structure=fs.readFileSync(path.join(__dirname,'../review_desk/static/structure.js'),'utf8');
// Real routing, version-button callbacks and comment renderer in a small DOM.
// Gesture, layout and browser history acceptance remain real-browser checks.
class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.className='';this.classList={add(){},remove(){},toggle(){}};this.value=''}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  setAttribute(name,value){this.attrs[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  focus(){}
  scrollIntoView(){this.scrolled=true}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  matches(s){if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));if(s==='[data-comment-submit]')return this.dataset.commentSubmit!==undefined;if(s==='[data-polish]')return this.dataset.polish!==undefined;return this.tag===s}
  querySelectorAll(s){if(s==='.editor-actions button')return this.all().filter(node=>node.tag==='button'&&node.parent?.className==='editor-actions');return this.all().filter(node=>node.matches(s))}
  querySelector(s){return this.querySelectorAll(s)[0]||null}
}
async function fixture(href='http://isolated/?workspace=story.outline',data={current_revision:'revision-10',revisions:[{id:'revision-10',version:10},{id:'revision-8',version:8}]}){
  const root=new Element('main'),nodes=new Map(),storage=new Map(),listeners={},pushes=[],requests=[];
  for(const selector of ['#comment-body','#open-count','#comments-toggle','#toast','#instance-title','#story-creation-shell','#story-workspace','#screenplay-workspace','#structure-workspace','#configuration-view','#approach-view','#placeholder-view','#production-view','#open-story-sources','#open-story-structure','#open-story-script','#view-title','#view-symbol','#brand-home','#screenplay-comments','#comments-close','#selection-action','#source-view','#structure-reader']){const node=new Element();node.id=selector.slice(1);nodes.set(selector,node);root.append(node)}
  const context={URL,console,CSS:{escape:x=>x},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    location:{href},history:{pushState(_state,_title,url){context.location.href=String(url);pushes.push(String(url))}},
    document:{addEventListener(){},querySelector:s=>root.querySelector(s)||nodes.get(s)||null,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createTextNode:text=>{const node=new Element('text');node.textContent=text;return node}},
    window:{addEventListener:(name,handler)=>listeners[name]=handler,scrollTo(){}},getSelection:()=>({removeAllRanges(){}}),
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    versions:new Element()};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(app,context);vm.runInContext(structure,context);
  const framework={workspaces:['story.outline','story.sources','story.script','production.approach','project.configuration'].map(id=>({id,implemented:true}))};
  context.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({'/api/business-codes':{objects:[],types:[]},'/api/instance':{title:'Isolated'},'/api/sources?with_revision=1':[{id:'source',target_revision_id:'source-revision',blocks:[]}],'/api/comments':[], '/api/framework':framework,'/api/configurations':{},'/api/story-structure':data,'/api/screenplays':{versions:[]},'/api/screenplay-summaries':{episodes:[]}}[url])}};
  vm.runInContext(`globalThis.state=state;globalThis.key=draftKey;
    applyFavicon=()=>{};renderWorkspaceNav=()=>{};closePanel=()=>{};openPanel=()=>{};hideSelectionAction=()=>{};scheduleSourceChapter=()=>{};watchTextSelection=()=>{};
    chooseSource=id=>{state.current=state.sources.find(source=>source.id===id)};chooseScript=()=>{};
    renderApproach=()=>{};renderConfigurations=()=>{};renderDocument=()=>{};
    restoreScriptDraft=()=>{};renderScriptIndex=()=>{};renderScriptReader=()=>{};`,context);
  const buttons=structure.split('\n').find(line=>line.includes('for(const revision of state.structure.revisions)'));
  context.renderStructureReader=()=>{context.versions.replaceChildren();if(context.state.structure)vm.runInContext(buttons,context)};
  await context.init();assert.doesNotMatch(nodes.get('#source-view').textContent||'',/^加载失败/);
  const button=id=>context.versions.children.find(node=>node.dataset.revisionId===id);
  const pop=url=>{context.location.href=url;listeners.popstate()};
  return {context,root,nodes,storage,pushes,requests,button,pop};
}

test('actual version buttons keep selected revision through refresh in both directions',async()=>{
  const f=await fixture('http://isolated/?workspace=story.outline&source=source&other=keep');
  f.button('revision-8').onclick();assert.equal(f.context.state.structureRevision,'revision-8');
  assert.equal(new URL(f.context.location.href).searchParams.get('structure_revision'),'revision-8');
  assert.equal(new URL(f.context.location.href).searchParams.get('other'),'keep');
  const old=await fixture(f.context.location.href);assert.equal(old.context.state.structureRevision,'revision-8');
  old.button('revision-10').onclick();const latest=await fixture(old.context.location.href);assert.equal(latest.context.state.structureRevision,'revision-10');
  assert.equal(f.pushes.length,1);assert.equal(old.pushes.length,1);
});

test('selecting the same revision neither adds history nor rebuilds an active editor',async()=>{
  const f=await fixture('http://isolated/?workspace=story.outline&structure_revision=revision-8');
  f.context.startDraft({type:'global'});const editor=f.root.querySelector('#comment-editor-text');editor.value='unique unsaved text';
  f.button('revision-8').onclick();assert.equal(f.root.querySelector('#comment-editor-text'),editor);assert.equal(editor.value,'unique unsaved text');assert.equal(f.pushes.length,0);
});

test('initial load and actual popstate use the same missing and invalid parameter fallback without history writes',async()=>{
  for(const query of ['?workspace=story.outline','?workspace=story.outline&structure_revision=missing']){
    const f=await fixture('http://isolated/?workspace=story.outline&structure_revision=revision-8');
    f.context.startDraft({type:'global'});const key=f.context.key();f.storage.set(key,'old revision draft');
    Object.assign(f.context.state,{editing:'old-comment',selected:'old-comment',suggestion:'old suggestion',preview:{},previewExpanded:true,pending:{},drawMode:'old-image',reviewCommentScope:{target_revision_id:'revision-8'}});
    f.pop('http://isolated/'+query);const fresh=await fixture('http://isolated/'+query);
    assert.equal(f.context.state.structureRevision,fresh.context.state.structureRevision);assert.equal(f.context.state.structureRevision,'revision-10');
    for(const name of ['anchor','editing','selected','suggestion','preview','pending','drawMode','reviewCommentScope'])assert.equal(f.context.state[name],null,name);
    assert.equal(f.context.state.previewExpanded,false);assert.equal(f.root.querySelector('#comment-editor-text'),null);assert.equal(f.storage.get(key),'old revision draft');assert.equal(f.pushes.length,0);
    f.pop('http://isolated/?workspace=story.outline&structure_revision=revision-8');assert.equal(f.context.state.structureRevision,'revision-8');assert.equal(f.pushes.length,0);
  }
});

test('normal cross-page return preserves the last structure choice and publishes it in the URL',async()=>{
  const f=await fixture();f.button('revision-8').onclick();
  for(const page of ['story.sources','production.approach']){
    f.context.switchWorkspace(page);f.context.switchWorkspace('story.outline');
    assert.equal(f.context.state.structureRevision,'revision-8');assert.equal(new URL(f.context.location.href).searchParams.get('structure_revision'),'revision-8');
  }
  f.pop('http://isolated/?workspace=story.sources');assert.equal(f.context.state.structureRevision,'revision-8');
  f.context.switchWorkspace('story.outline');assert.equal(new URL(f.context.location.href).searchParams.get('structure_revision'),'revision-8');
});

test('unrelated history navigation does not reset a source editor or hidden structure choice',async()=>{
  const f=await fixture('http://isolated/?workspace=story.outline&structure_revision=revision-8');
  f.context.switchWorkspace('story.sources');f.context.startDraft({type:'text',block_id:'b',quote:'source'});
  const anchor=f.context.state.anchor,editor=f.root.querySelector('#comment-editor-text');editor.value='source opinion';editor.listeners.input();
  f.pop('http://isolated/?workspace=story.sources&structure_revision=revision-10');
  assert.equal(f.context.state.anchor,anchor);assert.equal(f.context.state.structureRevision,'revision-8');assert.equal(f.root.querySelector('#comment-editor-text').value,'source opinion');
});

test('historical comment location writes its exact revision; same target does not duplicate history',async()=>{
  const f=await fixture();f.context.startDraft({type:'global'});
  const comment={id:'comment-eight',target_object_id:'story-structure',target_revision_id:'revision-8',anchor:{type:'global'},anchor_state:{valid:true},status:'OPEN',body:'old opinion',updated_at:'2026-01-01'};
  f.context.state.comments=[comment];f.context.locateComment(comment);
  assert.equal(f.context.state.structureRevision,'revision-8');assert.equal(f.context.state.selected,comment.id);assert.equal(f.context.state.anchor,null);
  assert.equal(new URL(f.context.location.href).searchParams.get('structure_revision'),'revision-8');assert.equal(f.nodes.get('#structure-reader').scrolled,true);assert.equal(f.pushes.length,1);
  f.context.locateComment(comment);assert.equal(f.pushes.length,1);
  const reload=await fixture(f.context.location.href);assert.equal(reload.context.state.structureRevision,'revision-8');
});

test('cross-workspace structure comment location adds one accurate route and invalid references retain the current revision',async()=>{
  const f=await fixture('http://isolated/?workspace=story.sources');
  const comment={id:'old',target_object_id:'story-structure',target_revision_id:'revision-8',anchor:{type:'global'},anchor_state:{valid:true}};
  f.context.locateComment(comment);assert.equal(f.pushes.length,1);assert.equal(f.context.state.workspace,'story.outline');assert.equal(new URL(f.context.location.href).searchParams.get('structure_revision'),'revision-8');
  f.context.locateComment({...comment,target_revision_id:'missing'});assert.equal(f.context.state.structureRevision,'revision-8');assert.equal(f.pushes.length,1);
  f.context.locateComment({...comment,target_revision_id:'revision-10',anchor_state:{valid:false,reason:'old quote changed'}});assert.equal(f.context.state.structureRevision,'revision-8');assert.equal(f.pushes.length,1);
});

test('real comment rendering keeps drafts and unconfirmed payloads tied to their original revision',async()=>{
  const f=await fixture('http://isolated/?workspace=story.outline&structure_revision=revision-8');
  f.context.startDraft({type:'global'});const oldKey=f.context.key(),oldInput=f.root.querySelector('#comment-editor-text');oldInput.value='old manuscript opinion';oldInput.listeners.input();
  const pending=JSON.stringify({id:'durable-id',payload:{target_object_id:'story-structure',target_revision_id:'revision-8',anchor:{type:'global'},body:oldInput.value}});f.storage.set(oldKey+':submission',pending);
  f.button('revision-10').onclick();assert.equal(f.root.querySelector('#comment-editor-text'),null);assert.equal(f.context.key(),null);
  f.context.startDraft({type:'global'});const currentKey=f.context.key();assert.notEqual(currentKey,oldKey);assert.equal(f.root.querySelector('#comment-editor-text').value,'');assert.equal(f.root.querySelector('.comment-submission-notice'),null);
  const currentInput=f.root.querySelector('#comment-editor-text');currentInput.value='new manuscript opinion';currentInput.listeners.input();
  f.button('revision-8').onclick();f.context.startDraft({type:'global'});assert.equal(f.root.querySelector('#comment-editor-text').value,'old manuscript opinion');assert.ok(f.root.querySelector('.comment-submission-notice'));
  assert.equal(f.storage.get(oldKey+':submission'),pending);assert.equal(f.storage.get(currentKey),'new manuscript opinion');assert.ok(f.requests.every(request=>!request.method));
});

test('missing structure data stays empty on initial load and history restoration',async()=>{
  const f=await fixture('http://isolated/?workspace=story.outline&structure_revision=missing',{current_revision:null,revisions:[]});
  assert.equal(f.context.state.structureRevision,null);f.pop('http://isolated/?workspace=story.outline');assert.equal(f.context.state.structureRevision,null);assert.equal(f.pushes.length,0);
});
