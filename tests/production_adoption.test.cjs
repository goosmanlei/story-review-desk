const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../review_desk/static/production.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const asset=(object_id,id=object_id+'-v1',version=1)=>({object_id,id,version,kind:'ASSET',payload:{title:object_id,media_type:'video',components:[{id:'original',role:'original'},{id:'preview',role:'preview'}]}});
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this._value='';this.disabled=false;this.parent=null}
  get isConnected(){return this.root===true||!!this.parent?.isConnected}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);if(this.tag==='select'&&this.children.length===1)this._value=node.value}}
  replaceChildren(...nodes){for(const child of this.children)child.parent=null;this.children=[];this._value='';this.append(...nodes)}
  setAttribute(key,value){this.attrs[key]=value}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null}
  get value(){return this._value}set value(value){this._value=String(value)}
  all(){return this.children.flatMap(child=>[child,...child.all()])}
}
function setup(){
  const root=new Element('main');root.root=true;
  const requests=[],posts=[],messages=[];
  const context={state:{workspace:'production.workspace',productionRecords:[asset('A'),asset('B')]},crypto:{randomUUID:()=>String(posts.length)},
    el:tag=>new Element(tag),Option:function(text,value){const option=new Element('option');option.textContent=text;option.value=value;return option},
    nodeText:(tag,cls,text,parent)=>{const node=new Element(tag);node.textContent=text;parent.append(node);return node},toast:message=>messages.push(message),
    api:(url,options)=>{if(options?.method==='POST'){posts.push(JSON.parse(options.body));return Promise.resolve({})}return new Promise((resolve,reject)=>requests.push({url,resolve,reject}))}};
  vm.createContext(context);vm.runInContext(source,context);context.loadProductionWorkspace=async()=>{context.reloads++};context.reloads=0;
  const row={requirement:{payload:{title:'Input',media_type:'video',scope:{object_id:'shot',revision_id:'shot-exact'},slot:'main',usage:'generation_input'}},adoption:{object_id:'existing-adoption',version:3}};
  const open=()=>{context.showProductionAdoption(root,row);const box=root.children.at(-1);return {box,field:label=>box.all().find(node=>node.attrs['aria-label']===label),button:label=>box.all().find(node=>node.tag==='button'&&node.textContent===label)}};
  const choose=(form,id)=>{form.field('选择素材').value=id;return form.field('选择素材').onchange()};
  const resolve=(request,records)=>request.resolve({history:records});
  return {context,root,requests,posts,messages,open,choose,resolve};
}

test('late A response cannot replace B selection or the adopted exact revision', {timeout:2000}, async()=>{
  const t=setup(),form=t.open();form.field('采用理由').value='technical fixture';
  const first=t.choose(form,'A'),second=t.choose(form,'B');
  t.resolve(t.requests[1],[asset('B')]);await second;
  t.resolve(t.requests[0],[asset('A')]);await first;
  assert.equal(form.field('选择素材').value,'B');assert.equal(form.field('采用素材版本').value,'B-v1');
  await form.button('确认采用此版本').onclick();
  assert.deepEqual(plain(t.posts[0].payload.asset),{object_id:'B',revision_id:'B-v1'});
});

test('loading and failed replacement clear old options and cannot submit the old asset', {timeout:2000}, async()=>{
  const t=setup(),form=t.open();form.field('采用理由').value='keep my reason';
  let pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A')]);await pending;
  pending=t.choose(form,'B');
  assert.equal(form.field('采用素材版本').children.length,0);assert.equal(form.field('采用文件组成').children.length,0);
  assert.equal(form.button('确认采用此版本').disabled,true);
  await form.button('确认采用此版本').onclick();assert.equal(t.posts.length,0);
  t.requests[1].reject(Error('detail unavailable'));await pending;
  assert.equal(form.button('确认采用此版本').disabled,true);assert.equal(form.field('采用理由').value,'keep my reason');
  await form.button('确认采用此版本').onclick();assert.equal(t.posts.length,0);assert.ok(t.messages.includes('detail unavailable'));
});

test('A to B to A uses the newest request even when the asset identity matches again', {timeout:2000}, async()=>{
  const t=setup(),form=t.open();
  const first=t.choose(form,'A'),middle=t.choose(form,'B'),last=t.choose(form,'A');
  t.resolve(t.requests[2],[asset('A','A-v2',2)]);await last;
  t.resolve(t.requests[0],[asset('A','A-v1',1)]);await first;
  t.requests[1].reject(Error('stale failure'));await middle;
  assert.equal(form.field('采用素材版本').value,'A-v2');assert.deepEqual(t.messages,[]);
});

