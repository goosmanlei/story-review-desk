import {candidateReviewSpec} from '../../_review-spec';
import {assertEpisodeSubmissionInput} from '../_scope';
import { assertEpisodeCandidateContract, validateEpisodePlanEvidence } from '../../_episode-plan';
import type { EpisodePlanContent } from '../../../../episode-plan-context';
import { projectIdFor, episodePlanIdFor } from '../../../../instance-profile';
import {
  appendEvent,
  assertCreativeRevisionBasisCurrent,
  assertSha256,
  assertString,
  currentCreativeSubjectBaseHash,
  errorResponse,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  replayIdempotentEvent,
  stableObjectHash,
  validateMutationRequest,
  type EventRecord,
} from '../../_store';
import {
  aggregateEpisodeSubmissions,
  assertEpisodeSubmissionBindings,
  episodeIdentities,
  episodeSubmissionHeads,
} from '../_contract';

function candidateFor(events: EventRecord[], revisionId: string, episodePlanId: string) {
  return events.find((event) => (
    (event.creativeRevisionId === revisionId || event.revisionId === revisionId)
    && event.subjectKind === 'EPISODE_PLAN'
    && event.subjectId === episodePlanId
    && event.revisionState === 'CANDIDATE'
  ));
}

function canonicalReviews(events: EventRecord[], revisionId: string, episodePlanId: string, projectId: string) {
  return events.filter((event) => (
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

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const episodePlanId = episodePlanIdFor(data);
    const projectId = projectIdFor(data);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('review', body);
    const replay = await replayIdempotentEvent('review', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        event: replay.event,
        replayed: true,
        operationRevision: replay.operations.operationRevision,
        mutationEtag: replay.operations.mutationEtag,
        appliedProjection: replay.operations.stateProjection,
      }, { headers: { ETag: replay.operations.etag } });
    }
    if (body.schemaVersion !== '1.0' || body.operation !== 'FINALIZE_PLAN') {
      throw new HttpError(400, 'episode plan finalization requires schemaVersion 1.0 and operation FINALIZE_PLAN');
    }
    const reviewContract = data.productionModel.systemModel?.stateModel?.reviewContract;
    if (!reviewContract || !['2.0', '2.1', '2.2'].includes(String(reviewContract.schemaVersion || ''))) {
      throw new HttpError(409, 'episode plan finalization requires the current ReviewEvent 2.2 contract');
    }
    const snapshotId = assertString(body.snapshotId, 'snapshotId', 200);
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    const subjectRevisionId = assertString(body.subjectRevisionId, 'subjectRevisionId', 300);
    const subjectRevisionHash = assertSha256(body.subjectRevisionHash, 'subjectRevisionHash');
    const contextHash = assertSha256(body.contextHash, 'contextHash');
    if (!Array.isArray(body.episodeSubmissionRefs)) {
      throw new HttpError(400, 'episodeSubmissionRefs must contain the complete current per-episode submission heads');
    }
    const suppliedHeadRefs = body.episodeSubmissionRefs.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HttpError(400, `episodeSubmissionRefs[${index}] must be an object`);
      }
      const row = raw as Record<string, unknown>;
      return {
        episodeUid: assertString(row.episodeUid, `episodeSubmissionRefs[${index}].episodeUid`, 300),
        eventId: assertString(row.eventId, `episodeSubmissionRefs[${index}].eventId`, 300),
      };
    });
    const candidates = await listAllEvents('creative-revision');
    const candidate = candidateFor(candidates, subjectRevisionId, episodePlanId);
    if (!candidate) throw new HttpError(422, 'subjectRevisionId does not resolve to the current EPISODE_PLAN candidate');
    if(candidates.find(c=>c.subjectKind==='EPISODE_PLAN'&&c.subjectId===episodePlanId&&c.revisionState==='CANDIDATE')?.creativeRevisionId!==subjectRevisionId)throw new HttpError(409,'完整候选已更新，不能汇总旧候选');
    if (candidate.contentHash !== subjectRevisionHash) throw new HttpError(409, 'subjectRevisionHash does not match the episode plan candidate');
    if (candidate.contextHash !== contextHash) throw new HttpError(409, 'episode plan finalization context is stale');
    if (candidate.baseRevisionHash !== currentCreativeSubjectBaseHash(data, 'EPISODE_PLAN', episodePlanId)) {
      throw new HttpError(409, 'episode plan predecessor changed after candidate creation');
    }
    assertEpisodeCandidateContract(candidate);
    const standard = candidateReviewSpec(data,candidate);
    if(data.productionModel.systemConfiguration&&body.reviewSpecHash!==standard.hash)throw new HttpError(409,'候选审阅标准已变化，请重新读取');
    if(data.productionModel.systemConfiguration)candidate.reviewSpec = standard;
    if (candidate.criteriaVersion === '2.0' ? body.criteriaVersion !== '2.0' : body.criteriaVersion != null && body.criteriaVersion !== '1.0') throw new HttpError(409, '审阅标准版本不匹配');
    validateEpisodePlanEvidence(data, candidate.content as EpisodePlanContent);
    const identities = episodeIdentities(candidate.content);
    const allSubmissions = await listAllEvents('episode-plan-submission');
    const heads = episodeSubmissionHeads(allSubmissions, subjectRevisionId);
    const aggregate = aggregateEpisodeSubmissions(identities, heads);
    if (!aggregate.complete) {
      throw new HttpError(422, 'all episode submissions are required before the complete plan review can be registered', {
        missingEpisodeUids: aggregate.missingEpisodeUids,
      });
    }
    if (!reviewContract.actions?.includes(aggregate.action)) {
      throw new HttpError(409, 'the current ReviewEvent contract does not allow the aggregated episode-plan action');
    }
    for (const submission of aggregate.submissions) {
      if (submission.event.reviewSpecHash !== standard.hash && !(submission.event.schemaVersion === '1.0' && !submission.event.reviewSpecHash && standard.legacy)) throw new HttpError(409, '本集提交仍绑定旧审阅标准，请重新提交');
      assertEpisodeSubmissionBindings(submission.event, candidate, submission.episode.episodeUid);
      assertEpisodeSubmissionInput(submission.event, candidate, candidates, allSubmissions);
    }
    const currentHeadRefs = aggregate.episodeSubmissionRefs.map(({ episodeUid, eventId }) => ({ episodeUid, eventId }));
    if (stableObjectHash(suppliedHeadRefs) !== stableObjectHash(currentHeadRefs)) {
      throw new HttpError(409, 'episodeSubmissionRefs do not match the complete current submission heads');
    }
    if (canonicalReviews(await listAllEvents('review'), subjectRevisionId, episodePlanId, projectId).length) {
      throw new HttpError(409, 'the complete episode plan already has a formal review');
    }
    const revisionInstructions = aggregate.action === 'REQUEST_REVISION'
      ? { preserve: [], change: aggregate.revisionChanges, mustNotRegress: [] }
      : null;
    const semanticRequest = {
      schemaVersion: '2.2',
      snapshotId,
      creationSnapshotId: snapshotId,
      businessContextHash: contextHash,
      bindingVersion: '2.2',
      subjectType: 'CREATIVE_REVISION',
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
      criterionFindings: aggregate.criterionFindings,
      revisionInstructions,
      productionPhaseId: null,
      productionGateId: null,
      scopeType: 'PROJECT',
      scopeId: projectId,
      workPackageId: null,
      workItemId: null,
      action: aggregate.action,
      note: aggregate.note,
      episodeSubmissionRefs: aggregate.episodeSubmissionRefs,
    };
    const reviewDecision = aggregate.action === 'APPROVE_AND_RELEASE'
      ? 'RELEASED'
      : aggregate.action === 'REQUEST_REVISION' ? 'REVISION_REQUIRED' : 'DO_NOT_USE';
    const eventPayload = {
      ...semanticRequest,
      reviewedRevisionState: 'CANDIDATE',
      originalProjection: {
        reviewDecision: 'PENDING',
        lifecycleState: 'REVIEW_PENDING',
        canFlowDownstream: false,
      },
      reviewDecision,
      lifecycleState: reviewDecision,
      canFlowDownstream: false,
      adoptionIntent: aggregate.action === 'APPROVE_AND_RELEASE' ? 'ADOPT_THIS_REVISION' : 'DO_NOT_ADOPT',
      internalDownstreamEligibility: aggregate.action === 'APPROVE_AND_RELEASE' ? 'INELIGIBLE_PENDING_SOURCE_SYNC' : 'INELIGIBLE',
      sourceSyncRequired: aggregate.action === 'APPROVE_AND_RELEASE',
      sourceSyncState: aggregate.action === 'APPROVE_AND_RELEASE' ? 'PENDING' : 'NOT_REQUIRED',
      applicationStatus: 'APPLIED',
      effect: 'APPLIED',
      reviewInputMode: 'EPISODE_PLAN_EPISODE_SUBMISSIONS',
      rawRequestHash,
    };
    const expectedHeadRefs = aggregate.episodeSubmissionRefs;
    const { event, replayed, operations } = await appendEvent(
      'review',
      idempotencyKey,
      mutationRequestHash('review', semanticRequest),
      ifMatch,
      eventPayload,
      '2.2',
      async (locked) => {
        const lockedCandidate = candidateFor(locked.creativeRevisions.events, subjectRevisionId, episodePlanId);
        if(locked.creativeRevisions.events.find(c=>c.subjectKind==='EPISODE_PLAN'&&c.subjectId===episodePlanId&&c.revisionState==='CANDIDATE')?.creativeRevisionId!==subjectRevisionId)throw new HttpError(409,'完整候选已更新，不能汇总旧候选');
        if (
          !lockedCandidate
          || lockedCandidate.contentHash !== subjectRevisionHash
          || lockedCandidate.contextHash !== contextHash
        ) throw new HttpError(409, 'episode plan candidate changed while finalization was in flight');
        assertCreativeRevisionBasisCurrent(data, locked.stateProjection, lockedCandidate, { requireCurrentPredecessor: true });
        assertEpisodeCandidateContract(lockedCandidate);
        if(data.productionModel.systemConfiguration){const lockedStandard=candidateReviewSpec(data,lockedCandidate);if(lockedStandard.hash!==standard.hash)throw new HttpError(409,'候选审阅标准已变化');lockedCandidate.reviewSpec=lockedStandard;}
        validateEpisodePlanEvidence(data, lockedCandidate.content as EpisodePlanContent);
        if (canonicalReviews(locked.reviews.events, subjectRevisionId, episodePlanId, projectId).length) {
          throw new HttpError(409, 'the complete episode plan already has a formal review');
        }
        const lockedAggregate = aggregateEpisodeSubmissions(
          episodeIdentities(lockedCandidate.content),
          episodeSubmissionHeads(locked.episodePlanSubmissions.events, subjectRevisionId),
        );
        if (!lockedAggregate.complete || stableObjectHash(lockedAggregate.episodeSubmissionRefs) !== stableObjectHash(expectedHeadRefs)) {
          throw new HttpError(409, 'episode submission heads changed while finalization was in flight');
        }
        for (const submission of lockedAggregate.submissions) {
          if (submission.event.reviewSpecHash !== standard.hash && !(submission.event.schemaVersion === '1.0' && !submission.event.reviewSpecHash && standard.legacy)) throw new HttpError(409, '本集提交仍绑定旧审阅标准，请重新提交');
          assertEpisodeSubmissionBindings(submission.event, lockedCandidate, submission.episode.episodeUid);
          assertEpisodeSubmissionInput(submission.event, lockedCandidate, locked.creativeRevisions.events, locked.episodePlanSubmissions.events);
        }
      },
    );
    const applied = operations.reviews.projectedStructureByRevision
      .some((item: { event?: { eventId?: unknown } }) => item.event?.eventId === event.eventId);
    if (!applied) {
      throw new HttpError(409, 'review event was recorded but does not bind the current episode plan projection; reload before retrying');
    }
    return jsonResponse({
      eventId: event.eventId,
      event,
      replayed,
      operationRevision: operations.operationRevision,
      mutationEtag: operations.mutationEtag,
      appliedProjection: operations.stateProjection,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'complete episode plan review finalization failed');
  }
}
