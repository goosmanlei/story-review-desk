const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const asset=(object_id,id=object_id+'-v1',version=1)=>({object_id,id,version,kind:'ASSET',payload:{title:object_id,media_type:'video',components:[{id:'original',role:'original'},{id:'preview',role:'preview'}]}});
class Element{
  constructor(tag,cls=''){this.tag=tag;this.className=cls;this.children=[];this.attrs={};this._value='';this.disabled=false;this.parent=null}
  get isConnected(){return this.root===true||!!this.parent?.isConnected}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);if(this.tag==='select'&&this.children.length===1)this._value=node.value}}
  replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this._value='';this.append(...nodes)}
  setAttribute(key,value){this.attrs[key]=value}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null}
  get value(){return this._value}set value(value){this._value=String(value)}
  all(){return this.children.flatMap(child=>[child,...child.all()])}
}
function setup(options={}){
  const root=new Element('main');root.root=true;
  const requests=[],posts=[],postUrls=[],messages=[];
  const context={state:{workspace:'production.workspace',productionRecords:[{object_id:'history-scene',id:'history-scene-r1',kind:'PREPARATION',payload:{title:'History scene'}}]},crypto:{randomUUID:()=>String(posts.length)},
    el:(tag,cls)=>new Element(tag,cls),Option:function(text,value){const option=new Element('option');option.textContent=text;option.value=value;return option},
    nodeText:(tag,cls,text,parent)=>{const node=new Element(tag);node.textContent=text;parent.append(node);return node},toast:message=>messages.push(message),
    api:(url,options)=>{if(options?.method==='POST'){posts.push(JSON.parse(options.body));postUrls.push(url);return Promise.resolve({})}return new Promise((resolve,reject)=>requests.push({url,resolve,reject}))}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(source,context);context.loadProductionWorkspace=async()=>{context.reloads++};context.reloads=0;
  const row={requirement:{object_id:'need',id:'need-exact',kind:'REQUIREMENT',payload:{title:'Input',media_type:'video',scope:{object_id:'shot',revision_id:'shot-exact'},slot:'main',usage:'generation_input',purpose:'Technical input',required:true}},issues:[],adoption:options.adoption===undefined?{object_id:'existing-adoption',version:3}:options.adoption};
  // Existing history/save tests use the real explicit-candidate entry contract.
  // Lazy tests deliberately omit this field and use a history-only page index.
  if(!options.lazy)row.candidates=options.candidates??[asset('A'),asset('B')];
  const form=box=>({box,field:label=>box.all().find(node=>node.attrs['aria-label']===label),button:label=>box.all().find(node=>node.tag==='button'&&node.textContent===label)});
  const open=()=>{context.showProductionAdoption(root,row);return form(root.children.at(-1))};
  const choose=(form,id)=>{form.field('选择素材').value=id;return form.field('选择素材').onchange()};
  const resolve=(request,records)=>request.resolve({history:records});
  return {context,root,requests,posts,postUrls,messages,open,choose,resolve,row,form};
}

test('history-only readiness opens the real lazy selector and posts the chosen historical file with the original contract', {timeout:2000}, async()=>{
  const t=setup({lazy:true,adoption:null}),scope={object_id:'shot',id:'shot-exact',kind:'SHOT_DESIGN'};t.context.state.productionSelected=scope;
  const rendering=t.context.renderProductionReadiness(t.root,scope);
  assert.equal(t.requests[0].url,'/api/production/readiness?scope=shot');
  t.requests[0].resolve({requirements:[t.row],required_count:1,missing_count:1,inputs_ready:false,package_available:false});await rendering;
  assert.equal(t.requests.length,1,'opening readiness alone does not fetch the asset inventory');
  assert.equal(t.context.state.productionRecords.some(r=>r.kind==='ASSET'),false);assert.equal(Object.hasOwn(t.row,'candidates'),false);
  await t.root.all().find(n=>n.tag==='button'&&n.textContent==='选择素材版本').onclick();
  const form=t.form(t.root.all().find(n=>n.className==='production-editor'));
  assert.equal(t.requests[1].url,'/api/production?kind=ASSET');assert.equal(form.field('选择素材').disabled,true);assert.equal(form.button('确认采用此原件').disabled,true);
  form.field('采用理由').value='explicit old revision';await t.choose(form,'A');await form.button('确认采用此原件').onclick();
  assert.equal(t.requests.length,2);assert.equal(t.posts.length,0,'loading cannot issue detail or adoption writes');
  const a2=asset('A','A-v2',2),otherMedia=asset('audio');otherMedia.payload.media_type='audio';const placeholder=asset('placeholder');placeholder.payload.placeholder=true;
  t.requests[1].resolve({records:[a2,asset('B'),a2,otherMedia,{...asset('not-asset'),kind:'REQUIREMENT'},placeholder]});await flush();
  assert.deepEqual(form.field('选择素材').children.map(n=>n.value),['','A','B','placeholder'],'same-media inventory is deduplicated without silently removing placeholder capability');
  assert.equal(form.field('选择素材').disabled,false);assert.equal(form.field('选择素材').value,'');assert.equal(form.button('确认采用此原件').disabled,true);
  const choosing=t.choose(form,'A');assert.equal(t.requests[2].url,'/api/production?object_id=A');t.resolve(t.requests[2],[a2,asset('A')]);await choosing;
  form.field('候选记录修订').value='A-v1';form.field('候选记录修订').onchange();form.field('采用文件组成').value='preview';
  form.field('入点秒（可选）').value='.2';form.field('出点秒（可选）').value='.8';
  for(const [label,value] of [['裁切左边比例','.1'],['裁切上边比例','.2'],['裁切宽度比例','.5'],['裁切高度比例','.6']])form.field(label).value=value;
  await form.button('确认采用此原件').onclick();
  assert.deepEqual(t.postUrls,['/api/production/adopt']);assert.deepEqual(t.posts,[{object_id:'adoption-0',expected_version:0,payload:{format:'production-relation-v1',title:'Input · 采用',blocks:[{id:'adoption',text:'explicit old revision'}],relation_type:'adoption',scope:{object_id:'shot',revision_id:'shot-exact'},slot:'main',asset:{object_id:'A',revision_id:'A-v1'},component_id:'preview',usage:'generation_input',reason:'explicit old revision',range:{start_seconds:.2,end_seconds:.8},crop:{x:.1,y:.2,width:.5,height:.6}}}]);
  assert.equal(t.context.reloads,1);assert.equal(t.context.state.productionRecords.some(r=>r.kind==='ASSET'),false,'inventory does not change page navigation records');
});

for(const candidates of [[],[asset('A')]])test(`explicit ${candidates.length}-candidate scope never expands to the global inventory`,()=>{
  const t=setup({candidates});t.context.state.productionRecords.push(asset('B'));const form=t.open();
  assert.deepEqual(form.field('选择素材').children.map(n=>n.value),['',...candidates.map(r=>r.object_id)]);assert.equal(t.requests.length,0);assert.equal(form.button('确认采用此原件').disabled,true);
});

for(const fail of [false,true])test(`cancel/reopen isolates a late ${fail?'failed':'successful'} inventory from the new editor`,{timeout:2000},async()=>{
  const t=setup({lazy:true}),old=t.open();await old.button('取消').onclick();const next=t.open();next.field('采用理由').value='new editor reason';
  t.requests[1].resolve({records:[asset('B')]});await flush();
  if(fail)t.requests[0].reject(Error('closed inventory failure'));else t.requests[0].resolve({records:[asset('A')]});await flush();
  assert.deepEqual(next.field('选择素材').children.map(n=>n.value),['','B']);assert.equal(next.field('采用理由').value,'new editor reason');assert.deepEqual(t.messages,[]);
  assert.equal(old.field('选择素材').children.length,1);await old.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
});

for(const [name,invalidate] of Object.entries({detached:(_t,f)=>f.box.remove(),workspace:t=>{t.context.state.workspace='story.sources'},read:t=>vm.runInContext('++productionReadEpoch',t.context),load:t=>vm.runInContext('++productionLoadEpoch',t.context)}))test(`initial inventory cannot populate or submit after ${name} ownership changes`,{timeout:2000},async()=>{
  for(const fail of [false,true]){
    const t=setup({lazy:true}),form=t.open();invalidate(t,form);
    if(fail)t.requests[0].reject(Error('obsolete inventory failure'));else t.requests[0].resolve({records:[asset('A')]});await flush();
    assert.equal(form.field('选择素材').children.length,1);assert.equal(form.button('确认采用此原件').disabled,true);assert.deepEqual(t.messages,[]);
    await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  }
});

for(const response of ['network',null,{},[{kind:'ASSET',payload:null}]])test(`failed or malformed inventory ${JSON.stringify(response)} preserves input without falling back to the page index`,{timeout:2000},async()=>{
  const t=setup({lazy:true});t.context.state.productionRecords.push(asset('stale-page-asset'));const form=t.open();form.field('采用理由').value='keep this reason';
  if(response==='network')t.requests[0].reject(Error('inventory unavailable'));else t.requests[0].resolve({records:response});await flush();
  assert.deepEqual(form.field('选择素材').children.map(n=>n.value),['']);assert.equal(form.field('候选记录修订').children.length,0);assert.equal(form.field('采用文件组成').children.length,0);
  assert.equal(form.field('采用理由').value,'keep this reason');assert.equal(form.button('确认采用此原件').disabled,true);assert.equal(t.messages.length,1);
  await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  await form.button('取消').onclick();const next=t.open();t.requests[1].resolve({records:[asset('A')]});await flush();
  assert.deepEqual(next.field('选择素材').children.map(n=>n.value),['','A']);assert.equal(next.field('选择素材').disabled,false);
});

test('late A response cannot replace B selection or the adopted exact revision', {timeout:2000}, async()=>{
  const t=setup(),form=t.open();form.field('采用理由').value='technical fixture';
  const first=t.choose(form,'A'),second=t.choose(form,'B');
  t.resolve(t.requests[1],[asset('B')]);await second;
  t.resolve(t.requests[0],[asset('A')]);await first;
  assert.equal(form.field('选择素材').value,'B');assert.equal(form.field('候选记录修订').value,'B-v1');
  await form.button('确认采用此原件').onclick();
  assert.deepEqual(plain(t.posts[0].payload.asset),{object_id:'B',revision_id:'B-v1'});
});

async function loadedAdoption(t){
  const form=t.open(),pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A')]);await pending;
  form.field('采用理由').value='exact attempted selection';return form;
}
const savedAdoption=request=>({object_id:request.object_id,kind:'RELATION',version:request.expected_version+1,payload:plain(request.payload)});

test('recovery: lost response recognizes only the exact created or updated head', {timeout:2000}, async()=>{
  for(const adoption of [null,{object_id:'existing-adoption',version:3}]){
    const t=setup({adoption}),form=await loadedAdoption(t);let sent,reads=0;
    form.field('入点秒（可选）').value='.2';form.field('出点秒（可选）').value='.8';
    for(const [label,value] of [['裁切左边比例','.1'],['裁切上边比例','.2'],['裁切宽度比例','.5'],['裁切高度比例','.6']])form.field(label).value=value;
    t.context.api=async(url,options)=>{
      if(options?.method==='POST'){sent=JSON.parse(options.body);t.posts.push(sent);throw Error('response lost after commit')}
      assert.equal(url,'/api/production?kind=RELATION');reads++;
      const head=savedAdoption(sent);head.payload=Object.fromEntries(Object.entries(head.payload).reverse());return {records:[head]};
    };
    await form.button('确认采用此原件').onclick();
    assert.equal(reads,1);assert.equal(t.posts.length,1);assert.equal(t.context.reloads,1);assert.ok(t.messages.includes('精确采用已保存'));
    assert.deepEqual(sent.payload.range,{start_seconds:.2,end_seconds:.8});assert.deepEqual(sent.payload.crop,{x:.1,y:.2,width:.5,height:.6});
  }
});

test('recovery: another id, content, or later head cannot be called this saved request', {timeout:2000}, async()=>{
  for(const change of [head=>{head.object_id='someone-else'},head=>{head.payload.reason='another decision'},head=>{head.version++}]){
    const t=setup({adoption:null}),form=await loadedAdoption(t);let sent;
    t.context.api=async(url,options)=>{if(options?.method==='POST'){sent=JSON.parse(options.body);t.posts.push(sent);throw Error('lost response')}
      const head=savedAdoption(sent);change(head);return {records:[head]}};
    await form.button('确认采用此原件').onclick();
    assert.equal(t.context.reloads,0);assert.ok(!t.messages.includes('精确采用已保存'));assert.ok(t.messages.some(v=>v.includes('采用已变化')));
    assert.equal(form.field('采用理由').value,'exact attempted selection');
    await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,1);
  }
});

