import {projectStoryProgress} from '../../../host/instance-runtime/workspace-projection.mjs';
import { executionRuntimeReason, executionRequestsForRuntimeQueue } from '../../../host/instance-runtime/execution-epoch.mjs';
import { executionEligibilityReasons, configuredProductionProgress } from '../../gate-evaluation';
import { CREATOR_PRODUCTION_STAGES, creatorProductionGateDefinition, creatorProductionStageForGate } from '../../creator-production-workflow';
import { resolveEpisodePlan } from './_episode-plan';
import { projectIdFor, episodePlanIdFor } from '../../instance-profile';
import {
  assertCreativeRevisionBasisCurrent,
  audioVerificationTargets,
  operationalSnapshot,
  recipeCatalog,
  reviewData,
  stableObjectHash,
  storyConfirmationTargets,
  workProductReviewBinding,
  type EventRecord,
} from './_store';
import { materialCreatorStageOptions, projectMaterialCreatorStage, type MaterialCreatorStage } from '../../material-taxonomy';

export type ActionActor = 'USER' | 'CODEX' | 'USER_EXTERNAL' | 'HOST_WORKER' | 'NONE';
export type ActionOwnerModule = 'STORY_CREATION' | 'WORLD_AND_MATERIALS' | 'FULL_PRODUCTION' | 'SYSTEM';
export type Actionability = 'ACTIONABLE' | 'MONITORING' | 'WAITING_DEPENDENCY' | 'BLOCKED';
export type WorkState = 'READY' | 'IN_PROGRESS' | 'WAITING' | 'BLOCKED';
export type WorkType = 'AUTHORING' | 'FORMAL_REVIEW' | 'AUTHORIZATION' | 'EXECUTION' | 'RESULT_REGISTRATION' | 'SOURCE_SYNC' | 'ISSUE_RESOLUTION';
export type ActorGroup = 'HUMAN' | 'AI' | 'AUTOMATION';
export type ActorKind = Exclude<ActionActor, 'NONE'>;
export type CapabilityLevel = 'ADVANCE' | 'ASSIST';
export type CapabilityAvailability = 'NOW' | 'AFTER_AUTHORIZATION' | 'AFTER_DEPENDENCY';
export type ActionWorkstream =
  | 'EPISODE_PLANNING'
  | 'STORY_CONFIRMATION'
  | 'SCENE_COVERAGE'
  | 'SHOT_PLAN_SET'
  | 'SHOT_INPUT_LOCK'
  | 'P07_CALIBRATION'
  | 'STRUCTURE_AUTHORING'
  | 'MATERIAL_PREP'
  | 'GENERATION'
  | 'EXECUTION_OPERATIONS'
  | 'SOURCE_SYNC'
  | 'EXCEPTION';
export type PriorityTier = 'MAINLINE' | 'PARALLEL' | 'SUPPORTING' | 'WAITING' | 'EXCEPTION';
export type ActionLane =
  | 'FORMAL_REVIEW'
  | 'CREATIVE_CONFIRMATION'
  | 'USER_AUTHORIZATION'
  | 'CODEX_AUTHORING'
  | 'SOURCE_SYNC'
  | 'EXECUTION'
  | 'RESULT_REGISTRATION'
  | 'EXCEPTION'
  | 'DEPENDENCY_WAIT';

export type ActionImpactSummary = {
  label: string;
  directUnlockCount: number;
  transitiveUnlockCount: number;
  affectedSceneCount: number;
  affectedShotCount: number;
  affectedWorkItemCount: number;
  conditional: boolean;
};

export type ActionAdvisoryRef = {
  type: 'ACTION' | 'WORK_ITEM' | 'ASSET_VERSION' | 'EXPECTED_OUTPUT' | 'SOURCE' | 'SCENE';
  ref: string;
  label: string;
  href?: string;
  status?: string;
};

export type ActionQueueItem = {
  actionKey: string;
  targetKey: string;
  basisHash: string;
  lane: ActionLane;
  requiredAction: string;
  actionability: Actionability;
  actor: ActionActor;
  workUnitKey: string;
  sourceActionKeys: string[];
  workState: WorkState;
  workType: WorkType;
  currentAssignee: {
    actorGroup: ActorGroup;
    actorKind: ActorKind;
    role: 'REVIEWER' | 'EXTERNAL_EXECUTOR' | 'CODEX' | 'HOST_WORKER';
    source: 'EXECUTION_REQUEST' | 'SOURCE_OPERATION';
    assignmentState: 'CLAIMED_ACTOR' | 'ACTIVE_WORKER';
    evidenceId: string;
    evidenceState: string;
    claimedBy?: string;
  } | null;
  progressCapabilities: Array<{
    actorGroup: ActorGroup;
    actorKind: ActorKind;
    level: CapabilityLevel;
    availability: CapabilityAvailability;
    actionType: WorkType;
    label: string;
    nextActionText: string;
  }>;
  ownerModule: ActionOwnerModule;
  workstream: ActionWorkstream;
  priorityTier: PriorityTier;
  businessOrder: number;
  workflowStep: number | null;
  productionPhaseId: string | null;
  productionGateId: string | null;
  priorityReasonCodes: string[];
  impactSummary: ActionImpactSummary;
  candidateAvailability: 'AVAILABLE' | 'NOT_PRODUCED' | 'EVIDENCE_ONLY' | 'NOT_APPLICABLE' | 'UNKNOWN';
  currentVersionRole: string;
  hardBlockers: Array<Record<string, unknown>>;
  advisoryRefs: ActionAdvisoryRef[];
  subjectType: string;
  subjectKind?: string;
  materialCreatorStage?: MaterialCreatorStage;
  subjectId: string;
  title: string;
  coordinates: { episodeId?: string; episodeUid?: string; sceneId?: string; shotId?: string; workflowStep?: number };
  reasonCodes: string[];
  reasonText: string;
  nextActionText: string;
  unlockText: string;
  dependency: {
    frontier: boolean;
    depth: number;
    blockers: Array<Record<string, unknown>>;
    directUnlockCount: number;
    transitiveUnlockCount: number;
  };
  permissions: {
    canSubmitReview: boolean;
    canAuthorizeCodex: boolean;
    canAuthorizeExternal: boolean;
    canRegisterResult: boolean;
  };
  navigationIntent: { href: string; label: string };
  groupKey: string;
  workItemId?: string;
  requirementId?: string;
  familyId?: string;
  versionId?: string;
  executionRequestId?: string;
  runId?: string;
};

export type ActionRecommendation = Pick<
  ActionQueueItem,
  | 'actionKey'
  | 'targetKey'
  | 'workUnitKey'
  | 'sourceActionKeys'
  | 'workState'
  | 'workType'
  | 'currentAssignee'
  | 'progressCapabilities'
  | 'workstream'
  | 'ownerModule'
  | 'priorityTier'
  | 'productionPhaseId'
  | 'productionGateId'
  | 'title'
  | 'actor'
  | 'reasonText'
  | 'nextActionText'
  | 'impactSummary'
  | 'navigationIntent'
>;

export type CurrentWorkCounts = {
  total: number;
  ready: number;
  inProgress: number;
  waiting: number;
  blocked: number;
  humanCanAdvance: number;
  aiCanAdvance: number;
  humanAndAi: number;
  aiCanAssist: number;
  automation: number;
};

export type WorkspaceMetric = {
  id: string;
  label: string;
  value: number | null;
  denominator: number | null;
  denominatorState: 'KNOWN' | 'UNKNOWN';
  unit: string;
};

export type WorkspaceStageSummary = {
  id: string;
  label: string;
  status: string;
  count: number | null;
  denominator: number | null;
  denominatorState: 'KNOWN' | 'UNKNOWN';
};

export type WorkspaceDomainSummary = {
  id: Exclude<ActionOwnerModule, 'SYSTEM'>;
  label: string;
  status: 'ACTIVE' | 'WAITING' | 'BLOCKED' | 'COMPLETE' | 'UNKNOWN';
  currentGate: string;
  headline: string;
  nextUnlockText: string;
  navigationIntent: ActionQueueItem['navigationIntent'];
  counts: CurrentWorkCounts;
  metrics: WorkspaceMetric[];
  stages: WorkspaceStageSummary[];
};

export type WorkspaceSummary = {
  counts: CurrentWorkCounts;
  domains: WorkspaceDomainSummary[];
  criticalBlockers: Array<{
    workUnitKey: string;
    title: string;
    reasonText: string;
    navigationIntent: ActionQueueItem['navigationIntent'];
  }>;
};

export type ActionProgram = {
  id: 'EPISODE_PLAN' | 'STORY_CONFIRMATION' | 'SCENE_COVERAGE' | 'SHOT_PLAN_SET' | 'SHOT_INPUT_LOCK';
  label: string;
  priorityTier: PriorityTier;
  status: 'ACTIVE' | 'QUEUED' | 'AVAILABLE_PARALLEL' | 'READY' | 'WAITING' | 'BLOCKED' | 'COMPLETE';
  totalCount: number;
  openCount: number;
  actionableCount: number;
  waitingCount: number;
  nextActionKey: string | null;
  summary: string;
};

type RecordMap = Record<string, Record<string, unknown> | undefined>;

type ActionQueueItemInput = Omit<
  ActionQueueItem,
  | 'actionKey'
  | 'basisHash'
  | 'workUnitKey'
  | 'sourceActionKeys'
  | 'workState'
  | 'workType'
  | 'currentAssignee'
  | 'progressCapabilities'
  | 'workstream'
  | 'ownerModule'
  | 'priorityTier'
  | 'businessOrder'
  | 'workflowStep'
  | 'productionPhaseId'
  | 'productionGateId'
  | 'priorityReasonCodes'
  | 'impactSummary'
  | 'candidateAvailability'
  | 'currentVersionRole'
  | 'hardBlockers'
  | 'advisoryRefs'
  | 'groupKey'
> & Partial<Pick<
  ActionQueueItem,
  | 'workstream'
  | 'ownerModule'
  | 'priorityTier'
  | 'businessOrder'
  | 'workflowStep'
  | 'productionPhaseId'
  | 'productionGateId'
  | 'priorityReasonCodes'
  | 'impactSummary'
  | 'candidateAvailability'
  | 'currentVersionRole'
  | 'hardBlockers'
  | 'advisoryRefs'
  | 'groupKey'
>> & { basis: unknown };

function latestAggregate(events: EventRecord[], field: string) {
  const result = new Map<string, EventRecord>();
  for (const event of events) {
    const key = String(event[field] || '');
    if (key && !result.has(key)) result.set(key, event);
  }
  return result;
}

function numericCoordinate(value?: string, position: 'FIRST' | 'LAST' = 'FIRST') {
  const matches = String(value || '').match(/\d+/g) || [];
  const selected = position === 'LAST' ? matches.at(-1) : matches[0];
  return Number(selected || 9999);
}

function coordinateOrder(item: ActionQueueItem) {
  return [
    numericCoordinate(item.coordinates.episodeId),
    numericCoordinate(item.coordinates.sceneId),
    numericCoordinate(item.coordinates.shotId, 'LAST'),
    item.workflowStep ?? 9999,
  ];
}

function sortItems(left: ActionQueueItem, right: ActionQueueItem) {
  const tierRank: Record<PriorityTier, number> = { EXCEPTION: 0, MAINLINE: 1, PARALLEL: 2, SUPPORTING: 3, WAITING: 4 };
  const rank = tierRank[left.priorityTier] - tierRank[right.priorityTier];
  if (rank) return rank;
  if (left.businessOrder !== right.businessOrder) return left.businessOrder - right.businessOrder;
  const actionabilityRank = (entry: ActionQueueItem) => entry.actionability === 'ACTIONABLE' ? 0 : entry.actionability === 'BLOCKED' ? 1 : 2;
  const actionRank = actionabilityRank(left) - actionabilityRank(right);
  if (actionRank) return actionRank;
  if (left.dependency.depth !== right.dependency.depth) return left.dependency.depth - right.dependency.depth;
  if (left.workstream === right.workstream && left.dependency.transitiveUnlockCount !== right.dependency.transitiveUnlockCount) {
    return right.dependency.transitiveUnlockCount - left.dependency.transitiveUnlockCount;
  }
  const l = coordinateOrder(left);
  const r = coordinateOrder(right);
  for (let index = 0; index < l.length; index += 1) if (l[index] !== r[index]) return l[index] - r[index];
  return left.actionKey.localeCompare(right.actionKey);
}

function defaultWorkstream(input: ActionQueueItemInput): ActionWorkstream {
  if (input.subjectKind === 'EPISODE_PLAN') return 'EPISODE_PLANNING';
  if (input.subjectKind === 'SCENE_COVERAGE') return 'SCENE_COVERAGE';
  if (input.subjectKind === 'SHOT_PLAN_SET') return 'SHOT_PLAN_SET';
  if (input.lane === 'EXCEPTION') return 'EXCEPTION';
  if (input.lane === 'CREATIVE_CONFIRMATION') return 'STORY_CONFIRMATION';
  if (input.subjectType === 'STRUCTURE' || input.subjectType === 'STRUCTURE_SCENE') return 'STRUCTURE_AUTHORING';
  if (input.subjectType === 'MATERIAL_REQUIREMENT' || input.subjectType === 'MATERIAL_WORK_ITEM') return 'MATERIAL_PREP';
  if (input.lane === 'USER_AUTHORIZATION') return 'GENERATION';
  if (input.lane === 'SOURCE_SYNC') return 'SOURCE_SYNC';
  return 'EXECUTION_OPERATIONS';
}

function defaultPriorityTier(input: ActionQueueItemInput): PriorityTier {
  if (input.lane === 'EXCEPTION' || input.actionability === 'BLOCKED') return 'EXCEPTION';
  if (input.actionability === 'WAITING_DEPENDENCY' || input.actor === 'NONE') return 'WAITING';
  return 'SUPPORTING';
}

function defaultOwnerModule(input: ActionQueueItemInput, workstream: ActionWorkstream): ActionOwnerModule {
  if (input.subjectKind === 'SHOT_PLAN_SET' || workstream === 'SHOT_PLAN_SET' || workstream === 'SHOT_INPUT_LOCK') return 'FULL_PRODUCTION';
  if (['STRUCTURE', 'STRUCTURE_SCENE', 'CREATIVE_REVISION', 'SCRIPT_SCENE'].includes(input.subjectType)) return 'STORY_CREATION';
  if (['MATERIAL_REQUIREMENT', 'MATERIAL_WORK_ITEM'].includes(input.subjectType)) return 'WORLD_AND_MATERIALS';
  if (workstream === 'STORY_CONFIRMATION' || workstream === 'STRUCTURE_AUTHORING') return 'STORY_CREATION';
  if (workstream === 'MATERIAL_PREP') return 'WORLD_AND_MATERIALS';
  if (input.workItemId || input.subjectType === 'WORK_PRODUCT' || workstream === 'P07_CALIBRATION') return 'FULL_PRODUCTION';
  return 'SYSTEM';
}

const readyRemediationActions = new Set([
  'REBASE_DEPENDENTS',
  'SPLIT_COMPANION_OUTPUT_LIFECYCLES',
  'AUTHOR_REVIEW_CONTEXT',
  'AUTHOR_AUDIO_CORRECTION_SYNC_CONTRACT',
  'INVESTIGATE_RESULT_UNKNOWN',
  'RESOLVE_SOURCE_SYNC_FAILURE',
  'RESOLVE_EXECUTION_FAILURE',
]);

export function workStateFor(input: ActionQueueItemInput): WorkState {
  const basis = asObject(input.basis);
  const request = asObject(basis.request);
  const sourceState = input.subjectType === 'SOURCE_OPERATION'
    ? String(basis.operationState || basis.state || '')
    : '';
  if (['EXECUTE_AUTHORIZED', 'USER_EXTERNAL_EXECUTION'].includes(input.requiredAction)
    && String(request.requestState || request.status || '') === 'CLAIMED') {
    return 'IN_PROGRESS';
  }
  if (['STARTED', 'BUILT', 'DEPLOYED'].includes(sourceState)) return 'IN_PROGRESS';
  if (readyRemediationActions.has(input.requiredAction)) return 'READY';
  if (input.actionability === 'ACTIONABLE') return 'READY';
  if (input.actionability === 'MONITORING') return 'IN_PROGRESS';
  if (input.actionability === 'BLOCKED') return 'BLOCKED';
  return 'WAITING';
}

function workTypeFor(input: ActionQueueItemInput): WorkType {
  if (readyRemediationActions.has(input.requiredAction) || input.lane === 'EXCEPTION') return 'ISSUE_RESOLUTION';
  if (input.lane === 'FORMAL_REVIEW' || input.lane === 'CREATIVE_CONFIRMATION') return 'FORMAL_REVIEW';
  if (input.lane === 'USER_AUTHORIZATION') return 'AUTHORIZATION';
  if (input.lane === 'EXECUTION') return 'EXECUTION';
  if (input.lane === 'RESULT_REGISTRATION') return 'RESULT_REGISTRATION';
  if (input.lane === 'SOURCE_SYNC' || input.workstream === 'SOURCE_SYNC') return 'SOURCE_SYNC';
  if (input.lane === 'CODEX_AUTHORING' || /^(AUTHOR|REVISE)_/.test(input.requiredAction)) return 'AUTHORING';
  if (input.requiredAction === 'WAIT_FOR_DEPENDENCY' && input.candidateAvailability === 'AVAILABLE') return 'FORMAL_REVIEW';
  return 'ISSUE_RESOLUTION';
}

function actorGroupFor(actor: ActorKind): ActorGroup {
  if (actor === 'USER' || actor === 'USER_EXTERNAL') return 'HUMAN';
  if (actor === 'CODEX') return 'AI';
  return 'AUTOMATION';
}

function workUnitKeyFor(input: ActionQueueItemInput) {
  if (input.workItemId) return `WORK_ITEM:${input.workItemId}`;
  if (input.subjectKind) return `${input.subjectKind}:${input.subjectId}`;
  if (input.subjectType === 'SCRIPT_SCENE') return `SCRIPT_SCENE:${input.coordinates.sceneId || input.subjectId}`;
  if (input.requirementId) return `MATERIAL_REQUIREMENT:${input.requirementId}`;
  return input.targetKey;
}

function capabilityLabel(actor: ActorKind, level: CapabilityLevel, availability: CapabilityAvailability) {
  if (level === 'ASSIST') return actor === 'CODEX' ? 'AI辅助' : '人工辅助';
  if (availability === 'AFTER_AUTHORIZATION') return actor === 'CODEX' ? '授权后AI执行' : '授权后人工执行';
  if (availability === 'AFTER_DEPENDENCY') return actor === 'HOST_WORKER' ? '依赖满足后系统自动' : actor === 'CODEX' ? '依赖满足后AI推进' : '依赖满足后人工推进';
  return actor === 'HOST_WORKER' ? '系统自动' : actor === 'CODEX' ? 'AI可推进' : '人可推进';
}

export function advanceAvailabilityFor(
  actionability: Actionability,
  actor: ActionActor,
  requiredAction: string,
): CapabilityAvailability {
  if (actionability === 'ACTIONABLE' || readyRemediationActions.has(requiredAction)) return 'NOW';
  if (actionability === 'MONITORING' && actor === 'HOST_WORKER') return 'NOW';
  return 'AFTER_DEPENDENCY';
}

