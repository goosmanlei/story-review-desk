const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/app.js'),'utf8'),plain=value=>JSON.parse(JSON.stringify(value)),flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node{
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.isConnected=true;this.disabled=false;this.classList={add(){},remove(){},toggle(){}}}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node)}}
  detach(){this.isConnected=false;this.children.forEach(node=>node.detach())}
  replaceChildren(...nodes){this.children.forEach(node=>node.detach());this.children=[];this.append(...nodes)}
  remove(){this.parent.children=this.parent.children.filter(node=>node!==this);this.detach()}
  setAttribute(key,value){this.attrs[key]=value}
  all(){return this.children.flatMap(node=>[node,...node.all()])}
  querySelectorAll(selector){return this.all().filter(node=>selector==='button'?node.tag==='button':selector==='[data-config-section]'?node.dataset.configSection!==undefined:false)}
  addEventListener(name,fn){this.listeners[name]=fn}
  get elements(){const groups=new Map();for(const node of this.all().filter(node=>node.name)){if(!groups.has(node.name))groups.set(node.name,[]);groups.get(node.name).push(node)}return Object.fromEntries([...groups].map(([key,nodes])=>[key,nodes.length===1?nodes[0]:{get value(){return nodes.find(node=>node.checked)?.value||''}}]))}
  get options(){return this.children}
}
function fixture(){
  const root=new Node('main'),requests=[],messages=[];
  const data={values:{PROJECT:{scope:'PROJECT',version:1,schema_version:4,body:{story_background:'Original story background'}},SYSTEM:{scope:'SYSTEM',version:1,schema_version:4,body:{ai_context_max_chars:12000,site_favicon:'old.svg'}}},catalog:{scopes:{PROJECT:{story_background:{type:'long_text',label:'故事背景'}},SYSTEM:{ai_context_max_chars:{type:'integer',label:'AI 参考上下文字数上限'},site_favicon:{type:'favicon',label:'站点图标'}}},model_efforts:{}},favicon_assets:['old.svg'],favicon:{url:'/old-icon',mime:'image/svg+xml'}};
  const toast={classList:{add(){},remove(){}},set textContent(value){messages.push(value)}};
  const context={document:{createElement:tag=>new Node(tag),addEventListener(){},querySelector:selector=>selector==='#configuration-view'?root:selector==='#toast'?toast:null},setTimeout:()=>0,clearTimeout(){},console,fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve:data=>resolve({ok:true,json:async()=>data}),reject}))};
  context.FileReader=class{readAsDataURL(){this.result='data:image/svg+xml;base64,dGVzdA==';queueMicrotask(()=>this.onload())}};
  vm.createContext(context);vm.runInContext(source,context);vm.runInContext('globalThis.state=state;',context);context.state.workspace='project.configuration';context.state.configurations=plain(data);context.renderConfigurations();
  const form=scope=>root.all().find(node=>node.tag==='form'&&node.dataset.scope===scope),save=form=>form.all().find(node=>node.tag==='button'&&node.type==='submit'),notice=form=>form.all().find(node=>node.attrs.role==='status');
  const input=(form,key,value)=>{form.elements[key].value=value;form.listeners.input?.()};
  const submit=form=>form.onsubmit({preventDefault(){}});
  const committed=request=>{const scope=request.url.split('/').at(-1),body=JSON.parse(request.options.body);return {...plain(data.values[scope]),version:body.expected_version+1,body:{...plain(data.values[scope].body),...body.updates}}};
  const snapshot=(...records)=>{const value=plain(data);for(const row of records)value.values[row.scope]=row;return value};
  const finish=async(request,promise)=>{const row=committed(request);request.resolve(row);await flush();requests.at(-1).resolve(snapshot(row));await promise;return row};
  return {root,context,data,requests,messages,form,save,notice,input,submit,committed,snapshot,finish};
}
test('same-form input written after submit survives and the next operation uses the confirmed version',async()=>{
  const f=fixture(),form=f.form('PROJECT');f.input(form,'story_background','submitted value');let saving=f.submit(form);await flush();const first=f.requests[0];assert.equal(f.save(form).disabled,true);assert.equal(form.elements.story_background.disabled,false);f.input(form,'story_background','unique later text');const saved=await f.finish(first,saving);
  assert.equal(f.form('PROJECT'),form);assert.equal(form.elements.story_background.value,'unique later text');assert.equal(f.save(form).disabled,false);assert.match(f.messages[0],/已保存.*当前新输入尚未保存/);
  saving=f.submit(form);await flush();const next=f.requests.at(-1);assert.equal(JSON.parse(next.options.body).expected_version,saved.version);assert.equal(JSON.parse(next.options.body).updates.story_background,'unique later text');await f.finish(next,saving);
});
test('saving PROJECT preserves an unsaved SYSTEM field and the visible group',async()=>{
  const f=fixture(),project=f.form('PROJECT'),system=f.form('SYSTEM');f.input(project,'story_background','submitted');const saving=f.submit(project);await flush();f.root.all().find(node=>node.textContent==='系统与 AI').onclick();f.input(system,'ai_context_max_chars','13579');await f.finish(f.requests[0],saving);
  assert.equal(f.form('SYSTEM'),system);assert.equal(system.elements.ai_context_max_chars.value,'13579');assert.equal(f.context.state.configSection,'SYSTEM');assert.equal(system.parent.hidden,false);
});
test('a returned page owns its new form and a late old save never rebases that form',async()=>{
  const f=fixture(),old=f.form('PROJECT');f.input(old,'story_background','old submitted');const saving=f.submit(old);await flush();f.context.state.workspace='story.sources';f.context.state.workspace='project.configuration';f.context.renderConfigurations();const current=f.form('PROJECT');f.input(current,'story_background','unique returned input');await f.finish(f.requests[0],saving);
  assert.notEqual(current,old);assert.equal(current.elements.story_background.value,'unique returned input');assert.equal(f.context.state.configurations.values.PROJECT.version,2);
  const next=f.submit(current);await flush();const request=f.requests.at(-1);assert.equal(JSON.parse(request.options.body).expected_version,1);request.reject(Error('version conflict'));await flush();f.requests.at(-1).resolve(f.snapshot(f.committed(f.requests[0])));await next;assert.equal(current.elements.story_background.value,'unique returned input');assert.match(f.notice(current).textContent,/版本已有变化/);
});
test('a confirmed PATCH and failed GET cannot be mislabeled unsaved or repeated unchanged',async()=>{
  const f=fixture(),form=f.form('PROJECT');f.input(form,'story_background','saved input');const saving=f.submit(form);await flush();f.requests[0].resolve(f.committed(f.requests[0]));await flush();f.requests[1].reject(Error('read offline'));await saving;
  assert.match(f.notice(form).textContent,/已保存.*暂未刷新/);assert.equal(f.save(form).disabled,true);await f.submit(form);assert.equal(f.requests.filter(request=>request.options.method==='PATCH').length,1);assert.equal(form.elements.story_background.value,'saved input');
  f.input(form,'story_background','next explicit input');assert.equal(f.save(form).disabled,false);
});
test('unknown PATCH retains its exact operation and a retry first recognizes committed configuration',async()=>{
  const f=fixture(),form=f.form('PROJECT');f.input(form,'story_background','original operation');let saving=f.submit(form);await flush();const first=f.requests[0];first.reject(Error('response lost'));await flush();f.requests[1].reject(Error('read unavailable'));await saving;assert.match(f.notice(form).textContent,/结果待确认/);
  f.input(form,'story_background','new input not submitted');saving=f.submit(form);await flush();assert.equal(f.requests.at(-1).url,'/api/configurations');f.requests.at(-1).resolve(f.snapshot(f.committed(first)));await saving;
  assert.equal(f.requests.filter(request=>request.options.method==='PATCH').length,1);assert.equal(form.elements.story_background.value,'new input not submitted');assert.match(f.messages.at(-1),/当前新输入尚未保存/);assert.equal(f.save(form).disabled,false);
});
test('a known absent write retries the original version and payload only after explicit submit',async()=>{
  const f=fixture(),form=f.form('PROJECT');f.input(form,'story_background','same retry');let saving=f.submit(form);await flush();const first=f.requests[0];first.reject(Error('request rejected'));await flush();f.requests.at(-1).resolve(f.snapshot());await saving;assert.equal(f.requests.filter(request=>request.options.method==='PATCH').length,1);
  saving=f.submit(form);await flush();f.requests.at(-1).resolve(f.snapshot());await flush();const second=f.requests.at(-1);assert.equal(second.options.body,first.options.body);await f.finish(second,saving);
});
test('a different or later configuration never authorizes overwriting with a higher version',async()=>{
  const f=fixture(),form=f.form('PROJECT');f.input(form,'story_background','my input');let saving=f.submit(form);await flush();f.requests[0].reject(Error('conflict'));await flush();const later={...f.committed(f.requests[0]),version:3,body:{story_background:'different writer'}};f.requests.at(-1).resolve(f.snapshot(later));await saving;
  assert.equal(form.elements.story_background.value,'my input');assert.match(f.notice(form).textContent,/版本已有变化/);saving=f.submit(form);await flush();f.requests.at(-1).resolve(f.snapshot(later));await saving;assert.equal(f.requests.filter(request=>request.options.method==='PATCH').length,1);
});
test('same form cannot double submit, and an old read cannot roll back a newer saved scope',async()=>{
  const f=fixture(),project=f.form('PROJECT'),system=f.form('SYSTEM');f.input(project,'story_background','new project');f.input(system,'ai_context_max_chars','14000');const a=f.submit(project);await f.submit(project);await flush();assert.equal(f.requests.length,1);const b=f.submit(system);await flush();const savedProject=f.committed(f.requests[0]),savedSystem=f.committed(f.requests[1]);f.requests[0].resolve(savedProject);f.requests[1].resolve(savedSystem);await flush();assert.equal(f.requests.length,4);
  const newer=f.snapshot(savedProject,savedSystem);newer.favicon={url:'/new-icon',mime:'image/svg+xml'};f.requests[3].resolve(newer);await b;f.requests[2].resolve(f.snapshot(savedProject));await a;
  assert.equal(f.context.state.configurations.values.SYSTEM.version,2);assert.equal(f.context.state.configurations.values.SYSTEM.body.ai_context_max_chars,14000);assert.equal(f.context.state.configurations.favicon.url,'/new-icon');assert.equal(f.form('SYSTEM'),system);
});
test('favicon upload and clear retain save locking and unsaved icon selection',async()=>{
  const f=fixture(),form=f.form('SYSTEM');f.input(form,'ai_context_max_chars','14000');const saving=f.submit(form);await flush();const patch=f.requests[0],file=form.all().find(node=>node.type==='file');file.files=[{size:4,name:'new.svg'}];const upload=file.onchange();await flush();assert.equal(f.save(form).disabled,true);const request=f.requests.at(-1);assert.equal(request.url,'/api/favicon');request.resolve({file:'new.svg'});await upload;assert.equal(f.save(form).disabled,true);assert.equal(form.elements.site_favicon.value,'new.svg');await f.finish(patch,saving);assert.equal(form.elements.site_favicon.value,'new.svg');assert.equal(f.save(form).disabled,false);
  const saveIcon=f.submit(form);await flush();await f.finish(f.requests.at(-1),saveIcon);assert.equal(f.save(form).disabled,true);form.all().find(node=>node.textContent==='清空，恢复默认').onclick();assert.equal(form.elements.site_favicon.value,'');assert.equal(f.save(form).disabled,false);
});
test('navigation during unknown-result lookup never posts again or changes the new form',async()=>{
  const f=fixture(),old=f.form('PROJECT');f.input(old,'story_background','original');const saving=f.submit(old);await flush();f.requests[0].reject(Error('lost'));await flush();f.context.renderConfigurations();const next=f.form('PROJECT');f.input(next,'story_background','new form input');f.requests.at(-1).resolve(f.snapshot());await saving;
  assert.equal(next.elements.story_background.value,'new form input');assert.equal(f.requests.filter(request=>request.options.method==='PATCH').length,1);assert.deepEqual(f.messages,[]);
});
