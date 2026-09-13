import {hash} from '../shared/contracts.mjs';
import {validateReferenceContent,validateReferenceTargets} from '../materials/references.mjs';

/** Current business graph audit. No filesystem aliases or execution archives are consulted. */
export async function businessIntegrity(tx,{limit=100}={}) {
 const issues=[];let total=0;
 const report=(objectId,code,message)=>{total++;if(issues.length<limit)issues.push({objectId,code,message});};
 const rows=(await tx.query(`SELECT o.id,o.kind,o.state,o.adopted_revision_id,r.id AS revision_id,r.content,r.sha256
  FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id) WHERE NOT o.historical ORDER BY o.id`)).rows;
 const objects=new Map((await tx.query('SELECT id,kind FROM objects')).rows.map(r=>[r.id,r.kind]));
 for(const row of rows){
  if(hash(row.content)!==row.sha256)report(row.id,'CONTENT_HASH','正文与修订 SHA 不一致');
  try{validateReferenceContent(row.kind,row.content);await validateReferenceTargets(tx,row.kind,row.content);}catch(e){report(row.id,e.code||'REFERENCE',e.message);}
  if(row.kind==='CALL'){
   for(const [key,kind]of [['assetFamilyRef','MATERIAL'],['assetVersionRef','ASSET'],['expectedOutputRef','EXPECTED_OUTPUT']]){
    const id=row.content.output?.[key];if(id&&objects.get(id)!==kind)report(row.id,'OUTPUT_REFERENCE','预期产物关联不存在或类型不符');
   }
   if(row.content.promptId&&objects.get(row.content.promptId)!=='PROMPT')report(row.id,'PROMPT_REFERENCE','提示词对象不存在');
  }
  if(row.kind==='NOTE'&&row.content.role==='MATERIAL_PRODUCTION'){
   if(objects.get(row.content.requirementId)!=='REQUIREMENT')report(row.id,'REQUIREMENT_REFERENCE','制作设置缺少素材需求');
   if(row.content.currentCallId&&objects.get(row.content.currentCallId)!=='CALL')report(row.id,'CALL_REFERENCE','制作设置引用的调用定义不存在');
  }
 }
 for(const row of (await tx.query(`SELECT f.object_id AS id FROM material_families f JOIN objects a ON a.id=f.adopted_asset_id
  WHERE a.state<>'ADOPTED' OR a.adopted_revision_id IS NULL`)).rows)report(row.id,'ADOPTED_HEAD','素材族采用指针与版本状态不一致');
 for(const row of (await tx.query(`SELECT a.object_id AS id FROM asset_versions a JOIN asset_versions p ON p.object_id=a.parent_asset_id WHERE a.family_id<>p.family_id`)).rows)report(row.id,'PARENT_FAMILY','父版本属于另一素材族');
 for(const row of (await tx.query(`SELECT o.id FROM objects o JOIN revisions r ON r.id=COALESCE(o.draft_revision_id,o.adopted_revision_id)
  JOIN source_documents s ON s.revision_id=r.id WHERE r.content->>'role'='SPATIAL_SPECIFICATION'`)).rows.slice(1))report(row.id,'SPATIAL_AMBIGUOUS','多个空间规格同时生效');
 return {status:total?'REQUIRES_ATTENTION':'VERIFIED',checkedObjects:rows.length,issueCount:total,issues,truncated:total>issues.length};
}
