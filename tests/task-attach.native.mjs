// Manual, opt-in acceptance against a real local Codex App Server. Importing
// this module or invoking it without --execute never creates a thread/turn.
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,lstat,realpath} from 'node:fs/promises';
import {location,readLedger,readBindings,mutate,startRun,requireRun,heartbeat,stopRun,updateBinding} from '../tools/task-ledger.mjs';
import {dispatchBackend,syncBackend,collectBackend,closeBackend,backendInScope} from '../tools/task-backend.mjs';
import {probeTaskServer,stopTaskServer} from '../tools/task-server.mjs';
import {ensureDecisionChannel,stopDecisionChannel,callDecisionChannel} from '../tools/task-decision-channel.mjs';
import {openAttachClient} from '../tools/task-attach-service.mjs';
import {allocateAgentWorkspace} from '../tools/task-agent-tools.mjs';
import {openPhase,phaseRecords,finishProcessTask,checkProcessTask,releaseConsumer,processAlive} from '../tools/process-resources.mjs';
import {durableDecisionFile,readDecisionFile} from '../tools/task-decisions.mjs';
import {decisionHash} from '../tools/task-decision-protocol.mjs';

const codeRoot=fileURLToPath(new URL('../',import.meta.url));
const demand=(ok,message)=>{if(!ok)throw Error(message);};
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const marker='TASK_ATTACH_NATIVE_FIXTURE';
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const artifactHash=data=>createHash('sha256').update(data).digest('hex');

export async function syncNativeFixtureNode(assignmentId,observedBinding,{sync,readCurrent}) {
 try{return await sync();}
 catch(error){
  let current;try{current=await readCurrent();}catch{throw error;}
  const b=current?.binding,receipt=b?.closureReceipt,threadId=observedBinding?.nativeThreadId;
  const closed=current?.assignment?.id===assignmentId&&current.assignment.status==='CLOSED'&&threadId&&observedBinding.backendServiceId&&
   observedBinding.backendCreation?.threadId===threadId&&observedBinding.backendCreation.serviceId===observedBinding.backendServiceId&&
   b?.nativeThreadId===threadId&&b.backendServiceId===observedBinding.backendServiceId&&
   b.backendCreation?.threadId===threadId&&b.backendCreation.serviceId===observedBinding.backendCreation?.serviceId&&
   receipt?.verified===true&&receipt.nativeThreadId===threadId&&receipt.history==='PRESERVED';
  if(!closed)throw error;
  return {assignmentId,status:'CLOSED',closedDuringSync:true};
 }
}

export async function resumeNativeFixtureChannel(root,loc,{call=callDecisionChannel,read=readDecisionFile,alive=processAlive,ensure=ensureDecisionChannel}={}) {
 try{
  // The original live receiver owns its immutable code bundle and pending
  // callbacks. A newer checkout is not a reason to replace that owner.
  const result=await call(root,{action:'ping'});demand(result.status==='READY','Original native receiver is not READY');return {...result,reused:true};
 }catch(error){
  const record=await read(path.join(loc.runtime,'decision-channel/channel.json'));
  demand(record?.root===root&&record.process&&alive(record.process)===false,'Original native receiver is not confirmed stopped; preserve it: '+error.message);
  return ensure(root);
 }
}

export function nativeAcceptancePlan(argv=process.argv.slice(2)) {
 const {values}=parseArgs({args:argv,options:{execute:{type:'boolean',default:false},resume:{type:'string'},'source-repository':{type:'string'},'base-commit':{type:'string'},model:{type:'string'},effort:{type:'string'},children:{type:'string',default:'1'},'timeout-ms':{type:'string',default:'900000'},'hold-ms':{type:'string',default:'120000'},help:{type:'boolean',default:false}},strict:true});
 const timeoutMs=Number(values['timeout-ms']),holdMs=Number(values['hold-ms']),childCount=Number(values.children);
 demand(Number.isInteger(timeoutMs)&&timeoutMs>=60000&&timeoutMs<=3600000,'timeout-ms must be 60000–3600000');
 demand(Number.isInteger(holdMs)&&holdMs>=30000&&holdMs<=300000,'hold-ms must be 30000–300000');
 demand(Number.isInteger(childCount)&&childCount>=1&&childCount<=20,'children must be an explicit bounded fixture workload from 1 to 20');
 if(values.execute&&!values.resume)demand(values['source-repository']&&/^[a-f0-9]{40}$/.test(values['base-commit']||'')&&values.model&&values.effort,'Explicit execution requires --source-repository, exact --base-commit, --model and --effort');
 return {execute:values.execute&&!values.help,resume:values.resume,sourceRepository:values['source-repository'],baseCommit:values['base-commit'],model:values.model,effort:values.effort,timeoutMs,holdMs,childCount,formalWorkers:3,minimumManagedChildren:childCount,realModelCalls:true};
}

