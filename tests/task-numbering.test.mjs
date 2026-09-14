import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {mutate,readLedger,rebuild,projectionFiles,audit,startRun,stopRun,setRunPolicy,location,updateBinding,activity,clearActivity} from '../tools/task-ledger.mjs';
import {main} from '../tools/tasks.mjs';
import {processIdentity} from '../tools/process-resources.mjs';
import {renderDetail,renderAudit} from '../tools/task-format.mjs';
import {replayTaskNumbers,normalizeTaskRequest} from '../tools/task-numbering.mjs';
import {listDecisions,persistDecisionMessage,drainDecisionInbox,decisionSnapshot,decisionVersions} from '../tools/task-decisions.mjs';
import {fixture,spec,task,request,legacy,eventBytes,call} from './task-numbering/fixture.mjs';

const at='2026-09-14T02:00:00.000Z';
const numberMap=ledger=>Object.fromEntries(Object.values(ledger.tasks).map(t=>[t.id,t.displayId]));
const id=n=>'T-20260914-'+String(n).padStart(12,'0');
const candidate=(taskId,key='worker')=>({taskId,key,goal:'验证别名派工',deliverables:['fixture'],acceptanceCriteria:['验证正确'],resources:[{kind:'OBJECT',key,access:'WRITE'}],execution:{rationale:'受控测试'}});
const caps={delegation:true,closeVerified:true,agentCapacity:3,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};

test('new CLI publications use Shanghai midnight, share both types, and reset to three digits independent of host timezone',async t=>{
  const root=await fixture(t);
  const first=await call(root,['publish'],{body:request({task:spec()}),at:'2026-09-13T15:59:59.999Z',env:{TZ:'America/Los_Angeles'}});
  const second=await call(root,['publish'],{body:request({tasks:[spec({key:'creative',type:'CREATIVE'}),spec({key:'system',dependencies:['@creative']})]}),at:'2026-09-13T16:00:00.000Z',env:{TZ:'UTC'}});
  const third=await call(root,['publish'],{body:request({task:spec()}),at:'2026-09-14T15:59:59.999Z',env:{TZ:'Pacific/Auckland'}});
  const fourth=await call(root,['publish'],{body:request({task:spec()}),at:'2026-09-14T16:00:00.000Z'});
  assert.equal(first.tasks[0].displayId,'T-20260913-001');
  assert.deepEqual(second.tasks.map(t=>t.displayId),['T-20260914-001','T-20260914-002']);
  assert.equal(third.tasks[0].displayId,'T-20260914-003');assert.equal(fourth.tasks[0].displayId,'T-20260915-001');
  assert.match(second.taskIds[0],/^T-20260913-[a-f0-9]{12}$/,'永久 ID 仍沿用原生成规则');
  assert.deepEqual(second.tasks[1].dependencies,[second.taskIds[0]]);
});

test('legacy mapping uses first publication instants and event order, pins at upgrade, and leaves bytes, IDs and references intact',async t=>{
  const root=await fixture(t),same='2026-09-13T17:00:00.000Z';
  const late=task(id(1),'2026-09-14T01:00:00.000Z'),early=task(id(9),same),tie=task(id(2),same,{dependencies:[early.id],references:[early.id,'fixture:original']}),yesterday=task(id(3),'2026-09-13T15:59:59.999Z');
  const done={...late,version:2,status:'DONE',updatedAt:at,completedAt:at};
  await legacy(root,[{tasks:[late],schemaVersion:1},{tasks:[early,tie]},{tasks:[yesterday]},{tasks:[done],action:'transition'}]);
  const bytes=await eventBytes(root),initial=await readLedger(root),expected={[late.id]:'T-20260914-003',[early.id]:'T-20260914-001',[tie.id]:'T-20260914-002',[yesterday.id]:'T-20260913-001'};
  assert.deepEqual(numberMap(initial),expected);assert.equal(initial.events[0].tasks[0].displayId,undefined);
  await rebuild(root);const views=projectionFiles(await readLedger(root));await rebuild(root);
  assert.deepEqual(projectionFiles(await readLedger(root)),views);assert.deepEqual(await eventBytes(root),bytes);
  const report=audit(initial,{taskId:late.id});assert.equal(report.events[0].changes[0].displayId,expected[late.id]);assert.equal(report.events[0].changes[0].status,'READY');
  await mutate(root,'upgrade',request({}));
  assert.equal((await readLedger(root)).events.at(-1).taskNumbering.allocations.length,4);
  await mutate(root,'amend',request({taskId:expected[tie.id],expectedVersions:{[expected[tie.id]]:1},changes:{priority:1},reason:'固定映射'}));
  let ledger=await readLedger(root);
  assert.equal(ledger.events.at(-1).taskNumbering.allocations.length,0);
  assert.equal(ledger.tasks[early.id].version,1,'映射固定不改其他任务版本');
  assert.deepEqual(ledger.tasks[tie.id].dependencies,[early.id]);assert.deepEqual(ledger.tasks[tie.id].references,[early.id,'fixture:original']);
  // A clock correction after mapping was fixed cannot reorder historical numbers.
  const newTask=await call(root,['publish'],{body:request({task:spec()}),at:'2026-09-13T16:30:00.000Z'});
  assert.equal(newTask.tasks[0].displayId,'T-20260914-004');
  ledger=await readLedger(root);for(const [id,displayId] of Object.entries(expected))assert.equal(ledger.tasks[id].displayId,displayId);
  const after=await eventBytes(root);for(const [name,value] of Object.entries(bytes))assert.equal(after[name],value);
  assert.equal((await main(['show',late.id,'--project',root])).id,late.id);
  assert.equal((await main(['show',expected[late.id],'--project',root])).id,late.id);
});

