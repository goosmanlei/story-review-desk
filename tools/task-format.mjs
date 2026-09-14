import {displayTaskId,compareTaskPublication} from './task-numbering.mjs';

export const taskLabels={READY:'READY',RUNNING:'RUNNING',BLOCKED:'BLOCKED',WAITING_REVIEW:'WAITING_REVIEW',DONE:'DONE',CANCELLED:'CANCELLED',MERGED:'MERGED'};
const taskTypes=new Set(['SYSTEM','CREATIVE']);
const assignmentStatuses=new Set(['RESERVED','RUNNING','WAITING_DECISION','DELIVERED','ACCEPTED','BLOCKED','CLOSED']);
export const cell=value=>String(value??'—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\\','&#92;').replaceAll('|','&#124;').replaceAll('`','&#96;').replaceAll('[','&#91;').replaceAll(']','&#93;').replaceAll('*','&#42;').replaceAll('_','&#95;').replace(/[\r\n\t]+/g,' ');
export const formatTaskDate=value=>{
  if(value===null||value==='')return '—';
  if(!value||Number.isNaN(Date.parse(value)))return 'UNKNOWN';
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value));
};
const date=formatTaskDate;
const taskIndex=tasks=>Array.isArray(tasks)?Object.fromEntries(tasks.map(t=>[t.id,t])):tasks||{};
const taskStatus=t=>Object.hasOwn(taskLabels,t?.status)?t.status:'UNKNOWN';
const taskType=t=>taskTypes.has(t?.type)?t.type:'UNKNOWN';
const lineCell=values=>values?.length?values.map(cell).join('<br>'):'—';
export function table(headers,rows) {return ['| '+headers.map(cell).join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |',...rows.map(r=>'| '+r.join(' | ')+' |')].join('\n');}
export function sortTasks(tasks,sort='published') {
  if(!['published','priority','updated','completed'].includes(sort))throw Error('排序须为 published、priority、updated 或 completed');
  return [...tasks].sort((a,b)=>(sort==='priority'?a.priority-b.priority:sort==='updated'?(b.updatedAt||'').localeCompare(a.updatedAt||''):sort==='completed'?(b.completedAt||'').localeCompare(a.completedAt||''):0)||compareTaskPublication(a,b));
}
export function renderTasks(data,{sort='published',columns=[],tasks=data.tasks}={}) {
  const index=taskIndex(tasks),display=id=>displayTaskId(index,id);
  const rows=sortTasks(data.tasks||[],sort),asOf=date(data.asOf),counts={};
  for(const t of rows)counts[taskStatus(t)]=(counts[taskStatus(t)]||0)+1;
  const distribution=[...Object.keys(taskLabels),'UNKNOWN'].filter(s=>counts[s]).map(s=>`${s} ${counts[s]}`).join('、')||'无任务';
  const intro=`截至 ${asOf}（北京时间），${data.scope||'当前查询范围'}共 ${rows.length} 项任务；${distribution}。`;
  const extras={completed:['完成时间',t=>date(t.completedAt)],progress:['当前进展',t=>t.checkpoint?.summary||'—'],blocker:['阻塞原因',t=>t.blockReason||'—'],result:['最终结果',t=>t.result?.summary||'—']};
  if(columns.some(c=>!extras[c]))throw Error('未知任务表格列');
  const headers=['任务编号','任务标题','类别','状态','优先级','发布时间','前置依赖'];
  const main=table(headers,rows.map(t=>[cell(t.displayId||display(t.id)),cell(t.title),cell(taskType(t)),cell(taskStatus(t)),cell(t.priority),cell(date(t.publishedAt)),lineCell((t.dependencies||[]).map(display))]));
  const detail=columns.length?'\n\n'+table(['任务编号',...columns.map(c=>extras[c][0])],rows.map(t=>[cell(t.displayId||display(t.id)),...columns.map(c=>cell(extras[c][1](t)))])):'';
  return intro+'\n\n'+main+detail;
}
export function renderStatus(data,options={}) {
  const runtime=data.runtime||{},open=(data.tasks||[]).flatMap(t=>(t.assignments||[]).filter(a=>a.status!=='CLOSED'));
  const activityCount=(runtime.activities||[]).filter(a=>a.live===true).length;
  const rows=[['执行者',runtime.runActive===null?'UNKNOWN（无法核验原执行者）':runtime.runActive?'当前会话执行中':'无活跃执行者'],['未关闭派工',open.length?`${open.length} 项`:'无'],['受管命令',(runtime.activities||[]).some(a=>a.live===null)?'UNKNOWN（存在无法核验的占用）':activityCount?`${activityCount} 项正在运行`:'无活跃命令'],['执行能力',runtime.run?.capabilities?.limitation||(runtime.run?.capabilities?.delegation?'SubAgent 自动调度':'主 Agent 执行')]];
  if(runtime.taskCapacity)rows.push(['正式任务占用',`${runtime.taskCapacity.occupied} / ${runtime.taskCapacity.limit} 项；可补入 ${runtime.taskCapacity.available} 项（仍须通过依赖、资源及执行能力检查）`]);
  const decisions=(data.tasks||[]).flatMap(t=>(t.assignments||[]).flatMap(a=>(a.decisions||[]).filter(d=>!['RESOLVED','CANCELLED'].includes(d.status))));
  rows.push(['待决策',decisions.length?`${decisions.length} 项；未关闭派工保留资源及容量。使用 decisions list 发现并集中转达`:'无']);
  if(runtime.decisionChannel)rows.push(['决策连接',runtime.decisionChannel.status]);
  return renderTasks(data,options)+'\n\n'+table(['项目','当前情况'],rows.map(r=>r.map(cell)))+renderAssignments(data.tasks||[]);
}
export function renderDetail(task,{tasks=[task]}={}) {
  const index=taskIndex(tasks);
  const rows=[['任务编号',cell(task.displayId||task.id)],['任务内容',cell(task.title)],['状态',cell(taskStatus(task))],['类型',cell(taskType(task))],['优先级',cell(task.priority)],['发布时间',cell(date(task.publishedAt))],['首次开始',cell(date(task.startedAt))],['完成时间',cell(date(task.completedAt))],['目标',cell(task.goal)],['讨论结论',cell(task.discussion?.summary||'UNKNOWN（旧版未单独记录）')],['可行性',cell(task.discussion?.feasibility||'UNKNOWN（旧版未单独记录）')],['当前进展',cell(task.checkpoint?.summary||'—')],['阻塞',cell(task.blockReason||'—')],['依赖',lineCell((task.dependencies||[]).map(id=>displayTaskId(index,id)))],['结果',cell(task.result?.summary||'—')]];
  return table(['字段','内容'],rows.map(([key,value])=>[cell(key),value]))+renderAssignments([task]);
}
export function renderAssignments(tasks) {
  const rows=tasks.flatMap(t=>(t.assignments||[]).map(a=>[cell(a.id),cell(t.displayId||t.id),cell(assignmentStatuses.has(a.status)?a.status:'UNKNOWN'),cell(`${a.execution.model} / ${a.execution.effort}`),cell(`${a.execution.goalMode} / ${a.execution.goalMode==='NATIVE'&&a.closure?'STOPPED':a.goalStatus||(a.execution.goalMode==='NATIVE'&&a.startedAt?'UNKNOWN':'—')}`),cell(a.closure?.agent||'尚未关闭')]));
  return rows.length?'\n\n'+table(['派工编号','所属任务','状态','模型 / 强度','Goal','Agent 关闭'],rows):'';
}
export function renderAudit(data,options={}) {
  const index=taskIndex(options.tasks||data.tasks);
  const rows=(data.events||[]).map(e=>[cell(e.sequence),cell(date(e.at)),cell(e.action),cell(e.changes?.map(t=>t.displayId||displayTaskId(index,t.id)).join('、')||'—'),cell(e.reason||'—')]);
  return renderTasks(data,options)+renderAssignments(data.tasks||[])+'\n\n'+table(['序号','时间（北京时间）','操作','相关任务','说明'],rows);
}
