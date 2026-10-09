const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.isConnected=true;this.classList={add(){},remove(){},toggle(){}}}append(...nodes){this.children.push(...nodes)}setAttribute(){}addEventListener(){}all(){return this.children.flatMap(n=>[n,...n.all()])}}
const row=(object,kind,id=object+'-v1',payload={})=>({object_id:object,id,current_revision:id,kind,version:1,payload:{title:object,...payload}}),ref=r=>({object_id:r.object_id,revision_id:r.id});
function setup(){
  const entity=row('entity','ENTITY',undefined,{entity_type:'character'}),form=row('form','STATE'),other=row('other','STATE');
  const plan=row('need','REQUIREMENT','plan-new',{scope:ref(form)}),old={...plan,id:'plan-old'},same=row('same-need','REQUIREMENT','same-plan',{scope:ref(other)});
  const makeRounds=(need,earlier)=>[{number:2,plan:need,members:[need],results:[]},{number:1,plan:earlier,members:[earlier],results:[]}];
  const scope={entity:ref(entity),states:[form,other].map(ref),requirements:[plan,same].map(ref),dependencies:[],relationships:[]};
  const data={entity,states:[form,other],requirements:[plan,same],relationships:[],media:[],comment_records:[],comment_targets:[],usages:{},can_accept:true,can_revoke:false,acceptance_mode:'generation',decision_version:0,scope,decision_scope:scope,material_versions:{need:makeRounds(plan,old),'same-need':makeRounds(same,same)}};
  const requests=[],messages=[],toast={classList:{add(){},remove(){}},set textContent(value){messages.push(value)}},context={URL,URLSearchParams,console,setTimeout:()=>1,clearTimeout(){},location:{href:'http://isolated/?workspace=settings.workspace'},history:{replaceState(){}},document:{addEventListener(){},querySelector:s=>s==='#toast'?toast:null,querySelectorAll:()=>[],createElement:tag=>new Element(tag)}};
  vm.createContext(context);require('./load_review_helpers.cjs')(context);for(const file of ['app.js','production.js','material-review.js','entity-review.js','production-breakdown.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../review_desk/static',file),'utf8'),context);
  vm.runInContext('globalThis.state=state;',context);Object.assign(context.state,{workspace:'settings.workspace',entityReview:data,productionEntityDetail:{record:entity},productionChildDetail:{record:form},productionSelected:plan});
  for(const fn of ['entityVersionControl','reviewTextBlocks','entitySources','renderEntityRelations','renderComments','paintProductionReview'])context[fn]=()=>{};
  context.entityReviewScope=()=>'';context.productionEntityIcon=()=>new Element('svg');const realReload=context.reloadEntityReview;context.reloadEntityReview=async()=>{};
  context.fetch=async(url,options)=>{requests.push({url,payload:JSON.parse(options.body)});return {ok:true,json:async()=>({})}};
  context.renderStateMaterials=(_root,data,form)=>context.materialRoundModels(data.requirements.filter(r=>r.payload.scope.revision_id===form.id).map(r=>data.localVersions?.[r.object_id]||r),[],data);
  const render=()=>{const root=new Element('main');context.renderEntityReview(root);const button=root.all().find(n=>n.tag==='button'&&['采纳','取消采纳'].includes(n.textContent));assert.ok(button);return button};
  context.renderProductionReader=render;
  return {context,data,entity,form,other,plan,old,same,requests,messages,render,realReload};
}

