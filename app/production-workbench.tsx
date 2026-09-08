'use client';
import {instanceCandidateRelativePath} from '../host/instance-runtime/media-paths.mjs';
import {ShotProductionWorkspace} from './shot-production-workspace';
import {AnimaticWorkspace} from './animatic-workspace';
import {EpisodeProductionEntry} from './episode-production-entry';
import {ShotProductionRecipeEditor} from './shot-production-recipe-editor';
import {ShotProductionEvidencePanel,useShotProductionEvidence} from './shot-production-review-evidence';
import type {ShotProductionEvidence} from '../host/instance-runtime/shot-production-locks.mjs';

import {useInstanceProfile} from './instance-context';
import type { ReviewSpec, ConfigurationBinding, Configuration, ConfigurationRef } from '../host/instance-runtime/configuration-model.mjs';
import { criteriaForReviewScope } from '../host/instance-runtime/review-criteria.mjs';
/* eslint-disable @next/next/no-img-element */

import { configuredProductionProgress } from './gate-evaluation';

import {ProductionPreparationWorkspace} from './production-preparation-workspace';
import { instanceLocalStorage } from './client-storage';
import { projectIdFor } from './instance-profile';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EvidenceTrigger } from './evidence-reader';
import { deriveHeadlineState, StatusHeadline, statusToneFromRecord, UnifiedStatusPanel } from './status-system';
import { publicRef, publicRefMatches, stageDisplay, visibleText, workflowDisplay } from './review-semantics';
import { useRuntimeMode } from './runtime-mode';
import { useAssistantFocus } from './assistant/context-provider';
import { useProjectAssistantDraftTargets } from './assistant/project-draft-adapters';
import type { EpisodeReviewDossier } from './story-review-types';

type ReviewClaim = { class: 'A' | 'F' | 'L' | 'U'; text: string; evidenceRefs: string[] };

type ReviewEvidence = {
  ref: string;
  path: string;
  title: string;
  locator: string;
  excerpt: string;
  sourceSha256: string;
  excerptSha256: string;
  sourceKind: string;
};

type ShotReviewContext = {
  schemaVersion: string;
  semanticStatus: 'AUTHORED_DRAFT' | 'ASSEMBLED_WITH_UNKNOWNS';
  contextHash: string;
  position: { sequenceId: string; episodeId: string; sceneId: string; shotId: string; shotOrdinal: number; shotTotal: number };
  sequence: {
    id: string; title: ReviewClaim; summary: ReviewClaim; structuralRole: ReviewClaim;
    audienceKnowledge: ReviewClaim; visualGrammar: ReviewClaim; editorialRhythm: ReviewClaim; constraints: ReviewClaim[];
  };
  episode: {
    id: string; sceneIds: string[]; openingHook: ReviewClaim; coreAdvance: ReviewClaim;
    endingCliffhanger: ReviewClaim; reviewQuestion: ReviewClaim;
  };
  scene: {
    id: string; slugline: string; scriptExcerpt: string; time: string; primaryLocation: string;
    route: string; keyPropsAndState: string; continuity: string; adaptationDeviation: ReviewClaim | null;
  };
  shot: {
    id: string; title: string; storyEvent: ReviewClaim; purpose: ReviewClaim; audienceTakeaway: ReviewClaim;
    mustShow: ReviewClaim[]; mustNotImply: ReviewClaim[]; reviewQuestion: ReviewClaim;
  };
  neighbours: Record<'previous' | 'current' | 'next', { id: string | null; title: string; storyEvent: string; dialogue: string | null }>;
  sourceRefs: string[];
};

export type LifecycleProjection = {
  lifecycleState?: string | null;
  outputState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  historyRole?: string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[] | null;
  upstreamReadiness?: string | null;
  latestRun?: { state?: string | null; source?: string | null } | null;
  reviewActionability?: 'ACTIONABLE' | 'WAITING_DEPENDENCY' | 'BLOCKED' | 'NOT_APPLICABLE' | null;
  reviewBlockers?: Array<Record<string, unknown>> | null;
  reviewDependencyDepth?: number | null;
  preflight?: { status?: string | null; manualStatus?: string | null; role?: string | null; sourceRef?: string | null } | null;
  legacyState?: Record<string, unknown> | null;
};

export type V7WorkItem = LifecycleProjection & {
  reviewSpec?: import("../host/instance-runtime/configuration-model.mjs").ReviewSpec;
  configurationBinding?: import("../host/instance-runtime/configuration-model.mjs").ConfigurationBinding;
  id: string;
  legacyStageId: string;
  stageKey: string;
  pipelineStageCode: string;
  workflowStepId: string;
  deliverableKey: string;
  scopeType: 'SEGMENT' | 'SHOT' | 'LINE' | 'SCENE' | 'EPISODE' | 'PROJECT';
  scopeId: string;
  episodeId: string;
  episodeUid?: string;
  sceneId: string | null;
  segmentId: string | null;
  shotId: string | null;
  lineId: string | null;
  definitionStatus?: string;
  inputAssetRefs: string[];
  outputAssetRef: string | null;
  additionalOutputAssetRefs?: string[];
  promptRef: string | null;
  sourceRef: string;
  executionDefinitionRef?: string | null;
  reviewContextRef?: string | null;
  phaseId?: ProductionPhaseId | null;
  gateId?: ProductionGateId | null;
  activityRole?: 'CURRENT_PRODUCTION' | 'HISTORICAL_EVIDENCE' | 'MATERIAL_COMPATIBILITY' | string;
  scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
  activeInCurrentProduction?: boolean;
};

export type CharacterCardSpec =
  | {
      role: 'TEMPLATE';
      layout: 'TWO_LINE';
      portrait: 'NONE';
      locale: 'zh-CN';
    }
  | {
      role: 'INSTANCE';
      templateFamilyId: 'CHARCARD-TEMPLATE-MAIN';
      characterId: string;
      displayName: string;
      contextLine: string;
      triggerKind: 'FIRST_CLEAR_APPEARANCE' | 'SCENE_CONTEXT_REVEAL';
      triggerSceneId: string;
      narrativeCue: string;
      occurrence: number;
      spoilerPolicy: 'KNOWN_AT_CUE';
    };

export type MaterialRequirement = {
  sourceKind?: string;
  reviewSpec?: ReviewSpec; configurationBinding?: ConfigurationBinding; businessCategoryPrimaryId?:string;businessCategorySecondaryId?:string;
  id: string;
  title: string;
  category: string;
  mediaKind: string;
  mediaType?: string;
  requirementClass: 'REQUIRED' | 'EVIDENCE_ONLY';
  reuseScope: string;
  productionLane: 'MATERIAL_PREP';
  workflowStepId: null;
  assetFamilyRefs: string[];
  plannedAssetFamilyId?: string | null;
  isNewRequirement?: boolean;
  materialWorkItemRef: string | null;
  consumerWorkItemRefs: string[];
  episodeIds: string[];
  episodeUids?: string[];
  sceneIds: string[];
  shotIds: string[];
  currentShotIds?: string[];
  structureCardRefs: string[];
  storyBasis: {
    sourceRef: string;
    factBoundary: string;
    whyNeeded?: string;
    onScreenRequirement?: string;
    authorityClass?: 'F' | 'A' | 'L' | 'U';
    evidenceRefs?: string[];
    evidenceSpecificity?: 'ITEM_EXACT' | 'SCENE_CONTEXT_ONLY' | 'PROJECT_POLICY_ONLY' | 'UNKNOWN';
  };
  projectScopeReason?: string | null;
  storyApplicability: { kind: 'SCENE_BOUND' | 'PROJECT_LEVEL'; reason: string | null };
  acceptanceProfile: string;
  acceptanceCriteria: string[];
  cardSpec?: CharacterCardSpec | null;
  plannedOutputPath?: string | null;
  requirementHash: string;
  coverageContextHash: string;
  coverageSatisfied: boolean;
  bindingStale: boolean;
  coverageReasons: string[];
  coveredByFamilyRefs: string[];
  coveredByVersionRefs: string[];
  materialWorkItemLifecycleState: string;
};

export type StructureCard = {
  id: string;
  objectRole: 'STRUCTURE_CARD_NOT_SHOT';
  episodeId: string;
  sceneId: string;
  segmentId: string;
  order: number;
  sourceUnitKind: string;
  sourceContent: string;
  lineBinding?: string | Record<string, unknown> | null;
  impactClassification: string;
  materialPreparationState: 'WAITING_MATERIAL_PREP';
  timingStatus: 'NOT_TIMING_LOCKED';
  executionAllowed: false;
  fixedOutput: null;
  modelBranch: null;
  reviewQuestions: string[];
  sceneMaterialRequirementRefs: string[];
  sceneMaterialAssetFamilyRefs: string[];
  sourceEvidence: {
    path?: string | null;
    lineStart?: number | null;
    lineEnd?: number | null;
    text?: string | null;
    fragment?: string | null;
    rangeStatus?: string | null;
    sourceTextSha256?: string | null;
    sourceFileSha256?: string | null;
  };
  sourceRef: string;
  boundary: string;
};

export type MaterialWorkItem = LifecycleProjection & {
  id: string;
  materialProductionPlanId?: string;
  label: string;
  lane: 'MATERIAL_PREP';
  workflowStepId: null;
  requirementRef: string;
  requirementHash: string;
  isNewRequirement?: boolean;
  scopeType: string;
  scopeId: string;
  episodeIds: string[];
  episodeUids?: string[];
  sceneIds: string[];
  shotIds: string[];
  structureCardRefs?: string[];
  inputAssetRefs: string[];
  outputAssetRef: string;
  additionalOutputAssetRefs: string[];
  consumerWorkItemRefs: string[];
  sourceRef: string;
  executionDefinitionRef?: string | null;
  definitionAuthoringState?: 'DEFINED' | 'REQUIRED';
  declaredExecutionGate?: string | null;
  generationAllowed?: boolean;
  executionBlockReasons?: string[];
  applicabilityState: 'REQUIRED';
};

export type V7WorkflowStep = {
  id: 'W01' | 'W02' | 'W03' | 'W04' | 'W05' | 'W06' | 'W07' | 'W08' | 'W09';
  order: number;
  label: string;
  technicalCodes: string[];
  purpose: string;
  reviewFocus: string;
  output: string;
  unlock: string;
  scope?: string;
};

export type V7ContinuityGroup = {
  id: string;
  segmentId: string;
  episodeId: string;
  sceneId: string;
  label: string;
  shotIds: string[];
  locs: string[];
  zones: string[];
  cameras: string[];
  stateFrom: string;
  stateTo: string;
  freezeFrom: string;
  freezeTo: string;
  isBusinessNavigationLevel: false;
  sourceRef: string;
};

export type V7WorkPackage = LifecycleProjection & {
  id: string;
  stepId: V7WorkflowStep['id'];
  label: string;
  scopeType: 'CONTINUITY_GROUP' | 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  scopeId: string;
  episodeId: string;
  episodeUid?: string;
  sceneId: string | null;
  segmentId: string | null;
  shotIds: string[];
  workItemRefs: string[];
  applicable: boolean;
  applicabilityState: 'REQUIRED' | 'SATISFIED_BY_EXISTING' | 'NOT_REQUIRED' | 'DATA_ERROR';
  notApplicableReason: string | null;
  isShared: boolean;
  reviewContextRef?: string | null;
  phaseId?: ProductionPhaseId | null;
  gateId?: ProductionGateId | null;
  activityRole?: 'CURRENT_PRODUCTION' | 'HISTORICAL_EVIDENCE' | 'MATERIAL_COMPATIBILITY' | string;
  scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
  activeInCurrentProduction?: boolean;
};

export type ProductionPhaseId = 'PREVIS' | 'SHOT_FINISH' | 'SCENE_FINISH' | 'EPISODE_FINISH' | 'SERIES_DELIVERY';
export type ProductionGateId =
  | 'SHOT_PLAN_INPUT_LOCK' | 'STORYBOARD_DIALOGUE' | 'ANIMATIC_LOCK'
  | 'KEYFRAMES' | 'SHOT_VIDEO' | 'SHOT_LOCK'
  | 'PICTURE_LOCK' | 'SOUND_MIX_SUBTITLES' | 'SCENE_QA'
  | 'EPISODE_ASSEMBLY' | 'EPISODE_REVIEW' | 'EPISODE_TECH_QC'
  | 'SERIES_CONTINUITY' | 'RIGHTS_SAFETY_TECH' | 'DELIVERY_ARCHIVE';

export type ProductionPhaseDefinition = {
  id: ProductionPhaseId;
  slug?: string;
  order: number;
  label: string;
  purpose: string;
  entryGateId?: ProductionGateId;
  exitGateId?: ProductionGateId;
  gateIds?: ProductionGateId[];
  legacyStepIds?: V7WorkflowStep['id'][];
  denominatorKnown?: boolean;
  denominatorState?: 'KNOWN' | 'UNKNOWN';
  denominator?: number | null;
  denominatorUnit?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  currentObjectCount?: number;
  currentWorkPackageCount?: number;
  currentWorkItemCount?: number;
  releasedWorkPackageCount?: number;
  releasedObjectCount?: number;
  completionState?: string;
  lifecycleRollup?: Record<string, number>;
  summary?: Record<string, unknown>;
  applicableCount?: number | null;
  completedCount?: number | null;
};

export type ProductionGateDefinition = {
  id: ProductionGateId;
  slug?: string;
  phaseId: ProductionPhaseId;
  order: number;
  label: string;
  purpose: string;
  scopeType?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT' | 'MIXED';
  legacyStepIds?: V7WorkflowStep['id'][];
  entryCriteria?: string[];
  exitCriteria?: string[];
  denominatorState?: 'KNOWN' | 'UNKNOWN';
  denominator?: number | null;
  denominatorUnit?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  currentObjectCount?: number;
  currentWorkPackageCount?: number;
  currentWorkItemCount?: number;
  releasedWorkPackageCount?: number;
  releasedObjectCount?: number;
  completionState?: string;
  lifecycleRollup?: Record<string, number>;
  summary?: Record<string, unknown>;
};

export type ExpectedOutput = {
  id: string;
  familyId: string;
  label: string;
  targetPath: string;
  plannedVersionLabel: string;
  legacyVersionId: string;
  expectationState: 'PLANNED' | 'REALIZED';
  realizedVersionId: string | null;
  realizedVersionSha256?: string | null;
  realizedAt?: string | null;
  executionDefinitionRef?: string | null;
  sourceRef?: string | null;
  promptRef?: string | null;
  model?: string | null;
};

export type ScopedReviewContext = {
  id: string;
  schemaVersion: '2.0';
  scopeType: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  scopeId: string;
  semanticStatus: 'AUTHORED_DRAFT' | 'ASSEMBLED_WITH_UNKNOWNS' | 'UNKNOWN_STALE_BINDING';
  reviewable: boolean;
  contextHash: string;
  binding?: {
    shotPlanRevisionId: string;
    shotDefinitionHash: string;
    bindingStatus: 'CURRENT' | 'NOT_AUTHORED' | 'MISMATCH';
    mismatchReasons: string[];
  };
  position?: Record<string, string | number | null>;
  scene?: {
    id: string;
    slugline?: string;
    scriptExcerpt?: string;
    route?: string;
    keyPropsAndState?: string;
    continuity?: string;
    shotIds?: string[];
  };
  episode?: {
    id: string;
    sceneIds?: string[];
    openingHook?: ReviewClaim;
    coreAdvance?: ReviewClaim;
    endingCliffhanger?: ReviewClaim;
  };
  project?: {
    id: string;
    episodeIds?: string[];
    sceneCount?: number;
    shotCount?: number;
    commercialReleaseCompliance?: string;
  };
  judgment?: {
    purpose?: ReviewClaim;
    audienceTakeaway?: ReviewClaim;
    reviewQuestion?: ReviewClaim;
  };
  sourceRefs?: string[];
};

export type V7AssetVersion = LifecycleProjection & {
  id: string;
  familyId: string;
  label: string;
  path: string | null;
  sha256: string | null;
  preview: string | null;
  audioProxy: string | null;
  promptRef: string | null;
  model: string | null;
  historyId: string | null;
  resourceId: string | null;
  reason?: string;
  sourceRef: string;
  executionDefinitionRef?: string | null;
  mediaUrl?: string | null;
  mediaToken?: string | null;
  dimensions?: [number, number] | null;
  byteSize?: number | null;
};

export type V7AssetFamily = LifecycleProjection & {
  id: string;
  materialProductionPlanId?: string;
  label: string;
  kind: string;
  subtype: string;
  episodeIds: string[];
  episodeUids?: string[];
  sceneIds: string[];
  segmentIds: string[];
  shotIds: string[];
  definitionStatus?: string;
  currentVersionId: string | null;
  versionRefs: string[];
  currentExpectedOutputId?: string | null;
  nextExpectedOutputId?: string | null;
  expectedOutputRefs?: string[];
  versionDeepLinkAliases?: Array<{ legacyVersionId: string; expectedOutputId: string }>;
  ownerRef?: string;
  usedByRefs?: string[];
  materialRequirementRefs?: string[];
  sourceRef: string;
  executionDefinitionRef?: string | null;
  scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
  activityRole?: 'CURRENT_PRODUCTION' | 'HISTORICAL_EVIDENCE' | 'MATERIAL_COMPATIBILITY' | 'PLANNING_SKELETON' | string;
};

export type V7Shot = LifecycleProjection & {
  id: string;
  episodeId: string;
  episodeUid?: string;
  sceneId: string;
  segmentId: string;
  beatId: string;
  title: string;
  sourceContent: string;
  durationSeconds: number;
  durationStatus: string;
  branch: string;
  dialogue: unknown;
  characters: string[];
  locs: string[];
  zones: string[];
  cameras: string[];
  stageInstanceRefs: string[];
  defaultStageInstanceId: string;
  workPackageRefs: string[];
  defaultWorkPackageId: string;
  requiredAssetRefs: string[];
  materialRequirementRefs?: string[];
  candidateAssetRefs: string[];
  progress: { completed: number; applicable: number };
  issueRefs: string[];
  nextAction: string;
  storyboardPreview: string | null;
  storyboardApprovalStatus: string;
  sourceRef: string;
  reviewContext: ShotReviewContext;
  scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
  activityRole?: string;
  activeInCurrentProduction?: boolean;
  shotPlanSetRevisionId?: string;
  shotPlanSetRevisionHash?: string;
  inputLockState?: string;
};

export type V7Issue = {
  id: string;
  title: string;
  state: string;
  stateText: string;
  stageKey: string;
  workflowStepId?: string;
  episodeIds: string[];
  sceneIds: string[];
  shotIds: string[];
  assetRefs: string[];
  fact: string;
  nextAction: string;
  userAction: string;
  responsibleParty: string;
  acceptance: string[];
  evidenceRefs: string[];
  sourceRef: string;
  requiresDestructiveConfirmation: boolean;
};

export type PostProductionTask = LifecycleProjection & {
  id: string;
  pipelineStageCode: string;
  scopeType: 'SCENE' | 'EPISODE' | 'PROJECT' | string;
  scopeId: string;
  episodeId?: string | null;
  sceneId?: string | null;
  label: string;
  status?: string;
  workItemRef?: string | null;
  inputs?: string[];
  inputAssetRefs?: string[];
  outputs?: string[];
  outputAssetRefs?: string[];
  acceptance?: string[];
  sourceRef?: string | null;
  executionDefinitionRef?: string | null;
};

export type ReviewAction = 'APPROVE_AND_RELEASE' | 'REQUEST_REVISION' | 'DO_NOT_USE';
type LegacyReviewDecision = 'PASS' | 'REVISE' | 'HOLD';

type CriterionFinding = {
  criterionId: string;
  verdict: 'PASS' | 'FAIL' | 'NA';
  note: string;
};

export type ReviewEventRecord = {
  schemaVersion?: string;
  eventId: string;
  eventKind?: 'review';
  recordedAt: string;
  snapshotId: string;
  shotId?: string;
  reviewContextRef?: string | null;
  reviewScopeType?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  reviewScopeId?: string;
  reviewContextSemanticStatus?: string;
  productionPhaseId?: ProductionPhaseId | null;
  productionGateId?: ProductionGateId | null;
  scopeType?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT' | null;
  scopeId?: string | null;
  workPackageId?: string;
  workItemId?: string;
  familyId: string;
  versionId: string;
  versionSha256: string;
  action?: ReviewAction;
  decision?: LegacyReviewDecision;
  reviewDecision?: 'RELEASED' | 'REVISION_REQUIRED' | 'DO_NOT_USE';
  projectRightsGateAtReview?: string;
  appliedProjectRightsGate?: string;
  lifecycleState?: string;
  canFlowDownstream?: boolean;
  note?: string;
  effect?: string;
  subjectType?: 'STRUCTURE' | 'CREATIVE_REVISION' | 'SCRIPT_SCENE' | 'ASSET' | 'WORK_PRODUCT';
  subjectKind?: 'EPISODE_PLAN' | 'SCENE_COVERAGE' | 'SHOT_PLAN_SET';
  subjectId?: string;
  subjectRevisionId?: string;
  subjectRevisionHash?: string;
  contextHash?: string;
  criterionFindings?: CriterionFinding[];
  revisionInstructions?: {
    preserve?: string[];
    change?: string[];
    mustNotRegress?: string[];
  };
};

type RevisionInstructions = {
  preserve: string;
  change: string;
  mustNotRegress: string;
};

export type ExecutionUiContext = {
  expectedOutput?: ExpectedOutput | null;
  configurationBinding?: import("../host/instance-runtime/configuration-model.mjs").ConfigurationBinding;
  snapshotId: string;
  mutationEtag: string | null;
  shotId: string;
  workPackageId: string;
  workItemId: string;
  familyId: string | null;
  parentVersionId: string | null;
  canAuthorize: boolean;
  authorizeReason: string;
};

type OperationAggregate<T> = { aggregateId: string; event: T };

export type OperationalSnapshot = {
  snapshotId?: string;
  baseSnapshotId?: string;
  operationalRevision?: string;
  operationRevision?: string;
  mutationEtag?: string;
  etag?: string;
  counts?: { reviews?: number; candidates?: number; runs?: number; total?: number };
  reviews?: {
    events?: ReviewEventRecord[];
    latestByWorkItemVersion?: Array<OperationAggregate<ReviewEventRecord>>;
    latestByWorkItem?: Array<OperationAggregate<ReviewEventRecord>>;
    projectedByVersion?: Array<OperationAggregate<ReviewEventRecord>>;
    projectedByAssetVersion?: Array<OperationAggregate<ReviewEventRecord>>;
    projectedByWorkItem?: Array<OperationAggregate<ReviewEventRecord>>;
  };
  stateProjection?: OperationalStateProjection;
  p07Released?: { allReleased?: boolean; remainingWorkItems?: number };
};

type EntityStateProjection = LifecycleProjection & Record<string, unknown>;

export type OperationalStateProjection = {
  executionGatesByWorkItem?: Record<string,string[]>;
  configuredGatesByWorkItem?: Record<string,import("./gate-evaluation").ConfiguredGate>;
  schemaVersion: '2.0' | '2.1';
  assetVersionsById: Record<string, EntityStateProjection & { familyId?: string; path?: string | null; sha256?: string | null; label?: string; mediaToken?: string | null }>;
  assetFamiliesById: Record<string, EntityStateProjection & { currentVersionId?: string | null; adoptedVersionId?: string | null; decisionVersionId?: string | null; currentExpectedOutputId?: string | null; nextExpectedOutputId?: string | null; realizedExpectedOutputIds?: string[]; versionRefs?: string[] }>;
  expectedOutputsById?: Record<string, { expectationState?: 'PLANNED' | 'REALIZED'; realizedVersionId?: string | null; realizedVersionSha256?: string | null; realizedAt?: string | null }>;
  workItemsById: Record<string, EntityStateProjection>;
  materialWorkItemsById?: Record<string, EntityStateProjection>;
  materialRequirementsById?: Record<string, Record<string, unknown>>;
  materialStoryRelations?: Record<string, unknown>;
  scriptScenesById?: Record<string, EntityStateProjection>;
  verificationsByIssue?: Record<string, EntityStateProjection>;
  workPackagesById: Record<string, EntityStateProjection>;
  shotsById: Record<string, EntityStateProjection>;
  scenesById: Record<string, EntityStateProjection>;
  episodesById: Record<string, EntityStateProjection>;
  reviewRollups?: Record<string, { required: number; released: number; lifecycleState: string }>;
};

export function resolveAdoptedVersionId(
  family: Pick<V7AssetFamily, 'id' | 'currentVersionId'>,
  projection?: OperationalStateProjection | null,
) {
  const projectedFamily = projection?.assetFamiliesById[family.id];
  if (projectedFamily && Object.prototype.hasOwnProperty.call(projectedFamily, 'adoptedVersionId')) {
    return String(projectedFamily.adoptedVersionId || '') || null;
  }
  return String(family.currentVersionId || '') || null;
}

export type MaterialFileVersionBucket = 'ADOPTED' | 'CANDIDATE' | 'HISTORY_OR_DISABLED';

export function classifyMaterialFileVersion(
  version: Pick<V7AssetVersion, 'id' | 'historyRole' | 'lifecycleState'>,
  adoptedVersionIds: ReadonlySet<string>,
): MaterialFileVersionBucket {
  if (adoptedVersionIds.has(version.id)) return 'ADOPTED';
  if (
    ['EVIDENCE_ONLY', 'SUPERSEDED'].includes(String(version.historyRole || ''))
    || ['EVIDENCE_ONLY', 'DO_NOT_USE'].includes(String(version.lifecycleState || ''))
  ) return 'HISTORY_OR_DISABLED';
  return 'CANDIDATE';
}

