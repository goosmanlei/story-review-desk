/** Current production definitions expose business inputs, never file locations. */
export async function presentRecipe(row, unit) {
  const c=row.revision.content,author=c.authorContent||c;
  const prompt=typeof c.prompt==='object'&&c.prompt?c.prompt:{main:author.prompt||'',negative:author.negativePrompt||''};
  const model=typeof c.model==='object'&&c.model?c.model:{branch:author.model||null};
  const bindings=c.inputBindings||c.upload?.items||[];
  const items=[];
  for(const [index,input] of bindings.entries()) {
    const versionId=input.versionId||input.assetVersionRef,familyId=input.familyId||input.assetFamilyRef;
    const result=(await unit.tx.query(`SELECT o.title,r.id AS revision_id,am.sha256,m.availability FROM objects o
      JOIN asset_versions a ON a.object_id=o.id AND a.family_id=$2
      JOIN revisions r ON r.object_id=o.id AND r.id=COALESCE($3,o.adopted_revision_id,o.draft_revision_id)
      JOIN asset_media am ON am.revision_id=r.id AND am.role='OUTPUT'
      JOIN media m ON m.id=am.media_id AND m.version_id=am.media_version_id
      WHERE o.id=$1 AND ($4::text IS NULL OR am.sha256=$4)`,[versionId,familyId,input.revisionId||null,input.sha256||null])).rows;
    const actual=result.length===1?result[0]:null;
    items.push({order:input.order||index+1,assetFamilyRef:familyId,assetVersionRef:versionId,revisionId:actual?.revision_id||input.revisionId||null,
      sha256:actual?.sha256||input.sha256||null,label:actual?.title||'参考素材待完善',mediaUrl:actual?.availability==='PRESENT'?'/api/v1/media/'+actual.sha256:null,
      bindingState:actual?'BOUND':'UNRESOLVED'});
  }
  const output=c.output||{};
  const family=output.assetFamilyRef?(await unit.tx.query('SELECT title FROM objects WHERE id=$1',[output.assetFamilyRef])).rows[0]:null;
  return {id:row.id,title:row.title,revisionId:row.revision.id,currentRevisionId:row.revision.id,objectVersion:row.version,
    definitionHash:c.definitionHash||row.revision.sha256,referenceSchema:1,
    upload:{items},model:{rawRule:'',resolution:'',...model},prompt:{negativeApplication:'',...prompt},
    output:{mediaType:output.mediaType||'UNKNOWN',assetFamilyRef:output.assetFamilyRef||null,assetVersionRef:output.assetVersionRef||null,
      expectedOutputRef:output.expectedOutputRef||null,label:family?.title||row.title},
    sourceBindings:c.sourceBindings||[],parametersRaw:c.parametersRaw||JSON.stringify(c.parameters||author.parameters||{},null,2),
    declaredGate:c.declaredGate||'INPUT_LOCK_REQUIRED',executorKind:c.executorKind||'MODEL',pipelineStageCode:c.pipelineStageCode||'',
    reviewSpec:c.reviewSpec||null,parentVersionId:c.parentVersionId||null,
    ...(c.materialSettings?{materialProductionPlanId:'material-production:'+row.id}:{})};
}