test('recovery: a rejected write retries the original id and version without elevating it', {timeout:2000}, async()=>{
  for(const adoption of [null,{object_id:'existing-adoption',version:3}]){
    const t=setup({adoption}),form=await loadedAdoption(t);let attempt=0,first;
    t.context.api=async(url,options)=>{if(options?.method==='POST'){const request=JSON.parse(options.body);t.posts.push(request);if(!attempt++){first=request;throw Error('rejected before commit')}return {}}
      return {records:adoption?[{object_id:adoption.object_id,kind:'RELATION',version:adoption.version,payload:{relation_type:'adoption',scope:first.payload.scope,slot:first.payload.slot,reason:'previous'}}]:[]}};
    await form.button('确认采用此原件').onclick();assert.equal(t.context.reloads,0);assert.equal(form.button('确认采用此原件').disabled,false);
    await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,2);assert.deepEqual(t.posts[1],t.posts[0]);assert.equal(t.context.reloads,1);
  }
});

test('uncertain: failed readback retains the snapshot and retry first resolves it', {timeout:2000}, async()=>{
  const t=setup({adoption:null}),form=await loadedAdoption(t);let sent,reads=0;
  t.context.api=async(url,options)=>{if(options?.method==='POST'){sent=JSON.parse(options.body);t.posts.push(sent);throw Error('lost response')}
    if(!reads++)throw Error('readback unavailable');return {records:[savedAdoption(sent)]}};
  await form.button('确认采用此原件').onclick();assert.equal(t.context.reloads,0);assert.equal(form.field('采用理由').value,'exact attempted selection');
  await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,1);assert.equal(t.context.reloads,1);assert.ok(t.messages.includes('精确采用已保存'));
});

