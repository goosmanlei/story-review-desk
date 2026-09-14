import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {agentTools,agentInstructions,isAgentToolMessage,handleAgentTool} from '../tools/task-agent-tools.mjs';
import {decisionHash} from '../tools/task-decision-protocol.mjs';
import {location,mutate,readLedger,readBindings,startRun,updateBinding} from '../tools/task-ledger.mjs';
import {decisionChannelSources} from '../tools/task-decision-channel.mjs';
import {fileURLToPath} from 'node:url';
import {nativeAcceptancePlan,runNativeAcceptance,syncNativeFixtureNode,resumeNativeFixtureChannel} from './task-attach.native.mjs';

const context={serviceId:'fixture-service',generation:'fixture-generation',connectionId:'fixture-connection'};
const baseCommit='a'.repeat(40);
const spawnArgs=(key='first',resource='core/tools/first.mjs')=>({key,goal:'完成范围内独立修改',prompt:'只修改分配资源；保留验收证据',deliverables:['修改与证据'],acceptanceCriteria:['接口通过'],resources:[{kind:'FILE',key:resource,access:'WRITE'}],execution:{rationale:'独立实现',workClass:'IMPLEMENTATION'}});
const unpack=response=>JSON.parse(response.contentItems[0].text);

async function fixture(t) {
 assert(process.env.REVIEW_TASK_DIR,'测试须使用受管 process 执行');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'agent-tools-')),loc={root,runtime:path.join(root,'instance/runtime/tasks'),projectId:'fixture-project'};
 await mkdir(loc.runtime,{recursive:true});t.after(()=>rm(root,{recursive:true,force:true}));
 const task={id:'task-one',version:1,status:'RUNNING',assignments:[]},ledger={tasks:{[task.id]:task},events:[]},bindings={assignments:{},tasks:{[task.id]:'detached-original-run'}},calls=[],operations=new Map();
 const makeAssignment=(id,parent=null,resource='core')=>{
  const a={id,key:id,taskId:task.id,version:1,role:parent?'SUBAGENT':'WORKER',parentAssignmentId:parent,rootAssignmentId:parent?task.assignments.find(x=>x.id===parent).rootAssignmentId:id,status:'RUNNING',execution:{mode:'SUBAGENT'},goal:'fixture',deliverables:['artifact'],acceptanceCriteria:['verified'],resources:[{kind:resource==='core'?'DIRECTORY':'FILE',key:resource,access:'WRITE'}],checkpoint:null,result:null};
  task.assignments.push(a);bindings.assignments[id]={runId:'detached-original-run',executionAuthority:{token:'token-'+id},nativeThreadId:'thread-'+id,backendServiceId:context.serviceId,backendGeneration:context.generation,backendCreation:{threadId:'thread-'+id,serviceId:context.serviceId,generation:context.generation},backendRequest:{operationId:'backend-'+id,turnId:'turn-'+id,baseCommit,state:'RUNNING'}};return a;
 };
 const worker=makeAssignment('worker'),state={root,loc,ledger,bindings,calls,operations,task,worker,makeAssignment,sequence:0,control:null};
 const services={
  location:async()=>loc,readLedger:async()=>structuredClone(ledger),readBindings:async()=>structuredClone(bindings),control:async()=>state.control,
  requireAuthority:async(_loc,authority,{assignmentId,taskId,relation,converging})=>{
   calls.push({kind:'authority',authority:structuredClone(authority),assignmentId,relation,converging});
   assert.equal(authority.executionToken,bindings.assignments[authority.assignmentId]?.executionAuthority.token);
   const target=task.assignments.find(a=>a.id===assignmentId);assert(target&&target.taskId===taskId);
   if(!converging&&state.control)throw Error('PAUSE_EXECUTION_BLOCKED');
   if(relation==='self')assert.equal(assignmentId,authority.assignmentId);
   else {let a=target;while(a.id!==authority.assignmentId&&a.parentAssignmentId)a=task.assignments.find(x=>x.id===a.parentAssignmentId);assert.equal(a.id,authority.assignmentId);}
   return {id:'detached-original-run',authorityMode:'EXECUTION',capabilities:{agentCapacity:1,availableSlots:1}};
  },
  restoreReceipts:async()=>{},
  mutate:async(_project,action,request)=>{
   const hash=decisionHash(request),old=operations.get(request.operationId);
   if(old){assert.equal(old.hash,hash,'恢复必须重放原请求及 CAS');return structuredClone(old.result);}
   calls.push({kind:'mutate',action,request:structuredClone(request)});
   assert.equal(request.expectedVersions[task.id],task.version);let result;
   if(action==='assignment:schedule'){
    assert.equal(request.parentAssignmentId,request.authority.assignmentId);
    if(state.defer){result={status:'NO_EXECUTABLE_ASSIGNMENT',assignments:[],deferred:[{reason:'RESOURCE_CONFLICT'}]};}
    else {
     const spec=request.assignments[0],id='child-'+(task.assignments.length),a=makeAssignment(id,request.parentAssignmentId,spec.resources[0].key);
     Object.assign(a,structuredClone(spec),{id,rootAssignmentId:task.assignments.find(x=>x.id===request.parentAssignmentId).rootAssignmentId,status:'RESERVED',version:1});
     bindings.assignments[id]={runId:'detached-original-run',executionAuthority:{token:'token-'+id}};
     result={status:'SCHEDULED',assignments:[structuredClone(a)],deferred:[]};
    }
   }else {
    const a=task.assignments.find(x=>x.id===request.assignmentId);assert.equal(request.expectedAssignmentVersion,a.version);
    if(action==='assignment:accept'){assert.equal(a.status,'DELIVERED');a.status='ACCEPTED';a.acceptanceEvidence=request.evidence;}
    else if(action==='assignment:close'){if(request.outcome==='ACCEPTED')assert.equal(a.status,'ACCEPTED');assert(!bindings.assignments[a.id].nativeThreadId||bindings.assignments[a.id].closureReceipt?.verified);a.status='CLOSED';a.outcome=request.outcome;bindings.assignments[a.id].retiredAt='fixture';}
    else throw Error('unexpected mutation '+action);
    a.version++;result={assignmentId:a.id,status:a.status};
   }
   task.version++;operations.set(request.operationId,{hash,result:structuredClone(result)});return result;
  },
  allocateWorkspace:async request=>{
   calls.push({kind:'workspace',request});assert.equal(request.baseCommit,baseCommit);assert.equal(request.root.id,'worker');assert.equal(request.task.id,task.id);await request.assertAdmission();
   const names=await readdir(path.join(loc.runtime,'agent-tools/operations'));
   const saved=JSON.parse(await readFile(path.join(loc.runtime,'agent-tools/operations',names.find(n=>n.endsWith('.json'))),'utf8'));
   assert(saved.assignmentId,'在工作区创建前保存子派工回执');
   return {workspace:path.join(root,'.process/shared',request.assignment.id),baseCommit,resourceStatus:'RETAINED_FOR_INTEGRATION'};
  },
  backend:{
   dispatch:async(_p,_r,id,request,authority)=>{
    calls.push({kind:'dispatch',id,request:structuredClone(request),authority});
    const a=task.assignments.find(x=>x.id===id),b=bindings.assignments[id];a.status='RUNNING';
    Object.assign(b,{nativeThreadId:'thread-'+id,backendServiceId:context.serviceId,backendGeneration:context.generation,backendCreation:{threadId:'thread-'+id,serviceId:context.serviceId,generation:context.generation},workspace:request.workspace,backendRequest:{...request,turnId:'turn-'+id,state:'RUNNING'}});
    return {assignmentId:id,status:'RUNNING',nativeThreadId:b.nativeThreadId,turnId:b.backendRequest.turnId};
   },
   sync:async(_p,_r,id,authority)=>{calls.push({kind:'sync',id,authority});return {assignmentId:id,status:bindings.assignments[id].backendRequest?.state||'RESULT_UNKNOWN'};},
   collect:async(_p,_r,id,operationId,authority)=>{calls.push({kind:'collect',id,operationId,authority});const a=task.assignments.find(x=>x.id===id);a.status='DELIVERED';a.version++;task.version++;a.result={summary:'已验证结果',artifacts:['patch'],acceptance:[{criterion:0,evidence:'fake evidence'}]};return {status:'DELIVERED'};},
   send:async(_p,_r,id,request,authority)=>{calls.push({kind:'send',id,request,authority});return {assignmentId:id,status:'DELIVERED',operationId:request.operationId};},
   close:async(_p,_r,id,authority)=>{calls.push({kind:'close',id,authority});bindings.assignments[id].closureReceipt={verified:true,nativeThreadId:bindings.assignments[id].nativeThreadId,history:'PRESERVED'};return {status:'NATIVE_CLOSED'};},
  },
 };
 state.services=services;
 state.message=(action,args={},sender='worker',id=++state.sequence)=>({id,method:'item/tool/call',params:{tool:'review_task_agent_'+action,callId:'call-'+id,threadId:'thread-'+sender,turnId:'turn-'+sender,arguments:args}});
 state.call=(action,args={},sender='worker',id)=>handleAgentTool(root,context,state.message(action,args,sender,id),services);
 return state;
}

