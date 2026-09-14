import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {mutate,readLedger,startRun,stopRun,runtimeState,updateBinding,configureCapabilities,activity} from '../tools/task-ledger.mjs';
import {setRunPolicy} from '../tools/task-ledger.mjs';
import {taskCapacity} from '../tools/task-capacity.mjs';
import {resources,conflicts,chooseExecution} from '../tools/task-assignments.mjs';
import {main} from '../tools/tasks.mjs';
import {renderTasks,renderStatus,renderAudit,renderDetail} from '../tools/task-format.mjs';
import {probeNative,closeNativeThread,verifyGoalProbe} from '../tools/task-native.mjs';

const cli=fileURLToPath(new URL('../tools/tasks.mjs',import.meta.url));
const req=x=>({operationId:randomUUID(),actor:'FIXTURE',...x});
const spec=(x={})=>({clarified:true,discussion:{approved:true,summary:'用户同意讨论结论',feasibility:'受控输入可验证',approvedRequirements:['准确交付']},title:'稳定正式标题',type:'SYSTEM',originalRequest:'原始问题',goal:'准确交付',scope:['fixture'],deliverables:['fixture结果'],acceptanceCriteria:['结果正确'],authorization:'仅隔离测试，不触及生产队列',...x});
const cp=(x={})=>({summary:'测试检查点',operations:[],...x});
const caps={delegation:true,closeVerified:true,goalVerified:false,parentThreadId:'fixture-parent',availableSlots:3,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};
async function fixture(t) {
  assert(process.env.REVIEW_TASK_DIR);
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'scheduling-'));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:randomUUID()}));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
const publish=(root,x)=>mutate(root,'publish',req({task:spec(x)}));
const candidate=(t,key,extra={})=>({taskId:t,key,goal:'交回可验证结果',deliverables:['artifact'],acceptanceCriteria:['结果正确'],resources:[{kind:'OBJECT',key,access:'WRITE'}],execution:{rationale:'独立常规测试实现'},...extra});
async function schedule(root,runId,assignments,operationId=randomUUID()) {
  const l=await readLedger(root);return mutate(root,'schedule',{operationId,actor:'FIXTURE',runId,assignments,expectedVersions:Object.fromEntries(Object.values(l.tasks).map(t=>[t.id,t.version]))});
}
async function change(root,action,taskId,assignmentId,runId,extra={}) {
  const t=(await readLedger(root)).tasks[taskId],a=t.assignments?.find(x=>x.id===assignmentId);
  return mutate(root,action,req({taskId,assignmentId,runId,expectedVersions:{[taskId]:t.version},expectedAssignmentVersion:a?.version,...extra}));
}
async function started(root,runId,a) {
  if(a.execution.mode==='SUBAGENT')await change(root,'assignment:dispatch',a.taskId,a.id,runId);
  return change(root,'assignment:start',a.taskId,a.id,runId,{nativeThreadId:'native-'+a.id,workspaceEvidence:'隔离 fixture，无共享代码写入'});
}
async function accepted(root,runId,a) {
  await change(root,'assignment:result',a.taskId,a.id,runId,{checkpoint:cp(),result:{summary:'结果完成',artifacts:['fixture:artifact'],acceptance:[{criterion:0,evidence:'fixture passed'}]}});
  await change(root,'assignment:accept',a.taskId,a.id,runId,{evidence:'主 Agent 独立核查 fixture passed'});
}
async function closed(root,runId,a) {
  if(a.execution.mode==='SUBAGENT')await updateBinding(root,runId,a.id,b=>{b.closureReceipt={verified:true,nativeThreadId:b.nativeThreadId,history:'PRESERVED'};});
  return change(root,'assignment:close',a.taskId,a.id,runId,{outcome:'ACCEPTED',cleanup:'fixture无残留'});
}

