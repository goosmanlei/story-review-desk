import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, realpath, readFile, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {blankProfile, blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {writeOrchestration, ORCHESTRATION_NAMESPACE} from '../host/instance-runtime/orchestration-service.mjs';
import {readOrchestrationDashboard, dashboardText} from '../host/instance-runtime/orchestration-dashboard.mjs';
import {readOrchestrationHeartbeat, writeOrchestrationHeartbeat} from '../host/instance-runtime/orchestration-dashboard-runtime.mjs';
import {OrchestrationRunner, privateDirectory} from '../host/orchestration-runner.mjs';
import {dashboardRecords, dashboardFixture} from './fixtures/orchestration-dashboard.mjs';

async function repository(t) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'orchestration-dashboard-')));
  const profile=blankProfile({instanceId:'dashboard-test',projectId:'dashboard-project'});
  const repo=createInstanceRepository({dbPath:path.join(root,'review.sqlite'),instanceId:profile.instanceId,profile});
  await repo.writeTransaction(tx => tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null}));
  t.after(async () => {await repo.close();await rm(root,{recursive:true,force:true});});
  return {repo,root,metadata:await repo.readTransaction(tx=>tx.getMetadata())};
}
test('browser projection reads completed history, every task state and held capacity without changing the real repository',async t => {
  const {repo,metadata}=await repository(t), f=dashboardRecords(metadata);
  await repo.writeTransaction(async tx => {for(const [key,value] of f.rows)await tx.putAux({namespace:ORCHESTRATION_NAMESPACE,key,bytes:JSON.stringify(value),expectedRevisionId:null});});
  const before=await repo.readTransaction(tx=>tx.getMetadata());
  const read=options=>repo.readTransaction(tx=>readOrchestrationDashboard(tx,{heartbeat:f.heartbeat,now:Date.parse(f.at),...options}));
  const view=await read();
  assert.deepEqual(view.pools.map(p=>[p.kind,p.configured,p.running,p.held,p.available]),[['CREATIVE',3,0,1,2],['CREATIVE_QA',0,1,0,0],['DEVELOP',3,1,1,1],['DEVELOP_QA',2,1,0,1]]);
  assert.equal(view.pools.find(p=>p.kind==='DEVELOP').waiting,4);
  assert.equal(view.pools.find(p=>p.kind==='CREATIVE_QA').dispatching,false,'zero capacity cannot dispatch new work');
  assert.equal(view.completed.total,23);assert.equal(view.completed.tasks.length,20);
  assert.equal(view.completed.tasks[0].statusLabel,'质检未通过 · 本轮结束');
  const second=await read({completedPage:1});assert.equal(second.completed.tasks.length,3);
  assert.deepEqual(new Set([...view.completed.tasks,...second.completed.tasks].map(t=>t.id)).size,23);
  assert.equal(second.completed.tasks.at(-1).statusLabel,'已取消');
  assert.equal(second.completed.tasks.at(-2).statusLabel,'已由返修版本替代');
  assert.equal(view.queue.find(t=>t.id==='dependent').dependencies[0].title,'实现协作页面');
  assert.equal(view.queue.find(t=>t.id==='repair').isRework,true);
  assert.equal(view.processing.find(t=>t.id==='qa-parent').statusLabel,'等待独立质检');
  assert.equal(view.processing.find(t=>t.id==='rework-parent').statusLabel,'等待返修');
  assert.equal(view.queue.find(t=>t.id==='blocked').statusLabel,'已阻塞');
  assert.equal(view.processing.find(t=>t.id==='cancel-pending').statusLabel,'正在取消 · 执行待核查');
  assert.equal(view.decisions.length,1);assert.equal(view.decisions[0].reason,'质检轮数已达上限');
  assert.equal(view.workers.find(r=>r.id==='run-work').observed,true);
  assert.equal(view.workers.find(r=>r.id==='run-work').model,'gpt-test');
  assert.equal(view.workers.find(r=>r.id==='run-qa').model,null);
  assert.equal(view.workers.find(r=>r.id==='run-unknown').observed,false);
  assert.doesNotMatch(JSON.stringify(view),/SENTINEL|token|capability|tokenHash|authorization|worktree|threadId|inputs|execution|\/private\//i);
  assert.deepEqual(await repo.readTransaction(tx=>tx.getMetadata()),before);
});

test('published task lifecycle distinguishes submitted, QA failure, rework, finalizing and delivered',async t => {
  const {repo,metadata}=await repository(t);
  const call=(command,args={},actor)=>repo.writeTransaction(tx=>writeOrchestration(tx,{schemaVersion:'1.0',runtimeEpoch:metadata.runtimeEpoch,requestId:randomUUID(),command,args,actor}));
  const capability=()=>randomUUID()+randomUUID();
  const main={kind:'MAIN',...(await call('attach',{entryId:'main',capabilityToken:capability()})).main};
  await call('activate',{projectRoot:'/fixture',authorization:{source:'isolated test',scope:'synthetic tasks',automaticCompletion:true}},main);
  const scheduler={kind:'SCHEDULER',...(await call('scheduler-open',{schedulerId:'schedule',capabilityToken:capability()},main)).scheduler};
  const task=(await call('submit',{kind:'DEVELOP',title:'真实流转验证',goal:'验证流转',scope:'test',acceptance:[{id:'behavior',text:'实际行为'}],inputs:[]},main)).task;
  const read=()=>repo.readTransaction(tx=>readOrchestrationDashboard(tx));
  const claim=async kind=>{const c=await call('claim',{kind,workerId:randomUUID(),capabilityToken:capability()},scheduler);return {...c,actor:{kind:'WORKER',id:c.run.workerId,token:c.run.token}};};
  const artifact={ref:'artifact:synthetic-version',sha256:'a'.repeat(64)};
  const report=(c,result)=>call('report',{runId:c.run.id,result},c.actor);
  const submit=c=>report(c,{status:'SUBMITTED',summary:'候选已提交',artifacts:[artifact]});
  let work=await claim('DEVELOP');await submit(work);
  assert.equal((await read()).processing.find(t=>t.id===task.id).status,'QA_PENDING');
  let qa=await claim('DEVELOP_QA');
  const verdict=(c,status)=>report(c,{status,summary:'合成行为检查',artifactHash:c.task.artifactHash,checks:[{criterionId:'behavior',status,comment:'实际合成行为',evidenceRefs:[artifact.ref]}]});
  await verdict(qa,'FAIL');
  assert.equal((await read()).processing.find(t=>t.id===task.id).status,'REWORK_PENDING');
  assert.equal((await read()).completed.tasks[0].statusLabel,'质检未通过 · 本轮结束');
  work=await claim('DEVELOP');await submit(work);qa=await claim('DEVELOP_QA');await verdict(qa,'PASS');
  assert.equal((await read()).queue.find(t=>t.id===task.id).status,'FINALIZING');
  const delivery=await claim('DEVELOP');await report(delivery,{status:'DELIVERED',summary:'合成回执',artifactHash:delivery.task.artifactHash,artifacts:[artifact],deliveryEvidence:[{ref:'receipt:fixture',sha256:'b'.repeat(64)}]});
  assert.equal((await read()).completed.tasks.find(t=>t.id===task.id).result,'DELIVERED');
  assert.equal((await read()).autoRefresh,false);
});

test('host status is bound to instance, epoch and fresh observation; mode and host are independent',async () => {
  const f=dashboardRecords();
  const tx={getMetadata:async()=>f.metadata,getAux:async()=>({bytes:JSON.stringify(f.config)}),listAux:async()=>[]};
  const read=(heartbeat=f.heartbeat,now=Date.parse(f.at))=>readOrchestrationDashboard(tx,{heartbeat,now});
  assert.equal((await read()).scheduler.hostStatus,'RUNNING');
  for(const heartbeat of [null,{...f.heartbeat,instanceId:'other'},{...f.heartbeat,runtimeEpoch:'old'},{...f.heartbeat,updatedAt:'bad'}])assert.equal((await read(heartbeat)).scheduler.hostStatus,'UNKNOWN');
  assert.equal((await read(f.heartbeat,Date.parse(f.at)+30001)).scheduler.hostStatus,'UNKNOWN');
  assert.equal((await read(f.heartbeat,Date.parse(f.at)-1)).scheduler.hostStatus,'UNKNOWN');
  for(const status of ['ACTIVE','PAUSED','STOPPED']){f.config.status=status;assert.equal((await read()).mode.status,status);assert.equal((await read()).scheduler.hostStatus,'RUNNING');}
  f.config.scheduler.blocked={code:'PRIVATE_CODE',summary:'PRIVATE_SUMMARY',token:'secret'};
  assert.equal((await read()).scheduler.blocked,true);assert.equal((await read()).pools[0].dispatching,false);
  assert.doesNotMatch(JSON.stringify(await read()),/PRIVATE_|secret/);
  assert.equal((await dashboardFixture({empty:true})).autoRefresh,false);
  assert.deepEqual((await dashboardFixture({empty:true})).mode,{enabled:false,status:'STOPPED'});
  assert.equal(dashboardText('检查 /Users/example/private/file.log 已结束'),'检查 [路径已隐藏] 已结束');
  assert.doesNotMatch(dashboardText('Bearer very-private-value'),/very-private-value/);
});

test('runner publishes safe heartbeat through the shared mount; stopped/blocked/paused pumping keeps observable status',async t => {
  const {root,metadata}=await repository(t), privateRoot=await privateDirectory(root);
  const runner=new OrchestrationRunner({instanceRoot:root,privateRoot,instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,projectRoot:'/PRIVATE_PROJECT',ledger:{read:async()=>({...metadata,tasks:[],runs:[],config:{status:'PAUSED'}})}});
  runner.active.set('run',{kind:'DEVELOP',taskId:'task',runId:'run',adapter:{token:'PRIVATE_ADAPTER'}});
  await runner.save('RUNNING',{error:'PRIVATE_ERROR'});
  const heartbeat=await readOrchestrationHeartbeat(root);
  assert.equal(heartbeat.status,'RUNNING');assert.deepEqual(heartbeat.active,[{kind:'DEVELOP',taskId:'task',runId:'run'}]);
  assert.doesNotMatch(JSON.stringify(heartbeat),/PRIVATE|pid|projectRoot|token|adapter|error/);
  await runner.pump();assert.equal((await readOrchestrationHeartbeat(root)).status,'RUNNING');
  runner.schedulerSuspended=true;await runner.pump();assert.equal((await readOrchestrationHeartbeat(root)).status,'BLOCKED');
  await runner.save('STOPPED');assert.equal((await readOrchestrationHeartbeat(root)).status,'STOPPED');
  const filename=path.join(root,'runtime/locks/orchestration-health.json');
  await writeFile(filename,'not-json');assert.equal(await readOrchestrationHeartbeat(root),null);
  await rm(filename);await symlink(path.join(root,'review.sqlite'),filename);assert.equal(await readOrchestrationHeartbeat(root),null);
  const foreign=path.join(root,'foreign');await mkdir(foreign);await symlink(path.join(root,'runtime'),path.join(foreign,'runtime'));
  await assert.rejects(writeOrchestrationHeartbeat(foreign,{...metadata,status:'RUNNING',active:[]}));
  assert.equal(await readOrchestrationHeartbeat(undefined),null);
  assert.ok((await readFile(path.join(privateRoot,'runner-state.json'),'utf8')).includes('PRIVATE_PROJECT'));
});
