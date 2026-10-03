const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/structure.js'),'utf8'),callback=source.slice(source.indexOf('async function chooseStructureDirection('),source.indexOf('function selectedStructureAnchor(')),flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.listeners={};this.isConnected=true;this.open=false}
 append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node)}}
 all(){return this.children.flatMap(n=>[n,...n.all()])}
 get firstChild(){return this.children[0]||null}
 setAttribute(k,v){this.attrs[k]=v}addEventListener(k,fn){this.listeners[k]=fn}
 showModal(){this.open=true}close(){this.open=false;this.listeners.close?.()}
 remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);for(const n of this.all())n.isConnected=false}
 replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes)}
}
function fixture(selection=null){
 const body=new Node('body'),status=new Node('section');status.append(new Node('p'));const requests=[],messages=[],state={workspace:'story.outline',structureRevision:null,structure:{selection,revisions:[]}},context={state,document:{body,createElement:tag=>new Node(tag)},$:()=>status,isStructure:()=>state.workspace==='story.outline',structureSourceTitle:id=>'Title '+id,el:tag=>new Node(tag),nodeText:(tag,cls,text,parent)=>{const n=new Node(tag);n.textContent=text;parent.append(n);return n},toast:s=>messages.push(s),api:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))};
 context.renders=0;context.renderStructureReader=()=>{context.renders++;status.replaceChildren(new Node('p'))};vm.createContext(context);vm.runInContext(callback,context);
 const open=async(id='direction-a')=>{await context.chooseStructureDirection(id);const dialog=body.children.at(-1);return {dialog,commit:()=>dialog.all().find(n=>n.textContent==='选择这个方向'),cancel:()=>dialog.all().find(n=>n.textContent==='返回'),notice:()=>dialog.all().find(n=>n.attrs.role==='status')}};
 return {context,state,body,status,requests,messages,open};
}
test('direction confirmed POST and failed GET remain saved, close the form and never resend the old snapshot',async()=>{
 const f=fixture(),form=await f.open(),saving=form.commit().onclick();await form.commit().onclick();assert.equal(f.requests.length,1);assert.equal(form.commit().disabled,true);
 f.requests[0].resolve({saved:true});await flush();assert.equal(form.dialog.open,false);assert.equal(f.requests.length,2);f.requests[1].reject(Error('snapshot unavailable'));await saving;
 assert.ok(f.messages.some(s=>s.includes('已保存')&&s.includes('尚未更新')));assert.equal(f.context.renders,0);await f.context.chooseStructureDirection('direction-b');assert.equal(f.requests.length,2);assert.equal(f.body.children.length,0);
});
test('direction unknown result stays explicit, retains original version and prevents automatic or blind repeated writes',async()=>{
 const f=fixture({version:4,payload:{source_id:'old-direction'}}),form=await f.open(),saving=form.commit().onclick();assert.deepEqual(JSON.parse(f.requests[0].options.body),{source_id:'direction-a',expected_version:4});f.requests[0].reject(Error('response lost'));await saving;
 assert.equal(form.dialog.open,true);assert.equal(form.commit().disabled,true);assert.match(form.notice().textContent,/结果待确认/);await form.commit().onclick();assert.equal(f.requests.length,1);form.cancel().onclick();await f.context.chooseStructureDirection('direction-b');assert.equal(f.requests.length,1);assert.equal(f.body.children.length,0);assert.ok(!f.messages.some(s=>s.includes('已保存')));
});
test('cancelled direction success names the original choice without reading or rendering behind a newer page',async()=>{
 const f=fixture(),form=await f.open(),saving=form.commit().onclick();form.cancel().onclick();f.state.workspace='story.sources';f.requests[0].resolve({saved:true});await saving;
 assert.equal(f.requests.length,1);assert.equal(f.context.renders,0);assert.equal(form.dialog.isConnected,false);assert.match(f.messages[0],/Title direction-a.*已保存/);
});
test('direction failure after cancellation or navigation cannot show an error on a newer page',async()=>{
 for(const mode of ['cancel','workspace','reader']){
  const f=fixture(),form=await f.open(),saving=form.commit().onclick();if(mode==='cancel')form.cancel().onclick();if(mode==='workspace')f.state.workspace='story.sources';if(mode==='reader')f.status.replaceChildren(new Node('div'));
  f.requests[0].reject(Error('old write failed'));await saving;assert.equal(f.messages.length,0);assert.equal(f.requests.length,1);
 }
});
test('direction refresh cannot replace a new structure snapshot, revision, workspace or reader',async()=>{
 for(const mode of ['snapshot','revision','workspace','reader'])for(const outcome of ['success','failure']){
  const f=fixture(),form=await f.open(),saving=form.commit().onclick();f.requests[0].resolve({saved:true});await flush();assert.equal(f.requests.length,2);
  if(mode==='snapshot')f.state.structure={selection:{version:99},revisions:[]};if(mode==='revision')f.state.structureRevision='other-revision';if(mode==='workspace')f.state.workspace='story.sources';if(mode==='reader')f.status.replaceChildren(new Node('div'));
  const before=f.state.structure;if(outcome==='success')f.requests[1].resolve({selection:{version:1},revisions:[]});else f.requests[1].reject(Error('old refresh failed'));await saving;
  assert.equal(f.state.structure,before);assert.equal(f.context.renders,0);assert.ok(!f.messages.some(s=>s.includes('old refresh failed')));
 }
});
test('direction normal success uses the returned snapshot once and preserves the original selection version',async()=>{
 const f=fixture({version:2,payload:{source_id:'old'}}),form=await f.open('direction-b'),saving=form.commit().onclick();assert.equal(JSON.parse(f.requests[0].options.body).expected_version,2);f.requests[0].resolve({saved:true});await flush();const data={selection:{version:3,payload:{source_id:'direction-b'}},revisions:[]};f.requests[1].resolve(data);await saving;
 assert.equal(f.state.structure,data);assert.equal(f.context.renders,1);assert.equal(f.body.children.length,0);assert.equal(f.requests.length,2);
});
test('a dialog whose original reader has been replaced cannot start a new direction write',async()=>{
 const f=fixture(),form=await f.open();f.status.replaceChildren(new Node('div'));await form.commit().onclick();assert.equal(f.requests.length,0);
});
