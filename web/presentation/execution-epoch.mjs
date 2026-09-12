// Epoch metadata is mutable runtime identity; immutable business rows are not
// rewritten during restoration. Normal process restarts retain the same epoch.
export const RESTORED_EPOCH_PREFIX='restore_v1_';
export function restoredRuntimeEpoch(uuid){
 if(typeof uuid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uuid))throw Error('A fresh UUID is required for a restore epoch');
 return RESTORED_EPOCH_PREFIX+uuid;
}
export function isRestoredRuntime(epoch){return typeof epoch==='string'&&epoch.startsWith(RESTORED_EPOCH_PREFIX);}
/** Queue discovery never claims or marks old restored jobs failed merely
 * because a worker started. Historical rows remain byte-identical. */
export async function listWorkerRuntimeJobs(tx,namespace){
 const records=await tx.listAux(namespace);
 if(typeof tx.getMetadata!=='function')return records; // existing pure fixtures
 const metadata=await tx.getMetadata();
 if(!isRestoredRuntime(metadata.runtimeEpoch))return records;
 return records.filter(record=>{
  if(record.deleted)return true;let job;try{job=JSON.parse(record.bytes);}catch{return true;}
  return job?.status!=='QUEUED'||job.instanceId===metadata.instanceId&&job.runtimeEpoch===metadata.runtimeEpoch;
 });
}
export function executionRuntimeReason(runtime,request){
 if(!request?.executionRequestId)return null; // Prospective readiness is not authorization.
 const binding=request.authorizationRuntime;
 if(!runtime){
  return binding?'EXECUTION_RUNTIME_UNAVAILABLE':null; // Legacy file fixtures retain their former contract.
 }
 if(!binding)return isRestoredRuntime(runtime.runtimeEpoch)?'RESTORED_REQUEST_REQUIRES_NEW_AUTHORIZATION':null;
 if(typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).sort().join(',')!=='instanceId,runtimeEpoch'||typeof binding.instanceId!=='string'||typeof binding.runtimeEpoch!=='string')return 'EXECUTION_RUNTIME_BINDING_INVALID';
 return binding.instanceId===runtime.instanceId&&binding.runtimeEpoch===runtime.runtimeEpoch?null:'RESTORED_REQUEST_REQUIRES_NEW_AUTHORIZATION';
}
export function restoredRunUpdateAllowed(runtime,request,previousState,nextState,hasReconciliationEvidence=false){
 if(!executionRuntimeReason(runtime,request))return true;
 if(!previousState||['PLANNED','SUBMITTED','RUNNING'].includes(nextState))return false;
 if(nextState==='RESULT_UNKNOWN')return ['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN'].includes(previousState);
 if(nextState==='CANCELLED')return previousState==='PLANNED';
 return ['SUCCEEDED','FAILED'].includes(nextState)&&hasReconciliationEvidence;
}

export function restoredUnresolvedRunsForWorkItem(runtime,requestEvents,runEvents,workItemId){
 const requests=new Map(),runs=new Map();
 for(const request of requestEvents)if(!requests.has(request.executionRequestId))requests.set(request.executionRequestId,request);
 for(const run of runEvents)if(!runs.has(run.runId))runs.set(run.runId,run);
 return [...runs.values()].filter(run=>{
  const request=requests.get(run.executionRequestId);
  return request?.workItemId===workItemId&&executionRuntimeReason(runtime,request)&&['PLANNED','SUBMITTED','RUNNING'].includes(String(run.runState||run.state||''));
 });
}

/** Project restored provider uncertainty across snapshots, without rewriting
 * business states or turning historical successes into new registration work. */
export function executionRequestsForRuntimeQueue(runtime,current,requestEvents=[],runEvents=[]){
 const result=[...current],positions=new Map(result.map((request,i)=>[request.executionRequestId,i])),requests=new Map(),runs=new Map(),added=new Set();
 for(const request of requestEvents)if(!requests.has(request.executionRequestId))requests.set(request.executionRequestId,request);
 for(const run of runEvents)if(!runs.has(run.runId))runs.set(run.runId,run);
 for(const run of runs.values()){
  const request=requests.get(run.executionRequestId);
  if(!request||added.has(request.executionRequestId)||!executionRuntimeReason(runtime,request)||!['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN'].includes(String(run.runState||run.state||'')))continue;
  added.add(request.executionRequestId);
  const index=positions.get(request.executionRequestId);
  if(index===undefined)result.push({...request,restoreBlockedRun:run});
  else result[index]={...result[index],restoreBlockedRun:run};
 }
 return result;
}
