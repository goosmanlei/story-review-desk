import { createHash } from 'node:crypto';

/** Public, read-only projection. Private assistant, trial and source-audio bytes never enter this bundle. */
export async function hostedEventProjection(view) {
const reviewData=view.snapshot;
const selectedRequirementIds = new Set((reviewData.productionModel.materialRequirements || []).filter(item=>item.requirementClass==='REQUIRED').map(item=>item.id));
const selectedWorkItemIds = new Set((reviewData.productionModel.materialWorkItems || []).filter(item=>selectedRequirementIds.has(item.requirementRef)).map(item=>item.id));
async function events(kind) {return view.eventsByKind[kind] || [];}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function stableObjectHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function revisionId(event) {
  return String(event.creativeRevisionId || event.revisionId || '');
}

function episodeIdentities(candidate) {
  const rows = candidate?.content?.episodes;
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) {
    throw new Error(`hosted episode-plan candidate ${revisionId(candidate) || 'UNKNOWN'} has invalid episode content`);
  }
  const identities = rows.map((episode, index) => ({
    episodeUid: String(episode?.episodeUid || ''),
    displayId: String(episode?.displayId || `E${String(index + 1).padStart(2, '0')}`),
  }));
  if (identities.some(({ episodeUid }) => !episodeUid) || new Set(identities.map(({ episodeUid }) => episodeUid)).size !== identities.length) {
    throw new Error(`hosted episode-plan candidate ${revisionId(candidate) || 'UNKNOWN'} has invalid episode identities`);
  }
  return identities;
}

function assertSubmissionBinding(event, candidate, identity, totalEpisodeCount) {
  const candidateId = revisionId(candidate);
  if (
    event.eventKind !== 'episode-plan-submission'
    || !['1.0','1.1'].includes(event.schemaVersion)
    || event.applicationStatus !== 'RECORDED'
    || event.effect !== 'REVIEW_INPUT_ONLY'
    || event.subjectType !== 'EPISODE_PLAN_EPISODE'
    || event.subjectKind !== 'EPISODE_PLAN'
    || event.subjectId !== view.profile.episodePlanId
    || event.subjectRevisionId !== candidateId
    || event.creativeRevisionId !== candidateId
    || event.subjectRevisionHash !== candidate.contentHash
    || event.contextHash !== candidate.contextHash
    || candidate.criteriaVersion === '2.0' && event.criteriaVersion !== '2.0'
    || event.baseRevisionHash !== candidate.baseRevisionHash
    || event.basisBindingsHash !== candidate.basisBindingsHash
    || stableObjectHash(event.basisBindings) !== candidate.basisBindingsHash
    || event.scopeType !== 'EPISODE'
    || event.scopeId !== identity.episodeUid
    || event.episodeUid !== identity.episodeUid
    || event.displayId !== identity.displayId
    || event.totalEpisodeCount !== totalEpisodeCount
    || event.candidateCreationSnapshotId !== candidate.snapshotId
  ) {
    throw new Error(`hosted episode submission ${event.eventId || 'UNKNOWN'} does not bind ${candidateId}/${identity.episodeUid}`);
  }
}

function submissionClosure(candidate, allSubmissions) {
  const candidateId = revisionId(candidate);
  const identities = episodeIdentities(candidate);
  const identityByUid = new Map(identities.map((identity) => [identity.episodeUid, identity]));
  const relevant = allSubmissions.filter((event) => String(event.subjectRevisionId || event.creativeRevisionId || '') === candidateId);
  const unknownUids = [...new Set(relevant.map((event) => String(event.episodeUid || event.scopeId || '')))]
    .filter((episodeUid) => !identityByUid.has(episodeUid));
  if (unknownUids.length) throw new Error(`hosted episode-plan candidate ${candidateId} has submissions for unknown episode UIDs`);
  const orderedEvents = [];
  const heads = new Map();
  for (const identity of identities) {
    const chain = relevant
      .filter((event) => String(event.episodeUid || event.scopeId || '') === identity.episodeUid)
      .sort((left, right) => (
        Number(left.eventSequence || 0) - Number(right.eventSequence || 0)
        || String(left.recordedAt || '').localeCompare(String(right.recordedAt || ''))
        || String(left.eventId || '').localeCompare(String(right.eventId || ''))
      ));
    let head = null;
    for (const event of chain) {
      assertSubmissionBinding(event, candidate, identity, identities.length);
      const supersedes = String(event.supersedesEpisodeSubmissionEventId || '');
      if ((!head && supersedes) || (head && supersedes !== head.eventId)) {
        throw new Error(`hosted episode submission chain for ${candidateId}/${identity.episodeUid} is not linear`);
      }
      head = event;
      orderedEvents.push(event);
    }
    if (head) heads.set(identity.episodeUid, head);
  }
  return { identities, events: orderedEvents, heads };
}

