import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mutate,readLedger,readBindings,startRun,updateBinding,location} from '../tools/task-ledger.mjs';
import {assertBackendThread,closeBackend,dispatchBackend,recoverBackend,requestFingerprint,continueBackend,restoreBackendReceipts,syncBackend} from '../tools/task-backend.mjs';
import {closeNativeThread} from '../tools/task-native.mjs';
import {decisionHash} from '../tools/task-decision-protocol.mjs';
import {durableDecisionFile} from '../tools/task-decisions.mjs';

const request=x=>({operationId:randomUUID(),actor:'BACKEND_FIXTURE',...x});
const capabilities={
  backend:'PROJECT_APP_SERVER',
  backendServiceId:'fixture-service',
  backendGeneration:'fixture-generation',
  socket:'/fixture/not-a-real-socket',
  delegation:true,
  closeVerified:true,
  goalVerified:false,
  availableSlots:3,
  models:[{model:'gpt-5.6-sol',efforts:['xhigh']}],
};
const taskSpec={
  clarified:true,
  discussion:{approved:true,summary:'已确认隔离后端验证',feasibility:'只使用临时账本与 fake client',approvedRequirements:['不连接真实 Codex']},
  title:'专属 App Server 后端验证夹具',
  type:'SYSTEM',
  originalRequest:'验证派工后端契约',
  goal:'验证归属、幂等、关闭与恢复边界',
  scope:['临时 fixture'],
  deliverables:['测试证据'],
  acceptanceCriteria:['契约通过'],
  authorization:'仅隔离测试，不连接项目服务或业务数据库',
};

async function fixture(t) {
  assert(process.env.REVIEW_TASK_DIR,'测试必须由受管 process 提供 REVIEW_TASK_DIR');
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'backend-'));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});
  await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
  const published=await mutate(root,'publish',request({task:taskSpec}));
  const run=await startRun(root,{capabilities});
  const ledger=await readLedger(root);
  const scheduled=await mutate(root,'schedule',request({
    runId:run.id,
    expectedVersions:{[published.taskId]:ledger.tasks[published.taskId].version},
    assignments:[{
      taskId:published.taskId,
      key:'backend',
      goal:'验证后端派工契约',
      deliverables:['测试结果'],
      acceptanceCriteria:['契约通过'],
      resources:[{kind:'FILE',key:'core/tests/task-backend.test.mjs',access:'WRITE'}],
      execution:{rationale:'隔离软件验证'},
    }],
  }));
  const assignment=scheduled.assignments[0];
  t.after(()=>rm(root,{recursive:true,force:true}));
  return {root,run,taskId:published.taskId,assignment};
}

async function assignmentChange(state,action,extra={}) {
  const task=(await readLedger(state.root)).tasks[state.taskId];
  const assignment=task.assignments.find(a=>a.id===state.assignment.id);
  return mutate(state.root,action,request({
    runId:state.run.id,
    taskId:state.taskId,
    assignmentId:assignment.id,
    expectedVersions:{[state.taskId]:task.version},
    expectedAssignmentVersion:assignment.version,
    ...extra,
  }));
}

async function bindThread(state,{threadId='fixture-thread',workspace=path.join(state.root,'.process/backend-worktree'),serviceId='fixture-service'}={}) {
  await mkdir(workspace,{recursive:true});
  const loc=await location(state.root);
  await mkdir(path.join(loc.runtime,'server'),{recursive:true});
  await writeFile(path.join(loc.runtime,'server/server.json'),JSON.stringify({serviceId}));
  await updateBinding(state.root,state.run.id,state.assignment.id,b=>{
    b.backendServiceId=serviceId;
    b.backendGeneration='fixture-generation';
    b.nativeThreadId=threadId;
    b.workspace=workspace;
    b.backendCreation={threadId,serviceId,generation:'fixture-generation',createdAt:new Date().toISOString()};
  });
  return {loc,threadId,workspace,serviceId};
}

