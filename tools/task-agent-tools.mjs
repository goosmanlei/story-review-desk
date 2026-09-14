import path from 'node:path';
import {mkdir,readFile,lstat,realpath} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import * as ledgerApi from './task-ledger.mjs';
import {resources as normalizeResources,assignmentUnknown} from './task-assignments.mjs';
import {findAssignment as find,assignmentAncestors as ancestors,assignmentDescendants as descendants,resourcesWithin} from './task-tree.mjs';
import {decisionHash,pendingDecisions} from './task-decision-protocol.mjs';
import {durableDecisionFile,readDecisionFile} from './task-decisions.mjs';
import {beginPhase,openPhase,phaseRecords,processLock} from './process-resources.mjs';
import {plainDirectory} from './io.mjs';

const demand=(ok,message)=>{if(!ok)throw Error(message);};
const text=(value,name)=>{demand(typeof value==='string'&&value.trim()&&value.length<=30000,'AGENT_TOOL_SCHEMA：'+name+' 须为有界非空文本');return value;};
const key=value=>{text(value,'key');demand(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(value),'AGENT_TOOL_SCHEMA：key 无效');return value;};
const list=(value,name)=>{demand(Array.isArray(value)&&value.length>0&&value.length<=200,'AGENT_TOOL_SCHEMA：'+name+' 须为有界非空数组');return value.map(x=>text(x,name));};
const object=(value,allowed)=>{demand(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k)),'AGENT_TOOL_SCHEMA：参数包含未知字段');return value;};
const stringSchema={type:'string'},stringsSchema={type:'array',items:stringSchema,minItems:1,maxItems:200};
const resourceSchema={type:'object',additionalProperties:false,required:['kind','key','access'],properties:{kind:{enum:['FILE','DIRECTORY','OBJECT','UNKNOWN']},key:stringSchema,access:{enum:['READ','WRITE']},version:stringSchema}};
const definition=(name,description,required,properties)=>({type:'function',name:'review_task_agent_'+name,description,inputSchema:{type:'object',additionalProperties:false,required,properties}});

export const agentTools=Object.freeze([
 definition('spawn','Create a managed descendant for one bounded part of your own formal task. Keep the same key when recovering an uncertain request. Workspace, parent, task and authorization are assigned by the service; children cannot commit, push or deploy. Returns once the original turn is started, without waiting for the child to finish.',
  ['key','goal','prompt','deliverables','acceptanceCriteria','resources','execution'],{
   key:stringSchema,goal:stringSchema,prompt:stringSchema,deliverables:stringsSchema,acceptanceCriteria:stringsSchema,
   resources:{type:'array',items:resourceSchema,minItems:1,maxItems:200},dependsOn:{type:'array',items:stringSchema},
   execution:{type:'object',additionalProperties:false,required:['rationale'],properties:{rationale:stringSchema,workClass:{enum:['LOOKUP','RESEARCH','IMPLEMENTATION','HIGH_RISK']},model:stringSchema,effort:stringSchema,longRunning:{type:'boolean'}}},
  }),
 definition('send','Send scoped instructions to one descendant through its original managed backend. Reuse the same key and text if the delivery result is unknown. This does not grant new task, business, model-call or external-operation authorization.',['key','assignmentId','text'],{key:stringSchema,assignmentId:stringSchema,text:stringSchema}),
 definition('read','Read a descendant and its original backend result, or list your descendant tree when assignmentId is omitted. Does not accept or close work.',[],{assignmentId:stringSchema}),
 definition('wait','Wait for a descendant to leave RUNNING, for at most timeoutMs (default 10000, maximum 30000). Returns on pending decisions, pause, stop or unknown results. The event receiver remains available while this tool waits.', ['assignmentId'],{assignmentId:stringSchema,timeoutMs:{type:'integer',minimum:0,maximum:30000}}),
 definition('accept','Collect and accept a descendant result after you have checked its evidence. All of its descendants must already be handled and closed. Acceptance never releases resources or closes the native thread.', ['key','assignmentId','evidence'],{key:stringSchema,assignmentId:stringSchema,evidence:stringSchema}),
 definition('close','Close one descendant only after its descendants are closed and original operations are known. Preserves history, checkpoints and worktree artifacts for integration. ACCEPTED requires prior acceptance; cancellation requires a reason.', ['key','assignmentId','outcome','cleanup'],{key:stringSchema,assignmentId:stringSchema,outcome:{enum:['ACCEPTED','CANCELLED','REPLACED']},cleanup:stringSchema,reason:stringSchema}),
]);

