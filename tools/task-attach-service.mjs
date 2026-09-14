import {location,readLedger,readBindings,requireTask,mutate,requireExecutionAuthority} from './task-ledger.mjs';
import {resolveTaskId} from './task-numbering.mjs';
import {assignmentRole,assignmentAncestors} from './task-tree.mjs';
import {callDecisionChannel} from './task-decision-channel.mjs';
import {sendBackend} from './task-backend.mjs';
import {decisionSnapshot,decisionVersions,readDecisionFile} from './task-decisions.mjs';
import path from 'node:path';
import {pendingDecisions,decisionHash} from './task-decision-protocol.mjs';
import {readPause,pauseBlocks} from './task-pause-state.mjs';
import {createInboxTaskObserver} from './task-observation.mjs';

// Opening and polling this client never acquires a coordinator lease, launches
// a service, resumes a thread, or starts a model turn.
export async function openAttachClient(project,inputId,{channel=callDecisionChannel,send=sendBackend,offlineObserver}={}) {
 const loc=await location(project),initial=await readLedger(loc),taskId=resolveTaskId(initial.tasks,inputId);
 requireTask(initial.tasks[taskId],'ATTACH_TASK：任务不存在');
 const messages=new Map(),cursors={},offlineCursors={},observerIds={},identities=new Map(),presented=new Map();
 const offline=offlineObserver||createInboxTaskObserver(loc.runtime);let closed=false,wasConnected=false,connectionIdentity;
 const resetLive=()=>{for(const key of Object.keys(cursors))delete cursors[key];for(const key of Object.keys(observerIds))delete observerIds[key];};
 const state=async()=>{
  requireTask(!closed,'ATTACH_CLOSED：观察连接已断开');
  const ledger=await readLedger(loc),task=ledger.tasks[taskId],bindings=await readBindings(loc);
  requireTask(task,'ATTACH_TASK：任务不存在');return {ledger,task,bindings};
 };
 const target=async id=>{
  const s=await state(),assignment=s.task.assignments?.find(a=>a.id===id),binding=s.bindings.assignments[id];
  requireTask(assignment&&binding,'ATTACH_NODE：请先选择本任务执行节点');
  const authority={assignmentId:id,executionToken:binding.executionAuthority?.token};
  await requireExecutionAuthority(loc,authority,{taskId,assignmentId:id});
  return {...s,assignment,binding,authority};
 };
 return {
  async snapshot() {
   const {ledger,task,bindings}=await state(),pause=await readPause(loc),run=await readDecisionFile(path.join(loc.runtime,'run.json'));let connection={status:'CONNECTED'},observed=[],retained=[];
   const allowed=new Set((task.assignments||[]).map(a=>a.id));
   for(const a of task.assignments||[]){
    const b=bindings.assignments[a.id],identity=decisionHash({threadId:b?.nativeThreadId,serviceId:b?.backendServiceId,creation:b?.backendCreation,workspace:b?.workspace,originalOperationId:(b?.backendHistory?.[0]||b?.backendRequest)?.operationId,scope:{taskId:b?.executionAuthority?.taskId,assignmentId:b?.executionAuthority?.assignmentId}});
    if(identities.has(a.id)&&identities.get(a.id)!==identity){messages.delete(a.id);delete cursors[a.id];delete offlineCursors[a.id];delete observerIds[a.id];}
    identities.set(a.id,identity);
   }
   try {
    // The durable receiver identity also isolates cursors for older bundles
    // that predate observerId. A reconnect always begins at zero.
    const record=await readDecisionFile(path.join(loc.runtime,'decision-channel/channel.json'));
    const currentIdentity=record?decisionHash({id:record.id,serviceId:record.serviceId,generation:record.generation}):null;
    if(!wasConnected||connectionIdentity!==currentIdentity)resetLive();
    let result=await channel(project,{action:'observe',taskId,cursors:{...cursors}});
    requireTask(Array.isArray(result?.nodes),'ATTACH_OBSERVATION：原观察响应不完整');
    if(result.nodes.some(n=>allowed.has(n.id)&&n.observerId&&observerIds[n.id]&&observerIds[n.id]!==n.observerId)){
     resetLive();result=await channel(project,{action:'observe',taskId,cursors:{}});
     requireTask(Array.isArray(result?.nodes),'ATTACH_OBSERVATION：原观察响应不完整');
    }
    observed=result.nodes.filter(n=>allowed.has(n.id));wasConnected=true;connectionIdentity=currentIdentity;
   }catch(error){connection={status:'UNAVAILABLE',reason:error.message};wasConnected=false;}
   // An unavailable receiver or unreadable original node can still be viewed
   // from its own persisted completed notifications. This never resumes it.
   if(connection.status!=='CONNECTED'||(task.assignments||[]).some(a=>!observed.find(n=>n.id===a.id)||observed.find(n=>n.id===a.id)?.error)){
    try {
     const fallback=await offline.read({task,bindings,cursors:offlineCursors});
     retained=fallback.nodes.filter(n=>allowed.has(n.id)&&(connection.status!=='CONNECTED'||!observed.find(l=>l.id===n.id)||observed.find(l=>l.id===n.id)?.error));
    }catch(error){retained=(task.assignments||[]).map(a=>({id:a.id,messages:[],historySource:'UNAVAILABLE',historyReason:'离线历史无法核对：'+error.message}));}
   }
   for(const node of observed){cursors[node.id]=node.cursor;if(node.observerId)observerIds[node.id]=node.observerId;}
   for(const node of retained){offlineCursors[node.id]={observerId:node.observerId,cursor:node.cursor};if(node.historySource==='UNVERIFIED')messages.delete(node.id);}
   for(const node of [...observed,...retained]){
    if(!messages.has(node.id))messages.set(node.id,new Map());
    for(const message of node.messages||[])messages.get(node.id).set(message.id,message);
   }
   const nodes=(task.assignments||[]).map(a=>{
    const b=bindings.assignments[a.id],live=observed.find(n=>n.id===a.id),history=retained.find(n=>n.id===a.id)||live,parents=assignmentAncestors(ledger.tasks,a.id);
    let reason;
    if(ledger.schemaVersion!==3||!b?.executionAuthority?.activatedAt)reason='旧执行节点只读；须安全升级并由 Main 核查原执行';
    else if(run?.stopRequested||run?.closedAt&&!run?.detachedAt||b.executionAuthority.revokedAt||b.executionAuthority.stopRequestedAt)reason='执行已明确停止或原节点授权已撤销';
    else if(pauseBlocks(pause))reason='任务执行已暂停或正在核查恢复';
    else if(['DONE','CANCELLED','MERGED'].includes(task.status)||[a,...parents].some(n=>n.status==='CLOSED')||b.closureReceipt)reason='执行节点已关闭';
    else if([a,...parents].some(n=>!['RUNNING'].includes(n.status)))reason='节点或祖先尚待决策、验收或收敛';
    else if(pendingDecisions(a).length)reason='请进入原待决问题作明确答复';
    else if(Object.values(b.interventions||{}).some(i=>['PENDING','RESULT_UNKNOWN'].includes(i.state)))reason='已有消息结果待核查；不能重复发送';
    else if(!['RUNNING','SUCCEEDED'].includes(b.backendRequest?.state))reason='原轮次结果未知或尚未开始';
    else if(connection.status!=='CONNECTED'||live?.error||!['active','idle'].includes(live?.nativeStatus))reason=live?.error||'原执行连接未就绪；观察不会自动恢复或启动';
    const transcript=[...(messages.get(a.id)?.values()||[])];
    if(!transcript.length&&a.checkpoint?.summary)transcript.push({id:'checkpoint:'+a.version,type:'checkpoint',text:a.checkpoint.summary});
    if(a.result?.summary)transcript.push({id:'result:'+a.version,type:'result',text:a.result.summary});
    for(const item of a.interventions||[])transcript.push({id:'intervention:'+item.operationId,type:'userMessage',text:item.text+'\n['+item.status+']'});
    if(history?.historyReason)transcript.unshift({id:'history-source',type:'observation',text:history.historyReason});
    return {id:a.id,parentAssignmentId:a.parentAssignmentId||null,rootAssignmentId:a.rootAssignmentId||null,role:assignmentRole(a),legacy:!a.role,title:a.goal,status:a.status,nativeStatus:live?.nativeStatus,model:a.execution?.model,effort:a.execution?.effort,canSend:!reason,reason,messages:transcript,historySource:history?.historySource||(live?'LIVE':'UNAVAILABLE'),historyVerification:history?.historyVerification,historyPending:history?.hasMore||false};
   });
   return {task:{id:task.id,displayId:task.displayId,title:task.title,status:task.status,checkpoint:task.checkpoint,result:task.result},nodes,decisions:(task.assignments||[]).flatMap(a=>pendingDecisions(a)),connection};
  },
  async send({assignmentId,text,operationId}) {
   const s=await target(assignmentId);
   return send(project,s.binding.runId,assignmentId,{text,operationId,actor:'USER'},{authority:s.authority});
  },
  async showDecision(decisionId) {
   const s=await decisionSnapshot(project,decisionId);requireTask(s.task.id===taskId,'ATTACH_DECISION_SCOPE：问题不属于本任务');
   presented.set(decisionId,{version:s.decision.version,bindingToken:s.decision.bindingToken,question:decisionHash({question:s.decision.question,context:s.decision.context,options:s.decision.options,wire:s.wire?.params})});
   return {decision:s.decision,requestFields:decisionVersions(s),...(s.decision.kind==='APPROVAL'?{runtime:s.wire}:{})};
  },
  async answer({decisionId,answer,operationId,presentedEvidence}) {
   const shown=presented.get(decisionId);requireTask(shown&&typeof presentedEvidence==='string'&&presentedEvidence.trim(),'DECISION_PRESENTATION：请先打开并阅读原问题');
   let s=await decisionSnapshot(project,decisionId);requireTask(s.task.id===taskId,'ATTACH_DECISION_SCOPE：问题不属于本任务');
   requireTask(shown.version===s.decision.version&&shown.bindingToken===s.decision.bindingToken&&shown.question===decisionHash({question:s.decision.question,context:s.decision.context,options:s.decision.options,wire:s.wire?.params}),'DECISION_STALE：原问题已改变，请重新打开后答复');
   const t=await target(s.assignment.id),auth={runId:t.binding.runId,authority:t.authority};
   if(!s.decision.presentations.length){
    await mutate(project,'decision:present',{operationId:operationId+'-present',actor:'USER',...auth,...decisionVersions(s),evidence:presentedEvidence});
    s=await decisionSnapshot(project,decisionId);
   }
   const result=await mutate(project,'decision:answer',{operationId,actor:'USER',...auth,...decisionVersions(s),answer,explicitUserAnswer:true,evidence:presentedEvidence+'；用户在该问题界面明确提交答复'});
   if(result.replayed||result.alreadyAnswered||result.status!=='ANSWERED')return result;
   try{return {...result,delivery:await channel(project,{action:'deliver',...auth,assignmentId:s.assignment.id,decisionId}),message:'答复已保存；已尝试通过原请求回传，等待原会话确认'};}
   catch(error){return {...result,message:'答复已保存，原请求回传需核查；不会重复发送',reason:error.message};}
  },
  async close(){closed=true;messages.clear();presented.clear();offline.close?.();},
 };
}