export type ProductionModel = {
  systemConfiguration?:{reference:ConfigurationRef;config:Configuration;defaults?:Configuration};
  schemaVersion: string;
  policy: Record<string, string>;
  stageDefinitions: Array<{ key: string; label: string; scope: string; note?: string }>;
  productionPhases?: ProductionPhaseDefinition[];
  productionGates?: ProductionGateDefinition[];
  workflowSteps: V7WorkflowStep[];
  continuityGroups: V7ContinuityGroup[];
  workItems: V7WorkItem[];
  workPackages: V7WorkPackage[];
  materialRequirements?: MaterialRequirement[];
  materialWorkItems?: MaterialWorkItem[];
  materialStoryRelations?: Record<string, unknown>;
  structureCards?: StructureCard[];
  revisionPointers?: {
    currentStoryRevisionId?: string | null;
    currentScriptRevisionId?: string | null;
    currentSceneScriptRevisionIds?: Record<string, string> | string[];
    episodePlanProposalRevisionId?: string | null;
    currentEpisodePlanRevisionId?: string | null;
    screenplayReleaseSnapshotId?: string | null;
  };
  storyRevisions?: Array<{
    id: string;
    revisionHash?: string;
    contentHash?: string;
    status?: string;
    scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
    isCurrent?: boolean;
    sourceBindings?: Array<{ bindingType?: string; path?: string; sha256?: string }>;
  }>;
  scriptRevisions?: Array<{
    id: string;
    revisionHash?: string;
    contentHash?: string;
    sourceSha256?: string;
    status?: string;
    scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
    isCurrent?: boolean;
  }>;
  episodePlanRevisions?: Array<{
    id: string;
    planId: string;
    episodes: Array<{
      episodeUid: string;
      displayId: string;
      title: string;
      sceneIds: string[];
      openingHook: string;
      coreAdvance: string;
      endingCliffhanger: string;
      reviewQuestion: string;
      reviewDossier: EpisodeReviewDossier;
    }>;
    retiredEpisodeUids?: string[];
    status?: string;
    scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN';
    revisionState?: string;
    isCurrentProposal?: boolean;
    basisBindings?: Array<{ bindingType: string; bindingId: string; bindingHash: string; scopeType?: string; scopeId?: string }>;
    sourcePath?: string;
    sourceSha256?: string;
    revisionHash?: string;
    review?: { state?: string; decision?: string | null };
    sync?: { state?: string; sourceOperationRequired?: boolean };
  }>;
  sceneCoveragePlanRevisions?: Array<Record<string, unknown>>;
  screenplayReleaseSnapshots?: Array<Record<string, unknown>>;
  scopeLocks?: Array<{ id: string; scopeType: string; scopeId: string; lockState: string; denominatorState: string; denominator?: number | null; discoveredCount?: number | null; sourceRef?: string }>;
  shotPlanSetRevisions?: Array<Record<string, unknown>>;
  episodes: Array<{ id: string; episodeUid: string; displayId: string; canonicalScopeId?: string; sceneIds: string[]; segmentIds: string[]; shotIds: string[]; calibrationShotCount: number; sourceRef: string; scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN'; storyHandoff?: Record<string, unknown> }>;
  scenes: Array<{ id: string; episodeId: string; episodeUid: string; title: string; segmentIds: string[]; shotIds: string[]; stageInstanceRefs: string[]; stageSummary: Record<string, { planned: number; generated: number }>; isCalibrationSubset: boolean; workflowEligible: boolean; lifecycleState?: string; issueRefs: string[]; sourceRef: string; scopeRole?: 'CURRENT' | 'PROPOSAL' | 'HISTORICAL' | 'UNKNOWN'; storyHandoff?: Record<string, unknown> }>;
  segments: Array<{ id: string; episodeId: string; sceneId: string; order: number; title: string; shotIds: string[]; beatIds: string[]; locs: string[]; zones: string[]; cameras: string[]; stateFrom: string; stateTo: string; freezeFrom: string; freezeTo: string; sourceRef: string }>;
  beats: Array<{ id: string; episodeId: string; sceneId: string; segmentId: string; shotIds: string[]; action: string; stateBefore: string; stateAfter: string; sourceRef: string }>;
  shots: V7Shot[];
  stageInstances?: V7WorkItem[];
  assetFamilies: V7AssetFamily[];
  assetVersions: V7AssetVersion[];
  expectedOutputs?: ExpectedOutput[];
  reviewContexts?: ScopedReviewContext[];
  dependencyEdges?: Array<{ id: string; from: string; to: string; relation: string; evidence: string }>;
  issues: V7Issue[];
  executionRecipeSummary?: {
    schemaVersion: string;
    snapshotId: string;
    counts: { definitions: number; modelCalls: number; manualEditTasks: number; byStage: Record<string, number>; documents: number; promptRevisions: number; postProductionTasks: number };
    executionDocuments: Array<{ id: string; path: string; title: string; sha256: string; byteSize: number }>;
    postProductionTasks: PostProductionTask[];
    sourceCatalog: Array<Record<string, unknown>>;
    integrity: Record<string, boolean>;
    recipeApi: string;
  };
  systemModel?: Record<string, unknown>;
  snapshotManifest?: { snapshotId: string; schemaVersion: string; sourceCatalog: Array<Record<string, unknown>>; integrity: Record<string, boolean> };
  reviewContextCatalog?: {
    schemaVersion: string; datasetId: string; reviewStatus: string; sourcePath: string; sourceSha256: string;
    authoredShotCount: number; assembledShotCount: number; totalShotCount: number; objectTypes: string[];
    evidenceCatalog?: Record<string, ReviewEvidence>;
  };
  counts: {
    episodes: number;
    scenes: number;
    segments: number;
    beats: number;
    shots: number;
    structureCards?: number;
    executableShotDefinitions?: number;
    waitingShotPlans?: number;
    currentShotSpecCount?: number;
    currentP07ShotPlans?: number;
    historicalP07ShotIdentities?: number;
    historicalP07ExecutableDefinitions?: number;
    historicalP07NoDefinitionPlans?: number;
    pendingP07ReauthoringScenes?: number;
    executableScenes?: number;
    structuralWaitingScenes?: number;
    stageInstances: number;
    stageInstancesByKey: Record<string, number>;
    assetFamilies: number;
    assetVersions: number;
    dependencyEdges: number;
    calibrationShots: number;
    p07Materialized: number;
    p07Released: number;
    workItems?: number;
    workPackages?: number;
    materialRequirements?: number;
    requiredMaterialRequirements?: number;
    materialWorkItems?: number;
    workPackagesByStep?: Record<string, number>;
  };
};

export function proposalEpisodeRange(model: Pick<ProductionModel, 'episodes'>) {
  const first = model.episodes[0]?.id;
  const last = model.episodes.at(-1)?.id;
  if (!first || !last) return '分集UNKNOWN';
  return first === last ? first : `${first}–${last}`;
}

export function episodePlanIsCurrent(model: Pick<ProductionModel, 'episodes'>) {
  return model.episodes.length > 0 && model.episodes.every((episode) => episode.scopeRole === 'CURRENT');
}

function episodePlanRangeLabel(model: Pick<ProductionModel, 'episodes'>) {
  return `${proposalEpisodeRange(model)}${episodePlanIsCurrent(model) ? '当前分集方案' : '导航提案'}`;
}

export function applyOperationalProjection(model: ProductionModel, projection?: OperationalStateProjection | null): ProductionModel {
  if (!projection || !['2.0', '2.1'].includes(projection.schemaVersion)) return model;
  const overlay = <T extends { id: string }>(records: T[], values: Record<string, EntityStateProjection>) => (
    records.map((record) => ({ ...record, ...(values[record.id] || {}) }))
  );
  const assetVersions = overlay(model.assetVersions, projection.assetVersionsById);
  const knownVersionIds = new Set(assetVersions.map((version) => version.id));
  for (const [id, value] of Object.entries(projection.assetVersionsById)) {
    if (knownVersionIds.has(id) || !value.familyId) continue;
    assetVersions.push({
      id,
      familyId: value.familyId,
      label: value.label || id,
      path: value.path || null,
      sha256: value.sha256 || null,
      preview: null,
      audioProxy: null,
      promptRef: null,
      model: null,
      historyId: null,
      resourceId: null,
      sourceRef: 'ReviewEvent 2.2 operational projection',
      mediaToken: value.mediaToken || null,
      ...value,
    });
  }
  const workItems = overlay(model.workItems, projection.workItemsById);
  const materialWorkItems = overlay(model.materialWorkItems || [], projection.materialWorkItemsById || {});
  const materialRequirements = (model.materialRequirements || []).map((requirement) => ({
    ...requirement,
    ...(projection.materialRequirementsById?.[requirement.id] || {}),
  })) as MaterialRequirement[];
  const postProductionTasks = (model.executionRecipeSummary?.postProductionTasks || []).map((task) => (
    task.workItemRef && projection.workItemsById[task.workItemRef]
      ? { ...task, ...projection.workItemsById[task.workItemRef] }
      : task
  ));
  return {
    ...model,
    ...(projection.configuredGatesByWorkItem ? configuredProductionProgress(model as unknown as Record<string,unknown>,projection) as {productionGates:ProductionGateDefinition[];productionPhases:ProductionPhaseDefinition[]} : {}),
    assetVersions,
    assetFamilies: overlay(model.assetFamilies, projection.assetFamiliesById),
    expectedOutputs: (model.expectedOutputs || []).map((expected) => ({
      ...expected,
      ...(projection.expectedOutputsById?.[expected.id] || {}),
    })),
    workItems,
    materialWorkItems,
    materialRequirements,
    materialStoryRelations: projection.materialStoryRelations
      ? { ...(model.materialStoryRelations || {}), ...projection.materialStoryRelations }
      : model.materialStoryRelations,
    stageInstances: model.stageInstances ? overlay(model.stageInstances, projection.workItemsById) : undefined,
    workPackages: overlay(model.workPackages, projection.workPackagesById),
    shots: overlay(model.shots, projection.shotsById),
    scenes: overlay(model.scenes, projection.scenesById),
    episodes: overlay(model.episodes, projection.episodesById),
    executionRecipeSummary: model.executionRecipeSummary && postProductionTasks
      ? { ...model.executionRecipeSummary, postProductionTasks }
      : model.executionRecipeSummary,
    counts: {
      ...model.counts,
      p07Released: projection.reviewRollups?.P07?.released ?? model.counts.p07Released,
      assetVersions: assetVersions.length,
    },
  };
}

export type ProductionContext = {
  shotId: string;
  workPackageId: string;
  workItemId: string | null;
  familyId: string | null;
  versionId: string | null;
  phaseId?: ProductionPhaseId | null;
  gateId?: ProductionGateId | null;
};

export type ProductionNavigationIntent = {
  shotId: string;
  workPackageId?: string | null;
  workItemId?: string | null;
  familyId?: string | null;
  versionId?: string | null;
  legacyStage?: string | null;
  phaseId?: ProductionPhaseId | null;
  gateId?: ProductionGateId | null;
  /** Navigation only. These fields never replace the work product's formal scope. */
  creatorStageId?: string;
  preparationEpisodeUid?: string;
  preparationSceneId?: string;
  navigationScopeType?: 'SCENE' | 'EPISODE' | 'PROJECT';
};

export type ProductionNavigate = (intent: ProductionNavigationIntent) => void;

type ContextProps = ProductionContext & {
  model: ProductionModel;
  onNavigate: ProductionNavigate;
  workPackage?: V7WorkPackage | null;
};

export function resolveProductionContext(model: ProductionModel, intent: ProductionNavigationIntent): ProductionContext {
  const globallyRequestedItem = intent.workItemId
    ? model.workItems.find((item) => publicRefMatches(item.id, intent.workItemId)) || null
    : null;
  const globallyRequestedPackage = intent.workPackageId
    ? model.workPackages.find((item) => publicRefMatches(item.id, intent.workPackageId) && (!globallyRequestedItem || item.workItemRefs.includes(globallyRequestedItem.id))) || null
    : globallyRequestedItem
      ? model.workPackages.find((item) => item.workItemRefs.includes(globallyRequestedItem.id)) || null
      : null;
  const requestedShot = model.shots.find((item) => item.id === intent.shotId || publicRefMatches(item.id, intent.shotId)) || null;
  const shot = globallyRequestedPackage && (!requestedShot || !globallyRequestedPackage.shotIds.includes(requestedShot.id))
    ? model.shots.find((item) => item.id === globallyRequestedPackage.shotIds[0]) || requestedShot || model.shots[0]
    : requestedShot || model.shots[0];
  if (!shot) throw new Error('生产模型中没有可解析的分镜');
  const packages = shot.workPackageRefs
    .map((id) => model.workPackages.find((item) => item.id === id))
    .filter((item): item is V7WorkPackage => Boolean(item));
  const packageItemIds = new Set(packages.flatMap((item) => item.workItemRefs));
  const legacyItem = intent.legacyStage
    ? model.workItems.find((item) => packageItemIds.has(item.id) && (
      item.id === intent.legacyStage || item.legacyStageId === intent.legacyStage
      || item.stageKey === intent.legacyStage || item.pipelineStageCode === intent.legacyStage
    ))
    : null;
  const workPackage = (globallyRequestedPackage && packages.some((item) => item.id === globallyRequestedPackage.id) ? globallyRequestedPackage : null)
    || packages.find((item) => publicRefMatches(item.id, intent.workPackageId))
    || (legacyItem ? packages.find((item) => item.workItemRefs.includes(legacyItem.id)) : null)
    || packages.find((item) => item.activeInCurrentProduction === true && item.stepId !== 'W01')
    || packages.find((item) => item.id === shot.defaultWorkPackageId && item.stepId !== 'W01')
    || packages.find((item) => item.stepId !== 'W01')
    || packages[0];
  if (!workPackage) throw new Error(`${shot.id} 没有可解析的工作包`);
  const phases = productionPhases(model);
  const gates = productionGates(model);
  const requestedGate = intent.gateId ? gates.find((gate) => gate.id === intent.gateId) || null : null;
  const packageGateId = workPackage.gateId || gateForStep(workPackage.stepId, model);
  const packagePhaseId = workPackage.phaseId || phaseForStep(workPackage.stepId, model);
  const phaseId = requestedGate?.phaseId
    || (intent.phaseId && phases.some((phase) => phase.id === intent.phaseId) ? intent.phaseId : null)
    || packagePhaseId;
  const phase = phases.find((entry) => entry.id === phaseId) || phases[0];
  if (!phase) throw new Error('当前快照缺少正式制作检查定义；前端不使用内置阶段兜底');
  const gateId = requestedGate?.id
    || (gates.some((gate) => gate.id === packageGateId && gate.phaseId === phase.id) ? packageGateId : null)
    || phase.entryGateId
    || gates.find((gate) => gate.phaseId === phase.id)?.id
    || null;
  if (workPackage.applicabilityState === 'NOT_REQUIRED') {
    return { shotId: shot.id, workPackageId: workPackage.id, workItemId: null, familyId: null, versionId: null, phaseId: phase.id, gateId };
  }
  const items = packageItems(model, workPackage);
  const requestedFamily = intent.familyId
    ? model.assetFamilies.find((family) => publicRefMatches(family.id, intent.familyId)) || null
    : null;
  const familyBoundItem = requestedFamily
    ? items.find((item) => item.outputAssetRef === requestedFamily.id || item.inputAssetRefs.includes(requestedFamily.id) || (item.additionalOutputAssetRefs || []).includes(requestedFamily.id))
    : null;
  const workItem = items.find((item) => publicRefMatches(item.id, intent.workItemId))
    || familyBoundItem
    || items.find((item) => item.pipelineStageCode === 'P07')
    || items[0]
    || null;
  const allowedFamilyIds = new Set(workItem ? [
    ...(workItem.outputAssetRef ? [workItem.outputAssetRef] : []),
    ...workItem.inputAssetRefs,
    ...(workItem.additionalOutputAssetRefs || []),
  ] : []);
  const family = requestedFamily && allowedFamilyIds.has(requestedFamily.id)
    ? requestedFamily
    : workItem?.outputAssetRef
      ? model.assetFamilies.find((item) => item.id === workItem.outputAssetRef) || null
      : null;
  const version = resolveFamilyVersionSelection(model, family, intent.versionId);
  return {
    shotId: shot.id,
    workPackageId: workPackage.id,
    workItemId: workItem?.id || null,
    familyId: family?.id || null,
    versionId: version,
    phaseId: phase.id,
    gateId,
  };
}

const stageToStep: Record<string, V7WorkflowStep['id']> = {
  P04B: 'W01', P07: 'W02', P08: 'W02', P09: 'W03', P10: 'W04', KFA: 'W04', KFB: 'W04', P11: 'W05', P12: 'W06',
  P13: 'W07', P14: 'W08', P15: 'W09',
};

const deliverableLabels: Record<string, string> = {
  LOC_STATE: '本连续性组地点状态',
  STORYBOARD: '单镜构图草图',
  DIALOGUE_DRY: '本句对白干声',
  ANIMATIC: '全场有声动态分镜',
  START_FRAME: '正式首帧',
  END_FRAME: '正式尾帧',
  PRE_LIP_VIDEO: '口型前动态镜头',
  AUDIO_DRIVEN_VIDEO: '声音驱动镜头',
  NO_LIP_VIDEO: '无对白动态镜头',
  POST_LIP_VIDEO: '口型终版',
  SCENE_SOUND_POST: '整场声音后期',
  EPISODE_DELIVERY_MASTER: '分集成片母版',
  PROJECT_DELIVERY_MANIFEST: '全剧终审交付包',
};

function statusTone(value?: string | null) {
  const code = value || '';
  if (/BLOCK|DO_NOT_USE|REJECT|FAIL|REVISION|RIGHTS_HOLD/.test(code)) return 'danger';
  if (/PASS|APPROVED|ELIGIBLE|COMPLETE|GENERATED|READY|RECORDED|RELEASED|SATISFIED_BY_EXISTING/.test(code)) return 'good';
  if (/NOT_APPLICABLE|LEGACY|EVIDENCE_ONLY|DELETED_AUDIT/.test(code)) return 'neutral';
  if (/PENDING|REVIEW|WAIT|HOLD|UNKNOWN|NOT_RUN|NOT_STARTED|PLANNED|TODO|IN_PROGRESS|RESULT_/.test(code)) return 'waiting';
  return 'neutral';
}

function directorStatus(value?: string | null) {
  if (!value) return '状态未登记';
  const semantic = visibleText(value);
  if (/[一-鿿]/.test(value)) return semantic;
  if (/DO_NOT_USE/.test(value)) return '禁止使用';
  if (/RELEASED/.test(value)) return '通过并放行';
  if (/SATISFIED_BY_EXISTING/.test(value)) return '既有资产满足';
  if (/RIGHTS_HOLD/.test(value)) return '权利阻断';
  if (/RESULT_PENDING_REGISTRATION/.test(value)) return '结果待登记';
  if (/RESULT_UNKNOWN/.test(value)) return '执行结果不明';
  if (/IN_PROGRESS/.test(value)) return '制作中';
  if (/REJECT|FAIL|REVISION/.test(value)) return '需要返修';
  if (/BLOCK/.test(value)) return '当前阻断';
  if (/NOT_APPLICABLE|LEGACY/.test(value)) return '本项不适用';
  if (/WAITING_USER|PENDING_USER|REVIEW_PENDING|PENDING/.test(value)) return '等待你的审阅';
  if (/HOLD|WAITING_DEPENDENCY|WAITING_P07|WAITING/.test(value)) return '等待上游完成';
  if (/GENERATED/.test(value)) return '已有产出，待确认';
  if (/APPROVED|ELIGIBLE|COMPLETE|READY|PASS/.test(value)) return '已就绪';
  if (/PLANNED|NOT_STARTED|NOT_RUN|TODO/.test(value)) return '尚未开始';
  if (/UNKNOWN/.test(value)) return '信息待确认';
  return semantic;
}

function itemDirectorStatus(item: V7WorkItem) {
  return deriveHeadlineState(item).label;
}

function isLifecycleComplete(record: LifecycleProjection) {
  return record.lifecycleState === 'RELEASED' || record.lifecycleState === 'SATISFIED_BY_EXISTING' || record.lifecycleState === 'NOT_APPLICABLE';
}

export type FullProductionFilter = 'ALL' | 'ACTIONABLE' | 'REVIEW_PENDING' | 'REVISION_REQUIRED' | 'BLOCKED';

export type FullProductionStageSummary = {
  stepId: V7WorkflowStep['id'];
  denominatorKnown: boolean;
  applicableCount: number | null;
  completedCount: number | null;
  registeredPlanCount: number;
  actionableCount: number;
  reviewCount: number;
  revisionCount: number;
  blockedCount: number;
};

export const fullProductionScopeDimensions: Record<V7WorkflowStep['id'], Array<'CONTINUITY_GROUP' | 'SCENE' | 'SHOT' | 'LANE' | 'EPISODE' | 'PROJECT'>> = {
  W01: ['CONTINUITY_GROUP'],
  W02: ['SCENE', 'SHOT', 'LANE'],
  W03: ['SCENE'],
  W04: ['SCENE', 'SHOT'],
  W05: ['SCENE', 'SHOT'],
  W06: ['SCENE', 'SHOT'],
  W07: ['SCENE'],
  W08: ['EPISODE'],
  W09: ['PROJECT'],
};

const fullProductionFilterDefinitions: Array<{ id: FullProductionFilter; label: string; description: string }> = [
  { id: 'ALL', label: '全部', description: '查看本步骤全部当前对象' },
  { id: 'ACTIONABLE', label: '可推进', description: '可以开始、正在制作或等待登记结果' },
  { id: 'REVIEW_PENDING', label: '待我审阅', description: '已有候选，等待正式判断' },
  { id: 'REVISION_REQUIRED', label: '待返修', description: '按审阅意见创建新版本' },
  { id: 'BLOCKED', label: '异常', description: '结果不明、失败、禁用或硬阻断' },
];

export function formalCurrentShotSpecIds(model: ProductionModel) {
  return new Set<string>(
    model.shots
      .filter((shot) => (
        shot.scopeRole === 'CURRENT'
        && shot.activeInCurrentProduction === true
        && shot.shotPlanSetRevisionId
      ))
      .map((shot) => shot.id),
  );
}

export function fullProductionCurrentP07ShotIds(model: ProductionModel) {
  const ids = new Set<string>();
  if (model.counts.currentP07ShotPlans === 0) return ids;
  model.workItems
    .filter((record) => {
      if (record.workflowStepId !== 'W02' || record.pipelineStageCode !== 'P07' || !record.shotId) return false;
      if (['EVIDENCE_ONLY', 'DO_NOT_USE', 'SUPERSEDED', 'DELETED_AUDIT'].includes(record.historyRole || '')) return false;
      const reviewContext = record.reviewContextRef
        ? (model.reviewContexts || []).find((context) => context.id === record.reviewContextRef)
        : null;
      return reviewContext?.scopeType === 'SHOT'
        && reviewContext.scopeId === record.shotId
        && reviewContext.binding?.bindingStatus === 'CURRENT';
    })
    .forEach((record) => ids.add(record.shotId as string));
  return ids;
}

export function fullProductionCurrentShotIds(model: ProductionModel) {
  return new Set([...formalCurrentShotSpecIds(model), ...fullProductionCurrentP07ShotIds(model)]);
}

export function fullProductionPackagesForStep(model: ProductionModel, stepId: V7WorkflowStep['id']) {
  const currentShotIds = fullProductionCurrentShotIds(model);
  return model.workPackages.filter((record) => {
    if (record.stepId !== stepId || record.applicabilityState === 'NOT_REQUIRED' || stepId === 'W01') return false;
    if (record.activeInCurrentProduction === false || currentShotIds.size === 0) return false;
    if (record.activeInCurrentProduction === true) return true;
    return record.shotIds.some((id) => currentShotIds.has(id));
  });
}

export function fullProductionPackagesForGate(model: ProductionModel, gate: ProductionGateDefinition) {
  const legacyStepIds = gate.legacyStepIds || [];
  const explicitGatePackages = model.workPackages.filter((record) => (
    record.activeInCurrentProduction === true
    && record.gateId === gate.id
    && record.stepId !== 'W01'
    && record.applicabilityState !== 'NOT_REQUIRED'
  ));
  const compatibilityPackages = legacyStepIds.flatMap((stepId) => fullProductionPackagesForStep(model, stepId));
  return [...explicitGatePackages, ...compatibilityPackages].filter((record, index, records) => {
    const recordGateId = record.gateId || gateForStep(record.stepId, model);
    return recordGateId === gate.id && records.findIndex((entry) => entry.id === record.id) === index;
  });
}

/** Scope by permanent identities; an episode workspace never selects a scene as its scope. */
export function productionPackagesInNavigationScope(model: ProductionModel, gate: ProductionGateDefinition, scope: { navigationScopeType: 'SCENE' | 'EPISODE' | 'PROJECT'; episodeUid?: string; sceneId?: string }) {
  return fullProductionPackagesForGate(model, gate).filter(record => {
    if (record.scopeType !== gate.scopeType || (record.phaseId && record.phaseId !== gate.phaseId)) return false;
    if (scope.navigationScopeType === 'PROJECT') return gate.scopeType === 'PROJECT' && record.scopeType === 'PROJECT' && record.scopeId === projectIdFor(model);
    if (scope.navigationScopeType === 'EPISODE') return gate.scopeType === 'EPISODE' && Boolean(scope.episodeUid) && record.episodeUid === scope.episodeUid && record.scopeId === scope.episodeUid;
    if (!scope.sceneId || !['SHOT', 'SCENE'].includes(gate.scopeType || '')) return false;
    if (record.scopeType === 'SCENE') return record.sceneId === scope.sceneId && record.scopeId === scope.sceneId;
    if (record.scopeType !== 'SHOT') return false;
    const shot = model.shots.find(item => item.id === record.scopeId && item.sceneId === scope.sceneId);
    return Boolean(shot && record.shotIds.includes(shot.id) && fullProductionCurrentShotIds(model).has(shot.id));
  });
}

export function productionProgressLabel(definition: {
  denominatorState?: 'KNOWN' | 'UNKNOWN';
  denominator?: number | null;
  releasedObjectCount?: number;
}) {
  if (definition.denominatorState !== 'KNOWN' || typeof definition.denominator !== 'number') return 'UNKNOWN';
  const released = Math.max(0, Math.min(definition.denominator, definition.releasedObjectCount || 0));
  return `${released}/${definition.denominator}`;
}

function packageLifecycleStates(model: ProductionModel, workPackage: V7WorkPackage) {
  const itemStates = packageItems(model, workPackage).map((item) => item.lifecycleState || 'UNKNOWN');
  return itemStates.length ? itemStates : [workPackage.lifecycleState || workPackage.applicabilityState || 'UNKNOWN'];
}

export function fullProductionFilterMatches(model: ProductionModel, workPackage: V7WorkPackage, filter: FullProductionFilter) {
  if (filter === 'ALL') return true;
  const states = packageLifecycleStates(model, workPackage);
  if (filter === 'ACTIONABLE') return states.some((state) => ['READY_TO_START', 'IN_PROGRESS', 'RESULT_PENDING_REGISTRATION'].includes(state));
  if (filter === 'REVIEW_PENDING') return states.some((state) => state === 'REVIEW_PENDING');
  if (filter === 'REVISION_REQUIRED') return states.some((state) => state === 'REVISION_REQUIRED');
  return workPackage.applicabilityState === 'DATA_ERROR'
    || states.some((state) => ['DO_NOT_USE', 'RIGHTS_HOLD', 'BLOCKED', 'RESULT_UNKNOWN', 'EXECUTION_FAILED'].includes(state));
}

export function buildFullProductionStageSummaries(model: ProductionModel): FullProductionStageSummary[] {
  return model.workflowSteps.slice().sort((a, b) => a.order - b.order).map((step) => {
    const packages = fullProductionPackagesForStep(model, step.id);
    const phase = productionPhases(model).find((entry) => entry.legacyStepIds?.includes(step.id));
    const denominatorKnown = phase?.denominatorState === 'KNOWN';
    return {
      stepId: step.id,
      denominatorKnown,
      applicableCount: denominatorKnown ? packages.length : null,
      completedCount: denominatorKnown ? packages.filter(isLifecycleComplete).length : null,
      registeredPlanCount: packages.length,
      actionableCount: packages.filter((record) => fullProductionFilterMatches(model, record, 'ACTIONABLE')).length,
      reviewCount: packages.filter((record) => fullProductionFilterMatches(model, record, 'REVIEW_PENDING')).length,
      revisionCount: packages.filter((record) => fullProductionFilterMatches(model, record, 'REVISION_REQUIRED')).length,
      blockedCount: packages.filter((record) => fullProductionFilterMatches(model, record, 'BLOCKED')).length,
    };
  });
}

function workItemLabel(item: V7WorkItem) {
  return deliverableLabels[item.deliverableKey] || item.deliverableKey.replaceAll('_', ' ');
}

function currentVersion(model: ProductionModel, family?: V7AssetFamily | null) {
  if (!family || !family.currentVersionId) return null;
  return model.assetVersions.find((item) => item.id === family.currentVersionId) || null;
}

export function registrationParentVersion(model: ProductionModel, family?: V7AssetFamily | null) {
  if (!family) return null;
  const current = currentVersion(model, family);
  if (current?.outputState === 'PRESENT' && current.path && current.sha256) return current;
  const materializedHistory = family.versionRefs
    .map((id) => model.assetVersions.find((item) => item.id === id) || null)
    .filter((item): item is V7AssetVersion => Boolean(item?.path && item?.sha256 && item?.outputState === 'PRESENT'));
  return materializedHistory[materializedHistory.length - 1] || null;
}

function expectedOutputRecordForFamily(model: ProductionModel, family: V7AssetFamily | null | undefined, requestedId?: string | null) {
  if (!family) return null;
  const expectedIds = new Set(family.expectedOutputRefs || []);
  const alias = requestedId
    ? (family.versionDeepLinkAliases || []).find((entry) => publicRefMatches(entry.legacyVersionId, requestedId))
    : null;
  const resolvedId = alias?.expectedOutputId
    || (requestedId && (model.expectedOutputs || []).some((entry) => entry.familyId === family.id && publicRefMatches(entry.id, requestedId)) ? requestedId : null)
    || (!requestedId ? family.currentExpectedOutputId : null);
  if (!resolvedId) return null;
  return (model.expectedOutputs || []).find((entry) => entry.familyId === family.id && (entry.id === resolvedId || (expectedIds.has(entry.id) && publicRefMatches(entry.id, resolvedId)))) || null;
}

function expectedOutputForFamily(model: ProductionModel, family: V7AssetFamily | null | undefined, requestedId?: string | null) {
  const expected = expectedOutputRecordForFamily(model, family, requestedId);
  return expected?.expectationState === 'REALIZED' || expected?.realizedVersionId ? null : expected;
}

export function resolveFamilyVersionSelection(
  model: ProductionModel,
  family: V7AssetFamily | null | undefined,
  requestedId?: string | null,
) {
  if (!family) return null;
  if (requestedId) {
    const version = family.versionRefs.find((id) => publicRefMatches(id, requestedId));
    if (version) return version;
    const expected = expectedOutputRecordForFamily(model, family, requestedId);
    if (expected?.realizedVersionId && family.versionRefs.includes(expected.realizedVersionId)) return expected.realizedVersionId;
    if (expected && expected.expectationState !== 'REALIZED') return expected.id;
  }
  return family.currentVersionId || family.currentExpectedOutputId || null;
}

function compactPath(path: string | null) {
  if (!path) return '无本地文件路径';
  const parts = path.split('/');
  return visibleText(parts.length > 4 ? '…/' + parts.slice(-4).join('/') : path);
}

function packageItems(model: ProductionModel, workPackage?: V7WorkPackage | null) {
  if (!workPackage) return [];
  return workPackage.workItemRefs.map((id) => model.workItems.find((item) => item.id === id)).filter((item): item is V7WorkItem => Boolean(item));
}

function episodeCanonicalScopeId(episode: ProductionModel['episodes'][number]) {
  return episode.canonicalScopeId || (episode.scopeRole === 'CURRENT' ? episode.episodeUid : episode.id);
}

function episodeForScope(model: ProductionModel, scopeId: string | null | undefined) {
  if (!scopeId) return null;
  return model.episodes.find((episode) => (
    episodePlanIsCurrent(model)
      ? [episodeCanonicalScopeId(episode), episode.episodeUid].includes(scopeId)
      : [episodeCanonicalScopeId(episode), episode.episodeUid, episode.id, episode.displayId].includes(scopeId)
  )) || null;
}

function episodeReviewScopeId(item: V7WorkItem, workPackage: V7WorkPackage) {
  if (item.scopeType === 'EPISODE') return item.scopeId;
  if (workPackage.scopeType === 'EPISODE') return workPackage.scopeId;
  return item.episodeUid || workPackage.episodeUid || item.episodeId || workPackage.episodeId;
}

export function workProductReviewContext(
  model: ProductionModel,
  item?: V7WorkItem | null,
  workPackage?: V7WorkPackage | null,
): ScopedReviewContext | null {
  if (!item || !workPackage || !workPackage.workItemRefs.includes(item.id)) return null;
  const ref = item.reviewContextRef || workPackage.reviewContextRef || null;
  const exact = ref
    ? (model.reviewContexts || []).find((context) => context.id === ref) || null
    : null;
  const fallbackScopeType = ['SHOT', 'SCENE', 'EPISODE', 'PROJECT'].includes(item.scopeType)
    ? item.scopeType
    : ['SHOT', 'SCENE', 'EPISODE', 'PROJECT'].includes(workPackage.scopeType)
      ? workPackage.scopeType
      : item.shotId ? 'SHOT' : null;
  const fallbackScopeId = fallbackScopeType === 'SHOT'
    ? item.shotId || workPackage.scopeId
    : fallbackScopeType === 'SCENE'
      ? item.sceneId || workPackage.sceneId || item.scopeId || workPackage.scopeId
      : fallbackScopeType === 'EPISODE'
        ? episodeReviewScopeId(item, workPackage)
        : fallbackScopeType === 'PROJECT' ? item.scopeId || workPackage.scopeId || projectIdFor(model) : null;
  const context = exact || (fallbackScopeType && fallbackScopeId
    ? (model.reviewContexts || []).find((record) => record.scopeType === fallbackScopeType && record.scopeId === fallbackScopeId) || null
    : null);
  if (!context || !/^[a-f0-9]{64}$/.test(context.contextHash)) return null;
  if (context.scopeType === 'SHOT') {
    if (!item.shotId || item.shotId !== context.scopeId || !workPackage.shotIds.includes(context.scopeId)) return null;
  } else if (
    (context.scopeType === 'SCENE' && item.sceneId !== context.scopeId)
    || (context.scopeType === 'EPISODE' && (
      episodeReviewScopeId(item, workPackage) !== context.scopeId
      || (item.scopeType === 'EPISODE' && item.scopeId !== context.scopeId)
      || (workPackage.scopeType === 'EPISODE' && workPackage.scopeId !== context.scopeId)
    ))
    || (context.scopeType === 'PROJECT' && context.scopeId !== projectIdFor(model))
  ) {
    return null;
  }
  return context;
}

type DecisionTarget = {
  workPackage: V7WorkPackage | null;
  item: V7WorkItem | null;
  family: V7AssetFamily | null;
  version: V7AssetVersion | null;
};

function decisionTargetForContext(model: ProductionModel, context: ProductionContext): DecisionTarget {
  const shot = model.shots.find((record) => record.id === context.shotId) || null;
  const workPackage = shot
    ? shot.workPackageRefs.map((id) => model.workPackages.find((record) => record.id === id)).find((record) => record?.id === context.workPackageId) || null
    : null;
  const items = packageItems(model, workPackage);
  const inspectedFamily = context.familyId ? model.assetFamilies.find((record) => record.id === context.familyId) || null : null;
  const familyBoundItem = inspectedFamily
    ? items.find((record) => record.outputAssetRef === inspectedFamily.id || record.inputAssetRefs.includes(inspectedFamily.id) || (record.additionalOutputAssetRefs || []).includes(inspectedFamily.id))
    : null;
  const item = items.find((record) => record.id === context.workItemId)
    || familyBoundItem
    || items.find((record) => record.pipelineStageCode === 'P07')
    || items[0]
    || null;
  const family = item?.outputAssetRef ? model.assetFamilies.find((record) => record.id === item.outputAssetRef) || null : null;
  return { workPackage, item, family, version: currentVersion(model, family) };
}

function scopeLabel(workPackage: V7WorkPackage, itemCount?: number) {
  if (workPackage.scopeType === 'CONTINUITY_GROUP') return '本连续性组共用';
  if (workPackage.scopeType === 'SCENE') return '全场共用';
  if (workPackage.scopeType === 'EPISODE') return '本集共用';
  if (workPackage.scopeType === 'PROJECT') return '全剧共用';
  if (workPackage.stepId === 'W02' && itemCount && itemCount > 1) return '本镜 · ' + (itemCount - 1) + '句台词';
  return '本镜独立';
}

function DirectorState({ value }: { value: string }) {
  return <span className={'v7-director-state tone-' + statusTone(value)}>{directorStatus(value)}</span>;
}

export type ExecutionRecipe = {
  id: string;
  materialProductionPlanId?: string;
  parentVersionId?: string | null;
  title: string;
  pipelineStageCode: string;
  executorKind: string;
  definitionHash: string;
  currentRevisionId: string;
  reviewSpec?: { title: string; question: string; criteria: string[] } | null;
  upload: { rawText: string; items: Array<{ order: number; path: string; assetFamilyRef?: string; assetVersionRef?: string }> };
  model: { branch: string | null; rawRule: string; resolution: string };
  parametersRaw?: string | null;
  prompt: { main: string | null; negative: string | null; negativeApplication: string };
  output: { path: string; mediaType: string; assetFamilyRef?: string | null; expectedOutputRef?: string | null };
  declaredGate: string;
  rawSourceBlock: string;
};

export function useExecutionRecipe(recipeId?: string | null) {
  const [result, setResult] = useState<{ id: string | null; recipe: ExecutionRecipe | null; error: string }>({ id: null, recipe: null, error: '' });
  useEffect(() => {
    if (!recipeId) return;
    const controller = new AbortController();
    fetch('/api/v8/recipes/' + encodeURIComponent(recipeId), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { recipe: ExecutionRecipe };
        setResult({ id: recipeId, recipe: payload.recipe, error: '' });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setResult({ id: recipeId, recipe: null, error: reason instanceof Error ? reason.message : '执行配方读取失败' });
      });
    return () => controller.abort();
  }, [recipeId]);
  return result.id === recipeId ? { recipe: result.recipe, error: result.error } : { recipe: null, error: '' };
}

function isReviewEvent(value: unknown): value is ReviewEventRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ReviewEventRecord>;
  return typeof record.eventId === 'string'
    && typeof record.recordedAt === 'string'
    && typeof record.versionId === 'string'
    && (
      typeof record.workItemId === 'string'
      || (record.subjectType === 'ASSET' && typeof record.subjectId === 'string')
    )
    && (
      record.action === 'APPROVE_AND_RELEASE'
      || record.action === 'REQUEST_REVISION'
      || record.action === 'DO_NOT_USE'
      || record.decision === 'PASS'
      || record.decision === 'REVISE'
      || record.decision === 'HOLD'
    );
}

function isAppliedReviewEvent(event: ReviewEventRecord) {
  return Boolean(event.action && ['2.0', '2.1', '2.2'].includes(String(event.schemaVersion)) && event.effect === 'APPLIED');
}

export type ReviewOperationTarget = {
  subjectType: 'WORK_PRODUCT' | 'ASSET';
  subjectId: string;
  versionId?: string | null;
  contextHash?: string | null;
};

export type ReviewOperationState = {
  loading: boolean;
  error: string;
  snapshotId: string | null;
  mutationEtag: string | null;
  operationalRevision: string | null;
  stateProjection: OperationalStateProjection | null;
  p07Released: { allReleased?: boolean; remainingWorkItems?: number } | null;
  workItemProjection: EntityStateProjection | null;
  events: ReviewEventRecord[];
  effective: ReviewEventRecord | null;
  refresh: () => void;
};