test('legacy operations replay with old IDs and equivalent aliases before upgrade, including a v1 publication without discussion',async t=>{
  const root=await fixture(t),a=task(id(1),at),b=task(id(2),at,{dependencies:[a.id]});
  const publication=request({task:spec({discussion:undefined})});
  const amendment=request({taskId:b.id,expectedVersions:{[b.id]:1},changes:{priority:0,dependencies:[a.id]},reason:'旧请求'});
  await legacy(root,[{tasks:[a],request:publication,schemaVersion:1},{tasks:[b]},{tasks:[{...b,version:2,priority:0}],request:amendment,action:'amend'}]);
  const before=await eventBytes(root);
  assert.equal((await mutate(root,'publish',publication)).taskId,a.id);
  const alias={...amendment,taskId:'T-20260914-002',expectedVersions:{'T-20260914-002':1},changes:{priority:0,dependencies:['T-20260914-001']}};
  for(const r of [amendment,alias])assert.equal((await mutate(root,'amend',r)).replayed,true);
  await assert.rejects(mutate(root,'amend',{...alias,changes:{priority:1}}),/同一操作/);
  await assert.rejects(mutate(root,'amend',{...alias,operationId:'new-stale'}),/TASK_UPGRADE_REQUIRED/);
  assert.deepEqual(await eventBytes(root),before);
});

test('aliases normalize only structured references before CAS and hashing; conflicts and duplicate merge targets do not write',async t=>{
  const root=await fixture(t),a=(await call(root,['publish'],{body:request({task:spec()}),at})).tasks[0];
  const original=request({task:spec({title:a.displayId+' 原样标题',dependencies:[a.displayId],references:[a.displayId,'text '+a.displayId]})});
  const first=await call(root,['publish'],{body:original,at});
  const replay=await call(root,['publish'],{body:{...original,task:{...original.task,dependencies:[a.id],references:[a.id,'text '+a.displayId]}},at});
  assert.equal(replay.replayed,true);assert.equal(replay.taskId,first.taskId);
  assert.equal(first.tasks[0].title,original.task.title);assert.deepEqual(first.tasks[0].references,[a.id,'text '+a.displayId]);
  const b=first.tasks[0],change=request({taskId:b.displayId,expectedVersions:{[b.displayId]:1},changes:{priority:0},reason:'别名 CAS'});
  await mutate(root,'amend',change);
  assert.equal((await mutate(root,'amend',{...change,taskId:b.id,expectedVersions:{[b.id]:1}})).replayed,true);
  const before=await eventBytes(root);
  await assert.rejects(mutate(root,'amend',{...change,operationId:'stale'}),/版本冲突/);
  await assert.rejects(mutate(root,'amend',{...change,operationId:'wrong-target',taskId:a.displayId}),/版本冲突/);
  await assert.rejects(mutate(root,'amend',{...change,operationId:'mixed-conflict',expectedVersions:{[b.displayId]:2,[b.id]:1}}),/TASK_ALIAS_VERSION_CONFLICT/);
  await assert.rejects(mutate(root,'merge',request({taskIds:[a.id,a.displayId],expectedVersions:{[a.id]:1},title:'重复来源',reason:'fixture'})),/两个不同任务/);
  await assert.rejects(mutate(root,'publish',{...original,task:spec({dependencies:[b.displayId]})}),/同一操作/);
  assert.deepEqual(await eventBytes(root),before);
  const payload={...change,operationId:a.displayId,checkpoint:{inputs:[a.displayId],operations:[{id:a.displayId}]},bindingToken:a.displayId};
  const normalized=normalizeTaskRequest((await readLedger(root)).tasks,payload);
  assert.equal(normalized.operationId,payload.operationId);assert.deepEqual(normalized.checkpoint,payload.checkpoint);assert.equal(normalized.bindingToken,payload.bindingToken);
});