test('batch publication is discussed, atomic, idempotent and resolves local dependencies',async t=>{
  const root=await fixture(t);
  await assert.rejects(mutate(root,'publish',req({tasks:[spec({key:'a'}),spec({key:'b',discussion:undefined})]})),/讨论/);
  await assert.rejects(readFile(path.join(root,'tasks/project.json')),e=>e.code==='ENOENT');
  await assert.rejects(mutate(root,'publish',req({tasks:[spec({key:'a',dependencies:['@b']}),spec({key:'b',dependencies:['@a']})]})),/循环/);
  assert.equal((await readLedger(root)).sequence,0);
  const request=req({tasks:[spec({key:'a'}),spec({key:'b',type:'CREATIVE',dependencies:['@a']})]});
  const result=await mutate(root,'publish',request);assert.equal(result.taskIds.length,2);
  assert.equal((await mutate(root,'publish',request)).replayed,true);
  const ledger=await readLedger(root);assert.equal(ledger.sequence,1);assert.deepEqual(ledger.tasks[result.taskIds[1]].dependencies,[result.taskIds[0]]);
  assert.equal(ledger.tasks[result.taskIds[1]].discussion.summary,'用户同意讨论结论');
});

test('v1 upgrade preserves immutable bytes and refuses an active executor',async t=>{
  const root=await fixture(t);await publish(root);
  const instance=JSON.parse(await readFile(path.join(root,'instance/instance.json')));
  const oldName=(await readdir(path.join(root,'tasks/events')))[0],event=JSON.parse(await readFile(path.join(root,'tasks/events',oldName)));
  delete event.hash;event.schemaVersion=1;
  const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
  event.hash=createHash('sha256').update(JSON.stringify(stable(event))).digest('hex');
  const legacyFile=path.join(root,'tasks/events','0000000001-'+event.hash+'.json');
  await rm(path.join(root,'tasks/events',oldName));await writeFile(legacyFile,JSON.stringify(event,null,2)+'\n');
  const original=await readFile(legacyFile);
  await writeFile(path.join(root,'tasks/project.json'),JSON.stringify({schemaVersion:1,projectId:instance.id}));
  const run=await startRun(root);await assert.rejects(mutate(root,'upgrade',req({})),/停止活跃/);await stopRun(root,run.id,{close:true});
  assert.equal((await mutate(root,'upgrade',req({}))).schemaVersion,2);
  assert.deepEqual(await readFile(legacyFile),original);
  const files=await readdir(path.join(root,'tasks/events')),file=path.join(root,'tasks/events',files[0]),before=await readFile(file);
  await publish(root);assert.deepEqual(await readFile(file),before);
  const legacyBinding=JSON.parse(await readFile(path.join(root,'tasks/project.json')));assert.notEqual(legacyBinding.schemaVersion,1);
});

test('simultaneous scheduling CAS and replay never dispatch the same intent twice',async t=>{
  const root=await fixture(t),a=await publish(root),run=await startRun(root,{capabilities:caps});
  const request=req({runId:run.id,expectedVersions:{[a.taskId]:1},assignments:[candidate(a.taskId,'a')]});
  const results=await Promise.all([mutate(root,'schedule',request),mutate(root,'schedule',request)]);
  assert.equal(results[0].assignments[0].id,results[1].assignments[0].id);assert(results.some(x=>x.replayed));
  assert.equal((await readLedger(root)).tasks[a.taskId].assignments.length,1);
  await assert.rejects(mutate(root,'schedule',{...request,operationId:randomUUID()}),/版本冲突/);
});

test('a fresh coordinator recovers delivered work without replaying its operation or reusing the Agent',async t=>{
  const root=await fixture(t),formal=await publish(root);
  const keeper=spawn(process.execPath,[cli,'run','--project',root],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(keeper.exitCode===null&&keeper.signalCode===null)keeper.kill('SIGKILL');});
  const first=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('keeper timeout')),5000);keeper.stdout.on('data',chunk=>{out+=chunk;try{const parsed=JSON.parse(out.split('\n')[0]);clearTimeout(timer);resolve(parsed.runId);}catch{}});});
  await configureCapabilities(root,first,caps);
  const a=(await schedule(root,first,[candidate(formal.taskId,'a')])).assignments[0];await started(root,first,a);await accepted(root,first,a);
  const exited=once(keeper,'close');keeper.kill('SIGKILL');await exited;
  const next=await startRun(root,{capabilities:{...caps,parentThreadId:'new-parent'}});
  await assert.rejects(change(root,'assignment:checkpoint',a.taskId,a.id,first,{checkpoint:cp()}),/资格失效/);
  await change(root,'assignment:reconcile',a.taskId,a.id,next.id,{checkpoint:cp(),reconciliation:{processes:'旧执行已退出',workspace:'成果已保存',versions:'fixture@1 未变',operations:'已完成，不重复',agent:'核查原 Agent 待关闭'}});
  assert.equal((await readLedger(root)).tasks[a.taskId].assignments[0].status,'ACCEPTED');
  const binding=(await runtimeState(root)).bindings.assignments[a.id];assert.equal(binding.parentThreadId,'fixture-parent');
  assert.equal(binding.nativeThreadId,'native-'+a.id);await closed(root,next.id,a);
  const retry=(await schedule(root,next.id,[candidate(a.taskId,'review',{attemptOf:a.id})])).assignments[0];assert.notEqual(retry.id,a.id);
});

