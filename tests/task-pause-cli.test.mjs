import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {mutate,startRun,readLedger,location,readBindings,updateBinding,runtimeState,activity} from '../tools/task-ledger.mjs';
import {requestPause,savePauseCheckpoint,verifyPause,resumePausedRun} from '../tools/task-pause.mjs';
import {pauseBackend,syncBackend,continueBackend,recoverBackend} from '../tools/task-backend.mjs';
import {readPause,readPauseFile,pauseHash} from '../tools/task-pause-state.mjs';
import {durableExecutionFile} from '../tools/execution-runtime.mjs';
import {processAlive,phaseRecords,beginPhase,formalAdmission} from '../tools/process-resources.mjs';
import {startProcessPhase} from '../tools/process.mjs';
import {persistDecisionMessage,drainDecisionInbox,decisionSnapshot,decisionVersions} from '../tools/task-decisions.mjs';

const cli=fileURLToPath(new URL('../tools/tasks.mjs',import.meta.url));
const processCli=fileURLToPath(new URL('../tools/process.mjs',import.meta.url));
const req=x=>({operationId:randomUUID(),actor:'PAUSE_FIXTURE',...x});
const spec={clarified:true,type:'SYSTEM',title:'隔离暂停验证',originalRequest:'仅 fake RPC 与临时进程',goal:'从安全 checkpoint 续办',scope:['fixture'],deliverables:['artifact'],acceptanceCriteria:['可恢复'],authorization:'隔离受控测试，不调用真实模型',discussion:{approved:true,summary:'fixture',feasibility:'fixture',approvedRequirements:['fixture']}};
const caps={delegation:true,closeVerified:true,availableSlots:3,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};
const cp=(operations=[])=>({summary:'已保存第一步',completedSteps:['第一步只执行一次'],nextSteps:['执行第二步'],inputs:['fixture input exact revision 1'],artifacts:['artifact.txt'],operations});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<120;i++){const result=await fn();if(result)return result;await wait(50);}throw Error('fixture wait timed out');}
async function fixture(t){
  assert(process.env.REVIEW_TASK_DIR,'测试须经受管 process');
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'pause-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});const id=randomUUID();
  await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id}));
  await writeFile(path.join(root,'instance/runtime/process-policy.json'),JSON.stringify({schemaVersion:'1.0',enabled:true,projectId:id,host:'fixture',maxTemporaryBytes:64*1024**3,reserveBytes:0,registry:'.process/receipts',workspace:'.process/stages',parentTasks:'.process/tasks',temporaryRoots:['.process/shared'],protectedPaths:['instance'],dockerBinary:'/usr/bin/true'}));
  const taskId=(await mutate(root,'publish',req({task:spec}))).taskId;
  await writeFile(path.join(root,'artifact.txt'),'first-step-result');
  return {root,taskId,loc:await location(root)};
}
async function change(f,action,assignmentId,extra={}){
  const task=(await readLedger(f.root)).tasks[f.taskId],a=task.assignments?.find(a=>a.id===assignmentId);
  return mutate(f.root,action,req({runId:f.run.id,taskId:f.taskId,assignmentId,expectedVersions:{[task.id]:task.version},expectedAssignmentVersion:a?.version,...extra}));
}
async function save(f,p,assignmentId,checkpoint=cp()){
  const task=(await readLedger(f.root)).tasks[f.taskId],a=task.assignments?.find(a=>a.id===assignmentId);
  const input=req({pauseId:p.id,taskId:f.taskId,assignmentId,expectedVersions:{[task.id]:task.version},expectedAssignmentVersion:a?.version,quiescent:true,evidence:'fixture coordinator explicitly saved its safe boundary',checkpoint,workspace:{path:f.root,files:['artifact.txt']}});
  const result=await savePauseCheckpoint(f.root,f.run.id,input);
  if(!assignmentId&&f.mainAssignmentId)await save(f,p,f.mainAssignmentId,checkpoint);
  return result;
}
async function mainWorker(f){
  const task=(await readLedger(f.root)).tasks[f.taskId];
  const a=(await mutate(f.root,'schedule',req({runId:f.run.id,expectedVersions:{[task.id]:task.version},assignments:[{taskId:task.id,key:'main-worker',goal:'fixture',deliverables:['artifact'],acceptanceCriteria:['fixture'],resources:[{kind:'UNKNOWN',key:'*',access:'WRITE'}],execution:{mode:'MAIN',rationale:'v3 Main 执行节点夹具'}}]}))).assignments[0];
  await change(f,'assignment:start',a.id,{workspaceEvidence:'隔离受管工作区'});f.mainAssignmentId=a.id;return a;
}
async function deadRun(f){
  const run=JSON.parse(await readFile(path.join(f.loc.runtime,'run.json')));
  // Controlled coordinator exit fixture; this does not kill a real Agent.
  run.owner={...run.owner,pid:99999999,birth:'fixture exited'};
  await durableExecutionFile(path.join(f.loc.runtime,'run.json'),run);
  await durableExecutionFile(path.join(f.loc.runtime,'runs',run.id+'.json'),run);
}
async function worker(f,key='worker'){
  const task=(await readLedger(f.root)).tasks[f.taskId];
  const parent=task.assignments?.find(a=>a.status!=='CLOSED'),binding=parent?(await readBindings(f.loc)).assignments[parent.id]:null;
  const a=(await mutate(f.root,parent?'assignment:schedule':'schedule',req({runId:f.run.id,taskId:task.id,...(parent?{parentAssignmentId:parent.id,authority:{assignmentId:parent.id,executionToken:binding.executionAuthority.token}}:{}),expectedVersions:{[task.id]:task.version},assignments:[{taskId:task.id,key,goal:'fixture',deliverables:['artifact'],acceptanceCriteria:['fixture'],resources:[{kind:'OBJECT',key:'shared-read-input',access:'READ',version:'1'}],execution:{rationale:'fixture'}}]}))).assignments[0];
  await change(f,'assignment:dispatch',a.id);
  await change(f,'assignment:start',a.id,{nativeThreadId:'thread-'+key,workspaceEvidence:'fixture object read'});
  const serviceId='fixture-service',generation='fixture-generation',turnId='turn-'+key;
  await mkdir(path.join(f.loc.runtime,'server'),{recursive:true});await writeFile(path.join(f.loc.runtime,'server/server.json'),JSON.stringify({serviceId,generation}));
  await updateBinding(f.root,f.run.id,a.id,b=>Object.assign(b,{workspace:f.root,backendServiceId:serviceId,backendGeneration:generation,backendCreation:{threadId:b.nativeThreadId,serviceId,generation},backendRequest:{operationId:'original-'+key,turnId,generation,state:'RUNNING',prompt:'original exact input'}}));
  const state={loaded:true,status:'active',turns:[{id:turnId,status:'inProgress',items:[]}],terminals:[{processId:'background-'+key}],goal:'active',lost:null,calls:[]};
  const client={close(){},async flush(){},async call(method,params){
    state.calls.push({method,params});let result;
    if(state.lostBefore===method){state.lostBefore=null;throw Error('fixture original send outcome unknown');}
    if(method==='thread/read')result={thread:{id:'thread-'+key,cwd:f.root,status:{type:state.loaded?state.status:'notLoaded'},turns:state.turns}};
    else if(method==='thread/loaded/list')result={data:state.loaded?['thread-'+key]:[]};
    else if(method==='thread/turns/list')result={data:state.turns};
    else if(method==='thread/goal/get')result={goal:{status:state.goal}};
    else if(method==='thread/goal/set'){state.goal=params.status;result={};}
    else if(method==='turn/interrupt'){state.status='idle';state.turns.find(t=>t.id===params.turnId).status='interrupted';result={};}
    else if(method==='thread/backgroundTerminals/list')result={data:state.terminals};
    else if(method==='thread/backgroundTerminals/terminate'){state.terminals=state.terminals.filter(t=>t.processId!==params.processId);result={};}
    else if(method==='thread/archive'){state.loaded=false;result={};}
    else if(method==='thread/resume'){state.loaded=true;state.status='idle';result={thread:{id:'thread-'+key}};}
    else if(method==='turn/start'){state.status='active';const turn={id:'continued-'+key,status:'inProgress',items:[]};state.turns.push(turn);result={turn};}
    else throw Error('unexpected fake RPC '+method);
    if(state.lost===method){state.lost=null;throw Error('fixture lost reply after original effect');}
    return result;
  }};
  const options={verifyServer:async()=>({record:{serviceId,generation},client}),verifyObserver:async()=>{throw Error('fixture has no parallel observer');}};
  return {id:a.id,key,state,options,service:{serviceId,generation},turnId,threadId:'thread-'+key};
}
const adapters=(f,workers)=>({pauseAgent:(root,runId,id,pauseId)=>pauseBackend(root,runId,id,pauseId,workers.find(w=>w.id===id).options),syncAgent:(root,runId,id)=>syncBackend(root,runId,id,workers.find(w=>w.id===id).options)});

