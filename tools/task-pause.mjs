import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {location,readLedger,readBindings,requireRun,requireTask,withRuntime,mutate,runtimeState} from './task-ledger.mjs';
import {durableExecutionFile as atomic} from './execution-runtime.mjs';
import {processLock,processAlive,processIdentity,phaseRecords,openPhase} from './process-resources.mjs';
import {readPause,writePause,pauseBlocks,pauseScope,assertPauseTarget,pauseHash,readPauseFile,capturePauseWorkspace,verifyPauseWorkspace} from './task-pause-state.mjs';
import {pauseBackend,syncBackend,pausedCheckpointResult} from './task-backend.mjs';

const at=()=>new Date().toISOString();
const key=(taskId,assignmentId)=>assignmentId||taskId;
const checkpointPath=(loc,p,id)=>path.join(loc.runtime,'pauses',p.id,'checkpoints',id+'.json');
export async function requestPause(project,runId) {
  return withRuntime(project,async loc=>{
    const old=await readPause(loc);
    if(pauseBlocks(old)&&[old.runId,...(old.ownerRunIds||[])].includes(runId))return {...old,replayed:true};
    const run=await requireRun(loc,runId,{converging:true});
    requireTask(!pauseBlocks(old),'PAUSE_OWNER_CHANGED：已有其他协调者的暂停周期');
    const ledger=await readLedger(loc),bindings=await readBindings(loc);
    const p={schemaVersion:1,id:randomUUID(),runId,status:'PAUSING',requestedAt:at(),targets:pauseScope(ledger.tasks,bindings,runId),checkpoints:{},issues:[],history:'PRESERVED'};
    // Both readers and every execution admission share ledger.lock. The gate
    // survives a crash before run.json is updated.
    await writePause(loc,p);
    run.stopRequested=true;run.pauseId=p.id;await atomic(path.join(loc.runtime,'run.json'),run);
    return p;
  });
}