test('atomic scheduling respects resource overlap, priority, dependencies and slots across tasks',async t=>{
  const root=await fixture(t),a=await publish(root),b=await publish(root),c=await publish(root,{dependencies:[a.taskId]}),d=await publish(root);
  const run=await startRun(root,{capabilities:{...caps,availableSlots:2}});
  const result=await schedule(root,run.id,[candidate(a.taskId,'a',{resources:[{kind:'DIRECTORY',key:'core/src',access:'WRITE'}]}),candidate(b.taskId,'b',{resources:[{kind:'FILE',key:'core/src/a.mjs',access:'WRITE'}]}),candidate(c.taskId,'c'),candidate(d.taskId,'d')]);
  assert.equal(result.assignments.length,2);assert.deepEqual(result.deferred.map(x=>x.reason),['RESOURCE_CONFLICT','DEPENDENCY']);
  const fifth=await publish(root);assert.equal((await schedule(root,run.id,[candidate(fifth.taskId,'e')])).deferred[0].reason,'AGENT_CAPACITY');
  assert(Object.values((await readLedger(root)).tasks).filter(t=>t.status==='RUNNING').length===2);
  assert.equal(result.assignments[0].execution.model,'gpt-5.6-sol');
});

test('project task capacity is three unique identities including main, helpers and unfinished closure',async t=>{
 const root=await fixture(t),ids=[];for(let i=0;i<4;i++)ids.push((await publish(root,{title:'并行正式任务 '+i})).taskId);
 const run=await startRun(root,{capabilities:{...caps,availableSlots:8}});
 const first=await schedule(root,run.id,ids.map((id,i)=>candidate(id,'task-'+i,{execution:{rationale:'受控能力夹具',...(i===0?{mode:'MAIN'}:{})}})));
 assert.equal(first.assignments.length,3);assert.equal(first.deferred[0].reason,'TASK_CAPACITY');assert.equal(first.capacity.occupied,3);assert.equal(first.capacity.available,0);
 const extra=(await schedule(root,run.id,[candidate(ids[1],'auxiliary')])).assignments[0];assert(extra);assert.equal(taskCapacity((await readLedger(root)).tasks).occupied,3);
 const mainTask=first.assignments.find(a=>a.taskId===ids[0]);await started(root,run.id,mainTask);await accepted(root,run.id,mainTask);
 assert.equal((await schedule(root,run.id,[candidate(ids[3],'fourth')])).deferred[0].reason,'TASK_CAPACITY');
 await closed(root,run.id,mainTask);assert.equal(taskCapacity((await readLedger(root)).tasks).occupied,3,'parent still needs formal completion');
 const current=await mutate(root,'next',req({runId:run.id}));assert.equal(current.status,'CURRENT_TASK');assert.equal(current.capacity.occupied,3);
 await change(root,'transition',ids[0],null,run.id,{status:'DONE',reason:'夹具收尾完成',result:{summary:'已验收',artifacts:[],cleanup:'fixture清理完成',acceptance:[{criterion:0,evidence:'通过'}]}});
 const refill=await schedule(root,run.id,[candidate(ids[3],'fourth')]);assert.equal(refill.assignments.length,1);assert.equal(refill.capacity.occupied,3);assert.equal(refill.assignments[0].taskId,ids[3]);
 const status=await main(['status','--project',root]);assert.equal(status.taskCapacity.occupied,3);assert.equal(status.taskCapacity.limit,3);
 assert.match(await main(['status','--project',root,'--format','markdown']),/正式任务占用.*3 \/ 3/);
});