test('registered tools expose only managed logical inputs and require final child convergence',()=>{
 assert.deepEqual(agentTools.map(t=>t.name),['spawn','send','read','wait','accept','close'].map(x=>'review_task_agent_'+x));
 for(const tool of agentTools){assert.equal(tool.inputSchema.additionalProperties,false);for(const field of ['taskId','parentAssignmentId','workspace','executionToken'])assert(!Object.hasOwn(tool.inputSchema.properties,field));}
 assert.match(agentInstructions,/禁止使用原生 spawn/);assert.match(agentInstructions,/所有后代关闭/);assert.match(agentInstructions,/不设应用层子 Agent 数量上限/);
 assert(isAgentToolMessage({method:'item/tool/call',params:{tool:'review_task_agent_spawn'}}));
 assert(!isAgentToolMessage({method:'item/tool/call',params:{tool:'review_task_agent_spawn',namespace:'foreign'}}));
});

test('sender binding rejects forged parents, unknown threads, stale turns and missing creation receipts',async t=>{
 const s=await fixture(t);
 for(const extra of [{taskId:'task-other'},{parentAssignmentId:'other'},{workspace:'/tmp/foreign'},{executionToken:'token-worker'}]){
  const r=await s.call('spawn',{...spawnArgs(),...extra});assert.equal(r.success,false);assert.match(unpack(r).error,/SCHEMA/);
 }
 const foreign=s.message('read');foreign.params.threadId='foreign';assert.match(unpack(await handleAgentTool(s.root,context,foreign,s.services)).error,/BINDING/);
 const stale=s.message('read');stale.params.turnId='old-turn';assert.match(unpack(await handleAgentTool(s.root,context,stale,s.services)).error,/TURN/);
 delete s.bindings.assignments.worker.backendCreation;
 assert.match(unpack(await s.call('spawn',spawnArgs())).error,/RECEIPT/);
 assert(!s.calls.some(c=>['mutate','workspace','dispatch'].includes(c.kind)));
});

