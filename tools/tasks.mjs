#!/usr/bin/env node
import {readFile, mkdir} from 'node:fs/promises';
import {spawn, execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {once} from 'node:events';
import {processLock,processIdentity} from './process-resources.mjs';
import {location,readLedger,mutate,rebuild,audit,runtimeState,startRun,heartbeat,stopRun,requireRun,activity,clearActivity,requireTask} from './task-ledger.mjs';
import {installTaskSkill} from './task-skill.mjs';

export const help=`tasks — 正式任务管理（不接收未澄清想法）

  tasks install                     安装/更新项目 Skill 与 npm 入口
  tasks init | rebuild              初始化空账本或从事件重建 Markdown 视图
  tasks list | show TASK_ID          读取权威任务记录
  tasks audit [--task ID] [--from ISO] [--to ISO] [--status STATE] [--type SYSTEM|CREATIVE]
  tasks audit --operation-id ID      核查管理操作是否已落账
  tasks status                      查看执行占用及中断任务
  tasks run                         在当前会话保持执行资格；不会自行调用模型
  tasks heartbeat --run RUN_ID       延长执行租约（10 分钟）
  tasks stop --run RUN_ID            请求停止领取和执行
  tasks guard --run RUN_ID --task ID [--core] -- COMMAND
                                    校验领取资格并登记执行进程；--core 串行共享核心操作
  tasks publish|next|resume|checkpoint|transition|amend|merge|split --file request.json

  --project PATH                    默认当前项目根；不能使用源码 worktree 代替账本根
  --file -                          从 stdin 读取 JSON，避免保存临时请求文件

写入共同字段：operationId（重发原编号）、actor（如 USER / PROJECT_CODEX）。
publish: {task:{clarified:true,type:"SYSTEM",title,originalRequest,goal,scope:[...],
  deliverables:[...],acceptanceCriteria:[...],authorization,priority:2,dependencies:[],references:[]}}
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

状态：READY 待执行 / RUNNING 执行中 / BLOCKED 阻塞 / WAITING_REVIEW 待验收 /
DONE 已完成 / CANCELLED 已取消 / MERGED 已合并。终态只读，变化另发任务。
审计事件时间为 UTC，from 包含、to 不包含；对话默认展示 Asia/Shanghai。
更多说明：review-software/docs/handbook/chapters/operations.md 的“正式任务管理”
`;

async function keeper(project) {
  const loc=await location(project); await mkdir(loc.runtime,{recursive:true,mode:0o700});
  return processLock(path.join(loc.runtime,'executor.lock'),async()=>{
    const run=await startRun(project);
    console.log(JSON.stringify({status:'EXECUTOR_READY',runId:run.id,expiresAt:run.expiresAt,instruction:'保留此命令运行，在当前会话用 next 领取任务；每个阶段 checkpoint 并 heartbeat；完成后 stop。'}));
    let stopping=false;
    const stop=()=>{stopping=true;};
    for(const s of ['SIGINT','SIGTERM','SIGHUP']) process.on(s,stop);
    try {
      while(true) {
        const state=await runtimeState(project);
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

async function guarded(project,runId,taskId,command,core) {
  requireTask(command.length,'guard 缺少命令');
  const loc=await location(project);
  const execute=()=>processLock(path.join(loc.runtime,'activity.lock'),async()=>{
    await requireRun(loc,runId);
    const ledger=await readLedger(loc), task=ledger.tasks[taskId];
    requireTask(task?.status==='RUNNING'&&task.runId===runId,'guard 只能执行当前会话已领取的任务');
    const owner=processIdentity(); await activity(project,runId,owner);
    let child, timer, terminating, failure;
    const stop=signal=>{ if(child?.pid) {try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;} if(!terminating){terminating=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);terminating.unref();}} };
    const handlers=new Map(['SIGINT','SIGTERM','SIGHUP'].map(s=>[s,()=>stop(s)]));
    try {
      child=spawn(command[0],command.slice(1),{cwd:loc.root,env:process.env,stdio:'inherit',detached:true});
      const done=once(child,'close');
      if(child.pid) await activity(project,runId,owner,processIdentity(child.pid));
      for(const [s,h] of handlers) process.on(s,h);
      let busy=false;
      timer=setInterval(async()=>{if(busy)return;busy=true;try{await heartbeat(project,runId);}catch(e){failure=e.message;stop('SIGTERM');}finally{busy=false;}},15000);
      const [code,signal]=await done;
      return {status:code===0&&!failure?'COMMAND_SUCCEEDED':'COMMAND_FAILED',exitCode:code|| (signal||failure?1:0),signal,error:failure};
    } finally {
      clearInterval(timer);clearTimeout(terminating);
      for(const [s,h] of handlers) process.off(s,h);
      await clearActivity(project,runId);
    }
  });
  if(!core) return execute();
  const machine=JSON.parse(await readFile(path.join(loc.root,'instance/runtime/machine.json'),'utf8'));
  requireTask(machine.sourceRepository,'未配置核心源码仓库');
  const common=execFileSync('git',['-C',machine.sourceRepository,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',timeout:10000}).trim();
  return processLock(path.join(common,'review-tasks.lock'),execute);
}

export async function main(argv=process.argv.slice(2)) {
  const sep=argv.indexOf('--'), command=sep<0?[]:argv.slice(sep+1);
  const {values:v,positionals:p}=parseArgs({args:sep<0?argv:argv.slice(0,sep),allowPositionals:true,options:{project:{type:'string'},file:{type:'string'},run:{type:'string'},task:{type:'string'},core:{type:'boolean'},from:{type:'string'},to:{type:'string'},status:{type:'string'},type:{type:'string'},'operation-id':{type:'string'},help:{type:'boolean'}}});
  const project=path.resolve(v.project||process.cwd()), action=p[0];
  if(v.help||!action||action==='help') return console.log(help);
  if(action==='install') return installTaskSkill(project,path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  if(['init','rebuild'].includes(action)) return rebuild(project);
  if(action==='run') return keeper(project);
  if(action==='heartbeat') return heartbeat(project,v.run);
  if(action==='stop') return stopRun(project,v.run);
  if(action==='guard') return guarded(project,v.run,v.task,command,v.core);
  const ledger=await readLedger(project);
  if(action==='list') return audit(ledger,{status:v.status,type:v.type}).tasks;
  if(action==='show') {requireTask(ledger.tasks[p[1]],'任务不存在');return ledger.tasks[p[1]];}
  if(action==='audit') return audit(ledger,{taskId:v.task,status:v.status,type:v.type,from:v.from,to:v.to,operationId:v['operation-id']});
  if(action==='status') return {...await runtimeState(project),interrupted: Object.values(ledger.tasks).filter(t=>t.status==='RUNNING')};
  requireTask(['publish','next','resume','checkpoint','transition','amend','merge','split'].includes(action),'未知命令；运行 tasks --help');
  requireTask(v.file,'写入必须提供 --file request.json 或 --file -');
  const input=v.file==='-'?await new Promise((resolve,reject)=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));process.stdin.on('error',reject);}):await readFile(v.file,'utf8');
  return mutate(project,action,JSON.parse(input));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) main().then(r=>{if(r!==undefined)console.log(JSON.stringify(r,null,2));process.exitCode=r?.exitCode||0;}).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