test('terminal changes, filters, sorting and all rendered surfaces preserve display numbers and seven columns',async t=>{
  const root=await fixture(t);const published=await call(root,['publish'],{body:request({tasks:[spec({key:'done'}),spec({key:'cancel'}),spec({key:'dependent',type:'CREATIVE',dependencies:['@done']})]}),at}),[a,b,c]=published.tasks;
  const run=await startRun(root),node=(await mutate(root,'schedule',request({runId:run.id,expectedVersions:{[a.id]:1},assignments:[{...candidate(a.id),execution:{mode:'MAIN',rationale:'编号 fixture'}}]}))).assignments[0];
  const change=async(action,extra)=>{const task=(await readLedger(root)).tasks[a.id],assignment=task.assignments[0];return mutate(root,action,request({runId:run.id,taskId:a.displayId,assignmentId:node.id,expectedVersions:{[a.id]:task.version},expectedAssignmentVersion:assignment.version,...extra}));};
  await change('assignment:start',{workspaceEvidence:'隔离对象'});
  await change('assignment:result',{checkpoint:{summary:'fixture',operations:[]},result:{summary:'已完成',artifacts:[],acceptance:[{criterion:0,evidence:'pass'}]}});
  await change('assignment:accept',{evidence:'fixture核验'});await change('assignment:close',{outcome:'ACCEPTED',cleanup:'无残留'});
  await change('transition',{status:'DONE',reason:'fixture',result:{summary:'已完成',cleanup:'受管夹具',artifacts:[],acceptance:[{criterion:0,evidence:'pass'},{criterion:1,evidence:'pass'}]}});
  await mutate(root,'transition',request({taskId:b.displayId,expectedVersions:{[b.displayId]:1},status:'CANCELLED',reason:'fixture'}));
  const d=(await call(root,['publish'],{body:request({task:spec()}),at})).tasks[0];assert.equal(d.displayId,'T-20260914-004');
  const ledger=await readLedger(root),before=numberMap(ledger),query=(...args)=>main([...args,'--project',root]);
  for(const ref of [a.id,a.displayId]) {
    assert.deepEqual(await query('list','--task',ref),[]);
    assert.equal((await query('list','--all','--task',ref))[0].id,a.id);
    assert.equal((await query('show',ref)).id,a.id);
    assert((await query('audit','--task',ref)).events.every(e=>e.changes.every(t=>t.id===a.id)));
  }
  assert.deepEqual(await query('list','--status','DONE'),[]);
  assert.equal((await query('list','--all','--status','DONE'))[0].id,a.id);
  for(const sort of ['published','priority','updated','completed']) {
    const rows=await query('list','--all','--sort',sort);assert.deepEqual(Object.fromEntries(rows.map(t=>[t.id,t.displayId])),before);
  }
  const table=await query('list','--type','CREATIVE','--format','markdown');
  assert.match(table,/T-20260914-003 .* T-20260914-001 \|/);
  for(const line of table.split('\n').filter(l=>l.startsWith('|')))assert.equal(line.split(' | ').length,7);
  const outputs=[table,await query('show',c.displayId,'--format','markdown'),await query('status','--task',c.id,'--format','markdown'),await query('audit','--task',c.displayId,'--format','markdown')];
  await rebuild(root);outputs.push(await readFile(path.join(root,'tasks/README.md'),'utf8'),await readFile(path.join(root,'tasks/items',c.id+'.md'),'utf8'));
  for(const output of outputs) {
    assert(output.includes(c.displayId));assert(output.includes(a.displayId));assert(output.includes(c.title));
    assert.doesNotMatch(output,/T-\d{8}-[a-f0-9]{12}|tasks\/items|\]\(/);
    assert(output.includes('2026-09-14 10:00:00'));
  }
  assert.deepEqual(numberMap(await readLedger(root)),before);
  assert.equal((await query('audit','--from','2026-09-14T02:00:00Z','--to','2026-09-14T02:00:00.001Z')).events.filter(e=>e.action==='publish').length,2);
});

