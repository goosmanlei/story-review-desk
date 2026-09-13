import {check} from '../shared/contracts.mjs';
export const MATERIAL_OVERALL='MATERIAL_OVERALL_V1';
export function validateOverallInput(value,{action=value.action,findings=value.criterionFindings,note=value.note}={}){
 check(value.reviewMode===MATERIAL_OVERALL,'MATERIAL_OVERALL_REQUIRED','素材请使用整体审阅');
 check(['APPROVE_AND_RELEASE','REQUEST_REVISION','ADOPT','REQUEST_CHANGES'].includes(action),'MATERIAL_REVIEW_ACTION','素材整体审阅仅支持通过并采用或要求修改');
 check(findings===undefined||Array.isArray(findings)&&findings.length===0,'MATERIAL_OVERALL_FINDINGS','整体审阅不接收分项判断');
 check(value.revisionInstructions===undefined||value.revisionInstructions===null,'MATERIAL_OVERALL_FIELDS','整体审阅仅接收一栏审阅说明');
 check(typeof note==='string','REVIEW_NOTE','请提供整体审阅说明文本');
 check(!['REQUEST_REVISION','REQUEST_CHANGES'].includes(action)||note.trim().length>0,'REVIEW_NOTE_REQUIRED','要求修改时请填写整体审阅说明');
}
export async function validateOverallCommand(tx,object,revision,command){
 validateOverallInput(command,{action:command.decision,findings:command.findings,note:command.note});
 if(object.kind==='ASSET'){
  const basis=command.reviewBasis;
  check(basis,'MATERIAL_REVIEW_BASIS','整体审阅须绑定精确素材需求');
  const requirement=(await tx.query('SELECT kind FROM objects WHERE id=$1',[basis.id])).rows[0];
  check(requirement?.kind==='REQUIREMENT','MATERIAL_REVIEW_SCOPE','整体审阅不适用于制作成果或故事审阅');
  const media=(await tx.query("SELECT sha256 FROM asset_media WHERE revision_id=$1 AND role='OUTPUT'",[command.revisionId])).rows;
  check(media.length===1&&command.reviewMetadata?.versionId===object.id&&command.reviewMetadata?.versionSha256===media[0].sha256,'ASSET_MEDIA_CONFLICT','整体审阅须绑定所见版本与实际媒体SHA',409);
  const {materialReviewFocus}=await import('./review-focus.mjs'),{PresentationRead}=await import('../presentation/read-unit.mjs');const focus=await materialReviewFocus(new PresentationRead(tx),{requirementId:basis.id,versionId:object.id});check(!focus.historical&&command.businessContextHash===focus.contextHash,'MATERIAL_REVIEW_CONTEXT_STALE','素材业务依据已改变',409);command.businessContext={hash:focus.contextHash,sources:focus.sources};
 }else{
  const mode=({MATERIAL_USAGE_REVIEW:'usage',ASSET_CONTEXT_REVALIDATION:'context'})[revision.content.role];
  check(object.kind==='NOTE'&&mode,'MATERIAL_REVIEW_SCOPE','整体审阅仅用于素材版本、素材用途或原图关系复核');
  const {validateOverallNote}=await import('./usage-reviews.mjs');await validateOverallNote(tx,mode,revision.content,command);
 }
}
