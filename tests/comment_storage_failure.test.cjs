const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {fixture}=require('./comment-persistence-fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
// Minimal DOM calls the real renderer; it is not browser or gesture acceptance.
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.classList={add(){},remove(){}};this.listeners={};this.className=''}
  append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes)}
  setAttribute(name,value){this.attrs[name]=value}
  addEventListener(name,callback){this.listeners[name]=callback}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  matches(s){if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));if(s==='[data-comment-submit]')return this.dataset.commentSubmit!==undefined;if(s==='[data-polish]')return this.dataset.polish!==undefined;return this.tag===s}
  querySelectorAll(s){if(s==='.editor-actions button')return this.all().filter(node=>node.tag==='button'&&node.parent?.className==='editor-actions');return this.all().filter(node=>node.matches(s))}
  querySelector(s){return this.querySelectorAll(s)[0]||null}
}
function actualEditor(f){
  const root=new Element('main');
  for(const id of ['comment-body','open-count','comments-toggle','toast']){const node=new Element('div');node.id=id;root.append(node)}
  f.context.document={querySelector:s=>root.querySelector(s),createElement:tag=>new Element(tag),createTextNode:text=>{const node=new Element('text');node.textContent=text;return node}};
  const start=source.indexOf('function renderComments(){'),end=source.indexOf('\nasync function refreshComments(){',start);vm.runInContext(source.slice(start,end),f.context);
  return root;
}
for(const workspace of ['story.sources','story.outline','materials.workspace'])for(const failure of ['draft','submission']){
  test(`${workspace}: ${failure} storage failure preserves the actual editor, unique input and feedback choice`,async()=>{
    const f=fixture(),key=workspace==='materials.workspace'?f.material(2):f.target(workspace),root=actualEditor(f);
    if(f.context.state.materialReview)f.context.state.materialReview.history=[];
    f.storage.set(key,'older durable text');f.context.renderComments();
    const textarea=root.querySelector('#comment-editor-text'),editor=root.querySelector('.comment-editor'),intent=root.querySelector('#material-revision-intent');
    const typed='new unique unsaved opinion';textarea.value=typed;if(intent)intent.checked=false;
    const set=f.context.localStorage.setItem;f.context.localStorage.setItem=(k,v)=>{if(k===(failure==='draft'?key:key+':submission'))throw Error('quota exceeded');return set(k,v)};
    if(failure==='draft')assert.throws(()=>textarea.listeners.input(),/quota/);
    await f.context.saveComment();
    assert.equal(root.querySelector('.comment-editor'),editor);assert.equal(root.querySelector('#comment-editor-text'),textarea);assert.equal(textarea.value,typed);assert.equal(textarea.readOnly,false);
    assert.equal(f.requests.length,0);assert.match(root.querySelector('#toast').textContent,/本机草稿保存失败.*尚未发送/);
    assert.equal(root.querySelector('.comment-submission-notice'),null);
    if(intent){assert.equal(root.querySelector('#material-revision-intent'),intent);assert.equal(intent.checked,false);assert.equal(intent.disabled,false)}
    assert.equal(f.storage.get(key),failure==='draft'?'older durable text':typed);
    f.context.localStorage.setItem=set;await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.requests[0].body).body,typed);
    if(intent)assert.equal(JSON.parse(f.requests[0].body).material_revision,undefined);
  });
}

for(const event of ['pointerdown','focusin'])test(`material card ${event} removes an unanchored editor and retains both exact drafts`,()=>{
  const f=fixture(),key=f.material(1),data=f.context.state.materialReview,root=actualEditor(f);
  data.history=[];data.material_versions.other=data.material_versions.need;data.selectedMaterialRounds.other=1;
  f.context.state.materialCommentCard={data,material_id:'need',number:1};
  f.context.Option=function(text,value){const option=new Element('option');option.textContent=text;option.value=value;return option};
  f.context.renderMaterialPlaceholder=()=>{};f.context.renderGenerationRecipe=()=>{};
  const model=mid=>({material_id:mid,need:{object_id:mid,payload:{title:mid}},round:{number:1},rounds:[{number:1}],candidates:[]});
  const first=f.context.renderMaterialCard(root,model('need')),second=f.context.renderMaterialCard(root,model('other'));
  f.storage.set(key,'card A opinion');f.context.renderComments();
  second.listeners[event]();assert.equal(f.context.state.anchor,null);assert.equal(root.querySelector('#comment-editor-text'),null);assert.equal(f.storage.get(key),'card A opinion');
  f.context.state.anchor={type:'global'};f.context.renderComments();const other=f.context.key();assert.notEqual(other,key);
  const input=root.querySelector('#comment-editor-text');assert.equal(input.value,'');input.value='card B opinion';input.listeners.input();assert.equal(f.storage.get(other),'card B opinion');
  first.listeners[event]();f.context.state.anchor={type:'global'};f.context.renderComments();assert.equal(root.querySelector('#comment-editor-text').value,'card A opinion');
  second.listeners[event]();f.context.state.anchor={type:'global'};f.context.renderComments();assert.equal(root.querySelector('#comment-editor-text').value,'card B opinion');
  assert.equal(f.storage.has(null),false);assert.equal(f.storage.has('null'),false);assert.equal(f.requests.length,0);
});

