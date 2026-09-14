import path from 'node:path';
import {realpath,readFile,mkdir,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomic} from './io.mjs';
import {processLock,phaseRecords,requiredPhase} from './process-resources.mjs';
import {location,readLedger,readBindings,requireRun,requireTask,mutate,updateBinding,configureCapabilities} from './task-ledger.mjs';
import {ensureTaskServer,verifyTaskServer,probeTaskServer,stopTaskServer} from './task-server.mjs';
import {closeNativeThread,nativeTurns} from './task-native.mjs';
import {channelClient,ensureDecisionChannel,stopDecisionChannel,callDecisionChannel} from './task-decision-channel.mjs';
import {decisionTool,decisionInstructions,pendingDecisions,decisionHash} from './task-decision-protocol.mjs';
import {assertNoPendingDecisions,cancelAssignmentDecisions,drainDecisionInbox,decisionSnapshot,decisionVersions,unappliedDecisionRequest,readDecisionFile} from './task-decisions.mjs';
import {requireTaskCapacity} from './task-capacity.mjs';

const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const requestFingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const schema={type:'object',additionalProperties:false,required:['summary','artifacts','acceptance','completedSteps','nextSteps'],properties:{summary:{type:'string'},artifacts:{type:'array',items:{type:'string'}},acceptance:{type:'array',items:{type:'object',additionalProperties:false,required:['criterion','evidence'],properties:{criterion:{type:'integer'},evidence:{type:'string'}}}},completedSteps:{type:'array',items:{type:'string'}},nextSteps:{type:'array',items:{type:'string'}}}};
const normalizeCwd=cwd=>cwd?.startsWith('file:')?fileURLToPath(cwd):cwd;
async function assigned(project,runId,assignmentId,{converging=false}={}){
 const loc=await location(project),run=await requireRun(loc,runId,{converging}),ledger=await readLedger(loc),bindings=await readBindings(loc);
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
 return {...v,client:channelClient(project,runId,assignmentId)};
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
  await change(project,runId,assignmentId,'dispatch',request.operationId+'-intent');
  await updateBinding(project,runId,assignmentId,b=>{b.backendServiceId=v.record.serviceId;b.backendGeneration=v.record.generation;b.socket=v.record.socket;b.workspace=workspace;b.backendRequest={operationId:request.operationId,hash:fingerprint,state:'CREATING',generation:v.record.generation,baseCommit:request.baseCommit,prompt:request.prompt,createdAt:new Date().toISOString()};});
  const developerInstructions='你是项目正式SYSTEM任务的独立软件工作Agent。只在分配的隔离worktree内修改明确资源；不操作故事业务、数据库、媒体、封存备份、凭据、公共服务。不得spawn其他Agent，不commit/push/deploy。使用受管process执行测试。遵守核心AGENTS。完成后输出指定JSON结果并结束，主Agent负责验收和关闭。\n正式任务：'+s.task.title+'\n派工：'+s.assignment.goal+'\n允许改动：'+JSON.stringify(s.assignment.resources)+'\n验收：'+JSON.stringify(s.assignment.acceptanceCriteria);
  const created=await v.client.call('thread/start',{cwd:workspace,model:s.assignment.execution.model,approvalPolicy:'never',sandbox:'danger-full-access',ephemeral:false,historyMode:'legacy',developerInstructions:developerInstructions+'\n'+decisionInstructions,dynamicTools:[decisionTool],serviceName:v.record.serviceId,config:{model_reasoning_effort:s.assignment.execution.effort}});
  const threadId=created.thread.id;
  await updateBinding(project,runId,assignmentId,b=>{b.nativeThreadId=threadId;b.backendCreation={threadId,serviceId:v.record.serviceId,generation:v.record.generation,createdAt:new Date().toISOString()};b.backendRequest.state='CREATED';});
  await v.client.call('thread/name/set',{threadId,name:assignmentId+' '+s.assignment.goal.slice(0,80)});
  await assertBackendThread(project,assignmentId,threadId,v.client);
  await change(project,runId,assignmentId,'start',request.operationId+'-bind',{nativeThreadId:threadId,workspace,workspaceEvidence:'专属服务创建回执、精确基准提交和独立受管worktree均已核对'});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.state='TURN_STARTING';});
  const turn=await v.client.call('turn/start',{threadId,input:[{type:'text',text:request.prompt}],model:s.assignment.execution.model,effort:s.assignment.execution.effort,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},outputSchema:schema});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.state='RUNNING';b.backendRequest.turnId=turn.turn.id;b.backendRequest.startedAt=new Date().toISOString();});
  await v.client.flush();
  await observeParallel(project,v).catch(error=>atomic(path.join(v.paths.runtime,'parallel-observation-error.json'),{checkedAt:new Date().toISOString(),error:error.message}));
  return withDecisionStatus(project,assignmentId,{assignmentId,serviceId:v.record.serviceId,nativeThreadId:threadId,turnId:turn.turn.id,status:'RUNNING',model:s.assignment.execution.model,effort:s.assignment.execution.effort});
 }catch(error){await updateBinding(project,runId,assignmentId,b=>{if(b.backendRequest){b.backendRequest.error=error.message;b.backendRequest.state='RESULT_UNKNOWN';}});throw error;}finally{v.client.close();}
}
export async function syncBackend(project,runId,assignmentId,{verifyServer=verifyBackendServer}={}){
 await restoreBackendReceipts(project,runId,assignmentId);
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.backendRequest,'BACKEND_REQUEST：没有原调用');
 if(!s.binding.nativeThreadId)return {assignmentId,status:'RESULT_UNKNOWN',reason:'创建回执丢失，禁止重发；保留原调用与服务日志待核查'};
 const v=await verifyServer(project,runId,assignmentId);try{
  await v.client.flush();
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
  const state=await v.client.call('thread/read',{threadId:s.binding.nativeThreadId,includeTurns:false});
  const turns=await nativeTurns(v.client,s.binding.nativeThreadId);
  if(state.thread.status?.type==='active'&&s.binding.backendRequest.turnId)requireTask(turns.filter(t=>t.status==='inProgress').every(t=>t.id===s.binding.backendRequest.turnId),'BACKEND_TURN_MISMATCH：存在其他活动轮次，不能套用原轮次结果');
  let turn=turns.find(t=>t.id===s.binding.backendRequest.turnId);
  if(!turn&&!s.binding.backendRequest.turnId){const previous=new Set((s.binding.backendHistory||[]).map(r=>r.turnId));const candidates=turns.filter(t=>!previous.has(t.id));requireTask(candidates.length<=1,'BACKEND_TURN_AMBIGUOUS：缺失回执且存在多个轮次');turn=candidates[0];}
  if(!turn)return {assignmentId,status:'RESULT_UNKNOWN',reason:'未发现原轮次，不自动重新执行'};
  requireTask(state.thread.status?.type!=='active'||turn.status==='inProgress','BACKEND_TURN_MISMATCH：线程活动状态与原轮次不符，保留现场');
  const status=turn.status==='completed'?'SUCCEEDED':['failed','interrupted'].includes(turn.status)?'FAILED':'RUNNING';
  let items=turn.items||[];
  if(status==='SUCCEEDED'&&!items.length){
   try{let cursor;do{const page=await v.client.call('thread/items/list',{threadId:s.binding.nativeThreadId,turnId:turn.id,limit:30,...(cursor?{cursor}:{})});items.push(...page.data);cursor=page.nextCursor;if(items.length>5000)throw Error('BACKEND_RESULT_LIMIT：结果条目超过读取范围');}while(cursor);}
   catch(error){if(!/unknown|unsupported|not supported/i.test(error.message))throw error;const history=await v.client.call('thread/read',{threadId:s.binding.nativeThreadId,includeTurns:true});items=history.thread.turns?.find(t=>t.id===turn.id)?.items||[];}
  }
  const final=items.filter(i=>i.type==='agentMessage').at(-1)?.text;let result;
  if(status==='SUCCEEDED'){try{result=JSON.parse(final);}catch{result=null;}}
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.turnId=turn.id;b.backendRequest.state=status;b.backendRequest.nativeStatus=turn.status;b.backendRequest.error=turn.error||null;if(status!=='RUNNING')b.backendRequest.completedAt ||= new Date().toISOString();});
  const directory=path.join(s.loc.runtime,'backend-results');await mkdir(directory,{recursive:true,mode:0o700});
  if(status!=='RUNNING')await atomic(path.join(directory,assignmentId+'.json'),{assignmentId,threadId:state.thread.id,turnId:turn.id,status,nativeStatus:turn.status,result,finalResponse:final||null,error:turn.error||null,checkedAt:new Date().toISOString()});
  await confirmDecisionFollowup(project,runId,assignmentId);
  await v.client.flush();
  return withDecisionStatus(project,assignmentId,{assignmentId,status,nativeThreadId:state.thread.id,turnId:turn.id,resultReady:!!result,error:turn.error||null});
 }finally{v.client.close();}
}
export async function collectBackend(project,runId,assignmentId,operationId){
 await assertNoPendingDecisions(project,assignmentId);
 const sync=await syncBackend(project,runId,assignmentId);requireTask(sync.status==='SUCCEEDED'&&sync.resultReady,'BACKEND_RESULT：尚无完整可验收结果');
 const s=await assigned(project,runId,assignmentId,{converging:true}),saved=JSON.parse(await readFile(path.join(s.loc.runtime,'backend-results',assignmentId+'.json'),'utf8'));
 const r=saved.result;
 return change(project,runId,assignmentId,'result',operationId,{checkpoint:{summary:r.summary,completedSteps:r.completedSteps,nextSteps:r.nextSteps,artifacts:r.artifacts,inputs:['core '+s.binding.backendRequest.baseCommit],operations:[{id:s.binding.backendRequest.operationId,kind:'SOFTWARE_AGENT',status:'SUCCEEDED',evidence:'专属服务原轮次已完成，结果已回读保存'}]},result:{summary:r.summary,artifacts:r.artifacts,acceptance:r.acceptance}});
}
export async function closeBackend(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.nativeThreadId,'BACKEND_THREAD：原会话身份未知');
 const v=await verifyBackendServer(project,runId,assignmentId);
 try{
  if(s.binding.closureReceipt){const thread=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});requireTask(thread.status?.type==='notLoaded','BACKEND_CLOSURE_DRIFT：已关闭会话重新加载，保留占用先核查');await cancelAssignmentDecisions(project,runId,assignmentId);return {assignmentId,status:'NATIVE_CLOSED',history:'PRESERVED',replayed:true};}
  const receipt=await closeNativeThread(v.client,s.binding.nativeThreadId,null,{resumeIfUnloaded:true,activeTurnIds:s.binding.backendRequest.turnId?[s.binding.backendRequest.turnId]:[],verifyOwnership:()=>assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true})});
  await updateBinding(project,runId,assignmentId,b=>{b.closureReceipt=receipt;});
  await cancelAssignmentDecisions(project,runId,assignmentId);
  return {assignmentId,status:'NATIVE_CLOSED',history:'PRESERVED'};
 }finally{v.client.close();}
}
export async function recoverBackend(project,runId,assignmentId){
 await restoreBackendReceipts(project,runId,assignmentId);
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.backendCreation?.threadId===s.binding.nativeThreadId,'BACKEND_RECOVERY：缺少原创建回执');
 requireTask(!s.binding.closureReceipt,'BACKEND_CLOSED：已核验关闭的派工不得重新加载');
 await ensureTaskServer(project);await ensureDecisionChannel(project);const v=await verifyBackendServer(project,runId,assignmentId);
 try{
  const thread=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
  // Resume subscribes this persistent connection to the original thread. It
  // does not start a turn and does not transfer old callback IDs to a new one.
  await v.client.call('thread/resume',{threadId:s.binding.nativeThreadId,cwd:s.binding.workspace,approvalPolicy:'never'});
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client);
  await updateBinding(project,runId,assignmentId,b=>{b.backendGeneration=v.record.generation;b.recoveredAt=new Date().toISOString();});
 }finally{v.client.close();}
 return syncBackend(project,runId,assignmentId);
}
async function observeParallel(project,v){
 const loc=await location(project),bindings=await readBindings(loc),ledger=await readLedger(loc),results=[];
 for(const a of Object.values(ledger.tasks).flatMap(t=>t.assignments||[])){
  const b=bindings.assignments[a.id];if(a.status!=='RUNNING'||b?.backendServiceId!==v.record.serviceId||!b.backendRequest?.turnId)continue;
  const thread=await assertBackendThread(project,a.id,b.nativeThreadId,v.client,{allowUnloaded:true});
  if(thread.status?.type==='active')results.push({assignmentId:a.id,status:'RUNNING',nativeThreadId:b.nativeThreadId,turnId:b.backendRequest.turnId});
 }
 if(results.length>=2)await atomic(path.join(loc.runtime,'parallel-validation-sample.json'),{checkedAt:new Date().toISOString(),serviceId:v.record.serviceId,results});
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
export async function continueBackend(project,runId,assignmentId,request,{verifyServer=verifyBackendServer}={}){
 const s=await assigned(project,runId,assignmentId);
 requireTask(['RUNNING','BLOCKED','WAITING_DECISION'].includes(s.assignment.status)&&s.assignment.execution.goalMode==='FOLLOWUP'&&!s.binding.closureReceipt,'BACKEND_FOLLOWUP：仅继续未交回、未关闭的同一长派工');
 requireTaskCapacity((await readLedger(s.loc)).tasks,s.task.id);
 requireTask(typeof request.operationId==='string'&&/^[A-Za-z0-9._-]+$/.test(request.operationId)&&typeof request.prompt==='string'&&request.prompt.trim(),'BACKEND_REQUEST：需要唯一操作号及范围内续办要求');
 const fingerprint=requestFingerprint(request);
 if(s.binding.backendRequest.operationId===request.operationId){requireTask(s.binding.backendRequest.hash===fingerprint,'BACKEND_REPLAY：同号内容不符');return syncBackend(project,runId,assignmentId,{verifyServer});}
 requireTask(!s.binding.backendHistory?.some(r=>r.operationId===request.operationId),'BACKEND_REPLAY：此操作已在历史中；查询原结果，不重复执行');
 const pending=pendingDecisions(s.assignment);
 if(request.decisionIds){requireTask(pending.length&&pending.length===request.decisionIds.length&&pending.every(d=>request.decisionIds.includes(d.id)&&d.status==='FOLLOWUP_READY')&&request.prompt===decisionFollowupPrompt(pending),'DECISION_FOLLOWUP：只传回已核查的原问题答复，不能扩大范围');}
 else await assertNoPendingDecisions(project,assignmentId);
 const status=await syncBackend(project,runId,assignmentId,{verifyServer});
 requireTask(status.status==='SUCCEEDED'||request.decisionIds&&status.status==='WAITING_DECISION'&&status.executionStatus==='SUCCEEDED','BACKEND_FOLLOWUP：上一轮尚未确认成功；先恢复核查');
 const v=await verifyServer(project,runId,assignmentId);
 try{
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client);
  await updateBinding(project,runId,assignmentId,b=>{b.backendHistory||=[];b.backendHistory.push(b.backendRequest);b.backendRequest={operationId:request.operationId,hash:fingerprint,prompt:request.prompt,decisionIds:request.decisionIds||[],generation:v.record.generation,baseCommit:b.backendRequest.baseCommit,state:'TURN_STARTING',createdAt:new Date().toISOString()};});
  for(const id of request.decisionIds||[]){const current=await decisionSnapshot(project,id);await mutate(project,'decision:followup-start',{operationId:'dc-followup-'+decisionHash({operationId:request.operationId,decisionId:id}),actor:'PROJECT_CODEX',runId,...decisionVersions(current),followupOperationId:request.operationId});}
  const turn=await v.client.call('turn/start',{threadId:s.binding.nativeThreadId,input:[{type:'text',text:request.prompt}],model:s.assignment.execution.model,effort:s.assignment.execution.effort,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},outputSchema:schema});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.turnId=turn.turn.id;b.backendRequest.startedAt=new Date().toISOString();b.backendRequest.state='RUNNING';});
  await confirmDecisionFollowup(project,runId,assignmentId);
  await v.client.flush();
  await observeParallel(project,v).catch(error=>atomic(path.join(v.paths.runtime,'parallel-observation-error.json'),{checkedAt:new Date().toISOString(),error:error.message}));return withDecisionStatus(project,assignmentId,{assignmentId,status:'RUNNING',turnId:turn.turn.id,nativeThreadId:s.binding.nativeThreadId});
 }catch(error){await updateBinding(project,runId,assignmentId,b=>{if(b.backendRequest.operationId===request.operationId){b.backendRequest.state='RESULT_UNKNOWN';b.backendRequest.error=error.message;}});throw error;}finally{v.client.close();}
}
export const decisionFollowupPrompt=decisions=>'继续原派工的同一范围。以下是主会话保存的用户明确答复；先核对已完成步骤及原操作，不能重复副作用，不扩大授权。\n'+JSON.stringify(decisions.map(d=>({decisionId:d.id,question:d.question,answer:d.answer.value,completedSteps:d.completedSteps,pendingWork:d.pendingWork})));
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