test('backend ownership binds the assignment to its service receipt, native thread and workspace',async t=>{
  const state=await fixture(t),binding=await bindThread(state);
  const calls=[];
  const client={async call(method,params){
    calls.push({method,params});
    if(method==='thread/read')return {thread:{id:binding.threadId,cwd:pathToFileURL(binding.workspace).href,status:{type:'idle'}}};
    if(method==='thread/loaded/list')return {data:[binding.threadId]};
    throw Error('unexpected fake RPC '+method);
  }};

  const thread=await assertBackendThread(state.root,state.assignment.id,binding.threadId,client);
  assert.equal(thread.id,binding.threadId);
  assert.deepEqual(calls.map(x=>x.method),['thread/read','thread/loaded/list']);

  const wrongWorkspace={call:async method=>{
    if(method==='thread/read')return {thread:{id:binding.threadId,cwd:path.join(state.root,'foreign'),status:{type:'idle'}}};
    throw Error('loaded lookup must not follow a workspace mismatch');
  }};
  await assert.rejects(assertBackendThread(state.root,state.assignment.id,binding.threadId,wrongWorkspace),/BACKEND_WORKSPACE/);

  const unloaded={call:async method=>method==='thread/read'
    ? {thread:{id:binding.threadId,cwd:binding.workspace,status:{type:'notLoaded'}}}
    : {data:[]}};
  await assert.rejects(assertBackendThread(state.root,state.assignment.id,binding.threadId,unloaded),/BACKEND_NOT_LOADED/);
  assert.equal((await assertBackendThread(state.root,state.assignment.id,binding.threadId,unloaded,{allowUnloaded:true})).status.type,'notLoaded');

  await assert.rejects(assertBackendThread(state.root,state.assignment.id,'foreign-thread',client),/BACKEND_OWNERSHIP/);
  assert.equal(calls.length,2,'归属不符时不得查询原生服务');
  await writeFile(path.join(binding.loc.runtime,'server/server.json'),JSON.stringify({serviceId:'foreign-service'}));
  await assert.rejects(assertBackendThread(state.root,state.assignment.id,binding.threadId,client),/BACKEND_OWNERSHIP/);
  assert.equal(calls.length,2,'服务创建回执不符时不得查询原生服务');
});

test('backend dispatch preserves the original request and never recreates an unknown result',async t=>{
  const state=await fixture(t);
  await assignmentChange(state,'assignment:dispatch');
  const original={operationId:'backend-original',prompt:'只执行这一项隔离测试',workspace:path.join(state.root,'.process/backend-worktree'),baseCommit:'a'.repeat(40)};
  const fingerprint=requestFingerprint(original);
  await updateBinding(state.root,state.run.id,state.assignment.id,b=>{
    b.backendRequest={operationId:original.operationId,hash:fingerprint,state:'CREATING',baseCommit:original.baseCommit,prompt:original.prompt};
  });
  const before=(await readLedger(state.root)).sequence;

  const replay=await dispatchBackend(state.root,state.run.id,state.assignment.id,original);
  assert.equal(replay.status,'RESULT_UNKNOWN');
  const reordered={baseCommit:original.baseCommit,workspace:original.workspace,prompt:original.prompt,operationId:original.operationId};
  assert.equal((await dispatchBackend(state.root,state.run.id,state.assignment.id,reordered)).status,'RESULT_UNKNOWN');
  assert.match(replay.reason,/禁止重发/);
  assert.equal((await readLedger(state.root)).sequence,before,'原请求回放不得重复登记 dispatch');

  await assert.rejects(dispatchBackend(state.root,state.run.id,state.assignment.id,{...original,prompt:'已改变的要求'}),/BACKEND_REPLAY/);
  await assert.rejects(dispatchBackend(state.root,state.run.id,state.assignment.id,{...original,operationId:'backend-second'}),/BACKEND_REPLAY/);
  const saved=(await readBindings(await location(state.root))).assignments[state.assignment.id];
  assert.equal(saved.backendRequest.operationId,'backend-original');
  assert.equal(saved.nativeThreadId,undefined);

  await updateBinding(state.root,state.run.id,state.assignment.id,b=>{b.runId='foreign-run';});
  await assert.rejects(dispatchBackend(state.root,state.run.id,state.assignment.id,original),/BACKEND_RUN/);
});