export const agentInstructions='每个正式任务由独立 WORKER 负责。你可按实际需要自行拆分、调度同任务的 SUBAGENT 及其后代，不设应用层子 Agent 数量上限；依赖和资源仍须满足约束。所有派生、通信、读取、等待、验收和关闭只能调用 review_task_agent_* 受管工具，禁止使用原生 spawn/fork、另起 App Server 或 codex exec 绕过登记。工具不接受 taskId、parentId、workspace 或权限令牌；身份来自当前请求所属线程。spawn 的 key 在重试中保持稳定，RESULT_UNKNOWN 必须回查原操作，不能换 key 重建。只把自己已获授权范围内可独立完成的工作交给后代；分出的写资源在后代关闭前由它占用，自己继续不重叠工作。子工作区固定根 WORKER 的精确 baseCommit；保留成果、checkpoint 和整合输入，不 commit/push/deploy，不借派生扩大业务裁决、模型调用或外部操作授权。read/wait 可看子树状态；send 仅在本子树内沟通。先检查每个后代成果并 accept、close，或说明原因取消并 close；所有后代关闭、未知操作和待决问题处理后才能提交自己的最终结果。';

const names=new Set(agentTools.map(t=>t.name));
export const isAgentToolMessage=message=>message?.method==='item/tool/call'&&!message.params?.namespace&&names.has(message.params?.tool);
const toolResult=(result,success=true)=>({success,contentItems:[{type:'inputText',text:JSON.stringify(result)}]});
const unknown=b=>['PENDING','CREATING','CREATED','TURN_STARTING','RESULT_UNKNOWN'].includes(b?.backendRequest?.state);
const safeBackend=result=>Object.fromEntries(Object.entries(result||{}).filter(([k])=>['assignmentId','operationId','status','executionStatus','reason','resultReady','error','model','effort','decisionIds','decisions','history','replayed'].includes(k)));
const safeAssignment=a=>Object.fromEntries(Object.entries(a).filter(([k])=>['id','key','taskId','role','parentAssignmentId','rootAssignmentId','status','goal','resources','deliverables','acceptanceCriteria','checkpoint','result','outcome','blockReason'].includes(k)));

function services(injected) {
 const invoke=async(name,project,runId,assignmentId,argument,authority)=>{
  const backend=await import('./task-backend.mjs');
  demand(typeof backend.backendInScope==='function','AGENT_BACKEND_UNAVAILABLE：缺少受管执行权限桥');
  return backend.backendInScope(authority,()=>backend[name](project,runId,assignmentId,...(argument===undefined?[]:[argument])));
 };
 return {
  location:ledgerApi.location,readLedger:ledgerApi.readLedger,readBindings:ledgerApi.readBindings,
  requireAuthority:(...args)=>ledgerApi.requireExecutionAuthority(...args),mutate:ledgerApi.mutate,
  restoreReceipts:(p,r,a,auth)=>invoke('restoreBackendReceipts',p,r,a,undefined,auth),
  lock:processLock,readFile:readDecisionFile,writeFile:durableDecisionFile,
  control:async loc=>{
   const {readPause,pauseBlocks}=await import('./task-pause-state.mjs'),pause=await readPause(loc);
   const run=await readDecisionFile(path.join(loc.runtime,'run.json'));
   return pauseBlocks(pause)?{status:pause.status||'PAUSED'}:run?.stopRequested?{status:'STOP_REQUESTED'}:null;
  },
  backend:{
   dispatch:(p,r,a,q,auth)=>invoke('dispatchBackend',p,r,a,q,auth),
   sync:(p,r,a,auth)=>invoke('syncBackend',p,r,a,undefined,auth),
   collect:(p,r,a,op,auth)=>invoke('collectBackend',p,r,a,op,auth),
   send:(p,r,a,q,auth)=>invoke('sendBackend',p,r,a,q,auth),
   close:(p,r,a,auth)=>invoke('closeBackend',p,r,a,undefined,auth),
  },
  allocateWorkspace:allocateAgentWorkspace,now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  ...injected,
 };
}

