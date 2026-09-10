import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './bytes.mjs';

export function emptyVpsState(target){return {schemaVersion:'1.0',kind:'REVIEW_VPS_STATE',targetId:target.targetId,targetSha256:sha256(canonicalJson(target)),current:null,backup:null,pending:null,lastReceipt:null,samples:[]};}
export function planVps(target,state,manifest,inspection){
 if(state.targetId!==target.targetId||state.targetSha256!==sha256(canonicalJson(target)))throw Error('Target configuration differs from prepared host');
 const loadedImageBytes=manifest.images.reduce((n,i)=>n+i.loadedBytes,0);
 const packageBytes=manifest.totalFileBytes+Buffer.byteLength(JSON.stringify(manifest,null,2))+1;
 // Do not credit a running database or image for free space until removed.
 // This also leaves enough headroom to restore the clean fallback on failure.
 const fallback=inspection.fallbackRuntimeBudgetBytes||0;
 const requiredFreeBytes=Math.max(manifest.runtimeBudgetBytes,fallback)+packageBytes+loadedImageBytes+target.retention.maxTemporaryBytes+target.retention.reserveBytes;
 if(!Number.isSafeInteger(inspection.freeBytes)||inspection.freeBytes<0)throw Error('Missing actual filesystem free-space measurement');
 return {targetId:target.targetId,expectedCurrent:state.current?.releaseId||'NONE',releaseId:manifest.releaseId,allowed:inspection.freeBytes>=requiredFreeBytes,freeBytes:inspection.freeBytes,requiredFreeBytes,packageBytes,loadedImageBytes,runtimeBudgetBytes:manifest.runtimeBudgetBytes,temporaryBudgetBytes:target.retention.maxTemporaryBytes,reserveBytes:target.retention.reserveBytes,maximumFullCopies:3,steps:['VERIFY_SOURCE_AND_CLEAN_FALLBACK','MAINTENANCE_AND_DRAIN','REMOVE_OWNED_RUNTIME','STREAM_FRESH_RUNTIME','VERIFY_AND_OPEN','DELETE_OLDEST_BACKUP','ROTATE_CLEAN_CURRENT','SAVE_NEW_CLEAN_PACKAGE']};
}

/** Runs only under the host's OS flock. Driver methods reconcile actual owned
 * resources and are idempotent. Every destructive/create intent is journalled
 * before execution. A source is re-openable; it is never staged as a fourth
 * full package. A recovery command always restores a clean published package. */