function progressCapabilitiesFor(
  input: ActionQueueItemInput,
  ownerModule: ActionOwnerModule,
  workType: WorkType,
) {
  const capabilities: ActionQueueItem['progressCapabilities'] = [];
  const currentAvailability = advanceAvailabilityFor(input.actionability, input.actor, input.requiredAction);
  if (input.actor !== 'NONE') {
    const actor = input.actor as ActorKind;
    capabilities.push({
      actorGroup: actorGroupFor(actor),
      actorKind: actor,
      level: 'ADVANCE',
      availability: currentAvailability,
      actionType: workType,
      label: capabilityLabel(actor, 'ADVANCE', currentAvailability),
      nextActionText: input.nextActionText,
    });
  }
  if (input.requiredAction === 'SPLIT_COMPANION_OUTPUT_LIFECYCLES') capabilities.push({
    actorGroup: 'AI', actorKind: 'CODEX', level: 'ADVANCE', availability: 'NOW', actionType: 'ISSUE_RESOLUTION',
    label: 'AI可推进', nextActionText: input.nextActionText,
  });
  if (input.requiredAction === 'REGISTER_CANDIDATE') {
    for (const actor of ['USER_EXTERNAL', 'CODEX'] as const) capabilities.push({
      actorGroup: actorGroupFor(actor),
      actorKind: actor,
      level: 'ADVANCE',
      availability: 'NOW',
      actionType: 'RESULT_REGISTRATION',
      label: capabilityLabel(actor, 'ADVANCE', 'NOW'),
      nextActionText: actor === 'CODEX'
        ? '核对文件、SHA与运行事实并登记一个候选版本'
        : '回传文件与运行事实，登记一个候选版本',
    });
  }
  if (workType === 'AUTHORIZATION') {
    if (input.permissions.canAuthorizeCodex) capabilities.push({
      actorGroup: 'AI', actorKind: 'CODEX', level: 'ADVANCE', availability: 'AFTER_AUTHORIZATION', actionType: 'EXECUTION',
      label: '授权后AI执行', nextActionText: '由Codex按精确调用包执行一次并登记运行事实',
    });
    if (input.permissions.canAuthorizeExternal) capabilities.push({
      actorGroup: 'HUMAN', actorKind: 'USER_EXTERNAL', level: 'ADVANCE', availability: 'AFTER_AUTHORIZATION', actionType: 'EXECUTION',
      label: '授权后人工执行', nextActionText: '由外部人工执行并回传运行与候选事实',
    });
  }
  if ((workType === 'FORMAL_REVIEW' && ownerModule === 'WORLD_AND_MATERIALS') || input.lane === 'CREATIVE_CONFIRMATION') capabilities.push({
    actorGroup: 'AI', actorKind: 'CODEX', level: 'ASSIST', availability: 'NOW', actionType: 'FORMAL_REVIEW',
    label: 'AI辅助', nextActionText: '生成可编辑的辅助审阅建议；不得提交正式裁决',
  });
  return capabilities.filter((capability, index, all) => all.findIndex((candidate) => (
    candidate.actorKind === capability.actorKind
    && candidate.level === capability.level
    && candidate.availability === capability.availability
    && candidate.actionType === capability.actionType
  )) === index);
}

export function eventBackedAssigneeFor(input: ActionQueueItemInput): ActionQueueItem['currentAssignee'] {
  if (input.lane === 'EXECUTION' && input.executionRequestId) {
    const request = asObject(asObject(input.basis).request);
    const evidenceState = String(request.requestState || request.status || '');
    const claimedBy = String(request.claimedBy || '').trim();
    if (evidenceState === 'CLAIMED'
      && (request.executor === 'CODEX' || request.executor === 'USER_EXTERNAL')
      && claimedBy) {
      const externalExecutor = request.executor === 'USER_EXTERNAL';
      return {
        actorGroup: externalExecutor ? 'HUMAN' : 'AI',
        actorKind: externalExecutor ? 'USER_EXTERNAL' : 'CODEX',
        role: externalExecutor ? 'EXTERNAL_EXECUTOR' : 'CODEX',
        source: 'EXECUTION_REQUEST',
        assignmentState: 'CLAIMED_ACTOR',
        evidenceId: String(request.eventId || input.executionRequestId),
        evidenceState,
        claimedBy,
      };
    }
  }
  if (input.subjectType === 'SOURCE_OPERATION') {
    const evidence = asObject(input.basis);
    const evidenceState = String(evidence.operationState || evidence.state || '');
    const claimedBy = String(evidence.assignedWorker || evidence.workerId || evidence.claimedBy || '').trim();
    if (['STARTED', 'BUILT', 'DEPLOYED'].includes(evidenceState) && claimedBy) {
      return {
        actorGroup: 'AUTOMATION',
        actorKind: 'HOST_WORKER',
        role: 'HOST_WORKER',
        source: 'SOURCE_OPERATION',
        assignmentState: 'ACTIVE_WORKER',
        evidenceId: String(evidence.eventId || input.subjectId),
        evidenceState,
        claimedBy,
      };
    }
  }
  return null;
}

function defaultBusinessOrder(input: ActionQueueItemInput, workstream: ActionWorkstream) {
  const coordinate = numericCoordinate(input.coordinates.episodeId) * 10_000
    + numericCoordinate(input.coordinates.sceneId) * 100
    + numericCoordinate(input.coordinates.shotId, 'LAST');
  const base: Record<ActionWorkstream, number> = {
    EPISODE_PLANNING: 50_000,
    STORY_CONFIRMATION: 100_000,
    SCENE_COVERAGE: 200_000,
    SHOT_PLAN_SET: 250_000,
    SHOT_INPUT_LOCK: 275_000,
    P07_CALIBRATION: 300_000,
    STRUCTURE_AUTHORING: 400_000,
    MATERIAL_PREP: 500_000,
    GENERATION: 600_000,
    EXECUTION_OPERATIONS: 700_000,
    SOURCE_SYNC: 800_000,
    EXCEPTION: 0,
  };
  return base[workstream] + coordinate;
}

function item(input: ActionQueueItemInput): ActionQueueItem {
  const basisHash = stableObjectHash(input.basis);
  const { basis: _basis, ...rest } = input;
  void _basis;
  const workstream = input.workstream || defaultWorkstream(input);
  const ownerModule = input.ownerModule || defaultOwnerModule(input, workstream);
  const workType = workTypeFor(input);
  const workState = workStateFor(input);
  const hardBlockers = input.hardBlockers || input.dependency.blockers;
  const workflowStep = input.workflowStep ?? input.coordinates.workflowStep ?? null;
  const actionKey = `${rest.targetKey}::${basisHash}::${rest.requiredAction}`;
  const currentAssignee = eventBackedAssigneeFor(input);
  return {
    ...rest,
    workUnitKey: workUnitKeyFor(input),
    sourceActionKeys: [actionKey],
    workState,
    workType,
    currentAssignee,
    progressCapabilities: progressCapabilitiesFor(input, ownerModule, workType),
    workstream,
    ownerModule,
    priorityTier: input.priorityTier || defaultPriorityTier(input),
    businessOrder: input.businessOrder ?? defaultBusinessOrder(input, workstream),
    workflowStep,
    productionPhaseId: input.productionPhaseId || null,
    productionGateId: input.productionGateId || null,
    priorityReasonCodes: input.priorityReasonCodes || input.reasonCodes,
    impactSummary: input.impactSummary || {
      label: input.unlockText,
      directUnlockCount: input.dependency.directUnlockCount,
      transitiveUnlockCount: input.dependency.transitiveUnlockCount,
      affectedSceneCount: input.coordinates.sceneId ? 1 : 0,
      affectedShotCount: input.coordinates.shotId ? 1 : 0,
      affectedWorkItemCount: input.workItemId ? 1 : 0,
      conditional: input.dependency.directUnlockCount > 0 || input.dependency.transitiveUnlockCount > 0,
    },
    candidateAvailability: input.candidateAvailability || (input.versionId ? 'AVAILABLE' : 'NOT_APPLICABLE'),
    currentVersionRole: input.currentVersionRole || (input.versionId ? 'CURRENT' : 'NOT_APPLICABLE'),
    hardBlockers,
    advisoryRefs: input.advisoryRefs || [],
    groupKey: input.groupKey || `${workstream}:${input.subjectType}`,
    basisHash,
    actionKey,
  };
}

function href(path: string, params: Record<string, string | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `${path}?${query.toString()}`;
}

function asObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function projectedEpisodePlanContent(value: unknown, expectedPlanId: string) {
  const plan = asObject(value);
  if (plan.planId !== expectedPlanId || !Array.isArray(plan.episodes) || !plan.episodes.length) return null;
  const episodes = plan.episodes.map((rawEpisode, index) => {
    const episode = asObject(rawEpisode);
    if (!Array.isArray(episode.sceneIds)) return null;
    const fields = ['episodeUid', 'title', 'openingHook', 'coreAdvance', 'endingCliffhanger', 'reviewQuestion'] as const;
    if (fields.some((field) => typeof episode[field] !== 'string' || !String(episode[field]).trim())) return null;
    if (!episode.reviewDossier || typeof episode.reviewDossier !== 'object' || Array.isArray(episode.reviewDossier)) return null;
    return {
      episodeUid: String(episode.episodeUid).trim(),
      displayId: `E${String(index + 1).padStart(2, '0')}`,
      title: String(episode.title).trim(),
      sceneIds: episode.sceneIds.map(String),
      openingHook: String(episode.openingHook).trim(),
      coreAdvance: String(episode.coreAdvance).trim(),
      endingCliffhanger: String(episode.endingCliffhanger).trim(),
      reviewQuestion: String(episode.reviewQuestion).trim(),
      reviewDossier: episode.reviewDossier,
    };
  });
  if (episodes.some((episode) => !episode)) return null;
  const retiredEpisodeUids = Array.isArray(plan.retiredEpisodeUids)
    ? [...new Set(plan.retiredEpisodeUids.map(String))].sort()
    : [];
  const changeSummary = typeof plan.changeSummary === 'string' ? plan.changeSummary.trim() : '';
  return {
    planId: expectedPlanId,
    episodes,
    retiredEpisodeUids,
    ...(changeSummary ? { changeSummary } : {}),
  };
}

export function exactReviewContextForScope(
  reviewContextRef: string,
  contexts: Array<Record<string, unknown>>,
  scopeType: string,
  scopeId: string,
) {
  const context = contexts.find((entry) => String(entry.id || entry.reviewContextId || '') === reviewContextRef);
  if (!context) return null;
  return String(context.scopeType || '') === scopeType && String(context.scopeId || '') === scopeId ? context : null;
}

/** Reading is not formal review. Never use display aliases or the first scene as a fallback. */
export function exactSceneReadingIntent(plan: ReturnType<typeof resolveEpisodePlan>, sceneId: string) {
  if (!plan?.revisionId || !sceneId) return null;
  const owners = plan.content.episodes.filter((episode) => episode.sceneIds.includes(sceneId));
  if (owners.length !== 1 || !owners[0].episodeUid
    || owners[0].sceneIds.filter((id) => id === sceneId).length !== 1
    || plan.content.episodes.filter((episode) => episode.episodeUid === owners[0].episodeUid).length !== 1
    || plan.content.retiredEpisodeUids.includes(owners[0].episodeUid)) return null;
  return {
    href: href('/', { view: 'story', storyMode: 'logic', narrativeLevel: 'scene', episodePlanRevision: plan.revisionId, episode: owners[0].episodeUid, scene: sceneId, confirmScene: sceneId }),
    label: '查看正文与评论',
    episodeUid: owners[0].episodeUid,
  };
}

export function formalReviewEligibilityReasons(
  work: { additionalOutputAssetRefs?: string[] },
  facts: { hasVersion: boolean; hasReviewSurface: boolean },
) {
  const companionOutputs = Array.isArray(work.additionalOutputAssetRefs)
    ? work.additionalOutputAssetRefs.map(String).filter(Boolean)
    : [];
  const reasons: string[] = [];
  if (companionOutputs.length) reasons.push('COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE');
  if (!facts.hasVersion) reasons.push('REVIEW_VERSION_UNRESOLVED');
  if (!facts.hasReviewSurface) reasons.push('REVIEW_CONTEXT_UNAVAILABLE');
  return reasons;
}

export function latestRunByExecutionRequest(runs: EventRecord[]) {
  // Event streams are newest-first. First collapse transitions of the same run,
  // then keep the newest run for each authorization. Building a Map directly
  // from this array would let an older run overwrite a newer RESULT_UNKNOWN.
  const currentRuns = [...latestAggregate(runs, 'runId').values()];
  return latestAggregate(currentRuns, 'executionRequestId');
}

export function stagedMainlineItems<T>(
  story: T[],
  p07: T[],
  episodePlan: T[] = [],
  sceneCoverage: T[] = [],
  shotPlanSet: T[] = [],
  shotInputLock: T[] = [],
) {
  void p07;
  return episodePlan.length
    ? episodePlan
    : story.length
      ? story
      : sceneCoverage.length
        ? sceneCoverage
        : shotPlanSet.length
          ? shotPlanSet
          : shotInputLock;
}

export function activeProgramIdFor<T>(
  story: T[],
  p07: T[],
  episodePlan: T[] = [],
  sceneCoverage: T[] = [],
  shotPlanSet: T[] = [],
  shotInputLock: T[] = [],
): ActionProgram['id'] | null {
  void p07;
  return episodePlan.length
    ? 'EPISODE_PLAN'
    : story.length
      ? 'STORY_CONFIRMATION'
      : sceneCoverage.length
        ? 'SCENE_COVERAGE'
        : shotPlanSet.length
          ? 'SHOT_PLAN_SET'
          : shotInputLock.length
            ? 'SHOT_INPUT_LOCK'
            : null;
}

export function isReviewLifecycleRepresentation(entry: ActionQueueItem) {
  return entry.requiredAction === 'FORMAL_REVIEW'
    || (entry.subjectType === 'WORK_PRODUCT' && entry.requiredAction === 'WAIT_FOR_DEPENDENCY')
    || entry.requiredAction === 'AUTHOR_REVIEW_CONTEXT'
    || entry.requiredAction === 'SPLIT_COMPANION_OUTPUT_LIFECYCLES';
}

export function isPendingReviewCandidate(entry: ActionQueueItem) {
  return isReviewLifecycleRepresentation(entry)
    && entry.candidateAvailability === 'AVAILABLE'
    && Boolean(entry.versionId);
}

const currentWorkStateRank: Record<WorkState, number> = {
  IN_PROGRESS: 0,
  READY: 1,
  BLOCKED: 2,
  WAITING: 3,
};

function capabilityIdentity(capability: ActionQueueItem['progressCapabilities'][number]) {
  return [
    capability.actorGroup,
    capability.actorKind,
    capability.level,
    capability.availability,
    capability.actionType,
  ].join(':');
}

export function collapseActionWorkUnits(items: ActionQueueItem[]): ActionQueueItem[] {
  const groups = new Map<string, ActionQueueItem[]>();
  for (const entry of items) groups.set(entry.workUnitKey, [...(groups.get(entry.workUnitKey) || []), entry]);
  return [...groups.values()].map((entries) => {
    const representative = entries.reduce((current, candidate) => (
      currentWorkStateRank[candidate.workState] < currentWorkStateRank[current.workState]
        ? candidate
        : current
    ));
    const currentEntries = entries.filter((entry) => entry.workState === representative.workState);
    const capabilities = new Map<string, ActionQueueItem['progressCapabilities'][number]>();
    for (const entry of currentEntries) {
      for (const capability of entry.progressCapabilities) capabilities.set(capabilityIdentity(capability), capability);
    }
    const assignees = new Map<string, NonNullable<ActionQueueItem['currentAssignee']>>();
    for (const entry of currentEntries) {
      if (!entry.currentAssignee) continue;
      const assignee = entry.currentAssignee;
      assignees.set([
        assignee.source,
        assignee.evidenceId,
        assignee.evidenceState,
        assignee.actorKind,
        assignee.claimedBy || '',
      ].join(':'), assignee);
    }
    return {
      ...representative,
      workState: representative.workState,
      sourceActionKeys: [...new Set(entries.flatMap((entry) => [entry.actionKey, ...entry.sourceActionKeys]))],
      progressCapabilities: [...capabilities.values()],
      currentAssignee: assignees.size === 1 ? [...assignees.values()][0] : null,
    };
  });
}

export function currentWorkCountsFor(items: ActionQueueItem[]): CurrentWorkCounts {
  const workUnits = collapseActionWorkUnits(items);
  const counts: CurrentWorkCounts = {
    total: workUnits.length,
    ready: 0,
    inProgress: 0,
    waiting: 0,
    blocked: 0,
    humanCanAdvance: 0,
    aiCanAdvance: 0,
    humanAndAi: 0,
    aiCanAssist: 0,
    automation: 0,
  };
  for (const workUnit of workUnits) {
    const state = workUnit.workState;
    if (state === 'IN_PROGRESS') counts.inProgress += 1;
    else if (state === 'READY') counts.ready += 1;
    else if (state === 'BLOCKED') counts.blocked += 1;
    else counts.waiting += 1;
    const nowAdvancers = workUnit.progressCapabilities.filter((capability) => capability.level === 'ADVANCE' && capability.availability === 'NOW');
    const human = nowAdvancers.some((capability) => capability.actorGroup === 'HUMAN');
    const ai = nowAdvancers.some((capability) => capability.actorGroup === 'AI');
    if (human) counts.humanCanAdvance += 1;
    if (ai) counts.aiCanAdvance += 1;
    if (human && ai) counts.humanAndAi += 1;
    if (workUnit.progressCapabilities.some((capability) => capability.actorGroup === 'AI' && capability.level === 'ASSIST' && capability.availability === 'NOW')) counts.aiCanAssist += 1;
    if (nowAdvancers.some((capability) => capability.actorGroup === 'AUTOMATION')) counts.automation += 1;
  }
  return counts;
}

