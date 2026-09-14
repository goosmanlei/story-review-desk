import {compareTaskPublication} from './task-numbering.mjs';
import path from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
import {taskCapacity,taskCapacityReason,requireTaskCapacity} from './task-capacity.mjs';
import {pendingDecisions} from './task-decision-protocol.mjs';
import {resources,conflicts,resourcesWithin,assignmentRole,assignmentNodes,findAssignment,assignmentAncestors,assignmentDescendants} from './task-tree.mjs';
export {resources,conflicts} from './task-tree.mjs';

// Logical reservations are durable. Native thread IDs, worktrees and leases live
// in runtime bindings and are deliberately never copied into these records.
const demand = (ok, message) => { if (!ok) throw Error(message); };
const nonempty = (v, name) => demand(typeof v === 'string' && v.trim() && v.length <= 30000, `${name}须为非空文本`);
const strings = (v, name) => { demand(Array.isArray(v) && v.length && v.length <= 200, `${name}须为非空数组`); v.forEach(x => nonempty(x, name)); return v; };
export const modelPolicy = {
  LOOKUP: {model:'gpt-5.6-luna', effort:'medium'},
  RESEARCH: {model:'gpt-5.6-terra', effort:'high'},
  IMPLEMENTATION: {model:'gpt-5.6-sol', effort:'xhigh'},
  HIGH_RISK: {model:'gpt-6-astra', effort:'max'},
};
export const assignmentOpen = a => a.status !== 'CLOSED';
export const assignmentUnknown = a => (a.checkpoint?.operations || []).some(o => ['PENDING','RESULT_UNKNOWN'].includes(o.status))||(a.interventions||[]).some(i=>['PENDING','RESULT_UNKNOWN'].includes(i.status));

export function chooseExecution(spec, capabilities) {
  nonempty(spec?.rationale, '模型与强度选择理由');
  if (!capabilities?.delegation || !capabilities?.closeVerified) {
    return {mode:'MAIN', model:'INHERIT', effort:'INHERIT', goalMode:'NONE', rationale:spec.rationale,
      limitation:capabilities?.limitation || '尚未验证原生 Agent 关闭能力，主 Agent 串行执行'};
  }
  if (spec.mode === 'MAIN') return {mode:'MAIN',model:'INHERIT',effort:'INHERIT',goalMode:'NONE',rationale:spec.rationale};
  const preferred = modelPolicy[spec.workClass || 'IMPLEMENTATION'];
  demand(preferred, '未知模型工作类别');
  const model=spec.model || preferred.model, effort=spec.effort || preferred.effort;
  demand(capabilities.models?.some(m => m.model===model && m.efforts.includes(effort)), '所选模型或推理强度未在本次运行验证可用');
  return {mode:'SUBAGENT',model,effort,rationale:spec.rationale,
    goalMode:spec.longRunning ? capabilities.goalVerified ? 'NATIVE' : 'FOLLOWUP' : 'NONE',
    ...(spec.longRunning&&!capabilities.goalVerified?{limitation:'原生子 Goal 未验证；仅在同一未完成派工内 followup'}:{})};
}

