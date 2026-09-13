import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, lstat, open, link, unlink, realpath} from 'node:fs/promises';
import {atomic, plainDirectory} from './io.mjs';
import {processLock, processIdentity, processAlive} from './process-resources.mjs';

export const states = ['READY','RUNNING','BLOCKED','WAITING_REVIEW','DONE','CANCELLED','MERGED'];
export const labels = {READY:'待执行',RUNNING:'执行中',BLOCKED:'阻塞',WAITING_REVIEW:'待验收',DONE:'已完成',CANCELLED:'已取消',MERGED:'已合并'};
const terminal = new Set(['DONE','CANCELLED','MERGED']);
export function requireTask(ok, message) { if (!ok) throw Error(message); }
const text = (v, name) => { requireTask(typeof v === 'string' && v.trim() && v.length <= 30000, `${name}须为非空文本`); return v; };
const list = (v, name, empty = false) => { requireTask(Array.isArray(v) && (empty || v.length) && v.length <= 200, `${name}须为${empty?'':'非空'}数组`); v.forEach(x=>text(x,name)); return v; };
const identity = v => { requireTask(typeof v==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(v),'编号无效'); return v; };
function stable(v) { return Array.isArray(v)?v.map(stable):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v; }
const digest = v => createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const timestamp = () => new Date().toISOString();
const maybe = async f => { try { const s=await lstat(f); requireTask(s.isFile()&&!s.isSymbolicLink(), '记录不是普通文件'); return JSON.parse(await readFile(f,'utf8')); } catch(e) { if(e.code==='ENOENT') return null; throw e; } };
async function directory(f) { await mkdir(f,{recursive:true,mode:0o700}); await plainDirectory(f); }

export function validateSpec(s) {
  requireTask(s?.clarified === true,'只接受已澄清的正式任务；未澄清的想法不入案');
  for (const k of ['title','originalRequest','goal','authorization']) text(s[k],k);
  for (const k of ['scope','deliverables','acceptanceCriteria']) list(s[k],k);
  requireTask(['SYSTEM','CREATIVE'].includes(s.type),'type 须为 SYSTEM 或 CREATIVE');
  requireTask(s.priority===undefined || Number.isInteger(s.priority)&&s.priority>=0&&s.priority<=3,'priority 须为 0–3，数字越小越优先');
  list(s.dependencies || [],'dependencies',true).forEach(identity);
  list(s.references || [],'references',true);
  return Object.fromEntries(['title','originalRequest','goal','authorization','scope','deliverables','acceptanceCriteria','type'].map(k=>[k,s[k]]).concat([
    ['priority',s.priority??2],['dependencies',[...new Set(s.dependencies||[])]],['references',s.references||[]]
  ]));
}

export async function location(project) {
  const root=await realpath(path.resolve(project)); await plainDirectory(root);
  const instance=await maybe(path.join(root,'instance/instance.json'));
  requireTask(instance?.id,'必须显式指向含 instance/instance.json 的故事项目根目录');
  return {root,projectId:instance.id,events:path.join(root,'tasks/events'),runtime:path.join(root,'instance/runtime/task-execution')};
}

export async function readLedger(project) {
  const loc=typeof project==='string'?await location(project):project;
  const binding=await maybe(path.join(loc.root,'tasks/project.json'));
  if(binding) requireTask(binding.schemaVersion===1 && binding.projectId===loc.projectId,'任务账本属于其他实例或版本');
  let names;
  try { await plainDirectory(loc.events); names=await readdir(loc.events); }
  catch(e) { if(e.code==='ENOENT') return {...loc,tasks:{},events:[],sequence:0,head:null}; throw e; }
  requireTask(binding,'任务账本缺少实例绑定');
  const events=[], tasks={}, operations=new Set(); let head=null;
  for(const name of names.sort()) {
    requireTask(/^\d{10}-[a-f0-9]{64}\.json$/.test(name),'账本包含未知文件');
    const e=await maybe(path.join(loc.events,name));
    const {hash,...body}=e;
    requireTask(e.schemaVersion===1 && e.projectId===loc.projectId && e.sequence===events.length+1 && e.previousHash===head && hash===digest(body) && name===`${String(e.sequence).padStart(10,'0')}-${hash}.json` && !operations.has(e.operationId),'账本校验失败；不得跳过或覆盖历史');
    for(const task of e.tasks) {
      identity(task.id);
      requireTask(task.version===(tasks[task.id]?.version||0)+1 && states.includes(task.status),'任务版本链无效');
      tasks[task.id]=task;
    }
    operations.add(e.operationId); events.push(e); head=hash;
  }
  return {...loc,tasks,events,head,sequence:events.length};
}