function assertFormalReviewClosure(review, candidate, closure) {
  const candidateId = revisionId(candidate);
  if (
    !['2.0', '2.1', '2.2'].includes(String(review.schemaVersion || ''))
    || review.effect !== 'APPLIED'
    || review.applicationStatus !== 'APPLIED'
    || review.subjectType !== 'CREATIVE_REVISION'
    || review.subjectKind !== 'EPISODE_PLAN'
    || review.subjectId !== view.profile.episodePlanId
    || String(review.subjectRevisionId || review.creativeRevisionId || '') !== candidateId
    || review.subjectRevisionHash !== candidate.contentHash
    || review.contextHash !== candidate.contextHash
    || candidate.criteriaVersion === '2.0' && review.criteriaVersion !== '2.0'
    || review.baseRevisionHash !== candidate.baseRevisionHash
    || review.basisBindingsHash !== candidate.basisBindingsHash
    || stableObjectHash(review.basisBindings) !== candidate.basisBindingsHash
  ) {
    throw new Error(`hosted episode-plan review ${review.eventId || 'UNKNOWN'} does not bind its exact candidate`);
  }
  const refs = Array.isArray(review.episodeSubmissionRefs) ? review.episodeSubmissionRefs : [];
  if (refs.length !== closure.identities.length || closure.heads.size !== closure.identities.length) {
    throw new Error(`hosted episode-plan review ${review.eventId || 'UNKNOWN'} does not cover its candidate episode count`);
  }
  closure.identities.forEach((identity, index) => {
    const ref = refs[index];
    const head = closure.heads.get(identity.episodeUid);
    if (
      !ref
      || ref.episodeUid !== identity.episodeUid
      || ref.displayIdAtSubmission !== identity.displayId
      || ref.eventId !== head?.eventId
    ) {
      throw new Error(`hosted episode-plan review ${review.eventId || 'UNKNOWN'} does not reference the exact current head for ${identity.episodeUid}`);
    }
  });
  const expectedCriteria = closure.identities.flatMap(({ episodeUid }) => [
    'opening-boundary', 'episode-purpose', 'escalation-turn',
    'information-causality', 'episode-payoff', 'ending-propulsion',
  ].map((suffix) => `episode:${episodeUid}:${suffix}`)).sort();
  const actualCriteria = Array.isArray(review.criterionFindings)
    ? review.criterionFindings.map((finding) => String(finding?.criterionId || '')).sort()
    : [];
  if (stableObjectHash(actualCriteria) !== stableObjectHash(expectedCriteria)) {
    throw new Error(`hosted episode-plan review ${review.eventId || 'UNKNOWN'} does not contain the exact per-episode findings`);
  }
}