test('native close verifies ownership, resumes only for cleanup, interrupts the original turn and preserves history',async()=>{
  const rejectedCalls=[];
  await assert.rejects(closeNativeThread({call:async(...args)=>rejectedCalls.push(args)},'fixture-thread',null,{verifyOwnership:async()=>{throw Error('fixture ownership rejected');}}),/ownership rejected/);
  assert.deepEqual(rejectedCalls,[],'归属核验失败后不得发出原生 RPC');

  let owned=false,status='notLoaded',loaded=false,terminal=true,goal='active';
  const calls=[];
  const client={async call(method,params={}){
    assert(owned,'任何原生 RPC 前必须先验证派工归属');
    calls.push({method,params});
    if(method==='thread/goal/get')return {goal:{status:goal,objective:'fixture'}};
    if(method==='thread/goal/set'){goal=params.status;return {}};
    if(method==='thread/read')return {thread:{id:'fixture-thread',cwd:'/fixture/worktree',status:{type:status}}};
    if(method==='thread/resume'){assert.equal(status,'notLoaded');status='active';loaded=true;return {thread:{id:'fixture-thread'}};}
    if(method==='turn/interrupt'){assert.equal(params.turnId,'fixture-turn');status='idle';return {}};
    if(method==='thread/backgroundTerminals/list')return {data:terminal?[{processId:'fixture-process'}]:[]};
    if(method==='thread/backgroundTerminals/terminate'){assert.equal(params.processId,'fixture-process');terminal=false;return {}};
    if(method==='thread/loaded/list')return {data:loaded?['fixture-thread']:[]};
    if(method==='thread/archive'){loaded=false;status='notLoaded';return {}};
    throw Error('unexpected fake RPC '+method);
  }};
  const receipt=await closeNativeThread(client,'fixture-thread',null,{
    resumeIfUnloaded:true,
    activeTurnIds:['fixture-turn'],
    verifyOwnership:async()=>{owned=true;},
  });

  assert.equal(receipt.verified,true);
  assert.equal(receipt.nativeThreadId,'fixture-thread');
  assert.equal(receipt.history,'PRESERVED');
  assert.equal(goal,'paused');
  assert.equal(terminal,false);
  for(const method of ['thread/resume','turn/interrupt','thread/backgroundTerminals/terminate','thread/archive'])assert(calls.some(x=>x.method===method),method);
  assert(!calls.some(x=>['thread/delete','thread/start','turn/start'].includes(x.method)));

  const unsafeCalls=[];
  const unsafe={async call(method){
    unsafeCalls.push(method);
    if(method==='thread/goal/get')return {goal:null};
    if(method==='thread/read')return {thread:{id:'unsafe-thread',cwd:'/fixture/worktree',status:{type:'idle'}}};
    if(method==='thread/backgroundTerminals/list')return {data:[{processId:null}]};
    throw Error('unexpected fake RPC '+method);
  }};
  await assert.rejects(closeNativeThread(unsafe,'unsafe-thread',null,{verifyOwnership:async()=>{}}),/后台命令身份未知/);
  assert(!unsafeCalls.includes('thread/archive'),'后台命令身份未知时不得归档并签发关闭回执');
});

test('backend close and recovery reject missing native identity or original creation receipt before touching a service',async t=>{
  const state=await fixture(t);
  await assert.rejects(closeBackend(state.root,state.run.id,state.assignment.id),/BACKEND_THREAD/);
  await updateBinding(state.root,state.run.id,state.assignment.id,b=>{
    b.nativeThreadId='fixture-thread';
    b.backendCreation={threadId:'different-thread',serviceId:'fixture-service',generation:'fixture-generation'};
  });
  await assert.rejects(recoverBackend(state.root,state.run.id,state.assignment.id),/BACKEND_RECOVERY/);
  const loc=await location(state.root);
  await assert.rejects(stat(path.join(loc.runtime,'server')),error=>error.code==='ENOENT');
});

test('closed backend threads cannot be recovered and returned identities must match',async t=>{
 const state=await fixture(t),binding=await bindThread(state);
 await updateBinding(state.root,state.run.id,state.assignment.id,b=>{b.closureReceipt={verified:true};});
 await assert.rejects(recoverBackend(state.root,state.run.id,state.assignment.id),/BACKEND_CLOSED/);
 await assert.rejects(continueBackend(state.root,state.run.id,state.assignment.id,{operationId:'new',prompt:'should not run'}),/BACKEND_FOLLOWUP/);
 await assert.rejects(assertBackendThread(state.root,state.assignment.id,binding.threadId,{call:async()=>({thread:{id:'other',cwd:binding.workspace,status:{type:'idle'}}})}),/BACKEND_THREAD_ID/);
});
test('native close refuses a Goal that acknowledges pause but remains active',async()=>{
 const client={call:async method=>{
  if(method==='thread/goal/get')return {goal:{status:'active'}};
  if(method==='thread/goal/set')return {};
  if(method==='thread/read')return {thread:{id:'t',status:{type:'idle'}}};
  if(method==='thread/backgroundTerminals/list')return {data:[]};
  throw Error('must not archive without verified pause');
 }};
 await assert.rejects(closeNativeThread(client,'t',null,{verifyOwnership:async()=>{}}),/Goal 尚未确认/);
});