test('agent capacity and unverified closure lower actual execution without inventing parallel agents',async t=>{
 const root=await fixture(t),ids=[];for(let i=0;i<4;i++)ids.push((await publish(root)).taskId);
 const run=await startRun(root,{capabilities:{...caps,availableSlots:1}}),one=await schedule(root,run.id,ids.map((id,i)=>candidate(id,'agent-'+i)));
 assert.equal(one.assignments.length,1);assert(one.deferred.every(d=>d.reason==='AGENT_CAPACITY'));
 await configureCapabilities(root,run.id,{...caps,availableSlots:0});await assert.rejects(change(root,'assignment:dispatch',ids[0],one.assignments[0].id,run.id),/AGENT_CAPACITY/);
 const serialRoot=await fixture(t),a=await publish(serialRoot),b=await publish(serialRoot),serial=await startRun(serialRoot,{capabilities:{delegation:false,closeVerified:false,availableSlots:0,limitation:'fixture close unavailable'}});
 const result=await schedule(serialRoot,serial.id,[candidate(a.taskId,'a'),candidate(b.taskId,'b')]);assert.equal(result.assignments.length,1);assert.equal(result.assignments[0].execution.mode,'MAIN');assert.equal(result.deferred[0].reason,'MAIN_CAPACITY');assert.match(result.assignments[0].execution.limitation,/close unavailable/);
});

test('an imported over-capacity ledger blocks next/resume/dispatch/start/guard but allows convergence',async t=>{
 const root=await fixture(t),ids=[];for(let i=0;i<4;i++)ids.push((await publish(root)).taskId);
 const run=await startRun(root,{capabilities:{...caps,availableSlots:8}}),assigned=(await schedule(root,run.id,ids.slice(0,3).map((id,i)=>candidate(id,'reserved-'+i)))).assignments;
 await change(root,'assignment:dispatch',ids[0],assigned[0].id,run.id);
 // Valid historical v2 event from a writer that predates the task-count limit.
 const ledger=await readLedger(root),at=new Date().toISOString(),old={...ledger.tasks[ids[3]],version:2,status:'RUNNING',runId:'old-coordinator',startedAt:at,updatedAt:at};
 const event={schemaVersion:2,projectId:ledger.projectId,sequence:ledger.sequence+1,previousHash:ledger.head,operationId:randomUUID(),requestHash:'f'.repeat(64),action:'next',actor:'LEGACY_FIXTURE',at,tasks:[old],result:{taskId:old.id,status:'RUNNING'}};
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 event.hash=createHash('sha256').update(JSON.stringify(stable(event))).digest('hex');await writeFile(path.join(root,'tasks/events',String(event.sequence).padStart(10,'0')+'-'+event.hash+'.json'),JSON.stringify(event,null,2)+'\n');
 const before=(await readLedger(root)).head;
 await assert.rejects(mutate(root,'next',req({runId:run.id})),/TASK_CAPACITY/);
 await assert.rejects(change(root,'resume',ids[3],null,run.id,{checkpoint:cp(),reconciliation:{processes:'已停止',workspace:'已核查',versions:'已核查',operations:'无外部操作'}}),/TASK_CAPACITY/);
 await assert.rejects(change(root,'assignment:dispatch',ids[1],assigned[1].id,run.id),/TASK_CAPACITY/);
 await assert.rejects(change(root,'assignment:start',ids[0],assigned[0].id,run.id,{nativeThreadId:'never-started',workspaceEvidence:'fixture'}),/TASK_CAPACITY/);
 await assert.rejects(activity(root,run.id,run.owner,null,assigned[0].id,ids[0]),/TASK_CAPACITY/);assert.equal((await readLedger(root)).head,before);
 await change(root,'assignment:reconcile',ids[0],assigned[0].id,run.id,{checkpoint:cp(),noAgentCreated:true,noAgentEvidence:'fixture only recorded dispatch; no native spawn happened',reconciliation:{processes:'没有原执行进程',workspace:'无工作区',versions:'未改变',operations:'无外部操作',agent:'确认未创建'}});
 await change(root,'assignment:close',ids[0],assigned[0].id,run.id,{outcome:'CANCELLED',reason:'收敛旧超限',cleanup:'没有Agent或过程资源'});
 await change(root,'transition',ids[0],null,run.id,{status:'CANCELLED',reason:'收敛旧超限完成'});
 assert.equal(taskCapacity((await readLedger(root)).tasks).occupied,3);
 const resumed=await change(root,'resume',ids[3],null,run.id,{checkpoint:cp(),reconciliation:{processes:'原执行已停止',workspace:'已核查',versions:'未改变',operations:'无外部操作'}});assert.equal(resumed.status,'RUNNING');assert.equal(taskCapacity((await readLedger(root)).tasks).occupied,3);
});