export async function buildActionQueue() {
  const [data, operations, catalog] = await Promise.all([reviewData(), operationalSnapshot(), recipeCatalog()]);
  const model = data.productionModel;
  const projection = operations.stateProjection as unknown as {
    executionGatesByWorkItem?: Record<string,string[]>;
    configuredGatesByWorkItem?: Record<string,import("../../gate-evaluation").ConfiguredGate>;
    workItemsById: RecordMap;
    materialWorkItemsById: RecordMap;
    assetFamiliesById: RecordMap;
    assetVersionsById: RecordMap;
    materialRequirementsById: RecordMap;
    scopeLocksById?: RecordMap;
    scriptScenesById?: RecordMap;
    verificationsByIssue?: RecordMap;
    structuresById?: RecordMap;
    storyHandoff?: Record<string, unknown>;
  };
  const items: ActionQueueItem[] = [];
  const allWorkItems = [...model.workItems, ...(model.materialWorkItems || [])];
  const reviewContexts = Array.isArray((model as unknown as Record<string, unknown>).reviewContexts)
    ? ((model as unknown as { reviewContexts: Array<Record<string, unknown>> }).reviewContexts)
    : [];
  const reviewContextById = new Map(reviewContexts.map((context) => [String(context.id || context.reviewContextId || ''), context]));
  const sceneById = new Map((model.scenes || []).map((scene) => [scene.id, scene as unknown as Record<string, unknown>]));
  let storyTargets = storyConfirmationTargets(data);
  const audioTargets = audioVerificationTargets(data);
  const scriptSceneProjection = projection.scriptScenesById || {};
  const verificationProjection = projection.verificationsByIssue || {};
  const episodePlanId = episodePlanIdFor(data);
  const staticEpisodePlan = (model.episodePlanRevisions || []).find((entry) => entry.planId === episodePlanId);
  const staticPlanReview = asObject(staticEpisodePlan?.review);
  const staticPlanSync = asObject(staticEpisodePlan?.sync);
  const staticPlanReady = Boolean(
    staticEpisodePlan
    && staticEpisodePlan.scopeRole === 'CURRENT'
    && (staticEpisodePlan.revisionState === 'CURRENT' || staticEpisodePlan.isCurrent === true)
    && ['ADOPTED', 'RELEASED', 'CURRENT'].includes(String(staticPlanReview.state || staticPlanReview.decision || ''))
    && ['SOURCE_CURRENT', 'SUCCEEDED'].includes(String(staticPlanSync.state || '')),
  );
  const planProjection = projection.structuresById?.[`EPISODE_PLAN::${episodePlanId}`];
  const projectedPlanReady = Boolean(
    planProjection?.reviewDecision === 'RELEASED'
    && planProjection?.sourceSyncState === 'SUCCEEDED'
    && planProjection?.canFlowDownstream === true,
  );
  const staticPlanContent = projectedEpisodePlanContent(staticEpisodePlan, episodePlanId);
  const staticPlanContentHash = staticPlanContent ? stableObjectHash(staticPlanContent) : '';
  const staticPlanBaseHash = String(data.creativeLineage?.storyStructure?.sourceSha256 || '').toLowerCase();
  const staticPlanBasisHash = String(staticEpisodePlan?.basisBindingsHash || '').toLowerCase();
  const canonicalSceneOrder = (data.creativeLineage?.scenes || []).map(scene=>scene.id);
  // Use the same default revision as the narrative page. Once any candidate
  // exists, stale evidence must fail closed instead of reviving the seed.
  const latestEpisodePlanCandidate = operations.creativeRevisions.events.find((event) => (
    event.subjectKind === 'EPISODE_PLAN' && event.subjectId === episodePlanId
  ));
  let resolvedEpisodePlan: ReturnType<typeof resolveEpisodePlan> = null;
  let episodePlanResolutionError: string | null = null;
  if (latestEpisodePlanCandidate) {
    try {
      resolvedEpisodePlan = resolveEpisodePlan(data, operations);
    } catch (error) {
      episodePlanResolutionError = error instanceof Error ? error.message : '当前分集方案不可读取';
    }
  }
  const storyProgress=projectStoryProgress(resolvedEpisodePlan,operations.stateProjection.episodeNarrativeReleasesByUid,episodePlanResolutionError);
  const narrativeCandidate = resolvedEpisodePlan?.sourceRole === 'CANDIDATE' ? resolvedEpisodePlan.content.narrativeRevision : undefined;
  const pendingSceneCount = narrativeCandidate?.scenes.length || canonicalSceneOrder.length;
  if (narrativeCandidate) storyTargets = []; // Old scene tasks cannot masquerade as new candidate scenes.
  const episodePlanCandidate = resolvedEpisodePlan?.sourceRole === 'CANDIDATE'
    ? operations.creativeRevisions.events.find((event) => (
        event.subjectKind === 'EPISODE_PLAN' && event.subjectId === episodePlanId
        && event.creativeRevisionId === resolvedEpisodePlan.revisionId
        && event.contentHash === resolvedEpisodePlan.contentHash
      ))
    : undefined;
  let staticProposalBasisCurrent = false;
  try {
    assertCreativeRevisionBasisCurrent(data, projection, {
      subjectKind: 'EPISODE_PLAN',
      subjectId: episodePlanId,
      baseRevisionHash: staticPlanBaseHash,
      basisBindings: staticEpisodePlan?.basisBindings,
      basisBindingsHash: staticPlanBasisHash,
    });
    staticProposalBasisCurrent = true;
  } catch {
    staticProposalBasisCurrent = false;
  }
  const hasCurrentStoryScenes = canonicalSceneOrder.length > 0;
  const episodePlanBasisAvailable = hasCurrentStoryScenes && Boolean(episodePlanCandidate || (
    /^[a-f0-9]{64}$/.test(staticPlanBaseHash)
    && /^[a-f0-9]{64}$/.test(staticPlanBasisHash)
    && staticProposalBasisCurrent
  ));
  const staticProposalReviewable = Boolean(
    staticEpisodePlan
    && staticEpisodePlan.scopeRole === 'PROPOSAL'
    && staticEpisodePlan.revisionState === 'PROPOSAL'
    && staticEpisodePlan.isCurrentProposal === true
    && staticPlanContent
    && staticPlanContent.episodes.flatMap((episode) => episode?.sceneIds || []).join('|') === canonicalSceneOrder.join('|')
    && /^[a-f0-9]{64}$/.test(staticPlanBaseHash)
    && /^[a-f0-9]{64}$/.test(staticPlanBasisHash)
    && staticProposalBasisCurrent,
  );
  const candidateId = String(episodePlanCandidate?.creativeRevisionId || episodePlanCandidate?.revisionId || '');
  const immutableCandidateReview = candidateId
    ? (operations.reviews.events as EventRecord[]).find((event) => (
        ['2.0', '2.1', '2.2'].includes(String(event.schemaVersion || ''))
        && event.effect === 'APPLIED'
        && event.applicationStatus === 'APPLIED'
        && ['CREATIVE_REVISION', 'STRUCTURE'].includes(String(event.subjectType || ''))
        && event.subjectKind === 'EPISODE_PLAN'
        && event.subjectId === episodePlanId
        && (event.subjectRevisionId || event.creativeRevisionId) === candidateId
        && event.subjectRevisionHash === episodePlanCandidate?.contentHash
      ))
    : undefined;
  const canonicalCandidateReview = immutableCandidateReview?.subjectType === 'CREATIVE_REVISION'
    ? immutableCandidateReview
    : undefined;
  const candidateDecision = String(canonicalCandidateReview?.reviewDecision || '');
  const projectedCandidateReady = Boolean(
    projectedPlanReady
    && candidateId
    && planProjection?.subjectRevisionId === candidateId
    && planProjection?.subjectRevisionHash === episodePlanCandidate?.contentHash
    && canonicalCandidateReview?.action === 'APPROVE_AND_RELEASE'
    && candidateDecision === 'RELEASED',
  );
  const episodePlanReady = staticPlanReady || projectedCandidateReady;
  const openStorySceneIds = storyTargets
    .map((target) => String(target.sceneId || target.subjectId || ''))
    .filter((sceneId) => sceneId && scriptSceneProjection[sceneId]?.reviewDecision !== 'RELEASED');
  const storyConfirmationOpen = openStorySceneIds.length > 0;
  const p07PriorityTier: PriorityTier = 'SUPPORTING';
  const creativeRevisionEvents = operations.creativeRevisions.events as EventRecord[];
  const sceneCoverageTemplates = (model.sceneCoveragePlanRevisions || []) as Array<Record<string, unknown>>;
  const shotPlanSetTemplates = (model.shotPlanSetRevisions || []) as Array<Record<string, unknown>>;
  let completedSceneCoverageCount = 0;
  let completedShotPlanSetCount = 0;
  const versionById = new Map(model.assetVersions.map((version) => [version.id, version]));
  for (const event of operations.candidates.events as EventRecord[]) {
    const versionId = String(event.versionId || '');
    if (versionId) versionById.set(versionId, event as never);
  }
  const p07WorkItems = model.workItems.filter((work) => work.pipelineStageCode === 'P07' && work.outputAssetRef);
  const p07OwnerByFamily = new Map(p07WorkItems.map((work) => [String(work.outputAssetRef), work]));
  const children = new Map<string, string[]>();
  for (const work of p07WorkItems) {
    for (const familyId of work.inputAssetRefs || []) {
      const parent = p07OwnerByFamily.get(familyId);
      if (!parent) continue;
      children.set(parent.id, [...(children.get(parent.id) || []), work.id]);
    }
  }
  const transitiveUnlockCount = (workItemId: string, visited = new Set<string>()): number => {
    if (visited.has(workItemId)) return 0;
    const next = new Set(visited).add(workItemId);
    return (children.get(workItemId) || []).reduce((sum, child) => sum + 1 + transitiveUnlockCount(child, next), 0);
  };

  // An empty desk has no formal authoring object yet. Missing source bindings
  // are prerequisites, not evidence that an agent can author a reviewable plan.
  if (episodePlanResolutionError) {
    const revisionId = String(latestEpisodePlanCandidate?.creativeRevisionId || latestEpisodePlanCandidate?.revisionId || '');
    const blockers = [{ reasonCode: 'EPISODE_PLAN_CONTEXT_UNAVAILABLE', revisionId, reason: episodePlanResolutionError }];
    items.push(item({
      targetKey: `CREATIVE_REVISION:EPISODE_PLAN:${episodePlanId}`,
      lane: 'EXCEPTION', requiredAction: 'RESOLVE_EPISODE_PLAN_BINDING', actionability: 'BLOCKED', actor: 'NONE',
      ownerModule: 'STORY_CREATION', workstream: 'EPISODE_PLANNING', priorityTier: 'MAINLINE', businessOrder: 50_000,
      workflowStep: null, subjectType: 'CREATIVE_REVISION', subjectKind: 'EPISODE_PLAN', subjectId: episodePlanId,
      title: '全剧分集方案 · 当前候选不可读取', coordinates: {},
      reasonCodes: ['EPISODE_PLAN_CONTEXT_UNAVAILABLE'],
      reasonText: `当前分集候选已过期或不可读取：${episodePlanResolutionError}`,
      nextActionText: '打开该候选核对具体原因，重新绑定当前依据后登记完整的新候选',
      unlockText: '候选与当前依据一致后，才能继续该分集方案审阅',
      candidateAvailability: 'AVAILABLE', currentVersionRole: 'STALE_CANDIDATE', hardBlockers: blockers,
      advisoryRefs: [], dependency: { frontier: false, depth: 0, blockers, directUnlockCount: 0, transitiveUnlockCount: 0 },
      permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
      navigationIntent: { href: href('/', { view: 'story', storyMode: 'logic', episodePlan: episodePlanId, episodePlanRevision: revisionId }), label: '查看当前分集候选不可读取原因' },
      basis: { snapshotId: data.snapshotId, latestEpisodePlanCandidate, episodePlanResolutionError },
    }));
  } else if ((!episodePlanReady || episodePlanCandidate && !projectedCandidateReady) && episodePlanBasisAvailable) {
    const waitingSourceSync = Boolean(
      episodePlanCandidate
      && canonicalCandidateReview
      && canonicalCandidateReview.action === 'APPROVE_AND_RELEASE'
      && candidateDecision === 'RELEASED',
    );
    const needsNewCandidate = (!episodePlanCandidate && !staticProposalReviewable) || Boolean(immutableCandidateReview && !waitingSourceSync);
    const directProposalReview = staticProposalReviewable && !episodePlanCandidate;
    const requiredAction = needsNewCandidate
      ? episodePlanCandidate ? 'REVISE_EPISODE_PLAN' : 'AUTHOR_EPISODE_PLAN'
      : waitingSourceSync ? 'EXECUTE_SOURCE_SYNC' : 'FORMAL_REVIEW';
    const lane: ActionLane = needsNewCandidate ? 'CODEX_AUTHORING' : waitingSourceSync ? 'SOURCE_SYNC' : 'FORMAL_REVIEW';
    const actor: ActionActor = needsNewCandidate ? 'CODEX' : waitingSourceSync ? 'HOST_WORKER' : 'USER';
    items.push(item({
      targetKey: `CREATIVE_REVISION:EPISODE_PLAN:${episodePlanId}`,
      lane,
      requiredAction,
      actionability: 'ACTIONABLE',
      actor,
      ownerModule: 'STORY_CREATION',
      workstream: 'EPISODE_PLANNING',
      priorityTier: 'MAINLINE',
      businessOrder: 50_000,
      workflowStep: null,
      subjectType: 'CREATIVE_REVISION',
      subjectKind: 'EPISODE_PLAN',
      subjectId: episodePlanId,
      title: '全剧分集方案 · 当前主线',
      coordinates: {},
      reasonCodes: [needsNewCandidate
        ? episodePlanCandidate ? 'EPISODE_PLAN_REVISION_REQUIRED' : 'EPISODE_PLAN_CANDIDATE_REQUIRED'
        : waitingSourceSync ? 'EPISODE_PLAN_SOURCE_SYNC_REQUIRED' : 'EPISODE_PLAN_FORMAL_REVIEW_REQUIRED'],
      reasonText: needsNewCandidate
        ? episodePlanCandidate
          ? '当前展示方案的候选已有不可变正式裁决，必须先作者化新内容。'
          : '当前全剧分集基线不符合可直接审阅契约，需先补齐方案。'
        : waitingSourceSync
          ? '分集方案已经通过正式审阅，但权威源同步尚未成功。'
          : directProposalReview
            ? '当前静态PROPOSAL已具备完整审阅条件；首次单集提交会先精确固化所展示方案。每集六项判断只登记为REVIEW_INPUT_ONLY，全部分集当前头齐全后由服务端汇总唯一全剧正式裁决。'
            : '分集方案候选已固化；逐集提交六项判断后，可独立确认本集正文并放行。未变分集可明确沿用原提交；其他集待审不阻断已放行集。',
      nextActionText: needsNewCandidate
        ? '准备覆盖全部当前场次且exact-once的新分集方案内容'
        : waitingSourceSync ? '在localhost主机工作器中显式apply受控源同步，并等待SUCCEEDED证明' : '提交本集六项判断，再明确确认本集正文并放行',
      unlockText: '本集放行并受控同步后，本集各场可以独立进入镜头拆解；全剧汇总仍单独核验',
      candidateAvailability: episodePlanCandidate ? 'AVAILABLE' : 'NOT_PRODUCED',
      currentVersionRole: episodePlanCandidate ? 'CANDIDATE' : 'PROPOSAL_BASE_ONLY',
      hardBlockers: [],
      advisoryRefs: staticEpisodePlan?.sourcePath ? [{ type: 'SOURCE', ref: String(staticEpisodePlan.sourcePath), label: '当前分集导航提案', status: String(staticEpisodePlan.scopeRole || 'PROPOSAL') }] : [],
      dependency: { frontier: true, depth: 0, blockers: [], directUnlockCount: pendingSceneCount, transitiveUnlockCount: pendingSceneCount },
      permissions: { canSubmitReview: requiredAction === 'FORMAL_REVIEW', canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
      navigationIntent: { href: href('/', { view: 'story', storyMode: 'logic', episodePlan: episodePlanId, episodePlanRevision: resolvedEpisodePlan?.revisionId || String(staticEpisodePlan?.id || '') }), label: needsNewCandidate ? '查看分集方案返修要求' : waitingSourceSync ? '查看源同步要求' : '打开分集方案审阅' },
      basis: {
        snapshotId: data.snapshotId,
        staticEpisodePlan,
        staticProposalReviewable,
        staticPlanContentHash,
        episodePlanCandidate,
        immutableCandidateReview,
        planProjection,
      },
    }));
  }

  const seenEpisodeReviews=new Set<string>();
  for(const review of operations.reviews.events as EventRecord[]){
    if(review.subjectType!=='EPISODE_NARRATIVE')continue;
    const uid=String(review.episodeUid||'');if(seenEpisodeReviews.has(uid))continue;seenEpisodeReviews.add(uid);
    if(review.action!=='APPROVE_AND_RELEASE'||(operations.sourceOperations.events as EventRecord[]).some(e=>e.reviewEventId===review.eventId&&e.operationState==='SUCCEEDED'))continue;
    const revisionId=String(review.creativeRevisionId||'');
    if(revisionId!==String(latestEpisodePlanCandidate?.creativeRevisionId||''))continue;
    items.push(item({
      targetKey:`EPISODE_NARRATIVE:${uid}`,lane:'SOURCE_SYNC',requiredAction:'EXECUTE_SOURCE_SYNC',actionability:'ACTIONABLE',actor:'HOST_WORKER',
      ownerModule:'STORY_CREATION',workstream:'EPISODE_PLANNING',priorityTier:'MAINLINE',businessOrder:55_000,workflowStep:null,
      subjectType:'EPISODE_NARRATIVE',subjectKind:'EPISODE_NARRATIVE',subjectId:uid,title:'本集叙事已放行 · 待受控同步',coordinates:{episodeUid:uid},
      reasonCodes:['EPISODE_NARRATIVE_SOURCE_SYNC_REQUIRED'],reasonText:'本集已正式通过；源同步尚未完成，其他集不参与本次门禁。',
      nextActionText:'使用本集精确审阅事件预览并执行实例受控源同步',unlockText:'仅本集场景进入镜头拆解，不采用全剧方案或代作场级审阅',
      dependency:{frontier:true,depth:0,blockers:[],directUnlockCount:0,transitiveUnlockCount:0},
      permissions:{canSubmitReview:false,canAuthorizeCodex:false,canAuthorizeExternal:false,canRegisterResult:false},
      navigationIntent:{href:href('/',{view:'story',storyMode:'logic',episodePlanRevision:revisionId,episodeUid:uid}),label:'查看本集同步凭证'},basis:review,
    }));
  }

  const addCreativeRevisionAction = (
    subjectKind: 'SCENE_COVERAGE' | 'SHOT_PLAN_SET',
    template: Record<string, unknown>,
    priorityTier: PriorityTier,
  ) => {
    const subjectId = String(template.planId || template.id || '');
    const sceneId = String(template.sceneId || template.scopeId || '');
    if (!subjectId || !sceneId) return false;
    const candidate = creativeRevisionEvents.find((event) => (
      event.subjectKind === subjectKind && event.subjectId === subjectId
    ));
    const candidateId = String(candidate?.creativeRevisionId || candidate?.revisionId || '');
    const currentProjection = projection.structuresById?.[`${subjectKind}::${subjectId}`];
    const exactProjection = candidateId && currentProjection?.subjectRevisionId === candidateId
      ? currentProjection
      : undefined;
    let candidateBindsCurrentBasis = false;
    if (candidate) {
      try {
        assertCreativeRevisionBasisCurrent(data, projection, candidate);
        candidateBindsCurrentBasis = true;
      } catch {
        candidateBindsCurrentBasis = false;
      }
    }
    const decision = String(exactProjection?.reviewDecision || '');
    const sourceSyncSucceeded = decision === 'RELEASED'
      && exactProjection?.sourceSyncState === 'SUCCEEDED'
      && exactProjection?.canFlowDownstream === true;
    if (sourceSyncSucceeded) return true;

    const needsNewCandidate = !candidate
      || !candidateBindsCurrentBasis
      || ['REVISION_REQUIRED', 'DO_NOT_USE'].includes(decision);
    const needsSourceSync = Boolean(candidate && decision === 'RELEASED');
    const requiredAction = needsNewCandidate
      ? candidate ? `REVISE_${subjectKind}` : `AUTHOR_${subjectKind}`
      : needsSourceSync ? 'EXECUTE_SOURCE_SYNC' : 'FORMAL_REVIEW';
    const lane: ActionLane = needsNewCandidate ? 'CODEX_AUTHORING' : needsSourceSync ? 'SOURCE_SYNC' : 'FORMAL_REVIEW';
    const actor: ActionActor = needsNewCandidate ? 'CODEX' : needsSourceSync ? 'HOST_WORKER' : 'USER';
    const episodeId = String(template.episodeUid || sceneById.get(sceneId)?.episodeUid || sceneById.get(sceneId)?.episodeId || '');
    const isCoverage = subjectKind === 'SCENE_COVERAGE';
    const subjectLabel = isCoverage ? '场级镜头意图' : '正式镜头计划';
    const downstreamLabel = isCoverage ? '对应场的正式镜头计划' : '镜头设计与输入锁定';
    items.push(item({
      targetKey: `CREATIVE_REVISION:${subjectKind}:${subjectId}`,
      lane,
      requiredAction,
      actionability: 'ACTIONABLE',
      actor,
      ownerModule: template.episodeNarrativeReleaseId ? 'FULL_PRODUCTION' : isCoverage ? 'STORY_CREATION' : 'FULL_PRODUCTION',
      workstream: subjectKind,
      priorityTier,
      businessOrder: (isCoverage ? 200_000 : 250_000)
        + numericCoordinate(episodeId) * 1_000
        + numericCoordinate(sceneId),
      workflowStep: null,
      productionPhaseId: isCoverage ? null : 'PREVIS',
      productionGateId: isCoverage ? null : 'SHOT_PLAN_INPUT_LOCK',
      subjectType: 'CREATIVE_REVISION',
      subjectKind,
      subjectId,
      title: `${sceneId} · ${subjectLabel}`,
      coordinates: { episodeId: episodeId || undefined, ...(template.episodeUid ? {episodeUid:String(template.episodeUid)} : {}), sceneId },
      reasonCodes: [needsNewCandidate
        ? candidate ? `${subjectKind}_REVISION_REQUIRED` : `${subjectKind}_CANDIDATE_REQUIRED`
        : needsSourceSync ? `${subjectKind}_SOURCE_SYNC_REQUIRED` : `${subjectKind}_FORMAL_REVIEW_REQUIRED`],
      reasonText: needsNewCandidate
        ? `${sceneId}${subjectLabel}尚无可正式审阅的当前候选。`
        : needsSourceSync
          ? `${sceneId}${subjectLabel}已经通过正式审阅，但权威源同步尚未成功。`
          : `${sceneId}${subjectLabel}候选已登记，必须绑定当前候选完成正式审阅。`,
      nextActionText: needsNewCandidate
        ? `${candidate ? '按修改结论重建' : '创建并登记'}${sceneId}${subjectLabel}候选`
        : needsSourceSync
          ? '在localhost主机工作器中显式apply受控源同步，并等待SUCCEEDED证明'
          : '打开当前候选并提交CREATIVE_REVISION正式审阅结论',
      unlockText: `源同步成功后解锁${downstreamLabel}`,
      candidateAvailability: candidate ? 'AVAILABLE' : 'NOT_PRODUCED',
      currentVersionRole: needsSourceSync
        ? 'RELEASED_PENDING_SOURCE_SYNC'
        : candidate ? decision || 'CANDIDATE' : 'EXPECTED_OUTPUT',
      hardBlockers: [],
      advisoryRefs: [
        { type: 'SCENE', ref: sceneId, label: `${sceneId} 当前业务范围`, status: 'CURRENT' },
        ...(template.sourcePath
          ? [{ type: 'SOURCE' as const, ref: String(template.sourcePath), label: `${subjectLabel}权威模板`, status: String(template.scopeRole || 'PROPOSAL') }]
          : []),
      ],
      dependency: {
        frontier: true,
        depth: 0,
        blockers: [],
        directUnlockCount: 1,
        transitiveUnlockCount: 1,
      },
      permissions: {
        canSubmitReview: requiredAction === 'FORMAL_REVIEW',
        canAuthorizeCodex: false,
        canAuthorizeExternal: false,
        canRegisterResult: false,
      },
      navigationIntent: template.episodeNarrativeReleaseId ? {href:href('/',{view:'pipeline',creatorStage:'shot-breakdown',preparationEpisode:episodeId,preparationScene:sceneId}),label:`打开${subjectLabel}`} : isCoverage
        ? { href: href('/', { view: 'story', storyMode: 'audit', confirmScene: sceneId, creativeRevision: subjectId }), label: `打开${subjectLabel}` }
        : {
            href: href('/', {
              view: 'pipeline',
              productionPhase: 'previs',
              productionGate: 'shot-plan-input-lock',
              productionScope: 'SCENE',
              productionObject: sceneId,
              creativeRevision: subjectId,
            }),
            label: `打开${subjectLabel}`,
          },
      basis: { snapshotId: data.snapshotId, template, candidate, exactProjection },
    }));
    return false;
  };

  {
    for (const coverage of sceneCoverageTemplates) {
      const sceneId = String(coverage.sceneId || coverage.scopeId || '');
      const scopedReady = (projection.storyHandoff?.sceneReleaseById as Record<string,{canCreateSceneCoverage?:boolean}> | undefined)?.[sceneId]?.canCreateSceneCoverage === true;
      if (!sceneId || !(scopedReady || episodePlanReady && scriptSceneProjection[sceneId]?.reviewDecision === 'RELEASED')) continue;
      const completed = addCreativeRevisionAction(
        'SCENE_COVERAGE',
        coverage,
        storyConfirmationOpen ? 'PARALLEL' : 'MAINLINE',
      );
      if (!completed) continue;
      completedSceneCoverageCount += 1;
      const shotPlan = shotPlanSetTemplates.find((entry) => String(entry.sceneId || entry.scopeId || '') === sceneId);
      if (!shotPlan) continue;
      const shotPlanCompleted = addCreativeRevisionAction(
        'SHOT_PLAN_SET',
        shotPlan,
        storyConfirmationOpen ? 'PARALLEL' : 'MAINLINE',
      );
      if (shotPlanCompleted) completedShotPlanSetCount += 1;
    }
  }

  const shotInputLockItems = model.workItems.filter((work) => (
    work.activeInCurrentProduction === true
    && work.activityRole === 'CURRENT_PRODUCTION'
    && work.gateId === 'SHOT_PLAN_INPUT_LOCK'
    && work.deliverableKey === 'SHOT_INPUT_LOCK'
    && work.scopeType === 'SHOT'
    && typeof work.shotId === 'string'
    && Boolean(work.shotId)
    && projection.workItemsById[work.id]?.activeInCurrentProduction === true
    && projection.workItemsById[work.id]?.scopeRole === 'CURRENT'
    && projection.workItemsById[work.id]?.shotPlanCurrentBindingState === 'CURRENT'
  ));
  for (const work of shotInputLockItems) {
    const state = projection.workItemsById[work.id] || work;
    if (state.canFlowDownstream === true || state.lifecycleState === 'RELEASED') continue;
    const shotId = String(work.shotId || work.scopeId || '');
    const sceneId = String(work.sceneId || '');
    const episodeId = String(work.episodeId || '');
    const packageRecord = model.workPackages.find((record) => (record.workItemRefs || []).includes(work.id));
    items.push(item({
      targetKey: `SHOT_INPUT_LOCK:${work.id}`,
      lane: 'CODEX_AUTHORING',
      requiredAction: 'AUTHOR_SHOT_INPUT_LOCK',
      actionability: 'ACTIONABLE',
      actor: 'CODEX',
      ownerModule: 'FULL_PRODUCTION',
      workstream: 'SHOT_INPUT_LOCK',
      priorityTier: storyConfirmationOpen ? 'PARALLEL' : 'MAINLINE',
      businessOrder: 300_000 + numericCoordinate(episodeId) * 1_000 + numericCoordinate(sceneId) * 10 + numericCoordinate(shotId),
      workflowStep: null,
      productionPhaseId: 'PREVIS',
      productionGateId: 'SHOT_PLAN_INPUT_LOCK',
      subjectType: 'SHOT_INPUT_LOCK',
      subjectId: work.id,
      workItemId: work.id,
      title: `${shotId} · 完成逐镜输入锁定`,
      coordinates: { episodeId: episodeId || undefined, sceneId, shotId },
      reasonCodes: ['SHOT_EXACT_INPUT_LOCK_REQUIRED'],
      reasonText: '正式ShotSpec与场级镜头分母已建立；当前仍缺剧本修订、采用素材版本哈希及LOC/STATE/ZONE/CAM/FREEZE等逐镜精确绑定。',
      nextActionText: '在镜头设计与输入锁定门禁补齐并核对本镜全部精确输入',
      unlockText: '全部字段精确锁定后，才可进入粗分镜／对白并行；当前不会生成或放行任何素材。',
      candidateAvailability: 'NOT_APPLICABLE',
      currentVersionRole: 'SHOT_SPEC_CURRENT_INPUTS_READY_TO_LOCK',
      hardBlockers: [],
      advisoryRefs: [
        { type: 'WORK_ITEM', ref: work.id, label: `${shotId} 输入锁定前沿`, status: String(state.lifecycleState || 'READY_TO_START') },
      ],
      dependency: {
        frontier: true,
        depth: 0,
        blockers: [],
        directUnlockCount: 1,
        transitiveUnlockCount: 1,
      },
      permissions: {
        canSubmitReview: false,
        canAuthorizeCodex: false,
        canAuthorizeExternal: false,
        canRegisterResult: false,
      },
      navigationIntent: {
        href: href('/', {
          view: 'pipeline',
          productionPhase: 'previs',
          productionGate: 'shot-plan-input-lock',
          productionScope: 'SCENE',
          productionObject: sceneId,
          scene: sceneId,
          shot: shotId,
          workPackage: packageRecord?.id,
          item: work.id,
        }),
        label: '打开逐镜输入锁定',
      },
      basis: {
        snapshotId: data.snapshotId,
        workItemId: work.id,
        shotPlanSetRevisionId: work.shotPlanSetRevisionId,
        shotPlanSetRevisionHash: work.shotPlanSetRevisionHash,
        planningBasisBindingsHash: work.planningBasisBindingsHash,
      },
    }));
  }

  for (const work of p07WorkItems) {
    const state = projection.workItemsById[work.id] || {};
    if (state.lifecycleState !== 'REVIEW_PENDING') continue;
    const family = work.outputAssetRef ? projection.assetFamiliesById[work.outputAssetRef] : null;
    const versionId = String(family?.currentVersionId || family?.decisionVersionId || '');
    const version = versionById.get(versionId) as Record<string, unknown> | undefined;
    const blockers = Array.isArray(state.reviewBlockers) ? state.reviewBlockers as Array<Record<string, unknown>> : [];
    const reviewActionability = String(state.reviewActionability || 'WAITING_DEPENDENCY');
    const actionability: Actionability = reviewActionability === 'ACTIONABLE'
      ? 'ACTIONABLE'
      : reviewActionability === 'BLOCKED'
        ? 'BLOCKED'
        : 'WAITING_DEPENDENCY';
    const requiresRebase = blockers.some((blocker) => blocker.reasonCode === 'UPSTREAM_VERSION_REBASE_REQUIRED');
    const targetKey = `WORK_PRODUCT:${work.id}`;
    const directUnlockCount = (children.get(work.id) || []).length;
    items.push(item({
      targetKey,
      lane: requiresRebase ? 'CODEX_AUTHORING' : actionability === 'ACTIONABLE' ? 'FORMAL_REVIEW' : 'DEPENDENCY_WAIT',
      requiredAction: requiresRebase ? 'REBASE_DEPENDENTS' : actionability === 'ACTIONABLE' ? 'FORMAL_REVIEW' : 'WAIT_FOR_DEPENDENCY',
      actionability,
      actor: requiresRebase ? 'CODEX' : actionability === 'ACTIONABLE' ? 'USER' : 'NONE',
      workstream: 'P07_CALIBRATION',
      priorityTier: requiresRebase ? 'EXCEPTION' : actionability === 'ACTIONABLE' ? p07PriorityTier : 'WAITING',
      workflowStep: 2,
      priorityReasonCodes: [
        actionability === 'ACTIONABLE'
          ? 'LEGACY_P07_EVIDENCE_ONLY'
          : requiresRebase ? 'P07_UPSTREAM_VERSION_REBASE_REQUIRED' : 'P07_WAITING_PREVIOUS_SHOT',
      ],
      subjectType: 'WORK_PRODUCT',
      subjectId: work.id,
      workItemId: work.id,
      familyId: work.outputAssetRef || undefined,
      versionId: versionId || undefined,
      title: `${work.shotId || work.id} · 粗分镜正式审阅`,
      coordinates: { episodeId: work.episodeId || undefined, sceneId: work.sceneId || undefined, shotId: work.shotId || undefined, workflowStep: 2 },
      reasonCodes: blockers.length ? blockers.map((blocker) => String(blocker.reasonCode || 'UPSTREAM_BLOCKED')) : ['CURRENT_FILE_SHA_REVIEW_PENDING'],
      reasonText: requiresRebase
        ? '当前候选仍绑定旧前镜版本，需要先判断换绑或重生。'
        : actionability === 'ACTIONABLE'
          ? '当前文件、SHA和业务上下文有效，且所有前镜已满足。'
          : `等待${blockers.map((blocker) => String(blocker.familyId || blocker.workItemId || '前镜')).join('、')}通过并放行。`,
      nextActionText: requiresRebase ? '核对输入版本并创建换绑或重生方案' : actionability === 'ACTIONABLE' ? '打开原件并提交一次正式结论' : '等待前镜结论',
      unlockText: directUnlockCount ? `满足其他门禁后可潜在释放${directUnlockCount}个直接后继；整条链还有${transitiveUnlockCount(work.id)}个后继` : '完成本场当前链条末端',
      impactSummary: {
        label: directUnlockCount
          ? `满足其他门禁后，可潜在释放${directUnlockCount}个直接后继、${transitiveUnlockCount(work.id)}个链路后继`
          : '当前为本场粗分镜链条末端',
        directUnlockCount,
        transitiveUnlockCount: transitiveUnlockCount(work.id),
        affectedSceneCount: 1,
        affectedShotCount: directUnlockCount,
        affectedWorkItemCount: directUnlockCount,
        conditional: directUnlockCount > 0,
      },
      candidateAvailability: versionId && version?.sha256 && version?.outputState === 'PRESENT' ? 'AVAILABLE' : 'UNKNOWN',
      currentVersionRole: String(version?.historyRole || (versionId ? 'CURRENT' : 'NOT_APPLICABLE')),
      hardBlockers: blockers,
      advisoryRefs: versionId ? [{ type: 'ASSET_VERSION', ref: versionId, label: `${versionId} 当前候选`, status: String(version?.historyRole || 'CURRENT') }] : [],
      dependency: {
        frontier: actionability === 'ACTIONABLE',
        depth: Number(state.reviewDependencyDepth || 0),
        blockers,
        directUnlockCount,
        transitiveUnlockCount: transitiveUnlockCount(work.id),
      },
      permissions: {
        canSubmitReview: actionability === 'ACTIONABLE',
        canAuthorizeCodex: false,
        canAuthorizeExternal: false,
        canRegisterResult: false,
      },
      navigationIntent: {
        href: href('/', { view: 'pipeline', scene: work.sceneId, shot: work.shotId, item: work.id, family: work.outputAssetRef, version: versionId }),
        label: actionability === 'ACTIONABLE' ? '打开正式审阅' : '查看依赖链',
      },
      basis: { snapshotId: data.snapshotId, workItemId: work.id, versionId, state, blockers },
    }));
  }

  // P07 adds an ordered review frontier, but it is not the only reviewable
  // lifecycle. Every other registered candidate must remain discoverable. A
  // candidate whose scope-specific review context is not yet supported stays
  // visible as a blocked exception instead of disappearing from the desk.
  const materialWorkItemIds = new Set((model.materialWorkItems || []).map((work) => work.id));
  for (const work of allWorkItems) {
    if (work.pipelineStageCode === 'P07') continue;
    const materialWorkItem = materialWorkItemIds.has(work.id);
    const state = materialWorkItem
      ? projection.materialWorkItemsById[work.id] || {}
      : projection.workItemsById[work.id] || {};
    if (state.lifecycleState !== 'REVIEW_PENDING') continue;
    const outputFamilyId = String(work.outputAssetRef || '');
    const family = outputFamilyId ? projection.assetFamiliesById[outputFamilyId] : null;
    const versionId = String(family?.decisionVersionId || family?.currentVersionId || '');
    const version = versionId ? projection.assetVersionsById[versionId] : null;
    const requirement = materialWorkItem
      ? (model.materialRequirements || []).find((entry) => entry.id === work.requirementRef)
      : null;
    const workPackage = !materialWorkItem
      ? model.workPackages.find((entry) => entry.workItemRefs?.includes(work.id))
      : null;
    const workRecord = work as unknown as Record<string, unknown>;
    const packageRecord = workPackage as unknown as Record<string, unknown> | null;
    const reviewBinding = !materialWorkItem && workPackage
      ? workProductReviewBinding(data, work.id, workPackage.id)
      : null;
    const reviewContextRef = String(reviewBinding?.reviewContextRef || workRecord.reviewContextRef || packageRecord?.reviewContextRef || '');
    const declaredReviewContext = reviewContextRef ? reviewContextById.get(reviewContextRef) : undefined;
    const expectedScopeType = String(reviewBinding?.reviewScopeType || packageRecord?.scopeType || workRecord.scopeType || (work.shotId ? 'SHOT' : work.sceneId ? 'SCENE' : work.episodeId ? 'EPISODE' : 'PROJECT'));
    const expectedScopeId = String(reviewBinding?.reviewScopeId || packageRecord?.scopeId || workRecord.scopeId || work.shotId || work.sceneId || work.episodeId || projectIdFor(model));
    const exactReviewContext = Boolean(reviewBinding?.reviewable && reviewBinding.semanticStatus !== 'UNKNOWN_STALE_BINDING');
    const legacyShotReviewContext = !reviewContextRef && Boolean(work.shotId && workPackage);
    const hasVersion = Boolean(versionId && version?.sha256 && version?.outputState === 'PRESENT');
    const hasReviewSurface = materialWorkItem ? Boolean(requirement) : exactReviewContext || legacyShotReviewContext;
    const companionOutputs = !Array.isArray(work.additionalOutputAssetRefs)
      ? []
      : work.additionalOutputAssetRefs.map(String).filter(Boolean);
    const configuredReasons = projection.configuredGatesByWorkItem?.[work.id]?.entryReasons || [];
    const eligibilityReasons = [...formalReviewEligibilityReasons(work, { hasVersion, hasReviewSurface }), ...configuredReasons];
    const actionable = eligibilityReasons.length === 0;
    const subjectType = materialWorkItem ? (outputFamilyId ? 'ASSET' : 'MATERIAL_WORK_ITEM') : 'WORK_PRODUCT';
    const subjectId = materialWorkItem && outputFamilyId ? outputFamilyId : work.id;
    const reasonCodes = actionable
      ? ['CURRENT_FILE_SHA_REVIEW_PENDING']
      : configuredReasons.length ? configuredReasons
      : companionOutputs.length
        ? ['COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE']
        : [
            !hasVersion
              ? 'REVIEW_VERSION_UNRESOLVED'
              : reviewContextRef && declaredReviewContext && !exactReviewContext
                ? 'REVIEW_CONTEXT_SCOPE_MISMATCH'
                : 'REVIEW_CONTEXT_UNAVAILABLE',
          ];
    items.push(item({
      targetKey: `${subjectType}:${subjectId}`,
      lane: actionable ? 'FORMAL_REVIEW' : configuredReasons.length || companionOutputs.length ? 'DEPENDENCY_WAIT' : 'EXCEPTION',
      requiredAction: actionable ? 'FORMAL_REVIEW' : configuredReasons.length ? 'WAIT_FOR_DEPENDENCY' : companionOutputs.length ? 'SPLIT_COMPANION_OUTPUT_LIFECYCLES' : 'AUTHOR_REVIEW_CONTEXT',
      actionability: actionable ? 'ACTIONABLE' : configuredReasons.length || companionOutputs.length ? 'WAITING_DEPENDENCY' : 'BLOCKED',
      actor: actionable ? 'USER' : configuredReasons.length || companionOutputs.length ? 'NONE' : 'CODEX',
      workstream: materialWorkItem ? 'MATERIAL_PREP' : 'EXECUTION_OPERATIONS',
      subjectType,
      subjectId,
      workItemId: work.id,
      requirementId: requirement?.id,
      familyId: outputFamilyId || undefined,
      versionId: versionId || undefined,
      title: `${work.shotId || work.sceneId || work.episodeId || work.outputAssetRef} · ${actionable ? '正式审阅' : configuredReasons.length ? '等待配置依赖' : companionOutputs.length ? '多输出闭环待拆分' : '待补审阅上下文'}`,
      coordinates: {
        episodeId: work.episodeId || undefined,
        sceneId: work.sceneId || undefined,
        shotId: work.shotId || undefined,
        workflowStep: Number(String(work.workflowStepId || '').match(/\d+/)?.[0] || 0) || undefined,
      },
      reasonCodes,
      reasonText: actionable
        ? '候选文件与SHA已登记，当前对象已进入唯一正式审阅生命周期。'
        : configuredReasons.length ? '本对象绑定的前置检查或上游门禁尚未满足。'
        : companionOutputs.length
          ? `主输出候选已登记，但当前工作项还有${companionOutputs.length}个伴随计划交付物未拆成独立版本与审阅闭环；不能用一次主输出审阅冒充整包齐套。`
        : !hasVersion
          ? '工作项显示待审，但当前决策版本或SHA投影无法解析。'
          : '候选已存在，但缺少与对象类型匹配的场／分集／全剧审阅上下文，不能用任意镜头冒充。',
      nextActionText: actionable ? '打开原件并提交一次正式结论' : configuredReasons.length ? '完成本对象配置要求的前置工作' : companionOutputs.length ? '先为伴随交付物建立独立版本、候选登记与审阅闭环' : '补齐当前作用域的叙事目的、连续性和通过后果',
      unlockText: actionable ? '根据结论释放下游、进入返修或禁用' : configuredReasons.length ? '依赖满足后重新计算放行资格' : companionOutputs.length ? '所有交付物均有独立生命周期后，才开放正式提交' : '审阅上下文完整后才能开放正式提交',
      candidateAvailability: hasVersion ? 'AVAILABLE' : 'UNKNOWN',
      currentVersionRole: String(version?.historyRole || (versionId ? 'CURRENT' : 'UNKNOWN')),
      hardBlockers: actionable ? [] : companionOutputs.length
        ? companionOutputs.map((familyId) => ({ reasonCode: 'COMPANION_OUTPUT_LIFECYCLE_MISSING', familyId }))
        : [{ reasonCode: reasonCodes[0] }],
      advisoryRefs: [
        ...(versionId ? [{ type: 'ASSET_VERSION' as const, ref: versionId, label: `${versionId} 当前审阅对象`, status: String(version?.historyRole || 'CURRENT') }] : []),
        ...(reviewContextRef ? [{ type: 'SOURCE' as const, ref: reviewContextRef, label: `${expectedScopeType} ${expectedScopeId} 审阅上下文`, status: exactReviewContext ? 'SCOPE_MATCHED' : 'SCOPE_MISMATCH' }] : []),
        ...companionOutputs.map((familyId) => ({ type: 'EXPECTED_OUTPUT' as const, ref: familyId, label: `${familyId} 伴随交付物`, status: 'INDEPENDENT_LIFECYCLE_REQUIRED' })),
      ],
      dependency: {
        frontier: actionable,
        depth: 0,
        blockers: actionable ? [] : companionOutputs.length
          ? companionOutputs.map((familyId) => ({ reasonCode: 'COMPANION_OUTPUT_LIFECYCLE_MISSING', familyId }))
          : [{ reasonCode: reasonCodes[0] }],
        directUnlockCount: 0,
        transitiveUnlockCount: 0,
      },
      permissions: { canSubmitReview: actionable, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
      navigationIntent: materialWorkItem && requirement
        ? { href: href('/', { view: 'materials', materialMode: 'classification', material: requirement.id, family: outputFamilyId, version: versionId }), label: '打开素材正式审阅' }
        : workPackage && hasReviewSurface
          ? (() => {
              const anchorShotId = work.shotId || workPackage.shotIds?.[0] || '';
              const anchorShot = model.shots?.find((shot) => shot.id === anchorShotId);
              return {
                href: href('/', {
                  view: 'pipeline',
                  scene: work.sceneId || anchorShot?.sceneId,
                  shot: anchorShotId,
                  work: workPackage.id,
                  item: work.id,
                  family: outputFamilyId,
                  version: versionId,
                }),
                label: '打开制作正式审阅',
              };
            })()
          : outputFamilyId
            ? { href: href('/', { view: 'materials', materialMode: 'classification', family: outputFamilyId, version: versionId }), label: '在素材详情查看候选与缺口' }
            : { href: href('/', { view: materialWorkItem ? 'materials' : 'overview', materialMode: materialWorkItem ? 'classification' : null, workArea: materialWorkItem ? null : 'EXCEPTION', item: work.id }), label: '查看待补资产绑定' },
      basis: { snapshotId: data.snapshotId, work, state, family, versionId, requirementId: requirement?.id, workPackageId: workPackage?.id, reviewContextRef, expectedScopeType, expectedScopeId, exactReviewContext },
    }));
  }

  // The ordinary scene form has been retired. Resolve only a reading destination
  // through the narrative page's exact revision resolver; keep historical gates.
  let sceneReadingPlan = resolvedEpisodePlan;
  if (!latestEpisodePlanCandidate && storyTargets.length) {
    try { sceneReadingPlan = resolveEpisodePlan(data, operations); } catch { sceneReadingPlan = null; }
  }
  for (const target of storyTargets) {
    const sceneId = String(target.sceneId || target.subjectId || '');
    const current = scriptSceneProjection[sceneId];
    if (current?.reviewDecision === 'RELEASED') continue;
    const needsAuthoring = current?.reviewDecision === 'REVISION_REQUIRED';
    const forbidden = current?.reviewDecision === 'DO_NOT_USE';
    const waitsForEpisodePlan = !episodePlanReady;
    const readingIntent = exactSceneReadingIntent(sceneReadingPlan, sceneId);
    const impactScope = asObject(target.affectedDownstreamRefs);
    const episodeIds = Array.isArray(impactScope.episodeIds) ? impactScope.episodeIds.map(String) : [];
    const shotIds = Array.isArray(impactScope.shotIds) ? impactScope.shotIds.map(String) : [];
    const workItemIds = Array.isArray(impactScope.workItemIds) ? impactScope.workItemIds.map(String) : [];
    const episodeId = episodeIds[0] || String(sceneById.get(sceneId)?.episodeId || '');
    const episodeOrdinal = Number(episodeId.match(/\d+/)?.[0] || 9999);
    const sceneOrdinal = Number(sceneId.match(/\d+/)?.[0] || 9999);
    items.push(item({
      targetKey: `SCRIPT_SCENE:${sceneId}`,
      lane: waitsForEpisodePlan ? 'DEPENDENCY_WAIT' : needsAuthoring ? 'CODEX_AUTHORING' : forbidden ? 'EXCEPTION' : 'DEPENDENCY_WAIT',
      requiredAction: waitsForEpisodePlan ? 'WAIT_FOR_EPISODE_PLAN' : needsAuthoring ? 'AUTHOR_SOURCE_REVISION' : forbidden ? 'RESOLVE_FORBIDDEN_SCENE' : 'WAIT_FOR_SCRIPT_SCENE_CONFIRMATION',
      actionability: waitsForEpisodePlan ? 'WAITING_DEPENDENCY' : forbidden ? 'BLOCKED' : needsAuthoring ? 'ACTIONABLE' : 'WAITING_DEPENDENCY',
      actor: waitsForEpisodePlan ? 'NONE' : needsAuthoring ? 'CODEX' : 'NONE',
      workstream: 'STORY_CONFIRMATION',
      priorityTier: waitsForEpisodePlan ? 'WAITING' : forbidden ? 'EXCEPTION' : 'MAINLINE',
      businessOrder: 100_000 + episodeOrdinal * 1_000 + sceneOrdinal,
      workflowStep: null,
      priorityReasonCodes: [waitsForEpisodePlan ? 'EPISODE_PLAN_PRECEDES_SCENE_REVIEW' : needsAuthoring ? 'STORY_REVISION_BLOCKS_CURRENT_SCENE' : forbidden ? 'STORY_SCENE_FORBIDDEN' : 'STORY_LOCK_PRECEDES_SOURCE_AND_PRODUCTION_REVIEW'],
      subjectType: 'SCRIPT_SCENE',
      subjectId: sceneId,
      title: `${sceneId} · 当前场正文`,
      coordinates: { episodeId: episodeId || undefined, episodeUid: readingIntent?.episodeUid, sceneId },
      reasonCodes: waitsForEpisodePlan ? ['CURRENT_SYNCED_EPISODE_PLAN_REQUIRED'] : needsAuthoring ? ['SCRIPT_SCENE_REVISION_REQUIRED'] : forbidden ? ['SCRIPT_SCENE_DO_NOT_USE'] : ['REWRITTEN_SCENE_UNCONFIRMED'],
      reasonText: waitsForEpisodePlan ? '全剧分集方案尚未正式采用并完成权威源同步，场正文上游门禁保持关闭。' : needsAuthoring ? '创作者已要求修改当前场景版本。' : forbidden ? '当前场景版本已被禁止采用，需项目级处理。' : '当前正文尚无正式采用结论；独立场正式审阅入口已下线，阅读与评论不替代该结论。',
      nextActionText: waitsForEpisodePlan ? '先完成全剧分集方案整体审阅与源同步；正文仅供阅读与评论' : needsAuthoring ? '按审阅说明修改权威剧本并生成新场景哈希' : forbidden ? '决定替代版本或撤销下游依赖' : readingIntent ? '查看本场正文与评论；正式采用缺项及下游阻断继续保留' : '本场与分集版本的精确归属尚不可解析；不跳转其他场次',
      unlockText: '正文阅读与评论不产生正式采用或下游解锁',
      impactSummary: {
        label: shotIds.length || workItemIds.length
          ? `采用当前场景后，${shotIds.length}个镜头坐标和${workItemIds.length}个工作项可基于同一正文哈希继续判断`
          : '采用当前场景后，可稳定后续结构与素材消费判断',
        directUnlockCount: 0,
        transitiveUnlockCount: 0,
        affectedSceneCount: 1,
        affectedShotCount: shotIds.length,
        affectedWorkItemCount: workItemIds.length,
        conditional: true,
      },
      candidateAvailability: 'NOT_APPLICABLE',
      currentVersionRole: 'CURRENT_SCRIPT_REVISION',
      hardBlockers: waitsForEpisodePlan ? [{ reasonCode: 'CURRENT_SYNCED_EPISODE_PLAN_REQUIRED', subjectId: episodePlanId }] : forbidden ? [{ reasonCode: 'SCRIPT_SCENE_DO_NOT_USE', sceneId }] : needsAuthoring ? [] : [{ reasonCode: 'SCRIPT_SCENE_CONFIRMATION_REQUIRED', sceneId }],
      advisoryRefs: [
        ...(target.scriptPath ? [{ type: 'SOURCE' as const, ref: String(target.scriptPath), label: `${sceneId} 当前剧本正文`, status: 'CURRENT' }] : []),
        { type: 'SCENE' as const, ref: sceneId, label: `${sceneId}获批后重新作者化粗分镜与对白`, status: 'WAITING_REAUTHORING' },
      ],
      dependency: { frontier: !waitsForEpisodePlan && !forbidden && needsAuthoring, depth: waitsForEpisodePlan || !needsAuthoring ? 1 : 0, blockers: waitsForEpisodePlan ? [{ reasonCode: 'CURRENT_SYNCED_EPISODE_PLAN_REQUIRED', subjectId: episodePlanId }] : !needsAuthoring && !forbidden ? [{ reasonCode: 'SCRIPT_SCENE_CONFIRMATION_REQUIRED', sceneId }] : [], directUnlockCount: 0, transitiveUnlockCount: 0 },
      permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
      navigationIntent: readingIntent ? { href: readingIntent.href, label: readingIntent.label } : { href: href('/', { view: 'overview', workArea: 'STORY_CREATION' }), label: '正文定位待补齐' },
      basis: { target, current, sceneReadingRevisionId: sceneReadingPlan?.revisionId || null, sceneReadingContentHash: sceneReadingPlan?.contentHash || null, sceneReadingEpisodeUid: readingIntent?.episodeUid || null, sceneReviewSurface: 'UNAVAILABLE' },
    }));
  }

  for (const target of audioTargets) {
    const issueId = String(target.issueId || target.subjectId || '');
    const current = verificationProjection[issueId];
    const targetSceneIds = Array.isArray(target.affectedSceneIds) ? target.affectedSceneIds.map(String) : [];
    const primarySceneId = String(target.primaryReviewSceneId || targetSceneIds[0] || '') || undefined;
    const primaryEpisodeId = primarySceneId
      ? String(sceneById.get(primarySceneId)?.episodeId || '') || undefined
      : undefined;
    if (current?.outcome !== 'CORRECTED') continue;
    items.push(item({
        targetKey: `AUDIO_SOURCE:${issueId}`,
        lane: 'EXCEPTION',
        requiredAction: 'AUTHOR_AUDIO_CORRECTION_SYNC_CONTRACT',
        actionability: 'BLOCKED',
        actor: 'CODEX',
        workstream: 'SOURCE_SYNC',
        priorityTier: 'EXCEPTION',
        businessOrder: 800_000 + Number(issueId.match(/\d+/)?.[0] || 9999),
        workflowStep: null,
        priorityReasonCodes: ['VERIFIED_CORRECTION_REQUIRES_CONTROLLED_SOURCE_SYNC_CONTRACT'],
        subjectType: 'AUDIO_SOURCE',
        subjectId: issueId,
        title: `${issueId} · 回听修正待受控同步契约`,
        coordinates: { episodeId: primaryEpisodeId, sceneId: primarySceneId },
        reasonCodes: ['VERIFICATION_CORRECTION_PENDING_SOURCE_SYNC'],
        reasonText: '回听修正已记录，但当前SourceOperation尚无绑定VerificationEvent和权威逐字稿路径的可执行契约，不能假称可授权。',
        nextActionText: '先补齐精确差异、旧／新SHA、路径白名单和恢复点契约',
        unlockText: '契约和受控工作器齐备后才能由用户显式apply',
        impactSummary: {
          label: `影响${targetSceneIds.length}个场次的文本事实；受控同步完成前保持原权威源不变`,
          directUnlockCount: 0,
          transitiveUnlockCount: 0,
          affectedSceneCount: targetSceneIds.length,
          affectedShotCount: 0,
          affectedWorkItemCount: 0,
          conditional: true,
        },
        candidateAvailability: 'NOT_APPLICABLE',
        currentVersionRole: 'VERIFICATION_RECORDED',
        hardBlockers: [{ reasonCode: 'AUDIO_CORRECTION_SYNC_CONTRACT_MISSING', issueId }],
        advisoryRefs: targetSceneIds.map((sceneId) => ({ type: 'SCENE', ref: sceneId, label: `${sceneId} 受核验结论影响`, status: 'IMPACT_SCOPE' })),
        dependency: { frontier: false, depth: 0, blockers: [{ reasonCode: 'AUDIO_CORRECTION_SYNC_CONTRACT_MISSING' }], directUnlockCount: 0, transitiveUnlockCount: 0 },
        permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
        navigationIntent: { href: href('/', { view: 'story', storyMode: 'audit', auditBeat: Array.isArray(target.beatIds) ? String(target.beatIds[0] || '') : '', verifyIssue: issueId }), label: '查看已记录修正' },
        basis: { target, current },
    }));
  }

  const materialWaitCounts = { definitions: 0, calibration: 0, lockedVideo: 0 };
  const materialHardBlockedWorkIds = new Set<string>();
  for (const work of model.materialWorkItems || []) {
    const state = projection.materialWorkItemsById[work.id] || {};
    if (state.lifecycleState === 'RELEASED' || state.lifecycleState === 'SATISFIED_BY_EXISTING') continue;
    if (state.lifecycleState === 'REVIEW_PENDING') continue;
    const gate = String(work.declaredExecutionGate || '');
    const requirementId = String(work.requirementRef || '');
    const requirement = (model.materialRequirements || []).find((candidate) => candidate.id === requirementId);
    if (!requirement || String(requirement.requirementClass || 'REQUIRED') !== 'REQUIRED') continue;
    const creatorStage = projectMaterialCreatorStage({
      lifecycleState: String(state.lifecycleState || work.lifecycleState || 'UNKNOWN'),
      executionRequestState: typeof state.executionRequestState === 'string' ? state.executionRequestState : null,
      requirementClass: String(requirement?.requirementClass || 'REQUIRED'),
      flowBlockReasons: Array.isArray(state.flowBlockReasons) ? state.flowBlockReasons : work.flowBlockReasons,
      executionBlockReasons: work.executionBlockReasons,
      executionGate: state.executionGate || work.declaredExecutionGate,
    });
    let actor: ActionActor = 'NONE';
    let lane: ActionLane = 'DEPENDENCY_WAIT';
    let requiredAction = 'WAIT_FOR_DEPENDENCY';
    let actionability: Actionability = 'WAITING_DEPENDENCY';
    const workRecord = work as unknown as Record<string, unknown>;
    const workSceneIds = [
      ...(work.sceneId ? [work.sceneId] : []),
      ...(Array.isArray(workRecord.sceneIds) ? workRecord.sceneIds.map(String) : []),
    ];
    const requiredSceneIds = Array.isArray(workRecord.requiredSceneConfirmationIds)?workRecord.requiredSceneConfirmationIds.map(String):(workRecord.requiresSceneConfirmation === true ? workSceneIds : []);
    const rule: {groupKey?:string}|undefined=requiredSceneIds.length?{groupKey:requiredSceneIds.join('_')}:undefined;
    const waitingSceneIds = gate === 'WAITING_EXECUTION_DEFINITION' ? requiredSceneIds.filter(sceneId=>scriptSceneProjection[sceneId]?.reviewDecision !== 'RELEASED') : [];
    const waitsForSceneConfirmation = waitingSceneIds.length > 0;
    const reasonCode = waitsForSceneConfirmation ? 'SCRIPT_SCENE_CONFIRMATION_REQUIRED' : gate || 'WAITING_UPSTREAM';
    const dependencyBlockers = waitsForSceneConfirmation
      ? [{
          reasonCode: 'SCRIPT_SCENE_CONFIRMATION_REQUIRED',
          subjectType: 'SCRIPT_SCENE',
          subjectId: waitingSceneIds[0],
          text: `先确认${waitingSceneIds.join('、')}当前正文哈希，再补本轮新增素材的执行定义。`,
        }]
      : gate === 'WAITING_EXECUTION_DEFINITION' ? [] : [{ reasonCode }];
    const executionBlockCodes = creatorStage.creatorStageReasonCodes.length
      ? creatorStage.creatorStageReasonCodes
      : [creatorStage.sourceLifecycleState === 'UNKNOWN' ? 'MATERIAL_STATE_EVIDENCE_INCOMPLETE' : creatorStage.sourceLifecycleState];
    const criticalExecutionBlock = creatorStage.executionBlocked && (
      !['WAITING_UPSTREAM', 'READY_TO_START', 'REVISION_REQUIRED', 'DO_NOT_USE'].includes(creatorStage.sourceLifecycleState)
      || executionBlockCodes.some(code => /RIGHTS|RESULT_UNKNOWN|EXECUTION_FAILED|SAFETY|UNDERAGE|MINOR/.test(code))
    );
    const blockers = creatorStage.executionBlocked
      ? executionBlockCodes.map((code) => ({ reasonCode: code }))
      : dependencyBlockers;
    let nextAction = '等待上游完成';
    if (criticalExecutionBlock) {
      materialHardBlockedWorkIds.add(work.id);
      lane = 'EXCEPTION'; requiredAction = 'RESOLVE_MATERIAL_BLOCKER'; actionability = 'BLOCKED';
      nextAction = creatorStage.creatorStageNextStep || '先核查当前状态与门禁证据，不得生成或重试';
    } else if (gate === 'WAITING_EXECUTION_DEFINITION') {
      materialWaitCounts.definitions += 1;
      if (waitsForSceneConfirmation) {
        nextAction = `先完成${waitingSceneIds.join('、')}当前正文的正式确认`;
      } else {
        actor = 'CODEX'; lane = 'CODEX_AUTHORING'; requiredAction = 'AUTHOR_EXECUTION_DEFINITION'; actionability = 'ACTIONABLE'; nextAction = '补齐输出资产族、附件、完整Prompt和固定文件名';
      }
    } else if (gate === 'HOLD_P07_CALIBRATION') {
      materialWaitCounts.calibration += 1;
      nextAction = '等待粗分镜校准全部正式放行';
    } else if (gate === 'WAIT_P12') {
      materialWaitCounts.lockedVideo += 1;
      nextAction = '等待锁定视频时间线';
    } else if (creatorStage.executionBlocked) {
      lane = 'EXCEPTION';
      requiredAction = 'RESOLVE_MATERIAL_BLOCKER';
      actionability = 'BLOCKED';
      nextAction = creatorStage.creatorStageNextStep || '先补齐可核验的阻断原因';
    } else continue;
    items.push(item({
      targetKey: `MATERIAL_REQUIREMENT:${requirementId || work.id}`,
      lane,
      requiredAction,
      actionability,
      actor,
      workstream: 'MATERIAL_PREP',
      priorityTier: waitsForSceneConfirmation ? 'WAITING' : undefined,
      priorityReasonCodes: [waitsForSceneConfirmation ? 'MATERIAL_DEFINITION_REQUIRES_SCENE_CONFIRMATION' : reasonCode],
      subjectType: 'MATERIAL_REQUIREMENT',
      subjectId: requirementId || work.id,
      workItemId: work.id,
      requirementId: requirementId || undefined,
      familyId: work.outputAssetRef || undefined,
      title: `${work.outputAssetRef || requirementId || work.id} · ${criticalExecutionBlock ? '素材阻断' : gate === 'WAITING_EXECUTION_DEFINITION' ? '补执行定义' : gate === 'HOLD_P07_CALIBRATION' ? '等待粗分镜校准' : gate === 'WAIT_P12' ? '等待锁镜' : '素材阻断'}`,
      coordinates: { episodeId: work.episodeId || undefined, sceneId: work.sceneId || workSceneIds[0] || undefined, shotId: work.shotId || undefined },
      reasonCodes: creatorStage.executionBlocked
        ? executionBlockCodes
        : [reasonCode],
      reasonText: creatorStage.executionBlocked
        ? creatorStage.creatorStageDetail
        : waitsForSceneConfirmation
        ? `当前新增素材需求真实存在，但${waitingSceneIds.join('、')}正文尚未正式采用，不能提前固化执行定义。`
        : gate === 'WAITING_EXECUTION_DEFINITION' ? '当前需求真实存在，但还没有可调用的完整执行定义。' : gate === 'HOLD_P07_CALIBRATION' ? '声音母版等待粗分镜校准结论。' : '动作同步声音与配乐必须等待锁定画面。',
      nextActionText: nextAction,
      unlockText: creatorStage.executionBlocked
        ? '解除全部硬门禁后重新计算当前素材阶段'
        : gate === 'WAITING_EXECUTION_DEFINITION' ? '完成定义后重新计算用户生成授权资格' : '上游完成后自动回到资格计算',
      hardBlockers: blockers,
      advisoryRefs: waitsForSceneConfirmation ? waitingSceneIds.map(sceneId=>({type:'SCENE' as const,ref:sceneId,label:`${sceneId}当前正文`,status:'CONFIRMATION_REQUIRED'})) : [],
      dependency: { frontier: actionability === 'ACTIONABLE', depth: gate === 'WAITING_EXECUTION_DEFINITION' && !waitsForSceneConfirmation ? 0 : 1, blockers, directUnlockCount: 0, transitiveUnlockCount: 0 },
      permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
      navigationIntent: { href: href('/', { view: 'materials', materialMode: 'classification', material: requirementId, family: work.outputAssetRef }), label: creatorStage.executionBlocked ? '查看阻断依据' : gate === 'WAITING_EXECUTION_DEFINITION' ? '查看定义缺口' : '查看等待依据' },
      groupKey: gate === 'WAITING_EXECUTION_DEFINITION' ? rule?.groupKey : undefined,
      basis: { work, state, sceneReviewDecision: waitsForSceneConfirmation ? scriptSceneProjection[waitingSceneIds[0]]?.reviewDecision || 'REVIEW_PENDING' : null },
    }));
  }

  const definitions = new Map(catalog.executionDefinitions.map((definition) => [definition.id, definition]));
  const activeRequestByWork = new Map((operations.executionRequests.current as EventRecord[])
    .filter((event) => ['AUTHORIZED', 'CLAIMED'].includes(String(event.requestState || event.status || '')))
    .map((event) => [String(event.workItemId || ''), event]));
  const currentRequestIds = new Set((operations.executionRequests.current as EventRecord[])
    .map((event) => String(event.executionRequestId || ''))
    .filter(Boolean));
  const currentRunEvents = [...latestAggregate(operations.runs.events as EventRecord[], 'runId').values()]
    .filter((event) => currentRequestIds.has(String(event.executionRequestId || '')));
  const runByRequest = latestRunByExecutionRequest(operations.runs.events as EventRecord[]);
  const navigationForWorkItem = (workItemId: string, familyId: string, label: string): ActionQueueItem['navigationIntent'] => {
    const materialWorkItem = model.materialWorkItems?.find((work) => work.id === workItemId);
    if (materialWorkItem) {
      const requirement = model.materialRequirements?.find((record) => record.id === materialWorkItem.requirementRef);
      return { href: href('/', { view: 'materials', materialMode: 'classification', material: requirement?.id, family: familyId || materialWorkItem.outputAssetRef, item: workItemId }), label };
    }
    const workItem = model.workItems?.find((work) => work.id === workItemId);
    const workPackage = workItem ? model.workPackages?.find((record) => record.workItemRefs?.includes(workItem.id)) : null;
    const shotId = String(workItem?.shotId || workPackage?.shotIds?.[0] || '');
    const shot = model.shots?.find((record) => record.id === shotId);
    if (workItem && workPackage && shot) {
      return { href: href('/', { view: 'pipeline', scene: shot.sceneId, shot: shot.id, work: workPackage.id, item: workItem.id, family: familyId || workItem.outputAssetRef }), label };
    }
    return { href: href('/', { view: 'overview', workArea: 'EXCEPTION', item: workItemId }), label };
  };
  for (const request of executionRequestsForRuntimeQueue(operations.executionRuntime, operations.executionRequests.current, operations.executionRequests.events, operations.runs.events) as EventRecord[]) {
    const requestId = String(request.executionRequestId || '');
    const requestWorkItemId = String(request.workItemId || '');
    const requestOwnerModule: ActionOwnerModule = materialWorkItemIds.has(requestWorkItemId)
      ? 'WORLD_AND_MATERIALS'
      : 'FULL_PRODUCTION';
    const state = String(request.requestState || request.status || '');
    const run = request.restoreBlockedRun as EventRecord | undefined || runByRequest.get(requestId);
    const runState = String(run?.runState || run?.state || '');
    const runtimeReason = executionRuntimeReason(operations.executionRuntime, request);
    if (runtimeReason && ['AUTHORIZED', 'CLAIMED'].includes(state) && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_UNKNOWN'].includes(runState)) {
      items.push(item({
        targetKey: `EXECUTION_REQUEST:${requestId}`, lane: 'EXCEPTION', requiredAction: 'RESOLVE_EXECUTION_BINDINGS', actionability: 'BLOCKED', actor: 'USER', ownerModule: requestOwnerModule,
        subjectType: 'EXECUTION_REQUEST', subjectId: requestId, executionRequestId: requestId, runId: run ? String(run.runId || '') : undefined, workItemId: requestWorkItemId, familyId: String(request.familyId || ''),
        title: `${requestWorkItemId || requestId} · 恢复前授权已隔离`, coordinates: {}, reasonCodes: [runtimeReason],
        reasonText: '历史授权不适用于当前恢复运行期；不得领取、启动或继续执行。',
        nextActionText: run ? '先核查原平台请求并登记终态，再取消旧授权并明确创建新授权' : '记录取消旧授权的原因，再明确创建本运行期的新授权',
        unlockText: '正式历史保留；新授权仍需通过当前精确输入与调用包门禁',
        dependency: { frontier: true, depth: 0, blockers: [{ reasonCode: runtimeReason }], directUnlockCount: 0, transitiveUnlockCount: 0 },
        permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
        navigationIntent: navigationForWorkItem(requestWorkItemId, String(request.familyId || ''), '核查恢复前请求'), basis: { request, run },
      }));
      continue;
    }
    if (runState === 'RESULT_UNKNOWN') {
      items.push(item({
        targetKey: `RUN:${String(run?.runId || requestId)}`,
        lane: 'EXCEPTION', requiredAction: 'INVESTIGATE_RESULT_UNKNOWN', actionability: 'BLOCKED', actor: request.executor === 'USER_EXTERNAL' ? 'USER_EXTERNAL' : 'CODEX',
        ownerModule: requestOwnerModule,
        subjectType: 'RUN', subjectId: String(run?.runId || requestId), executionRequestId: requestId, runId: String(run?.runId || ''), workItemId: String(request.workItemId || ''), familyId: String(request.familyId || ''),
        title: `${request.workItemId || requestId} · 结果不明`, coordinates: {}, reasonCodes: ['RESULT_UNKNOWN'], reasonText: '模型请求结果未知，禁止取消后盲重试。', nextActionText: '使用REQUEST_ID／LOG_ID核查并登记成功或失败', unlockText: '只有核查终态后才能决定是否重新授权',
        dependency: { frontier: true, depth: 0, blockers: [{ reasonCode: 'RESULT_UNKNOWN' }], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false }, navigationIntent: navigationForWorkItem(String(request.workItemId || ''), String(request.familyId || ''), '核查运行结果'), basis: { request, run },
      }));
    } else if (runState === 'SUCCEEDED' && Number(request.registeredOutputs || 0) < Number(request.maxOutputs || 1)) {
      items.push(item({
        targetKey: `RUN:${String(run?.runId || requestId)}`, lane: 'RESULT_REGISTRATION', requiredAction: 'REGISTER_CANDIDATE', actionability: 'ACTIONABLE', actor: request.executor === 'USER_EXTERNAL' ? 'USER_EXTERNAL' : 'CODEX', subjectType: 'RUN', subjectId: String(run?.runId || requestId), executionRequestId: requestId, runId: String(run?.runId || ''), workItemId: String(request.workItemId || ''), familyId: String(request.familyId || ''), title: `${request.workItemId || requestId} · 登记生成结果`, coordinates: {}, reasonCodes: ['RUN_SUCCEEDED_OUTPUT_NOT_REGISTERED'], reasonText: '运行已成功，但文件与SHA尚未登记为候选版本。', nextActionText: '预检文件并登记一个候选版本', unlockText: '候选登记后进入正式审阅', dependency: { frontier: true, depth: 0, blockers: [], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: true }, navigationIntent: navigationForWorkItem(String(request.workItemId || ''), String(request.familyId || ''), '登记结果'), basis: { request, run },
        ownerModule: requestOwnerModule,
      }));
    } else if (['PLANNED', 'SUBMITTED', 'RUNNING'].includes(runState)) {
      items.push(item({
        targetKey: `RUN:${String(run?.runId || requestId)}`, lane: 'EXECUTION', requiredAction: 'MONITOR_RUNNING', actionability: 'MONITORING', actor: request.executor === 'USER_EXTERNAL' ? 'USER_EXTERNAL' : 'CODEX',
        ownerModule: requestOwnerModule,
        subjectType: 'RUN', subjectId: String(run?.runId || requestId), executionRequestId: requestId, runId: String(run?.runId || ''), workItemId: requestWorkItemId, familyId: String(request.familyId || ''),
        title: `${request.workItemId || requestId} · 制作进行中`, coordinates: {}, reasonCodes: [`RUN_${runState}`], reasonText: '当前请求已启动，正在等待可核验的运行终态。', nextActionText: '监控当前请求，不创建重复执行', unlockText: '运行成功后登记文件与SHA；失败或结果不明时进入异常处理',
        dependency: { frontier: true, depth: 0, blockers: [], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false }, navigationIntent: navigationForWorkItem(requestWorkItemId, String(request.familyId || ''), '查看运行状态'), basis: { request, run },
      }));
    } else if (runState === 'FAILED') {
      items.push(item({
        targetKey: `RUN:${String(run?.runId || requestId)}`, lane: 'EXCEPTION', requiredAction: 'RESOLVE_EXECUTION_FAILURE', actionability: 'BLOCKED', actor: request.executor === 'USER_EXTERNAL' ? 'USER_EXTERNAL' : 'CODEX',
        ownerModule: requestOwnerModule,
        subjectType: 'RUN', subjectId: String(run?.runId || requestId), executionRequestId: requestId, runId: String(run?.runId || ''), workItemId: requestWorkItemId, familyId: String(request.familyId || ''),
        title: `${request.workItemId || requestId} · 制作失败`, coordinates: {}, reasonCodes: ['RUN_FAILED'], reasonText: '最近一次运行已明确失败，原授权不能冒充新的执行许可。', nextActionText: '核对失败原因；确需重试时重新创建一次精确授权', unlockText: '失败原因处理并重新授权后才可再次执行',
        dependency: { frontier: false, depth: 0, blockers: [{ reasonCode: 'RUN_FAILED' }], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false }, navigationIntent: navigationForWorkItem(requestWorkItemId, String(request.familyId || ''), '处理执行失败'), basis: { request, run },
      }));
    } else if (['AUTHORIZED', 'CLAIMED'].includes(state) && !run) {
      const work = allWorkItems.find(w => w.id === requestWorkItemId);
      const definition = definitions.get(String(work?.executionDefinitionRef || ''));
      const eligibility = definition ? executionEligibilityReasons({stateProjection:projection,p07Released:operations.p07Released,executionRuntime:operations.executionRuntime},definition,request) : ['EXECUTION_DEFINITION_NOT_READY'];
      // A claimed request itself projects IN_PROGRESS; all other exact bindings
      // and configuration dependencies still have to remain current.
      const blocked = eligibility.filter(reason => !(state === 'CLAIMED' && reason === 'WORK_ITEM_IN_PROGRESS'));
      if (definition && request.callPackageHash !== definition.definitionHash) blocked.push('EXECUTION_DEFINITION_STALE');
      if (blocked.length) {
        items.push(item({targetKey:`EXECUTION_REQUEST:${requestId}`,lane:'DEPENDENCY_WAIT',requiredAction:'RESOLVE_EXECUTION_BINDINGS',actionability:'WAITING_DEPENDENCY',actor:'NONE',ownerModule:requestOwnerModule,subjectType:'EXECUTION_REQUEST',subjectId:requestId,executionRequestId:requestId,workItemId:requestWorkItemId,familyId:String(request.familyId || ''),title:`${requestWorkItemId} · 授权条件已变化`,coordinates:{},reasonCodes:blocked,reasonText:'当前依赖或调用包已不满足这条授权。',nextActionText:'核对并恢复依赖，必要时重新授权',unlockText:'通过相同门禁检查后才可执行',dependency:{frontier:false,depth:1,blockers:blocked.map(reasonCode=>({reasonCode})),directUnlockCount:0,transitiveUnlockCount:0},permissions:{canSubmitReview:false,canAuthorizeCodex:false,canAuthorizeExternal:false,canRegisterResult:false},navigationIntent:navigationForWorkItem(requestWorkItemId,String(request.familyId || ''),'核对执行条件'),basis:{request}}));
        continue;
      }
      items.push(item({
        targetKey: `EXECUTION_REQUEST:${requestId}`, lane: 'EXECUTION', requiredAction: request.executor === 'CODEX' ? 'EXECUTE_AUTHORIZED' : 'USER_EXTERNAL_EXECUTION', actionability: 'ACTIONABLE', actor: request.executor === 'USER_EXTERNAL' ? 'USER_EXTERNAL' : 'CODEX', subjectType: 'EXECUTION_REQUEST', subjectId: requestId, executionRequestId: requestId, workItemId: String(request.workItemId || ''), familyId: String(request.familyId || ''), title: `${request.workItemId || requestId} · 已授权执行`, coordinates: {}, reasonCodes: ['EXECUTION_AUTHORIZED'], reasonText: '授权已绑定当前调用包与精确输入。', nextActionText: request.executor === 'CODEX' ? '认领并执行一次模型调用' : '在外部平台执行并回传事实', unlockText: '登记运行事实和最多一个候选', dependency: { frontier: true, depth: 0, blockers: [], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: request.executor === 'USER_EXTERNAL' }, navigationIntent: navigationForWorkItem(String(request.workItemId || ''), String(request.familyId || ''), '查看执行包'), basis: { request },
        ownerModule: requestOwnerModule,
      }));
    }
  }

  // Canonical generation eligibility.  Missing output families or definitions
  // are authoring work, never user authorization.
  for (const work of allWorkItems) {
    const materialWorkItem = materialWorkItemIds.has(work.id);
    if (materialWorkItem && materialHardBlockedWorkIds.has(work.id)) continue;
    const ownerModule: ActionOwnerModule = materialWorkItem ? 'WORLD_AND_MATERIALS' : 'FULL_PRODUCTION';
    const state = projection.workItemsById[work.id] || projection.materialWorkItemsById[work.id] || {};
    if (!['READY_TO_START', 'REVISION_REQUIRED'].includes(String(state.lifecycleState || ''))) continue;
    const companionOutputs = Array.isArray(work.additionalOutputAssetRefs) ? work.additionalOutputAssetRefs.map(String).filter(Boolean) : [];
    if (companionOutputs.length) {
      items.push(item({
        targetKey: `GENERATION:${work.id}`,
        lane: 'DEPENDENCY_WAIT',
        requiredAction: 'SPLIT_COMPANION_OUTPUT_LIFECYCLES',
        actionability: 'WAITING_DEPENDENCY',
        actor: 'NONE',
        ownerModule,
        workstream: materialWorkItem ? 'MATERIAL_PREP' : 'EXECUTION_OPERATIONS',
        subjectType: 'WORK_PRODUCT',
        subjectId: work.id,
        workItemId: work.id,
        familyId: work.outputAssetRef || undefined,
        title: `${work.shotId || work.scopeId || work.id} · 多输出闭环尚未拆分`,
        coordinates: { episodeId: work.episodeId || undefined, sceneId: work.sceneId || undefined, shotId: work.shotId || undefined },
        reasonCodes: ['COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE'],
        reasonText: `当前工作项除主输出外还有${companionOutputs.length}个伴随计划交付物；不能用一次主输出授权或审阅冒充整包齐套。`,
        nextActionText: '先为每个伴随交付物建立独立版本、候选登记与审阅闭环',
        unlockText: '所有交付物可分别登记文件、SHA和正式结论后，才重新计算生成授权',
        candidateAvailability: 'NOT_PRODUCED',
        currentVersionRole: 'EXPECTED_OUTPUT',
        hardBlockers: companionOutputs.map((familyId) => ({ reasonCode: 'COMPANION_OUTPUT_LIFECYCLE_MISSING', familyId })),
        advisoryRefs: companionOutputs.map((familyId) => ({ type: 'EXPECTED_OUTPUT' as const, ref: familyId, label: `${familyId} 伴随交付物`, status: 'INDEPENDENT_LIFECYCLE_REQUIRED' })),
        dependency: { frontier: false, depth: 1, blockers: [{ reasonCode: 'COMPANION_OUTPUTS_REQUIRE_INDEPENDENT_LIFECYCLE' }], directUnlockCount: 0, transitiveUnlockCount: 0 },
        permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false },
        navigationIntent: navigationForWorkItem(work.id, String(work.outputAssetRef || ''), '查看多输出边界'),
        basis: { workItemId: work.id, companionOutputs },
      }));
      continue;
    }
    if (!work.outputAssetRef || !work.executionDefinitionRef || activeRequestByWork.has(work.id)) continue;
    const definition = definitions.get(work.executionDefinitionRef);
    if (!definition || definition.definitionStatus !== 'DEFINED' || !/^[a-f0-9]{64}$/i.test(String(definition.definitionHash || ''))) continue;
    const output = asObject(definition.output);
    if (output.assetFamilyRef !== work.outputAssetRef) continue;
    const upload = asObject(definition.upload);
    const uploadItems = Array.isArray(upload.items) ? upload.items.map(asObject) : [];
    if (projection.executionGatesByWorkItem?.[work.id]?.length !== 0) continue;
    items.push(item({
      targetKey: `GENERATION:${work.id}`, lane: 'USER_AUTHORIZATION', requiredAction: 'AUTHORIZE_GENERATION', actionability: 'ACTIONABLE', actor: 'USER', ownerModule, subjectType: 'WORK_PRODUCT', subjectId: work.id, workItemId: work.id, familyId: work.outputAssetRef, title: `${work.shotId || work.outputAssetRef} · 授权生成一个候选`, coordinates: { episodeId: work.episodeId || undefined, sceneId: work.sceneId || undefined, shotId: work.shotId || undefined }, reasonCodes: ['CAN_AUTHORIZE_ONE_CANDIDATE'], reasonText: '输出族、完整调用包和精确输入已满足，且当前无活动授权。', nextActionText: '选择Codex执行或用户外部执行，并明确授权一个候选', unlockText: '授权后进入对应执行者队列', dependency: { frontier: true, depth: 0, blockers: [], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: true, canAuthorizeExternal: true, canRegisterResult: false }, navigationIntent: navigationForWorkItem(work.id, String(work.outputAssetRef || ''), '核对并授权'), basis: { workItemId: work.id, lifecycleState: state.lifecycleState, definitionHash: definition.definitionHash, uploadItems },
    }));
  }

  const sourceLatest = new Map((operations.sourceOperations.latestById as Array<{ aggregateId: string; event: EventRecord }>).map((entry) => [entry.aggregateId, entry.event]));
  for (const [sourceOperationId, event] of sourceLatest) {
    const state = String(event.operationState || event.state || '');
    if (state === 'SUCCEEDED') continue;
    const sourceInProgress = ['STARTED', 'BUILT', 'DEPLOYED'].includes(state);
    items.push(item({
      targetKey: `SOURCE_OPERATION:${sourceOperationId}`, lane: state === 'FAILED' ? 'EXCEPTION' : 'SOURCE_SYNC', requiredAction: state === 'FAILED' ? 'RESOLVE_SOURCE_SYNC_FAILURE' : 'EXECUTE_SOURCE_SYNC', actionability: state === 'FAILED' ? 'BLOCKED' : sourceInProgress ? 'MONITORING' : 'ACTIONABLE', actor: state === 'FAILED' ? 'CODEX' : 'HOST_WORKER', subjectType: 'SOURCE_OPERATION', subjectId: sourceOperationId, title: `${sourceOperationId} · ${state === 'FAILED' ? '源同步失败' : '受控源同步'}`, coordinates: {}, reasonCodes: [`SOURCE_OPERATION_${state || 'UNKNOWN'}`], reasonText: state === 'FAILED' ? String(event.note || '源同步失败，正式下传保持关闭。') : '源同步尚未完成正式3000端口激活证明。', nextActionText: state === 'FAILED' ? '核对journal与恢复点后决定重新申请' : sourceInProgress ? '由本地主机工作器继续执行并核验当前步骤' : '启动受控构建、部署和正式入口校验', unlockText: '正式运行态与目标快照一致后才允许下传', dependency: { frontier: true, depth: 0, blockers: state === 'FAILED' ? [{ reasonCode: 'SOURCE_SYNC_FAILED' }] : [], directUnlockCount: 0, transitiveUnlockCount: 0 }, permissions: { canSubmitReview: false, canAuthorizeCodex: false, canAuthorizeExternal: false, canRegisterResult: false }, navigationIntent: { href: href('/', { view: 'overview', workState: state === 'FAILED' ? 'BLOCKED' : sourceInProgress ? 'IN_PROGRESS' : 'READY', sourceOperation: sourceOperationId }), label: '查看同步证据' }, basis: event,
    }));
  }

  const currentWorkById = new Map(model.workItems.map((work) => [work.id, work]));
  for (const entry of items) {
    const work = entry.workItemId ? currentWorkById.get(entry.workItemId) : null;
    const workRecord = work as unknown as { phaseId?: string | null; gateId?: string | null; activeInCurrentProduction?: boolean } | null;
    if (!work || workRecord?.activeInCurrentProduction !== true || !workRecord.phaseId || !workRecord.gateId) continue;
    const workPackage = model.workPackages.find((candidate) => candidate.workItemRefs?.includes(work.id) && (candidate as unknown as { activeInCurrentProduction?: boolean }).activeInCurrentProduction === true) || null;
    if (!workPackage) continue;
    entry.productionPhaseId = workRecord.phaseId;
    entry.productionGateId = workRecord.gateId;
    entry.navigationIntent = {
      href: href('/', {
        view: 'pipeline',
        productionPhase: workRecord.phaseId.toLowerCase().replaceAll('_', '-'),
        productionGate: workRecord.gateId.toLowerCase().replaceAll('_', '-'),
        productionScope: String(workPackage.scopeType || 'UNKNOWN'),
        productionObject: String(workPackage.scopeId || 'UNKNOWN'),
        item: work.id,
        family: entry.familyId,
        version: entry.versionId,
      }),
      label: entry.navigationIntent.label,
    };
  }

  const pendingReviewRequiredActions = new Set([
    'FORMAL_REVIEW',
    'WAIT_FOR_DEPENDENCY',
    'AUTHOR_REVIEW_CONTEXT',
    'SPLIT_COMPANION_OUTPUT_LIFECYCLES',
  ]);
  const deduped = new Map<string, ActionQueueItem>();
  for (const candidate of items.sort(sortItems)) {
    const immutableReviewKey = candidate.versionId && candidate.familyId && pendingReviewRequiredActions.has(candidate.requiredAction)
      ? `REVIEW_VERSION:${candidate.familyId}:${candidate.versionId}`
      : candidate.targetKey;
    if (!deduped.has(immutableReviewKey)) deduped.set(immutableReviewKey, candidate);
  }
  const episodeUidByAlias = new Map<string, string>();
  const episodeUidByScene = new Map<string, string>();
  const episodePlanIsCurrent = data.creativeLineage?.storyStructure?.planStatus === 'CURRENT';
  for (const episode of model.episodes || []) {
    const episodeUid = String(episode.episodeUid || '');
    if (!episodeUid) continue;
    for (const alias of [episode.id, episode.displayId, episode.canonicalScopeId, episodeUid]) {
      if (alias) episodeUidByAlias.set(String(alias), episodeUid);
    }
    for (const sceneId of episode.sceneIds || []) episodeUidByScene.set(String(sceneId), episodeUid);
  }
  const result = [...deduped.values()].map((entry) => {
    const episodeAlias = entry.coordinates.episodeId || '';
    const episodeUid = entry.coordinates.episodeUid
      || (entry.coordinates.sceneId ? episodeUidByScene.get(entry.coordinates.sceneId) : undefined)
      || (!episodePlanIsCurrent ? episodeUidByAlias.get(episodeAlias) : undefined);
    return episodeUid
      ? { ...entry, coordinates: { ...entry.coordinates, episodeUid } }
      : entry;
  }).sort(sortItems);
  const actionKeysByWorkUnit = new Map<string, string[]>();
  for (const entry of result) actionKeysByWorkUnit.set(entry.workUnitKey, [...(actionKeysByWorkUnit.get(entry.workUnitKey) || []), entry.actionKey]);
  for (const entry of result) entry.sourceActionKeys = [...new Set(actionKeysByWorkUnit.get(entry.workUnitKey) || [entry.actionKey])];
  const workUnitFacts = new Map(collapseActionWorkUnits(result).map((entry) => [entry.workUnitKey, entry]));
  for (const entry of result) {
    const facts = workUnitFacts.get(entry.workUnitKey);
    if (!facts) continue;
    entry.workState = facts.workState;
    entry.sourceActionKeys = facts.sourceActionKeys;
    entry.progressCapabilities = facts.progressCapabilities;
    entry.currentAssignee = facts.currentAssignee;
  }
  const materialRequirements = (model.materialRequirements || [])
    .filter((requirement) => String(requirement.requirementClass || 'REQUIRED') === 'REQUIRED')
    .map((requirement) => projection.materialRequirementsById?.[requirement.id] || requirement as unknown as Record<string, unknown>);
  const materialStageIds = new Set<MaterialCreatorStage>(materialCreatorStageOptions.map((stage) => stage.id));
  const materialStageCounts = Object.fromEntries(materialCreatorStageOptions.map((stage) => [stage.id, 0])) as Record<MaterialCreatorStage, number>;
  const materialStagesByRequirement = new Map<string, MaterialCreatorStage>();
  const materialWorkByRequirementId = new Map((model.materialWorkItems || []).map((work) => [String(work.requirementRef || ''), work]));
  for (const requirement of materialRequirements) {
    const requirementId = String(requirement.id || '');
    const explicitWorkItemId = String(requirement.materialWorkItemRef || '');
    const work = (explicitWorkItemId
      ? (model.materialWorkItems || []).find((candidate) => candidate.id === explicitWorkItemId)
      : materialWorkByRequirementId.get(requirementId)) || null;
    const state = work ? projection.materialWorkItemsById[work.id] || {} : {};
    const projectedStage = String(state.creatorStage || '');
    let stage: MaterialCreatorStage;
    if (requirement.coverageSatisfied === true) {
      stage = 'APPROVED';
    } else if (requirement.bindingStale === true) {
      stage = 'INITIAL';
    } else if (!work) {
      stage = 'INITIAL';
    } else {
      stage = materialStageIds.has(projectedStage as MaterialCreatorStage)
        ? projectedStage as MaterialCreatorStage
        : projectMaterialCreatorStage({
          lifecycleState: String(state.lifecycleState || work.lifecycleState || requirement.materialWorkItemLifecycleState || 'UNKNOWN'),
          executionRequestState: typeof state.executionRequestState === 'string' ? state.executionRequestState : null,
          requirementClass: 'REQUIRED',
          flowBlockReasons: Array.isArray(state.flowBlockReasons) ? state.flowBlockReasons : work.flowBlockReasons,
          executionBlockReasons: work.executionBlockReasons,
          executionGate: state.executionGate || work.declaredExecutionGate,
        }).creatorStage;
      if (stage === 'APPROVED') stage = 'INITIAL';
    }
    materialStageCounts[stage] += 1;
    materialStagesByRequirement.set(requirementId, stage);
  }
  // Bind task filtering to the same exact REQUIRED-demand projection as the
  // counters, never to action titles or inferred lifecycle labels.
  const materialStageBindingFailures = new Map<string, string>();
  for (const entry of result) {
    if (entry.ownerModule !== 'WORLD_AND_MATERIALS') continue;
    let requirementId = entry.requirementId || '';
    if (entry.workItemId) {
      const matches = allWorkItems.filter(work => work.id === entry.workItemId);
      const materialMatches = (model.materialWorkItems || []).filter(work => work.id === entry.workItemId);
      const exactRef = materialMatches.length === 1 ? String(materialMatches[0].requirementRef || '') : '';
      if (matches.length !== 1 || materialMatches.length !== 1 || !exactRef) {
        materialStageBindingFailures.set(entry.workUnitKey, 'MATERIAL_STAGE_BINDING_UNKNOWN'); continue;
      }
      if (requirementId && requirementId !== exactRef) {
        materialStageBindingFailures.set(entry.workUnitKey, 'MATERIAL_STAGE_BINDING_CONFLICT'); continue;
      }
      requirementId = exactRef;
    }
    const requirements = materialRequirements.filter(requirement => String(requirement.id || '') === requirementId);
    if (!requirementId || requirements.length !== 1 || !materialStagesByRequirement.has(requirementId)) {
      materialStageBindingFailures.set(entry.workUnitKey, 'MATERIAL_STAGE_BINDING_UNKNOWN'); continue;
    }
    const explicitWork = String(requirements[0].materialWorkItemRef || '');
    if (entry.workItemId && explicitWork && explicitWork !== entry.workItemId) {
      materialStageBindingFailures.set(entry.workUnitKey, 'MATERIAL_STAGE_BINDING_CONFLICT'); continue;
    }
    entry.requirementId = requirementId;
    entry.materialCreatorStage = materialStagesByRequirement.get(requirementId);
  }
  // A representative must not hide a conflicting action in the same work unit.
  for (const entry of result) {
    const reason = materialStageBindingFailures.get(entry.workUnitKey);
    if (!reason) continue;
    delete entry.materialCreatorStage;
    entry.reasonCodes = [...new Set([...entry.reasonCodes, reason])];
    entry.reasonText += ' 素材阶段未归属：当前工作项与必需需求的永久身份缺失或冲突，需核对归属；未按旧场号、标题或素材族猜测。';
  }
  const workUnits = collapseActionWorkUnits(result);
  const covered = materialRequirements.filter((requirement) => requirement.coverageSatisfied === true).length;
  const formalReview = result.filter((entry) => (
    entry.lane === 'FORMAL_REVIEW'
    || (entry.subjectType === 'WORK_PRODUCT' && entry.requiredAction === 'WAIT_FOR_DEPENDENCY')
    || (entry.requiredAction === 'SPLIT_COMPANION_OUTPUT_LIFECYCLES' && entry.candidateAvailability === 'AVAILABLE')
  ));
  const pendingReviewCandidates = result.filter(isPendingReviewCandidate);
  const expectedPendingKeys = new Set(allWorkItems.flatMap((work) => {
    const state = materialWorkItemIds.has(work.id)
      ? projection.materialWorkItemsById[work.id]
      : projection.workItemsById[work.id];
    if (state?.lifecycleState !== 'REVIEW_PENDING') return [];
    const familyId = String(work.outputAssetRef || '');
    const family = familyId ? projection.assetFamiliesById[familyId] : null;
    const versionId = String(family?.decisionVersionId || family?.currentVersionId || '');
    return [familyId && versionId ? `REVIEW_VERSION:${familyId}:${versionId}` : `REVIEW_WORK_ITEM:${work.id}`];
  }));
  const representedPendingKeys = new Set(result.filter(isReviewLifecycleRepresentation).map((entry) => (
    entry.familyId && entry.versionId
      ? `REVIEW_VERSION:${entry.familyId}:${entry.versionId}`
      : `REVIEW_WORK_ITEM:${entry.workItemId || entry.subjectId}`
  )));
  const missingPendingKeys = [...expectedPendingKeys].filter((key) => !representedPendingKeys.has(key));
  if (missingPendingKeys.length) {
    throw new Error(`ActionQueue lost REVIEW_PENDING candidates: ${missingPendingKeys.join(', ')}`);
  }
  const summary = {
    actionable: {
      userFormalReview: formalReview.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      userCreativeConfirmation: result.filter((entry) => entry.actionability === 'ACTIONABLE' && entry.lane === 'CREATIVE_CONFIRMATION' && entry.actor === 'USER').length,
      userAuthorization: result.filter((entry) => entry.actionability === 'ACTIONABLE' && entry.lane === 'USER_AUTHORIZATION' && entry.actor === 'USER').length,
      userSourceSyncAuthorization: result.filter((entry) => entry.actionability === 'ACTIONABLE' && entry.lane === 'SOURCE_SYNC' && entry.actor === 'USER').length,
      userResultHandling: result.filter((entry) => entry.actionability === 'ACTIONABLE' && ['RESULT_REGISTRATION', 'EXCEPTION'].includes(entry.lane) && ['USER', 'USER_EXTERNAL'].includes(entry.actor)).length,
      codexAuthoring: result.filter((entry) => entry.actionability === 'ACTIONABLE' && entry.lane === 'CODEX_AUTHORING' && entry.actor === 'CODEX').length,
      codexExecution: result.filter((entry) => entry.actionability === 'ACTIONABLE' && entry.lane === 'EXECUTION' && entry.actor === 'CODEX').length,
      hostWorker: result.filter((entry) => entry.actionability === 'ACTIONABLE' && entry.actor === 'HOST_WORKER').length,
    },
    waiting: {
      reviewDependency: formalReview.filter((entry) => entry.actionability !== 'ACTIONABLE').length,
      calibrationReview: materialWaitCounts.calibration,
      lockedVideo: materialWaitCounts.lockedVideo,
      externalEvidence: Object.values(verificationProjection).filter((entry) => entry?.outcome === 'UNRESOLVED_AFTER_LISTENING').length,
    },
    authoring: {
      executionDefinitions: materialWaitCounts.definitions,
      episodePlanCandidates: result.filter((entry) => entry.subjectKind === 'EPISODE_PLAN' && ['AUTHOR_EPISODE_PLAN', 'REVISE_EPISODE_PLAN'].includes(entry.requiredAction)).length,
      sceneCoverageCandidates: result.filter((entry) => entry.subjectKind === 'SCENE_COVERAGE' && ['AUTHOR_SCENE_COVERAGE', 'REVISE_SCENE_COVERAGE'].includes(entry.requiredAction)).length,
      shotPlanSetCandidates: result.filter((entry) => entry.subjectKind === 'SHOT_PLAN_SET' && ['AUTHOR_SHOT_PLAN_SET', 'REVISE_SHOT_PLAN_SET'].includes(entry.requiredAction)).length,
      shotInputLocks: result.filter((entry) => entry.workstream === 'SHOT_INPUT_LOCK' && entry.requiredAction === 'AUTHOR_SHOT_INPUT_LOCK').length,
      structureCandidates: 0,
      sceneReauthoring: 0,
      structureCards: 0,
    },
    operations: {
      authorized: (operations.executionRequests.current as EventRecord[]).filter((event) => !executionRuntimeReason(operations.executionRuntime, event) && ['AUTHORIZED', 'CLAIMED'].includes(String(event.requestState || event.status || ''))).length,
      running: result.filter((entry) => entry.requiredAction === 'MONITOR_RUNNING').length,
      resultRegistration: result.filter((entry) => entry.lane === 'RESULT_REGISTRATION').length,
      resultUnknown: result.filter((entry) => entry.reasonCodes.includes('RESULT_UNKNOWN')).length,
    },
    inventory: {
      materialRequirements: materialRequirements.length,
      covered,
      uncovered: materialRequirements.length - covered,
      pendingReviewCandidates: pendingReviewCandidates.length,
    },
  };
  const recommendationFrom = (entry: ActionQueueItem): ActionRecommendation => ({
    actionKey: entry.actionKey,
    targetKey: entry.targetKey,
    workUnitKey: entry.workUnitKey,
    sourceActionKeys: entry.sourceActionKeys,
    workState: entry.workState,
    workType: entry.workType,
    currentAssignee: entry.currentAssignee,
    progressCapabilities: entry.progressCapabilities,
    workstream: entry.workstream,
    ownerModule: entry.ownerModule,
    priorityTier: entry.priorityTier,
    productionPhaseId: entry.productionPhaseId,
    productionGateId: entry.productionGateId,
    title: entry.title,
    actor: entry.actor,
    reasonText: entry.reasonText,
    nextActionText: entry.nextActionText,
    impactSummary: entry.impactSummary,
    navigationIntent: entry.navigationIntent,
  });
  const actionableParallel = result.filter((entry) => entry.priorityTier === 'PARALLEL' && entry.actionability === 'ACTIONABLE');
  const programItems = (workstream: ActionWorkstream) => result.filter((entry) => entry.workstream === workstream);
  const episodePlanProgramItems = programItems('EPISODE_PLANNING');
  const storyProgramItems = programItems('STORY_CONFIRMATION');
  const sceneCoverageProgramItems = programItems('SCENE_COVERAGE');
  const shotPlanSetProgramItems = programItems('SHOT_PLAN_SET');
  const shotInputLockProgramItems = programItems('SHOT_INPUT_LOCK');
  const activeProgramId = activeProgramIdFor(
    storyProgramItems,
    [],
    episodePlanProgramItems,
    sceneCoverageProgramItems,
    shotPlanSetProgramItems,
    shotInputLockProgramItems,
  );
  const programNext = (entries: ActionQueueItem[]) => entries.find((entry) => entry.actionability === 'ACTIONABLE')?.actionKey || entries[0]?.actionKey || null;
  const releasedSceneCoverageCount = sceneCoverageTemplates.filter((coverage) => {
    const sceneId = String(coverage.sceneId || coverage.scopeId || '');
    return sceneId && scriptSceneProjection[sceneId]?.reviewDecision === 'RELEASED';
  }).length;
  const programStatus = (
    entries: ActionQueueItem[],
    totalCount: number,
    availableInParallel: boolean,
  ): ActionProgram['status'] => {
    if (totalCount === 0) return 'WAITING';
    if (entries.length === 0) return 'COMPLETE';
    if (entries.some((entry) => entry.actionability === 'BLOCKED')) return 'BLOCKED';
    if (entries.some((entry) => entry.actionability === 'ACTIONABLE')) return availableInParallel ? 'AVAILABLE_PARALLEL' : 'ACTIVE';
    return 'WAITING';
  };
  const programs: ActionProgram[] = [
    {
      id: 'EPISODE_PLAN',
      label: '全剧分集方案',
      priorityTier: 'MAINLINE',
      status: episodePlanResolutionError ? 'BLOCKED' : episodePlanProgramItems.length ? 'ACTIVE' : episodePlanReady ? 'COMPLETE' : 'WAITING',
      totalCount: episodePlanReady || episodePlanBasisAvailable || episodePlanResolutionError ? 1 : 0,
      openCount: episodePlanProgramItems.length,
      actionableCount: episodePlanProgramItems.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      waitingCount: episodePlanProgramItems.filter((entry) => entry.actionability !== 'ACTIONABLE').length,
      nextActionKey: programNext(episodePlanProgramItems),
      summary: episodePlanResolutionError
        ? `当前分集候选不可读取：${episodePlanResolutionError}`
        : !episodePlanReady && !episodePlanBasisAvailable
        ? hasCurrentStoryScenes ? '等待补齐当前场正文与分集方案的可核验依据' : '尚未建立分集方案，先整理来源资料与当前场正文'
        : episodePlanProgramItems.length
        ? storyProgress.headline || '按集阅读和提交判断；本集明确确认并受控同步后可独立下传'
        : '当前全剧分集方案已采用且权威源同步成功',
    },
    {
      id: 'STORY_CONFIRMATION',
      label: '场正文与评论',
      priorityTier: 'MAINLINE',
      status: storyTargets.length === 0 ? 'WAITING' : storyProgramItems.some((entry) => entry.actionability === 'BLOCKED')
        ? 'BLOCKED'
        : storyProgramItems.some((entry) => entry.actionability === 'ACTIONABLE')
          ? 'ACTIVE'
          : storyProgramItems.length ? 'WAITING' : 'COMPLETE',
      totalCount: storyTargets.length,
      openCount: storyProgramItems.length,
      actionableCount: storyProgramItems.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      waitingCount: storyProgramItems.filter((entry) => entry.actionability !== 'ACTIONABLE').length,
      nextActionKey: programNext(storyProgramItems),
      summary: storyTargets.length === 0
        ? '尚未建立当前场正文，等待整理来源资料与剧本候选'
        : storyProgramItems.length
        ? storyProgramItems.some((entry) => entry.actionability === 'ACTIONABLE')
          ? `${storyProgramItems.length}个场正文仍有采用或返修缺项；可查看正文与评论，不提供独立场正式提交`
          : `${storyProgramItems.length}个场正文的正式采用缺项保持；阅读与评论不解除上游门禁`
        : `全剧${storyTargets.length}场正文均已有正式结论`,
    },
    {
      id: 'SCENE_COVERAGE',
      label: '逐场镜头意图',
      priorityTier: storyConfirmationOpen ? 'PARALLEL' : releasedSceneCoverageCount ? 'MAINLINE' : 'WAITING',
      status: programStatus(sceneCoverageProgramItems, releasedSceneCoverageCount, storyConfirmationOpen),
      totalCount: releasedSceneCoverageCount,
      openCount: sceneCoverageProgramItems.length,
      actionableCount: sceneCoverageProgramItems.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      waitingCount: sceneCoverageProgramItems.filter((entry) => entry.actionability !== 'ACTIONABLE').length,
      nextActionKey: programNext(sceneCoverageProgramItems),
      summary: releasedSceneCoverageCount === 0
        ? '待分集方案同步且至少一场正文放行后，逐场建立镜头意图'
        : sceneCoverageProgramItems.length
          ? `已有${releasedSceneCoverageCount}场正文放行；逐场完成镜头意图候选、审阅与源同步`
          : `已放行的${releasedSceneCoverageCount}场均已完成镜头意图同步`,
    },
    {
      id: 'SHOT_PLAN_SET',
      label: '正式镜头计划',
      priorityTier: storyConfirmationOpen ? 'PARALLEL' : completedSceneCoverageCount ? 'MAINLINE' : 'WAITING',
      status: programStatus(shotPlanSetProgramItems, completedSceneCoverageCount, storyConfirmationOpen),
      totalCount: completedSceneCoverageCount,
      openCount: shotPlanSetProgramItems.length,
      actionableCount: shotPlanSetProgramItems.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      waitingCount: shotPlanSetProgramItems.filter((entry) => entry.actionability !== 'ACTIONABLE').length,
      nextActionKey: programNext(shotPlanSetProgramItems),
      summary: completedSceneCoverageCount === 0
        ? '待至少一场镜头意图放行并完成源同步后，再建立正式镜头计划'
        : shotPlanSetProgramItems.length
          ? `已有${completedSceneCoverageCount}场镜头意图同步；逐场完成正式镜头计划候选、审阅与源同步`
          : `已解锁的${completedShotPlanSetCount}场正式镜头计划均已完成同步`,
    },
    {
      id: 'SHOT_INPUT_LOCK',
      label: '逐镜输入锁定',
      priorityTier: storyConfirmationOpen ? 'PARALLEL' : shotInputLockItems.length ? 'MAINLINE' : 'WAITING',
      status: programStatus(shotInputLockProgramItems, shotInputLockItems.length, storyConfirmationOpen),
      totalCount: shotInputLockItems.length,
      openCount: shotInputLockProgramItems.length,
      actionableCount: shotInputLockProgramItems.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      waitingCount: shotInputLockProgramItems.filter((entry) => entry.actionability !== 'ACTIONABLE').length,
      nextActionKey: programNext(shotInputLockProgramItems),
      summary: shotInputLockItems.length === 0
        ? '待正式镜头计划同步后，开放逐镜输入锁定'
        : shotInputLockProgramItems.length
          ? `已建立${shotInputLockItems.length}个正式ShotSpec；逐镜补齐剧本、素材版本与空间连续性精确绑定`
          : `已完成${shotInputLockItems.length}个正式ShotSpec的输入锁定`,
    },
  ];
  const countsByOwner = (owner: Exclude<ActionOwnerModule, 'SYSTEM'>) => currentWorkCountsFor(result.filter((entry) => entry.ownerModule === owner));
  const storyCounts = countsByOwner('STORY_CREATION');
  const materialCounts = countsByOwner('WORLD_AND_MATERIALS');
  const productionCounts = countsByOwner('FULL_PRODUCTION');
  const storyProgramIds = new Set(['EPISODE_PLAN', 'STORY_CONFIRMATION', 'SCENE_COVERAGE']);
  const storyPrograms = programs.filter((program) => storyProgramIds.has(program.id));
  const activeStoryProgramId = activeProgramIdFor(
    storyProgramItems,
    [],
    episodePlanProgramItems,
    sceneCoverageProgramItems,
  );
  const activeStoryProgram = activeStoryProgramId
    ? storyPrograms.find((program) => program.id === activeStoryProgramId) || null
    : null;
  const materialStageLabel = (stageId: MaterialCreatorStage) => materialCreatorStageOptions.find((stage) => stage.id === stageId)?.label || stageId;
  const firstMaterialStage = materialCreatorStageOptions.find((stage) => materialStageCounts[stage.id] > 0 && stage.id !== 'APPROVED') || null;
  const pendingMaterialReview = materialStageCounts.PENDING_REVIEW;
  const materialStatus: WorkspaceDomainSummary['status'] = materialRequirements.length > 0 && materialStageCounts.APPROVED === materialRequirements.length
    ? 'COMPLETE'
    : materialCounts.ready > 0 || materialCounts.inProgress > 0 ? 'ACTIVE'
      : materialCounts.blocked > 0 ? 'BLOCKED' : 'WAITING';
  const activeProductionWorks = model.workItems.filter((work) => (
    work.activeInCurrentProduction === true
    && projection.workItemsById[work.id]?.activeInCurrentProduction !== false
  ));
  const productionWorkUnits = workUnits.filter((entry) => entry.ownerModule === 'FULL_PRODUCTION');
  const currentProductionWork = productionWorkUnits.find((entry) => entry.workState === 'IN_PROGRESS')
    || productionWorkUnits.find((entry) => entry.workState === 'READY')
    || productionWorkUnits.find((entry) => entry.workState === 'BLOCKED')
    || productionWorkUnits.find((entry) => entry.workState === 'WAITING')
    || null;
  const currentProductionGate = currentProductionWork?.productionGateId
    ? (model.productionGates || []).find((gate) => gate.id === currentProductionWork.productionGateId)?.label
    : null;
  // Share the workbench's current, gate-specific release projection. Counts at
  // different scopes must never be summed into a creator-stage denominator.
  const projectedProductionGates = configuredProductionProgress(model as unknown as Record<string, unknown>, projection).productionGates as Array<Record<string, unknown> & {releasedObjectCount:number;currentObjectCount:number}>;
  const productionStages: WorkspaceStageSummary[] = CREATOR_PRODUCTION_STAGES.map((stage) => {
    const exitGateId = stage.gateIds.filter(id => !stage.exportGateIds.includes(id)).at(-1)!;
    const canonical = creatorProductionGateDefinition(exitGateId)!;
    const candidates = projectedProductionGates.filter(gate => gate.id === exitGateId);
    const exit = candidates.length === 1 ? candidates[0] : null;
    const exactExit = Boolean(exit && exit.phaseId === canonical.phaseId && exit.scopeType === canonical.scopeType
      && (!exit.denominatorUnit || exit.denominatorUnit === canonical.scopeType));
    const released = exactExit && Number.isSafeInteger(exit?.releasedObjectCount) && Number(exit?.releasedObjectCount) >= 0
      ? Number(exit?.releasedObjectCount) : null;
    const denominatorKnown = exactExit && exit?.denominatorState === 'KNOWN'
      && Number.isSafeInteger(exit?.denominator) && Number(exit?.denominator) >= 0
      && released !== null && released <= Number(exit?.denominator);
    const stageCounts = currentWorkCountsFor(productionWorkUnits.filter(entry => creatorProductionStageForGate(entry.productionGateId) === stage.id));
    return {
      id: stage.id, label: stage.label,
      status: stageCounts.ready > 0 || stageCounts.inProgress > 0 ? 'ACTIVE'
        : stageCounts.blocked > 0 ? 'BLOCKED'
        : stageCounts.waiting > 0 ? 'WAITING'
        : denominatorKnown && released === Number(exit?.denominator) ? 'COMPLETE'
        : Number(exit?.currentObjectCount || 0) > 0 ? 'ACTIVE' : 'UNKNOWN',
      count: released, denominator: denominatorKnown ? Number(exit?.denominator) : null,
      denominatorState: denominatorKnown ? 'KNOWN' : 'UNKNOWN',
    };
  });
  const workspaceSummary: WorkspaceSummary = {
    counts: currentWorkCountsFor(result),
    domains: [
      {
        id: 'STORY_CREATION',
        label: '故事 → 剧本',
        status: activeStoryProgram ? activeStoryProgram.status === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE' : !episodePlanReady || !hasCurrentStoryScenes ? 'WAITING' : 'COMPLETE',
        currentGate: activeStoryProgram?.label || (!hasCurrentStoryScenes ? '尚未建立当前场正文' : !episodePlanReady ? '等待分集方案依据' : '故事与剧本主线已完成'),
        headline: storyProgress.headline || activeStoryProgram?.summary || (!episodePlanReady || !hasCurrentStoryScenes ? '先整理来源资料与当前场正文，再形成可核验的分集方案' : '当前故事与剧本主线均已形成正式采用事实'),
        nextUnlockText: storyProgress.nextAction || (activeStoryProgram
          ? '完成当前程序后，按场逐步解锁镜头意图与正式镜头计划'
          : !episodePlanReady || !hasCurrentStoryScenes ? '资料和当前正文齐备后，再建立正式创作与审阅工作' : '等待后续剧本变更或新的创作范围'),
        navigationIntent: { href: href('/', { view: 'story', storyMode: !hasCurrentStoryScenes ? 'source' : 'logic' }), label: '进入故事创作' },
        counts: storyCounts,
        metrics: [
          ...(storyProgress.state==='AVAILABLE'?[
            {id:'CURRENT_EPISODES',label:storyProgress.sourceRole==='CANDIDATE'?'当前候选集数':'当前方案集数',value:storyProgress.episodeCount,denominator:null,denominatorState:'UNKNOWN' as const,unit:'集'},
            {id:'EPISODES_SOURCE_CURRENT',label:'独立正式通过且已同步',value:storyProgress.releasedEpisodeCount,denominator:null,denominatorState:'UNKNOWN' as const,unit:'集'},
          ]:[]),
          { id: 'EPISODE_PLAN', label: '正式分集方案', value: episodePlanReady ? 1 : 0, denominator: episodePlanReady || episodePlanBasisAvailable || episodePlanResolutionError ? 1 : null, denominatorState: episodePlanReady || episodePlanBasisAvailable || episodePlanResolutionError ? 'KNOWN' : 'UNKNOWN', unit: '套' },
          { id: 'SCRIPT_SCENES', label: narrativeCandidate ? '待审稿已拆场次' : '已确认场正文', value: narrativeCandidate ? pendingSceneCount : storyTargets.length - openStorySceneIds.length, denominator: narrativeCandidate ? null : storyTargets.length || null, denominatorState: narrativeCandidate ? 'UNKNOWN' : storyTargets.length ? 'KNOWN' : 'UNKNOWN', unit: '场' },
        ],
        stages: storyPrograms.map((program) => ({
          id: program.id,
          label: program.label,
          status: program.status,
          count: Math.max(0, program.totalCount - program.openCount),
          denominator: program.id === 'SCENE_COVERAGE' || program.totalCount === 0 ? null : program.totalCount,
          denominatorState: program.id === 'SCENE_COVERAGE' || program.totalCount === 0 ? 'UNKNOWN' as const : 'KNOWN' as const,
        })),
      },
      {
        id: 'WORLD_AND_MATERIALS',
        label: '剧本 → 素材',
        status: materialStatus,
        currentGate: pendingMaterialReview
          ? `${pendingMaterialReview}项待正式审阅`
          : firstMaterialStage ? materialStageLabel(firstMaterialStage.id) : materialRequirements.length ? '素材需求已全部采用' : '尚未登记素材需求',
        headline: `${materialRequirements.length}项当前必需素材；${covered}项已采用，${materialRequirements.length - covered}项尚未通过`,
        nextUnlockText: pendingMaterialReview
          ? '先审阅已有候选；其余就绪项可按一次一候选授权推进'
          : materialCounts.ready > 0 ? '先处理当前可开展工作，再由同一生命周期投影后续阶段' : '等待上游依赖或解除硬阻断',
        navigationIntent: { href: href('/', { view: 'materials', materialMode: 'classification' }), label: '进入素材管理' },
        counts: materialCounts,
        metrics: [
          { id: 'REQUIRED', label: '当前必需', value: materialRequirements.length, denominator: materialRequirements.length, denominatorState: 'KNOWN', unit: '项' },
          { id: 'APPROVED', label: '已采用', value: materialStageCounts.APPROVED, denominator: materialRequirements.length, denominatorState: 'KNOWN', unit: '项' },
          { id: 'PENDING_REVIEW', label: '待审阅', value: materialStageCounts.PENDING_REVIEW, denominator: materialRequirements.length, denominatorState: 'KNOWN', unit: '项' },
          { id: 'BLOCKED', label: '阻断工作', value: materialCounts.blocked, denominator: materialCounts.total, denominatorState: 'KNOWN', unit: '工作项' },
        ],
        stages: materialCreatorStageOptions.map((stage) => ({
          id: stage.id,
          label: stage.label,
          status: materialStageCounts[stage.id] > 0 ? 'ACTIVE' : 'EMPTY',
          count: materialStageCounts[stage.id],
          denominator: materialRequirements.length,
          denominatorState: 'KNOWN' as const,
        })),
      },
      {
        id: 'FULL_PRODUCTION',
        label: '剧本 + 素材 → 全剧制作',
        status: activeProductionWorks.length || productionCounts.ready || productionCounts.inProgress
          ? 'ACTIVE'
          : productionCounts.blocked > 0
            ? 'BLOCKED'
            : productionCounts.waiting > 0 ? 'WAITING' : 'UNKNOWN',
        currentGate: currentProductionGate || (currentProductionWork
          ? currentProductionWork.title
          : activeProductionWorks.length
            ? '当前正式制作前沿'
          : productionCounts.ready || productionCounts.inProgress
            ? '当前有可推进制作工作'
            : productionCounts.blocked > 0
              ? `${productionCounts.blocked}个制作工作单元阻断`
              : productionCounts.waiting > 0
                ? `${productionCounts.waiting}个制作工作单元等待依赖`
                : '正式制作分母尚未锁定'),
        headline: activeProductionWorks.length
          ? `${activeProductionWorks.length}个当前制作工作项；各阶段分别按同类出口统计`
          : productionCounts.ready || productionCounts.inProgress || productionCounts.blocked || productionCounts.waiting
            ? `${productionCounts.ready + productionCounts.inProgress}个当下可开展、${productionCounts.waiting}个等待、${productionCounts.blocked}个阻断的制作工作单元`
          : '按镜头拆解、镜头生成、场景剪辑和分集成片推进；正式制作范围尚未锁定',
        nextUnlockText: currentProductionWork?.unlockText
          || '正式分集方案与场级创作逐步同步后，按已锁范围建立镜头计划与制作分母',
        navigationIntent: { href: href('/', { view: 'pipeline' }), label: '进入全剧制作' },
        counts: productionCounts,
        metrics: [
          { id: 'ACTIVE_WORK_ITEMS', label: '当前工作项', value: activeProductionWorks.length, denominator: null, denominatorState: 'UNKNOWN', unit: '项' },
          { id: 'PHASES', label: '制作阶段', value: CREATOR_PRODUCTION_STAGES.length, denominator: CREATOR_PRODUCTION_STAGES.length, denominatorState: 'KNOWN', unit: '阶段' },
        ],
        stages: productionStages,
      },
    ],
    criticalBlockers: [...new Map(result
      .filter((entry) => entry.workState === 'BLOCKED')
      .map((entry) => [entry.workUnitKey, {
        workUnitKey: entry.workUnitKey,
        title: entry.title,
        reasonText: entry.reasonText,
        navigationIntent: entry.navigationIntent,
      }])).values()].slice(0, 6),
  };
  const activeProgram = activeProgramId ? programs.find((program) => program.id === activeProgramId) || null : null;
  const currentMainlineItems = stagedMainlineItems(
    storyProgramItems,
    [],
    episodePlanProgramItems,
    sceneCoverageProgramItems,
    shotPlanSetProgramItems,
    shotInputLockProgramItems,
  );
  const mainlineRecommendation = currentMainlineItems.find((entry) => entry.actionability === 'ACTIONABLE') || currentMainlineItems[0] || null;
  const mainlineRecommendationProjection = mainlineRecommendation
    ? {
      ...recommendationFrom(mainlineRecommendation),
      priorityTier: mainlineRecommendation.priorityTier,
    }
    : null;
  return {
    schemaVersion: '1.4',
    snapshotId: data.snapshotId,
    operationRevision: operations.operationRevision,
    etag: operations.etag,
    summary,
    recommendations: {
      perspective: 'CREATOR' as const,
      mainline: mainlineRecommendationProjection,
      parallel: actionableParallel.map(recommendationFrom),
      counts: {
        mainlineActionable: currentMainlineItems.filter((entry) => entry.actionability === 'ACTIONABLE').length,
        parallelActionable: actionableParallel.length,
      },
    },
    programs,
    journeySummary: activeProgramId && activeProgram ? {
      activeProgramId,
      headline: activeProgram.summary,
      currentStep: activeProgramId === 'EPISODE_PLAN'
        ? 1
        : activeProgramId === 'STORY_CONFIRMATION'
          ? 2
          : activeProgramId === 'SCENE_COVERAGE' ? 3
            : activeProgramId === 'SHOT_PLAN_SET' ? 4 : 5,
      steps: programs.map((program) => ({
        id: program.id,
        label: program.label,
        status: program.status,
        count: program.openCount,
        nextActionKey: program.nextActionKey,
      })),
    } : null,
    storyProgress,
    workspaceSummary,
    count: workUnits.length,
    rowCount: result.length,
    workUnitCount: workUnits.length,
    items: result,
    workUnits,
  };
}