async function snapshot(project,svc) {
 const loc=await svc.location(project),[ledger,bindings]=await Promise.all([svc.readLedger(loc),svc.readBindings(loc)]);
 return {loc,ledger,bindings};
}
async function sender(project,context,message,svc,{converging=false}={}) {
 const p=message.params||{};
 demand(isAgentToolMessage(message)&&Object.hasOwn(message,'id')&&['string','number'].includes(typeof message.id),'AGENT_TOOL_REQUEST：缺少原工具请求身份');
 demand(typeof p.threadId==='string'&&p.threadId&&typeof p.turnId==='string'&&p.turnId,'AGENT_TOOL_BINDING：必须使用原请求的 threadId 和 turnId');
 text(p.callId,'原工具 callId');
 demand(context?.serviceId&&context.generation&&context.connectionId,'AGENT_TOOL_CONTEXT：缺少受管接收连接身份');
 let s=await snapshot(project,svc);const matches=Object.entries(s.bindings.assignments).filter(([,b])=>b.nativeThreadId===p.threadId);
 demand(matches.length===1,'AGENT_TOOL_BINDING：原线程没有唯一派工身份');
 const id=matches[0][0];let binding=matches[0][1],entry=find(s.ledger.tasks,id),assignment=entry?.assignment,task=entry?.task;
 demand(assignment&&['WORKER','SUBAGENT'].includes(assignment.role)&&assignment.execution?.mode==='SUBAGENT'&&assignment.status!=='CLOSED'&&!binding.retiredAt&&!binding.closureReceipt,'AGENT_TOOL_BINDING：不是未关闭的受管 Worker 或 Subagent');
 demand(binding.backendServiceId===context.serviceId&&binding.backendGeneration===context.generation&&binding.backendCreation?.serviceId===context.serviceId&&binding.backendCreation.threadId===p.threadId&&binding.backendCreation.generation,'AGENT_TOOL_RECEIPT：原服务创建回执不符');
 const authority={assignmentId:id,executionToken:binding.executionAuthority?.token};
 demand(authority.executionToken,'AGENT_TOOL_AUTHORITY：缺少本派工运行权限');
 // The server can emit a dynamic call before turn/start's reply has reached
 // its binding. Only the persisted original reply may fill this gap; waiting
 // happens outside the decision inbox and never starts or retries a turn.
 const originalOperationId=binding.backendRequest?.operationId;
 for(let attempt=0;(!binding.backendRequest?.turnId||binding.backendRequest.state==='TURN_STARTING')&&attempt<40;attempt++){
  demand(['TURN_STARTING','RESULT_UNKNOWN'].includes(binding.backendRequest?.state),'AGENT_TOOL_TURN：缺少原轮次意图');
  await svc.requireAuthority(s.loc,authority,{taskId:task.id,assignmentId:id,relation:'self',converging:true});
  await svc.restoreReceipts(project,binding.runId,id,authority);
  s=await snapshot(project,svc);binding=s.bindings.assignments[id];entry=find(s.ledger.tasks,id);assignment=entry?.assignment;task=entry?.task;
  demand(binding?.nativeThreadId===p.threadId&&binding.backendServiceId===context.serviceId&&binding.backendGeneration===context.generation&&binding.backendRequest?.operationId===originalOperationId&&!binding.closureReceipt&&!binding.retiredAt&&assignment?.status!=='CLOSED','AGENT_TOOL_BINDING：回读原轮次期间身份已改变');
  demand(!binding.backendRequest.turnId||binding.backendRequest.turnId===p.turnId,'AGENT_TOOL_TURN：回执属于其他轮次');
  if(!binding.backendRequest.turnId||binding.backendRequest.state==='TURN_STARTING')await svc.sleep(50);
 }
 demand(binding.backendRequest?.turnId===p.turnId,'AGENT_TOOL_TURN：原工具请求不属于当前轮次');
 const run=await svc.requireAuthority(s.loc,authority,{taskId:task.id,assignmentId:id,relation:'self',converging});
 if(!converging){demand(!assignmentUnknown(assignment)&&!unknown(binding),'AGENT_TOOL_RESULT_UNKNOWN：先核查原操作');demand(!pendingDecisions(assignment).length,'AGENT_TOOL_DECISION_PENDING：先处理原待决问题');}
 const chain=ancestors(s.ledger.tasks,id),root=chain.at(-1)||assignment;
 demand(root.role==='WORKER'&&root.rootAssignmentId===root.id&&assignment.rootAssignmentId===root.id,'AGENT_TOOL_ROOT：根 Worker 身份不符');
 return {...s,task,assignment,binding,authority,run,root};
}
async function target(project,context,message,svc,id,{converging=true,allowClosed=false}={}) {
 const s=await sender(project,context,message,svc,{converging}),entry=find(s.ledger.tasks,id);
 demand(entry&&entry.task.id===s.task.id&&id!==s.assignment.id&&ancestors(s.ledger.tasks,id).some(a=>a.id===s.assignment.id),'AGENT_TOOL_SUBTREE：只可操作发送者的后代，不能操作自己、祖先、同级或其他任务');
 const binding=s.bindings.assignments[id];
 demand(binding,'AGENT_TOOL_BINDING：后代运行绑定缺失');
 demand(allowClosed||entry.assignment.status!=='CLOSED','AGENT_TOOL_CLOSED：原后代已关闭，禁止恢复或复用');
 if(entry.assignment.status!=='CLOSED')await svc.requireAuthority(s.loc,s.authority,{taskId:s.task.id,assignmentId:id,relation:'descendant',converging});
 return {...s,child:entry.assignment,childBinding:binding};
}
function childrenHandled(s,id) {
 demand(descendants(s.ledger.tasks,id).every(a=>a.status==='CLOSED'),'AGENT_TOOL_CHILDREN_OPEN：先验收或取消并关闭全部后代');
}
function parseArguments(message) {
 const action=message.params.tool.slice('review_task_agent_'.length),raw=message.params.arguments;
 const schema=agentTools.find(t=>t.name===message.params.tool).inputSchema;
 object(raw,Object.keys(schema.properties));
 for(const name of schema.required)demand(Object.hasOwn(raw,name),'AGENT_TOOL_SCHEMA：缺少 '+name);
 const args=structuredClone(raw);
 if('key'in args)key(args.key);
 for(const name of ['assignmentId','goal','prompt','text','evidence','cleanup','reason'])if(name in args)text(args[name],name);
 if(action==='spawn'){
  args.deliverables=list(args.deliverables,'deliverables');args.acceptanceCriteria=list(args.acceptanceCriteria,'acceptanceCriteria');
  demand(Array.isArray(args.resources)&&args.resources.length,'AGENT_TOOL_SCHEMA：必须明确分配资源');
  args.resources.forEach(r=>object(r,['kind','key','access','version']));args.resources=normalizeResources(args.resources);
  object(args.execution,['rationale','workClass','model','effort','longRunning']);text(args.execution.rationale,'execution.rationale');
  for(const name of ['model','effort'])if(name in args.execution)text(args.execution[name],'execution.'+name);
  if('workClass'in args.execution)demand(['LOOKUP','RESEARCH','IMPLEMENTATION','HIGH_RISK'].includes(args.execution.workClass),'AGENT_TOOL_SCHEMA：workClass 无效');
  if('longRunning'in args.execution)demand(typeof args.execution.longRunning==='boolean','AGENT_TOOL_SCHEMA：longRunning 无效');
  if(args.dependsOn){demand(Array.isArray(args.dependsOn)&&args.dependsOn.length<=200,'AGENT_TOOL_SCHEMA：dependsOn 无效');args.dependsOn.forEach(x=>text(x,'dependsOn'));}
 }
 if(action==='wait')demand(args.timeoutMs===undefined||Number.isInteger(args.timeoutMs)&&args.timeoutMs>=0&&args.timeoutMs<=30000,'AGENT_TOOL_SCHEMA：timeoutMs 范围为 0–30000');
 if(action==='close'){demand(['ACCEPTED','CANCELLED','REPLACED'].includes(args.outcome),'AGENT_TOOL_SCHEMA：outcome 无效');if(args.outcome!=='ACCEPTED')text(args.reason,'reason');}
 return {action,args};
}

