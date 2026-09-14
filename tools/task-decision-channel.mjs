import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,lstat,unlink,chmod,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {location,readBindings,readLedger,requireRun,requireTask,withRuntime,requireAssignmentAuthority} from './task-ledger.mjs';
import {serverPaths,verifyAppService as verifyTaskServer} from './app-service.mjs';
import {processLock,processAlive,processIdentity} from './process-resources.mjs';
import {plainDirectory} from './io.mjs';
import {bootStamp,compareBootIdentity} from './execution-runtime.mjs';
import {connectNative} from './task-native.mjs';
import {createTaskObserver} from './task-observation.mjs';
import {isAgentToolMessage,handleAgentTool} from './task-agent-tools.mjs';
import {decisionHash} from './task-decision-protocol.mjs';
import {durableDecisionFile,readDecisionFile,persistDecisionMessage,drainDecisionInbox,deliverDecision} from './task-decisions.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
export const decisionChannelSources=Object.freeze(['task-decision-daemon.mjs','task-decision-channel.mjs','task-decisions.mjs','task-decision-state.mjs','task-decision-protocol.mjs','task-native.mjs','native-socket.mjs','task-ledger.mjs','task-numbering.mjs','task-assignments.mjs','task-capacity.mjs','task-format.mjs','task-server.mjs','app-service.mjs','execution-runtime.mjs','task-server-daemon.mjs','process-resources.mjs','process-identity.mjs','task-pause-state.mjs','task-backend.mjs','task-tree.mjs','task-interventions.mjs','task-agent-tools.mjs','task-execution-scope.mjs','task-observation.mjs','io.mjs'].map(f=>'tools/'+f).concat('server/transport-contract.mjs'));
const rpcMethods=new Set(['thread/start','thread/resume','thread/name/set','thread/read','thread/loaded/list','thread/turns/list','thread/items/list','thread/goal/get','thread/goal/set','thread/backgroundTerminals/list','thread/backgroundTerminals/terminate','thread/archive','turn/start','turn/steer','turn/interrupt']);
export async function channelPaths(project,{readOnly=false}={}) {
 const p=await serverPaths(project,{readOnly}),directory=path.join(p.runtime,'decision-channel');
 if(!readOnly){await mkdir(directory,{recursive:true,mode:0o700});await plainDirectory(directory);}
 return {...p,directory,channelRecord:path.join(directory,'channel.json'),channelSocket:path.join(path.dirname(p.socket),'decisions-'+p.serviceId.slice(-20)+'.sock')};
}
export async function callDecisionChannel(project,request,{timeoutMs=12000}={}) {
 const p=await channelPaths(project,{readOnly:true}),record=await readDecisionFile(p.channelRecord);
 requireTask(record?.serviceId===p.serviceId&&record.root===p.root&&record.socket===p.channelSocket&&processAlive(record.process),'DECISION_CHANNEL_UNAVAILABLE：先在受管阶段 backend probe，再 recover 原派工');
 const st=await lstat(p.channelSocket);
 requireTask(st.isSocket()&&!st.isSymbolicLink()&&st.dev===record.socketIdentity?.dev&&st.ino===record.socketIdentity?.ino,'DECISION_CHANNEL_IDENTITY：socket 已改变');
 return new Promise((resolve,reject)=>{
  const stream=net.createConnection({path:p.channelSocket});let buffer='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);stream.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('DECISION_CHANNEL_TIMEOUT：结果未知；查原操作，不重发')),timeoutMs);
  stream.on('connect',()=>stream.write(JSON.stringify({...request,channelId:record.id})+'\n'));
  stream.on('error',e=>finish(Error('DECISION_CHANNEL_CONNECTION：'+e.code)));
  stream.on('end',()=>finish(Error('DECISION_CHANNEL_DISCONNECTED：结果未知；查原操作')));
  stream.on('data',data=>{buffer+=data.toString();if(Buffer.byteLength(buffer)>8*1024*1024)return finish(Error('DECISION_CHANNEL_LIMIT'));const end=buffer.indexOf('\n');if(end<0)return;try{const response=JSON.parse(buffer.slice(0,end));finish(response.error?Error(response.error):null,response.result);}catch(e){finish(e);}});
 });
}
export function channelClient(project,runId,assignmentId,{authority}={}) {
 return {call:(method,params={},options={})=>callDecisionChannel(project,{action:'rpc',runId,assignmentId,authority,operationId:options.operationId,method,params}),close(){},flush:()=>callDecisionChannel(project,{action:'drain'})};
}
export async function ensureDecisionChannel(project) {
 const p=await channelPaths(project);
 return processLock(path.join(p.directory,'startup.lock'),async()=>{
  const v=await verifyTaskServer(project);v.client.close();
  const content=await Promise.all(decisionChannelSources.map(async name=>[name,await readFile(path.join(sourceRoot,name),'utf8')]));
  const sourceDigest=decisionHash(content.map(([name,data])=>[name,decisionHash(data)]));
  let previous=await readDecisionFile(p.channelRecord);
  if(previous&&!previous.process){const launchOwner=await readDecisionFile(path.join(p.directory,'launch-process.json'));if(launchOwner?.id===previous.id&&launchOwner.process)previous={...previous,process:launchOwner.process};}
  if(previous&&processAlive(previous.process)){
   requireTask(previous.serviceId===p.serviceId&&previous.root===p.root&&previous.generation===v.record.generation,'DECISION_CHANNEL_IDENTITY：原接收器归属或代次不明，保留现场');
   requireTask(previous.sourceDigest===sourceDigest,'DECISION_CHANNEL_VERSION：接收器运行旧代码；先收敛派工并停止服务，再加载新版本');
   await callDecisionChannel(project,{action:'ping'});return {...previous,reused:true};
  }
  requireTask(!previous||previous.process||previous.status!=='STARTING'||compareBootIdentity(previous)==='DIFFERENT','DECISION_CHANNEL_START_UNKNOWN：原启动身份未知，先核查原进程');
  if(previous){await persistDecisionMessage(project,previous,previous.id,{method:'connection/closed',params:{}});await drainDecisionInbox(project);}
  const socket=await lstat(p.channelSocket).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(socket){requireTask(previous?.serviceId===p.serviceId&&previous.root===p.root&&previous.socketIdentity?.dev===socket.dev&&previous.socketIdentity.ino===socket.ino&&!processAlive(previous.process),'DECISION_CHANNEL_SOCKET：未知占用，保留现场');await unlink(p.channelSocket);}
  const bundle=path.join(p.directory,'code',sourceDigest);
  for(const [name,data] of content){
   const target=path.join(bundle,name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await plainDirectory(path.dirname(target));
   const prior=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(prior)requireTask(prior.isFile()&&!prior.isSymbolicLink()&&await readFile(target,'utf8')===data,'DECISION_CHANNEL_CODE：恢复代码被修改，保留现场');
   else await writeFile(target,data,{flag:'wx',mode:0o600});
  }
  const launch=path.join(p.directory,'launch.json'),spec={id:randomUUID(),...bootStamp(),root:p.root,serviceId:p.serviceId,generation:v.record.generation,sourceDigest,socket:p.channelSocket};
  await durableDecisionFile(launch,spec);
  await durableDecisionFile(p.channelRecord,{...spec,status:'STARTING',startedAt:new Date().toISOString()});
  const env={...process.env};for(const key of ['REVIEW_PROCESS_CONTEXT','REVIEW_TASK_ID','REVIEW_TASK_DIR','TMPDIR','TMP','TEMP','TEST_TMPDIR','XDG_CACHE_HOME','npm_config_cache','CODEX_THREAD_ID','CODEX_SESSION_ID'])delete env[key];
  const child=spawn(process.execPath,[path.join(bundle,'tools/task-decision-daemon.mjs'),launch],{cwd:p.root,env,stdio:'ignore',detached:true});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  // The daemon is the sole writer of channel.json after spawn. A separate
  // launch receipt avoids overwriting READY with a stale parent snapshot.
  await durableDecisionFile(path.join(p.directory,'launch-process.json'),{id:spec.id,process:processIdentity(child.pid)});
  for(let i=0;i<50;i++){await wait(100);const current=await readDecisionFile(p.channelRecord);if(current?.id!==spec.id)continue;if(current.status==='FAILED')throw Error('DECISION_CHANNEL_START：'+current.error);if(current.status==='READY'){await callDecisionChannel(project,{action:'ping'});return {...current,reused:false};}}
  throw Error('DECISION_CHANNEL_START_UNKNOWN：保留原启动记录，禁止重复启动');
 });
}
export async function stopDecisionChannel(project) {
 const p=await channelPaths(project),record=await readDecisionFile(p.channelRecord);
 if(!record||!processAlive(record.process))return;
 const ledger=await readLedger(project),bindings=await readBindings(p);
 // A MAIN assignment with no native binding can own the maintenance command
 // stopping this idle receiver. Subagents and any native binding still block.
 requireTask(!Object.values(ledger.tasks).some(t=>t.assignments?.some(a=>a.status!=='CLOSED'&&(a.execution.mode==='SUBAGENT'||bindings.assignments[a.id]?.nativeThreadId||bindings.assignments[a.id]?.backendServiceId))),'DECISION_CHANNEL_BUSY：仍有未关闭服务派工');
 requireTask(record.serviceId===p.serviceId&&record.root===p.root,'DECISION_CHANNEL_IDENTITY');
 const command=execFileSync('ps',['-p',String(record.process.pid),'-o','command='],{encoding:'utf8'});
 requireTask(command.includes(path.join(p.directory,'code',record.sourceDigest,'tools/task-decision-daemon.mjs')),'DECISION_CHANNEL_PROCESS：原进程身份不符');
 process.kill(record.process.pid,'SIGTERM');for(let i=0;i<50&&processAlive(record.process);i++)await wait(100);
 requireTask(!processAlive(record.process),'DECISION_CHANNEL_STOP_UNKNOWN：尚未确认结束');
}

export async function runDecisionChannel(spec,{verifyServer=verifyTaskServer,handleSignals=true}={}) {
 const p=await channelPaths(spec.root);requireTask(spec.serviceId===p.serviceId&&spec.socket===p.channelSocket,'DECISION_CHANNEL_IDENTITY');
 let record={...spec,process:processIdentity(),status:'STARTING',startedAt:new Date().toISOString()},v,nativeClient,server,stopping=false;
 await durableDecisionFile(p.channelRecord,record);
 const save=async patch=>{record={...record,...patch};await durableDecisionFile(p.channelRecord,record);};
 let ingest=Promise.resolve();const observer=createTaskObserver(),agentCalls=new Set();
 const observe=message=>{ingest=ingest.then(async()=>{await persistDecisionMessage(spec.root,spec,spec.id,message);await drainDecisionInbox(spec.root);});return ingest;};
 const shutdown=async(error)=>{
  if(stopping)return;stopping=true;
  try{await observe({method:'connection/closed',params:{}});await save({status:error?'FAILED':'STOPPED',error:error?.message,stoppedAt:new Date().toISOString()});}finally{server?.close();v?.client.close();}
 };
 try{
  v=await verifyServer(spec.root,{connect:options=>nativeClient=connectNative({...options,
   onRequest:async message=>{
    if(message.method==='currentTime/read'){
     const response={currentTimeAt:Math.floor(Date.now()/1000)};
     const file=await persistDecisionMessage(spec.root,spec,spec.id,message),saved=await readDecisionFile(file);
     await durableDecisionFile(file,{...saved,state:'APPLIED',technicalResponse:response,appliedAt:new Date().toISOString()});
     if(nativeClient.hasRequest(message.id))await nativeClient.respond(message.id,response);return;
    }
    if(isAgentToolMessage(message)){
     // A tool may wait for a child whose notifications arrive on this same
     // socket. Launch outside the ordered ingest chain; do not block transport.
     const pending=handleAgentTool(spec.root,{serviceId:spec.serviceId,generation:spec.generation,connectionId:spec.id},message)
      .then(result=>nativeClient.hasRequest(message.id)?nativeClient.respond(message.id,result):null)
      .catch(error=>save({lastAgentError:error.message})).finally(()=>agentCalls.delete(pending));
     agentCalls.add(pending);return;
    }
    await observe(message);
   },
   onNotification:async message=>{
    observer.observe(message);
    // High-volume deltas are not recovery input; final items and every other
    // notification (including unknown methods) are retained for diagnosis.
    if(!/delta|tokenUsage|reasoning/i.test(message.method))await observe(message);
   },
   onDisconnect:error=>shutdown(error),
  })});
  requireTask(!stopping,'DECISION_CHANNEL_DISCONNECTED：初始化连接已结束');
  requireTask(v.record.generation===spec.generation,'DECISION_CHANNEL_GENERATION：服务代次已改变');
  // Reuse the original receiver's visible completed items on hosts whose
  // history API is unavailable. No second transcript or thread is created.
  const inbox=path.join(p.directory,'inbox'),history=[];
  for(const name of await readdir(inbox).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
   if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
   const entry=await readDecisionFile(path.join(inbox,name));
   if(entry.serviceId===spec.serviceId&&!Object.hasOwn(entry.message,'id'))history.push(entry);
  }
  history.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt));for(const entry of history)observer.observe(entry.message);
  await drainDecisionInbox(spec.root);
  server=net.createServer(stream=>{
   let buffer='',handled=false;stream.setTimeout(15000,()=>stream.destroy());
   stream.on('error',()=>{});
   stream.on('data',chunk=>{
    buffer+=chunk.toString();if(Buffer.byteLength(buffer)>8*1024*1024){stream.destroy();return;}
    const end=buffer.indexOf('\n');if(end<0||handled)return;handled=true;
    void (async()=>{
     const req=JSON.parse(buffer.slice(0,end));requireTask(req.channelId===spec.id&&!stopping,'DECISION_CHANNEL_IDENTITY：连接代次不符');
     if(req.action==='ping')return {status:record.status,id:spec.id,generation:spec.generation};
     await v.client.flush();await ingest;await drainDecisionInbox(spec.root);
     if(req.action==='drain')return {status:'DRAINED'};
     if(req.action==='observe'){
      const ledger=await readLedger(p),task=ledger.tasks[req.taskId],bindings=await readBindings(p);
      requireTask(task,'ATTACH_TASK：任务不存在');const nodes=[];let remaining=6*1024*1024;
      for(const a of task.assignments||[]){
       const b=bindings.assignments[a.id];if(!b?.nativeThreadId||b.backendServiceId!==spec.serviceId||b.backendCreation?.threadId!==b.nativeThreadId)continue;
       let thread,error;
       try {const r=await v.client.call('thread/read',{threadId:b.nativeThreadId,includeTurns:false});thread=r.thread;requireTask(thread.id===b.nativeThreadId&&path.resolve(thread.cwd?.startsWith('file:')?fileURLToPath(thread.cwd):thread.cwd)===b.workspace,'ATTACH_OWNERSHIP：原线程身份改变');await observer.hydrate(v.client,b.nativeThreadId);}
       catch(e){error=e.message;}
       const cursor=req.cursors?.[a.id]||0,page=observer.page(b.nativeThreadId,cursor,Math.min(2*1024*1024,Math.max(0,remaining)));
       const size=Buffer.byteLength(JSON.stringify(page));
       // A task may have many descendants. Keep the complete response within
       // the local transport bound and leave deferred node cursors unchanged.
       if(size>remaining&&nodes.some(n=>n.messages.length))nodes.push({id:a.id,nativeStatus:thread?.status?.type,error,observerId:page.observerId,messages:[],cursor,hasMore:page.messages.length>0||page.hasMore,historyReason:page.historyReason});
       else {nodes.push({id:a.id,nativeStatus:thread?.status?.type,error,...page});remaining-=size;}
      }
      return {generation:spec.generation,nodes};
     }
     if(req.action==='deliver'){
      const ledger=await readLedger(p),task=Object.values(ledger.tasks).find(t=>t.assignments?.some(a=>a.decisions?.some(d=>d.id===req.decisionId)));
      req.assignmentId=task?.assignments.find(a=>a.decisions?.some(d=>d.id===req.decisionId))?.id;
     }
     await requireAssignmentAuthority(p,req,{converging:req.action==='rpc'&&!['thread/start','turn/start','turn/steer'].includes(req.method)});
     if(req.action==='deliver')return deliverDecision(spec.root,req.runId,req.decisionId,{client:v.client,connectionId:spec.id,service:spec,authority:req.authority});
     requireTask(req.action==='rpc'&&rpcMethods.has(req.method),'DECISION_CHANNEL_METHOD：只允许任务工作会话协议');
     const b=(await readBindings(p)).assignments[req.assignmentId];
     requireTask(b?.runId===req.runId&&b.backendServiceId===spec.serviceId&&!b.retiredAt,'DECISION_CHANNEL_ASSIGNMENT：当前派工绑定不符');
     if(req.method==='thread/start')requireTask(!b.nativeThreadId&&b.backendRequest?.state==='CREATING'&&req.params.cwd===b.workspace,'DECISION_CHANNEL_CREATE：没有原创建意图');
     else if(req.params.threadId)requireTask(req.params.threadId===b.nativeThreadId&&b.backendCreation?.threadId===b.nativeThreadId,'DECISION_CHANNEL_THREAD：不能操作其他线程');
     if(req.method==='turn/start')requireTask(b.backendRequest?.state==='TURN_STARTING'&&!b.backendRequest.turnId,'DECISION_CHANNEL_TURN：没有唯一未执行轮次意图');
     if(req.method==='turn/steer'){
      const intent=b.interventions?.[req.operationId],ledger=await readLedger(p),assignment=Object.values(ledger.tasks).flatMap(t=>t.assignments||[]).find(a=>a.id===req.assignmentId);
      const text=assignment?.interventions?.find(i=>i.operationId===req.operationId)?.text;
      requireTask(intent?.state==='PENDING'&&intent.method==='STEER'&&intent.threadId===req.params.threadId&&intent.turnId===req.params.expectedTurnId&&typeof text==='string'&&decisionHash(req.params.input)===decisionHash([{type:'text',text}]),'INTERVENTION_INTENT：没有匹配的原消息执行意图');
     }
     const mutating=['thread/start','thread/resume','turn/start','turn/steer','turn/interrupt','thread/archive','thread/backgroundTerminals/terminate','thread/goal/set'].includes(req.method);
     const creation=['thread/start','turn/start'].includes(req.method),once=mutating;
     const rpcId=req.method==='turn/steer'?decisionHash({assignmentId:req.assignmentId,operationId:req.operationId,method:req.method}):creation?decisionHash({assignmentId:req.assignmentId,operationId:b.backendRequest?.operationId,method:req.method}):mutating?decisionHash({assignmentId:req.assignmentId,operationId:b.backendRequest?.operationId,method:req.method,params:req.params,generation:spec.generation,connectionId:spec.id}):randomUUID(),file=path.join(p.directory,'calls',rpcId+'.json');
     const intent={rpcId,assignmentId:req.assignmentId,operationId:req.operationId||b.backendRequest?.operationId,method:req.method,params:req.params,serviceId:spec.serviceId,generation:spec.generation,connectionId:spec.id,state:'PENDING',at:new Date().toISOString()};
     const perform=async()=>{
      if(once){const prior=await readDecisionFile(file);if(prior){requireTask(decisionHash(prior.params)===decisionHash(req.params),'DECISION_CHANNEL_REPLAY：原调用内容不符');requireTask(prior.state==='SUCCEEDED','DECISION_CHANNEL_RESULT_UNKNOWN：原调用未核查，不重发');return prior.result;}}
      // The request may have waited for the operation lock while its owner or
      // original intent changed. Recheck the lease and binding before sending.
      if(!mutating)return v.client.call(req.method,req.params);
      let pending;
      await withRuntime(spec.root,async loc=>{
       await requireAssignmentAuthority(loc,req,{converging:!creation&&req.method!=='turn/steer'&&!(req.method==='thread/goal/set'&&req.params.status==='active')});
       const current=(await readBindings(loc)).assignments[req.assignmentId];
       requireTask(current?.runId===req.runId&&current.backendServiceId===spec.serviceId&&!current.retiredAt&&current.backendRequest?.operationId===b.backendRequest?.operationId,'DECISION_CHANNEL_ASSIGNMENT：等待锁期间执行归属或原意图已改变');
       if(req.method==='turn/steer')requireTask(!current.closureReceipt&&current.backendRequest?.turnId===req.params.expectedTurnId&&current.interventions?.[req.operationId]?.state==='PENDING','INTERVENTION_TURN：原轮次已改变');
       if(creation)requireTask(!current.closureReceipt&&current.backendRequest.state===b.backendRequest.state,'DECISION_CHANNEL_ASSIGNMENT：原执行意图已改变');
       if(req.method==='thread/resume')requireTask(!current.closureReceipt,'BACKEND_CLOSED：已关闭会话禁止恢复');
       await durableDecisionFile(file,intent);
       // The initialized transport starts this send before the admission lock
       // is released. Awaiting the RPC reply outside it keeps pause responsive.
       pending=v.client.call(req.method,req.params).then(result=>({result}),error=>({error}));
      });
      try{const outcome=await pending;if(outcome.error)throw outcome.error;const result=outcome.result;if(mutating)await durableDecisionFile(file,{...intent,state:'SUCCEEDED',result,completedAt:new Date().toISOString()});return result;}
      catch(error){if(mutating)await durableDecisionFile(file,{...intent,state:'RESULT_UNKNOWN',error:error.message});throw error;}
     };
     if(once)await mkdir(path.dirname(file),{recursive:true,mode:0o700});
     return once?processLock(file+'.lock',perform):perform();
    })().then(result=>stream.end(JSON.stringify({result})+'\n'),error=>stream.end(JSON.stringify({error:error.message})+'\n'));
   });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(p.channelSocket,resolve);});
  requireTask(!stopping,'DECISION_CHANNEL_DISCONNECTED：启动期间连接已结束');
  await chmod(p.channelSocket,0o600);const st=await lstat(p.channelSocket);
  await save({status:'READY',socketIdentity:{dev:st.dev,ino:st.ino},readyAt:new Date().toISOString()});
  const interval=setInterval(()=>{void ingest.then(()=>drainDecisionInbox(spec.root)).catch(error=>shutdown(error));},2000);
  if(handleSignals)for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(interval);void shutdown().then(()=>process.exit(0));});
  // A lost connection is never reused. Restart/subscribe is an explicit managed
  // recovery, and a new connection never sends an old callback ID on its own.
  await new Promise(resolve=>server.once('close',resolve));clearInterval(interval);
 }catch(error){await shutdown(error);if(server?.listening)server.close();nativeClient?.close();throw error;}
}
