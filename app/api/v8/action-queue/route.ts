import {
  buildActionQueue,
  collapseActionWorkUnits,
  currentWorkCountsFor,
  isPendingReviewCandidate,
  type ActorGroup,
  type ActionActor,
  type ActionQueueItem,
  type Actionability,
  type ActionLane,
  type ActionOwnerModule,
  type ActionWorkstream,
  type PriorityTier,
  type CapabilityLevel,
  type WorkState,
  type WorkType,
} from '../_action-queue';
import { errorResponse, HttpError, jsonResponse, reviewData } from '../_store';

const actors = new Set<ActionActor>(['USER', 'CODEX', 'USER_EXTERNAL', 'HOST_WORKER', 'NONE']);
const actionabilities = new Set<Actionability>(['ACTIONABLE', 'MONITORING', 'WAITING_DEPENDENCY', 'BLOCKED']);
const lanes = new Set<ActionLane>([
  'FORMAL_REVIEW', 'CREATIVE_CONFIRMATION', 'USER_AUTHORIZATION',
  'CODEX_AUTHORING', 'SOURCE_SYNC', 'EXECUTION', 'RESULT_REGISTRATION', 'EXCEPTION', 'DEPENDENCY_WAIT',
]);
const workstreams = new Set<ActionWorkstream>([
  'EPISODE_PLANNING', 'STORY_CONFIRMATION', 'SCENE_COVERAGE', 'SHOT_PLAN_SET', 'SHOT_INPUT_LOCK', 'P07_CALIBRATION',
  'STRUCTURE_AUTHORING', 'MATERIAL_PREP', 'GENERATION', 'EXECUTION_OPERATIONS', 'SOURCE_SYNC', 'EXCEPTION',
]);
const priorityTiers = new Set<PriorityTier>(['MAINLINE', 'PARALLEL', 'SUPPORTING', 'WAITING', 'EXCEPTION']);
const ownerModules = new Set<ActionOwnerModule>(['STORY_CREATION', 'WORLD_AND_MATERIALS', 'FULL_PRODUCTION', 'SYSTEM']);
const workStates = new Set<WorkState>(['READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED']);
const workTypes = new Set<WorkType>(['AUTHORING', 'FORMAL_REVIEW', 'AUTHORIZATION', 'EXECUTION', 'RESULT_REGISTRATION', 'SOURCE_SYNC', 'ISSUE_RESOLUTION']);
type CapableActorFilter = ActorGroup | 'BOTH';
const capableActors = new Set<CapableActorFilter>(['HUMAN', 'AI', 'BOTH', 'AUTOMATION']);
const capabilityLevels = new Set<CapabilityLevel>(['ADVANCE', 'ASSIST']);
function recommendationFrom(item: ActionQueueItem) {
  return {
    actionKey: item.actionKey,
    targetKey: item.targetKey,
    workUnitKey: item.workUnitKey,
    sourceActionKeys: item.sourceActionKeys,
    workState: item.workState,
    workType: item.workType,
    currentAssignee: item.currentAssignee,
    progressCapabilities: item.progressCapabilities,
    workstream: item.workstream,
    ownerModule: item.ownerModule,
    priorityTier: item.priorityTier,
    productionPhaseId: item.productionPhaseId,
    productionGateId: item.productionGateId,
    title: item.title,
    actor: item.actor,
    reasonText: item.reasonText,
    nextActionText: item.nextActionText,
    impactSummary: item.impactSummary,
    navigationIntent: item.navigationIntent,
  };
}

