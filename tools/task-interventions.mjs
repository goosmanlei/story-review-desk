import {assignmentAncestors} from './task-tree.mjs';
import {pendingDecisions} from './task-decision-protocol.mjs';

const demand=(value,message)=>{if(!value)throw Error(message);};

// The send intent and its public receipt share the task CAS lock. Transport
// identity stays in machine runtime; message and outcome stay in task history.
export async function interventionMutation({action,request,tasks,bindings,at,touch,requireRun}) {
 const task=tasks[request.taskId],a=task?.assignments?.find(a=>a.id===request.assignmentId),b=bindings.assignments[request.assignmentId];
 demand(task&&a&&b,'INTERVENTION_TARGET：执行节点不存在');
 demand(request.expectedVersions?.[task.id]===task.version&&request.expectedAssignmentVersion===a.version,'INTERVENTION_VERSION：节点已改变，请重新查看');
 await requireRun({converging:action==='intervention:settle'});
 demand(b.runId===request.runId,'INTERVENTION_BINDING：原执行归属已改变');
 a.interventions||=[];b.interventions||={};
 if(action==='intervention:record') {
  demand(['USER','WORKER_AGENT'].includes(request.actor),'INTERVENTION_ACTOR：需要用户或父 Agent 输入');
  demand(typeof request.text==='string'&&request.text.trim()&&request.text.length<=30000,'INTERVENTION_TEXT：请输入 1–30000 字符');
  demand(!['DONE','CANCELLED','MERGED'].includes(task.status)&&[a,...assignmentAncestors(tasks,a.id)].every(n=>n.status==='RUNNING')&&!b.closureReceipt,'INTERVENTION_CLOSED：节点尚未恢复、已交回或正在关闭');
  demand(!pendingDecisions(a).length,'DECISION_PENDING：请进入原问题明确答复；普通聊天不能代替审批');
  demand(!Object.values(b.interventions).some(i=>['PENDING','RESULT_UNKNOWN'].includes(i.state)),'INTERVENTION_UNKNOWN：已有未确认消息，先核查原操作');
  demand(['STEER','CONTINUE'].includes(request.method),'INTERVENTION_METHOD：不支持的消息方式');
  demand(b.nativeThreadId&&b.backendCreation?.threadId===b.nativeThreadId&&b.backendRequest?.turnId===request.expectedTurnId,'INTERVENTION_TURN：原线程或轮次已改变');
  demand(request.method==='STEER'?b.backendRequest.state==='RUNNING':b.backendRequest.state==='SUCCEEDED','INTERVENTION_STATE：先确认活动或空闲状态');
  const entry={operationId:request.operationId,assignmentId:a.id,actor:request.actor,sourceAssignmentId:request.authority?.assignmentId||null,text:request.text,method:request.method,status:'PENDING',createdAt:at};
  a.interventions.push(entry);
  b.interventions[request.operationId]={operationId:request.operationId,threadId:b.nativeThreadId,turnId:b.backendRequest.turnId,backendOperationId:b.backendRequest.operationId,serviceId:b.backendServiceId,generation:b.backendGeneration,method:request.method,state:'PENDING',createdAt:at};
 } else if(action==='intervention:settle') {
  const entry=a.interventions.find(i=>i.operationId===request.interventionOperationId),wire=b.interventions[request.interventionOperationId];
  demand(entry&&wire,'INTERVENTION_NOT_FOUND：原消息不存在');
  demand(['SENT','RESULT_UNKNOWN','REJECTED'].includes(request.status),'INTERVENTION_STATUS：回执状态无效');
  demand(wire.state==='PENDING'||wire.state==='RESULT_UNKNOWN','INTERVENTION_SETTLED：消息已有最终回执');
  entry.status=request.status;entry.updatedAt=at;wire.state=request.status;wire.updatedAt=at;
  if(request.receipt)wire.receipt=structuredClone(request.receipt);
  if(request.reason)entry.reason=String(request.reason).slice(0,3000);
 } else throw Error('INTERVENTION_ACTION：未知消息动作');
 touch(task);a.version++;a.updatedAt=at;
 const entry=a.interventions.find(i=>i.operationId===(request.interventionOperationId||request.operationId));
 return {taskId:task.id,assignmentId:a.id,operationId:entry.operationId,status:entry.status};
}
