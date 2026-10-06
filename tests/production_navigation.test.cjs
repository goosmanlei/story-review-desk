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

test('history type filters expose only loaded kinds and retain accurately supplemented records',()=>{
  const baseline=['INPUT_LOCK','PREPARATION','ASSEMBLY','DELIVERABLE'].map(kind=>row(kind.toLowerCase(),kind));
  const declaration=source.split('\n').find(line=>line.trim().startsWith('const kindOptions='));
  assert.ok(declaration,'test must exercise the actual history filter options');
  for(const [records,expected] of [
    [baseline,['','PREPARATION','ASSEMBLY','DELIVERABLE']],
    [[...baseline,row('linked-shot','SHOT_DESIGN',{},'exact-shot-revision')],['','PREPARATION','SHOT_DESIGN','ASSEMBLY','DELIVERABLE']],
    [[...baseline,row('linked-requirement','REQUIREMENT',{},'exact-requirement-revision')],['','PREPARATION','REQUIREMENT','ASSEMBLY','DELIVERABLE']],
    [[],['']],
  ]){
    const before=JSON.stringify(records),ctx=setup(records);ctx.workspace='production.workspace';ctx.result={records};
    const options=plain(vm.runInContext('(()=>{'+declaration+'return kindOptions})()',ctx));
    assert.deepEqual(options.map(option=>option[0]),expected);
    assert.ok(options.every(([kind])=>!kind||records.some(record=>record.kind===kind)));
    assert.equal(JSON.stringify(records),before);
  }
});

test('withdrawn entities and states leave current lists without deleting historical rows',()=>{
  const a=row('a','ENTITY'),old=row('old','ENTITY',{status:'withdrawn'});
  const current=row('current','STATE',{state_model:'complete-v1',entity:{object_id:'a'}});
  const previous=row('previous','STATE',{state_model:'complete-v1',entity:{object_id:'a'},status:'withdrawn'});
  const records=[a,old,current,previous],ctx=setup(records);
  assert.deepEqual(plain(ctx.productionWorkspaceRows(records,'settings.workspace').map(r=>r.object_id)),['a']);
  assert.deepEqual(plain(ctx.productionEntityChildren('a').map(r=>r.object_id)),['current']);
  assert.equal(ctx.state.productionRecords.length,4);
});

test('shared and state-only settings appear under each owner exactly once; project settings stay unowned',()=>{
  const a=row('a','ENTITY'),b=row('b','ENTITY');
  const wet=row('wet','STATE',{state_model:'complete-v1',entity:{object_id:'a',revision_id:'a-old'}});
  const shared=row('shared','REPRESENTATION',{entities:[{object_id:'a'},{object_id:'b'}],states:[{object_id:'wet'}]});
  const stateOnly=row('state-only','REPRESENTATION',{entities:[],states:[{object_id:'wet'}]});
  const common=row('common','REPRESENTATION',{entities:[],states:[]});
  const ctx=setup([a,b,wet,shared,stateOnly,common]);
  assert.deepEqual(plain(ctx.productionEntityIds(shared)),['a','b']);
  assert.deepEqual(plain(ctx.productionEntityChildren('a').map(r=>r.object_id)),['wet','shared','state-only']);
  assert.deepEqual(plain(ctx.productionEntityChildren('b').map(r=>r.object_id)),['shared']);
  assert.deepEqual(plain(ctx.productionEntityIds(common)),[]);
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

test('historical representation resolves the referenced state, not its newer parent',async()=>{
  const oldOwner=row('old-owner','ENTITY'),newOwner=row('new-owner','ENTITY');
  const current=row('state','STATE',{entity:{object_id:'new-owner'}});
  const old={...current,id:'state-old',payload:{entity:{object_id:'old-owner'}}};
  const rep=row('rep','REPRESENTATION',{entities:[],states:[{object_id:'state',revision_id:'state-old'}]});
  const requests=[];
  const ctx=setup([oldOwner,newOwner,current,rep],async url=>{requests.push(url);return {record:url.includes('object_id=rep')?rep:old}});
  await ctx.openProductionRecord('rep');
  assert.equal(ctx.state.productionSelected,rep);
  assert.equal(ctx.state.productionEntityId,'old-owner');
  assert.ok(requests.some(url=>url.includes('revision_id=state-old')));
  assert.equal(current.payload.entity.object_id,'new-owner');
});

test('a slow historical ownership lookup cannot replace a newer selection',async()=>{
  const entity=row('entity','ENTITY'),current=row('state','STATE',{entity:{object_id:'entity'}});
  const rep=row('rep','REPRESENTATION',{entities:[],states:[{object_id:'state',revision_id:'state-old'}]});
  let release,lookupStarted;
  const started=new Promise(resolve=>{lookupStarted=resolve});
  const ctx=setup([entity,current,rep],async url=>{
    if(url.includes('object_id=state')){lookupStarted();return new Promise(resolve=>{release=()=>resolve({record:{...current,id:'state-old'}})})}
    return {record:url.includes('object_id=rep')?rep:entity};
  });
  const first=ctx.openProductionRecord('rep');await started;
  await ctx.openProductionRecord('entity');release();await first;
  assert.equal(ctx.state.productionSelected,entity);
  assert.equal(new URL(ctx.location.href).searchParams.get('production_object'),'entity');
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
  const a=row('a','PREPARATION'),b=row('b','PREPARATION'),old={...b,id:'b-old'};
  const ctx=setup([a,b],recordApi([a,b,old]));ctx.state.workspace='production.workspace';
  const buttons=recordButtons(ctx,['a','b',null]);
  for(const [objectId,revisionId,selected] of [['a',null,0],['b',null,1],['b','b-old',1],['a',null,0]]){
    await ctx.openProductionRecord(objectId,revisionId);
    assert.equal(ctx.state.productionSelected.id,revisionId||objectId+'-current');
    assert.deepEqual(buttons.slice(0,2).map(b=>[b.active,b.attrs['aria-pressed']]),[0,1].map(i=>[i===selected,String(i===selected)]));
    assert.equal(buttons[2].attrs['aria-pressed'],undefined);
  }
});
test('a late record response cannot move either selection marker from the newer record',async()=>{
  const a=row('a','PREPARATION'),b=row('b','PREPARATION');let release;
  const ctx=setup([a,b],url=>new URL(url,'http://localhost').searchParams.get('object_id')==='a'?new Promise(resolve=>{release=()=>resolve({record:a,history:[a]})}):Promise.resolve({record:b,history:[b]}));
  ctx.state.workspace='production.workspace';const buttons=recordButtons(ctx,['a','b']);
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
