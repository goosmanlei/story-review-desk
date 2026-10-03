const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8'),plain=value=>JSON.parse(JSON.stringify(value)),flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node{
  constructor(tag,cls){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this.disabled=false;this.value='';this.isConnected=true}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node)}}
  remove(){this.parent.children=this.parent.children.filter(node=>node!==this);this.isConnected=false;this.all().forEach(node=>node.isConnected=false)}
  setAttribute(key,value){this.attrs[key]=value}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
}
function fixture(){
  const root=new Node('main'),requests=[],reads=[],posts=[],messages=[];
  const record={object_id:'asset',id:'exact-old-asset',payload:{title:'Original candidate'}},context={state:{workspace:'materials.workspace',productionSelected:record},crypto:require('node:crypto').webcrypto,el:(tag,cls)=>new Node(tag,cls),nodeText:(tag,cls,text,parent)=>{const node=new Node(tag,cls);node.textContent=text;parent.append(node);return node},toast:text=>messages.push(text),api:(url,options)=>{posts.push(JSON.parse(options.body));return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))},fetch:url=>new Promise((resolve,reject)=>reads.push({url,resolve,reject}))};
  context.Option=function(text,value){const node=new Node('option');node.textContent=text;node.value=value;return node};
  vm.createContext(context);vm.runInContext(source,context);context.reloads=0;context.loadProductionWorkspace=async()=>{context.reloads++};
  const open=()=>{context.showProductionJudgment(root);const box=root.children.at(-1),field=label=>box.all().find(node=>node.attrs['aria-label']===label),button=label=>box.all().find(node=>node.tag==='button'&&node.textContent===label);field('审阅结果').value='passed';field('审阅者').value='Technical reviewer';field('结论依据').value='Exact original candidate assessment';return {box,field,button,notice:()=>box.all().find(node=>node.attrs.role==='status')}};
  return {context,root,record,requests,reads,posts,messages,open};
}
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
const saved=request=>({object_id:request.object_id,kind:'JUDGMENT',version:1,payload:plain(request.payload)});
test('in-flight judgment locks fields and one form cannot create two opposing operations',async()=>{
  const f=fixture(),form=f.open();const saving=form.button('保存审阅').onclick();await flush();for(const label of ['审阅结果','审阅者','结论依据'])assert.equal(form.field(label).disabled,true);assert.equal(form.button('取消').disabled,false);
  form.field('审阅结果').value='rejected';await form.button('保存审阅').onclick();assert.equal(f.posts.length,1);assert.equal(f.posts[0].payload.verdict,'passed');assert.equal(f.posts[0].expected_version,0);f.requests[0].resolve({});await saving;assert.equal(form.box.isConnected,false);assert.equal(f.context.reloads,1);
});
test('the original target is frozen even when another comment focus changes the selected record',async()=>{
  const f=fixture(),form=f.open();f.context.state.productionSelected={object_id:'actual-call',id:'call-exact',payload:{title:'Call'}};const saving=form.button('保存审阅').onclick();await flush();assert.deepEqual(f.posts[0].payload.target,{object_id:'asset',revision_id:'exact-old-asset'});f.requests[0].resolve({});await saving;assert.equal(f.context.reloads,0);assert.match(f.messages.at(-1),/Original candidate.*已记录/);
});
test('canceled or navigated saves do not reload a newer view or report old failures there',async()=>{
  for(const mode of ['cancel-success','navigate-success','cancel-failure','navigate-failure']){
    const f=fixture(),old=f.open();const saving=old.button('保存审阅').onclick();await flush();if(mode.startsWith('cancel'))await old.button('取消').onclick();else vm.runInContext('++productionReadEpoch',f.context);const next=f.open();next.field('结论依据').value='unique new opinion';
    if(mode.endsWith('success'))f.requests[0].resolve({});else f.requests[0].reject(Error('old failure'));await saving;
    assert.equal(f.context.reloads,0);assert.equal(next.field('结论依据').value,'unique new opinion');assert.equal(next.box.isConnected,true);assert.equal(f.reads.length,0);assert.equal(f.messages.length,mode.endsWith('success')?1:0);
  }
});
test('a queued detached editor cannot send a new judgment',async()=>{
  const f=fixture(),form=f.open();await form.button('取消').onclick();await form.button('保存审阅').onclick();assert.equal(f.posts.length,0);
});
test('lost response recognizes only exact id, first version and complete payload',async()=>{
  const f=fixture(),form=f.open();const saving=form.button('保存审阅').onclick();await flush();f.requests[0].reject(Error('lost after commit'));await flush();assert.equal(f.reads[0].url,'/api/production?object_id='+encodeURIComponent(f.posts[0].object_id));const row=saved(f.posts[0]);row.payload=Object.fromEntries(Object.entries(row.payload).reverse());f.reads[0].resolve(response(200,{record:row}));await saving;assert.equal(f.posts.length,1);assert.equal(f.context.reloads,1);assert.equal(form.box.isConnected,false);
});
test('unknown result is checked before retry and never allocates another id merely for a missing response',async()=>{
  const f=fixture(),form=f.open();let saving=form.button('保存审阅').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();f.reads[0].reject(Error('offline'));await saving;assert.match(form.notice().textContent,/结果待确认/);assert.equal(form.field('结论依据').disabled,false);
  saving=form.button('保存审阅').onclick();await flush();assert.equal(f.posts.length,1);f.reads[1].resolve(response(200,{record:saved(f.posts[0])}));await saving;assert.equal(f.posts.length,1);assert.equal(f.context.reloads,1);
});
test('explicit unchanged retry uses the exact original id and version; 409 can recover only that same save',async()=>{
  const f=fixture(),form=f.open();let saving=form.button('保存审阅').onclick();await flush();f.requests[0].reject(Error('write rejected'));await flush();f.reads[0].resolve(response(404,{}));await saving;
  saving=form.button('保存审阅').onclick();await flush();f.reads[1].resolve(response(404,{}));await flush();assert.deepEqual(f.posts[1],f.posts[0]);f.requests[1].reject(Error('HTTP 409'));await flush();f.reads[2].resolve(response(200,{record:saved(f.posts[0])}));await saving;assert.equal(f.context.reloads,1);assert.equal(f.posts[1].expected_version,0);
});
test('different id, later version or another payload cannot be called this successful judgment',async()=>{
  for(const change of [row=>row.object_id='other-id',row=>row.version++,row=>row.payload.verdict='rejected']){
    const f=fixture(),form=f.open();const saving=form.button('保存审阅').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();const row=saved(f.posts[0]);change(row);f.reads[0].resolve(response(200,{record:row}));await saving;assert.match(form.notice().textContent,/已有不同内容/);assert.equal(form.box.isConnected,true);assert.equal(f.context.reloads,0);assert.ok(!f.messages.some(message=>message.includes('已记录')));
  }
});
test('edited reason after an uncertain save is not silently consumed by confirmation of the old payload',async()=>{
  const f=fixture(),form=f.open();let saving=form.button('保存审阅').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();f.reads[0].reject(Error('read offline'));await saving;form.field('结论依据').value='new not-yet-submitted opinion';form.field('审阅结果').value='rejected';
  saving=form.button('保存审阅').onclick();await flush();f.reads[1].resolve(response(200,{record:saved(f.posts[0])}));await saving;assert.match(form.notice().textContent,/当前修改尚未提交/);assert.equal(f.posts.length,1);assert.equal(f.context.reloads,0);assert.equal(form.field('结论依据').value,'new not-yet-submitted opinion');
});
test('cancel during an uncertain read prevents a stale retry and preserves the next editor',async()=>{
  const f=fixture(),old=f.open();const saving=old.button('保存审阅').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();await old.button('取消').onclick();const next=f.open();f.reads[0].resolve(response(404,{}));await saving;assert.equal(f.posts.length,1);assert.equal(f.messages.length,0);assert.equal(next.box.isConnected,true);
});
test('known saved judgment and later refresh failure are separate outcomes with no second POST',async()=>{
  const f=fixture(),form=f.open();f.context.loadProductionWorkspace=()=>{vm.runInContext('++productionLoadEpoch',f.context);return Promise.reject(Error('list offline'))};const saving=form.button('保存审阅').onclick();await flush();f.requests[0].resolve({});await saving;
  assert.equal(form.box.isConnected,false);assert.match(f.messages.at(-1),/已保存.*页面尚未完整更新.*list offline/);await form.button('保存审阅').onclick();assert.equal(f.posts.length,1);
});
test('a refresh failure after another record takes over does not report an error on that record',async()=>{
  const f=fixture(),form=f.open();let rejectRefresh;f.context.loadProductionWorkspace=()=>{vm.runInContext('++productionLoadEpoch',f.context);return new Promise((resolve,reject)=>rejectRefresh=reject)};const saving=form.button('保存审阅').onclick();await flush();f.requests[0].resolve({});await flush();vm.runInContext('++productionReadEpoch',f.context);rejectRefresh(Error('old list failure'));await saving;assert.equal(f.messages.length,1);assert.match(f.messages[0],/审阅已记录/);
});