test('a first dynamic call waits for the original turn receipt without creating or resending a turn',async t=>{
 const s=await fixture(t),b=s.bindings.assignments.worker;delete b.backendRequest.turnId;b.backendRequest.state='TURN_STARTING';let restored=0;
 s.services.restoreReceipts=async()=>{restored++;b.backendRequest.turnId='turn-worker';b.backendRequest.state='RUNNING';};
 const result=await s.call('read');assert.equal(result.success,true);assert.equal(restored,1);assert(!s.calls.some(c=>['dispatch','send'].includes(c.kind)));
});

test('spawn persists intent and exact reservation before RPC, returns promptly and does not expose native identity',async t=>{
 const s=await fixture(t);const dispatch=s.services.backend.dispatch;
 s.services.backend.dispatch=async(...args)=>{
  const files=(await readdir(path.join(s.loc.runtime,'agent-tools/operations'))).filter(n=>n.endsWith('.json'));
  const record=JSON.parse(await readFile(path.join(s.loc.runtime,'agent-tools/operations',files[0]),'utf8'));
  assert.equal(record.dispatchRequest.operationId,args[3].operationId);assert.equal(record.assignmentId,args[2]);assert(record.scheduleRequest.authority.executionToken);assert(record.workspace);
  return dispatch(...args);
 };
 const response=await s.call('spawn',spawnArgs()),result=unpack(response);assert.equal(response.success,true);assert.equal(result.status,'RUNNING');assert.equal(result.parentAssignmentId,'worker');assert.equal(result.baseCommit,baseCommit);assert(!('nativeThreadId'in result));assert(!('turnId'in result));
 assert.equal(s.calls.filter(c=>c.kind==='sync').length,0);assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,1);
 const replay=unpack(await s.call('spawn',spawnArgs()));assert.equal(replay.assignmentId,result.assignmentId);assert.equal(replay.replayed,true);assert.equal(s.task.assignments.length,2);assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,1);
 assert.match(unpack(await s.call('spawn',{...spawnArgs(),prompt:'changed'})).error,/REPLAY/);
});