test('persisted connection receipts recover lost thread and turn replies without making any RPC',async t=>{
 const state=await fixture(t),binding=await bindThread(state),operationId='fixture-lost-dispatch';
 await updateBinding(state.root,state.run.id,state.assignment.id,b=>{delete b.nativeThreadId;delete b.backendCreation;b.backendRequest={operationId,generation:'fixture-generation',state:'RESULT_UNKNOWN'};});
 const save=async(method,result,extra={})=>{
  const id=decisionHash({assignmentId:state.assignment.id,operationId,method});
  await durableDecisionFile(path.join(binding.loc.runtime,'decision-channel/calls',id+'.json'),{assignmentId:state.assignment.id,operationId,method,state:'SUCCEEDED',serviceId:binding.serviceId,generation:'fixture-generation',params:method==='thread/start'?{cwd:binding.workspace}:{threadId:binding.threadId},result,at:new Date().toISOString(),completedAt:new Date().toISOString(),...extra});
 };
 await save('thread/start',{thread:{id:binding.threadId}},{state:'RESULT_UNKNOWN'});
 await restoreBackendReceipts(state.root,state.run.id,state.assignment.id);assert.equal((await readBindings(binding.loc)).assignments[state.assignment.id].nativeThreadId,undefined);
 await save('thread/start',{thread:{id:binding.threadId}});await save('turn/start',{turn:{id:'original-turn'}});
 await restoreBackendReceipts(state.root,state.run.id,state.assignment.id);
 const b=(await readBindings(binding.loc)).assignments[state.assignment.id];assert.equal(b.nativeThreadId,binding.threadId);assert.equal(b.backendCreation.serviceId,binding.serviceId);assert.equal(b.backendRequest.turnId,'original-turn');
 await updateBinding(state.root,state.run.id,state.assignment.id,b=>{delete b.backendRequest.turnId;});
 await save('turn/start',{turn:{id:'wrong-turn'}},{serviceId:'other-service'});
 await assert.rejects(restoreBackendReceipts(state.root,state.run.id,state.assignment.id),/BACKEND_RECEIPT/);
 assert.equal((await readBindings(binding.loc)).assignments[state.assignment.id].backendRequest.turnId,undefined);
});

// Every RPC reads this fixture's disk state, including after a fresh Node
// process. No native socket, host authentication or model is involved.
async function persistedNativeOptions(file) {
 const {readFile,writeFile}=await import('node:fs/promises');
 const read=async()=>JSON.parse(await readFile(file,'utf8'));
 const client={close(){},async flush(){},async call(method,params){
  const state=await read();state.calls.push({method,params});
  if(['thread/start','turn/start'].includes(method))throw Error('Recovery must never start work');
  let result;
  if(method==='thread/resume'){state.loaded=true;result={thread:{id:state.threadId}};}
  else if(method==='thread/read')result={thread:{id:state.threadId,cwd:state.workspace,status:{type:!state.loaded?'notLoaded':state.turn.status==='inProgress'?'active':'idle'}}};
  else if(method==='thread/loaded/list')result={data:state.loaded?[state.threadId]:[]};
  else if(method==='thread/turns/list')result={data:[state.turn]};
  else throw Error('Unexpected fixture RPC '+method);
  await writeFile(file,JSON.stringify(state));return result;
 }};
 return {ensureServer:async()=>{},ensureChannel:async()=>{},verifyServer:async()=>({record:(await read()).service,client})};
}