test('uncertain: editing after an unknown result cannot relabel the old save as new content', {timeout:2000}, async()=>{
  const t=setup({adoption:null}),form=await loadedAdoption(t);let sent,reads=0;
  t.context.api=async(url,options)=>{if(options?.method==='POST'){sent=JSON.parse(options.body);t.posts.push(sent);throw Error('lost response')}
    if(!reads++)throw Error('readback unavailable');return {records:[savedAdoption(sent)]}};
  await form.button('确认采用此原件').onclick();form.field('采用理由').value='a new judgment not yet saved';
  await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,1);assert.equal(t.context.reloads,0);
  assert.equal(form.field('采用理由').value,'a new judgment not yet saved');assert.ok(t.messages.some(v=>v.includes('当前修改尚未提交')));assert.ok(!t.messages.includes('精确采用已保存'));
});

test('uncertain: cancellation during readback prevents retry, reload and late errors', {timeout:2000}, async()=>{
  const t=setup({adoption:null}),form=await loadedAdoption(t);let resolveRead,started;
  const reading=new Promise(resolve=>{started=resolve});
  t.context.api=async(url,options)=>{if(options?.method==='POST'){t.posts.push(JSON.parse(options.body));throw Error('lost response')}
    started();return new Promise(resolve=>{resolveRead=resolve})};
  const save=form.button('确认采用此原件').onclick();await reading;
  for(const label of ['采用理由','入点秒（可选）','出点秒（可选）','裁切左边比例'])assert.equal(form.field(label).disabled,true);
  await form.button('取消').onclick();const next=t.open();resolveRead({records:[]});await save;
  assert.equal(t.posts.length,1);assert.equal(t.context.reloads,0);assert.deepEqual(t.messages,[]);assert.equal(next.box.isConnected,true);
});