test('pause fences scheduling and phases immediately, missing checkpoints cannot stop workers or report PAUSED',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root,{capabilities:caps});const w=await worker(f);
  const p=await requestPause(f.root,f.run.id),again=await requestPause(f.root,f.run.id);
  assert.equal(p.id,again.id);assert(again.replayed);
  const result=await verifyPause(f.root,f.run.id,adapters(f,[w]));assert.equal(result.status,'PAUSING');assert.equal(w.state.calls.length,0);
  await assert.rejects(mutate(f.root,'next',req({runId:f.run.id})),/PAUSE_EXECUTION_BLOCKED/);
  await assert.rejects(startProcessPhase(f.root,f.taskId,'forbidden'),/PAUSE_EXECUTION_BLOCKED/);
  await assert.rejects(beginPhase(f.root,f.taskId,'direct-forbidden'),/PAUSE_EXECUTION_BLOCKED/);
  await assert.rejects(activity(f.root,f.run.id,{},null,w.id,f.taskId,()=>{throw Error('must never spawn');}),/PAUSE_EXECUTION_BLOCKED/);
  await assert.rejects(continueBackend(f.root,f.run.id,w.id,{operationId:'forbidden',prompt:'no'},w.options),/PAUSE_EXECUTION_BLOCKED/);
  assert.equal((await readLedger(f.root)).tasks[f.taskId].assignments[0].status,'RUNNING');
});