async function initialize(loc) {
  await directory(path.join(loc.root,'tasks'));
  const file=path.join(loc.root,'tasks/project.json'), previous=await maybe(file);
  if(previous) requireTask(previous.schemaVersion===1&&previous.projectId===loc.projectId,'任务实例绑定不符');
  else await atomic(file,{schemaVersion:1,projectId:loc.projectId});
  await directory(loc.events);
}
// Publish one immutable transaction, including all merge/split/parent changes.
// fsync + exclusive link makes both partial writes and overwriting history impossible.
async function append(loc,event) {
  const value={...event,hash:digest(event)}, name=`${String(event.sequence).padStart(10,'0')}-${value.hash}.json`;
  const temp=path.join(loc.runtime,randomUUID()+'.tmp');
  const f=await open(temp,'wx',0o600);
  try { await f.writeFile(JSON.stringify(value,null,2)+'\n'); await f.sync(); } finally { await f.close(); }
  try { await link(temp,path.join(loc.events,name)); const d=await open(loc.events,'r'); try { await d.sync(); } finally { await d.close(); } }
  finally { await unlink(temp); }
  return value;
}

function complete(tasks,id,seen=new Set()) {
  if(seen.has(id)) return false; seen.add(id);
  const t=tasks[id]; return t?.status==='DONE' || t?.status==='MERGED'&&complete(tasks,t.mergedInto,seen);
}
function graph(tasks) {
  const visited=new Set(), stack=new Set();
  function visit(id) {
    requireTask(tasks[id],`依赖任务不存在：${id}`);
    requireTask(!stack.has(id),'任务依赖形成循环');
    if(visited.has(id)) return;
    stack.add(id);
    const t=tasks[id];
    for(const x of [...t.dependencies,...(t.children||[]),...(t.mergedInto?[t.mergedInto]:[])]) visit(x);
    stack.delete(id); visited.add(id);
  }
  Object.keys(tasks).forEach(visit);
}
function checkpoint(value, previous) {
  text(value?.summary,'checkpoint.summary');
  for(const k of ['completedSteps','nextSteps','inputs','artifacts']) list(value[k]||[],k,true);
  requireTask(Array.isArray(value.operations||[]),'operations 须为数组');
  const ids=new Set();
  for(const op of value.operations||[]) {
    identity(op.id); text(op.kind,'operation.kind'); requireTask(!ids.has(op.id),'重复操作编号'); ids.add(op.id);
    requireTask(['PENDING','SUCCEEDED','FAILED','RESULT_UNKNOWN','CANCELLED'].includes(op.status),'操作状态无效');
    if(!['PENDING','RESULT_UNKNOWN'].includes(op.status)) text(op.evidence,'operation.evidence');
  }
  for(const old of previous?.operations||[]) requireTask(ids.has(old.id),'检查点不能丢弃已登记操作；保留编号及最终核查结果');
  return value;
}
const uncertain=t=>(t.checkpoint?.operations||[]).some(x=>['PENDING','RESULT_UNKNOWN'].includes(x.status));
function resultFor(t,result) {
  text(result?.summary,'result.summary'); text(result?.cleanup,'result.cleanup');
  list(result.artifacts||[],'result.artifacts',true);
  requireTask(Array.isArray(result.acceptance),'result.acceptance 须为数组');
  for(let i=0;i<t.acceptanceCriteria.length;i++) requireTask(result.acceptance.some(x=>x.criterion===i && typeof x.evidence==='string'&&x.evidence.trim()),`验收项 ${i} 缺少证据`);
  requireTask(!uncertain(t),'存在未核查的操作，不能标为完成');
  return result;
}

