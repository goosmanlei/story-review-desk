const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./comment-persistence-fixture.cjs');
const plain=x=>JSON.parse(JSON.stringify(x));
const comment=(version=5)=>({id:'comment-one',version,body:'saved '+version,status:'OPEN',target_object_id:'source-1',target_revision_id:'rev-1',anchor:{type:'global'}});
function page(storage=new Map(),pageStorage=new Map(),navigationType='navigate',transport){return fixture({storage,pageStorage,navigationType,fetch:transport})}
function edit(f,c=comment(),body='draft'){
 f.target();Object.assign(f.context.state,{editing:c.id,comments:[c],anchor:plain(c.anchor)});f.context.beginCommentEdit(c);f.textarea.value=body;const key=f.context.key();f.storage.set(key,body);f.context.rememberStoryDraft();return key;
}
test('two pages with B written first: A save cleans only A; B retains body, anchor, target and start version',async()=>{
 const shared=new Map(),a=page(shared),b=page(shared),bk=edit(b,comment(),'B first'),ak=edit(a,comment(),'A later');assert.notEqual(ak,bk);
 await a.context.saveComment();assert.equal(shared.has(ak),false);assert.equal(shared.get(bk),'B first');const basis=JSON.parse(shared.get(bk+':basis'));assert.equal(basis.version,5);assert.deepEqual(basis.target,{source_id:'source-1',target_revision_id:'rev-1'});assert.deepEqual(basis.anchor,{type:'global'});
});
test('one page cancellation preserves the other page even at the identical comment and anchor',()=>{
 const shared=new Map(),a=page(shared),b=page(shared),bk=edit(b,comment(),'B'),ak=edit(a,comment(),'A');a.context.abandonDraft('cancel');assert.equal(shared.has(ak),false);assert.equal(shared.get(bk),'B');assert.equal(JSON.parse(shared.get(bk+':basis')).version,5);
});
test('reload retains page ownership while a new or duplicated navigation gets its own editor',()=>{
 const shared=new Map(),tab=new Map(),a=page(shared,tab),ak=edit(a,comment(),'original');const reload=page(shared,tab,'reload');const rk=edit(reload,comment(6),'original');assert.equal(rk,ak);assert.equal(reload.context.editDraftBasis().version,5);
 const duplicate=page(shared,new Map(tab)),dk=edit(duplicate,comment(6),'duplicate');assert.notEqual(dk,ak);assert.equal(shared.get(ak),'original');
});
test('list refresh never upgrades start version; rejected save retains the complete draft and original basis',async()=>{
 const f=page(new Map(),new Map(),'navigate',async()=>({ok:false,status:409,json:async()=>({error:'comment version changed; refresh before editing'})}));const key=edit(f,comment(),'B old basis');f.context.state.comments=[comment(6)];await f.context.saveComment();assert.equal(JSON.parse(f.requests[0].body).expected_version,5);assert.equal(f.storage.get(key),'B old basis');assert.equal(JSON.parse(f.storage.get(key+':basis')).version,5);assert.equal(JSON.parse(f.storage.get(key+':basis')).conflict,true);
});
test('explicit reviewed retry uses its frozen version and another change still rejects',async()=>{
 const f=page(new Map(),new Map(),'navigate',async()=>({ok:false,status:409,json:async()=>({error:'changed again'})}));const key=edit(f);f.context.rememberEditBasis({...f.context.editDraftBasis(),version:6,body:'reviewed saved 6'});f.context.state.comments=[comment(7)];await f.context.saveComment();assert.equal(JSON.parse(f.requests[0].body).expected_version,6);assert.equal(f.storage.get(key),'draft');assert.equal(f.context.editDraftBasis().version,6);
});
test('legacy shared text cannot silently become a modification based on the current comment version',async()=>{
 const f=page();f.target();f.context.state.editing='comment-one';f.storage.set(f.context.legacyKey(),'old unknown draft');f.context.state.comments=[comment(8)];f.context.beginCommentEdit(comment(8));f.textarea.value='old unknown draft';await f.context.saveComment();assert.equal(f.requests.length,0);assert.equal(f.context.editDraftBasis().version,null);assert.match(f.messages.at(-1),/开始版本无法确定/);
});
test('unconfirmed PATCH retries the same start version and never uses a newly fetched list version',async()=>{
 const f=page(new Map(),new Map(),'navigate',async()=>{throw Error('network response unknown')});const key=edit(f);await f.context.saveComment();f.context.state.comments=[comment(6)];await f.context.saveComment();assert.deepEqual(f.requests.map(r=>JSON.parse(r.body).expected_version),[5,5]);assert.equal(f.storage.get(key),'draft');
});
test('local storage failure blocks transmission while the start basis and live input remain',async()=>{
 const f=page();edit(f,comment(),'only live input');f.context.localStorage.setItem=()=>{throw Error('quota')};await f.context.saveComment();assert.equal(f.requests.length,0);assert.equal(f.textarea.value,'only live input');assert.equal(f.context.editDraftBasis().version,5);
});
test('recovery catalog exposes exact old target only, independently of the current latest revision',()=>{
 const shared=new Map(),old=page(shared);edit(old,comment(),'old target draft');const fresh=page(shared);fresh.target();fresh.context.state.comments=[comment(6)];assert.equal(fresh.context.storedCommentEdits()[0].text,'old target draft');fresh.context.state.current.target_revision_id='rev-2';assert.equal(fresh.context.storedCommentEdits().length,0);
});
test('another comment and visual/time anchors cannot reuse the edit key or basis',()=>{
 const f=page();const first=edit(f);for(const [id,anchor] of [['comment-two',{type:'global'}],['comment-one',{type:'region',visual_id:'exact-file',points:[[0,0],[1,0],[1,1]]}],['comment-one',{type:'time',component_id:'clip',asset_file:'exact.wav',start_seconds:1,end_seconds:2}]]){const key=edit(f,{...comment(),id,anchor});assert.notEqual(key,first);assert.deepEqual(plain(f.context.editDraftBasis().anchor),anchor);assert.equal(f.storage.get(first),'draft')}
});
test('conflict review controls unlock when a rejected save finishes',()=>{
 const f=page();edit(f);const review=[{disabled:true},{disabled:true}],actions=[{},{},{}],editor={querySelector:s=>s==='textarea'?f.textarea:s==='[data-comment-submit]'?actions[0]:s==='[data-polish]'?actions[1]:null,querySelectorAll:s=>s==='.comment-edit-conflict button'?review:s==='.editor-actions button'?actions:[]};
 const query=f.context.document.querySelector;f.context.document.querySelector=s=>s==='.comment-editor'?editor:query(s);f.context.updateCommentEditorControls();assert.deepEqual(review.map(b=>b.disabled),[false,false]);
});
