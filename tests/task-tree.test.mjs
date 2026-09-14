import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mutate,readLedger,location,readBindings,startRun,stopRun,detachRun,updateBinding,runtimeState,requireExecutionAuthority,activity,clearActivity} from '../tools/task-ledger.mjs';
import {assignmentRole,assignmentAncestors,assignmentDescendants,rootAssignment,resourcesWithin,requireAssignmentResourceAccess} from '../tools/task-tree.mjs';
import {requestPause,savePauseCheckpoint,verifyPause} from '../tools/task-pause.mjs';
import {renderStatus} from '../tools/task-format.mjs';
import {materializeLegacyFixture} from './task-legacy-fixture.mjs';

const req=x=>({actor:'TREE_FIXTURE',operationId:randomUUID(),...x});
const caps={delegation:true,closeVerified:true,parentThreadId:'coordinator',agentCapacity:1,availableSlots:0,models:[{model:'gpt-5.6-sol',efforts:['xhigh']}]};
const cp=()=>({summary:'保留原成果和后续步骤',completedSteps:['已完成原步骤'],nextSteps:['继续未完成步骤'],inputs:['fixture@1'],artifacts:['fixture-result'],operations:[]});
const object=key=>[{kind:'OBJECT',key,access:'WRITE'}];
const candidate=(taskId,key,resources=object(key))=>({taskId,key,resources,goal:'有界执行',deliverables:['artifact'],acceptanceCriteria:['通过核验'],execution:{rationale:'隔离原生能力 fixture'}});
async function fixture(t,{schemaVersion}={}){
  assert(process.env.REVIEW_TASK_DIR,'Use the managed process runner');
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'task-tree-')),projectId=randomUUID();
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:projectId}));
  await writeFile(path.join(root,'instance/runtime/process-policy.json'),JSON.stringify({schemaVersion:'1.0',enabled:true,projectId,host:'fixture',maxTemporaryBytes:64*1024**3,reserveBytes:0,registry:'.process/receipts',workspace:'.process/stages',parentTasks:'.process/tasks',temporaryRoots:['.process/shared'],protectedPaths:['instance'],dockerBinary:'/usr/bin/true'}));
  if(schemaVersion){await mkdir(path.join(root,'tasks'));await writeFile(path.join(root,'tasks/project.json'),JSON.stringify({schemaVersion,projectId}));}
  return root;
}
const publish=root=>mutate(root,'publish',req({task:{clarified:true,type:'SYSTEM',title:'树形执行夹具',originalRequest:'隔离验证执行树',goal:'原任务有界交付',scope:['fixture'],deliverables:['fixture-result'],acceptanceCriteria:['通过核验'],authorization:'仅隔离测试',discussion:{approved:true,summary:'仅隔离验证',feasibility:'本地 fake host',approvedRequirements:['无真实模型调用']}}}));
async function schedule(root,run,assignments){const l=await readLedger(root);return mutate(root,'schedule',req({runId:run.id,assignments,expectedVersions:Object.fromEntries(Object.values(l.tasks).map(t=>[t.id,t.version]))}));}
async function change(root,run,a,action,extra={}){const t=(await readLedger(root)).tasks[a.taskId],node=t.assignments.find(x=>x.id===a.id);return mutate(root,action,req({runId:run?.id,taskId:t.id,assignmentId:a.id,expectedVersions:{[t.id]:t.version},expectedAssignmentVersion:node.version,...extra}));}
async function start(root,run,a,authority){
  if(a.execution.mode==='SUBAGENT')await change(root,run,a,'assignment:dispatch',{authority});
  await change(root,run,a,'assignment:start',{authority,nativeThreadId:'native-'+a.id,workspaceEvidence:'隔离对象范围，无代码写入'});
  return {assignmentId:a.id,executionToken:(await readBindings(await location(root))).assignments[a.id].executionAuthority?.token};
}
async function children(root,parent,authority,assignments){const t=(await readLedger(root)).tasks[parent.taskId];return mutate(root,'assignment:schedule',req({taskId:t.id,parentAssignmentId:parent.id,authority,assignments,expectedVersions:{[t.id]:t.version}}));}
const result={summary:'完成隔离验收',artifacts:['fixture-result'],acceptance:[{criterion:0,evidence:'fixture passed'}]};

