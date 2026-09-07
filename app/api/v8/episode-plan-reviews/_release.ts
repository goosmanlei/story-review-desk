import { HttpError, stableObjectHash, type EventRecord, type ReviewData } from '../_store';
import { episodeReviewInput, episodeReviewInputHash, assertEpisodeSubmissionInput } from './_scope';
import { assertEpisodeSubmissionBindings, episodeSubmissionHeads, parseEpisodeFindings, validateEpisodeAction } from './_contract';
import {candidateReviewSpec} from '../_review-spec';

export const EPISODE_SYNC_PROTOCOL = 'EPISODE_DATABASE_COMPILER_V1';
export const SCENE_SYNC_PROTOCOL = 'SCOPED_SCENE_DATABASE_COMPILER_V1';
export type EpisodeReleaseRecord = {
  id: string; episodeUid: string; creativeRevisionId: string; candidateContentHash: string;
  contentHash: string; reviewInput: ReturnType<typeof episodeReviewInput>; reviewEventId: string;
  sourceOperationId: string; sourceRevisionId: string; sourceSha256: string; sourcePath: string;
  scopeRole: string; sourceSyncState: string; protocol: string;
  episodeScriptReleaseSnapshot:ReturnType<typeof episodeScriptReleaseSnapshot>;
};

export function episodeScriptReleaseSnapshot(release:{id:string;episodeUid:string;reviewEventId:string;contentHash:string;reviewInput:ReturnType<typeof episodeReviewInput>}){
  const content={schemaVersion:'1.0',scopeType:'EPISODE',scopeId:release.episodeUid,episodeNarrativeReleaseId:release.id,reviewEventId:release.reviewEventId,reviewInputHash:release.contentHash,
    orderedSceneBindings:release.reviewInput.scenes.map(scene=>({sceneId:scene.id,sceneScriptRevisionId:`NSR-${stableObjectHash({sceneId:scene.id,contentHash:scene.contentHash,episodeNarrativeReleaseId:release.id}).slice(0,32)}`,sceneContentHash:scene.contentHash}))};
  const contentHash=stableObjectHash(content);return {id:`ESRS-${contentHash.slice(0,32)}`,...content,contentHash};
}

export function assertEpisodeNarrativeReview(event: EventRecord, candidates: EventRecord[], submissions: EventRecord[]) {
  const candidate = candidates.find(c => c.subjectKind === 'EPISODE_PLAN' && c.creativeRevisionId === event.creativeRevisionId);
  if (!candidate) throw new HttpError(409, '本集正式审阅缺少不可变完整候选');
  const atReview = submissions.filter(s => !event.eventSequence || Number(s.eventSequence) < Number(event.eventSequence));
  const submission = episodeSubmissionHeads(atReview, String(candidate.creativeRevisionId)).get(String(event.episodeUid));
  if (!submission || submission.eventId !== event.episodeSubmissionEventId) throw new HttpError(409, '本集正式审阅未绑定当前提交头');
  assertEpisodeSubmissionBindings(submission, candidate, String(event.episodeUid));
  assertEpisodeSubmissionInput(submission, candidate, candidates, atReview);
  const findings = parseEpisodeFindings(submission.criterionFindings, String(event.episodeUid));
  const action = validateEpisodeAction(String(submission.recommendation), findings, String(submission.note || ''));
  const inputHash = episodeReviewInputHash(candidate, String(event.episodeUid), String(submission.reviewSpecHash));
  if (event.schemaVersion !== '2.3' || event.subjectType !== 'EPISODE_NARRATIVE' || event.subjectKind !== 'EPISODE_NARRATIVE'
    || event.subjectId !== event.episodeUid || event.scopeType !== 'EPISODE' || event.scopeId !== event.episodeUid
    || event.subjectRevisionId !== candidate.creativeRevisionId || event.criteriaVersion !== candidate.criteriaVersion
    || Number(candidate.eventSequence)>=Number(submission.eventSequence) || event.eventSequence!=null&&Number(submission.eventSequence)>=Number(event.eventSequence)
    || event.parentCandidateHash !== candidate.contentHash || event.subjectRevisionHash !== inputHash || event.reviewInputHash !== inputHash
    || event.contextHash !== stableObjectHash({episodeUid:event.episodeUid,reviewInputHash:inputHash,episodeSubmissionEventId:submission.eventId})
    || event.reviewSpecHash !== submission.reviewSpecHash || event.action !== action || event.note !== submission.note
    || stableObjectHash(event.criterionFindings) !== stableObjectHash(findings)
    || event.applicationStatus !== 'APPLIED' || event.effect !== 'APPLIED'
    || event.canFlowDownstream !== false || event.sourceSyncRequired !== (action === 'APPROVE_AND_RELEASE')
    || event.sourceSyncState !== (action === 'APPROVE_AND_RELEASE' ? 'PENDING' : 'NOT_REQUIRED')
    || action === 'APPROVE_AND_RELEASE' && event.confirmSceneScripts !== true) throw new HttpError(409, '本集正式审阅的范围、正文确认或精确证据不一致');
  return {candidate, submission, input:episodeReviewInput(candidate, String(event.episodeUid), String(event.reviewSpecHash))};
}

