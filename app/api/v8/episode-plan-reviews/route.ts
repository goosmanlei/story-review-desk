import {reviewData} from '../_store';
import { EPISODE_REVIEW_INPUT_VERSION, episodeReviewInputHash, episodeCarryForwardOptions, assertEpisodeCarryForward } from './_scope';
import {projectEpisodeNarrativeReleases} from './_release';
import {candidateReviewSpec} from '../_review-spec';
import { assertEpisodeCandidateContract, validateEpisodePlanEvidence } from '../_episode-plan';
import type { EpisodePlanContent } from '../../../episode-plan-context';
import { projectIdFor, episodePlanIdFor } from '../../../instance-profile';
import {
  appendEvent,
  assertCreativeRevisionBasisCurrent,
  assertSha256,
  assertString,
  errorResponse,
  eventLimit,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  optionalString,
  replayIdempotentEvent,
  stableObjectHash,
  validateMutationRequest,
  type EventRecord,
} from '../_store';
import {
  episodeIdentities,
  episodeSubmissionHeads,
  parseEpisodeFindings,
  validateEpisodeAction,
} from './_contract';

function candidateFor(events: EventRecord[], revisionId: string, episodePlanId: string) {
  return events.find((event) => (
    (event.creativeRevisionId === revisionId || event.revisionId === revisionId)
    && event.subjectKind === 'EPISODE_PLAN'
    && event.subjectId === episodePlanId
    && event.revisionState === 'CANDIDATE'
  ));
}

function canonicalPlanReviewExists(events: EventRecord[], revisionId: string, episodePlanId: string, projectId: string) {
  return events.some((event) => (
    ['2.0', '2.1', '2.2'].includes(String(event.schemaVersion || ''))
    && event.effect === 'APPLIED'
    && event.applicationStatus === 'APPLIED'
    && event.subjectType === 'CREATIVE_REVISION'
    && event.subjectKind === 'EPISODE_PLAN'
    && event.subjectId === episodePlanId
    && (event.subjectRevisionId === revisionId || event.creativeRevisionId === revisionId)
    && event.scopeType === 'PROJECT'
    && event.scopeId === projectId
  ));
}