const allExecutionRequests = await events('execution-request');
const currentExecutionRequests = allExecutionRequests.filter((event) => (
  event.snapshotId === reviewData.snapshotId && selectedWorkItemIds.has(String(event.workItemId || ''))
));
const selectedFamilyIds = new Set(
  reviewData.productionModel.materialWorkItems
    .filter((item) => selectedRequirementIds.has(String(item.requirementRef || '')))
    .map((item) => String(item.outputAssetRef || '')),
);
const materialFamilyIds=new Set(selectedFamilyIds),animaticVersionIds=new Set((reviewData.productionModel.publicProductionMedia||reviewData.productionModel.publicAnimaticMedia||[]).map(m=>m.versionId));
const publicBindings=reviewData.productionModel.publicExportMediaBindings,publicVersionIds=Array.isArray(publicBindings)?new Set(publicBindings.map(b=>b.versionId)):null;
const isExactPublicMediaEvent=event=>publicBindings?.some(binding=>binding.familyId===event.familyId&&binding.versionId===event.versionId&&binding.sha256===(event.versionSha256||event.sha256));
for(const item of reviewData.productionModel.publicAnimaticMedia||[])selectedFamilyIds.add(item.familyId);
for(const item of reviewData.productionModel.workItems||[])if(item.scopeRole==='CURRENT'&&selectedFamilyIds.has(item.outputAssetRef))selectedWorkItemIds.add(item.id);
const assetVersions = (await events('asset-version')).filter((event) => (
  publicVersionIds?isExactPublicMediaEvent(event):(materialFamilyIds.has(String(event.familyId || '')) || animaticVersionIds.has(event.versionId))
));
const candidateRequestIds = new Set(assetVersions.filter(event=>!['DETERMINISTIC_RENDER','DETERMINISTIC_MANIFEST'].includes(event.executorKind)).map((event) => String(event.executionRequestId || '')));
const materialReviews=(await events('review')).filter(event=>['ASSET','WORK_PRODUCT'].includes(event.subjectType)&&(publicVersionIds?isExactPublicMediaEvent(event):(materialFamilyIds.has(event.familyId)||animaticVersionIds.has(event.versionId))));
const candidateExecutionRequests = allExecutionRequests.filter((event) => (
  candidateRequestIds.has(String(event.executionRequestId || ''))
));
const executionRequests = [...(publicVersionIds?[]:currentExecutionRequests), ...candidateExecutionRequests]
  .filter((event, index, rows) => rows.findIndex((candidate) => candidate.eventId === event.eventId) === index);
const requestIds = new Set(executionRequests.map((event) => String(event.executionRequestId || '')));
const runs = (await events('run')).filter((event) => (
  requestIds.has(String(event.executionRequestId || ''))
));
const allEpisodePlanRevisions = (await events('creative-revision')).filter((event) => (
  event.subjectKind === 'EPISODE_PLAN' && event.subjectId === view.profile.episodePlanId
));
const allEpisodePlanSubmissions = await events('episode-plan-submission');
const scopedCandidates=(await events('creative-revision')).filter(e=>e.scopedReviewSpec&&['SCENE_COVERAGE','SHOT_PLAN_SET'].includes(e.subjectKind));
const scopedReviews=(await events('review')).filter(e=>e.subjectType==='EPISODE_NARRATIVE'||scopedCandidates.some(c=>c.creativeRevisionId===e.creativeRevisionId));
const scopedOperations=(await events('source-operation')).filter(e=>['EPISODE_DATABASE_COMPILER_V1','SCOPED_SCENE_DATABASE_COMPILER_V1'].includes(e.protocol));
for(const op of scopedOperations)if(!scopedReviews.some(r=>r.eventId===op.reviewEventId&&r.creativeRevisionId===op.creativeRevisionId))throw new Error('scoped export lacks exact review closure');
for(const review of scopedReviews)if(review.subjectType!=='EPISODE_NARRATIVE'&&!scopedCandidates.some(c=>c.creativeRevisionId===review.creativeRevisionId&&c.contentHash===review.subjectRevisionHash))throw new Error('scoped export lacks exact candidate closure');
const allEpisodePlanReviews = (await events('review')).filter((event) => (
  event.subjectType === 'CREATIVE_REVISION'
  && event.subjectKind === 'EPISODE_PLAN'
  && event.subjectId === view.profile.episodePlanId
  && ['2.0', '2.1', '2.2'].includes(String(event.schemaVersion || ''))
  && event.effect === 'APPLIED'
  && event.applicationStatus === 'APPLIED'
));
const adoptedRevisionId = String(reviewData.creativeLineage?.storyStructure?.adoptedCreativeRevisionId || '');
const latestCandidate = allEpisodePlanRevisions[0] || null;
const latestFormalReview = allEpisodePlanReviews[0] || null;
const selectedRevisionIds = new Set([
  revisionId(latestCandidate || {}),
  adoptedRevisionId,
  String(latestFormalReview?.subjectRevisionId || latestFormalReview?.creativeRevisionId || ''),
].filter(Boolean));
// Historical submitted candidates are review evidence, including carry-forward
// provenance and the newest uncarried heads. Never erase their visible status.
for (const event of allEpisodePlanSubmissions) selectedRevisionIds.add(String(event.subjectRevisionId));
for (const review of scopedReviews.filter(e=>e.subjectType==='EPISODE_NARRATIVE')) selectedRevisionIds.add(String(review.creativeRevisionId));
const episodePlanRevisions = allEpisodePlanRevisions.filter((event) => selectedRevisionIds.has(revisionId(event)));
if (selectedRevisionIds.size !== episodePlanRevisions.length) {
  throw new Error('hosted episode-plan projection cannot resolve every selected candidate revision');
}
const candidateById = new Map(episodePlanRevisions.map((event) => [revisionId(event), event]));
const latestReviewByRevision = new Map();
for (const review of allEpisodePlanReviews) {
  const candidateId = String(review.subjectRevisionId || review.creativeRevisionId || '');
  if (selectedRevisionIds.has(candidateId) && !latestReviewByRevision.has(candidateId)) latestReviewByRevision.set(candidateId, review);
}
const episodePlanReviews = [...latestReviewByRevision.values()];
const closureByRevision = new Map(episodePlanRevisions.map((candidate) => [
  revisionId(candidate),
  submissionClosure(candidate, allEpisodePlanSubmissions),
]));
for (const review of episodePlanReviews) {
  const candidateId = String(review.subjectRevisionId || review.creativeRevisionId || '');
  assertFormalReviewClosure(review, candidateById.get(candidateId), closureByRevision.get(candidateId));
}
const episodePlanSubmissions = [...closureByRevision.values()]
  .flatMap((closure) => closure.events)
  .sort((left, right) => Number(right.eventSequence || 0) - Number(left.eventSequence || 0));