test('recovery: missing or malformed current heads never authorize a stale update', {timeout:2000}, async()=>{
  for(const result of [{records:[]},{records:null}]){
    const t=setup(),form=await loadedAdoption(t);
    t.context.api=async(url,options)=>{if(options?.method==='POST'){t.posts.push(JSON.parse(options.body));throw Error('failed update')}return result};
    await form.button('确认采用此原件').onclick();await form.button('确认采用此原件').onclick();
    assert.equal(t.posts.length,1);assert.equal(t.context.reloads,0);assert.ok(!t.messages.includes('精确采用已保存'));assert.equal(form.field('采用理由').value,'exact attempted selection');
  }
});

test('loading and failed replacement clear old options and cannot submit the old asset', {timeout:2000}, async()=>{
  const t=setup(),form=t.open();form.field('采用理由').value='keep my reason';
  let pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A')]);await pending;
  pending=t.choose(form,'B');
  assert.equal(form.field('候选记录修订').children.length,0);assert.equal(form.field('采用文件组成').children.length,0);
  assert.equal(form.button('确认采用此原件').disabled,true);
  await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  t.requests[1].reject(Error('detail unavailable'));await pending;
  assert.equal(form.button('确认采用此原件').disabled,true);assert.equal(form.field('采用理由').value,'keep my reason');
  await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);assert.ok(t.messages.includes('detail unavailable'));
});