test('a lost schedule reply replays the saved CAS request and recovers the original reservation',async t=>{
 const s=await fixture(t),mutate=s.services.mutate;let lost=true;
 s.services.mutate=async(...args)=>{const result=await mutate(...args);if(lost&&args[1]==='assignment:schedule'){lost=false;throw Error('fixture lost schedule reply');}return result;};
 assert.equal((await s.call('spawn',spawnArgs())).success,false);assert.equal(s.task.assignments.length,2);
 const result=unpack(await s.call('spawn',spawnArgs()));assert.equal(result.assignmentId,'child-1');assert.equal(result.status,'RUNNING');assert.equal(s.task.assignments.length,2);assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,1);
});

test('a lost native creation reply only syncs the original backend operation on a new callback',async t=>{
 const s=await fixture(t),dispatch=s.services.backend.dispatch;let lost=true;
 s.services.backend.dispatch=async(...args)=>{const result=await dispatch(...args);if(lost){lost=false;throw Error('fixture lost RPC reply');}return result;};
 assert.equal((await s.call('spawn',spawnArgs())).success,false);
 const result=unpack(await s.call('spawn',spawnArgs()));assert.equal(result.status,'RUNNING');assert.equal(result.assignmentId,'child-1');assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,1);assert.equal(s.calls.filter(c=>c.kind==='sync').length,1);assert.equal(s.calls.filter(c=>c.kind==='workspace').length,1);
});

test('an unbound create RESULT_UNKNOWN is retained and never retried or closed',async t=>{
 const s=await fixture(t);
 s.services.backend.dispatch=async(_p,_r,id,request)=>{s.calls.push({kind:'dispatch'});s.bindings.assignments[id].backendRequest={...request,state:'RESULT_UNKNOWN'};throw Error('unknown create');};
 assert.equal((await s.call('spawn',spawnArgs())).success,false);
 assert.equal(unpack(await s.call('spawn',spawnArgs())).status,'RESULT_UNKNOWN');
 assert.equal(unpack(await s.call('spawn',spawnArgs())).status,'RESULT_UNKNOWN');
 const closed=await s.call('close',{key:'cancel-first',assignmentId:'child-1',outcome:'CANCELLED',reason:'stop',cleanup:'保留原输入'});
 assert.equal(closed.success,false);assert.match(unpack(closed).error,/RESULT_UNKNOWN/);assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,1);assert.equal(s.calls.filter(c=>c.kind==='close').length,0);
});

test('definitively deferred reservation can use its stable intent after resource availability changes',async t=>{
 const s=await fixture(t);s.defer=true;
 assert.equal(unpack(await s.call('spawn',spawnArgs())).status,'DEFERRED');assert.equal(s.task.assignments.length,1);
 s.defer=false;const result=unpack(await s.call('spawn',spawnArgs()));assert.equal(result.status,'RUNNING');assert.equal(s.task.assignments.length,2);
 const mutations=s.calls.filter(c=>c.kind==='mutate');assert.equal(mutations.length,2);assert.notEqual(mutations[0].request.operationId,mutations[1].request.operationId);assert.equal(mutations[0].request.assignments[0].key,mutations[1].request.assignments[0].key);
});

test('children can create descendants at the exact root base and application slot counts do not cap tool use',async t=>{
 const s=await fixture(t);
 for(let i=0;i<4;i++)assert.equal((await s.call('spawn',spawnArgs('child'+i,'core/tools/file'+i+'.mjs'))).success,true);
 assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,4);
 const nested=unpack(await s.call('spawn',spawnArgs('nested','core/tools/file0.mjs'),'child-1'));
 assert.equal(nested.status,'RUNNING');assert.equal(nested.parentAssignmentId,'child-1');assert.equal(nested.rootAssignmentId,'worker');assert.equal(nested.baseCommit,baseCommit);
 assert.equal(s.calls.filter(c=>c.kind==='dispatch').at(-1).authority.assignmentId,'child-1');
});

