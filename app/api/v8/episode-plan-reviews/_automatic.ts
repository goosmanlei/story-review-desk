import { stableObjectHash, mutationRequestHash, type EventRecord } from '../_store';
import { episodeIdentities, episodeSubmissionHeads } from './_contract';
import { EPISODE_REVIEW_INPUT_VERSION, episodeCarryForwardOptions, assertEpisodeCarryForward } from './_scope';

// Called only inside the candidate-registration write transaction. Reading a
// candidate (including a hosted mirror) never creates or modifies review input.
export function automaticEpisodeSubmissions(
  candidate: EventRecord, candidates: EventRecord[], submissions: EventRecord[],
  standard: { hash: string }, snapshotId: string,
) {
  if (candidate.subjectKind !== 'EPISODE_PLAN' || candidate.revisionState !== 'CANDIDATE'
    || !(candidate.content as { narrativeRevision?: unknown } | undefined)?.narrativeRevision) return [];
  const revisionId = String(candidate.creativeRevisionId);
  const heads = episodeSubmissionHeads(submissions, revisionId);
  const identities = episodeIdentities(candidate.content);
  return episodeCarryForwardOptions(candidates, submissions, candidate, standard.hash)
    .filter(option => option.state === 'ELIGIBLE' && !heads.has(option.episodeUid))
    .map(option => {
      const source = assertEpisodeCarryForward(candidates, submissions, candidate, standard.hash,
        option.episodeUid, option.sourceSubmissionEventId, option.reviewInputHash!);
      const identity = identities.find(row => row.episodeUid === option.episodeUid)!;
      const semantic = {
        schemaVersion: '1.1', snapshotId, candidateCreationSnapshotId: candidate.snapshotId,
        operation: 'CARRY_FORWARD_EPISODE', automaticCarryForward: true,
        reviewInputVersion: EPISODE_REVIEW_INPUT_VERSION, reviewInputHash: option.reviewInputHash,
        reviewSpec: standard, reviewSpecHash: standard.hash,
        carryForward: {
          sourceSubmissionEventId: source.eventId, sourceRevisionId: source.subjectRevisionId,
          sourceCandidateHash: source.subjectRevisionHash, sourceReviewSpecHash: source.reviewSpecHash,
          sourceReviewInputHash: option.reviewInputHash, targetReviewInputHash: option.reviewInputHash,
          sourceEventHash: stableObjectHash(source),
        },
        subjectType: 'EPISODE_PLAN_EPISODE', subjectKind: 'EPISODE_PLAN', subjectId: candidate.subjectId,
        subjectRevisionId: revisionId, creativeRevisionId: revisionId, subjectRevisionHash: candidate.contentHash,
        baseRevisionHash: candidate.baseRevisionHash, basisBindings: candidate.basisBindings,
        basisBindingsHash: candidate.basisBindingsHash, contextHash: candidate.contextHash,
        criteriaVersion: candidate.criteriaVersion, scopeType: 'EPISODE', scopeId: identity.episodeUid,
        episodeUid: identity.episodeUid, displayId: identity.displayId,
        criterionFindings: source.criterionFindings, recommendation: source.recommendation, note: String(source.note || ''),
        supersedesEpisodeSubmissionEventId: null,
      };
      const requestHash = mutationRequestHash('episode-plan-submission', semantic);
      return {
        kind: 'episode-plan-submission' as const,
        idempotencyKey: `automatic-episode-review-${stableObjectHash({revisionId, episodeUid: identity.episodeUid})}`,
        requestHash, eventSchemaVersion: '1.1',
        payload: {...semantic, rawRequestHash: requestHash, submissionState: 'SUBMITTED',
          applicationStatus: 'RECORDED', effect: 'REVIEW_INPUT_ONLY', totalEpisodeCount: identities.length,
          canFlowDownstream: false, internalDownstreamEligibility: 'INELIGIBLE_PENDING_COMPLETE_PLAN_REVIEW',
          sourceSyncRequired: false, sourceSyncState: 'NOT_REQUIRED'},
      };
    });
}
