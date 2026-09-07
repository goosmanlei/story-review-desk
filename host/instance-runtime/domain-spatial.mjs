import {sha256} from './bytes.mjs';
export const spatialLogicalPath='data/production_map_spec.json';
/** One whitelisted published story source; never fall back to legacy physical files. */
export async function readSpatialSettings(tx,view) {
  const document=await tx.getPublishedDocument(spatialLogicalPath);
  if(!document)return {status:'NOT_CONFIGURED',snapshotId:view.snapshot.snapshotId,sourceBinding:null,specification:null};
  if(!view.sourceRevisionIds.includes(document.revisionId)||sha256(document.bytes)!==document.sha256)throw new Error('空间资料与已发布来源绑定不一致');
  const sourceText=Buffer.from(document.bytes).toString('utf8');
  return {status:'AVAILABLE',snapshotId:view.snapshot.snapshotId,sourceBinding:{documentId:document.documentId,revisionId:document.revisionId,sha256:document.sha256,logicalPath:spatialLogicalPath},sourceText,specification:JSON.parse(sourceText)};
}