test('direct phases retain recovery input and convergence never admits new work after pause',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root);await mainWorker(f);
  // Both direct and parent-task entry points work before pause; their nested
  // admissions must not deadlock on the same ledger lock.
  const direct=await beginPhase(f.root,f.taskId,'direct'),nested=await startProcessPhase(f.root,f.taskId,'nested');
  assert.equal((await direct.read()).formalTaskId,f.taskId);
  const file=path.join((await direct.environment()).REVIEW_TASK_DIR,'saved.txt');await writeFile(file,'recover this');
  const p=await requestPause(f.root,f.run.id);
  let launched=false;
  await assert.rejects(direct.startChild(()=>{launched=true;throw Error('unexpected launch');}),/PAUSE_EXECUTION_BLOCKED/);
  assert.equal(launched,false);
  await assert.rejects(formalAdmission(f.root,f.taskId,()=>beginPhase(f.root,f.taskId,'nested-forbidden'),{converging:true}),/PAUSE_EXECUTION_BLOCKED/);
  const finished=await direct.finish({outcome:'CANCELLED'});await nested.finish({outcome:'CANCELLED'});
  assert.equal(finished.pauseRetention.pauseId,p.id);assert.equal(finished.status,'CLEANED');
  assert.equal(await readFile(file,'utf8'),'recover this');
});

test('child launch is registered before concurrent pause acquires admission',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root);await mainWorker(f);
  const phase=await beginPhase(f.root,f.taskId,'launch');
  let enter,release,child,closed;
  const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;});
  const starting=phase.startChild(async()=>{
    enter();await gate;
    child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    closed=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
    return child;
  });
  try{
    await entered;const pausing=requestPause(f.root,f.run.id);release();await starting;await pausing;
    assert.equal((await phase.read()).child.pid,child.pid);
    await assert.rejects(phase.startChild(()=>{throw Error('must not launch');}),/PAUSE_EXECUTION_BLOCKED/);
  }finally{
    release();await starting;
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    if(closed)await closed;
    await phase.childEnded();await phase.finish({outcome:'CANCELLED'});
  }
});