test('recovery tracks the original running turn and recollects completion from disk in a fresh process',async t=>{
 const s=await fixture(t),binding=await bindThread(s),operationId='original-durable-work';
 await updateBinding(s.root,s.run.id,s.assignment.id,b=>{b.backendRequest={operationId,turnId:'original-turn',generation:'fixture-generation',state:'RUNNING'};});
 const file=path.join(s.root,'isolated-native.json'),final={summary:'completed once',artifacts:[],acceptance:[{criterion:0,evidence:'fixture effect counter = 1'}],completedSteps:['original work'],nextSteps:[]};
 await writeFile(file,JSON.stringify({service:{serviceId:binding.serviceId,generation:'replacement-generation'},threadId:binding.threadId,workspace:binding.workspace,loaded:true,turn:{id:'original-turn',status:'inProgress',items:[]},effectCount:1,calls:[]}));
 const options=await persistedNativeOptions(file);
 assert.equal((await recoverBackend(s.root,s.run.id,s.assignment.id,options)).status,'RUNNING');
 assert.equal((await recoverBackend(s.root,s.run.id,s.assignment.id,options)).status,'RUNNING');
 let saved=(await readBindings(binding.loc)).assignments[s.assignment.id];
 assert.equal(saved.recoveryHistory.length,1);assert.equal(saved.recoveryHistory[0].operationId,operationId);
 assert.equal(saved.recoveryHistory[0].previousGeneration,'fixture-generation');
 // Actual operation completion is persisted by the fake native service;
 // the coordinator has no result receipt and its old connection is unloaded.
 const native=JSON.parse(await readFile(file,'utf8'));native.loaded=false;native.turn.status='completed';native.turn.items=[{type:'agentMessage',text:JSON.stringify(final)}];await writeFile(file,JSON.stringify(native));
 await assert.rejects(readFile(path.join(binding.loc.runtime,'backend-results',s.assignment.id+'.json')),e=>e.code==='ENOENT');
 const module=new URL('../tools/task-backend.mjs',import.meta.url).href;
 const code=`import {readFileSync} from 'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));const {recoverBackend}=await import(x.module);const options=await (${persistedNativeOptions.toString()})(x.file);console.log(JSON.stringify(await recoverBackend(x.root,x.runId,x.assignmentId,options)));`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:s.root,encoding:'utf8',input:JSON.stringify({file,module,root:s.root,runId:s.run.id,assignmentId:s.assignment.id})}));
 assert.equal(result.status,'SUCCEEDED');assert.equal(result.resultReady,true);
 const recovered=JSON.parse(await readFile(path.join(binding.loc.runtime,'backend-results',s.assignment.id+'.json'),'utf8'));
 assert.equal(recovered.operationId,operationId);assert.equal(recovered.turnId,'original-turn');assert.deepEqual(recovered.result,final);
 const historical=path.join(binding.loc.runtime,'backend-results/operations',requestFingerprint({assignmentId:s.assignment.id,operationId})+'.json');
 assert.equal(JSON.parse(await readFile(historical,'utf8')).operationId,operationId);
 assert.equal((await recoverBackend(s.root,s.run.id,s.assignment.id,options)).status,'SUCCEEDED');
 const after=JSON.parse(await readFile(file,'utf8'));assert.equal(after.effectCount,1);assert(!after.calls.some(c=>['thread/start','turn/start'].includes(c.method)));
 assert(after.calls.filter(c=>c.method==='thread/resume').every(c=>c.params.threadId===binding.threadId));
});

test('all unresolved creation windows retain their original operation and never infer a turn from history',async t=>{
 const s=await fixture(t),binding=await bindThread(s),request={operationId:'uncertain-original',prompt:'original input',workspace:binding.workspace,baseCommit:'a'.repeat(40)};
 const file=path.join(s.root,'isolated-native.json');
 await writeFile(file,JSON.stringify({service:{serviceId:binding.serviceId,generation:'fixture-generation'},threadId:binding.threadId,workspace:binding.workspace,loaded:true,turn:{id:'unproven-visible-turn',status:'completed',items:[]},effectCount:1,calls:[]}));
 const options=await persistedNativeOptions(file);
 for(const state of ['CREATING','PENDING','RESULT_UNKNOWN']){
  await updateBinding(s.root,s.run.id,s.assignment.id,b=>{b.backendRequest={...request,hash:requestFingerprint(request),state,generation:'fixture-generation'};});
  assert.equal((await syncBackend(s.root,s.run.id,s.assignment.id,options)).status,'RESULT_UNKNOWN');
  const saved=(await readBindings(binding.loc)).assignments[s.assignment.id];
  assert.equal(saved.backendRequest.operationId,request.operationId);assert.equal(saved.backendRequest.turnId,undefined);
  await assert.rejects(dispatchBackend(s.root,s.run.id,s.assignment.id,{...request,operationId:'replacement-id'}),/BACKEND_REPLAY/);
 }
 assert.equal(JSON.parse(await readFile(file,'utf8')).effectCount,1);
});

