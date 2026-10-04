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
 const start=source.indexOf('function renderComments(){'),end=source.indexOf('\nasync function refreshComments(){',start);vm.runInContext(source.slice(start,end),f.context);
 if(f.context.state.materialReview)f.context.state.materialReview.history=[];f.context.renderComments();return root;
}
const rejection=(status=409,message='素材修订轮次已变化，请刷新后提交。')=>({ok:false,status,json:async()=>({error:message})});
const submit=f=>f.requests.filter(r=>r.method==='POST').map(r=>JSON.parse(r.body));
const notice=root=>root.querySelector('.comment-submission-notice')?.textContent||'';
for(const status of [400,409])test(`explicit HTTP ${status} preserves the actual draft and exact operation but states rejection instead of uncertain success`,async()=>{
 const f=fixture({fetch:async()=>rejection(status)}),key=f.material(2),root=editor(f),input=root.querySelector('#comment-editor-text'),intent=root.querySelector('#material-revision-intent');
 input.value='  唯一原轮意见🧵  ';input.selectionStart=2;input.selectionEnd=8;assert.equal(intent,null);const target=JSON.stringify(f.context.state.productionSelected),anchor=JSON.stringify(f.context.state.anchor);
 await f.context.saveComment();const request=submit(f)[0],pending=JSON.parse(f.storage.get(key+':submission'));
 assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'  唯一原轮意见🧵  ');assert.equal(input.selectionStart,2);assert.equal(root.querySelector('#material-revision-intent'),intent);
 assert.equal(pending.id,request.id);assert.equal(pending.rejection.status,status);assert.equal(pending.payload.material_context.number,2);assert.equal(pending.payload.material_revision,undefined);assert.equal(f.storage.get(key),input.value);
 assert.equal(JSON.stringify(f.context.state.productionSelected),target);assert.equal(JSON.stringify(f.context.state.anchor),anchor);assert.match(notice(root),/提交被拒绝.*原草稿与圈选仍保留/);assert.doesNotMatch(notice(root),/尚未确认|原样重试可确认保存/);assert.equal(root.querySelectorAll('.comment-submission-notice').length,1);assert.equal(f.requests.length,1);
});
test('refreshing the old material round retains rejected status, original UUID and exact scope after a new plan appears',async()=>{
 const f=fixture({fetch:async()=>rejection()}),key=f.material(2),root=editor(f);root.querySelector('#comment-editor-text').value='原轮唯一意见';await f.context.saveComment();
 const next=fixture({storage:f.storage,fetch:async()=>rejection()}),same=next.material(2),data=next.context.state.materialReview;data.material_versions.need.unshift({...data.material_versions.need[0],number:3});const after=editor(next);
 assert.equal(same,key);assert.equal(next.context.materialRevisionIntent(),null);assert.equal(next.context.commentRevisionIntent(),null);assert.match(notice(after),/提交被拒绝/);assert.equal(after.querySelector('#material-revision-intent'),null);
 await next.context.saveComment();assert.deepEqual(submit(next)[0],submit(f)[0]);assert.equal(data.selectedMaterialRounds.need,2);assert.match(notice(after),/提交被拒绝/);assert.doesNotMatch(notice(after),/原样重试可确认保存/);
});
test('a later same-payload attempt can become uncertain again without changing its UUID or duplicating notices',async()=>{
 let phase=0;const f=fixture({fetch:async()=>{phase++;if(phase===1)return rejection();if(phase===2)throw Error('connection lost');return rejection(503,'temporary unavailable')}}),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='same payload';
 await f.context.saveComment();assert.match(notice(root),/被拒绝/);await f.context.saveComment();assert.match(notice(root),/上次提交尚未确认/);assert.equal(JSON.parse(f.storage.get(key+':submission')).rejection,undefined);
 await f.context.saveComment();assert.match(notice(root),/上次提交尚未确认/);assert.equal(new Set(submit(f).map(r=>r.id)).size,1);assert.equal(root.querySelectorAll('.comment-submission-notice').length,1);
});
test('editing a rejected payload starts a new operation and does not carry the old rejection',async()=>{
 let phase=0;const f=fixture({fetch:async()=>++phase===1?rejection():rejection(503,'unavailable')}),key=f.target(),root=editor(f),input=root.querySelector('#comment-editor-text');input.value='first';await f.context.saveComment();input.value='changed';await f.context.saveComment();
 assert.notEqual(submit(f)[0].id,submit(f)[1].id);assert.equal(submit(f)[1].body,'changed');assert.equal(JSON.parse(f.storage.get(key+':submission')).rejection,undefined);assert.match(notice(root),/尚未确认/);
});
test('a late rejection records only its old operation and never replaces another page editor or adds a notice there',async()=>{
 let reply;const f=fixture({fetch:()=>new Promise(done=>reply=done)}),old=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='old page';const pending=f.context.saveComment();
 const key=f.target('story.outline');f.storage.set(key,'new page');f.context.renderComments();const input=root.querySelector('#comment-editor-text');reply(rejection());await pending;
 assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'new page');assert.equal(notice(root),'');assert.equal(JSON.parse(f.storage.get(old+':submission')).rejection.status,409);assert.equal(f.storage.get(key),'new page');
});
test('a late rejection cannot overwrite a newer pending submission from another tab',async()=>{
 let reply;const f=fixture({fetch:()=>new Promise(done=>reply=done)}),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='old page';const pending=f.context.saveComment();
 const newer=JSON.stringify({id:'newer-operation',payload:{source_id:'source-1',target_revision_id:'rev-1',anchor:{type:'global'},body:'another tab'}});f.storage.set(key+':submission',newer);f.storage.set(key,'another tab');reply(rejection());await pending;
 assert.equal(f.storage.get(key+':submission'),newer);assert.equal(f.storage.get(key),'another tab');assert.doesNotMatch(notice(root),/被拒绝/);
});
test('failure to persist the rejection keeps it in the same exact session without replacing the unique editor',async()=>{
 const f=fixture({fetch:async()=>rejection()}),key=f.target(),root=editor(f),input=root.querySelector('#comment-editor-text');input.value='unique text';const set=f.context.localStorage.setItem;
 f.context.localStorage.setItem=(k,v)=>{if(k===key+':submission'&&JSON.parse(v).rejection)throw Error('quota');set(k,v)};await f.context.saveComment();
 assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'unique text');assert.match(notice(root),/被拒绝/);assert.match(root.querySelector('#toast').textContent,/拒绝状态未能写入本机/);assert.equal(JSON.parse(f.storage.get(key+':submission')).rejection,undefined);
 f.context.renderComments();assert.equal(root.querySelector('#comment-editor-text').value,'unique text');assert.match(notice(root),/被拒绝/);
 f.context.abandonDraft('cancel');f.target();f.context.renderComments();assert.equal(notice(root),'');assert.equal(f.storage.has(key+':submission'),false);
});
for(const status of [409,201,503])test(`incomplete JSON retains HTTP ${status} and distinguishes explicit rejection from an unconfirmed successful or failing response`,async()=>{
 const f=fixture({fetch:async()=>({ok:status===201,status,json:async()=>{throw SyntaxError('incomplete JSON')}})}),key=f.target(),root=editor(f);root.querySelector('#comment-editor-text').value='exact draft';await f.context.saveComment();
 const pending=JSON.parse(f.storage.get(key+':submission'));assert.equal(root.querySelector('#comment-editor-text').value,'exact draft');
 if(status===409){assert.equal(pending.rejection.status,409);assert.match(notice(root),/被拒绝（HTTP 409）/);assert.doesNotMatch(notice(root),/尚未确认/)}
 else{assert.equal(pending.rejection,undefined);assert.match(notice(root),/尚未确认/)}
});
test('a pending storage read failure after HTTP 409 keeps the original refusal visible and does not reject the save callback',async()=>{
 const f=fixture({fetch:async()=>{const get=f.context.localStorage.getItem;f.context.localStorage.getItem=k=>{if(k.endsWith(':submission'))throw Error('SecurityError pending read');return get(k)};return rejection()}});f.target();const root=editor(f),input=root.querySelector('#comment-editor-text');input.value='唯一原稿';
 await assert.doesNotReject(f.context.saveComment());assert.equal(root.querySelector('#comment-editor-text'),input);assert.equal(input.value,'唯一原稿');assert.match(root.querySelector('#toast').textContent,/轮次已变化/);assert.match(root.querySelector('#toast').textContent,/拒绝状态未能写入本机/);assert.equal(submit(f).length,1);
});
for(const quota of [false,true])test(`another tab's same-operation attempt expires the old rejection, including quota fallback (${quota})`,async()=>{
 const a=fixture({fetch:async()=>rejection()}),key=a.target(),rootA=editor(a),set=a.context.localStorage.setItem;
 if(quota)a.context.localStorage.setItem=(k,v)=>{if(k===key+':submission'&&JSON.parse(v).rejection)throw Error('rejection quota');set(k,v)};
 rootA.querySelector('#comment-editor-text').value='同一操作';await a.context.saveComment();assert.match(notice(rootA),/拒绝/);const first=JSON.parse(a.storage.get(key+':submission'));
 const b=fixture({storage:a.storage,fetch:async()=>{throw Error('other attempt response lost')}});b.target();const rootB=editor(b);await b.context.saveComment();const second=JSON.parse(a.storage.get(key+':submission'));
 assert.deepEqual(submit(a)[0],submit(b)[0]);assert.notEqual(first.attempt_id,second.attempt_id);assert.equal(submit(b)[0].attempt_id,undefined);assert.equal(second.rejection,undefined);assert.match(notice(rootB),/尚未确认/);
 a.context.renderComments();assert.match(notice(rootA),/尚未确认/);assert.doesNotMatch(notice(rootA),/被拒绝/);
});
test('a late 409 cannot overwrite another tab retry of the same UUID and payload',async()=>{
 let reply;const a=fixture({fetch:()=>new Promise(done=>reply=done)}),key=a.target(),rootA=editor(a);rootA.querySelector('#comment-editor-text').value='same exact operation';const pending=a.context.saveComment();
 const b=fixture({storage:a.storage,fetch:async()=>{throw Error('new attempt unknown')}});b.target();const rootB=editor(b);await b.context.saveComment();const newer=a.storage.get(key+':submission');assert.deepEqual(submit(a)[0],submit(b)[0]);
 reply(rejection());await pending;assert.equal(a.storage.get(key+':submission'),newer);assert.match(notice(rootA),/尚未确认/);assert.match(notice(rootB),/尚未确认/);
});
