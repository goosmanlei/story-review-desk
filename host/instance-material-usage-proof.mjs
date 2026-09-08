import {canonicalJson,sha256} from './instance-runtime/bytes.mjs';
import {MATERIAL_USAGE_SOURCE,validateMaterialUsageLedger} from './instance-runtime/material-usage-model.mjs';

const fail=message=>{throw Object.assign(Error(message),{code:'MATERIAL_USAGE_PROOF'});};
const limit=64*1024*1024;
/** Original source bytes travel independently of the parsed UI evidence. */
export function encodeMaterialUsageDocuments(documents){
  let total=0;
  for(const doc of documents||[])if((doc.aliases||[]).some(a=>a.startsWith('story/material-usages/'))&&doc.metadata?.sourceRole!==MATERIAL_USAGE_SOURCE)fail('用途固定源路径不能冒充其他来源角色');
  return (documents||[]).filter(d=>d.metadata?.sourceRole===MATERIAL_USAGE_SOURCE).map(d=>{
    const bytes=Buffer.from(d.bytes);total+=bytes.length;
    if(total>limit||sha256(bytes)!==d.sha256)fail('用途固定源字节或传输容量不符');
    return {documentId:d.documentId||d.key,revisionId:d.revisionId,sha256:d.sha256,aliases:d.aliases,metadata:d.metadata,deleted:Boolean(d.deleted),bytes:{encoding:'BASE64',data:bytes.toString('base64')}};
  });
}
export function decodeMaterialUsageDocuments(rows){
  if(!Array.isArray(rows))fail('用途固定源传输不是数组');
  let total=0;
  return rows.map(row=>{
    if(row?.bytes?.encoding!=='BASE64'||typeof row.bytes.data!=='string')fail('用途固定源传输编码不符');
    const bytes=Buffer.from(row.bytes.data,'base64');total+=bytes.length;
    if(total>limit||bytes.toString('base64')!==row.bytes.data||sha256(bytes)!==row.sha256||row.metadata?.sourceRole!==MATERIAL_USAGE_SOURCE)fail('用途固定源传输 SHA/角色不符');
    return {...row,bytes};
  });
}
export const materialUsageDocumentsHash=rows=>sha256(canonicalJson(rows));
export function validateHostedMaterialUsages(snapshot,events,{mediaBindings}={}){
  const model=snapshot?.productionModel||{},documents=decodeMaterialUsageDocuments(model.materialUsageSources||[]);
  const rows=validateMaterialUsageLedger({snapshot,documents,events:Object.values(events?.events||events||{}).flat()});
  // UI evidence is a convenience projection, never a substitute for fixed bytes.
  if(rows.length){
    const projected=model.materialUsageEvidence;
    if(!Array.isArray(projected)||projected.length!==rows.length)fail('只读用途投影缺少完整来源/事件闭包');
    for(const row of rows){
      const matches=projected.filter(r=>r.ref?.id===row.ref.id);if(matches.length!==1||canonicalJson({ref:matches[0].ref,body:matches[0].body,event:matches[0].event})!==canonicalJson(row))fail('只读用途投影与固定源或事件不一致');
      if(matches[0].mediaCurrent===true&&!(mediaBindings||model.publicExportMediaBindings||[]).some(m=>m.familyId===row.body.basis.source.familyId&&m.versionId===row.body.basis.source.versionId&&m.sha256===row.body.basis.source.sha256))fail('只读用途原件未进入精确公共媒体闭包');
    }
  }else if((model.materialUsageEvidence||[]).length)fail('只读用途投影存在孤儿');
  return rows;
}