test('result collection uses original operation CAS and cannot accept a concurrently replaced or unresolved turn',async t=>{
 const s=await fixture(t);await assignmentChange(s,'assignment:dispatch');const b=await bindThread(s);
 await writeFile(path.join(b.workspace,'.git'),'fixture worktree identity');
 await assignmentChange(s,'assignment:start',{nativeThreadId:b.threadId,workspace:b.workspace,workspaceEvidence:'isolated fixture'});
 const extra={expectedBackendOperationId:'completed-original',checkpoint:{summary:'original completion',operations:[{id:'completed-original',kind:'FIXTURE',status:'SUCCEEDED',evidence:'read original turn'}]},result:{summary:'collected',artifacts:[],acceptance:[{criterion:0,evidence:'original result'}]}};
 await updateBinding(s.root,s.run.id,s.assignment.id,b=>{b.backendRequest={operationId:'concurrent-followup',state:'RUNNING'};});
 await assert.rejects(assignmentChange(s,'assignment:result',extra),/BACKEND_OPERATION_CHANGED/);
 await updateBinding(s.root,s.run.id,s.assignment.id,b=>{b.backendRequest={operationId:'completed-original',state:'RESULT_UNKNOWN'};});
 await assert.rejects(assignmentChange(s,'assignment:result',extra),/BACKEND_OPERATION_CHANGED/);
 await updateBinding(s.root,s.run.id,s.assignment.id,b=>{b.backendRequest.state='SUCCEEDED';});
 await assignmentChange(s,'assignment:result',extra);
 assert.equal((await readLedger(s.root)).tasks[s.taskId].assignments[0].status,'DELIVERED');
});


test('tracking running work refreshes overlap evidence after dispatch initially observes an idle peer',async t=>{
 const s=await fixture(t),current=(await readLedger(s.root)).tasks[s.taskId];
 const scheduled=await mutate(s.root,'schedule',request({runId:s.run.id,expectedVersions:{[s.taskId]:current.version},assignments:[{taskId:s.taskId,key:'peer',goal:'independent overlap fixture',deliverables:['evidence'],acceptanceCriteria:['overlap'],resources:[{kind:'FILE',key:'core/tests/independent-peer.mjs',access:'WRITE'}],execution:{rationale:'independent fixture'}}]}));
 const peer={...s,assignment:scheduled.assignments[0]},states=[s,peer],threads={};
 for(const [i,state]of states.entries()){
  await assignmentChange(state,'assignment:dispatch');
  const binding=await bindThread(state,{threadId:'overlap-thread-'+i,workspace:path.join(s.root,'.process','peer-'+i)});
  await writeFile(path.join(binding.workspace,'.git'),'isolated worktree identity');
  await assignmentChange(state,'assignment:start',{nativeThreadId:binding.threadId,workspace:binding.workspace,workspaceEvidence:'isolated fixture'});
  await updateBinding(s.root,s.run.id,state.assignment.id,b=>{b.backendRequest={operationId:'overlap-operation-'+i,turnId:'overlap-turn-'+i,generation:'fixture-generation',state:'RUNNING'};});
  threads[binding.threadId]={id:binding.threadId,cwd:binding.workspace,active:i===0,turnId:'overlap-turn-'+i};
 }
 const loc=await location(s.root),sampleFile=path.join(loc.runtime,'parallel-validation-sample.json');
 const old={checkedAt:'2020-01-01T00:00:00.000Z',serviceId:'fixture-service',results:[{assignmentId:'old-unaccepted'}]};await writeFile(sampleFile,JSON.stringify(old));
 const calls=[],client={close(){},async flush(){},async call(method,params){calls.push(method);const thread=threads[params.threadId];if(method==='thread/read')return {thread:{id:thread.id,cwd:thread.cwd,status:{type:thread.active?'active':'idle'}}};if(method==='thread/turns/list')return {data:[{id:thread.turnId,status:'inProgress',items:[]}]};if(method==='thread/loaded/list')return {data:Object.keys(threads)};throw Error('Unexpected RPC '+method);}};
 const options={verifyServer:async()=>({record:{serviceId:'fixture-service',generation:'fixture-generation'},client})};
 assert.equal((await syncBackend(s.root,s.run.id,s.assignment.id,options)).status,'RUNNING');assert.deepEqual(JSON.parse(await readFile(sampleFile,'utf8')),old);
 threads['overlap-thread-1'].active=true;
 assert.equal((await syncBackend(s.root,s.run.id,s.assignment.id,options)).status,'RUNNING');const sample=JSON.parse(await readFile(sampleFile,'utf8'));
 assert.deepEqual(sample.results.map(r=>r.assignmentId).sort(),states.map(x=>x.assignment.id).sort());assert.deepEqual(sample.results.map(r=>r.turnId).sort(),['overlap-turn-0','overlap-turn-1']);assert.notEqual(sample.checkedAt,old.checkedAt);assert(!calls.some(method=>['thread/start','turn/start'].includes(method)));
});