test('immutable reads parallelize; unknown resources and path aliases cannot bypass reservations',()=>{
  const read=resources([{kind:'FILE',key:'core/a',access:'READ',version:'sha1'}]);
  assert.equal(conflicts(read,read),false);
  assert.equal(conflicts(read,resources([{kind:'DIRECTORY',key:'CORE',access:'WRITE'}])),true);
  assert.equal(conflicts(read,resources([])),true);
  assert.throws(()=>resources([{kind:'FILE',key:'core/../a',access:'WRITE'}]),/规范/);
  assert.throws(()=>resources([{kind:'FILE',key:'core/a',access:'READ'}]),/精确版本/);
  assert.equal(chooseExecution({longRunning:true,rationale:'实现'},caps).goalMode,'FOLLOWUP');
  assert.equal(chooseExecution({longRunning:true,rationale:'实现'},{...caps,goalVerified:true}).goalMode,'NATIVE');
  assert.throws(()=>chooseExecution({model:'nonexistent',rationale:'实现'},caps),/未在本次/);
});

test('delivered and accepted agents retain reservations until verified closure; native IDs stay local',async t=>{
  const root=await fixture(t),t1=await publish(root),run=await startRun(root,{capabilities:caps}),a=(await schedule(root,run.id,[candidate(t1.taskId,'a')])).assignments[0];
  await started(root,run.id,a);await accepted(root,run.id,a);
  await assert.rejects(change(root,'assignment:close',a.taskId,a.id,run.id,{outcome:'ACCEPTED',cleanup:'done'}),/原生关闭/);
  await assert.rejects(change(root,'transition',a.taskId,null,run.id,{status:'DONE',reason:'done',result:{}}),/关闭所有/);
  await closed(root,run.id,a);
  const second=(await schedule(root,run.id,[candidate(a.taskId,'a',{attemptOf:a.id})])).assignments[0];assert.notEqual(second.id,a.id);
  await change(root,'assignment:dispatch',second.taskId,second.id,run.id);
  await assert.rejects(change(root,'assignment:start',second.taskId,second.id,run.id,{nativeThreadId:'native-'+a.id,workspaceEvidence:'fixture'}),/禁止复用/);
  const bytes=(await Promise.all((await readdir(path.join(root,'tasks/events'))).map(f=>readFile(path.join(root,'tasks/events',f),'utf8')))).join('');
  assert(!bytes.includes('native-'+a.id));assert(!bytes.includes(run.id));
});

test('missing spawn receipt cannot be retried; independent resources still progress',async t=>{
  const root=await fixture(t),t1=await publish(root),t2=await publish(root),run=await startRun(root,{capabilities:caps});
  const a=(await schedule(root,run.id,[candidate(t1.taskId,'a')])).assignments[0];await change(root,'assignment:dispatch',a.taskId,a.id,run.id);
  await assert.rejects(change(root,'assignment:dispatch',a.taskId,a.id,run.id),/只能/);
  await assert.rejects(change(root,'assignment:close',a.taskId,a.id,run.id,{outcome:'CANCELLED',reason:'unknown spawn',cleanup:'keep'}),/原生关闭/);
  assert.equal((await schedule(root,run.id,[candidate(t2.taskId,'b')])).assignments.length,1);
  await change(root,'assignment:reconcile',a.taskId,a.id,run.id,{checkpoint:cp(),reconciliation:{processes:'无命令',workspace:'无工作区',versions:'未变',operations:'原调用已核对',agent:'明确失败且未创建'},noAgentCreated:true,noAgentEvidence:'fixture API 返回未创建错误'});
  assert.equal((await change(root,'assignment:close',a.taskId,a.id,run.id,{outcome:'CANCELLED',reason:'未创建',cleanup:'无资源'})).status,'CLOSED');
});

