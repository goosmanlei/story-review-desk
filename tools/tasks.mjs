#!/usr/bin/env node
import {backendAction,assertBackendThread} from './task-backend.mjs';
import {readFile, mkdir} from 'node:fs/promises';
import {spawn, execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {once} from 'node:events';
import {processLock,processIdentity} from './process-resources.mjs';
import {location,readLedger,mutate,rebuild,audit,runtimeState,startRun,heartbeat,stopRun,requireRun,activity,clearActivity,requireTask,readBindings,updateBinding,configureCapabilities,setRunPolicy} from './task-ledger.mjs';
import {installTaskSkill} from './task-skill.mjs';
import {commitTaskRecords,taskCommitStatus} from './task-git.mjs';
import {taskCapacity} from './task-capacity.mjs';
import {decisionsAction} from './task-decision-cli.mjs';
import {decisionChannelStatus,listDecisions,durableDecisionFile} from './task-decisions.mjs';
import {decisionHash} from './task-decision-protocol.mjs';
import {renderTasks,renderStatus,renderDetail,renderAudit,sortTasks} from './task-format.mjs';
import {resolveTaskId,displayTaskId} from './task-numbering.mjs';
import {probeNative,connectNative,closeNativeThread,verifyGoalProbe,assertNativeChild} from './task-native.mjs';

export const help=`tasks — 正式任务管理（不接收未澄清想法）

  tasks install                     安装/更新项目 Skill 与 npm 入口
  tasks init | rebuild              初始化空账本或从事件重建 Markdown 视图
  tasks upgrade --file -             无活跃执行时升级至 v2；保留旧事件
  tasks list [--all]                 默认列出未完成任务；--all 包含全部终态历史
  tasks show TASK_ID                 读取单项权威任务记录
  tasks audit [--task ID] [--from ISO] [--to ISO] [--status STATE] [--type SYSTEM|CREATIVE]
  tasks audit --operation-id ID      核查管理操作是否已落账
  tasks commit --file -              发布回读后仅提交本地受管任务记录，无需领取或执行
  tasks commit-status --operation-id ID  只读核查原管理提交和 Git 证据
  tasks status                      查看执行占用及中断任务
  tasks run                         在当前会话保持执行资格；不会自行调用模型
  tasks heartbeat --run RUN_ID       延长执行租约（10 分钟）
  tasks stop --run RUN_ID            请求停止领取和执行
  tasks guard --run RUN_ID --task ID [--assignment ID] [--core] -- COMMAND
                                    校验领取资格并登记执行进程；--core 串行共享核心操作
  tasks publish|next|resume|checkpoint|transition|amend|merge|split --file request.json
  tasks schedule --file -            原子选择无冲突派工；支持跨正式任务
                                    最多占用 3 个正式任务；主 Agent、预留和未关闭派工计入
  tasks assignment dispatch|start|checkpoint|result|accept|close|reconcile --file -
  tasks policy --run ID --file -     设置 {stopAfterTaskId}，该任务终态后暂停补位
  tasks backend ensure|probe --run ID
                                    在受管阶段启动/复用并核验项目专属服务
  tasks backend dispatch|continue --run ID --assignment ID --file -
                                    同一服务创建工作会话或继续未完成长派工
  tasks backend sync|recover|collect|close --run ID --assignment ID [--file -]
                                    查询原轮次、恢复、保存结果及核验关闭
  tasks backend verify-execution --run ID
                                    核验真实并行采样、成果验收和关闭
  tasks backend stop --run ID        只停止无未关闭派工或加载会话的专属服务
  tasks decisions list [--history] [--format markdown]
                                    执行中发现待决策问题；不需要活跃协调会话
  tasks decisions show ID [--runtime] 读取原问题、当前版本和答复绑定；审批须核对 runtime 原操作
  tasks decisions present|answer|reconcile --run ID --file -
                                    登记主会话实际提问、用户明确答复、原操作核查
  tasks decisions deliver --run ID --decision ID
                                    只发送已保存且从未尝试发送的原答复；未知结果不重发
  tasks decisions followup --run ID --decision ID --file -
                                    已核查失效请求的同范围续办；只接受 {operationId}
  tasks decisions status            查看持久连接、原请求和未绑定消息诊断
  tasks native probe|close           兼容别名；probe不接受公共socket或slots声明

  --project PATH                    默认当前项目根；不能使用源码 worktree 代替账本根
  --file -                          从 stdin 读取 JSON，避免保存临时请求文件
  --format json|markdown             list / show / status / audit；默认 JSON
  --sort published|priority|updated|completed
  --columns completed,progress,blocker,result  Markdown 附表可选列

list 默认范围：READY / RUNNING / BLOCKED / WAITING_REVIEW；
--all 才纳入 DONE / CANCELLED / MERGED。--status / --type / --task 与范围取交集，
例如 list --status DONE 返回空，list --all --status DONE 查询已完成。
JSON 与 Markdown 同范围；show / status / audit 保持原查询语义。
展示编号为 T-YYYYMMDD-NNN，日期按 Asia/Shanghai 原始发布时间，同日跨类型共用 001–999。
编号终态不复用、重建不变化；每日超过 999 项整笔拒绝（TASK_NUMBER_LIMIT）。
完整展示号与旧永久 ID 均可 show、list/audit --task、依赖、合并、派工和写入定位。
JSON id/taskId/依赖保持永久身份，task.displayId 提供展示号；expectedVersions 可用任一编号作键。
同一任务的新旧键版本冲突须拒绝；别名在锁内解析后核对幂等与版本，不能绕过 CAS。

写入共同字段：operationId（重发原编号）、actor（如 USER / PROJECT_CODEX）。
publish: {task:{clarified:true,type:"SYSTEM",title,originalRequest,goal,scope:[...],
  deliverables:[...],acceptanceCriteria:[...],authorization,priority:2,dependencies:[],references:[],
  discussion:{approved:true,summary,feasibility,approvedRequirements:[...]}}}
publish 也接受 tasks:[{key:"a",...},{key:"b",dependencies:["@a"],...}]；
一次讨论可正式发布多项任务，批内依赖使用 @key，全批原子保存。不接收未讨论部分。
发布成功后先 audit --operation-id 原编号 回读，再自行调用 commit；不需重复请示。
commit: {operationId,actor,publishOperationId}，包含当前完整前序链与必要视图；
仅本地 commit，不 push、不启动执行器、不随其他状态变化自动提交。
失败不撤销发布，先 commit-status 查原编号，再用相同请求补交；不重新 publish。
next: {runId}，自动领取；返回 CURRENT_TASK / RECOVERY_REQUIRED / NO_EXECUTABLE_TASK 时不创建事件。
其他单任务写入：{taskId,expectedVersions:{"TASK_ID":当前版本},...}
checkpoint: {runId,checkpoint:{summary,completedSteps:[],nextSteps:[],inputs:[],artifacts:[],
  operations:[{id,kind,status:"PENDING|SUCCEEDED|FAILED|RESULT_UNKNOWN|CANCELLED",evidence}]}}
resume: {runId,checkpoint, reconciliation:{processes,workspace,versions,operations}}
transition: {runId（执行中必填）,status,reason,result（DONE 必填）}
result: {summary,artifacts:[],cleanup,acceptance:[{criterion:0,evidence:"..."},...]}
amend: {changes:{priority,dependencies},reason}，不得改写原意或范围。
merge: {taskIds:[...],expectedVersions:{...},title,reason}，仅同类且未开始任务。
split: {taskId,expectedVersions:{...},reason,children:[{title,goal,criterionIndexes:[0]},...]}
拆解完整承接原验收项；范围、授权与依赖继承父任务。
schedule: {runId,expectedVersions:{...},assignments:[{taskId,key,goal,deliverables:[...],
  acceptanceCriteria:[...],resources:[{kind:"FILE|DIRECTORY|OBJECT|UNKNOWN",key:"core/tools/x.mjs",access:"WRITE|READ",version}],
  execution:{workClass:"LOOKUP|RESEARCH|IMPLEMENTATION|HIGH_RISK",rationale,longRunning:false},dependsOn:[],attemptOf}]}
assignment: {runId,taskId,assignmentId,expectedVersions:{...},expectedAssignmentVersion,...}
backend dispatch: {operationId,prompt,workspace,baseCommit}；collect: {operationId}；continue: {operationId,prompt}。
decisions present/answer/reconcile 共同字段：{operationId,actor,runId,taskId,assignmentId,decisionId,
  expectedVersions:{TASK_ID:版本},expectedAssignmentVersion,expectedDecisionVersion,bindingToken}。
show 的 requestFields 提供当前字段；每次写入前重新读取，不能猜版本或换绑。
present: {evidence:"主会话实际提问的消息引用及内容"}，必须先真正向用户呈现，再登记回执。
answer: {actor:"USER",explicitUserAnswer:true,evidence:"用户原话及消息引用",answer:...}。
BUSINESS: answer {text:"用户明确决定"}；INPUT: answer {answers:{原问题ID:{answers:["用户答复"]}}}；
APPROVAL: answer {decision:"accept|decline|cancel"}；权限申请为 {decision:"grant|deny"}，只限原请求本轮。
不接收秘密输入、会话授权或规则修改；原始权限与机器绑定只保存在 runtime。
相同操作号重放仅回读；同号不同内容拒绝，已保存答复冲突拒绝。超时、默认值、resolved 通知都不是用户同意。
reconcile: {resolution:"DELIVERED|FOLLOWUP",checkedOriginalOperation:true,evidence:"原操作/原轮次核查"}。
先读取原线程，活动、失败未知、缺失原轮次不能 FOLLOWUP；审批失效不能作为续办授权。
FOLLOWUP_READY 后才能 decisions followup；已关闭派工须关闭收尾并以新派工重新核对范围。
assignment dispatch: {}，创建前保存尝试；start: {workspaceEvidence,workspace（本机路径仅存 runtime）,nativeThreadId（SubAgent 必填）}
checkpoint: {checkpoint,goalStatus}; result: {checkpoint,result:{summary,artifacts:[],acceptance:[{criterion:0,evidence}]}}
accept: {evidence}; close: {outcome:"ACCEPTED|CANCELLED|REPLACED",cleanup,reason};
reconcile: {checkpoint,reconciliation:{processes,workspace,versions,operations,agent}}。
专属服务长派工使用 FOLLOWUP；backend continue 只续办同一未交回派工。未验证关闭则主 Agent 执行。
TASK_CAPACITY 表示项目已占用 3 个不同任务；同任务辅助派工只增加 Agent 占用。
MAIN_CAPACITY / AGENT_CAPACITY 仍按实际能力限制执行。交回或空闲不释放占用，
收尾关闭并完成任务后，协调者重新 schedule 按依赖和优先级补入待办。
next 保持未知资源的串行兼容，不能绕过上限；旧超限记录只允许 reconcile/close/收尾。

状态：READY 待执行 / RUNNING 执行中 / BLOCKED 阻塞 / WAITING_REVIEW 待验收 /
DONE 已完成 / CANCELLED 已取消 / MERGED 已合并。终态只读，变化另发任务。
派工 WAITING_DECISION 表示存在未解决决定，保留任务/Agent/资源占用，不能 collect/accept/DONE。
问题 OPEN/ANSWERED/DELIVERY_UNKNOWN/NEEDS_RECONCILIATION/FOLLOWUP_READY 均未解决。
持久接收器独立于协调租约保存问题；主会话每个检查点查询 decisions list，合并转达，沿用已提问题。
无活跃主会话不会自动弹出提问；恢复 run/reconcile/backend recover 后继续转达和核查。
审计事件时间为 UTC，from 包含、to 不包含；对话默认展示 Asia/Shanghai。
更多说明：review-software/docs/handbook/chapters/operations.md 的“正式任务管理”
`;

async function keeper(project) {
  const loc=await location(project); await mkdir(loc.runtime,{recursive:true,mode:0o700});
  return processLock(path.join(loc.runtime,'executor.lock'),async()=>{
    const run=await startRun(project);
    console.log(JSON.stringify({status:'EXECUTOR_READY',runId:run.id,expiresAt:run.expiresAt,instruction:'保留此命令运行，在当前会话用 next 领取任务；每个阶段 checkpoint 并 heartbeat；完成后 stop。'}));
    let stopping=false,decisionNotice=null;
    const stop=()=>{stopping=true;};
    for(const s of ['SIGINT','SIGTERM','SIGHUP']) process.on(s,stop);
    try {
      while(true) {
        const state=await runtimeState(project);
        const decisions=await listDecisions(project),notice=decisionHash(decisions.map(d=>[d.id,d.status,d.needsPresentation]));
        if(notice!==decisionNotice&&(decisions.length||decisionNotice)){
          const event={status:'DECISIONS_CHANGED',runId:run.id,detectedAt:new Date().toISOString(),decisions:decisions.map(d=>({decisionId:d.id,taskId:d.taskId,assignmentId:d.assignmentId,kind:d.kind,status:d.status,question:d.question,needsPresentation:d.needsPresentation}))};
          await durableDecisionFile(path.join(loc.runtime,'decision-channel/notices',run.id+'-'+Date.now()+'.json'),event);
          console.log(JSON.stringify(event));
        }
        decisionNotice=notice;
        if(stopping||state.run?.stopRequested||Date.parse(state.run?.expiresAt)<=Date.now()) {
          try { await stopRun(project,run.id,{close:true}); break; }
          catch(e) { if(!e.message.includes('仍在运行')) throw e; }
        }
        await new Promise(r=>setTimeout(r,1000));
      }
    } finally { for(const s of ['SIGINT','SIGTERM','SIGHUP']) process.off(s,stop); }
    return {status:'EXECUTOR_STOPPED',runId:run.id};
  });
}

async function guarded(project,runId,taskId,command,core,assignmentId) {
  requireTask(command.length,'guard 缺少命令');
  const loc=await location(project);
  requireTask(!assignmentId||/^[A-Za-z0-9._-]+$/.test(assignmentId),'派工编号无效');
  const execute=()=>processLock(path.join(loc.runtime,assignmentId?`activity-${assignmentId}.lock`:'activity.lock'),async()=>{
    await requireRun(loc,runId);
    const ledger=await readLedger(loc), bindings=await readBindings(loc);
    taskId=resolveTaskId(ledger.tasks,taskId);
    const task=assignmentId?Object.values(ledger.tasks).find(t=>t.assignments?.some(a=>a.id===assignmentId)):ledger.tasks[taskId];
    requireTask(!taskId||task?.id===taskId,'guard 派工与任务编号不符');
    requireTask(task?.status==='RUNNING'&&(bindings.tasks[task.id]||task.runId)===runId,'guard 只能执行当前会话已领取的任务');
    requireTask(assignmentId||!task.assignments?.length,'已派工任务必须指定 --assignment');
    const owner=processIdentity(); await activity(project,runId,owner,null,assignmentId,task.id);
    let child, timer, terminating, failure;
    const stop=signal=>{ if(child?.pid) {try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;} if(!terminating){terminating=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);terminating.unref();}} };
    const handlers=new Map(['SIGINT','SIGTERM','SIGHUP'].map(s=>[s,()=>stop(s)]));
    try {
      child=spawn(command[0],command.slice(1),{cwd:bindings.assignments[assignmentId]?.workspace||loc.root,env:process.env,stdio:'inherit',detached:true});
      const done=once(child,'close');
      if(child.pid) await activity(project,runId,owner,processIdentity(child.pid),assignmentId,task.id);
      for(const [s,h] of handlers) process.on(s,h);
      let busy=false;
      timer=setInterval(async()=>{if(busy)return;busy=true;try{await heartbeat(project,runId);}catch(e){failure=e.message;stop('SIGTERM');}finally{busy=false;}},15000);
      const [code,signal]=await done;
      return {status:code===0&&!failure?'COMMAND_SUCCEEDED':'COMMAND_FAILED',exitCode:code|| (signal||failure?1:0),signal,error:failure};
    } finally {
      clearInterval(timer);clearTimeout(terminating);
      for(const [s,h] of handlers) process.off(s,h);
      await clearActivity(project,runId,assignmentId);
    }
  });
  if(!core) return execute();
  const machine=JSON.parse(await readFile(path.join(loc.root,'instance/runtime/machine.json'),'utf8'));
  requireTask(machine.sourceRepository,'未配置核心源码仓库');
  const common=execFileSync('git',['-C',machine.sourceRepository,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',timeout:10000}).trim();
  return processLock(path.join(common,'review-tasks.lock'),execute);
}

async function inputFile(file) {
  requireTask(file,'写入必须提供 --file request.json 或 --file -');
  return JSON.parse(file==='-'?await new Promise((resolve,reject)=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));process.stdin.on('error',reject);}):await readFile(file,'utf8'));
}
async function nativeAction(project,action,v) {
  const loc=await location(project),run=await requireRun(loc,v.run,{converging:action==='close'});
  if(action==='probe') {
    requireTask(process.env.REVIEW_TASK_DIR,'原生探测须通过受管 process 阶段执行');
    requireTask(v.slots===undefined,'slots 不接受人工声明；使用专属服务实际能力核验');
    requireTask(!v.socket,'专属服务socket由项目身份确定，不接管外部socket');
    return backendAction(project,'probe',v);
  }
  const ledger=await readLedger(loc),task=Object.values(ledger.tasks).find(t=>t.assignments?.some(a=>a.id===v.assignment));
  const a=task?.assignments.find(a=>a.id===v.assignment),bindings=await readBindings(loc),binding=bindings.assignments[v.assignment];
  requireTask(a?.execution.mode==='SUBAGENT'&&binding?.runId===v.run&&binding.nativeThreadId&&!binding.retiredAt,'只操作当前未关闭派工绑定的原生子 Agent');
  if(binding.backendServiceId&&action==='close')return backendAction(project,'close',v);
  const client=connectNative({socket:binding.socket||run.capabilities.socket});
  try {
    await client.initialize();
    if(action==='close') {
      const receipt=await closeNativeThread(client,binding.nativeThreadId,binding.parentThreadId||run.capabilities.parentThreadId);
      await updateBinding(project,v.run,v.assignment,b=>{b.closureReceipt=receipt;});
      return {assignmentId:a.id,status:'NATIVE_CLOSED',history:'PRESERVED'};
    }
    const body=await inputFile(v.file);
    if(action==='goal') {
      requireTask(run.capabilities.goalVerified&&a.execution.goalMode==='NATIVE','尚未验证原生子 Goal；使用普通派工');
      requireTask(['active','paused'].includes(body.status),'Goal 操作只允许 active / paused');
      if(body.objective)requireTask(body.objective===a.goal,'Goal 目标须匹配派工，不得扩大范围');
      return client.call('thread/goal/set',{threadId:binding.nativeThreadId,status:body.status,...(body.objective?{objective:body.objective}:{})});
    }
    if(action==='verify-goal') {
      const proof=await verifyGoalProbe(client,{...body,childThreadId:binding.nativeThreadId,parentThreadId:run.capabilities.parentThreadId});
      return configureCapabilities(project,v.run,{...run.capabilities,...proof});
    }
    throw Error('未知原生操作');
  } finally {client.close();}
}