test('simultaneous batches and duplicate operations allocate once in append order with no shared-type gaps',async t=>{
  const root=await fixture(t),requests=Array.from({length:6},(_,i)=>request({tasks:[spec({key:'a',title:'系统 '+i}),spec({key:'b',title:'创作 '+i,type:'CREATIVE',dependencies:['@a']})]}));
  const results=await Promise.all([...requests,requests[0],requests[0]].map(body=>call(root,['publish'],{body,at})));
  assert.equal(results.filter(r=>r.replayed).length,2);
  const ledger=await readLedger(root);assert.equal(ledger.sequence,6);assert.equal(Object.keys(ledger.tasks).length,12);
  const ordered=ledger.events.flatMap(e=>e.tasks.filter(t=>t.version===1));
  assert.deepEqual(ordered.map(t=>t.displayId),Array.from({length:12},(_,i)=>'T-20260914-'+String(i+1).padStart(3,'0')));
  for(const e of ledger.events)assert.deepEqual(e.tasks[1].dependencies,[e.tasks[0].id]);
  const replay=await call(root,['publish'],{body:requests[0],at:'2026-09-15T02:00:00Z'});
  assert.equal(replay.taskId,results[0].taskId);assert.deepEqual(replay.taskIds,results[0].taskIds);assert.equal((await readLedger(root)).sequence,6);
});

