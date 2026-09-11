import {canonicalJson,sha256} from './bytes.mjs';
import {openRepeatableArchive} from './archive-repeatable-stream.mjs';
import {isRestoredRuntime} from './execution-epoch.mjs';

const unknown=new Set(['UNKNOWN','RESULT_UNKNOWN']);
const identity=(namespace,key)=>canonicalJson([namespace,key]);

export async function readCurrentAuxiliaryActivity(tx){
 // This function is serialized into the compatibility inspector below. Keep
 // its dependencies inside the function so bundling/minification is safe.
 const {createHash}=await import('node:crypto');
 const active=new Set(['QUEUED','RUNNING','STARTED','SUBMITTED','RESULT_UNKNOWN','UNKNOWN','CLAIMED','PROCESSING']);
 const rows=await tx.all("SELECT h.namespace,h.record_key,h.revision_id,r.content_bytes,r.content_sha256 FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace LIKE 'aux:%' AND r.deleted=0");
 const records=[];
 for(const row of rows){let value;try{value=JSON.parse(row.content_bytes);}catch{continue;}
  const state=[value.status,value.state,value.runState].find(s=>active.has(s));if(!state)continue;
  const actual=createHash('sha256').update(row.content_bytes).digest('hex');if(actual!==row.content_sha256)throw Error('Auxiliary record SHA differs');
  records.push({namespace:row.namespace,key:row.record_key,revisionId:row.revision_id,sha256:actual,state});
 }
 return {metadata:await tx.getMetadata(),records};
}

// Run the current publisher's read-only inspection inside the existing app.
// An older deployed checker may not distinguish restored history from work
// submitted in this VPS epoch. No credential directory or record is changed.
export const inspectAuxiliaryHistoryScript=String.raw`
import {resolveInstance,openInstanceRepository} from './host/instance-runtime/index.mjs';
import {canonicalJson,sha256} from './host/instance-runtime/bytes.mjs';
import {readFile} from 'node:fs/promises';
const readCurrentAuxiliaryActivity=${readCurrentAuxiliaryActivity.toString()};
const repo=await openInstanceRepository({...resolveInstance('/instance'),readOnly:true});
try{
 const manifest=JSON.parse(await readFile('/instance/runtime/restore-manifest.json','utf8'));
 const proof=JSON.parse(await readFile('/instance/runtime/restore-proof.json','utf8'));
 const result=await repo.readTransaction(readCurrentAuxiliaryActivity);
 console.log(JSON.stringify({...result,restoreProof:proof,restoreManifestHash:sha256(canonicalJson(manifest))}));
}finally{await repo.close();}
`;

/** Read only the owned clean package. Its archive is checked on both passes;
 * retain exact head identities and hashes, never infer history from dates. */
export async function readRestoredAuxiliaryHistory(source){
 const baseline=source.manifest.baseline;
 const reader=await openRepeatableArchive(()=>source.open('baseline/'+baseline.database.path),baseline.database);
 const heads=new Map(),records=new Map();let metadata;
 try{
  if(reader.header.instanceId!==baseline.instanceId)throw Error('Baseline instance differs');
  for(const table of reader.tableNames)for await(const row of reader.iterate(table)){
   if(table==='record_heads'&&row.namespace.startsWith('aux:')){
    if(heads.size>=100000)throw Error('Auxiliary history exceeds verification bound');
    heads.set(identity(row.namespace,row.record_key),row.revision_id);
   }else if(table==='record_revisions'&&row.namespace.startsWith('aux:')&&!row.deleted){
    const key=identity(row.namespace,row.record_key);if(heads.get(key)!==row.revision_id)continue;
    if(row.content_bytes?.encoding!=='base64')throw Error('Invalid archived auxiliary bytes');
    const bytes=Buffer.from(row.content_bytes.bytes,'base64');if(sha256(bytes)!==row.content_sha256)throw Error('Archived auxiliary SHA differs');
    let value;try{value=JSON.parse(bytes);}catch{continue;}
    const state=[value.status,value.state,value.runState].find(s=>unknown.has(s));if(!state)continue;
    records.set(key,{revisionId:row.revision_id,sha256:row.content_sha256,state});
   }else if(table==='repository_meta')metadata=row;
  }
  await reader.assertUnchanged();
  if(metadata?.instance_id!==baseline.instanceId||metadata.current_release_id!==baseline.releaseId||metadata.repository_revision!==baseline.repositoryRevision)throw Error('Baseline metadata differs');
  return {baseline,manifestHash:sha256(canonicalJson(baseline)),sourceRuntimeEpoch:metadata.runtime_epoch,records};
 }finally{await reader.close();}
}

export function classifyRestoredAuxiliaryHistory(check,inspection,history,runtime){
 const {metadata,restoreProof:proof}=inspection;
 if(metadata?.instanceId!==runtime.instanceId||metadata.runtimeEpoch!==runtime.runtimeEpoch||!isRestoredRuntime(metadata.runtimeEpoch)||metadata.runtimeEpoch===history.sourceRuntimeEpoch||check.metadata?.instanceId!==metadata.instanceId||check.metadata.runtimeEpoch!==metadata.runtimeEpoch)throw Error('Restored runtime identity differs');
 if(inspection.restoreManifestHash!==history.manifestHash||proof?.status!=='RESTORED_VERIFIED'||proof.instanceId!==metadata.instanceId||proof.runtimeEpoch!==metadata.runtimeEpoch||proof.releaseId!==history.baseline.releaseId||proof.originalBytesPreserved!==true||proof.businessIdsPreserved!==true||proof.integrity?.ok!==true||proof.streamPasses!==4||proof.scratchArchiveBytes!==0)throw Error('Complete clean restoration proof required');
 if(!Array.isArray(inspection.records))throw Error('Current auxiliary inspection missing');
 // Re-read every active AUX head after the archive scan; a new or changed
 // unknown is still a blocker, including writes occurring during that scan.
 const blockers=check.blockers.filter(b=>!b.namespace.startsWith('aux:'));
 const restoredHistory=[];
 for(const row of inspection.records){
  const previous=history.records.get(identity(row.namespace,row.key));
  if(unknown.has(row.state)&&previous&&previous.revisionId===row.revisionId&&previous.sha256===row.sha256&&previous.state===row.state){
   restoredHistory.push({...row,disposition:'RESTORED_HISTORY_UNCHANGED',externalResult:'STILL_UNKNOWN',executionResumed:false});
  }else blockers.push({namespace:row.namespace,key:row.key,state:row.state});
 }
 return {...check,metadata,blockers,restoredHistory,restoredHistoryBaselineSha256:history.baseline.manifestSha256};
}
