import {check,hash,identity} from '../shared/contracts.mjs';
import {transaction} from '../db.mjs';
import {PresentationRead} from '../presentation/read-unit.mjs';
import {episodePlan} from '../presentation/story.mjs';
import {commentTargets,sceneReviewContext} from '../presentation/review.mjs';
import {assistantContext,assertSourceVersions} from './assistant-context.mjs';

async function contextFor(tx,input){
  const unit=new PresentationRead(tx),plan=await episodePlan(unit);check(plan,'COMMENT_BASIS','请先选择故事正文',409);
  check(input.snapshotId===await unit.namespace(),'CONTEXT_INSTANCE','评论不属于当前运行期',409);
  const target=(await commentTargets(unit,plan)).find(t=>input.target?t.kind===input.target.kind&&t.subjectId===input.target.subjectId:t.kind==='SCENE_SCRIPT'&&t.subjectId===input.sceneId);
  check(target,'COMMENT_BASIS','评论对象不在当前故事中',409);
  if(input.target)check(input.target.contentHash===target.contentHash&&input.target.contextHash===target.contextHash&&input.target.objectRevisionId===target.objectRevisionId&&input.target.expectedVersion===target.expectedVersion,'CONTEXT_STALE','圈选正文已改变，原评论仍保留',409);
  else {const {context}=await sceneReviewContext(unit,new URLSearchParams({sceneId:input.sceneId}));check(input.sceneContentHash===context.sceneContentHash&&input.businessContextHash===context.contextHash,'CONTEXT_STALE','本场正文或依据已改变',409);}
  const segments=input.anchor?.segments?.length?input.anchor.segments:[input.anchor];
  check(segments.length<=100&&segments.every(s=>s&&typeof s.quote==='string'&&s.quote&&Number.isInteger(s.startOffset)&&Number.isInteger(s.endOffset)&&s.startOffset>=0&&s.endOffset>s.startOffset&&target.blocks.find(b=>b.id===s.blockId)?.text.slice(s.startOffset,s.endOffset)===s.quote),'COMMENT_ANCHOR','圈选文字不能与当前正文精确核对',409);
  check(typeof input.commentDraft==='string'&&input.commentDraft.length<=16000,'COMMENT_TEXT','评论草稿过长或格式无效');
  const profile=await unit.profile();
  const context=await assistantContext(tx,{focus:{projectId:profile.projectId,snapshotId:await unit.namespace(),subjectType:target.kind==='SCENE_SCRIPT'?'SCENE':'EPISODE',subjectId:target.objectId},draftTargets:[]});
  return {context,target};
}
export async function prepareCommentPolish(pool,input,{operationId,runtimeEpoch}) {
  identity(operationId);const clientHash=hash({input,runtimeEpoch});
  return transaction(pool,async tx=>{
    const prior=(await tx.query('SELECT request FROM operations WHERE id=$1',[operationId])).rows[0];
    if(prior){check(prior.request.commentPolish?.clientHash===clientHash,'OPERATION_ID_CONFLICT','同一操作编号不能用于不同评论',409);return prior.request;}
    const active=(await tx.query("SELECT id,status FROM operations WHERE kind='AI_SUGGEST' AND request #>> '{commentPolish,clientHash}'=$1 AND status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') LIMIT 1",[clientHash])).rows[0];
    check(!active,'COMMENT_REQUEST_PENDING','相同评论建议尚未完成；请核查原操作 '+(active?.id||''),409,active);
    const {context,target}=await contextFor(tx,input);
    return {kind:'AI_SUGGEST',operationId,runtimeEpoch,objectId:context.objectId,expectedVersion:context.objectVersion,revisionId:context.objectRevisionId,prompt:'请只改进用户对圈选正文的修改意见，保留用户判断，不替用户裁决或改写正文。summary 只返回可供用户预览的评论建议正文，patch 必须为空对象，draftSuggestions 必须为空数组。\n'+JSON.stringify({commentDraft:input.commentDraft,anchor:input.anchor}),commentPolish:{clientHash,input,target,context}};
  },{readOnly:true});
}
export async function validateCommentPolish(tx,request){
  const meta=request.commentPolish;if(!meta)return;
  const active=(await tx.query("SELECT id FROM operations WHERE kind='AI_SUGGEST' AND request #>> '{commentPolish,clientHash}'=$1 AND id<>$2 AND status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') LIMIT 1",[meta.clientHash,request.operationId])).rows[0];
  check(!active,'COMMENT_REQUEST_PENDING','已有相同评论请求待核查：'+(active?.id||''),409);
  const current=await contextFor(tx,meta.input);check(current.context.packetHash===meta.context.packetHash,'CONTEXT_STALE','排队前评论依据已改变',409);await assertSourceVersions(tx,meta.context.sourceVersions);
}
export async function commentPolishResult(tx,operationId){
  identity(operationId);const row=(await tx.query("SELECT status,request,result,error FROM operations WHERE id=$1 AND kind='AI_SUGGEST'",[operationId])).rows[0];
  check(row?.request.commentPolish,'COMMENT_REQUEST','评论建议请求不存在',404);
  check(row.status==='SUCCEEDED','COMMENT_PENDING',row.status==='RESULT_UNKNOWN'?'原请求结果未知，请按原编号核查':'评论建议尚未完成',409,{operationId,status:row.status});
  const meta=row.request.commentPolish,value=(await tx.query('SELECT content FROM suggestions WHERE operation_id=$1 AND expires_at>now()',[operationId])).rows[0];
  check(value,'SUGGESTION_EXPIRED','建议已超过 10 分钟保留期，原请求回执仍可核查',410);
  await assertSourceVersions(tx,[...meta.context.sourceVersions,...value.content.sourceVersions||[]]);
  return {operationId,requestId:operationId,polishedComment:value.content.summary,model:value.content.model||'AI',snapshotId:meta.input.snapshotId,sceneId:meta.input.sceneId,sceneContentHash:meta.input.sceneContentHash,businessContextHash:meta.input.businessContextHash,requestMode:meta.input.commentDraft.trim()?'POLISH_DRAFT':'SUGGEST_FROM_CONTEXT',sourceContext:{directBeatCount:meta.context.resources?.filter(r=>r.role==='SOURCE').length||0,relatedBeatCount:0}};
}