test('delegation cannot expand resources or target a sibling, ancestor or different task',async t=>{
 const s=await fixture(t);s.makeAssignment('left','worker','core/tools/left.mjs');s.makeAssignment('right','worker','core/tools/right.mjs');
 assert.match(unpack(await s.call('spawn',spawnArgs('outside','other/tools/file.mjs'))).error,/RESOURCE_SCOPE/);
 assert.match(unpack(await s.call('spawn',spawnArgs('outside','core/tools/right.mjs'),'left')).error,/RESOURCE_SCOPE/);
 for(const id of ['worker','right','missing'])for(const action of ['send','read','wait','accept','close']){
  const args={assignmentId:id,...(['send','accept','close'].includes(action)?{key:action+id}:{}),...(action==='send'?{text:'scoped'}:{}),...(action==='accept'?{evidence:'checked'}:{}),...(action==='close'?{outcome:'CANCELLED',reason:'stop',cleanup:'preserved'}:{})};
  const response=await s.call(action,args,'left');assert.equal(response.success,false);assert.match(unpack(response).error,/SUBTREE/);
 }
 assert(!s.calls.some(c=>['dispatch','send','close','collect'].includes(c.kind)));
});

test('pause, stopped execution and unknown original operations block creation and messages while reads continue',async t=>{
 const s=await fixture(t);s.makeAssignment('child','worker');s.control={status:'PAUSING'};
 for(const [action,args]of [['spawn',spawnArgs()],['send',{key:'send',assignmentId:'child',text:'continue'}]])assert.match(unpack(await s.call(action,args)).error,/PAUSE/);
 assert.equal((await s.call('read',{assignmentId:'child'})).success,true);
 s.control=null;s.bindings.assignments.worker.backendRequest.state='RESULT_UNKNOWN';assert.match(unpack(await s.call('spawn',spawnArgs())).error,/RESULT_UNKNOWN/);
 assert(!s.calls.some(c=>['dispatch','send'].includes(c.kind)));
});

test('tool replies await dispatch completion; waiting leaves unrelated tool requests responsive',async t=>{
 const s=await fixture(t),dispatch=s.services.backend.dispatch;let started,release;
 const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 s.services.backend.dispatch=async(...args)=>{started();await gate;return dispatch(...args);};
 let replied=false;const pending=s.call('spawn',spawnArgs()).then(value=>{replied=true;return value;});await entered;assert.equal(replied,false);
 const other=await s.call('read');assert.equal(other.success,true);assert.equal(replied,false);release();assert.equal((await pending).success,true);
 let sleeping,resume;const sleepingNow=new Promise(resolve=>{sleeping=resolve;});s.services.sleep=async()=>{sleeping();await new Promise(resolve=>{resume=resolve;});};
 const waiting=s.call('wait',{assignmentId:'child-1',timeoutMs:30000});await sleepingNow;
 assert.equal((await s.call('read')).success,true);s.bindings.assignments['child-1'].backendRequest.state='SUCCEEDED';resume();assert.equal(unpack(await waiting).backend.status,'SUCCEEDED');
});

test('original callback and concurrent stable-key replays receive fully persisted replies without duplicate children',async t=>{
 const s=await fixture(t),message=s.message('spawn',spawnArgs());
 const responses=await Promise.all([handleAgentTool(s.root,context,message,s.services),handleAgentTool(s.root,context,message,s.services),s.call('spawn',spawnArgs())]);
 assert(responses.every(r=>r.success));assert.equal(new Set(responses.map(r=>unpack(r).assignmentId)).size,1);assert.equal(s.calls.filter(c=>c.kind==='dispatch').length,1);
 const changed=structuredClone(message);changed.params.arguments.prompt='changed';assert.match(unpack(await handleAgentTool(s.root,context,changed,s.services)).error,/REQUEST_REPLAY/);
 const files=(await readdir(path.join(s.loc.runtime,'agent-tools/calls'))).filter(n=>n.endsWith('.json'));for(const name of files){const saved=JSON.parse(await readFile(path.join(s.loc.runtime,'agent-tools/calls',name),'utf8'));assert(saved.response);}
});