async function ensureDirectory(directory) {await mkdir(directory,{recursive:true,mode:0o700});await plainDirectory(directory);}
async function savedMutation(s,action,args,svc,perform) {
 const id=decisionHash({taskId:s.task.id,parentAssignmentId:s.assignment.id,action,key:args.key}),directory=path.join(s.loc.runtime,'agent-tools/operations');
 await ensureDirectory(directory);const file=path.join(directory,id+'.json');
 return svc.lock(file+'.lock',async()=>{
  let record=await svc.readFile(file);const hash=decisionHash(args);
  demand(!record||record.inputHash===hash&&record.parentAssignmentId===s.assignment.id&&record.taskId===s.task.id,'AGENT_TOOL_REPLAY：同一 key 的原请求内容不同');
  if(record?.state==='SUCCEEDED')return {...record.result,replayed:true};
  if(!record){record={id,operationId:'agent-'+action+'-'+id,action,taskId:s.task.id,parentAssignmentId:s.assignment.id,inputHash:hash,input:args,state:'PENDING',createdAt:new Date(svc.now()).toISOString()};await svc.writeFile(file,record);}
  const save=async patch=>{Object.assign(record,patch);await svc.writeFile(file,record);};
  try{const result=await perform(record,save);await save({state:result.status==='DEFERRED'?'DEFERRED':result.status==='RESULT_UNKNOWN'?'RESULT_UNKNOWN':'SUCCEEDED',result,updatedAt:new Date(svc.now()).toISOString()});return result;}
  catch(error){await save({state:'RESULT_UNKNOWN',error:error.message,updatedAt:new Date(svc.now()).toISOString()});throw error;}
 });
}