/** Read-only currentness projection. No SCENE ReviewEvents or whole-plan adoption
 * are manufactured; every scene cites its real parent EPISODE review and source.
 */
export function projectEpisodeNarrativeReleases(data: ReviewData, candidates: EventRecord[], reviews: EventRecord[], submissions: EventRecord[], sourceOperations: EventRecord[]) {
  const rows = (data.productionModel as unknown as {episodeNarrativeReleases?: EpisodeReleaseRecord[]}).episodeNarrativeReleases || [];
  const latest = candidates.find(c => c.subjectKind === 'EPISODE_PLAN' && c.revisionState === 'CANDIDATE');
  const byEpisode: Record<string, EpisodeReleaseRecord & {state:string;canFlowDownstream:boolean;reason:string}> = {};
  for (const row of rows.filter(r => r.scopeRole === 'CURRENT')) {
    let reason = '本集发布证据不完整';
    try {
      const review = reviews.find(e => e.eventId === row.reviewEventId);
      if (!review) throw new Error(reason);
      const verified = assertEpisodeNarrativeReview(review, candidates, submissions);
      if (review.action !== 'APPROVE_AND_RELEASE' || row.protocol !== EPISODE_SYNC_PROTOCOL || row.sourceSyncState !== 'SOURCE_CURRENT'
        || row.contentHash !== stableObjectHash(row.reviewInput) || row.contentHash !== review.subjectRevisionHash
        || stableObjectHash(verified.input) !== row.contentHash || row.episodeUid !== review.episodeUid
        || row.creativeRevisionId !== review.creativeRevisionId || row.candidateContentHash !== review.parentCandidateHash
        ||stableObjectHash(row.episodeScriptReleaseSnapshot)!==stableObjectHash(episodeScriptReleaseSnapshot(row))) throw new Error(reason);
      const op = sourceOperations.find(e => e.sourceOperationId === row.sourceOperationId && e.protocol === EPISODE_SYNC_PROTOCOL && e.operationState === 'SUCCEEDED');
      const proof = op?.transactionProof as Record<string, unknown> | undefined;
      if (!op || op.reviewEventId !== row.reviewEventId || !proof || proof.releaseRecordHash !== stableObjectHash(row)
        || proof.sourceRevisionId !== row.sourceRevisionId || proof.sourceSha256 !== row.sourceSha256
        || proof.reviewInputHash !== row.contentHash || proof.reviewEventId !== row.reviewEventId) throw new Error(reason);
      const latestReview = reviews.find(e => e.subjectType === 'EPISODE_NARRATIVE' && e.episodeUid === row.episodeUid);
      if (latestReview?.eventId !== row.reviewEventId) throw new Error('本集存在更新的正式结论，需按最新结论完成源同步');
      if (!latest || episodeReviewInputHash(latest, row.episodeUid, candidateReviewSpec(data,latest).hash) !== row.contentHash) throw new Error('本集正文、归属、关联承接／因果或标准已变化，待重新审阅与同步');
      byEpisode[row.episodeUid] = {...row,state:'READY',canFlowDownstream:true,reason:''};
      continue;
    } catch (error) { reason = error instanceof Error ? error.message : reason; }
    byEpisode[row.episodeUid] = {...row,state:'STALE',canFlowDownstream:false,reason};
  }
  return byEpisode;
}