test('unknown operations preserve only affected reservations; stop permits convergence but no dispatch',async t=>{
  const root=await fixture(t),t1=await publish(root),t2=await publish(root),run=await startRun(root);
  const a=(await schedule(root,run.id,[candidate(t1.taskId,'a')])).assignments[0];assert.equal(a.execution.mode,'MAIN');await started(root,run.id,a);
  const pending=cp({operations:[{id:'op1',kind:'fixture',status:'RESULT_UNKNOWN'}]});
  await change(root,'assignment:reconcile',a.taskId,a.id,run.id,{checkpoint:pending,reconciliation:{processes:'已退出',workspace:'保留',versions:'已核对',operations:'UNKNOWN',agent:'无子Agent'}});
  const b=(await schedule(root,run.id,[candidate(t2.taskId,'b')])).assignments[0];assert(b);
  await assert.rejects(change(root,'assignment:checkpoint',a.taskId,a.id,run.id,{checkpoint:cp()}),/不能丢弃/);
  await stopRun(root,run.id);await assert.rejects(schedule(root,run.id,[candidate(t2.taskId,'c')]),/资格失效/);
  await change(root,'assignment:checkpoint',a.taskId,a.id,run.id,{checkpoint:pending});
  await assert.rejects(change(root,'assignment:close',a.taskId,a.id,run.id,{outcome:'CANCELLED',reason:'stop',cleanup:'keep'}),/未知操作/);
});