async function spawnChild(project,context,message,args,svc) {
 const initial=await sender(project,context,message,svc);
 return savedMutation(initial,'spawn',args,svc,async(record,save)=>{
  let s=await sender(project,context,message,svc);
  const rootBinding=s.bindings.assignments[s.root.id],baseCommit=rootBinding?.backendRequest?.baseCommit;
  demand(/^[a-f0-9]{40}$/.test(baseCommit||'')&&s.binding.backendRequest.baseCommit===baseCommit,'AGENT_WORKSPACE_BASE：根 Worker 的精确基准缺失或不符');
  demand(resourcesWithin(args.resources,s.assignment.resources)&&resourcesWithin(args.resources,s.root.resources),'AGENT_TOOL_RESOURCE_SCOPE：子资源不得超出父派工或根任务授权范围');
  for(const id of args.dependsOn||[])demand(find(s.ledger.tasks,id)?.task.id===s.task.id&&id!==s.assignment.id&&ancestors(s.ledger.tasks,id).some(a=>a.id===s.assignment.id),'AGENT_TOOL_SUBTREE：依赖须来自当前发送者子树');
  if(!record.assignmentId){
   if(!record.scheduleRequest||record.state==='DEFERRED'){
    const attempt=(record.scheduleAttempt||0)+1;
    const request={operationId:record.operationId+'-schedule-'+attempt,actor:'WORKER_AGENT',runId:s.binding.runId,taskId:s.task.id,parentAssignmentId:s.assignment.id,authority:s.authority,expectedVersions:{[s.task.id]:s.task.version},assignments:[{taskId:s.task.id,key:'child-'+record.id.slice(0,56),role:'SUBAGENT',parentAssignmentId:s.assignment.id,goal:args.goal,deliverables:args.deliverables,acceptanceCriteria:args.acceptanceCriteria,resources:args.resources,dependsOn:args.dependsOn||[],execution:{...args.execution,mode:'SUBAGENT',longRunning:true}}]};
    await save({scheduleRequest:request,scheduleAttempt:attempt,state:'SCHEDULING',baseCommit});
   }
   // Replaying this exact persisted request recovers a reservation even when the
   // process died after the ledger append and before recording its reply.
   const scheduled=await svc.mutate(project,'assignment:schedule',record.scheduleRequest);
   const child=scheduled.assignments?.[0];
   if(!child){await save({scheduleResult:scheduled});return {status:'DEFERRED',key:args.key,reason:scheduled.deferred?.[0]?.reason||scheduled.status};}
   demand(scheduled.assignments.length===1&&child.parentAssignmentId===s.assignment.id&&child.taskId===s.task.id,'AGENT_TOOL_SCHEDULE_RECEIPT：子派工回执不符');
   await save({assignmentId:child.id,scheduleResult:scheduled,state:'RESERVED'});
  }
  s=await target(project,context,message,svc,record.assignmentId,{converging:false});
  demand(record.baseCommit===baseCommit&&s.child.parentAssignmentId===s.assignment.id,'AGENT_TOOL_REPLAY：原创建根基准或直接父身份已改变');
  if(!record.workspace){
   const workspace=await svc.allocateWorkspace({project,loc:s.loc,task:s.task,parent:s.assignment,assignment:s.child,root:s.root,baseCommit,operationId:record.operationId,authority:s.authority,assertAdmission:()=>sender(project,context,message,svc)});
   await save({workspace,state:'WORKSPACE_READY'});
  }
  if(!record.dispatchRequest)await save({dispatchRequest:{operationId:record.operationId+'-dispatch',prompt:args.prompt,workspace:record.workspace.workspace,baseCommit}});
  const current=await target(project,context,message,svc,record.assignmentId,{converging:false});
  // Existing backend intent is read only. No second create RPC is sent after
  // a lost thread/start or turn/start response, including a new callback ID.
  const result=current.childBinding.backendRequest||current.childBinding.spawnAttemptAt
   ? await svc.backend.sync(project,current.childBinding.runId,current.child.id,current.authority)
   : await svc.backend.dispatch(project,current.childBinding.runId,current.child.id,record.dispatchRequest,current.authority);
  return {key:args.key,assignmentId:current.child.id,parentAssignmentId:current.assignment.id,rootAssignmentId:current.root.id,workspace:record.workspace.workspace,baseCommit,...safeBackend(result)};
 });
}