for(const workspace of ['story.sources','materials.workspace'])test(`${workspace}: first failed request adds one pending notice without replacing the real editor`,async()=>{
  const f=fixture({fetch:async()=>{throw Error('lost response')}}),key=workspace==='materials.workspace'?f.material(2):f.target(workspace),root=actualEditor(f);
  if(f.context.state.materialReview)f.context.state.materialReview.history=[];
  f.context.renderComments();const editor=root.querySelector('.comment-editor'),input=root.querySelector('#comment-editor-text'),intent=root.querySelector('#material-revision-intent');
  input.value='unique input before response loss';input.listeners.input();if(intent)intent.checked=false;
  assert.equal(root.querySelector('.comment-submission-notice'),null);
  await f.context.saveComment();
  assert.equal(root.querySelector('.comment-editor'),editor);assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'unique input before response loss');
  const notice=root.querySelector('.comment-submission-notice');assert.match(notice.textContent,/上次提交尚未确认.*修改内容后提交/);assert.equal(notice.attrs.role,'status');
  if(intent){assert.equal(root.querySelector('#material-revision-intent'),intent);assert.equal(intent.checked,false)}
  assert.ok(f.storage.get(key+':submission'));await f.context.saveComment();assert.equal(root.querySelectorAll('.comment-submission-notice').length,1);
  assert.equal(JSON.parse(f.requests[0].body).id,JSON.parse(f.requests[1].body).id);
});

test('late failed request does not add its notice to another real editor',async()=>{
  let reject;const f=fixture({fetch:()=>new Promise((_,fail)=>reject=fail)});f.target();const root=actualEditor(f);f.context.renderComments();
  root.querySelector('#comment-editor-text').value='old page';const saving=f.context.saveComment();
  const next=f.target('story.outline');f.storage.set(next,'new page');f.context.renderComments();const input=root.querySelector('#comment-editor-text');
  reject(Error('lost response'));await saving;assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'new page');assert.equal(root.querySelector('.comment-submission-notice'),null);
});

for(const workspace of ['story.sources','story.outline'])test(`${workspace}: acknowledged retry removes the real editor even when refresh finds identical comments`,async()=>{
  let comments;const f=fixture({fetch:async(url,options)=>({ok:true,json:async()=>options?.method==='POST'?comments[0]:comments})}),key=f.target(workspace),root=actualEditor(f);
  const target=vm.runInContext('commentTarget()',f.context),payload={...target,anchor:f.context.state.anchor,body:'committed retry'};
  comments=[{id:'already-committed',target_object_id:target.target_object_id||target.source_id,target_revision_id:target.target_revision_id,anchor:payload.anchor,body:payload.body,status:'OPEN',version:1,updated_at:'2026-01-01T00:00:00Z'}];
  f.context.state.comments=comments;f.storage.set(key,payload.body);f.storage.set(key+':submission',JSON.stringify({id:comments[0].id,payload}));f.context.renderComments();
  const start=source.indexOf('async function refreshComments(){'),end=source.indexOf('\nasync function saveComment(){',start);vm.runInContext(source.slice(start,end),f.context);
  assert.ok(root.querySelector('#comment-editor-text'));assert.ok(root.querySelector('.comment-submission-notice'));
  await f.context.saveComment();
  assert.equal(f.requests.length,2);assert.equal(JSON.parse(f.requests[0].body).id,comments[0].id);assert.equal(f.requests[1].url,'/api/comments');
  assert.equal(root.querySelector('#comment-editor-text'),null);assert.equal(root.querySelector('.comment-submission-notice'),null);assert.equal(f.context.state.anchor,null);assert.equal(f.storage.has(key+':submission'),false);
  assert.ok(root.querySelector('#comment-'+comments[0].id));assert.match(root.querySelector('#toast').textContent,/评论已保存/);
});

test('acknowledged retry with unchanged comments never removes a newer page editor',async()=>{
  let resolve;const comments=[];
  const f=fixture({fetch:async(url,options)=>options?.method==='POST'?new Promise(done=>resolve=done):{ok:true,json:async()=>comments}});f.target();const root=actualEditor(f);f.context.renderComments();
  root.querySelector('#comment-editor-text').value='old operation';
  const start=source.indexOf('async function refreshComments(){'),end=source.indexOf('\nasync function saveComment(){',start);vm.runInContext(source.slice(start,end),f.context);
  const saving=f.context.saveComment(),next=f.target('story.outline');f.storage.set(next,'new page draft');f.context.renderComments();const editor=root.querySelector('.comment-editor');
  resolve({ok:true,json:async()=>({})});await saving;
  assert.equal(root.querySelector('.comment-editor'),editor);assert.equal(root.querySelector('#comment-editor-text').value,'new page draft');assert.equal(f.context.state.anchor.type,'global');assert.equal(f.storage.get(next),'new page draft');
});