// This is a cooperative, explicit checkpoint, never a claim to read a main
// coordinator's unsaved reasoning. It authorizes interruption at this boundary
// only. It is neither a decision answer nor authorization for a new operation.
export async function savePauseCheckpoint(project,runId,request) {
  const loc=await location(project),p=await readPause(loc);
  requireTask(p?.id===request.pauseId&&p.status!=='RESUMED','PAUSE_ID：须使用当前暂停编号');
  const ledger=await readLedger(loc);
  const {resolveTaskId}=await import('./task-numbering.mjs');
  const taskId=resolveTaskId(ledger.tasks,request.taskId),id=key(taskId,request.assignmentId);
  assertPauseTarget(p,taskId,request.assignmentId);
  const existing=await readPauseFile(checkpointPath(loc,p,id));
  if(existing?.operationId===request.operationId)requireTask(existing.requestHash===pauseHash(request),'PAUSE_REPLAY_CONFLICT');
  if(p.status==='PAUSED'){
    requireTask(existing?.operationId===request.operationId,'PAUSE_CHECKPOINT_FROZEN：已验证暂停的检查点只读');
    return {status:'PAUSED',pauseId:p.id,checkpointId:id,replayed:true};
  }
  requireTask(request.quiescent===true&&typeof request.evidence==='string'&&request.evidence.trim(),'PAUSE_CHECKPOINT_REQUIRED：协调者须确认已落盘可中断边界及不再执行新步骤');
  const cp=request.checkpoint;
  requireTask(cp&&['completedSteps','nextSteps','inputs','artifacts','operations'].every(k=>Array.isArray(cp[k]))&&cp.inputs.length,'PAUSE_CHECKPOINT_REQUIRED：需要完整步骤、精确输入、成果和原操作清单');
  const previous=(request.assignmentId?ledger.tasks[taskId]?.assignments?.find(a=>a.id===request.assignmentId):ledger.tasks[taskId])?.checkpoint;
  for(const field of ['completedSteps','artifacts','inputs'])requireTask((previous?.[field]||[]).every(value=>cp[field].includes(value)),'PAUSE_CHECKPOINT_LOSS：不能丢弃已保存的 '+field);
  const workspace=await capturePauseWorkspace(request.workspace);
  const originalBinding=(await readBindings(loc)).assignments[request.assignmentId];
  if(originalBinding?.workspace)requireTask(workspace.spec.path===originalBinding.workspace,'PAUSE_WORKSPACE_BINDING：检查点必须引用原派工工作区');
  if(originalBinding?.backendRequest?.baseCommit)requireTask(workspace.spec.baseCommit===originalBinding.backendRequest.baseCommit,'PAUSE_VERSION_BINDING：须保留原执行的精确基准提交');
  const result=await mutate(project,request.assignmentId?'assignment:checkpoint':'checkpoint',{
    operationId:request.operationId,actor:request.actor,runId,taskId,assignmentId:request.assignmentId,
    expectedVersions:request.expectedVersions,expectedAssignmentVersion:request.expectedAssignmentVersion,checkpoint:cp,
  });
  return withRuntime(project,async current=>{
    await requireRun(current,runId,{converging:true});const pause=await readPause(current),state=await readLedger(current),bindings=await readBindings(current);
    assertPauseTarget(pause,taskId,request.assignmentId);requireTask(pause.id===request.pauseId,'PAUSE_ID_CHANGED');
    const task=state.tasks[taskId],assignment=task.assignments?.find(a=>a.id===request.assignmentId),target=assignment||task;
    requireTask(pauseHash(target.checkpoint)===pauseHash(cp),'PAUSE_CHECKPOINT_CHANGED：检查点已被其他写入改变');
    requireTask((assignment?bindings.assignments[id]?.runId:bindings.tasks[id]||task.runId)===runId,'PAUSE_OWNER_CHANGED：不能替其他执行者保存停止边界');
    const prior=await readPauseFile(checkpointPath(current,pause,id));
    const requestHash=pauseHash(request);
    if(prior?.operationId===request.operationId){requireTask(prior.requestHash===requestHash,'PAUSE_REPLAY_CONFLICT');return {status:pause.status,pauseId:pause.id,checkpointId:id,replayed:true};}
    requireTask(pause.status!=='PAUSED','PAUSE_CHECKPOINT_FROZEN：已验证暂停的检查点只读');
    const saved={pauseId:pause.id,taskId,assignmentId:request.assignmentId||null,operationId:request.operationId,requestHash,
      taskVersion:task.version,assignmentVersion:assignment?.version||null,checkpoint:cp,workspace,evidence:request.evidence,savedAt:at()};
    await atomic(checkpointPath(current,pause,id),saved);
    pause.checkpoints[id]={hash:pauseHash(saved),operationId:request.operationId};pause.status='PAUSING';
    await writePause(current,pause);return {...result,status:'CHECKPOINT_SAVED',pauseId:pause.id,checkpointId:id};
  });
}

async function savedCheckpoints(loc,p,ledger) {
  const saved={};
  for(const t of p.targets)for(const id of [t.taskId,...t.assignmentIds]){
    const cp=await readPauseFile(checkpointPath(loc,p,id));
    requireTask(cp&&pauseHash(cp)===p.checkpoints[id]?.hash,'PAUSE_CHECKPOINT_REQUIRED：尚未保存 '+id+' 的可中断检查点');
    const task=ledger.tasks[t.taskId],target=id===t.taskId?task:task?.assignments?.find(a=>a.id===id);
    requireTask(target&&pauseHash(target.checkpoint)===pauseHash(cp.checkpoint),'PAUSE_CHECKPOINT_CHANGED：'+id);
    saved[id]=cp;
  }
  return saved;
}