test('v3 next reports candidates without bypassing WORKER admission or changing the ledger',async t=>{
  const root=await fixture(t),formal=await publish(root),run=await startRun(root),before=await readLedger(root);
  const next=await mutate(root,'next',req({runId:run.id}));
  assert.equal(next.status,'WORKER_REQUIRED');assert.equal(next.taskId,formal.taskId);assert.equal(next.capacity.occupied,0);
  const after=await readLedger(root);assert.equal(after.head,before.head);assert.deepEqual(after.tasks,before.tasks);assert.equal(after.tasks[formal.taskId].status,'READY');
});

test('a frozen v2 writer refuses v3 before reaching a mutation and leaves all event bytes intact',async t=>{
  const root=await fixture(t);await publish(root);
  const directory=path.join(root,'tasks/events'),names=await readdir(directory),before=await Promise.all(names.map(f=>readFile(path.join(directory,f))));
  assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(new URL('./task-tree-v2-writer.mjs',import.meta.url)),root],{stdio:'pipe'}),/请升级 CLI/);
  assert.deepEqual(await readdir(directory),names);for(let i=0;i<names.length;i++)assert.deepEqual(await readFile(path.join(directory,names[i])),before[i]);
});

test('an explicit Main detach preserves running node commands and tokens for exact runtime handoff',async t=>{
  const root=await fixture(t),formal=await publish(root),run=await startRun(root,{capabilities:caps});
  const [parent]=(await schedule(root,run,[{...candidate(formal.taskId,'root',[{kind:'UNKNOWN',key:'*',access:'WRITE'}]),execution:{mode:'MAIN',rationale:'主节点 fixture'}}])).assignments,authority=await start(root,run,parent);
  const [child]=(await children(root,parent,authority,[candidate(parent.taskId,'child')])).assignments;
  const childAuthority=await start(root,null,child,authority),loc=await location(root),before=await readLedger(root),nativeBefore=(await readBindings(loc)).assignments[child.id].nativeThreadId;
  await activity(root,run.id,run.owner,null,child.id,child.taskId,undefined,{authority:childAuthority});
  assert.equal((await detachRun(root,run.id)).status,'DETACHED');
  const detached=await runtimeState(root);assert.equal(detached.executionStatus,'COORDINATOR_DETACHED');assert.equal(detached.runActive,false);
  assert.match(renderStatus({tasks:Object.values((await readLedger(root)).tasks),runtime:detached}),/主协调者已退出/);
  await assert.rejects(schedule(root,run,[]),/资格失效/);
  assert.equal((await requireExecutionAuthority(loc,authority,{assignmentId:child.id,relation:'descendant'})).id,run.id);
  await change(root,null,child,'assignment:checkpoint',{authority:childAuthority,checkpoint:cp()});
  const atHandoff=await readLedger(root),next=await startRun(root,{capabilities:caps});assert.equal(next.recoveryKind,'COORDINATOR_DETACHED');
  const binding=(await readBindings(loc)).assignments[child.id];assert.equal(binding.runId,next.id);assert.equal(binding.nativeThreadId,nativeBefore);assert.equal(binding.executionAuthority.token,childAuthority.executionToken);assert.equal(binding.ownershipHistory.at(-1).fromRunId,run.id);
  assert.deepEqual((await readLedger(root)).tasks,atHandoff.tasks);assert.equal((await requireExecutionAuthority(loc,childAuthority)).id,next.id);assert.equal((await readLedger(root)).events.length,before.events.length+1);
  await clearActivity(root,run.id,child.id);
  await stopRun(root,next.id);await assert.rejects(requireExecutionAuthority(loc,childAuthority),/STOP_EXECUTION_BLOCKED/);
});

test('Main detach cannot release an unbound command or create a second live coordinator',async t=>{
  const root=await fixture(t);await publish(root);const run=await startRun(root);
  await activity(root,run.id,run.owner);
  await assert.rejects(detachRun(root,run.id),/DETACH_ACTIVITY_UNBOUND/);assert.equal((await runtimeState(root)).runActive,true);
  await clearActivity(root,run.id);await detachRun(root,run.id);
  const next=await startRun(root);await assert.rejects(startRun(root),/已有执行会话/);
  assert.equal((await runtimeState(root)).run.id,next.id);
});