export async function executeVps({target,state,source,driver,expectedCurrent,operationId,action='deploy',recover=false}){
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,120}$/.test(operationId||''))throw Error('Explicit stable --operation-id required');
 if(!expectedCurrent)throw Error('Explicit --expected-current required (NONE for first deployment)');
 if(!['deploy','rollback'].includes(action))throw Error('Unsupported publisher action');
 const fingerprint=sha256(canonicalJson({action,expectedCurrent,operationId,releaseId:source.manifest.releaseId,manifestSha256:source.manifest.manifestSha256}));
 if(state.lastReceipt?.fingerprint===fingerprint&&!state.pending)return {...state.lastReceipt,replayed:true};
 if(state.pending&&state.pending.fingerprint!==fingerprint)throw Error('An unfinished publication exists; resume its exact operation before starting another');
 if(!state.pending){
  if((state.current?.releaseId||'NONE')!==expectedCurrent)throw Error('Current release CAS mismatch');
  if(action==='rollback'&&(!state.backup||state.backup.releaseId!==source.manifest.releaseId))throw Error('Rollback must use the previous clean package');
  if(action==='deploy'&&state.current?.releaseId===source.manifest.releaseId)throw Error('Current release is already running');
  state.pending={operationId,fingerprint,action,expectedCurrent,manifest:source.manifest,phase:'PREFLIGHT',runtime:null,restoreAttempt:randomUUID(),error:null,recovery:false};
  await driver.save(state);
 }
 const pending=state.pending;
 const phase=async value=>{pending.phase=value;pending.error=null;await driver.save(state);await sample(value);};
 const sample=async label=>{const usage=await driver.measure();state.samples.push({phase:label,operationId,...usage,at:new Date().toISOString()});state.samples=state.samples.slice(-100);await driver.save(state);};
 if(recover){
  if(!state.current||['OPENED','ROTATING','SAVING'].includes(pending.phase))throw Error('Clean-current recovery is only available before opening the replacement');
  if(pending.runtime){if(['OPENING'].includes(pending.phase)){await driver.maintenance(pending.runtime);await driver.drain(pending.runtime);await driver.assertQuiescent(pending.runtime);}await driver.removeRuntime(pending.runtime);}
  pending.runtime=null;pending.recovery=true;pending.restoreAttempt=randomUUID();
  source=await driver.cleanSource(state.current);await driver.verifySource(source);pending.manifest=source.manifest;await phase('RUNTIME_REMOVED');
 }else if(pending.recovery){source=await driver.cleanSource(state.current);}
 try{
  if(pending.phase==='PREFLIGHT'){
   const inspection=await driver.inspect(state),plan=planVps(target,state,source.manifest,inspection);
   if(!plan.allowed)throw Error('Insufficient capacity before runtime reclamation');
   await driver.validatePrepared(inspection);
   await driver.verifySource(source);
   if(state.current)await driver.verifySource(await driver.cleanSource(state.current));
   await phase('MAINTENANCE');
  }
  if(pending.phase==='MAINTENANCE'){
   await driver.maintenance(state.current?.runtime);await driver.drain(state.current?.runtime);await phase('DRAINED');
  }
  if(pending.phase==='DRAINED'){
   if(state.current){await driver.assertQuiescent(state.current.runtime);await driver.removeRuntime(state.current.runtime);}
   await phase('RUNTIME_REMOVED');
  }
  if(pending.phase==='RUNTIME_REMOVED'){
   pending.runtime=await driver.runtimeIntent(source.manifest,pending.restoreAttempt);await phase('RESTORING');
  }
  if(pending.phase==='RESTORING'){
   // A partially imported target never becomes a recovery baseline. Reconcile
   // or discard only its exact inventory, then import again under a new epoch.
   await driver.restore(source,pending.runtime);await phase('VERIFYING');
  }
  if(pending.phase==='VERIFYING'){
   await driver.verifyRuntime(pending.runtime,source.manifest);await phase('OPENING');
  }
  if(pending.phase==='OPENING'){
   await driver.open(pending.runtime);await phase('OPENED');
  }
  if(pending.recovery){
   state.current.runtime=pending.runtime;
   const receipt={status:'CLEAN_CURRENT_RECOVERED',operationId,releaseId:state.current.releaseId,runtimeEpoch:pending.runtime.runtimeEpoch,fingerprint};state.lastReceipt=receipt;state.pending=null;await driver.save(state);return receipt;
  }
  if(pending.phase==='OPENED')await phase('ROTATING');
  if(pending.phase==='ROTATING'){
   // Rollback swaps existing clean slots without ever copying a package.
   if(action==='rollback'){
    const old=state.current;state.current={...state.backup,runtime:pending.runtime};state.backup=old?{...old,runtime:undefined}:null;
   }else{
    pending.savingSlot=state.backup?.slot||(state.current?.slot==='clean-0'?'clean-1':'clean-0');
    if(state.backup)await driver.removeClean(state.backup);
    state.backup=state.current?{...state.current,runtime:undefined}:null;
    state.current={releaseId:source.manifest.releaseId,manifestSha256:source.manifest.manifestSha256,slot:pending.savingSlot,runtime:pending.runtime,cleanReady:false};
   }
   await phase('SAVING');
  }
  if(pending.phase==='SAVING'){
   if(action==='deploy')await driver.saveClean(source,state.current);
   state.current.cleanReady=true;
   const receipt={status:action==='rollback'?'ROLLED_BACK_CLEAN':'DEPLOYED_CLEAN',operationId,releaseId:state.current.releaseId,runtimeEpoch:state.current.runtime.runtimeEpoch,backupReleaseId:state.backup?.releaseId||null,fingerprint};
   state.lastReceipt=receipt;state.pending=null;await driver.save(state);await sample('COMPLETE');return receipt;
  }
  throw Error('Unknown publication phase');
 }catch(error){pending.error={message:String(error.message||error).slice(0,1500),at:new Date().toISOString()};await driver.save(state);await sample(pending.phase+':FAILED');throw error;}
}
