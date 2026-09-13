export const MAX_PARALLEL_TASKS=3;

// Count formal identities, including main work and every durable reservation.
// A delivered/idle/blocked assignment still occupies its task until closed;
// closing its last assignment does not complete a still-RUNNING parent task.
export function taskCapacity(tasks){
 const rows=Array.isArray(tasks)?tasks:Object.values(tasks);
 const taskIds=[...new Set(rows.filter(t=>t.status==='RUNNING'||t.assignments?.some(a=>a.status!=='CLOSED')).map(t=>t.id))].sort();
 return {limit:MAX_PARALLEL_TASKS,occupied:taskIds.length,available:Math.max(0,MAX_PARALLEL_TASKS-taskIds.length),taskIds};
}
export function taskCapacityReason(tasks,taskId){
 const capacity=taskCapacity(tasks),projected=new Set([...capacity.taskIds,...(taskId?[taskId]:[])]).size;
 return projected>MAX_PARALLEL_TASKS?'TASK_CAPACITY':null;
}
export function requireTaskCapacity(tasks,taskId){
 if(taskCapacityReason(tasks,taskId)){const c=taskCapacity(tasks);throw Error(`TASK_CAPACITY：项目最多同时占用 ${c.limit} 项正式任务，当前 ${c.occupied} 项；先收尾并释放原任务占用`);}
}
