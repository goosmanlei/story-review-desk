import path from 'node:path';

const demand=(ok,message)=>{if(!ok)throw Error(message);};
const nonempty=(v,name)=>demand(typeof v==='string'&&v.trim()&&v.length<=30000,`${name}须为非空文本`);

// The role describes the durable execution tree. execution.mode describes the
// host transport and must never be used to infer a parent/child relationship.
export const assignmentRole=a=>a.role||(a.parentAssignmentId?'SUBAGENT':'WORKER');
export function assignmentNodes(input){
  const tasks=Array.isArray(input)?input:input?.assignments||input?.id?[input]:Object.values(input||{});
  return tasks.flatMap(task=>(task.assignments||[]).map(assignment=>({task,assignment})));
}
export const findAssignment=(tasks,id)=>assignmentNodes(tasks).find(x=>x.assignment.id===id);
export function assignmentAncestors(tasks,id){
  const origin=findAssignment(tasks,id);demand(origin,'派工不存在');
  const ancestors=[],seen=new Set([id]);let node=origin.assignment;
  while(node.parentAssignmentId){
    demand(!seen.has(node.parentAssignmentId),'ASSIGNMENT_TREE_CYCLE：执行树形成循环');
    seen.add(node.parentAssignmentId);
    const parent=findAssignment(tasks,node.parentAssignmentId);
    demand(parent&&parent.task.id===origin.task.id,'ASSIGNMENT_PARENT_SCOPE：父节点须属于同一正式任务');
    ancestors.push(parent.assignment);node=parent.assignment;
  }
  return ancestors;
}
export const isAssignmentAncestor=(tasks,ancestorId,descendantId)=>ancestorId!==descendantId&&assignmentAncestors(tasks,descendantId).some(a=>a.id===ancestorId);
export const assignmentDescendants=(tasks,id)=>assignmentNodes(tasks).map(x=>x.assignment).filter(a=>a.id!==id&&isAssignmentAncestor(tasks,id,a.id));
export const rootAssignment=(tasks,id)=>assignmentAncestors(tasks,id).at(-1)||findAssignment(tasks,id)?.assignment;

export function validateAssignmentTree(tasks){
  const ids=new Set();
  for(const {task,assignment:a} of assignmentNodes(tasks)){
    demand(!ids.has(a.id),'ASSIGNMENT_ID_DUPLICATE：派工身份重复');ids.add(a.id);
    demand(a.taskId===task.id,'ASSIGNMENT_TASK_SCOPE：派工与正式任务不符');
    demand(['WORKER','SUBAGENT'].includes(assignmentRole(a)),'ASSIGNMENT_ROLE：执行节点角色无效');
    demand(assignmentRole(a)==='SUBAGENT'?!!a.parentAssignmentId:!a.parentAssignmentId,'ASSIGNMENT_PARENT_SCOPE：角色与父节点不符');
    const root=rootAssignment(tasks,a.id);
    demand(!a.rootAssignmentId||a.rootAssignmentId===root.id,'ASSIGNMENT_ROOT_SCOPE：根节点身份不符');
    if(a.parentAssignmentId){
      const parent=findAssignment(tasks,a.parentAssignmentId).assignment;
      demand(resourcesWithin(a.resources,parent.resources),'RESOURCE_SCOPE：子节点超出父节点资源范围');
      demand(a.status==='CLOSED'||parent.status!=='CLOSED','ASSIGNMENT_DESCENDANTS_OPEN：父节点已关闭但子节点仍开放');
    }
  }
  for(const task of Array.isArray(tasks)?tasks:Object.values(tasks)){
    // Unmodified v1/v2 rows remain readable; only v3 writers create role fields.
    demand((task.assignments||[]).filter(a=>a.role==='WORKER'&&a.status!=='CLOSED').length<=1,'WORKER_EXISTS：同一正式任务只能有一个开放的 WORKER');
  }
}

export function resources(value){
  if(!value?.length)return [{kind:'UNKNOWN',key:'*',access:'WRITE'}];
  demand(Array.isArray(value)&&value.length<=200,'resources 须为有界数组');
  return value.map(r=>{
    demand(['FILE','DIRECTORY','OBJECT','UNKNOWN'].includes(r.kind),'资源种类无效');
    demand(['READ','WRITE'].includes(r.access),'资源访问方式无效');
    if(r.kind==='UNKNOWN')return {kind:'UNKNOWN',key:'*',access:'WRITE'};
    nonempty(r.key,'resource.key');
    demand(!path.posix.isAbsolute(r.key)&&!r.key.includes('\\')&&!r.key.split('/').some(x=>['..','.',''].includes(x)),'资源必须使用规范逻辑身份，不能使用机器绝对路径');
    if(r.access==='READ')nonempty(r.version,'不可变读取的精确版本');
    return {kind:r.kind,key:r.key,access:r.access,...(r.access==='READ'?{version:r.version}:{})};
  });
}
const covers=(parent,child)=>{
  if(parent.kind==='UNKNOWN')return true;
  if(child.kind==='UNKNOWN')return false;
  if(parent.access==='READ'&&(child.access!=='READ'||parent.version!==child.version))return false;
  if((parent.kind==='OBJECT')!==(child.kind==='OBJECT'))return false;
  const p=parent.key.toLowerCase(),c=child.key.toLowerCase();
  return p===c&&(parent.kind===child.kind||parent.kind==='DIRECTORY')||parent.kind==='DIRECTORY'&&c.startsWith(p+'/');
};
export const resourcesWithin=(child,parent)=>resources(child).every(c=>resources(parent).some(p=>covers(p,c)));
export function conflicts(left,right){
  return resources(left).some(a=>resources(right).some(b=>{
    if(a.kind==='UNKNOWN'||b.kind==='UNKNOWN')return true;
    if(a.access==='READ'&&b.access==='READ')return false;
    if((a.kind==='OBJECT')!==(b.kind==='OBJECT'))return false;
    const x=a.key.toLowerCase(),y=b.key.toLowerCase();
    return x===y||a.kind==='DIRECTORY'&&y.startsWith(x+'/')||b.kind==='DIRECTORY'&&x.startsWith(y+'/');
  }));
}
export function requireAssignmentResourceAccess(tasks,assignment,claims=assignment.resources){
  const requested=resources(claims);
  demand(resourcesWithin(requested,assignment.resources),'RESOURCE_SCOPE：执行资源超出派工范围');
  demand(!assignmentDescendants(tasks,assignment.id).some(a=>a.status!=='CLOSED'&&conflicts(requested,a.resources)),'RESOURCE_DELEGATED：资源已委派给开放子节点，祖先不得继续访问冲突范围');
  return requested;
}