async function activeActivity(loc) {
  const a=await maybe(path.join(loc.runtime,'activity.json'));
  if(!a) return false;
  requireTask(a.host===os.hostname() && a.root===loc.root,'执行占用来自其他机器或目录，须现场核查');
  return processAlive(a.owner)||processAlive(a.child);
}
export async function requireRun(loc,id) {
  identity(id);
  const run=await maybe(path.join(loc.runtime,'run.json'));
  requireTask(run?.id===id && run.host===os.hostname() && run.root===loc.root && run.projectId===loc.projectId && !run.closedAt && !run.stopRequested && Date.parse(run.expiresAt)>Date.now() && processAlive(run.owner),'执行资格失效；先核查原执行者并重新启动，不能继续写入');
  return run;
}
export async function runtimeState(project) {
  const loc=await location(project);
  return {run:await maybe(path.join(loc.runtime,'run.json')),activity:await maybe(path.join(loc.runtime,'activity.json'))};
}
export async function withRuntime(project,callback) {
  const loc=await location(project); await directory(loc.runtime);
  return processLock(path.join(loc.runtime,'ledger.lock'),()=>callback(loc));
}
export async function startRun(project) {
  return withRuntime(project,async loc=>{
    const old=await maybe(path.join(loc.runtime,'run.json'));
    if(old&&!old.closedAt) {
      requireTask(old.root===loc.root&&old.host===os.hostname(),'旧执行记录属于其他机器或目录；不能复制执行资格');
      requireTask(!processAlive(old.owner),'已有执行会话；即使租约超时也不接管存活进程');
    }
    requireTask(!await activeActivity(loc),'原执行命令仍在运行，先核查原进程');
    const run={id:randomUUID(),root:loc.root,host:os.hostname(),projectId:loc.projectId,owner:processIdentity(),startedAt:timestamp(),expiresAt:new Date(Date.now()+600000).toISOString()};
    await atomic(path.join(loc.runtime,'run.json'),run); return run;
  });
}
export async function heartbeat(project,id) {
  return withRuntime(project,async loc=>{
    const run=await requireRun(loc,id); run.expiresAt=new Date(Date.now()+600000).toISOString();
    await atomic(path.join(loc.runtime,'run.json'),run); return {runId:id,expiresAt:run.expiresAt};
  });
}
export async function stopRun(project,id,{close=false}={}) {
  return withRuntime(project,async loc=>{
    const run=await maybe(path.join(loc.runtime,'run.json'));
    requireTask(run?.id===id,'执行编号已变化');
    if(close) { requireTask(!await activeActivity(loc),'受管命令仍在运行'); run.closedAt=timestamp(); }
    else run.stopRequested=true;
    await atomic(path.join(loc.runtime,'run.json'),run); return {runId:id,closedAt:run.closedAt,stopRequested:run.stopRequested};
  });
}
export async function activity(project,id,owner,child=null) {
  return withRuntime(project,async loc=>{
    await requireRun(loc,id);
    await atomic(path.join(loc.runtime,'activity.json'),{runId:id,root:loc.root,host:os.hostname(),owner,child});
  });
}
export async function clearActivity(project,id) {
  return withRuntime(project,async loc=>{
    const a=await maybe(path.join(loc.runtime,'activity.json'));
    requireTask(!a||a.runId===id,'执行命令归属已变化');
    if(a) { requireTask(!processAlive(a.child),'子进程仍存活'); await unlink(path.join(loc.runtime,'activity.json')); }
  });
}