export function useReviewOperations(
  targetOrWorkItemId?: ReviewOperationTarget | string | null,
  legacyVersionId?: string | null,
  legacyContextHash?: string | null,
): ReviewOperationState {
  const target: ReviewOperationTarget | null = typeof targetOrWorkItemId === 'string'
    ? { subjectType: 'WORK_PRODUCT',
 subjectId: targetOrWorkItemId, versionId: legacyVersionId, contextHash: legacyContextHash }
    : targetOrWorkItemId || null;
  const subjectType = target?.subjectType || null;
  const subjectId = target?.subjectId || null;
  const versionId = target?.versionId || null;
  const contextHash = target?.contextHash || null;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<Omit<ReviewOperationState, 'refresh'> & { targetKey: string }>({
    targetKey: '',
    loading: false,
    error: '',
    snapshotId: null,
    mutationEtag: null,
    operationalRevision: null,
    stateProjection: null,
    p07Released: null,
    workItemProjection: null,
    events: [],
    effective: null,
  });

  useEffect(() => {
    if (!subjectId || !subjectType) return;
    const targetKey = subjectType + '::' + subjectId + '::' + (versionId || 'NO_VERSION') + '::' + (contextHash || 'NO_CONTEXT');
    const controller = new AbortController();
    const operationRequest = fetch('/api/v8/operations/snapshot', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`operation snapshot HTTP ${response.status}`);
      return response.json() as Promise<OperationalSnapshot>;
    });
    const eventRequest = versionId
      ? (() => {
        const contextQuery = contextHash ? `&contextHash=${encodeURIComponent(contextHash)}` : '';
        return fetch(`/api/v8/reviews?subjectType=${encodeURIComponent(subjectType)}&subjectId=${encodeURIComponent(subjectId)}&versionId=${encodeURIComponent(versionId)}${contextQuery}&limit=500`, { signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error(`review history HTTP ${response.status}`);
          return response.json() as Promise<{ events?: unknown[] }>;
        });
      })()
      : Promise.resolve({ events: [] } as { events?: unknown[] });
    Promise.allSettled([operationRequest, eventRequest]).then(([operationResult, eventResult]) => {
      if (controller.signal.aborted) return;
      const operation = operationResult.status === 'fulfilled' ? operationResult.value : null;
      const operationEvents = operation?.reviews?.events?.filter(isReviewEvent) || [];
      const projectedEntries = subjectType === 'ASSET'
        ? operation?.reviews?.projectedByAssetVersion
        : operation?.reviews?.projectedByWorkItem;
      const projectedEvents = projectedEntries?.map((entry) => entry.event).filter(isReviewEvent) || [];
      const directEvents = eventResult.status === 'fulfilled' ? (eventResult.value.events || []).filter(isReviewEvent) : [];
      const correctionProjection = versionId
        ? operation?.stateProjection?.assetVersionsById[versionId]?.reviewCorrection
        : null;
      const correctionRecord = correctionProjection && typeof correctionProjection === 'object'
        ? correctionProjection as Record<string, unknown>
        : null;
      const correctionHeadEventId = subjectType === 'ASSET'
        && typeof correctionRecord?.headEventId === 'string'
        ? correctionRecord.headEventId
        : '';
      const matchesTarget = (event: ReviewEventRecord) => subjectType === 'ASSET'
        ? event.subjectType === 'ASSET' && event.subjectId === subjectId
        : event.workItemId === subjectId;
      const merged = [...directEvents, ...operationEvents, ...projectedEvents]
        .filter((event) => matchesTarget(event) && event.versionId === versionId)
        .filter((event) => (
          !contextHash
          || event.contextHash === contextHash
          || (subjectType === 'ASSET' && Boolean(correctionHeadEventId) && event.eventId === correctionHeadEventId)
        ))
        .filter((event, index, all) => all.findIndex((record) => record.eventId === event.eventId) === index)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.eventId.localeCompare(a.eventId));
      const effective = subjectType === 'ASSET'
        ? correctionHeadEventId
          ? merged.find((event) => event.eventId === correctionHeadEventId && isAppliedReviewEvent(event)) || null
          : null
        : projectedEvents
          .filter((event) => matchesTarget(event) && event.versionId === versionId)
          .filter((event) => !contextHash || event.contextHash === contextHash)
          .find(isAppliedReviewEvent) || null;
      const operationError = operationResult.status === 'rejected'
        ? (operationResult.reason instanceof Error ? operationResult.reason.message : '运行快照读取失败')
        : '';
      setState({
        targetKey,
        loading: false,
        error: operationError,
        snapshotId: operation?.snapshotId || operation?.baseSnapshotId || null,
        mutationEtag: operation?.mutationEtag || operation?.etag || null,
        operationalRevision: operation?.operationalRevision || operation?.operationRevision || null,
        stateProjection: operation?.stateProjection || null,
        p07Released: operation?.p07Released || null,
        workItemProjection: subjectType === 'ASSET'
          ? operation?.stateProjection?.assetFamiliesById[subjectId] || null
          : operation?.stateProjection?.workItemsById[subjectId]
            || operation?.stateProjection?.materialWorkItemsById?.[subjectId]
            || null,
        events: merged,
        effective,
      });
    });
    return () => controller.abort();
  }, [contextHash, revision, subjectId, subjectType, versionId]);

  if (!subjectId || !subjectType) return { loading: false, error: '', snapshotId: null, mutationEtag: null, operationalRevision: null, stateProjection: null, p07Released: null, workItemProjection: null, events: [], effective: null, refresh: () => setRevision((value) => value + 1) };
  if (state.targetKey !== subjectType + '::' + subjectId + '::' + (versionId || 'NO_VERSION') + '::' + (contextHash || 'NO_CONTEXT')) return { loading: true, error: '', snapshotId: null, mutationEtag: null, operationalRevision: null, stateProjection: null, p07Released: null, workItemProjection: null, events: [], effective: null, refresh: () => setRevision((value) => value + 1) };
  return { ...state, refresh: () => setRevision((value) => value + 1) };
}

async function stableDigest(value: string) {
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return Math.abs(hash >>> 0).toString(16).padStart(8, '0').repeat(8);
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.isContentEditable
    || target.closest('input, textarea, select, button, a, audio, video, [contenteditable="true"], [role="dialog"]'),
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function withOperationalProjection<T extends LifecycleProjection>(record: T, projection?: EntityStateProjection | null): T {
  return projection ? { ...record, ...projection } : record;
}

function executionAuthorizationGate(
  item: V7WorkItem,
  family: V7AssetFamily | null,
  recipe: ExecutionRecipe | null,
  operations: ReviewOperationState,
) {
  if (operations.loading) return { canAuthorize: false, reason: '正在核对当前运行快照与全部上游版本。' };
  if (operations.error) return { canAuthorize: false, reason: `运行快照不可用：${operations.error}` };
  if (!recipe) return { canAuthorize: false, reason: '完整执行配方尚未读取完成。' };
  const projection = operations.stateProjection;
  if (!projection) return { canAuthorize: false, reason: '尚未取得可校验的状态模型2.0投影。' };

  const reasons=projection.executionGatesByWorkItem?.[item.id];
  if(!reasons)return {canAuthorize:false,reason:'服务端尚未提供当前对象的执行门禁，请刷新后再试。'};
  return {canAuthorize:reasons.length===0,reason:reasons.length?reasons.map(visibleText).join('；'):'当前调用包与全部输入版本满足授权条件。'};
}

function normalizedProjectRelativePath(value: string) {
  const candidate = value.trim();
  if (!candidate) return { normalized: '', error: '请填写项目内已有的 _review_pending 结果路径。' };
  if (candidate.startsWith('/')) {
    return { normalized: '', error: '候选路径必须是项目相对路径，不能以 / 开头。' };
  }
  if (candidate.includes('\\')) {
    return { normalized: '', error: '候选路径必须使用正斜杠 /，不能包含反斜杠。' };
  }
  const parts = candidate.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    return { normalized: '', error: '候选路径必须是规范化的项目相对路径；不得包含空路径段、. 或 ..。' };
  }
  return { normalized: parts.join('/'), error: '' };
}

function ClipboardButton({ value, label, className = '' }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<'IDLE' | 'COPIED' | 'FAILED'>('IDLE');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('COPIED');
      window.setTimeout(() => setState('IDLE'), 1800);
    } catch {
      setState('FAILED');
    }
  }
  return <button type="button" className={className} onClick={() => void copy()}>{state === 'COPIED' ? '已复制' : state === 'FAILED' ? '复制失败' : label}</button>;
}

function instructionLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

async function mediaToken(versionId: string) {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(versionId));
  const bytes = Array.from(new Uint8Array(digest));
  const base64 = window.btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  return 'm_' + base64.slice(0, 28);
}

export function useOriginalMediaUrl(version?: V7AssetVersion | null) {
  const { hostedReadOnly } = useRuntimeMode();
  const [resolved, setResolved] = useState<{ versionId: string; url: string | null; error: string }>({ versionId: '', url: null, error: '' });
  const publicOriginal=typeof version?.mediaUrl==='string'&&/^\/media\/animatic\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|avif|wav|mp3|m4a|flac|ogg|aac|mp4|webm|mov|json|txt)$/.test(version.mediaUrl)?version.mediaUrl:null;
  const eligible = Boolean((!hostedReadOnly||publicOriginal) && version && version.outputState === 'PRESENT' && version.path && version.sha256);
  const directUrl = hostedReadOnly?publicOriginal:version?.mediaUrl || (version?.mediaToken ? '/api/v8/media/' + version.mediaToken : null);
  useEffect(() => {
    let alive = true;
    if (!version || !eligible || directUrl) return;
    mediaToken(version.id)
      .then((token) => { if (alive) setResolved({ versionId: version.id, url: '/api/v8/media/' + token, error: '' }); })
      .catch((reason: unknown) => { if (alive) setResolved({ versionId: version.id, url: null, error: reason instanceof Error ? reason.message : '无法解析原件地址' }); });
    return () => { alive = false; };
  }, [directUrl, eligible, version]);
  if (!version || !eligible) return { url: null, error: '' };
  if (directUrl) return { url: directUrl, error: '' };
  return resolved.versionId === version.id ? { url: resolved.url, error: resolved.error } : { url: null, error: '' };
}