test('A to B to A uses the newest request even when the asset identity matches again', {timeout:2000}, async()=>{
  const t=setup(),form=t.open();
  const first=t.choose(form,'A'),middle=t.choose(form,'B'),last=t.choose(form,'A');
  t.resolve(t.requests[2],[asset('A','A-v2',2)]);await last;
  t.resolve(t.requests[0],[asset('A','A-v1',1)]);await first;
  t.requests[1].reject(Error('stale failure'));await middle;
  assert.equal(form.field('候选记录修订').value,'A-v2');assert.deepEqual(t.messages,[]);
});

test('clearing the asset cancels pending selection without issuing an empty detail query', {timeout:2000}, async()=>{
  const t=setup(),form=t.open(),pending=t.choose(form,'A');
  await t.choose(form,'');assert.equal(t.requests.length,1);
  t.resolve(t.requests[0],[asset('A')]);await pending;
  assert.equal(form.field('候选记录修订').children.length,0);assert.equal(form.button('确认采用此原件').disabled,true);
});

test('cancel then reopen isolates both late success and late failure from the new editor', {timeout:2000}, async()=>{
  for(const fail of [false,true]){
    const t=setup(),old=t.open(),pending=t.choose(old,'A');await old.button('取消').onclick();
    const next=t.open(),loaded=t.choose(next,'B');t.resolve(t.requests[1],[asset('B')]);await loaded;
    if(fail)t.requests[0].reject(Error('closed failure'));else t.resolve(t.requests[0],[asset('A')]);await pending;
    assert.equal(old.field('候选记录修订').children.length,0);assert.equal(next.field('候选记录修订').value,'B-v1');assert.deepEqual(t.messages,[]);
    await old.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  }
});

test('detached or superseded workspace editors cannot consume or submit stale details', {timeout:2000}, async()=>{
  for(const invalidate of [(t,f)=>f.box.remove(),t=>{t.context.state.workspace='story.sources'},t=>vm.runInContext('++productionReadEpoch',t.context)]){
    const t=setup(),form=t.open(),pending=t.choose(form,'A');invalidate(t,form);t.resolve(t.requests[0],[asset('A')]);await pending;
    assert.equal(form.field('候选记录修订').children.length,0);await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  }
});

test('exact historical revision, component, crop, range and adoption version are preserved', {timeout:2000}, async()=>{
  const t=setup(),form=t.open(),pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A','A-v2',2),asset('A')]);await pending;
  form.field('候选记录修订').value='A-v1';form.field('候选记录修订').onchange();form.field('采用文件组成').value='preview';
  form.field('采用理由').value='explicit old revision';form.field('入点秒（可选）').value='0.2';form.field('出点秒（可选）').value='0.8';
  for(const [label,value] of [['裁切左边比例','.1'],['裁切上边比例','.2'],['裁切宽度比例','.5'],['裁切高度比例','.6']])form.field(label).value=value;
  await form.button('确认采用此原件').onclick();
  assert.equal(t.posts[0].object_id,'existing-adoption');assert.equal(t.posts[0].expected_version,3);
  assert.deepEqual(plain(t.posts[0].payload.asset),{object_id:'A',revision_id:'A-v1'});assert.equal(t.posts[0].payload.component_id,'preview');
  assert.deepEqual(plain(t.posts[0].payload.range),{start_seconds:0.2,end_seconds:0.8});assert.deepEqual(plain(t.posts[0].payload.crop),{x:0.1,y:0.2,width:0.5,height:0.6});
  assert.deepEqual(plain(t.posts[0].payload.scope),{object_id:'shot',revision_id:'shot-exact'});
});

test('submit validates asset identity and component membership and prevents duplicate pending saves', {timeout:2000}, async()=>{
  const t=setup(),form=t.open(),pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A')]);await pending;form.field('采用理由').value='fixture';
  form.field('选择素材').value='B';await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  form.field('选择素材').value='A';form.field('采用文件组成').value='unknown';await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,0);
  form.field('采用文件组成').value='original';let release;
  t.context.api=(url,options)=>{t.posts.push(JSON.parse(options.body));return new Promise(resolve=>{release=resolve})};
  const first=form.button('确认采用此原件').onclick();await Promise.resolve();await form.button('确认采用此原件').onclick();assert.equal(t.posts.length,1);
  await form.button('取消').onclick();const next=t.open();release({});await first;
  assert.equal(t.context.reloads,0);assert.equal(next.box.isConnected,true);assert.ok(!t.messages.includes('精确采用已保存'));
});