export async function assignmentMutation(ctx) {
  const {action,request,tasks,at,touch,get,requireRun,bindings,checkpoint,complete,active,capabilities,idFor,root,decisionBlocked}=ctx;
  await requireRun();
  const v3=ctx.schemaVersion>=3;
  const all=()=>assignmentNodes(tasks);
  const find=id=>findAssignment(tasks,id);
  const owner=a=>demand(ctx.executionAuthority||bindings.assignments[a.id]?.runId===request.runId,'派工不属于当前执行会话；先核查恢复');
  const hostLimit=()=>v3?capabilities.capacityScope==='GLOBAL'?capabilities.agentCapacity:null:capabilities.agentCapacity??capabilities.availableSlots??0;
  const hostFull=open=>hostLimit()!==null&&open.filter(x=>x.assignment.execution.mode==='SUBAGENT').length>=Math.max(0,hostLimit());
  const bump=(t,a)=>{touch(t);a.version++;a.updatedAt=at;};
  if (action === 'schedule'||action==='assignment:schedule') {
    const child=action==='assignment:schedule';
    demand(!child||v3,'子执行树要求 v3 账本');
    const parent=child?find(request.parentAssignmentId)?.assignment:null;
    if(child){
      demand(parent&&parent.taskId===request.taskId,'ASSIGNMENT_PARENT_SCOPE：父节点须属于指定正式任务');
      demand(request.authority?.assignmentId===parent.id&&ctx.executionAuthority,'EXECUTION_AUTHORITY：子派工必须使用原父节点执行授权');
      demand(parent.status==='RUNNING'&&!assignmentUnknown(parent)&&!pendingDecisions(parent).length&&!await decisionBlocked?.(parent.id),'ASSIGNMENT_PARENT_BLOCKED：父节点未处于可派工状态');
    }
    demand(Array.isArray(request.assignments) && request.assignments.length && request.assignments.length<=50, 'schedule 须提供 1–50 项候选派工');
    const seen=new Set();
    const candidates=request.assignments.map(s=>{
      const t=get(s.taskId||request.taskId); nonempty(s.key,'assignment.key');
      if(v3)demand(child?(!s.role||s.role==='SUBAGENT')&&(!s.parentAssignmentId||s.parentAssignmentId===parent.id)&&t.id===parent.taskId:(!s.role||s.role==='WORKER')&&!s.parentAssignmentId,'ASSIGNMENT_PARENT_SCOPE：协调者只调度 WORKER，子节点只由原父节点派工');
      demand(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s.key),'派工 key 无效');
      const k=t.id+':'+s.key;demand(!seen.has(k),'候选派工 key 重复');seen.add(k);
      nonempty(s.goal,'assignment.goal');strings(s.deliverables,'assignment.deliverables');strings(s.acceptanceCriteria,'assignment.acceptanceCriteria');
      const rs=resources(s.resources), execution=chooseExecution(s.execution,capabilities);
      if(child){demand(resourcesWithin(rs,parent.resources),'RESOURCE_SCOPE：子节点超出父节点资源范围');demand(execution.mode==='SUBAGENT','HOST_CAPABILITY：子节点需要已验证的原生创建和关闭能力');}
      demand(Array.isArray(s.dependsOn||[]),'派工依赖须为数组');
      for(const d of s.dependsOn||[]){demand(find(d),'派工依赖不存在');if(child)demand(find(d).task.id===t.id,'ASSIGNMENT_PARENT_SCOPE：子节点依赖须属于同一正式任务');}
      if(s.attemptOf) demand(find(s.attemptOf)?.task.id===t.id && find(s.attemptOf).assignment.status==='CLOSED','重派必须引用本任务已关闭的派工');
      demand(!(t.assignments||[]).some(a=>a.key===s.key && assignmentOpen(a)), '同一派工尚未关闭，不能重复调度');
      return {s,t,rs,execution};
    }).sort((a,b)=>a.t.priority-b.t.priority||compareTaskPublication(a.t,b.t)||a.s.key.localeCompare(b.s.key));
    const selected=[], deferred=[];
    for (const {s,t,rs,execution} of candidates) {
      let reason=null;
      const open=all().filter(x=>assignmentOpen(x.assignment));
      if (!['READY','RUNNING'].includes(t.status) || t.children?.length) reason='TASK_NOT_EXECUTABLE';
      else if (!t.dependencies.every(d=>complete(tasks,d))) reason='DEPENDENCY';
      else if (v3&&!child&&(t.assignments||[]).some(a=>assignmentOpen(a)&&assignmentRole(a)==='WORKER')) reason='WORKER_EXISTS';
      else if (!child&&t.status==='RUNNING' && bindings.tasks[t.id]!==request.runId) reason='RECOVERY_REQUIRED';
      else if ((t.checkpoint?.operations||[]).some(o=>['PENDING','RESULT_UNKNOWN'].includes(o.status))) reason='RESULT_UNKNOWN';
      else if ((s.dependsOn||[]).some(d=>{const a=find(d).assignment;return a.status!=='CLOSED'||a.outcome!=='ACCEPTED';})) reason='ASSIGNMENT_DEPENDENCY';
      else if (open.some(x=>!(child&&[parent,...assignmentAncestors(tasks,parent.id)].some(a=>a.id===x.assignment.id))&&conflicts(rs,x.assignment.resources))) reason='RESOURCE_CONFLICT';
      else if (child&&(await Promise.all([parent,...assignmentAncestors(tasks,parent.id)].map(a=>ctx.resourceActive?.(a.id,rs)))).some(Boolean)) reason='ANCESTOR_RESOURCE_ACTIVE';
      else if (Object.values(tasks).some(x=>x.status==='RUNNING'&&!x.assignments?.length)) reason='LEGACY_EXCLUSIVE';
      else if (taskCapacityReason(tasks,t.id)) reason='TASK_CAPACITY';
      else if (execution.mode==='MAIN' && open.some(x=>x.assignment.execution.mode==='MAIN'&&x.assignment.status!=='BLOCKED')) reason='MAIN_CAPACITY';
      else if (execution.mode==='SUBAGENT' && hostFull(open)) reason='AGENT_CAPACITY';
      if (reason) {deferred.push({taskId:t.id,key:s.key,reason});continue;}
      const id=idFor(t.id+':'+s.key), a={id,key:s.key,taskId:t.id,...(v3?{role:child?'SUBAGENT':'WORKER',parentAssignmentId:parent?.id||null,rootAssignmentId:parent?.rootAssignmentId||parent?.id||id}:{}),version:1,status:'RESERVED',goal:s.goal,
        deliverables:s.deliverables,acceptanceCriteria:s.acceptanceCriteria,resources:rs,execution,
        dependsOn:s.dependsOn||[],attemptOf:s.attemptOf||null,createdAt:at,updatedAt:at,startedAt:null,
        deliveredAt:null,acceptedAt:null,closedAt:null,checkpoint:null,result:null};
      touch(t);t.assignments ||= [];t.assignments.push(a);t.status='RUNNING';t.startedAt ||= at;t.blockReason=null;
      const runId=child?bindings.assignments[parent.id].runId:request.runId;
      delete t.runId;if(!child)bindings.tasks[t.id]=runId;bindings.assignments[id]={runId,originRunId:runId,dispatchIntentAt:at};
      if(v3)ctx.issueAuthority(a,bindings.assignments[id],capabilities);
      selected.push(a);
    }
    return {status:selected.length?'SCHEDULED':'NO_EXECUTABLE_ASSIGNMENT',assignments:selected,deferred,capacity:taskCapacity(tasks)};
  }
  const t=get(request.taskId), a=t.assignments?.find(x=>x.id===request.assignmentId);
  demand(a,'派工不存在');demand(a.version===request.expectedAssignmentVersion,`派工版本冲突：当前为 ${a.version}`);
  demand(assignmentOpen(a),'已关闭派工只读；返工或新任务须重新调度新的 Agent');
  const binding=bindings.assignments[a.id] ||= {};
  if(['assignment:result','assignment:accept','assignment:close'].includes(action)){
    const descendants=assignmentDescendants(tasks,a.id);
    demand(!descendants.some(assignmentOpen),'ASSIGNMENT_DESCENDANTS_OPEN：须先收敛并关闭全部后代，父节点不能提前交回、验收或释放资源');
    demand(!descendants.some(x=>assignmentUnknown(x)||pendingDecisions(x).length),'ASSIGNMENT_DESCENDANTS_PENDING：后代仍有未知结果或待决事项');
    for(const node of [a,...descendants]){
      demand(!(node.interventions||[]).some(i=>['PENDING','RESULT_UNKNOWN'].includes(i.status)),'INTERVENTION_PENDING：介入结果尚未核查，不能交回、验收或关闭');
      demand(!ctx.runtimeUnknown?.(node.id),'RESULT_UNKNOWN：原节点操作或介入结果尚未核查，不能交回、验收或关闭');
      demand(!await decisionBlocked?.(node.id),'DECISION_INBOX：原服务请求尚未核查，不能验收或关闭');
    }
  }
  if(['assignment:dispatch','assignment:start'].includes(action)){
    requireTaskCapacity(tasks,t.id);
    const open=all().filter(x=>assignmentOpen(x.assignment));
    if(a.execution.mode==='SUBAGENT')demand(capabilities.delegation&&capabilities.closeVerified&&(hostLimit()===null||open.filter(x=>x.assignment.execution.mode==='SUBAGENT').length<=Math.max(0,hostLimit())),'AGENT_CAPACITY：当前原生能力或槽位不足；保留原派工，先核查收尾');
    else demand(open.filter(x=>x.assignment.execution.mode==='MAIN'&&x.assignment.status!=='BLOCKED').length<=1,'MAIN_CAPACITY：主 Agent 只能串行执行');
  }
  if(action==='assignment:reconcile') {
    await ctx.reconcileOwner?.(binding);
    for(const k of ['processes','workspace','versions','operations','agent']) nonempty(request.reconciliation?.[k],`reconciliation.${k}`);
    demand(!await active(a.id),'原受管命令仍在运行');
    if(request.nativeThreadId) {
      nonempty(request.nativeThreadId,'nativeThreadId');
      demand(!binding.nativeThreadId||binding.nativeThreadId===request.nativeThreadId,'原 Agent 身份不能换绑');
      demand(request.nativeThreadId!==capabilities.parentThreadId&&!Object.entries(bindings.assignments).some(([id,b])=>id!==a.id&&b.nativeThreadId===request.nativeThreadId),'原 Agent 不能复用或绑定主会话');
      binding.nativeThreadId=request.nativeThreadId;
    }
    if(request.noAgentCreated===true) {
      demand(!binding.nativeThreadId&&!binding.backendRequest,'已有原生身份或原服务调用意图，不能声明未创建；先对账');nonempty(request.noAgentEvidence,'核查原 spawn 未创建 Agent 的证据');
      binding.noAgentCreated=true;binding.noAgentEvidence=request.noAgentEvidence;
    }
    const cp=checkpoint(request.checkpoint,a.checkpoint);
    bump(t,a);a.checkpoint=cp;
    if(pendingDecisions(a).length){a.status='WAITING_DECISION';a.decisionResumeStatus='BLOCKED';}
    else if(!['DELIVERED','ACCEPTED'].includes(a.status)||assignmentUnknown(a))a.status='BLOCKED';
    a.reconciliation=request.reconciliation;
    a.blockReason=assignmentUnknown(a)?'原操作结果仍未知；只查询原编号':'中断派工须核查并关闭；后续使用新 Agent';
    if(binding.runId!==request.runId){
      binding.originRunId||=binding.runId;binding.ownershipHistory||=[];
      binding.ownershipHistory.push({fromRunId:binding.runId,toRunId:request.runId,operationId:request.operationId,backendOperationId:binding.backendRequest?.operationId||null,checkpointOperationIds:(cp.operations||[]).map(op=>op.id),at});
    }
    binding.runId=request.runId;bindings.tasks[t.id]=request.runId;
  } else {
    owner(a);
    if(action==='assignment:dispatch') {
      demand(a.status==='RESERVED'&&!binding.spawnAttemptAt&&a.execution.mode==='SUBAGENT','只能对尚未尝试启动的子 Agent 派工登记一次 dispatch');
      bump(t,a);a.dispatchAttemptAt=at;binding.spawnAttemptAt=at;binding.parentThreadId=a.parentAssignmentId?bindings.assignments[a.parentAssignmentId]?.nativeThreadId:capabilities.parentThreadId;binding.socket=capabilities.socket;
    } else if(action==='assignment:start') {
      demand(a.status==='RESERVED','派工只能启动一次；缺失回执先 reconcile');
      nonempty(request.workspaceEvidence,'工作区隔离核查');
      if(a.execution.mode==='SUBAGENT') {
        demand(binding.spawnAttemptAt,'先保存 dispatch 意图再启动原生 Agent');
        demand(capabilities?.closeVerified,'当前环境不能可靠关闭 Agent');
        nonempty(request.nativeThreadId,'nativeThreadId');
        demand(!Object.entries(bindings.assignments).some(([id,b])=>id!==a.id&&b.nativeThreadId===request.nativeThreadId),'Agent 已绑定过其他派工，禁止复用');
        demand(request.nativeThreadId!==capabilities.parentThreadId,'不能将主会话绑定为子 Agent');
        binding.nativeThreadId=request.nativeThreadId;
      }
      if(request.workspace) {
        nonempty(request.workspace,'workspace');const workspace=await realpath(path.resolve(request.workspace));
        if(a.execution.mode==='SUBAGENT'&&a.resources.some(r=>r.access==='WRITE'&&['FILE','DIRECTORY','UNKNOWN'].includes(r.kind))) {
          demand(workspace.startsWith(path.join(root,'.process')+path.sep),'代码派工工作区须位于当前项目受管过程目录');
          demand((await lstat(path.join(workspace,'.git'))).isFile(),'代码派工须使用独立 Git worktree');
        }
        binding.workspace=workspace;
      } else if(a.execution.mode==='SUBAGENT'&&a.resources.some(r=>r.access==='WRITE'&&['FILE','DIRECTORY','UNKNOWN'].includes(r.kind))) throw Error('代码写派工须指定受管 worktree');
      bump(t,a);a.status='RUNNING';a.startedAt=at;a.workspaceEvidence=request.workspaceEvidence;
      if(binding.executionAuthority)binding.executionAuthority.activatedAt=at;
    } else if(action==='assignment:checkpoint') {
      demand(['RUNNING','BLOCKED','WAITING_DECISION'].includes(a.status)||ctx.pausing&&['RESERVED','DELIVERED','ACCEPTED'].includes(a.status),'此状态不能保存执行检查点');
      bump(t,a);a.checkpoint=checkpoint(request.checkpoint,a.checkpoint);
      if(request.goalStatus) {demand(['ACTIVE','COMPLETE','PAUSED','UNKNOWN','UNAVAILABLE'].includes(request.goalStatus),'Goal 状态无效');a.goalStatus=request.goalStatus;}
    } else if(action==='assignment:result') {
      if(request.expectedBackendOperationId)demand(binding.backendRequest?.operationId===request.expectedBackendOperationId&&binding.backendRequest.state==='SUCCEEDED','BACKEND_OPERATION_CHANGED：回收结果与当前已完成原操作不符');
      demand(!(a.decisions||[]).some(d=>d.status!=='RESOLVED'),'DECISION_PENDING：尚有未解决决策，不可交回完整成果');
      demand(['RUNNING','BLOCKED'].includes(a.status),'只接收已执行派工的结果');
      demand(!await active(a.id),'受管命令仍在运行');
      const cp=checkpoint(request.checkpoint,a.checkpoint);demand(!assignmentUnknown({checkpoint:cp}),'原操作结果尚未核查');
      nonempty(request.result?.summary,'result.summary');
      demand(Array.isArray(request.result.artifacts),'result.artifacts 须为数组');request.result.artifacts.forEach(x=>nonempty(x,'artifact'));
      demand(Array.isArray(request.result.acceptance),'缺少逐项验收证据');
      a.acceptanceCriteria.forEach((_,i)=>demand(request.result.acceptance.some(x=>x.criterion===i&&typeof x.evidence==='string'&&x.evidence.trim()),`派工验收项 ${i} 缺少证据`));
      bump(t,a);a.status='DELIVERED';a.deliveredAt=at;a.checkpoint=cp;a.result=request.result;
    } else if(action==='assignment:accept') {
      demand(!ctx.executionAuthority||request.authority.assignmentId!==a.id,'ASSIGNMENT_SELF_ACCEPT：节点不能验收自身成果，须由父节点或主协调者验收');
      demand(!(a.decisions||[]).some(d=>d.status!=='RESOLVED'),'DECISION_PENDING：尚有未解决决策，不可验收');
      demand(a.status==='DELIVERED','结果交回后由主 Agent 验收');nonempty(request.evidence,'主 Agent 验收证据');
      bump(t,a);a.status='ACCEPTED';a.acceptedAt=at;a.acceptanceEvidence=request.evidence;
    } else if(action==='assignment:close') {
      demand(!pendingDecisions(a).length,'DECISION_PENDING：先停止原轮次并收敛决策请求');
      demand(!await active(a.id),'受管命令仍在运行');demand(!assignmentUnknown(a),'未知操作未核查，不能释放资源');
      demand(['ACCEPTED','CANCELLED','REPLACED'].includes(request.outcome),'关闭结果无效');
      if(request.outcome==='ACCEPTED') {demand(a.status==='ACCEPTED','完成的派工须先经过主 Agent 验收');demand((a.decisions||[]).every(d=>d.status==='RESOLVED'),'DECISION_PENDING：取消的问题不能作为已验收成果关闭');}
      else nonempty(request.reason,'取消或替换原因');
      if(a.execution.mode==='SUBAGENT') {
        const receipt=binding.closureReceipt;
        demand(!binding.spawnAttemptAt&&!binding.nativeThreadId || binding.noAgentCreated&&!binding.nativeThreadId || receipt?.verified===true&&receipt.nativeThreadId===binding.nativeThreadId&&receipt.history==='PRESERVED','缺少原生关闭及保留历史的核查回执；空闲不等于关闭');
      }
      nonempty(request.cleanup,'派工清理或已转交恢复资源的证据');
      bump(t,a);a.status='CLOSED';a.closedAt=at;a.outcome=request.outcome;a.cleanup=request.cleanup;
      a.closure={agent:binding.nativeThreadId?'CLOSED':'NOT_APPLICABLE',goal:'STOPPED',processes:'STOPPED',history:'PRESERVED',verifiedAt:at};
      binding.retiredAt=at;if(binding.executionAuthority)binding.executionAuthority.revokedAt=at;
    } else throw Error('未知派工操作');
  }
  return {taskId:t.id,assignmentId:a.id,status:a.status,assignment:a};
}
