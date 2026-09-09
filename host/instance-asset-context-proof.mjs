import {sha256} from './instance-runtime/bytes.mjs';
import {ASSET_CONTEXT_SOURCE,contextCheck,contextHash,assertAssetContextSource,validateAssetContextLedger} from './instance-runtime/asset-context-revalidation-model.mjs';
const marker=d=>d.metadata?.sourceRole===ASSET_CONTEXT_SOURCE||(d.aliases||[]).some(a=>a.startsWith('story/asset-context-revalidations/'));
export function encodeAssetContextDocuments(documents){
 const context=(documents||[]).filter(marker),producerIds=new Set();
 for(const doc of context){contextCheck(doc.metadata?.sourceRole===ASSET_CONTEXT_SOURCE,'关系复核源角色错误');const body=assertAssetContextSource(JSON.parse(doc.bytes));producerIds.add(body.basis.legacyAdoptionProof.producerSource.sourceRevisionId);}
 let total=0;const selected=(documents||[]).filter(d=>marker(d)||producerIds.has(d.revisionId));
 for(const id of producerIds)contextCheck(selected.filter(d=>d.revisionId===id).length===1,'关系复核producer固定来源缺失');
 return selected.map(d=>{const bytes=Buffer.from(d.bytes);total+=bytes.length;contextCheck(total<=64*1024*1024&&sha256(bytes)===d.sha256,'关系复核源传输SHA或容量错误');return{documentId:d.documentId||d.key,revisionId:d.revisionId,sha256:d.sha256,aliases:d.aliases,metadata:d.metadata,deleted:Boolean(d.deleted),bytes:{encoding:'BASE64',data:bytes.toString('base64')}};});
}
export function decodeAssetContextDocuments(rows){
 contextCheck(Array.isArray(rows),'关系复核源传输不是数组');let total=0;
 return rows.map(d=>{contextCheck(d?.bytes?.encoding==='BASE64'&&typeof d.bytes.data==='string','关系复核源编码错误');const bytes=Buffer.from(d.bytes.data,'base64');total+=bytes.length;contextCheck(total<=64*1024*1024&&bytes.toString('base64')===d.bytes.data&&sha256(bytes)===d.sha256,'关系复核源原字节SHA错误');return{...d,bytes};});
}
export const assetContextDocumentsHash=contextHash;
/** Public projection does not acquire historical private snapshots. Its exact
 * source/event envelopes remain reviewable, but absence of full publication
 * proof cannot restore a version's downstream eligibility. */
export function validateHostedAssetContexts(snapshot,bundle){
 const model=snapshot.productionModel||{},documents=decodeAssetContextDocuments(model.assetContextRevalidationSources||[]),events=Object.values(bundle?.events||bundle||{}).flat(),proof=model.assetContextRevalidationHostedProof;
 const refs=model.assetContextRevalidationLedger;
 if(!documents.length&&!events.some(e=>e.eventKind==='asset-context-revalidation'||e.subjectType==='ASSET_CONTEXT')&&refs===undefined){contextCheck(!model.assetContextRevalidationEvidence?.length,'只读关系复核有孤儿投影');return[];}
 contextCheck(proof?.schemaVersion==='ASSET_CONTEXT_HOSTED_ENVELOPES_V1'&&proof.effectAvailable===false&&Array.isArray(proof.eventManifests),'只读关系复核不得声明具备完整历史采用证明');
 const rows=validateAssetContextLedger({snapshot,documents,events,eventManifest:event=>{const matches=proof.eventManifests.filter(p=>p.eventId===event.eventId);contextCheck(matches.length===1,'只读复核事件闭包缺失');return matches[0].manifest;},validatePublication:()=>true});
 for(const row of model.assetContextRevalidationEvidence||[])contextCheck(row.mediaCurrent===false,'只读关系复核不能在缺完整历史发布证据时恢复采用效力');
 contextCheck((model.assetContextRevalidationEvidence||[]).length===rows.length,'只读复核来源/投影数量不符');
 for(const row of rows){const projected=model.assetContextRevalidationEvidence.filter(r=>r.ref?.id===row.ref.id);contextCheck(projected.length===1&&contextHash({ref:projected[0].ref,body:projected[0].body,event:projected[0].event})===contextHash(row),'只读复核原始来源/事件投影不符');}
 return rows;
}
