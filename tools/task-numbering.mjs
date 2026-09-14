// Display numbers are aliases of immutable task IDs. The event chain is the only
// authority; neither a filtered list nor a generated view allocates numbers.
const dayFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
const pattern = /^T-(\d{8})-(\d{3})$/;
const demand = (ok, message) => { if (!ok) throw Error(message); };

export function taskDay(at) {
  demand(typeof at==='string' && Number.isFinite(Date.parse(at)), 'TASK_PUBLICATION_TIME：原始发布时间无效');
  const parts=Object.fromEntries(dayFormat.formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  const day=parts.year+parts.month+parts.day;
  demand(/^\d{8}$/.test(day),'TASK_PUBLICATION_TIME：发布时间年份须为四位');
  return day;
}
function allocate(day, highWater) {
  const next=(highWater.get(day)||0)+1;
  demand(next<=999,`TASK_NUMBER_LIMIT：北京时间 ${day} 已达每日 999 项上限；整笔操作未发布`);
  highWater.set(day,next);
  return `T-${day}-${String(next).padStart(3,'0')}`;
}

export function replayTaskNumbers(events) {
  const publications=new Map(), declarations=[], snapshots=[];
  for(const event of events) {
    for(const task of event.tasks) {
      if(!publications.has(task.id)) publications.set(task.id,{id:task.id,at:task.publishedAt,day:taskDay(task.publishedAt),sequence:event.sequence,order:publications.size});
      else demand(Date.parse(task.publishedAt)===Date.parse(publications.get(task.id).at),'TASK_PUBLICATION_TIME：原始发布时间不可变化');
      if(task.displayId!==undefined) snapshots.push(task);
    }
    if(event.taskNumbering!==undefined) {
      demand(event.taskNumbering?.version===1 && Array.isArray(event.taskNumbering.allocations),'TASK_NUMBERING_VERSION：展示编号协议无效');
      declarations.push(...event.taskNumbering.allocations.map(a=>({...a,sequence:event.sequence})));
    }
  }
  const displayIds={}, used=new Map(), highWater=new Map(), persistedIds=[];
  for(const {taskId,displayId,sequence} of declarations) {
    const publication=publications.get(taskId), match=typeof displayId==='string'&&pattern.exec(displayId);
    demand(publication && publication.sequence<=sequence && match && match[1]===publication.day && Number(match[2])>0,'TASK_NUMBERING_INVALID：展示编号须匹配原始发布日及 001–999');
    demand(!Object.hasOwn(displayIds,taskId) && !used.has(displayId),'TASK_NUMBERING_CONFLICT：任务展示编号重复分配');
    displayIds[taskId]=displayId;used.set(displayId,taskId);persistedIds.push(taskId);
    highWater.set(match[1],Math.max(highWater.get(match[1])||0,Number(match[2])));
  }
  // Legacy first publications sort by the original instant, then by immutable
  // event/array order. Once persisted, a mapping is never sorted or allocated again.
  for(const p of [...publications.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.order-b.order)) {
    if(Object.hasOwn(displayIds,p.id))continue;
    const displayId=allocate(p.day,highWater);displayIds[p.id]=displayId;used.set(displayId,p.id);
  }
  for(const [displayId,id] of used) demand(!publications.has(displayId)||displayId===id,'TASK_NUMBERING_CONFLICT：展示编号与其他永久 ID 冲突');
  for(const task of snapshots) demand(task.displayId===displayIds[task.id],'TASK_NUMBERING_CONFLICT：任务快照不能改号');
  return {displayIds,persistedIds};
}

export function nextTaskDisplayId(tasks,at) {
  const day=taskDay(at),highWater=new Map();
  for(const task of Object.values(tasks)) {
    const match=pattern.exec(task.displayId||'');
    if(match?.[1]===day)highWater.set(day,Math.max(highWater.get(day)||0,Number(match[2])));
  }
  const displayId=allocate(day,highWater);
  demand(!Object.hasOwn(tasks,displayId),'TASK_NUMBERING_CONFLICT：展示编号与永久 ID 冲突');
  return displayId;
}

export function resolveTaskId(tasks,reference) {
  if(typeof reference!=='string')return reference;
  const alias=Object.values(tasks).find(t=>t.displayId===reference);
  demand(!alias||!Object.hasOwn(tasks,reference)||alias.id===reference,'TASK_NUMBERING_CONFLICT：任务别名不唯一');
  return alias?.id||reference;
}
export const displayTaskId = (tasks,id) => tasks[id]?.displayId||id;
export const compareTaskPublication = (a,b) => Date.parse(a.publishedAt)-Date.parse(b.publishedAt)||(a.displayId||a.id).localeCompare(b.displayId||b.id);

// Normalize only structured task references, never titles, evidence, operation
// IDs, decision binding tokens or native/runtime identities. Run under the ledger
// lock, before request hashing and the original multi-object CAS checks.
export function normalizeTaskRequest(tasks,request) {
  const resolve=id=>resolveTaskId(tasks,id),result=structuredClone(request);
  const references=object=>{
    for(const key of ['dependencies','references'])if(Array.isArray(object?.[key]))object[key]=object[key].map(id=>typeof id==='string'&&id.startsWith('@')?id:resolve(id));
  };
  if(result.taskId!==undefined)result.taskId=resolve(result.taskId);
  if(Array.isArray(result.taskIds))result.taskIds=result.taskIds.map(resolve);
  if(result.expectedVersions && typeof result.expectedVersions==='object' && !Array.isArray(result.expectedVersions)) {
    const versions=new Map();
    for(const [key,version] of Object.entries(result.expectedVersions)) {
      const id=resolve(key);
      demand(!versions.has(id)||versions.get(id)===version,'TASK_ALIAS_VERSION_CONFLICT：同一任务的新旧编号给出了不同版本');
      versions.set(id,version);
    }
    result.expectedVersions=Object.fromEntries(versions);
  }
  references(result.task);references(result.changes);
  if(Array.isArray(result.tasks))result.tasks.forEach(references);
  if(Array.isArray(result.assignments))for(const a of result.assignments)if(a?.taskId!==undefined)a.taskId=resolve(a.taskId);
  return result;
}

export function numberedResult(result,tasks) {
  return {...result,...(result.tasks?{tasks:result.tasks.map(t=>({...t,displayId:tasks[t.id]?.displayId||t.displayId}))}:{})};
}
