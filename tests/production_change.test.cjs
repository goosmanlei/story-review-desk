const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value)),flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node{
  constructor(tag,cls){Object.assign(this,{tag,className:cls||'',children:[],dataset:{},attrs:{},value:'',disabled:false,isConnected:true});this.classList={add(){},remove(){},toggle(){}}}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n)}}
  detach(){this.isConnected=false;this.children.forEach(n=>n.detach())}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.detach()}
  replaceChildren(...nodes){this.children.forEach(n=>n.detach());this.children=[];this.append(...nodes)}
  replaceWith(n){const p=this.parent;assert.ok(p);const index=p.children.indexOf(this);this.detach();n.parent=p;p.children[index]=n}
  insertBefore(n,ref){n.parent=this;this.children.splice(this.children.indexOf(ref),0,n)}
  setAttribute(k,v){this.attrs[k]=v}
  all(){return this.children.flatMap(n=>[n,...n.all()])}
  querySelectorAll(selector){assert.equal(selector,'.production-editor');return this.all().filter(n=>n.className.split(' ').includes('production-editor'))}
  get childElementCount(){return this.children.length}
}
const record=(object_id,kind,payload={})=>({object_id,id:object_id+'-r1',current_revision:object_id+'-r1',kind,version:1,payload:{title:object_id,...payload}});
const change={object_id:'upstream',used_revision:'upstream-r1',current_revision:'upstream-r2',target:{object_id:'exact-use',revision_id:'exact-use-r1'}};
const ready=(scope,count=1)=>({scope:record(scope,'EPISODE'),required_count:count,missing_count:count,inputs_ready:false,package_available:false,requirements:Array.from({length:count},(_,i)=>({requirement:record(scope+'-need-'+String(i+1).padStart(2,'0'),'REQUIREMENT',{purpose:'technical test',usage:'post_audio',required:true}),issues:['upstream_needs_review'],pending_changes:[plain(change)]}))});
function fixture(){
  const host=new Node('main'),episodes=[record('episode-A','EPISODE'),record('episode-B','EPISODE')],records=episodes.flatMap(e=>['a','b'].map(letter=>record(e.object_id+'-prep-'+letter,'PREPARATION',{source:{object_id:e.object_id,revision_id:e.id,scene_id:'scene-'+letter}})));
  const messages=[],requests=[],reads=[],posts=[];
  const context={state:{workspace:'production.workspace',screenplays:[{episodes}]},URL,URLSearchParams,location:{href:'http://fixture/?workspace=production.workspace'},document:{querySelectorAll:()=>[]},isProduction:()=>true,renderComments(){},toast:text=>messages.push(text),el:(tag,cls)=>new Node(tag,cls),nodeText:(tag,cls,text,parent)=>{const n=new Node(tag,cls);n.textContent=text;parent.append(n);return n},crypto:require('node:crypto').webcrypto};
  context.api=async(url,options)=>{
    if(options?.method==='POST')posts.push(JSON.parse(options.body));
    if(url==='/api/production')return {records};
    if(url.startsWith('/api/production?')){const id=new URL(url,'http://fixture').searchParams.get('object_id');return {record:records.find(r=>r.object_id===id),history:[],uses:[]}}
    return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
  };
  context.fetch=url=>new Promise((resolve,reject)=>reads.push({url,resolve,reject}));
  context.$=selector=>selector==='#production-view'?host:host.all().find(n=>n.id===selector.slice(1));
  context.history={replaceState(_state,_title,url){context.location.href=String(url)}};
  context.Option=function(text,value){const n=new Node('option');n.textContent=text;n.value=value;return n};
  vm.createContext(context);vm.runInContext(source,context);
  context.renderProductionReader=()=>{const root=context.$('#production-reader');root.replaceChildren();context.nodeText('p',null,context.state.productionSelected.object_id,root)};
  context.productionRefLink=()=>{};
  const byLabel=label=>host.all().find(n=>n.attrs['aria-label']===label),button=(label,root=host)=>root.all().find(n=>n.tag==='button'&&n.textContent===label),text=root=>root.all().map(n=>n.textContent||'').join('\n');
  const form=box=>({box,field:label=>box.all().find(n=>n.attrs['aria-label']===label),button:label=>button(label,box),notice:()=>box.all().find(n=>n.attrs.role==='status')});
  const open=(options={},parent=host)=>{context.showProductionChange(parent,plain(change),options);const f=form(parent.children.at(-1));f.field('变更处理').value='keep';f.field('复核者').value='Technical reviewer';f.field('复核依据').value='Keep the exact original reference';return f};
  return {context,host,episodes,records,messages,requests,reads,posts,byLabel,button,text,form,open};
}
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
const saved=request=>({object_id:request.object_id,kind:'JUDGMENT',version:1,payload:plain(request.payload)});
async function scope(f,episode,count=1){const ep=f.byLabel('制作分集');if(ep.value!==episode){ep.value=episode;ep.onchange();await flush()}const action=f.button('检查本集素材缺项').onclick();await flush();f.requests.at(-1).resolve(ready(episode,count));await action;return f.byLabel('所选集场素材缺项')}
function fill(f,box){const form=f.form(box);form.field('变更处理').value='keep';form.field('复核者').value='Technical reviewer';form.field('复核依据').value='Keep exact reference';return form}

