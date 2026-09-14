import {randomUUID} from 'node:crypto';
import {location,mutate,requireRun,requireTask,updateBinding} from './task-ledger.mjs';
import {listDecisions,renderDecisions,decisionSnapshot,decisionVersions,decisionChannelStatus} from './task-decisions.mjs';
import {callDecisionChannel} from './task-decision-channel.mjs';
import {backendAction,assertBackendThread,decisionFollowupPrompt} from './task-backend.mjs';
import {verifyTaskServer} from './task-server.mjs';
import {nativeTurns} from './task-native.mjs';
import {pendingDecisions} from './task-decision-protocol.mjs';

export async function decisionsAction(project,action,values,input={}) {
 if(action==='list'){
  const decisions=await listDecisions(project,{taskId:values.task,assignmentId:values.assignment,includeHistory:values.history});
  return values.format==='markdown'?renderDecisions(decisions):{decisions,channel:await decisionChannelStatus(project)};
 }
 if(action==='status')return decisionChannelStatus(project);
 if(action==='show'){
  const s=await decisionSnapshot(project,values.decision);
  return {decision:s.decision,taskTitle:s.task.title,requestFields:decisionVersions(s),...(values.runtime?{runtime:s.wire}:{}),instruction:'先在主会话实际提问，再 present 保存提问证据。用户明确回答后，actor USER、explicitUserAnswer true，通过 answer 保存并尝试原请求回传。'};
 }
 const runId=values.run||input.runId,loc=await location(project);
 await requireRun(loc,runId,{converging:action==='reconcile'});
 requireTask(!input.runId||input.runId===runId,'DECISION_RUN：执行会话不符');
 if(action==='deliver')return callDecisionChannel(project,{action:'deliver',runId,decisionId:values.decision||input.decisionId});
 if(action==='followup'){
  const s=await decisionSnapshot(project,values.decision||input.decisionId);
  requireTask(s.binding.runId===runId,'DECISION_RUN：先核查原派工');
  const prior=s.binding.backendRequest,decisions=pendingDecisions(s.assignment);
  const request=prior.operationId===input.operationId?{operationId:input.operationId,prompt:prior.prompt,decisionIds:prior.decisionIds}:{operationId:input.operationId,prompt:decisionFollowupPrompt(decisions),decisionIds:decisions.map(d=>d.id)};
  return backendAction(project,'continue',{run:runId,assignment:s.assignment.id},request);
 }
 requireTask(['present','answer','reconcile'].includes(action),'DECISION_ACTION：未知动作');
 const request={...input,runId};
 if(action==='reconcile'){
  const s=await decisionSnapshot(project,input.decisionId);
  requireTask(input.taskId===s.task.id&&input.assignmentId===s.assignment.id&&s.binding.runId===runId,'DECISION_BINDING：先核对问题归属');
  requireTask(s.decision.answer&&s.wire.protocolState!=='PENDING','DECISION_RECOVERY：原请求仍待答或没有用户答复');
  if(input.resolution==='FOLLOWUP')requireTask(['BUSINESS','INPUT'].includes(s.decision.kind),'DECISION_APPROVAL_EXPIRED：失效审批不得变成新轮次授权；关闭后按新请求核查');
  else requireTask(s.wire.deliveryAttemptedAt||s.wire.followupOperationId,'DECISION_DELIVERY：从未尝试回传，不能声明送达');
  const v=await verifyTaskServer(project);
  try{
   await assertBackendThread(project,s.assignment.id,s.wire.threadId,v.client,{allowUnloaded:true});
   const turns=await nativeTurns(v.client,s.wire.threadId,{itemsView:'full'}),original=turns.find(t=>t.id===s.wire.turnId);
   requireTask(original&&['completed','failed','interrupted'].includes(original.status),'DECISION_RECOVERY：原轮次仍活动或结果未知；先核查，不续办');
   if(input.resolution==='FOLLOWUP')requireTask(original.status==='completed'&&s.binding.backendRequest.turnId===original.id,'DECISION_FOLLOWUP：仅在上一轮成功且未被替换时同范围续办');
   await updateBinding(project,runId,s.assignment.id,b=>{b.decisions[s.decision.id].reconciliationObservation={id:randomUUID(),checkedAt:new Date().toISOString(),serviceGeneration:v.record.generation,originalTurnId:original.id,status:original.status,items:original.items||[]};});
  }finally{v.client.close();}
 }
 const saved=await mutate(project,'decision:'+action,request);
 if(action!=='answer'||saved.replayed||saved.alreadyAnswered||saved.status!=='ANSWERED')return saved;
 try{return {...saved,delivery:await callDecisionChannel(project,{action:'deliver',runId,decisionId:input.decisionId})};}
 catch(error){return {...saved,delivery:{status:'NEEDS_RECONCILIATION',error:error.message},instruction:'用户答复已持久保存；show 核查原请求，不能换号重发或启动新轮次。'};}
}
