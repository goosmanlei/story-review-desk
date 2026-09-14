import {describeDecision,encodeDecisionAnswer,decisionHash,decisionPending,pendingDecisions,decisionBindingToken} from './task-decision-protocol.mjs';

const demand=(ok,message)=>{if(!ok)throw Error(message);};
const nonempty=(s,name)=>demand(typeof s==='string'&&s.trim()&&s.length<=30000,`DECISION_REQUEST：${name}须为非空文本`);
const refresh=a=>{
 if(pendingDecisions(a).length){if(a.status!=='WAITING_DECISION')a.decisionResumeStatus=a.status;a.status='WAITING_DECISION';}
 else if(a.status==='WAITING_DECISION'){a.status=a.decisionResumeStatus||'RUNNING';delete a.decisionResumeStatus;}
};

// Runs under the same ledger lock as collect, accept, close and task DONE.
// A service observation needs its original runtime binding, not a live user
// lease. User answers require the current coordinator and all three versions.
export async function decisionMutation({action,request,tasks,bindings,at,touch,requireRun,service}) {
 const pairs=Object.values(tasks).flatMap(t=>(t.assignments||[]).map(a=>({t,a,b:bindings.assignments[a.id]})));
 const bump=(t,a,d)=>{touch(t);a.version++;a.updatedAt=at;if(d){d.version++;d.updatedAt=at;}refresh(a);};
 if(action==='decision:receive'){
  const w=request.wire;
  demand(w&&w.serviceId===service?.serviceId&&typeof w.generation==='string','DECISION_SERVICE：不是本项目专属服务');
  const currentGeneration=w.generation===service.generation;
  const matches=pairs.filter(({b})=>b?.nativeThreadId===w.threadId&&b.backendCreation?.threadId===w.threadId&&b.backendServiceId===w.serviceId);
  demand(matches.length===1,'DECISION_BINDING：请求没有唯一派工归属，保留 runtime 消息待核查');
  const {t,a,b}=matches[0];demand(a.status!=='CLOSED'&&!b.closureReceipt,'DECISION_CLOSED：原派工已关闭');
  demand(b.backendRequest?.turnId===w.turnId,'DECISION_TURN：不是已保存的原工作轮次，保留消息待核查');
  demand(typeof w.requestId==='string'||Number.isSafeInteger(w.requestId),'DECISION_PROTOCOL：缺少原请求 ID');
  const id='D-'+decisionHash({serviceId:w.serviceId,generation:w.generation,threadId:w.threadId,turnId:w.turnId,requestId:w.requestId}).slice(0,24);
  a.decisions||=[];b.decisions||={};
  let d=a.decisions.find(d=>d.id===id),prior=b.decisions[id];
  if(d){
   demand(prior?.requestHash===w.requestHash,'DECISION_REPLAY_CONFLICT：原请求编号内容发生变化');
   if(prior.connectionId===w.connectionId)return {decisionId:id,status:d.status,replayed:true};
   prior.connectionId=w.connectionId;prior.protocolState=currentGeneration?'PENDING':'STALE';prior.replayedAt=at;
   // A replay proves only that the server presented a callback again. Never
   // erase an earlier send intent or automatically resend an unknown answer.
   if(!prior.deliveryAttemptedAt&&decisionPending(d))d.status=currentGeneration&&d.supported?(d.answer?'ANSWERED':'OPEN'):'NEEDS_RECONCILIATION';
   d.bindingToken=decisionBindingToken(prior);bump(t,a,d);
  }else{
   let description;
   try{description=describeDecision({method:w.method,params:w.params});}
   catch(error){description={kind:'UNSUPPORTED',question:'原用户请求格式尚不能处理',context:'原消息已保存在 runtime，须核查协议。',options:[],recommendation:'核查原请求',pendingWork:['核查协议兼容性'],completedSteps:[],supported:false,limitation:error.message};}
   demand(!description.key||!a.decisions.some(old=>old.key===description.key&&decisionPending(old)),'DECISION_DUPLICATE_KEY：已有未解决业务问题；保留新回调核查，不重复提问');
   d={...description,id,taskId:t.id,assignmentId:a.id,version:1,status:description.supported&&currentGeneration?'OPEN':'NEEDS_RECONCILIATION',createdAt:request.receivedAt||at,updatedAt:at,bindingToken:decisionBindingToken(w),presentations:[],answer:null,delivery:null};
   a.decisions.push(d);b.decisions[id]={...w,protocolState:currentGeneration?'PENDING':'STALE'};bump(t,a);
  }
  return {taskId:t.id,assignmentId:a.id,decisionId:id,status:d.status};
 }
 if(action==='decision:signal'){
  const w=request.wire;
  demand(w&&w.serviceId===service?.serviceId,'DECISION_SERVICE：不是本项目服务');
  const changed=[];
  for(const {t,a,b} of pairs)for(const d of a.decisions||[]){
   const p=b?.decisions?.[d.id];if(!p||!decisionPending(d)||p.serviceId!==w.serviceId||p.generation!==w.generation)continue;
   if(w.connectionId&&p.connectionId!==w.connectionId)continue;
   if(w.threadId&&p.threadId!==w.threadId)continue;
   if(w.turnId&&p.turnId!==w.turnId)continue;
   if(w.requestId!==undefined&&p.requestId!==w.requestId)continue;
   if(request.signal==='SEND_UNKNOWN'){
    if(!p.deliveryAttemptedAt||!d.answer)continue;
    d.status='DELIVERY_UNKNOWN';d.delivery={status:'RESULT_UNKNOWN',attemptedAt:p.deliveryAttemptedAt};
   }else if(request.signal==='DISCONNECTED'){p.protocolState='DISCONNECTED';d.status='NEEDS_RECONCILIATION';}
   else if(request.signal==='RESOLVED'){
    p.protocolState='CLEARED';p.resolvedAt=at;
    d.status='NEEDS_RECONCILIATION'; // answered OR cleared: never consent proof
   }else if(request.signal==='ITEM_COMPLETED'){
    if((p.params.callId||p.params.itemId)!==request.item?.id)continue;
    const item=request.item;
    // Dynamic tool output echoes the exact answer and is stronger evidence
    // than a generic resolved notification or a turn finishing normally.
    if(d.kind==='BUSINESS'&&p.method==='item/tool/call'&&d.answer&&p.deliveryAttemptedAt&&item.type==='dynamicToolCall'&&item.status==='completed'&&item.tool===p.params.tool&&decisionHash(item.arguments)===decisionHash(p.params.arguments)&&item.success===true&&decisionHash(item.contentItems)===decisionHash(p.response?.contentItems)){
     d.status='RESOLVED';d.delivery={status:'CONFIRMED',confirmedAt:at,evidence:'原工具条目回读包含完全匹配的用户答复'};p.protocolState='RESOLVED';
    }else {d.status='NEEDS_RECONCILIATION';p.protocolState='CLEARED';}
   }else if(request.signal==='TURN_ENDED'){p.protocolState='CLEARED';d.status='NEEDS_RECONCILIATION';}
   else throw Error('DECISION_SIGNAL：未知服务信号');
   d.recoveryReason=request.signal;bump(t,a,d);changed.push(d.id);
  }
  return {status:'RECORDED',decisionIds:changed};
 }
 const found=pairs.find(({t,a})=>t.id===request.taskId&&a.id===request.assignmentId);
 demand(found,'DECISION_BINDING：问题所属任务或派工不符');
 const {t,a,b}=found;
 await requireRun({converging:['decision:cancel','decision:reconcile'].includes(action)});
 demand(b?.runId===request.runId,'DECISION_RUN：先由当前协调会话 reconcile 原派工');
 demand(t.version===request.expectedVersions?.[t.id]&&a.version===request.expectedAssignmentVersion,'DECISION_VERSION：任务或派工版本冲突');
 demand(a.status!=='CLOSED'&&!b.retiredAt,'DECISION_CLOSED：原派工已关闭；不能复用答复');
 if(action==='decision:cancel'){
  demand(b.closureReceipt?.verified,'DECISION_CLOSE：先核验原工作会话停止和关闭');nonempty(request.evidence,'关闭核查证据');
  for(const d of pendingDecisions(a)){d.status='CANCELLED';d.cancelledAt=at;d.cancellationEvidence=request.evidence;b.decisions[d.id].protocolState='CANCELLED';bump(t,a,d);}
  return {taskId:t.id,assignmentId:a.id,status:'CANCELLED'};
 }
 const d=a.decisions?.find(d=>d.id===request.decisionId),p=b.decisions?.[request.decisionId];
 demand(d&&p,'DECISION_NOT_FOUND：没有此问题及原执行绑定');
 demand(d.version===request.expectedDecisionVersion,'DECISION_VERSION：问题版本冲突');
 demand(request.bindingToken===d.bindingToken&&request.bindingToken===decisionBindingToken(p),'DECISION_BINDING：请求绑定不符或已过期');
 demand(decisionPending(d),'DECISION_TERMINAL：问题已解决或取消');
 demand(!b.closureReceipt,'DECISION_CLOSED：原会话已核验关闭');
 if(action==='decision:present'){
  nonempty(request.evidence,'实际提问回执');
  if(d.presentations.length)return {decisionId:d.id,status:d.status,alreadyPresented:true};
  d.presentations.push({at,evidence:request.evidence});
  p.presentedByRun=request.runId;
 }else if(action==='decision:answer'){
  demand(request.actor==='USER'&&request.explicitUserAnswer===true,'DECISION_CONSENT：必须来自用户明确答复');
  nonempty(request.evidence,'用户答复来源');
  demand(d.presentations.length,'DECISION_PRESENTATION：尚未登记主会话实际提问');
  const response=encodeDecisionAnswer(d,p,request.answer);
  if(d.answer){demand(decisionHash(d.answer.value)===decisionHash(request.answer),'DECISION_ANSWER_CONFLICT：已有不同用户答复');return {decisionId:d.id,status:d.status,alreadyAnswered:true};}
  demand(['OPEN','NEEDS_RECONCILIATION'].includes(d.status),'DECISION_STALE：原请求不可回传，先核查');
  d.answer={operationId:request.operationId,value:request.answer,evidence:request.evidence,at};d.status=p.protocolState==='PENDING'?'ANSWERED':'NEEDS_RECONCILIATION';p.response=response;
 }else if(action==='decision:sending'){
  demand(d.status==='ANSWERED'&&d.answer&&p.protocolState==='PENDING'&&!p.deliveryAttemptedAt,'DECISION_SEND_UNKNOWN：答复不满足首次发送条件；只核查不重发');
  demand(p.connectionId===request.connectionId&&p.generation===service?.generation&&p.serviceId===service.serviceId,'DECISION_CONNECTION：原连接或服务代次已失效');
  demand(b.nativeThreadId===p.threadId&&b.backendRequest?.turnId===p.turnId,'DECISION_TURN：工作轮次已改变');
  p.deliveryAttemptedAt=at;p.deliveryOperationId=d.answer.operationId;d.status='DELIVERY_UNKNOWN';d.delivery={status:'RESULT_UNKNOWN',attemptedAt:at};
 }else if(action==='decision:followup-start'){
  demand(d.status==='FOLLOWUP_READY'&&d.answer&&p.protocolState!=='PENDING','DECISION_FOLLOWUP：尚未核查原请求和已保存答复');
  demand(a.execution.goalMode==='FOLLOWUP'&&b.backendRequest?.operationId===request.followupOperationId&&b.backendRequest.state==='TURN_STARTING','DECISION_FOLLOWUP：缺少同范围续办意图');
  p.followupOperationId=request.followupOperationId;d.status='DELIVERY_UNKNOWN';d.delivery={status:'RESULT_UNKNOWN',attemptedAt:at,mode:'FOLLOWUP'};
 }else if(action==='decision:followup-confirm'){
  demand(p.followupOperationId===request.followupOperationId&&b.backendRequest?.operationId===request.followupOperationId&&b.backendRequest.turnId&&['RUNNING','SUCCEEDED'].includes(b.backendRequest.state),'DECISION_FOLLOWUP：尚无原续办回执');
  d.status='RESOLVED';d.delivery={status:'CONFIRMED',confirmedAt:at,mode:'FOLLOWUP',evidence:'同范围原续办操作已取得工作轮次回执；用户答复包含于其保存的输入'};
 }else if(action==='decision:reconcile'){
  nonempty(request.evidence,'原请求和原操作核查证据');
  demand(['DELIVERED','FOLLOWUP'].includes(request.resolution),'DECISION_RECOVERY：仅接受已送达核查或同范围 FOLLOWUP');
  demand(d.answer&&p.protocolState!=='PENDING','DECISION_RECOVERY：须有原用户答复并先核查失效请求');
  demand(request.checkedOriginalOperation===true,'DECISION_RECOVERY：必须核查原操作');
  if(request.resolution==='DELIVERED'){d.status='RESOLVED';d.delivery={status:'CONFIRMED_BY_RECONCILIATION',confirmedAt:at,evidence:request.evidence};}
  else {demand(a.execution.goalMode==='FOLLOWUP'&&['BUSINESS','INPUT'].includes(d.kind),'DECISION_FOLLOWUP：只续办原有 FOLLOWUP 派工的业务决定或输入，失效审批不得继承');d.status='FOLLOWUP_READY';d.recoveryEvidence=request.evidence;}
 }else throw Error('DECISION_ACTION：未知决策操作');
 bump(t,a,d);
 return {taskId:t.id,assignmentId:a.id,decisionId:d.id,status:d.status};
}
