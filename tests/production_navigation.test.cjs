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
  context.history={replaceState:(_state,_title,url)=>{context.location.href=String(url)}};
  vm.createContext(context);vm.runInContext(source,context);
  context.renderProductionReader=()=>{};
  return context;
}
const plain=value=>JSON.parse(JSON.stringify(value));

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