async function phasesFor(loc,p) {
  const ledger=await readLedger(loc),ids=new Set(p.targets.flatMap(t=>[t.taskId,ledger.tasks[t.taskId]?.displayId]).filter(Boolean));
  const rows=(await phaseRecords(loc.root)).filter(({record:r})=>ids.has(r.formalTaskId)||ids.has(r.taskId));
  for(const {record:r} of rows)requireTask(r.projectId===loc.projectId&&['local','fixture'].includes(r.host),'PAUSE_PROCESS_OWNER_UNKNOWN：受管阶段不属于本机实例');
  return rows;
}
async function preservePhases(loc,p,rows) {
  for(const {record:r} of rows){
    const phase=await openPhase({root:loc.root,taskId:r.taskId,phaseId:r.phaseId,token:r.token});
    await phase.update(record=>{
      record.pauseRetention||={pauseId:p.id,reason:'保留最近安全检查点的原工作区及恢复输入；由协调者整合验收后解除',at:at()};
      for(const resource of record.resources)if(resource.kind==='path'&&!['REMOVED','RETAINED'].includes(resource.state)){
        requireTask(resource.state!=='INTENT','PAUSE_RESOURCE_UNKNOWN：目录创建结果待核查');
        resource.state='RETAINED';resource.reason='pause '+p.id+' checkpoint recovery';
      }
    });
  }
}