test('a WORKER and descendant pause at saved checkpoints; lost interrupt/archive replies are observed and never resent',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root,{capabilities:caps});const workers=[await worker(f,'one'),await worker(f,'two')],a=adapters(f,workers);
  const p=await requestPause(f.root,f.run.id);await save(f,p);for(const w of workers)await save(f,p,w.id);
  workers[0].state.lost='turn/interrupt';workers[1].state.lost='thread/archive';
  assert.equal((await verifyPause(f.root,f.run.id,a)).status,'PAUSE_UNVERIFIED');
  const stopped=await verifyPause(f.root,f.run.id,a);assert.equal(stopped.status,'PAUSED',JSON.stringify(stopped.issues));
  for(const w of workers){assert.equal(w.state.loaded,false);assert.deepEqual(w.state.terminals,[]);assert.equal(w.state.goal,'paused');assert.equal(w.state.calls.filter(c=>c.method==='turn/interrupt').length,1);assert.equal(w.state.calls.filter(c=>c.method==='thread/archive').length,1);}
  const calls=workers.map(w=>w.state.calls.length);await requestPause(f.root,f.run.id);await verifyPause(f.root,f.run.id,a);workers.forEach((w,i)=>assert(w.state.calls.slice(calls[i]).every(c=>c.method==='thread/read')));
  const snapshot=await readPauseFile(path.join(f.loc.runtime,'pauses',p.id,'checkpoint.json'));assert.equal(pauseHash(snapshot),stopped.snapshot.hash);
  assert(snapshot.tasks[0].assignments.every(x=>x.status!=='CLOSED'));assert(Object.values(snapshot.bindings.assignments).every(b=>b.pauseReceipt.verified&&!b.closureReceipt));
  assert.equal(await readFile(path.join(f.root,'artifact.txt'),'utf8'),'first-step-result');
  await assert.rejects(startRun(f.root),/PAUSE_OLD_RUN_ALIVE/);
  await deadRun(f);f.run=await startRun(f.root,{capabilities:caps});
  const resumed=await resumePausedRun(f.root,f.run.id,a);assert.equal(resumed.status,'CHECKPOINT_READY');assert.equal(resumed.checkpoints[0].checkpoint.completedSteps[0],'第一步只执行一次');
  for(const w of workers)assert.equal(w.state.calls.filter(c=>['thread/start','turn/start'].includes(c.method)).length,0);
  const original=(await readBindings(f.loc)).assignments[workers[0].id].backendRequest.operationId;
  const continued=await continueBackend(f.root,f.run.id,workers[0].id,{operationId:'continue-from-checkpoint'},workers[0].options);assert.equal(continued.status,'RUNNING');
  const b=(await readBindings(f.loc)).assignments[workers[0].id];assert.equal(b.backendHistory[0].operationId,original);assert.match(b.backendRequest.prompt,/第一步只执行一次/);assert.equal(b.nativeThreadId,workers[0].threadId);
  await continueBackend(f.root,f.run.id,workers[0].id,{operationId:'continue-from-checkpoint'},workers[0].options);assert.equal(workers[0].state.calls.filter(c=>c.method==='turn/start').length,1);
});

test('unknown original operations retain reservations and interrupted pause resumes only convergence; checkpoint cannot lose results',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root);await mainWorker(f);
  const p=await requestPause(f.root,f.run.id);await save(f,p,undefined,cp([{id:'original-side-effect',kind:'EXTERNAL',status:'RESULT_UNKNOWN'}]));
  let paused=await verifyPause(f.root,f.run.id);assert.equal(paused.status,'PAUSE_UNVERIFIED');assert(paused.issues.some(i=>i.code==='OPERATION_UNVERIFIED'));
  await deadRun(f);f.run=await startRun(f.root);assert.equal((await resumePausedRun(f.root,f.run.id)).status,'PAUSE_UNVERIFIED');
  await assert.rejects(save(f,p,undefined,{...cp(),completedSteps:[],operations:[{id:'original-side-effect',kind:'EXTERNAL',status:'FAILED',evidence:'fixture queried original operation'}]}),/PAUSE_CHECKPOINT_LOSS/);
  await save(f,p,undefined,cp([{id:'original-side-effect',kind:'EXTERNAL',status:'FAILED',evidence:'fixture queried original operation, no result'}]));
  paused=await verifyPause(f.root,f.run.id);assert.equal(paused.status,'PAUSED',JSON.stringify(paused.issues));
  await writeFile(path.join(f.root,'artifact.txt'),'drift');await deadRun(f);f.run=await startRun(f.root);
  await assert.rejects(resumePausedRun(f.root,f.run.id),/PAUSE_WORKSPACE_DRIFT/);
  await assert.rejects(startProcessPhase(f.root,f.taskId,'still-forbidden'),/PAUSE_EXECUTION_BLOCKED/);
});