async function readChild(project,context,message,svc,id) {
 let s=await target(project,context,message,svc,id,{allowClosed:true});
 let backend;
 if(s.child.status!=='CLOSED'&&s.childBinding.backendRequest)backend=await svc.backend.sync(project,s.childBinding.runId,id,s.authority);
 s=await target(project,context,message,svc,id,{allowClosed:true});
 const saved=await svc.readFile(path.join(s.loc.runtime,'backend-results',id+'.json'));
 const verified=saved&&saved.assignmentId===id&&saved.operationId===s.childBinding.backendRequest?.operationId&&saved.threadId===s.childBinding.nativeThreadId&&saved.turnId===s.childBinding.backendRequest?.turnId&&saved.serviceId===s.childBinding.backendServiceId;
 return {assignment:safeAssignment(s.child),backend:safeBackend(backend),...(verified?{result:saved.result||null,finalResponse:saved.finalResponse||null}:{}),children:descendants(s.ledger.tasks,id).map(safeAssignment),...(await svc.control(s.loc)||{})};
}

async function operateChild(project,context,message,action,args,svc) {
 const initial=await sender(project,context,message,svc,{converging:action!=='send'});
 return savedMutation(initial,action,args,svc,async(record,save)=>{
  let s=await target(project,context,message,svc,args.assignmentId,{converging:action!=='send',allowClosed:action==='close'});
  if(action==='send'){
   demand(!assignmentUnknown(s.child)&&!unknown(s.childBinding),'AGENT_TOOL_RESULT_UNKNOWN：先 read 原后代操作，不重发消息');
   const result=await svc.backend.send(project,s.childBinding.runId,s.child.id,{operationId:record.operationId,text:args.text,actor:'WORKER_AGENT'},s.authority);
   return {assignmentId:s.child.id,...safeBackend(result)};
  }
  childrenHandled(s,s.child.id);
  demand(!assignmentUnknown(s.child),'AGENT_TOOL_RESULT_UNKNOWN：后代 checkpoint 存在未知操作');
  if(action==='accept'){
   demand(!pendingDecisions(s.child).length,'AGENT_TOOL_DECISION_PENDING：后代仍有待决问题');
   if(!['DELIVERED','ACCEPTED'].includes(s.child.status))await svc.backend.collect(project,s.childBinding.runId,s.child.id,record.operationId+'-collect',s.authority);
   s=await target(project,context,message,svc,args.assignmentId);childrenHandled(s,s.child.id);
   if(s.child.status==='ACCEPTED'&&!record.mutationRequest)return {assignmentId:s.child.id,status:'ACCEPTED',replayed:true};
   if(!record.mutationRequest)await save({mutationRequest:{operationId:record.operationId,actor:'WORKER_AGENT',runId:s.childBinding.runId,authority:s.authority,taskId:s.task.id,assignmentId:s.child.id,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.child.version,evidence:args.evidence}});
   const result=await svc.mutate(project,'assignment:accept',record.mutationRequest);
   return {assignmentId:s.child.id,status:result.status};
  }
  if(s.child.status==='CLOSED'){
   demand(record.mutationRequest,'AGENT_TOOL_CLOSED：后代已由其他关闭操作结束');
  }else {
   if(args.outcome==='ACCEPTED')demand(s.child.status==='ACCEPTED','AGENT_TOOL_ACCEPT_REQUIRED：成功后代须先验收');
   if(unknown(s.childBinding)){
    const original=await svc.backend.sync(project,s.childBinding.runId,s.child.id,s.authority);
    demand(!['RESULT_UNKNOWN','PENDING'].includes(original.status),'AGENT_TOOL_RESULT_UNKNOWN：先核查后代原生操作，不能释放占用');
    s=await target(project,context,message,svc,args.assignmentId);
   }
   if(s.childBinding.nativeThreadId)await svc.backend.close(project,s.childBinding.runId,s.child.id,s.authority);
   else demand(!s.childBinding.spawnAttemptAt&&!s.childBinding.backendRequest,'AGENT_TOOL_RESULT_UNKNOWN：创建身份未知，不能声明已关闭');
   s=await target(project,context,message,svc,args.assignmentId);childrenHandled(s,s.child.id);
  }
  if(!record.mutationRequest)await save({mutationRequest:{operationId:record.operationId,actor:'WORKER_AGENT',runId:s.childBinding.runId,authority:s.authority,taskId:s.task.id,assignmentId:s.child.id,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.child.version,outcome:args.outcome,...(args.reason?{reason:args.reason}:{}),cleanup:args.cleanup+'；保留已登记 worktree、checkpoint 与成果供父派工整合，未删除资源'}});
  const result=await svc.mutate(project,'assignment:close',record.mutationRequest);
  return {assignmentId:s.child.id,status:result.status,history:'PRESERVED',artifacts:'RETAINED_FOR_INTEGRATION'};
 });
}