export function mediaKind(path: string | null) {
  const extension = path?.split('.').pop()?.toLowerCase();
  if (extension && ['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return 'IMAGE';
  if (extension && ['wav', 'mp3', 'm4a', 'flac'].includes(extension)) return 'AUDIO';
  if (extension && ['mp4', 'mov', 'webm'].includes(extension)) return 'VIDEO';
  return 'UNKNOWN';
}

export function deriveCurrentAction(model: ProductionModel, context: ProductionContext, effectiveReview?: ReviewEventRecord | null) {
  const { workPackage, item, version } = decisionTargetForContext(model, context);
  if (workPackage?.applicabilityState === 'SATISFIED_BY_EXISTING') return { kind: 'READY', title: '既有校准资产已满足本步骤', reason: '无需创建兼容任务，也无需重复裁决；从下一项实际工作开始推进。' };
  if (workPackage?.applicabilityState === 'NOT_REQUIRED') return { kind: 'NOT_REQUIRED', title: '本镜不需要这一制作步骤', reason: '该分支不适用且不计入完成率。' };
  if (workPackage?.applicabilityState === 'DATA_ERROR') return { kind: 'BLOCKED', title: '工作包适用性数据异常', reason: '先修复业务关系，不能据此执行或裁决。' };
  if (!item) return { kind: 'NOT_REQUIRED', title: '本步骤没有可执行工作项', reason: '当前业务坐标没有适用的交付物。' };
  if (effectiveReview?.action === 'APPROVE_AND_RELEASE') return {
    kind: 'READY',
    title: '当前版本已通过并放行',
    reason: `事件 ${effectiveReview.eventId} 已原子应用到本地运行投影；按依赖关系重新计算下游资格。`,
  };
  if (effectiveReview?.action === 'REQUEST_REVISION') return {
    kind: 'REVISE',
    title: '按正式审阅意见创建返修版本',
    reason: `事件 ${effectiveReview.eventId} 已应用；当前版本保留追溯，不得原位覆盖。`,
  };
  if (effectiveReview?.action === 'DO_NOT_USE') return {
    kind: 'BLOCKED',
    title: '当前版本禁止使用',
    reason: `事件 ${effectiveReview.eventId} 已应用；该版本只保留审计，不得进入下游。`,
  };
  const lifecycle = item.lifecycleState || version?.lifecycleState || '';
  if (/REVISION_REQUIRED|EXECUTION_FAILED/.test(lifecycle)) return { kind: 'REVISE', title: '按审阅意见返修当前版本', reason: '当前生命周期要求返修，不能下传。' };
  if (/DO_NOT_USE|RIGHTS_HOLD|BLOCKED/.test(lifecycle)) return { kind: 'BLOCKED', title: '当前对象被阻断', reason: '先处理明确门禁原因；禁用版本不得下传。' };
  if (lifecycle === 'RELEASED' || item.canFlowDownstream) return { kind: 'READY', title: '当前工作项已通过并放行', reason: '按依赖关系检查同包或下游工作项。' };
  if (lifecycle === 'REVIEW_PENDING') return { kind: 'REVIEW', title: `审阅 ${workItemLabel(item)} 的当前版本`, reason: '文件与哈希已登记，当前需要完成一次正式审阅。' };
  if (version?.outputState === 'PRESENT') return { kind: 'WAIT', title: '先修复版本登记与生命周期不一致', reason: '已有文件记录，但工作项没有进入待审阅；正式审阅表保持关闭。' };
  return { kind: 'WAIT', title: `等待 ${workItemLabel(item)} 的上游或产出`, reason: directorStatus(lifecycle || item.upstreamReadiness) + '；固定路径不代表文件已生成。' };
}

export function ProductionContextBar(props: ContextProps) {
  const { model, shotId, onNavigate, workPackage } = props;
  const shot = model.shots.find((item) => item.id === shotId) || model.shots[0];
  const episode = model.episodes.find((item) => item.id === shot.episodeId) || model.episodes[0];
  const scene = model.scenes.find((item) => item.id === shot.sceneId) || model.scenes[0];
  const sceneOptions = model.scenes.filter((item) => item.episodeId === episode.id);
  const shotOptions = model.shots.filter((item) => item.sceneId === scene.id);

  function chooseShot(nextShotId: string) {
    const nextShot = model.shots.find((item) => item.id === nextShotId);
    if (!nextShot) return;
    const matchingPackage = workPackage
      ? nextShot.workPackageRefs.map((id) => model.workPackages.find((item) => item.id === id)).find((item) => item?.stepId === workPackage.stepId)
      : null;
    onNavigate({ shotId: nextShot.id, workPackageId: matchingPackage?.id || undefined });
  }

  return <section className="v7-context-bar" aria-label="当前业务坐标">
    {workPackage?.scopeType === 'PROJECT' ? <p><span>范围</span><b>本剧全剧 · {model.episodes.length}集</b></p> : <label><span>集</span><select value={episode.id} onChange={(event) => { const next = model.episodes.find((item) => item.id === event.target.value); if (next && next.shotIds[0]) chooseShot(next.shotIds[0]); }}>{model.episodes.map((item) => <option key={item.id} value={item.id}>{item.id + ' · ' + item.sceneIds[0] + '–' + item.sceneIds.at(-1)}</option>)}</select></label>}
    {workPackage?.scopeType !== 'PROJECT' && workPackage?.scopeType !== 'EPISODE' && <><i>→</i><label><span>场</span><select value={scene.id} onChange={(event) => { const next = model.scenes.find((item) => item.id === event.target.value); if (next && next.shotIds[0]) chooseShot(next.shotIds[0]); }}>{sceneOptions.map((item) => <option key={item.id} value={item.id}>{item.id + ' · ' + item.title}</option>)}</select></label></>}
    {(!workPackage || ['SHOT', 'CONTINUITY_GROUP'].includes(workPackage.scopeType)) && <><i>→</i><label><span>分镜</span><select value={shot.id} onChange={(event) => chooseShot(event.target.value)}>{shotOptions.map((item) => <option key={item.id} value={item.id}>{item.id + ' · ' + item.title}</option>)}</select></label></>}
  </section>;
}

function ShotNavigator({ model, shot, onNavigate }: { model: ProductionModel; shot: V7Shot; onNavigate: ProductionNavigate }) {
  const episode = model.episodes.find((item) => item.id === shot.episodeId) || model.episodes[0];
  const scenes = model.scenes.filter((item) => item.episodeId === episode.id);
  const shots = model.shots.filter((item) => item.sceneId === shot.sceneId);
  const groups = model.continuityGroups.filter((item) => item.sceneId === shot.sceneId);
  const groupedShotIds = new Set(groups.flatMap((group) => group.shotIds));
  const ungrouped = shots.filter((item) => !groupedShotIds.has(item.id));

  function shotButtons(records: V7Shot[]) {
    return records.map((item) => <button aria-current={item.id === shot.id ? 'location' : undefined} className={item.id === shot.id ? 'active' : ''} key={item.id} onClick={() => onNavigate({ shotId: item.id })}><span>{item.id.replace(item.sceneId + '-', '')}</span><b>{item.title}</b><small>{directorStatus(item.lifecycleState) + ' · ' + item.branch}</small></button>);
  }

  return <nav className="v6-shot-navigator v8-business-tree" aria-label={`${episode.id} ${shot.sceneId} 镜头导航`}>
    <header><small>BUSINESS TREE</small><h3>{episode.id + ' → ' + shot.sceneId}</h3><p>{episode.sceneIds.length + '场 · 当前场' + shots.length + '镜'}</p></header>
    <div className="v8-episode-root"><b>{episode.id}</b><small>{episode.sceneIds.length + '场 · ' + episode.shotIds.length + '镜'}</small></div>
    <div className="v6-scene-list v8-scene-tree">{scenes.map((item) => {
      const expanded = item.id === shot.sceneId;
      const sceneShots = model.shots.filter((entry) => entry.sceneId === item.id);
      return <section className={'v8-scene-node ' + (expanded ? 'active' : '')} key={item.id}>
        <button aria-expanded={expanded} aria-controls={`scene-shots-${item.id}`} onClick={() => item.shotIds[0] && onNavigate({ shotId: item.shotIds[0] })}><span>{item.id}</span><b>{item.title}</b><small>{item.shotIds.length + '镜 · ' + directorStatus(item.lifecycleState)}</small></button>
        {expanded && <div id={`scene-shots-${item.id}`} className="v8-shot-children">{groups.length > 1 ? groups.map((group) => <section key={group.id}><header><b>{group.label}</b><small>连续性分组</small></header><div className="v6-shot-list">{shotButtons(group.shotIds.map((id) => model.shots.find((entry) => entry.id === id)).filter((entry): entry is V7Shot => Boolean(entry)))}</div></section>) : <div className="v6-shot-list">{shotButtons(sceneShots)}</div>}{ungrouped.length > 0 && groups.length > 1 && <div className="v6-shot-list">{shotButtons(ungrouped)}</div>}</div>}
      </section>;
    })}</div>
  </nav>;
}

function CreatorShotStrip({ model, shot, onNavigate }: { model: ProductionModel; shot: V7Shot; onNavigate: ProductionNavigate }) {
  const sceneShots = model.shots.filter((item) => item.sceneId === shot.sceneId);
  return <nav className="creator-shot-strip" aria-label={`${shot.sceneId}创作镜头带`}><header><small>SCENE SHOT STRIP</small><h3>{shot.sceneId} · {sceneShots.length}镜</h3><p>前后镜常驻；缩略图只作定位，正式判断以SHA绑定原件为准。</p></header><div>{sceneShots.map((item, index) => {
    const target = storyboardReviewTarget(model, item);
    const preview = target.version?.preview || item.storyboardPreview;
    const state = target.version?.lifecycleState || target.item?.lifecycleState || item.lifecycleState;
    return <button type="button" key={item.id} className={item.id === shot.id ? 'active' : ''} aria-current={item.id === shot.id ? 'location' : undefined} onClick={() => onNavigate({ shotId: item.id, workPackageId: target.workPackage?.id || item.defaultWorkPackageId, workItemId: target.item?.id || null, familyId: target.family?.id || null, versionId: target.version?.id || null })}><span>{preview ? <img src={preview} alt="" /> : <i>{String(index + 1).padStart(2, '0')}</i>}</span><b>{item.id}</b><small>{visibleText(item.title)}</small><em className={'tone-' + statusTone(state)}>{directorStatus(state)}</em></button>;
  })}</div><details><summary>展开全业务树</summary><ShotNavigator model={model} shot={shot} onNavigate={onNavigate} /></details></nav>;
}

function WorkflowRail({ model, shot, activeId, onNavigate }: { model: ProductionModel; shot: V7Shot; activeId: string; onNavigate: ProductionNavigate }) {
  const packages = shot.workPackageRefs.map((id) => model.workPackages.find((item) => item.id === id)).filter((item): item is V7WorkPackage => Boolean(item));
  return <nav className="v7-workflow-rail" aria-label={shot.id + '制作流程'}>
    {model.workflowSteps.slice().sort((a, b) => a.order - b.order).map((step) => {
      const workPackage = packages.find((item) => item.stepId === step.id);
      if (!workPackage) return <span className="v7-workflow-node is-missing" key={step.id}><i>{String(step.order).padStart(2, '0')}</i><b>{step.label}</b><small>{workflowDisplay(step.order)}</small><em>未登记</em></span>;
      const items = packageItems(model, workPackage);
      if (workPackage.applicabilityState === 'NOT_REQUIRED') return <span key={step.id} className="v7-workflow-node v8-package-not-required"><i>{String(step.order).padStart(2, '0')}</i><b>{step.label}</b><small>{workflowDisplay(step.order)}</small><span>本镜无需口型</span><em>不计入完成率</em></span>;
      return <button key={step.id} className={'v7-workflow-node ' + (workPackage.id === activeId ? 'active ' : '') + (workPackage.applicabilityState === 'SATISFIED_BY_EXISTING' ? 'v8-package-satisfied ' : '') + 'tone-' + statusTone(workPackage.lifecycleState)} onClick={() => onNavigate({ shotId: shot.id, workPackageId: workPackage.id })}><i>{String(step.order).padStart(2, '0')}</i><b>{step.label}</b><small>{workflowDisplay(step.order)}</small><span>{workPackage.applicabilityState === 'SATISFIED_BY_EXISTING' ? '已由既有校准资产满足' : scopeLabel(workPackage, items.length)}</span><em>{workPackage.applicabilityState === 'SATISFIED_BY_EXISTING' ? '已满足，无需重复制作' : directorStatus(workPackage.lifecycleState)}</em></button>;
    })}
  </nav>;
}

function AssetMiniCard({ model, family, selected, role, onSelect, onOpenMaterial }: { model: ProductionModel; family: V7AssetFamily; selected: boolean; role?: string; onSelect: (id: string) => void; onOpenMaterial?: (requirementId: string) => void }) {
  const version = currentVersion(model, family);
  const expected = expectedOutputForFamily(model, family);
  return <article className={'v6-asset-mini-card ' + (selected ? 'selected ' : '') + 'tone-' + statusToneFromRecord(family)}>
    <button className="v6-asset-mini" aria-pressed={selected} onClick={() => onSelect(family.id)}>
      <span><b>{(role || '资产') + ' · ' + publicRef(family.id)}</b><i>{visibleText(family.kind + ' · ' + family.subtype)}</i></span>
      <strong>{visibleText(family.label)}</strong>
      <small>{deriveHeadlineState(family).label}</small>
      <em>{expected ? `计划 ${visibleText(expected.plannedVersionLabel)} · 尚未产出` : version ? visibleText(version.label) : '尚无版本'}{family.versionRefs.length ? ` · ${family.versionRefs.length}个文件／证据版本` : ''}</em>
    </button>
    {onOpenMaterial && family.materialRequirementRefs?.length ? <button className="v6-asset-legacy-action" data-production-input-material={publicRef(family.id)} onClick={() => onOpenMaterial(family.materialRequirementRefs?.[0] || '')}>{`去素材管理 · ${family.materialRequirementRefs.length}项需求`}</button> : null}
  </article>;
}

export function VersionPanel({ model, family, selectedVersionId, onSelectVersion, heading = '查看中的资产' }: { model: ProductionModel; family: V7AssetFamily | null; selectedVersionId: string | null; onSelectVersion: (id: string | null) => void; heading?: string }) {
  if (!family) return <section className="v6-version-panel empty v7-version-empty"><b>先选择一项具体资产</b><p>版本属于资产，不属于制作步骤。请先从中间区域选择产出或依赖资产，再查看当前版本和历史版本。</p></section>;
  const familyVersions = family.versionRefs.map((id) => model.assetVersions.find((item) => item.id === id)).filter((item): item is V7AssetVersion => Boolean(item));
  const expectedOutputs = (family.expectedOutputRefs || [])
    .map((id) => (model.expectedOutputs || []).find((item) => item.id === id))
    .filter((item): item is ExpectedOutput => Boolean(item))
    .filter((item) => item.expectationState !== 'REALIZED' && !item.realizedVersionId);
  const selectedActual = selectedVersionId ? familyVersions.find((item) => publicRefMatches(item.id, selectedVersionId)) || null : null;
  const selectedExpected = selectedActual ? null : expectedOutputForFamily(model, family, selectedVersionId);
  const version = selectedActual || (!selectedExpected ? currentVersion(model, family) || familyVersions[0] : null);
  const expected = selectedExpected || (!version ? expectedOutputForFamily(model, family) : null);
  return <section className="v6-version-panel">
    <header><span><small>{heading}</small><b>{visibleText(family.label)}</b></span><i>{`${familyVersions.length}个文件版本 · ${expectedOutputs.length}个计划产出`}</i></header>
    {version && version.preview && <img src={version.preview} alt={visibleText(family.label) + '审阅代理'} />}
    {version && version.audioProxy && <audio controls preload="metadata" src={version.audioProxy}>你的浏览器不支持音频播放。</audio>}
    <div className="v6-version-list">{familyVersions.map((item) => <button className={(item.id === version?.id ? 'active ' : '') + 'tone-' + statusToneFromRecord(item)} key={item.id} onClick={() => onSelectVersion(item.id)}><b>{visibleText(item.label)}</b><StatusHeadline record={item} compact /><small>{visibleText(deriveHeadlineState(item).meaning)}</small></button>)}{expectedOutputs.map((item) => <button className={(item.id === expected?.id ? 'active ' : '') + 'tone-waiting is-expected-output'} key={item.id} onClick={() => onSelectVersion(item.id)}><b>{visibleText(item.plannedVersionLabel)}</b><span>计划产出 · 尚无文件</span><small>不可预览、不可审阅、不可采用</small></button>)}{!familyVersions.length && !expectedOutputs.length && <p className="v6-empty-note">当前资产尚无文件版本或计划产出记录。</p>}</div>
    {expected && <article className="creator-expected-output" role="status"><small>EXPECTED OUTPUT · 不是资产版本</small><b>{visibleText(expected.label || expected.plannedVersionLabel)}</b><p>这里只登记应当产出的固定目标。当前没有候选文件与SHA-256，因此不能预览、提交审阅或作为下游输入。</p><dl><div><dt>计划文件</dt><dd><code>{compactPath(expected.targetPath)}</code></dd></div><div><dt>兼容旧深链</dt><dd><code>{publicRef(expected.legacyVersionId)}</code></dd></div><div><dt>执行定义</dt><dd>{publicRef(expected.executionDefinitionRef) || '尚未登记'}</dd></div></dl></article>}
    {version && <details className="v7-technical-details v7-version-tech"><summary>统一状态、路径与哈希</summary><UnifiedStatusPanel record={version} showGateReason={false} /><div className="v6-version-facts"><p><b>资产／版本</b><code>{publicRef(family.id) + ' / ' + publicRef(version.id)}</code></p><p><b>路径</b><code>{compactPath(version.path)}</code></p><p><b>SHA-256</b><code>{version.sha256 || '无文件，不生成哈希'}</code></p>{(version.historyId || version.resourceId) && <p><b>历史凭据</b><code>{(version.historyId || '—') + ' / ' + (version.resourceId || '—')}</code></p>}{version.reason && <p><b>历史处置</b><span>{visibleText(version.reason)}</span></p>}</div></details>}
  </section>;
}

type CriterionDefinition = { id: string; label: string; question: string };
type CriterionVerdict = 'PASS' | 'FAIL' | 'NA' | '';


function WorkItemButton({ item, selected, onSelect }: { item: V7WorkItem; selected: boolean; onSelect: (item: V7WorkItem) => void }) {
  return <button className={'v7-work-item ' + (selected ? 'active ' : '') + 'tone-' + statusToneFromRecord(item)} onClick={() => onSelect(item)}><span><small>{stageDisplay(item.pipelineStageCode)}</small><b>{workItemLabel(item)}</b></span><em>{visibleText(item.lineId || item.scopeId)}</em><i>{itemDirectorStatus(item)}</i></button>;
}

type DraftFinding = { verdict: CriterionVerdict; note: string };
type Draft = {
  action: ReviewAction | '';
  note: string;
  findings: Record<string, DraftFinding>;
  rightsConfirmed: boolean;
  shotProductionEvidence?: ShotProductionEvidence;
  revision: RevisionInstructions;
  updatedAt?: string;
};
type StoredDraft = Partial<Draft> & { decision?: LegacyReviewDecision | '' };

function draftSignature(value: Draft) {
  return JSON.stringify({ action: value.action, note: value.note, findings: value.findings, rightsConfirmed: value.rightsConfirmed, shotProductionEvidence: value.shotProductionEvidence, revision: value.revision });
}

function storyboardReviewTarget(model: ProductionModel, shot: V7Shot) {
  const workPackage = shot.workPackageRefs
    .map((id) => model.workPackages.find((record) => record.id === id))
    .find((record) => record?.stepId === 'W02') || null;
  const item = packageItems(model, workPackage).find((record) => record.pipelineStageCode === 'P07') || null;
  const family = item?.outputAssetRef ? model.assetFamilies.find((record) => record.id === item.outputAssetRef) || null : null;
  const version = currentVersion(model, family);
  return { workPackage, item, family, version };
}

function storyboardReviewQueue(model: ProductionModel) {
  return model.shots.filter((shot) => {
    if (!model.scenes.find((scene) => scene.id === shot.sceneId)?.isCalibrationSubset) return false;
    const target = storyboardReviewTarget(model, shot);
    return Boolean(
      target.item
      && target.version?.outputState === 'PRESENT'
      && target.version.historyRole !== 'EVIDENCE_ONLY'
      && target.version.path
      && target.version.sha256,
    );
  });
}

function storyboardLifecycle(target: ReturnType<typeof storyboardReviewTarget>, projection?: OperationalStateProjection | null) {
  const projected = target.item ? projection?.workItemsById[target.item.id] : null;
  return String(projected?.lifecycleState || target.version?.lifecycleState || target.item?.lifecycleState || '');
}

function storyboardActionability(target: ReturnType<typeof storyboardReviewTarget>, projection?: OperationalStateProjection | null) {
  const projected = target.item ? projection?.workItemsById[target.item.id] : null;
  return String(projected?.reviewActionability || target.item?.reviewActionability || '');
}

function nextSubmittableStoryboard(model: ProductionModel, currentShotId: string, projection?: OperationalStateProjection | null) {
  const queue = storyboardReviewQueue(model);
  const currentIndex = queue.findIndex((record) => record.id === currentShotId);
  if (currentIndex < 0) return null;
  const ordered = [...queue.slice(currentIndex + 1), ...queue.slice(0, currentIndex)];
  return ordered.find((record) => {
    const target = storyboardReviewTarget(model, record);
    return storyboardLifecycle(target, projection) === 'REVIEW_PENDING'
      && storyboardActionability(target, projection) === 'ACTIONABLE';
  }) || null;
}

function normalizeDraft(value: StoredDraft | null | undefined, criteria: CriterionDefinition[]): Draft {
  const existing = value?.findings || {};
  const legacyAction = value?.decision === 'PASS'
    ? 'APPROVE_AND_RELEASE'
    : value?.decision === 'REVISE'
      ? 'REQUEST_REVISION'
      : '';
  return {
    action: value?.action || legacyAction,
    note: value?.note || '',
    rightsConfirmed: Boolean(value?.rightsConfirmed),
    shotProductionEvidence: value?.shotProductionEvidence?.schemaVersion==='1.0'?value.shotProductionEvidence:undefined,
    revision: {
      preserve: value?.revision?.preserve || '',
      change: value?.revision?.change || '',
      mustNotRegress: value?.revision?.mustNotRegress || '',
    },
    findings: Object.fromEntries(criteria.map((criterion) => [criterion.id, {
      verdict: existing[criterion.id]?.verdict || '',
      note: existing[criterion.id]?.note || '',
    }])),
    updatedAt: value?.updatedAt,
  };
}

function actionLabel(action: ReviewAction | LegacyReviewDecision | '') {
  return action === 'APPROVE_AND_RELEASE' || action === 'PASS'
    ? '通过并放行'
    : action === 'REQUEST_REVISION' || action === 'REVISE'
      ? '要求修改'
      : action === 'DO_NOT_USE'
        ? '禁止使用'
        : action === 'HOLD'
          ? '旧记录：暂缓'
          : '未选择';
}

function eventAction(event: ReviewEventRecord): ReviewAction | LegacyReviewDecision | '' {
  return event.action || event.decision || '';
}

function withReviewProjection<T extends LifecycleProjection>(record: T, event?: ReviewEventRecord | null): T {
  if (!event || !isAppliedReviewEvent(event)) return record;
  return {
    ...record,
    lifecycleState: event.lifecycleState || record.lifecycleState,
    reviewDecision: event.reviewDecision || record.reviewDecision,
    projectRightsGate: event.appliedProjectRightsGate || record.projectRightsGate,
    canFlowDownstream: typeof event.canFlowDownstream === 'boolean' ? event.canFlowDownstream : record.canFlowDownstream,
    flowBlockReasons: event.canFlowDownstream ? [] : record.flowBlockReasons,
  };
}

function ReviewDraft({ model, shot, workPackage, item, version, reviewContext, mediaVerified, operations, criteria, onNavigate, onOpenReviewOverview }: { model: ProductionModel; shot: V7Shot; workPackage: V7WorkPackage; item: V7WorkItem; version: V7AssetVersion | null; reviewContext: ScopedReviewContext; mediaVerified: boolean; operations: ReviewOperationState; criteria: CriterionDefinition[]; onNavigate: ProductionNavigate; onOpenReviewOverview?: () => void }) {
  const { hostedReadOnly } = useRuntimeMode();
  const [draft, setDraft] = useState<Draft>(() => normalizeDraft(null, criteria));
  const [message, setMessage] = useState('尚未保存');
  const [submitting, setSubmitting] = useState(false);
  const [hydratedKey, setHydratedKey] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [clearedDraft, setClearedDraft] = useState<Draft | null>(null);
  const [submittedEventId, setSubmittedEventId] = useState<string | null>(null);
  const [submittedNextShotId, setSubmittedNextShotId] = useState<string | null>(null);
  const [activeCriterionIndex, setActiveCriterionIndex] = useState(0);
  const mobileReviewBlocked = useMediaQuery('(max-width: 639px)');
  const lastPersistedSignatureRef = useRef('');
  const latestDraftRef = useRef(draft);
  const clearUndoTimerRef = useRef<number | null>(null);
  const submittedProjectionRefreshRef = useRef(false);
  const contextHash = reviewContext.contextHash;
  const isShotScope = reviewContext.scopeType === 'SHOT';
  const productionPhaseId = item.phaseId || null;
  const productionGateId = item.gateId || null;
  const canonicalBindingReady = Boolean(
    productionPhaseId
    && productionGateId
    && workPackage.phaseId === productionPhaseId
    && workPackage.gateId === productionGateId
    && item.scopeType === reviewContext.scopeType
    && item.scopeId === reviewContext.scopeId
    && workPackage.scopeType === reviewContext.scopeType
    && workPackage.scopeId === reviewContext.scopeId,
  );
  const scopeCoordinate = reviewContext.scopeType === 'SHOT'
    ? [shot.episodeId, shot.sceneId, reviewContext.scopeId]
    : reviewContext.scopeType === 'SCENE'
      ? [shot.episodeId, reviewContext.scopeId, '整场']
      : reviewContext.scopeType === 'EPISODE'
        ? [reviewContext.scopeId, '分集成片']
        : [projectIdFor(model), '全剧终审'];
  const storageKey = [item.id, version?.id || 'NO_VERSION', version?.sha256 || 'NO_SHA', contextHash, item.reviewSpec?.hash || 'LEGACY'].join(':');
  const criteriaKey = `${item.reviewSpec?.hash || 'LEGACY'}:${criteria.map((criterion) => criterion.id).join('|')}`;
  const productionEvidenceRequired=Boolean((item as V7WorkItem&{shotProductionPlanId?:string}).shotProductionPlanId&&['SHOT_INPUT_LOCK','START_FRAME','INTERMEDIATE_FRAME','END_FRAME','LOCKED_SHOT'].includes(item.deliverableKey||''));
  const productionEvidence=useShotProductionEvidence({required:productionEvidenceRequired&&!hostedReadOnly,workItemId:item.id,versionId:version?.id,snapshotId:operations.snapshotId||model.snapshotManifest?.snapshotId||'',revisionKey:operations.operationalRevision||'',value:draft.shotProductionEvidence,onChange:value=>setDraft(current=>({...current,shotProductionEvidence:value}))});
  const fileReady = version?.outputState === 'PRESENT' && Boolean(version.sha256);
  const rightsUnknown = version?.projectRightsGate === 'UNKNOWN';
  const rightsBlocked = version?.projectRightsGate === 'BLOCKED';
  const projectedActionability = String(operations.workItemProjection?.reviewActionability || 'ACTIONABLE');
  const reviewBlockers = Array.isArray(operations.workItemProjection?.reviewBlockers)
    ? operations.workItemProjection.reviewBlockers.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return String(value);
      const blocker = value as Record<string, unknown>;
      const coordinate = String(blocker.familyId || blocker.workItemId || blocker.requiredVersionId || '').trim();
      return `${String(blocker.reasonCode || 'UPSTREAM_BLOCKED')}${coordinate ? `（${coordinate}）` : ''}`;
    })
    : [];
  const dependencyActionable = projectedActionability === 'ACTIONABLE';
  const companionLifecycleReady = (item.additionalOutputAssetRefs || []).length === 0;
  const immutableDecisionApplied = Boolean(
    operations.effective
    && operations.effective.versionId === version?.id
    && operations.effective.versionSha256?.toLowerCase() === version?.sha256?.toLowerCase(),
  );
  const draftable = Boolean(item.lifecycleState === 'REVIEW_PENDING' && fileReady && companionLifecycleReady && !immutableDecisionApplied);
  const reviewable = Boolean(draftable && mediaVerified && operations.mutationEtag && dependencyActionable && canonicalBindingReady && !mobileReviewBlocked && !submittedEventId);
  useEffect(() => { latestDraftRef.current = draft; }, [draft]);

  useEffect(() => () => {
    if (submittedProjectionRefreshRef.current) window.dispatchEvent(new CustomEvent('review:operations-updated'));
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!reviewable || submitting || event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || isTextEntryTarget(event.target)) return;
      const verdictByKey: Record<string, CriterionVerdict> = { p: 'PASS', f: 'FAIL', n: 'NA' };
      const verdict = verdictByKey[event.key.toLowerCase()];
      if (!verdict) return;
      const index = Math.min(activeCriterionIndex, Math.max(0, criteria.length - 1));
      const criterion = criteria[index];
      if (!criterion || (verdict === "NA" && "allowNA" in criterion && !criterion.allowNA)) return;
      event.preventDefault();
      setDraft((value) => ({
        ...value,
        findings: {
          ...value.findings,
          [criterion.id]: { ...value.findings[criterion.id], verdict },
        },
      }));
      setActiveCriterionIndex((value) => Math.min(criteria.length - 1, value + 1));
      setMessage(`快捷判断：${visibleText(criterion.label)} → ${verdict === 'PASS' ? '通过' : verdict === 'FAIL' ? '有问题' : '不适用'}`);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeCriterionIndex, criteria, reviewable, submitting]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const legacyKeys = Array.from(new Set([shot.id + ':' + item.legacyStageId, shot.id + ':' + item.id]));
        const current = JSON.parse(instanceLocalStorage.getItem('review.reviewDraft.v3') || '{}') as Record<string, StoredDraft>;
        setStorageError(false);
        document.documentElement.dataset.reviewDraftUnsaved = 'false';
        if (current[storageKey]) { const loaded = normalizeDraft(current[storageKey], criteria); setDraft(loaded); lastPersistedSignatureRef.current = draftSignature(loaded); setHydratedKey(storageKey); setMessage('已载入本机草稿'); return; }
        const previous = JSON.parse(instanceLocalStorage.getItem('review.reviewDraft.v2') || '{}') as Record<string, StoredDraft>;
        if (previous[storageKey]) { const loaded = normalizeDraft(previous[storageKey], criteria); setDraft(loaded); lastPersistedSignatureRef.current = draftSignature(loaded); setHydratedKey(storageKey); setMessage('已兼容载入旧版草稿；修改后将自动转为新结构'); return; }
        const legacy = JSON.parse(instanceLocalStorage.getItem('review.reviewDraft.v1') || '{}') as Record<string, StoredDraft>;
        const migrated = item.reviewSpec && !item.reviewSpec.legacy ? undefined : legacyKeys.map((key) => legacy[key]).find(Boolean);
        const loaded = normalizeDraft(migrated, criteria);
        setDraft(loaded);
        lastPersistedSignatureRef.current = draftSignature(loaded);
        setHydratedKey(storageKey);
        setMessage(migrated ? '已兼容载入旧版草稿；再次保存将转为新版结构' : '尚未保存');
      } catch { const empty = normalizeDraft(null, criteria); setDraft(empty); setHydratedKey(storageKey); setStorageError(true); document.documentElement.dataset.reviewDraftUnsaved = 'true'; setMessage('本机存储不可用；离开前请复制记录'); }
    }, 0);
    return () => window.clearTimeout(timer);
    // criteriaKey intentionally represents the stable criterion schema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, shot.id, item.id, item.legacyStageId, criteriaKey]);

  function persistDraft(value: Draft, automatic = false) {
    try {
      const all = JSON.parse(instanceLocalStorage.getItem('review.reviewDraft.v3') || '{}') as Record<string, Draft>;
      const next = { ...value, updatedAt: new Date().toISOString() };
      all[storageKey] = next;
      instanceLocalStorage.setItem('review.reviewDraft.v3', JSON.stringify(all));
      lastPersistedSignatureRef.current = draftSignature(next);
      setStorageError(false);
      document.documentElement.dataset.reviewDraftUnsaved = 'false';
      setMessage(automatic ? '本机草稿已自动保存；未写入项目状态' : '已保存为本机草稿；未写入项目状态');
      return next;
    } catch {
      setStorageError(true);
      document.documentElement.dataset.reviewDraftUnsaved = 'true';
      setMessage('保存失败；本机存储不可用，离开前请复制记录');
      return null;
    }
  }

  useEffect(() => {
    if (hydratedKey !== storageKey) return;
    const signature = draftSignature(draft);
    if (signature === lastPersistedSignatureRef.current) return;
    const timer = window.setTimeout(() => { persistDraft(draft, true); }, 500);
    return () => window.clearTimeout(timer);
    // persistDraft writes the current component-local key and draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, hydratedKey, storageKey]);

  useEffect(() => {
    if (hydratedKey !== storageKey) return;
    const flush = () => {
      const value = latestDraftRef.current;
      if (draftSignature(value) !== lastPersistedSignatureRef.current) persistDraft(value, true);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (document.documentElement.dataset.reviewDraftUnsaved === 'true') event.preventDefault();
    };
    window.addEventListener('review:flush-review-draft', flush);
    window.addEventListener('popstate', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      flush();
      window.removeEventListener('review:flush-review-draft', flush);
      window.removeEventListener('popstate', flush);
      window.removeEventListener('beforeunload', beforeUnload);
    };
    // persistDraft writes synchronously to the current component-local key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydratedKey, storageKey]);

  function saveDraft() {
    const next = persistDraft(draft);
    if (next) setDraft(next);
  }

  function clearDraft() {
    const previous = draft;
    try {
      const all = JSON.parse(instanceLocalStorage.getItem('review.reviewDraft.v3') || '{}') as Record<string, Draft>;
      delete all[storageKey];
      instanceLocalStorage.setItem('review.reviewDraft.v3', JSON.stringify(all));
      setStorageError(false);
      document.documentElement.dataset.reviewDraftUnsaved = 'false';
    } catch { /* local draft cleanup is best effort */ }
    const empty = normalizeDraft(null, criteria);
    setDraft(empty);
    lastPersistedSignatureRef.current = draftSignature(empty);
    setClearedDraft(previous);
    if (clearUndoTimerRef.current) window.clearTimeout(clearUndoTimerRef.current);
    clearUndoTimerRef.current = window.setTimeout(() => setClearedDraft(null), 8000);
    setMessage('已清除当前草稿；8秒内可撤销');
  }

  function undoClearDraft() {
    if (!clearedDraft) return;
    setDraft(clearedDraft);
    persistDraft(clearedDraft);
    setClearedDraft(null);
    if (clearUndoTimerRef.current) window.clearTimeout(clearUndoTimerRef.current);
  }

  async function copyDraft() {
    const step = model.workflowSteps.find((record) => record.id === workPackage.stepId);
    const findingLines = criteria.map((criterion) => {
      const finding = draft.findings[criterion.id];
      const verdict = finding?.verdict === 'PASS' ? '通过' : finding?.verdict === 'FAIL' ? '有问题' : finding?.verdict === 'NA' ? '不适用' : '未判断';
      return `  - ${visibleText(criterion.label)}：${verdict}${finding?.note ? `；${visibleText(finding.note)}` : ''}`;
    });
    const body = ['# 本剧制作审阅草稿', '', '- 业务坐标：' + scopeCoordinate.join(' / '), '- 正式审阅范围：' + `${reviewContext.scopeType} / ${reviewContext.scopeId}`, '- 制作步骤：' + workflowDisplay(step?.order || 0), '- 审阅对象：' + workItemLabel(item), '- 版本：' + (version ? visibleText(version.label) : '未选择资产版本'), '- SHA-256：' + (version && version.sha256 ? version.sha256 : '无'), '- 上下文哈希：' + contextHash, '- 草稿结论：' + actionLabel(draft.action), '- 项目内权利确认：' + (rightsUnknown ? draft.rightsConfirmed ? '已确认仅限本项目内部生产；商业发行法律核验仍为UNKNOWN' : '未确认' : visibleText(version?.projectRightsGate || 'NOT_APPLICABLE')), '- 逐项判断：', ...findingLines, '- 返修必须保留：', ...(instructionLines(draft.revision.preserve).map((item) => '  - ' + visibleText(item)).length ? instructionLines(draft.revision.preserve).map((item) => '  - ' + visibleText(item)) : ['  - 无']), '- 返修必须修改：', ...(instructionLines(draft.revision.change).map((item) => '  - ' + visibleText(item)).length ? instructionLines(draft.revision.change).map((item) => '  - ' + visibleText(item)) : ['  - 无']), '- 返修禁止退化：', ...(instructionLines(draft.revision.mustNotRegress).map((item) => '  - ' + visibleText(item)).length ? instructionLines(draft.revision.mustNotRegress).map((item) => '  - ' + visibleText(item)) : ['  - 无']), '- 备注：' + (draft.note || '无'), '', '> 本内容是本机审阅草稿，不是正式事件；保存不会修改项目状态。'].join('\n');
    try { await navigator.clipboard.writeText(body); setMessage('已复制结构化草稿'); } catch { setMessage('复制失败；浏览器未授权剪贴板'); }
  }

  async function submitReview() {
    if (!reviewable || !version || !draft.action) {
      setMessage(!mediaVerified ? '请先确认已加载与SHA一致的原件，再提交裁决' : '正式提交需要已生成且带哈希的版本、最新运行快照和明确裁决');
      return;
    }
    if (draft.action==='APPROVE_AND_RELEASE'&&productionEvidenceRequired&&!productionEvidence.ready){setMessage('请先完成当前精确制作输入及媒体观察验收');return;}
    if (draft.action !== 'APPROVE_AND_RELEASE' && !draft.note.trim()) {
      setMessage(actionLabel(draft.action) + '必须填写可执行的具体原因');
      return;
    }
    if (draft.action === 'APPROVE_AND_RELEASE' && rightsBlocked) {
      setMessage('当前版本存在不可豁免的项目内权利阻断，不能通过并放行');
      return;
    }
    if (draft.action === 'APPROVE_AND_RELEASE' && rightsUnknown && !draft.rightsConfirmed) {
      setMessage('权利事实为UNKNOWN；通过前必须显式确认仅限本项目内部生产，商业发行法律核验仍保持UNKNOWN');
      return;
    }
    if (draft.action === 'APPROVE_AND_RELEASE' && rightsUnknown && !draft.note.trim()) {
      setMessage('权利事实为UNKNOWN；请在总体备注中写明本项目内部使用依据');
      return;
    }
    const criterionFindings = criteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: draft.findings[criterion.id]?.verdict,
      note: draft.findings[criterion.id]?.note.trim() || undefined,
    }));
    if (criterionFindings.some((finding) => !finding.verdict)) {
      setMessage('请先完成全部逐项判断；确实不适用的项目请选择“不适用”');
      return;
    }
    if (criterionFindings.some((finding) => finding.verdict === 'FAIL' && !finding.note)) {
      setMessage('每一项“有问题”的判断都必须填写具体问题与修改方向');
      return;
    }
    if (draft.action === 'APPROVE_AND_RELEASE' && criterionFindings.some((finding) => finding.verdict === 'FAIL')) {
      setMessage('总体通过不能包含“有问题”的逐项判断');
      return;
    }
    if (draft.action === 'REQUEST_REVISION' && !criterionFindings.some((finding) => finding.verdict === 'FAIL')) {
      setMessage('退回修改至少需要一项标记为“有问题”');
      return;
    }
    if (draft.action === 'REQUEST_REVISION' && !instructionLines(draft.revision.change).length) {
      setMessage('要求修改必须填写至少一条“必须修改”，让下一版可以直接执行');
      return;
    }
    try {
      setSubmitting(true);
      setMessage('正在提交正式审阅事件…');
      const snapshotId = operations.snapshotId || model.snapshotManifest?.snapshotId || model.executionRecipeSummary?.snapshotId || '';
      const rightsUnknownConfirmation = rightsUnknown && draft.action === 'APPROVE_AND_RELEASE'
        ? { confirmed: true, scope: 'PROJECT_INTERNAL_ONLY', basis: draft.note.trim() }
        : null;
      const revisionInstructions = draft.action === 'REQUEST_REVISION' ? {
        preserve: instructionLines(draft.revision.preserve),
        change: instructionLines(draft.revision.change),
        mustNotRegress: instructionLines(draft.revision.mustNotRegress),
      } : null;
      const shotProductionEvidence=productionEvidenceRequired?draft.shotProductionEvidence:undefined;
      const semanticKey = await stableDigest(JSON.stringify({ snapshotId, shotProductionEvidence, reviewContextRef: reviewContext.id, productionPhaseId, productionGateId, scopeType: reviewContext.scopeType, scopeId: reviewContext.scopeId, workPackageId: workPackage.id, workItemId: item.id, versionId: version.id, versionSha256: version.sha256, contextHash, criterionFindings, action: draft.action, revisionInstructions, rightsUnknownConfirmation, note: draft.note.trim() }));
      const response = await fetch('/api/v8/reviews', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'review-' + semanticKey,
          'If-Match': operations.mutationEtag as string,
        },
        body: JSON.stringify({
          schemaVersion: '2.2',
          snapshotId,
          reviewContextRef: reviewContext.id,
          productionPhaseId,
          productionGateId,
          scopeType: reviewContext.scopeType,
          scopeId: reviewContext.scopeId,
          workPackageId: workPackage.id,
          workItemId: item.id,
          versionId: version.id,
          versionSha256: version.sha256,
          subjectType: 'WORK_PRODUCT',
          reviewSpecHash: item.reviewSpec?.hash,
          subjectId: item.id,
          contextHash,
          criterionFindings,
          ...(shotProductionEvidence?{shotProductionEvidence}:{}),
          action: draft.action,
          revisionInstructions,
          rightsUnknownConfirmation,
          note: draft.note.trim(),
        }),
      });
      const payload = await response.json() as { eventId?: string; replayed?: boolean; error?: string; appliedProjection?: OperationalStateProjection };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setMessage((payload.replayed ? '已确认既有正式审阅：' : '正式审阅已提交并原子应用：') + payload.eventId + '；本地运行投影已更新');
      setSubmittedEventId(payload.eventId || '已提交');
      const deterministicNext = item.pipelineStageCode === 'P07'
        ? nextSubmittableStoryboard(model, shot.id, payload.appliedProjection)
        : null;
      setSubmittedNextShotId(deterministicNext?.id || null);
      submittedProjectionRefreshRef.current = true;
      try {
        const all = JSON.parse(instanceLocalStorage.getItem('review.reviewDraft.v3') || '{}') as Record<string, Draft>;
        delete all[storageKey];
        instanceLocalStorage.setItem('review.reviewDraft.v3', JSON.stringify(all));
      } catch { /* formal event succeeded; draft cleanup remains best effort */ }
    } catch (reason) {
      setMessage('正式提交失败：' + visibleText(reason instanceof Error ? reason.message : '未知错误'));
      operations.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  const assistantProductionSnapshotId = operations.snapshotId || model.snapshotManifest?.snapshotId || '';
  useAssistantFocus(assistantProductionSnapshotId ? {
    projectId: projectIdFor(model), snapshotId: assistantProductionSnapshotId, view: 'pipeline',
    subjectType: 'WORK_ITEM', subjectId: item.id, title: `全剧制作 · ${workItemLabel(item)}`,
    versionId: version?.id, criterionId: criteria[activeCriterionIndex]?.id,
    references: [reviewContext.id, `business-context:${contextHash}`, ...(version ? [`family:${version.familyId}`] : [])],
    filters: { scopeType: reviewContext.scopeType, scopeId: reviewContext.scopeId, phaseId: productionPhaseId || '', gateId: productionGateId || '' },
  } : null, 10);
  const assistantDrafts = useProjectAssistantDraftTargets({
    identity: `production:${assistantProductionSnapshotId}:${storageKey}`,
    subjectId: item.id, versionId: version?.id, defaultFieldId: 'note',
    fields: [
      ...criteria.map((criterion) => ({ fieldId: `criterion:${criterion.id}`, label: `${workItemLabel(item)} · ${visibleText(criterion.label)}意见`, value: draft.findings[criterion.id]?.note || '' })),
      { fieldId: 'note', label: `${workItemLabel(item)} · 总体备注`, value: draft.note },
      ...(draft.action === 'REQUEST_REVISION' ? [
        { fieldId: 'preserve', label: `${workItemLabel(item)} · 必须保留`, value: draft.revision.preserve },
        { fieldId: 'change', label: `${workItemLabel(item)} · 必须修改`, value: draft.revision.change },
        { fieldId: 'mustNotRegress', label: `${workItemLabel(item)} · 禁止退化`, value: draft.revision.mustNotRegress },
      ] : []),
    ],
    canAdopt: Boolean(assistantProductionSnapshotId && hydratedKey === storageKey && !hostedReadOnly
      && !submitting && !operations.loading && !operations.error && !immutableDecisionApplied && !submittedEventId),
    disabledReason: '当前制作对象或版本草稿不可编辑；建议仍可复制。',
    applyField: (fieldId, nextValue) => setDraft((current) => {
      const next = fieldId === 'note' ? { ...current, note: nextValue }
        : fieldId.startsWith('criterion:') ? { ...current, findings: { ...current.findings,
          [fieldId.slice('criterion:'.length)]: { ...(current.findings[fieldId.slice('criterion:'.length)] || { verdict: '', note: '' }), note: nextValue },
        } }
        : { ...current, revision: { ...current.revision, [fieldId]: nextValue } };
      latestDraftRef.current = next;
      return next;
    }),
  });

  const allCriteriaDecided = criteria.every((criterion) => Boolean(draft.findings[criterion.id]?.verdict));
  const failedCriteriaExplained = criteria.every((criterion) => draft.findings[criterion.id]?.verdict !== 'FAIL' || Boolean(draft.findings[criterion.id]?.note.trim()));
  const decisionConsistent = draft.action === 'APPROVE_AND_RELEASE'
    ? criteria.every((criterion) => draft.findings[criterion.id]?.verdict !== 'FAIL')
    : draft.action === 'REQUEST_REVISION'
      ? criteria.some((criterion) => draft.findings[criterion.id]?.verdict === 'FAIL')
      : Boolean(draft.action);
  const revisionActionable = draft.action !== 'REQUEST_REVISION' || instructionLines(draft.revision.change).length > 0;
  const submittedNextShot = submittedNextShotId ? model.shots.find((record) => record.id === submittedNextShotId) || null : null;
  const submittedNextTarget = submittedNextShot ? storyboardReviewTarget(model, submittedNextShot) : null;
  function refreshSubmittedProjection() {
    submittedProjectionRefreshRef.current = false;
    window.dispatchEvent(new CustomEvent('review:operations-updated'));
  }

  return <section className="v6-review-draft"><header><div><small>REVIEW DECISION</small><h3>{workItemLabel(item) + ' · 输出版本裁决'}</h3></div><span>{operations.effective ? '已有有效事件' : reviewable ? '原件与运行快照已就绪' : operations.loading ? '正在读取运行快照' : !fileReady ? '当前无可审版本' : !companionLifecycleReady ? '伴随交付物未闭环' : !dependencyActionable ? '等待前序审阅' : !mediaVerified ? '等待原件加载' : '运行快照不可用'}</span></header>
    {operations.effective && <article className={'v8-effective-review tone-' + statusTone(operations.effective.lifecycleState || operations.effective.reviewDecision || eventAction(operations.effective))}><div><small>EFFECTIVE APPLIED REVIEW</small><b>{actionLabel(eventAction(operations.effective)) + ' · 已应用到本地运行投影'}</b><p>{operations.effective.note || '未填写补充说明'}</p></div><span>{new Date(operations.effective.recordedAt).toLocaleString('zh-CN')}<br />{operations.effective.eventId}</span></article>}
    {immutableDecisionApplied && <p className="creator-mobile-review-block" role="status"><b>当前版本已完成正式裁决</b>{eventAction(operations.effective as ReviewEventRecord) === 'REQUEST_REVISION'
      ? '必须登记新的 AssetVersion 与新 SHA-256 后再审；同一版本不能改判为通过。'
      : eventAction(operations.effective as ReviewEventRecord) === 'DO_NOT_USE'
        ? '禁止使用是该版本的终态；只能另建新版本，不能反向覆盖这条结论。'
        : '该版本已经通过并放行；若需要替换，必须另建新版本并重新审阅。'}</p>}
    {mobileReviewBlocked && <p className="creator-mobile-review-block" role="status"><b>小屏只读保护</b>当前宽度不足640px，可以阅读、比较和保存草稿，但不能提交图片、视频或声音的正式裁决。请在更宽屏幕核对原件后提交。</p>}
    {!companionLifecycleReady && <p className="creator-mobile-review-block" role="status"><b>多输出正式审阅保持关闭</b>当前工作项还有{(item.additionalOutputAssetRefs || []).length}个伴随计划交付物没有独立版本、候选登记和审阅闭环；不能用主输出的一次结论冒充整包齐套。</p>}
    {!dependencyActionable && <p className="creator-mobile-review-block" role="status"><b>{`依赖链尚未到${isShotScope ? '本镜' : '当前范围'}`}</b>{reviewBlockers.length ? `当前阻塞：${reviewBlockers.join('、')}。` : '请先完成前序工作产物的正式审阅。'}你仍可填写并保存草稿，但暂不能正式提交。</p>}
    {!canonicalBindingReady && <p className="creator-mobile-review-block" role="alert"><b>正式范围绑定 UNKNOWN</b>当前工作项、工作包与审阅上下文未同时绑定同一正式检查及业务范围；ReviewEvent 2.2失败关闭，不提交旧字段。</p>}
    <div className="creator-shortcut-help" aria-label="审阅快捷键"><span><kbd>P</kbd>通过</span><span><kbd>F</kbd>有问题</span><span><kbd>N</kbd>不适用</span><span><kbd>J</kbd>上一镜</span><span><kbd>K</kbd>下一镜</span><span><kbd>C</kbd>切换比较</span><small>输入框、选择框、弹窗聚焦时快捷键自动停用</small></div>
    <div className="v8-criterion-checklist"><header><b>逐项判断</b><span>{criteria.filter((criterion) => draft.findings[criterion.id]?.verdict).length} / {criteria.length}</span></header>{criteria.map((criterion, criterionIndex) => {
      const finding = draft.findings[criterion.id] || { verdict: '', note: '' };
      return <article key={criterion.id} className={(finding.verdict ? `is-${finding.verdict.toLowerCase()} ` : '') + (activeCriterionIndex === criterionIndex ? 'is-keyboard-active' : '')} onClick={() => setActiveCriterionIndex(criterionIndex)}><div><small>{visibleText(criterion.label)}</small><p>{visibleText(criterion.question)}</p></div><div className="creator-verdict-buttons" role="radiogroup" aria-label={visibleText(criterion.label) + '结论'}>{([['PASS', 'P · 通过'], ['FAIL', 'F · 有问题'], ['NA', 'N · 不适用']] as const).filter(([v])=>v!=='NA' || !("allowNA" in criterion) || criterion.allowNA).map(([verdict, label]) => <button type="button" role="radio" aria-checked={finding.verdict === verdict} disabled={!draftable || submitting} className={finding.verdict === verdict ? 'active' : ''} key={verdict} onClick={() => { setDraft((value) => ({ ...value, findings: { ...value.findings, [criterion.id]: { ...(value.findings[criterion.id] || { verdict: '', note: '' }), verdict: value.findings[criterion.id]?.verdict === verdict ? '' : verdict } } })); setActiveCriterionIndex(Math.min(criteria.length - 1, criterionIndex + 1)); }}>{label}</button>)}</div><label><span>该项说明</span><input disabled={immutableDecisionApplied} value={finding.note} onFocus={() => { setActiveCriterionIndex(criterionIndex); assistantDrafts.activateField(`criterion:${criterion.id}`); }} onChange={(event) => setDraft((value) => ({ ...value, findings: { ...value.findings, [criterion.id]: { ...finding, note: event.target.value } } }))} placeholder={finding.verdict === 'FAIL' ? '写明可执行的问题与修改方向' : '可选'} /></label></article>;
    })}</div>
    {productionEvidenceRequired&&<>
      {productionEvidence.loading&&<p role="status">正在核对本次制作验收的精确输入…</p>}
      {productionEvidence.error&&<p role="alert">{productionEvidence.error}<button type="button" onClick={productionEvidence.refresh}>重读验收依据</button></p>}
      {productionEvidence.template&&<ShotProductionEvidencePanel template={productionEvidence.template} evidence={draft.shotProductionEvidence} onChange={value=>setDraft(current=>({...current,shotProductionEvidence:value}))} disabled={hostedReadOnly||!draftable||submitting} versions={model.assetVersions}/>}
    </>}
    <fieldset className="v8-decision-choice"><legend>选择正式结论</legend><div className="v6-decision-buttons" role="radiogroup" aria-label="正式审阅结论">{(['APPROVE_AND_RELEASE', 'REQUEST_REVISION', 'DO_NOT_USE'] as const).map((action) => <button type="button" role="radio" aria-checked={draft.action === action} disabled={!draftable || submitting || (action === 'APPROVE_AND_RELEASE' && rightsBlocked)} className={draft.action === action ? 'active' : ''} key={action} onClick={() => setDraft((value) => ({ ...value, action: value.action === action ? '' : action }))}><b>{actionLabel(action)}</b><small>{action === 'APPROVE_AND_RELEASE' ? '采用当前版本并重算下游资格' : action === 'REQUEST_REVISION' ? '保留当前版本并进入返修' : '保留审计，禁止下游使用'}</small></button>)}</div></fieldset>
    {draft.action === 'REQUEST_REVISION' && <fieldset className="creator-revision-brief"><legend>下一版返修约束</legend><p>每行一条。下一轮执行应保留已正确部分，只修改明确问题，并防止已经通过的要素退化。</p><label><span>必须保留</span><textarea disabled={immutableDecisionApplied} value={draft.revision.preserve} onFocus={() => assistantDrafts.activateField('preserve')} onChange={(event) => setDraft((value) => ({ ...value, revision: { ...value.revision, preserve: event.target.value } }))} placeholder={'例如：保留当前低机位与人物身份\n保留已正确的南门方向'} /></label><label className="is-required"><span>必须修改</span><textarea disabled={immutableDecisionApplied} value={draft.revision.change} onFocus={() => assistantDrafts.activateField('change')} onChange={(event) => setDraft((value) => ({ ...value, revision: { ...value.revision, change: event.target.value } }))} placeholder={'至少一条，例如：修正右手六指\n把醋缸内首级压到液面以下'} /></label><label><span>禁止退化</span><textarea disabled={immutableDecisionApplied} value={draft.revision.mustNotRegress} onFocus={() => assistantDrafts.activateField('mustNotRegress')} onChange={(event) => setDraft((value) => ({ ...value, revision: { ...value.revision, mustNotRegress: event.target.value } }))} placeholder={'例如：不得镜像门向\n不得更换人物面孔或服装'} /></label></fieldset>}
    {rightsUnknown && draft.action === 'APPROVE_AND_RELEASE' && <label className="v8-rights-confirmation"><input disabled={immutableDecisionApplied} type="checkbox" checked={draft.rightsConfirmed} onChange={(event) => setDraft((value) => ({ ...value, rightsConfirmed: event.target.checked }))} /><span><b>仅限本项目内部生产确认</b>我确认当前依据足以让该版本进入本剧项目内部下游；原始权利事实仍保留UNKNOWN，商业发行法律核验并未完成。</span></label>}
    {rightsBlocked && <p className="v8-inline-error">该版本存在不可豁免的项目内权利阻断；只能退回修改或禁止使用，不能通过并放行。</p>}
    <label><span>总体备注{draft.action && (draft.action !== 'APPROVE_AND_RELEASE' || rightsUnknown) ? '（必填）' : '（通过可选）'}</span><textarea disabled={immutableDecisionApplied} value={draft.note} onFocus={() => assistantDrafts.activateField('note')} onChange={(event) => setDraft((value) => ({ ...value, note: event.target.value }))} placeholder={rightsUnknown && draft.action === 'APPROVE_AND_RELEASE' ? '写明仅限本项目内部使用的依据；商业发行法律核验仍为UNKNOWN…' : '说明总体结论、关键问题与下一版修改方向…'} /></label>
    <button type="button" disabled={hostedReadOnly || !assistantDrafts.hasTargets} onClick={assistantDrafts.askAboutActiveDraft}>结合这条意见问助手</button>
    <footer><button disabled={hostedReadOnly || !reviewable || !draft.action || !allCriteriaDecided || !failedCriteriaExplained || !decisionConsistent || !revisionActionable || submitting || (draft.action==='APPROVE_AND_RELEASE'&&productionEvidenceRequired&&!productionEvidence.ready) || (draft.action !== 'APPROVE_AND_RELEASE' && !draft.note.trim()) || (draft.action === 'APPROVE_AND_RELEASE' && rightsUnknown && (!draft.rightsConfirmed || !draft.note.trim())) || (draft.action === 'APPROVE_AND_RELEASE' && rightsBlocked)} onClick={() => void submitReview()}>{submitting ? '提交中…' : hostedReadOnly ? '远端镜像不可正式提交' : `确认提交：${actionLabel(draft.action)}`}</button><button onClick={saveDraft}>立即保存</button><button onClick={() => void copyDraft()}>复制记录</button><button className="quiet" onClick={clearDraft}>清除草稿</button>{clearedDraft && <button className="quiet" onClick={undoClearDraft}>撤销清除</button>}</footer>
    <p role="status" aria-live="polite" aria-atomic="true">{message + (draft.updatedAt ? ' · ' + draft.updatedAt : '')}{operations.operationalRevision ? ' · ' + operations.operationalRevision : ''}</p>
    {storageError && <p className="v8-inline-error">本机草稿存储不可用。离开前请先“复制记录”；导航时会再次尝试保存并明确提示风险。</p>}
    {submittedEventId && <section className="v8-review-receipt" role="status" aria-live="polite"><div><small>REVIEW APPLIED</small><b>{`${reviewContext.scopeId} 正式审阅已应用`}</b><p>{submittedEventId}</p>{item.pipelineStageCode === 'P07' && !submittedNextShot && <span>应用后的投影中没有其他可提交镜头；可返回队列查看等待关系。</span>}</div><div>{submittedNextShot && submittedNextTarget?.workPackage && submittedNextTarget.item && <button onClick={() => { refreshSubmittedProjection(); onNavigate({ shotId: submittedNextShot.id, workPackageId: submittedNextTarget.workPackage?.id, workItemId: submittedNextTarget.item?.id, familyId: submittedNextTarget.family?.id || null, versionId: submittedNextTarget.version?.id || null }); }}>{`审下一张可提交：${submittedNextShot.id}`}</button>}{onOpenReviewOverview && <button onClick={() => { refreshSubmittedProjection(); onOpenReviewOverview(); }}>返回校准镜头队列</button>}<button className="quiet" onClick={() => { refreshSubmittedProjection(); setSubmittedEventId(null); setSubmittedNextShotId(null); operations.refresh(); }}>{isShotScope ? '留在本镜' : '留在当前范围'}</button></div></section>}
    {operations.error && <p className="v8-inline-error">运行快照暂时无法读取：{visibleText(operations.error)}</p>}
    {operations.events.length > 0 && <details className="v8-review-history"><summary>{'查看当前输出版本的' + operations.events.length + '条审阅历史'}</summary><ol>{operations.events.map((event) => <li key={event.eventId}><b>{actionLabel(eventAction(event))}{isAppliedReviewEvent(event) ? ' · 已应用' : ' · 历史证据'}</b><span>{new Date(event.recordedAt).toLocaleString('zh-CN')}</span><p>{event.note || '无备注'}</p><code>{event.eventId}</code></li>)}</ol></details>}
  </section>;
}