test('pending decisions and explicit saved answers survive pause and a new run without answering, redelivery or new turns',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root,{capabilities:caps});const w=await worker(f),a=adapters(f,[w]);
  for(let i=0;i<2;i++){
    await persistDecisionMessage(f.root,w.service,'fixture-connection',{id:i,method:'item/tool/call',params:{threadId:w.threadId,turnId:w.turnId,callId:'item-'+i,tool:'review_task_decision',arguments:{key:'question-'+i,question:'fixture question '+i,context:'fake decision only',options:[{label:'yes',description:'marker only'},{label:'no',description:'marker only'}],recommendation:'either',pendingWork:['record explicit marker'],completedSteps:['prepared']}}});
  }
  await drainDecisionInbox(f.root);const decisions=(await readLedger(f.root)).tasks[f.taskId].assignments[0].decisions;assert.equal(decisions.length,2);
  const changeDecision=async(action,extra)=>{const s=await decisionSnapshot(f.root,decisions[0].id);return mutate(f.root,'decision:'+action,req({runId:f.run.id,...decisionVersions(s),...extra}));};
  await changeDecision('present',{evidence:'controlled fixture presentation'});
  await changeDecision('answer',{actor:'USER',explicitUserAnswer:true,evidence:'controlled fixture explicit yes',answer:{text:'yes'}});
  const before=(await readLedger(f.root)).tasks[f.taskId].assignments[0].decisions;
  const p=await requestPause(f.root,f.run.id);await save(f,p);await save(f,p,w.id);assert.equal((await verifyPause(f.root,f.run.id,a)).status,'PAUSED');
  await deadRun(f);f.run=await startRun(f.root,{capabilities:caps});await resumePausedRun(f.root,f.run.id,a);
  const after=(await readLedger(f.root)).tasks[f.taskId].assignments[0].decisions;assert.deepEqual(after,before);
  await assert.rejects(continueBackend(f.root,f.run.id,w.id,{operationId:'not-authorized'},w.options),/DECISION_PENDING/);
  assert.equal(w.state.calls.filter(c=>c.method==='turn/start').length,0);assert(after[0].answer);assert.equal(after[1].answer,null);
  // Later explicit fixture answer, after the original interrupted callback was
  // cleared. Continuation may carry these business answers, never an approval.
  await persistDecisionMessage(f.root,w.service,'fixture-connection',{method:'turn/completed',params:{threadId:w.threadId,turn:{id:w.turnId,status:'interrupted',items:[]}}});await drainDecisionInbox(f.root);
  let s=await decisionSnapshot(f.root,decisions[1].id);
  await mutate(f.root,'decision:present',req({runId:f.run.id,...decisionVersions(s),evidence:'fixture second question presented'}));
  s=await decisionSnapshot(f.root,decisions[1].id);
  await mutate(f.root,'decision:answer',req({runId:f.run.id,...decisionVersions(s),actor:'USER',explicitUserAnswer:true,evidence:'fixture second explicit no',answer:{text:'no'}}));
  assert.equal((await continueBackend(f.root,f.run.id,w.id,{operationId:'after-actual-answers'},w.options)).status,'RUNNING');
  const done=(await readLedger(f.root)).tasks[f.taskId].assignments[0].decisions;assert(done.every(d=>d.status==='RESOLVED'));assert.equal(done[0].answer.value.text,'yes');assert.equal(done[1].answer.value.text,'no');
  await continueBackend(f.root,f.run.id,w.id,{operationId:'after-actual-answers'},w.options);assert.equal(w.state.calls.filter(c=>c.method==='turn/start').length,1);
});

