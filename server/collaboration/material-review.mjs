import {check,hash,identity} from '../shared/contracts.mjs';
import {transaction} from '../db.mjs';
import {PresentationRead,idsFor} from '../presentation/read-unit.mjs';
import {assets,materialRows,assetReviewContextHash} from '../presentation/materials.mjs';
import {assistantContext,assertSourceVersions} from './assistant-context.mjs';

async function contextFor(tx,input){
  const unit=new PresentationRead(tx),profile=await unit.profile();
  check(input.snapshotId===await unit.namespace(),'CONTEXT_INSTANCE','素材建议不属于当前运行期',409);
  const requirement=await unit.detail(input.requirementId),asset=await unit.detail(input.versionId);
  check(requirement.kind==='REQUIREMENT'&&asset.kind==='ASSET'&&idsFor(requirement,'FAMILY').includes(input.familyId)&&idsFor(asset,'FAMILY').includes(input.familyId),'MATERIAL_BINDING','需求、素材族和实际版本不一致',409);
  const media=await assets(unit,[input.familyId]),version=media.assetVersions.find(v=>v.id===input.versionId),requirements=await materialRows(unit);
  check(version?.sha256===input.versionSha256&&version.outputState==='PRESENT','MATERIAL_MEDIA','原件不存在、已退役或 SHA 改变',409);
  const spec=requirement.revision.content.reviewSpec;
  check(spec?.criteria?.length&&input.reviewSpecHash===(spec.hash||hash(spec))&&input.contextHash===assetReviewContextHash(version,requirements),'CONTEXT_STALE','素材需求或审阅依据已改变',409);
  const context=await assistantContext(tx,{focus:{projectId:profile.projectId,snapshotId:await unit.namespace(),subjectType:'MATERIAL',subjectId:requirement.id,versionId:asset.id},draftTargets:[]});
  return {context,spec,mediaKind:version.mediaKind};
}
export async function prepareMaterialReview(pool,input,{operationId,runtimeEpoch}){
  identity(operationId);const clientHash=hash({input,runtimeEpoch});
  return transaction(pool,async tx=>{
    const prior=(await tx.query('SELECT request FROM operations WHERE id=$1',[operationId])).rows[0];
    if(prior){check(prior.request.materialReview?.clientHash===clientHash,'OPERATION_ID_CONFLICT','同一操作编号不能用于不同素材建议',409);return prior.request;}
    const active=(await tx.query("SELECT id,status FROM operations WHERE request#>>'{materialReview,clientHash}'=$1 AND status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') LIMIT 1",[clientHash])).rows[0];
    check(!active,'MATERIAL_REVIEW_PENDING','相同建议请求尚待核查：'+(active?.id||''),409,active);
    const value=await contextFor(tx,input);
    return {kind:'AI_SUGGEST',operationId,runtimeEpoch,objectId:value.context.objectId,expectedVersion:value.context.objectVersion,revisionId:value.context.objectRevisionId,materialReview:{clientHash,input,...value},prompt:'请为当前精确素材版本生成审阅参考意见。先使用 read_image 读取原图；不能凭路径、Prompt 或元数据声称观察。无法观察的条目填写 UNKNOWN，不作正式采用判断。summary 用中文概括；patch 只包含 materialReview 字段，字段内容为 '+JSON.stringify({summary:'参考摘要',criterionFindings:value.spec.criteria.map(c=>({criterionId:c.id,verdict:'UNKNOWN',note:c.question||c.label})),qualityRecommendation:'INSUFFICIENT_EVIDENCE',overallNote:'说明已知与未知',revisionInstructions:null,observations:[],unobserved:[]})+'。draftSuggestions 为空。'};
  },{readOnly:true});
}
export async function validateMaterialReview(tx,request){
  const meta=request.materialReview;if(!meta)return;
  const active=(await tx.query("SELECT id FROM operations WHERE request#>>'{materialReview,clientHash}'=$1 AND id<>$2 AND status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') LIMIT 1",[meta.clientHash,request.operationId])).rows[0];
  check(!active,'MATERIAL_REVIEW_PENDING','已有相同素材建议待核查：'+(active?.id||''),409);
  const current=await contextFor(tx,meta.input);check(current.context.packetHash===meta.context.packetHash,'CONTEXT_STALE','素材建议依据已改变',409);await assertSourceVersions(tx,meta.context.sourceVersions);
}
export function normalizeMaterialReview(request,value){
  const meta=request.materialReview,raw=value.patch?.materialReview,observed=value.observedImageIds||[],reads=value.sourceVersions||[];
  check(Array.isArray(observed)&&observed.every(id=>reads.some(r=>r.objectId===id&&r.mediaSha256)),'IMAGE_OBSERVATION','原图观察声明缺少实际读取依据');
  check(raw&&typeof raw.summary==='string'&&typeof raw.overallNote==='string'&&Array.isArray(raw.criterionFindings),'MATERIAL_REVIEW_FORMAT','素材建议未返回完整判断结构');
  const exactObserved=meta.mediaKind==='IMAGE'&&observed.includes(meta.input.versionId)&&reads.some(r=>r.objectId===meta.input.versionId&&r.mediaSha256===meta.input.versionSha256);
  const criterionFindings=meta.spec.criteria.map(c=>{const f=raw.criterionFindings.find(f=>f.criterionId===c.id);check(f&&['PASS','FAIL','NA','UNKNOWN'].includes(f.verdict)&&typeof f.note==='string','MATERIAL_REVIEW_FORMAT','素材建议缺少逐项依据');check(f.verdict!=='NA'||c.allowNA,'MATERIAL_REVIEW_FORMAT','此标准不能选择不适用');return {...f,criterionId:c.id,verdict:exactObserved?f.verdict:'UNKNOWN'};});
  const list=value=>Array.isArray(value)?value.filter(v=>typeof v==='string').slice(0,50):[];
  let quality=['QUALITY_PASS_ON_OBSERVED_EVIDENCE','REQUEST_REVISION','DO_NOT_USE','INSUFFICIENT_EVIDENCE'].includes(raw.qualityRecommendation)?raw.qualityRecommendation:'INSUFFICIENT_EVIDENCE';
  if(quality==='QUALITY_PASS_ON_OBSERVED_EVIDENCE'&&criterionFindings.some(f=>!['PASS','NA'].includes(f.verdict)))quality=criterionFindings.some(f=>f.verdict==='FAIL')?'REQUEST_REVISION':'INSUFFICIENT_EVIDENCE';
  const draft={summary:raw.summary,overallNote:raw.overallNote,criterionFindings,qualityRecommendation:exactObserved?quality:'INSUFFICIENT_EVIDENCE',observations:exactObserved?list(raw.observations):[],unobserved:[...list(raw.unobserved),...(!exactObserved?['本轮未读取此版本原图；视觉判断仍为 UNKNOWN。']:[])],revisionInstructions:raw.revisionInstructions?{preserve:list(raw.revisionInstructions.preserve),change:list(raw.revisionInstructions.change),mustNotRegress:list(raw.revisionInstructions.mustNotRegress)}:null};
  value.patch={};value.draftSuggestions=[];value.purpose='MATERIAL_REVIEW';value.materialReview=draft;value.sourceVersions=[...meta.context.sourceVersions,...reads];
}
export async function materialReviewResult(tx,operationId){
  identity(operationId);const row=(await tx.query("SELECT status,request FROM operations WHERE id=$1 AND kind='AI_SUGGEST'",[operationId])).rows[0];
  check(row?.request.materialReview,'MATERIAL_REVIEW_REQUEST','素材建议请求不存在',404);
  check(row.status==='SUCCEEDED','MATERIAL_REVIEW_PENDING','建议尚未完成，请核查原操作',409,{operationId,status:row.status});
  const suggestion=(await tx.query('SELECT content FROM suggestions WHERE operation_id=$1 AND expires_at>now()',[operationId])).rows[0];check(suggestion,'SUGGESTION_EXPIRED','建议超过 10 分钟保留期',410);
  await assertSourceVersions(tx,suggestion.content.sourceVersions);
  return {requestId:operationId,draft:suggestion.content.materialReview,evidenceBoundary:'建议依据所读对象与实际观察范围生成，先预览，再填入审阅草稿。正式判断由用户确认。'};
}