function EvidenceDetails({ refs, catalog, label = '查看依据内容' }: { refs: string[]; catalog: Record<string, ReviewEvidence>; label?: string }) {
  const uniqueRefs = Array.from(new Set(refs));
  if (!uniqueRefs.length) return null;
  void catalog;
  return <EvidenceTrigger refs={uniqueRefs} heading={label.replace(/^查看/, '') || '判断依据'} semantics="以下为当前审阅上下文直接引用的源片段；显示依据不改变其F／L／A／U等级，也不构成第二次审批。" label={label} />;
}

function ClaimBlock({ label, claim, catalog }: { label: string; claim: ReviewClaim; catalog: Record<string, ReviewEvidence> }) {
  return <article className={`v8-context-claim is-${claim.class.toLowerCase()}`}><header><span>{claim.class}</span><b>{label}</b></header><p>{visibleText(claim.text)}</p><EvidenceDetails refs={claim.evidenceRefs} catalog={catalog} /></article>;
}

function ReviewContextPanel({ context, evidenceCatalog }: { context: ShotReviewContext; evidenceCatalog: Record<string, ReviewEvidence> }) {
  const neighbourOrder = ['previous', 'current', 'next'] as const;
  return <section className="v8-review-context">
    <header><div><small>STORY-SPECIFIC REVIEW CONTEXT</small><h3>这个镜头为什么存在，它承接什么</h3></div><span className={context.semanticStatus === 'AUTHORED_DRAFT' ? 'tone-good' : 'tone-waiting'}>{context.semanticStatus === 'AUTHORED_DRAFT' ? '已显式创作 · 待审定' : '现有来源已组装 · 独立意图含UNKNOWN'}</span></header>
    <div className="v8-context-position"><b>{context.position.sequenceId}</b><span>{visibleText(context.sequence.title.text)}</span><i>→</i><b>{context.position.episodeId}</b><span>{context.position.sceneId} · {visibleText(context.scene.slugline)}</span><i>→</i><b>{context.position.shotId}</b><span>本场第{context.position.shotOrdinal}/{context.position.shotTotal}镜</span></div>
    <div className="v8-context-grid"><ClaimBlock label="所属故事序列的结构作用" claim={context.sequence.structuralRole} catalog={evidenceCatalog} /><ClaimBlock label="此时观众已经知道" claim={context.sequence.audienceKnowledge} catalog={evidenceCatalog} /><ClaimBlock label="本镜发生的事件" claim={context.shot.storyEvent} catalog={evidenceCatalog} /><ClaimBlock label="本镜叙事目的" claim={context.shot.purpose} catalog={evidenceCatalog} /><ClaimBlock label="希望观众从本镜获得" claim={context.shot.audienceTakeaway} catalog={evidenceCatalog} /><ClaimBlock label="本镜核心判断问题" claim={context.shot.reviewQuestion} catalog={evidenceCatalog} /></div>
    <details className="v8-context-scene"><summary>展开所属故事序列、分集判断与制作语法</summary><div className="v8-context-grid"><ClaimBlock label="故事序列标题" claim={context.sequence.title} catalog={evidenceCatalog} /><ClaimBlock label="故事序列摘要" claim={context.sequence.summary} catalog={evidenceCatalog} /><ClaimBlock label="视觉语法" claim={context.sequence.visualGrammar} catalog={evidenceCatalog} /><ClaimBlock label="剪辑节奏" claim={context.sequence.editorialRhythm} catalog={evidenceCatalog} />{context.sequence.constraints.map((claim, index) => <ClaimBlock key={index} label={`序列不可破坏约束 ${index + 1}`} claim={claim} catalog={evidenceCatalog} />)}<ClaimBlock label={`本集 ${context.episode.id} 核心审阅问题`} claim={context.episode.reviewQuestion} catalog={evidenceCatalog} /></div></details>
    <div className="v8-neighbour-strip">{neighbourOrder.map((key) => { const record = context.neighbours[key]; return <article className={key === 'current' ? 'active' : ''} key={key}><small>{key === 'previous' ? '上一镜' : key === 'current' ? '当前镜' : '下一镜'}</small><b>{visibleText(record.id ? `${record.id} · ${record.title}` : record.title)}</b><p>{visibleText(record.storyEvent)}</p>{record.dialogue && <q>{visibleText(record.dialogue)}</q>}</article>; })}</div>
    <details className="v8-context-scene"><summary>展开本场剧本、连续性与分集未知项</summary><div><article><b>本场剧本片段</b><p>{visibleText(context.scene.scriptExcerpt)}</p></article><article><b>人物路线</b><p>{visibleText(context.scene.route)}</p></article><article><b>道具与状态</b><p>{visibleText(context.scene.keyPropsAndState)}</p></article><article><b>连续性要求</b><p>{visibleText(context.scene.continuity)}</p></article></div><div className="v8-context-grid"><ClaimBlock label="分集开场钩子" claim={context.episode.openingHook} catalog={evidenceCatalog} /><ClaimBlock label="分集核心推进" claim={context.episode.coreAdvance} catalog={evidenceCatalog} /><ClaimBlock label="分集结尾悬念" claim={context.episode.endingCliffhanger} catalog={evidenceCatalog} /></div>{context.scene.adaptationDeviation && <ClaimBlock label="改编与制作边界差异" claim={context.scene.adaptationDeviation} catalog={evidenceCatalog} />}</details>
    <div className="v8-context-guards"><article><b>画面必须守住</b>{context.shot.mustShow.map((claim, index) => <section className="v8-context-guard-item" key={index}><p><span>{claim.class}</span>{visibleText(claim.text)}</p><EvidenceDetails refs={claim.evidenceRefs} catalog={evidenceCatalog} /></section>)}</article><article><b>不得让观众误读为</b>{context.shot.mustNotImply.map((claim, index) => <section className="v8-context-guard-item" key={index}><p><span>{claim.class}</span>{visibleText(claim.text)}</p><EvidenceDetails refs={claim.evidenceRefs} catalog={evidenceCatalog} /></section>)}</article></div>
    <footer><span>上下文哈希</span><code>{context.contextHash}</code><EvidenceDetails refs={context.sourceRefs} catalog={evidenceCatalog} label="查看上下文依据内容" /></footer>
  </section>;
}

function ScopedReviewContextPanel({ context, evidenceCatalog }: { context: ScopedReviewContext; evidenceCatalog: Record<string, ReviewEvidence> }) {
  const unknownClaim = (text: string): ReviewClaim => ({ class: 'U', text, evidenceRefs: [] });
  const scopeLabelText = context.scopeType === 'SCENE' ? '整场' : context.scopeType === 'EPISODE' ? '整集' : context.scopeType === 'PROJECT' ? '全剧' : '本镜';
  const purpose = context.judgment?.purpose || unknownClaim(`${context.scopeId}的独立叙事目的为UNKNOWN。`);
  const audience = context.judgment?.audienceTakeaway || unknownClaim(`${context.scopeId}结束时观众所得为UNKNOWN。`);
  const question = context.judgment?.reviewQuestion || unknownClaim(`${context.scopeId}的正式判断问题为UNKNOWN。`);
  return <section className="v8-review-context creator-scoped-review-context">
    <header><div><small>{`${context.scopeType} REVIEW CONTEXT`}</small><h3>{`${context.scopeId} · ${scopeLabelText}正式审阅边界`}</h3><p>{context.scopeType==='SHOT'?'正式审阅绑定本镜永久身份、当前制作工作项与精确版本。':'当前页面中的镜头用于浏览组成部分；正式裁决绑定此处完整范围。'}</p></div><span className={context.reviewable && context.semanticStatus !== 'UNKNOWN_STALE_BINDING' ? 'tone-good' : 'tone-danger'}>{context.semanticStatus === 'AUTHORED_DRAFT' ? '已显式创作 · 待审定' : context.semanticStatus === 'ASSEMBLED_WITH_UNKNOWNS' ? '来源已组装 · 含UNKNOWN' : '绑定已失效 · 禁止提交'}</span></header>
    <div className="v8-context-position"><b>{context.scopeType}</b><span>{context.scopeId}</span><i>→</i><b>正式对象</b><span>{scopeLabelText}</span><i>→</i><b>提交资格</b><span>{context.reviewable ? '可在候选齐备后审阅' : '当前不可审阅'}</span></div>
    <div className="v8-context-grid"><ClaimBlock label={`${scopeLabelText}叙事目的`} claim={purpose} catalog={evidenceCatalog} /><ClaimBlock label={`${scopeLabelText}观众所得`} claim={audience} catalog={evidenceCatalog} /><ClaimBlock label={`${scopeLabelText}核心判断问题`} claim={question} catalog={evidenceCatalog} /></div>
    {context.scene && <details open className="v8-context-scene"><summary>整场剧情、空间与连续性</summary><div><article><b>场次与剧本片段</b><p>{visibleText([context.scene.id, context.scene.slugline, context.scene.scriptExcerpt].filter(Boolean).join(' · '))}</p></article><article><b>人物路线</b><p>{visibleText(context.scene.route || 'UNKNOWN')}</p></article><article><b>道具与状态</b><p>{visibleText(context.scene.keyPropsAndState || 'UNKNOWN')}</p></article><article><b>连续性要求</b><p>{visibleText(context.scene.continuity || 'UNKNOWN')}</p></article></div></details>}
    {context.episode && <details open className="v8-context-scene"><summary>分集结构提案与UNKNOWN边界</summary><div className="v8-context-grid"><ClaimBlock label="分集开场钩子" claim={context.episode.openingHook || unknownClaim('UNKNOWN')} catalog={evidenceCatalog} /><ClaimBlock label="分集核心推进" claim={context.episode.coreAdvance || unknownClaim('UNKNOWN')} catalog={evidenceCatalog} /><ClaimBlock label="分集结尾悬念" claim={context.episode.endingCliffhanger || unknownClaim('UNKNOWN')} catalog={evidenceCatalog} /></div></details>}
    {context.project && <div className="creator-project-gates"><article><b>覆盖范围</b><p>{`${context.project.episodeIds?.length || 0}集 · ${context.project.sceneCount ?? 'UNKNOWN'}场 · 镜头分母按当前ShotPlanSet锁定`}</p></article><article><b>商业发行合规</b><p>{visibleText(context.project.commercialReleaseCompliance || 'UNKNOWN')}</p></article><article><b>边界</b><p>项目内采用不等于对外发行或法律核验完成。</p></article></div>}
    <footer><span>范围上下文哈希</span><code>{context.contextHash}</code><EvidenceDetails refs={context.sourceRefs || []} catalog={evidenceCatalog} label="查看范围上下文依据内容" /></footer>
  </section>;
}

