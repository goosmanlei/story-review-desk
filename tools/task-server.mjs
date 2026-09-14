// Compatibility and formal-task capacity policy. Lifecycle belongs to app-service.
import os from 'node:os';
import {readBindings,readLedger,requireTask} from './task-ledger.mjs';
import {closeNativeThread} from './task-native.mjs';
import {serverPaths,ensureAppService as ensureTaskServer,verifyAppService as verifyTaskServer,stopAppService} from './app-service.mjs';
export {serverPaths,ensureTaskServer,verifyTaskServer};
export async function stopTaskServer(project) {
 return stopAppService(project,{assertIdle:async p=>{
  const ledger=await readLedger(p),bindings=await readBindings(p);
  requireTask(!Object.values(ledger.tasks).some(t=>t.assignments?.some(a=>a.status!=='CLOSED'&&bindings.assignments[a.id]?.backendServiceId===p.serviceId)),'SERVER_BUSY：仍有未关闭派工');
 }});
}
export async function probeTaskServer(project){
 const record=await ensureTaskServer(project),v=await verifyTaskServer(project);let probeId;
 try{
  const models=await v.client.call('model/list',{}),loaded=await v.client.call('thread/loaded/list',{limit:100});
  const thread=await v.client.call('thread/start',{cwd:v.paths.directory,ephemeral:false,historyMode:'legacy'});probeId=thread.thread.id;
  await v.client.call('thread/name/set',{threadId:probeId,name:'review-tasks closure capability probe'});
  const closure=await closeNativeThread(v.client,probeId,null,{probe:true});
  const cpu=os.availableParallelism(),memory=os.totalmem(),configured=v.config.config.agents?.max_concurrent_threads_per_session??v.config.config.agents?.max_threads;
  const ledger=await readLedger(v.paths),occupied=Object.values(ledger.tasks).flatMap(t=>t.assignments||[]).filter(a=>a.status!=='CLOSED'&&a.execution.mode==='SUBAGENT').length;
  return {checkedAt:new Date().toISOString(),backend:'PROJECT_APP_SERVER',backendServiceId:record.serviceId,backendGeneration:record.generation,socket:record.socket,delegation:true,closeVerified:true,goalVerified:false,executionVerified:false,capacityScope:'PER_SESSION',occupiedAgentSlots:occupied,capacityEvidence:{configuredPerSession:configured??null,cpu,totalMemoryBytes:memory,formalTaskLimit:3,loadedThreads:loaded.data.length,scope:'PER_SESSION',primaryExcluded:true},models:models.data.map(m=>({model:m.model||m.id,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)})),closureProbe:closure,limitation:'专属服务及空线程关闭已核验；真实软件派工与并行重叠须独立验收，长任务使用FOLLOWUP'};
 }catch(error){throw Error('SERVER_PROBE_FAILED：'+error.message+(probeId?'；保留探测会话 '+probeId:''));}finally{v.client.close();}
}