test('parent accepts and closes only a converged descendant tree, preserving artifacts and original authority',async t=>{
 const s=await fixture(t);s.makeAssignment('child','worker');s.makeAssignment('grandchild','child');
 const accept={key:'accept-child',assignmentId:'child',evidence:'已检查各验收项'};
 assert.match(unpack(await s.call('accept',accept)).error,/CHILDREN_OPEN/);assert(!s.calls.some(c=>c.kind==='collect'));
 const close={key:'close-child',assignmentId:'child',outcome:'ACCEPTED',cleanup:'成果已转交整合'};
 assert.match(unpack(await s.call('close',close)).error,/CHILDREN_OPEN/);
 const grand=s.task.assignments.find(a=>a.id==='grandchild');grand.status='CLOSED';grand.outcome='ACCEPTED';
 assert.equal(unpack(await s.call('accept',accept)).status,'ACCEPTED');assert.equal(s.calls.filter(c=>c.kind==='close').length,0);
 const closed=unpack(await s.call('close',close));assert.equal(closed.status,'CLOSED');assert.equal(closed.artifacts,'RETAINED_FOR_INTEGRATION');assert.equal(closed.history,'PRESERVED');
 const mutations=s.calls.filter(c=>c.kind==='mutate'&&c.action==='assignment:close');assert.equal(mutations.length,1);assert.equal(mutations[0].request.authority.assignmentId,'worker');assert.match(mutations[0].request.cleanup,/未删除资源/);
 assert.equal(unpack(await s.call('close',close)).replayed,true);assert.equal(s.calls.filter(c=>c.kind==='close').length,1);
 assert.equal((await s.call('read',{assignmentId:'child'})).success,true);
});

test('accept blocks pending decisions and send preserves a stable operation without claiming new authorization',async t=>{
 const s=await fixture(t),child=s.makeAssignment('child','worker');child.decisions=[{status:'WAITING_USER'}];
 assert.match(unpack(await s.call('accept',{key:'accept',assignmentId:'child',evidence:'checked'})).error,/DECISION_PENDING/);
 child.decisions=[];const send={key:'message',assignmentId:'child',text:'继续已授权资源内的修改'};
 const first=unpack(await s.call('send',send)),second=unpack(await s.call('send',send));assert.equal(first.operationId,second.operationId);assert.equal(s.calls.filter(c=>c.kind==='send').length,1);
 assert.match(unpack(await s.call('send',{...send,text:'changed'})).error,/REPLAY/);assert.equal(s.calls.find(c=>c.kind==='send').request.actor,'WORKER_AGENT');
});