test('browsing an older material plan keeps the current entity scope available and posts only that scope',async()=>{
 const f=setup(),before=JSON.stringify(f.data.scope);f.context.switchMaterialRound(f.data,'need',1);
 assert.equal(f.context.materialRoundModels([f.plan],[],f.data)[0].need.id,f.old.id);
 const button=f.render();assert.equal(button.disabled,false);await button.onclick();
 assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.requests[0].payload.scope),before);
});
test('a retained frozen material call does not replace or disable current entity acceptance',()=>{
 const f=setup();Object.assign(f.data.material_versions.need[1],{model:'plan-v1',frozen:1,plan:null});f.context.switchMaterialRound(f.data,'need',1);
 assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),false);assert.equal(f.render().disabled,false);
});
test('each state restores its material choice while historical entity and state sections stay read-only',()=>{
 const f=setup();f.context.switchMaterialRound(f.data,'need',1);f.context.selectEntityReviewState(f.other);f.context.selectEntityReviewState(f.form);
 assert.equal(f.data.selectedMaterialRounds.need,1);assert.equal(f.render().disabled,false);
 f.context.state.productionEntityDetail.record={...f.entity,id:'old-entity'};assert.equal(f.render().disabled,true);
 f.context.state.productionEntityDetail.record=f.entity;f.context.state.productionChildDetail.record={...f.form,id:'old-form'};assert.equal(f.render().disabled,true);
});
test('accept, revoke and reaccept retain exact scope and optimistic version semantics',async()=>{
 for(const phase of [{accept:true,revoke:false,version:0,action:'accept'},{accept:false,revoke:true,version:1,action:'revoke'},{accept:true,revoke:false,version:2,action:'accept'}]){
  const f=setup();Object.assign(f.data,{can_accept:phase.accept,can_revoke:phase.revoke,decision_version:phase.version,revoke_target:{object_id:'decision',revision_id:'decision-v1'}});
  f.context.switchMaterialRound(f.data,'need',1);await f.render().onclick();
  assert.equal(f.requests[0].payload.action,phase.action);assert.equal(f.requests[0].payload.expected_version,phase.version);assert.deepEqual(f.requests[0].payload.scope,f.data.scope);
  await f.render().onclick();assert.equal(f.requests.length,1);
 }
});
test('incomplete preparation still posts content acceptance without claiming generation readiness',async()=>{
 const f=setup();f.data.acceptance_mode='content';f.data.preparation={complete:false,issues:[{message:'方案待完善'}]};f.context.switchMaterialRound(f.data,'need',1);
 const button=f.render();assert.equal(button.disabled,false);assert.match(button.title,/生成前仍需完善/);await button.onclick();assert.equal(f.requests[0].payload.acceptance_mode,'content');assert.equal(f.data.preparation.complete,false);
});
test('a queued callback cannot accept a newly historical entity, another reader or another workspace',async()=>{
 for(const change of ['entity','reader','workspace']){
  const f=setup(),button=f.render(),click=button.onclick();
  if(change==='entity')f.context.state.productionEntityDetail.record={...f.entity,id:'old'};
  if(change==='reader')f.context.state.entityReview={...f.data};
  if(change==='workspace')f.context.state.workspace='story.sources';await click;assert.equal(f.requests.length,0);
 }
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('entity save keeps one request across double invocation and rerender, and distinguishes its actual refresh failure',async()=>{
 const f=setup(),requests=[];f.context.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));f.context.reloadEntityReview=f.realReload;
 const button=f.render(),saving=button.onclick();await flush();await button.onclick();assert.equal(f.render().disabled,true);await f.render().onclick();assert.equal(requests.length,1);
 requests[0].resolve({ok:true,json:async()=>({saved:true})});await flush();assert.equal(requests.length,2);assert.match(requests[1].url,/entity-review/);requests[1].reject(Error('own read unavailable'));await saving;
 assert.equal(requests.length,2);assert.ok(f.messages.some(s=>s.includes('已保存')&&s.includes('尚未更新')&&s.includes('own read unavailable')));assert.equal(f.render().disabled,true);await f.render().onclick();assert.equal(requests.length,2);
});
test('entity unknown result retains the exact version, blocks blind resend and does not claim success',async()=>{
 const f=setup(),requests=[];f.context.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
 const saving=f.render().onclick();await flush();assert.equal(JSON.parse(requests[0].options.body).expected_version,0);requests[0].reject(Error('response lost'));await saving;
 assert.match(f.messages.at(-1),/结果待确认/);assert.ok(!f.messages.some(s=>s.includes('已保存')));await f.render().onclick();assert.equal(requests.length,1);
});
test('entity late writes never reload a new entity, workspace or replaced local reader',async()=>{
 for(const outcome of ['success','failure'])for(const change of ['entity','workspace','reader']){
  const f=setup(),requests=[];let reloads=0;f.context.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({resolve,reject}));f.context.reloadEntityReview=async()=>{reloads++};
  const button=f.render(),saving=button.onclick();await flush();
  if(change==='entity')f.context.state.entityReview={...f.data,entity:{...f.entity,object_id:'new-entity'}};
  if(change==='workspace')f.context.state.workspace='story.sources';
  if(change==='reader')button.isConnected=false;
  if(outcome==='success')requests[0].resolve({ok:true,json:async()=>({})});else requests[0].reject(Error('old request failure'));await saving;
  assert.equal(reloads,0);assert.equal(f.messages.length,outcome==='success'?1:0);if(outcome==='success')assert.match(f.messages[0],/「entity」.*已保存/);
 }
});
test('entity own refresh failure stays quiet after a new actual detail read takes ownership',async()=>{
 const f=setup(),requests=[];f.context.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));f.context.reloadEntityReview=f.realReload;
 const saving=f.render().onclick();await flush();requests[0].resolve({ok:true,json:async()=>({})});await flush();assert.match(requests[1].url,/entity-review/);
 const newer=f.context.openProductionRecord('new-entity');await flush();requests[1].reject(Error('old refresh failure'));await saving;assert.ok(!f.messages.some(s=>s.includes('old refresh failure')));
 requests[2].reject(Error('new read stopped'));await assert.rejects(newer,/new read stopped/);
});

