import {check} from '../shared/contracts.mjs';
import {validateMaterialUsageScopeContent,validateMaterialUsageScopeTargets} from './usage-scopes.mjs';
import {validateSoundOwnershipContent,validateSoundOwnershipTargets,soundOwnershipDependencies} from '../settings/sound-ownership.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Business references are identities; filenames never supply a missing binding. */
export function validateReferenceContent(kind, content) {
  if(kind==='NOTE')validateMaterialUsageScopeContent(content);
  if(kind==='NOTE'&&content.role==='SOUND_OWNERSHIP')validateSoundOwnershipContent(content);
  if(['SPACE','NOTE'].includes(kind)&&content.role==='SPATIAL_VIEW'){
    check(content.sceneId&&content.viewId&&['DRAFT','PUBLISHED'].includes(content.status),'SPATIAL_REFERENCE','局部空间必须绑定永久场与视图身份');
    if(content.status==='PUBLISHED')check(content.view?.sceneBinding?.sceneId===content.sceneId&&content.view.viewId===content.viewId&&content.view.base?.id&&content.view.base.revisionId&&sha(content.view.base.sha256),'SPATIAL_REFERENCE','已发布空间缺少精确正文与空间规格');
  }
  if(kind==='NOTE'&&content.role==='MATERIAL_OCCURRENCE'){
    check(content.sceneId&&content.reference?.requirementId&&content.reference?.sourceSceneRevisionId&&content.reference?.requirementRevisionId,
      'OCCURRENCE_REFERENCE','素材使用位置必须绑定永久场、需求和各自修订');
    check(sha(content.sceneContentHash)&&sha(content.reference.requirementHash),'OCCURRENCE_REFERENCE','使用位置缺少正文与需求校验');
  }
  if (!['CALL', 'PROMPT', 'REQUIREMENT', 'ASSET', 'EXPECTED_OUTPUT'].includes(kind)) return;
  for (const value of [content.path, content.targetPath, content.plannedOutputPath, content.output?.path])
    check(!value, 'PATH_REFERENCE', '请使用素材版本或预期产物身份，不使用目录或文件路径');
  check(content.sourceBindings===undefined || Array.isArray(content.sourceBindings)&&content.sourceBindings.length<=1000,'SOURCE_REFERENCE','来源引用必须是有界列表');
  if (kind === 'CALL') {
    check(Array.isArray(content.inputBindings||content.upload?.items||[])&&(content.inputBindings||content.upload?.items||[]).length<=24,'INPUT_REFERENCE','参考附件必须是不超过 24 项的列表');
    for (const input of content.inputBindings || content.upload?.items || []) {
      check(!input.path, 'PATH_REFERENCE', '参考附件必须绑定已登记的媒体版本');
      check((input.versionId || input.assetVersionRef) && (input.familyId || input.assetFamilyRef) && sha(input.sha256),
        'INPUT_REFERENCE', '参考附件缺少素材族、版本或 SHA');
    }
  }
  for (const source of content.sourceBindings || [])
    check(source.objectId && source.revisionId, 'SOURCE_REFERENCE', '来源必须绑定对象和修订');
}