export async function main(argv=process.argv.slice(2)) {
  const sep=argv.indexOf('--'), command=sep<0?[]:argv.slice(sep+1);
  const {values:v,positionals:p}=parseArgs({args:sep<0?argv:argv.slice(0,sep),allowPositionals:true,options:{project:{type:'string'},file:{type:'string'},run:{type:'string'},task:{type:'string'},assignment:{type:'string'},decision:{type:'string'},history:{type:'boolean'},runtime:{type:'boolean'},core:{type:'boolean'},all:{type:'boolean'},from:{type:'string'},to:{type:'string'},status:{type:'string'},type:{type:'string'},format:{type:'string',default:'json'},sort:{type:'string',default:'published'},columns:{type:'string'},socket:{type:'string'},slots:{type:'string'},'operation-id':{type:'string'},help:{type:'boolean'}}});
  const project=path.resolve(v.project||process.cwd()), action=p[0];
  if(v.help||!action||action==='help') return console.log(help);
  requireTask(!v.all||action==='list','--all 仅适用于 list');
  if(action==='install') return installTaskSkill(project,path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  if(['init','rebuild'].includes(action)) return rebuild(project);
  if(action==='run') return keeper(project);
  if(action==='heartbeat') return heartbeat(project,v.run);
  if(action==='stop') return stopRun(project,v.run);
  if(action==='policy')return setRunPolicy(project,v.run,await inputFile(v.file));
  if(action==='guard') return guarded(project,v.run,v.task,command,v.core,v.assignment);
  if(action==='native') return nativeAction(project,p[1],v);
  if(action==='backend')return backendAction(project,p[1],v,v.file?await inputFile(v.file):{});
  if(action==='decisions')return decisionsAction(project,p[1],{...v,decision:v.decision||p[2]},v.file?await inputFile(v.file):{});
  if(action==='commit')return commitTaskRecords(project,await inputFile(v.file));
  if(action==='commit-status')return taskCommitStatus(project,v['operation-id']);
  requireTask(['json','markdown'].includes(v.format),'format 须为 json 或 markdown');
  const ledger=await readLedger(project);
  const data=audit(ledger,{taskId:v.task,status:v.status,type:v.type,from:v.from,to:v.to,operationId:v['operation-id']});
  data.tasks=sortTasks(data.tasks,v.sort);
  data.scope=[v.task?'任务 '+displayTaskId(ledger.tasks,resolveTaskId(ledger.tasks,v.task)):null,v.status||null,v.type||null].filter(Boolean).join(' / ')||'当前项目';
  const options={sort:v.sort,columns:v.columns?.split(',')||[],tasks:ledger.tasks};
  if(action==='list') {
    if(!v.all)data.tasks=data.tasks.filter(t=>['READY','RUNNING','BLOCKED','WAITING_REVIEW'].includes(t.status));
    data.scope+=' / '+(v.all?'全部任务（含终态）':'未完成任务');
    return v.format==='markdown'?renderTasks(data,options):data.tasks;
  }
  if(action==='show') {const task=ledger.tasks[resolveTaskId(ledger.tasks,p[1])];requireTask(task,'任务不存在');return v.format==='markdown'?renderDetail(task,options):task;}
  if(action==='audit')return v.format==='markdown'?renderAudit(data,options):data;
  if(action==='status') {
    const runtime=await runtimeState(project),interrupted=Object.values(ledger.tasks).filter(t=>t.status==='RUNNING'&&(!runtime.runActive||(runtime.bindings.tasks[t.id]||t.runId)!==runtime.run?.id));
    runtime.taskCapacity=taskCapacity(ledger.tasks);
    runtime.decisions=await listDecisions(project);
    runtime.decisionChannel=await decisionChannelStatus(project);
    return v.format==='markdown'?renderStatus({...data,runtime},options):{...runtime,interrupted};
  }
  const mutation=action==='assignment'?`assignment:${p[1]}`:action;
  requireTask(['publish','upgrade','next','resume','checkpoint','transition','amend','merge','split','schedule','assignment:dispatch','assignment:start','assignment:checkpoint','assignment:result','assignment:accept','assignment:close','assignment:reconcile'].includes(mutation),'未知命令；运行 tasks --help');
  const request=await inputFile(v.file);
  // Durable replays must reach the ledger hash check without reopening a closed
  // native thread. A conflicting reuse still fails in mutate before any effect.
  if(!ledger.events.some(e=>e.operationId===request.operationId)&&(mutation==='assignment:start'||mutation==='assignment:reconcile'&&request.nativeThreadId)) {
    const a=ledger.tasks[resolveTaskId(ledger.tasks,request.taskId)]?.assignments?.find(a=>a.id===request.assignmentId);
    if(a?.execution.mode==='SUBAGENT') {
      const loc=await location(project),run=await requireRun(loc,request.runId),binding=(await readBindings(loc)).assignments[request.assignmentId],client=connectNative({socket:binding?.socket||run.capabilities.socket});
      try{await client.initialize();if(binding?.backendServiceId)await assertBackendThread(project,request.assignmentId,request.nativeThreadId,client);else await assertNativeChild(client,request.nativeThreadId,binding?.parentThreadId||run.capabilities.parentThreadId);}finally{client.close();}
    }
  }
  return mutate(project,mutation,request);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) main().then(r=>{if(r!==undefined)console.log(typeof r==='string'?r:JSON.stringify(r,null,2));process.exitCode=r?.exitCode||0;}).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
