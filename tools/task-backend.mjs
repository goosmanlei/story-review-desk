import path from 'node:path';
import {realpath,readFile,mkdir,lstat,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {durableExecutionFile as atomic} from './execution-runtime.mjs';
import {processLock,phaseRecords,requiredPhase} from './process-resources.mjs';
import {location,readLedger,readBindings,requireRun,requireTask,mutate as ledgerMutate,updateBinding as ledgerUpdateBinding,configureCapabilities,requireAssignmentAuthority} from './task-ledger.mjs';
import {ensureAppService as ensureTaskServer,verifyAppService as verifyTaskServer} from './app-service.mjs';
import {probeTaskServer,stopTaskServer} from './task-server.mjs';
import {closeNativeThread,pauseNativeThread,nativeTurns} from './task-native.mjs';
import {readPause,pauseBlocks,pauseHash,readPauseFile,verifyPauseWorkspace} from './task-pause-state.mjs';
import {channelClient,ensureDecisionChannel,stopDecisionChannel,callDecisionChannel} from './task-decision-channel.mjs';
import {decisionTool,decisionInstructions,pendingDecisions,decisionHash} from './task-decision-protocol.mjs';
import {assertNoPendingDecisions,cancelAssignmentDecisions,drainDecisionInbox,decisionSnapshot,decisionVersions,unappliedDecisionRequest,readDecisionFile} from './task-decisions.mjs';
import {executionAuthority,withExecutionAuthority} from './task-execution-scope.mjs';
import {agentTools,agentInstructions} from './task-agent-tools.mjs';
import {assignmentRole,assignmentDescendants} from './task-tree.mjs';
import {requireTaskCapacity} from './task-capacity.mjs';

export const backendInScope=withExecutionAuthority;
const mutate=(project,action,request)=>ledgerMutate(project,action,{...request,...(executionAuthority()?{authority:executionAuthority()}:{})});
const updateBinding=(project,runId,assignmentId,callback)=>ledgerUpdateBinding(project,runId,assignmentId,callback,{authority:executionAuthority()});
const authorize=(loc,runId,assignmentId,options={})=>requireAssignmentAuthority(loc,{runId,assignmentId,authority:executionAuthority()},options);

const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const requestFingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const schema={type:'object',additionalProperties:false,required:['summary','artifacts','acceptance','completedSteps','nextSteps'],properties:{summary:{type:'string'},artifacts:{type:'array',items:{type:'string'}},acceptance:{type:'array',items:{type:'object',additionalProperties:false,required:['criterion','evidence'],properties:{criterion:{type:'integer'},evidence:{type:'string'}}}},completedSteps:{type:'array',items:{type:'string'}},nextSteps:{type:'array',items:{type:'string'}}}};
const normalizeCwd=cwd=>cwd?.startsWith('file:')?fileURLToPath(cwd):cwd;
async function assigned(project,runId,assignmentId,{converging=false}={}){
 const loc=await location(project),run=await authorize(loc,runId,assignmentId,{converging}),ledger=await readLedger(loc),bindings=await readBindings(loc);
 const task=Object.values(ledger.tasks).find(t=>t.assignments?.some(a=>a.id===assignmentId)),assignment=task?.assignments.find(a=>a.id===assignmentId),binding=bindings.assignments[assignmentId];
 requireTask(assignment&&assignment.status!=='CLOSED'&&assignment.execution.mode==='SUBAGENT','BACKEND_ASSIGNMENT：需要未关闭子Agent派工');
 requireTask(binding?.runId===runId,'BACKEND_RUN：派工须先由当前协调运行核查恢复');
 return {loc,run,task,assignment,binding};
}
async function change(project,runId,assignmentId,action,operationId,extra={}){
 const s=await assigned(project,runId,assignmentId,{converging:true});
 return mutate(project,'assignment:'+action,{operationId,actor:'PROJECT_CODEX',runId,taskId:s.task.id,assignmentId,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.assignment.version,...extra});
}
async function verifyBackendServer(project,runId,assignmentId){
 const v=await verifyTaskServer(project);v.client.close();
 const channel=await callDecisionChannel(project,{action:'ping'});
 requireTask(channel.generation===v.record.generation,'DECISION_CHANNEL_GENERATION：先恢复项目决策连接');
 return {...v,client:channelClient(project,runId,assignmentId,{authority:executionAuthority()})};
}
export async function restoreBackendReceipts(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true}),original=s.binding.backendRequest;
 if(!original)return;
 for(const method of ['thread/start','turn/start']){
  if(method==='thread/start'&&s.binding.nativeThreadId&&s.binding.backendCreation?.threadId===s.binding.nativeThreadId||method==='turn/start'&&original.turnId)continue;
  const key=decisionHash({assignmentId,operationId:original.operationId,method}),receipt=await readDecisionFile(path.join(s.loc.runtime,'decision-channel/calls',key+'.json'));
  if(!receipt||receipt.state!=='SUCCEEDED')continue;
  requireTask(receipt.assignmentId===assignmentId&&receipt.operationId===original.operationId&&receipt.method===method&&receipt.serviceId===s.binding.backendServiceId&&receipt.generation===(original.generation||s.binding.backendGeneration),'BACKEND_RECEIPT：原调用回执绑定不符');
  await updateBinding(project,runId,assignmentId,async b=>{
   requireTask(b.backendRequest.operationId===original.operationId&&!b.closureReceipt,'BACKEND_RECEIPT：原操作已改变或关闭');
   if(method==='thread/start'){
    const id=receipt.result?.thread?.id;requireTask(typeof id==='string'&&id&&receipt.params.cwd===b.workspace,'BACKEND_RECEIPT：创建回执与工作区不符');
    requireTask((!b.nativeThreadId||b.nativeThreadId===id)&&(!b.backendCreation||b.backendCreation.threadId===id),'BACKEND_RECEIPT：原线程不能换绑');
    requireTask(!Object.entries((await readBindings(s.loc)).assignments).some(([other,value])=>other!==assignmentId&&value.nativeThreadId===id),'BACKEND_RECEIPT：线程已属于其他派工');
    b.nativeThreadId=id;b.backendCreation||={threadId:id,serviceId:receipt.serviceId,generation:receipt.generation,createdAt:receipt.completedAt};
   }else {
    const id=receipt.result?.turn?.id;requireTask(typeof id==='string'&&id&&receipt.params.threadId===b.nativeThreadId&&(!b.backendRequest.turnId||b.backendRequest.turnId===id),'BACKEND_RECEIPT：轮次回执不符');
    b.backendRequest.turnId=id;b.backendRequest.startedAt||=receipt.at;
   }
  });
 }
}
async function withDecisionStatus(project,assignmentId,result){
 await drainDecisionInbox(project);
 const loc=await location(project),ledger=await readLedger(loc),bindings=await readBindings(loc),a=Object.values(ledger.tasks).flatMap(t=>t.assignments||[]).find(a=>a.id===assignmentId),pending=pendingDecisions(a);
 if(await unappliedDecisionRequest(loc,bindings.assignments[assignmentId]?.nativeThreadId))return {...result,executionStatus:result.status,status:'RESULT_UNKNOWN',reason:'DECISION_INBOX：原服务请求未完成绑定；先核查，不可验收'};
 if(pending.length)return {...result,executionStatus:result.status,status:'WAITING_DECISION',decisionIds:pending.map(d=>d.id),decisions:pending.map(d=>({id:d.id,status:d.status,kind:d.kind,question:d.question}))};
 return result;
}
export async function assertBackendThread(project,assignmentId,threadId,client,{allowUnloaded=false}={}){
 const loc=await location(project),binding=(await readBindings(loc)).assignments[assignmentId],service=JSON.parse(await readFile(path.join(loc.runtime,'server/server.json'),'utf8'));
 requireTask(binding?.backendServiceId===service.serviceId&&binding.nativeThreadId===threadId&&binding.backendCreation?.threadId===threadId&&binding.backendCreation?.serviceId===service.serviceId,'BACKEND_OWNERSHIP：缺少本项目服务创建回执');
 const read=await client.call('thread/read',{threadId,includeTurns:false});
 requireTask(read.thread.id===threadId,'BACKEND_THREAD_ID：服务返回了不同会话');
 requireTask(path.resolve(normalizeCwd(read.thread.cwd))===binding.workspace,'BACKEND_WORKSPACE：会话与派工工作区不符');
 if(!allowUnloaded){const loaded=await client.call('thread/loaded/list',{limit:100});requireTask(loaded.data.includes(threadId)&&read.thread.status?.type!=='notLoaded','BACKEND_NOT_LOADED：须在同一专属服务恢复原派工');}
 return read.thread;
}
async function checkedWorkspace(s,workspace,baseCommit){
 requireTask(typeof workspace==='string'&&/^[a-f0-9]{40}$/.test(baseCommit||''),'BACKEND_WORKTREE：需要工作区和精确基准提交');
 const actual=await realpath(workspace);requireTask(actual.startsWith(path.join(s.loc.root,'.process')+path.sep),'BACKEND_WORKTREE：必须使用项目受管worktree');
 const registered=(await phaseRecords(s.loc.root,s.task.id)).flatMap(({record})=>record.projectId===s.loc.projectId?record.resources:[]).filter(r=>r.kind==='path'&&r.state!=='REMOVED'&&(actual===r.path||actual.startsWith(r.path+path.sep)));
 let owned=false;for(const r of registered){const st=await lstat(r.path);if(st.isDirectory()&&!st.isSymbolicLink()&&st.dev===r.dev&&st.ino===r.ino)owned=true;}
 requireTask(owned,'BACKEND_WORKTREE：目录尚未登记到本正式任务受管资源');
 requireTask((await lstat(path.join(actual,'.git'))).isFile(),'BACKEND_WORKTREE：不接受共享源码目录');
 const machine=JSON.parse(await readFile(path.join(s.loc.root,'instance/runtime/machine.json'),'utf8'));
 const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 requireTask(await realpath(git(actual,'rev-parse','--path-format=absolute','--git-common-dir'))===await realpath(git(machine.sourceRepository,'rev-parse','--path-format=absolute','--git-common-dir')),'BACKEND_WORKTREE：不属于本项目通用核心仓库');
 requireTask(git(actual,'rev-parse','HEAD')===baseCommit&&!git(actual,'status','--porcelain'),'BACKEND_WORKTREE：基准已改变或不是干净worktree');
 return actual;
}
export async function dispatchBackend(project,runId,assignmentId,request){
 const s=await assigned(project,runId,assignmentId);
 requireTask(typeof request.operationId==='string'&&/^[A-Za-z0-9._-]+$/.test(request.operationId)&&typeof request.prompt==='string'&&request.prompt.trim(),'BACKEND_REQUEST：需要唯一操作号及明确工作要求');
 const fingerprint=requestFingerprint(request),prior=s.binding.backendRequest;
 if(prior){requireTask(prior.operationId===request.operationId&&(prior.hash===fingerprint||prior.hash===createHash('sha256').update(JSON.stringify(request)).digest('hex')),'BACKEND_REPLAY：已有原调用，不能换号重复创建；先sync核查');return syncBackend(project,runId,assignmentId);}
 requireTask(s.assignment.status==='RESERVED'&&!s.binding.spawnAttemptAt,'BACKEND_DISPATCH：只能启动未尝试过的派工');
 const workspace=await checkedWorkspace(s,request.workspace,request.baseCommit);
 requireTask(s.run.capabilities.backend==='PROJECT_APP_SERVER','BACKEND_PROBE：先核验专属服务能力');
 const v=await verifyBackendServer(project,runId,assignmentId);
 try{
  requireTask(v.record.serviceId===s.run.capabilities.backendServiceId,'BACKEND_SERVICE_CHANGED：能力不属于当前服务');
  await updateBinding(project,runId,assignmentId,async b=>{await authorize(s.loc,runId,assignmentId);requireTask(!b.backendRequest&&!b.spawnAttemptAt,'BACKEND_REPLAY：原派工已有执行意图，先核查');b.backendServiceId=v.record.serviceId;b.backendGeneration=v.record.generation;b.socket=v.record.socket;b.workspace=workspace;b.backendRequest={operationId:request.operationId,hash:fingerprint,state:'CREATING',generation:v.record.generation,baseCommit:request.baseCommit,prompt:request.prompt,createdAt:new Date().toISOString()};});
  await change(project,runId,assignmentId,'dispatch',request.operationId+'-intent');
  const developerInstructions='你是正式任务中的 '+assignmentRole(s.assignment)+' 执行节点，任务类别 '+s.task.type+'。只执行分配范围与本轮明确授权，遵守核心 AGENTS。软件变更只在隔离 worktree 内，测试使用受管 process；不要 commit/push/deploy。故事业务仅在本任务明确授权且经业务接口时可执行；不访问封存备份、凭据或无关公共服务。普通输入是范围内指导，不是新增制作/发布/付费授权。可以通过 review_task_agent_* 工具自主委派任务内部子节点；不得绕过执行树用原生 spawn 或其他后台 Agent。子节点结束后核查结果、关闭并整合，再交回指定 JSON 结果。主 Agent 管理正式任务总并行及验收。\n正式任务：'+s.task.title+'\n派工：'+s.assignment.goal+'\n允许改动：'+JSON.stringify(s.assignment.resources)+'\n验收：'+JSON.stringify(s.assignment.acceptanceCriteria)+'\n项目根：'+s.loc.root+'\n正式任务 ID：'+s.task.id+'\n执行节点 ID：'+s.assignment.id+'\n受管命令使用本项目 npm run tasks -- guard --assignment '+s.assignment.id+' --task '+s.task.id+' -- COMMAND（项目参数 --project '+s.loc.root+'）；长测试还须通过该项目 process 阶段。';
  const created=await v.client.call('thread/start',{cwd:workspace,model:s.assignment.execution.model,approvalPolicy:'never',sandbox:'danger-full-access',ephemeral:false,historyMode:'legacy',developerInstructions:developerInstructions+'\n'+decisionInstructions+'\n'+agentInstructions,dynamicTools:[decisionTool,...agentTools],serviceName:v.record.serviceId,config:{model_reasoning_effort:s.assignment.execution.effort,'features.multi_agent':false,'features.multi_agent_v2':false}});
  const threadId=created.thread.id;
  await updateBinding(project,runId,assignmentId,b=>{b.nativeThreadId=threadId;b.backendCreation={threadId,serviceId:v.record.serviceId,generation:v.record.generation,createdAt:new Date().toISOString()};b.backendRequest.state='CREATED';});
  await v.client.call('thread/name/set',{threadId,name:assignmentId+' '+s.assignment.goal.slice(0,80)});
  await assertBackendThread(project,assignmentId,threadId,v.client);
  await change(project,runId,assignmentId,'start',request.operationId+'-bind',{nativeThreadId:threadId,workspace,workspaceEvidence:'专属服务创建回执、精确基准提交和独立受管worktree均已核对'});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.state='TURN_STARTING';});
  const turn=await v.client.call('turn/start',{threadId,input:[{type:'text',text:request.prompt}],model:s.assignment.execution.model,effort:s.assignment.execution.effort,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},outputSchema:schema});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.state='RUNNING';b.backendRequest.turnId=turn.turn.id;b.backendRequest.startedAt=new Date().toISOString();});
  await v.client.flush();
  await observeParallel(project).catch(error=>atomic(path.join(v.paths.runtime,'parallel-observation-error.json'),{checkedAt:new Date().toISOString(),error:error.message}));
  return withDecisionStatus(project,assignmentId,{assignmentId,serviceId:v.record.serviceId,nativeThreadId:threadId,turnId:turn.turn.id,status:'RUNNING',model:s.assignment.execution.model,effort:s.assignment.execution.effort});
 }catch(error){await updateBinding(project,runId,assignmentId,b=>{if(b.backendRequest?.operationId===request.operationId&&b.backendRequest.hash===fingerprint){b.backendRequest.error=error.message;b.backendRequest.state='RESULT_UNKNOWN';}});throw error;}finally{v.client.close();}
}
export async function syncBackend(project,runId,assignmentId,{verifyServer=verifyBackendServer,verifyObserver=verifyTaskServer}={}){
 await restoreBackendReceipts(project,runId,assignmentId);
 await reconcileBackendMessages(project,runId,assignmentId);
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.backendRequest,'BACKEND_REQUEST：没有原调用');
 if(!s.binding.nativeThreadId)return {assignmentId,status:'RESULT_UNKNOWN',reason:'创建回执丢失，禁止重发；保留原调用与服务日志待核查'};
 const v=await verifyServer(project,runId,assignmentId);try{
  await v.client.flush();
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
  const state=await v.client.call('thread/read',{threadId:s.binding.nativeThreadId,includeTurns:false});
  let turns,observed;
  try { turns=await nativeTurns(v.client,s.binding.nativeThreadId); }
  catch(error) {
   if(!/unsupported|not supported|unknown method/i.test(error.message))throw error;
   // Some legacy stores cannot page or read turns after the service restarts.
   // Only the original receiver's bound, immutable completion is a fallback.
   requireTask(['idle','notLoaded'].includes(state.thread.status?.type),'BACKEND_TURN_UNKNOWN：历史读取不支持且线程尚未确认空闲，保留原操作');
   observed=await readObservedBackendTurn(s.loc.runtime,assignmentId,s.binding);
   if(!observed)return {assignmentId,operationId:s.binding.backendRequest.operationId,status:'RESULT_UNKNOWN',reason:'历史读取不支持，且没有可核对的原轮次完成通知；保留原操作，不重复执行'};
   turns=[observed.turn];
  }
  if(state.thread.status?.type==='active'&&s.binding.backendRequest.turnId)requireTask(turns.filter(t=>t.status==='inProgress').every(t=>t.id===s.binding.backendRequest.turnId),'BACKEND_TURN_MISMATCH：存在其他活动轮次，不能套用原轮次结果');
  let turn=turns.find(t=>t.id===s.binding.backendRequest.turnId);
  // A single visible turn is not proof of the original operation. Only a durable
  // receipt may supply its ID; a lost reply otherwise stays unknown.
  if(!turn){await updateBinding(project,runId,assignmentId,b=>{requireTask(b.backendRequest.operationId===s.binding.backendRequest.operationId,'BACKEND_OPERATION_CHANGED：原操作已改变');b.backendRequest.state='RESULT_UNKNOWN';});return {assignmentId,status:'RESULT_UNKNOWN',reason:'未发现原轮次，不自动重新执行'};}
  requireTask(state.thread.status?.type!=='active'||turn.status==='inProgress','BACKEND_TURN_MISMATCH：线程活动状态与原轮次不符，保留现场');
  const status=turn.status==='completed'?'SUCCEEDED':['failed','interrupted'].includes(turn.status)?'FAILED':'RUNNING';
  let items=turn.items||[];
  if(status==='SUCCEEDED'&&!items.length&&!observed){
   try{let cursor;do{const page=await v.client.call('thread/items/list',{threadId:s.binding.nativeThreadId,turnId:turn.id,limit:30,...(cursor?{cursor}:{})});items.push(...page.data);cursor=page.nextCursor;if(items.length>5000)throw Error('BACKEND_RESULT_LIMIT：结果条目超过读取范围');}while(cursor);}
   catch(error){if(!/unknown|unsupported|not supported/i.test(error.message))throw error;const history=await v.client.call('thread/read',{threadId:s.binding.nativeThreadId,includeTurns:true});items=history.thread.turns?.find(t=>t.id===turn.id)?.items||[];}
  }
  const final=items.filter(i=>i.type==='agentMessage').at(-1)?.text;let result;
  if(status==='SUCCEEDED'){try{result=JSON.parse(final);}catch{result=null;}}
  await updateBinding(project,runId,assignmentId,b=>{requireTask(b.backendRequest.operationId===s.binding.backendRequest.operationId&&(!b.backendRequest.turnId||b.backendRequest.turnId===turn.id),'BACKEND_OPERATION_CHANGED：原操作已改变');b.backendRequest.turnId=turn.id;b.backendRequest.state=status;b.backendRequest.nativeStatus=turn.status;b.backendRequest.error=turn.error||null;if(status!=='RUNNING')b.backendRequest.completedAt ||= new Date().toISOString();});
  const directory=path.join(s.loc.runtime,'backend-results');await mkdir(directory,{recursive:true,mode:0o700});
  if(status!=='RUNNING'){
   const saved={assignmentId,operationId:s.binding.backendRequest.operationId,originRunId:s.binding.originRunId||s.binding.runId,runId,serviceId:s.binding.backendServiceId,generation:v.record.generation,threadId:state.thread.id,turnId:turn.id,status,nativeStatus:turn.status,result,finalResponse:final||null,error:turn.error||null,...(observed?{source:observed.source}:{}),checkedAt:new Date().toISOString()};
   await atomic(path.join(directory,'operations',requestFingerprint({assignmentId,operationId:saved.operationId})+'.json'),saved);
   await atomic(path.join(directory,assignmentId+'.json'),saved);
  }
  await confirmDecisionFollowup(project,runId,assignmentId);
  // A dispatch reply can arrive before its thread reports active. Sample actual
  // overlap again while tracking running work, including recovered work.
  if(status==='RUNNING')await observeParallel(project,verifyObserver).catch(error=>atomic(path.join(s.loc.runtime,'parallel-observation-error.json'),{checkedAt:new Date().toISOString(),error:error.message}));
  await v.client.flush();
  return withDecisionStatus(project,assignmentId,{assignmentId,operationId:s.binding.backendRequest.operationId,status,nativeThreadId:state.thread.id,turnId:turn.id,resultReady:!!result,error:turn.error||null});
 }finally{v.client.close();}
}
export async function readObservedBackendTurn(runtime,assignmentId,binding) {
 const request=binding.backendRequest,threadId=binding.nativeThreadId,turnId=request?.turnId;
 if(!threadId||!turnId||binding.backendCreation?.threadId!==threadId)return null;
 const key=decisionHash({assignmentId,operationId:request.operationId,method:'turn/start'});
 const receipt=await readDecisionFile(path.join(runtime,'decision-channel/calls',key+'.json'));
 if(!receipt)return null;
 requireTask(receipt.rpcId===key&&receipt.state==='SUCCEEDED'&&receipt.method==='turn/start'&&receipt.assignmentId===assignmentId&&receipt.operationId===request.operationId&&receipt.serviceId===binding.backendServiceId&&receipt.generation===request.generation&&receipt.params?.threadId===threadId&&receipt.result?.turn?.id===turnId&&typeof receipt.connectionId==='string'&&receipt.connectionId,'BACKEND_NOTIFICATION_RECEIPT：原启动回执不能对应本派工轮次');
 const directory=path.join(runtime,'decision-channel/inbox');
 const names=(await readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));
 requireTask(names.length<=50000,'BACKEND_NOTIFICATION_LIMIT：通知超过有界回读范围，保留原操作');
 const completions=[],items=[];
 for(const name of names) {
  const entry=await readDecisionFile(path.join(directory,name)),message=entry?.message,params=message?.params;
  if(!params||(params.threadId||params.conversationId)!==threadId||(params.turnId||params.turn?.id)!==turnId||!['turn/completed','item/completed'].includes(message.method))continue;
  if(entry.serviceId!==receipt.serviceId||entry.generation!==receipt.generation||entry.connectionId!==receipt.connectionId)continue;
  const hash=decisionHash({serviceId:entry.serviceId,generation:entry.generation,connectionId:entry.connectionId,message});
  requireTask(entry.id===hash&&name===hash+'.json'&&!Object.hasOwn(message,'id'),'BACKEND_NOTIFICATION_INTEGRITY：完成通知身份或摘要不符');
  requireTask(Number.isFinite(Date.parse(entry.receivedAt))&&Number.isFinite(Date.parse(receipt.at))&&Date.parse(entry.receivedAt)>=Date.parse(receipt.at),'BACKEND_NOTIFICATION_TIME：通知先于原执行意图或时间未知');
  if(message.method==='turn/completed')completions.push(entry);
  else if(params.item?.type==='agentMessage'&&params.item.phase==='final_answer')items.push(entry);
 }
 if(!completions.length)return null;
 requireTask(completions.every(e=>['completed','failed','interrupted'].includes(e.message.params.turn.status)),'BACKEND_NOTIFICATION_STATUS：原轮次缺少终态');
 requireTask(new Set(completions.map(e=>decisionHash(e.message.params.turn))).size===1,'BACKEND_NOTIFICATION_CONFLICT：原轮次完成通知冲突');
 const completion=completions[0],turn=structuredClone(completion.message.params.turn);
 const finalItems=(turn.items||[]).filter(i=>i.type==='agentMessage'&&i.phase==='final_answer');
 for(const entry of items)if(Date.parse(entry.receivedAt)<=Date.parse(completion.receivedAt))finalItems.push(entry.message.params.item);
 const unique=new Map(finalItems.map(i=>[decisionHash({id:i.id,text:i.text}),i]));
 requireTask(unique.size<=1,'BACKEND_NOTIFICATION_CONFLICT：原轮次最终答复冲突');
 // Missing final text remains resultReady=false; no report file is substituted.
 turn.items=[...unique.values()];
 return {turn,source:{kind:'PERSISTED_ORIGINAL_NOTIFICATION',receiptId:key,notificationId:completion.id,generation:completion.generation,connectionId:completion.connectionId}};
}
export async function collectBackend(project,runId,assignmentId,operationId){
 await assertNoPendingDecisions(project,assignmentId);
 const sync=await syncBackend(project,runId,assignmentId);requireTask(sync.status==='SUCCEEDED'&&sync.resultReady,'BACKEND_RESULT：尚无完整可验收结果');
 const s=await assigned(project,runId,assignmentId,{converging:true});
 requireTask(s.binding.backendRequest.operationId===sync.operationId,'BACKEND_OPERATION_CHANGED：结果回收期间原操作已改变');
 const saved=JSON.parse(await readFile(path.join(s.loc.runtime,'backend-results/operations',requestFingerprint({assignmentId,operationId:sync.operationId})+'.json'),'utf8'));
 requireTask(saved.operationId===sync.operationId&&saved.threadId===s.binding.nativeThreadId&&saved.turnId===s.binding.backendRequest.turnId&&saved.status==='SUCCEEDED','BACKEND_RESULT：结果与原操作绑定不符');
 const r=saved.result;
 const previous=s.assignment.checkpoint||{},operations=new Map((previous.operations||[]).map(op=>[op.id,op]));
 for(const original of [...(s.binding.backendHistory||[]),s.binding.backendRequest])if(['SUCCEEDED','FAILED'].includes(original.state))operations.set(original.operationId,{id:original.operationId,kind:'SOFTWARE_AGENT',status:original.state,evidence:'原轮次 '+original.turnId+' 已按原操作回读：'+(original.nativeStatus||original.state)});
 const union=(a,b)=>[...new Set([...(a||[]),...(b||[])])];
 return change(project,runId,assignmentId,'result',operationId,{expectedBackendOperationId:sync.operationId,checkpoint:{summary:r.summary,completedSteps:union(previous.completedSteps,r.completedSteps),nextSteps:r.nextSteps,artifacts:union(previous.artifacts,r.artifacts),inputs:union(previous.inputs,['core '+s.binding.backendRequest.baseCommit]),operations:[...operations.values()]},result:{summary:r.summary,artifacts:union(previous.artifacts,r.artifacts),acceptance:r.acceptance}});
}
export async function closeBackend(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true});
 requireTask(!assignmentDescendants((await readLedger(s.loc)).tasks,assignmentId).some(a=>a.status!=='CLOSED'),'ASSIGNMENT_DESCENDANTS_OPEN：先核查关闭全部后代，再关闭父节点');
 requireTask(s.binding.nativeThreadId,'BACKEND_THREAD：原会话身份未知');
 const v=await verifyBackendServer(project,runId,assignmentId);
 try{
  if(s.binding.closureReceipt){const thread=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});requireTask(thread.status?.type==='notLoaded','BACKEND_CLOSURE_DRIFT：已关闭会话重新加载，保留占用先核查');await cancelAssignmentDecisions(project,runId,assignmentId,{authority:executionAuthority()});return {assignmentId,status:'NATIVE_CLOSED',history:'PRESERVED',replayed:true};}
  const receipt=await closeNativeThread(v.client,s.binding.nativeThreadId,null,{resumeIfUnloaded:true,activeTurnIds:s.binding.backendRequest.turnId?[s.binding.backendRequest.turnId]:[],verifyOwnership:()=>assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true})});
  await updateBinding(project,runId,assignmentId,b=>{b.closureReceipt=receipt;});
  await cancelAssignmentDecisions(project,runId,assignmentId,{authority:executionAuthority()});
  return {assignmentId,status:'NATIVE_CLOSED',history:'PRESERVED'};
 }finally{v.client.close();}
}
export async function pauseBackend(project,runId,assignmentId,pauseId,{verifyServer=verifyBackendServer}={}) {
 const loc=await location(project);
 return processLock(path.join(loc.runtime,'backend-'+assignmentId+'.lock'),async()=>{
  await restoreBackendReceipts(project,runId,assignmentId);
  let s=await assigned(project,runId,assignmentId,{converging:true});
  const pause=await readPause(loc);requireTask(pause?.id===pauseId&&pauseBlocks(pause),'PAUSE_ID_CHANGED');
  if(!s.binding.nativeThreadId){
   requireTask(!s.binding.spawnAttemptAt&&!s.binding.backendRequest,'PAUSE_CREATE_UNKNOWN：先核查原创建调用，不重复创建');
   await updateBinding(project,runId,assignmentId,b=>{b.pauseReceipt={pauseId,verified:true,recoverable:true,notCreated:true,history:'PRESERVED',verifiedAt:new Date().toISOString()};});
   return {status:'PAUSED',assignmentId};
  }
  requireTask(s.binding.backendServiceId,'PAUSE_BACKEND_UNSUPPORTED：原生交互 Agent 须由所属协调者核验，不连接公共服务');
  const v=await verifyServer(project,runId,assignmentId);
  try{
   const verifyOwnership=()=>assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
   if(pause.status==='PAUSED'&&s.binding.pauseReceipt?.generation)requireTask(s.binding.pauseReceipt.generation===v.record.generation,'PAUSE_SERVICE_CHANGED：暂停后的服务代次改变，须重新核查原执行与停止证据');
   if(s.binding.closureReceipt||s.binding.pauseReceipt?.pauseId===pauseId&&s.binding.pauseReceipt.verified&&s.binding.pauseReceipt.generation===v.record.generation){
    const t=await verifyOwnership();requireTask(t.status?.type==='notLoaded','PAUSE_RECEIPT_DRIFT');
    if(s.binding.closureReceipt)await updateBinding(project,runId,assignmentId,b=>{b.pauseReceipt={pauseId,verified:true,closed:true,recoverable:false,history:'PRESERVED'};});
    return {status:'PAUSED',assignmentId,replayed:true};
   }
   const once=async(method,params)=>{
    const id=pauseHash({pauseId,assignmentId,method,params}),file=path.join(loc.runtime,'pauses',pauseId,'rpc',id+'.json');
    const prior=await readPauseFile(file);
    if(prior){requireTask(prior.state==='SUCCEEDED','PAUSE_RPC_RESULT_UNKNOWN：先回读原停止状态，禁止重发 '+method);return prior.result;}
    const intent={pauseId,assignmentId,serviceId:v.record.serviceId,generation:v.record.generation,method,params,state:'PENDING',at:new Date().toISOString()};
    await atomic(file,intent);
    try{const result=await v.client.call(method,params);await atomic(file,{...intent,state:'SUCCEEDED',result});return result;}
    catch(error){await atomic(file,{...intent,state:'RESULT_UNKNOWN',error:error.message});throw error;}
   };
   const receipt=await pauseNativeThread(v.client,s.binding.nativeThreadId,{verifyOwnership,once,turnId:s.binding.backendRequest?.turnId,
    stoppedEvidence:s.binding.pauseStopEvidence?.pauseId===pauseId&&s.binding.pauseStopEvidence.generation===v.record.generation?s.binding.pauseStopEvidence.evidence:null,
    saveStopped:evidence=>updateBinding(project,runId,assignmentId,b=>{b.pauseStopEvidence={pauseId,generation:v.record.generation,evidence};})});
   await updateBinding(project,runId,assignmentId,b=>{
    requireTask(b.nativeThreadId===s.binding.nativeThreadId&&b.backendRequest?.operationId===s.binding.backendRequest?.operationId&&!b.closureReceipt,'PAUSE_OPERATION_CHANGED');
    b.pauseReceipt={...receipt,pauseId,serviceId:v.record.serviceId,generation:v.record.generation,operationId:b.backendRequest?.operationId};
   });
   return {status:'PAUSED',assignmentId};
  }finally{v.client.close();}
 });
}
export async function recoverBackend(project,runId,assignmentId,{ensureServer=ensureTaskServer,ensureChannel=ensureDecisionChannel,verifyServer=verifyBackendServer}={}){
 await restoreBackendReceipts(project,runId,assignmentId);
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.nativeThreadId&&s.binding.backendCreation?.threadId===s.binding.nativeThreadId,'BACKEND_RECOVERY：缺少原创建回执');
 requireTask(!s.binding.closureReceipt,'BACKEND_CLOSED：已核验关闭的派工不得重新加载');
 await ensureServer(project);await ensureChannel(project);const v=await verifyServer(project,runId,assignmentId);
 try{
  const thread=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
  // Resume subscribes this persistent connection to the original thread. It
  // does not start a turn and does not transfer old callback IDs to a new one.
  const recoveryKey=requestFingerprint({assignmentId,threadId:s.binding.nativeThreadId,generation:v.record.generation});
  const prior=s.binding.recoveryCalls?.[recoveryKey];
  if(prior){
   if(thread.status?.type==='notLoaded'){
    const original=await syncBackend(project,runId,assignmentId,{verifyServer});
    return ['SUCCEEDED','FAILED'].includes(original.executionStatus||original.status)?original:{...original,status:'RESULT_UNKNOWN',reason:'BACKEND_RECOVERY_UNKNOWN：原恢复调用已发送但会话未加载；只查询，不重发'};
   }
   requireTask(['idle','active'].includes(thread.status?.type),'BACKEND_RECOVERY_UNKNOWN：原恢复调用已发送；只查询，不重发');
  }else{
   await updateBinding(project,runId,assignmentId,b=>{requireTask(!b.recoveryCalls?.[recoveryKey]&&!b.closureReceipt,'BACKEND_RECOVERY_CHANGED');b.recoveryCalls||={};b.recoveryCalls[recoveryKey]={state:'PENDING',threadId:b.nativeThreadId,operationId:b.backendRequest.operationId,generation:v.record.generation,at:new Date().toISOString()};});
   try{
    await v.client.call('thread/resume',{threadId:s.binding.nativeThreadId,cwd:s.binding.workspace,approvalPolicy:'never',excludeTurns:true});
    await updateBinding(project,runId,assignmentId,b=>{b.recoveryCalls[recoveryKey].state='SUCCEEDED';});
   }catch(error){await updateBinding(project,runId,assignmentId,b=>{b.recoveryCalls[recoveryKey].state='RESULT_UNKNOWN';b.recoveryCalls[recoveryKey].error=error.message;});throw error;}
  }
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client);
  await updateBinding(project,runId,assignmentId,b=>{
   requireTask(b.backendRequest.operationId===s.binding.backendRequest.operationId,'BACKEND_OPERATION_CHANGED：原操作已改变');
   b.recoveryHistory||=[];
   if(!b.recoveryHistory.some(r=>r.runId===runId&&r.generation===v.record.generation&&r.operationId===b.backendRequest.operationId))
    b.recoveryHistory.push({runId,originRunId:b.originRunId||b.runId,operationId:b.backendRequest.operationId,serviceId:b.backendServiceId,previousGeneration:b.backendGeneration,generation:v.record.generation,threadId:b.nativeThreadId,turnId:b.backendRequest.turnId||null,checkpointOperationIds:(s.assignment.checkpoint?.operations||[]).map(op=>op.id),at:new Date().toISOString()});
   b.backendGeneration=v.record.generation;b.recoveredAt=new Date().toISOString();
  });
 }finally{v.client.close();}
 return syncBackend(project,runId,assignmentId,{verifyServer});
}
async function observeParallel(project,verifyObserver=verifyTaskServer){
 const loc=await location(project),bindings=await readBindings(loc),ledger=await readLedger(loc);
 const candidates=Object.values(ledger.tasks).flatMap(t=>t.assignments||[]).filter(a=>a.status==='RUNNING'&&bindings.assignments[a.id]?.backendServiceId&&bindings.assignments[a.id]?.backendRequest?.turnId);
 if(candidates.length<2)return;
 // Worker RPC connections are confined to one assignment. The coordinator uses
 // a separately verified read-only observer and still checks each exact binding.
 const v=await verifyObserver(project),results=[];
 try{
  for(const a of candidates){
   const b=bindings.assignments[a.id];if(b.backendServiceId!==v.record.serviceId)continue;
   const thread=await assertBackendThread(project,a.id,b.nativeThreadId,v.client,{allowUnloaded:true});
   if(thread.status?.type==='active'){
    const turns=await nativeTurns(v.client,b.nativeThreadId);
    if(turns.some(t=>t.id===b.backendRequest.turnId&&t.status==='inProgress'))results.push({assignmentId:a.id,status:'RUNNING',nativeThreadId:b.nativeThreadId,turnId:b.backendRequest.turnId});
   }
  }
  if(results.length>=2)await atomic(path.join(loc.runtime,'parallel-validation-sample.json'),{checkedAt:new Date().toISOString(),serviceId:v.record.serviceId,generation:v.record.generation,results});
 }finally{v.client.close();}
}
export async function verifyExecution(project,runId){
 const loc=await location(project),run=await requireRun(loc,runId),ledger=await readLedger(loc),bindings=await readBindings(loc);
 const sample=JSON.parse(await readFile(path.join(loc.runtime,'parallel-validation-sample.json'),'utf8')),v=await verifyTaskServer(project);
 try{
  requireTask(sample.serviceId===v.record.serviceId&&sample.results.length>=2&&new Set(sample.results.map(r=>r.assignmentId)).size===sample.results.length,'BACKEND_EVIDENCE：缺少不同派工实际执行重叠采样');
  for(const r of sample.results){
   const a=Object.values(ledger.tasks).flatMap(t=>t.assignments||[]).find(a=>a.id===r.assignmentId),b=bindings.assignments[r.assignmentId];
   requireTask(a?.status==='CLOSED'&&a.outcome==='ACCEPTED'&&b?.backendServiceId===sample.serviceId&&b.nativeThreadId===r.nativeThreadId&&b.backendRequest?.turnId===r.turnId&&b.closureReceipt?.verified,'BACKEND_EVIDENCE：结果未验收关闭或身份不符');
   requireTask(b.backendRequest.state==='SUCCEEDED'&&Date.parse(b.backendRequest.startedAt)<=Date.parse(sample.checkedAt)&&Date.parse(b.backendRequest.completedAt)>=Date.parse(sample.checkedAt),'BACKEND_EVIDENCE：原轮次未覆盖采样时刻');
   const t=await assertBackendThread(project,a.id,b.nativeThreadId,v.client,{allowUnloaded:true});requireTask(t.status?.type==='notLoaded','BACKEND_EVIDENCE：会话仍加载');
   const saved=JSON.parse(await readFile(path.join(loc.runtime,'backend-results',a.id+'.json'),'utf8'));requireTask(saved.status==='SUCCEEDED'&&saved.turnId===r.turnId&&saved.result,'BACKEND_EVIDENCE：成果未保存');
  }
  const proof={checkedAt:new Date().toISOString(),overlapAt:sample.checkedAt,assignmentIds:sample.results.map(r=>r.assignmentId),serviceId:v.record.serviceId,history:'PRESERVED'};
  await atomic(path.join(loc.runtime,'server/execution-proof.json'),proof);
  return configureCapabilities(project,runId,{...run.capabilities,executionVerified:true,executionProof:proof,limitation:'专属服务真实软件派工、并行重叠、成果验收及关闭已核验；长任务使用FOLLOWUP'});
 }finally{v.client.close();}
}
export async function pausedCheckpointResult(loc,saved,binding) {
 const original=binding?.backendRequest;
 if(!original||original.state!=='SUCCEEDED')return {checkpoint:saved.checkpoint,resultReady:false};
 const result=await readPauseFile(path.join(loc.runtime,'backend-results/operations',requestFingerprint({assignmentId:saved.assignmentId,operationId:original.operationId})+'.json'));
 if(!result?.result)return {checkpoint:saved.checkpoint,resultReady:false};
 requireTask(result.operationId===original.operationId&&result.turnId===original.turnId&&result.threadId===binding.nativeThreadId&&result.status==='SUCCEEDED','PAUSE_RESULT_IDENTITY');
 const r=result.result;requireTask(['completedSteps','nextSteps','artifacts'].every(k=>Array.isArray(r[k])),'PAUSE_RESULT_SHAPE');
 const union=(a,b)=>[...new Set([...(a||[]),...(b||[])])];
 return {checkpoint:{...saved.checkpoint,summary:r.summary,completedSteps:union(saved.checkpoint.completedSteps,r.completedSteps),nextSteps:r.nextSteps,artifacts:union(saved.checkpoint.artifacts,r.artifacts)},resultReady:true,operationId:original.operationId};
}
export async function continueBackend(project,runId,assignmentId,request,{verifyServer=verifyBackendServer}={}){
 const s=await assigned(project,runId,assignmentId);
 const receipt=s.binding.pauseReceipt;
 const fromPause=receipt?.verified&&receipt.recoverable&&!receipt.notCreated&&(!receipt.continuedOperationId||receipt.continuedOperationId===request.operationId)&&!request.prompt;
 if(fromPause){
  requireTask(Object.keys(request).length===1&&typeof request.operationId==='string','PAUSE_CONTINUE_INPUT：只接受稳定 operationId，输入来自保存的 checkpoint');
  if(receipt.continuedOperationId===request.operationId&&s.binding.backendRequest.operationId===request.operationId)return syncBackend(project,runId,assignmentId,{verifyServer});
  const p=await readPause(s.loc),snapshot=await readPauseFile(path.join(s.loc.runtime,'pauses',receipt.pauseId,'checkpoint.json'));
  requireTask(p?.id===receipt.pauseId&&p.status==='RESUMED'&&p.resumedByRunId===runId&&snapshot&&pauseHash(snapshot)===p.snapshot.hash,'PAUSE_RESUME_REQUIRED：先 task run 核查暂停检查点');
  const saved=snapshot.checkpoints[assignmentId];await verifyPauseWorkspace(saved.workspace);
  requireTask(pauseHash(saved.checkpoint)===pauseHash(s.assignment.checkpoint),'PAUSE_CHECKPOINT_CHANGED');
  const effective=await pausedCheckpointResult(s.loc,saved,s.binding);
  requireTask(effective.checkpoint.nextSteps.length,'PAUSE_RESULT_READY：已完成工作须回收验收，不启动重复轮次');
  const prompt='从最近已核验的安全 checkpoint 继续原未完成派工。已完成步骤和成果不得重复执行；所有外部操作先查询原编号。暂停不提供任何新增授权，未解决的问题仍等待用户明确答复。\n'+JSON.stringify({goal:s.assignment.goal,checkpoint:effective.checkpoint,originalOperation:snapshot.bindings.assignments[assignmentId].backendRequest,decisions:(s.assignment.decisions||[]).map(d=>({id:d.id,kind:d.kind,status:d.status,question:d.question,...(['BUSINESS','INPUT'].includes(d.kind)&&d.answer?{answer:d.answer}:{} )}))});
  request={...request,prompt,pauseId:receipt.pauseId};
  const waiting=pendingDecisions(s.assignment);
  if(waiting.length){
   const original=await syncBackend(project,runId,assignmentId,{verifyServer}),b=(await readBindings(s.loc)).assignments[assignmentId];
   requireTask(['SUCCEEDED','FAILED'].includes(original.executionStatus||original.status)&&['completed','interrupted'].includes(b.backendRequest.nativeStatus),'PAUSE_DECISION_ORIGINAL_UNKNOWN');
   for(const d of waiting){const wire=b.decisions?.[d.id];requireTask(['BUSINESS','INPUT'].includes(d.kind)&&d.answer&&wire&&wire.protocolState!=='PENDING'&&!wire.deliveryAttemptedAt,'DECISION_PENDING：待用户明确答复，或先核查原回传；失效审批不得用于续办');}
   for(const d of waiting){
    const current=await decisionSnapshot(project,d.id);
    if(current.decision.status!=='FOLLOWUP_READY')await mutate(project,'decision:reconcile',{operationId:'pause-decision-'+decisionHash({pauseId:receipt.pauseId,decisionId:d.id,answerOperationId:d.answer.operationId}),actor:'PROJECT_CODEX',runId,...decisionVersions(current),resolution:'FOLLOWUP',checkedOriginalOperation:true,evidence:'已核查原暂停轮次 '+original.turnId+' 与从未回传的明确答复；同派工 checkpoint 续办'});
   }
   request.decisionIds=waiting.map(d=>d.id);
  }
 }
 requireTask(['RUNNING','BLOCKED','WAITING_DECISION'].includes(s.assignment.status)&&(s.assignment.execution.goalMode==='FOLLOWUP'||fromPause||request.intervention===true)&&!s.binding.closureReceipt,'BACKEND_FOLLOWUP：仅继续未交回、未关闭的同一长派工或已核验暂停工作');
 requireTaskCapacity((await readLedger(s.loc)).tasks,s.task.id);
 requireTask(typeof request.operationId==='string'&&/^[A-Za-z0-9._-]+$/.test(request.operationId)&&typeof request.prompt==='string'&&request.prompt.trim(),'BACKEND_REQUEST：需要唯一操作号及范围内续办要求');
 const fingerprint=requestFingerprint(request);
 if(s.binding.backendRequest.operationId===request.operationId){requireTask(s.binding.backendRequest.hash===fingerprint,'BACKEND_REPLAY：同号内容不符');return syncBackend(project,runId,assignmentId,{verifyServer});}
 requireTask(!s.binding.backendHistory?.some(r=>r.operationId===request.operationId),'BACKEND_REPLAY：此操作已在历史中；查询原结果，不重复执行');
 const pending=pendingDecisions((await assigned(project,runId,assignmentId)).assignment);
 if(request.decisionIds){requireTask(pending.length&&pending.length===request.decisionIds.length&&pending.every(d=>request.decisionIds.includes(d.id)&&d.status==='FOLLOWUP_READY')&&(fromPause||request.prompt===decisionFollowupPrompt(pending)),'DECISION_FOLLOWUP：只传回已核查的原问题答复，不能扩大范围');}
 else await assertNoPendingDecisions(project,assignmentId);
 const status=await syncBackend(project,runId,assignmentId,{verifyServer});
 const pausedInterrupted=fromPause&&(status.executionStatus||status.status)==='FAILED'&&(await readBindings(s.loc)).assignments[assignmentId].backendRequest.nativeStatus==='interrupted';
 requireTask(status.status==='SUCCEEDED'||pausedInterrupted||request.decisionIds&&status.status==='WAITING_DECISION'&&status.executionStatus==='SUCCEEDED','BACKEND_FOLLOWUP：上一轮尚未确认成功或安全暂停；先恢复核查');
 const v=await verifyServer(project,runId,assignmentId);
 try{
  if(fromPause){
   const t=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
   if(t.status?.type==='notLoaded'){
    const file=path.join(s.loc.runtime,'pauses',receipt.pauseId,'resume-'+assignmentId+'.json'),prior=await readPauseFile(file);
    requireTask(!prior,'PAUSE_RESUME_RESULT_UNKNOWN：已发送原恢复调用；只核查原线程，不重发');
    await atomic(file,{state:'PENDING',operationId:request.operationId,threadId:s.binding.nativeThreadId,generation:v.record.generation});
    await v.client.call('thread/resume',{threadId:s.binding.nativeThreadId,cwd:s.binding.workspace,approvalPolicy:'never',excludeTurns:true});
    await atomic(file,{state:'SUCCEEDED',operationId:request.operationId,threadId:s.binding.nativeThreadId,generation:v.record.generation});
   }
  }
  const current=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client);
  requireTask(current.status?.type==='idle','BACKEND_FOLLOWUP_ACTIVE：原会话尚未确认空闲');
  await updateBinding(project,runId,assignmentId,async b=>{await authorize(s.loc,runId,assignmentId);requireTask(b.backendRequest.operationId===s.binding.backendRequest.operationId&&b.backendRequest.turnId===s.binding.backendRequest.turnId&&(b.backendRequest.state==='SUCCEEDED'||pausedInterrupted&&b.backendRequest.nativeStatus==='interrupted')&&!b.closureReceipt,'BACKEND_OPERATION_CHANGED：上一轮状态或原操作已改变，不能并行续办');b.backendHistory||=[];b.backendHistory.push(b.backendRequest);b.backendRequest={operationId:request.operationId,hash:fingerprint,prompt:request.prompt,pauseId:request.pauseId||null,decisionIds:request.decisionIds||[],generation:v.record.generation,baseCommit:b.backendRequest.baseCommit,state:'TURN_STARTING',createdAt:new Date().toISOString()};if(fromPause)b.pauseReceipt.continuedOperationId=request.operationId;});
  for(const id of request.decisionIds||[]){const current=await decisionSnapshot(project,id);await mutate(project,'decision:followup-start',{operationId:'dc-followup-'+decisionHash({operationId:request.operationId,decisionId:id}),actor:'PROJECT_CODEX',runId,...decisionVersions(current),followupOperationId:request.operationId});}
  const turn=await v.client.call('turn/start',{threadId:s.binding.nativeThreadId,input:[{type:'text',text:request.prompt}],model:s.assignment.execution.model,effort:s.assignment.execution.effort,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},outputSchema:schema});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.turnId=turn.turn.id;b.backendRequest.startedAt=new Date().toISOString();b.backendRequest.state='RUNNING';});
  await confirmDecisionFollowup(project,runId,assignmentId);
  await v.client.flush();
  await observeParallel(project).catch(error=>atomic(path.join(s.loc.runtime,'parallel-observation-error.json'),{checkedAt:new Date().toISOString(),error:error.message}));return withDecisionStatus(project,assignmentId,{assignmentId,status:'RUNNING',turnId:turn.turn.id,nativeThreadId:s.binding.nativeThreadId});
 }catch(error){await updateBinding(project,runId,assignmentId,b=>{if(b.backendRequest.operationId===request.operationId){b.backendRequest.state='RESULT_UNKNOWN';b.backendRequest.error=error.message;}});throw error;}finally{v.client.close();}
}
export const decisionFollowupPrompt=decisions=>'继续原派工的同一范围。以下是主会话保存的用户明确答复；先核对已完成步骤及原操作，不能重复副作用，不扩大授权。\n'+JSON.stringify(decisions.map(d=>({decisionId:d.id,question:d.question,answer:d.answer.value,completedSteps:d.completedSteps,pendingWork:d.pendingWork})));
export async function reconcileBackendMessages(project,runId,assignmentId) {
 let s=await assigned(project,runId,assignmentId,{converging:true});
 for(const message of s.assignment.interventions||[]){
  if(!['PENDING','RESULT_UNKNOWN'].includes(message.status))continue;
  const wire=s.binding.interventions?.[message.operationId];if(!wire)continue;
  const method=wire.method==='STEER'?'turn/steer':'turn/start',operationId=wire.method==='STEER'?message.operationId:message.operationId+'-turn';
  const key=decisionHash({assignmentId,operationId,method}),receipt=await readDecisionFile(path.join(s.loc.runtime,'decision-channel/calls',key+'.json'));
  if(receipt?.state!=='SUCCEEDED')continue;
  requireTask(receipt.rpcId===key&&receipt.assignmentId===assignmentId&&receipt.operationId===operationId&&receipt.method===method&&receipt.serviceId===wire.serviceId&&receipt.generation===wire.generation&&receipt.params.threadId===wire.threadId,'INTERVENTION_RECEIPT：原消息回执身份不符');
  const original=[s.binding.backendRequest,...(s.binding.backendHistory||[])].find(r=>r?.operationId===operationId);
  requireTask(method==='turn/steer'?receipt.params.expectedTurnId===wire.turnId&&decisionHash(receipt.params.input)===decisionHash([{type:'text',text:message.text}]):typeof receipt.result?.turn?.id==='string'&&original?.prompt===interventionPrompt(message.text)&&decisionHash(receipt.params.input)===decisionHash([{type:'text',text:original.prompt}]),'INTERVENTION_RECEIPT：原轮次或消息内容不符');
  await mutate(project,'intervention:settle',{operationId:message.operationId+'-observed-'+key.slice(0,12),actor:'TASK_APP_SERVER',runId,taskId:s.task.id,assignmentId,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.assignment.version,interventionOperationId:message.operationId,status:'SENT',receipt:{rpcId:key,source:'PERSISTED_ORIGINAL_RECEIPT'},reason:'已回读原消息调用成功回执；没有重发'});
  s=await assigned(project,runId,assignmentId,{converging:true});
 }
}
const interventionPrompt=text=>'用户/父节点对原派工的范围内指导。继续本节点未完成工作，保留既有成果；不扩大任务授权。\n'+text;
// One durable message intent precedes exactly one steer/continuation. The lock
// is shared with coordinator backend commands and other attached terminals.
export async function sendBackend(project,runId,assignmentId,request,{authority=executionAuthority(),verifyServer=verifyBackendServer}={}) {
 return backendInScope(authority,async()=>{
  const loc=await location(project);
  return processLock(path.join(loc.runtime,'backend-'+assignmentId+'.lock'),async()=>{
   await reconcileBackendMessages(project,runId,assignmentId);
   const ledger=await readLedger(loc),task=Object.values(ledger.tasks).find(t=>t.assignments?.some(a=>a.id===assignmentId)),a=task?.assignments.find(a=>a.id===assignmentId);
   requireTask(typeof request.operationId==='string'&&/^[A-Za-z0-9._-]+$/.test(request.operationId),'INTERVENTION_ID：需要稳定消息编号');
   const prior=a?.interventions?.find(i=>i.operationId===request.operationId);
   if(prior){requireTask(prior.text===request.text&&prior.actor===(request.actor||'USER'),'INTERVENTION_REPLAY：同号消息内容不符');return {assignmentId,operationId:prior.operationId,status:prior.status,replayed:true,message:prior.status==='SENT'?'原消息已送入会话；不重复发送':'原消息尚待核查；不重复发送'};}
   await assigned(project,runId,assignmentId);
   await assertNoPendingDecisions(project,assignmentId);
   const sync=await syncBackend(project,runId,assignmentId,{verifyServer});
   requireTask(['RUNNING','SUCCEEDED'].includes(sync.status),'INTERVENTION_STATE：执行尚未确认活动或空闲，请先核查');
   const s=await assigned(project,runId,assignmentId),method=sync.status==='RUNNING'?'STEER':'CONTINUE';
   const versions=state=>({taskId:state.task.id,assignmentId,expectedVersions:{[state.task.id]:state.task.version},expectedAssignmentVersion:state.assignment.version});
   await mutate(project,'intervention:record',{operationId:request.operationId,actor:request.actor||'USER',runId,...versions(s),text:request.text,method,expectedTurnId:s.binding.backendRequest.turnId});
   const settle=async(status,receipt,reason)=>{
    const current=await assigned(project,runId,assignmentId,{converging:true});
    const original=current.assignment.interventions?.find(i=>i.operationId===request.operationId);
    if(original?.status==='SENT')return {operationId:original.operationId,status:'SENT',replayed:true};
    return mutate(project,'intervention:settle',{operationId:request.operationId+'-receipt',actor:'TASK_APP_SERVER',runId,...versions(current),interventionOperationId:request.operationId,status,receipt,reason});
   };
   let delivered;
   try {
    if(method==='STEER') {
     const v=await verifyServer(project,runId,assignmentId);
     try {
      await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client);
      delivered=await v.client.call('turn/steer',{threadId:s.binding.nativeThreadId,expectedTurnId:s.binding.backendRequest.turnId,input:[{type:'text',text:request.text}]},{operationId:request.operationId});
     } finally {v.client.close();}
    } else delivered=await continueBackend(project,runId,assignmentId,{operationId:request.operationId+'-turn',prompt:interventionPrompt(request.text),intervention:true},{verifyServer});
   } catch(error) {
    // Even a lost transport reply must leave this operation occupied. A new
    // operation number is not permission to send the same intervention twice.
    await settle('RESULT_UNKNOWN',null,error.message);
    return {assignmentId,operationId:request.operationId,status:'RESULT_UNKNOWN',message:'消息结果未知，已保留原操作；先核查回执，不能重发',reason:error.message};
   }
   await settle('SENT',delivered);
   return {assignmentId,operationId:request.operationId,status:'SENT',method,message:method==='STEER'?'消息已送入正在执行的原轮次':'消息已保存并在原节点继续执行'};
  });
 });
}
async function confirmDecisionFollowup(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true});
 if(!s.binding.backendRequest?.turnId||!['RUNNING','SUCCEEDED'].includes(s.binding.backendRequest.state))return;
 for(const d of pendingDecisions(s.assignment))if(s.binding.decisions?.[d.id]?.followupOperationId===s.binding.backendRequest.operationId){
  const current=await decisionSnapshot(project,d.id);
  await mutate(project,'decision:followup-confirm',{operationId:'dc-confirm-'+decisionHash({operationId:s.binding.backendRequest.operationId,decisionId:d.id}),actor:'PROJECT_CODEX',runId,...decisionVersions(current),followupOperationId:s.binding.backendRequest.operationId});
 }
}
export async function backendAction(project,action,values,input={}){
 const loc=await location(project);
 if(['ensure','probe','recover','stop'].includes(action)){const phase=await requiredPhase(project);requireTask(phase&&(await phase.context()).root===loc.root,'服务生命周期须通过本项目受管process阶段执行');}
 await requireRun(loc,values.run,{converging:['sync','collect','close','recover','stop'].includes(action)});
 if(action==='ensure'){const server=await ensureTaskServer(project),channel=await ensureDecisionChannel(project);return {...server,decisionChannel:channel};}
 if(action==='probe'){const capability=await probeTaskServer(project),channel=await ensureDecisionChannel(project);return configureCapabilities(project,values.run,{...capability,decisionChannel:{id:channel.id,generation:channel.generation,status:channel.status}});}
 if(action==='stop'){await stopDecisionChannel(project);return stopTaskServer(project);}
 if(action==='verify-execution')return verifyExecution(project,values.run);
 requireTask(values.assignment,'BACKEND_ASSIGNMENT：需要派工编号');
 return processLock(path.join(loc.runtime,'backend-'+values.assignment+'.lock'),async()=>{
  if(action==='continue')return continueBackend(project,values.run,values.assignment,input);
  if(action==='dispatch')return dispatchBackend(project,values.run,values.assignment,input);
  if(action==='sync')return syncBackend(project,values.run,values.assignment);
  if(action==='collect')return collectBackend(project,values.run,values.assignment,input.operationId);
  if(action==='recover')return recoverBackend(project,values.run,values.assignment);
  if(action==='close')return closeBackend(project,values.run,values.assignment);
  throw Error('未知backend动作');
 });
}
