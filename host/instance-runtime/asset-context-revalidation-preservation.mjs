import {captureHistoricalEventContexts} from '../instance-historical-event-context.mjs';
import {sha256} from './bytes.mjs';
import {ASSET_CONTEXT_SOURCE,contextCheck,contextHash,validateAssetContextLedger,assetContextCurrentBasis} from './asset-context-revalidation-model.mjs';
import {materialUsageMediaCurrent} from './material-usage-preservation.mjs';
const marker=doc=>doc.metadata?.sourceRole===ASSET_CONTEXT_SOURCE||(doc.aliases||[]).some(a=>a.startsWith('story/asset-context-revalidations/'));
export async function readAssetContextEvidence(tx,model,{view}={}){
 view ||= await tx.readView();if(Object.hasOwn(model,'assetContextRevalidationLedger'))contextCheck(Array.isArray(model.assetContextRevalidationLedger),'复核ledger必须为数组');
 const events=await tx.listEvents(),metadata=await tx.listPublishedDocumentMetadata(),documents=[],releaseMap=new Map();
 for(const meta of metadata.filter(marker)){const doc=await tx.readDocumentRevision(meta.revisionId);contextCheck(doc&&view.sourceRevisionIds.includes(doc.revisionId),'复核来源未当前发布');documents.push(doc);}
 for(const id of view.sourceRevisionIds||[])if(!metadata.some(d=>d.revisionId===id)){const doc=await tx.readDocumentRevision(id);if(doc&&marker(doc))documents.push(doc);}
 const producerIds=new Set();for(const doc of documents){const body=JSON.parse(doc.bytes);producerIds.add(body.basis?.legacyAdoptionProof?.producerSource?.sourceRevisionId);const id=body.baseReleaseId;if(!releaseMap.has(id)){const release=await tx.readRelease(id);contextCheck(release&&sha256(release.snapshotBytes)===release.snapshotSha256&&sha256(release.recipesBytes)===release.recipesSha256,'复核原发布字节校验失败');const snapshot=JSON.parse(release.snapshotBytes),recipes=JSON.parse(release.recipesBytes),profile=await tx.getRecord('settings','instance-profile',release.profileRevisionId);contextCheck(profile&&sha256(profile.bytes)===profile.sha256&&JSON.parse(profile.bytes).instanceId===body.basis.instanceId,'复核原发布profile不可核');releaseMap.set(id,{release,snapshot,recipes});}}
 for(const id of producerIds){contextCheck(typeof id==='string','原producer固定源缺失');if(!documents.some(d=>d.revisionId===id)){const doc=await tx.readDocumentRevision(id);contextCheck(doc,'原producer来源丢失');documents.push(doc);}}
 const contextEvents=events.filter(e=>e.eventKind==='asset-context-revalidation');
 if(contextEvents.length)await captureHistoricalEventContexts(tx,{events:contextEvents,instanceId:(await tx.getMetadata()).instanceId});
 const rows=validateAssetContextLedger({snapshot:{instance:view.snapshot?.instance,productionModel:model},documents,events,releaseContext:(_event,body)=>releaseMap.get(body.baseReleaseId)});
 for(const row of rows)row.mediaCurrent=await materialUsageMediaCurrent(tx,row.body.basis.source);
 return {documents,rows,releaseMap};
}
export async function loadAssetContextRevalidationEvidence(tx,model,{view}={}){const {rows}=await readAssetContextEvidence(tx,model,{view});if(!rows.length&&!Object.hasOwn(model,'assetContextRevalidationEvidence'))return model;const out={...model};delete out.assetContextRevalidationEvidence;if(rows.length)out.assetContextRevalidationEvidence=rows;return out;}
export function preserveAssetContextRevalidations({snapshot,recipes,baseSnapshot,documents,events,releaseContext}){const rows=validateAssetContextLedger({snapshot:baseSnapshot,documents,events,releaseContext});if(!rows.length)return{snapshot,recipes};const refs=rows.map(r=>r.ref);if(Object.hasOwn(snapshot.productionModel,'assetContextRevalidationLedger'))contextCheck(contextHash(snapshot.productionModel.assetContextRevalidationLedger)===contextHash(refs),'编译不能改写复核ledger');snapshot.productionModel.assetContextRevalidationLedger=structuredClone(refs);delete snapshot.productionModel.assetContextRevalidationEvidence;validateAssetContextLedger({snapshot,documents,events,releaseContext});return{snapshot,recipes};}
/** This provides only a root's current-domain proof, never a new adoption or
 * a replacement for rights/source synchronization/current-version checks. */
export function assetContextReviewedBindings(model,versions,{contextHashForVersion}){
 const refs=model.assetContextRevalidationLedger||[],heads=new Map();
 for(const row of model.assetContextRevalidationEvidence||[]){if(!refs.some(ref=>contextHash(ref)===contextHash(row.ref)))continue;const previous=heads.get(row.body.revalidationId);if(!previous||previous.event.eventSequence<row.event.eventSequence)heads.set(row.body.revalidationId,row);}
 const result=new Map();for(const row of heads.values()){
  const source=row.body.basis.source,version=versions.get(source.versionId),family=(model.assetFamilies||[]).find(f=>f.id===source.familyId);
  if(row.mediaCurrent!==true||!version||version.familyId!==source.familyId||version.sha256!==source.sha256||version.path!==source.path||family?.currentVersionId!==source.versionId||version.lifecycleState!=='RELEASED'||version.canFlowDownstream!==true||!['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(version.projectRightsGate)||row.event.action!=='CONFIRM_CURRENT_DOMAIN')continue;
  let current;try{current=assetContextCurrentBasis(model,source);}catch{continue;}
  if(contextHash(current)!==contextHash(row.body.basis.current)||contextHashForVersion(source)!==row.body.basis.contextHash)continue;
  result.set(source.versionId,{familyId:source.familyId,sha256:source.sha256,domainContextHash:current.domainContext.hash,reviewEventId:row.event.eventId,reviewEventSequence:row.event.eventSequence});
 }
 return result;
}