// The channel calls this outside its ordered decision-inbox queue, then awaits
// this result before replying to the original dynamic-tool request. This module
// does not reply on a socket or retain unawaited backend work of its own.
export async function handleAgentTool(project,context,message,injectedServices={}) {
 const svc=services(injectedServices);
 try {
  demand(isAgentToolMessage(message),'AGENT_TOOL_UNKNOWN');const {action,args}=parseArguments(message);
  const s=await sender(project,context,message,svc,{converging:!['spawn','send'].includes(action)});
  const id=decisionHash({serviceId:context.serviceId,generation:context.generation,connectionId:context.connectionId,requestId:message.id}),directory=path.join(s.loc.runtime,'agent-tools/calls');
  await ensureDirectory(directory);const file=path.join(directory,id+'.json'),requestHash=decisionHash(message);
  return await svc.lock(file+'.lock',async()=>{
   const prior=await svc.readFile(file);demand(!prior||prior.requestHash===requestHash&&prior.assignmentId===s.assignment.id,'AGENT_TOOL_REQUEST_REPLAY：原请求 ID 内容不同');
   if(prior?.response)return prior.response;
   const record=prior||{id,serviceId:context.serviceId,generation:context.generation,connectionId:context.connectionId,requestId:message.id,callId:message.params.callId,assignmentId:s.assignment.id,taskId:s.task.id,requestHash,message,state:'PENDING',receivedAt:new Date(svc.now()).toISOString()};
   if(!prior)await svc.writeFile(file,record);
   let response;
   try {
    let result;
    if(action==='spawn')result=await spawnChild(project,context,message,args,svc);
    else if(['send','accept','close'].includes(action))result=await operateChild(project,context,message,action,args,svc);
    else if(action==='read'){
     if(args.assignmentId)result=await readChild(project,context,message,svc,args.assignmentId);
     else {const current=await sender(project,context,message,svc,{converging:true});result={assignmentId:current.assignment.id,rootAssignmentId:current.root.id,children:descendants(current.ledger.tasks,current.assignment.id).map(safeAssignment)};}
    }else {
     const deadline=svc.now()+(args.timeoutMs??10000);
     do{result=await readChild(project,context,message,svc,args.assignmentId);if(result.status||!['RUNNING','RESERVED'].includes(result.assignment.status)||result.backend.status&&result.backend.status!=='RUNNING')break;if(svc.now()>=deadline){result.timedOut=true;break;}await svc.sleep(Math.min(1000,deadline-svc.now()));}while(true);
    }
    response=toolResult(result);
   }catch(error){response=toolResult({error:error.message},false);}
   await svc.writeFile(file,{...record,state:response.success?'SUCCEEDED':'FAILED',response,completedAt:new Date(svc.now()).toISOString()});
   return response;
  });
 }catch(error){return toolResult({error:error.message},false);}
}

const git=async(root,...args)=>(await promisify(execFile)('git',['-C',root,...args],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024})).stdout.trim();
async function verifyWorkspace(workspace,sourceRepository,baseCommit) {
 const st=await lstat(path.join(workspace,'.git'));
 demand(st.isFile()&&!st.isSymbolicLink(),'AGENT_WORKSPACE：不是独立 Git worktree');
 const [common,sourceCommon,head,status]=await Promise.all([git(workspace,'rev-parse','--path-format=absolute','--git-common-dir'),git(sourceRepository,'rev-parse','--path-format=absolute','--git-common-dir'),git(workspace,'rev-parse','HEAD'),git(workspace,'status','--porcelain')]);
 demand(await realpath(common)===await realpath(sourceCommon)&&head===baseCommit&&!status,'AGENT_WORKSPACE：工作区归属、精确基准或干净状态不符');
 return {workspace:await realpath(workspace),baseCommit};
}
async function addWorktree(phase,source,workspace,baseCommit) {
 let completion;
 try{
  await phase.startChild(async()=>{
   const child=spawn('git',['-C',source,'worktree','add','--detach',workspace,baseCommit],{stdio:['ignore','pipe','pipe']});
   completion=new Promise((resolve,reject)=>{let error='';child.stdout.resume();child.stderr.on('data',b=>{error=(error+b.toString()).slice(-4000);});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('AGENT_WORKSPACE_GIT：'+error)));});
   // Register an error observer before awaiting the durable child receipt.
   completion.catch(()=>{});return child;
  });
  await completion;
 }finally{if(completion)await completion.catch(()=>{});await phase.childEnded();}
}