test('entity decision reload retains the chosen material version and candidate',async()=>{
 const f=setup();f.context.reloadEntityReview=f.realReload;
 Object.assign(f.data,{selectedMaterialRounds:{need:2},selectedCandidates:{need:'candidate-one'},unifiedMaterialId:'need'});
 const fresh={...f.data,selectedMaterialRounds:undefined,selectedCandidates:undefined,unifiedMaterialId:undefined};
 f.context.fetch=async()=>({ok:true,json:async()=>fresh});
 await f.realReload();
 assert.equal(f.context.state.entityReview.selectedMaterialRounds.need,2);
 assert.equal(f.context.state.entityReview.selectedCandidates.need,'candidate-one');
 assert.equal(f.context.state.entityReview.unifiedMaterialId,'need');
});

// Deferred responses model timing; UI reproduction lives in the story task.
test('[defect-probing] early close still refreshes its live list for accept and revoke',async()=>{
 for(const revoke of [false,true]){
  const f=setup(),pending=[];let indexes=0,reloads=0;
  f.data.can_revoke=revoke;f.data.can_accept=!revoke;
  f.context.state.refreshEntityIndex=async()=>{indexes++};
  f.context.reloadEntityReview=async()=>{reloads++};
  f.context.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const button=f.render(),saving=button.onclick();await flush();button.isConnected=false;
  pending[0]({ok:true,json:async()=>({})});await saving;
  assert.equal(indexes,1);assert.equal(reloads,0);assert.equal(pending.length,1);
 }
});
test('[defect-probing] a failed own detail read does not suppress the saved list update',async()=>{
 const f=setup();let indexes=0;
 f.context.state.refreshEntityIndex=async()=>{indexes++};
 f.context.reloadEntityReview=async()=>{throw Error('detail unavailable')};
 await f.render().onclick();assert.equal(indexes,1);
 assert.ok(f.messages.some(s=>s.includes('已保存')&&s.includes('尚未更新')));
});
test('late entity success cannot call the replacement page list refresher',async()=>{
 const f=setup(),pending=[];let old=0,replacement=0;
 f.context.state.refreshEntityIndex=async()=>{old++};f.context.fetch=()=>new Promise(resolve=>pending.push(resolve));
 const saving=f.render().onclick();await flush();f.context.state.entityReview=null;
 f.context.state.refreshEntityIndex=async()=>{replacement++};pending[0]({ok:true,json:async()=>({})});await saving;
 assert.equal(old,1);assert.equal(replacement,0);
});

test('detail reads crossing a successful entity decision recheck once without resending the write',async()=>{
 const f=setup(),pending=[];f.context.fetch=url=>new Promise(resolve=>pending.push({url,resolve:data=>resolve({ok:true,json:async()=>data})}));
 const reading=f.context.readEntityDecisionView('/api/production/card?object_id=entity');
 vm.runInContext("entityDecisionReads.set('entity',1)",f.context);
 pending[0].resolve({entity_review:{entity:f.entity,decision_version:0}});await flush();assert.equal(pending.length,2);
 pending[1].resolve({entity_review:{entity:f.entity,decision_version:1}});assert.equal((await reading).entity_review.decision_version,1);
 assert.ok(pending.every(r=>r.url.includes('/card?')));
});
test('unrelated decisions do not invalidate another entity read and repeated changes are bounded',async()=>{
 const f=setup(),pending=[];f.context.fetch=url=>new Promise(resolve=>pending.push({resolve:data=>resolve({ok:true,json:async()=>data})}));
 const other=f.context.readEntityDecisionView('/api/production/card?object_id=other');vm.runInContext("entityDecisionReads.set('entity',1)",f.context);pending[0].resolve({entity_review:{entity:{object_id:'other'}}});await other;assert.equal(pending.length,1);
 const changing=f.context.readEntityDecisionView('/api/production/entity-review?entity_id=entity');vm.runInContext("entityDecisionReads.set('entity',2)",f.context);pending[1].resolve({entity:f.entity});await flush();
 vm.runInContext("entityDecisionReads.set('entity',3)",f.context);pending[2].resolve({entity:f.entity});await assert.rejects(changing,/重新打开/);assert.equal(pending.length,3);
});
test('failed or conflicting entity writes retain scope and never refresh or retry',async()=>{
 for(const status of [400,409]){
 const f=setup();let indexes=0;f.context.state.refreshEntityIndex=async()=>indexes++;
 f.context.fetch=async(url,options)=>{f.requests.push({url,payload:JSON.parse(options.body)});return {ok:false,status,json:async()=>({error:status===409?'version conflict':'save rejected'})}};
 await f.render().onclick();await f.render().onclick();assert.equal(indexes,0);assert.equal(f.requests.length,1);assert.equal(f.requests[0].payload.expected_version,0);assert.ok(!f.messages.some(s=>s.includes('已保存')));assert.match(f.messages.at(-1),status===409?/版本已变化，本次未保存/:/本次未保存/);
 }
});