test('assignment guard runs three independent task commands concurrently and prevents early release',async t=>{
  const root=await fixture(t),t1=await publish(root),t2=await publish(root),t3=await publish(root),t4=await publish(root),run=await startRun(root,{capabilities:caps});
  const scheduled=await schedule(root,run.id,[candidate(t1.taskId,'a'),candidate(t2.taskId,'b'),candidate(t3.taskId,'c'),candidate(t4.taskId,'d')]),assigned=scheduled.assignments;
  assert.equal(scheduled.deferred[0].reason,'TASK_CAPACITY');
  for(const a of assigned)await started(root,run.id,a);
  const children=assigned.map(a=>spawn(process.execPath,[cli,'guard','--project',root,'--run',run.id,'--assignment',a.id,'--',process.execPath,'-e','setTimeout(()=>{},1500)'],{stdio:['ignore','pipe','pipe']}));
  const done=children.map(c=>once(c,'close'));t.after(()=>children.forEach(c=>{if(c.exitCode===null)c.kill('SIGTERM');}));
  let state;for(let i=0;i<100;i++){state=await runtimeState(root);if(state.activities.filter(a=>a.child&&a.live).length===3)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(state.activities.filter(a=>a.child&&a.live).length,3);
  await assert.rejects(accepted(root,run.id,assigned[0]),/命令仍在运行/);
  assert.deepEqual((await Promise.all(done)).map(x=>x[0]),[0,0,0]);
  assert.equal((await runtimeState(root)).activities.length,0);
});

test('all audit surfaces share seven fixed columns, exact title, category, dependencies and Beijing full timestamps',async t=>{
  const root=await fixture(t),a=await publish(root,{title:'不变 | 标题 <x> [y]'}),b=await publish(root,{type:'CREATIVE',dependencies:[a.taskId]});
  const ledger=await readLedger(root),data={tasks:Object.values(ledger.tasks),asOf:'2026-09-13T17:00:00Z',events:[]};
  const header='| 任务编号 | 任务标题 | 类别 | 状态 | 优先级 | 发布时间 | 前置依赖 |';
  const one=renderTasks(data),two=renderTasks({...data,asOf:'2026-09-14T17:00:00Z'});
  assert.equal(one.split('\n').slice(2).join('\n'),two.split('\n').slice(2).join('\n'));
  for(const output of [one,renderStatus(data),renderAudit(data),await main(['list','--project',root,'--format','markdown'])]) {
    assert(output.includes(header));assert(output.includes('不变 &#124; 标题 &lt;x&gt; &#91;y&#93;'));assert(output.includes('内容创作（CREATIVE）'));assert(output.includes(ledger.tasks[a.taskId].displayId));assert(!output.includes('.md>'));assert(!output.includes('tasks/items/'));
  }
  assert(renderDetail(ledger.tasks[b.taskId],{tasks:ledger.tasks}).includes(ledger.tasks[a.taskId].displayId));
  const empty=renderTasks({tasks:[],asOf:'2026-09-13T17:00:00Z'});assert(empty.includes('2026-09-14 01:00:00'));assert(empty.includes('共 0 项'));assert(empty.includes(header));
  assert(Array.isArray(await main(['list','--project',root])));
  assert.equal((await main(['list','--project',root,'--type','CREATIVE'])).length,1);
  await writeFile(path.join(root,'instance/runtime/task-execution/run.json'),JSON.stringify({id:'foreign',root,host:'unverifiable-host',projectId:ledger.projectId}));
  await writeFile(path.join(root,'instance/runtime/task-execution/activity.json'),JSON.stringify({host:'unverifiable-host',root}));
  const runtime=await runtimeState(root),unknown=renderStatus({...data,runtime});
  assert.equal(runtime.runActive,null);assert(unknown.includes('UNKNOWN（无法核验原执行者）'));assert(unknown.includes('UNKNOWN（存在无法核验的占用）'));
});

function nativeFixture({stuck=false,continueGoal=false}={}) {
  let loaded=true,paused=false,reads=0;const calls=[];
  return {calls,initialize:async()=>{},close(){},async call(method,params={}) {
    calls.push({method,params});
    if(method==='thread/read')return {thread:{id:params.threadId,status:{type:loaded?'idle':'notLoaded'},source:{subAgent:{thread_spawn:{parent_thread_id:'parent'}}},turns:params.includeTurns?[{id:'turn1',status:'completed'},...(continueGoal&&++reads>1?[{id:'turn2',status:'inProgress'}]:[])]:[]}};
    if(method==='thread/goal/get')return {goal:params.threadId==='parent'?null:{status:paused?'paused':'active',objective:'fixture'}};
    if(method==='thread/goal/set'){paused=true;return {};}
    if(method==='thread/backgroundTerminals/list')return {data:[]};
    if(method==='thread/loaded/list')return {data:loaded?['child']:[]};
    if(method==='thread/archive'){if(!stuck)loaded=false;return {};}
    if(method==='model/list')return {data:[{model:'gpt-5.6-sol',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}]};
    if(method==='thread/start')return {thread:{id:'child'}};
    if(method==='turn/interrupt')return {};
    throw Error(method);
  }};
}
test('native adapter fails closed when archive remains loaded and never deletes history',async()=>{
  const stuck=nativeFixture({stuck:true});await assert.rejects(closeNativeThread(stuck,'child','parent'),/未确认/);
  const client=nativeFixture();const receipt=await closeNativeThread(client,'child','parent');assert.equal(receipt.history,'PRESERVED');
  assert(!client.calls.some(x=>x.method==='thread/delete'));assert(client.calls.some(x=>x.method==='thread/goal/set'&&x.params.status==='paused'));
  await assert.rejects(closeNativeThread(client,'parent','parent'),/只能关闭/);
  const fallback=await probeNative({parentThreadId:'parent',probeRoot:'/fixture',availableSlots:3,clientFactory:()=>({initialize:async()=>{throw Error('unavailable');},close(){}})});
  assert.equal(fallback.delegation,false);assert.equal(chooseExecution({rationale:'fix'},fallback).mode,'MAIN');
});

test('native Goal verification observes new automatic turn and parent pause, never assumes two old turns suffice',async()=>{
  const client=nativeFixture({continueGoal:true});assert.equal((await verifyGoalProbe(client,{childThreadId:'child',parentThreadId:'parent',firstTurnId:'turn1',timeoutMs:100,pollMs:1})).goalVerified,true);
  assert(!client.calls.some(x=>['turn/start','turn/steer'].includes(x.method)));
  await assert.rejects(verifyGoalProbe(nativeFixture(),{childThreadId:'child',parentThreadId:'parent',firstTurnId:'turn1',timeoutMs:5,pollMs:1}),/未观察/);
});

test('an explicit stop-after policy blocks refill after the selected task finishes',async t=>{
 const root=await fixture(t),a=await publish(root),b=await publish(root),run=await startRun(root,{capabilities:caps});
 await setRunPolicy(root,run.id,{stopAfterTaskId:a.taskId});
 const worker=(await schedule(root,run.id,[candidate(a.taskId,'a',{execution:{mode:'MAIN',rationale:'policy fixture'}})])).assignments[0];
 await started(root,run.id,worker);await accepted(root,run.id,worker);await closed(root,run.id,worker);
 await change(root,'transition',a.taskId,null,run.id,{status:'DONE',reason:'完成并暂停',result:{summary:'已验收',artifacts:[],cleanup:'fixture已清理',acceptance:[{criterion:0,evidence:'通过'}]}});
 assert.equal((await schedule(root,run.id,[candidate(b.taskId,'b')])).status,'PAUSED_BY_POLICY');
 assert.equal((await mutate(root,'next',req({runId:run.id}))).status,'PAUSED_BY_POLICY');
 assert.equal((await readLedger(root)).tasks[b.taskId].status,'READY');
});

test('coordinator exit preserves the running worker identity, original checkpoint and resource reservation',async t=>{
 const root=await fixture(t),formal=await publish(root);
 const keeper=spawn(process.execPath,[cli,'run','--project',root],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(keeper.exitCode===null&&keeper.signalCode===null)keeper.kill('SIGKILL');});
 const oldRun=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('keeper timeout')),5000);keeper.stdout.on('data',chunk=>{out+=chunk;try{const parsed=JSON.parse(out.split('\n')[0]);clearTimeout(timer);resolve(parsed.runId);}catch{}});});
 await configureCapabilities(root,oldRun,caps);
 const a=(await schedule(root,oldRun,[candidate(formal.taskId,'running-work')])).assignments[0];await started(root,oldRun,a);
 const checkpoint=cp({completedSteps:['persisted original input'],nextSteps:['track original turn'],operations:[{id:'still-running-operation',kind:'FIXTURE',status:'PENDING'}]});
 await change(root,'assignment:checkpoint',a.taskId,a.id,oldRun,{checkpoint});
 await updateBinding(root,oldRun,a.id,b=>{b.backendRequest={operationId:'still-running-operation',turnId:'same-turn',state:'RUNNING'};});
 await assert.rejects(startRun(root),/已有执行会话/);
 const exited=once(keeper,'close');keeper.kill('SIGKILL');await exited;
 const next=await startRun(root,{capabilities:caps});assert.equal(next.recoveryKind,'COORDINATOR_EXIT');
 const t1=(await readLedger(root)).tasks[a.taskId],request=req({runId:next.id,expectedRunId:oldRun,taskId:a.taskId,assignmentId:a.id,expectedVersions:{[a.taskId]:t1.version},expectedAssignmentVersion:t1.assignments[0].version,checkpoint,reconciliation:{processes:'fixture keeper actually exited',workspace:'unchanged',versions:'checked',operations:'original turn remains in progress',agent:'same native worker'}});
 await mutate(root,'assignment:reconcile',request);assert((await mutate(root,'assignment:reconcile',request)).replayed);
 const current=(await runtimeState(root)).bindings.assignments[a.id];
 assert.equal(current.nativeThreadId,'native-'+a.id);assert.equal(current.backendRequest.turnId,'same-turn');assert.equal(current.backendRequest.operationId,'still-running-operation');assert.equal(current.ownershipHistory.length,1);
 const conflict=await schedule(root,next.id,[candidate(formal.taskId,'duplicate',{resources:a.resources})]);assert.equal(conflict.assignments.length,0);assert.equal(conflict.deferred[0].reason,'RESOURCE_CONFLICT');
 assert.equal((await readLedger(root)).tasks[a.taskId].assignments.length,1);
});
