import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {mutate,readLedger,location,readBindings,startRun,stopRun,requireRun,activity,heartbeat,runtimeState} from '../tools/task-ledger.mjs';
import {requestPause,savePauseCheckpoint,verifyPause,resumePausedRun} from '../tools/task-pause.mjs';
import {main} from '../tools/tasks.mjs';
import {dispatchBackend,continueBackend} from '../tools/task-backend.mjs';
import {materializeLegacyFixture} from './task-legacy-fixture.mjs';
import {formalAdmission,beginPhase} from '../tools/process-resources.mjs';

const req=x=>({operationId:randomUUID(),actor:'LEGACY_GATE_FIXTURE',...x});
const cp={summary:'保存原结果',completedSteps:['完成原步骤'],nextSteps:['验收原结果'],inputs:['fixture@1'],artifacts:['artifact'],operations:[]};
const result={summary:'原结果已完成',artifacts:['artifact'],acceptance:[{criterion:0,evidence:'原结果核验通过'}]};
async function fixture(t,schemaVersion=2){
  assert(process.env.REVIEW_TASK_DIR);
  const root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'legacy-gate-')),projectId=randomUUID();
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'instance/runtime'),{recursive:true});await writeFile(path.join(root,'instance/instance.json'),JSON.stringify({id:projectId}));
  await writeFile(path.join(root,'instance/runtime/process-policy.json'),JSON.stringify({schemaVersion:'1.0',enabled:true,projectId,host:'fixture',maxTemporaryBytes:64*1024**3,reserveBytes:0,registry:'.process/receipts',workspace:'.process/stages',parentTasks:'.process/tasks',temporaryRoots:['.process/shared'],protectedPaths:['instance'],dockerBinary:'/usr/bin/true'}));
  const publication=req({task:{clarified:true,type:'SYSTEM',title:'旧历史夹具',originalRequest:'验证旧工作可收敛',goal:'核验原结果',scope:['fixture'],deliverables:['artifact'],acceptanceCriteria:['原结果通过'],authorization:'仅受控夹具',discussion:{approved:true,summary:'fixture',feasibility:'fixture',approvedRequirements:['fixture']}}});
  const formal=await mutate(root,'publish',publication),run=await startRun(root),taskId=formal.taskId;
  const [assignment]=(await mutate(root,'schedule',req({runId:run.id,expectedVersions:{[taskId]:1},assignments:[{taskId,key:'existing',goal:'已有工作',deliverables:['artifact'],acceptanceCriteria:['原结果通过'],resources:[{kind:'UNKNOWN',key:'*',access:'WRITE'}],execution:{mode:'MAIN',rationale:'历史主执行'}}]}))).assignments;
  let task=(await readLedger(root)).tasks[taskId];
  await mutate(root,'assignment:start',req({runId:run.id,taskId,assignmentId:assignment.id,expectedVersions:{[taskId]:task.version},expectedAssignmentVersion:assignment.version,workspaceEvidence:'isolated historical input'}));
  await materializeLegacyFixture(root,schemaVersion);
  return {root,taskId,assignmentId:assignment.id,run,publication,loc:await location(root)};
}
async function change(f,action,extra={}){const task=(await readLedger(f.root)).tasks[f.taskId],assignment=task.assignments.find(a=>a.id===f.assignmentId);return mutate(f.root,action,req({runId:f.run.id,taskId:f.taskId,assignmentId:f.assignmentId,expectedVersions:{[f.taskId]:task.version},expectedAssignmentVersion:assignment.version,...extra}));}
async function bytes(f){const directory=path.join(f.root,'tasks/events'),files=(await readdir(directory)).sort();return Promise.all(files.map(async name=>[name,await readFile(path.join(directory,name),'utf8')]));}