export function assertScopedEpisodeSceneBasis(data: ReviewData, releases: Record<string, Record<string, unknown> | undefined> | undefined, sceneId: string, bindings: Array<Record<string, unknown>>) {
  const parent = bindings.find(b => b.bindingType === 'EPISODE_NARRATIVE_RELEASE');
  const sceneBinding = bindings.find(b => b.bindingType === 'SCENE_SCRIPT_REVISION');
  const continuity = bindings.find(b => b.bindingType === 'CONTINUITY_SPEC');
  const release = Object.values(releases || {}).find(r => r?.id === parent?.bindingId);
  const input = release?.reviewInput as EpisodeReleaseRecord['reviewInput'] | undefined;
  const scene = input?.scenes.find(s => s.id === sceneId);
  const revision = data.productionModel.sceneScriptRevisions?.find(r => r.id === sceneBinding?.bindingId && r.sceneId === sceneId && r.episodeNarrativeReleaseId === release?.id);
  if (!release || release.canFlowDownstream !== true || release.contentHash !== parent?.bindingHash || parent?.scopeType !== 'EPISODE' || parent.scopeId !== release.episodeUid
    || !scene || !revision || revision.contentHash !== scene.contentHash || sceneBinding?.bindingHash !== scene.contentHash
    || sceneBinding.scopeType !== 'SCENE' || sceneBinding.scopeId !== sceneId
    || continuity?.bindingId !== 'PRODUCTION-MAP-SPEC' || !/^[a-f0-9]{64}$/.test(String(continuity.bindingHash)) || continuity.bindingHash !== data.sourceHashes?.productionMapSha256) throw new HttpError(409, '本场需要精确已发布的本集、正文与当前空间依据；其他集的完成状态不参与此门禁');
  return release;
}

export function assertScopedSceneSyncBinding(data: ReviewData, event: EventRecord, review: EventRecord) {
  const rows = review.subjectKind === 'SCENE_COVERAGE' ? data.productionModel.sceneCoveragePlanRevisions : review.subjectKind === 'SHOT_PLAN_SET' ? data.productionModel.shotPlanSetRevisions : [];
  const row = rows?.find(r => r.id === event.creativeRevisionId && r.scopeRole === 'CURRENT');
  const proof = event.transactionProof as Record<string, unknown> | undefined;
  if (!row || !proof || event.protocol !== SCENE_SYNC_PROTOCOL || event.operationState !== 'SUCCEEDED' || event.reviewEventId !== review.eventId
    || review.action !== 'APPROVE_AND_RELEASE' || review.applicationStatus !== 'APPLIED' || review.effect !== 'APPLIED'
    || event.subjectRevisionHash !== review.subjectRevisionHash || row.contentHash !== review.subjectRevisionHash || stableObjectHash(row.content) !== row.contentHash
    || row.basisBindingsHash !== review.basisBindingsHash || proof.releaseRecordHash !== stableObjectHash(row)
    || proof.sourceRevisionId !== row.sourceRevisionId || proof.sourceSha256 !== row.sourceSha256 || proof.reviewEventId !== review.eventId
    || row.sourceOperationId !== event.sourceOperationId) throw new HttpError(409, '本场源同步证明与已发布正文、候选或正式审阅不一致');
  assertScopedSourceEnvelope(event,review,row as Record<string,unknown>);
}