export async function mutate(project,action,request) {
  identity(request.operationId);
  text(request.actor,'actor');
  if(action==='publish') validateSpec(request.task); // Nothing is persisted for an unclarified request.
  const hash=digest({action,request});
  return withRuntime(project,async loc=>{
    const ledger=await readLedger(loc), old=ledger.events.find(e=>e.operationId===request.operationId);
    if(old) { requireTask(old.requestHash===hash,'同一操作编号不能用于不同请求'); return {...old.result,replayed:true}; }
    const tasks=structuredClone(ledger.tasks), changed=new Set(), at=timestamp();
    const touch=t=>{ if(!changed.has(t.id)) { t.version++; t.updatedAt=at; changed.add(t.id); } return t; };
    const get=id=>{ const t=tasks[identity(id)]; requireTask(t,'任务不存在'); requireTask(request.expectedVersions?.[id]===t.version,`版本冲突：${id} 当前为 ${t.version}`); return t; };
    const create=(spec,suffix='')=>{
      const id='T-'+at.slice(0,10).replaceAll('-','')+'-'+digest(request.operationId+suffix).slice(0,12);
      requireTask(!tasks[id],'任务编号冲突');
      const t={...validateSpec(spec),id,projectId:loc.projectId,version:1,status:'READY',publishedAt:at,updatedAt:at,startedAt:null,completedAt:null,checkpoint:null,result:null};
      tasks[id]=t; changed.add(id); return t;
    };
    const owned=async t=>{ await requireRun(loc,request.runId); requireTask(t.status==='RUNNING'&&t.runId===request.runId,'任务不属于当前执行会话'); };
    let result;
    if(action==='publish') {
      const t=create(request.task); result={taskId:t.id,status:t.status};
    } else if(action==='next') {
      await requireRun(loc,request.runId);
      const unfinished=Object.values(tasks).filter(t=>t.status==='RUNNING');
      if(unfinished.length) return {status:unfinished[0].runId===request.runId?'CURRENT_TASK':'RECOVERY_REQUIRED',tasks:unfinished};
      requireTask(!await activeActivity(loc),'原执行命令仍在运行，不能领取新任务');
      const candidates=Object.values(tasks).filter(t=>t.status==='READY' && !t.children?.length && t.dependencies.every(d=>complete(tasks,d))).sort((a,b)=>a.priority-b.priority||a.publishedAt.localeCompare(b.publishedAt)||a.id.localeCompare(b.id));
      const t=candidates[0];
      if(!t) return {status:'NO_EXECUTABLE_TASK',remaining:Object.values(tasks).filter(t=>!terminal.has(t.status))};
      touch(t); t.status='RUNNING'; t.startedAt ||= at; t.runId=request.runId; t.blockReason=null;
      result={taskId:t.id,status:t.status};
    } else if(action==='checkpoint') {
      const t=get(request.taskId);
      if(t.status==='BLOCKED'&&!t.children?.length) await requireRun(loc,request.runId); else await owned(t);
      touch(t); t.checkpoint=checkpoint(request.checkpoint,t.checkpoint);
      result={taskId:t.id,status:t.status};
    } else if(action==='resume') {
      const t=get(request.taskId); await requireRun(loc,request.runId);
      requireTask(t.status==='RUNNING' && t.runId!==request.runId,'仅续办原会话中断的任务');
      const r=request.reconciliation;
      for(const k of ['processes','workspace','versions','operations']) text(r?.[k],`reconciliation.${k}`);
      requireTask(!await activeActivity(loc),'原命令仍在运行');
      const cp=checkpoint(request.checkpoint,t.checkpoint);
      touch(t); t.runId=request.runId; t.checkpoint=cp; t.reconciliation=r;
      if(uncertain(t)) {t.status='BLOCKED';t.blockReason='原操作结果仍未知；先查询原编号，禁止自动重试';}
      result={taskId:t.id,status:t.status};
    } else if(action==='transition') {
      const t=get(request.taskId); text(request.reason,'reason');
      requireTask(['READY','BLOCKED','WAITING_REVIEW','DONE','CANCELLED'].includes(request.status),'目标状态无效');
      requireTask(!terminal.has(t.status),'终态任务只读；新工作须发布新任务');
      if(t.status==='RUNNING') { await owned(t); requireTask(!await activeActivity(loc),'当前命令仍在运行，不能提前释放任务'); }
      requireTask(!t.children?.length || ['BLOCKED','CANCELLED'].includes(request.status),'拆解父任务由子任务完成情况汇总');
      if(request.status==='DONE') {
        requireTask(['RUNNING','WAITING_REVIEW'].includes(t.status),'任务须经执行或验收才能完成');
        requireTask(t.dependencies.every(d=>complete(tasks,d)),'前置依赖尚未完成');
        t.result=resultFor(t,request.result); t.completedAt=at;
      }
      if(request.status==='READY') requireTask(['BLOCKED','WAITING_REVIEW'].includes(t.status)&&!uncertain(t),'先解决阻塞和未知结果再重新入队');
      if(request.status==='CANCELLED') {
        requireTask(!uncertain(t)&&!await activeActivity(loc),'结果未知或命令仍在运行，不能直接取消');
        requireTask(!t.children?.some(id=>!terminal.has(tasks[id].status)),'请先处理子任务，不能只取消父任务留下可执行子任务');
      }
      if(request.status==='WAITING_REVIEW') requireTask(t.status==='RUNNING'&&!uncertain(t),'须完成执行并核查操作后提交验收');
      touch(t); t.status=request.status; t.blockReason=['BLOCKED','WAITING_REVIEW'].includes(t.status)?request.reason:null;
      result={taskId:t.id,status:t.status};
    } else if(action==='amend') {
      const t=get(request.taskId); text(request.reason,'reason'); requireTask(['READY','BLOCKED'].includes(t.status)&&!t.children?.length,'仅调整未执行或阻塞的普通任务');
      requireTask(Object.keys(request.changes||{}).every(k=>['priority','dependencies'].includes(k)),'改动目标或范围须另行澄清发布；这里只调整排序与依赖');
      const spec=validateSpec({...t,...request.changes,clarified:true}); touch(t); t.priority=spec.priority; t.dependencies=spec.dependencies;
      result={taskId:t.id,status:t.status};
    } else if(action==='merge') {
      text(request.reason,'reason'); text(request.title,'title');
      const sources=list(request.taskIds,'taskIds').map(get);
      requireTask(sources.length>=2&&new Set(request.taskIds).size===sources.length,'合并至少需要两个不同任务');
      requireTask(sources.every(t=>['READY','BLOCKED'].includes(t.status)&&!t.children?.length&&!t.startedAt&&t.type===sources[0].type),'仅合并同类且尚未开始的普通任务');
      const first=sources[0], union=k=>[...new Set(sources.flatMap(t=>t[k]))];
      const t=create({...first,clarified:true,title:request.title,originalRequest:sources.map(t=>`${t.id}: ${t.originalRequest}`).join('\n'),goal:sources.map(t=>t.goal).join('\n'),scope:union('scope'),deliverables:union('deliverables'),acceptanceCriteria:sources.flatMap(t=>t.acceptanceCriteria.map(x=>`${t.id}: ${x}`)),authorization:sources.map(t=>`${t.id}: ${t.authorization}`).join('\n'),references:union('references'),dependencies:union('dependencies').filter(x=>!request.taskIds.includes(x)),priority:Math.min(...sources.map(t=>t.priority))});
      t.sources=request.taskIds;
      for(const s of sources) { touch(s); s.status='MERGED'; s.mergedInto=t.id; s.mergeReason=request.reason; }
      result={taskId:t.id,sourceTaskIds:request.taskIds,status:t.status};
    } else if(action==='split') {
      const parent=get(request.taskId); text(request.reason,'reason');
      requireTask(['READY','BLOCKED'].includes(parent.status)&&!parent.startedAt&&!parent.children?.length,'仅拆解尚未开始的普通任务');
      requireTask(Array.isArray(request.children)&&request.children.length>=2&&request.children.length<=50,'至少拆解为两个子任务');
      const covered=new Set(), children=request.children.map((c,i)=>{
        text(c.title,'child.title'); text(c.goal,'child.goal');
        requireTask(Array.isArray(c.criterionIndexes)&&c.criterionIndexes.length,'每个子任务须承接原验收项');
        c.criterionIndexes.forEach(n=>{ requireTask(Number.isInteger(n)&&n>=0&&n<parent.acceptanceCriteria.length,'验收项编号无效'); covered.add(n); });
        const t=create({...parent,clarified:true,title:c.title,goal:c.goal,acceptanceCriteria:c.criterionIndexes.map(n=>parent.acceptanceCriteria[n])},String(i));
        t.parentId=parent.id; t.parentCriterionIndexes=c.criterionIndexes; return t.id;
      });
      requireTask(covered.size===parent.acceptanceCriteria.length,'拆解不能遗漏原验收项');
      touch(parent); parent.children=children; parent.status='BLOCKED'; parent.blockReason='等待子任务完成'; parent.splitReason=request.reason;
      result={taskId:parent.id,children,status:parent.status};
    } else throw Error('未知任务操作');
    graph(tasks);
    let aggregated;
    do {
      aggregated=false;
      for(const parent of Object.values(tasks)) if(parent.children?.length&&!terminal.has(parent.status)&&parent.children.every(id=>complete(tasks,id))) {
      touch(parent); parent.status='DONE'; parent.completedAt=at; parent.blockReason=null;
      parent.result={summary:'全部子任务已按原验收项完成',artifacts:parent.children,cleanup:'各子任务已记录清理证据',acceptance:parent.acceptanceCriteria.map((_,i)=>({criterion:i,evidence:parent.children.filter(id=>tasks[id].parentCriterionIndexes.includes(i)).join(', ')}))};
      aggregated=true;
      }
    } while(aggregated);
    result.tasks=[...changed].map(id=>tasks[id]);
    await initialize(loc);
    await append(loc,{schemaVersion:1,projectId:loc.projectId,sequence:ledger.sequence+1,previousHash:ledger.head,operationId:request.operationId,requestHash:hash,action,actor:request.actor,reason:request.reason||null,at,tasks:result.tasks,result});
    try { await projections({...loc,tasks}); } catch(e) { result.projectionWarning=`账本已提交；运行 rebuild 重建视图：${e.message}`; }
    return result;
  });
}