test('clearing the asset cancels pending selection without issuing an empty detail query', {timeout:2000}, async()=>{
  const t=setup(),form=t.open(),pending=t.choose(form,'A');
  await t.choose(form,'');assert.equal(t.requests.length,1);
  t.resolve(t.requests[0],[asset('A')]);await pending;
  assert.equal(form.field('采用素材版本').children.length,0);assert.equal(form.button('确认采用此版本').disabled,true);
});

test('cancel then reopen isolates both late success and late failure from the new editor', {timeout:2000}, async()=>{
  for(const fail of [false,true]){
    const t=setup(),old=t.open(),pending=t.choose(old,'A');await old.button('取消').onclick();
    const next=t.open(),loaded=t.choose(next,'B');t.resolve(t.requests[1],[asset('B')]);await loaded;
    if(fail)t.requests[0].reject(Error('closed failure'));else t.resolve(t.requests[0],[asset('A')]);await pending;
    assert.equal(old.field('采用素材版本').children.length,0);assert.equal(next.field('采用素材版本').value,'B-v1');assert.deepEqual(t.messages,[]);
    await old.button('确认采用此版本').onclick();assert.equal(t.posts.length,0);
  }
});

test('detached or superseded workspace editors cannot consume or submit stale details', {timeout:2000}, async()=>{
  for(const invalidate of [(t,f)=>f.box.remove(),t=>{t.context.state.workspace='story.sources'},t=>vm.runInContext('++productionReadEpoch',t.context)]){
    const t=setup(),form=t.open(),pending=t.choose(form,'A');invalidate(t,form);t.resolve(t.requests[0],[asset('A')]);await pending;
    assert.equal(form.field('采用素材版本').children.length,0);await form.button('确认采用此版本').onclick();assert.equal(t.posts.length,0);
  }
});

test('exact historical revision, component, crop, range and adoption version are preserved', {timeout:2000}, async()=>{
  const t=setup(),form=t.open(),pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A','A-v2',2),asset('A')]);await pending;
  form.field('采用素材版本').value='A-v1';form.field('采用素材版本').onchange();form.field('采用文件组成').value='preview';
  form.field('采用理由').value='explicit old revision';form.field('入点秒（可选）').value='0.2';form.field('出点秒（可选）').value='0.8';
  for(const [label,value] of [['裁切左边比例','.1'],['裁切上边比例','.2'],['裁切宽度比例','.5'],['裁切高度比例','.6']])form.field(label).value=value;
  await form.button('确认采用此版本').onclick();
  assert.equal(t.posts[0].object_id,'existing-adoption');assert.equal(t.posts[0].expected_version,3);
  assert.deepEqual(plain(t.posts[0].payload.asset),{object_id:'A',revision_id:'A-v1'});assert.equal(t.posts[0].payload.component_id,'preview');
  assert.deepEqual(plain(t.posts[0].payload.range),{start_seconds:0.2,end_seconds:0.8});assert.deepEqual(plain(t.posts[0].payload.crop),{x:0.1,y:0.2,width:0.5,height:0.6});
  assert.deepEqual(plain(t.posts[0].payload.scope),{object_id:'shot',revision_id:'shot-exact'});
});

test('submit validates asset identity and component membership and prevents duplicate pending saves', {timeout:2000}, async()=>{
  const t=setup(),form=t.open(),pending=t.choose(form,'A');t.resolve(t.requests[0],[asset('A')]);await pending;form.field('采用理由').value='fixture';
  form.field('选择素材').value='B';await form.button('确认采用此版本').onclick();assert.equal(t.posts.length,0);
  form.field('选择素材').value='A';form.field('采用文件组成').value='unknown';await form.button('确认采用此版本').onclick();assert.equal(t.posts.length,0);
  form.field('采用文件组成').value='original';let release;
  t.context.api=(url,options)=>{t.posts.push(JSON.parse(options.body));return new Promise(resolve=>{release=resolve})};
  const first=form.button('确认采用此版本').onclick();await Promise.resolve();await form.button('确认采用此版本').onclick();assert.equal(t.posts.length,1);
  await form.button('取消').onclick();const next=t.open();release({});await first;
  assert.equal(t.context.reloads,0);assert.equal(next.box.isConnected,true);assert.ok(!t.messages.includes('精确采用已保存'));
});