test('v3 ledger integration retains execution authority after coordinator expiry through managed child closure',async t=>{
 assert(process.env.REVIEW_TASK_DIR,'Use the managed process runner');
 const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'agent-ledger-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'instance'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
 const request=x=>({operationId:randomUUID(),actor:'AGENT_INTEGRATION_FIXTURE',...x});
 const published=await mutate(root,'publish',request({task:{clarified:true,type:'SYSTEM',title:'受管工具隔离集成夹具',originalRequest:'验证 v3 工具与真实账本接口',goal:'贯通创建和关闭',scope:['隔离临时目录'],deliverables:['测试证据'],acceptanceCriteria:['通过'],authorization:'仅本地隔离测试，无真实 App Server 或模型调用',discussion:{approved:true,summary:'验证范围明确',feasibility:'临时账本与 fake backend',approvedRequirements:['不调用真实服务']}}}));
 const capabilities={backend:'PROJECT_APP_SERVER',backendServiceId:context.serviceId,backendGeneration:context.generation,delegation:true,closeVerified:true,agentCapacity:1,availableSlots:0,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};
 const run=await startRun(root,{capabilities}),taskId=published.taskId;
 const scheduled=await mutate(root,'schedule',request({runId:run.id,expectedVersions:{[taskId]:(await readLedger(root)).tasks[taskId].version},assignments:[{taskId,key:'worker',goal:'隔离工具集成',deliverables:['证据'],acceptanceCriteria:['通过'],resources:[{kind:'DIRECTORY',key:'core',access:'WRITE'}],execution:{rationale:'fake backend integration'}}]}));
 const worker=scheduled.assignments[0],loc=await location(root);
 const change=async(id,action,extra={},authority)=>{const task=(await readLedger(root)).tasks[taskId],a=task.assignments.find(x=>x.id===id);return mutate(root,action,request({runId:run.id,taskId,assignmentId:id,authority,expectedVersions:{[taskId]:task.version},expectedAssignmentVersion:a.version,...extra}));};
 const workspace=async id=>{const p=path.join(root,'.process/shared',id);await mkdir(p,{recursive:true});await writeFile(path.join(p,'.git'),'fixture independent worktree marker');return p;};
 await change(worker.id,'assignment:dispatch');
 await change(worker.id,'assignment:start',{nativeThreadId:'native-'+worker.id,workspace:await workspace(worker.id),workspaceEvidence:'隔离账本 fixture；原生与 Git 由 fake backend 验证'});
 const bind=async(id,request,authority)=>updateBinding(root,run.id,id,b=>{Object.assign(b,{backendServiceId:context.serviceId,backendGeneration:context.generation,backendCreation:{threadId:'native-'+id,serviceId:context.serviceId,generation:context.generation},nativeThreadId:'native-'+id,backendRequest:{...request,turnId:'turn-'+id,state:'RUNNING',baseCommit}});},{authority});
 await bind(worker.id,{operationId:'root-fixture'});
 const runFile=path.join(loc.runtime,'run.json'),original=JSON.parse(await readFile(runFile,'utf8'));original.expiresAt='2000-01-01T00:00:00Z';await writeFile(runFile,JSON.stringify(original));
 const backends=[];
 const injected={
  allocateWorkspace:async({assignment,baseCommit:base})=>({workspace:await workspace(assignment.id),baseCommit:base}),
  backend:{
   dispatch:async(_p,_r,id,q,authority)=>{backends.push({action:'dispatch',id,authority});await change(id,'assignment:dispatch',{},authority);await change(id,'assignment:start',{nativeThreadId:'native-'+id,workspace:q.workspace,workspaceEvidence:'隔离 fake backend 回执'},authority);await bind(id,q,authority);return {status:'RUNNING',assignmentId:id};},
   sync:async(_p,_r,id)=>({assignmentId:id,status:(await readBindings(loc)).assignments[id].backendRequest.state}),
   collect:async(_p,_r,id,operationId,authority)=>{await updateBinding(root,run.id,id,b=>{b.backendRequest.state='SUCCEEDED';},{authority});return change(id,'assignment:result',{operationId,checkpoint:{summary:'完成隔离工作',completedSteps:['fake complete'],nextSteps:[],inputs:['fixture'],artifacts:['fixture-patch'],operations:[]},result:{summary:'fixture complete',artifacts:['fixture-patch'],acceptance:[{criterion:0,evidence:'fixture checked'}]}},authority);},
   close:async(_p,_r,id,authority)=>{backends.push({action:'close',id,authority});await updateBinding(root,run.id,id,b=>{b.closureReceipt={verified:true,nativeThreadId:b.nativeThreadId,history:'PRESERVED'};},{authority});return {status:'NATIVE_CLOSED'};},
  },
 };
 let sequence=0;
 const call=(action,args)=>handleAgentTool(root,context,{id:++sequence,method:'item/tool/call',params:{tool:'review_task_agent_'+action,callId:'call-'+sequence,threadId:'native-'+worker.id,turnId:'turn-'+worker.id,arguments:args}},injected);
 const response=await call('spawn',spawnArgs());assert.equal(response.success,true,JSON.stringify(unpack(response)));const childId=unpack(response).assignmentId;
 const child=(await readLedger(root)).tasks[taskId].assignments.find(a=>a.id===childId);assert.equal(child.parentAssignmentId,worker.id);assert.equal(child.rootAssignmentId,worker.id);assert.equal(child.status,'RUNNING');
 assert.equal((await call('spawn',spawnArgs())).success,true);assert.equal(backends.filter(x=>x.action==='dispatch').length,1);
 const accepted=await call('accept',{key:'accept',assignmentId:childId,evidence:'父节点核验通过'});assert.equal(accepted.success,true,JSON.stringify(unpack(accepted)));
 const closed=await call('close',{key:'close',assignmentId:childId,outcome:'ACCEPTED',cleanup:'供整合的输入已保留'});assert.equal(closed.success,true,JSON.stringify(unpack(closed)));assert.equal(unpack(closed).status,'CLOSED');
 assert.equal(backends.find(x=>x.action==='close').authority.assignmentId,worker.id);
 const events=(await Promise.all((await readdir(loc.events)).map(f=>readFile(path.join(loc.events,f),'utf8')))).join('');
 assert(!events.includes(backends[0].authority.executionToken));assert(!events.includes('native-'+worker.id));
});