export async function validateReferenceTargets(tx, kind, content, previous, options={}) {
  if(kind==='NOTE')await validateMaterialUsageScopeTargets(tx,content,previous,options);
  if(kind==='NOTE')await validateSoundOwnershipTargets(tx,content,previous,options);
  if(['SPACE','NOTE'].includes(kind)&&content.role==='SPATIAL_VIEW'){
    check(!previous||previous.role!=='SPATIAL_VIEW'||previous.sceneId===content.sceneId&&previous.viewId===content.viewId,'SPATIAL_IDENTITY','局部视图不能换绑永久场或视图身份',409);
    const scene=(await tx.query('SELECT kind FROM objects WHERE id=$1',[content.sceneId])).rows[0];
    check(scene?.kind==='SCENE','SPATIAL_REFERENCE','局部空间所属场不存在',409);
    if(content.status==='PUBLISHED'){
      const view=content.view;
      const sceneRevision=(await tx.query('SELECT sha256 FROM revisions WHERE object_id=$1 AND id=$2',[content.sceneId,view.sceneBinding.sceneRevisionId])).rows[0];
      const source=(await tx.query('SELECT s.original_sha256 FROM revisions r JOIN source_documents s ON s.revision_id=r.id WHERE r.object_id=$1 AND r.id=$2',[view.base.id,view.base.revisionId])).rows[0];
      check(sceneRevision?.sha256===view.sceneBinding.sceneContentHash&&source?.original_sha256===view.base.sha256,'SPATIAL_REFERENCE','空间引用的正文或规格修订校验不一致',409);
    }
  }
  if(kind==='NOTE'&&content.role==='MATERIAL_OCCURRENCE'){
    for(const [id,revisionId,targetKind,expected]of [[content.sceneId,content.reference.sourceSceneRevisionId,'SCENE',content.sceneContentHash],[content.reference.requirementId,content.reference.requirementRevisionId,'REQUIREMENT',content.reference.requirementHash]]){
      const row=(await tx.query('SELECT o.kind,r.sha256,r.content FROM objects o JOIN revisions r ON r.object_id=o.id WHERE o.id=$1 AND r.id=$2',[id,revisionId])).rows[0];
      check(row?.kind===targetKind&&(row.content[targetKind==='SCENE'?'contentHash':'requirementHash']||row.sha256)===expected,'OCCURRENCE_REFERENCE','使用位置的对象、修订与内容校验不一致',409);
    }
  }
  if (!['CALL', 'PROMPT', 'REQUIREMENT', 'ASSET', 'EXPECTED_OUTPUT'].includes(kind)) return;
  for (const source of content.sourceBindings || []) {
    const row = (await tx.query('SELECT sha256 FROM revisions WHERE object_id=$1 AND id=$2', [source.objectId, source.revisionId])).rows[0];
    check(row && (!source.sha256 || source.sha256 === row.sha256), 'SOURCE_REFERENCE', '来源身份、修订或内容校验不一致', 409);
  }
  if (kind !== 'CALL') return;
  const inputs = content.inputBindings || content.upload?.items || [];
  const orders = new Set();
  for (const [index, input] of inputs.entries()) {
    const order = input.order ?? index + 1;
    check(Number.isSafeInteger(order) && order > 0 && !orders.has(order), 'INPUT_ORDER', '参考附件顺序必须唯一且为正整数');
    orders.add(order);
    const row = (await tx.query(`SELECT am.sha256,r.id FROM asset_versions a JOIN objects o ON o.id=a.object_id
      JOIN revisions r ON r.object_id=o.id AND r.id=COALESCE($3,o.adopted_revision_id,o.draft_revision_id)
      JOIN asset_media am ON am.revision_id=r.id AND am.role='OUTPUT'
      WHERE a.family_id=$1 AND a.object_id=$2 AND am.sha256=$4`,
    [input.familyId || input.assetFamilyRef, input.versionId || input.assetVersionRef, input.revisionId || null, input.sha256])).rows;
    check(row.length === 1, 'INPUT_REFERENCE', '参考附件不属于所选素材族或媒体版本不一致', 409);
  }
}

export async function normalizeReferenceInputs(tx,kind,content){
  if(kind!=='CALL')return content;
  const inputBindings=[];
  for(const [index,i]of (content.inputBindings||content.upload?.items||[]).entries()){
    const versionId=i.versionId||i.assetVersionRef;
    const revisionId=i.revisionId||(await tx.query('SELECT COALESCE(adopted_revision_id,draft_revision_id) AS id FROM objects WHERE id=$1',[versionId])).rows[0]?.id;
    inputBindings.push({order:i.order??index+1,familyId:i.familyId||i.assetFamilyRef,versionId,revisionId,sha256:i.sha256,...(i.requirementId?{requirementId:i.requirementId}:{}),...(i.slot?{slot:i.slot}:{}),...(i.workItemId?{workItemId:i.workItemId}:{})});
  }
  const result={...content,inputBindings};delete result.upload;return result;
}

export async function referenceDependencies(tx,kind,content){
  if(kind==='NOTE'&&content.role==='SOUND_OWNERSHIP')return soundOwnershipDependencies(content);
  if(['SPACE','NOTE'].includes(kind)&&content.role==='SPATIAL_VIEW'&&content.status==='PUBLISHED')return [{revisionId:content.view.sceneBinding.sceneRevisionId,purpose:'CONTENT'},{revisionId:content.view.base.revisionId,purpose:'DESIGN'}];
  if(kind==='NOTE'&&content.role==='MATERIAL_OCCURRENCE')return [
    {revisionId:content.reference.sourceSceneRevisionId,purpose:'CONTENT'},
    {revisionId:content.reference.requirementRevisionId,purpose:'DEFINITION'}];
  if(!['CALL','PROMPT','REQUIREMENT','ASSET','EXPECTED_OUTPUT'].includes(kind))return [];
  const result=(content.sourceBindings||[]).map(s=>({revisionId:s.revisionId,purpose:'SOURCE'}));
  if(kind==='CALL')for(const input of content.inputBindings||content.upload?.items||[]){
    const row=(await tx.query('SELECT COALESCE($2,adopted_revision_id,draft_revision_id) AS id FROM objects WHERE id=$1',[input.versionId||input.assetVersionRef,input.revisionId||null])).rows[0];
    if(row)result.push({revisionId:row.id,purpose:'ACTUAL_INPUT'});
  }
  return result;
}