// Record descendants and the original command's process group before signalling
// its runner. A dead leader does not imply that background children stopped.
function processTree(owner,child) {
  const rows=execFileSync('ps',['-axo','pid=,ppid=,pgid=,stat='],{encoding:'utf8',timeout:10000}).trim().split('\n').map(s=>s.trim().split(/\s+/)).filter(x=>x.length>=4).map(([pid,ppid,pgid,stat])=>({pid:Number(pid),ppid:Number(ppid),pgid:Number(pgid),stat}));
  const ids=new Set([owner?.pid,child?.pid].filter(Boolean));
  let more=true;while(more){more=false;for(const r of rows)if(!ids.has(r.pid)&&(ids.has(r.ppid)||child?.pid===r.pgid)){ids.add(r.pid);more=true;}}
  return rows.filter(r=>ids.has(r.pid)&&!r.stat.includes('Z')).map(r=>processIdentity(r.pid)).filter(Boolean);
}
async function stopOwnedProcesses(loc,p,rows,state) {
  const records=[...rows.filter(({record:r})=>r.status==='RUNNING'||r.child).map(({record:r})=>({owner:r.owner,child:r.child,label:r.taskId+'/'+r.phaseId})),
    ...state.activities.map(a=>{requireTask(a.runId===p.runId||a.runId===state.run?.id,'PAUSE_PROCESS_OWNER_UNKNOWN：旧受管命令尚未接续归属');requireTask(a.live!==null,'PAUSE_PROCESS_OWNER_UNKNOWN');return {...a,label:a.assignmentId||'main'};})];
  const issues=[];
  for(const r of records){
    requireTask(r.owner?.pid&&r.owner.birth,'PAUSE_PROCESS_OWNER_UNKNOWN：缺少原命令身份');
    const file=path.join(loc.runtime,'pauses',p.id,'stops',pauseHash({owner:r.owner,child:r.child||null})+'.json');
    let intent=await readPauseFile(file);
    const live=processAlive(r.owner)||processAlive(r.child);
    if(!intent&&live){
      const tracked=processTree(r.owner,r.child);
      intent={label:r.label,owner:r.owner,child:r.child||null,tracked,state:'PENDING',at:at()};await atomic(file,intent);
      // Never signal this verification process or an inferred/reused PID.
      if(processAlive(r.owner)&&r.owner.pid!==process.pid)process.kill(r.owner.pid,'SIGTERM');
      else if(!processAlive(r.owner)&&processAlive(r.child)&&r.child.pid!==process.pid)process.kill(r.child.pid,'SIGTERM');
      intent={...intent,state:'SENT',sentAt:at()};await atomic(file,intent);
    }
    if(live||(intent?.tracked||[]).some(processAlive))issues.push({code:'PAUSING',target:r.label,reason:'原受管命令或后台子进程仍活跃；停止请求只发送一次'});
  }
  // Include orphaned descendants even if their activity/phase record vanished.
  const {readdir}=await import('node:fs/promises');
  for(const name of await readdir(path.join(loc.runtime,'pauses',p.id,'stops')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
    const intent=await readPauseFile(path.join(loc.runtime,'pauses',p.id,'stops',name));
    if(intent.tracked?.some(processAlive))issues.push({code:'PAUSING',target:intent.label,reason:'已登记停止树仍有活动进程'});
  }
  return issues;
}

function uncertainOperations(cp,b) {
  return cp.operations.filter(o=>['PENDING','RESULT_UNKNOWN'].includes(o.status)&&
    !(o.id===b?.backendRequest?.operationId&&['SUCCEEDED','FAILED'].includes(b.backendRequest.state)));
}
export async function verifyPause(project,runId,{pauseAgent=pauseBackend,syncAgent=syncBackend}={}) {
  const loc=await location(project);
  return processLock(path.join(loc.runtime,'pause-verify.lock'),async()=>{
    await requireRun(loc,runId,{converging:true});let p=await readPause(loc);
    requireTask(pauseBlocks(p),'PAUSE_NOT_REQUESTED');
    if(p.status==='PAUSED'){
      try{
        const snapshot=await readPauseFile(path.join(loc.runtime,'pauses',p.id,'checkpoint.json'));
        requireTask(snapshot&&pauseHash(snapshot)===p.snapshot?.hash,'PAUSE_CHECKPOINT_INTEGRITY');
        for(const cp of Object.values(snapshot.checkpoints))await verifyPauseWorkspace(cp.workspace);
        requireTask(!(await runtimeState(project)).activities.some(a=>a.live!==false),'PAUSE_PROCESS_ACTIVE');
        requireTask(!(await phasesFor(loc,p)).some(({record:r})=>processAlive(r.child)||r.status==='RUNNING'&&processAlive(r.owner)),'PAUSE_PROCESS_ACTIVE');
        for(const t of p.targets)for(const id of t.assignmentIds){
          const b=(await readBindings(loc)).assignments[id];
          if(b?.nativeThreadId)await pauseAgent(project,runId,id,p.id);
        }
        return p;
      }catch(error){
        p.status='PAUSE_UNVERIFIED';p.issues=[{code:'PAUSE_RECEIPT_DRIFT',reason:error.message}];await withRuntime(project,current=>writePause(current,p));return p;
      }
    }
    const issues=[],ledger=await readLedger(loc),bindings=await readBindings(loc);let checkpoints;
    try{checkpoints=await savedCheckpoints(loc,p,ledger);}catch(e){issues.push({code:'CHECKPOINT_REQUIRED',reason:e.message});}
    // No destructive stop until every coordinator/worker recovery boundary has
    // been explicitly saved. Admissions are already fenced while waiting.
    if(checkpoints){
      try{
        const rows=await phasesFor(loc,p);await preservePhases(loc,p,rows);
        issues.push(...await stopOwnedProcesses(loc,p,rows,await runtimeState(project)));
      }catch(e){issues.push({code:'PROCESS_UNVERIFIED',reason:e.message});}
      for(const t of p.targets)for(const id of t.assignmentIds){
        const a=ledger.tasks[t.taskId]?.assignments?.find(a=>a.id===id),b=bindings.assignments[id];
        if(a?.status==='CLOSED')continue;
        if(b?.runId!==runId){issues.push({code:'OWNER_UNVERIFIED',target:id,reason:'原派工归属尚未核查'});continue;}
        if(a.execution.mode==='SUBAGENT'){
          try{await pauseAgent(project,runId,id,p.id);if(b.backendRequest)await syncAgent(project,runId,id);}
          catch(e){issues.push({code:'AGENT_UNVERIFIED',target:id,reason:e.message});}
        }
      }
    }
    return withRuntime(project,async current=>{
      await requireRun(current,runId,{converging:true});const now=await readPause(current);
      requireTask(now.id===p.id,'PAUSE_ID_CHANGED');p=now;
      const latest=await readLedger(current),b=await readBindings(current);
      if(checkpoints)try{
        checkpoints=await savedCheckpoints(current,p,latest);
        for(const cp of Object.values(checkpoints)){
          // Recapture after all writes stopped. The cooperative checkpoint pins
          // HEAD, directory identity and its declared file set; changes made by
          // the interrupted original execution are retained in this final image.
          const workspace=await capturePauseWorkspace(cp.workspace.spec);
          requireTask(workspace.dev===cp.workspace.dev&&workspace.ino===cp.workspace.ino,'PAUSE_WORKSPACE_IDENTITY');
          cp.workspace=workspace;
          if(uncertainOperations(cp.checkpoint,b.assignments[cp.assignmentId]).length)issues.push({code:'OPERATION_UNVERIFIED',target:cp.assignmentId||cp.taskId,reason:'PENDING/RESULT_UNKNOWN 原操作须先核查'});
        }
        for(const target of p.targets)for(const id of target.assignmentIds){
          const a=latest.tasks[target.taskId].assignments.find(a=>a.id===id),binding=b.assignments[id];
          if(a.status!=='CLOSED'&&a.execution.mode==='SUBAGENT')requireTask(binding.pauseReceipt?.verified&&binding.pauseReceipt.pauseId===p.id,'PAUSE_RECEIPT_REQUIRED：'+id);
        }
      }catch(e){issues.push({code:'CHECKPOINT_UNVERIFIED',reason:e.message});}
      if(!issues.length){
        const snapshot={schemaVersion:1,pauseId:p.id,originRunId:p.runId,createdAt:at(),targets:p.targets,
          checkpoints,tasks:p.targets.map(t=>latest.tasks[t.taskId]),bindings:{tasks:Object.fromEntries(p.targets.map(t=>[t.taskId,b.tasks[t.taskId]])),assignments:Object.fromEntries(p.targets.flatMap(t=>t.assignmentIds.map(id=>[id,b.assignments[id]])))},processes:await phasesFor(current,p)};
        const file=path.join(current.runtime,'pauses',p.id,'checkpoint.json');await atomic(file,snapshot);
        requireTask(pauseHash(await readPauseFile(file))===pauseHash(snapshot),'PAUSE_CHECKPOINT_READBACK');
        p.snapshot={hash:pauseHash(snapshot)};p.status='PAUSED';p.verifiedAt=at();p.verifiedByRunId=runId;
      }else p.status=issues.every(i=>['PAUSING','CHECKPOINT_REQUIRED'].includes(i.code))?'PAUSING':'PAUSE_UNVERIFIED';
      p.issues=issues;p.checkedAt=at();await writePause(current,p);return p;
    });
  });
}

export async function resumePausedRun(project,runId,{syncAgent=syncBackend,pauseAgent=pauseBackend}={}) {
  const loc=await location(project),p=await readPause(loc);
  if(!pauseBlocks(p))return {status:'NO_PAUSED_TASK'};
  return processLock(path.join(loc.runtime,'pause-verify.lock'),async()=>{
    const run=await requireRun(loc,runId,{converging:true});
    requireTask(run.id!==p.runId,'PAUSE_OLD_RUN_ALIVE：原协调运行退出后再 task run');
    const old=await readPauseFile(path.join(loc.runtime,'runs',p.runId+'.json'));
    requireTask(old?.host===os.hostname()&&old.root===loc.root&&old.projectId===loc.projectId&&old.owner?.birth&&!processAlive(old.owner),'PAUSE_OLD_RUN_ALIVE：原协调者未明确停止');
    // Recover even an interrupted pause transaction. Ownership is limited to
    // convergence until the saved checkpoint and every original execution pass.
    await withRuntime(project,async current=>{
      const now=await readPause(current),bindings=await readBindings(current),ledger=await readLedger(current);
      requireTask(now.id===p.id&&pauseBlocks(now),'PAUSE_ID_CHANGED');
      const owners=new Set([p.runId,...(now.ownerRunIds||[]),runId]);
      const checkOwner=async id=>{
        requireTask(owners.has(id),'PAUSE_OWNER_CAS：原工作归属已改变');
        if(id===runId)return;
        const r=await readPauseFile(path.join(current.runtime,'runs',id+'.json'));
        requireTask(r?.host===os.hostname()&&r.root===current.root&&r.projectId===current.projectId&&r.owner?.birth&&!processAlive(r.owner),'PAUSE_OLD_RUN_ALIVE：旧执行者仍存活或身份未知');
      };
      for(const t of now.targets){
        requireTask(ledger.tasks[t.taskId]&&!['DONE','CANCELLED','MERGED'].includes(ledger.tasks[t.taskId].status),'PAUSE_TASK_TERMINAL');
        await checkOwner(bindings.tasks[t.taskId]||ledger.tasks[t.taskId].runId);
        for(const id of t.assignmentIds)await checkOwner(bindings.assignments[id]?.runId);
      }
      now.ownerRunIds=[...owners];await writePause(current,now);
      for(const t of now.targets){
        bindings.tasks[t.taskId]=runId;
        for(const id of t.assignmentIds){const b=bindings.assignments[id];if(b.runId!==runId){b.ownershipHistory||=[];b.ownershipHistory.push({fromRunId:b.runId,toRunId:runId,pauseId:p.id,converging:true,at:at()});b.runId=runId;}}
      }
      await atomic(path.join(current.runtime,'bindings.json'),bindings);
    });
    if(p.status!=='PAUSED')return {status:p.status,pauseId:p.id,runId,issues:p.issues,instruction:'已核查旧协调者并只接续收敛归属；补存 checkpoint 后 pause verify，禁止自动重跑'};
    const snapshot=await readPauseFile(path.join(loc.runtime,'pauses',p.id,'checkpoint.json'));
    requireTask(snapshot&&pauseHash(snapshot)===p.snapshot?.hash,'PAUSE_CHECKPOINT_INTEGRITY');
    for(const cp of Object.values(snapshot.checkpoints))await verifyPauseWorkspace(cp.workspace);
    requireTask(!(await stopOwnedProcesses(loc,p,await phasesFor(loc,p),await runtimeState(project))).length,'PAUSE_PROCESS_ACTIVE：原执行仍活跃');
    // Ownership CAS under the admission lock. Do not run assignment:reconcile:
    // that is interrupted/finished-work recovery, which deliberately blocks and
    // retires workers. This protocol preserves the same unfinished assignment.
    await withRuntime(project,async current=>{
      await requireRun(current,runId,{converging:true});const latest=await readLedger(current),bindings=await readBindings(current);
      for(const t of p.targets){
        requireTask([p.runId,runId].includes(bindings.tasks[t.taskId]),'PAUSE_OWNER_CAS');
        requireTask(!['DONE','CANCELLED','MERGED'].includes(latest.tasks[t.taskId]?.status),'PAUSE_TASK_TERMINAL');
        for(const id of [t.taskId,...t.assignmentIds]){
          const cp=snapshot.checkpoints[id],a=latest.tasks[t.taskId].assignments?.find(a=>a.id===id),target=a||latest.tasks[t.taskId];
          requireTask(pauseHash(target.checkpoint)===pauseHash(cp.checkpoint),'PAUSE_CHECKPOINT_CHANGED');
          if(!a)continue;
          const b=bindings.assignments[id],saved=snapshot.bindings.assignments[id];
          requireTask(b&&[p.runId,runId].includes(b.runId)&&!b.retiredAt&&a.status!=='CLOSED','PAUSE_OWNER_CAS：原派工已关闭或归属变化');
          requireTask(pauseHash(b.closureReceipt||null)===pauseHash(saved.closureReceipt||null),'PAUSE_CLOSURE_CHANGED');
          requireTask(b.nativeThreadId===saved.nativeThreadId&&b.backendRequest?.operationId===saved.backendRequest?.operationId,'PAUSE_OPERATION_CAS');
          if(b.runId!==runId){b.ownershipHistory||=[];b.ownershipHistory.push({fromRunId:b.runId,toRunId:runId,pauseId:p.id,at:at()});b.runId=runId;}
        }
        bindings.tasks[t.taskId]=runId;
      }
      await atomic(path.join(current.runtime,'bindings.json'),bindings);
    });
    const latest=await readLedger(loc),bindings=await readBindings(loc);
    for(const t of p.targets)for(const id of t.assignmentIds){
      if(bindings.assignments[id]?.nativeThreadId)await pauseAgent(project,runId,id,p.id);
      if(!bindings.assignments[id]?.backendRequest)continue;
      const result=await syncAgent(project,runId,id);
      requireTask(['SUCCEEDED','FAILED'].includes(result.executionStatus||result.status),'PAUSE_OPERATION_UNVERIFIED：先查询原轮次，不重跑');
    }
    return withRuntime(project,async current=>{
      const run=await requireRun(current,runId,{converging:true}),pause=await readPause(current);
      requireTask(pause.id===p.id&&pause.status==='PAUSED','PAUSE_ID_CHANGED');
      // Recheck file/CAS facts after original-operation observation.
      for(const cp of Object.values(snapshot.checkpoints))await verifyPauseWorkspace(cp.workspace);
      const b=await readBindings(current);
      for(const cp of Object.values(snapshot.checkpoints))requireTask(!uncertainOperations(cp.checkpoint,b.assignments[cp.assignmentId]).length,'PAUSE_OPERATION_UNVERIFIED');
      const plans=await Promise.all(Object.values(snapshot.checkpoints).map(async cp=>({taskId:cp.taskId,assignmentId:cp.assignmentId,...await pausedCheckpointResult(current,cp,b.assignments[cp.assignmentId])})));
      pause.status='RESUMED';pause.resumedAt=at();pause.resumedByRunId=runId;
      run.stopRequested=false;run.pauseId=null;run.expiresAt=new Date(Date.now()+600000).toISOString();
      await atomic(path.join(current.runtime,'run.json'),run);await writePause(current,pause);
      return {status:'CHECKPOINT_READY',pauseId:p.id,runId,checkpoints:plans,
        decisions:p.targets.flatMap(t=>(latest.tasks[t.taskId].assignments||[]).flatMap(a=>a.decisions||[])),instruction:'从 nextSteps 继续；保留已完成步骤、成果及原操作。未完成子派工可 backend continue 使用保存的暂停输入；待决问题仍须原用户答复。'};
    });
  }).catch(async error=>{
    await withRuntime(project,async current=>{const pause=await readPause(current);if(pause?.id===p.id&&pauseBlocks(pause)){pause.status='PAUSE_UNVERIFIED';pause.issues=[{code:'RECOVERY_UNVERIFIED',reason:error.message}];await writePause(current,pause);}});
    throw error;
  });
}

export async function pauseAction(project,action,runId,request={}) {
  if(action==='checkpoint')return savePauseCheckpoint(project,runId,request);
  if(action==='status')return readPause(await location(project));
  if(action==='verify')return verifyPause(project,runId);
  requireTask(!action,'未知 pause 操作');const p=await requestPause(project,runId);
  if(p.replayed&&p.status==='PAUSED')return p;
  return verifyPause(project,runId);
}