function assertScopedSourceEnvelope(event:EventRecord,review:EventRecord,row:Record<string,unknown>){
  const proof=event.transactionProof as Record<string,unknown>;
  const impact=event.impact as Record<string,unknown>|undefined;
  if(event.schemaVersion!=='2.0'||event.operationType!=='CREATIVE_REVISION_SYNC'||event.operationState!=='SUCCEEDED'||event.state!=='SUCCEEDED'
    ||event.effect!=='APPLIED'||event.applicationStatus!=='APPLIED'||Number(review.eventSequence)>=Number(event.eventSequence)
    ||event.subjectKind!==review.subjectKind||event.creativeRevisionId!==review.creativeRevisionId||event.subjectRevisionHash!==review.subjectRevisionHash
    ||event.snapshotId!==event.newSnapshotId||!event.baseSnapshotId||!event.resultReleaseId
    ||!impact||['reviewEventId','creativeRevisionId','subjectKind','subjectRevisionHash','basisBindingsHash'].some(key=>impact[key]!==event[key])
    ||proof.protocol!==event.protocol||proof.sourceOperationId!==event.sourceOperationId||proof.creativeRevisionId!==event.creativeRevisionId||proof.reviewInputHash!==row.contentHash
    ||stableObjectHash(event.sourcePaths)!==stableObjectHash([row.sourcePath])||stableObjectHash(event.newBlockHashes)!==stableObjectHash({[String(row.sourcePath)]:row.sourceSha256})
    ||!/^[a-f0-9]{64}$/.test(String(proof.snapshotSha256)))throw new HttpError(409,'受控同步事件缺少精确事务、来源路径或作用域证据');
}

export function assertEpisodeSourceOperation(data: ReviewData, event: EventRecord, candidates: EventRecord[], reviews: EventRecord[], submissions: EventRecord[]) {
  const review=reviews.find(e=>e.eventId===event.reviewEventId);
  if(!review||Number(review.eventSequence)>=Number(event.eventSequence)||event.protocol!==EPISODE_SYNC_PROTOCOL||event.operationType!=='CREATIVE_REVISION_SYNC'||event.operationState!=='SUCCEEDED'||event.applicationStatus!=='APPLIED'||event.effect!=='APPLIED')throw new HttpError(409,'本集源同步事件契约无效');
  const {input}=assertEpisodeNarrativeReview(review,candidates,submissions);
  const rows=(data.productionModel as unknown as {episodeNarrativeReleases?:EpisodeReleaseRecord[]}).episodeNarrativeReleases||[];
  const stored=rows.find(r=>r.sourceOperationId===event.sourceOperationId);
  const row=stored?{...stored,scopeRole:'CURRENT'}:null;
  const proof=event.transactionProof as Record<string,unknown>|undefined;
  if(!row||!proof||review.action!=='APPROVE_AND_RELEASE'||event.creativeRevisionId!==review.creativeRevisionId||event.subjectRevisionHash!==review.subjectRevisionHash
    ||row.reviewEventId!==review.eventId||row.contentHash!==stableObjectHash(input)||row.contentHash!==stableObjectHash(row.reviewInput)||proof.releaseRecordHash!==stableObjectHash(row)
    ||proof.sourceRevisionId!==row.sourceRevisionId||proof.sourceSha256!==row.sourceSha256||proof.reviewEventId!==review.eventId||proof.reviewInputHash!==row.contentHash
    ||stableObjectHash(event.sourcePaths)!==stableObjectHash([row.sourcePath])||(event.newBlockHashes as Record<string,unknown>)?.[row.sourcePath]!==row.sourceSha256
    ||!/^[a-f0-9]{64}$/.test(String(proof.snapshotSha256)))throw new HttpError(409,'本集源同步内容与不可变发布记录不一致');
  assertScopedSourceEnvelope(event,review,row);
}