const safeText=s=>String(s??'').replaceAll('|','\\|').replaceAll('\n',' ');
export async function projections(ledger) {
  const base=path.join(ledger.root,'tasks'), cards=path.join(base,'items'); await directory(cards);
  const rows=Object.values(ledger.tasks).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)||a.id.localeCompare(b.id));
  async function markdown(file,content) {
    const old=await lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;}); requireTask(!old||old.isFile()&&!old.isSymbolicLink(),'任务视图路径不安全');
    const tmp=path.join(ledger.runtime,randomUUID()+'.md'); const f=await open(tmp,'wx',0o600); try{await f.writeFile(content);}finally{await f.close();}
    await (await import('node:fs/promises')).rename(tmp,file);
  }
  for(const t of rows) {
    const body=[`# ${t.title}`,'',`编号：${t.id} · 类型：${t.type} · 状态：${labels[t.status]} · 版本：${t.version}`,'',`发布时间：${t.publishedAt}\n\n开始时间：${t.startedAt||'尚未开始'}\n\n完成时间：${t.completedAt||'尚未完成'}`,'','## 正式要求','',t.goal,'','用户原话：\n\n'+t.originalRequest,'','范围：\n\n'+t.scope.map(x=>'- '+x).join('\n'),'','交付物：\n\n'+t.deliverables.map(x=>'- '+x).join('\n'),'','验收标准：\n\n'+t.acceptanceCriteria.map((x,i)=>`${i+1}. ${x}`).join('\n'),'','授权边界：\n\n'+t.authorization,'',`依赖：${t.dependencies.join(', ')||'无'}\n\n关系：${[t.parentId,...(t.children||[]),t.mergedInto,...(t.sources||[])].filter(Boolean).join(', ')||'无'}`,'','## 当前进展','',t.blockReason||'',t.checkpoint?.summary||'尚无执行检查点','',...(t.checkpoint?.completedSteps||[]).map(x=>'- 已完成：'+x),...(t.checkpoint?.nextSteps||[]).map(x=>'- 下一步：'+x),'','## 结果','',t.result?.summary||'尚未完成','',...(t.result?.acceptance||[]).map(x=>`- 验收 ${x.criterion+1}：${x.evidence}`),...(t.result?.artifacts||[]).map(x=>'- 成果：'+x),t.result?'\n清理：'+t.result.cleanup:'','', '此文件由追加式任务账本生成；通过 tasks CLI 修改。',''].join('\n');
    await markdown(path.join(cards,t.id+'.md'),body);
  }
  await markdown(path.join(base,'README.md'),'# 正式任务\n\n仅收录已完成澄清的正式任务。账本通过 tasks CLI 维护，视图可重建。时间为 UTC；对话审计默认换算北京时间。\n\n| 编号 | 任务 | 状态 | 发布时间 | 完成时间 |\n| --- | --- | --- | --- | --- |\n'+rows.map(t=>`| [${t.id}](items/${t.id}.md) | ${safeText(t.title)} | ${labels[t.status]} | ${t.publishedAt} | ${t.completedAt||'—'} |`).join('\n')+'\n');
}
export async function rebuild(project) { return withRuntime(project,async loc=>{await initialize(loc); const ledger=await readLedger(loc); await projections(ledger); return {status:'REBUILT',tasks:Object.keys(ledger.tasks).length};}); }
export function audit(ledger,{taskId,status,type,from,to,operationId}={}) {
  if(status) requireTask(states.includes(status),'状态筛选无效');
  for(const x of [from,to].filter(Boolean)) requireTask(!Number.isNaN(Date.parse(x)),'时间筛选无效；使用带时区的 ISO 时间');
  const match=t=>(!taskId||t.id===taskId)&&(!status||t.status===status)&&(!type||t.type===type);
  return {projectId:ledger.projectId,asOf:timestamp(),sequence:ledger.sequence,head:ledger.head,tasks:Object.values(ledger.tasks).filter(match),events:ledger.events.filter(e=>(!operationId||e.operationId===operationId)&&(!from||e.at>=new Date(from).toISOString())&&(!to||e.at<new Date(to).toISOString())&&(!taskId||e.tasks.some(t=>t.id===taskId))).map(({sequence,at,action,actor,reason,operationId,tasks})=>({sequence,at,action,actor,reason,operationId,changes:tasks.filter(match)}))};
}
