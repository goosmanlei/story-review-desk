import {nativeTurns} from './task-native.mjs';
import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readDecisionFile} from './task-decisions.mjs';
import {decisionHash} from './task-decision-protocol.mjs';

const visible=new Set(['agentMessage','userMessage','commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageView','imageGeneration','collabAgentToolCall','plan']);
const textOf=item=>{
 if(item.type==='agentMessage')return item.text||'';
 if(item.type==='userMessage')return (item.content||[]).map(c=>c.text||c.url||'').join('\n');
 if(item.type==='commandExecution')return [item.command,item.aggregatedOutput??item.output,item.exitCode!==undefined?'exit '+item.exitCode:''].filter(x=>x!==undefined&&x!=='').join('\n');
 // Tool input/result are user-visible protocol fields. Reasoning items and
 // reasoning deltas are deliberately excluded from the observation surface.
 const {id,type,...content}=item;return JSON.stringify(content,null,2);
};

export function createTaskObserver() {
 const observerId=randomUUID(),threads=new Map();let sequence=0;
 const get=id=>{if(!threads.has(id))threads.set(id,{items:new Map(),hydrated:false,status:null});return threads.get(id);};
 const put=(threadId,item,turnId)=>{
  if(!visible.has(item?.type)||!item.id)return;
  const thread=get(threadId),key=(turnId||'')+':'+item.id,prior=thread.items.get(key),text=textOf(item);
  if(prior?.text===text&&prior.status===item.status)return;
  thread.items.set(key,{id:key,type:item.type,text,status:item.status,turnId,sequence:++sequence});
 };
 return {
  observerId,
  observe(message) {
   if(!message||Object.hasOwn(message,'id'))return;
   const p=message.params||{},threadId=p.threadId||p.conversationId,turnId=p.turnId||p.turn?.id;
   if(!threadId||/reasoning|tokenUsage/i.test(message.method))return;
   const thread=get(threadId);
   if(p.item)put(threadId,p.item,turnId);
   if(message.method==='thread/status/changed')thread.status=p.status;
   if(message.method==='turn/completed')for(const item of p.turn?.items||[])put(threadId,item,turnId);
   const kind=message.method==='item/agentMessage/delta'?'agentMessage':message.method==='item/commandExecution/outputDelta'?'commandExecution':null;
   if(kind&&p.itemId&&typeof p.delta==='string'){
    const key=(turnId||'')+':'+p.itemId,prior=thread.items.get(key);
    thread.items.set(key,{id:key,type:kind,turnId,text:(prior?.text||'')+p.delta,sequence:++sequence});
   }
  },
  async hydrate(client,threadId) {
   const thread=get(threadId);if(thread.hydrated)return;
   let turns;
   try {turns=await nativeTurns(client,threadId,{itemsView:'full'});}
   catch(error){
    if(!/unknown|unsupported|not supported/i.test(error.message))throw error;
    thread.hydrated=true;thread.historyReason='宿主历史接口不支持；显示原接收器保留的可见事件及当前输出';return;
   }
   for(const turn of [...turns].reverse()){
    let items=turn.items||[];
    if(!items.length){
     try {let cursor;do {const page=await client.call('thread/items/list',{threadId,turnId:turn.id,limit:100,...(cursor?{cursor}:{})});items.push(...page.data);cursor=page.nextCursor;}while(cursor);}
     catch(error){if(!/unknown|unsupported|not supported/i.test(error.message))throw error;}
    }
    for(const item of items){const key=turn.id+':'+item.id;if(!thread.items.has(key))put(threadId,item,turn.id);}
   }
   thread.hydrated=true;
  },
  page(threadId,since=0,maxBytes=2*1024*1024) {
   const thread=get(threadId),updates=[...thread.items.values()].filter(x=>x.sequence>since).sort((a,b)=>a.sequence-b.sequence);
   const messages=[];let bytes=0,cursor=since;
   for(const item of updates){const size=Buffer.byteLength(JSON.stringify(item));if(maxBytes<=0||messages.length&&bytes+size>maxBytes)break;messages.push(item);bytes+=size;cursor=item.sequence;}
   return {observerId,messages,cursor,hasMore:messages.length<updates.length,historyReason:thread.historyReason};
  },
 };
}

const offlineReason='原执行连接不可用；只读回显原接收器保存的已完成可见条目。未保存的流式增量不在离线历史中。';
const identityError='ATTACH_HISTORY_IDENTITY：原服务、线程及派工创建回执无法核对；仅显示账本检查点与结果';
const compareEntries=(a,b)=>a.receivedAt.localeCompare(b.receivedAt)||
 (BigInt(a.receivedOrder||0)<BigInt(b.receivedOrder||0)?-1:BigInt(a.receivedOrder||0)>BigInt(b.receivedOrder||0)?1:0)||a.id.localeCompare(b.id);