test('the 999 limit is explicit and atomic for publish, batch, merge and split, including concurrent final-slot claims',async t=>{
  const root=await fixture(t),tasks=Array.from({length:998},(_,i)=>task(id(i+1),at));
  await legacy(root,Array.from({length:20},(_,i)=>({tasks:tasks.slice(i*50,(i+1)*50)})));
  await mutate(root,'upgrade',request({}));
  const before=await eventBytes(root),head=(await readLedger(root)).head;
  await assert.rejects(call(root,['publish'],{body:request({tasks:[spec({key:'a'}),spec({key:'b',dependencies:['@a']})]}),at}),/TASK_NUMBER_LIMIT.*999/);
  await assert.rejects(call(root,['split'],{body:request({taskId:'T-20260914-001',expectedVersions:{'T-20260914-001':1},reason:'超限拆解',children:[{title:'a',goal:'a',criterionIndexes:[0]},{title:'b',goal:'b',criterionIndexes:[1]}]}),at}),/TASK_NUMBER_LIMIT/);
  assert.deepEqual(await eventBytes(root),before);assert.equal((await readLedger(root)).head,head);
  const r=request({task:spec({title:'最后名额'})}),other=request({task:spec({type:'CREATIVE'})});
  const results=await Promise.allSettled([r,other].map(body=>call(root,['publish'],{body,at})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/TASK_NUMBER_LIMIT/);
  const winner=results[0].status==='fulfilled'?0:1,saved=results[winner].value;
  assert.equal(saved.tasks[0].displayId,'T-20260914-999');
  assert.equal((await call(root,['publish'],{body:[r,other][winner],at})).replayed,true);
  const full=await eventBytes(root);
  await assert.rejects(call(root,['merge'],{body:request({taskIds:['T-20260914-001','T-20260914-002'],expectedVersions:{'T-20260914-001':1,'T-20260914-002':1},title:'超限合并',reason:'fixture'}),at}),/TASK_NUMBER_LIMIT/);
  assert.deepEqual(await eventBytes(root),full);assert.equal(Object.keys((await readLedger(root)).tasks).length,999);
  const reset=await call(root,['publish'],{body:request({task:spec()}),at:'2026-09-14T16:00:00.000Z'});
  assert.equal(reset.tasks[0].displayId,'T-20260915-001');
});

test('malformed numbering mappings, rewritten aliases and a legacy day above 999 fail without truncation or reuse',()=>{
  const a=task(id(1),at),b=task(id(2),at),base={sequence:1,tasks:[a,b]};
  assert.throws(()=>replayTaskNumbers([{...base,taskNumbering:{version:1,allocations:[{taskId:a.id,displayId:'T-20260914-001'},{taskId:b.id,displayId:'T-20260914-001'}]}}]),/CONFLICT/);
  assert.throws(()=>replayTaskNumbers([{...base,taskNumbering:{version:1,allocations:[{taskId:a.id,displayId:'T-20260913-001'}]}}]),/INVALID/);
  for(const displayId of ['T-20260914-000','T-20260914-1000'])assert.throws(()=>replayTaskNumbers([{...base,taskNumbering:{version:1,allocations:[{taskId:a.id,displayId}]}}]),/INVALID/);
  assert.throws(()=>replayTaskNumbers([{...base,tasks:[{...a,displayId:'T-20260914-002'},b]}]),/CONFLICT/);
  assert.throws(()=>replayTaskNumbers([{sequence:1,tasks:Array.from({length:1000},(_,i)=>task(id(i+1),at))}]),/TASK_NUMBER_LIMIT/);
});

test('schedule and assignment aliases keep versions, operation identity, policy and guard ownership bound to the original task',async t=>{
  const root=await fixture(t),published=await mutate(root,'publish',request({tasks:[spec({key:'a'}),spec({key:'b'})]})),[a,b]=published.tasks,run=await startRun(root);
  const r=request({runId:run.id,expectedVersions:{[a.displayId]:1},assignments:[candidate(a.displayId)]});
  await assert.rejects(mutate(root,'schedule',{...r,operationId:'duplicate-alias',assignments:[candidate(a.displayId),candidate(a.id)]}),/候选派工 key 重复/);
  const scheduled=await mutate(root,'schedule',r),assignment=scheduled.assignments[0];
  assert.equal(assignment.taskId,a.id);
  assert.equal((await mutate(root,'schedule',{...r,expectedVersions:{[a.id]:1},assignments:[candidate(a.id)]})).assignments[0].id,assignment.id);
  const start=request({runId:run.id,taskId:a.displayId,assignmentId:assignment.id,expectedVersions:{[a.id]:2},expectedAssignmentVersion:1,workspaceEvidence:'隔离 fixture'});
  await mutate(root,'assignment:start',start);
  assert.equal((await mutate(root,'assignment:start',{...start,taskId:a.id})).replayed,true);
  const snapshot=await readLedger(root),current=snapshot.tasks[a.id],as=current.assignments[0];
  await assert.rejects(mutate(root,'assignment:checkpoint',request({runId:run.id,taskId:a.displayId,assignmentId:as.id,expectedVersions:{[a.displayId]:current.version},expectedAssignmentVersion:as.version-1,checkpoint:{summary:'stale'}})),/派工版本冲突/);
  assert.deepEqual(await setRunPolicy(root,run.id,{stopAfterTaskId:a.displayId}),{stopAfterTaskId:a.id});
  await activity(root,run.id,processIdentity(),null,as.id,a.displayId);await clearActivity(root,run.id,as.id);
  await assert.rejects(activity(root,run.id,processIdentity(),null,as.id,b.displayId),/派工与任务编号不符/);
  await assert.rejects(main(['guard','--project',root,'--run',run.id,'--task',b.displayId,'--assignment',as.id,'--',process.execPath,'-e','process.exit(99)']),/派工与任务编号不符/);
  const correct=await main(['guard','--project',root,'--run',run.id,'--task',a.displayId,'--assignment',as.id,'--',process.execPath,'-e','process.exit(0)']);
  assert.equal(correct.exitCode,0);assert.deepEqual(numberMap(await readLedger(root)),numberMap(snapshot));
});

test('decision aliases retain three-level CAS, binding tokens, waiting and replay gates without contacting a real receiver',async t=>{
  const root=await fixture(t),[a,b]=(await mutate(root,'publish',request({tasks:[spec({key:'a'}),spec({key:'b'})]}))).tasks,run=await startRun(root,{capabilities:caps});
  const scheduled=await mutate(root,'schedule',request({runId:run.id,expectedVersions:{[a.displayId]:1},assignments:[candidate(a.displayId)]})),assignment=scheduled.assignments[0];
  let started;
  for(const action of ['dispatch','start']) {
    const current=(await readLedger(root)).tasks[a.id],as=current.assignments[0];
    const r=request({runId:run.id,taskId:a.displayId,assignmentId:as.id,expectedVersions:{[a.displayId]:current.version},expectedAssignmentVersion:as.version,...(action==='start'?{nativeThreadId:'fixture-thread',workspaceEvidence:'fixture'}:{})});
    await mutate(root,'assignment:'+action,r);if(action==='start')started=r;
  }
  const loc=await location(root),service={serviceId:'numbering-service',generation:'numbering-generation'};
  await mkdir(path.join(loc.runtime,'server'));await writeFile(path.join(loc.runtime,'server/server.json'),JSON.stringify(service));
  await updateBinding(root,run.id,assignment.id,b=>{b.backendServiceId=service.serviceId;b.backendCreation={threadId:'fixture-thread',...service};b.backendRequest={operationId:'fixture-work',turnId:'fixture-turn',state:'RUNNING'};});
  await persistDecisionMessage(root,service,'fixture-connection',{id:1,method:'item/tool/requestUserInput',params:{threadId:'fixture-thread',turnId:'fixture-turn',itemId:'fixture-item',questions:[{id:'choice',header:'fixture',question:'仅受控问题'}]}});
  await drainDecisionInbox(root);
  const decisions=await listDecisions(root,{taskId:a.displayId});assert.equal(decisions.length,1);assert.equal(decisions[0].taskId,a.id);
  assert.match(await main(['decisions','list','--project',root,'--task',a.displayId,'--format','markdown']),new RegExp(a.displayId));
  let snapshot=await decisionSnapshot(root,decisions[0].id);assert.equal(snapshot.assignment.status,'WAITING_DECISION');
  const fields=()=>({...decisionVersions(snapshot),taskId:a.displayId,expectedVersions:{[a.displayId]:snapshot.task.version}});
  await assert.rejects(mutate(root,'decision:present',request({runId:run.id,...fields(),taskId:b.displayId,evidence:'错绑测试'})),/DECISION_BINDING/);
  await assert.rejects(mutate(root,'decision:present',request({runId:run.id,...fields(),expectedDecisionVersion:0,evidence:'过期测试'})),/DECISION_VERSION/);
  await assert.rejects(mutate(root,'decision:present',request({runId:run.id,...fields(),bindingToken:'wrong',evidence:'错误 token'})),/DECISION_BINDING/);
  const present=request({runId:run.id,...fields(),evidence:'仅 fixture 模拟呈现'});
  await mutate(root,'decision:present',present);
  assert.equal((await mutate(root,'decision:present',{...present,taskId:a.id,expectedVersions:{[a.id]:snapshot.task.version}})).replayed,true);
  snapshot=await decisionSnapshot(root,decisions[0].id);
  await assert.rejects(mutate(root,'decision:answer',request({runId:run.id,...fields(),answer:{answers:{choice:{answers:['test']}}},evidence:'未授权'})),/DECISION_CONSENT/);
  const answer=request({runId:run.id,...fields(),actor:'USER',explicitUserAnswer:true,answer:{answers:{choice:{answers:['test']}}},evidence:'仅 fixture 明确答复'});
  await mutate(root,'decision:answer',answer);
  assert.equal((await mutate(root,'decision:answer',{...answer,taskId:a.id,expectedVersions:{[a.id]:snapshot.task.version}})).replayed,true);
  await assert.rejects(mutate(root,'decision:answer',{...answer,answer:{answers:{choice:{answers:['different']}}}}),/同一操作/);
  snapshot=await decisionSnapshot(root,decisions[0].id);assert.equal(snapshot.assignment.status,'WAITING_DECISION');
  await assert.rejects(mutate(root,'assignment:result',request({runId:run.id,taskId:a.displayId,assignmentId:assignment.id,expectedVersions:{[a.displayId]:snapshot.task.version},expectedAssignmentVersion:snapshot.assignment.version,checkpoint:{summary:'fixture'},result:{summary:'不允许提前完成',acceptance:[]}})),/DECISION_PENDING/);
  assert.match(renderDetail(snapshot.task),new RegExp(a.displayId));
  assert.match(renderAudit(audit(await readLedger(root),{taskId:a.displayId})),new RegExp(a.displayId));
  await stopRun(root,run.id);
  const before=await eventBytes(root);
  for(const useAlias of [false,true]) {
    const body=useAlias?answer:{...answer,taskId:a.id,expectedVersions:{[a.id]:answer.expectedVersions[a.displayId]}};
    assert.equal((await call(root,['decisions','answer'],{body})).replayed,true);
    const startBody=useAlias?started:{...started,taskId:a.id,expectedVersions:{[a.id]:started.expectedVersions[a.displayId]}};
    assert.equal((await call(root,['assignment','start'],{body:startBody})).replayed,true);
  }
  await assert.rejects(call(root,['decisions','answer'],{body:{...answer,answer:{answers:{choice:{answers:['different']}}}}}),/同一操作/);
  await assert.rejects(call(root,['decisions','answer'],{body:{...answer,operationId:'new-after-stop'}}),/资格失效/);
  assert.deepEqual(await eventBytes(root),before);
});