const selectedReviewIds = new Set(episodePlanReviews.map((event) => String(event.eventId || '')));
const allSourceOperations = await events('source-operation');
const selectedSourceOperationIds = new Set(allSourceOperations
  .filter((event) => selectedReviewIds.has(String(event.reviewEventId || event.impact?.reviewEventId || '')))
  .map((event) => String(event.sourceOperationId || ''))
  .filter(Boolean));
const episodePlanSourceOperations = allSourceOperations.filter((event) => selectedSourceOperationIds.has(String(event.sourceOperationId || '')));
for (const sourceOperationId of selectedSourceOperationIds) {
  const operationEvents = episodePlanSourceOperations
    .filter((event) => event.sourceOperationId === sourceOperationId)
    .sort((left, right) => Number(left.eventSequence || 0) - Number(right.eventSequence || 0));
  const latest = operationEvents.at(-1);
  const review = episodePlanReviews.find((event) => event.eventId === latest?.reviewEventId || event.eventId === latest?.impact?.reviewEventId);
  const allowedTransitions = {
    REQUESTED: new Set(['REQUESTED', 'STARTED', 'FAILED']),
    STARTED: new Set(['STARTED', 'BUILT', 'FAILED']),
    BUILT: new Set(['BUILT', 'DEPLOYED', 'FAILED']),
    DEPLOYED: new Set(['DEPLOYED', 'SUCCEEDED', 'FAILED']),
    SUCCEEDED: new Set(),
    FAILED: new Set(),
  };
  let previousState = '';
  for (const event of operationEvents) {
    const impact = event.impact && typeof event.impact === 'object' && !Array.isArray(event.impact) ? event.impact : {};
    const state = String(event.operationState || event.state || '');
    if (
      !review
      || event.operationType !== 'CREATIVE_REVISION_SYNC'
      || event.reviewEventId !== review.eventId
      || impact.reviewEventId !== review.eventId
      || event.subjectKind !== 'EPISODE_PLAN'
      || impact.subjectKind !== 'EPISODE_PLAN'
      || event.creativeRevisionId !== (review.subjectRevisionId || review.creativeRevisionId)
      || impact.creativeRevisionId !== event.creativeRevisionId
      || event.subjectRevisionHash !== review.subjectRevisionHash
      || impact.subjectRevisionHash !== event.subjectRevisionHash
      || event.basisBindingsHash !== review.basisBindingsHash
      || impact.basisBindingsHash !== event.basisBindingsHash
      || (!previousState && state !== 'REQUESTED')
      || (previousState && !allowedTransitions[previousState]?.has(state))
    ) {
      throw new Error(`hosted source operation ${sourceOperationId} does not bind its exact episode-plan review`);
    }
    previousState = state;
  }
}