test('PENDING interrupt intent and an unobserved creation keep original ownership and never repeat effects',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root,{capabilities:caps});const w=await worker(f),a=adapters(f,[w]),p=await requestPause(f.root,f.run.id);
  await save(f,p);await save(f,p,w.id);w.state.lostBefore='turn/interrupt';
  assert.equal((await verifyPause(f.root,f.run.id,a)).status,'PAUSE_UNVERIFIED');
  assert.equal((await verifyPause(f.root,f.run.id,a)).status,'PAUSE_UNVERIFIED');
  assert.equal(w.state.calls.filter(c=>c.method==='turn/interrupt').length,1);assert.equal(w.state.status,'active');
  assert(!(await readBindings(f.loc)).assignments[w.id].pauseReceipt);
  // A later original turn observation permits convergence without resending.
  w.state.status='idle';w.state.turns[0].status='interrupted';assert.equal((await verifyPause(f.root,f.run.id,a)).status,'PAUSED');
  const g=await fixture(t);g.run=await startRun(g.root,{capabilities:caps});const x=await worker(g,'creation');
  await updateBinding(g.root,g.run.id,x.id,b=>{delete b.nativeThreadId;delete b.backendCreation;delete b.backendRequest.turnId;b.backendRequest.state='PENDING';});
  const q=await requestPause(g.root,g.run.id);await save(g,q);await save(g,q,x.id);
  const unknown=await verifyPause(g.root,g.run.id,adapters(g,[x]));assert.equal(unknown.status,'PAUSE_UNVERIFIED');assert.equal(x.state.calls.length,0);
  assert.equal((await readBindings(g.loc)).assignments[x.id].backendRequest.operationId,'original-creation');
});

test('reserved work can checkpoint without claiming execution; a formal closure cannot become a recoverable pause',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root,{capabilities:caps});
  const task=(await readLedger(f.root)).tasks[f.taskId];
  const id=(await mutate(f.root,'schedule',req({runId:f.run.id,expectedVersions:{[task.id]:task.version},assignments:[{taskId:task.id,key:'reserved',goal:'not started',deliverables:['artifact'],acceptanceCriteria:['pass'],resources:[{kind:'OBJECT',key:'reserved',access:'READ',version:'1'}],execution:{rationale:'fixture'}}]}))).assignments[0].id;
  const p=await requestPause(f.root,f.run.id);await save(f,p);await save(f,p,id);
  assert.equal((await verifyPause(f.root,f.run.id)).status,'PAUSED');assert((await readBindings(f.loc)).assignments[id].pauseReceipt.notCreated);
  const g=await fixture(t);g.run=await startRun(g.root,{capabilities:caps});const w=await worker(g,'closed');w.state.loaded=false;
  await updateBinding(g.root,g.run.id,w.id,b=>{b.closureReceipt={verified:true,nativeThreadId:w.threadId,history:'PRESERVED'};});
  await assert.rejects(recoverBackend(g.root,g.run.id,w.id,{ensureServer:async()=>{throw Error('must not load');},ensureChannel:async()=>{},verifyServer:w.options.verifyServer}),/BACKEND_CLOSED/);
  const q=await requestPause(g.root,g.run.id);await save(g,q);await save(g,q,w.id);await pauseBackend(g.root,g.run.id,w.id,q.id,w.options);
  const b=(await readBindings(g.loc)).assignments[w.id];assert(b.closureReceipt);assert.equal(b.pauseReceipt.recoverable,false);assert(!w.state.calls.some(c=>c.method==='thread/resume'));
});

test('a result completed during pause supersedes stale next steps without repeating completed work',async t=>{
  const f=await fixture(t);f.run=await startRun(f.root,{capabilities:caps});const w=await worker(f),a=adapters(f,[w]);
  const p=await requestPause(f.root,f.run.id);await save(f,p);await save(f,p,w.id);
  const result={summary:'both steps finished once',completedSteps:['第一步只执行一次','第二步已完成'],nextSteps:[],artifacts:['artifact.txt'],acceptance:[{criterion:0,evidence:'controlled final result'}]};
  w.state.status='idle';w.state.turns[0]={id:w.turnId,status:'completed',items:[{type:'agentMessage',text:JSON.stringify(result)}]};
  assert.equal((await verifyPause(f.root,f.run.id,a)).status,'PAUSED');await deadRun(f);f.run=await startRun(f.root,{capabilities:caps});
  const resumed=await resumePausedRun(f.root,f.run.id,a),plan=resumed.checkpoints.find(c=>c.assignmentId===w.id);
  assert(plan.resultReady);assert.deepEqual(plan.checkpoint.nextSteps,[]);assert(plan.checkpoint.completedSteps.includes('第二步已完成'));
  await assert.rejects(continueBackend(f.root,f.run.id,w.id,{operationId:'must-not-repeat'},w.options),/PAUSE_RESULT_READY/);
  assert(!w.state.calls.some(c=>c.method==='turn/start'));
});