test('v3 has one WORKER per task, three formal slots, and no inherited application subagent ceiling',async t=>{
  const root=await fixture(t),ids=[];for(let i=0;i<4;i++)ids.push((await publish(root)).taskId);
  const run=await startRun(root,{capabilities:caps});
  const scheduled=await schedule(root,run,ids.map((id,i)=>i===0?{...candidate(id,'root-'+i,[{kind:'DIRECTORY',key:'scope'+i,access:'WRITE'}]),execution:{mode:'MAIN',rationale:'主节点 fixture'}}:candidate(id,'root-'+i)));
  assert.equal(scheduled.assignments.length,3);assert.equal(scheduled.deferred[0].reason,'TASK_CAPACITY');assert.equal(scheduled.capacity.occupied,3);
  const worker=scheduled.assignments[0],authority=await start(root,run,worker);
  assert.equal(assignmentRole(worker),'WORKER');assert.equal(worker.parentAssignmentId,null);assert.equal(worker.rootAssignmentId,worker.id);
  assert.equal((await schedule(root,run,[candidate(worker.taskId,'second-root')])).deferred[0].reason,'WORKER_EXISTS');
  const expanded=await children(root,worker,authority,Array.from({length:6},(_,i)=>candidate(worker.taskId,'child-'+i,[{kind:'FILE',key:'scope0/'+i,access:'WRITE'}])));
  assert.equal(expanded.assignments.length,6);assert.equal(expanded.capacity.occupied,3);
  assert(expanded.assignments.every(a=>a.role==='SUBAGENT'&&a.parentAssignmentId===worker.id&&a.rootAssignmentId===worker.id));
  assert.equal((await readLedger(root)).schemaVersion,3);
  const runtime=await runtimeState(root);assert(!runtime.bindings.assignments[worker.id].executionAuthority.token);
  const eventText=(await Promise.all((await readdir(path.join(root,'tasks/events'))).map(f=>readFile(path.join(root,'tasks/events',f),'utf8')))).join('');
  assert(!eventText.includes(authority.executionToken));assert(!eventText.includes('native-'+worker.id));assert(!eventText.includes(run.id));
});

test('descendants retain original authority after lease expiry while cross-tree and stop gates fail closed',async t=>{
  const root=await fixture(t),first=await publish(root),second=await publish(root),run=await startRun(root,{capabilities:caps});
  const [parent,other]=(await schedule(root,run,[{...candidate(first.taskId,'root',[{kind:'UNKNOWN',key:'*',access:'WRITE'}]),execution:{mode:'MAIN',rationale:'主节点 fixture'}}])).assignments;
  const authority=await start(root,run,parent),loc=await location(root);
  const runFile=path.join(loc.runtime,'run.json'),saved=JSON.parse(await readFile(runFile));saved.expiresAt='2000-01-01T00:00:00Z';await writeFile(runFile,JSON.stringify(saved));
  await assert.rejects(schedule(root,run,[candidate(second.taskId,'other')]),/资格失效/);
  const [child]=(await children(root,parent,authority,[candidate(parent.taskId,'child',object('object-a'))])).assignments;
  const childAuthority=await start(root,null,child,authority);
  const authorized=await requireExecutionAuthority(loc,authority,{assignmentId:child.id,relation:'descendant'});assert.equal(authorized.id,run.id);assert.equal(authorized.authorityMode,'EXECUTION');
  await assert.rejects(requireExecutionAuthority(loc,childAuthority,{assignmentId:parent.id,relation:'descendant'}),/EXECUTION_AUTHORITY_SCOPE/);
  await assert.rejects(children(root,parent,{...authority,executionToken:randomUUID()},[candidate(parent.taskId,'forged')]),/EXECUTION_AUTHORITY/);
  await assert.rejects(children(root,parent,childAuthority,[candidate(parent.taskId,'wrong-parent')]),/EXECUTION_AUTHORITY_SCOPE|EXECUTION_AUTHORITY/);
  await assert.rejects(children(root,parent,authority,[candidate(second.taskId,'foreign')]),/版本冲突|ASSIGNMENT_PARENT_SCOPE/);
  await stopRun(root,run.id);
  await assert.rejects(children(root,child,childAuthority,[candidate(child.taskId,'stopped',object('object-a'))]),/STOP_EXECUTION_BLOCKED/);
  await change(root,null,child,'assignment:checkpoint',{authority:childAuthority,checkpoint:cp()});
});

