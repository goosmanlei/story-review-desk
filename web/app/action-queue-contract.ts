export type ActionActor = 'USER' | 'CODEX' | 'USER_EXTERNAL' | 'HOST_WORKER' | 'NONE';
export type Actionability = 'ACTIONABLE' | 'MONITORING' | 'WAITING_DEPENDENCY' | 'BLOCKED';
export type WorkState = 'READY' | 'IN_PROGRESS' | 'WAITING' | 'BLOCKED';
export type WorkType = 'AUTHORING' | 'FORMAL_REVIEW' | 'AUTHORIZATION' | 'EXECUTION' | 'RESULT_REGISTRATION' | 'SOURCE_SYNC' | 'ISSUE_RESOLUTION';
export type ActorGroup = 'HUMAN' | 'AI' | 'AUTOMATION';
export type ActorKind = Exclude<ActionActor, 'NONE'>;
export type CapabilityLevel = 'ADVANCE' | 'ASSIST';
export type CapabilityAvailability = 'NOW' | 'AFTER_AUTHORIZATION' | 'AFTER_DEPENDENCY';
export type PriorityTier = 'MAINLINE' | 'PARALLEL' | 'SUPPORTING' | 'WAITING' | 'EXCEPTION';
export type Workstream =
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

export type ActionOwnerModule = 'STORY_CREATION' | 'WORLD_AND_MATERIALS' | 'FULL_PRODUCTION' | 'SYSTEM';

export type NavigationIntent = { href: string; label: string };

export type CurrentAssignee = {
  actorGroup: ActorGroup;
  actorKind: ActorKind;
  role: 'REVIEWER' | 'EXTERNAL_EXECUTOR' | 'CODEX' | 'HOST_WORKER';
  source: 'EXECUTION_REQUEST' | 'SOURCE_OPERATION';
  assignmentState: 'CLAIMED_ACTOR' | 'ACTIVE_WORKER';
  evidenceId: string;
  evidenceState: string;
  claimedBy?: string;
};

export type ProgressCapability = {
  actorGroup: ActorGroup;
  actorKind: ActorKind;
  level: CapabilityLevel;
  availability: CapabilityAvailability;
  actionType: WorkType;
  label: string;
  nextActionText: string;
};

export type ImpactSummary = {
  label?: string;
  affectedShotCount?: number;
  affectedWorkItemCount?: number;
  affectedSceneCount?: number;
  directUnlockCount?: number;
  transitiveUnlockCount?: number;
  conditional?: boolean;
};

export type ActionAdvisoryRef = {
  type: 'ACTION' | 'WORK_ITEM' | 'ASSET_VERSION' | 'EXPECTED_OUTPUT' | 'SOURCE' | 'SCENE';
  ref: string;
  label: string;
  href?: string;
  status?: string;
};

export type ActionRecommendation = {
  actionKey: string;
  targetKey: string;
  workUnitKey: string;
  sourceActionKeys: string[];
  workState: WorkState;
  workType: WorkType;
  currentAssignee: CurrentAssignee | null;
  progressCapabilities: ProgressCapability[];
  workstream: Workstream;
  ownerModule: ActionOwnerModule;
  priorityTier: PriorityTier;
  productionPhaseId: string | null;
  productionGateId: string | null;
  title: string;
  actor: ActionActor;
  reasonText: string;
  nextActionText: string;
  impactSummary: ImpactSummary;
  navigationIntent: NavigationIntent;
};

export type ActionItem = {
  actionKey: string;
  targetKey: string;
  basisHash: string;
  lane: string;
  requiredAction: string;
  actionability: Actionability;
  actor: ActionActor;
  workUnitKey: string;
  sourceActionKeys: string[];
  workState: WorkState;
  workType: WorkType;
  currentAssignee: CurrentAssignee | null;
  progressCapabilities: ProgressCapability[];
  subjectType: string;
  subjectId: string;
  workItemId?: string;
  requirementId?: string;
  materialCreatorStage?: import('./material-taxonomy').MaterialCreatorStage;
  familyId?: string;
  versionId?: string;
  executionRequestId?: string;
  runId?: string;
  groupKey: string;
  title: string;
  coordinates?: { episodeId?: string; episodeUid?: string; sceneId?: string; shotId?: string; workflowStep?: number };
  reasonText: string;
  decisionQuestion?: string;
  agentNextAction?: string;
  reasonCodes: string[];
  nextActionText: string;
  unlockText: string;
  dependency?: { depth?: number; blockers?: Array<Record<string, unknown>>; transitiveUnlockCount?: number };
  permissions?: { canSubmitReview?: boolean; canAuthorizeCodex?: boolean; canAuthorizeExternal?: boolean; canRegisterResult?: boolean };
  navigationIntent: NavigationIntent;
  workstream: Workstream;
  ownerModule?: ActionOwnerModule;
  priorityTier: PriorityTier;
  businessOrder: number;
  workflowStep: number | null;
  productionPhaseId: string | null;
  productionGateId: string | null;
  priorityReasonCodes: string[];
  impactSummary: ImpactSummary;
  candidateAvailability?: string;
  currentVersionRole?: string;
  hardBlockers?: Array<Record<string, unknown>>;
  advisoryRefs?: ActionAdvisoryRef[];
};

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
  navigationIntent: NavigationIntent;
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
    navigationIntent: NavigationIntent;
  }>;
};