function launch(t,args){
  const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,output}));});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await done;}});
  return {child,done,get output(){return output;}};
}
async function keeper(t,f){
  const k=launch(t,[cli,'run','--project',f.root]);
  await until(()=>k.output.includes('EXECUTOR_READY'));
  const ready=k.output.split('\n').map(s=>{try{return JSON.parse(s);}catch{return null;}}).find(x=>x?.status==='EXECUTOR_READY');
  f.run={id:ready.runId};return k;
}

test('real CLI main command and its background process stop before PAUSED; same/new CLI sessions discover checkpoint without rerunning',async t=>{
  const f=await fixture(t),k=await keeper(t,f);await mainWorker(f);
  const command=launch(t,[cli,'guard','--project',f.root,'--run',f.run.id,'--task',f.taskId,'--assignment',f.mainAssignmentId,'--',process.execPath,processCli,'run','--root',f.root,'--task',f.taskId,'--phase','main-command','--',process.execPath,'-e',"const {spawn}=require('node:child_process'); const fs=require('node:fs');fs.writeFileSync(process.env.REVIEW_TASK_DIR+'/saved-result.txt','kept');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('command-started');setInterval(()=>{},1000)"]);
  await until(()=>command.output.includes('command-started'));
  const originalChild=await until(async()=>{const phases=await phaseRecords(f.root,f.taskId);return phases[0]?.record.child;});
  const pauseCommand=launch(t,[cli,'pause','--project',f.root,'--run',f.run.id]);const first=await pauseCommand.done;assert.equal(first.code,0,first.output);assert.match(first.output,/PAUSING/);assert(processAlive(originalChild));
  const p=await readPause(f.loc);await save(f,p);
  let final;
  await until(async()=>{final=await verifyPause(f.root,f.run.id);return final.status==='PAUSED';});
  assert.notEqual((await command.done).code,0,'暂停保留中断命令的真实非成功退出码');
  assert.equal((await k.done).code,0);assert(!processAlive(originalChild));
  const repeated=await launch(t,[cli,'pause','--project',f.root,'--run',f.run.id]).done;assert.equal(repeated.code,0,repeated.output);assert.match(repeated.output,/PAUSED/);assert.match(repeated.output,/replayed/);
  const after=await phaseRecords(f.root,f.taskId),scratch=after[0].record.resources[0];assert.equal(scratch.state,'RETAINED');assert.equal(await readFile(path.join(scratch.path,'saved-result.txt'),'utf8'),'kept');
  const fresh=await keeper(t,f);assert.match(fresh.output,/CHECKPOINT_READY/);assert.match(fresh.output,/第一步只执行一次/);
  assert.equal((await readLedger(f.root)).tasks[f.taskId].checkpoint.completedSteps.length,1);assert.equal((await phaseRecords(f.root,f.taskId)).length,1);
  const sameSession=await runtimeState(f.root);assert.equal(sameSession.pause.status,'RESUMED');assert.equal(sameSession.bindings.tasks[f.taskId],f.run.id);
  fresh.child.kill('SIGTERM');await fresh.done;
});

test('a fresh CLI run after interrupted pause advertises convergence only and keeps admissions fenced',async t=>{
  const f=await fixture(t),original=await keeper(t,f);await mainWorker(f);
  const p=await requestPause(f.root,f.run.id);original.child.kill('SIGTERM');await original.done;
  const next=launch(t,[cli,'run','--project',f.root]);await until(()=>next.output.includes('EXECUTOR_CONVERGING'));
  assert(!next.output.includes('EXECUTOR_READY'));assert.match(next.output,/PAUSING/);
  const state=await runtimeState(f.root);assert.equal(state.pause.id,p.id);assert.equal(state.runActive,false);
  await assert.rejects(mutate(f.root,'next',req({runId:state.run.id})),/PAUSE_EXECUTION_BLOCKED/);
  next.child.kill('SIGTERM');await next.done;
});