test('resource delegation excludes ancestors, blocks siblings and enforces recursive containment',async t=>{
  const root=await fixture(t),formal=await publish(root),run=await startRun(root,{capabilities:caps});
  const [parent]=(await schedule(root,run,[{...candidate(formal.taskId,'root',[{kind:'UNKNOWN',key:'*',access:'WRITE'}]),execution:{mode:'MAIN',rationale:'主节点 fixture'}}])).assignments,authority=await start(root,run,parent);
  const [child]=(await children(root,parent,authority,[candidate(parent.taskId,'child',object('owned'))])).assignments,childAuthority=await start(root,null,child,authority);
  assert.equal((await children(root,parent,authority,[candidate(parent.taskId,'sibling',object('owned'))])).deferred[0].reason,'RESOURCE_CONFLICT');
  await assert.rejects(children(root,child,childAuthority,[candidate(parent.taskId,'escape',object('outside'))]),/RESOURCE_SCOPE/);
  const [grandchild]=(await children(root,child,childAuthority,[candidate(parent.taskId,'grandchild',object('owned'))])).assignments;
  const tasks=(await readLedger(root)).tasks;
  assert.deepEqual(assignmentAncestors(tasks,grandchild.id).map(a=>a.id),[child.id,parent.id]);
  assert.equal(rootAssignment(tasks,grandchild.id).id,parent.id);assert.equal(assignmentDescendants(tasks,parent.id).length,2);
  assert.throws(()=>requireAssignmentResourceAccess(tasks,parent,object('owned')),/RESOURCE_DELEGATED/);
  assert.deepEqual(requireAssignmentResourceAccess(tasks,parent,object('unclaimed')),object('unclaimed'));
  await assert.rejects(activity(root,run.id,run.owner,null,parent.id,parent.taskId,()=>{throw Error('must not launch');},{authority,resources:object('owned')}),/RESOURCE_DELEGATED/);
  assert.equal(resourcesWithin([{kind:'FILE',key:'src/a',access:'WRITE'}],[{kind:'DIRECTORY',key:'src',access:'READ',version:'sha'}]),false);
  assert.equal(resourcesWithin([{kind:'FILE',key:'src/a',access:'READ',version:'sha2'}],[{kind:'DIRECTORY',key:'src',access:'READ',version:'sha1'}]),false);
});

test('a parent cannot finish or release descendants, decisions, or unknown interventions',async t=>{
  const root=await fixture(t),formal=await publish(root),run=await startRun(root,{capabilities:caps});
  const [parent]=(await schedule(root,run,[{...candidate(formal.taskId,'root',[{kind:'UNKNOWN',key:'*',access:'WRITE'}]),execution:{mode:'MAIN',rationale:'主节点 fixture'}}])).assignments,authority=await start(root,run,parent);
  const [child]=(await children(root,parent,authority,[candidate(parent.taskId,'child')])).assignments;
  await start(root,null,child,authority);
  await assert.rejects(change(root,run,parent,'assignment:result',{checkpoint:cp(),result}),/ASSIGNMENT_DESCENDANTS_OPEN/);
  await assert.rejects(change(root,run,parent,'assignment:close',{outcome:'CANCELLED',reason:'提前释放',cleanup:'none'}),/ASSIGNMENT_DESCENDANTS_OPEN/);
  await updateBinding(root,run.id,child.id,b=>{b.interventions={uncertain:{state:'RESULT_UNKNOWN'}};});
  await assert.rejects(change(root,null,child,'assignment:result',{authority,checkpoint:cp(),result}),/RESULT_UNKNOWN/);
  await updateBinding(root,run.id,child.id,b=>{b.interventions.uncertain.state='REJECTED';});
  await change(root,null,child,'assignment:result',{authority,checkpoint:cp(),result});
  const own={assignmentId:child.id,executionToken:(await readBindings(await location(root))).assignments[child.id].executionAuthority.token};
  await assert.rejects(change(root,null,child,'assignment:accept',{authority:own,evidence:'自验'}),/SELF_ACCEPT/);
  await change(root,null,child,'assignment:accept',{authority,evidence:'父节点验收'});
  await updateBinding(root,null,child.id,b=>{b.closureReceipt={verified:true,nativeThreadId:b.nativeThreadId,history:'PRESERVED'};},{authority});
  await change(root,null,child,'assignment:close',{authority,outcome:'ACCEPTED',cleanup:'无过程资源'});
  await assert.rejects(requireExecutionAuthority(await location(root),own,{converging:true}),/EXECUTION_AUTHORITY/);
  await change(root,null,parent,'assignment:result',{authority,checkpoint:cp(),result});
});

