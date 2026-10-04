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

test('a displayed old plan disables the real acceptance button and its exact scope is never posted',async()=>{
  const f=setup();f.context.switchMaterialRound(f.data,'need',1);const models=f.context.materialRoundModels([f.plan],[],f.data);assert.equal(models[0].need.id,f.old.id);
  const button=f.render();assert.equal(button.disabled,true);assert.match(button.title,/历史内容/);await button.onclick();assert.equal(f.requests.length,0);
});

test('a frozen actual-call version without a matching draft remains readable and cannot accept current scope',()=>{
  const f=setup();Object.assign(f.data.material_versions.need[1],{model:'plan-v1',frozen:1,plan:null});
  f.context.switchMaterialRound(f.data,'need',1);
  assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),true);
  assert.equal(f.render().disabled,true);
});

test('older round sharing the same exact plan remains acceptable and posts the existing current scope',async()=>{
  const f=setup();f.context.switchMaterialRound(f.data,'same-need',1);assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),false);
  const before=JSON.stringify(f.data.scope),button=f.render();assert.equal(button.disabled,false);await button.onclick();assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.requests[0].payload.scope),before);assert.equal(f.requests[0].payload.action,'accept');assert.equal(f.requests[0].payload.expected_version,0);
});

test('accept, revoke and reaccept retain their existing action and version semantics in current content',async()=>{
  for(const phase of [{accept:true,revoke:false,version:0,action:'accept'},{accept:false,revoke:true,version:1,action:'revoke'},{accept:true,revoke:false,version:2,action:'accept'}]){
    const f=setup();Object.assign(f.data,{can_accept:phase.accept,can_revoke:phase.revoke,decision_version:phase.version,revoke_target:{object_id:'decision',revision_id:'decision-v1'}});f.context.switchMaterialRound(f.data,'same-need',1);
    const button=f.render();assert.equal(button.disabled,false);await button.onclick();assert.equal(f.requests[0].payload.action,phase.action);assert.equal(f.requests[0].payload.expected_version,phase.version);assert.equal(f.requests[0].payload.decision_ref.revision_id,'decision-v1');
    f.context.switchMaterialRound(f.data,'need',1);const old=f.render();assert.equal(old.disabled,true);await old.onclick();assert.equal(f.requests.length,1);
  }
});

test('each state restores its historical selection and protects acceptance until its displayed plan is current',()=>{
  const f=setup();f.context.switchMaterialRound(f.data,'need',1);assert.equal(f.render().disabled,true);
  f.context.selectEntityReviewState(f.other);assert.equal(f.render().disabled,false);assert.equal(f.data.selectedMaterialRounds.need,undefined);
  f.context.switchMaterialRound(f.data,'same-need',1);assert.equal(f.render().disabled,false);
  f.context.selectEntityReviewState(f.form);assert.equal(f.data.selectedMaterialRounds.need,1);assert.equal(f.render().disabled,true);
  f.context.switchMaterialRound(f.data,'need',2);assert.equal(f.render().disabled,false);
  f.context.state.productionEntityDetail.record={...f.entity,id:'old-entity'};assert.equal(f.render().disabled,true);f.context.state.productionEntityDetail.record=f.entity;
  f.data.localVersions={relation:{id:'old-relation',current_revision:'current-relation'}};assert.equal(f.render().disabled,true);
});

test('guard uses exact plan identity, model fallbacks and existing local-version overrides without mutating the snapshot',()=>{
  const f=setup(),before=JSON.stringify(f.data);assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),false);assert.equal(JSON.stringify(f.data),before);assert.equal(f.data.selectedMaterialRounds,undefined);
  f.data.selectedMaterialRounds={need:999};assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),false);
  f.data.material_versions.need[0].plan={...f.plan,object_id:'other-identity'};assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),true);
  f.data.material_versions.need[0].plan=f.plan;f.data.selectedMaterialRounds.need=1;f.data.material_versions.need[1].members.push(f.plan);f.data.localVersions={need:f.plan};assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),false);assert.equal(f.context.materialRoundModels([f.plan],[],f.data)[0].need,f.plan);
  f.data.localVersions={need:f.old};assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),true);
});

test('shared material from another entity does not expand the acceptance scope',()=>{
  const f=setup();f.data.material_versions.shared=[{number:2,plan:row('shared','REQUIREMENT','shared-new'),members:[],results:[]},{number:1,plan:row('shared','REQUIREMENT','shared-old'),members:[],results:[]}];f.data.selectedMaterialRounds={shared:1};
  const before=JSON.stringify(f.data.scope);assert.equal(f.context.entityReviewHasHistoricalContent(f.data,f.entity,f.form),false);assert.equal(f.render().disabled,false);assert.equal(JSON.stringify(f.data.scope),before);
});

test('content compatibility mode without generation requirements keeps its existing scope and no generation permission',async()=>{
  const f=setup();f.data.requirements=[];f.data.material_versions={};f.data.acceptance_mode='content';f.data.decision_scope={entity:ref(f.entity),states:[ref(f.form)],media:[]};f.data.accepted=null;
  const button=f.render();assert.equal(button.disabled,false);await button.onclick();assert.equal(f.requests[0].payload.acceptance_mode,'content');assert.deepEqual(f.requests[0].payload.scope,f.data.decision_scope);assert.equal(f.data.accepted,null);
  f.data.historical=true;assert.equal(f.render().disabled,true);
});

test('incomplete current preparation posts its exact content scope while old plans remain read-only',async()=>{
  const f=setup();f.data.acceptance_mode='content';f.data.preparation={complete:false,issues:[{message:'前置方案已变化，需复核'}]};
  const button=f.render();assert.equal(button.disabled,false);assert.match(button.title,/生成前仍需完善/);
  await button.onclick();assert.equal(f.requests[0].payload.acceptance_mode,'content');assert.deepEqual(f.requests[0].payload.scope,f.data.scope);
  f.data.decisionSave=null;f.context.switchMaterialRound(f.data,'need',1);assert.equal(f.render().disabled,true);
});

test('a queued old button callback cannot judge a newer historical display or a different entity',async()=>{
  const f=setup(),button=f.render();assert.equal(button.disabled,false);const click=button.onclick();f.context.switchMaterialRound(f.data,'need',1);await click;assert.equal(f.requests.length,0);
  f.context.switchMaterialRound(f.data,'need',2);const next=f.render().onclick();f.context.state.entityReview={...f.data};await next;assert.equal(f.requests.length,0);
  f.context.state.entityReview=f.data;const away=f.render().onclick();f.context.state.workspace='story.sources';await away;assert.equal(f.requests.length,0);
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