if ([...candidateRequestIds].some((requestId) => !requestId || !requestIds.has(requestId))) {
  throw new Error('hosted material-event projection is missing an execution request referenced by a candidate');
}
if (runs.some((event) => !requestIds.has(String(event.executionRequestId || '')))) {
  throw new Error('hosted material-event projection contains a run outside the selected request closure');
}
if (new Set(executionRequests.map((event) => String(event.eventId || ''))).size !== executionRequests.length) {
  throw new Error('hosted material-event projection contains duplicate execution-request events');
}
if (runs.some((event) => event.modelInvocationPerformedByReviewSite !== false)) {
  throw new Error('hosted material-event export contains an unverified model invocation flag');
}
const commentEvents=await events('script-comment');
const commentRevisionIds=new Set([...episodePlanRevisions.map(revisionId),...(reviewData.productionModel.episodePlanRevisions||[]).filter(r=>r.isCurrent).flatMap(r=>[r.id,r.creativeRevisionId])]);
const commentIds=new Set(commentEvents.filter(e=>e.schemaVersion==='1.2'&&e.commentAction==='CREATE'&&commentRevisionIds.has(e.target?.revisionId)).map(e=>e.commentId));
// Include the complete immutable chain of closed story comments. Reading history
// does not restore it to current work or rebind old scene aliases to new scenes.
for(const event of commentEvents) if(['RESOLVE_USER','RESOLVE_AI','RESOLVE_AND_DELETE','RESOLVE_WITH_HISTORY'].includes(event.commentAction)) commentIds.add(event.commentId);
const storyComments=commentEvents.filter(e=>commentIds.has(e.commentId));
const bundle = {
  schemaVersion: '1.0',
  mode: 'HOSTED_READ_ONLY_EVENT_PROJECTION',
  snapshotId: reviewData.snapshotId,
  selectionPlanId: view.releaseId,
  selectionSeed: null,
  paidModelInvocation: false,
  events: {
    'execution-request': executionRequests,
    run: runs,
    'asset-version': assetVersions,
    'creative-revision': [...episodePlanRevisions,...scopedCandidates].sort((a,b)=>Number(b.eventSequence||0)-Number(a.eventSequence||0)),
    'episode-plan-submission': episodePlanSubmissions,
    review: [...episodePlanReviews,...scopedReviews,...materialReviews].filter((event,index,rows)=>rows.findIndex(row=>row.eventId===event.eventId)===index).sort((a,b)=>Number(b.eventSequence||0)-Number(a.eventSequence||0)),
    'source-operation': [...episodePlanSourceOperations,...scopedOperations].sort((a,b)=>Number(b.eventSequence||0)-Number(a.eventSequence||0)),
    'script-comment': storyComments,
  },
  counts: {
    executionRequestEvents: executionRequests.length,
    runEvents: runs.length,
    assetVersionEvents: assetVersions.length,
    episodePlanRevisionEvents: episodePlanRevisions.length,
    episodePlanSubmissionEvents: episodePlanSubmissions.length,
    episodePlanReviewEvents: episodePlanReviews.length,
    episodePlanSourceOperationEvents: episodePlanSourceOperations.length,
    storyCommentEvents: storyComments.length,
    scopedCreativeRevisionEvents:scopedCandidates.length,
    scopedReviewEvents:scopedReviews.length,
    materialReviewEvents:materialReviews.length,
    scopedSourceOperationEvents:scopedOperations.length,
  },
};
const serialized = `${JSON.stringify(bundle)}\n`;
if (Buffer.byteLength(serialized) > 12 * 1024 * 1024) {
  throw new Error('hosted read-only event projection exceeds the 12 MiB compact safety budget');
}
return bundle;
}