test('a late saved judgment leaves the newer episode, all-scenes filter and readiness intact',async()=>{
  const f=fixture();await f.context.loadProductionWorkspace();const a=await scope(f,'episode-A');await f.button('记录变更处理',a).onclick();const old=fill(f,a.querySelectorAll('.production-editor')[0]);const saving=old.button('保存变更处理').onclick();await flush();const post=f.requests.at(-1);
  const b=await scope(f,'episode-B');const before=f.text(b);post.resolve({saved:true});await saving;
  assert.equal(f.byLabel('制作分集').value,'episode-B');assert.equal(f.byLabel('制作场次').value,'');assert.equal(b.hidden,false);assert.equal(f.text(b),before);assert.equal(f.requests.filter(r=>r.url.includes('readiness')).length,2);assert.match(f.messages.at(-1),/「upstream」.*已保存/);assert.equal(f.posts.length,1);
});
test('late failures after navigation and success or failure after cancel never redraw another editor',async()=>{
  for(const mode of ['navigation-failure','cancel-failure','cancel-success']){
    const f=fixture(),old=f.open();const saving=old.button('保存变更处理').onclick();await flush();
    if(mode.startsWith('navigation'))f.context.state.workspace='story.workspace';else await old.button('取消').onclick();
    const next=f.open();next.field('复核依据').value='a different new opinion';
    if(mode.endsWith('success'))f.requests[0].resolve({});else f.requests[0].reject(Error('late old failure'));await saving;
    assert.equal(next.box.isConnected,true);assert.equal(next.field('复核依据').value,'a different new opinion');assert.equal(f.reads.length,0);assert.equal(f.messages.length,mode.endsWith('success')?1:0);
  }
});
test('same scope refresh preserves page, title, close control and record body',async()=>{
  const f=fixture();await f.context.loadProductionWorkspace();const panel=await scope(f,'episode-A',45);await f.button('下一页',panel).onclick();await f.button('记录变更处理',panel).onclick();const old=fill(f,panel.querySelectorAll('.production-editor')[0]);const reader=f.context.$('#production-reader'),readerText=f.text(reader);const saving=old.button('保存变更处理').onclick();await flush();f.requests.at(-1).resolve({});await flush();assert.match(f.requests.at(-1).url,/readiness.*episode-A/);f.requests.at(-1).resolve(ready('episode-A',45));await saving;
  assert.equal(f.text(reader),readerText);assert.equal(panel.querySelectorAll('.production-editor').length,0);assert.equal(panel.all().find(n=>n.tag==='strong').textContent,'episode-A-need-21');assert.match(f.text(panel),/第 21–40 项/);assert.match(f.text(panel),/episode-A/);assert.equal(f.byLabel('制作场次').value,'');await f.button('收起缺项检查',panel).onclick();assert.equal(panel.hidden,true);
});
test('a successful POST and failed local GET remain saved and cannot post twice',async()=>{
  const f=fixture();await f.context.loadProductionWorkspace();const panel=await scope(f,'episode-A');await f.button('记录变更处理',panel).onclick();const old=fill(f,panel.querySelectorAll('.production-editor')[0]);const saving=old.button('保存变更处理').onclick();await flush();f.requests.at(-1).resolve({});await flush();f.requests.at(-1).reject(Error('readiness unavailable'));await saving;
  assert.match(old.notice().textContent,/已保存，但当前检查尚未更新/);assert.equal(old.button('保存变更处理').disabled,true);await old.button('保存变更处理').onclick();assert.equal(f.posts.length,1);assert.equal(old.field('复核依据').value,'Keep exact reference');
});
test('in-flight fields and same-editor repeated save are locked to one exact request',async()=>{
  const f=fixture(),form=f.open();const first=form.button('保存变更处理').onclick();await flush();for(const label of ['变更处理','复核者','复核依据'])assert.equal(form.field(label).disabled,true);assert.equal(form.button('取消').disabled,false);
  form.field('变更处理').value='rework';await form.button('保存变更处理').onclick();assert.equal(f.posts.length,1);assert.equal(f.posts[0].payload.change.action,'keep');f.requests[0].resolve({});await first;
});
test('lost POST response recognizes exact created judgment and leaves actual adoption alone',async()=>{
  const f=fixture(),form=f.open();const saving=form.button('保存变更处理').onclick();await flush();f.requests[0].reject(Error('response lost after commit'));await flush();assert.match(f.reads[0].url,new RegExp(encodeURIComponent(f.posts[0].object_id)));const head=saved(f.posts[0]);head.payload=Object.fromEntries(Object.entries(head.payload).reverse());f.reads[0].resolve(response(200,{record:head}));await saving;
  assert.equal(f.posts.length,1);assert.equal(form.box.isConnected,false);assert.match(f.messages.at(-1),/已保存.*没有自动换版/);
});
test('unknown result retries exact lookup before posting and retains the request snapshot',async()=>{
  const f=fixture(),form=f.open();let saving=form.button('保存变更处理').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();f.reads[0].reject(Error('readback offline'));await saving;assert.match(form.notice().textContent,/结果待确认/);assert.equal(form.field('复核依据').disabled,false);
  saving=form.button('保存变更处理').onclick();await flush();assert.equal(f.posts.length,1);f.reads[1].resolve(response(200,{record:saved(f.posts[0])}));await saving;assert.equal(f.posts.length,1);assert.equal(form.box.isConnected,false);
});
test('known absent request retries the same id and exact payload; conflict can recover only that request',async()=>{
  const f=fixture(),form=f.open();let saving=form.button('保存变更处理').onclick();await flush();f.requests[0].reject(Error('rejected'));await flush();f.reads[0].resolve(response(404,{}));await saving;
  saving=form.button('保存变更处理').onclick();await flush();f.reads[1].resolve(response(404,{}));await flush();assert.deepEqual(f.posts[1],f.posts[0]);assert.equal(f.posts[1].expected_version,0);f.requests[1].reject(Error('HTTP 409'));await flush();f.reads[2].resolve(response(200,{record:saved(f.posts[0])}));await saving;assert.equal(form.box.isConnected,false);assert.equal(f.posts.length,2);
});
test('foreign payload, wrong id or later version is never adopted as this saved judgment',async()=>{
  for(const mutate of [head=>head.payload.reason='someone else',head=>head.version++,head=>head.object_id='another-id']){
    const f=fixture(),form=f.open();let saving=form.button('保存变更处理').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();const head=saved(f.posts[0]);mutate(head);f.reads[0].resolve(response(200,{record:head}));await saving;assert.match(form.notice().textContent,/已有不同内容/);assert.equal(form.box.isConnected,true);assert.ok(!f.messages.some(s=>s.includes('结论已保存')));
    saving=form.button('保存变更处理').onclick();await flush();f.reads[1].resolve(response(200,{record:head}));await saving;assert.equal(f.posts.length,1);
  }
});
test('changed input after unknown result cannot describe the old saved request as new input',async()=>{
  const f=fixture(),form=f.open();let saving=form.button('保存变更处理').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();f.reads[0].reject(Error('offline'));await saving;form.field('复核依据').value='A new different decision';form.field('变更处理').value='rework';
  saving=form.button('保存变更处理').onclick();await flush();f.reads[1].resolve(response(200,{record:saved(f.posts[0])}));await saving;assert.match(form.notice().textContent,/当前修改尚未提交/);assert.equal(f.posts.length,1);assert.equal(form.field('复核依据').value,'A new different decision');assert.equal(form.box.isConnected,true);
});
test('cancel while reading an unknown save prevents a repeated POST and any new-editor mutation',async()=>{
  const f=fixture(),old=f.open();const saving=old.button('保存变更处理').onclick();await flush();f.requests[0].reject(Error('lost'));await flush();await old.button('取消').onclick();const next=f.open();f.reads[0].resolve(response(404,{}));await saving;assert.equal(f.posts.length,1);assert.equal(f.messages.length,0);assert.equal(next.box.isConnected,true);
});
test('other editors, cancel, paging or changed scope during local refresh prevent replacement',async()=>{
  for(const mode of ['other-before','other-during','cancel-during','page-during','scope-during']){
    const f=fixture();await f.context.loadProductionWorkspace();const panel=await scope(f,'episode-A',45);await f.button('记录变更处理',panel).onclick();const old=fill(f,panel.querySelectorAll('.production-editor')[0]);const saving=old.button('保存变更处理').onclick();await flush();const post=f.requests.at(-1);
    let next;if(mode==='other-before')next=f.open({},old.box.parent);
    post.resolve({});await flush();
    if(mode==='other-before'){await saving;assert.equal(next.box.isConnected,true);assert.equal(f.requests.filter(r=>r.url.includes('readiness')).length,1);continue}
    const refreshing=f.requests.at(-1);
    if(mode==='other-during')next=f.open({},old.box.parent);
    if(mode==='cancel-during')await old.button('取消').onclick();
    if(mode==='page-during')await f.button('下一页',panel).onclick();
    if(mode==='scope-during')await scope(f,'episode-B',1);
    const before=f.text(panel);refreshing.resolve(ready('episode-A',45));await saving;assert.equal(f.text(panel),before);if(next)assert.equal(next.box.isConnected,true);
  }
});