test('the immutable decision receiver bundle contains every relative dependency used by managed tools',async()=>{
 const sourceRoot=fileURLToPath(new URL('../',import.meta.url)),included=new Set(decisionChannelSources),missing=[];
 for(const name of included){const source=await readFile(path.join(sourceRoot,name),'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)){const dependency=path.normalize(path.join(path.dirname(name),match[2]));if(!included.has(dependency))missing.push({source:name,dependency});}}
 assert.deepEqual(missing,[]);assert(included.has('tools/task-agent-tools.mjs'));assert(included.has('tools/task-backend.mjs'));assert(included.has('tools/task-execution-scope.mjs'));
});

test('native acceptance is opt-in and requires an explicit model and exact base before any execution',async()=>{
 const plan=nativeAcceptancePlan([]),result=await runNativeAcceptance(plan);
 assert.equal(plan.execute,false);assert.equal(result.status,'NOT_RUN');assert.equal(plan.childCount,1);
 assert.throws(()=>nativeAcceptancePlan(['--execute']),/requires/);
 assert.equal(nativeAcceptancePlan(['--execute','--source-repository','/explicit/core','--base-commit',baseCommit,'--model','explicit-model','--effort','medium','--children','4']).childCount,4);
});

test('native fixture synchronization tolerates only verified closure of the original node',async()=>{
 const error=Error('EXECUTION_AUTHORITY_SCOPE: original token revoked'),original={nativeThreadId:'native-child',backendServiceId:'service',backendCreation:{threadId:'native-child',serviceId:'service'}};
 const closed={assignment:{id:'child',status:'CLOSED'},binding:{...original,closureReceipt:{verified:true,nativeThreadId:'native-child',history:'PRESERVED'}}};
 const services={sync:async()=>{throw error;},readCurrent:async()=>closed};
 assert.deepEqual(await syncNativeFixtureNode('child',original,services),{assignmentId:'child',status:'CLOSED',closedDuringSync:true});
 for(const current of [
  {...closed,assignment:{id:'child',status:'RUNNING'}},
  {...closed,binding:{...closed.binding,nativeThreadId:'different'}},
  {...closed,binding:{...closed.binding,closureReceipt:{verified:false,nativeThreadId:'native-child',history:'PRESERVED'}}},
  {...closed,binding:{...closed.binding,backendCreation:{threadId:'native-child',serviceId:'different'}}},
 ])await assert.rejects(syncNativeFixtureNode('child',original,{...services,readCurrent:async()=>current}),value=>value===error);
});

test('native fixture resume reuses a live immutable receiver and never restarts an unverified owner',async()=>{
 let starts=0;const root='/isolated/fixture',loc={runtime:root+'/instance/runtime'},ensure=async()=>{starts++;return {status:'READY'};};
 const live=await resumeNativeFixtureChannel(root,loc,{call:async()=>({status:'READY',id:'original'}),read:async()=>{throw Error('live ping must not require source migration');},ensure});
 assert.equal(live.id,'original');assert.equal(starts,0);
 const failed={call:async()=>{throw Error('ping failed');},read:async()=>({root,process:{pid:123}}),ensure};
 await assert.rejects(resumeNativeFixtureChannel(root,loc,{...failed,alive:()=>true}),/not confirmed stopped/);assert.equal(starts,0);
 await assert.rejects(resumeNativeFixtureChannel(root,loc,{...failed,read:async()=>({root}),alive:()=>false}),/not confirmed stopped/);assert.equal(starts,0);
 assert.equal((await resumeNativeFixtureChannel(root,loc,{...failed,alive:()=>false})).status,'READY');assert.equal(starts,1);
});