function filteredSummary(items: ActionQueueItem[]) {
  const actionable = (predicate: (item: ActionQueueItem) => boolean) => items.filter((item) => item.actionability === 'ACTIONABLE' && predicate(item)).length;
  const materialRequirementIds = new Set(items.map((item) => item.requirementId).filter(Boolean));
  const pendingReviews = items.filter(isPendingReviewCandidate);
  const reasonIncludes = (item: ActionQueueItem, pattern: RegExp) => item.reasonCodes.some((reason) => pattern.test(reason));
  return {
    actionable: {
      userFormalReview: actionable((item) => item.lane === 'FORMAL_REVIEW' && item.permissions.canSubmitReview === true),
      userCreativeConfirmation: actionable((item) => item.lane === 'CREATIVE_CONFIRMATION' && item.actor === 'USER'),
      userAuthorization: actionable((item) => item.lane === 'USER_AUTHORIZATION' && item.actor === 'USER'),
      userSourceSyncAuthorization: actionable((item) => item.lane === 'SOURCE_SYNC' && item.actor === 'USER'),
      userResultHandling: actionable((item) => ['RESULT_REGISTRATION', 'EXCEPTION'].includes(item.lane) && ['USER', 'USER_EXTERNAL'].includes(item.actor)),
      codexAuthoring: actionable((item) => item.lane === 'CODEX_AUTHORING' && item.actor === 'CODEX'),
      codexExecution: actionable((item) => item.lane === 'EXECUTION' && item.actor === 'CODEX'),
      hostWorker: actionable((item) => item.actor === 'HOST_WORKER'),
    },
    waiting: {
      reviewDependency: pendingReviews.filter((item) => item.actionability !== 'ACTIONABLE').length,
      calibrationReview: items.filter((item) => item.actionability === 'WAITING_DEPENDENCY' && reasonIncludes(item, /P07|CALIBRATION/)).length,
      lockedVideo: items.filter((item) => item.actionability === 'WAITING_DEPENDENCY' && reasonIncludes(item, /P12|LOCKED_VIDEO|PICTURE_LOCK/)).length,
      externalEvidence: items.filter((item) => reasonIncludes(item, /EXTERNAL_EVIDENCE|UNRESOLVED_AFTER_LISTENING/)).length,
    },
    authoring: {
      executionDefinitions: items.filter((item) => item.requiredAction === 'AUTHOR_EXECUTION_DEFINITION').length,
      episodePlanCandidates: items.filter((item) => item.subjectKind === 'EPISODE_PLAN' && ['AUTHOR_EPISODE_PLAN', 'REVISE_EPISODE_PLAN'].includes(item.requiredAction)).length,
      sceneCoverageCandidates: items.filter((item) => item.subjectKind === 'SCENE_COVERAGE' && ['AUTHOR_SCENE_COVERAGE', 'REVISE_SCENE_COVERAGE'].includes(item.requiredAction)).length,
      shotPlanSetCandidates: items.filter((item) => item.subjectKind === 'SHOT_PLAN_SET' && ['AUTHOR_SHOT_PLAN_SET', 'REVISE_SHOT_PLAN_SET'].includes(item.requiredAction)).length,
      structureCandidates: items.filter((item) => item.subjectType === 'STRUCTURE' && item.lane === 'CODEX_AUTHORING').length,
      sceneReauthoring: items.filter((item) => item.subjectType === 'STRUCTURE_SCENE').length,
      structureCards: 0,
    },
    operations: {
      authorized: items.filter((item) => item.requiredAction === 'EXECUTE_AUTHORIZED').length,
      running: items.filter((item) => item.requiredAction === 'MONITOR_RUNNING').length,
      resultRegistration: items.filter((item) => item.lane === 'RESULT_REGISTRATION').length,
      resultUnknown: items.filter((item) => reasonIncludes(item, /RESULT_UNKNOWN/)).length,
    },
    inventory: {
      materialRequirements: materialRequirementIds.size,
      covered: 0,
      uncovered: materialRequirementIds.size,
      pendingReviewCandidates: pendingReviews.length,
    },
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const actor = url.searchParams.get('actor') as ActionActor | null;
    const lane = url.searchParams.get('lane') as ActionLane | null;
    const actionability = url.searchParams.get('actionability') as Actionability | null;
    const workstream = url.searchParams.get('workstream') as ActionWorkstream | null;
    const priorityTier = url.searchParams.get('priorityTier') as PriorityTier | null;
    const ownerModule = url.searchParams.get('ownerModule') as ActionOwnerModule | null;
    const workState = url.searchParams.get('workState') as WorkState | null;
    const workType = url.searchParams.get('workType') as WorkType | null;
    const capableActor = url.searchParams.get('capableActor') as CapableActorFilter | null;
    const capabilityLevel = url.searchParams.get('capabilityLevel') as CapabilityLevel | null;
    const scope = url.searchParams.get('scope');
    if (actor && !actors.has(actor)) throw new HttpError(400, 'actor is invalid');
    if (lane && !lanes.has(lane)) throw new HttpError(400, 'lane is invalid');
    if (actionability && !actionabilities.has(actionability)) throw new HttpError(400, 'actionability is invalid');
    if (workstream && !workstreams.has(workstream)) throw new HttpError(400, 'workstream is invalid');
    if (priorityTier && !priorityTiers.has(priorityTier)) throw new HttpError(400, 'priorityTier is invalid');
    if (ownerModule && !ownerModules.has(ownerModule)) throw new HttpError(400, 'ownerModule is invalid');
    if (workState && !workStates.has(workState)) throw new HttpError(400, 'workState is invalid');
    if (workType && !workTypes.has(workType)) throw new HttpError(400, 'workType is invalid');
    if (capableActor && !capableActors.has(capableActor)) throw new HttpError(400, 'capableActor is invalid');
    if (capabilityLevel && !capabilityLevels.has(capabilityLevel)) throw new HttpError(400, 'capabilityLevel is invalid');
    const [queue, data] = await Promise.all([buildActionQueue(), reviewData()]);
    if (queue.snapshotId !== data.snapshotId) throw new HttpError(409, 'action queue snapshot changed during read');
    if (scope && data.creativeLineage?.storyStructure?.planStatus === 'CURRENT') {
      const displayAlias = data.productionModel.episodes?.find((episode) => (
        [episode.id, episode.displayId].includes(scope)
        && ![episode.canonicalScopeId, episode.episodeUid].includes(scope)
      ));
      if (displayAlias) throw new HttpError(422, 'CURRENT episode scope requires episodeUid; displayId is not a stable identity');
    }
    const items = queue.items
      .filter((item) => !actor || item.actor === actor)
      .filter((item) => !lane || item.lane === lane)
      .filter((item) => !actionability || item.actionability === actionability)
      .filter((item) => !workstream || item.workstream === workstream)
      .filter((item) => !priorityTier || item.priorityTier === priorityTier)
      .filter((item) => !ownerModule || item.ownerModule === ownerModule)
      .filter((item) => !workState || item.workState === workState)
      .filter((item) => !workType || item.workType === workType)
      .filter((item) => {
        if (!capableActor && !capabilityLevel) return true;
        const level = capabilityLevel || 'ADVANCE';
        const matching = item.progressCapabilities.filter((capability) => (
          capability.availability === 'NOW' && capability.level === level
        ));
        if (capableActor === 'BOTH') {
          return matching.some((capability) => capability.actorGroup === 'HUMAN')
            && matching.some((capability) => capability.actorGroup === 'AI');
        }
        return capableActor
          ? matching.some((capability) => capability.actorGroup === capableActor)
          : matching.length > 0;
      })
      .filter((item) => !scope || [item.subjectId, item.workItemId, item.requirementId, item.familyId, item.coordinates.episodeUid, item.coordinates.episodeId, item.coordinates.sceneId, item.coordinates.shotId].includes(scope)
        || item.advisoryRefs.some((ref) => ref.ref === scope));
    const filters = { actor, lane, actionability, workstream, priorityTier, ownerModule, workState, workType, capableActor, capabilityLevel, scope };
    const filtered = Object.values(filters).some(Boolean);
    const workUnits = collapseActionWorkUnits(items);
    if (!filtered) return jsonResponse({
      ...queue,
      items,
      workUnits,
      count: workUnits.length,
      rowCount: items.length,
      workUnitCount: workUnits.length,
      summaryScope: 'GLOBAL',
    }, { headers: { ETag: queue.etag } });
    const mainlineItems = workUnits.filter((item) => item.actionability === 'ACTIONABLE' && item.priorityTier === 'MAINLINE');
    const mainline = mainlineItems[0] || null;
    const parallel = workUnits.filter((item) => item.actionability === 'ACTIONABLE' && item.priorityTier === 'PARALLEL');
    const filteredActionSummary = filteredSummary(items);
    filteredActionSummary.inventory = queue.summary.inventory;
    const filteredWorkCounts = currentWorkCountsFor(items);
    return jsonResponse({
      ...queue,
      items,
      workUnits,
      count: workUnits.length,
      rowCount: items.length,
      workUnitCount: workUnits.length,
      summaryScope: 'FILTERED_ITEMS',
      globalSummary: queue.summary,
      summary: filteredActionSummary,
      recommendations: {
        perspective: 'CREATOR',
        mainline: mainline ? recommendationFrom(mainline) : null,
        parallel: parallel.map(recommendationFrom),
        counts: { mainlineActionable: mainlineItems.length, parallelActionable: parallel.length },
      },
      programs: [],
      journeySummary: null,
      workspaceSummary: queue.workspaceSummary,
      filteredWorkCounts,
      filters,
    }, { headers: { ETag: queue.etag } });
  } catch (reason) {
    return errorResponse(reason, 'action queue is unavailable');
  }
}