const completionMessage=message=>{
 if(!message||Object.hasOwn(message,'id')||!['item/completed','turn/completed'].includes(message.method))return null;
 const p=message.params||{},threadId=p.threadId||p.conversationId,turnId=p.turnId||p.turn?.id;
 if(typeof threadId!=='string'||!threadId||typeof turnId!=='string'||!turnId)return null;
 const items=(message.method==='item/completed'?[p.item]:p.turn?.items||[]).filter(item=>visible.has(item?.type)&&typeof item.id==='string'&&item.id);
 // Retain only the public item fields, never the raw approval/input request,
 // reasoning item, turn error payload, or unretained streaming delta.
 return items.length?{threadId,turnId,items}:null;
};

// This is an in-memory view over the original durable inbox, not a second
// transcript. Content-addressed records already read are cached across polls;
// only new filenames and not-yet-complete RPC receipts require file reads.
export function createInboxTaskObserver(runtime,{read=readDecisionFile,list=readdir}={}) {
 const directory=path.join(runtime,'decision-channel'),seen=new Set(),seenCalls=new Set(),entries=new Map(),receipts=new Map(),resumes=new Map(),sessions=new Map();let refreshing;
 const retainReceipt=(key,value)=>{
  if(value?.state!=='SUCCEEDED')return;
  receipts.set(key,value);seenCalls.add(key+'.json');
  if(value.method==='thread/resume')resumes.set(key,value);
 };
 const receipt=async key=>{
  if(receipts.has(key))return receipts.get(key);
  const value=await read(path.join(directory,'calls',key+'.json'));
  retainReceipt(key,value);
  return value;
 };
 const refresh=()=>refreshing||= (async()=>{
  const names=await list(path.join(directory,'inbox')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(names.length>50000)throw Error('ATTACH_HISTORY_LIMIT：原通知超过有界回读范围；仅显示已观察内容和账本结果');
  const fresh=[];
  for(const name of names){
   if(!/^[a-f0-9]{64}\.json$/.test(name)||seen.has(name))continue;
   let entry;try{entry=await read(path.join(directory,'inbox',name));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)continue;throw error;}
   if(!entry?.message)continue;
   const hash=decisionHash({serviceId:entry.serviceId,generation:entry.generation,connectionId:entry.connectionId,message:entry.message});
   if(entry.id!==hash||name!==hash+'.json'||!Number.isFinite(Date.parse(entry.receivedAt))||
    typeof entry.connectionId!=='string'||!entry.connectionId||entry.receivedOrder!==undefined&&!/^\d+$/.test(entry.receivedOrder))continue;
   seen.add(name);
   const content=completionMessage(entry.message);if(!content)continue;
   fresh.push({id:entry.id,serviceId:entry.serviceId,generation:entry.generation,connectionId:entry.connectionId,receivedAt:entry.receivedAt,receivedOrder:entry.receivedOrder,...content});
  }
  for(const entry of fresh.sort(compareEntries)){
   if(!entries.has(entry.threadId))entries.set(entry.threadId,[]);
   entries.get(entry.threadId).push(entry);
  }
  const calls=await list(path.join(directory,'calls')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  if(calls.length>50000)throw Error('ATTACH_HISTORY_LIMIT：原调用超过有界回读范围；仅显示已观察内容和账本结果');
  for(const name of calls){
   if(!/^[a-f0-9]{64}\.json$/.test(name)||seenCalls.has(name))continue;
   let value;try{value=await read(path.join(directory,'calls',name));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)continue;throw error;}
   retainReceipt(name.slice(0,-5),value);
  }
 })().finally(()=>{refreshing=null;});
 return {
  async read({task,bindings,cursors={}}) {
   await refresh();const nodes=[];
   for(const assignment of task.assignments||[]){
    const binding=bindings.assignments?.[assignment.id],creation=binding?.backendCreation,threadId=binding?.nativeThreadId,grant=binding?.executionAuthority;
    const identity=decisionHash({taskId:task.id,assignmentId:assignment.id,threadId,serviceId:binding?.backendServiceId,creation});
    const old=sessions.get(assignment.id);if(old&&old.identity!==identity)sessions.delete(assignment.id);
    let valid=threadId&&creation?.threadId===threadId&&creation.serviceId===binding.backendServiceId&&typeof creation.generation==='string'&&creation.generation&&
     (!grant||grant.taskId===task.id&&grant.assignmentId===assignment.id)&&
     Object.values(bindings.assignments||{}).filter(b=>b.nativeThreadId===threadId&&b.backendServiceId===binding.backendServiceId).length===1;
    const requests=[...(binding?.backendHistory||[]),...(binding?.backendRequest?[binding.backendRequest]:[])],original=requests[0];
    let started;
    if(valid&&original?.operationId){
     const key=decisionHash({assignmentId:assignment.id,operationId:original.operationId,method:'thread/start'});
     started=await receipt(key);
     valid=started?.rpcId===key&&started.state==='SUCCEEDED'&&started.method==='thread/start'&&started.assignmentId===assignment.id&&started.operationId===original.operationId&&
      started.serviceId===creation.serviceId&&started.generation===creation.generation&&started.result?.thread?.id===threadId&&
      typeof binding.workspace==='string'&&started.params?.cwd===binding.workspace&&Number.isFinite(Date.parse(started.at));
    }else valid=false;
    if(!valid){sessions.delete(assignment.id);nodes.push({id:assignment.id,messages:[],cursor:0,hasMore:false,historySource:'UNVERIFIED',historyReason:identityError});continue;}
    const turns=new Map();
    for(const request of requests){
     if(!request.operationId||!request.turnId)continue;
     const key=decisionHash({assignmentId:assignment.id,operationId:request.operationId,method:'turn/start'}),r=await receipt(key);
     if(r?.rpcId===key&&r.state==='SUCCEEDED'&&r.method==='turn/start'&&r.assignmentId===assignment.id&&r.operationId===request.operationId&&
      r.serviceId===creation.serviceId&&r.generation===request.generation&&r.params?.threadId===threadId&&r.result?.turn?.id===request.turnId&&
      typeof r.connectionId==='string'&&r.connectionId&&Number.isFinite(Date.parse(r.at)))turns.set(request.turnId,r);
    }
    // A managed receiver may subscribe to this same original turn after its
    // start. Only an exact successful original thread/resume receipt can prove
    // that additional connection; arbitrary new receiver IDs remain unknown.
    const resumed=[...resumes.entries()].filter(([key,r])=>r.rpcId===key&&r.assignmentId===assignment.id&&requests.some(q=>q.operationId===r.operationId)&&
     r.serviceId===creation.serviceId&&r.params?.threadId===threadId&&r.params?.cwd===binding.workspace&&r.result?.thread?.id===threadId&&
     typeof r.connectionId==='string'&&r.connectionId&&Number.isFinite(Date.parse(r.at))&&
     key===decisionHash({assignmentId:r.assignmentId,operationId:r.operationId,method:'thread/resume',params:r.params,generation:r.generation,connectionId:r.connectionId})).map(([,r])=>r);
    let session=sessions.get(assignment.id),unverifiedReceiver=false;
    if(!session){session={identity,observer:createTaskObserver(),applied:new Set(),latest:new Map()};sessions.set(assignment.id,session);}
    for(const entry of [...(entries.get(threadId)||[])].sort(compareEntries)){
     if(session.applied.has(entry.id))continue;
     const turn=turns.get(entry.turnId);
     if(!turn||entry.serviceId!==creation.serviceId||entry.generation!==turn.generation||Date.parse(entry.receivedAt)<Date.parse(turn.at)||Date.parse(entry.receivedAt)<Date.parse(started.at))continue;
     if(entry.connectionId!==turn.connectionId&&!resumed.some(r=>r.operationId===turn.operationId&&r.generation===entry.generation&&r.connectionId===entry.connectionId&&Date.parse(entry.receivedAt)>=Date.parse(r.at))){unverifiedReceiver=true;continue;}
     for(const item of entry.items){
      const key=entry.turnId+':'+item.id,previous=session.latest.get(key);if(previous&&compareEntries(entry,previous)<0)continue;
      session.observer.observe({method:'item/completed',params:{threadId,turnId:entry.turnId,item}});session.latest.set(key,entry);
     }
     session.applied.add(entry.id);
    }
    const known=cursors[assignment.id],since=known?.observerId===session.observer.observerId?known.cursor:0;
    nodes.push({id:assignment.id,...session.observer.page(threadId,since||0),historySource:'PERSISTED_COMPLETED_ITEMS',historyVerification:unverifiedReceiver?'PARTIAL_UNVERIFIED':'VERIFIED',historyReason:offlineReason+(unverifiedReceiver?' 部分完成通知缺少原接收器恢复回执（UNVERIFIED），未显示。':'')});
   }
   return {nodes};
  },
  close(){seen.clear();seenCalls.clear();entries.clear();receipts.clear();resumes.clear();sessions.clear();},
 };
}