test('download labels use the exact readiness scope, including kind-less screenplay snapshots',async()=>{
  for(const [kind,label] of [['EPISODE','本集'],['PREPARATION','本场'],['SHOT_DESIGN','逐镜'],['STATE','状态参考']]){
    const f=fixture(),subject=record('accurate-scope',kind);
    // screenplay.snapshot() emits episode payload/revision without a kind field.
    if(kind==='EPISODE'){delete subject.kind;subject.payload.format='screenplay-episode-v1'}
    f.context.state.productionSelected=subject;
    const rendering=f.context.renderProductionReadiness(f.host,subject);await flush();
    f.requests[0].resolve({...ready(subject.object_id),scope:record(subject.object_id,kind)});await rendering;
    assert.equal(f.requests[0].url,'/api/production/readiness?scope=accurate-scope');
    const buttons=f.host.all().filter(n=>n.tag==='button'&&n.textContent.startsWith('下载'));
    assert.equal(buttons.length,1);assert.equal(buttons[0].textContent,'下载'+label+(kind==='STATE'?'清单':'输入清单'));
  }
});

function materialJudgmentFixture(){
  const f=fixture();f.context.state.workspace='materials.workspace';f.context.location.href='http://fixture/?workspace=materials.workspace&production_object=asset-A';
  f.records.splice(0,f.records.length,record('asset-A','ASSET',{components:[]}),record('asset-B','ASSET',{components:[]}));
  f.context.productionEntityIcon=()=>new Node('svg');vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static/material-review.js'),'utf8'),f.context);return f;
}
function openMaterialJudgment(f){
  const root=f.context.$('#production-reader');f.context.showProductionJudgment(root);const form=f.form(root.children.at(-1));
  form.field('审阅结果').value='passed';form.field('审阅者').value='Technical reviewer';form.field('结论依据').value='Exact asset candidate';return form;
}
test('judgment refresh reports a failed own detail read through the actual load and open functions',async()=>{
  const f=materialJudgmentFixture();await f.context.loadProductionWorkspace();const form=openMaterialJudgment(f),original=f.context.api;
  f.context.api=(url,options)=>url.startsWith('/api/production?')?Promise.reject(Error('own detail unavailable')):original(url,options);
  const saving=form.button('保存审阅').onclick();await flush();f.requests.at(-1).resolve({});await saving;
  assert.equal(f.posts.length,1);assert.equal(form.box.isConnected,false);assert.ok(f.messages.some(s=>s.includes('已保存')&&s.includes('页面尚未完整更新')&&s.includes('own detail unavailable')),JSON.stringify(f.messages));
});
test('judgment refresh cannot report its old failure after a real new read or workspace takes over',async()=>{
  for(const takeover of ['new-read','new-workspace']){
    const f=materialJudgmentFixture();await f.context.loadProductionWorkspace();const form=openMaterialJudgment(f),original=f.context.api,details=[];
    f.context.api=(url,options)=>url.startsWith('/api/production?')?new Promise((resolve,reject)=>details.push({url,resolve,reject})):original(url,options);
    const saving=form.button('保存审阅').onclick();await flush();f.requests.at(-1).resolve({});await flush();assert.equal(details.length,1);
    let newer;
    if(takeover==='new-read'){
      newer=f.context.openProductionRecord('asset-B');await flush();assert.equal(details.length,2);
      details[1].resolve({record:f.records[1],history:[],uses:[]});await newer;
      assert.equal(f.context.state.productionSelected.object_id,'asset-B');
    }else f.context.state.workspace='story.workspace';
    details[0].reject(Error('late old detail unavailable'));await saving;
    assert.equal(f.posts.length,1);assert.ok(f.messages.some(s=>s.includes('asset-A')&&s.includes('已记录')));
    assert.ok(!f.messages.some(s=>s.includes('late old detail unavailable')),JSON.stringify(f.messages));
    if(takeover==='new-read')assert.equal(f.context.state.productionSelected.object_id,'asset-B');
  }
});

