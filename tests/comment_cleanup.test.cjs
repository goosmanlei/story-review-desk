const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {fixture}=require('./comment-persistence-fixture.cjs');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8');
class Element{
 constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.listeners={};this.className='';this.classList={add(){},remove(){}}}
 append(...nodes){for(const node of nodes){this.children.push(node);node.parent=this}}replaceChildren(...nodes){this.children=[];this.append(...nodes)}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,v){this.listeners[k]=v}
 all(){return this.children.flatMap(node=>[node,...node.all()])}
 matches(s){if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));if(s==='[data-comment-submit]')return this.dataset.commentSubmit!==undefined;if(s==='[data-polish]')return this.dataset.polish!==undefined;return this.tag===s}
 querySelectorAll(s){return this.all().filter(n=>s==='.editor-actions button'?n.tag==='button'&&n.parent?.className==='editor-actions':n.matches(s))}querySelector(s){return this.querySelectorAll(s)[0]||null}
}
function editor(f){
 const root=new Element('main');for(const id of ['comment-body','comment-panel','open-count','comments-toggle','screenplay-comments','toast']){const n=new Element('div');n.id=id;root.append(n)}
 f.context.document={querySelector:s=>root.querySelector(s),createElement:tag=>new Element(tag),createTextNode:text=>{const n=new Element('text');n.textContent=text;return n}};
 const start=source.indexOf('function renderComments('),end=source.indexOf('\nasync function refreshComments(){',start);vm.runInContext(source.slice(start,end),f.context);
 if(f.context.state.materialReview)f.context.state.materialReview.history=[];f.context.renderComments();return root;
}
const notice=root=>root.querySelector('.comment-submission-notice')?.textContent||'';
const failDelete=(f,key,which)=>{const remove=f.context.localStorage.removeItem;f.context.localStorage.removeItem=k=>{if(k===(which==='body'?key:key+which))throw Error('SecurityError cleanup');remove(k)};return ()=>{f.context.localStorage.removeItem=remove}};
for(const which of ['body',':discussion',':submission'])test(`cancel ${which} cleanup failure retains the actual editor and reports incomplete cancellation`,()=>{
 const f=fixture(),key=f.target(),root=editor(f),input=root.querySelector('#comment-editor-text');input.value='唯一草稿';f.storage.set(key,input.value);f.storage.set(key+':discussion','true');f.storage.set(key+':submission',JSON.stringify({id:'known',payload:{body:'唯一草稿'}}));const restore=failDelete(f,key,which);
 const cancel=root.querySelectorAll('button').find(b=>b.textContent==='取消本次评论');assert.doesNotThrow(()=>cancel.onclick());assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'唯一草稿');assert.ok(f.context.state.anchor);assert.match(root.querySelector('#toast').textContent,/取消未完成/);assert.equal(f.requests.length,0);
 restore();cancel.onclick();assert.equal(f.context.state.anchor,null);for(const tail of ['',':discussion',':submission'])assert.equal(f.storage.has(key+tail),false);assert.match(root.querySelector('#toast').textContent,/已取消/);
});
for(const which of ['body',':discussion',':submission'])test(`acknowledged create ${which} cleanup failure retains receipt and retries cleanup without another POST`,async()=>{
 const f=fixture(),key=f.target(),root=editor(f),input=root.querySelector('#comment-editor-text');input.value='已保存正文';f.storage.set(key+':discussion','true');const restore=failDelete(f,key,which);
 await f.context.saveComment();const pending=JSON.parse(f.storage.get(key+':submission')),id=pending.id;assert.equal(f.requests.length,1);assert.equal(pending.acknowledged,true);assert.equal(root.querySelector('#comment-editor-text'),input);assert.match(notice(root),/已保存/);assert.doesNotMatch(notice(root),/尚未确认/);assert.match(root.querySelector('#toast').textContent,/已保存.*未能完全清除/);
 await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.storage.get(key+':submission')).id,id);
 restore();await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(f.context.state.anchor,null);for(const tail of ['',':discussion',':submission'])assert.equal(f.storage.has(key+tail),false);
});
test('quota rejecting the success marker retains exact UUID, prevents repeat POST in this page and explains refresh limit',async()=>{
 const f=fixture(),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='only exact text';const set=f.context.localStorage.setItem;f.context.localStorage.setItem=(k,v)=>{if(k===key+':submission'&&JSON.parse(v).acknowledged)throw Error('quota success marker');set(k,v)};const restore=failDelete(f,key,'body');
 await f.context.saveComment();const pending=JSON.parse(f.storage.get(key+':submission'));assert.equal(pending.acknowledged,undefined);assert.match(notice(root),/已保存/);assert.match(notice(root),/暂仅在当前页面/);await f.context.saveComment();assert.equal(f.requests.length,1);
 f.context.renderComments();assert.match(notice(root),/已保存/);assert.equal(root.querySelector('#comment-editor-text').value,'only exact text');await f.context.saveComment();assert.equal(f.requests.length,1);
 const fresh=fixture({storage:f.storage});fresh.target();const freshRoot=editor(fresh);assert.match(notice(freshRoot),/尚未确认/);assert.equal(JSON.parse(fresh.storage.get(key+':submission')).id,pending.id);
 restore();await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(f.storage.has(key+':submission'),false);
});
test('a refreshed page uses a durable success receipt only for cleanup, including a partly removed body',async()=>{
 const f=fixture(),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='saved body';failDelete(f,key,':discussion');await f.context.saveComment();assert.equal(f.storage.has(key),false);
 const fresh=fixture({storage:f.storage});fresh.target();const freshRoot=editor(fresh);assert.match(notice(freshRoot),/已保存/);assert.equal(freshRoot.querySelector('#comment-editor-text').value,'');
 freshRoot.querySelector('#comment-editor-text').value='saved body';await fresh.context.saveComment();assert.equal(fresh.requests.length,0);assert.equal(fresh.storage.has(key+':submission'),false);assert.equal(fresh.storage.has(key+':discussion'),false);
});
test('a stored success for one payload does not mark a changed opinion as saved or reuse its UUID',async()=>{
 const f=fixture(),key=f.target(),root=editor(f),input=root.querySelector('#comment-editor-text');input.value='first';const restore=failDelete(f,key,'body');await f.context.saveComment();const first=JSON.parse(f.requests[0].body);
 restore();input.value='changed';await f.context.saveComment();assert.equal(f.requests.length,2);const second=JSON.parse(f.requests[1].body);assert.notEqual(first.id,second.id);assert.equal(second.body,'changed');assert.equal(second.acknowledged,undefined);assert.equal(second.attempt_id,undefined);
});
test('known success plus unreadable pending storage stays truthful and cannot cause a second request',async()=>{
 let get;const f=fixture({fetch:async()=>{get=f.context.localStorage.getItem;f.context.localStorage.getItem=k=>{if(k.endsWith(':submission'))throw Error('SecurityError');return get(k)};return {ok:true,json:async()=>({})}}}),key=f.target(),root=editor(f),input=root.querySelector('#comment-editor-text');input.value='only input';
 await f.context.saveComment();assert.equal(f.requests.length,1);assert.match(notice(root),/已保存/);assert.doesNotMatch(notice(root),/尚未确认/);await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(root.querySelector('#comment-editor-text'),input);assert.match(root.querySelector('#toast').textContent,/已保存/);f.context.localStorage.getItem=get;
});
test('known edit success is persisted and retry cleanup does not PATCH the old expected_version again',async()=>{
 const f=fixture();f.target();f.context.state.editing='existing';f.context.state.comments=[{id:'existing',version:1,body:'old',status:'OPEN',anchor:{type:'global'},target_object_id:'source-1',target_revision_id:'rev-1'}];const key=f.context.key(),root=editor(f);root.querySelector('#comment-editor-text').value='edited';const restore=failDelete(f,key,'body');
 await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'PATCH');assert.equal(JSON.parse(f.storage.get(key+':submission')).editing,'existing');assert.match(notice(root),/已保存/);
 await f.context.saveComment();assert.equal(f.requests.length,1);restore();await f.context.saveComment();assert.equal(f.requests.length,1);assert.equal(f.context.state.anchor,null);
});
test('late acknowledged success cannot delete another tab newer draft and request identity',async()=>{
 let resolve;const f=fixture({fetch:()=>new Promise(done=>resolve=done)}),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='A';const pending=f.context.saveComment();const newer=JSON.stringify({id:'B',payload:{body:'B'}});f.storage.set(key,'B');f.storage.set(key+':submission',newer);resolve({ok:true,json:async()=>({})});await pending;
 assert.equal(f.storage.get(key),'B');assert.equal(f.storage.get(key+':submission'),newer);assert.equal(f.context.state.anchor.type,'global');
});
test('unreadable submission before send fails closed and cannot silently create a fresh UUID',async()=>{
 const f=fixture(),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='draft';const get=f.context.localStorage.getItem;f.context.localStorage.getItem=k=>{if(k===key+':submission')throw Error('SecurityError');return get(k)};
 await f.context.saveComment();assert.equal(f.requests.length,0);assert.equal(root.querySelector('#comment-editor-text').value,'draft');assert.match(root.querySelector('#toast').textContent,/尚未发送/);
});
