import {appendEvent,assertCreativeRevisionBasisCurrent,assertSha256,assertString,errorResponse,HttpError,jsonResponse,listAllEvents,mutationRequestHash,replayIdempotentEvent,stableObjectHash,validateMutationRequest} from '../../_store';
import {candidateReviewSpec} from '../../_review-spec';
import {episodeReviewInputHash} from '../_scope';
import {assertEpisodeSubmissionBindings,episodeSubmissionHeads,parseEpisodeFindings,validateEpisodeAction} from '../_contract';
import {assertEpisodeNarrativeReview} from '../_release';
import {episodePlanIdFor} from '../../../../instance-profile';

export async function POST(request:Request) {
  try {
    const {data,idempotencyKey,ifMatch}=await validateMutationRequest(request);
    const body=await request.json() as Record<string,unknown>,rawRequestHash=mutationRequestHash('review',body);
    const replay=await replayIdempotentEvent('review',idempotencyKey,rawRequestHash);
    if(replay)return jsonResponse({event:replay.event,eventId:replay.event.eventId,replayed:true},{headers:{ETag:replay.operations.etag}});
    if(body.schemaVersion!=='1.0'||body.operation!=='FINALIZE_EPISODE')throw new HttpError(400,'需要 FINALIZE_EPISODE 明确确认本集范围');
    if(body.snapshotId!==data.snapshotId)throw new HttpError(412,'页面快照已变化');
    const episodeUid=assertString(body.episodeUid,'episodeUid',300),revisionId=assertString(body.subjectRevisionId,'subjectRevisionId',300),submissionId=assertString(body.episodeSubmissionEventId,'episodeSubmissionEventId',300);
    const candidates=await listAllEvents('creative-revision'),submissions=await listAllEvents('episode-plan-submission');
    const candidate=candidates.find(e=>e.subjectKind==='EPISODE_PLAN'&&e.subjectId===episodePlanIdFor(data));
    if(!candidate||candidate.creativeRevisionId!==revisionId||candidate.contentHash!==assertSha256(body.subjectRevisionHash,'subjectRevisionHash'))throw new HttpError(409,'本集正式确认必须绑定当前完整候选');
    const submission=episodeSubmissionHeads(submissions,revisionId).get(episodeUid);
    if(!submission||submission.eventId!==submissionId)throw new HttpError(409,'本集提交头已变化');
    assertEpisodeSubmissionBindings(submission,candidate,episodeUid);
    const standard=candidateReviewSpec(data,candidate);
    if(standard.hash!==submission.reviewSpecHash||body.reviewSpecHash!==standard.hash)throw new HttpError(409,'本集审阅标准已变化');
    const findings=parseEpisodeFindings(submission.criterionFindings,episodeUid),action=validateEpisodeAction(String(submission.recommendation),findings,String(submission.note||''));
    if(action==='APPROVE_AND_RELEASE'&&body.confirmSceneScripts!==true)throw new HttpError(422,'请明确确认本集全部场正文与六项设计判断一并放行');
    const inputHash=episodeReviewInputHash(candidate,episodeUid,standard.hash);
    const payload={schemaVersion:'2.3',snapshotId:data.snapshotId,subjectType:'EPISODE_NARRATIVE',subjectKind:'EPISODE_NARRATIVE',subjectId:episodeUid,episodeUid,scopeType:'EPISODE',scopeId:episodeUid,
      subjectRevisionId:revisionId,creativeRevisionId:revisionId,parentCandidateHash:candidate.contentHash,subjectRevisionHash:inputHash,reviewInputHash:inputHash,
      episodeSubmissionEventId:submissionId,reviewSpecHash:standard.hash,criteriaVersion:candidate.criteriaVersion,contextHash:stableObjectHash({episodeUid,reviewInputHash:inputHash,episodeSubmissionEventId:submissionId}),
      criterionFindings:findings,action,note:String(submission.note||''),confirmSceneScripts:body.confirmSceneScripts===true,applicationStatus:'APPLIED',effect:'APPLIED',canFlowDownstream:false,sourceSyncRequired:action==='APPROVE_AND_RELEASE',sourceSyncState:action==='APPROVE_AND_RELEASE'?'PENDING':'NOT_REQUIRED',rawRequestHash};
    assertEpisodeNarrativeReview(payload,candidates,submissions);
    const result=await appendEvent('review',idempotencyKey,mutationRequestHash('review',payload),ifMatch,payload,'2.3',async locked=>{
      if(locked.creativeRevisions.events.find(e=>e.subjectKind==='EPISODE_PLAN'&&e.subjectId===candidate.subjectId)?.creativeRevisionId!==revisionId)throw new HttpError(409,'候选已变化');
      assertCreativeRevisionBasisCurrent(data,locked.stateProjection,candidate,{requireCurrentPredecessor:true});
      assertEpisodeNarrativeReview(payload,locked.creativeRevisions.events,locked.episodePlanSubmissions.events);
      if(locked.reviews.events.some(e=>e.subjectType==='EPISODE_NARRATIVE'&&e.creativeRevisionId===revisionId&&e.episodeUid===episodeUid))throw new HttpError(409,'本候选的本集正式结论已登记；修改须创建新候选');
    });
    return jsonResponse({event:result.event,eventId:result.event.eventId,replayed:result.replayed,sourceSyncRequired:payload.sourceSyncRequired},{status:result.replayed?200:201,headers:{ETag:result.operations.etag}});
  } catch(error) {return errorResponse(error,'本集正式确认失败');}
}
