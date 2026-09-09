import {sha256} from './bytes.mjs';
import {cancellationMarker,validateUnstartedCancellationEvents} from './execution-cancellation.mjs';
const parse=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{code:'EXECUTION_CANCELLATION_ARCHIVE'});};
/** Read every original row; retain compact release descriptors and only the
 * execution history needed to prove a cancellation. No snapshot body cache. */
export function createExecutionCancellationArchiveValidator(){
 const events=[],releases=[],profiles=new Map();let instanceId;
 return {accept(table,row,parsedSnapshot){
  if(table==='repository_meta')instanceId=row.instance_id;
  if(table==='domain_events'){
   const e=parse(row.event_bytes);if(e.eventKind==='execution-request'||cancellationMarker(e))events.push(e);
   else if(['run','asset-version'].includes(e.eventKind))events.push(Object.fromEntries(['eventId','eventKind','eventSequence','executionRequestId','workItemId','familyId','executionDefinitionId'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])));
  }
  if(table==='record_revisions'&&row.namespace==='settings'&&row.record_key==='instance-profile'){check(sha256(row.content_bytes)===row.content_sha256,'取消历史profile SHA错误');profiles.set(row.revision_id,parse(row.content_bytes).instanceId);}
  if(table==='releases'){
   const snapshot=parsedSnapshot||parse(row.snapshot_bytes),recipes=parse(row.recipes_bytes);check(sha256(row.snapshot_bytes)===row.snapshot_sha256&&sha256(row.recipes_bytes)===row.recipes_sha256,'取消历史发布SHA错误');
   releases.push({releaseId:row.release_id,snapshotId:snapshot.snapshotId,snapshotSha256:row.snapshot_sha256,recipesSha256:row.recipes_sha256,profileRevisionId:row.profile_revision_id,sourceRevisionIds:JSON.parse(row.source_revision_ids_json),createdAt:row.created_at,instanceIds:[snapshot.instance?.instanceId,snapshot.productionModel?.instance?.instanceId].filter(id=>id!==undefined),recipeSnapshotId:recipes.snapshotId});
  }
 },finish(){
  if(!events.some(cancellationMarker))return;
  validateUnstartedCancellationEvents({events,instanceId,releaseContext(event){
   const candidates=releases.filter(r=>r.createdAt<=event.recordedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),latest=candidates[0];
   check(latest&&latest.createdAt<event.recordedAt&&!candidates.some((r,i)=>i&&r.createdAt===latest.createdAt),'取消并非唯一最新先前实际发布');
   check(profiles.get(latest.profileRevisionId)===instanceId&&latest.instanceIds.every(id=>id===instanceId)&&latest.recipeSnapshotId===latest.snapshotId,'取消实际发布实例或配方身份不符');return latest;
  }});
 }};
}