function submissionProgress(events: EventRecord[], revisionId: string, totalEpisodeCount: number, standard?:{hash:string;legacy?:boolean}) {
  const completedEpisodeCount = [...episodeSubmissionHeads(events,revisionId).values()].filter(e=>!standard||e.reviewSpecHash===standard.hash||!e.reviewSpecHash&&standard.legacy).length;
  return {
    completedEpisodeCount,
    totalEpisodeCount,
    allEpisodesSubmitted: completedEpisodeCount === totalEpisodeCount,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'), 500);
    const subjectRevisionId = url.searchParams.get('subjectRevisionId')?.trim() || '';
    const contextHash = url.searchParams.get('contextHash')?.trim().toLowerCase() || '';
    const episodeUid = url.searchParams.get('episodeUid')?.trim() || '';
    if (contextHash) assertSha256(contextHash, 'contextHash');
    const allSubmissions = await listAllEvents('episode-plan-submission');
    const allCandidates = await listAllEvents('creative-revision');
    const allMatchingEvents = allSubmissions
      .filter((event) => !subjectRevisionId || event.subjectRevisionId === subjectRevisionId)
      .filter((event) => !contextHash || event.contextHash === contextHash);
    const data=await reviewData();const rawCandidate=subjectRevisionId?candidateFor(allCandidates,subjectRevisionId,episodePlanIdFor(data)):undefined;const standard=rawCandidate?candidateReviewSpec(data,rawCandidate):undefined;
    const heads = subjectRevisionId ? episodeSubmissionHeads(allMatchingEvents, subjectRevisionId) : new Map<string, EventRecord>();
    const events = allMatchingEvents
      .filter((event) => !episodeUid || event.episodeUid === episodeUid)
      .slice(0, limit);
    const reviews = await listAllEvents('review');
    const releases = projectEpisodeNarrativeReleases(data, allCandidates, reviews, allSubmissions, await listAllEvents('source-operation'));
    return jsonResponse({
      schemaVersion: '1.0',
      events,
      latestHeads:[...heads.values()],
      heads:[...heads.values()].filter(e=>!standard||e.reviewSpecHash===standard.hash||!e.reviewSpecHash&&standard.legacy),
      count: events.length,
      headCount: heads.size,
      carryForwardOptions: rawCandidate && standard ? episodeCarryForwardOptions(allCandidates, allSubmissions, rawCandidate, standard.hash) : [],
      episodeReviews: reviews.filter(e => e.subjectType === 'EPISODE_NARRATIVE' && e.creativeRevisionId === subjectRevisionId),
      episodeReleases: Object.values(releases).map(r => ({episodeUid:r.episodeUid,id:r.id,state:r.state,canFlowDownstream:r.canFlowDownstream,reason:r.reason,reviewEventId:r.reviewEventId,sourceOperationId:r.sourceOperationId})),
    });
  } catch (reason) {
    return errorResponse(reason, 'episode review submissions are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const episodePlanId = episodePlanIdFor(data);
    const projectId = projectIdFor(data);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('episode-plan-submission', body);
    const replay = await replayIdempotentEvent('episode-plan-submission', idempotencyKey, rawRequestHash);
    if (replay) {
      const replayRevisionId = String(replay.event.subjectRevisionId || '');
      const totalEpisodeCount = Number(replay.event.totalEpisodeCount || 0);
      return jsonResponse({
        eventId: replay.event.eventId,
        event: replay.event,
        replayed: true,
        ...submissionProgress(replay.operations.episodePlanSubmissions.events, replayRevisionId, totalEpisodeCount),
        operationRevision: replay.operations.operationRevision,
        mutationEtag: replay.operations.mutationEtag,
      }, { headers: { ETag: replay.operations.etag } });
    }

    const carryForward = body.operation === 'CARRY_FORWARD_EPISODE';
    if (!['1.0','1.1'].includes(String(body.schemaVersion)) || !['SUBMIT_EPISODE','CARRY_FORWARD_EPISODE'].includes(String(body.operation)) || carryForward && body.schemaVersion !== '1.1') {
      throw new HttpError(400, 'episode review submissions require SUBMIT_EPISODE or schema 1.1 CARRY_FORWARD_EPISODE');
    }
    if (carryForward && ['criterionFindings','reviewAction','recommendation','note'].some(key => key in body)) throw new HttpError(400, '沿用判断必须由服务端读取原提交，不能附带修改后的判断');
    const snapshotId = assertString(body.snapshotId, 'snapshotId', 200);
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    const subjectRevisionId = assertString(body.subjectRevisionId, 'subjectRevisionId', 300);
    const subjectRevisionHash = assertSha256(body.subjectRevisionHash, 'subjectRevisionHash');
    const contextHash = assertSha256(body.contextHash, 'contextHash');
    const episodeUid = assertString(body.episodeUid, 'episodeUid', 300);
    let note = optionalString(body.note, 2400);
    const supersedesEpisodeSubmissionEventId = optionalString(body.supersedesEpisodeSubmissionEventId, 300);
    const creativeRevisions = await listAllEvents('creative-revision');
    const candidate = candidateFor(creativeRevisions, subjectRevisionId, episodePlanId);
    if (!candidate) throw new HttpError(422, 'subjectRevisionId does not resolve to the current EPISODE_PLAN candidate');
    if (candidate.contentHash !== subjectRevisionHash) throw new HttpError(409, 'subjectRevisionHash does not match the episode plan candidate');
    if (candidate.contextHash !== contextHash) throw new HttpError(409, 'episode review context is stale');
    assertEpisodeCandidateContract(candidate);
    const standard = candidateReviewSpec(data,candidate);
    if(data.productionModel.systemConfiguration&&body.reviewSpecHash!==standard.hash)throw new HttpError(409,'候选审阅标准已变化，请重新读取');
    if(data.productionModel.systemConfiguration)candidate.reviewSpec = standard;
    if (candidate.criteriaVersion === '2.0' ? body.criteriaVersion !== '2.0' : body.criteriaVersion != null && body.criteriaVersion !== '1.0') throw new HttpError(409, '审阅标准版本不匹配');
    validateEpisodePlanEvidence(data, candidate.content as EpisodePlanContent);
    const identities = episodeIdentities(candidate.content);
    const identity = identities.find((episode) => episode.episodeUid === episodeUid);
    if (!identity) throw new HttpError(422, 'episodeUid does not belong to the reviewed episode plan candidate');
    const reviewInputHash = (candidate.content as EpisodePlanContent).narrativeRevision ? episodeReviewInputHash(candidate, episodeUid, standard.hash) : undefined;
    const sourceSubmissionEventId = carryForward ? assertString(body.sourceSubmissionEventId, 'sourceSubmissionEventId', 300) : '';
    const expectedInputHash = carryForward ? assertSha256(body.reviewInputHash, 'reviewInputHash') : '';
    const source = carryForward ? assertEpisodeCarryForward(creativeRevisions, await listAllEvents('episode-plan-submission'), candidate, standard.hash, episodeUid, sourceSubmissionEventId, expectedInputHash) : null;
    if (source) note = String(source.note || '');
    const criterionFindings = parseEpisodeFindings(source ? source.criterionFindings : body.criterionFindings, episodeUid);
    const action = validateEpisodeAction(String(source ? source.recommendation : body.reviewAction || ''), criterionFindings, note);
    const eventSchemaVersion = reviewInputHash ? '1.1' : '1.0';
    const semanticRequest = {
      schemaVersion: eventSchemaVersion,
      snapshotId,
      candidateCreationSnapshotId: candidate.snapshotId,
      operation: carryForward ? 'CARRY_FORWARD_EPISODE' : 'SUBMIT_EPISODE',
      ...(reviewInputHash ? {reviewInputVersion: EPISODE_REVIEW_INPUT_VERSION, reviewInputHash, reviewSpec:standard} : {}),
      ...(source ? {carryForward: {sourceSubmissionEventId, sourceRevisionId: source.subjectRevisionId, sourceCandidateHash: source.subjectRevisionHash, sourceReviewSpecHash: source.reviewSpecHash, sourceReviewInputHash: reviewInputHash, targetReviewInputHash: reviewInputHash, sourceEventHash: stableObjectHash(source)}} : {}),
      subjectType: 'EPISODE_PLAN_EPISODE',
      subjectKind: 'EPISODE_PLAN',
      subjectId: episodePlanId,
      subjectRevisionId,
      creativeRevisionId: subjectRevisionId,
      subjectRevisionHash,
      baseRevisionHash: candidate.baseRevisionHash,
      basisBindings: candidate.basisBindings,
      basisBindingsHash: candidate.basisBindingsHash,
      contextHash,
      ...(candidate.criteriaVersion ? { criteriaVersion: candidate.criteriaVersion } : {}),
      reviewSpecHash: standard.hash,
      scopeType: 'EPISODE',
      scopeId: episodeUid,
      episodeUid,
      displayId: identity.displayId,
      criterionFindings,
      recommendation: action,
      note,
      supersedesEpisodeSubmissionEventId: supersedesEpisodeSubmissionEventId || null,
    };
    const eventPayload = {
      ...semanticRequest,
      submissionState: 'SUBMITTED',
      canFlowDownstream: false,
      internalDownstreamEligibility: 'INELIGIBLE_PENDING_COMPLETE_PLAN_REVIEW',
      sourceSyncRequired: false,
      sourceSyncState: 'NOT_REQUIRED',
      applicationStatus: 'RECORDED',
      effect: 'REVIEW_INPUT_ONLY',
      totalEpisodeCount: identities.length,
      rawRequestHash,
    };
    const { event, replayed, operations } = await appendEvent(
      'episode-plan-submission',
      idempotencyKey,
      mutationRequestHash('episode-plan-submission', semanticRequest),
      ifMatch,
      eventPayload,
      eventSchemaVersion,
      async (locked) => {
        const lockedCandidate = candidateFor(locked.creativeRevisions.events, subjectRevisionId, episodePlanId);
        if (
          !lockedCandidate
          || lockedCandidate.contentHash !== subjectRevisionHash
          || lockedCandidate.contextHash !== contextHash
        ) throw new HttpError(409, 'episode plan candidate changed while the episode review was in flight');
        const latestCandidate = locked.creativeRevisions.events.find(e => e.subjectKind === 'EPISODE_PLAN' && e.subjectId === episodePlanId && e.revisionState === 'CANDIDATE');
        if (latestCandidate?.creativeRevisionId !== subjectRevisionId) throw new HttpError(409, '不能提交已被新候选取代的分集方案，请重新读取');
        assertCreativeRevisionBasisCurrent(data, locked.stateProjection, lockedCandidate, { requireCurrentPredecessor: true });
        assertEpisodeCandidateContract(lockedCandidate);
        if(data.productionModel.systemConfiguration&&candidateReviewSpec(data,lockedCandidate).hash!==standard.hash)throw new HttpError(409,'候选审阅标准已变化');
        validateEpisodePlanEvidence(data, lockedCandidate.content as EpisodePlanContent);
        if (source) {
          const lockedSource = assertEpisodeCarryForward(locked.creativeRevisions.events, locked.episodePlanSubmissions.events, lockedCandidate, standard.hash, episodeUid, sourceSubmissionEventId, expectedInputHash);
          if (stableObjectHash(lockedSource) !== stableObjectHash(source)) throw new HttpError(409, '沿用来源已变化');
        }
        if (canonicalPlanReviewExists(locked.reviews.events, subjectRevisionId, episodePlanId, projectId)) {
          throw new HttpError(409, 'the complete episode plan already has a formal review');
        }
        if (locked.reviews.events.some(e => e.subjectType === 'EPISODE_NARRATIVE' && e.creativeRevisionId === subjectRevisionId && e.episodeUid === episodeUid)) throw new HttpError(409, '本集已形成正式结论；修改请建立新候选，原审阅不覆盖');
        const lockedHeads = episodeSubmissionHeads(locked.episodePlanSubmissions.events, subjectRevisionId);
        const lockedHead = lockedHeads.get(episodeUid) || null;
        if (lockedHead) {
          if (supersedesEpisodeSubmissionEventId !== lockedHead.eventId) {
            throw new HttpError(409, 'episode review correction must supersede the current episode submission head');
          }
        } else if (supersedesEpisodeSubmissionEventId) {
          throw new HttpError(409, 'supersedesEpisodeSubmissionEventId does not resolve to the current episode submission head');
        }
      },
    );
    const progress = submissionProgress(operations.episodePlanSubmissions.events, subjectRevisionId, identities.length, data.productionModel.systemConfiguration?standard:undefined);
    return jsonResponse({
      eventId: event.eventId,
      event,
      replayed,
      ...progress,
      operationRevision: operations.operationRevision,
      mutationEtag: operations.mutationEtag,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'episode review submission failed');
  }
}