test('list load failure replaces its own loading message and keeps the error for the save caller',async()=>{
 const f=fixture(),failure=Error('list unavailable');f.context.api=async()=>{throw failure};
 await assert.rejects(f.context.loadProductionWorkspace(),error=>error===failure);
 assert.match(f.text(f.host),/制作记录读取失败：list unavailable/);assert.match(f.text(f.host),/左侧导航/);assert.doesNotMatch(f.text(f.host),/正在读取/);
});
test('a failed list load cannot replace newer loading, another detail read or another workspace',async()=>{
 for(const takeover of ['new-load','new-read','workspace','detached']){
  const f=fixture(),requests=[];f.context.api=()=>new Promise((resolve,reject)=>requests.push({resolve,reject}));
  const old=f.context.loadProductionWorkspace();let newer;
  if(takeover==='new-load')newer=f.context.loadProductionWorkspace();
  if(takeover==='new-read')newer=f.context.openProductionRecord('new-target');
  if(takeover==='workspace')f.context.state.workspace='story.sources';
  if(takeover==='detached')f.host.replaceChildren(new Node('p'));
  const before=f.text(f.host);requests[0].reject(Error('old list unavailable'));await assert.rejects(old,/old list unavailable/);assert.equal(f.text(f.host),before);
  if(newer){requests[1].reject(Error('new request unavailable'));await assert.rejects(newer,/new request unavailable/);if(takeover==='new-load')assert.match(f.text(f.host),/new request unavailable/)}
 }
});
test('saved judgment and failed actual list refresh show both saved feedback and a recoverable error page',async()=>{
 const f=materialJudgmentFixture();await f.context.loadProductionWorkspace();const form=openMaterialJudgment(f),original=f.context.api;
 f.context.api=(url,options)=>url==='/api/production'?Promise.reject(Error('list unavailable')):original(url,options);
 const saving=form.button('保存审阅').onclick();await flush();f.requests.at(-1).resolve({});await saving;
 assert.equal(f.posts.length,1);assert.ok(f.messages.some(s=>s.includes('已保存')&&s.includes('页面尚未完整更新')));assert.match(f.text(f.host),/制作记录读取失败/);assert.doesNotMatch(f.text(f.host),/正在读取/);
});
