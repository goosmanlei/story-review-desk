import path from 'node:path';
import {realpath,lstat} from 'node:fs/promises';
import {taskCapacity,taskCapacityReason,requireTaskCapacity} from './task-capacity.mjs';
import {pendingDecisions} from './task-decision-protocol.mjs';

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
export const assignmentUnknown = a => (a.checkpoint?.operations || []).some(o => ['PENDING','RESULT_UNKNOWN'].includes(o.status));

export function resources(value) {
  if (!value?.length) return [{kind:'UNKNOWN', key:'*', access:'WRITE'}];
  demand(Array.isArray(value) && value.length <= 200, 'resources 须为有界数组');
  return value.map(r => {
    demand(['FILE','DIRECTORY','OBJECT','UNKNOWN'].includes(r.kind), '资源种类无效');
    demand(['READ','WRITE'].includes(r.access), '资源访问方式无效');
    if (r.kind === 'UNKNOWN') return {kind:'UNKNOWN',key:'*',access:'WRITE'};
    nonempty(r.key, 'resource.key');
    demand(!path.posix.isAbsolute(r.key) && !r.key.includes('\\') && !r.key.split('/').some(x=>['..','.',''].includes(x)), '资源必须使用规范逻辑身份，不能使用机器绝对路径');
    if (r.access === 'READ') nonempty(r.version, '不可变读取的精确版本');
    return {kind:r.kind,key:r.key,access:r.access,...(r.access==='READ'?{version:r.version}:{})};
  });
}
export function conflicts(left, right) {
  return left.some(a => right.some(b => {
    if (a.kind === 'UNKNOWN' || b.kind === 'UNKNOWN') return true;
    if (a.access === 'READ' && b.access === 'READ') return false;
    if ((a.kind==='OBJECT') !== (b.kind==='OBJECT')) return false;
    const x=a.key.toLowerCase(), y=b.key.toLowerCase();
    return x===y || a.kind==='DIRECTORY'&&y.startsWith(x+'/') || b.kind==='DIRECTORY'&&x.startsWith(y+'/');
  }));
}

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
  const all=()=>Object.values(tasks).flatMap(t=>(t.assignments||[]).map(a=>({task:t,assignment:a})));
  const find=id=>all().find(x=>x.assignment.id===id);
  const owner=a=>demand(bindings.assignments[a.id]?.runId===request.runId,'派工不属于当前执行会话；先核查恢复');
  const bump=(t,a)=>{touch(t);a.version++;a.updatedAt=at;};
  if (action === 'schedule') {
    demand(Array.isArray(request.assignments) && request.assignments.length && request.assignments.length<=50, 'schedule 须提供 1–50 项候选派工');
    const seen=new Set();
    const candidates=request.assignments.map(s=>{
      const t=get(s.taskId); nonempty(s.key,'assignment.key');
      demand(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s.key),'派工 key 无效');
      const k=t.id+':'+s.key;demand(!seen.has(k),'候选派工 key 重复');seen.add(k);
      nonempty(s.goal,'assignment.goal');strings(s.deliverables,'assignment.deliverables');strings(s.acceptanceCriteria,'assignment.acceptanceCriteria');
      const rs=resources(s.resources), execution=chooseExecution(s.execution,capabilities);
      demand(Array.isArray(s.dependsOn||[]),'派工依赖须为数组');
      for(const d of s.dependsOn||[]) demand(find(d),'派工依赖不存在');
      if(s.attemptOf) demand(find(s.attemptOf)?.task.id===t.id && find(s.attemptOf).assignment.status==='CLOSED','重派必须引用本任务已关闭的派工');
      demand(!(t.assignments||[]).some(a=>a.key===s.key && assignmentOpen(a)), '同一派工尚未关闭，不能重复调度');
      return {s,t,rs,execution};
    }).sort((a,b)=>a.t.priority-b.t.priority||a.t.publishedAt.localeCompare(b.t.publishedAt)||a.t.id.localeCompare(b.t.id)||a.s.key.localeCompare(b.s.key));
    const selected=[], deferred=[];
    for (const {s,t,rs,execution} of candidates) {
      let reason=null;
      const open=all().filter(x=>assignmentOpen(x.assignment));
      if (!['READY','RUNNING'].includes(t.status) || t.children?.length) reason='TASK_NOT_EXECUTABLE';
      else if (!t.dependencies.every(d=>complete(tasks,d))) reason='DEPENDENCY';
      else if (t.status==='RUNNING' && bindings.tasks[t.id]!==request.runId) reason='RECOVERY_REQUIRED';
      else if ((t.checkpoint?.operations||[]).some(o=>['PENDING','RESULT_UNKNOWN'].includes(o.status))) reason='RESULT_UNKNOWN';
      else if ((s.dependsOn||[]).some(d=>{const a=find(d).assignment;return a.status!=='CLOSED'||a.outcome!=='ACCEPTED';})) reason='ASSIGNMENT_DEPENDENCY';
      else if (open.some(x=>conflicts(rs,x.assignment.resources))) reason='RESOURCE_CONFLICT';
      else if (Object.values(tasks).some(x=>x.status==='RUNNING'&&!x.assignments?.length)) reason='LEGACY_EXCLUSIVE';
      else if (taskCapacityReason(tasks,t.id)) reason='TASK_CAPACITY';
      else if (execution.mode==='MAIN' && open.some(x=>x.assignment.execution.mode==='MAIN'&&x.assignment.status!=='BLOCKED')) reason='MAIN_CAPACITY';
      else if (execution.mode==='SUBAGENT' && open.filter(x=>x.assignment.execution.mode==='SUBAGENT').length >= Math.max(0,capabilities.agentCapacity??capabilities.availableSlots??0)) reason='AGENT_CAPACITY';
      if (reason) {deferred.push({taskId:t.id,key:s.key,reason});continue;}
      const id=idFor(t.id+':'+s.key), a={id,key:s.key,taskId:t.id,version:1,status:'RESERVED',goal:s.goal,
        deliverables:s.deliverables,acceptanceCriteria:s.acceptanceCriteria,resources:rs,execution,
        dependsOn:s.dependsOn||[],attemptOf:s.attemptOf||null,createdAt:at,updatedAt:at,startedAt:null,
        deliveredAt:null,acceptedAt:null,closedAt:null,checkpoint:null,result:null};
      touch(t);t.assignments ||= [];t.assignments.push(a);t.status='RUNNING';t.startedAt ||= at;t.blockReason=null;
      delete t.runId;bindings.tasks[t.id]=request.runId;bindings.assignments[id]={runId:request.runId,dispatchIntentAt:at};
      selected.push(a);
    }
    return {status:selected.length?'SCHEDULED':'NO_EXECUTABLE_ASSIGNMENT',assignments:selected,deferred,capacity:taskCapacity(tasks)};
  }
  const t=get(request.taskId), a=t.assignments?.find(x=>x.id===request.assignmentId);
  demand(a,'派工不存在');demand(a.version===request.expectedAssignmentVersion,`派工版本冲突：当前为 ${a.version}`);
  demand(assignmentOpen(a),'已关闭派工只读；返工或新任务须重新调度新的 Agent');
  const binding=bindings.assignments[a.id] ||= {};
  if(['assignment:result','assignment:accept'].includes(action))demand(!await decisionBlocked?.(a.id),'DECISION_INBOX：原服务请求尚未核查，不能验收');
  if(['assignment:dispatch','assignment:start'].includes(action)){
    requireTaskCapacity(tasks,t.id);
    const open=all().filter(x=>assignmentOpen(x.assignment));
    if(a.execution.mode==='SUBAGENT')demand(capabilities.delegation&&capabilities.closeVerified&&open.filter(x=>x.assignment.execution.mode==='SUBAGENT').length<=Math.max(0,capabilities.agentCapacity??capabilities.availableSlots??0),'AGENT_CAPACITY：当前原生能力或槽位不足；保留原派工，先核查收尾');
    else demand(open.filter(x=>x.assignment.execution.mode==='MAIN'&&x.assignment.status!=='BLOCKED').length<=1,'MAIN_CAPACITY：主 Agent 只能串行执行');
  }
  if(action==='assignment:reconcile') {
    for(const k of ['processes','workspace','versions','operations','agent']) nonempty(request.reconciliation?.[k],`reconciliation.${k}`);
    demand(!await active(a.id),'原受管命令仍在运行');
    if(request.nativeThreadId) {
      nonempty(request.nativeThreadId,'nativeThreadId');
      demand(!binding.nativeThreadId||binding.nativeThreadId===request.nativeThreadId,'原 Agent 身份不能换绑');
      demand(request.nativeThreadId!==capabilities.parentThreadId&&!Object.entries(bindings.assignments).some(([id,b])=>id!==a.id&&b.nativeThreadId===request.nativeThreadId),'原 Agent 不能复用或绑定主会话');
      binding.nativeThreadId=request.nativeThreadId;
    }
    if(request.noAgentCreated===true) {
      demand(!binding.nativeThreadId,'已有原生身份，不能声明未创建');nonempty(request.noAgentEvidence,'核查原 spawn 未创建 Agent 的证据');
      binding.noAgentCreated=true;binding.noAgentEvidence=request.noAgentEvidence;
    }
    const cp=checkpoint(request.checkpoint,a.checkpoint);
    bump(t,a);a.checkpoint=cp;
    if(pendingDecisions(a).length){a.status='WAITING_DECISION';a.decisionResumeStatus='BLOCKED';}
    else if(!['DELIVERED','ACCEPTED'].includes(a.status)||assignmentUnknown(a))a.status='BLOCKED';
    a.reconciliation=request.reconciliation;
    a.blockReason=assignmentUnknown(a)?'原操作结果仍未知；只查询原编号':'中断派工须核查并关闭；后续使用新 Agent';
    binding.runId=request.runId;bindings.tasks[t.id]=request.runId;
  } else {
    owner(a);
    if(action==='assignment:dispatch') {
      demand(a.status==='RESERVED'&&!binding.spawnAttemptAt&&a.execution.mode==='SUBAGENT','只能对尚未尝试启动的子 Agent 派工登记一次 dispatch');
      bump(t,a);a.dispatchAttemptAt=at;binding.spawnAttemptAt=at;binding.parentThreadId=capabilities.parentThreadId;binding.socket=capabilities.socket;
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
    } else if(action==='assignment:checkpoint') {
      demand(['RUNNING','BLOCKED','WAITING_DECISION'].includes(a.status),'此状态不能保存执行检查点');
      bump(t,a);a.checkpoint=checkpoint(request.checkpoint,a.checkpoint);
      if(request.goalStatus) {demand(['ACTIVE','COMPLETE','PAUSED','UNKNOWN','UNAVAILABLE'].includes(request.goalStatus),'Goal 状态无效');a.goalStatus=request.goalStatus;}
    } else if(action==='assignment:result') {
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
      binding.retiredAt=at;
    } else throw Error('未知派工操作');
  }
  return {taskId:t.id,assignmentId:a.id,status:a.status,assignment:a};
}