const help=plan=>({status:'NOT_RUN',plan,usage:'Run through tools/process.mjs with a unique phase, then: node tests/task-attach.native.mjs --execute --source-repository CORE --base-commit EXACT_SHA --model MODEL --effort EFFORT. Recovery: same managed runner, --execute --resume ORIGINAL_FIXTURE. The fixture is retained under the original REVIEW_TASK_DIR; resume never creates replacement nodes.'});

async function filesFor(root,task,binding,assignment) {
 const candidates=assignment.resources.filter(r=>r.kind==='FILE').map(r=>r.key);
 if(assignment.role==='WORKER')candidates.push('native-attach/'+task.nativeKey+'/result.json');
 const artifacts=[];
 for(const relative of candidates){
  demand(!path.isAbsolute(relative)&&!relative.split('/').some(p=>p==='..'||p==='.git'),'Invalid fixture artifact');
  const file=path.join(binding.workspace,relative);
  let data;try{data=await readFile(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  artifacts.push({assignmentId:assignment.id,relative,sha256:artifactHash(data),bytes:data.length,content:data.toString('utf8')});
 }
 return artifacts;
}

function commandPrompt(fixture,formalTaskId,phaseName,relative,token,holdMs) {
 const program='const fs=require("node:fs"),path=require("node:path");const out=path.resolve(process.argv[1]);fs.mkdirSync(path.dirname(out),{recursive:true});console.log("NATIVE_STARTED '+token+'");setTimeout(()=>{fs.writeFileSync(out,JSON.stringify({token:'+JSON.stringify(token)+',complete:true})+"\\n");console.log("NATIVE_DONE '+token+'")},'+holdMs+');';
 // This is input for the worker, not a shell command constructed/executed by
 // the harness. The model is told to pass every argv item separately.
 return '使用受管命令完成这一项合成 fixture：argv='+JSON.stringify([process.execPath,path.join(codeRoot,'tools/process.mjs'),'run','--root',fixture,'--task',formalTaskId,'--phase',phaseName,'--',process.execPath,'-e',program,'__OWN_WORKSPACE__/'+relative])+'。必须先把 argv 最后一个元素的 __OWN_WORKSPACE__ 替换为你本次获配的隔离 worktree 绝对路径，不能使用 fixture 项目根；程序通过该绝对路径写入本派工资源 '+relative+'。通过项目根 npm run tasks -- guard --assignment 你自己的节点ID --task '+formalTaskId+' -- 上述argv 运行（不要使用工作区旧版CLI）。使用短 yield 和后续轮询保持可接收消息，不重复启动同一阶段。执行完成后回读 JSON，最终按既定 JSON schema 交付，artifacts 给出该文件绝对路径，acceptance criterion 0 提供实际结果。';
}
function promptFor(journal,taskId,index) {
 const key='work-'+(index+1),relative='native-attach/'+key+'/result.json',token=journal.id+'-'+key;
 const common='这是隔离的 v3 原生验收 fixture，已明确授权本轮使用指定模型、受管子 Agent 与本 fixture 文件。禁止访问真实故事项目、数据库、媒体、凭据，禁止 commit/push/deploy，禁止测试之外的网络或模型调用。只使用自己的工作区与所分配资源。不要发表新的正式任务。工具结果未知先 read 原操作，不换 key，不重复执行。\n';
 if(index!==0)return common+commandPrompt(journal.root,taskId,'native-'+key,relative,token,journal.holdMs)+'\n允许后续范围内 steer/idle followup；接到 ACK 标记时将其加入最终 summary。';
 const specs=Array.from({length:journal.childCount},(_,i)=>{
  const childKey='native-child-'+i,childFile='native-attach/work-1/child-'+i+'.json';
  return {key:childKey,goal:'完成隔离子工作 '+i,prompt:common+commandPrompt(journal.root,taskId,'native-child-'+i,childFile,journal.id+'-child-'+i,30000),deliverables:[childFile],acceptanceCriteria:['实际命令成功且回读 marker JSON'],resources:[{kind:'FILE',key:childFile,access:'WRITE'}],execution:{model:journal.model,effort:journal.effort,rationale:'已明确授权的原生受管子树验收'}};
 });
 return common+'先自主调用 review_task_agent_spawn 创建以下 '+journal.childCount+' 个相互独立的有界 SUBAGENT，按 key 保存返回身份；必须全部发起后再等待，以验证全执行树可以超过 3 个原生节点。不得使用原生 spawn/fork：\n'+JSON.stringify(specs)+'\n通过 read/wait 接收各子节点真实结果，逐项检查，accept 后 close；未知或待决必须如实报告，禁止假称完成。每个子节点 worktree 成果由受管服务保留；所有后代关闭后再完成自己的范围内 marker：\n'+commandPrompt(journal.root,taskId,'native-work-1',relative,token,0)+'\n若收到 STEER_ACK 标记，将其包含在最终 summary。最终 artifacts 汇总各子成果和自己的 marker，completedSteps 描述真实验证。';
}

export async function runNativeAcceptance(plan) {
 if(!plan.execute)return help(plan);
 demand(process.env.REVIEW_TASK_DIR&&process.env.REVIEW_PROCESS_CONTEXT,'Native acceptance must use the managed process runner');
 const enclosing=await openPhase(JSON.parse(process.env.REVIEW_PROCESS_CONTEXT));await enclosing.assertRunning();
 // If the process is interrupted, its fixture, journal, history and live
 // worktree registrations must survive automatic scratch cleanup.
 await enclosing.retain('path',process.env.REVIEW_TASK_DIR,'native App Server acceptance evidence and original-operation recovery');
 let journal,root,file;
 if(plan.resume){
  root=await realpath(plan.resume);file=path.join(root,'native-attach.json');journal=await readDecisionFile(file);
  demand(journal?.kind===marker&&journal.root===root&&journal.id&&journal.projectId,'Refuse to resume anything except the original isolated fixture');
  const instance=JSON.parse(await readFile(path.join(root,'instance/instance.json'),'utf8'));demand(instance.id===journal.projectId,'Fixture identity drift');
 }else {
  const sourceRepository=await realpath(plan.sourceRepository);demand(git(sourceRepository,'cat-file','-t',plan.baseCommit)==='commit','base-commit is not a Git commit');
  root=await mkdtemp(path.join(process.env.REVIEW_TASK_DIR,'task-attach-native-'));file=path.join(root,'native-attach.json');
  journal={kind:marker,id:randomUUID(),projectId:randomUUID(),root,sourceRepository,baseCommit:plan.baseCommit,model:plan.model,effort:plan.effort,holdMs:plan.holdMs,childCount:plan.childCount,state:'PREPARED',createdAt:new Date().toISOString(),operations:{},workspaces:{},evidence:{samples:[],artifacts:[]}};
  await durableDecisionFile(file,journal);await mkdir(path.join(root,'instance/runtime'),{recursive:true});
  await durableDecisionFile(path.join(root,'instance/instance.json'),{id:journal.projectId});
  await durableDecisionFile(path.join(root,'instance/runtime/machine.json'),{sourceRepository});
  await durableDecisionFile(path.join(root,'package.json'),{name:'task-attach-native-fixture',private:true,scripts:{tasks:'node '+shellQuote(path.join(codeRoot,'tools/tasks.mjs')),process:'node '+shellQuote(path.join(codeRoot,'tools/process.mjs'))}});
  await durableDecisionFile(path.join(root,'instance/runtime/process-policy.json'),{schemaVersion:'1.0',enabled:true,projectId:journal.projectId,host:'local',maxTemporaryBytes:64*1024**3,reserveBytes:2*1024**3,registry:'instance/runtime/process',workspace:'.process/stages',parentTasks:'.process/tasks',temporaryRoots:['.process/shared'],protectedPaths:['instance','tasks','native-attach.json']});
 }
 console.log(JSON.stringify({status:plan.resume?'RECOVERING':'PREPARED',fixture:root,journal:file,model:journal.model,effort:journal.effort,baseCommit:journal.baseCommit}));
 const save=async patch=>{Object.assign(journal,patch);await durableDecisionFile(file,journal);};
 const operationId=key=>'native-'+decisionHash({fixtureId:journal.id,key});
 const once=async(key,action,build)=>{
  let original=journal.operations[key];
  if(original&&original.state!=='SUCCEEDED'&&original.request.runId&&run?.id&&original.request.runId!==run.id){
   const ledger=await readLedger(root);
   if(!ledger.events.some(e=>e.operationId===original.request.operationId)){
    // The old coordinator has been verified dead by startRun. A local ledger
    // append is authoritative: absence establishes that this CAS never took
    // effect. Preserve it, then admit the same logical step under the new run.
    journal.operationHistory ||= [];journal.operationHistory.push({key,...original,resolution:'NO_LEDGER_EVENT'});
    original={action,request:{operationId:operationId(key+'-admission-'+run.id),actor:'NATIVE_ACCEPTANCE',...await build()},state:'PENDING'};journal.operations[key]=original;await save({});
   }
  }
  if(!original){original={action,request:{operationId:operationId(key),actor:'NATIVE_ACCEPTANCE',...await build()},state:'PENDING'};journal.operations[key]=original;await save({});}
  demand(original.action===action,'Fixture operation drift');
  if(original.state==='SUCCEEDED')return original.result;
  const result=await mutate(root,action,original.request);original.result=result;original.state='SUCCEEDED';await save({});return result;
 };
 let timer,heartbeatPending=Promise.resolve(),attach,run=journal.run,failed,ownsCoordinator=false;
 const loc=await location(root);
 const state=async()=>({ledger:await readLedger(loc),bindings:await readBindings(loc)});
 const scope=async id=>{const s=await state(),b=s.bindings.assignments[id],task=Object.values(s.ledger.tasks).find(t=>t.assignments?.some(a=>a.id===id));demand(task&&b,'Missing original fixture assignment');return {task,assignment:task.assignments.find(a=>a.id===id),binding:b,authority:b.executionAuthority?.activatedAt?{assignmentId:id,executionToken:b.executionAuthority.token}:null};};
 const backend=async(name,id,...args)=>{const s=await scope(id);return s.authority?backendInScope(s.authority,()=>name(root,s.binding.runId,id,...args)):name(root,run.id,id,...args);};
 try {
  const setupResume=plan.resume&&!journal.workerIds?.length&&Object.keys((await readLedger(loc)).tasks).length===0;
  if(plan.resume&&!setupResume){
   // Recovery observes original identities. A reservation that never obtained
   // activation is left for explicit reconciliation; no replacement is minted.
   demand(journal.workerIds?.length===3&&journal.taskIds?.length===3,'Original setup incomplete; inspect its recorded operation, do not create replacements');
   const existing=await state();
   if(!journal.nativeVerifiedAt||Object.values(existing.ledger.tasks).flatMap(t=>t.assignments||[]).some(a=>a.status!=='CLOSED'))await resumeNativeFixtureChannel(root,loc);
  }else {
   const capabilities=await probeTaskServer(root);await ensureDecisionChannel(root);
   demand(capabilities.models.some(m=>m.model===journal.model&&m.efforts.includes(journal.effort)),'Requested model/effort not offered by this exact service');
   run=await startRun(root,{capabilities});ownsCoordinator=true;await save({run,state:'RUNNING'});
   timer=setInterval(()=>{heartbeatPending=heartbeatPending.then(()=>heartbeat(root,run.id)).catch(error=>{failed ||= error;});},30000);
   const published=await once('publish','publish',()=>({tasks:Array.from({length:3},(_,i)=>({key:'work-'+(i+1),clarified:true,type:'SYSTEM',title:'原生 attach 隔离验收 '+(i+1),originalRequest:'明确运行的隔离原生协议验收',goal:'真实节点与 attach 生命周期验收',scope:['隔离 fixture native-attach/work-'+(i+1)],deliverables:['真实 marker 与协议证据'],acceptanceCriteria:['实际 marker 文件及原生关闭回执'],authorization:'仅该隔离 fixture 的已指定 Codex 模型、受管子 Agent 与本地文件，不触及业务数据和外部发布',discussion:{approved:true,summary:'由操作者通过 --execute 明确启动',feasibility:'使用已核验本机专属 App Server',approvedRequirements:['3 WORKER','同任务至少'+journal.childCount+'个受管子节点','attach 原线程介入','保留原操作且完整关闭清理']}}))}));
   const taskIds=published.taskIds;demand(taskIds?.length===3,'Publish did not return exactly three tasks');await save({taskIds});
   const scheduled=await once('schedule','schedule',async()=>{const l=await readLedger(loc);return {runId:run.id,expectedVersions:Object.fromEntries(taskIds.map(id=>[id,l.tasks[id].version])),assignments:taskIds.map((taskId,i)=>({taskId,key:'worker',goal:'完成独立原生验收 '+i,deliverables:['真实执行证据'],acceptanceCriteria:['实际 marker 文件及原生关闭回执'],resources:[{kind:'DIRECTORY',key:'native-attach/work-'+(i+1),access:'WRITE'}],execution:{model:journal.model,effort:journal.effort,longRunning:true,rationale:'操作者明确授权的隔离原生验收'}}))};});
   const workerIds=taskIds.map(id=>scheduled.assignments.find(a=>a.taskId===id)?.id);demand(workerIds.every(Boolean),'Three WORKER reservations were not admitted');await save({workerIds});
   for(const index of [1,2,0]){
    const id=workerIds[index],s=await scope(id);
    if(!journal.workspaces[id]){journal.workspaces[id]=await allocateAgentWorkspace({project:root,loc,task:s.task,parent:s.assignment,assignment:s.assignment,root:s.assignment,baseCommit:journal.baseCommit,operationId:operationId('workspace-'+id),assertAdmission:()=>requireRun(loc,run.id)});await save({});}
    const key='dispatch-'+id;
    if(!journal.operations[key]){journal.operations[key]={request:{operationId:operationId(key),workspace:journal.workspaces[id].workspace,baseCommit:journal.baseCommit,prompt:promptFor(journal,s.task.id,index)},state:'PENDING'};await save({});}
    const current=await scope(id),result=current.binding.backendRequest?await backend(syncBackend,id):await backend(dispatchBackend,id,journal.operations[key].request);
    journal.operations[key].result=result;journal.operations[key].state=result.status==='RESULT_UNKNOWN'?'RESULT_UNKNOWN':'SUCCEEDED';await save({});demand(result.status!=='RESULT_UNKNOWN','Original dispatch unknown; kept for recovery');
   }
  }
  if(!journal.nativeVerifiedAt){
  const deadline=Date.now()+plan.timeoutMs,rootId=journal.workerIds[0];attach=await openAttachClient(root,journal.taskIds[0]);
  while(Date.now()<deadline){
   if(failed)throw failed;
   let s=await state();const nodes=Object.values(s.ledger.tasks).flatMap(t=>t.assignments||[]);
   for(const a of nodes.filter(a=>a.status!=='CLOSED')){
    const bound=s.bindings.assignments[a.id];
    // A worker's tool can have reserved its child while allocating the clean
    // worktree. Observe that original intent until its activation receipt; do
    // not sync a half-created turn or treat normal admission as a failure.
    if(!bound?.executionAuthority?.activatedAt||!bound.backendRequest?.turnId)continue;
    const result=await syncNativeFixtureNode(a.id,bound,{sync:()=>backend(syncBackend,a.id),readCurrent:()=>scope(a.id)});
    if(result.closedDuringSync){journal.evidence.concurrentClosures ||= [];journal.evidence.concurrentClosures.push({assignmentId:a.id,at:new Date().toISOString()});}
   }
   const views=[];for(const taskId of journal.taskIds){const client=taskId===journal.taskIds[0]?attach:await openAttachClient(root,taskId);try{views.push(await client.snapshot());}finally{if(client!==attach)await client.close();}}
   const active=views.flatMap(v=>v.nodes).filter(n=>n.nativeStatus==='active');
   const sample={at:new Date().toISOString(),active:active.map(n=>({id:n.id,role:n.role,parentAssignmentId:n.parentAssignmentId})),totalNodes:nodes.length};
   journal.evidence.samples.push(sample);
   if(active.filter(n=>n.role==='WORKER').length===3)journal.evidence.threeWorkersOverlap ||= sample;
   if(active.length>3&&nodes.filter(n=>n.role==='SUBAGENT').length>=journal.childCount)journal.evidence.beyondThreeOverlap ||= sample;
   const rootView=views[0].nodes.find(n=>n.id===rootId);
   if(!journal.evidence.steer&&rootView?.canSend&&rootView.nativeStatus==='active'){
    const result=await attach.send({assignmentId:rootId,operationId:operationId('steer'),text:'范围内验收指导：保持本轮既定工作，最终 summary 加入 STEER_ACK_'+journal.id+'，不得重做或新增任务。'});journal.evidence.steer=result;
   }
   if(!journal.evidence.detach&&views[0].nodes.some(n=>n.messages.length)){
    const before=(await state()).bindings.assignments[rootId].nativeThreadId;await attach.close();attach=await openAttachClient(root,journal.taskIds[0]);await attach.snapshot();
    demand((await state()).bindings.assignments[rootId].nativeThreadId===before,'Attach reconnect changed native identity');journal.evidence.detach={sameThread:true,at:new Date().toISOString()};
   }
   s=await state();const second=s.bindings.assignments[journal.workerIds[1]];
   if(!journal.evidence.idleContinue&&second.backendRequest?.state==='SUCCEEDED'){
    const client=await openAttachClient(root,journal.taskIds[1]);try{journal.evidence.idleContinue=await client.send({assignmentId:journal.workerIds[1],operationId:operationId('idle-continue'),text:'这是原范围结果核对。保留现有 marker 文件，不重复命令或创建节点；回读已完成成果，按同一 JSON schema 再次报告并在 summary 加入 IDLE_ACK_'+journal.id+'。'});}finally{await client.close();}
   }
   await save({state:'OBSERVING'});
   s=await state();const openChildren=Object.values(s.ledger.tasks).flatMap(t=>t.assignments||[]).filter(a=>a.role==='SUBAGENT'&&a.status!=='CLOSED');
   if(journal.evidence.idleContinue&&journal.workerIds.every(id=>s.bindings.assignments[id].backendRequest?.state==='SUCCEEDED')&&!openChildren.length)break;
   if(Object.values(s.ledger.tasks).some(t=>(t.assignments||[]).some(a=>a.status==='WAITING_DECISION')))throw Error('Actual node requested a decision; preserved original request, no synthetic answer sent');
   await sleep(1000);
  }
  const end=await state();
  demand(journal.workerIds.every(id=>end.bindings.assignments[id].backendRequest?.state==='SUCCEEDED'),'Native acceptance timed out; original nodes retained');
  demand(journal.evidence.threeWorkersOverlap,'No observed overlap of all three WORKER threads');
  demand(journal.evidence.beyondThreeOverlap,'No observed active node count > 3 with the requested managed descendants');
  demand(journal.evidence.steer?.status==='SENT'&&journal.evidence.idleContinue?.status==='SENT'&&journal.evidence.detach?.sameThread,'Attach steer / idle continue / detach evidence incomplete');
  const nodes=Object.values(end.ledger.tasks).flatMap(t=>t.assignments||[]);
  demand(nodes.filter(a=>a.role==='SUBAGENT').length>=journal.childCount&&nodes.filter(a=>a.role==='SUBAGENT').every(a=>a.status==='CLOSED'&&a.outcome==='ACCEPTED'),'Worker did not itself accept and close all descendants');
  for(const [index,taskId]of journal.taskIds.entries())for(const a of end.ledger.tasks[taskId].assignments){journal.evidence.artifacts.push(...await filesFor(root,{nativeKey:'work-'+(index+1)},end.bindings.assignments[a.id],a));}
  demand(journal.evidence.artifacts.length>=3+journal.childCount,'Actual fixture marker artifacts are incomplete');
  for(const artifact of journal.evidence.artifacts){const value=JSON.parse(artifact.content);demand(value.complete===true&&value.token.startsWith(journal.id+'-'),'Actual marker content does not belong to this fixture');}
  for(const [id,ack]of [[journal.workerIds[0],'STEER_ACK_'],[journal.workerIds[1],'IDLE_ACK_']]){const saved=await readDecisionFile(path.join(loc.runtime,'backend-results',id+'.json'));demand(saved?.result?.summary.includes(ack+journal.id),'Delivered message was not acknowledged in the actual original thread result');}
  await save({state:'VERIFIED_NATIVE',nativeVerifiedAt:new Date().toISOString()});
  }
  if(!ownsCoordinator){
   const previousRun=journal.run;
   run=await startRun(root,{capabilities:previousRun.capabilities});ownsCoordinator=true;
   journal.previousRuns ||= [];journal.previousRuns.push(previousRun);await save({run,state:'FINALIZING'});
   const reconciliation={processes:'原受管命令已结束；账本 activity 将再次核验',workspace:'已核对原工作区、基准和已保存 marker SHA',versions:'保留原正式任务、派工及精确后端操作版本',operations:'只接管实际 SUCCEEDED 原轮次的验收关闭，不重建或续启模型',agent:'保留原 nativeThreadId 与创建回执；原轮次已回读成功'};
   for(const id of journal.workerIds){
    const s=await scope(id);
    if(s.assignment.status!=='CLOSED')await once('reconcile-'+id+'-'+run.id,'assignment:reconcile',()=>({runId:run.id,expectedRunId:s.binding.runId,taskId:s.task.id,assignmentId:id,nativeThreadId:s.binding.nativeThreadId,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.assignment.version,reconciliation,checkpoint:s.assignment.checkpoint||{summary:'原生验收已完成，仅接管验收关闭',completedSteps:['已回读原轮次与 marker SHA'],nextSteps:['验收并关闭'],inputs:['core '+journal.baseCommit],artifacts:journal.evidence.artifacts.filter(a=>a.assignmentId===id).map(a=>a.relative),operations:[]}}));
    else if((await state()).bindings.tasks[s.task.id]!==run.id&&s.task.status==='RUNNING')await once('resume-task-'+s.task.id+'-'+run.id,'resume',()=>({runId:run.id,taskId:s.task.id,expectedVersions:{[s.task.id]:s.task.version},reconciliation,checkpoint:s.task.checkpoint||{summary:'全部原节点已经关闭，接管清理结案',completedSteps:['原节点关闭'],nextSteps:['清理并结案'],inputs:['core '+journal.baseCommit],artifacts:[file],operations:[]}}));
   }
  }
  // Root completion remains a separate collection, acceptance and closure.
  for(const id of journal.workerIds){
   let s=await scope(id);
   if(!['DELIVERED','ACCEPTED','CLOSED'].includes(s.assignment.status))await backend(collectBackend,id,operationId('collect-'+id));
   s=await scope(id);
   if(s.assignment.status==='DELIVERED')await once('accept-'+id,'assignment:accept',()=>({runId:run.id,taskId:s.task.id,assignmentId:id,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.assignment.version,evidence:'原生执行、实际 marker SHA、逐项子树关闭和 attach 收据均已回读'}));
   if((await scope(id)).assignment.status!=='CLOSED')await backend(closeBackend,id);
   s=await scope(id);
   if(s.assignment.status!=='CLOSED')await once('close-'+id,'assignment:close',()=>({runId:run.id,taskId:s.task.id,assignmentId:id,expectedVersions:{[s.task.id]:s.task.version},expectedAssignmentVersion:s.assignment.version,outcome:'ACCEPTED',cleanup:'原生线程已核验关闭，marker 内容与 SHA 已归档，受管 worktree 即将精确退役'}));
  }
  await attach?.close();attach=null;
  const channelRecord=await readDecisionFile(path.join(loc.runtime,'decision-channel/channel.json'));
  if(channelRecord&&!['STOPPED','FAILED'].includes(channelRecord.status))await stopDecisionChannel(root);
  const serverRecord=await readDecisionFile(path.join(loc.runtime,'server/server.json'));
  if(serverRecord?.status!=='STOPPED')await stopTaskServer(root);
  const final=await state();demand(Object.values(final.ledger.tasks).flatMap(t=>t.assignments||[]).every(a=>a.status==='CLOSED'),'Refuse cleanup with any open execution node');
  for(const [id,b]of Object.entries(final.bindings.assignments)){
   if(!b.workspace)continue;const absolute=await realpath(b.workspace).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!absolute)continue;
   demand(absolute.startsWith(path.join(root,'.process/shared')+path.sep)&&git(absolute,'rev-parse','HEAD')===journal.baseCommit,'Refuse cleanup after workspace identity or base drift');
   const common=await realpath(git(absolute,'rev-parse','--path-format=absolute','--git-common-dir'));demand(common===await realpath(git(journal.sourceRepository,'rev-parse','--path-format=absolute','--git-common-dir')),'Foreign worktree');
   const registered=(await phaseRecords(root)).flatMap(({record})=>record.resources).find(r=>r.kind==='path'&&r.path===absolute),st=await lstat(absolute);demand(registered?.dev===st.dev&&registered.ino===st.ino,'Missing owned worktree resource');
   git(journal.sourceRepository,'worktree','remove','--force',absolute);journal.evidence.retiredWorkspaces ||= [];journal.evidence.retiredWorkspaces.push({assignmentId:id,path:absolute});await save({});
  }
  for(const taskId of journal.taskIds){await releaseConsumer(root,taskId,'integrate');const finished=await finishProcessTask(root,taskId),checked=await checkProcessTask(root,taskId);demand(finished.status==='CLEANED'&&checked.status==='CLEANED','Managed fixture cleanup is not complete');}
  for(const taskId of journal.taskIds){const task=(await readLedger(loc)).tasks[taskId];if(task.status!=='DONE')await once('complete-'+taskId,'transition',()=>({runId:run.id,taskId,expectedVersions:{[taskId]:task.version},status:'DONE',reason:'隔离原生验收与清理已实际完成',result:{summary:'原生 WORKER/子树、attach 介入、marker 文件和关闭清理均已验证',artifacts:[file],cleanup:'全部原生节点已关闭，登记 worktree 已精确退役，过程资源 CLEANED',acceptance:[{criterion:0,evidence:'原生回执与 marker SHA 已保存于 '+file}]}}));}
  if(ownsCoordinator)await stopRun(root,run.id,{close:true});
  await save({state:'COMPLETE',completedAt:new Date().toISOString(),cleanup:'ALL_THREADS_CLOSED_AND_OWNED_WORKTREES_RETIRED'});
  return {status:'COMPLETE',fixture:root,journal:file,workers:3,children:Object.values(final.ledger.tasks).flatMap(t=>t.assignments||[]).filter(a=>a.role==='SUBAGENT').length,threeWorkersOverlap:journal.evidence.threeWorkersOverlap,beyondThreeOverlap:journal.evidence.beyondThreeOverlap,cleanup:journal.cleanup};
 }catch(error){await save({state:'RECOVERY_REQUIRED',error:error.message,checkedAt:new Date().toISOString()});return {status:'RECOVERY_REQUIRED',fixture:root,journal:file,error:error.message,resume:'Run this script with --execute --resume '+root,cleanup:'SKIPPED_WHILE_ORIGINAL_NODES_OR_RESULTS_UNRESOLVED'};}
 finally{if(timer)clearInterval(timer);await heartbeatPending;await attach?.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const result=await runNativeAcceptance(nativeAcceptancePlan());console.log(JSON.stringify(result,null,2));if(result.status==='RECOVERY_REQUIRED')process.exitCode=1;}
 catch(error){console.error(JSON.stringify({status:'NOT_RUN',error:error.message}));process.exitCode=1;}
}
