import path from 'node:path';
import {realpath,readFile,mkdir,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomic} from './io.mjs';
import {processLock} from './process-resources.mjs';
import {location,readLedger,readBindings,requireRun,requireTask,mutate,updateBinding,configureCapabilities} from './task-ledger.mjs';
import {ensureTaskServer,verifyTaskServer,probeTaskServer,stopTaskServer} from './task-server.mjs';
import {closeNativeThread,nativeTurns} from './task-native.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
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
export async function assertBackendThread(project,assignmentId,threadId,client,{allowUnloaded=false}={}){
 const loc=await location(project),binding=(await readBindings(loc)).assignments[assignmentId],service=JSON.parse(await readFile(path.join(loc.runtime,'server/server.json'),'utf8'));
 requireTask(binding?.backendServiceId===service.serviceId&&binding.nativeThreadId===threadId&&binding.backendCreation?.threadId===threadId&&binding.backendCreation?.serviceId===service.serviceId,'BACKEND_OWNERSHIP：缺少本项目服务创建回执');
 const read=await client.call('thread/read',{threadId,includeTurns:false});
 requireTask(path.resolve(normalizeCwd(read.thread.cwd))===binding.workspace,'BACKEND_WORKSPACE：会话与派工工作区不符');
 if(!allowUnloaded){const loaded=await client.call('thread/loaded/list',{limit:100});requireTask(loaded.data.includes(threadId)&&read.thread.status?.type!=='notLoaded','BACKEND_NOT_LOADED：须在同一专属服务恢复原派工');}
 return read.thread;
}
async function checkedWorkspace(s,workspace,baseCommit){
 requireTask(typeof workspace==='string'&&/^[a-f0-9]{40}$/.test(baseCommit||''),'BACKEND_WORKTREE：需要工作区和精确基准提交');
 const actual=await realpath(workspace);requireTask(actual.startsWith(path.join(s.loc.root,'.process')+path.sep),'BACKEND_WORKTREE：必须使用项目受管worktree');
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
 const fingerprint=hash(request),prior=s.binding.backendRequest;
 if(prior){requireTask(prior.operationId===request.operationId&&prior.hash===fingerprint,'BACKEND_REPLAY：已有原调用，不能换号重复创建；先sync核查');return syncBackend(project,runId,assignmentId);}
 requireTask(s.assignment.status==='RESERVED'&&!s.binding.spawnAttemptAt,'BACKEND_DISPATCH：只能启动未尝试过的派工');
 const workspace=await checkedWorkspace(s,request.workspace,request.baseCommit);
 requireTask(s.run.capabilities.backend==='PROJECT_APP_SERVER','BACKEND_PROBE：先核验专属服务能力');
 const v=await verifyTaskServer(project);
 try{
  requireTask(v.record.serviceId===s.run.capabilities.backendServiceId,'BACKEND_SERVICE_CHANGED：能力不属于当前服务');
  await change(project,runId,assignmentId,'dispatch',request.operationId+'-intent');
  await updateBinding(project,runId,assignmentId,b=>{b.backendServiceId=v.record.serviceId;b.backendGeneration=v.record.generation;b.socket=v.record.socket;b.workspace=workspace;b.backendRequest={operationId:request.operationId,hash:fingerprint,state:'CREATING',baseCommit:request.baseCommit,prompt:request.prompt,createdAt:new Date().toISOString()};});
  const developerInstructions='你是项目正式SYSTEM任务的独立软件工作Agent。只在分配的隔离worktree内修改明确资源；不操作故事业务、数据库、媒体、封存备份、凭据、公共服务。不得spawn其他Agent，不commit/push/deploy。使用受管process执行测试。遵守核心AGENTS。完成后输出指定JSON结果并结束，主Agent负责验收和关闭。\n正式任务：'+s.task.title+'\n派工：'+s.assignment.goal+'\n允许改动：'+JSON.stringify(s.assignment.resources)+'\n验收：'+JSON.stringify(s.assignment.acceptanceCriteria);
  const created=await v.client.call('thread/start',{cwd:workspace,model:s.assignment.execution.model,approvalPolicy:'never',sandbox:'danger-full-access',ephemeral:false,developerInstructions,serviceName:v.record.serviceId,config:{model_reasoning_effort:s.assignment.execution.effort}});
  const threadId=created.thread.id;
  await updateBinding(project,runId,assignmentId,b=>{b.nativeThreadId=threadId;b.backendCreation={threadId,serviceId:v.record.serviceId,generation:v.record.generation,createdAt:new Date().toISOString()};b.backendRequest.state='CREATED';});
  await assertBackendThread(project,assignmentId,threadId,v.client);
  await change(project,runId,assignmentId,'start',request.operationId+'-bind',{nativeThreadId:threadId,workspace,workspaceEvidence:'专属服务创建回执、精确基准提交和独立受管worktree均已核对'});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.state='TURN_STARTING';});
  const turn=await v.client.call('turn/start',{threadId,input:[{type:'text',text:request.prompt}],model:s.assignment.execution.model,effort:s.assignment.execution.effort,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},outputSchema:schema});
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.state='RUNNING';b.backendRequest.turnId=turn.turn.id;b.backendRequest.startedAt=new Date().toISOString();});
  return {assignmentId,serviceId:v.record.serviceId,nativeThreadId:threadId,turnId:turn.turn.id,status:'RUNNING',model:s.assignment.execution.model,effort:s.assignment.execution.effort};
 }catch(error){await updateBinding(project,runId,assignmentId,b=>{if(b.backendRequest){b.backendRequest.error=error.message;b.backendRequest.state='RESULT_UNKNOWN';}});throw error;}finally{v.client.close();}
}
export async function syncBackend(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.backendRequest,'BACKEND_REQUEST：没有原调用');
 if(!s.binding.nativeThreadId)return {assignmentId,status:'RESULT_UNKNOWN',reason:'创建回执丢失，禁止重发；保留原调用与服务日志待核查'};
 const v=await verifyTaskServer(project);try{
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
  const state=await v.client.call('thread/read',{threadId:s.binding.nativeThreadId,includeTurns:false});
  if(state.thread.status?.type==='active')return {assignmentId,status:'RUNNING',nativeThreadId:state.thread.id,turnId:s.binding.backendRequest.turnId};
  const turns=await nativeTurns(v.client,s.binding.nativeThreadId);
  let turn=turns.find(t=>t.id===s.binding.backendRequest.turnId);
  if(!turn&&!s.binding.backendRequest.turnId){requireTask(turns.length<=1,'BACKEND_TURN_AMBIGUOUS：缺失回执且存在多个轮次');turn=turns[0];}
  if(!turn)return {assignmentId,status:'RESULT_UNKNOWN',reason:'未发现原轮次，不自动重新执行'};
  const status=turn.status==='completed'?'SUCCEEDED':['failed','interrupted'].includes(turn.status)?'FAILED':'RUNNING';
  let items=turn.items||[];
  if(status==='SUCCEEDED'&&!items.length){let cursor;do{const page=await v.client.call('thread/items/list',{threadId:s.binding.nativeThreadId,turnId:turn.id,limit:30,...(cursor?{cursor}:{})});items.push(...page.data);cursor=page.nextCursor;if(items.length>5000)throw Error('BACKEND_RESULT_LIMIT：结果条目超过读取范围');}while(cursor);}
  const final=items.filter(i=>i.type==='agentMessage').at(-1)?.text;let result;
  if(status==='SUCCEEDED'){try{result=JSON.parse(final);}catch{result=null;}}
  await updateBinding(project,runId,assignmentId,b=>{b.backendRequest.turnId=turn.id;b.backendRequest.state=status;b.backendRequest.nativeStatus=turn.status;b.backendRequest.error=turn.error||null;if(status!=='RUNNING')b.backendRequest.completedAt ||= new Date().toISOString();});
  const directory=path.join(s.loc.runtime,'backend-results');await mkdir(directory,{recursive:true,mode:0o700});
  if(status!=='RUNNING')await atomic(path.join(directory,assignmentId+'.json'),{assignmentId,threadId:state.thread.id,turnId:turn.id,status,nativeStatus:turn.status,result,finalResponse:final||null,error:turn.error||null,checkedAt:new Date().toISOString()});
  return {assignmentId,status,nativeThreadId:state.thread.id,turnId:turn.id,resultReady:!!result,error:turn.error||null};
 }finally{v.client.close();}
}
export async function collectBackend(project,runId,assignmentId,operationId){
 const sync=await syncBackend(project,runId,assignmentId);requireTask(sync.status==='SUCCEEDED'&&sync.resultReady,'BACKEND_RESULT：尚无完整可验收结果');
 const s=await assigned(project,runId,assignmentId,{converging:true}),saved=JSON.parse(await readFile(path.join(s.loc.runtime,'backend-results',assignmentId+'.json'),'utf8'));
 const r=saved.result;
 return change(project,runId,assignmentId,'result',operationId,{checkpoint:{summary:r.summary,completedSteps:r.completedSteps,nextSteps:r.nextSteps,artifacts:r.artifacts,inputs:['core '+s.binding.backendRequest.baseCommit],operations:[{id:s.binding.backendRequest.operationId,kind:'SOFTWARE_AGENT',status:'SUCCEEDED',evidence:'专属服务原轮次已完成，结果已回读保存'}]},result:{summary:r.summary,artifacts:r.artifacts,acceptance:r.acceptance}});
}
export async function closeBackend(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.nativeThreadId,'BACKEND_THREAD：原会话身份未知');
 const v=await verifyTaskServer(project);
 try{
  const receipt=await closeNativeThread(v.client,s.binding.nativeThreadId,null,{resumeIfUnloaded:true,activeTurnIds:s.binding.backendRequest.turnId?[s.binding.backendRequest.turnId]:[],verifyOwnership:()=>assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true})});
  await updateBinding(project,runId,assignmentId,b=>{b.closureReceipt=receipt;});
  return {assignmentId,status:'NATIVE_CLOSED',history:'PRESERVED'};
 }finally{v.client.close();}
}
export async function recoverBackend(project,runId,assignmentId){
 const s=await assigned(project,runId,assignmentId,{converging:true});requireTask(s.binding.backendCreation?.threadId===s.binding.nativeThreadId,'BACKEND_RECOVERY：缺少原创建回执');
 await ensureTaskServer(project);const v=await verifyTaskServer(project);
 try{
  const thread=await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client,{allowUnloaded:true});
  if(thread.status?.type==='notLoaded')await v.client.call('thread/resume',{threadId:s.binding.nativeThreadId,cwd:s.binding.workspace,approvalPolicy:'never'});
  await assertBackendThread(project,assignmentId,s.binding.nativeThreadId,v.client);
  await updateBinding(project,runId,assignmentId,b=>{b.backendGeneration=v.record.generation;b.recoveredAt=new Date().toISOString();});
 }finally{v.client.close();}
 return syncBackend(project,runId,assignmentId);
}
export async function backendAction(project,action,values,input={}){
 const loc=await location(project);await requireRun(loc,values.run,{converging:['sync','collect','close','recover','stop'].includes(action)});
 if(action==='ensure')return ensureTaskServer(project);
 if(action==='probe'){const capability=await probeTaskServer(project);return configureCapabilities(project,values.run,capability);}
 if(action==='stop')return stopTaskServer(project);
 requireTask(values.assignment,'BACKEND_ASSIGNMENT：需要派工编号');
 return processLock(path.join(loc.runtime,'backend-'+values.assignment+'.lock'),async()=>{
  if(action==='dispatch')return dispatchBackend(project,values.run,values.assignment,input);
  if(action==='sync')return syncBackend(project,values.run,values.assignment);
  if(action==='collect')return collectBackend(project,values.run,values.assignment,input.operationId);
  if(action==='recover')return recoverBackend(project,values.run,values.assignment);
  if(action==='close')return closeBackend(project,values.run,values.assignment);
  throw Error('未知backend动作');
 });
}
