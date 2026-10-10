const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/production.js'),'utf8');
const row=(object_id,kind,payload={},id=object_id+'-current')=>({object_id,kind,payload,id,current_revision:id});
function setup(records,api){
  const context={state:{workspace:'settings.workspace',productionRecords:records},URL,URLSearchParams,
    location:{href:'http://localhost/?workspace=settings.workspace'},document:{querySelectorAll:()=>[]},
    api,isProduction:()=>true,renderComments:()=>{}};
  context.history={replaceState:(_state,_title,url)=>{context.location.href=String(url)},pushState:(_state,_title,url)=>{context.location.href=String(url)}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);vm.runInContext(source,context);
  context.renderProductionReader=()=>{};
  return context;
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('withdrawn entities and states leave current lists without deleting historical rows',()=>{
  const a=row('a','ENTITY'),old=row('old','ENTITY',{status:'withdrawn'});
  const current=row('current','STATE',{state_model:'complete-v1',entity:{object_id:'a'}});
  const previous=row('previous','STATE',{state_model:'complete-v1',entity:{object_id:'a'},status:'withdrawn'});
  const records=[a,old,current,previous],ctx=setup(records);
  assert.deepEqual(plain(ctx.productionWorkspaceRows(records,'settings.workspace').map(r=>r.object_id)),['a']);
  assert.deepEqual(plain(ctx.productionEntityChildren('a').map(r=>r.object_id)),['current']);
  assert.equal(ctx.state.productionRecords.length,4);
});


test('old state links keep exact state and entity identity, without replacing the selected target with the entity',async()=>{
  const entity=row('bag','ENTITY'),current=row('bag-state','STATE',{entity:{object_id:'bag',revision_id:'bag-old'}});
  const old={...current,id:'state-old',payload:{...current.payload,title:'Historical title'}};
  const ctx=setup([entity,current],async()=>({record:old,history:[current,old]}));
  await ctx.openProductionRecord('bag-state','state-old');
  assert.equal(ctx.state.productionSelected.id,'state-old');
  assert.equal(ctx.state.productionEntityId,'bag');
  const url=new URL(ctx.location.href);
  assert.equal(url.searchParams.get('production_revision'),'state-old');
  assert.equal(url.searchParams.get('production_entity'),'bag');
});

test('shared entity card retains an exact older revision even without legacy history flags',()=>{
  const current=row('state','STATE'),old={...current,id:'retired-old',cleaned_target:true};
  const ctx=setup([current]);ctx.isEntityReview=()=>true;ctx.state.entityReview={};
  ctx.focusProductionReview({record:old},false);
  assert.equal(new URL(ctx.location.href).searchParams.get('production_revision'),old.id);
  ctx.focusProductionReview({record:current},false);
  assert.equal(new URL(ctx.location.href).searchParams.get('production_revision'),null);
});



test('legacy fragments do not count as current complete forms but keep their owner',()=>{
  const entity=row('person','ENTITY'),legacy=row('hand','STATE',{entity:{object_id:'person'}}),full=row('full','STATE',{state_model:'complete-v1',entity:{object_id:'person'}});
  const ctx=setup([entity,legacy,full]);
  assert.deepEqual(plain(ctx.productionEntityChildren('person').map(r=>r.object_id)),['full']);
  assert.deepEqual(plain(ctx.productionEntityIds(legacy)),['person']);
});

function recordApi(records){return async url=>{const params=new URL(url,'http://localhost').searchParams;const record=records.find(r=>r.object_id===params.get('object_id')&&(!params.get('revision_id')||r.id===params.get('revision_id')));assert.ok(record,url);return {record,history:records.filter(r=>r.object_id===record.object_id),uses:[]}}}
const complete=(id,entity,scene)=>row(id,'STATE',{state_model:'complete-v1',entity:{object_id:entity},sources:[{scene_id:scene,block_ids:[scene+'-b001']}]});

function recordButtons(ctx,ids){
  const buttons=ids.map(objectId=>({dataset:objectId?{objectId}:{},attrs:{},active:false,setAttribute(k,v){this.attrs[k]=v}}));
  for(const button of buttons)button.classList={toggle:(_name,value)=>{button.active=value}};
  ctx.document.querySelectorAll=selector=>selector==='#production-index button'?buttons:[];
  return buttons;
}
test('record navigation keeps visual and accessible selection on the exact displayed object',async()=>{
  const a=row('a','AV_SCENE'),b=row('b','AV_SCENE'),old={...b,id:'b-old'};
  const ctx=setup([a,b],recordApi([a,b,old]));ctx.state.workspace='settings.workspace';
  const buttons=recordButtons(ctx,['a','b',null]);
  for(const [objectId,revisionId,selected] of [['a',null,0],['b',null,1],['b','b-old',1],['a',null,0]]){
    await ctx.openProductionRecord(objectId,revisionId);
    assert.equal(ctx.state.productionSelected.id,revisionId||objectId+'-current');
    assert.deepEqual(buttons.slice(0,2).map(b=>[b.active,b.attrs['aria-pressed']]),[0,1].map(i=>[i===selected,String(i===selected)]));
    assert.equal(buttons[2].attrs['aria-pressed'],undefined);
  }
});
test('a late record response cannot move either selection marker from the newer record',async()=>{
  const a=row('a','AV_SCENE'),b=row('b','AV_SCENE');let release;
  const ctx=setup([a,b],url=>new URL(url,'http://localhost').searchParams.get('object_id')==='a'?new Promise(resolve=>{release=()=>resolve({record:a,history:[a]})}):Promise.resolve({record:b,history:[b]}));
  ctx.state.workspace='settings.workspace';const buttons=recordButtons(ctx,['a','b']);
  const older=ctx.openProductionRecord('a');await ctx.openProductionRecord('b');release();await older;
  assert.equal(ctx.state.productionSelected,b);
  assert.deepEqual(buttons.map(b=>[b.active,b.attrs['aria-pressed']]),[[false,'false'],[true,'true']]);
});

test('opening an entity shows its basic information and defaults to the earliest complete state',async()=>{
  const entity=row('bag','ENTITY'),late=complete('a-filled','bag','s002'),base=complete('z-empty','bag','s001');
  const ctx=setup([entity,late,base],recordApi([entity,late,base]));
  await ctx.openProductionRecord('bag');
  assert.equal(ctx.state.productionEntityDetail.record,entity);
  assert.equal(ctx.state.productionChildDetail.record,base);
  assert.equal(ctx.state.productionSelected,base);
  await ctx.openProductionRecord(late.object_id,late.id);
  assert.equal(ctx.state.productionEntityDetail.record,entity);
  assert.equal(ctx.state.productionChildDetail.record,late);
  await ctx.openProductionRecord('bag');
  assert.equal(ctx.state.productionChildDetail.record,base);
});

test('entity history and review focus keep the selected state and separate exact comment targets',async()=>{
  const entity=row('person','ENTITY'),old={...entity,id:'person-old'},form=complete('form','person','s001');
  const ctx=setup([entity,form],recordApi([entity,old,form]));
  await ctx.openProductionRecord('form');
  const child=ctx.state.productionChildDetail;
  await ctx.openProductionRecord('person','person-old');
  assert.equal(ctx.state.productionSelected,old);
  assert.equal(ctx.state.productionEntityDetail.record,old);
  assert.equal(ctx.state.productionChildDetail,child);
  ctx.focusProductionReview(child,false);
  assert.equal(ctx.state.productionSelected,form);
  assert.equal(ctx.state.productionEntityDetail.record,old);
  assert.equal(new URL(ctx.location.href).searchParams.get('production_revision'),form.id);
});

test('a slow entity overview lookup cannot overwrite a newer entity and its default state',async()=>{
  const a=row('a','ENTITY'),b=row('b','ENTITY'),form=complete('a-form','a','s001'),bForm=complete('b-form','b','s001');
  let release,started;const pending=new Promise(resolve=>{started=resolve});
  const read=recordApi([a,b,form,bForm]);
  const ctx=setup([a,b,form,bForm],async url=>{if(new URL(url,'http://localhost').searchParams.get('object_id')==='a'){started();return new Promise(resolve=>{release=()=>resolve({record:a,history:[a]})})}return read(url)});
  const first=ctx.openProductionRecord('a-form');await pending;
  await ctx.openProductionRecord('b');release();await first;
  assert.equal(ctx.state.productionEntityId,'b');
  assert.equal(ctx.state.productionEntityDetail.record,b);
  assert.equal(ctx.state.productionChildDetail.record,bForm);
  assert.equal(ctx.state.productionSelected,bForm);
});

test('an entity with only historical partial states stays readable without inventing a default form',async()=>{
  const entity=row('person','ENTITY'),legacy=row('hand','STATE',{entity:{object_id:'person'}});
  const ctx=setup([entity,legacy],recordApi([entity,legacy]));
  await ctx.openProductionRecord('person');
  assert.equal(ctx.state.productionSelected,entity);
  assert.equal(ctx.state.productionEntityDetail.record,entity);
  assert.equal(ctx.state.productionChildDetail,null);
});

test('historical call references still navigate to their exact detail after removal from material list facets',async()=>{
 const call=row('old-call','CALL',{title:'Executed call'},'exact-call');
 const ctx=setup([],async()=>({record:call,history:[call],uses:[]}));const routes=[];ctx.switchWorkspace=workspace=>routes.push(workspace);
 await ctx.openProductionRecord('old-call','exact-call',true);assert.deepEqual(routes,['materials.workspace']);
 assert.equal(new URL(ctx.location.href).searchParams.get('production_revision'),'exact-call');
 ctx.state.workspace='materials.workspace';await ctx.openProductionRecord('old-call','exact-call',false);
 assert.equal(ctx.state.productionSelected.id,'exact-call');
});
