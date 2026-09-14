import path from 'node:path';
import {readFile,readdir,mkdir,open,rename,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {location,readLedger,readBindings,mutate,requireTask} from './task-ledger.mjs';
import {decisionHash,decisionPending,pendingDecisions} from './task-decision-protocol.mjs';
import {cell,table} from './task-format.mjs';
import {processAlive} from './process-resources.mjs';

// These are recovery inputs, not disposable logs. Sync both file and directory
// before acknowledging receipt or putting a user answer on the wire.
export async function durableDecisionFile(file,value) {
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const temp=file+'.'+randomUUID()+'.tmp',f=await open(temp,'wx',0o600);
 try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
 await rename(temp,file);const dir=await open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
export async function readDecisionFile(file) {
 try{const s=await lstat(file);requireTask(s.isFile()&&!s.isSymbolicLink(),'DECISION_FILE：记录不是普通文件');return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function decisionSnapshot(project,decisionId) {
 const loc=await location(project),ledger=await readLedger(loc),bindings=await readBindings(loc);
 for(const task of Object.values(ledger.tasks))for(const assignment of task.assignments||[]){
  const decision=assignment.decisions?.find(d=>d.id===decisionId);
  if(decision)return {loc,task,assignment,decision,binding:bindings.assignments[assignment.id],wire:bindings.assignments[assignment.id]?.decisions?.[decisionId]};
 }
 throw Error('DECISION_NOT_FOUND：问题不存在');
}
export const decisionVersions=s=>({taskId:s.task.id,assignmentId:s.assignment.id,decisionId:s.decision.id,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.assignment.version,expectedDecisionVersion:s.decision.version,bindingToken:s.decision.bindingToken});
export async function listDecisions(project,{taskId,assignmentId,includeHistory=false}={}) {
 const ledger=await readLedger(project),items=[];
 for(const task of Object.values(ledger.tasks))for(const assignment of task.assignments||[])for(const d of assignment.decisions||[]){
  if(taskId&&taskId!==task.id||assignmentId&&assignmentId!==assignment.id||!includeHistory&&!decisionPending(d))continue;
  items.push({...d,taskTitle:task.title,taskVersion:task.version,assignmentVersion:assignment.version,needsPresentation:!d.presentations.length&&decisionPending(d)});
 }
 return items.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}
export function renderDecisions(items) {
 const rows=items.map(d=>[d.id,d.taskId+' '+d.taskTitle,d.assignmentId,d.kind,d.status,d.question,d.options.map(o=>o.label+'：'+o.description).join('；')||'自由文本',d.recommendation,d.presentations.length?'已转达；沿用原问题':'待主会话提问'].map(cell));
 return table(['问题编号','正式任务','派工','类型','状态','问题','选项及影响','建议','转达'],rows);
}

export async function persistDecisionMessage(project,service,connectionId,message) {
 const loc=await location(project),receivedAt=new Date().toISOString();
 const id=decisionHash({serviceId:service.serviceId,generation:service.generation,connectionId,message});
 const file=path.join(loc.runtime,'decision-channel/inbox',id+'.json');
 if(!await readDecisionFile(file))await durableDecisionFile(file,{id,serviceId:service.serviceId,generation:service.generation,connectionId,message,receivedAt,receivedOrder:process.hrtime.bigint().toString(),state:'RECEIVED'});
 return file;
}
export async function drainDecisionInbox(project) {
 const loc=await location(project),directory=path.join(loc.runtime,'decision-channel/inbox');
 const files=await readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 const entries=await Promise.all(files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(async f=>({file:path.join(directory,f),entry:await readDecisionFile(path.join(directory,f))})));
 const pending=entries.filter(({entry})=>entry.state!=='APPLIED').sort((a,b)=>a.entry.receivedAt.localeCompare(b.entry.receivedAt)||Number(BigInt(a.entry.receivedOrder||0)-BigInt(b.entry.receivedOrder||0)));
 const blockedThreads=new Set();
 for(const {file,entry:e} of pending){
  const m=e.message,p=m.params||{},wire={serviceId:e.serviceId,generation:e.generation,connectionId:e.connectionId,threadId:p.threadId||p.conversationId,turnId:p.turnId||p.turn?.id,requestId:m.id,method:m.method,params:p,requestHash:decisionHash(m)};
  try{
   let result;
   if(Object.hasOwn(m,'id'))result=await mutate(project,'decision:receive',{operationId:'dc-receive-'+e.id,actor:'TASK_APP_SERVER',wire,receivedAt:e.receivedAt});
   else {
    const signal=m.method==='serverRequest/resolved'?'RESOLVED':m.method==='item/completed'?'ITEM_COMPLETED':m.method==='turn/completed'?'TURN_ENDED':m.method==='connection/closed'?'DISCONNECTED':null;
    if(signal){if(blockedThreads.has(wire.threadId)||signal==='DISCONNECTED'&&blockedThreads.size)continue;wire.requestId=p.requestId;result=await mutate(project,'decision:signal',{operationId:'dc-signal-'+e.id,actor:'TASK_APP_SERVER',wire,signal,item:p.item});}
    else result={status:'OBSERVED'};
   }
   await durableDecisionFile(file,{...e,state:'APPLIED',appliedAt:new Date().toISOString(),result});
  }catch(error){
   // Missing turn/start receipts, replaced services and unknown methods stay
   // visible. A later sync/recover can attach the original receipt and replay.
   await durableDecisionFile(file,{...e,state:'NEEDS_RECONCILIATION',error:error.message,checkedAt:new Date().toISOString()});
   if(Object.hasOwn(m,'id'))blockedThreads.add(wire.threadId);
  }
 }
 return pending.length;
}
export async function decisionChannelStatus(project) {
 const loc=await location(project),record=await readDecisionFile(path.join(loc.runtime,'decision-channel/channel.json'));
 const directory=path.join(loc.runtime,'decision-channel/inbox'),files=await readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 const unresolved=[];
 for(const name of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){const e=await readDecisionFile(path.join(directory,name));if(e.state!=='APPLIED')unresolved.push({id:e.id,method:e.message.method,state:e.state,error:e.error,receivedAt:e.receivedAt});}
 const service=await readDecisionFile(path.join(loc.runtime,'server/server.json'));
 const status=record?.status==='READY'&&(!processAlive(record.process)||record.generation!==service?.generation)?'DISCONNECTED':record?.status||'UNAVAILABLE';
 return {status,record,unresolved};
}
export async function assertNoPendingDecisions(project,assignmentId) {
 const ledger=await readLedger(project),a=Object.values(ledger.tasks).flatMap(t=>t.assignments||[]).find(a=>a.id===assignmentId);
 requireTask(a&&!pendingDecisions(a).length,'DECISION_PENDING：尚有未解决问题；不能 collect 或继续普通轮次');
 const loc=await location(project),b=(await readBindings(loc)).assignments[assignmentId];
 requireTask(!await unappliedDecisionRequest(loc,b?.nativeThreadId),'DECISION_INBOX：尚有未归入账本的原服务请求；先核查');
}
export async function unappliedDecisionRequest(loc,threadId) {
 if(!threadId)return false;
 const directory=path.join(loc.runtime,'decision-channel/inbox'),files=await readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const name of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){const e=await readDecisionFile(path.join(directory,name));if(e.state!=='APPLIED'&&Object.hasOwn(e.message,'id')&&(e.message.params?.threadId||e.message.params?.conversationId)===threadId)return true;}
 return false;
}
export async function cancelAssignmentDecisions(project,runId,assignmentId) {
 const ledger=await readLedger(project),task=Object.values(ledger.tasks).find(t=>t.assignments?.some(a=>a.id===assignmentId)),a=task.assignments.find(a=>a.id===assignmentId);
 const loc=await location(project),b=(await readBindings(loc)).assignments[assignmentId];
 requireTask(b?.closureReceipt?.verified,'DECISION_CLOSE：先核查原会话关闭');
 let result;
 if(pendingDecisions(a).length)result=await mutate(project,'decision:cancel',{operationId:'dc-close-'+randomUUID(),actor:'PROJECT_CODEX',runId,taskId:task.id,assignmentId,expectedVersions:{[task.id]:task.version},expectedAssignmentVersion:a.version,evidence:'backend close 已核查原轮次停止、后台命令结束及原线程卸载；保留问题、用户答复及未知回传历史'});
 const directory=path.join(loc.runtime,'decision-channel/inbox'),files=await readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const name of files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){const file=path.join(directory,name),e=await readDecisionFile(file);if(e.state!=='APPLIED'&&(e.message.params?.threadId||e.message.params?.conversationId)===b.nativeThreadId)await durableDecisionFile(file,{...e,state:'APPLIED',resolution:'CANCELLED_AFTER_VERIFIED_CLOSE',closedAt:new Date().toISOString()});}
 return result;
}

// Called only by the persistent connection owner. No send is retried: even
// crash between intent persistence and write is an unknown delivery to inspect.
export async function deliverDecision(project,runId,decisionId,{client,connectionId,service}) {
 await client.flush?.();await drainDecisionInbox(project);
 const s=await decisionSnapshot(project,decisionId);
 requireTask(s.binding?.runId===runId,'DECISION_RUN：先核查当前协调归属');
 if(s.wire?.deliveryAttemptedAt&&s.decision.status==='ANSWERED'){
  await mutate(project,'decision:signal',{operationId:'dc-send-recovery-'+decisionHash({decisionId,operationId:s.decision.answer.operationId}),actor:'TASK_APP_SERVER',wire:s.wire,signal:'SEND_UNKNOWN'});
  return {decisionId,status:'DELIVERY_UNKNOWN',sent:false,reason:'原发送意图先于账本保存；保留未知结果，不重发'};
 }
 if(s.wire?.deliveryAttemptedAt||s.decision.status!=='ANSWERED')return {decisionId,status:s.decision.status,sent:false,reason:'只核查原答复，不重发'};
 requireTask(s.wire.serviceId===service.serviceId&&s.wire.generation===service.generation&&s.wire.connectionId===connectionId&&client.hasRequest(s.wire.requestId),'DECISION_CONNECTION：原协议请求或连接已失效；保留答复先核查');
 const intent=await mutate(project,'decision:sending',{operationId:'dc-send-'+decisionHash({decisionId,operationId:s.decision.answer.operationId}),actor:'PROJECT_CODEX',runId,...decisionVersions(s),connectionId});
 if(intent.replayed)return {decisionId,status:'DELIVERY_UNKNOWN',sent:false};
 try{await client.respond(s.wire.requestId,s.wire.response);return {decisionId,status:'DELIVERY_UNKNOWN',sent:true,reason:'写入连接不等于送达；等待原工具回读或核查'};}
 catch(error){return {decisionId,status:'DELIVERY_UNKNOWN',sent:false,error:error.message};}
}