for(const schemaVersion of [1,2])test(`v${schemaVersion} rejects new writes and execution while exact old operations replay without changing history`,async t=>{
  const f=await fixture(t,schemaVersion),before=await bytes(f);
  assert.equal((await main(['list','--project',f.root])).length,1);assert.equal((await main(['audit','--project',f.root])).sequence,3);
  for(const [action,extra] of [['publish',{task:f.publication.task}],['schedule',{assignments:[]}],['next',{}],['amend',{changes:{priority:1}}],['merge',{taskIds:[]}],['split',{children:[]}],['transition',{status:'READY'}],['assignment:dispatch',{}],['assignment:start',{}],['decision:answer',{}],['decision:sending',{}],['decision:reconcile',{resolution:'FOLLOWUP'}],['decision:followup-start',{}]])await assert.rejects(change(f,action,extra),/TASK_UPGRADE_REQUIRED/,action);
  await assert.rejects(requireRun(f.loc,f.run.id),/TASK_UPGRADE_REQUIRED/);
  await assert.rejects(activity(f.root,f.run.id,f.run.owner,null,f.assignmentId,f.taskId,()=>{throw Error('must not launch');}),/TASK_UPGRADE_REQUIRED/);
  await assert.rejects(dispatchBackend(f.root,f.run.id,f.assignmentId,{operationId:'new-dispatch'}),/TASK_UPGRADE_REQUIRED/);
  await assert.rejects(continueBackend(f.root,f.run.id,f.assignmentId,{operationId:'new-turn'}),/TASK_UPGRADE_REQUIRED/);
  await assert.rejects(beginPhase(f.root,f.taskId,'new-formal-phase'),/TASK_UPGRADE_REQUIRED/);
  assert.equal(await formalAdmission(f.root,f.taskId,()=> 'converged',{converging:true}),'converged');
  assert.equal(await formalAdmission(f.root,'development-not-formal',()=> 'development'),'development');
  await assert.rejects(formalAdmission(f.root,f.taskId,()=>formalAdmission(f.root,f.taskId,()=> 'must not execute'),{converging:true}),/TASK_UPGRADE_REQUIRED/);
  assert.equal((await mutate(f.root,'publish',f.publication)).replayed,true);
  assert.deepEqual(await bytes(f),before);assert.equal((await runtimeState(f.root)).convergenceOnly,true);
  assert.equal((await requireRun(f.loc,f.run.id,{converging:true})).id,f.run.id);await heartbeat(f.root,f.run.id);
});

test('v2 existing results can checkpoint, deliver, accept, close and complete while the run is stopping',async t=>{
  const f=await fixture(t),before=await bytes(f);await stopRun(f.root,f.run.id);
  await change(f,'checkpoint',{checkpoint:cp});await change(f,'assignment:checkpoint',{checkpoint:cp});
  await change(f,'assignment:result',{checkpoint:cp,result});await change(f,'assignment:accept',{evidence:'主协调者核验原结果'});
  await change(f,'assignment:close',{outcome:'ACCEPTED',cleanup:'原夹具无残留'});
  await change(f,'transition',{status:'DONE',reason:'旧工作收尾',result:{...result,cleanup:'原夹具无残留'}});
  const ledger=await readLedger(f.root);assert.equal(ledger.tasks[f.taskId].status,'DONE');assert.equal(ledger.schemaVersion,2);
  assert.deepEqual((await bytes(f)).slice(0,before.length),before);
  await stopRun(f.root,f.run.id,{close:true});assert.equal((await mutate(f.root,'upgrade',req({}))).schemaVersion,3);
});

test('direct legacy pause recovery preserves the exact PAUSED snapshot and bindings until safe upgrade',async t=>{
  const f=await fixture(t),pause=await requestPause(f.root,f.run.id);
  for(const assignmentId of [undefined,f.assignmentId]){
    const task=(await readLedger(f.root)).tasks[f.taskId],a=task.assignments.find(a=>a.id===assignmentId);
    await savePauseCheckpoint(f.root,f.run.id,req({pauseId:pause.id,taskId:f.taskId,assignmentId,expectedVersions:{[f.taskId]:task.version},expectedAssignmentVersion:a?.version,quiescent:true,evidence:'真实夹具安全边界',checkpoint:cp,workspace:{path:f.root,files:[]}}));
  }
  assert.equal((await verifyPause(f.root,f.run.id)).status,'PAUSED');await stopRun(f.root,f.run.id,{close:true});
  const files=['pause.json','bindings.json','run.json',path.join('pauses',pause.id,'checkpoint.json')],before=await Promise.all(files.map(file=>readFile(path.join(f.loc.runtime,file)))),history=await bytes(f);
  const recovered=await resumePausedRun(f.root,'unused-recovery-run');assert.equal(recovered.status,'UPGRADE_REQUIRED');assert.equal(recovered.pauseStatus,'PAUSED');
  for(let i=0;i<files.length;i++)assert.deepEqual(await readFile(path.join(f.loc.runtime,files[i])),before[i]);assert.deepEqual(await bytes(f),history);
  assert.equal((await mutate(f.root,'upgrade',req({}))).schemaVersion,3);
  assert(!(await readBindings(f.loc)).assignments[f.assignmentId].executionAuthority);
});
