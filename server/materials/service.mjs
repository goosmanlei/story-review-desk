import {check,identifier} from '../shared/contracts.mjs';
export const kinds=['REQUIREMENT','MATERIAL','ASSET','PROMPT','CALL','EXPECTED_OUTPUT'];
export function validate(kind,content){
  if(kind==='REQUIREMENT')check(typeof content.description==='string'||Array.isArray(content.acceptanceCriteria),'REQUIREMENT_DESCRIPTION','请填写需求说明或验收要点');
  if(content.rightsFact!==undefined)check(['UNKNOWN','CLEAR','BLOCKED'].includes(content.rightsFact),'RIGHTS_INVALID','权利事实无效');
}
export async function projectLinks(tx,object,revisionId,links){
  if(object.kind==='MATERIAL')await tx.query('INSERT INTO material_families(object_id) VALUES($1) ON CONFLICT DO NOTHING',[object.id]);
  if(object.kind==='ASSET'){
    const family=links.filter(x=>x.role==='FAMILY');check(family.length===1,'ASSET_FAMILY_REQUIRED','实际素材版本必须绑定一个素材族');
    const existing=(await tx.query('SELECT family_id FROM asset_versions WHERE object_id=$1',[object.id])).rows[0];
    check(!existing||existing.family_id===family[0].id,'ASSET_FAMILY_IMMUTABLE','素材版本不能换绑素材族');
    await tx.query('INSERT INTO asset_versions(object_id,family_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[object.id,family[0].id]);
  }
}
export async function verifyAdoption(tx,object,revisionId,review){
  if(object.kind!=='ASSET')return;
  const media=(await tx.query("SELECT m.* FROM asset_media a JOIN media m ON m.id=a.media_id AND m.version_id=a.media_version_id WHERE a.revision_id=$1 AND a.role='OUTPUT'",[revisionId])).rows;
  check(media.length>0&&media.every(x=>x.availability==='PRESENT'),'MEDIA_UNAVAILABLE','缺失或已退役素材不能采用',409);
  const rights=(await tx.query('SELECT * FROM rights WHERE revision_id=$1',[revisionId])).rows[0];
  check(rights?.fact!=='BLOCKED','RIGHTS_BLOCKED','权利阻断不能豁免',409);
  check(rights?.fact==='CLEAR'||rights?.internal_attestation||review.internalAttestation===true,'RIGHTS_UNKNOWN','权利未知；项目内部使用须由用户在本次判断中明确确认',409);
  if(review.internalAttestation===true){
    await tx.query('INSERT INTO rights_events(id,revision_id,fact,internal_attestation,evidence,author,operation_id) VALUES($1,$2,$3,true,$4,$5,$6)',[identifier('rights'),revisionId,rights?.fact||'UNKNOWN',{note:review.note,scope:'PROJECT_INTERNAL_ONLY'},review.actor?.label||'用户',review.operationId||'explicit-review']);
    await tx.query("INSERT INTO rights(revision_id,fact,internal_attestation) VALUES($1,'UNKNOWN',true) ON CONFLICT(revision_id) DO UPDATE SET internal_attestation=true",[revisionId]);
  }
}
export async function afterAdoption(tx,object){
  if(object.kind!=='ASSET')return;
  const binding=(await tx.query('SELECT family_id FROM asset_versions WHERE object_id=$1',[object.id])).rows[0];
  check(binding,'ASSET_FAMILY_REQUIRED','素材族绑定缺失',409);
  await tx.query('UPDATE material_families SET adopted_asset_id=$1 WHERE object_id=$2',[object.id,binding.family_id]);
}