export async function allocateAgentWorkspace({project,loc,task,parent,assignment,root,baseCommit,operationId,authority,assertAdmission}) {
 demand(/^[a-f0-9]{40}$/.test(baseCommit||''),'AGENT_WORKSPACE_BASE');
 const id=decisionHash({taskId:task.id,assignmentId:assignment.id,operationId}),phaseId='agent-workspace-'+id.slice(0,48),workspace=path.join(loc.root,'.process/shared','agent-'+id.slice(0,48));
 const directory=path.join(loc.runtime,'agent-tools/workspaces');await ensureDirectory(directory);const file=path.join(directory,id+'.json');
 return processLock(file+'.lock',async()=>{
  await assertAdmission();let saved=await readDecisionFile(file);
  demand(!saved||saved.baseCommit===baseCommit&&saved.assignmentId===assignment.id&&saved.parentAssignmentId===parent.id&&saved.rootAssignmentId===root.id,'AGENT_WORKSPACE_REPLAY：原工作区意图不符');
  const save=async patch=>{saved={...saved,...patch};await durableDecisionFile(file,saved);};
  if(!saved)await save({id,operationId,taskId:task.id,assignmentId:assignment.id,parentAssignmentId:parent.id,rootAssignmentId:root.id,baseCommit,workspace,phaseId,state:'PENDING'});
  const machine=JSON.parse(await readFile(path.join(loc.root,'instance/runtime/machine.json'),'utf8'));
  demand(typeof machine.sourceRepository==='string','AGENT_WORKSPACE_SOURCE：本机核心仓库绑定缺失');
  await plainDirectory(machine.sourceRepository);
  const rows=await phaseRecords(project,task.id),existing=rows.find(({record})=>record.phaseId===phaseId);
  let phase;
  if(existing){demand(existing.record.projectId===loc.projectId&&existing.record.taskId===task.id,'AGENT_WORKSPACE_PHASE：资源阶段归属不符');phase=await openPhase({root:loc.root,taskId:task.id,phaseId,token:existing.record.token});}
  else {demand(!saved.phaseContext&&!saved.gitAttemptedAt,'AGENT_WORKSPACE_RESULT_UNKNOWN：原阶段回执缺失，禁止重建');await assertAdmission();phase=await beginPhase(project,task.id,phaseId);await save({phaseContext:await phase.context()});}
  let record=await phase.read(),resource=record.resources.find(r=>r.kind==='path'&&r.path===workspace);
  if(!resource){demand(!saved.gitAttemptedAt,'AGENT_WORKSPACE_RESULT_UNKNOWN：原资源回执缺失');await assertAdmission();await phase.directory(workspace);record=await phase.read();resource=record.resources.find(r=>r.path===workspace);}
  const st=await lstat(workspace);
  demand(resource.state!=='REMOVED'&&st.isDirectory()&&!st.isSymbolicLink()&&resource.dev===st.dev&&resource.ino===st.ino,'AGENT_WORKSPACE_RESULT_UNKNOWN：资源路径身份未知，保留现场');
  if(!resource.consumers?.includes('integrate'))await phase.transfer('path',workspace,'integrate');
  if(saved.gitAttemptedAt){const verified=await verifyWorkspace(workspace,machine.sourceRepository,baseCommit);if((await phase.read()).status==='RUNNING')await phase.finish();await save({state:'READY'});return {...verified,phaseId,resourceStatus:'RETAINED_FOR_INTEGRATION'};}
  await assertAdmission();await save({state:'GIT_STARTING',gitAttemptedAt:new Date().toISOString()});
  try{await addWorktree(phase,machine.sourceRepository,workspace,baseCommit);const verified=await verifyWorkspace(workspace,machine.sourceRepository,baseCommit);await phase.finish();await save({state:'READY'});return {...verified,phaseId,resourceStatus:'RETAINED_FOR_INTEGRATION'};}
  catch(error){await save({state:'RESULT_UNKNOWN',error:error.message});await phase.finish({outcome:'FAILED',recover:true}).catch(()=>{});throw error;}
 });
}
