import {MATERIAL_USAGE_EVENT,MATERIAL_USAGE_SOURCE,validateMaterialUsageLedger,usageHash} from './material-usage-model.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
const list=value=>Array.isArray(value)?value:[];
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};

export async function materialUsageMediaCurrent(tx,source){
 const media=await tx.getMedia(source.familyId,source.versionId);
 if(!media||media.sha256!==source.sha256||media.availability!=='PRESENT'||!['FORMAL','IMPORTED_EVIDENCE'].includes(media.metadata?.authorityDomain)||!['PUBLIC',undefined].includes(media.metadata?.visibility)||media.metadata?.sourceRole==='ORIGINAL_SOURCE'||(await mediaRetirementOverlay(tx,media)).state!=='ACTIVE')return false;
 const resolved=await tx.resolveMedia(source.path,{versionId:source.versionId,sha256:source.sha256});
 if(!resolved||resolved.mediaId!==source.familyId||resolved.versionId!==source.versionId||resolved.sha256!==source.sha256||resolved.relativePath!==media.relativePath||resolved.byteSize!==media.byteSize)return false;
 return !source.media||usageHash({mediaId:media.mediaId,versionId:media.versionId,sha256:media.sha256,relativePath:media.relativePath,byteSize:media.byteSize})===usageHash(source.media);
}
async function loadMaterialUsageOnly(tx,model,{view}={}){
 view ||= await tx.readView();
 if(Object.hasOwn(model,'materialUsageLedger')&&!Array.isArray(model.materialUsageLedger))fail('用途ledger必须为数组');
 const events=await tx.listEvents(),refs=list(model.materialUsageLedger);
 if(!refs.length&&!events.some(e=>e.eventKind===MATERIAL_USAGE_EVENT||e.subjectType==='MATERIAL_USAGE'||Object.hasOwn(e,'usageRevisionId'))){
  const published=await tx.listPublishedDocumentMetadata();
  if(!published.some(d=>d.metadata?.sourceRole===MATERIAL_USAGE_SOURCE||(d.aliases||[]).some(a=>a.startsWith('story/material-usages/')))){if(Object.hasOwn(model,'materialUsageEvidence')){const clean={...model};delete clean.materialUsageEvidence;return clean;}return model;}
 }
 const documents=[];
 // Read every published usage source, not only referenced ones: a lost ledger
 // reference or event must fail instead of silently disappearing from coverage.
 for(const id of view.sourceRevisionIds||[]){const doc=await tx.readDocumentRevision(id);if(doc&&(doc.metadata?.sourceRole===MATERIAL_USAGE_SOURCE||(doc.aliases||[]).some(a=>a.startsWith('story/material-usages/'))))documents.push(doc);}
 const rows=validateMaterialUsageLedger({snapshot:{productionModel:model},documents,events});
 for(const row of rows)row.mediaCurrent=await materialUsageMediaCurrent(tx,row.body.basis.source);
 return {...model,materialUsageEvidence:rows};
}
/** Rebuild only the new ledger. Existing assets, recipes and reviews are untouched. */
export function preserveMaterialUsageProjection({snapshot,recipes,baseSnapshot,documents,events}){
 const rows=validateMaterialUsageLedger({snapshot:baseSnapshot,documents,events});
 if(!rows.length)return {snapshot,recipes};
 if(Object.hasOwn(snapshot.productionModel||{},'materialUsageLedger')&&!Array.isArray(snapshot.productionModel.materialUsageLedger))fail('编译用途ledger必须为数组');
 const current=list(snapshot.productionModel?.materialUsageLedger),expected=rows.map(r=>r.ref);
 if(current.length&&usageHash(current)!==usageHash(expected))fail('编译结果不能改写既有用途ledger');
 snapshot.productionModel.materialUsageLedger=structuredClone(expected);
 delete snapshot.productionModel.materialUsageEvidence;
 validateMaterialUsageLedger({snapshot,documents,events});
 return {snapshot,recipes};
}

export async function loadMaterialUsageEvidence(tx,model,options={}){
 const result=await loadMaterialUsageOnly(tx,model,options);
 const {loadAssetContextRevalidationEvidence}=await import('./asset-context-revalidation-preservation.mjs');
 return loadAssetContextRevalidationEvidence(tx,result,options);
}