test('safe v2 upgrade preserves exact old history, unfinished checkpoints and paused legacy nodes without minting authority',async t=>{
  const root=await fixture(t),formal=await publish(root),run=await startRun(root,{capabilities:{delegation:false,closeVerified:false}});
  const [old]=(await schedule(root,run,[candidate(formal.taskId,'legacy')])).assignments;
  await start(root,run,old);
  await materializeLegacyFixture(root);
  await assert.rejects(mutate(root,'upgrade',req({})),/停止活跃/);
  const pause=await requestPause(root,run.id);
  for(const assignmentId of [undefined,old.id]){
    const task=(await readLedger(root)).tasks[formal.taskId],a=task.assignments.find(a=>a.id===assignmentId);
    await savePauseCheckpoint(root,run.id,req({pauseId:pause.id,taskId:task.id,assignmentId,expectedVersions:{[task.id]:task.version},expectedAssignmentVersion:a?.version,quiescent:true,evidence:'所有状态已落盘',checkpoint:cp(),workspace:{path:root,files:[]}}));
  }
  const verified=await verifyPause(root,run.id);assert.equal(verified.status,'PAUSED',JSON.stringify(verified.issues));await stopRun(root,run.id,{close:true});
  const before=await readLedger(root),files=await readdir(path.join(root,'tasks/events')),bytes=await Promise.all(files.map(f=>readFile(path.join(root,'tasks/events',f))));
  const upgraded=await mutate(root,'upgrade',req({}));assert.equal(upgraded.schemaVersion,3);
  const after=await readLedger(root);assert.deepEqual(after.tasks,before.tasks);assert.equal(after.events.length,before.events.length+1);
  for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(path.join(root,'tasks/events',files[i])),bytes[i]);
  const legacy=after.tasks[old.taskId].assignments[0];assert(!legacy.role);assert(!legacy.parentAssignmentId);assert(!legacy.rootAssignmentId);
  assert(!(await readBindings(await location(root))).assignments[old.id].executionAuthority);
});

test('v3 pause targets every descendant and only closes the coordinator after all stop receipts are verified',async t=>{
  const root=await fixture(t),formal=await publish(root),run=await startRun(root,{capabilities:caps});
  const [parent]=(await schedule(root,run,[{...candidate(formal.taskId,'root',[{kind:'UNKNOWN',key:'*',access:'WRITE'}]),execution:{mode:'MAIN',rationale:'主节点 fixture'}}])).assignments,authority=await start(root,run,parent);
  const [child]=(await children(root,parent,authority,[candidate(parent.taskId,'child')])).assignments,childAuthority=await start(root,null,child,authority);
  const [leaf]=(await children(root,child,childAuthority,[candidate(parent.taskId,'leaf',child.resources)])).assignments;await start(root,null,leaf,childAuthority);
  const pause=await requestPause(root,run.id);assert.deepEqual(pause.targets[0].assignmentIds,[parent.id,child.id,leaf.id]);
  await assert.rejects(requireExecutionAuthority(await location(root),childAuthority),/PAUSE_EXECUTION_BLOCKED/);
  await assert.rejects(detachRun(root,run.id),/DETACH_STOP/);
  await assert.rejects(stopRun(root,run.id,{close:true}),/未核查关闭/);
  await assert.rejects(change(root,run,parent,'assignment:close',{outcome:'CANCELLED',reason:'父节点不能先关闭',cleanup:'保留'}),/ASSIGNMENT_DESCENDANTS_OPEN/);
  for(const assignmentId of [undefined,parent.id,child.id,leaf.id]){
    const task=(await readLedger(root)).tasks[formal.taskId],a=task.assignments.find(a=>a.id===assignmentId);
    await savePauseCheckpoint(root,run.id,req({pauseId:pause.id,taskId:task.id,assignmentId,expectedVersions:{[task.id]:task.version},expectedAssignmentVersion:a?.version,quiescent:true,evidence:'整棵执行树已保存可停止检查点',checkpoint:cp(),workspace:{path:root,files:[]}}));
  }
  const paused=await verifyPause(root,run.id,{pauseAgent:async(project,id,assignmentId,pauseId)=>updateBinding(project,id,assignmentId,b=>{b.pauseReceipt={verified:true,pauseId,history:'PRESERVED'};})});
  assert.equal(paused.status,'PAUSED',JSON.stringify(paused.issues));await stopRun(root,run.id,{close:true});
  assert.equal((await runtimeState(root)).pause.status,'PAUSED');assert.equal((await readLedger(root)).tasks[formal.taskId].assignments.filter(a=>a.status!=='CLOSED').length,3);
});