function TextReviewOriginal({url,sha256,onReady,onError}:{url:string;sha256:string;onReady:()=>void;onError:()=>void}){
  const [content,setContent]=useState('正在读取文本原件…');const callbacks=useRef({onReady,onError});
  useEffect(()=>{callbacks.current={onReady,onError};},[onReady,onError]);
  useEffect(()=>{let active=true;fetch(url,{cache:'no-store'}).then(async response=>{if(!response.ok)throw Error('文本原件无法读取');const bytes=await response.arrayBuffer();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');if(hash!==sha256)throw Error('文本原件与登记SHA不一致');if(active){setContent(new TextDecoder().decode(bytes));callbacks.current.onReady();}}).catch(error=>{if(active){setContent(error instanceof Error?error.message:'文本原件无法核验');callbacks.current.onError();}});return()=>{active=false;};},[url,sha256]);
  return <pre className="production-text-original" aria-label="SHA核验的文本原件">{content}</pre>;
}

function ReviewTargetPanel({
  shot,
  reviewContext,
  item,
  family,
  version,
  inspectedFamily,
  recipe,
  recipeError,
  originalMediaUrl,
  originalMediaError,
  comparisonFamily,
  comparisonVersion,
  comparisonMediaUrl,
  comparisonMediaError,
  showComparison,
  onToggleComparison,
  onMediaReady,
  onMediaError,
  effectiveReview,
}: {
  shot: V7Shot;
  reviewContext: ScopedReviewContext | null;
  item: V7WorkItem;
  family: V7AssetFamily | null;
  version: V7AssetVersion | null;
  inspectedFamily: V7AssetFamily | null;
  recipe: ExecutionRecipe | null;
  recipeError: string;
  originalMediaUrl: string | null;
  originalMediaError: string;
  comparisonFamily: V7AssetFamily | null;
  comparisonVersion: V7AssetVersion | null;
  comparisonMediaUrl: string | null;
  comparisonMediaError: string;
  showComparison: boolean;
  onToggleComparison: () => void;
  onMediaReady: () => void;
  onMediaError: () => void;
  effectiveReview: ReviewEventRecord | null;
}) {
  const kind = mediaKind(version?.path || null);
  const comparisonKind = mediaKind(comparisonVersion?.path || null);
  const isInspectingDependency = Boolean(inspectedFamily && inspectedFamily.id !== family?.id);
  const projectedItem = withReviewProjection(item, effectiveReview);
  const isShotScope = reviewContext?.scopeType === 'SHOT';
  const scopePurpose = (isShotScope ? shot.reviewContext?.shot?.purpose?.text : null) || reviewContext?.judgment?.purpose?.text || `${reviewContext?.scopeId || item.scopeId}的独立叙事目的为UNKNOWN。`;
  const scopeAudience = (isShotScope ? shot.reviewContext?.shot?.audienceTakeaway?.text : null) || reviewContext?.judgment?.audienceTakeaway?.text || `${reviewContext?.scopeId || item.scopeId}结束时观众所得为UNKNOWN。`;
  const scopeQuestion = (isShotScope ? shot.reviewContext?.shot?.reviewQuestion?.text : null) || reviewContext?.judgment?.reviewQuestion?.text || `${reviewContext?.scopeId || item.scopeId}的正式判断问题为UNKNOWN。`;
  const scopeNoun = isShotScope ? '本镜' : reviewContext?.scopeType === 'SCENE' ? '整场' : reviewContext?.scopeType === 'EPISODE' ? '整集' : reviewContext?.scopeType === 'PROJECT' ? '全剧' : '当前范围';
  return <section className="v8-review-target">
    <header><div><small>FORMAL DECISION TARGET · OUTPUT ONLY</small><h3>{visibleText(family?.label || workItemLabel(item))}</h3><p>{version ? `${visibleText(version.label)} · ${version.sha256 ? 'SHA ' + version.sha256 : '无文件哈希'}` : '计划定义 · 尚无可审文件'}</p></div><StatusHeadline record={projectedItem} compact /></header>
    {isInspectingDependency && <div className="v8-evidence-warning"><b>右侧正在查看依赖证据：{visibleText(inspectedFamily?.label)}</b><p>它只帮助判断，不会改变正式裁决对象。提交始终绑定上方产出资产 {publicRef(family?.id) || 'UNKNOWN'} 与版本 {publicRef(version?.id) || 'UNKNOWN'}。</p></div>}
    <div className="creator-compare-toolbar"><div><b>A · 正式裁决对象</b><span>{publicRef(version?.id) || '尚无版本'}</span></div>{comparisonVersion ? <><div><b>B · 比较证据</b><span>{publicRef(comparisonVersion.id)} · {visibleText(comparisonFamily?.label || '')}</span></div><button type="button" aria-pressed={showComparison} onClick={onToggleComparison}>{showComparison ? '隐藏 B' : '显示 B'} <kbd>C</kbd></button></> : <p>从下方制作信息选择依赖或历史版本，即可建立A/B比较。</p>}</div>
    <div className={'creator-media-comparison ' + (showComparison && comparisonVersion ? 'is-comparing' : '')}>
      <figure><figcaption><b>A · 当前正式对象</b><span>{visibleText(version?.label || '尚无版本')}</span></figcaption><div className="v8-review-media">
        {originalMediaUrl && kind === 'IMAGE' && <img src={originalMediaUrl} alt={visibleText(family?.label || item.id) + '与登记SHA一致的原件'} onLoad={onMediaReady} onError={onMediaError} />}
        {originalMediaUrl && kind === 'AUDIO' && <audio controls preload="metadata" src={originalMediaUrl} onCanPlay={onMediaReady} onError={onMediaError}>你的浏览器不支持音频播放。</audio>}
        {originalMediaUrl && kind === 'VIDEO' && <video controls preload="metadata" src={originalMediaUrl} onCanPlay={onMediaReady} onError={onMediaError}>你的浏览器不支持视频播放。</video>}
        {!originalMediaUrl && version?.outputState === 'PRESENT' && version.path && version.sha256 && !originalMediaError && <div><b>正在解析与登记SHA一致的原件…</b><p>{visibleText(version.path)}</p></div>}
        {(!version || version.outputState !== 'PRESENT' || !version.path || !version.sha256) && <div><b>当前没有可正式裁决的原件</b><p>{visibleText(version?.path || recipe?.output.path || '固定输出路径未登记')}</p><small>仍可核对执行配方和依赖，但不能提交结果裁决。</small></div>}
        {originalMediaUrl && kind === 'UNKNOWN' && /\.(json|txt|md)$/i.test(version?.path||'') && version?.sha256 && <TextReviewOriginal url={originalMediaUrl} sha256={version.sha256} onReady={onMediaReady} onError={onMediaError}/> }
        {originalMediaUrl && kind === 'UNKNOWN' && !/\.(json|txt|md)$/i.test(version?.path||'') && <div><b>该文件需在原件窗口核对</b><p>{visibleText(version?.path)}</p><small>当前类型不支持内嵌预览。</small></div>}
      </div></figure>
      {showComparison && comparisonVersion && <figure><figcaption><b>B · 只作比较证据</b><span>{visibleText(comparisonVersion.label)}</span></figcaption><div className="v8-review-media is-evidence">
        {comparisonMediaUrl && comparisonKind === 'IMAGE' && <img src={comparisonMediaUrl} alt={visibleText(comparisonFamily?.label || comparisonVersion.id) + '比较证据'} />}
        {comparisonMediaUrl && comparisonKind === 'AUDIO' && <audio controls preload="metadata" src={comparisonMediaUrl}>你的浏览器不支持音频播放。</audio>}
        {comparisonMediaUrl && comparisonKind === 'VIDEO' && <video controls preload="metadata" src={comparisonMediaUrl}>你的浏览器不支持视频播放。</video>}
        {!comparisonMediaUrl && <div><b>比较原件暂不可预览</b><p>{visibleText(comparisonVersion.path || comparisonMediaError || '没有登记媒体路径')}</p></div>}
      </div></figure>}
    </div>
    <div className="v8-original-proof"><div><b>与裁决绑定的原件</b><code>{publicRef(version?.id) || '无版本'}<br />{version?.sha256 || '无SHA-256'}</code></div>{originalMediaUrl ? <a href={originalMediaUrl} target="_blank" rel="noreferrer">在新窗口打开SHA绑定原件</a> : <span>原件地址不可用</span>}</div>
    <div className="v8-review-brief creator-review-brief"><article><span>{scopeNoun}为什么存在</span><h4>{visibleText(scopePurpose)}</h4><p>{visibleText(scopeAudience)}</p></article><article><span>{scopeNoun}核心判断</span><h4>{visibleText(scopeQuestion)}</h4><p>逐项判断始终绑定A与当前范围哈希；B只用于发现版本退化或依赖偏差。</p></article></div>
    <div className="v8-review-effects"><p><b>通过后</b>{item.deliverableKey === 'STORYBOARD' ? '与本镜适用对白共同进入场级Animatic；校准子集全部通过后才允许锁时。' : '按直接依赖关系重新计算下游资格。'}</p><p><b>退回后</b>当前版本保持可追溯，记录具体问题并创建新版本；不得原位覆盖。</p></div>
    {originalMediaError && <p className="v8-inline-error">原件无法核验：{visibleText(originalMediaError)}</p>}
    {recipeError && <p className="v8-inline-error">执行配方暂时无法读取：{visibleText(recipeError)}</p>}
  </section>;
}

function recipeCallPackage(recipe: ExecutionRecipe) {
  return {
    schemaVersion: '1.0',
    executionDefinitionId: recipe.id,
    revisionId: recipe.currentRevisionId,
    callPackageHash: recipe.definitionHash,
    executorKind: recipe.executorKind,
    model: recipe.model,
    inputBindings: recipe.upload.items.map((item) => ({ order: item.order, path: item.path, assetFamilyRef: item.assetFamilyRef || '', assetVersionRef: item.assetVersionRef || '' })),
    prompt: recipe.prompt,
    parametersRaw: recipe.parametersRaw || null,
    output: recipe.output,
    declaredGate: recipe.declaredGate,
  };
}

function completeProductionPrompt(recipe: ExecutionRecipe) {
  const main = recipe.prompt.main?.trim() || '不适用（人工剪辑任务）';
  const negative = recipe.prompt.negative?.trim();
  if (!negative) return main;
  return `${main}\n\n【排除要求（生产调用时一并应用）】\n${negative}`;
}

function reviewerCallPackage(recipe: ExecutionRecipe) {
  return {
    schemaVersion: '1.0',
    executionDefinitionId: recipe.id,
    revisionId: recipe.currentRevisionId,
    callPackageHash: recipe.definitionHash,
    executorKind: recipe.executorKind,
    model: recipe.model,
    inputBindings: recipe.upload.items.map((item) => ({ order: item.order, path: item.path, assetFamilyRef: item.assetFamilyRef || '', assetVersionRef: item.assetVersionRef || '' })),
    prompt: completeProductionPrompt(recipe),
    parametersRaw: recipe.parametersRaw || null,
    output: recipe.output,
  };
}

function recipeCallPackageMarkdown(recipe: ExecutionRecipe, reviewerView = false) {
  if (reviewerView) {
    return [
      `# ${recipe.title}`,
      '',
      `- 模型／执行器：${recipe.executorKind} · ${recipe.model.branch || recipe.model.rawRule}`,
      ...(recipe.upload.items.length ? [
        '',
        '## 上传附件（严格保序）',
        ...recipe.upload.items.map((item) => `${item.order}. ${item.path}`),
      ] : []),
      '',
      '## 完整 Prompt',
      completeProductionPrompt(recipe),
      '',
      '## 参数／规格',
      recipe.parametersRaw || '无／不适用',
      '',
      '## 固定输出',
      recipe.output.path,
    ].join('\n');
  }
  return [
    `# ${recipe.title}`,
    '',
    `- 执行定义：${recipe.id}`,
    `- 修订：${recipe.currentRevisionId}`,
    `- 调用包哈希：${recipe.definitionHash}`,
    `- 模型／执行器：${recipe.executorKind} · ${recipe.model.branch || recipe.model.rawRule}`,
    '',
    '## 上传附件（严格保序）',
    ...(recipe.upload.items.length ? recipe.upload.items.map((item) => `${item.order}. ${item.path}`) : ['无附件']),
    '',
    '## 主 Prompt',
    recipe.prompt.main || '不适用（人工剪辑任务）',
    '',
    '## 负面 Prompt',
    recipe.prompt.negative || '无／不适用',
    '',
    '## 参数／规格',
    recipe.parametersRaw || '无／不适用',
    '',
    '## 固定输出',
    recipe.output.path,
    '',
    '## 声明门禁',
    recipe.declaredGate,
  ].join('\n');
}

async function currentMutationEtag(snapshotId: string) {
  const response = await fetch('/api/v8/operations/snapshot');
  if (!response.ok) throw new Error(`运行快照 HTTP ${response.status}`);
  const payload = await response.json() as OperationalSnapshot;
  const currentSnapshotId = payload.snapshotId || payload.baseSnapshotId || '';
  if (currentSnapshotId !== snapshotId) throw new Error('页面快照已过期，请刷新后重新授权或登记');
  const etag = payload.mutationEtag || payload.etag;
  if (!etag) throw new Error('运行快照没有可用于安全写入的ETag');
  return etag;
}

function RecipeExecutionControls({ recipe, context }: { recipe: ExecutionRecipe; context: ExecutionUiContext }) {
  const { hostedReadOnly } = useRuntimeMode();
  const configurationProfile=useInstanceProfile();
  const [executor, setExecutor] = useState<'CODEX' | 'USER_EXTERNAL'>(()=>(context.configurationBinding?.productionLane === 'CODEX' || (context.configurationBinding?.productionLane !== 'USER_EXTERNAL' && (context.configurationBinding?.defaultExecutor || configurationProfile.capabilities.defaultExecutor)==='CODEX'))?'CODEX':'USER_EXTERNAL');
  const [message, setMessage] = useState('这里只创建明确范围的执行授权，不会在浏览器中直接调用模型。');
  const [busy, setBusy] = useState(false);
  const [executionRequestId, setExecutionRequestId] = useState('');
  const resultPath = context.expectedOutput?.targetPath || '';
  const [resultLabel, setResultLabel] = useState('');
  const [runId, setRunId] = useState('');
  const [runState, setRunState] = useState('');
  const [providerRunId, setProviderRunId] = useState('');
  const [runNote, setRunNote] = useState('');
  const [actualPrompt, setActualPrompt] = useState(recipe.prompt.main || '');
  const [actualNegativePrompt, setActualNegativePrompt] = useState(recipe.prompt.negative || '');
  const inputBindings = recipe.upload.items.map((item) => ({ order: item.order, path: item.path, assetFamilyRef: item.assetFamilyRef || '', assetVersionRef: item.assetVersionRef || '' }));

  async function authorize() {
    if (!context.familyId) { setMessage('当前工作项没有输出资产族，不能创建生成授权。'); return; }
    try {
      setBusy(true);
      setMessage('正在校验快照并记录执行授权…');
      const etag = await currentMutationEtag(context.snapshotId);
      const body = {
        snapshotId: context.snapshotId,
        action: 'AUTHORIZE',
        workItemId: context.workItemId,
        familyId: context.familyId,
        callPackageHash: recipe.definitionHash,
        executor,
        authorized: true,
        maxOutputs: 1,
        inputBindings,
      };
      const semanticKey = await stableDigest(JSON.stringify(body));
      const response = await fetch('/api/v8/execution-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'execution-request-' + semanticKey, 'If-Match': etag },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { eventId?: string; executionRequestId?: string; status?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setExecutionRequestId(payload.executionRequestId || '');
      setMessage(`${executor === 'CODEX' ? 'Codex执行' : '用户外部执行'}授权已登记：${payload.executionRequestId || payload.eventId || '成功'}。配方或快照变化后该授权自动失效。`);
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) {
      setMessage('授权登记失败：' + visibleText(reason instanceof Error ? reason.message : '未知错误'));
    } finally {
      setBusy(false);
    }
  }

  async function registerCandidate() {
    if (!context.familyId) { setMessage('当前工作项没有输出资产族，不能登记候选。'); return; }
    const expectedOutput = context.expectedOutput;
    if (!expectedOutput) { setMessage('当前工作项缺少精确预期产物，请刷新并核对当前目标。'); return; }
    if (recipe.materialProductionPlanId && recipe.parentVersionId !== null && (typeof recipe.parentVersionId !== 'string' || !recipe.parentVersionId)) { setMessage('基础素材调用包缺少精确父版本依据，请重新读取制作资料。'); return; }
    const normalizedPath = normalizedProjectRelativePath(resultPath);
    if (normalizedPath.error) { setMessage(normalizedPath.error); return; }
    if (!expectedOutput || expectedOutput.familyId !== context.familyId
      || expectedOutput.id !== recipe.output.expectedOutputRef
      || recipe.output.assetFamilyRef !== context.familyId
      || normalizedPath.normalized !== recipe.output.path
      || expectedOutput.expectationState !== 'PLANNED') {
      setMessage('当前预期产物与调用包不一致，请刷新并核对当前目标。');
      return;
    }
    try { instanceCandidateRelativePath(normalizedPath.normalized, context.familyId); }
    catch { setMessage('当前预期产物不是受控候选媒体路径。'); return; }
    if (!executionRequestId.startsWith('xreq_')) { setMessage('请填写与本结果绑定的 Execution Request ID。'); return; }
    if (!runId.startsWith('run_')) { setMessage('请填写已进入 SUCCEEDED 的 Run ID；文件存在或平台提示成功都不能替代Run证据。'); return; }
    if (!actualPrompt.trim()) { setMessage('实际Prompt不能为空；外部调整过时必须粘贴最终实际Prompt。'); return; }
    try {
      setBusy(true);
      setMessage('正在预检并登记已有候选结果…');
      const etag = await currentMutationEtag(context.snapshotId);
      const body = {
        snapshotId: context.snapshotId,
        familyId: context.familyId,
        path: normalizedPath.normalized,
        expectedOutputId: expectedOutput.id,
        label: resultLabel.trim() || undefined,
        note: '由创作者工作台登记已有_review_pending结果；不移动媒体。',
        runId: runId.trim(),
        executionRequestId: executionRequestId.trim(),
        executionDefinitionId: recipe.id,
        callPackageHash: recipe.definitionHash,
        actualPrompt: actualPrompt === (recipe.prompt.main || '') && actualNegativePrompt === (recipe.prompt.negative || '')
          ? recipe.prompt
          : { ...recipe.prompt, main: actualPrompt, negative: actualNegativePrompt },
        inputBindings,
        parentVersionId: recipe.materialProductionPlanId ? recipe.parentVersionId : context.parentVersionId,
      };
      const semanticKey = await stableDigest(JSON.stringify(body));
      const response = await fetch('/api/v8/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'candidate-import-' + semanticKey, 'If-Match': etag },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { eventId?: string; versionId?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setMessage(`候选已登记为 ${payload.versionId || payload.eventId || '新版本'}；仍为REVIEW_PENDING，未移动媒体、未放行。`);
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) {
      setMessage('候选登记失败：' + visibleText(reason instanceof Error ? reason.message : '未知错误'));
    } finally {
      setBusy(false);
    }
  }

  async function reportExternalRun(state: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'RESULT_UNKNOWN') {
    if (executor !== 'USER_EXTERNAL') { setMessage('只有“我在外部执行”的授权可在这里登记运行；Codex运行由本地主机工作器回写。'); return; }
    if (!executionRequestId.startsWith('xreq_')) { setMessage('请先完成外部执行授权，或填入对应的 Execution Request ID。'); return; }
    if (state !== 'SUBMITTED' && !runId.startsWith('run_')) { setMessage('请先登记“已提交到外部平台”，取得本次 Run ID。'); return; }
    if (['FAILED', 'RESULT_UNKNOWN'].includes(state) && !runNote.trim()) { setMessage(`${state === 'FAILED' ? '执行失败' : '结果不明'}必须写明可核查的具体情况。`); return; }
    try {
      setBusy(true);
      setMessage('正在登记外部运行事实…');
      const etag = await currentMutationEtag(context.snapshotId);
      const body = {
        snapshotId: context.snapshotId,
        executionRequestId: executionRequestId.trim(),
        executionDefinitionId: recipe.id,
        callPackageHash: recipe.definitionHash,
        runId: runId || undefined,
        state,
        providerRunId: providerRunId.trim() || undefined,
        note: runNote.trim() || undefined,
      };
      const semanticKey = await stableDigest(JSON.stringify(body));
      const response = await fetch('/api/v8/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'external-run-' + semanticKey, 'If-Match': etag },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { eventId?: string; runId?: string; state?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setRunId(payload.runId || runId);
      setRunState(payload.state || state);
      setMessage(state === 'SUCCEEDED'
        ? `外部运行已登记成功：${payload.runId}。现在可登记已有候选文件。`
        : state === 'RESULT_UNKNOWN'
          ? `已登记结果不明：${payload.runId}。请先按平台任务ID核查，禁止自动重试。`
          : state === 'FAILED'
            ? `已登记执行失败：${payload.runId}。本次授权不会自动重试。`
            : `已登记提交：${payload.runId}。取得明确结果后再选择成功、失败或结果不明。`);
      window.dispatchEvent(new CustomEvent('review:operations-updated'));
    } catch (reason) {
      setMessage('外部运行登记失败：' + visibleText(reason instanceof Error ? reason.message : '未知错误'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="creator-execution-controls">
    <header><div><small>EXECUTION HANDOFF</small><h4>标记可生成</h4></div><span>每项每轮最多1个永久候选</span></header>
    <div className="creator-executor-choice" role="radiogroup" aria-label="选择执行者"><button type="button" role="radio" aria-checked={executor === 'CODEX'} className={executor === 'CODEX' ? 'active' : ''} onClick={() => { setExecutor('CODEX'); setExecutionRequestId(''); setRunId(''); setRunState(''); }}><b>Codex执行</b><small>本次点击即授权明确工作项；不会扩大到下一批。</small></button><button type="button" role="radio" aria-checked={executor === 'USER_EXTERNAL'} className={executor === 'USER_EXTERNAL' ? 'active' : ''} onClick={() => { setExecutor('USER_EXTERNAL'); setExecutionRequestId(''); setRunId(''); setRunState(''); }}><b>我在外部执行</b><small>只进入用户执行队列，不授权Codex调用模型。</small></button></div>
    <button type="button" className="creator-authorize-button" disabled={hostedReadOnly || busy || !context.familyId || !context.canAuthorize} onClick={() => void authorize()}>{busy ? '正在处理…' : hostedReadOnly ? '远端镜像不可授权生成' : `标记可生成 · ${executor === 'CODEX' ? 'Codex执行' : '我在外部执行'}`}</button>
    {!context.canAuthorize && <p className="creator-execution-gate">当前不能授权生成：{visibleText(context.authorizeReason)}</p>}
    {executor === 'USER_EXTERNAL' && executionRequestId.startsWith('xreq_') && <section className="creator-external-run"><header><div><b>记录外部平台运行</b><span>{runState ? `当前：${visibleText(runState)}` : '尚未登记提交'}</span></div><code>{executionRequestId}</code></header><label><span>平台任务ID（建议填写）</span><input value={providerRunId} onChange={(event) => setProviderRunId(event.target.value)} placeholder="historyId / requestId / taskId" /></label><label><span>情况说明（失败／结果不明必填）</span><textarea value={runNote} onChange={(event) => setRunNote(event.target.value)} placeholder="记录平台提示、核查入口或失败原因；不要粘贴密钥" /></label><div>{!runId && <button type="button" disabled={hostedReadOnly || busy} onClick={() => void reportExternalRun('SUBMITTED')}>已提交到外部平台</button>}{runId && ['SUBMITTED', 'RUNNING', ''].includes(runState) && <><button type="button" disabled={hostedReadOnly || busy} onClick={() => void reportExternalRun('SUCCEEDED')}>已有明确结果</button><button type="button" disabled={hostedReadOnly || busy} onClick={() => void reportExternalRun('FAILED')}>执行失败</button><button type="button" disabled={hostedReadOnly || busy} onClick={() => void reportExternalRun('RESULT_UNKNOWN')}>结果不明</button></>}</div>{runId && <p>本次Run：<code>{runId}</code>{runState === 'SUCCEEDED' ? ' · 可继续登记候选' : ''}</p>}</section>}
    <details className="creator-candidate-import"><summary>登记已有候选结果</summary><p>这里只登记已存在于项目 <code>_review_pending</code> 的文件，不上传二进制、不移动媒体，也不代表正式放行。必须绑定已授权请求和已成功Run；附件、模型和参数若偏离已授权调用包，应先更新配方并重新授权。</p><label><span>已冻结的候选目标路径</span><input value={resultPath} readOnly placeholder="尚无精确预期产物" /></label><div><label><span>候选标签（可选）</span><input value={resultLabel} onChange={(event) => setResultLabel(event.target.value)} placeholder="例如：返修V002" /></label><label><span>Run ID（必填）</span><input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="run_…" /></label></div><label><span>Execution Request ID（必填）</span><input value={executionRequestId} onChange={(event) => setExecutionRequestId(event.target.value)} placeholder="xreq_…" /></label><label><span>实际使用的完整主Prompt</span><textarea value={actualPrompt} onChange={(event) => setActualPrompt(event.target.value)} /><small>若在外部平台改过Prompt，必须用最终实际文本替换这里的配方原文。</small></label><label><span>实际使用的完整负面Prompt</span><textarea value={actualNegativePrompt} onChange={(event) => setActualNegativePrompt(event.target.value)} /><small>没有负面Prompt时保持为空；不得把改动只留在平台历史中。</small></label><button type="button" disabled={hostedReadOnly || busy || !context.familyId} onClick={() => void registerCandidate()}>{busy ? '正在处理…' : hostedReadOnly ? '远端镜像不可登记候选' : '预检并登记已有结果'}</button></details>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}

export function RecipePanel({ definitionRef, recipe, error, title = '制作依据：附件、Prompt、模型与固定输出', executionContext, authorWorkItemId, defaultOpen = false, reviewerView = false, expanded = false, compact = false }: { definitionRef?: string | null; recipe: ExecutionRecipe | null; error?: string; title?: string; executionContext?: ExecutionUiContext; authorWorkItemId?:string; defaultOpen?: boolean; reviewerView?: boolean; expanded?: boolean; compact?: boolean }) {
  const {hostedReadOnly}=useRuntimeMode();
  const packageJson = recipe ? JSON.stringify(reviewerView ? reviewerCallPackage(recipe) : recipeCallPackage(recipe), null, 2) : '';
  const packageMarkdown = recipe ? recipeCallPackageMarkdown(recipe, reviewerView) : '';
  const completePrompt = recipe ? completeProductionPrompt(recipe) : '';
  const Wrapper = expanded ? 'section' : 'details';
  const fixedOutput = recipe ? <section className="creator-recipe-section is-output"><header><b>固定输出</b><code title={recipe.output.path}>{recipe.output.path}</code><ClipboardButton value={recipe.output.path} label="复制固定输出" /></header></section> : null;
  return <Wrapper {...(!expanded ? { open: defaultOpen } : {})} className={`v7-technical-details v8-recipe-panel${compact ? ' material-recipe-compact' : ''}`}>{expanded ? <h4>{title}</h4> : <summary>{title}</summary>}{!definitionRef ? <p className="v6-empty-note">当前对象没有独立执行定义；不伪造Prompt。</p> : error ? <p className="v8-inline-error">完整执行配方读取失败：{visibleText(error)}</p> : !recipe ? <p className="v6-empty-note">正在按需读取完整执行配方…</p> : <div>
    {compact&&fixedOutput}
    <div className="creator-call-package-actions"><ClipboardButton value={packageMarkdown} label="复制完整调用包" /><ClipboardButton value={packageJson} label={reviewerView ? '复制生产资料 JSON' : '复制调用包 JSON'} /></div>
    {!reviewerView && <p><b>执行定义</b><code>{publicRef(recipe.id)} · {publicRef(recipe.currentRevisionId)}<br />{recipe.definitionHash}</code></p>}
    <p><b>模型／执行器</b><span>{visibleText(recipe.executorKind + ' · ' + (recipe.model.branch || recipe.model.rawRule))}</span></p>
    {recipe.upload.items.length > 0 && <section className="creator-recipe-section"><header><b>上传附件（严格保序）</b><ClipboardButton value={recipe.upload.items.map((item) => `${item.order}. ${item.path}`).join('\n')} label="复制附件清单" /></header><ol>{recipe.upload.items.map((upload) => <li key={upload.order + upload.path}><span>{upload.order}</span><code>{visibleText(upload.path)}</code></li>)}</ol></section>}
    {recipe.upload.items.length > 0 && recipe.upload.rawText && <section className="creator-recipe-section"><header><b>附件定义</b><ClipboardButton value={recipe.upload.rawText} label="复制附件定义" /></header><pre>{visibleText(recipe.upload.rawText)}</pre></section>}
    {reviewerView
      ? <section className="creator-recipe-section"><header><b>完整 Prompt</b><ClipboardButton value={completePrompt} label="复制完整 Prompt" /></header><pre>{visibleText(completePrompt)}</pre></section>
      : <><section className="creator-recipe-section"><header><b>主 Prompt</b><ClipboardButton value={recipe.prompt.main || '不适用（人工剪辑任务）'} label="复制主Prompt" /></header><pre>{visibleText(recipe.prompt.main || '不适用（人工剪辑任务）')}</pre></section><section className="creator-recipe-section"><header><b>负面 Prompt</b><ClipboardButton value={recipe.prompt.negative || '无／不适用'} label="复制负面Prompt" /></header><pre>{visibleText(recipe.prompt.negative || '无／不适用')}</pre></section></>}
    {recipe.parametersRaw && <section className="creator-recipe-section"><header><b>参数／规格</b><ClipboardButton value={recipe.parametersRaw} label="复制参数" /></header><pre>{visibleText(recipe.parametersRaw)}</pre></section>}
    {!compact&&fixedOutput}
    {!reviewerView && recipe.reviewSpec && <><p><b>执行定义附带的审阅提示</b><span>{visibleText(recipe.reviewSpec.question)}</span></p><ul>{recipe.reviewSpec.criteria.map((criterion) => <li key={criterion}>{visibleText(criterion)}</li>)}</ul></>}
    {executionContext && <RecipeExecutionControls key={`${recipe.id}:${recipe.currentRevisionId}:${executionContext.workItemId}:${executionContext.configurationBinding?.configurationHash || "LEGACY"}`} recipe={recipe} context={executionContext} />}
    {!reviewerView && <details><summary>查看执行脚本全文（语义化展示）</summary><pre>{visibleText(recipe.rawSourceBlock)}</pre></details>}
  </div>}{authorWorkItemId&&!reviewerView&&<ShotProductionRecipeEditor key={authorWorkItemId} workItemId={authorWorkItemId} definitionRef={definitionRef} readOnly={hostedReadOnly}/>}</Wrapper>;
}

type WorkbenchSurface = 'PRE_OUTPUT' | 'REVIEW' | 'REVIEW_BLOCKED' | 'REVISION' | 'RELEASED' | 'FORBIDDEN';

function resolveWorkbenchSurface(item: V7WorkItem, version: V7AssetVersion | null, formalReviewSupported: boolean): WorkbenchSurface {
  const lifecycle = item.lifecycleState || version?.lifecycleState || 'WAITING_UPSTREAM';
  if (lifecycle === 'REVIEW_PENDING') {
    const outputBound = version?.outputState === 'PRESENT' && Boolean(version.path && version.sha256);
    return formalReviewSupported && outputBound ? 'REVIEW' : 'REVIEW_BLOCKED';
  }
  if (lifecycle === 'REVISION_REQUIRED') return 'REVISION';
  if (lifecycle === 'RELEASED') return 'RELEASED';
  if (['DO_NOT_USE', 'EVIDENCE_ONLY', 'DELETED_AUDIT'].includes(lifecycle)) return 'FORBIDDEN';
  return 'PRE_OUTPUT';
}

function postTaskForItem(model: ProductionModel, item: V7WorkItem | null) {
  if (!item) return null;
  return model.executionRecipeSummary?.postProductionTasks.find((task) => (
    task.workItemRef === item.id
    && (!item.executionDefinitionRef || !task.executionDefinitionRef || task.executionDefinitionRef === item.executionDefinitionRef)
  )) || null;
}

function ScopeStageContext({ model, shot, workPackage, item, task, reviewContext }: { model: ProductionModel; shot: V7Shot; workPackage: V7WorkPackage; item: V7WorkItem; task: PostProductionTask | null; reviewContext: ScopedReviewContext | null }) {
  const step = model.workflowSteps.find((record) => record.id === workPackage.stepId) || model.workflowSteps[0];
  const scene = model.scenes.find((record) => record.id === (workPackage.sceneId || shot.sceneId)) || null;
  const episode = model.episodes.find((record) => record.id === (workPackage.episodeId || shot.episodeId)) || null;
  const companionRefs = item.additionalOutputAssetRefs || [];
  const upstreamStep = workPackage.stepId === 'W07' ? 'W06' : workPackage.stepId === 'W08' ? 'W07' : workPackage.stepId === 'W09' ? 'W08' : null;
  const upstreamPackages = upstreamStep
    ? model.workPackages.filter((record) => record.stepId === upstreamStep && record.shotIds.some((id) => workPackage.shotIds.includes(id)))
    : [];
  const upstreamReleased = upstreamPackages.filter(isLifecycleComplete).length;
  const currentShotIds = fullProductionCurrentShotIds(model);
  const currentScopeShotCount = workPackage.shotIds.filter((id) => currentShotIds.has(id)).length;
  const currentShotStructure = currentScopeShotCount > 0 ? `${currentScopeShotCount}个当前镜头` : '当前镜头结构 UNKNOWN';
  const currentEpisodePlan = episodePlanIsCurrent(model);
  const episodePlanObjectLabel = currentEpisodePlan ? '当前分集方案' : '导航提案';

  if (!['W07', 'W08', 'W09'].includes(workPackage.stepId)) {
    const group = workPackage.scopeType === 'CONTINUITY_GROUP'
      ? model.continuityGroups.find((record) => record.id === workPackage.scopeId) || null
      : null;
    const currentGroupShotIds = group?.shotIds.filter((id) => currentShotIds.has(id)) || [];
    return <>
      {group && <section className="creator-scope-summary"><header><small>连续性组位置</small><h3>{visibleText(group.label)}</h3></header><div><p><b>当前镜头范围</b>{currentGroupShotIds.length ? currentGroupShotIds.join(' · ') : 'UNKNOWN · 历史关系见页面底部只读证据区'}</p><p><b>空间坐标</b>{[...group.locs, ...group.zones, ...group.cameras].join(' · ') || 'UNKNOWN'}</p><p><b>状态变化</b>{visibleText(group.stateFrom)} → {visibleText(group.stateTo)}</p><p><b>冻结点</b>{visibleText(group.freezeFrom)} → {visibleText(group.freezeTo)}</p></div></section>}
      {reviewContext && (reviewContext.scopeType !== 'SHOT'||!shot.reviewContext)
        ? <ScopedReviewContextPanel context={reviewContext} evidenceCatalog={model.reviewContextCatalog?.evidenceCatalog ?? {}} />
        : shot.reviewContext?<ReviewContextPanel context={shot.reviewContext} evidenceCatalog={model.reviewContextCatalog?.evidenceCatalog ?? {}} />:<p>本镜审阅上下文尚未就绪。</p>}
    </>;
  }

  const scopeTitle = workPackage.stepId === 'W07'
    ? `${scene?.id || workPackage.scopeId} · ${visibleText(scene?.title || '场声音后期')}`
    : workPackage.stepId === 'W08'
      ? `${episode?.displayId || episode?.id || workPackage.scopeId} · 分集成片（${episodePlanObjectLabel}）`
      : '本剧全剧终审 · 正式输入分母UNKNOWN';
  const scopePosition = workPackage.stepId === 'W07'
    ? `${episode?.id || shot.episodeId} → ${scene?.id || shot.sceneId} → 场级对象 · ${currentShotStructure}`
    : workPackage.stepId === 'W08'
      ? `${episode?.displayId || episode?.id || shot.episodeId}（${episodePlanObjectLabel}） → ${episode?.sceneIds.length || 0}场 → 正式制作分母 UNKNOWN · ${currentShotStructure}`
      : `${episodePlanRangeLabel(model)} → ${model.scenes.length}场正文范围 → 正式制作分母与镜头分母 UNKNOWN`;

  return <section className="creator-scope-stage-context">
    <header><div><small>{workPackage.stepId === 'W07' ? 'SCENE SCOPE' : workPackage.stepId === 'W08' ? 'EPISODE SCOPE' : 'PROJECT SCOPE'}</small><h3>{scopeTitle}</h3><p>{scopePosition}</p></div><span>{upstreamReleased}/{upstreamPackages.length || 0}项上游已放行</span></header>
    <div className="creator-scope-question-grid"><article><b>这一阶段解决什么</b><p>{visibleText(step.purpose)}</p></article><article><b>判断什么</b><p>{visibleText(step.reviewFocus)}</p></article><article><b>完成后产出</b><p>{visibleText(step.output)}</p></article><article><b>通过后解锁</b><p>{visibleText(step.unlock)}</p></article></div>
    {reviewContext && <ScopedReviewContextPanel context={reviewContext} evidenceCatalog={model.reviewContextCatalog?.evidenceCatalog ?? {}} />}
    {workPackage.stepId === 'W09' && <div className="creator-project-gates"><article><b>故事与案件</b><p>核对人物关系、死亡与割首顺序、九颗首级和尸身位置、物证链及审案结论。</p></article><article><b>版本与禁用</b><p>经审阅锁定的分集采用版本、字幕、分轨、哈希与归档必须齐套，任何禁用资产不得下传；{currentEpisodePlan ? `当前${model.episodes.length}集方案已采用，但尚未建立正式制作分母。` : `当前${model.episodes.length}段仅为导航提案。`}</p></article><article><b>成片门禁</b><p>实际文件的可播放性、音画同步、字幕、商业权利与法律放行须在交付前逐项核对。</p></article></div>}
    <details open className="creator-post-task-summary"><summary>本对象的输入、固定交付物与验收口径</summary><div><section><h4>输入</h4>{task?.inputs?.length ? <ol>{task.inputs.map((entry) => <li key={entry}><code>{visibleText(entry)}</code></li>)}</ol> : <p>当前没有已锁定输入文件；继续等待上游。</p>}</section><section><h4>计划交付物</h4>{task?.outputs?.length ? <ol>{task.outputs.map((entry) => <li key={entry}><code>{visibleText(entry)}</code></li>)}</ol> : <p>固定输出定义为UNKNOWN。</p>}</section></div>{task?.acceptance?.length ? <ul>{task.acceptance.map((entry) => <li key={entry}>{visibleText(entry)}</li>)}</ul> : <p>验收口径未登记。</p>}</details>
    {companionRefs.length > 0 && <p className="creator-multi-output-warning"><b>多输出尚未闭环：</b>当前工作项登记1个主输出与{companionRefs.length}个伴随计划交付物。伴随项尚未各自形成独立版本与审阅闭环，不能用主输出的一次放行冒充整包齐套。</p>}
  </section>;
}

function LifecycleSurface({ surface, item, version, currentAction, effectiveReview, task }: { surface: WorkbenchSurface; item: V7WorkItem; version: V7AssetVersion | null; currentAction: ReturnType<typeof deriveCurrentAction>; effectiveReview: ReviewEventRecord | null; task: PostProductionTask | null }) {
  const lifecycle = item.lifecycleState || version?.lifecycleState || 'WAITING_UPSTREAM';
  const blockReasons = item.flowBlockReasons || [];
  const companionCount = (item.additionalOutputAssetRefs || []).length;
  const revision = effectiveReview?.revisionInstructions;
  const surfaceLabel: Record<Exclude<WorkbenchSurface, 'REVIEW'>, string> = {
    PRE_OUTPUT: '制作准备与执行跟踪',
    REVIEW_BLOCKED: companionCount ? '已有主输出候选，但多输出闭环未拆分' : '已有候选，但正式审阅上下文未闭合',
    REVISION: '返修交接',
    RELEASED: '已放行结果',
    FORBIDDEN: '禁止使用／仅作审计',
  };
  if (surface === 'REVIEW') return null;
  return <section className={`creator-lifecycle-surface is-${surface.toLowerCase()}`}>
    <header><div><small>{surfaceLabel[surface]}</small><h3>{visibleText(currentAction.title)}</h3><p>{visibleText(currentAction.reason)}</p></div><DirectorState value={lifecycle} /></header>
    {surface === 'PRE_OUTPUT' && <div className="creator-lifecycle-facts"><article><b>当前事实</b><p>{directorStatus(lifecycle)}。固定输出路径或执行定义只说明“应当产出什么”，不代表文件已经生成。</p></article><article><b>安全下一步</b><p>{lifecycle === 'RESULT_UNKNOWN' ? '先按REQUEST_ID／LOG_ID或平台任务ID核查；任何执行者都不得盲目重试。' : lifecycle === 'IN_PROGRESS' ? '等待当前Run形成明确结果，再登记候选文件与SHA。' : lifecycle === 'RESULT_PENDING_REGISTRATION' ? '登记已经存在的候选文件、实际Prompt、输入版本与SHA。' : lifecycle === 'EXECUTION_FAILED' ? '核对失败原因；需要再次执行时创建新授权，不自动重试。' : '先关闭上游缺口；只有可开始状态才显示有效生成授权。'}</p></article></div>}
    {surface === 'REVIEW_BLOCKED' && <p className="v8-inline-error">{companionCount ? `主输出候选不等于整包可审。当前还有${companionCount}个伴随计划交付物没有独立版本与审阅闭环；页面只读，正式提交保持关闭。` : '候选文件不等于可提交审阅。当前缺少场／分集／全剧作用域的正式上下文哈希，或文件／SHA登记不完整；页面仅作只读查看，不会把任意锚点镜头冒充正式审阅范围。'}</p>}
    {surface === 'REVISION' && <div className="creator-revision-handoff"><p><b>被退版本</b>{publicRef(version?.id) || 'UNKNOWN'} · {version?.sha256 || '无SHA'}</p><p><b>审阅备注</b>{visibleText(effectiveReview?.note || '当前事件未登记总体备注')}</p><section><article><b>必须保留</b><ul>{revision?.preserve?.length ? revision.preserve.map((entry) => <li key={entry}>{visibleText(entry)}</li>) : <li>UNKNOWN</li>}</ul></article><article><b>必须修改</b><ul>{revision?.change?.length ? revision.change.map((entry) => <li key={entry}>{visibleText(entry)}</li>) : <li>UNKNOWN</li>}</ul></article><article><b>禁止退化</b><ul>{revision?.mustNotRegress?.length ? revision.mustNotRegress.map((entry) => <li key={entry}>{visibleText(entry)}</li>) : <li>UNKNOWN</li>}</ul></article></section></div>}
    {surface === 'RELEASED' && <div className="creator-released-result"><p><b>采用版本</b>{publicRef(version?.id) || 'UNKNOWN'} · {version?.sha256 || '无SHA'}</p><p><b>有效结论</b>{visibleText(effectiveReview?.note || '已通过并放行；完整判断见不可变审阅历史。')}</p><p><b>下游资格</b>{item.canFlowDownstream === true ? '允许按直接依赖关系继续推进。' : '当前仍有独立门禁，不能据放行状态推断商业或法律可用。'}</p></div>}
    {surface === 'FORBIDDEN' && <div className="creator-forbidden-result"><p><b>当前版本不得使用</b>{visibleText(effectiveReview?.note || blockReasons.join('；') || '该版本只保留审计，不得进入任何制作下游。')}</p><p><b>影响</b>引用该版本的工作项必须停止或改绑其他已放行版本；禁止原位覆盖来抹去历史。</p></div>}
    {blockReasons.length > 0 && <details><summary>查看{blockReasons.length}项门禁原因</summary><ul>{blockReasons.map((entry) => <li key={entry}>{visibleText(entry)}</li>)}</ul></details>}
    {task && <p className="creator-task-linkage">当前对象已关联后期任务定义；完整输入、输出与验收口径见左侧创作／阶段信息和下方制作配方。</p>}
  </section>;
}

function WorkPackageDetail({ model, shot, workPackage, context, operations, onNavigate, onOpenMaterial, onOpenReviewOverview }: { model: ProductionModel; shot: V7Shot; workPackage: V7WorkPackage; context: ProductionContext; operations: ReviewOperationState; onNavigate: ProductionNavigate; onOpenMaterial?: (requirementId: string) => void; onOpenReviewOverview?: () => void }) {
  const step = model.workflowSteps.find((item) => item.id === workPackage.stepId) || model.workflowSteps[0];
  const items = packageItems(model, workPackage);
  const familyBoundItem = context.familyId ? items.find((item) => item.outputAssetRef === context.familyId || item.inputAssetRefs.includes(context.familyId as string) || (item.additionalOutputAssetRefs || []).includes(context.familyId as string)) : null;
  const selectedItem = items.find((item) => item.id === context.workItemId) || familyBoundItem || items.find((item) => item.pipelineStageCode === 'P07') || items[0] || null;
  const outputFamily = selectedItem && selectedItem.outputAssetRef ? model.assetFamilies.find((family) => family.id === selectedItem.outputAssetRef) || null : null;
  const inputFamilies = selectedItem ? selectedItem.inputAssetRefs.map((id) => model.assetFamilies.find((family) => family.id === id)).filter((family): family is V7AssetFamily => Boolean(family)) : [];
  const companionFamilies = selectedItem ? (selectedItem.additionalOutputAssetRefs || []).map((id) => model.assetFamilies.find((family) => family.id === id)).filter((family): family is V7AssetFamily => Boolean(family)) : [];
  const shotMaterialRequirements = (shot.materialRequirementRefs || [])
    .map((id) => (model.materialRequirements || []).find((requirement) => requirement.id === id) || null)
    .filter((requirement): requirement is MaterialRequirement => Boolean(requirement));
  const inputFamilyIds = new Set(inputFamilies.map((family) => family.id));
  const inputListedRequirementIds = new Set(shotMaterialRequirements
    .filter((requirement) => requirement.assetFamilyRefs.some((familyId) => inputFamilyIds.has(familyId)))
    .map((requirement) => requirement.id));
  const allowedFamilies = (outputFamily ? [outputFamily] : []).concat(inputFamilies, companionFamilies);
  const selectedFamily = context.familyId ? allowedFamilies.find((family) => family.id === context.familyId) || null : null;
  // A work item owns one formal decision target: the current output version.
  // Choosing another version in the inspector is comparison only and must not
  // silently rebind the immutable ReviewEvent target.
  const decisionVersion = currentVersion(model, outputFamily);
  const lineageParentVersion = registrationParentVersion(model, outputFamily);
  const selectedVersion = selectedFamily
    ? model.assetVersions.find((version) => version.familyId === selectedFamily.id && version.id === context.versionId) || currentVersion(model, selectedFamily)
    : null;
  const comparisonVersion = selectedVersion && selectedVersion.id !== decisionVersion?.id ? selectedVersion : null;
  const comparisonFamily = comparisonVersion ? selectedFamily : null;
  const p07 = items.filter((item) => item.pipelineStageCode === 'P07');
  const p08 = items.filter((item) => item.pipelineStageCode === 'P08');
  const reviewContext = workProductReviewContext(model, selectedItem, workPackage);
  const criteria = selectedItem ? (selectedItem.reviewSpec?.criteria || criteriaForReviewScope(selectedItem, shot.reviewContext, reviewContext)) : [];
  const projectedSelectedItem = selectedItem ? withReviewProjection(withOperationalProjection(selectedItem, operations.workItemProjection), operations.effective) : null;
  const activeItem = projectedSelectedItem || selectedItem;
  const companionLifecycleReady = (selectedItem?.additionalOutputAssetRefs || []).length === 0;
  const formalReviewSupported = Boolean(reviewContext?.reviewable && reviewContext.semanticStatus !== 'UNKNOWN_STALE_BINDING' && companionLifecycleReady);
  const surface = activeItem ? resolveWorkbenchSurface(activeItem, decisionVersion, formalReviewSupported) : 'PRE_OUTPUT';
  const postTask = postTaskForItem(model, selectedItem);

  const { recipe, error: recipeError } = useExecutionRecipe(selectedItem?.executionDefinitionRef);
  const { url: originalMediaUrl, error: originalMediaError } = useOriginalMediaUrl(decisionVersion);
  const { url: comparisonMediaUrl, error: comparisonMediaError } = useOriginalMediaUrl(comparisonVersion);
  const [hiddenComparisonId, setHiddenComparisonId] = useState<string | null>(null);
  const showComparison = Boolean(comparisonVersion && hiddenComparisonId !== comparisonVersion.id);
  const [verifiedMediaKey, setVerifiedMediaKey] = useState<string | null>(null);
  const [failedMediaKey, setFailedMediaKey] = useState<string | null>(null);
  const mediaKey = decisionVersion ? decisionVersion.id + ':' + (decisionVersion.sha256 || 'NO_SHA') : null;
  const mediaVerified = Boolean(mediaKey && verifiedMediaKey === mediaKey);
  const mediaError = originalMediaError || (mediaKey && failedMediaKey === mediaKey ? '原件请求未通过媒体完整性检查或浏览器无法解码；正式提交保持禁用。' : '');
  const snapshotId = operations.snapshotId || model.snapshotManifest?.snapshotId || model.executionRecipeSummary?.snapshotId || '';
  const currentAction = projectedSelectedItem ? deriveCurrentAction({
    ...model,
    workItems: model.workItems.map((item) => item.id === projectedSelectedItem.id ? projectedSelectedItem : item),
  }, context, operations.effective) : deriveCurrentAction(model, context, operations.effective);
  const baseAuthorizationGate = selectedItem
    ? executionAuthorizationGate(selectedItem, outputFamily, recipe, operations)
    : { canAuthorize: false, reason: '当前没有可授权的工作项。' };
  const authorizationGate = selectedItem && (selectedItem.additionalOutputAssetRefs || []).length > 0
    ? { canAuthorize: false, reason: '该任务包含尚未拆成独立版本与审阅闭环的伴随交付物；当前不能把主输出授权冒充整包授权。' }
    : baseAuthorizationGate;

  useEffect(() => {
    const toggle = () => {
      if (!comparisonVersion) return;
      setHiddenComparisonId((value) => value === comparisonVersion.id ? null : comparisonVersion.id);
    };
    window.addEventListener('review:toggle-comparison', toggle);
    return () => window.removeEventListener('review:toggle-comparison', toggle);
  }, [comparisonVersion]);

  function selectItem(item: V7WorkItem) { onNavigate({ shotId: shot.id, workPackageId: workPackage.id, workItemId: item.id }); }
  function selectFamily(id: string) { onNavigate({ shotId: shot.id, workPackageId: workPackage.id, workItemId: selectedItem?.id || null, familyId: id }); }

  return <section className="v7-package-detail creator-package-detail">
      <header><div><small>{workflowDisplay(step.order)}</small><h3>{visibleText(step.label)}</h3><p>{scopeLabel(workPackage, items.length) + ' · ' + visibleText(workPackage.label)}</p></div><DirectorState value={workPackage.applicabilityState === 'SATISFIED_BY_EXISTING' ? 'SATISFIED_BY_EXISTING' : activeItem?.lifecycleState || workPackage.lifecycleState || 'UNKNOWN'} /></header>
      {workPackage.applicabilityState === 'SATISFIED_BY_EXISTING' ? <div className="v7-not-applicable v8-package-satisfied"><b>本步骤已由校准时期的既有地点状态资产满足</b><p>无需补造没有真实执行内容的兼容任务；从粗分镜开始审阅本镜。</p></div> : workPackage.applicabilityState === 'NOT_REQUIRED' ? <div className="v7-not-applicable v8-package-not-required"><b>本镜无需口型步骤</b><p>无对白或非口型分支在动态镜头通过后即可锁镜；这不是缺失，也不计入完成率。</p></div> : workPackage.stepId === 'W02' ? <div className="v7-parallel-work"><header><b>选择实际审阅对象</b><span>粗分镜与本镜适用对白并行，完成后共同汇入全场Animatic锁时</span></header><div><section><h4>画面支线 <small>粗分镜</small></h4>{p07.map((item) => <WorkItemButton key={item.id} item={item} selected={selectedItem && selectedItem.id === item.id} onSelect={selectItem} />)}</section>{p08.length > 0 && <i>∥</i>}{p08.length > 0 && <section><h4>声音支线 <small>对白干声</small></h4>{p08.map((item) => <WorkItemButton key={item.id} item={item} selected={selectedItem && selectedItem.id === item.id} onSelect={selectItem} />)}</section>}</div>{p08.length === 0 && <p className="v6-empty-note">本镜无台词，不制造空白对白任务。</p>}</div> : <div className={'v7-work-item-list ' + (workPackage.stepId === 'W04' ? 'is-dual-output' : '')}>{items.map((item) => <WorkItemButton key={item.id} item={item} selected={selectedItem && selectedItem.id === item.id} onSelect={selectItem} />)}</div>}
      {workPackage.applicabilityState === 'REQUIRED' && selectedItem && <>
        <ScopeStageContext model={model} shot={shot} workPackage={workPackage} item={activeItem || selectedItem} task={postTask} reviewContext={reviewContext} />
        {shotMaterialRequirements.length > 0 && <section className="creator-shot-material-demands" aria-label="本镜素材需求与输入冻结状态"><header><div><small>SHOT MATERIAL REQUIREMENTS</small><h3>本镜待冻结素材需求</h3><p>ShotSpec 只声明需要哪些素材；只有下方输入资产显示精确采用版本与 SHA 时，才算完成输入冻结。</p></div><span>{inputListedRequirementIds.size} 已列入输入 · {shotMaterialRequirements.length - inputListedRequirementIds.size} 待冻结</span></header><div>{shotMaterialRequirements.map((requirement) => {
          const card = requirement.cardSpec?.role === 'INSTANCE' ? requirement.cardSpec : null;
          const listed = inputListedRequirementIds.has(requirement.id);
          const content = <><span>{card ? (card.triggerKind === 'FIRST_CLEAR_APPEARANCE' ? '人物信息卡 · 首次出场' : '人物信息卡 · 场内背景补充') : visibleText(requirement.category)}</span><b>{card ? `${visibleText(card.displayName)}／${visibleText(card.contextLine)}` : visibleText(requirement.title)}</b><small>{listed ? '已列入输入资产清单；继续核对版本与SHA' : '尚未绑定采用资产；保持待冻结'}</small></>;
          return onOpenMaterial
            ? <button type="button" key={requirement.id} className={listed ? 'is-listed' : ''} onClick={() => onOpenMaterial(requirement.id)}>{content}</button>
            : <article key={requirement.id} className={listed ? 'is-listed' : ''}>{content}</article>;
        })}</div></section>}
        {surface === 'REVIEW' ? <div className="creator-focus-review">
          <section className="creator-focus-media-pane"><ReviewTargetPanel shot={shot} reviewContext={reviewContext} item={activeItem || selectedItem} family={outputFamily} version={decisionVersion} inspectedFamily={selectedFamily} recipe={recipe} recipeError={recipeError} originalMediaUrl={originalMediaUrl} originalMediaError={mediaError} comparisonFamily={comparisonFamily} comparisonVersion={comparisonVersion} comparisonMediaUrl={comparisonMediaUrl} comparisonMediaError={comparisonMediaError} showComparison={showComparison} onToggleComparison={() => { if (comparisonVersion) setHiddenComparisonId((value) => value === comparisonVersion.id ? null : comparisonVersion.id); }} effectiveReview={operations.effective} onMediaReady={() => { setVerifiedMediaKey(mediaKey); setFailedMediaKey(null); }} onMediaError={() => { setVerifiedMediaKey(null); setFailedMediaKey(mediaKey); }} /></section>
          <aside className="creator-focus-decision-pane"><section className={'v6-next-action v8-current-action tone-' + statusTone(currentAction.kind)}><small>CURRENT ACTION · {currentAction.kind}</small><h3>{visibleText(currentAction.title)}</h3><p>{visibleText(currentAction.reason)}</p></section>{reviewContext && <ReviewDraft key={`${(activeItem || selectedItem).id}:${decisionVersion?.id || 'NO_VERSION'}:${reviewContext.contextHash}`} model={model} shot={shot} workPackage={workPackage} item={activeItem || selectedItem} version={decisionVersion} reviewContext={reviewContext} mediaVerified={mediaVerified} operations={operations} criteria={criteria} onNavigate={onNavigate} onOpenReviewOverview={onOpenReviewOverview} />}</aside>
        </div> : <LifecycleSurface surface={surface} item={activeItem || selectedItem} version={decisionVersion} currentAction={currentAction} effectiveReview={operations.effective} task={postTask} />}
        {surface !== 'REVIEW' && decisionVersion?.outputState === 'PRESENT' && <details className="creator-readonly-output"><summary>查看当前原件与版本证据（只读）</summary><ReviewTargetPanel shot={shot} reviewContext={reviewContext} item={activeItem || selectedItem} family={outputFamily} version={decisionVersion} inspectedFamily={selectedFamily} recipe={recipe} recipeError={recipeError} originalMediaUrl={originalMediaUrl} originalMediaError={mediaError} comparisonFamily={comparisonFamily} comparisonVersion={comparisonVersion} comparisonMediaUrl={comparisonMediaUrl} comparisonMediaError={comparisonMediaError} showComparison={showComparison} onToggleComparison={() => { if (comparisonVersion) setHiddenComparisonId((value) => value === comparisonVersion.id ? null : comparisonVersion.id); }} effectiveReview={operations.effective} onMediaReady={() => { setVerifiedMediaKey(mediaKey); setFailedMediaKey(null); }} onMediaError={() => { setVerifiedMediaKey(null); setFailedMediaKey(mediaKey); }} /></details>}
        <section className="creator-info-layers" aria-label="制作与审计信息分层">
          <details open={surface !== 'REVIEW' && surface !== 'RELEASED' && surface !== 'FORBIDDEN'}><summary><b>制作信息</b><span>依赖、版本、完整调用包、授权与结果登记</span></summary>
            <section className="v6-required-assets"><header><div><small>OUTPUT + INPUT + COMPANION PLAN</small><h3>{workItemLabel(selectedItem) + '的输出与依赖'}</h3><p>{surface === 'REVIEW' ? '选择依赖或历史版本只建立B侧比较；正式裁决始终绑定主输出当前版本。' : '主输出、输入依赖和伴随计划交付物分开显示；没有文件与SHA时不进入正式审阅。输入素材可回到“素材管理”的统一素材信息卡。'}</p></div><span>{allowedFamilies.length}</span></header>{allowedFamilies.length ? <div>{outputFamily && <AssetMiniCard model={model} family={outputFamily} selected={selectedFamily?.id === outputFamily.id} role="主输出" onSelect={selectFamily} />}{inputFamilies.map((family) => <AssetMiniCard key={family.id} model={model} family={family} selected={selectedFamily?.id === family.id} role="输入依赖" onSelect={selectFamily} onOpenMaterial={onOpenMaterial} />)}{companionFamilies.map((family) => <AssetMiniCard key={family.id} model={model} family={family} selected={selectedFamily?.id === family.id} role="伴随计划交付物（未闭环）" onSelect={selectFamily} />)}</div> : <p className="v6-empty-note">本工作项没有独立资产记录。</p>}</section>
            <div className="creator-production-evidence"><VersionPanel model={model} family={selectedFamily || outputFamily} selectedVersionId={context.versionId} heading={selectedFamily && selectedFamily.id !== outputFamily?.id ? '依赖／伴随项版本（只读证据）' : '主输出版本与历史'} onSelectVersion={(versionId) => onNavigate({ ...context, shotId: shot.id, familyId: (selectedFamily || outputFamily)?.id || null, versionId })} /><RecipePanel authorWorkItemId={selectedItem.id.startsWith('SP-WI-')&&selectedItem.activeInCurrentProduction===true&&['STORYBOARD','DIALOGUE_DRY','START_FRAME','END_FRAME','INTERMEDIATE_FRAME','SHOT_VIDEO'].includes(selectedItem.deliverableKey||'')?selectedItem.id:undefined} definitionRef={selectedItem.executionDefinitionRef} recipe={recipe} error={recipeError} defaultOpen={surface === 'PRE_OUTPUT' || surface === 'REVISION' || surface === 'REVIEW_BLOCKED'} executionContext={surface === 'PRE_OUTPUT' || surface === 'REVISION' ? { snapshotId, expectedOutput: (model.expectedOutputs || []).find(output => output.id === (outputFamily?.nextExpectedOutputId || outputFamily?.currentExpectedOutputId) && output.familyId === outputFamily?.id) || null, configurationBinding:selectedItem.configurationBinding, mutationEtag: operations.mutationEtag, shotId: shot.id, workPackageId: workPackage.id, workItemId: selectedItem.id, familyId: outputFamily?.id || null, parentVersionId: lineageParentVersion?.id || null, canAuthorize: authorizationGate.canAuthorize, authorizeReason: authorizationGate.reason } : undefined} /></div>
          </details>
          <details open={surface === 'RELEASED' || surface === 'FORBIDDEN'}><summary><b>审计信息</b><span>生命周期、技术坐标、SHA与解锁条件</span></summary><div className="v7-outcome-grid"><article><span>解决什么问题</span><p>{visibleText(step.purpose)}</p></article><article><span>重点审阅什么</span><p>{visibleText(step.reviewFocus)}</p></article><article><span>产出什么</span><p>{visibleText(step.output)}</p></article><article><span>通过后解锁</span><p>{visibleText(step.unlock)}</p></article></div><UnifiedStatusPanel record={{ ...(activeItem || withReviewProjection(selectedItem, operations.effective)), applicabilityState: workPackage.applicabilityState }} /><div className="v6-stage-evidence"><p><b>当前对象</b><code>{publicRef(selectedItem.id)}<br />{stageDisplay(selectedItem.pipelineStageCode)}</code></p><p><b>执行配方／来源定位</b>{publicRef(selectedItem.executionDefinitionRef) || '不适用'}<br />{visibleText(selectedItem.sourceRef)}</p></div></details>
        </section>
      </>}
    </section>;
}

/** The process-material catalogue opens the same work-product information card.
 * Selection is validated before mounting; it never creates a second review or
 * adoption target and a navigation anchor never changes the package scope. */
export function ProductionWorkItemInformationCard({model,workItemId,familyId,versionId,onNavigate,onOpenMaterial}:{
  model:ProductionModel;workItemId:string;familyId:string;versionId?:string|null;onNavigate:ProductionNavigate;onOpenMaterial?:(requirementId:string)=>void;
}) {
  const item=model.workItems.find(row=>row.id===workItemId);
  const packages=model.workPackages.filter(row=>row.workItemRefs.includes(workItemId));
  const workPackage=packages.length===1?packages[0]:null;
  const family=model.assetFamilies.find(row=>row.id===familyId);
  const bound=Boolean(item&&[item.outputAssetRef,...item.inputAssetRefs,...(item.additionalOutputAssetRefs||[])].includes(familyId));
  const validVersion=!versionId||Boolean(family&&(family.versionRefs.includes(versionId)&&model.assetVersions.some(row=>row.id===versionId&&row.familyId===familyId)||(family.expectedOutputRefs||[]).includes(versionId)&&(model.expectedOutputs||[]).some(row=>row.id===versionId&&row.familyId===familyId)));
  const shot=workPackage?model.shots.find(row=>row.id===(workPackage.scopeType==='SHOT'?workPackage.scopeId:item?.shotId)&&workPackage.shotIds.includes(row.id))||model.shots.find(row=>workPackage.shotIds.includes(row.id)):null;
  const reviewContext=item&&workPackage?workProductReviewContext(model,item,workPackage):null;
  const outputFamily=item?model.assetFamilies.find(row=>row.id===item.outputAssetRef):null;
  const decisionVersion=currentVersion(model,outputFamily);
  const operations=useReviewOperations(item&&bound&&validVersion?item.id:null,decisionVersion?.id||null,reviewContext?.contextHash||null);
  if(!item||!workPackage||!shot||!family||!bound||!validVersion||!model.workflowSteps.some(step=>step.id===workPackage.stepId))return <section role="alert" className="material-info-card">制作素材的工作项、范围或版本绑定无法精确核验，已停止默认回退。请重新读取目录。</section>;
  const context:ProductionContext={shotId:shot.id,workPackageId:workPackage.id,workItemId:item.id,familyId:family.id,versionId:versionId||family.currentVersionId||family.currentExpectedOutputId||null,phaseId:item.phaseId,gateId:item.gateId};
  return <article className="material-info-card production-material-info-card" data-family-id={family.id} data-work-item-id={item.id}>
    <WorkPackageDetail model={model} shot={shot} workPackage={workPackage} context={context} operations={operations} onNavigate={onNavigate} onOpenMaterial={onOpenMaterial}/>
  </article>;
}

function CalibrationJourneyBar({ model, shot, projection, onNavigate }: { model: ProductionModel; shot: V7Shot; projection?: OperationalStateProjection | null; onNavigate: ProductionNavigate }) {
  const queue = storyboardReviewQueue(model);
  const currentIndex = queue.findIndex((record) => record.id === shot.id);
  if (currentIndex < 0) return null;
  const targets = queue.map((record) => ({ shot: record, ...storyboardReviewTarget(model, record) }));
  const isResolved = (target: ReturnType<typeof storyboardReviewTarget>) => {
    return ['RELEASED', 'REVISION_REQUIRED', 'DO_NOT_USE'].includes(storyboardLifecycle(target, projection));
  };
  const completed = targets.filter((target) => isResolved(target)).length;
  const submittable = targets.filter((target) => storyboardLifecycle(target, projection) === 'REVIEW_PENDING' && storyboardActionability(target, projection) === 'ACTIONABLE').length;
  const waitingDependency = targets.filter((target) => storyboardLifecycle(target, projection) === 'REVIEW_PENDING' && storyboardActionability(target, projection) === 'WAITING_DEPENDENCY').length;
  const sceneCount = new Set(queue.map((record) => record.sceneId)).size;
  const previous = targets[currentIndex - 1] || null;
  const next = targets[currentIndex + 1] || null;
  const nextSubmittableShot = nextSubmittableStoryboard(model, shot.id, projection);
  const nextSubmittable = nextSubmittableShot ? targets.find((target) => target.shot.id === nextSubmittableShot.id) || null : null;
  const navigateTarget = (target: typeof targets[number]) => {
    if (!target.workPackage || !target.item) return;
    onNavigate({ shotId: target.shot.id, workPackageId: target.workPackage.id, workItemId: target.item.id, familyId: target.family?.id || null, versionId: target.version?.id || null });
  };
  return <nav className="review-shot-nav" aria-label="粗分镜审阅进度">
    <button disabled={!previous} onClick={() => previous && navigateTarget(previous)}>← 上一镜</button>
    <div aria-live="polite"><small>{`${sceneCount}场当前粗分镜队列`}</small><b>{`第 ${currentIndex + 1} / ${queue.length} 镜 · ${shot.id}`}</b><span>{`已裁决 ${completed}/${queue.length} · 现在可提交 ${submittable} · 等待依赖 ${waitingDependency}`}</span></div>
    <button disabled={!next} onClick={() => next && navigateTarget(next)}>浏览下一镜 →</button>
    <button className="review-next-pending review-next-submittable" disabled={!nextSubmittable} onClick={() => nextSubmittable && navigateTarget(nextSubmittable)}>{nextSubmittable ? `下一可提交 · ${nextSubmittable.shot.id}` : '没有其他可提交镜头'}</button>
  </nav>;
}

function ProductionScopeNavigator({ model, shot, workPackage, onNavigate }: { model: ProductionModel; shot: V7Shot; workPackage: V7WorkPackage; onNavigate: ProductionNavigate }) {
  if (!['W07', 'W08', 'W09'].includes(workPackage.stepId)) return <CreatorShotStrip model={model} shot={shot} onNavigate={onNavigate} />;

  const navigateWithinStep = (nextShot: V7Shot) => {
    const nextPackage = nextShot.workPackageRefs
      .map((id) => model.workPackages.find((record) => record.id === id))
      .find((record) => record?.stepId === workPackage.stepId);
    if (nextPackage) onNavigate({ shotId: nextShot.id, workPackageId: nextPackage.id });
  };

  if (workPackage.stepId === 'W07') {
    const sceneShots = workPackage.shotIds.map((id) => model.shots.find((record) => record.id === id)).filter((record): record is V7Shot => Boolean(record));
    return <nav className="creator-scope-navigator" aria-label={`${workPackage.scopeId}场声音后期范围`}><header><small>场级范围</small><h3>{workPackage.scopeId} · {sceneShots.length}镜</h3><p>这里按整场工作，不把某一镜当成正式审阅范围；镜头仅用于检查锁镜输入。</p></header><div>{sceneShots.map((record) => { const upstream = record.workPackageRefs.map((id) => model.workPackages.find((entry) => entry.id === id)).find((entry) => entry?.stepId === 'W06'); return <button key={record.id} className={record.id === shot.id ? 'active' : ''} onClick={() => navigateWithinStep(record)}><b>{record.id}</b><span>{visibleText(record.title)}</span><small>{upstream ? directorStatus(upstream.lifecycleState) : '锁镜工作包未登记'}</small></button>; })}</div></nav>;
  }

  if (workPackage.stepId === 'W08') {
    const episode = episodeForScope(model, workPackage.scopeId);
    const scenes = episode ? episode.sceneIds.map((id) => model.scenes.find((record) => record.id === id)).filter((record): record is ProductionModel['scenes'][number] => Boolean(record)) : [];
    const displayId = episode?.displayId || episode?.id || 'UNKNOWN';
    return <nav className="creator-scope-navigator" aria-label={`${displayId}分集成片范围`}><header><small>分集范围</small><h3>{displayId} · {scenes.length}场</h3><p>逐场检查声音后期与场间承接；分集裁决不能绑定任意一镜替代。</p></header><div>{scenes.map((record) => { const firstShot = model.shots.find((entry) => entry.sceneId === record.id); const upstream = model.workPackages.find((entry) => entry.stepId === 'W07' && entry.scopeId === record.id); return <button key={record.id} disabled={!firstShot} className={record.id === shot.sceneId ? 'active' : ''} onClick={() => firstShot && navigateWithinStep(firstShot)}><b>{record.id}</b><span>{visibleText(record.title)}</span><small>{upstream ? directorStatus(upstream.lifecycleState) : '尚无场级制作包'}</small></button>; })}</div></nav>;
  }

  return <nav className="creator-scope-navigator" aria-label="全剧终审范围"><header><small>全剧范围</small><h3>{episodePlanRangeLabel(model)} · 全剧终审</h3><p>{episodePlanIsCurrent(model) ? '当前分集方案已采用，但仍须等待正式剧本发布快照、场成片齐套与ScopeLock建立制作分母。' : `当前${proposalEpisodeRange(model)}只用于定位准备缺口；分集方案获批并同步后再检查齐套与承接。`}平台、发行和权利UNKNOWN继续阻断对外交付。</p></header><div>{model.episodes.map((record) => { const firstShot = model.shots.find((entry) => entry.episodeId === record.id); const upstream = model.workPackages.find((entry) => entry.stepId === 'W08' && entry.scopeId === episodeCanonicalScopeId(record)); return <button key={record.episodeUid || record.id} disabled={!firstShot} className={record.id === shot.episodeId ? 'active' : ''} onClick={() => firstShot && navigateWithinStep(firstShot)}><b>{record.displayId || record.id}</b><span>{record.sceneIds.length}场 · 正式镜数UNKNOWN</span><small>{upstream ? directorStatus(upstream.lifecycleState) : '分集成片包未登记'}</small></button>; })}</div></nav>;
}

function workbenchHeading(model: ProductionModel, shot: V7Shot, workPackage: V7WorkPackage, item: V7WorkItem | null) {
  const scene = model.scenes.find((record) => record.id === (workPackage.sceneId || shot.sceneId));
  const episode = model.episodes.find((record) => record.id === (workPackage.episodeId || shot.episodeId));
  const currentShotIds = fullProductionCurrentShotIds(model);
  const currentScopeShotCount = workPackage.shotIds.filter((id) => currentShotIds.has(id)).length;
  const currentScopeLabel = currentScopeShotCount > 0 ? `${currentScopeShotCount}个当前镜头` : '当前镜头结构 UNKNOWN';
  if (workPackage.scopeType === 'CONTINUITY_GROUP') {
    const group = model.continuityGroups.find((record) => record.id === workPackage.scopeId);
    return {
      path: `${workPackage.episodeId} → ${workPackage.sceneId || group?.sceneId || '场次UNKNOWN'} → 连续性／地点组`,
      title: group ? visibleText(group.label) : visibleText(workPackage.label),
      description: '统一这一组镜头共用的地点身份、宏观状态、空间坐标与冻结点；镜头只表示受影响范围。',
      meta: [['范围', '连续性／地点组'], ['地点', group?.locs.join(' · ') || 'UNKNOWN'], ['冻结点', `${visibleText(group?.freezeFrom || 'UNKNOWN')} → ${visibleText(group?.freezeTo || 'UNKNOWN')}`]],
    };
  }
  if (workPackage.scopeType === 'SCENE') return {
    path: `${episode?.id || shot.episodeId} → ${scene?.id || shot.sceneId} → 整场`,
    title: `${scene?.id || shot.sceneId} · ${visibleText(scene?.title || (workPackage.stepId === 'W03' ? 'Animatic锁时' : '场声音后期'))}`,
    description: workPackage.stepId === 'W03'
      ? '把本场粗分镜与对白放进同一时间线，判断节拍、镜头时长和场间承接；当前镜头结构未建立时只显示准备缺口。'
      : '以本场锁定画面为共同时间线，组织对白、环境、拟音和原创配乐；历史镜头关系不构成当前完成分母。',
    meta: [['范围', currentScopeLabel], ['交付物', `1个主输出 + ${(item?.additionalOutputAssetRefs || []).length}个伴随计划项`], [workPackage.stepId === 'W03' ? '锁定时长' : '发行规格', 'UNKNOWN']],
  };
  if (workPackage.scopeType === 'EPISODE') return {
    path: `${episode?.id || workPackage.scopeId} → 分集成片`,
    title: `${episode?.displayId || episode?.id || workPackage.scopeId} · 分集成片（${episodePlanIsCurrent(model) ? '当前分集方案' : '导航提案'}）`,
    description: episodePlanIsCurrent(model)
      ? `当前分集方案已采用；本集覆盖${episode?.sceneIds.length || 0}场，但正式制作分母、剧本发布快照与镜头结构仍为UNKNOWN。场与历史镜头只说明准备缺口，不冒充集级成片已建立。`
      : `${proposalEpisodeRange(model)}当前只用于组织审阅导航；本提案覆盖${episode?.sceneIds.length || 0}场，但正式制作分母与镜头结构仍为UNKNOWN。场与历史镜头只说明准备缺口，不是集级裁决身份。`,
    meta: [[episodePlanIsCurrent(model) ? '方案范围' : '提案范围', `${episode?.sceneIds.length || 0}场 · ${currentScopeLabel}`], ['交付物', `1个主输出 + ${(item?.additionalOutputAssetRefs || []).length}个伴随计划项`], ['正式制作分母', 'UNKNOWN']],
  };
  if (workPackage.scopeType === 'PROJECT') return {
    path: `本剧 → ${episodePlanRangeLabel(model)} → 全剧终审`,
    title: '本剧全剧终审与归档（输入未建立）',
    description: episodePlanIsCurrent(model)
      ? `汇总获批分集、案件连续性、版本血缘、权利、敏感内容与技术QA；当前${model.episodes.length}集方案已采用，但正式制作输入分母仍为UNKNOWN，不能据此推断分集成片或发行规格已经锁定。`
      : `汇总获批分集、案件连续性、版本血缘、权利、敏感内容与技术QA；${proposalEpisodeRange(model)}仅为导航提案，正式制作输入分母仍为UNKNOWN，不能据此推断${model.episodes.length}集规格已经锁定。`,
    meta: [['范围', `${model.scenes.length}场正文范围 · 正式分集分母UNKNOWN`], ['交付物', `1个主清单 + ${(item?.additionalOutputAssetRefs || []).length}个伴随计划项`], ['发行状态', 'BLOCKED · UNKNOWN未闭合']],
  };
  return {
    path: [shot.episodeId, shot.sceneId, shot.id].join(' → '),
    title: `${shot.id} · ${visibleText(shot.title)}`,
    description: visibleText(shot.sourceContent || '本镜为无对白建立镜头；具体动作以镜头卡为准。'),
    meta: [['时长', `${shot.durationSeconds}秒 · ${directorStatus(shot.durationStatus)}`], ['视频分支', visibleText(shot.branch)], ['空间', visibleText([...shot.locs, ...shot.zones, ...shot.cameras].join(' · ') || 'UNKNOWN')]],
  };
}

type FullProductionWorkbenchProps = {
  model: ProductionModel;
  context: ProductionContext;
  onNavigate: ProductionNavigate;
  onOpenMaterial: (requirementId: string) => void;
  onOpenReviewOverview?: () => void;
  dataWindow?: {
    loaded: number;
    total: number | null;
    hasMore: boolean;
    loading: boolean;
    error: string;
    onLoadMore: () => void;
    onRetry: () => void;
  };
};

function anchorShotForPackage(model: ProductionModel, workPackage: V7WorkPackage, preferredShotId?: string | null) {
  const preferred = preferredShotId && workPackage.shotIds.includes(preferredShotId)
    ? model.shots.find((record) => record.id === preferredShotId) || null
    : null;
  return preferred
    || workPackage.shotIds.map((id) => model.shots.find((record) => record.id === id) || null).find((record): record is V7Shot => Boolean(record))
    || model.shots[0]
    || null;
}

function nativeScopeTitle(model: ProductionModel, workPackage: V7WorkPackage) {
  if (workPackage.scopeType === 'CONTINUITY_GROUP') {
    const group = model.continuityGroups.find((record) => record.id === workPackage.scopeId);
    return group
      ? `${group.segmentId} · ${visibleText(group.label)}`
      : `${workPackage.scopeId} · ${visibleText(workPackage.label)}`;
  }
  if (workPackage.scopeType === 'SCENE') {
    const scene = model.scenes.find((record) => record.id === workPackage.scopeId);
    return `${workPackage.scopeId} · ${visibleText(scene?.title || workPackage.label)}`;
  }
  if (workPackage.scopeType === 'EPISODE') {
    const episode = episodeForScope(model, workPackage.scopeId);
    return `${episode?.displayId || episode?.id || workPackage.scopeId} · ${episodePlanIsCurrent(model) ? '当前分集方案' : '分集导航提案'}`;
  }
  if (workPackage.scopeType === 'PROJECT') return '本剧全剧终审';
  const shot = model.shots.find((record) => record.id === workPackage.scopeId || workPackage.shotIds.includes(record.id));
  return shot ? `${shot.id} · ${visibleText(shot.title)}` : visibleText(workPackage.label);
}

function nativeScopeMeta(model: ProductionModel, workPackage: V7WorkPackage) {
  if (workPackage.scopeType === 'CONTINUITY_GROUP') {
    const group = model.continuityGroups.find((record) => record.id === workPackage.scopeId);
    return [
      group?.sceneId || workPackage.sceneId || '场次UNKNOWN',
      ...(group?.locs || ['地点UNKNOWN']),
      ...(group?.zones || []),
      ...(group?.cameras || []),
    ].join(' · ');
  }
  if (workPackage.scopeType === 'SCENE') return `${workPackage.episodeId} · 场级对象`;
  if (workPackage.scopeType === 'EPISODE') {
    const episode = episodeForScope(model, workPackage.scopeId);
    return `${episode?.sceneIds.length || 0}场导航 · 正式分集分母 UNKNOWN`;
  }
  if (workPackage.scopeType === 'PROJECT') return `${episodePlanRangeLabel(model)} · ${model.scenes.length}场正文范围 · 项目级对象`;
  const shot = model.shots.find((record) => record.id === workPackage.scopeId || workPackage.shotIds.includes(record.id));
  return `${shot?.sceneId || workPackage.sceneId || '场次UNKNOWN'} · 镜头级对象`;
}

function productionPhases(model: ProductionModel) {
  return (model.productionPhases || []).slice().sort((a, b) => a.order - b.order);
}

function productionGates(model: ProductionModel) {
  return (model.productionGates || []).slice().sort((a, b) => a.order - b.order);
}

function phaseForStep(stepId: V7WorkflowStep['id'], model: ProductionModel): ProductionPhaseId | null {
  return productionPhases(model).find((phase) => phase.legacyStepIds?.includes(stepId))?.id || null;
}

function gateForStep(stepId: V7WorkflowStep['id'], model: ProductionModel): ProductionGateId | null {
  const gates = productionGates(model);
  const preferred: Partial<Record<V7WorkflowStep['id'], ProductionGateId>> = {
    W02: 'STORYBOARD_DIALOGUE', W03: 'ANIMATIC_LOCK', W04: 'KEYFRAMES', W05: 'SHOT_VIDEO', W06: 'SHOT_LOCK',
    W07: 'SOUND_MIX_SUBTITLES', W08: 'EPISODE_ASSEMBLY', W09: 'SERIES_CONTINUITY',
  };
  return gates.find((gate) => gate.id === preferred[stepId])?.id
    || gates.find((gate) => gate.legacyStepIds?.includes(stepId))?.id
    || null;
}

function FullProductionStageSpine({ model, activePhaseId, onSelect }: {
  model: ProductionModel;
  activePhaseId: ProductionPhaseId;
  onSelect: (phaseId: ProductionPhaseId) => void;
}) {
  return <nav className="production-v2-stage-spine" aria-label="全剧制作五阶段" role="tablist">
    {productionPhases(model).map((phase) => {
      const denominatorKnown = phase.denominatorState === 'KNOWN' && typeof phase.denominator === 'number';
      const progress = productionProgressLabel(phase);
      const lifecycle = phase.lifecycleRollup || {};
      return <button
        type="button"
        role="tab"
        key={phase.id}
        data-production-phase={phase.order}
        className={activePhaseId === phase.id ? 'active' : ''}
        aria-selected={activePhaseId === phase.id}
        onClick={() => onSelect(phase.id)}
      >
        <span><i>{String(phase.order).padStart(2, '0')}</i><b>{phase.label}</b></span>
        <strong>{progress}</strong>
        <small>{denominatorKnown ? '已放行出口 / 当前适用' : '当前阶段出口分母未建立'}</small>
        <em>{`待审${lifecycle.REVIEW_PENDING || 0} · 返修${lifecycle.REVISION_REQUIRED || 0} · 异常${(lifecycle.BLOCKED || 0) + (lifecycle.RESULT_UNKNOWN || 0) + (lifecycle.EXECUTION_FAILED || 0)}`}</em>
      </button>;
    })}
  </nav>;
}

function FullProductionGateRail({ model, phase, activeGateId, onSelect }: {
  model: ProductionModel;
  phase: ProductionPhaseDefinition;
  activeGateId: ProductionGateId;
  onSelect: (gateId: ProductionGateId) => void;
}) {
  const gates = productionGates(model).filter((gate) => gate.phaseId === phase.id);
  return <nav className="production-v2-gate-rail" aria-label={`${phase.label}内部质量门禁`} role="tablist">
    {gates.map((gate) => {
      const denominatorKnown = gate.denominatorState === 'KNOWN' && typeof gate.denominator === 'number';
      const status = denominatorKnown
        ? `${productionProgressLabel(gate)}个出口对象已放行`
        : '分母 UNKNOWN';
      return <button
        type="button"
        role="tab"
        key={gate.id}
        data-production-gate={gate.order}
        className={activeGateId === gate.id ? 'active' : ''}
        aria-selected={activeGateId === gate.id}
        onClick={() => onSelect(gate.id)}
      ><span>门禁 {gate.order}</span><b>{gate.label}</b><small>{status}</small></button>;
    })}
  </nav>;
}

function FullProductionScopeSelector({ model, gate, packages, activePackage, onSelect }: {
  model: ProductionModel;
  gate: ProductionGateDefinition;
  packages: V7WorkPackage[];
  activePackage: V7WorkPackage | null;
  onSelect: (workPackage: V7WorkPackage) => void;
}) {
  const selectedId = activePackage && packages.some((record) => record.id === activePackage.id) ? activePackage.id : '';
  const sceneIds = [...new Set(packages.map((record) => record.sceneId).filter((id): id is string => Boolean(id)))];
  const selectedSceneId = activePackage?.sceneId || sceneIds[0] || '';
  const shotPackages = packages.filter((record) => record.sceneId === selectedSceneId);
  const choose = (id: string) => {
    const next = packages.find((record) => record.id === id);
    if (next) onSelect(next);
  };
  const chooseScene = (sceneId: string) => {
    const next = packages.find((record) => record.sceneId === sceneId);
    if (next) onSelect(next);
  };

  if (gate.scopeType === 'PROJECT') return <section className="production-v2-scope-selector" aria-label={`${gate.label}项目范围`}>
    <p><span>项目范围</span><b>本剧全剧 · 正式输入分母 UNKNOWN</b><small>{episodePlanIsCurrent(model) ? `${proposalEpisodeRange(model)}当前分集方案已采用，但尚未形成正式制作输入分母；` : `${proposalEpisodeRange(model)}只是审阅导航提案；`}正式身份为项目，不使用任意锚点镜头代替。</small></p>
  </section>;

  if (!packages.length) return <section className="production-v2-scope-selector is-empty" aria-label={`${gate.label}范围`}>
    <p><span>本门禁范围</span><b>当前没有可进入的正式对象</b><small>缺失目标保持为ExpectedOutput或上游准备缺口；旧镜头不进入当前生产范围。</small></p>
  </section>;

  if (gate.scopeType === 'SCENE') return <section className="production-v2-scope-selector" aria-label={`${gate.label}场级范围`}>
    <label><span>场</span><select value={selectedId} onChange={(event) => choose(event.target.value)}>{packages.map((record) => <option key={record.id} value={record.id}>{nativeScopeTitle(model, record)}</option>)}</select></label>
    <p><span>正式范围</span><b>整场对象</b><small>镜头仅作为组成输入，不替代本门禁的场级审阅身份。</small></p>
  </section>;

  if (gate.scopeType === 'EPISODE') return <section className="production-v2-scope-selector" aria-label={`${gate.label}集级范围`}>
    <label><span>{episodePlanIsCurrent(model) ? '当前分集方案' : '分集导航提案'}</span><select value={selectedId} onChange={(event) => choose(event.target.value)}>{packages.map((record) => <option key={record.id} value={record.id}>{nativeScopeTitle(model, record)}</option>)}</select></label>
    <p><span>当前边界</span><b>{episodePlanRangeLabel(model)}</b><small>正式制作分母为 UNKNOWN；场与历史镜头只说明准备缺口，不替代集级成片裁决。</small></p>
  </section>;

  return <section className="production-v2-scope-selector" aria-label={`${gate.label}镜头范围`}>
    <label><span>场</span><select value={selectedSceneId} onChange={(event) => chooseScene(event.target.value)}>{sceneIds.map((id) => { const scene = model.scenes.find((record) => record.id === id); return <option key={id} value={id}>{`${id} · ${visibleText(scene?.title || '场次')}`}</option>; })}</select></label>
    <i>→</i>
    <label><span>当前镜</span><select value={selectedId} onChange={(event) => choose(event.target.value)}>{shotPackages.map((record) => <option key={record.id} value={record.id}>{nativeScopeTitle(model, record)}</option>)}</select></label>
    {gate.id === 'STORYBOARD_DIALOGUE' && <p><span>并行泳道</span><b>画面粗分镜 ∥ 对白干声</b><small>两条泳道分别审阅、共同决定Animatic是否可开始。</small></p>}
  </section>;
}

function FullProductionLifecycleFilters({ model, packages, value, onChange }: {
  model: ProductionModel;
  packages: V7WorkPackage[];
  value: FullProductionFilter;
  onChange: (filter: FullProductionFilter) => void;
}) {
  return <nav className="production-v2-lifecycle-filters" aria-label="当前门禁工作筛选">
    {fullProductionFilterDefinitions.map((filter) => {
      const count = filter.id === 'ALL' ? packages.length : packages.filter((record) => fullProductionFilterMatches(model, record, filter.id)).length;
      return <button type="button" key={filter.id} className={value === filter.id ? 'active' : ''} aria-pressed={value === filter.id} title={filter.description} onClick={() => onChange(value === filter.id ? 'ALL' : filter.id)}><span>{filter.label}</span><b>{count}</b></button>;
    })}
  </nav>;
}

function FullProductionScopeNavigator({ model, gate, packages, activePackage, onSelect }: {
  model: ProductionModel;
  gate: ProductionGateDefinition;
  packages: V7WorkPackage[];
  activePackage: V7WorkPackage | null;
  onSelect: (workPackage: V7WorkPackage) => void;
}) {
  if (gate.scopeType === 'PROJECT') return <aside className="production-v2-scope-list is-project" aria-label={`${gate.label}分集齐套矩阵`}>
    <header><small>项目级范围</small><h3>{episodePlanIsCurrent(model) ? '当前分集方案输入矩阵' : '导航提案输入矩阵'}</h3><p>本门禁只审全剧；{episodePlanIsCurrent(model) ? `${proposalEpisodeRange(model)}方案已采用，但仍只显示未齐套输入；` : `${proposalEpisodeRange(model)}仅用于查看分集准备缺口，`}正式制作输入分母仍为UNKNOWN。</p></header>
    <div>{model.episodes.map((episode) => {
      const upstream = model.workPackages.find((record) => record.stepId === 'W08' && record.scopeId === episodeCanonicalScopeId(episode));
      return <article key={episode.episodeUid || episode.id}><b>{episode.displayId || episode.id}</b><span>{episode.sceneIds.length}场</span><em className={`tone-${statusTone(upstream?.lifecycleState)}`}>{directorStatus(upstream?.lifecycleState || 'WAITING_UPSTREAM')}</em></article>;
    })}</div>
  </aside>;

  return <nav className="production-v2-scope-list" aria-label={`${gate.label}对象列表`}>
    <header><small>本门禁对象</small><h3>{gate.label}</h3><p>{packages.length ? `${packages.length}项符合当前筛选` : '当前筛选没有对象'}</p></header>
    <div>{packages.map((record) => <button
      type="button"
      key={record.id}
      className={record.id === activePackage?.id ? 'active' : ''}
      aria-current={record.id === activePackage?.id ? 'location' : undefined}
      onClick={() => onSelect(record)}
    ><b>{nativeScopeTitle(model, record)}</b><span>{nativeScopeMeta(model, record)}</span><em className={`tone-${statusTone(record.lifecycleState)}`}>{directorStatus(record.lifecycleState || record.applicabilityState)}</em></button>)}</div>
  </nav>;
}

function FullProductionHistoricalFocusEvidence({ shot }: { shot: V7Shot }) {
  return <aside className="production-v2-historical-focus-evidence" aria-label="历史镜头只读证据" data-historical-shot-id={shot.id}>
    <header><small>精确旧链接 · 只读证据</small><h3>{shot.id} · {visibleText(shot.title)}</h3><p>该镜头已退出当前制作图，仅因本次链接精确指向它而显示；这里不提供历史目录、生成、审阅或恢复入口。</p></header>
    <p>{visibleText(shot.sourceContent || '旧镜头未登记内容摘要')}</p>
    <dl><div><dt>场次</dt><dd>{shot.episodeId} → {shot.sceneId}</dd></div><div><dt>空间</dt><dd>{visibleText([...shot.locs, ...shot.zones, ...shot.cameras].join(' · ') || 'UNKNOWN')}</dd></div><div><dt>来源</dt><dd>{visibleText(shot.sourceRef)}</dd></div></dl>
    <p className="production-v2-history-warning">仅作证据，不可生成、审阅或计入完成率。</p>
  </aside>;
}

/** An explicit history coordinate may reveal evidence, never a production anchor. */
export function historicalFocusForProductionContext(model: ProductionModel, context: Pick<ProductionContext, 'shotId' | 'workPackageId'>): V7Shot | null {
  if (!context.shotId || context.workPackageId !== `HISTORICAL_ONLY:${context.shotId}`) return null;
  const matches = model.shots.filter((shot) => shot.id === context.shotId);
  if (matches.length !== 1) return null;
  const shot = matches[0];
  if (shot.scopeRole !== 'HISTORICAL' || shot.activityRole !== 'HISTORICAL_EVIDENCE' || shot.activeInCurrentProduction !== false || fullProductionCurrentShotIds(model).has(shot.id)) return null;
  return shot;
}

function FullProductionEmptyState({ model, phase, gate }: { model: ProductionModel; phase: ProductionPhaseDefinition; gate: ProductionGateDefinition }) {
  const currentShotSpecs = formalCurrentShotSpecIds(model).size;
  const currentP07 = fullProductionCurrentP07ShotIds(model).size;
  const isolatedPlanCount = model.workPackages.filter((record) => record.gateId === gate.id && record.activeInCurrentProduction === false).length;
  return <section className="production-v2-empty-state">
    <small>{`阶段 ${phase.order} · 门禁 ${gate.order}`}</small>
    <h3>当前没有可进入本门禁的正式生产对象</h3>
    <p>已建立{currentShotSpecs}个正式ShotSpec，其中当前粗分镜产出为{currentP07}；未完成逐镜输入锁的对象只停在首门禁，不能进入“{phase.label}”后续出口。</p>
    <p>当前门禁正式分母为{gate.denominatorState || 'UNKNOWN'}。</p>
  </section>;
}

function productionContractIssues(model: ProductionModel) {
  const phases = productionPhases(model);
  const gates = productionGates(model);
  const expectedPhases: ProductionPhaseId[] = ['PREVIS', 'SHOT_FINISH', 'SCENE_FINISH', 'EPISODE_FINISH', 'SERIES_DELIVERY'];
  const expectedGates: ProductionGateId[] = [
    'SHOT_PLAN_INPUT_LOCK', 'STORYBOARD_DIALOGUE', 'ANIMATIC_LOCK',
    'KEYFRAMES', 'SHOT_VIDEO', 'SHOT_LOCK',
    'PICTURE_LOCK', 'SOUND_MIX_SUBTITLES', 'SCENE_QA',
    'EPISODE_ASSEMBLY', 'EPISODE_REVIEW', 'EPISODE_TECH_QC',
    'SERIES_CONTINUITY', 'RIGHTS_SAFETY_TECH', 'DELIVERY_ARCHIVE',
  ];
  const issues = [
    phases.length !== 5 ? `阶段定义应为5项，实际为${phases.length}` : '',
    gates.length !== 15 ? `门禁定义应为15项，实际为${gates.length}` : '',
    expectedPhases.some((id) => !phases.some((phase) => phase.id === id)) ? '缺少一个或多个canonical阶段ID' : '',
    expectedGates.some((id) => !gates.some((gate) => gate.id === id)) ? '缺少一个或多个canonical门禁ID' : '',
    phases.some((phase) => gates.filter((gate) => gate.phaseId === phase.id).length !== 3) ? '每个阶段必须精确包含3个门禁' : '',
  ].filter(Boolean);
  return issues;
}

export function FullProductionWorkbench(props: FullProductionWorkbenchProps) {
  const issues = productionContractIssues(props.model);
  if (issues.length) return <section className="v8-inline-error production-contract-failed" role="alert"><b>制作检查定义：UNKNOWN</b><p>当前页面已失败关闭，没有使用前端内置检查兜底。</p><details><summary>查看配置缺项</summary><ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></details></section>;
  return <ProductionPreparationWorkspace workflow={{phases:productionPhases(props.model),gates:productionGates(props.model)}} initialPhaseId={props.context.phaseId} initialGateId={props.context.gateId} onStageChange={(phaseId,gateId,creatorStageId,selection)=>props.onNavigate({shotId:'',workPackageId:'',workItemId:null,familyId:null,versionId:null,phaseId:phaseId as ProductionPhaseId,gateId:gateId as ProductionGateId,creatorStageId,preparationEpisodeUid:selection?.episodeUid,preparationSceneId:selection?.sceneId,navigationScopeType:selection?.navigationScopeType})} renderStage={({sceneId,episodeUid,phaseId,gateId,navigationScopeType})=><FullProductionWorkbenchReady {...props} contextualSceneId={sceneId} contextualEpisodeUid={episodeUid} navigationScopeType={navigationScopeType} context={{...props.context,phaseId:phaseId as ProductionPhaseId,gateId:gateId as ProductionGateId}}/>}/>;
}

function FullProductionWorkbenchReady({ model, context, onNavigate, onOpenMaterial, dataWindow, contextualSceneId, contextualEpisodeUid, navigationScopeType }: FullProductionWorkbenchProps & {contextualSceneId?:string;contextualEpisodeUid?:string;navigationScopeType:'SCENE'|'EPISODE'|'PROJECT'}) {
  const contextPackage = model.workPackages.find((record) => record.id === context.workPackageId) || null;
  const phases = productionPhases(model);
  const gates = productionGates(model);
  const packagePhaseId = contextPackage?.phaseId || (contextPackage && contextPackage.stepId !== 'W01' ? phaseForStep(contextPackage.stepId, model) : 'PREVIS');
  const requestedPhase = context.phaseId ? phases.find((record) => record.id === context.phaseId) || null : null;
  const activePhase = requestedPhase || phases.find((record) => record.id === packagePhaseId) || phases[0];
  const requestedGate = context.gateId ? gates.find((record) => record.id === context.gateId && record.phaseId === activePhase.id) || null : null;
  const packageGateId = contextPackage?.gateId || (contextPackage && contextPackage.stepId !== 'W01' ? gateForStep(contextPackage.stepId, model) : null);
  const activeGate = requestedGate
    || gates.find((record) => record.id === packageGateId && record.phaseId === activePhase.id)
    || gates.find((record) => record.id === activePhase.entryGateId)
    || gates.find((record) => record.phaseId === activePhase.id)
    || gates[0];
  const activeStepId = activeGate.legacyStepIds?.[0] || activePhase.legacyStepIds?.[0] || 'W02';
  const [filterSelection, setFilterSelection] = useState<{ gateId: ProductionGateId; filter: FullProductionFilter }>(() => ({ gateId: activeGate.id, filter: 'ALL' }));
  const filter = filterSelection.gateId === activeGate.id ? filterSelection.filter : 'ALL';
  const currentShotIds = useMemo(() => fullProductionCurrentShotIds(model), [model]);
  const sceneShots = model.shots.filter(record=>currentShotIds.has(record.id) && (navigationScopeType==='PROJECT' || navigationScopeType==='EPISODE' ? navigationScopeType==='PROJECT' || record.episodeUid===contextualEpisodeUid : record.sceneId===contextualSceneId));
  const contextShot = sceneShots.find((record) => record.id === context.shotId) || sceneShots[0] || null;

  const step = model.workflowSteps.find((record) => record.id === activeStepId) || model.workflowSteps.find((record) => record.id === 'W02') || model.workflowSteps[0];
  const packages = productionPackagesInNavigationScope(model, activeGate, {navigationScopeType,episodeUid:contextualEpisodeUid,sceneId:contextualSceneId});
  const historicalContextMarker = context.workPackageId.startsWith('HISTORICAL_ONLY:');
  const historicalOnlyContext = historicalContextMarker && (!contextShot || !currentShotIds.has(contextShot.id));
  const activePackage = historicalOnlyContext
    ? null
    : packages.find((record) => record.id === context.workPackageId)
      || packages.find((record) => record.shotIds.includes(context.shotId))
      || (historicalContextMarker ? null : packages[0])
      || null;
  const visiblePackages = packages.filter((record) => fullProductionFilterMatches(model, record, filter));
  const anchorShot = activePackage ? sceneShots.find(shot=>shot.id===context.shotId&&activePackage.shotIds.includes(shot.id)) || sceneShots.find(shot=>activePackage.shotIds.includes(shot.id)) || null : contextShot;
  const effectiveContext = activePackage && anchorShot
    ? resolveProductionContext(model, {
      shotId: anchorShot.id,
      workPackageId: activePackage.id,
      workItemId: activePackage.id === context.workPackageId ? context.workItemId : null,
      familyId: activePackage.id === context.workPackageId ? context.familyId : null,
      versionId: activePackage.id === context.workPackageId ? context.versionId : null,
      phaseId: activePhase.id,
      gateId: activeGate.id,
    })
    : context;
  const target = activePackage ? decisionTargetForContext(model, effectiveContext) : { workPackage: null, item: null, family: null, version: null };
  const targetReviewContext = workProductReviewContext(model, target.item, target.workPackage);
  const operations = useReviewOperations(target.item ? {
    subjectType: 'WORK_PRODUCT',

    subjectId: target.item.id,
    versionId: target.version?.id || null,
    contextHash: targetReviewContext?.contextHash || null,
  } : null);
  const activeItem = target.item ? withReviewProjection(withOperationalProjection(target.item, operations.workItemProjection), operations.effective) : null;
  const heading = activePackage && anchorShot ? workbenchHeading(model, anchorShot, activePackage, activeItem) : null;
  const legacyFocus = historicalFocusForProductionContext(model, context);
  const currentShotSpecs = formalCurrentShotSpecIds(model).size;
  const declaredCurrentShotSpecs = model.counts.currentShotSpecCount ?? currentShotSpecs;
  const currentP07 = fullProductionCurrentP07ShotIds(model).size;
  const declaredCurrentP07 = model.counts.currentP07ShotPlans ?? currentP07;

  function navigatePackage(workPackage: V7WorkPackage) {
    const shot = anchorShotForPackage(model, workPackage, context.shotId);
    if (!shot) return;
    onNavigate({ shotId: shot.id, workPackageId: workPackage.id, phaseId: activePhase.id, gateId: activeGate.id });
  }

  function navigateGate(phase: ProductionPhaseDefinition, gate: ProductionGateDefinition) {
    setFilterSelection({ gateId: gate.id, filter: 'ALL' });
    const nextPackages = fullProductionPackagesForGate(model, gate);
    const workPackage = nextPackages.find((record) => record.id === context.workPackageId)
      || nextPackages.find((record) => record.shotIds.includes(context.shotId))
      || nextPackages[0]
      || null;
    const shot = workPackage ? anchorShotForPackage(model, workPackage, context.shotId) : contextShot;
    if (!shot) return;
    onNavigate({
      shotId: shot.id,
      workPackageId: workPackage?.id || context.workPackageId,
      phaseId: phase.id,
      gateId: gate.id,
    });
  }

  function choosePhase(phaseId: ProductionPhaseId) {
    const phase = phases.find((record) => record.id === phaseId) || activePhase;
    const gate = gates.find((record) => record.id === phase.entryGateId)
      || gates.find((record) => record.phaseId === phase.id)
      || activeGate;
    navigateGate(phase, gate);
  }

  function chooseGate(gateId: ProductionGateId) {
    const gate = gates.find((record) => record.id === gateId && record.phaseId === activePhase.id) || activeGate;
    navigateGate(activePhase, gate);
  }

  function chooseFilter(next: FullProductionFilter) {
    setFilterSelection({ gateId: activeGate.id, filter: next });
    if (next === 'ALL' || (activePackage && fullProductionFilterMatches(model, activePackage, next))) return;
    const first = packages.find((record) => fullProductionFilterMatches(model, record, next));
    if (first) navigatePackage(first);
  }

  function openCurrentGateReviewQueue() {
    setFilterSelection({ gateId: activeGate.id, filter: 'REVIEW_PENDING' });
    const first = packages.find((record) => fullProductionFilterMatches(model, record, 'REVIEW_PENDING'));
    if (first) navigatePackage(first);
  }

  if (!activePhase || !activeGate || (activePackage && !step)) return <section className="v6-empty-note"><b>制作检查定义缺失。</b><p>当前不能建立全剧制作工作面。</p></section>;

  return <section className="production-v2-full-workbench is-contextual creator-production-stage-body" data-navigation-scope={navigationScopeType} data-formal-scope={activeGate.scopeType}>
    {activeGate.id==='SHOT_PLAN_INPUT_LOCK' && contextualEpisodeUid && contextualSceneId && <EpisodeProductionEntry episodeUid={contextualEpisodeUid} sceneId={contextualSceneId}/>}
    {contextualSceneId && activeGate.id==='ANIMATIC_LOCK' && <AnimaticWorkspace sceneId={contextualSceneId}/>}
    {contextualSceneId && ['SHOT_PLAN_INPUT_LOCK','STORYBOARD_DIALOGUE','KEYFRAMES','SHOT_VIDEO','SHOT_LOCK'].includes(activeGate.id) && <ShotProductionWorkspace sceneId={contextualSceneId} episodeUid={contextualEpisodeUid} gateId={activeGate.id} shotId={context.shotId||undefined}/>}
    {(declaredCurrentShotSpecs !== currentShotSpecs || declaredCurrentP07 !== currentP07) && <p role="alert">正式镜头或粗分镜声明数量与精确绑定不一致，当前分母保持 UNKNOWN，请核查输入。</p>}

    {dataWindow && (dataWindow.loading || dataWindow.hasMore || dataWindow.error || dataWindow.total === null) && <section className={`paged-data-window ${dataWindow.error ? 'has-error' : ''}`} role={dataWindow.error ? 'alert' : 'status'}>
      <div><small>当前门禁按需数据</small><b>{dataWindow.total === null ? '总量 UNKNOWN' : `已读取 ${dataWindow.loaded} / ${dataWindow.total} 个工作项`}</b><span>{dataWindow.hasMore ? '仅列出已读取对象；继续读取不会改变门禁或正式分母。' : '当前查询窗口已完整读取。'}</span></div>
      {dataWindow.error ? <><p>读取未完成：{visibleText(dataWindow.error)}。页面保留已验证数据，没有回退到旧全量兼容视图。</p><button type="button" disabled={dataWindow.loading} onClick={dataWindow.onRetry}>重试当前窗口</button></> : dataWindow.hasMore ? <button type="button" disabled={dataWindow.loading} onClick={dataWindow.onLoadMore}>{dataWindow.loading ? '读取中…' : '继续读取当前门禁'}</button> : null}
    </section>}

    {packages.length > 0 && <section className="production-v2-stage-controls">
      <FullProductionLifecycleFilters model={model} packages={packages} value={filter} onChange={chooseFilter} />
    </section>}

    {activeGate.id === 'STORYBOARD_DIALOGUE' && activePackage && anchorShot && <CalibrationJourneyBar model={model} shot={anchorShot} projection={operations.stateProjection} onNavigate={onNavigate} />}

    <div className="creator-production-objects">
      {visiblePackages.length > 1 && <nav className="creator-production-object-tabs" aria-label="当前工作对象">{visiblePackages.map(record=><button type="button" key={record.id} aria-pressed={record.id===activePackage?.id} onClick={()=>navigatePackage(record)}>{nativeScopeTitle(model,record)}</button>)}</nav>}
      <main className="production-v2-workspace">
        {activePackage && !visiblePackages.some((record) => record.id === activePackage.id) && <section className="production-v2-filter-mismatch"><b>当前对象不在“{fullProductionFilterDefinitions.find((record) => record.id === filter)?.label}”结果中</b><p>从左侧选择符合筛选的对象，或切回“全部”。正式目标不会因筛选被静默改绑。</p></section>}
        {!activePackage || !anchorShot || !heading
          ? <><section className="production-v2-empty-state"><h3>{activePackage?'当前对象的组成输入尚未齐套':'尚未建立本项正式制作对象'}</h3><p>{activeGate.scopeType==='PROJECT'?'导出检查针对全剧已采用输入；当前选择的集只用于查看，不改变全剧审阅范围。':navigationScopeType==='EPISODE'?'本集尚无可审阅的合成成片。需要本集的已通过场景成片和完整剧本发布快照。':'准备稿可用于整理表达意图；正式镜头、输入锁与生成结果仍须按当前场的精确版本建立。'}</p><small>正式制作分母：{activeGate.denominatorState||'UNKNOWN'}。准备内容不代表已生成、已审阅或已采用。</small></section>{legacyFocus && <FullProductionHistoricalFocusEvidence shot={legacyFocus} />}</>
          : <>
            <section className="production-v2-object-heading"><header><div><small>{heading.path}</small><h2>{heading.title}</h2><p>{heading.description}</p></div><span className={`tone-${statusTone(activeItem?.lifecycleState || activePackage.lifecycleState)}`}><b>{directorStatus(activeItem?.lifecycleState || activePackage.lifecycleState)}</b><small>当前工作项生命周期</small></span></header><div>{heading.meta.map(([label, value]) => <span key={label}><b>{label}</b>{value}</span>)}</div></section>
            <WorkPackageDetail model={model} shot={anchorShot} workPackage={activePackage} context={effectiveContext} operations={operations} onNavigate={onNavigate} onOpenMaterial={onOpenMaterial} onOpenReviewOverview={activeGate.id === 'STORYBOARD_DIALOGUE' ? openCurrentGateReviewQueue : undefined} />
          </>}
      </main>
    </div>

  </section>;
}

export function ShotProductionWorkbench({ model, context, onNavigate, onOpenReviewOverview }: {
  model: ProductionModel;
  context: ProductionContext;
  onNavigate: ProductionNavigate;
  onOpenReviewOverview?: () => void;
}) {
  const shot = model.shots.find((item) => item.id === context.shotId) || model.shots[0];
  const packages = shot.workPackageRefs.map((id) => model.workPackages.find((item) => item.id === id)).filter((item): item is V7WorkPackage => Boolean(item));
  const workPackage = packages.find((item) => item.id === context.workPackageId) || packages.find((item) => item.id === shot.defaultWorkPackageId) || packages[0];
  const target = decisionTargetForContext(model, context);
  const targetReviewContext = workProductReviewContext(model, target.item, target.workPackage);
  const operations = useReviewOperations(target.item ? {
    subjectType: 'WORK_PRODUCT',

    subjectId: target.item.id,
    versionId: target.version?.id || null,
    contextHash: targetReviewContext?.contextHash || null,
  } : null);
  const calibrationQueue = storyboardReviewQueue(model);
  const sceneQueue = model.shots.filter((item) => item.sceneId === shot.sceneId);
  const navigationQueue = calibrationQueue.some((item) => item.id === shot.id) ? calibrationQueue : sceneQueue;

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!workPackage || ['W07', 'W08', 'W09'].includes(workPackage.stepId)) return;
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || isTextEntryTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'c') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('review:toggle-comparison'));
        return;
      }
      if (key !== 'j' && key !== 'k') return;
      const index = navigationQueue.findIndex((item) => item.id === shot.id);
      const next = navigationQueue[index + (key === 'j' ? -1 : 1)];
      if (!next) return;
      event.preventDefault();
      const nextTarget = storyboardReviewTarget(model, next);
      onNavigate({ shotId: next.id, workPackageId: nextTarget.workPackage?.id || next.defaultWorkPackageId, workItemId: nextTarget.item?.id || null, familyId: nextTarget.family?.id || null, versionId: nextTarget.version?.id || null });
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [model, navigationQueue, onNavigate, shot.id, workPackage]);

  if (!workPackage) return <section className="v6-empty-note"><b>当前镜头没有可解析的制作工作包。</b><p>请先修复业务关系，不能凭固定路径继续执行或审阅。</p></section>;
  const activeItem = target.item ? withReviewProjection(withOperationalProjection(target.item, operations.workItemProjection), operations.effective) : null;
  const heading = workbenchHeading(model, shot, workPackage, activeItem);

  return <>
    <ProductionContextBar model={model} {...context} workPackage={workPackage} onNavigate={onNavigate} />
    {workPackage.stepId === 'W02' && <CalibrationJourneyBar model={model} shot={shot} projection={operations.stateProjection} onNavigate={onNavigate} />}
    <section className="creator-workbench-heading"><header className="v6-shot-heading"><div><small>{heading.path}</small><h2>{heading.title}</h2><p>{heading.description}</p></div><span className={'tone-' + statusTone(activeItem?.lifecycleState || workPackage.lifecycleState)}><b>{directorStatus(activeItem?.lifecycleState || workPackage.lifecycleState)}</b><small>当前工作项生命周期</small><i>父级只聚合；这里以选中交付物为准</i></span></header>
      <div className="v6-shot-meta">{heading.meta.map(([label, value]) => <span key={label}><b>{label}</b>{value}</span>)}</div>
      <WorkflowRail model={model} shot={shot} activeId={workPackage.id} onNavigate={onNavigate} />
    </section>
    <div className="v7-workbench-grid creator-workbench-grid">
      <ProductionScopeNavigator model={model} shot={shot} workPackage={workPackage} onNavigate={onNavigate} />
      <section className="v6-shot-workspace creator-shot-workspace">
        <WorkPackageDetail model={model} shot={shot} workPackage={workPackage} context={context} operations={operations} onNavigate={onNavigate} onOpenReviewOverview={onOpenReviewOverview} />
      </section>
    </div>
  </>;
}

function IssueCard({ issue, evidenceCatalog, onOpen }: { issue: V7Issue; evidenceCatalog: Record<string, ReviewEvidence>; onOpen?: (shotId: string) => void }) {
  const businessScope = [...issue.episodeIds, ...issue.sceneIds, ...issue.shotIds].map(visibleText).join(' → ') || '全局';
  return <section id={publicRef(issue.id)} className={'tone-' + statusTone(issue.stateText)}><header><b>{publicRef(issue.id) + ' · ' + visibleText(issue.title)}</b><i>{directorStatus(issue.stateText)}</i></header><div><p><span>当前事实</span>{visibleText(issue.fact)}</p><p><span>下一动作</span>{visibleText(issue.nextAction)}</p><p><span>你需要如何做</span>{visibleText(issue.userAction)}</p></div><footer><small>{'业务范围：' + businessScope}</small><small>{'责任：' + visibleText(issue.responsibleParty)}</small>{onOpen && issue.shotIds.map((id) => <button key={id} onClick={() => onOpen(id)}>{'打开' + id}</button>)}</footer><EvidenceDetails refs={issue.evidenceRefs || []} catalog={evidenceCatalog} label="查看问题依据内容" /></section>;
}

export function StructuredWorkBoard({ model, unknowns, focusId, onNavigate, onOpenWorkPackage, onOpenStoryScene, onOpenStructureScene }: {
  model: ProductionModel;
  unknowns: string[];
  focusId?: string | null;
  onNavigate: ProductionNavigate;
  onOpenWorkPackage?: (shotId: string, workPackageId: string) => void;
  onOpenStoryScene?: (sceneId: string) => void;
  onOpenStructureScene?: (sceneId: string) => void;
}) {
  const [expandedLifecycleQueues, setExpandedLifecycleQueues] = useState<string[]>([]);
  const evidenceCatalog = model.reviewContextCatalog?.evidenceCatalog || {};
  const steps = model.workflowSteps.slice().sort((a, b) => a.order - b.order);
  function stepForIssue(issue: V7Issue) { return issue.workflowStepId || stageToStep[issue.stageKey]; }
  const actionableIssues = model.issues.filter((issue) => !/CLOSED|RESOLVED|RELEASED/.test(issue.state || issue.stateText));
  const lifecycleQueues = [
    { id: 'REVISION_REQUIRED', label: '需要返修', states: ['REVISION_REQUIRED'] },
    { id: 'EXECUTION', label: '执行与结果登记', states: ['IN_PROGRESS', 'RESULT_PENDING_REGISTRATION'] },
    { id: 'EXCEPTION', label: '结果不明／失败', states: ['RESULT_UNKNOWN', 'EXECUTION_FAILED'] },
    { id: 'BLOCKED', label: '硬阻断／禁止使用', states: ['BLOCKED', 'RIGHTS_HOLD', 'DO_NOT_USE'] },
  ].map((queue) => ({ ...queue, items: model.workItems.filter((item) => queue.states.includes(item.lifecycleState || '')) }));
  const structureCards = model.structureCards || [];
  const structureScenes = [...new Set(structureCards.map((card) => card.sceneId))].sort();

  function openWorkItem(item: V7WorkItem) {
    const workPackage = model.workPackages.find((entry) => entry.workItemRefs.includes(item.id));
    const shotId = workPackage?.shotIds[0] || item.shotId;
    if (!workPackage || !shotId) return;
    if (onOpenWorkPackage) onOpenWorkPackage(shotId, workPackage.id);
    else onNavigate({ shotId, workPackageId: workPackage.id, workItemId: item.id });
  }

  useEffect(() => {
    if (!focusId) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(publicRef(focusId));
      if (!target) return;
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.tabIndex = -1;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusId, model]);

  return <>
    <section className="creator-control-summary"><header><div><small>PROJECT CONTROL</small><h2>只处理跨对象推进、异常与项目门禁</h2><p>普通待审候选只在“镜头制作 → 审阅与返修”出现；这里不重复。故事、素材和具体制作也各自回到唯一工作面。</p></div></header><div>{lifecycleQueues.map((queue) => <article key={queue.id}><b>{queue.items.length}</b><span>{queue.label}</span></article>)}</div></section>
    <section className="creator-control-queues"><header><div><small>LIFECYCLE QUEUES</small><h2>需要跨对象协调的真实队列</h2></div><p>只显示返修、执行中、结果异常和硬阻断；普通REVIEW_PENDING与等待上游不会淹没统筹视图。</p></header><div>{lifecycleQueues.map((queue) => { const expanded = expandedLifecycleQueues.includes(queue.id); const visible = expanded ? queue.items : queue.items.slice(0, 24); return <section key={queue.id}><header><b>{queue.label}</b><span>显示 {visible.length} / 共 {queue.items.length} 项</span></header>{visible.length ? visible.map((item) => <button key={item.id} onClick={() => openWorkItem(item)}><span><b>{workItemLabel(item)}</b><small>{[item.episodeId, item.sceneId, item.shotId || item.scopeId].filter(Boolean).map(visibleText).join(' → ')}</small></span><em>{directorStatus(item.lifecycleState)}</em></button>) : <p>当前无此类对象。</p>}{queue.items.length > 24 && <button type="button" className="creator-queue-expander" aria-expanded={expanded} onClick={() => setExpandedLifecycleQueues((current) => expanded ? current.filter((id) => id !== queue.id) : [...current, queue.id])}>{expanded ? '收起列表' : `展开全部 ${queue.items.length} 项`}</button>}</section>; })}</div></section>
    {actionableIssues.length > 0 && <section className="creator-governance-issues"><header><div><small>REGISTERED ISSUES</small><h2>已登记问题与验收出口</h2></div><span>{actionableIssues.length}项</span></header><div>{actionableIssues.map((issue) => <IssueCard key={issue.id} issue={issue} evidenceCatalog={evidenceCatalog} onOpen={(shotId) => { const stepId = stepForIssue(issue); const step = steps.find((entry) => entry.id === stepId); const shot = model.shots.find((entry) => entry.id === shotId); const workPackage = shot?.workPackageRefs.map((id) => model.workPackages.find((entry) => entry.id === id)).find((entry) => entry?.stepId === step?.id); const workItem = workPackage ? model.workItems.find((entry) => workPackage.workItemRefs.includes(entry.id)) : null; if (shot && workItem) openWorkItem(workItem); }} />)}</div></section>}
    {structureScenes.length > 0 && <section className="creator-owner-pointer"><div><small>对象归属提示</small><h2>{structureScenes.length}场、{structureCards.length}张结构卡由“故事创作 → 场次重编”唯一处理</h2><p>项目统筹只保留数量和影响提醒，不再复制逐场卡片。结构卡不是镜头，不进入五阶段出口分母。</p></div><div>{structureScenes[0] && <><button onClick={() => onOpenStructureScene?.(structureScenes[0])}>进入场次重编 →</button><button onClick={() => onOpenStoryScene?.(structureScenes[0])}>先读本场剧本</button></>}</div></section>}
    <section className="creator-stage-health"><header><div><small>FIVE-PHASE HEALTH</small><h2>五阶段聚合，只用于发现卡点</h2></div></header><div>{productionPhases(model).map((phase) => { const lifecycle = phase.lifecycleRollup || {}; const blocked = (lifecycle.BLOCKED || 0) + (lifecycle.RIGHTS_HOLD || 0) + (lifecycle.DO_NOT_USE || 0) + (lifecycle.RESULT_UNKNOWN || 0) + (lifecycle.EXECUTION_FAILED || 0); return <article key={phase.id}><span>{`阶段 ${phase.order} · ${phase.label}`}</span><b>{productionProgressLabel(phase)}</b><small>{blocked ? `${blocked}项异常` : '无已登记异常'}</small></article>; })}</div></section>
    <section className="v6-unknowns"><header><h2>必须保持 UNKNOWN 的边界</h2><span>{unknowns.length + '项'}</span></header><div>{unknowns.map((item, index) => <article key={item}><b>{String(index + 1).padStart(2, '0')}</b><p>{visibleText(item)}</p></article>)}</div></section>
  </>;
}