export type ActionSurfaceMode = 'CONTROL' | 'MATERIALS' | 'REVIEW';

export function actionQueueSurfaceIncludes(mode: ActionSurfaceMode, item: ActionItem) {
  if (mode === 'REVIEW') return item.lane === 'FORMAL_REVIEW'
    || (item.lane === 'DEPENDENCY_WAIT' && item.workstream === 'P07_CALIBRATION')
    || (item.requiredAction === 'SPLIT_COMPANION_OUTPUT_LIFECYCLES' && item.candidateAvailability === 'AVAILABLE');
  if (mode === 'MATERIALS') return item.workstream === 'MATERIAL_PREP' || item.workstream === 'GENERATION';
  return item.lane === 'EXCEPTION' || item.lane === 'SOURCE_SYNC' || item.lane === 'EXECUTION' || item.actor === 'HOST_WORKER'
    || item.lane === 'RESULT_REGISTRATION'
    || item.requiredAction === 'SPLIT_COMPANION_OUTPUT_LIFECYCLES'
    || item.requiredAction === 'INVESTIGATE_RESULT_UNKNOWN' || item.requiredAction === 'REGISTER_CANDIDATE';
}

export type ActionSummary = {
  actionable: {
    userFormalReview: number;
    userCreativeConfirmation: number;
    userAuthorization: number;
    userSourceSyncAuthorization: number;
    userResultHandling: number;
    codexAuthoring: number;
    codexExecution: number;
    hostWorker: number;
  };
  waiting: { reviewDependency: number; calibrationReview: number; lockedVideo: number; externalEvidence: number };
  authoring: {
    executionDefinitions: number;
    episodePlanCandidates: number;
    sceneCoverageCandidates: number;
    shotPlanSetCandidates: number;
    shotInputLocks?: number;
    structureCandidates: number;
    sceneReauthoring: number;
    structureCards?: number;
  };
  operations: { authorized: number; running: number; resultRegistration: number; resultUnknown: number };
  inventory: { materialRequirements: number; covered: number; uncovered: number; pendingReviewCandidates: number };
};

export type ActionProgram = {
  id: string;
  label: string;
  priorityTier: PriorityTier;
  status: string;
  totalCount: number;
  openCount: number;
  actionableCount: number;
  waitingCount: number;
  nextActionKey: string | null;
  summary: string;
};

export type QueuePayload = {
  schemaVersion: string;
  snapshotId: string;
  operationRevision: string;
  count?: number;
  rowCount?: number;
  workUnitCount?: number;
  summary: ActionSummary;
  summaryScope?: 'GLOBAL' | 'FILTERED_ITEMS';
  globalSummary?: ActionSummary;
  recommendations?: {
    perspective: 'CREATOR';
    mainline: ActionRecommendation | null;
    parallel: ActionRecommendation[];
    counts: { mainlineActionable: number; parallelActionable: number };
  };
  programs?: ActionProgram[];
  journeySummary?: {
    activeProgramId: string;
    headline: string;
    currentStep: number;
    steps: Array<{ id: string; label: string; status: string; count: number; nextActionKey: string | null }>;
  } | null;
  workspaceSummary?: WorkspaceSummary;
  filteredWorkCounts?: CurrentWorkCounts;
  filters?: Partial<Record<'actor' | 'lane' | 'actionability' | 'workstream' | 'priorityTier' | 'scope' | 'ownerModule' | 'workState' | 'workType' | 'capableActor' | 'capabilityLevel', string | null>>;
  items: ActionItem[];
  workUnits?: ActionItem[];
};

export type UnifiedActionCounts = {
  userDecisions: number;
  producedPendingDecision: number;
  submittableNow: number;
  waitingDependency: number;
};

export function unifiedActionCounts(queue: QueuePayload): UnifiedActionCounts {
  const userDecisions = new Set(queue.items
    .filter((item) => item.progressCapabilities.some((capability) => (
      capability.actorGroup === 'HUMAN'
      && capability.level === 'ADVANCE'
      && capability.availability === 'NOW'
    )))
    .map((item) => item.workUnitKey)).size;
  return {
    userDecisions,
    producedPendingDecision: queue.summary.inventory.pendingReviewCandidates,
    submittableNow: queue.summary.actionable.userFormalReview,
    waitingDependency: queue.summary.waiting.reviewDependency,
  };
}

export function impactLabel(impact?: ImpactSummary | null) {
  if (!impact) return '';
  if (impact.label) return impact.label;
  const parts = [
    typeof impact.affectedShotCount === 'number' ? `影响${impact.affectedShotCount}镜` : '',
    typeof impact.affectedWorkItemCount === 'number' ? `关联${impact.affectedWorkItemCount}个工作项` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}
