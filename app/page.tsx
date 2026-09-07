/* eslint-disable @next/next/no-img-element */
'use client';
import { StoryCommentsProvider } from './story-comments';
import { NarrativeOverview } from './narrative-revision-reader';
import {EpisodeSceneReading} from './episode-scene-reading';
import {narrativeOverviewSection, type NarrativeOverviewSection} from './narrative-revision';
import { useEpisodePlanContext } from './use-episode-plan-context';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import dynamic from 'next/dynamic';
import { handleReviewAudioPlay, stopSeamAudition, type Asset, type Coverage, type Shot } from './review-components';
import { EvidenceReaderProvider } from './evidence-reader';
import { useAssistantFocus } from './assistant/context-provider';
import { useInstanceProfile } from './instance-context';
import type { WorkFocus } from './assistant/types';
import { applyOperationalProjection, FullProductionWorkbench, fullProductionCurrentShotIds, resolveFamilyVersionSelection, resolveProductionContext, type OperationalStateProjection, type ProductionContext, type ProductionGateId, type ProductionModel, type ProductionNavigationIntent, type ProductionPhaseId } from './production-workbench';
import { SystemDocumentation } from './system-documentation';
import { SystemManagement, SourceImport } from './system-management';
import { StorySettingsWorkspace } from './story-settings-workspace';
import {saveMaterialBrowseLocation,restoreMaterialBrowseLocation} from './material-browse-state';
import { GenericAuthoringWorkspace } from './generic-authoring-workspace';
import { GenericSourceReader, type GenericSourceFocus } from './generic-source-reader';
import { HistoricalVerificationSource } from './historical-verification-source';
import { publicRef, visibleText } from './review-semantics';
import { defaultCurrentWorkView, type CurrentWorkActor, type CurrentWorkArea, type CurrentWorkStateFilter, type CurrentWorkTypeFilter, type CurrentWorkViewState } from './current-work-shared';
import { CurrentWorkCenter } from './current-work-center';
import { defaultMaterialCenterState, MaterialProductionCenter, type MaterialCenterViewState } from './material-production-center';
import { isMaterialCreatorStage } from './material-taxonomy';
import type { AdaptationAudit, AudioVerificationTarget, SceneReviewDossier, StoryConfirmationTarget } from './adaptation-audit';
import { DocumentBlocks, type DocumentBlock } from './document-blocks';
import { EpisodePlanWorkbench, type EpisodeCriterionId } from './episode-plan-workbench';
import { CREATOR_PRODUCTION_STAGES, creatorProductionGateDefinition, creatorProductionStageForGate } from './creator-production-workflow';
import {exactMaterialPanelMatch} from './material-catalog-panel';
import { EpisodeLogicReview, EpisodeLogicSummary, firstLogicItem, normalizeLogicSelection } from './episode-logic-review';
import { StoryStructureWorkbench, STORY_OVERVIEW_SECTIONS } from './story-structure-workbench';
import { EmptyInstanceDesk } from './empty-instance';
import { TrialScopeEntry } from './trial-entry';
import { StoryWorkspaceHeading } from './story-workspace-heading';
import type { EpisodeReviewDossier, StoryOverview, StoryOverviewSectionId } from './story-review-types';
import {
  emptyPagedProductionWindow,
  mergePagedProductionModel,
  normalizeProductionModel,
  pagedProductionUrl,
  pagedProductionWindowKey,
  type PagedProductionFilters,
  type PagedProductionPayload,
  type PagedProductionResource,
  type PagedProductionWindow,
  type UiScopeType,
} from './paged-production-data';

const AdaptationAuditWorkbench = dynamic(
  () => import('./adaptation-audit').then((module) => module.AdaptationAuditWorkbench),
  { loading: () => <section className="review-bootstrap-state"><p>正在装入原文改编审计……</p></section> },
);

type StoryView = 'audit' | 'logic' | 'source' | 'story-structure';
type StorySourceMode = 'transcript' | 'outline';

type StoryboardArtifact = {
  id: string;
  shotId: string;
  scene: string;
  title: string;
  duration: number;
  branch: string;
  path: string;
  reviewProxy: string;
  manualQaEvidence: { scope: 'BATCH_STATEMENT_COVERING_EACH_SHOT'; sourceRef: string; sourceSha256: string; reviewer: 'UNKNOWN'; reviewedAt: 'UNKNOWN' };
  approvalEvidence: string;
  outputState: 'PRESENT';
  reviewDecision: 'PENDING' | 'RELEASED' | 'REVISION_REQUIRED' | 'DO_NOT_USE';
  projectRightsGate: 'NOT_APPLICABLE';
  historyRole: 'CURRENT';
  lifecycleState: string;
  canFlowDownstream: boolean;
  flowBlockReasons: string[];
  preflight: { status: 'PASS'; manualStatus: 'PASS' | 'UNKNOWN'; role: 'REVIEW_EVIDENCE_ONLY'; sourceRef: string };
  dimensions: [number, number];
  format: string;
  bytes: number;
  sha256: string;
  proxySha256: string;
  cardPath: string;
  sourceRef: string;
};

type P07ContactSheet = {
  path: string;
  dimensions: [number, number];
  items: number;
  sha256: string;
  bytes: number;
  reviewProxy: string;
  proxySha256: string;
  historyRole?: 'CURRENT_REVIEW_EVIDENCE' | 'EVIDENCE_ONLY';
};

type LineagePlaceholder = {
  id: string;
  kind: string;
  label: string;
  relationState: 'PLANNED_PLACEHOLDER' | 'DEFINED';
  materializationState: 'PLANNED' | 'REGISTERED' | 'GENERATED';
};

type LineageScene = {
  id: string;
  number: number;
  act: string;
  actTitle: string;
  phaseId: string;
  storySequenceId: string;
  slugline: string;
  scriptExcerpt: string;
  scriptText: string;
  scriptBlocks: DocumentBlock[];
  scriptCharacterCount: number;
  sourceLineStart: number;
  sourceLineEnd: number;
  sourceRef: string;
  time: string;
  primaryLocation: string;
  zone: string;
  route: string;
  keyPropsAndState: string;
  stateIds: string[];
  continuity: string;
  packageId: string;
  packagePath: string;
  packageSha256: string;
  packageStatus: string;
  segmentCount: number;
  shotCount: number;
  authoringStatus: string;
  promptDefinitionStatus: string;
  episodeAssignment: { id: string; status: 'PROPOSED_NAVIGATION_ONLY' | 'CURRENT_EPISODE_PLAN'; label: string; episodeId: string; episodeUid: string };
  dialogue: {
    scene_id: string;
    line_count: number;
    locked_calibration_line_count: number;
    lines: Array<{
      id: string;
      type: string;
      speaker: string;
      text: string;
      sourceStatus: string;
      productionLockStatus: string;
      productionAssetId: string;
      productionShotId: string;
    }>;
  };
  characters: Array<{ id: string; name: string; type: string; assetRefs: string[] }>;
  locations: Array<{ id: string; name: string; fact: string; lock: string; assetRefs: string[] }>;
  visualAssetRefs: string[];
  materialAssetRefs: string[];
  characterAssetRefs: string[];
  locationAssetRefs: string[];
  propAssetRefs: string[];
  audioAssetRefs: string[];
  shotRefs: string[];
  outputArtifactRefs: string[];
  milestonePlan: {
    storyboards: StoryboardArtifact[];
    storyboardPlanCount: number;
    storyboardMaterializedCount: number;
    animatic: { id: string; path: string; state: 'PLANNED'; approval: string };
  };
  promptRefs: string[];
  placeholders: LineagePlaceholder[];
  blockedAssetRefs: string[];
  issueRefs: string[];
  nextAction: string;
  relationStatus: 'BLOCKED' | 'DEFINED' | 'PLANNED';
};

type AuthorityClass = 'A' | 'F' | 'L' | 'U';

type NarrativeClaim = {
  class: AuthorityClass;
  text: string;
  evidenceRefs: string[];
};

type NarrativeEvidence = {
  ref: string;
  sourceKind: 'SCREENPLAY' | 'ADAPTATION_AUDIT' | 'CONTINUITY_MATRIX' | 'EPISODE_REGISTRY' | 'PROJECT_RULE';
  sourceTitle: string;
  sourcePath: string;
  sourceSha256: string;
  locator: string;
  lineStart: number | null;
  lineEnd: number | null;
  displayFormat: 'MARKDOWN' | 'JSON';
  excerpt: string;
  excerptSha256: string;
  sceneIds: string[];
  episodeIds: string[];
  internalTarget: { storyView: 'audit' | 'logic' | 'story-structure' | 'timeline' | 'structure' | 'case' | 'cause' | 'script' | 'episodes'; sceneId: string | null; episodeId: string | null; anchorId: string | null; causeChainId?: string | null } | null;
  reviewUse: string;
};

type CausalChain = {
  id: string;
  title: string;
  setupBeatIds: string[];
  payoffBeatIds: string[];
  setupSceneIds: string[];
  payoffSceneIds: string[];
  status: string;
  mustPreserve: string;
  sourceRef: string;
};

type SpatialEvidence = {
  version: string;
  sourceRef: string;
  sourceSha256: string;
  orientation: string;
  mapCards: Array<{ id: string; locationIds: string[]; label: string; imageUrl: string; note: string }>;
  locations: Array<{ id: string; name: string; zone: string; pos: [number, number]; entrance: string; fact: string; lock: string }>;
  locationPackages: Array<{
    id: string;
    name: string;
    factBoundary: string;
    lockBoundary: string;
    zones: Array<{ id: string; name: string; fact: string; lock: string }>;
    cameras: Array<{ id: string; from: string; looks: string; use: string }>;
  }>;
  sceneRouteLocks: Array<{
    sceneId: string;
    locationIds: string[];
    orderedZones: string[];
    objectRoutes?: Array<{ object: string; from: string; to?: string; via?: string; mustNotMergeWith?: string }>;
    evidenceRoutes?: string[];
    lock?: string;
  }>;
};

type StorySequence = {
  id: string;
  order: number;
  legacyPhaseId: string;
  title: NarrativeClaim;
  sceneIds: string[];
  sceneStart: string;
  sceneEnd: string;
  sceneCount: number;
  shotCount: number;
  episodeIds: string[];
  actLabels: string[];
  estimatedDurationSeconds: number | null;
  timingStatus: 'UNCONFIRMED';
  summary: NarrativeClaim;
  structuralRole: NarrativeClaim;
  inputState: NarrativeClaim[];
  turningPoint: { event: NarrativeClaim; structuralMeaning: NarrativeClaim };
  outputState: NarrativeClaim[];
  audienceKnowledge: NarrativeClaim;
  visualGrammar: NarrativeClaim;
  editorialRhythm: NarrativeClaim;
  constraints: NarrativeClaim[];
  decisionStatus: 'UNKNOWN';
  decision: null;
  reviewQuestion: NarrativeClaim;
};

type ReviewSnapshot = {
  schemaVersion: string;
  snapshotId: string;
  snapshotDate: string;
  scope: {
    storyActs: number;
    storyScenes: number;
    calibrationScenes: string[];
    remainingScenes: string[];
    executionScriptStatus: string;
    remainingUpstreamReadiness: 'WAITING' | 'READY' | 'BLOCKED';
    episodePlanStatus: 'PROPOSAL' | 'CURRENT';
    episodePlanAuthoredCount: number;
    episodeCount: number;
    episodeCountSemantics: 'AUTHORED_PLAN_CARDINALITY_NOT_FORMAL_DENOMINATOR';
    formalEpisodeDenominatorState: 'UNKNOWN';
    formalEpisodeDenominator: null;
    episodeDuration: string;
    frame: string;
    productionMapVersion: string;
  };
  statusModel: Record<string, string[] | string>;
  sources: Record<string, string>;
  coverage: Coverage;
  unknowns: string[];
  executionExpansion: {
    packageId: string;
    sceneCount: number;
    calibrationSceneCount: number;
    remainingSceneCount: number;
    shotCardCount: number;
    executableShotDefinitionCount: number;
    waitingShotPlanCount: number;
    structureCardCount: number;
    executableSceneCount: number;
    structuralWaitingSceneCount: number;
    structuralWaitingSceneIds: string[];
    historicalStructuralWaitingSceneIds?: string[];
    calibrationShotCount: number;
    remainingShotCount: number;
    remainingSegmentCount: number;
    lineMappingCount: number;
    remainingLineCount: number;
    authoringStatus: string;
    upstreamReadiness: 'WAITING' | 'READY' | 'BLOCKED';
    lifecycleState: string;
    canFlowDownstream: boolean;
    flowBlockReasons: string[];
    technicalReasonCodes: string[];
    plannedOutputCounts: Record<string, number>;
    promptDefinitionCounts: Record<string, number>;
    materialization: Record<string, { planned: number; materialized: number }>;
    materializationBoundary: string;
    sourceRef: string;
  };
  audioExecution: {
    existingDirectCallCount: number;
    existingMaterializedCount: number;
    existingPlannedCount: number;
    existingEvidenceOnlyCount: number;
    remainingVoiceMasterCallCount: number;
    remainingDialogueCallCount: number;
    remainingCallCount: number;
    remainingMaterializedCount: number;
    remainingUnmaterializedCount: number;
    remainingWaitingUpstreamCount: number;
    remainingRightsUnknownCount: number;
    structuralWaitingLineCount: number;
    structuralWaitingSpokenCount: number;
    structuralWaitingTitleCardCount: number;
    structuralWaitingSceneCount: number;
    structuralWaitingSceneIds: string[];
    totalExecutionCallCount: number;
    upstreamReadiness: 'WAITING';
    projectRightsGate: 'UNKNOWN';
    lifecycleState: 'WAITING_UPSTREAM';
    canFlowDownstream: false;
    flowBlockReasons: string[];
    technicalReasonCodes: string[];
    promptVersion: string;
    ranges: { voiceMasters: 'V11-V24'; dialogue: 'D14-D125' };
    materialization: {
      voiceMasters: { planned: number; materialized: number };
      dialogue: { planned: number; materialized: number };
      remainingTotal: { planned: number; materialized: number };
    };
    sourceRef: string;
    sourceSha256: string;
    materializationBoundary: string;
  };
  storySources: {
    evidenceOrder: string[];
    audio: {
      title: string;
      sourcePath: string;
      audioUrl: string;
      duration: string;
      durationSeconds: number;
      byteSize: number;
      sha256: string;
      reviewUse: string;
    };
    transcript: {
      title: string;
      sourcePath: string;
      sha256: string;
      byteSize: number;
      lineCount: number;
      characterCount: number;
      documentCharacterCount: number;
      payloadCharacterCount: number;
      rawMarkdown: string;
      segmentCount: number;
      introBlocks: DocumentBlock[];
      sections: Array<{
        id: string;
        title: string;
        sourceLine: number;
        segmentIds: string[];
        segmentCount: number;
        startTimecode: string;
        endTimecode: string;
      }>;
      segments: Array<{
        id: string;
        sectionId: string;
        timecode: string;
        seconds: number;
        sourceLine: number;
        text: string;
        characterCount: number;
      }>;
    };
    outline: {
      title: string;
      authority: 'AUXILIARY_ONLY';
      sourcePath: string;
      sha256: string;
      byteSize: number;
      lineCount: number;
      characterCount: number;
      rawMarkdown: string;
      blocks: DocumentBlock[];
    };
  };
  creativeLineage: {
    policy: Record<string, string>;
    globalBaselineAssetRefs: string[];
    scriptDocument: {
      title: string;
      sourcePath: string;
      sha256: string;
      byteSize: number;
      lineCount: number;
      characterCount: number;
      rawMarkdown: string;
      sceneCount: number;
      intro: { id: string; title: string; sourceLineStart: number; sourceLineEnd: number; rawText: string; blocks: DocumentBlock[] };
      appendix: { id: string; title: string; sourceLineStart: number; sourceLineEnd: number; rawText: string; blocks: DocumentBlock[] };
    };
    storyStructure: {
      schemaVersion: string;
      datasetId: string;
      title: string;
      structureStatus: string;
      reviewStatus: 'UNKNOWN';
      planStatus: 'PROPOSAL' | 'CURRENT';
      retiredEpisodeUids?: string[];
      authorityModel: Record<AuthorityClass, string>;
      sourcePath: string;
      sourceSha256: string;
      acts: Array<{ id: string; order: number; title: NarrativeClaim; sceneIds: string[]; sceneStart: string; sceneEnd: string }>;
      sequences: StorySequence[];
      evidenceCatalog?: Record<string, NarrativeEvidence>;
      episodeDecisions: Array<{
        episodeId: string;
        sceneIds: string[];
        sequenceIds: string[];
        actLabels: string[];
        episodeUid: string;
        title: string;
        mapping: { class: 'A'; status: 'PROPOSED_NAVIGATION_ONLY' | 'CURRENT_EPISODE_PLAN' };
        openingHook: NarrativeClaim;
        coreAdvance: NarrativeClaim;
        endingCliffhanger: NarrativeClaim;
        reviewDossier: EpisodeReviewDossier;
        review: { decisionStatus: 'UNKNOWN'; decision: null; question: NarrativeClaim };
      }>;
      integrityRules: Record<string, string | boolean>;
      coverage: { sequenceCount: number; sceneCount: number; shotCount: number; episodeCount: number; actCount: number; decisionsReviewed: number; evidenceReferenceOccurrenceCount: number; uniqueEvidenceReferenceCount: number; resolvedEvidenceReferenceCount: number; evidenceSourceCount: number };
    };
    storyOverview: StoryOverview;
    phases: Array<{ id: string; storySequenceId: string; sceneIds: string[]; packageIds: string[]; episodeStatus: 'PROPOSED_NAVIGATION_ONLY' | 'CURRENT_EPISODE_PLAN'; sceneCount: number; definedShotCount: number }>;
    scenes: LineageScene[];
    causalChains?: CausalChain[];
    spatialEvidence?: SpatialEvidence;
    episodes: Array<{
      id: string;
      episodeUid: string;
      canonicalScopeId?: string;
      displayId: string;
      sceneStart: string;
      sceneEnd: string;
      sceneIds: string[];
      sceneCount: number;
      targetRuntimeMinutes: string;
      structureStatus: 'PROPOSED_NAVIGATION_ONLY' | 'CURRENT_EPISODE_PLAN';
      hookOutlineStatus: 'UNKNOWN' | 'AUTHORED_PROPOSAL' | 'AUTHORED_CURRENT';
      endingCliffhangerStatus: 'UNKNOWN' | 'AUTHORED_PROPOSAL' | 'AUTHORED_CURRENT';
      acts: string[];
      scriptCharacterCount: number;
      sourceRef: string;
      reviewDossier: EpisodeReviewDossier;
    }>;
    coverage: {
      storyBeats: number;
      scriptScenes: number;
      episodeMappingsKnown: number;
      episodeMappingPlaceholders: number;
      scenesWithDefinedShots: number;
      sceneShotlistPlaceholders: number;
      registeredShots: number;
      registeredStoryboards: number;
      materializedStoryboards: number;
      plannedAnimatics: number;
      registeredAssetLinks: number;
      registeredPromptLinks: number;
      registeredDialogueLines: number;
    };
  };
  productionModel: ProductionModel;
  workItems: WorkItem[];
  visualAssets: Asset[];
  audioAssets: Asset[];
  shots: Shot[];
  p07: {
    milestone: 'P07';
    description: string;
    plannedCount: number;
    expectedCount: number;
    materializedCount: number;
    evidenceOnlyCount: number;
    evidenceOnlyShotIds: string[];
    reviewDecision: 'PENDING' | 'RELEASED' | 'REVISION_REQUIRED' | 'DO_NOT_USE' | 'NOT_APPLICABLE';
    releasedCount: number;
    reviewRollupSource: string;
    requiredDimensions: [number, number];
    generatedAt: string;
    qaReportPath: string;
    qaReportSha256: string;
    manualQaSourceRef: string;
    milestoneSourceRef: string;
    contactSheets: Record<string, P07ContactSheet>;
    scenes: Array<{ scene: string; expected: number; reviewRequired: number; materialized: number; qaPass: number; reviewDecision: string; lifecycleState: string; released: number; preflight: { status: string; role: string }; contactSheet: P07ContactSheet }>;
    storyboards: StoryboardArtifact[];
    nextGate: string;
  };
  outputArtifacts: Array<{
    id: string;
    shotId: string;
    scene: string;
    variant: string;
    path: string;
    outputState: 'PRESENT' | 'NOT_PRODUCED';
    reviewDecision: string;
    projectRightsGate: string;
    historyRole: string;
    lifecycleState: string;
    canFlowDownstream: boolean;
    flowBlockReasons: string[];
    sha256: string | null;
    sourceRef: string;
  }>;
};

type WorkspaceView = 'overview' | 'story' | 'settings' | 'materials' | 'pipeline' | 'system';
type LegacyWorkspaceView = 'assets' | 'targets' | 'shots' | 'work';

type SearchResult = {
  episodePlanRevision?: string;
  kind: '故事设定' | '设定关系' | '故事' | '逐字稿' | '故事梗概' | '原文审计' | '因果链' | '空间证据' | '剧本正文' | '分集导航' | '场景包' | '结构卡' | '制作影响' | '素材需求' | '素材' | '资产族' | '镜头' | '目标' | '问题' | '任务' | '后期任务';
  id: string;
  title: string;
  view: WorkspaceView | LegacyWorkspaceView;
  storyView?: 'audit' | 'logic' | 'story-structure' | 'source' | 'script' | 'episodes' | 'timeline' | 'structure' | 'cause' | 'case' | 'map';
  structureSection?: StoryOverviewSectionId;
  materialMode?: 'classification' | 'episodes' | 'requirements' | 'assets' | 'space' | 'production' | 'relations';
  sectionId?: string;
  sceneId?: string;
  episodeId?: string;
  episodeUid?: string;
  episodeIdentityState?: 'CURRENT' | 'HISTORICAL_DISPLAY_ONLY';
  anchorId?: string;
  auditBeatId?: string;
  causeChainId?: string;
  mapLocationId?: string;
  structureSceneId?: string;
  actionLabel?: string;
  group?: 'business' | 'evidence' | 'legacy';
  matchTier?: 'exact' | 'prefix' | 'relation' | 'fulltext';
};

type NavigationOrigin = { label: string };
type OverlayHistory = { kind: 'lightbox' | 'evidence' | 'search'; depth: number };
type PendingProductionLocation = {
  shotId: string | null;
  sceneId: string | null;
  workPackageId: string | null;
  workItemId: string | null;
  familyId: string | null;
  versionId: string | null;
  materialRequirementId: string | null;
  phaseId: ProductionPhaseId | null;
  gateId: ProductionGateId | null;
  scopeType: string | null;
  objectId: string | null;
  legacyStage: string | null;
  legacyTarget: string | null;
};
type PagedProductionLoadRequest = {
  resource: PagedProductionResource;
  filters?: PagedProductionFilters;
  mode?: 'initial' | 'next' | 'all';
  force?: boolean;
};
type PagedProductionDataState = {
  windows: Record<string, PagedProductionWindow>;
};
type PagedProductionLoader = (request: PagedProductionLoadRequest) => Promise<ProductionModel | null>;
type ReviewHistoryState = Record<string, unknown> & {
  reviewOrigin?: NavigationOrigin;
  reviewRestore?: { mainTop: number; readerTop: number; searchOpen: boolean; focusSelector?: string | null };
  reviewOverlay?: OverlayHistory;
  evidenceRequest?: unknown;
};

const workspaceViews: Array<{ id: WorkspaceView; index: string; title: string; short: string; desc: string }> = [
  { id: 'overview', index: '当前', title: '当前工作', short: '当前', desc: '全剧状态与当下可开展工作' },
  { id: 'story', index: '故事', title: '故事创作', short: '故事', desc: '来源资料、故事结构与叙事拆解' },
  { id: 'settings', index: '设定', title: '故事设定', short: '设定', desc: '主体分类、空间设定与实体关系' },
  { id: 'materials', index: '素材', title: '素材管理', short: '素材', desc: '实体素材目录、集场筛选与统一素材信息卡' },
  { id: 'pipeline', index: '制作', title: '全剧制作', short: '制作', desc: '镜头拆解与生成、场景剪辑、分集成片' },
  { id: 'system', index: '管理', title: '系统管理', short: '管理', desc: '使用与初始化、系统配置、数据与运行' },
];

const storyViews: StoryView[] = ['source', 'story-structure', 'logic', 'audit'];

const productionPhaseIds: ProductionPhaseId[] = ['PREVIS', 'SHOT_FINISH', 'SCENE_FINISH', 'EPISODE_FINISH', 'SERIES_DELIVERY'];
const productionGateIds: ProductionGateId[] = [
  'SHOT_PLAN_INPUT_LOCK', 'STORYBOARD_DIALOGUE', 'ANIMATIC_LOCK',
  'KEYFRAMES', 'SHOT_VIDEO', 'SHOT_LOCK',
  'PICTURE_LOCK', 'SOUND_MIX_SUBTITLES', 'SCENE_QA',
  'EPISODE_ASSEMBLY', 'EPISODE_REVIEW', 'EPISODE_TECH_QC',
  'SERIES_CONTINUITY', 'RIGHTS_SAFETY_TECH', 'DELIVERY_ARCHIVE',
];

function productionSlug(value: string) {
  return value.toLowerCase().replaceAll('_', '-');
}

function phaseIdFromLocation(value: string | null): ProductionPhaseId | null {
  return productionPhaseIds.find((id) => id === value || productionSlug(id) === value) || null;
}

function gateIdFromLocation(value: string | null): ProductionGateId | null {
  return productionGateIds.find((id) => id === value || productionSlug(id) === value) || null;
}

function legacyProductionGate(value: string | null): { phaseId: ProductionPhaseId; gateId: ProductionGateId } | null {
  const mapping: Record<string, { phaseId: ProductionPhaseId; gateId: ProductionGateId }> = {
    W02: { phaseId: 'PREVIS', gateId: 'STORYBOARD_DIALOGUE' }, STEP02: { phaseId: 'PREVIS', gateId: 'STORYBOARD_DIALOGUE' }, P07: { phaseId: 'PREVIS', gateId: 'STORYBOARD_DIALOGUE' }, P08: { phaseId: 'PREVIS', gateId: 'STORYBOARD_DIALOGUE' },
    W03: { phaseId: 'PREVIS', gateId: 'ANIMATIC_LOCK' }, STEP03: { phaseId: 'PREVIS', gateId: 'ANIMATIC_LOCK' }, P09: { phaseId: 'PREVIS', gateId: 'ANIMATIC_LOCK' },
    W04: { phaseId: 'SHOT_FINISH', gateId: 'KEYFRAMES' }, STEP04: { phaseId: 'SHOT_FINISH', gateId: 'KEYFRAMES' }, P10: { phaseId: 'SHOT_FINISH', gateId: 'KEYFRAMES' }, KFA: { phaseId: 'SHOT_FINISH', gateId: 'KEYFRAMES' }, KFB: { phaseId: 'SHOT_FINISH', gateId: 'KEYFRAMES' },
    W05: { phaseId: 'SHOT_FINISH', gateId: 'SHOT_VIDEO' }, STEP05: { phaseId: 'SHOT_FINISH', gateId: 'SHOT_VIDEO' }, P11: { phaseId: 'SHOT_FINISH', gateId: 'SHOT_VIDEO' },
    W06: { phaseId: 'SHOT_FINISH', gateId: 'SHOT_LOCK' }, STEP06: { phaseId: 'SHOT_FINISH', gateId: 'SHOT_LOCK' }, P12: { phaseId: 'SHOT_FINISH', gateId: 'SHOT_LOCK' },
    W07: { phaseId: 'SCENE_FINISH', gateId: 'SOUND_MIX_SUBTITLES' }, STEP07: { phaseId: 'SCENE_FINISH', gateId: 'SOUND_MIX_SUBTITLES' }, P13: { phaseId: 'SCENE_FINISH', gateId: 'SOUND_MIX_SUBTITLES' },
    W08: { phaseId: 'EPISODE_FINISH', gateId: 'EPISODE_ASSEMBLY' }, STEP08: { phaseId: 'EPISODE_FINISH', gateId: 'EPISODE_ASSEMBLY' }, P14: { phaseId: 'EPISODE_FINISH', gateId: 'EPISODE_ASSEMBLY' },
    W09: { phaseId: 'SERIES_DELIVERY', gateId: 'SERIES_CONTINUITY' }, STEP09: { phaseId: 'SERIES_DELIVERY', gateId: 'SERIES_CONTINUITY' }, P15: { phaseId: 'SERIES_DELIVERY', gateId: 'SERIES_CONTINUITY' },
  };
  return value ? mapping[value.toUpperCase()] || null : null;
}

function legacyProductionStep(value: string | null) {
  const mapping: Record<string, string> = {
    W01: 'W01', STEP01: 'W01', P04B: 'W01',
    W02: 'W02', STEP02: 'W02', P07: 'W02', P08: 'W02',
    W03: 'W03', STEP03: 'W03', P09: 'W03',
    W04: 'W04', STEP04: 'W04', P10: 'W04', KFA: 'W04', KFB: 'W04',
    W05: 'W05', STEP05: 'W05', P11: 'W05',
    W06: 'W06', STEP06: 'W06', P12: 'W06',
    W07: 'W07', STEP07: 'W07', P13: 'W07',
    W08: 'W08', STEP08: 'W08', P14: 'W08',
    W09: 'W09', STEP09: 'W09', P15: 'W09',
  };
  return value ? mapping[value.toUpperCase()] || null : null;
}

function inferLegacyProductionStage(...values: Array<string | null>) {
  for (const value of values) {
    const match = value?.toUpperCase().match(/(?:^|:)(P04B|P0[7-9]|P1[0-5]|W0[1-9]|STEP0[1-9]|KFA|KFB)(?::|$)/);
    if (match) return match[1];
  }
  return null;
}

function normalizedStoryView(value: string | null, legacyStructureRoute = false, scopedStructureRoute = false, sceneScope = false): StoryView | null {
  if (legacyStructureRoute) return 'logic';
  if (value === 'audit' || value === 'script' || value === 'episodes') return 'audit';
  if (value === 'logic' || value === 'decomposition' || value === 'cause') return sceneScope ? 'audit' : 'logic';
  if (value === 'story-structure' || value === 'case') return 'story-structure';
  if (value === 'timeline' || value === 'structure') return scopedStructureRoute ? 'logic' : 'story-structure';
  if (value === 'source') return 'source';
  return null;
}

function storySegmentIdFromPhase(phaseId: string) {
  const match = phaseId.match(/^P(\d{2})$/);
  return match ? `SEQ-${match[1]}` : phaseId;
}

function phaseIdFromStorySegment(storySegmentId: string | null) {
  const match = storySegmentId?.match(/^SEQ-(\d{2})$/);
  return match ? `P${match[1]}` : null;
}

function uiScopeType(value: string | null | undefined): UiScopeType | null {
  return value === 'SHOT' || value === 'SCENE' || value === 'EPISODE' || value === 'PROJECT' ? value : null;
}

type WorkItem = {
  id: string;
  state: 'blocked' | 'ready' | 'waiting' | 'decision' | 'resolved';
  stateText: string;
  title: string;
  fact: string;
  next: string;
  userAction: string;
  responsibleParty: 'USER_DECISION_REQUIRED' | 'AGENT_CAN_EXECUTE' | 'WAITING_EXTERNAL' | 'DESTRUCTIVE_CONFIRMATION_REQUIRED' | 'NO_CURRENT_ACTION' | 'CODEX_COMPLETE';
  refs: string[];
  target?: string;
  acceptance: string[];
  sourceRef: string;
  requiresDestructiveConfirmation: boolean;
};

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function Home() {
  const instance = useInstanceProfile();
  const [reviewData, setReviewData] = useState<ReviewSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [pagedProduction, setPagedProduction] = useState<PagedProductionDataState>({ windows: {} });
  const reviewDataRef = useRef<ReviewSnapshot | null>(null);
  const pagedProductionRef = useRef<PagedProductionDataState>({ windows: {} });
  const productionRequestsRef = useRef(new Map<string, Promise<ProductionModel | null>>());

  const commitPagedProduction = useCallback((next: PagedProductionDataState) => {
    pagedProductionRef.current = next;
    setPagedProduction(next);
  }, []);

  const updatePagedWindow = useCallback((key: string, update: (current: PagedProductionWindow) => PagedProductionWindow, fallback: PagedProductionWindow) => {
    const currentState = pagedProductionRef.current;
    const nextWindow = update(currentState.windows[key] || fallback);
    commitPagedProduction({ windows: { ...currentState.windows, [key]: nextWindow } });
    return nextWindow;
  }, [commitPagedProduction]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v8/ui/bootstrap', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ data: ReviewSnapshot }>;
      })
      .then((payload) => {
        const next = { ...payload.data, productionModel: normalizeProductionModel(payload.data.productionModel) };
        reviewDataRef.current = next;
        commitPagedProduction({ windows: {} });
        setReviewData(next);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== 'AbortError') setLoadError(reason instanceof Error ? reason.message : '数据读取失败');
      });
    return () => controller.abort();
  }, [attempt, commitPagedProduction]);

  const loadProduction = useCallback<PagedProductionLoader>((request) => {
    const filters = request.filters || {};
    const key = pagedProductionWindowKey(request.resource, filters);
    const fallback = emptyPagedProductionWindow(request.resource, filters);
    const currentWindow = pagedProductionRef.current.windows[key] || fallback;
    const currentModel = reviewDataRef.current?.productionModel || null;
    if (!request.force) {
      if (request.mode === 'next' && currentWindow.initialized && !currentWindow.hasMore) return Promise.resolve(currentModel);
      if (request.mode !== 'next' && currentWindow.initialized && (request.mode !== 'all' || !currentWindow.hasMore)) return Promise.resolve(currentModel);
    }
    const existing = productionRequestsRef.current.get(key);
    if (existing) return existing;

    const task = (async () => {
      updatePagedWindow(key, (windowState) => ({ ...windowState, loading: true, error: '' }), fallback);
      let cursor = request.force || !currentWindow.initialized ? null : currentWindow.nextCursor;
      let loaded = request.force || !currentWindow.initialized ? 0 : currentWindow.loaded;
      const seenCursors = new Set<string>();
      try {
        do {
          const response = await fetch(pagedProductionUrl(request.resource, filters, cursor));
          if (!response.ok) {
            const detail = await response.json().catch(() => null) as { error?: string; message?: string } | null;
            throw new Error(detail?.error || detail?.message || `HTTP ${response.status}`);
          }
          const payload = await response.json() as PagedProductionPayload;
          const currentData = reviewDataRef.current;
          if (!currentData) throw new Error('基础快照尚未就绪');
          if (payload.snapshotId !== currentData.snapshotId) {
            throw new Error(`分页快照 ${payload.snapshotId} 与当前快照 ${currentData.snapshotId} 不一致`);
          }
          const nextModel = mergePagedProductionModel(currentData.productionModel, payload.page);
          const nextData = { ...currentData, productionModel: nextModel };
          reviewDataRef.current = nextData;
          setReviewData(nextData);
          loaded += payload.count;
          cursor = payload.nextCursor;
          updatePagedWindow(key, (windowState) => ({
            ...windowState,
            initialized: true,
            loading: true,
            error: '',
            loaded,
            total: payload.total,
            hasMore: payload.hasMore,
            nextCursor: payload.nextCursor,
          }), fallback);
          if (cursor) {
            if (seenCursors.has(cursor)) throw new Error('分页游标重复，已停止读取以避免循环');
            seenCursors.add(cursor);
          }
        } while (request.mode === 'all' && cursor);
        return reviewDataRef.current?.productionModel || null;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : '分页制作数据读取失败';
        updatePagedWindow(key, (windowState) => ({ ...windowState, loading: false, error: message }), fallback);
        return null;
      } finally {
        updatePagedWindow(key, (windowState) => ({ ...windowState, loading: false }), fallback);
      }
    })().finally(() => productionRequestsRef.current.delete(key));
    productionRequestsRef.current.set(key, task);
    return task;
  }, [updatePagedWindow]);

  if (!reviewData) return <main className="review-bootstrap-state"><section><span className="brand-mark">{instance.branding.mark}</span><small>LOCAL PRODUCTION DESK</small><h1>{loadError ? '审阅快照暂时无法读取' : '正在装入制作审阅台'}</h1><p>{loadError ? `本地只读接口返回异常：${loadError}` : '先装入结构与索引；依据正文会在打开时读取。'}</p>{loadError && <button type="button" onClick={() => { setLoadError(''); setAttempt((value) => value + 1); }}>重新读取</button>}</section></main>;
  if (!reviewData.creativeLineage.scenes.length && !reviewData.productionModel.materialRequirements?.length) return <EmptyInstanceDesk snapshotId={reviewData.snapshotId}/>;
  return <ReviewApp reviewData={reviewData} pagedProduction={pagedProduction} onNeedProduction={loadProduction} />;
}

function ReviewApp({ reviewData, pagedProduction, onNeedProduction }: { reviewData: ReviewSnapshot; pagedProduction: PagedProductionDataState; onNeedProduction: PagedProductionLoader }) {
  const instance = useInstanceProfile();
  const [activeView, setActiveView] = useState<WorkspaceView>((workspaceViews.some(item=>item.id===instance.capabilities.landingView)?instance.capabilities.landingView:'overview') as WorkspaceView);
  const [storyView, setStoryView] = useState<StoryView>('source');
  const [adaptationAudit, setAdaptationAudit] = useState<AdaptationAudit | null>(null);
  const [authoringScenes, setAuthoringScenes] = useState<LineageScene[]>([]);
  const genericAuthoring=Boolean((reviewData.productionModel as typeof reviewData.productionModel&{genericAuthoring?:{enabled?:boolean;roots?:unknown[]}}).genericAuthoring);
  const [genericSourceFocus,setGenericSourceFocus]=useState<GenericSourceFocus|null>(null);
  const [storySourcesDetail, setStorySourcesDetail] = useState<ReviewSnapshot['storySources'] | null>(null);
  const [storySourcesLoading, setStorySourcesLoading] = useState(false);
  const [storySourcesError, setStorySourcesError] = useState('');
  const [storySourcesAttempt, setStorySourcesAttempt] = useState(0);
  const [adaptationSnapshotId, setAdaptationSnapshotId] = useState(reviewData.snapshotId);
  const [storyConfirmations, setStoryConfirmations] = useState<StoryConfirmationTarget[]>([]);
  const [audioVerifications, setAudioVerifications] = useState<AudioVerificationTarget[]>([]);
  const [sceneReviewDossiers, setSceneReviewDossiers] = useState<SceneReviewDossier[]>([]);
  const [adaptationAuditError, setAdaptationAuditError] = useState('');
  const [adaptationAuditAttempt, setAdaptationAuditAttempt] = useState(0);
  const [auditBeatId, setAuditBeatId] = useState<string | null>(null);
  const [auditSceneId, setAuditSceneId] = useState<string | null>(null);
  const [auditVerificationIssueId, setAuditVerificationIssueId] = useState<string | null>(null);
  const [causeChainId, setCauseChainId] = useState<string | null>(null);
  const [logicGroup, setLogicGroup] = useState<EpisodeCriterionId>('opening-boundary');
  const [logicItem, setLogicItem] = useState('incoming-handoff');
  const [storyStructureSection, setStoryStructureSection] = useState<StoryOverviewSectionId>('overview');
  const [narrativeSection,setNarrativeSection] = useState<NarrativeOverviewSection>('documents');
  const [storySourceMode, setStorySourceMode] = useState<StorySourceMode>('transcript');
  const [transcriptSectionId, setTranscriptSectionId] = useState(reviewData.storySources.transcript.sections[0]?.id || '');
  const [episodeId, setEpisodeId] = useState(reviewData.creativeLineage.episodes[0]?.id || '');
  const [readerAnchor, setReaderAnchor] = useState<string | null>(null);
  const [phaseId, setPhaseId] = useState('P01');
  const [, setStorySceneId] = useState(reviewData.creativeLineage.scenes[0]?.id || '');
  const [materialCenterState, setMaterialCenterState] = useState<MaterialCenterViewState>(defaultMaterialCenterState);
  const [currentWorkView, setCurrentWorkView] = useState<CurrentWorkViewState>({...defaultCurrentWorkView,actor:instance.capabilities.preferredCollaborator==='HUMAN_FIRST'?'HUMAN':instance.capabilities.preferredCollaborator==='AI_FIRST'?'AI':'ALL'});
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [navigationOrigin, setNavigationOrigin] = useState<NavigationOrigin | null>(null);
  const [navigationError, setNavigationError] = useState('');
  const [blockedPersistentRoute, setBlockedPersistentRoute] = useState<'EPISODE' | 'MATERIAL_EPISODE' | 'ASSET_EPISODE' | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [productionContext, setProductionContext] = useState<ProductionContext>(() => !reviewData.productionModel.shots.length ? {shotId:'',workPackageId:'',workItemId:null,familyId:null,versionId:null,phaseId:'PREVIS',gateId:'SHOT_PLAN_INPUT_LOCK'} : resolveProductionContext(reviewData.productionModel, {
    shotId: reviewData.p07.storyboards.find((item) => item.reviewDecision === 'PENDING')?.shotId || reviewData.p07.storyboards[0]?.shotId || '',
    phaseId: 'PREVIS',
    gateId: 'SHOT_PLAN_INPUT_LOCK',
  }));
  const {
    shotId: focusShotId,
    workPackageId: selectedWorkPackageId,
    workItemId: selectedWorkItemId,
    familyId: selectedFamilyId,
    versionId: selectedVersionId,
    phaseId: selectedProductionPhaseId,
    gateId: selectedProductionGateId,
  } = productionContext;
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement | null>(null);
  const lightboxOpenerRef = useRef<HTMLElement | null>(null);
  const previousLightboxRef = useRef<string | null>(null);
  const searchToggleRef = useRef<HTMLButtonElement | null>(null);
  const mobileMoreRef = useRef<HTMLDivElement | null>(null);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const readerScrollRef = useRef<HTMLDivElement | null>(null);
  const storyAudioRef = useRef<HTMLAudioElement | null>(null);
  const [operationalProjection, setOperationalProjection] = useState<OperationalStateProjection | null>(null);
  const restoringHistoryRef = useRef(false);
  const pendingProductionIntentRef = useRef<PendingProductionLocation | null>(null);
  const productionModel = useMemo(() => {
    const projected = applyOperationalProjection(reviewData.productionModel, operationalProjection);
    const existingRelations = (projected as ProductionModel & { materialStoryRelations?: unknown }).materialStoryRelations;
    const spatial = reviewData.creativeLineage.spatialEvidence;
    if (existingRelations || !spatial) return projected;
    return {
      ...projected,
      materialStoryRelations: {
        schemaVersion: '1.0',
        businessOrder: 'EPISODE_TO_SCENE_TO_CURRENT_SHOT',
        currentShotState: (projected.counts.currentP07ShotPlans || 0) > 0 ? 'DECLARED' : 'UNKNOWN',
        currentShotCount: projected.counts.currentP07ShotPlans || 0,
        historicalShotCount: projected.counts.historicalP07ShotIdentities || projected.counts.shots,
        pendingP07ReauthoringSceneCount: projected.counts.pendingP07ReauthoringScenes || projected.counts.scenes,
        worldOverview: {
          recordKind: 'PRODUCTION_REFERENCE',
          businessCategoryPrimary: '场景',
          businessCategorySecondary: '空间证据',
          ...spatial,
        },
      },
    } as ProductionModel;
  }, [operationalProjection, reviewData.creativeLineage.spatialEvidence, reviewData.productionModel]);
  const p07ReleasedCount = operationalProjection?.reviewRollups?.P07?.released ?? reviewData.p07.releasedCount;
  const reviewableStoryboardCount = Math.max(0, reviewData.p07.materializedCount - p07ReleasedCount);
  const storyStructure = reviewData.creativeLineage.storyStructure;
  const episodePlanIsCurrent = storyStructure.planStatus === 'CURRENT';
  const episodeRecordForRoute = useCallback((value: string | null | undefined) => {
    if (!value) return null;
    return reviewData.creativeLineage.episodes.find((item) => (
      episodePlanIsCurrent
        ? item.episodeUid === value || item.canonicalScopeId === value
        : item.id === value || item.displayId === value || item.episodeUid === value || item.canonicalScopeId === value
    )) || null;
  }, [episodePlanIsCurrent, reviewData.creativeLineage.episodes]);
  const episodeRouteId = useCallback((value: string | null | undefined) => {
    const episode = reviewData.creativeLineage.episodes.find((item) => (
      item.id === value || item.displayId === value || item.episodeUid === value || item.canonicalScopeId === value
    ));
    if (!episode) return value || '';
    return episodePlanIsCurrent ? episode.canonicalScopeId || episode.episodeUid : episode.displayId || episode.id;
  }, [episodePlanIsCurrent, reviewData.creativeLineage.episodes]);
  const storySources = storySourcesDetail || reviewData.storySources;
  const storySourcesReady = Boolean(storySourcesDetail || reviewData.storySources.transcript.segments.length || reviewData.storySources.outline.blocks.length);
  const storySequences = storyStructure.sequences;
  const causalChains = reviewData.creativeLineage.causalChains ?? [];
  const storyOverview = reviewData.creativeLineage.storyOverview;
  const { plan: resolvedEpisodePlan, error: episodePlanError } = useEpisodePlanContext(activeView === 'story', reviewData.snapshotId);
  const [narrativeLocationRevision, setNarrativeLocationRevision] = useState('');
  const narrativeCandidate = resolvedEpisodePlan?.content.narrativeRevision;
  const episodeDecisions = (resolvedEpisodePlan?.content.episodes || []).map((episode) => ({ ...episode, episodeId: episode.displayId,
    openingHook: {class: 'A' as const, text: episode.openingHook, evidenceRefs: []}, coreAdvance: {class: 'A' as const, text: episode.coreAdvance, evidenceRefs: []}, endingCliffhanger: {class: 'A' as const, text: episode.endingCliffhanger, evidenceRefs: []},
  }));
  const selectedEpisodeDecision = episodeDecisions.find((item) => item.episodeId === episodeId || item.episodeUid === episodeId) ?? episodeDecisions[0];
  const selectedEpisodeIndex = episodeDecisions.findIndex((item) => item.episodeUid === selectedEpisodeDecision?.episodeUid);
  const previousEpisodeDecision = selectedEpisodeIndex > 0 ? episodeDecisions[selectedEpisodeIndex - 1] : null;
  const nextEpisodeDecision = episodeDecisions[selectedEpisodeIndex + 1] || null;
  const selectedLogic = selectedEpisodeDecision
    ? normalizeLogicSelection(logicGroup, logicItem, selectedEpisodeDecision.reviewDossier)
    : { groupId: 'opening-boundary' as EpisodeCriterionId, itemId: 'incoming-handoff' };
  const assistantPageFocus: WorkFocus = ((): WorkFocus => {
    const base = { projectId: instance.projectId, snapshotId: reviewData.snapshotId, view: activeView };
    if (activeView === 'story') {
      if (storyView === 'logic' && selectedEpisodeDecision) return {
        ...base, view: 'logic', subjectType: 'EPISODE', subjectId: selectedEpisodeDecision.episodeUid,
        title: `叙事拆解 · ${selectedEpisodeDecision.episodeId}`,
        versionId: resolvedEpisodePlan?.revisionId,
        criterionId: selectedLogic.groupId, itemId: selectedLogic.itemId,
      };
      if (storyView === 'audit' && auditSceneId && !(narrativeCandidate && auditVerificationIssueId)) return {
        ...base, view: 'audit', subjectType: 'SCENE', subjectId: auditSceneId,
        title: `场级拆解 · ${narrativeCandidate?.scenes.find(scene=>scene.id===auditSceneId)?.displayId || auditSceneId}`,
        versionId: resolvedEpisodePlan?.content.narrativeRevision ? resolvedEpisodePlan.revisionId : storyConfirmations.find((target) => target.sceneId === auditSceneId)?.sceneContentHash,
        filters: { readerAnchor: readerAnchor || '', verificationIssueId: auditVerificationIssueId || '' },
      };
      if (genericAuthoring && storyView === 'source') return genericSourceFocus ? {...base,view:'source',subjectType:'SOURCE',subjectId:genericSourceFocus.id,title:genericSourceFocus.title,versionId:genericSourceFocus.revisionId} : {...base,view:'source',subjectType:'PROJECT',subjectId:instance.projectId,title:'故事来源资料'};
      if (storyView === 'source') return {
        ...base, view: 'source', subjectType: 'SOURCE',
        subjectId: storySourceMode === 'outline' ? 'outline' : readerAnchor?.startsWith('TR-') ? readerAnchor : transcriptSectionId,
        title: storySourceMode === 'outline' ? '来源资料 · 网友故事梗概' : `来源资料 · 逐字稿 ${transcriptSectionId}`,
        filters: { sourceMode: storySourceMode, sectionId: transcriptSectionId, readerAnchor: readerAnchor || '' },
      };
      return { ...base, view: storyView, subjectType: 'PROJECT', subjectId: instance.projectId,
        title: storyView === 'story-structure' ? '故事结构' : '故事创作', versionId: narrativeCandidate ? resolvedEpisodePlan?.revisionId : undefined, filters: { sectionId: narrativeCandidate ? narrativeSection : storyStructureSection } };
    }
    if (activeView === 'materials') return materialCenterState.requirementId ? {
      ...base, subjectType: 'MATERIAL', subjectId: materialCenterState.requirementId, title: '素材管理 · 当前素材',
      versionId: materialCenterState.versionId || undefined,
      references: materialCenterState.familyId ? [`family:${materialCenterState.familyId}`] : [],
    } : { ...base, subjectType: 'PROJECT', subjectId: instance.projectId, title: '素材管理',
      filters: { mode: materialCenterState.workspaceMode || 'classification', media: materialCenterState.mediaType,
        category: materialCenterState.category, episode: materialCenterState.episodeScope, scene: materialCenterState.sceneScope } };
    if (activeView === 'pipeline') return selectedWorkItemId ? {
      ...base, subjectType: 'WORK_ITEM', subjectId: selectedWorkItemId, title: `全剧制作 · ${publicRef(selectedWorkItemId)}`,
      versionId: selectedVersionId || undefined, references: selectedFamilyId ? [`family:${selectedFamilyId}`] : [],
      filters: { phaseId: selectedProductionPhaseId || '', gateId: selectedProductionGateId || '' },
    } : { ...base, subjectType: 'PROJECT', subjectId: instance.projectId, title: '全剧制作',
      filters: { phaseId: selectedProductionPhaseId || '', gateId: selectedProductionGateId || '' } };
    if (activeView === 'settings') return { ...base, subjectType: 'PROJECT', subjectId: instance.projectId, title: '故事设定' };
    if (activeView === 'system') return { ...base, subjectType: 'GUIDE', subjectId: 'guide', title: '系统管理' };
    return { ...base, subjectType: 'PROJECT', subjectId: instance.projectId, title: '当前工作',
      filters: { area: currentWorkView.area, actor: currentWorkView.actor, state: currentWorkView.state, type: currentWorkView.type } };
  })();
  useAssistantFocus(urlReady && !blockedPersistentRoute ? assistantPageFocus : null);

  const transcriptSection = storySources.transcript.sections.find((item) => item.id === transcriptSectionId) ?? storySources.transcript.sections[0];
  const transcriptSegments = storySources.transcript.segments.filter((item) => item.sectionId === transcriptSection?.id);
  const currentView = workspaceViews.find((item) => item.id === activeView) ?? workspaceViews[0];
  const pipelineFilters = useMemo<PagedProductionFilters>(() => ({
    phaseId: selectedProductionPhaseId || 'PREVIS',
    gateId: selectedProductionGateId || 'SHOT_PLAN_INPUT_LOCK',
  }), [selectedProductionGateId, selectedProductionPhaseId]);
  const pipelineWindowKey = pagedProductionWindowKey('production', pipelineFilters);
  const pipelineWindow = pagedProduction.windows[pipelineWindowKey] || emptyPagedProductionWindow('production', pipelineFilters);
  const materialResource: PagedProductionResource = 'materials';
  // Both views count the same complete REQUIRED pool. Candidate use belongs to
  // the exact preparation scene/requirement bindings, not old published aliases.
  const materialEpisodeScopeId = materialCenterState.episodeScope === '全部' ? null : materialCenterState.episodeScope;
  const materialFilters = useMemo<PagedProductionFilters>(() => ({}), []);
  const materialWindowKey = pagedProductionWindowKey(materialResource, materialFilters);
  const materialWindow = pagedProduction.windows[materialWindowKey] || emptyPagedProductionWindow(materialResource, materialFilters);
  const activePagedWindow = activeView === 'pipeline' ? pipelineWindow : activeView === 'materials' ? materialWindow : null;
  const activeProductionReady = activeView === 'pipeline'
    ? pipelineWindow.initialized
    : activeView === 'materials'
      ? materialWindow.initialized
      : true;
  const storyInstruction: Record<StoryView, string> = genericAuthoring ? {
    source:'阅读本故事已登记的原始依据、派生整理与辅助资料。原件是否已观察、文字是否可读及资料待核事项分别记录。',
    'story-structure':'整理故事结构、完整剧本与实体关系；作者草稿保留版本，完整候选按对应流程审阅和采用。',
    logic:'按当前完整分集候选逐集判断任务、推进、信息、回报与承接；全部输入齐全后汇总全剧正式审阅。',
    audit:'按当前分集方案定位本场完整正文，结合精确来源与承接要求进行逐场审阅。来源目录可读取不表示媒体已观察或事实已核验。',
  } : {
    audit: !resolvedEpisodePlan ? '读取当前方案的完整正文与逐场依据。' : narrativeCandidate ? `阅读当前 ${resolvedEpisodePlan?.content.episodes.length} 集、${narrativeCandidate.scenes.length} 场完整待审正文，并核对各场时长、视角与信息释放。` : `按集、幕和Sxx场次定位${reviewData.scope.storyScenes}场完整正文，结合本场直接依据完成创作审阅与可选原音核实；完整录音、逐字稿与段落时间线统一在“来源资料”阅读。`,
    logic: '',
    'story-structure': narrativeCandidate ? '从分集任务与视角接力理解全剧，核对铺垫、揭晓、逐场时长、原文处理和创作说明。分集正式判断在“叙事拆解”完成。' : '从全剧尺度阅读简明故事线、幕与叙事序列、人物关系、故事真实发展、观众信息线与高层空间关系；这里只呈现创作依据，不承载分集裁决。',
    source: '阅读完整来源资料：8小时09分原始录音、289段带时间戳规整逐字稿，以及明确标为辅助材料的网友梗概。内容完整呈现，不做模糊、遮挡或脱敏。',
  };

  useEffect(() => {
    if (activeView !== 'pipeline' || pipelineWindow.initialized || pipelineWindow.loading || pipelineWindow.error) return;
    void onNeedProduction({ resource: 'production', filters: pipelineFilters, mode: 'initial' });
  }, [activeView, onNeedProduction, pipelineFilters, pipelineWindow.error, pipelineWindow.initialized, pipelineWindow.loading]);

  useEffect(() => {
    if (activeView !== 'materials' || materialWindow.loading || materialWindow.error) return;
    if (materialWindow.initialized && !materialWindow.hasMore) return;
    void onNeedProduction({ resource: materialResource, filters: materialFilters, mode: 'all' });
  }, [activeView, materialFilters, materialResource, materialWindow.error, materialWindow.hasMore, materialWindow.initialized, materialWindow.loading, onNeedProduction]);

  useEffect(() => {
    if (genericAuthoring || activeView !== 'story' || !['audit', 'source'].includes(storyView) || storySourcesReady || storySourcesError || storyView === 'audit' && (!resolvedEpisodePlan || narrativeCandidate)) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setStorySourcesLoading(true);
      return fetch('/api/v8/ui/story-sources', { signal: controller.signal });
    })
      .then(async (response) => {
        if (!response) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ snapshotId: string; storySources: ReviewSnapshot['storySources'] | null }>;
      })
      .then((payload) => {
        if (!payload) return;
        if (payload.snapshotId !== reviewData.snapshotId) throw new Error('来源资料与当前基础快照不一致');
        if (!payload.storySources?.transcript?.segments?.length || !payload.storySources?.outline?.blocks?.length) {
          throw new Error('来源资料按需接口未返回完整逐字稿与辅助梗概');
        }
        setStorySourcesDetail(payload.storySources);
        setStorySourcesError('');
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== 'AbortError') setStorySourcesError(reason instanceof Error ? reason.message : '来源资料读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setStorySourcesLoading(false);
      });
    return () => controller.abort();
  }, [genericAuthoring, activeView, resolvedEpisodePlan, narrativeCandidate, reviewData.snapshotId, storySourcesAttempt, storySourcesError, storySourcesReady, storyView]);

  useEffect(() => {
    if (genericAuthoring || !((activeView === 'overview') || (activeView === 'story' && storyView === 'audit')) || adaptationAudit || activeView === 'story' && (!resolvedEpisodePlan || narrativeCandidate)) return;
    const controller = new AbortController();
    fetch('/api/v8/ui/adaptation-audit', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ snapshotId: string; adaptationAudit: AdaptationAudit; scenes?: LineageScene[]; storyConfirmations?: StoryConfirmationTarget[]; audioVerifications?: AudioVerificationTarget[]; sceneReviewDossiers?: SceneReviewDossier[] }>;
      })
      .then((payload) => {
        setAdaptationAudit(payload.adaptationAudit);
        setAuthoringScenes(payload.scenes || []);
        setAdaptationSnapshotId(payload.snapshotId);
        const nextStoryConfirmations = payload.storyConfirmations || [];
        setStoryConfirmations(nextStoryConfirmations);
        const nextAudioVerifications = payload.audioVerifications || [];
        const nextSceneReviewDossiers = payload.sceneReviewDossiers || [];
        setAudioVerifications(nextAudioVerifications);
        setSceneReviewDossiers(nextSceneReviewDossiers);
        const params = new URLSearchParams(window.location.search);
        const requestedVerificationIssueId = params.get('verifyIssue');
        const requestedVerification = requestedVerificationIssueId
          ? nextAudioVerifications.find((item) => item.issueId === requestedVerificationIssueId)
          : null;
        const requestedMode = normalizedStoryView(
          params.get('storyMode'),
          params.get('materialMode') === 'structure',
          Boolean(params.get('structureScene') || params.get('storySegment')),
          params.get('narrativeLevel') === 'scene' || Boolean(params.get('scene') || params.get('confirmScene')),
        );
        const requestedEpisode = episodeRecordForRoute(params.get('episode'));
        const requestedScriptPart = params.get('scriptPart');
        const requestedLegacyScriptScene = requestedScriptPart && /^S\d{2}$/.test(requestedScriptPart) ? requestedScriptPart : null;
        const explicitBeatId = params.get('auditBeat');
        const explicitBeat = explicitBeatId
          ? payload.adaptationAudit.beats.find((beat) => beat.beat_id === explicitBeatId)
          : null;
        const explicitBeatMappedSceneId = explicitBeat
          ? [...(explicitBeat.current_mapping.scene_ids || []), ...(explicitBeat.adaptation_decision.target_scene_ids || [])][0]
          : null;
        const explicitBeatDirectSceneIds = explicitBeatId
          ? nextSceneReviewDossiers.filter((item) => item.directBeatIds.includes(explicitBeatId)).map((item) => item.sceneId)
          : [];
        const explicitBeatDirectSceneId = explicitBeatDirectSceneIds.length === 1 ? explicitBeatDirectSceneIds[0] : null;
        const requestedSceneId = requestedVerification?.primaryReviewSceneId
          || params.get('confirmScene')
          || (requestedMode === 'audit'
            ? params.get('scene')
              || requestedLegacyScriptScene
              || explicitBeatMappedSceneId
              || explicitBeatDirectSceneId
              || (!explicitBeatId ? requestedEpisode?.sceneIds[0] : null)
              || null
            : null);
        const dossier = requestedSceneId ? nextSceneReviewDossiers.find((item) => item.sceneId === requestedSceneId) : null;
        const target = requestedSceneId ? nextStoryConfirmations.find((item) => item.sceneId === requestedSceneId) : null;
        const sourceBeatId = params.get('auditBeat')
          || requestedVerification?.beatIds?.find((beatId) => payload.adaptationAudit.beats.some((beat) => beat.beat_id === beatId))
          || (requestedVerification?.beatId && payload.adaptationAudit.beats.some((beat) => beat.beat_id === requestedVerification.beatId) ? requestedVerification.beatId : undefined)
          || dossier?.directBeatIds.find((beatId) => payload.adaptationAudit.beats.some((beat) => beat.beat_id === beatId))
          || dossier?.relatedBeatIds.find((beatId) => payload.adaptationAudit.beats.some((beat) => beat.beat_id === beatId))
          || target?.sourceBeatIds?.find((beatId) => payload.adaptationAudit.beats.some((beat) => beat.beat_id === beatId));
        if (sourceBeatId) setAuditBeatId(sourceBeatId);
        if (requestedMode === 'audit' && sourceBeatId && !requestedSceneId) {
          const sourceBeatExists = payload.adaptationAudit.beats.some((beat) => beat.beat_id === sourceBeatId);
          const sourceSection = reviewData.storySources.transcript.sections.find((item) => item.segmentIds.includes(sourceBeatId));
          if (!sourceBeatExists || !sourceSection) {
            setAuditBeatId(null);
            setAuditSceneId(null);
            setNavigationError(`无法定位原文段落 ${sourceBeatId}；已停止打开场次，避免显示无关正文。`);
            return;
          }
          const url = new URL(window.location.href);
          cleanDestinationUrl(url);
          ['scene', 'confirmScene', 'verifyIssue', 'auditBeat', 'episode', 'episodeDisplay', 'storySegment'].forEach((key) => url.searchParams.delete(key));
          url.searchParams.set('view', 'story');
          url.searchParams.set('storyMode', 'source');
          url.searchParams.set('source', 'transcript');
          url.searchParams.set('transcript', sourceSection.id);
          url.searchParams.set('readerAnchor', sourceBeatId);
          window.history.replaceState(window.history.state, '', url);
          setAuditBeatId(null);
          setAuditSceneId(null);
          setAuditVerificationIssueId(null);
          setStorySourceMode('transcript');
          setTranscriptSectionId(sourceSection.id);
          setReaderAnchor(sourceBeatId);
          setStoryView('source');
          setNavigationError('');
          return;
        }
        if (requestedSceneId && reviewData.creativeLineage.scenes.some((item) => item.id === requestedSceneId)) {
          setAuditSceneId(requestedSceneId);
          const scene = reviewData.creativeLineage.scenes.find((item) => item.id === requestedSceneId);
          if (scene) {
            setStorySceneId(scene.id);
            setEpisodeId(scene.episodeAssignment.episodeId);
          }
          const url = new URL(window.location.href);
          url.searchParams.set('confirmScene', requestedSceneId);
          url.searchParams.set('scene', requestedSceneId);
          if (sourceBeatId) url.searchParams.set('auditBeat', sourceBeatId);
          window.history.replaceState(window.history.state, '', url);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setAdaptationAuditError(reason instanceof Error ? reason.message : '原文改编审计读取失败');
      });
    return () => controller.abort();
  }, [genericAuthoring, activeView, resolvedEpisodePlan, narrativeCandidate, adaptationAudit, adaptationAuditAttempt, episodeRecordForRoute, reviewData.creativeLineage.episodes, reviewData.creativeLineage.scenes, reviewData.storySources.transcript.sections, storyView]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      fetch('/api/v8/operations/snapshot', { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{ stateProjection?: OperationalStateProjection }>;
        })
        .then((payload) => setOperationalProjection(payload.stateProjection || null))
        .catch(() => {
          if (!controller.signal.aborted) setOperationalProjection(null);
        });
    };
    refresh();
    window.addEventListener('review:operations-updated', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('review:operations-updated', refresh);
    };
  }, []);

  const locationRestorerRef = useRef<(state?: ReviewHistoryState, initial?: boolean) => void>(() => undefined);
  locationRestorerRef.current = (historyState = (window.history.state || {}) as ReviewHistoryState, initial = false) => {
    const browseUrl=new URL(window.location.href);
    if(restoreMaterialBrowseLocation(browseUrl))window.history.replaceState(window.history.state,'',browseUrl);
    const params = new URLSearchParams(window.location.search);
    if(narrativeCandidate&&params.get('view')==='story'&&params.get('verifyIssue')&&(params.get('storyMode')!=='source'||params.has('scene')||params.has('confirmScene')||params.has('episode'))){
      params.set('storyMode','source');params.set('source','transcript');
      for(const key of ['scene','confirmScene','episode','episodeDisplay','episodePlanRevision','auditBeat','storySegment','scriptPart','structureScene','readerAnchor'])params.delete(key);
      const url=new URL(window.location.href);url.search=params.toString();url.hash='';window.history.replaceState(window.history.state,'',url);
    }
    const requestedView = params.get('view');
    const requestedStoryView = params.get('storyMode');
    const requestedMaterialMode = params.get('materialMode');
    const legacyAssetId = params.get('asset');
    const legacyStructureRoute = requestedMaterialMode === 'structure';
    const legacyMapRoute = requestedStoryView === 'map';
    if (legacyMapRoute) {
      const url = new URL(window.location.href);
      url.searchParams.set('settingsSection', 'space');
      const locationId = params.get('map');
      if (locationId) url.searchParams.set('settingsEntity', locationId);
      window.history.replaceState(window.history.state, '', url);
    }
    const normalizedView = window.location.hash === '#story-relations-title' || requestedView === 'story' && requestedStoryView === 'map' ? 'settings' : requestedView === 'assets' || legacyAssetId
      ? 'materials'
      : ['targets', 'shots'].includes(requestedView || '')
        ? 'pipeline'
        : requestedView === 'work'
          ? 'overview'
        : legacyStructureRoute
          ? 'story'
          : legacyMapRoute
            ? 'materials'
            : requestedView;
    const nextView = normalizedView && workspaceViews.some((item) => item.id === normalizedView) ? normalizedView as WorkspaceView : 'overview';
    const nextStoryView = legacyMapRoute ? null : normalizedStoryView(
      requestedStoryView,
      legacyStructureRoute,
      Boolean(params.get('structureScene') || params.get('storySegment')),
      params.get('narrativeLevel') === 'scene' || Boolean(params.get('scene') || params.get('confirmScene')),
    );
    const nextSourceMode = params.get('source');
    // A candidate can own permanent episode identities absent from the published
    // bootstrap. Resolve its exact revision before validating this deep link.
    if (nextView === 'story' && (nextStoryView === 'logic' || nextStoryView === 'audit') && !resolvedEpisodePlan) {
      setActiveView('story');
      setStoryView(nextStoryView);
      setUrlReady(false);
      if (episodePlanError) setNavigationError(episodePlanError);
      return;
    }
    const nextTranscriptSection = params.get('transcript');
    const nextScriptSection = params.get('scriptPart');
    const nextReaderAnchor = params.get('readerAnchor');
    const nextAuditBeat = params.get('auditBeat');
    const nextEpisode = params.get('episode');
    const candidateEpisode = resolvedEpisodePlan && nextView === 'story' ? resolvedEpisodePlan.content.episodes.find((item) => item.episodeUid === nextEpisode) : null;
    const nextEpisodeRecord = episodeRecordForRoute(nextEpisode);
    const nextEpisodeScopeId = nextEpisodeRecord?.canonicalScopeId || nextEpisodeRecord?.episodeUid || nextEpisode;
    const requestedMaterialEpisode = params.get('materialEpisode');
    const requestedAssetEpisode = params.get('assetEpisode');
    const requestedAssetEpisodeRecord = episodeRecordForRoute(requestedAssetEpisode);
    const invalidCurrentEpisodeRoute = Boolean(nextEpisode) && (nextView === 'story' && resolvedEpisodePlan ? !candidateEpisode : episodePlanIsCurrent && !nextEpisodeRecord);
    const invalidCurrentAssetEpisodeRoute = episodePlanIsCurrent
      && Boolean(requestedAssetEpisode)
      && requestedAssetEpisode !== '全部'
      && !requestedAssetEpisodeRecord;
    if (invalidCurrentEpisodeRoute) {
      setNavigationError('无法定位此分集，请从当前分集目录重新选择。');
    }
    if (invalidCurrentAssetEpisodeRoute) {
      setNavigationError('当前素材管理剧集范围只接受episodeUid；旧E##筛选已失败关闭。');
    }
    const legacyScriptScene = nextScriptSection && /^S\d{2}$/.test(nextScriptSection) ? nextScriptSection : null;
    const firstEpisodeScene = candidateEpisode?.sceneIds[0] || nextEpisodeRecord?.sceneIds[0] || null;
    const nextCauseChain = params.get('causeChain');
    const causeChainScene = causalChains.find((item) => item.id === nextCauseChain)?.setupSceneIds[0]
      || causalChains.find((item) => item.id === nextCauseChain)?.payoffSceneIds[0]
      || null;
    const compatibleStoryScene = params.get('confirmScene')
      || params.get('scene')
      || params.get('structureScene')
      || legacyScriptScene
      || (nextStoryView === 'logic' ? causeChainScene : null)
      || (nextStoryView === 'audit' ? firstEpisodeScene : null);
    const nextAuditScene = nextStoryView === 'audit' ? compatibleStoryScene : null;
    const nextVerificationIssue = params.get('verifyIssue');
    const nextStorySegment = params.get('storySegment');
    const nextPhase = phaseIdFromStorySegment(nextStorySegment) ?? params.get('phase');
    const legacyTarget = params.get('target');
    const nextScene = nextStoryView === 'audit' && nextAuditScene
      ? nextAuditScene
      : compatibleStoryScene ?? (nextView === 'pipeline' ? null : legacyTarget);
    const nextLightbox = params.get('lightbox');
    const nextQuery = params.get('q') || '';
    const legacyStage = params.get('stage') || (nextView === 'pipeline'
      ? params.get('phase') || inferLegacyProductionStage(params.get('work'), params.get('item'), params.get('family'), params.get('version'))
      : null);
    const legacySelection = legacyProductionGate(legacyStage);
    const creatorStage = CREATOR_PRODUCTION_STAGES.find(stage=>stage.id===params.get('creatorStage')||productionSlug(stage.id)===params.get('creatorStage'));
    const creatorEntry = creatorProductionGateDefinition(creatorStage?.defaultGateId);
    const pending: PendingProductionLocation = {
      shotId: params.get('shot'),
      sceneId: nextScene,
      workPackageId: params.get('work'),
      workItemId: params.get('item'),
      familyId: params.get('family') || legacyAssetId,
      versionId: params.get('version'),
      materialRequirementId: params.get('material'),
      phaseId: phaseIdFromLocation(params.get('productionPhase')) || legacySelection?.phaseId || creatorEntry?.phaseId || null,
      gateId: gateIdFromLocation(params.get('productionGate')) || legacySelection?.gateId || creatorStage?.defaultGateId as ProductionGateId || null,
      scopeType: params.get('productionScope'),
      objectId: params.get('productionObject'),
      legacyStage,
      legacyTarget,
    };

    restoringHistoryRef.current = !initial;
    setNavigationOrigin(historyState.reviewOrigin || null);
    setActiveView(nextView);
    const requestedTodayPerspective = params.get('todayMode');
    const requestedWorkArea = params.get('workArea');
    const requestedWorkActor = params.get('workActor');
    const requestedWorkState = params.get('workState');
    const requestedWorkType = params.get('workType');
    const legacyArea = ['STORY', 'MATERIALS', 'PRODUCTION', 'EXCEPTION'].includes(requestedTodayPerspective || '')
      ? requestedTodayPerspective as CurrentWorkArea
      : null;
    setCurrentWorkView({
      stage: params.get('workStage') || undefined,
      area: requestedView === 'work'
        ? 'EXCEPTION'
        : ['ALL', 'STORY', 'MATERIALS', 'PRODUCTION', 'EXCEPTION'].includes(requestedWorkArea || '')
          ? requestedWorkArea as CurrentWorkArea
          : legacyArea || 'ALL',
      actor: ['ALL', 'HUMAN', 'AI', 'BOTH', 'AUTOMATION'].includes(requestedWorkActor || '')
        ? requestedWorkActor as CurrentWorkActor : 'ALL',
      state: ['NOW', 'READY', 'IN_PROGRESS', 'WAITING', 'BLOCKED', 'ALL'].includes(requestedWorkState || '')
        ? requestedWorkState as CurrentWorkStateFilter : 'NOW',
      type: ['ALL', 'AUTHORING', 'FORMAL_REVIEW', 'AUTHORIZATION', 'EXECUTION', 'RESULT_REGISTRATION', 'SOURCE_SYNC', 'ISSUE_RESOLUTION'].includes(requestedWorkType || '')
        ? requestedWorkType as CurrentWorkTypeFilter : 'ALL',
    });
    if (nextStoryView && storyViews.includes(nextStoryView)) setStoryView(nextStoryView);
    const requestedStructureSection = params.get('structureSection');
    setNarrativeSection(narrativeOverviewSection(params.get('narrativeSection') || requestedStructureSection));
    if (nextView === 'story' && nextStoryView === 'story-structure') {
      const legacySection = params.get('narrativeSection');
      if (legacySection === 'timing') setStoryView('logic');
      if (legacySection === 'source') setStoryView('source');
    }
    const legacyStructureSection: StoryOverviewSectionId = requestedStoryView === 'case'
      ? 'truth-route'
      : ['timeline', 'structure'].includes(requestedStoryView || '')
        ? 'spine'
        : 'overview';
    setStoryStructureSection(
      STORY_OVERVIEW_SECTIONS.some((item) => item.id === requestedStructureSection)
        ? requestedStructureSection as StoryOverviewSectionId
        : legacyStructureSection
    );
    if (nextSourceMode === 'transcript' || nextSourceMode === 'outline') setStorySourceMode(nextSourceMode);
    const restoredAuditBeat = nextAuditBeat || (nextAuditScene
      ? sceneReviewDossiers.find((item) => item.sceneId === nextAuditScene)?.directBeatIds?.[0]
        || sceneReviewDossiers.find((item) => item.sceneId === nextAuditScene)?.relatedBeatIds?.[0]
        || storyConfirmations.find((item) => item.sceneId === nextAuditScene)?.sourceBeatIds?.[0]
        || null
      : null);
    setAuditBeatId(restoredAuditBeat);
    setAuditSceneId(narrativeCandidate || genericAuthoring ? nextAuditScene : nextAuditScene && reviewData.creativeLineage.scenes.some((item) => item.id === nextAuditScene) ? nextAuditScene : null);
    setAuditVerificationIssueId(nextVerificationIssue);
    setCauseChainId(causalChains.some((item) => item.id === nextCauseChain) ? nextCauseChain : null);
    if (storySources.transcript.sections.some((item) => item.id === nextTranscriptSection)) setTranscriptSectionId(nextTranscriptSection as string);
    if (nextEpisodeRecord) setEpisodeId(nextEpisodeRecord.displayId || nextEpisodeRecord.id);
    const logicEpisode = candidateEpisode || (narrativeCandidate ? resolvedEpisodePlan?.content.episodes[0] : null) || storyStructure.episodeDecisions?.find((item) => (
      item.episodeUid === nextEpisodeRecord?.episodeUid || item.episodeId === nextEpisodeRecord?.displayId
    )) || storyStructure.episodeDecisions?.[0];
    if (logicEpisode) {
      const requestedLogicGroup = params.get('logicGroup');
      const requestedLogicItem = params.get('logicItem');
      const legacyGroup: EpisodeCriterionId | null = nextCauseChain || requestedStoryView === 'cause'
        ? 'information-causality'
        : nextStorySegment || legacyStructureRoute || ['timeline', 'structure'].includes(requestedStoryView || '')
          ? 'escalation-turn'
          : null;
      const legacyItem = nextCauseChain || requestedStoryView === 'cause'
        ? 'causal-chains'
        : nextStorySegment
          ? `slice-${nextStorySegment.toLowerCase()}`
          : legacyGroup === 'escalation-turn'
            ? 'key-turns'
            : null;
      const selection = normalizeLogicSelection(
        legacyGroup || requestedLogicGroup,
        legacyItem || requestedLogicItem,
        logicEpisode.reviewDossier,
      );
      setLogicGroup(selection.groupId);
      setLogicItem(selection.itemId);
    }
    if (nextPhase && storySequences.some((item) => item.legacyPhaseId === nextPhase)) setPhaseId(nextPhase);
    const lineageScene = reviewData.creativeLineage.scenes.find((item) => item.id === nextScene);
    if (lineageScene && nextView === 'story' && !narrativeCandidate && !genericAuthoring) {
      setStorySceneId(lineageScene.id);
      if (!(nextStoryView === 'logic' && nextStorySegment)) setPhaseId(lineageScene.phaseId);
      setEpisodeId(lineageScene.episodeAssignment.episodeId);
    }
    if ((narrativeCandidate || genericAuthoring) && resolvedEpisodePlan && nextView === 'story') {
      const sceneEpisode = resolvedEpisodePlan?.content.episodes.find((item) => item.sceneIds.includes(nextAuditScene || ''));
      const explicitEpisode = nextEpisode ? resolvedEpisodePlan.content.episodes.find(item => item.episodeUid === nextEpisode) : null;
      setEpisodeId(nextStoryView === 'audit' ? explicitEpisode?.episodeUid || sceneEpisode?.episodeUid || resolvedEpisodePlan.content.episodes[0]?.episodeUid || '' : candidateEpisode?.episodeUid || resolvedEpisodePlan.content.episodes[0]?.episodeUid || '');
      setAuditBeatId(null); setAuditVerificationIssueId(narrativeCandidate&&nextStoryView==='source'?nextVerificationIssue:null);
    }
    setReaderAnchor(nextReaderAnchor);
    setQuery(nextQuery);
    setSearchResultsOpen(params.get('searchOpen') === '1');
    setMobileSearchOpen(params.get('searchOpen') === '1');
    const materialWorkspaceMode: NonNullable<MaterialCenterViewState['workspaceMode']> = 'classification';
    setMaterialCenterState({
      search: params.get('materialQ') || params.get('assetQ') || '',
      mediaType: (params.get('materialMedia') as MaterialCenterViewState['mediaType']) || '全部',
      businessPrimary: params.get('materialPrimary') || '全部',
      category: params.get('materialCategory') || '全部',
      episodeScope: requestedMaterialEpisode || '全部',
      sceneScope: params.get('materialScene') || '全部',
      shotScope: params.get('materialShot') || '全部',
      creatorStage: isMaterialCreatorStage(params.get('materialCreatorStage'))
        ? params.get('materialCreatorStage') as MaterialCenterViewState['creatorStage']
        : '全部',
      coverage: params.get('materialCoverage') === 'EVIDENCE_ONLY'
        ? '全部'
        : (params.get('materialCoverage') as MaterialCenterViewState['coverage']) || '全部',
      workspaceMode: materialWorkspaceMode,
      requirementId: nextView === 'materials' ? pending.materialRequirementId : null,
      familyId: nextView === 'materials' ? pending.familyId : null,
      versionId: nextView === 'materials' ? pending.versionId : null,
    });
    setLightbox(nextLightbox);
    if (nextLightbox && !historyState.reviewOverlay) {
      window.history.replaceState({ ...historyState, reviewOverlay: { kind: 'lightbox', depth: 0 } }, '', window.location.href);
    }

    const resolvePending = (model: ProductionModel) => {
      if (requestedView === 'work' && pending.workItemId) {
        const materialItem = (model.materialWorkItems || []).find((item) => item.id === pending.workItemId || publicRef(item.id) === pending.workItemId) || null;
        if (materialItem) {
          const requirement = (model.materialRequirements || []).find((item) => item.id === materialItem.requirementRef) || null;
          const family = model.assetFamilies.find((item) => item.id === materialItem.outputAssetRef) || null;
          const versionId = resolveFamilyVersionSelection(model, family, pending.versionId);
          setMaterialCenterState({ ...defaultMaterialCenterState, workspaceMode: 'classification', requirementId: requirement?.id || null, familyId: family?.id || null, versionId });
          setActiveView('materials');
          setNavigationError('');
          return true;
        }
        const workItem = model.workItems.find((item) => item.id === pending.workItemId || publicRef(item.id) === pending.workItemId) || null;
        const workPackage = workItem ? model.workPackages.find((item) => item.workItemRefs.includes(workItem.id)) || null : null;
        const workShot = workItem?.shotId
          ? model.shots.find((item) => item.id === workItem.shotId) || null
          : workPackage?.shotIds.map((id) => model.shots.find((item) => item.id === id) || null).find(Boolean) || null;
        if (workItem && workPackage && workShot) {
          setProductionContext(resolveProductionContext(model, { shotId: workShot.id, workPackageId: workPackage.id, workItemId: workItem.id, familyId: pending.familyId, versionId: pending.versionId }));
          setActiveView('pipeline');
          setNavigationError('');
          return true;
        }
      }
      const requestedLegacyPackage = pending.workPackageId
        ? model.workPackages.find((item) => item.id === pending.workPackageId || publicRef(item.id) === pending.workPackageId) || null
        : null;
      const requestedLegacyItem = pending.workItemId
        ? model.workItems.find((item) => item.id === pending.workItemId || publicRef(item.id) === pending.workItemId) || null
        : null;
      const legacyLocationCode = String(pending.legacyStage || '').toUpperCase();
      const legacyStepId = legacyProductionStep(pending.legacyStage);
      const legacyTargetShot = pending.legacyTarget
        ? model.shots.find((item) => item.id === pending.legacyTarget || publicRef(item.id) === pending.legacyTarget) || null
        : null;
      const legacyTargetScene = pending.legacyTarget
        ? model.scenes.find((item) => item.id === pending.legacyTarget || publicRef(item.id) === pending.legacyTarget) || null
        : null;
      const legacyTargetEpisode = pending.legacyTarget
        ? model.episodes.find((item) => episodePlanIsCurrent
          ? item.episodeUid === pending.legacyTarget || item.canonicalScopeId === pending.legacyTarget
          : item.id === pending.legacyTarget || publicRef(item.id) === pending.legacyTarget) || null
        : null;
      const legacyTargetIsProject = pending.legacyTarget === instance.projectId;
      const legacyTargetPackage = legacyStepId && pending.legacyTarget
        ? model.workPackages.find((item) => (
          item.stepId === legacyStepId
          && (
            item.scopeId === pending.legacyTarget
            || publicRef(item.scopeId) === pending.legacyTarget
            || item.scopeId.endsWith(`:${pending.legacyTarget}`)
            || publicRef(item.scopeId).endsWith(`:${pending.legacyTarget}`)
            || item.shotIds.some((id) => id === pending.legacyTarget || publicRef(id) === pending.legacyTarget)
          )
        )) || null
        : null;
      // W02/P07/P08 identities are retired history coordinates. Let the later
      // shot resolver validate the exact target; a paged response need not carry
      // the historical work-package row in order to normalize this old URL.
      const retiredStoryboardDeepLink = legacyStepId === 'W02' && Boolean(pending.shotId);
      const invalidCurrentLegacyEpisodeTarget = episodePlanIsCurrent
        && legacyStepId === 'W08'
        && /^E\d{2,}$/.test(pending.legacyTarget || '');
      if (nextView === 'pipeline' && invalidCurrentLegacyEpisodeTarget) {
        setNavigationError('当前分集方案的旧制作链接只接受episodeUid；E##目标已失败关闭，未绑定到重排后的同号分集。');
        setBlockedPersistentRoute('EPISODE');
        setActiveView('overview');
        pendingProductionIntentRef.current = null;
        return false;
      }
      if (nextView === 'pipeline' && pending.workPackageId && !requestedLegacyPackage && !retiredStoryboardDeepLink) {
        setNavigationError(`无法在当前快照定位工作包 ${pending.workPackageId}；已保留原链接，未回退历史镜头。`);
        pendingProductionIntentRef.current = pending;
        return false;
      }
      if (nextView === 'pipeline' && pending.legacyTarget && pending.legacyStage
        && !legacyTargetShot && !legacyTargetScene && !legacyTargetEpisode && !legacyTargetIsProject && !legacyTargetPackage) {
        setNavigationError(`无法在当前快照定位旧链接对象 ${pending.legacyTarget}；已保留原链接，未回退历史镜头。`);
        pendingProductionIntentRef.current = pending;
        return false;
      }
      const locationCompatibilityPackage = (requestedLegacyPackage || legacyTargetPackage)?.stepId === 'W01'
        ? requestedLegacyPackage || legacyTargetPackage
        : null;
      const locationCompatibilityItem = requestedLegacyItem?.pipelineStageCode === 'P04B'
        ? requestedLegacyItem
        : locationCompatibilityPackage?.workItemRefs.map((id) => model.workItems.find((item) => item.id === id) || null).find((item) => item?.pipelineStageCode === 'P04B') || null;
      if (nextView === 'pipeline' && (['W01', 'P04B'].includes(legacyLocationCode) || locationCompatibilityPackage || locationCompatibilityItem)) {
        const relatedItemIds = new Set([
          ...(locationCompatibilityPackage?.workItemRefs || []),
          ...(locationCompatibilityItem ? [locationCompatibilityItem.id] : []),
        ]);
        const relatedFamilyIds = new Set([
          ...(locationCompatibilityItem?.outputAssetRef ? [locationCompatibilityItem.outputAssetRef] : []),
          ...(locationCompatibilityItem?.inputAssetRefs || []),
        ]);
        const requirement = (model.materialRequirements || []).find((item) => item.requirementClass === 'REQUIRED' && (
          item.consumerWorkItemRefs.some((id) => relatedItemIds.has(id))
          || item.assetFamilyRefs.some((id) => relatedFamilyIds.has(id))
        )) || null;
        const familyId = requirement?.assetFamilyRefs.find((id) => relatedFamilyIds.has(id))
          || requirement?.assetFamilyRefs[0]
          || [...relatedFamilyIds][0]
          || null;
        const family = familyId ? model.assetFamilies.find((item) => item.id === familyId) || null : null;
        setMaterialCenterState({
          ...defaultMaterialCenterState,
          workspaceMode: 'classification',
          businessPrimary: '场景',
          category: '地点状态',
          episodeScope: locationCompatibilityPackage?.episodeId || '全部',
          sceneScope: locationCompatibilityPackage?.sceneId || '全部',
          requirementId: requirement?.id || null,
          familyId: family?.id || null,
          versionId: resolveFamilyVersionSelection(model, family, pending.versionId),
        });
        setActiveView('materials');
        setNavigationError('');
        pendingProductionIntentRef.current = null;
        return true;
      }
      // Material definitions and demands exist before any formal shot.
      if (nextView === 'materials') {
        setNavigationError('');
        pendingProductionIntentRef.current = null;
        // Trial identity and versions belong to their independent drawer, not
        // the REQUIRED material/family/version resolver.
        if (params.get('materialTrial') && !pending.materialRequirementId && !pending.familyId) {
          setMaterialCenterState(current=>({...current,workspaceMode:materialWorkspaceMode,requirementId:null,familyId:null,versionId:null}));
          return true;
        }
        const required = (model.materialRequirements || []).filter(item=>item.requirementClass==='REQUIRED');
        const requirementById = pending.materialRequirementId ? exactMaterialPanelMatch(required,pending.materialRequirementId,item=>item.id,publicRef) || null : null;
        const explicitFamily = pending.familyId ? exactMaterialPanelMatch(model.assetFamilies,pending.familyId,item=>item.id,publicRef) || null : null;
        const familyRequirements = explicitFamily ? required.filter(item=>item.assetFamilyRefs.includes(explicitFamily.id)) : [];
        const requirement = pending.materialRequirementId ? requirementById : familyRequirements.length===1 ? familyRequirements[0] : null;
        // An explicit family deep link is evidence that must be validated, not
        // silently replaced by the requirement's first family. Keeping the
        // resolved explicit family lets the unified material card report the
        // exact requirement/family mismatch and avoids reviewing the wrong
        // object. Only infer the requirement's first family when no family was
        // supplied at all.
        const requestedFamilyId = pending.familyId
          || requirement?.assetFamilyRefs[0]
          || null;
        const family = requestedFamilyId ? exactMaterialPanelMatch(model.assetFamilies,requestedFamilyId,item=>item.id,publicRef) || null : null;
        const requestedVersionId = pending.versionId && family
          ? exactMaterialPanelMatch([...family.versionRefs, ...(family.expectedOutputRefs || [])],pending.versionId,id=>id,publicRef) || null
          : null;
        const versionId = pending.versionId
          ? requestedVersionId || pending.versionId
          : resolveFamilyVersionSelection(model, family);
        setMaterialCenterState((current) => ({
          ...current,
          workspaceMode: materialWorkspaceMode,
          requirementId: requirement?.id || pending.materialRequirementId || null,
          familyId: family?.id || pending.familyId || requirement?.assetFamilyRefs[0] || null,
          versionId,
        }));
        if ((pending.materialRequirementId && !requirement) || (pending.familyId && !family)) {
          setNavigationError(`410 · 当前素材管理中无法定位 ${pending.materialRequirementId || pending.familyId}；已停止静默回退。全剧产物请从“全剧制作”打开，退役记录仅保留最小凭据。`);
        }
        return true;
      }
      // A stage/preparation entry has no production identity to resolve yet.
      // Keep explicit object links on the exact resolver below, even when the
      // current formal graph is empty; never substitute an old/default shot.
      const identityFreeProductionEntry = nextView === 'pipeline'
        && !pending.shotId && !pending.sceneId && !pending.workPackageId
        && !pending.workItemId && !pending.legacyTarget
        && !pending.familyId && !pending.versionId && !pending.materialRequirementId
        && (!pending.objectId || pending.objectId === 'UNKNOWN');
      if (identityFreeProductionEntry) {
        const phaseId = pending.phaseId
          || model.productionGates?.find((gate) => gate.id === pending.gateId)?.phaseId
          || 'PREVIS';
        const gateId = pending.gateId
          || model.productionPhases?.find((phase) => phase.id === phaseId)?.entryGateId
          || 'SHOT_PLAN_INPUT_LOCK';
        setProductionContext({ shotId: '', workPackageId: '', workItemId: null, familyId: null, versionId: null, phaseId, gateId });
        setNavigationError('');
        pendingProductionIntentRef.current = null;
        return true;
      }
      const scopedPackage = pending.scopeType && pending.objectId && pending.objectId !== 'UNKNOWN'
        ? model.workPackages.find((item) => (
          item.activeInCurrentProduction === true
          && (!pending.phaseId || item.phaseId === pending.phaseId)
          && (!pending.gateId || item.gateId === pending.gateId)
          && item.scopeType === pending.scopeType
          && (item.scopeId === pending.objectId || publicRef(item.scopeId) === pending.objectId)
        )) || null
        : null;
      if (nextView === 'pipeline' && pending.scopeType && pending.objectId && pending.objectId !== 'UNKNOWN' && !scopedPackage) {
        setNavigationError(`无法在当前制作图定位 ${pending.scopeType}:${pending.objectId}；已保留原链接，未回退历史镜头。`);
        pendingProductionIntentRef.current = pending;
        return false;
      }
      const locationPackage = scopedPackage || requestedLegacyPackage || legacyTargetPackage;
      const requestedShot = pending.shotId
        ? model.shots.find((item) => item.id === pending.shotId || publicRef(item.id) === pending.shotId)
        : locationPackage
          ? locationPackage.shotIds.map((id) => model.shots.find((item) => item.id === id) || null).find((item): item is NonNullable<typeof item> => Boolean(item)) || null
          : legacyTargetShot
            ? legacyTargetShot
          : legacyTargetScene
            ? model.shots.find((item) => item.sceneId === legacyTargetScene.id)
          : legacyTargetEpisode
            ? model.shots.find((item) => item.episodeId === legacyTargetEpisode.id)
          : legacyTargetIsProject
            ? model.shots.find((item) => item.id === productionContext.shotId) || model.shots[0]
          : pending.scopeType === 'SCENE' && pending.objectId && pending.objectId !== 'UNKNOWN'
            ? model.shots.find((item) => item.sceneId === pending.objectId || publicRef(item.sceneId) === pending.objectId)
        : pending.sceneId
          ? model.shots.find((item) => item.sceneId === pending.sceneId)
          : model.shots.find((item) => item.id === productionContext.shotId) || model.shots[0];
      if (!requestedShot) {
        setNavigationError(`无法在当前快照定位 ${pending.shotId || pending.sceneId || '制作对象'}；已保留原链接，未回退到其他场次。`);
        pendingProductionIntentRef.current = pending;
        return false;
      }
      setNavigationError('');
      pendingProductionIntentRef.current = null;
      const exactHistoricalShotDeepLink = nextView === 'pipeline'
        && Boolean(pending.shotId || legacyTargetShot)
        && !fullProductionCurrentShotIds(model).has(requestedShot.id);
      const historicalShotWithoutWorkGraph = nextView === 'pipeline'
        && !requestedShot.workPackageRefs.some((id) => model.workPackages.some((item) => item.id === id));
      if (nextView === 'pipeline' && (retiredStoryboardDeepLink || exactHistoricalShotDeepLink || historicalShotWithoutWorkGraph)) {
        setProductionContext({
          shotId: requestedShot.id,
          workPackageId: `HISTORICAL_ONLY:${requestedShot.id}`,
          workItemId: null,
          familyId: null,
          versionId: null,
          phaseId: retiredStoryboardDeepLink ? 'PREVIS' : pending.phaseId || 'PREVIS',
          gateId: retiredStoryboardDeepLink ? 'SHOT_PLAN_INPUT_LOCK' : pending.gateId || 'SHOT_PLAN_INPUT_LOCK',
        });
        return true;
      }
      const useProductionEntry = nextView === 'pipeline'
        && !pending.phaseId
        && !pending.gateId
        && !locationPackage
        && !pending.legacyStage;
      setProductionContext(resolveProductionContext(model, {
        shotId: requestedShot.id,
        workPackageId: nextView === 'pipeline' ? locationPackage?.id || pending.workPackageId : null,
        workItemId: nextView === 'pipeline' ? pending.workItemId : null,
        familyId: nextView === 'pipeline' ? pending.familyId : null,
        versionId: nextView === 'pipeline' ? pending.versionId : null,
        legacyStage: nextView === 'pipeline' ? pending.legacyStage : null,
        phaseId: nextView === 'pipeline' ? pending.phaseId || (useProductionEntry ? 'PREVIS' : null) : null,
        gateId: nextView === 'pipeline' ? pending.gateId || (useProductionEntry ? 'SHOT_PLAN_INPUT_LOCK' : null) : null,
      }));
      return true;
    };
    const needsPagedProduction = ['pipeline', 'materials'].includes(nextView) || Boolean(
      pending.shotId || pending.workPackageId || pending.workItemId || pending.materialRequirementId
      || pending.phaseId || pending.gateId || pending.scopeType || pending.objectId || pending.legacyStage
    );
    const finishRestore = () => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (nextView === 'materials' && !initial) window.dispatchEvent(new Event('review:material-panel-location'));
      const restore = historyState.reviewRestore;
      if (restore) {
        mainScrollRef.current?.scrollTo({ top: restore.mainTop, behavior: 'auto' });
        readerScrollRef.current?.scrollTo({ top: restore.readerTop, behavior: 'auto' });
        if (restore.focusSelector) document.querySelector<HTMLElement>(restore.focusSelector)?.focus({ preventScroll: true });
      }
      restoringHistoryRef.current = false;
    }));
    const blockedRoute = invalidCurrentEpisodeRoute
      ? 'EPISODE'
      : invalidCurrentAssetEpisodeRoute
          ? 'ASSET_EPISODE'
          : null;
    if (blockedRoute) {
      pendingProductionIntentRef.current = null;
      setBlockedPersistentRoute(blockedRoute);
      setActiveView('overview');
      setUrlReady(true);
      finishRestore();
      return;
    }
    setBlockedPersistentRoute(null);
    if (needsPagedProduction) {
      pendingProductionIntentRef.current = pending;
      setUrlReady(false);
      const requests: PagedProductionLoadRequest[] = [];
      if (nextView === 'materials' || requestedView === 'work') {
        const resource: PagedProductionResource = 'materials';
        requests.push({
          resource,
          mode: 'all',
          // Facet counts and entity relations need the same complete catalog on every deep link.
          filters: {},
        });
      }
      if (nextView === 'pipeline' || requestedView === 'work') {
        const explicitScopeType = uiScopeType(pending.scopeType);
        const inferredScope = explicitScopeType && pending.objectId && pending.objectId !== 'UNKNOWN'
          ? { scopeType: explicitScopeType, scopeId: pending.objectId }
          : pending.shotId
            ? { scopeType: 'SHOT' as const, scopeId: pending.shotId }
            : pending.legacyTarget && /^S\d{2}-SH\d{2,3}$/i.test(pending.legacyTarget)
              ? { scopeType: 'SHOT' as const, scopeId: pending.legacyTarget }
            : pending.sceneId
              ? { scopeType: 'SCENE' as const, scopeId: pending.sceneId }
              : {};
        const filters: PagedProductionFilters = {
          phaseId: pending.phaseId,
          gateId: pending.gateId,
          ...inferredScope,
        };
        requests.push({
          resource: 'production',
          filters,
          mode: (filters.scopeType || pending.workPackageId || pending.workItemId) ? 'all' : 'initial',
        });
      }
      if (!requests.length) {
        setUrlReady(true);
        finishRestore();
        return;
      }
      void Promise.all(requests.map((request) => onNeedProduction(request))).then(async (models) => {
        const successfulRequest = requests.find((_request, index) => Boolean(models[index]));
        const model = successfulRequest ? await onNeedProduction(successfulRequest) : null;
        if (model) resolvePending(model);
        else setNavigationError('目标工作区的分页数据未能读取；已保留原链接，没有回退到旧全量兼容视图。');
        setUrlReady(true);
        finishRestore();
      });
    } else {
      setUrlReady(true);
      finishRestore();
    }
  };

  const historyLeaveRequiredRef = useRef<() => boolean>(() => false);
  historyLeaveRequiredRef.current = () => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('view');
    const next = window.location.hash === '#story-relations-title' || requested === 'story' && params.get('storyMode') === 'map'
      ? 'settings' : requested === 'assets' || params.has('asset') ? 'materials'
        : ['targets', 'shots'].includes(requested || '') ? 'pipeline'
          : requested === 'work' ? 'overview' : params.get('materialMode') === 'structure' ? 'story'
            : workspaceViews.some(item => item.id === requested) ? requested : 'overview';
    const nextStory = normalizedStoryView(params.get('storyMode'));
    const sameNarrativeModule = ['logic', 'audit'].includes(nextStory || '') && ['logic', 'audit'].includes(storyView);
    return next !== activeView || next === 'story' && !sameNarrativeModule && nextStory !== storyView;
  };

  useEffect(() => {
    const timer = window.setTimeout(() => locationRestorerRef.current((window.history.state || {}) as ReviewHistoryState, true), 0);
    let undoingRejectedNavigation = false;
    const restoreFromHistory = (event: PopStateEvent) => {
      if (undoingRejectedNavigation) { undoingRejectedNavigation = false; return; }
      if(historyLeaveRequiredRef.current()&&!window.dispatchEvent(new Event('review:configuration-before-leave',{cancelable:true}))){event.stopImmediatePropagation();undoingRejectedNavigation = true;window.history.go(1);return;}
      locationRestorerRef.current((event.state || {}) as ReviewHistoryState, false);
    };
    window.addEventListener('popstate', restoreFromHistory);
    return () => { window.clearTimeout(timer); window.removeEventListener('popstate', restoreFromHistory); };
  }, []);

  useEffect(() => {
    if (!resolvedEpisodePlan && !episodePlanError) return;
    const timer = window.setTimeout(() => {
      locationRestorerRef.current((window.history.state || {}) as ReviewHistoryState, false);
      setNarrativeLocationRevision(resolvedEpisodePlan?.revisionId || '');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [resolvedEpisodePlan?.revisionId, resolvedEpisodePlan?.content.narrativeRevision, episodePlanError]);

  useEffect(() => {
    mainScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeView]);

  useEffect(() => {
    readerScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [storyView, storySourceMode, transcriptSectionId, episodeId]);

  useEffect(() => {
    if (!storySourcesReady || !readerAnchor || !readerScrollRef.current) return;
    const timer = window.setTimeout(() => {
      const container = readerScrollRef.current;
      const target = document.getElementById(readerAnchor);
      if (!container || !target || !container.contains(target)) return;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + targetRect.top - containerRect.top - container.clientHeight * .28, behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [readerAnchor, storyView, storySourceMode, transcriptSectionId, episodeId, storySourcesReady]);

  useEffect(() => {
    if (lightbox) {
      previousLightboxRef.current = lightbox;
      lightboxCloseRef.current?.focus();
      return;
    }
    if (!previousLightboxRef.current) return;
    previousLightboxRef.current = null;
    window.requestAnimationFrame(() => {
      if (lightboxOpenerRef.current?.isConnected) lightboxOpenerRef.current.focus();
      lightboxOpenerRef.current = null;
    });
  }, [lightbox]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || lightbox) return;
      if (mobileMoreOpen) { setMobileMoreOpen(false); return; }
      if (searchResultsOpen) closeSearchResults();
    };
    const onPointer = (event: PointerEvent) => {
      if (mobileMoreOpen && event.target instanceof Node && !mobileMoreRef.current?.contains(event.target)) setMobileMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onPointer); };
  }, [lightbox, mobileMoreOpen, searchResultsOpen]);

  useEffect(() => {
    if (!urlReady || blockedPersistentRoute || pendingProductionIntentRef.current) return;
    if (activeView === 'story' && ((!resolvedEpisodePlan && !episodePlanError) || (narrativeCandidate && narrativeLocationRevision !== resolvedEpisodePlan?.revisionId))) return;
    const url = new URL(window.location.href);
    url.searchParams.set('view', activeView);
    if (activeView === 'story') {
      url.searchParams.set('storyMode', storyView === 'audit' ? 'logic' : storyView);
      if (storyView === 'audit') url.searchParams.set('narrativeLevel', 'scene');
      else url.searchParams.delete('narrativeLevel');
      if (storyView === 'source') {
        url.searchParams.set('source', storySourceMode);
        url.searchParams.set('transcript', transcriptSectionId);
      } else {
        url.searchParams.delete('source');
        url.searchParams.delete('transcript');
      }
      url.searchParams.delete('scriptPart');
      url.searchParams.delete('structureScene');
      if (storyView === 'audit' || storyView === 'logic') {
        const narrativeEpisode = narrativeCandidate || genericAuthoring ? resolvedEpisodePlan?.content.episodes.find((item) => item.episodeUid === episodeId || !genericAuthoring && item.displayId === episodeId) : null;
        url.searchParams.set('episode', narrativeEpisode?.episodeUid || episodeRouteId(episodeId));
        if (episodePlanIsCurrent) url.searchParams.set('episodeDisplay', episodeId);
        else url.searchParams.delete('episodeDisplay');
        if (narrativeCandidate) url.searchParams.delete('storySegment');
        else if (storyView === 'audit') url.searchParams.set('storySegment', storySegmentIdFromPhase(phaseId));
        else if (selectedLogic.itemId.startsWith('slice-seq-')) url.searchParams.set('storySegment', selectedLogic.itemId.slice('slice-'.length).toUpperCase());
        else url.searchParams.delete('storySegment');
      } else {
        url.searchParams.delete('episode');
        url.searchParams.delete('episodeDisplay');
        url.searchParams.delete('storySegment');
      }
      if (storyView === 'audit') {
        if (auditSceneId) url.searchParams.set('scene', auditSceneId);
        else url.searchParams.delete('scene');
      } else url.searchParams.delete('scene');
      if ((storyView === 'source' || storyView === 'audit') && readerAnchor) url.searchParams.set('readerAnchor', readerAnchor);
      else url.searchParams.delete('readerAnchor');
      if (storyView === 'audit' && auditBeatId) url.searchParams.set('auditBeat', auditBeatId);
      else url.searchParams.delete('auditBeat');
      if (storyView === 'audit' && auditSceneId) url.searchParams.set('confirmScene', auditSceneId);
      else url.searchParams.delete('confirmScene');
      if ((storyView === 'audit' || storyView === 'source' && narrativeCandidate) && auditVerificationIssueId) url.searchParams.set('verifyIssue', auditVerificationIssueId);
      else url.searchParams.delete('verifyIssue');
      if ((storyView === 'logic'||storyView === 'audit') && selectedLogic.itemId === 'causal-chains' && causeChainId) url.searchParams.set('causeChain', causeChainId);
      else url.searchParams.delete('causeChain');
      if (storyView === 'logic'||storyView === 'audit') {
        url.searchParams.set('logicGroup', selectedLogic.groupId);
        url.searchParams.set('logicItem', selectedLogic.itemId);
      } else {
        url.searchParams.delete('logicGroup');
        url.searchParams.delete('logicItem');
      }
      if (storyView === 'story-structure' && narrativeCandidate) {
        url.searchParams.set('narrativeSection',narrativeSection);
        url.searchParams.delete('structureSection');
      } else {
        url.searchParams.delete('narrativeSection');
        if (storyView === 'story-structure') url.searchParams.set('structureSection',storyStructureSection);
        else url.searchParams.delete('structureSection');
      }
      url.searchParams.delete('map');
    } else {
      ['storyMode', 'narrativeLevel', 'source', 'transcript', 'scriptPart', 'episode', 'episodeDisplay', 'storySegment', 'readerAnchor', 'auditBeat', 'confirmScene', 'verifyIssue', 'causeChain', 'logicGroup', 'logicItem', 'structureSection', 'narrativeSection', 'map'].forEach((key) => url.searchParams.delete(key));
    }
    url.searchParams.delete('asset');
    url.searchParams.delete('phase');
    if (activeView === 'pipeline') {
      const selectedPackage = productionModel.workPackages.find((item) => item.id === selectedWorkPackageId) || null;
      const selectedGate = productionModel.productionGates?.find((item) => item.id === selectedProductionGateId) || null;
      const historicalShotId = selectedWorkPackageId.startsWith('HISTORICAL_ONLY:')
        ? focusShotId
        : null;
      const currentPackage = selectedPackage?.activeInCurrentProduction === true
        && (!selectedProductionPhaseId || selectedPackage.phaseId === selectedProductionPhaseId)
        && (!selectedProductionGateId || selectedPackage.gateId === selectedProductionGateId)
        ? selectedPackage
        : null;
      const currentItem = selectedWorkItemId
        ? productionModel.workItems.find((item) => item.id === selectedWorkItemId && item.activeInCurrentProduction === true && (!selectedProductionGateId || item.gateId === selectedProductionGateId)) || null
        : null;
      if (selectedProductionPhaseId) url.searchParams.set('productionPhase', productionSlug(selectedProductionPhaseId));
      else url.searchParams.delete('productionPhase');
      if (selectedProductionGateId) url.searchParams.set('productionGate', productionSlug(selectedProductionGateId));
      else url.searchParams.delete('productionGate');
      const creatorStageId = creatorProductionStageForGate(selectedProductionGateId);
      // Preserve explicit invalid/mismatched links for the workspace to reject.
      if (creatorStageId && !url.searchParams.has('creatorStage')) url.searchParams.set('creatorStage',productionSlug(creatorStageId));
      url.searchParams.set('productionScope', currentPackage?.scopeType || selectedGate?.scopeType || 'UNKNOWN');
      url.searchParams.set('productionObject', currentPackage ? publicRef(currentPackage.scopeId) : 'UNKNOWN');
      ['scene', 'shot', 'work'].forEach((key) => url.searchParams.delete(key));
      if (historicalShotId) url.searchParams.set('shot', publicRef(historicalShotId));
      if (currentItem) url.searchParams.set('item', publicRef(currentItem.id));
      else url.searchParams.delete('item');
    } else if (activeView !== 'story') {
      url.searchParams.delete('scene');
      url.searchParams.delete('shot');
    }
    if (activeView !== 'pipeline') ['productionPhase', 'productionGate', 'productionScope', 'productionObject', 'creatorStage', 'preparationEpisode', 'preparationScene'].forEach((key) => url.searchParams.delete(key));
    if (activeView !== 'pipeline') url.searchParams.delete('work');
    url.searchParams.delete('productionMode');
    url.searchParams.delete('stage');
    const urlWorkItemId = activeView === 'pipeline'
      ? productionModel.workItems.find((item) => item.id === selectedWorkItemId && item.activeInCurrentProduction === true)?.id || null
      : null;
    if (urlWorkItemId) url.searchParams.set('item', publicRef(urlWorkItemId));
    else url.searchParams.delete('item');
    const urlFamilyId = activeView === 'materials'
      ? materialCenterState.familyId
      : activeView === 'pipeline'
        ? (urlWorkItemId ? selectedFamilyId : null)
        : null;
    const urlVersionId = activeView === 'materials'
      ? materialCenterState.versionId
      : activeView === 'pipeline'
        ? (urlWorkItemId ? selectedVersionId : null)
        : null;
    if (urlFamilyId) url.searchParams.set('family', publicRef(urlFamilyId));
    else url.searchParams.delete('family');
    if (urlVersionId) url.searchParams.set('version', publicRef(urlVersionId));
    else url.searchParams.delete('version');
    url.searchParams.delete('target');
    if (query.trim()) url.searchParams.set('q', query.trim());
    else url.searchParams.delete('q');
    if (searchResultsOpen) url.searchParams.set('searchOpen', '1');
    else url.searchParams.delete('searchOpen');
    ['todayMode', 'workArea', 'workActor', 'workState', 'workType', 'workStage'].forEach((key) => url.searchParams.delete(key));
    if (activeView === 'overview') {
      if (currentWorkView.stage) url.searchParams.set('workStage', currentWorkView.stage);
      if (currentWorkView.area !== 'ALL') url.searchParams.set('workArea', currentWorkView.area);
      if (currentWorkView.actor !== 'ALL') url.searchParams.set('workActor', currentWorkView.actor);
      if (currentWorkView.state !== 'NOW') url.searchParams.set('workState', currentWorkView.state);
      if (currentWorkView.type !== 'ALL') url.searchParams.set('workType', currentWorkView.type);
    }
    ['assetScope', 'assetKind', 'assetState', 'assetPage', 'assetQ'].forEach((key) => url.searchParams.delete(key));
    if (activeView === 'materials') {
      if (materialCenterState.requirementId) url.searchParams.set('material', publicRef(materialCenterState.requirementId));
      else url.searchParams.delete('material');
      url.searchParams.set('materialMedia', materialCenterState.mediaType);
      url.searchParams.set('materialPrimary', materialCenterState.businessPrimary);
      url.searchParams.set('materialCategory', materialCenterState.category);
      url.searchParams.set('materialEpisode', materialEpisodeScopeId || materialCenterState.episodeScope);
      if (materialEpisodeScopeId && materialEpisodeScopeId !== materialCenterState.episodeScope) {
        url.searchParams.set('materialEpisodeDisplay', materialCenterState.episodeScope);
      } else url.searchParams.delete('materialEpisodeDisplay');
      url.searchParams.set('materialScene', materialCenterState.sceneScope);
      url.searchParams.set('materialShot', materialCenterState.shotScope);
      url.searchParams.set('materialCreatorStage', materialCenterState.creatorStage);
      url.searchParams.set('materialCoverage', materialCenterState.coverage);
      // The entity catalog owns the permanent state identity, including an
      // unresolved deep link. Do not erase it during unrelated filter updates.
      url.searchParams.delete('materialPage');
      // Legacy episodes/relations links keep their exact filters and targets in the single catalog.
      url.searchParams.set('materialMode', 'classification');
      ['assetOwner', 'assetBusinessState', 'assetFact', 'assetKind', 'assetEpisode', 'assetEpisodeDisplay', 'assetPage', 'assetQ'].forEach((key) => url.searchParams.delete(key));
      if (materialCenterState.search.trim()) url.searchParams.set('materialQ', materialCenterState.search.trim());
      else url.searchParams.delete('materialQ');
      url.searchParams.delete('map');
    } else {
      ['material', 'materialPanel', 'materialRelation', 'materialTrial', 'materialTrialVersion', 'materialMedia', 'materialPrimary', 'materialCategory', 'materialEpisode', 'materialEpisodeDisplay', 'materialScene', 'materialShot', 'materialCreatorStage', 'materialCoverage', 'materialState', 'materialPage', 'materialMode', 'structureScene', 'materialQ', 'assetOwner', 'assetBusinessState', 'assetFact', 'assetKind', 'assetEpisode', 'assetEpisodeDisplay', 'assetPage', 'assetQ'].forEach((key) => url.searchParams.delete(key));
    }
    if(activeView==='materials')saveMaterialBrowseLocation(url);
    ['targetEpisode', 'targetScene', 'targetSubset', 'targetPage'].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState({ ...(window.history.state || {}) }, '', url);
  }, [resolvedEpisodePlan, episodePlanError, narrativeCandidate, narrativeLocationRevision, activeView, storyView, storySourceMode, transcriptSectionId, readerAnchor, auditBeatId, auditSceneId, auditVerificationIssueId, causeChainId, episodeId, episodePlanIsCurrent, episodeRouteId, phaseId, selectedLogic.groupId, selectedLogic.itemId, storyStructureSection, narrativeSection, focusShotId, selectedWorkPackageId, selectedWorkItemId, selectedFamilyId, selectedVersionId, selectedProductionPhaseId, selectedProductionGateId, materialCenterState, materialEpisodeScopeId, currentWorkView, query, searchResultsOpen, urlReady, blockedPersistentRoute, productionModel]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      fetch(`/api/v8/ui/search?q=${encodeURIComponent(needle)}&limit=12`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{ data: SearchResult[]; total: number }>;
        })
        .then((payload) => { setSearchResults(payload.data); setSearchTotal(payload.total); })
        .catch((reason: unknown) => {
          if ((reason as { name?: string }).name !== 'AbortError') { setSearchResults([]); setSearchTotal(0); }
        })
        .finally(() => setSearchLoading(false));
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  function saveCurrentHistoryEntry() {
    const state = (window.history.state || {}) as ReviewHistoryState;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusSelector = activeElement ? stableElementSelector(activeElement) : null;
    window.history.replaceState({
      ...state,
      reviewRestore: {
        mainTop: mainScrollRef.current?.scrollTop || 0,
        readerTop: readerScrollRef.current?.scrollTop || 0,
        searchOpen: searchResultsOpen,
        focusSelector,
      },
    }, '', window.location.href);
  }

  function stableElementSelector(element: HTMLElement) {
    const parts: string[] = [];
    let current: HTMLElement | null = element;
    while (current && current !== document.documentElement) {
      if (current.id) {
        parts.unshift(`#${window.CSS.escape(current.id)}`);
        break;
      }
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      const tag = current.tagName.toLocaleLowerCase();
      const siblings = Array.from(parent.children).filter((item) => item.tagName === current?.tagName);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = parent;
    }
    return parts.join(' > ');
  }

  function canLeaveCurrentView() {
    if (!window.dispatchEvent(new Event("review:configuration-before-leave", {cancelable:true}))) return false;
    window.dispatchEvent(new Event('review:flush-review-draft'));
    if (document.documentElement.dataset.reviewDraftUnsaved !== 'true') return true;
    return window.confirm('本机草稿保存失败。现在离开可能丢失尚未复制的审阅记录，仍要离开吗？');
  }

  function pushDestination(url: URL, origin?: NavigationOrigin, overlay?: OverlayHistory) {
    saveCurrentHistoryEntry();
    const nextState: ReviewHistoryState = {
      ...(window.history.state || {}),
      reviewOrigin: origin,
      reviewRestore: undefined,
      reviewOverlay: overlay,
      evidenceRequest: undefined,
    };
    window.history.pushState(nextState, '', url);
    setNavigationOrigin(origin || null);
  }

  function cleanDestinationUrl(url: URL) {
    ['asset', 'lightbox', 'evidenceRef', 'searchOpen'].forEach((key) => url.searchParams.delete(key));
    url.hash = '';
  }

  function openSearchResults() {
    if (searchResultsOpen) return;
    const url = new URL(window.location.href);
    url.searchParams.set('searchOpen', '1');
    saveCurrentHistoryEntry();
    window.history.pushState({ ...(window.history.state || {}), reviewOverlay: { kind: 'search', depth: 1 } }, '', url);
    setSearchResultsOpen(true);
  }

  function closeSearchResults() {
    const state = (window.history.state || {}) as ReviewHistoryState;
    if (state.reviewOverlay?.kind === 'search' && state.reviewOverlay.depth > 0) {
      window.history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete('searchOpen');
      window.history.replaceState({ ...state, reviewOverlay: undefined }, '', url);
      setSearchResultsOpen(false);
      setMobileSearchOpen(false);
    }
    window.setTimeout(() => searchToggleRef.current?.focus(), 0);
  }

  function goToView(view: WorkspaceView, pushHistory = true, origin?: NavigationOrigin) {
    if (blockedPersistentRoute) return;
    if (view !== activeView && !canLeaveCurrentView()) return;
    if (view !== activeView && pushHistory && urlReady) {
      const url = new URL(window.location.href);
      if(activeView==='materials')saveMaterialBrowseLocation(url);
      cleanDestinationUrl(url);
      url.searchParams.set('view', view);
      if(view==='materials'){
        restoreMaterialBrowseLocation(url,true);
        const params=url.searchParams;
        setMaterialCenterState({...defaultMaterialCenterState,
          search:params.get('materialQ')||'',
          mediaType:(params.get('materialMedia') as MaterialCenterViewState['mediaType'])||'全部',
          businessPrimary:params.get('materialPrimary')||'全部',
          category:params.get('materialCategory')||'全部',
          episodeScope:params.get('materialEpisode')||'全部',
          sceneScope:params.get('materialScene')||'全部',
          creatorStage:isMaterialCreatorStage(params.get('materialCreatorStage'))?params.get('materialCreatorStage') as MaterialCenterViewState['creatorStage']:'全部',
          coverage:params.get('materialCoverage')==='EVIDENCE_ONLY'?'全部':(params.get('materialCoverage') as MaterialCenterViewState['coverage'])||'全部',
          requirementId:null,familyId:null,versionId:null,workspaceMode:'classification',
        });
      }
      pushDestination(url, origin);
    }
    stopSeamAudition();
    if (view === 'overview') setCurrentWorkView(defaultCurrentWorkView);
    setActiveView(view);
    setMobileSearchOpen(false);
    setSearchResultsOpen(false);
    setMobileMoreOpen(false);
    setLightbox(null);
  }

  function recoverBlockedPersistentRoute() {
    const url = new URL(window.location.href);
    url.search = '';
    const firstEpisode = reviewData.creativeLineage.episodes[0];
    const currentNarrativeEpisode = resolvedEpisodePlan?.content.narrativeRevision && resolvedEpisodePlan.content.episodes[0];
    if (blockedPersistentRoute === 'EPISODE' && currentNarrativeEpisode && resolvedEpisodePlan) {
      url.searchParams.set('view', 'story');
      url.searchParams.set('storyMode', 'logic');
      url.searchParams.set('episode', currentNarrativeEpisode.episodeUid);
      url.searchParams.set('episodePlanRevision', resolvedEpisodePlan.revisionId);
    } else if (blockedPersistentRoute === 'EPISODE' && firstEpisode) {
      const firstScene = reviewData.creativeLineage.scenes.find((item) => item.id === firstEpisode.sceneIds[0]);
      url.searchParams.set('view', 'story');
      url.searchParams.set('storyMode', 'logic');
      url.searchParams.set('episode', episodeRouteId(firstEpisode.episodeUid || firstEpisode.id));
      url.searchParams.set('episodeDisplay', firstEpisode.displayId || firstEpisode.id);
      if (firstScene) {
        url.searchParams.set('scene', firstScene.id);
        url.searchParams.set('storySegment', storySegmentIdFromPhase(firstScene.phaseId));
      }
    } else {
      url.searchParams.set('view', 'overview');
    }
    window.history.replaceState({ ...(window.history.state || {}), reviewOrigin: undefined, reviewRestore: undefined }, '', url);
    setBlockedPersistentRoute(null);
    setNavigationError('');
    setUrlReady(false);
    locationRestorerRef.current((window.history.state || {}) as ReviewHistoryState, false);
  }

  function openLightbox(src: string, initialZoom: number, opener: HTMLElement) {
    lightboxOpenerRef.current = opener;
    const url = new URL(window.location.href);
    url.searchParams.set('lightbox', src);
    saveCurrentHistoryEntry();
    window.history.pushState({ ...(window.history.state || {}), reviewOverlay: { kind: 'lightbox', depth: 1 } }, '', url);
    setZoom(initialZoom);
    setLightbox(src);
  }

  function closeLightbox() {
    const state = (window.history.state || {}) as ReviewHistoryState;
    if (state.reviewOverlay?.kind === 'lightbox' && state.reviewOverlay.depth > 0) {
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('lightbox');
    window.history.replaceState({ ...state, reviewOverlay: undefined }, '', url);
    setLightbox(null);
    requestAnimationFrame(() => {
      if (lightboxOpenerRef.current?.isConnected) lightboxOpenerRef.current.focus();
      lightboxOpenerRef.current = null;
    });
  }

  function trapLightboxFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeLightbox();
      return;
    }
    if (event.key !== 'Tab' || !lightboxRef.current) return;
    const controls = Array.from(lightboxRef.current.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])')).filter((node) => !node.hasAttribute('disabled'));
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function navigateProduction(intent: ProductionNavigationIntent) {
    const emptyStageIntent = !intent.shotId && !intent.workPackageId && !intent.workItemId
      && !intent.familyId && !intent.versionId && !intent.legacyStage
      && Boolean(intent.phaseId && intent.gateId);
    if (emptyStageIntent) {
      if (pendingProductionIntentRef.current) return;
      const phase = productionModel.productionPhases?.find((item) => item.id === intent.phaseId);
      const gate = productionModel.productionGates?.find((item) => item.id === intent.gateId && item.phaseId === phase?.id);
      if (!phase || !gate || !canLeaveCurrentView()) return;
      const creator = creatorProductionStageForGate(gate.id);
      if (intent.creatorStageId && intent.creatorStageId !== creator) return;
      const url=new URL(window.location.href);
      url.searchParams.set('view','pipeline');
      url.searchParams.set('productionPhase',productionSlug(phase.id));
      url.searchParams.set('productionGate',productionSlug(gate.id));
      if(creator)url.searchParams.set('creatorStage',productionSlug(creator));
      url.searchParams.set('productionScope',gate.scopeType || 'UNKNOWN');
      url.searchParams.set('productionObject','UNKNOWN');
      for(const key of ['scene','shot','work','item','family','version'])url.searchParams.delete(key);
      if(intent.preparationEpisodeUid)url.searchParams.set('preparationEpisode',intent.preparationEpisodeUid);
      if(intent.navigationScopeType==='SCENE'&&intent.preparationSceneId)url.searchParams.set('preparationScene',intent.preparationSceneId);
      else url.searchParams.delete('preparationScene');
      if(url.href!==window.location.href)window.history.pushState({...window.history.state},'',url);
      // One history entry contains the navigation scope and canonical check.
      // Browsing never selects an old shot or establishes a formal scope lock.
      setProductionContext({ shotId: '', workPackageId: '', workItemId: null, familyId: null, versionId: null, phaseId: phase.id, gateId: gate.id });
      return;
    }
    const next = resolveProductionContext(productionModel, intent);
    const shot = productionModel.shots.find((item) => item.id === next.shotId);
    if (!shot) return;
    if (next.shotId !== productionContext.shotId && !canLeaveCurrentView()) return;
    setProductionContext(next);
  }

  async function openProductionIntent(intent: ProductionNavigationIntent, originLabel: string, modelOverride?: ProductionModel | null) {
    if (!canLeaveCurrentView()) return;
    const model = modelOverride || await onNeedProduction({
      resource: 'production',
      filters: {
        phaseId: intent.phaseId || null,
        gateId: intent.gateId || null,
        scopeType: 'SHOT',
        scopeId: intent.shotId,
      },
      mode: 'all',
    });
    if (!model) {
      setNavigationError('制作关系暂时无法读取；已留在原位置，没有跳到错误对象。');
      return;
    }
    const requestedShot = model.shots.find((item) => item.id === intent.shotId || publicRef(item.id) === intent.shotId);
    if (!requestedShot) {
      setNavigationError(`无法定位 ${intent.shotId}；已留在原位置，没有回退到默认镜头。`);
      return;
    }
    const next = resolveProductionContext(model, { ...intent, shotId: requestedShot.id });
    const nextPackage = model.workPackages.find((item) => item.id === next.workPackageId) || null;
    if (nextPackage?.stepId === 'W01') {
      const itemIds = new Set(nextPackage.workItemRefs);
      const materialModel = await onNeedProduction({ resource: 'materials', mode: 'all' });
      const requirement = (materialModel?.materialRequirements || []).find((item) => item.consumerWorkItemRefs.some((id) => itemIds.has(id))) || null;
      if (requirement) {
        await openMaterialCenter(requirement.id, originLabel, materialModel);
        return;
      }
      const materialUrl = new URL(window.location.href);
      cleanDestinationUrl(materialUrl);
      ['scene', 'shot', 'work', 'item', 'stage', 'productionPhase', 'productionGate', 'productionScope', 'productionObject'].forEach((key) => materialUrl.searchParams.delete(key));
      materialUrl.searchParams.set('view', 'materials');
      materialUrl.searchParams.set('materialMode', 'classification');
      materialUrl.searchParams.set('materialPrimary', '场景');
      materialUrl.searchParams.set('materialCategory', '地点状态');
      pushDestination(materialUrl, { label: originLabel });
      setMaterialCenterState({ ...defaultMaterialCenterState, workspaceMode: 'classification', businessPrimary: '场景', category: '地点状态' });
      setActiveView('materials');
      return;
    }
    const url = new URL(window.location.href);
    cleanDestinationUrl(url);
    url.searchParams.set('view', 'pipeline');
    ['scene', 'shot', 'work', 'stage'].forEach((key) => url.searchParams.delete(key));
    if (next.phaseId) url.searchParams.set('productionPhase', productionSlug(next.phaseId));
    if (next.gateId) url.searchParams.set('productionGate', productionSlug(next.gateId));
    const creator = creatorProductionStageForGate(next.gateId);
    if(creator)url.searchParams.set('creatorStage',productionSlug(creator));
    const currentPackage = nextPackage?.activeInCurrentProduction === true ? nextPackage : null;
    const gate = model.productionGates?.find((item) => item.id === next.gateId) || null;
    url.searchParams.set('productionScope', currentPackage?.scopeType || gate?.scopeType || 'UNKNOWN');
    url.searchParams.set('productionObject', currentPackage ? publicRef(currentPackage.scopeId) : 'UNKNOWN');
    const currentItem = next.workItemId ? model.workItems.find((item) => item.id === next.workItemId && item.activeInCurrentProduction === true) || null : null;
    if (currentItem) url.searchParams.set('item', publicRef(currentItem.id)); else url.searchParams.delete('item');
    if (currentItem && next.familyId) url.searchParams.set('family', publicRef(next.familyId)); else url.searchParams.delete('family');
    if (currentItem && next.versionId) url.searchParams.set('version', publicRef(next.versionId)); else url.searchParams.delete('version');
    pushDestination(url, { label: originLabel });
    stopSeamAudition();
    setNavigationError('');
    setProductionContext(next);
    setActiveView('pipeline');
    setSearchResultsOpen(false);
    setMobileSearchOpen(false);
    setMobileMoreOpen(false);
  }

  async function openMaterialCenter(requirementId: string, originLabel: string, modelOverride?: ProductionModel | null) {
    if (!canLeaveCurrentView()) return;
    const model = modelOverride || await onNeedProduction({ resource: 'materials', mode: 'all' });
    const requirement = model?.materialRequirements?.find((item) => item.id === requirementId || publicRef(item.id) === requirementId) || null;
    if (!model || !requirement) {
      setNavigationError(`无法定位素材需求 ${requirementId}；已留在原位置。`);
      return;
    }
    const family = model.assetFamilies.find((item) => requirement.assetFamilyRefs.includes(item.id)) || null;
    const versionId = resolveFamilyVersionSelection(model, family);
    const url = new URL(window.location.href);
    cleanDestinationUrl(url);
    ['scene', 'shot', 'work', 'item', 'stage', 'productionPhase', 'productionGate', 'productionScope', 'productionObject'].forEach((key) => url.searchParams.delete(key));
    url.searchParams.set('view', 'materials');
    url.searchParams.set('materialMode', 'classification');
    url.searchParams.set('material', publicRef(requirement.id));
    if (family) url.searchParams.set('family', publicRef(family.id)); else url.searchParams.delete('family');
    if (versionId) url.searchParams.set('version', publicRef(versionId));
    else url.searchParams.delete('version');
    pushDestination(url, { label: originLabel });
    setMaterialCenterState({ ...defaultMaterialCenterState, workspaceMode: 'classification', requirementId: requirement.id, familyId: family?.id || null, versionId });
    setNavigationError('');
    setActiveView('materials');
    setSearchResultsOpen(false);
    setMobileSearchOpen(false);
    setMobileMoreOpen(false);
  }

  async function openStructureRecompile(nextSceneId: string, originLabel: string, _modelOverride?: ProductionModel | null) {
    void _modelOverride;
    if (!canLeaveCurrentView()) return;
    const scene = reviewData.creativeLineage.scenes.find((item) => item.id === nextSceneId);
    if (!scene) {
      setNavigationError(`无法定位 ${nextSceneId} 的叙事关系；已留在原位置。`);
      return;
    }
    const url = new URL(window.location.href);
    cleanDestinationUrl(url);
    ['shot', 'work', 'item', 'stage', 'material', 'family', 'version', 'materialMode', 'structureScene'].forEach((key) => url.searchParams.delete(key));
    url.searchParams.set('view', 'story');
    url.searchParams.set('storyMode', 'logic');
    url.searchParams.set('scene', nextSceneId);
    url.searchParams.set('episode', episodeRouteId(scene.episodeAssignment.episodeUid || scene.episodeAssignment.episodeId));
    if (episodePlanIsCurrent) url.searchParams.set('episodeDisplay', scene.episodeAssignment.episodeId);
    url.searchParams.set('storySegment', storySegmentIdFromPhase(scene.phaseId));
    pushDestination(url, { label: originLabel });
    selectLineageScene(nextSceneId);
    setStoryView('logic');
    setNavigationError('');
    setActiveView('story');
    setSearchResultsOpen(false);
    setMobileSearchOpen(false);
    setMobileMoreOpen(false);
  }

  async function openScenePipeline(nextSceneId: string, originLabel: string) {
    const model = await onNeedProduction({ resource: 'production', filters: { scopeType: 'SCENE', scopeId: nextSceneId }, mode: 'all' });
    const currentShotIds = model ? fullProductionCurrentShotIds(model) : new Set<string>();
    const firstShot = model?.shots.find((item) => item.sceneId === nextSceneId && currentShotIds.has(item.id));
    if (!firstShot) {
      setNavigationError(`当前快照没有 ${nextSceneId} 的可执行制作镜头；历史结构卡只保留为证据，不构成制作入口。`);
      return;
    }
    await openProductionIntent({ shotId: firstShot.id }, originLabel, model);
  }

  function navigateToInternalHref(href: string, originLabel: string) {
    if (!canLeaveCurrentView()) return;
    const url = new URL(href, window.location.href);
    cleanDestinationUrl(url);
    pushDestination(url, { label: originLabel });
    locationRestorerRef.current((window.history.state || {}) as ReviewHistoryState, false);
  }

  function selectEpisodeForReview(nextEpisodeId: string) {
    const decision = resolvedEpisodePlan?.content.episodes.find((item) => item.displayId === nextEpisodeId || item.episodeUid === nextEpisodeId);
    if (!decision) return;
    if (storyView === 'audit' && !canLeaveCurrentView()) return;
    setEpisodeId(decision.episodeUid);
    setStoryView('logic');
    setAuditSceneId(null);
    const selection = normalizeLogicSelection(logicGroup, logicItem, decision.reviewDossier);
    const url=new URL(window.location.href);
    url.searchParams.set('storyMode','logic');
    for (const key of ['scene','confirmScene','narrativeLevel','auditBeat','verifyIssue']) url.searchParams.delete(key);
    url.searchParams.set('episode',decision.episodeUid);
    url.searchParams.set('logicGroup',selection.groupId);
    url.searchParams.set('logicItem',selection.itemId);
    if(url.href!==window.location.href)pushDestination(url,(window.history.state as ReviewHistoryState)?.reviewOrigin);
    setLogicGroup(selection.groupId);
    setLogicItem(selection.itemId);
    setReaderAnchor(null);
  }

  function selectLineageScene(nextSceneId: string) {
    const nextScene = reviewData.creativeLineage.scenes.find((item) => item.id === nextSceneId);
    if (!nextScene) return;
    if(genericAuthoring){const owner=resolvedEpisodePlan?.content.episodes.find(episode=>episode.sceneIds.includes(nextSceneId));setStorySceneId(nextSceneId);setEpisodeId(owner?.episodeUid||'');setReaderAnchor(null);return;}
    setPhaseId(nextScene.phaseId);
    setStorySceneId(nextSceneId);
    setEpisodeId(nextScene.episodeAssignment.episodeId);
    setReaderAnchor(null);
  }

  function selectStoryMode(nextMode: StoryView) {
    if (nextMode !== storyView && !canLeaveCurrentView()) return;
    setStoryView(nextMode);
    setReaderAnchor(null);
  }

  function selectNarrativeSection(section: NarrativeOverviewSection) {
    if (section===narrativeSection) return;
    const url=new URL(window.location.href);
    url.searchParams.set('narrativeSection',section);
    url.searchParams.delete('structureSection');
    pushDestination(url);
    setNarrativeSection(section);
  }

  function selectLogicItem(nextGroup: EpisodeCriterionId, nextItem: string) {
    setLogicGroup(nextGroup);
    setLogicItem(nextItem);
    if (nextItem === 'causal-chains') setCauseChainId(null);
  }

  function selectLogicCriterion(nextGroup: EpisodeCriterionId) {
    if (!selectedEpisodeDecision) return;
    setLogicGroup(nextGroup);
    setLogicItem(firstLogicItem(nextGroup, selectedEpisodeDecision.reviewDossier));
  }

  function openStoryScene(nextSceneId: string, originLabel: string, navigation: 'push' | 'replace' = 'push') {
    if (resolvedEpisodePlan && (resolvedEpisodePlan.content.narrativeRevision?.scenes.some((scene) => scene.id === nextSceneId) || genericAuthoring && resolvedEpisodePlan.content.episodes.filter(episode=>episode.sceneIds.includes(nextSceneId)).length===1)) {
      if (!canLeaveCurrentView()) return;
      const owners=resolvedEpisodePlan.content.episodes.filter((item)=>item.sceneIds.includes(nextSceneId));
      if (owners.length !== 1) { setNavigationError('此场尚未唯一归属当前分集方案，不能打开另一场代替。'); return; }
      const owner=owners[0];
      const url=new URL(window.location.href);cleanDestinationUrl(url);
      url.searchParams.set('view','story');url.searchParams.set('storyMode','logic');url.searchParams.set('narrativeLevel','scene');url.searchParams.set('episodePlanRevision',resolvedEpisodePlan.revisionId);url.searchParams.set('episode',owner.episodeUid);url.searchParams.set('scene',nextSceneId);url.searchParams.set('confirmScene',nextSceneId);
      const logicSelection=normalizeLogicSelection(logicGroup,logicItem,owner.reviewDossier);
      url.searchParams.set('logicGroup',logicSelection.groupId);url.searchParams.set('logicItem',logicSelection.itemId);
      if (url.href !== window.location.href) {
        if (navigation === 'replace') window.history.replaceState(window.history.state, '', url);
        else pushDestination(url, activeView === 'story' ? (window.history.state as ReviewHistoryState)?.reviewOrigin : { label: originLabel });
      }
      setReaderAnchor(null);
      setLogicGroup(logicSelection.groupId);setLogicItem(logicSelection.itemId);
      setAuditSceneId(nextSceneId); setEpisodeId(owner.episodeUid); setStoryView('audit'); setActiveView('story');
      return;
    }
    if(genericAuthoring){setNavigationError('此场尚未唯一归属当前分集方案，不能打开另一场代替。');return;}
    const scene = reviewData.creativeLineage.scenes.find((item) => item.id === nextSceneId);
    if (!scene || !canLeaveCurrentView()) return;
    const dossier = sceneReviewDossiers.find((item) => item.sceneId === scene.id);
    const beatId = dossier?.directBeatIds[0]
      || dossier?.relatedBeatIds[0]
      || storyConfirmations.find((item) => item.sceneId === scene.id)?.sourceBeatIds?.[0]
      || adaptationAudit?.beats.find((beat) => [...(beat.current_mapping.scene_ids || []), ...(beat.adaptation_decision.target_scene_ids || [])].includes(scene.id))?.beat_id
      || adaptationAudit?.beats[0]?.beat_id
      || 'TR-011';
    openAuditScene(scene.id, beatId, originLabel);
  }

  function openTranscriptBeat(nextBeatId: string, nextSectionId: string, originLabel: string) {
    if (!nextBeatId || !nextSectionId || !canLeaveCurrentView()) return;
    const url = new URL(window.location.href);
    cleanDestinationUrl(url);
    ['scene', 'confirmScene', 'verifyIssue', 'auditBeat', 'episode', 'episodeDisplay', 'storySegment'].forEach((key) => url.searchParams.delete(key));
    url.searchParams.set('view', 'story');
    url.searchParams.set('storyMode', 'source');
    url.searchParams.set('source', 'transcript');
    url.searchParams.set('transcript', nextSectionId);
    url.searchParams.set('readerAnchor', nextBeatId);
    pushDestination(url, { label: originLabel });
    setAuditBeatId(null);
    setAuditSceneId(null);
    setAuditVerificationIssueId(null);
    setStorySourceMode('transcript');
    setTranscriptSectionId(nextSectionId);
    setReaderAnchor(nextBeatId);
    setStoryView('source');
    setNavigationError('');
    setActiveView('story');
    setSearchResultsOpen(false);
    setMobileSearchOpen(false);
  }

  function openAuditBeat(nextBeatId: string, originLabel: string, hint: { sceneId?: string; sectionId?: string } = {}) {
    if (!nextBeatId) return;
    const beat = adaptationAudit?.beats.find((item) => item.beat_id === nextBeatId);
    const mappedSceneId = beat
      ? [...(beat.current_mapping.scene_ids || []), ...(beat.adaptation_decision.target_scene_ids || [])][0]
      : null;
    const directSceneIds = sceneReviewDossiers.filter((item) => item.directBeatIds.includes(nextBeatId)).map((item) => item.sceneId);
    const directSceneId = directSceneIds.length === 1 ? directSceneIds[0] : null;
    const nextSceneId = hint.sceneId || mappedSceneId || directSceneId;
    if (nextSceneId) {
      openAuditScene(nextSceneId, nextBeatId, originLabel);
      return;
    }
    const nextSectionId = hint.sectionId
      || storySources.transcript.sections.find((item) => item.segmentIds.includes(nextBeatId))?.id;
    if (nextSectionId) {
      openTranscriptBeat(nextBeatId, nextSectionId, originLabel);
      return;
    }
    setNavigationError(`无法定位原文段落 ${nextBeatId}；已留在原位置。`);
  }

  function openAuditScene(nextSceneId: string, beatId: string, originLabel?: string, verificationIssueId?: string) {
    const scene = reviewData.creativeLineage.scenes.find((item) => item.id === nextSceneId);
    if (!scene || !canLeaveCurrentView()) return;
    const url = new URL(window.location.href);
    cleanDestinationUrl(url);
    url.searchParams.set('view', 'story');
    url.searchParams.set('storyMode', 'audit');
    url.searchParams.set('auditBeat', beatId);
    url.searchParams.set('confirmScene', scene.id);
    if (verificationIssueId) url.searchParams.set('verifyIssue', verificationIssueId);
    else url.searchParams.delete('verifyIssue');
    url.searchParams.set('scene', scene.id);
    url.searchParams.set('episode', episodeRouteId(scene.episodeAssignment.episodeUid || scene.episodeAssignment.episodeId));
    if (episodePlanIsCurrent) url.searchParams.set('episodeDisplay', scene.episodeAssignment.episodeId);
    url.searchParams.set('storySegment', storySegmentIdFromPhase(scene.phaseId));
    if (originLabel) {
      pushDestination(url, { label: originLabel });
    } else {
      const currentState = (window.history.state || {}) as ReviewHistoryState;
      window.history.replaceState({
        ...currentState,
        reviewOrigin: undefined,
        reviewRestore: undefined,
        reviewOverlay: undefined,
        evidenceRequest: undefined,
      }, '', url);
      setNavigationOrigin(null);
    }
    setAuditBeatId(beatId);
    setAuditSceneId(scene.id);
    setAuditVerificationIssueId(verificationIssueId || null);
    selectLineageScene(scene.id);
    setStoryView('audit');
    setActiveView('story');
    setSearchResultsOpen(false);
    setMobileSearchOpen(false);
  }

  function seekStoryAudio(seconds: number) {
    const player = storyAudioRef.current;
    if (!player) return;
    player.currentTime = seconds;
    void player.play().catch(() => undefined);
  }

  async function openResult(result: SearchResult) {
    if(result.view==='settings'){
      if(!canLeaveCurrentView())return;
      const url=new URL(window.location.href);cleanDestinationUrl(url);url.searchParams.set('view','settings');
      for(const key of ['settingsEntity','settingsRelation','settingsState','settingsSection'])url.searchParams.delete(key);
      if(result.kind==='设定关系'){url.searchParams.set('settingsSection','relations');url.searchParams.set('settingsRelation',result.id);}
      else{url.searchParams.set('settingsEntity',result.id);if(result.kind==='空间证据')url.searchParams.set('settingsSection','space');}
      window.history.pushState({},'',url);window.dispatchEvent(new PopStateEvent('popstate'));setSearchResultsOpen(false);return;
    }
    const originLabel = `搜索结果 · ${publicRef(result.id)} ${visibleText(result.title)}`;
    if (result.kind === '素材需求') {
      await openMaterialCenter(result.id, originLabel);
      return;
    }
    if (result.kind === '结构卡') {
      await openStructureRecompile(result.structureSceneId || result.sceneId || result.id, originLabel);
      return;
    }
    if (result.kind === '原文审计' || result.kind === '制作影响') {
      if (result.auditBeatId) openAuditBeat(result.auditBeatId, originLabel, { sceneId: result.sceneId, sectionId: result.sectionId });
      else setNavigationError(`无法定位 ${result.id} 的原文节拍；已留在搜索结果。`);
      return;
    }
    if (result.kind === '因果链' || result.kind === '空间证据') {
      const url = new URL(window.location.href);
      cleanDestinationUrl(url);
      url.searchParams.set('view', 'story');
      if (result.kind === '因果链') {
        url.searchParams.set('storyMode', 'story-structure');
        if (narrativeCandidate && resolvedEpisodePlan) {
          url.searchParams.set('narrativeSection','causality');
          url.searchParams.set('episodePlanRevision',resolvedEpisodePlan.revisionId);
          url.searchParams.delete('structureSection');
        } else {url.searchParams.delete('narrativeSection');url.searchParams.set('structureSection','audience');}
      } else {
        url.searchParams.set('view', 'settings');
        url.searchParams.set('settingsSection', 'space');
        if(result.mapLocationId)url.searchParams.set('settingsEntity',result.mapLocationId);
      }
      navigateToInternalHref(url.toString(), originLabel);
      return;
    }
    if (result.kind === '素材' || result.kind === '资产族') {
      const model = await onNeedProduction({ resource: 'materials', mode: 'all' });
      const family = model?.assetFamilies.find((item) => item.id === result.id || publicRef(item.id) === result.id);
      if (!model || !family) { setNavigationError(`无法定位素材 ${result.id}；已留在搜索结果。`); return; }
      const requirement = (model.materialRequirements || []).find((item) => item.requirementClass === 'REQUIRED' && item.assetFamilyRefs.includes(family.id)) || null;
      if (!requirement) {
        setNavigationError(`410 · ${publicRef(family.id)} 不属于当前可复用素材；全剧产物请从“全剧制作”所属门禁进入，退役记录不再进入素材搜索。`);
        return;
      }
      const versionId = resolveFamilyVersionSelection(model, family);
      const url = new URL(window.location.href);
      cleanDestinationUrl(url);
      url.searchParams.set('view', 'materials');
      url.searchParams.set('materialMode', 'classification');
      url.searchParams.set('material', publicRef(requirement.id));
      url.searchParams.set('family', publicRef(family.id));
      if (versionId) url.searchParams.set('version', publicRef(versionId));
      pushDestination(url, { label: originLabel });
      setMaterialCenterState({ ...defaultMaterialCenterState, workspaceMode: 'classification', requirementId: requirement.id, familyId: family.id, versionId });
      setActiveView('materials');
      setSearchResultsOpen(false);
      setMobileSearchOpen(false);
      return;
    }
    if (result.kind === '目标') {
      const model = await onNeedProduction({ resource: 'production', filters: { scopeType: 'SCENE', scopeId: result.id }, mode: 'all' });
      const currentShotIds = model ? fullProductionCurrentShotIds(model) : new Set<string>();
      const firstShot = model?.shots.find((item) => item.sceneId === result.id && currentShotIds.has(item.id));
      if (!model || !firstShot) { setNavigationError(`无法定位场次 ${result.id}；已留在搜索结果。`); return; }
      await openProductionIntent({ shotId: firstShot.id }, originLabel, model);
      return;
    }
    if (result.kind === '镜头') {
      await openProductionIntent({ shotId: result.id }, originLabel);
      return;
    }
    if (result.kind === '场景包') {
      await openScenePipeline(result.sceneId || result.id, originLabel);
      return;
    }
    const url = new URL(window.location.href);
    cleanDestinationUrl(url);
    const resultView = result.view === 'assets'
      ? 'materials'
      : result.view === 'targets' || result.view === 'shots'
        ? 'pipeline'
        : result.view === 'work'
          ? 'overview'
          : result.view;
    url.searchParams.set('view', resultView);
    if (result.episodePlanRevision) url.searchParams.set('episodePlanRevision', result.episodePlanRevision);
    if (result.view === 'assets') url.searchParams.set('materialMode', 'classification');
    if (result.view === 'work') url.searchParams.set('workArea', 'EXCEPTION');
    if (result.kind === '故事') {
      url.searchParams.set('storyMode', 'story-structure');
      url.searchParams.set('structureSection', 'spine');
    } else if (result.kind === '逐字稿') {
      url.searchParams.set('storyMode', 'source');
      url.searchParams.set('source', 'transcript');
      if (result.sectionId) url.searchParams.set('transcript', result.sectionId);
    } else if (result.kind === '故事梗概') {
      url.searchParams.set('storyMode', 'source');
      url.searchParams.set('source', 'outline');
    } else if (result.kind === '剧本正文') {
      url.searchParams.set('storyMode', 'audit');
      const sceneId = result.sceneId || result.id;
      url.searchParams.set('scene', sceneId);
      url.searchParams.set('confirmScene', sceneId);
    } else if (result.kind === '分集导航' && result.episodeId) {
      url.searchParams.set('storyMode', 'logic');
      url.searchParams.set('logicGroup', 'opening-boundary');
      url.searchParams.set('logicItem', 'incoming-handoff');
      const resultEpisodeScopeId = episodePlanIsCurrent ? result.episodeUid : result.episodeUid || episodeRouteId(result.episodeId);
      if (resultEpisodeScopeId) url.searchParams.set('episode', resultEpisodeScopeId);
      else url.searchParams.delete('episode');
      if (episodePlanIsCurrent && resultEpisodeScopeId) url.searchParams.set('episodeDisplay', result.episodeId);
      else url.searchParams.delete('episodeDisplay');
    } else if (result.kind === '问题' || result.kind === '任务' || result.kind === '后期任务') {
      url.searchParams.set('workArea', 'EXCEPTION');
      url.searchParams.set('item', publicRef(result.id));
      if (result.sceneId) url.searchParams.set('scene', result.sceneId);
      url.searchParams.delete('episode');
      url.searchParams.delete('episodeDisplay');
      if (result.episodeUid || result.episodeId) {
        const resultEpisodeScopeId = episodePlanIsCurrent ? result.episodeUid : result.episodeUid || episodeRouteId(result.episodeId);
        if (resultEpisodeScopeId) url.searchParams.set('episode', resultEpisodeScopeId);
        else url.searchParams.delete('episode');
        if (episodePlanIsCurrent && resultEpisodeScopeId && result.episodeId) url.searchParams.set('episodeDisplay', result.episodeId);
        else url.searchParams.delete('episodeDisplay');
      }
    }
    if (result.anchorId) url.searchParams.set('readerAnchor', result.anchorId);
    navigateToInternalHref(url.toString(), originLabel);
  }

  return (
    <EvidenceReaderProvider onInternalNavigate={(href, label) => navigateToInternalHref(href, `判断依据 · ${label}`)}>
    <main className="review-shell">
      <aside className="workspace-sidebar" aria-label="审阅台主导航">
        <button className="sidebar-brand" onClick={() => goToView('overview')} aria-label="返回审阅台首页">
          <span className="brand-mark">{instance.branding.mark}</span>
          <span><b>{instance.branding.title}</b><small>LOCAL PRODUCTION DESK</small></span>
        </button>
        <nav className="workspace-nav">
          {workspaceViews.map((item) => <button key={item.id} className={activeView === item.id ? 'active' : ''} aria-current={activeView === item.id ? 'page' : undefined} onClick={() => goToView(item.id)}><span>{item.index}</span><div><b>{item.title}</b><small>{item.desc}</small></div></button>)}
        </nav>
        <div className="sidebar-snapshot"><i /><div><b>本地审阅台</b><span>资料与审阅以当前故事实例为准</span></div></div>
      </aside>

      <div className="workspace-main" ref={mainScrollRef}>
        <header className="workspace-topbar">
          <div className="view-context"><span>{currentView.index}</span><div><small>当前视图</small><b>{currentView.title}</b></div></div>
          <div className="search-wrap">
            <div className={`global-search ${mobileSearchOpen ? 'mobile-open' : ''}`}>
              <button ref={searchToggleRef} type="button" aria-label={searchResultsOpen ? '关闭全局搜索' : '打开全局搜索'} aria-expanded={searchResultsOpen} onClick={() => { if (searchResultsOpen) closeSearchResults(); else { setMobileSearchOpen(true); openSearchResults(); } }}><span aria-hidden="true">⌕</span></button>
              <input value={query} onFocus={openSearchResults} onChange={(event) => { const value = event.target.value; setQuery(value); if (!searchResultsOpen) openSearchResults(); if (!value.trim()) { setSearchResults([]); setSearchTotal(0); setSearchLoading(false); } }} placeholder="搜故事正文、台词、集、场或素材" aria-label="全局搜索" />
            </div>
            {query && searchResultsOpen && <div className="search-results" role="dialog" aria-label="全局搜索结果">
              <div className="result-count"><span>{searchLoading ? '正在检索当前快照…' : `展示 ${searchResults.length} / 共 ${searchTotal} 项`}</span><button type="button" onClick={closeSearchResults}>关闭</button></div>
              {searchResults.length ? searchResults.map((result) => (
                <button data-search-kind={result.kind} data-search-id={publicRef(result.id)} key={`${result.kind}-${result.id}-${result.anchorId ?? result.episodeId ?? ''}`} onClick={() => void openResult(result)}><span>{result.kind}</span><b>{publicRef(result.id)}</b><small>{visibleText(result.title)}</small><i>{result.actionLabel || (result.kind === '素材' ? '打开素材信息卡' : '定位并查看')} →</i></button>
              )) : <p>没有匹配项</p>}
            </div>}
          </div>
        </header>

        <div className={`workspace-content ${navigationOrigin ? 'has-source-return' : ''}`}>
          {navigationOrigin && <nav className="source-return-bar" aria-label="返回来源"><button type="button" onClick={() => window.history.back()}>← 返回：{navigationOrigin.label}</button><span>浏览器后退会恢复来源页、筛选和滚动位置</span></nav>}
          {navigationError && <div className="navigation-error" role="alert"><b>没有跳到错误对象</b><span>{navigationError}</span><button type="button" onClick={blockedPersistentRoute ? recoverBlockedPersistentRoute : () => setNavigationError('')}>{blockedPersistentRoute === 'EPISODE' ? '打开当前分集目录' : blockedPersistentRoute ? '回到当前导航' : '关闭'}</button></div>}
          {activePagedWindow && !activeProductionReady && <section className="production-view-loading" aria-live="polite"><small>COMPLETE WORKSPACE DATA</small><h2>{activePagedWindow.error ? '当前工作区数据未完整读取' : '正在装入完整工作区数据'}</h2><p>{activePagedWindow.error ? `本地只读接口返回异常：${activePagedWindow.error}。没有展示不完整结果，也没有回退到旧全量兼容视图。` : activePagedWindow.resource === 'production' ? `正在读取当前制作门禁；完整前不会把未读取对象显示为0。` : '正在读取素材目录摘要；每批到达后即可浏览，选择素材时读取完整生产资料。'}</p>{activePagedWindow.error && <button type="button" onClick={() => void onNeedProduction({ resource: activePagedWindow.resource, filters: activePagedWindow.filters, mode: activePagedWindow.resource === 'production' ? (activePagedWindow.initialized ? 'next' : 'initial') : 'all' })}>重新完整读取</button>}{activePagedWindow.loading && <span>读取中…</span>}</section>}
          {activeView === 'overview' && <section className="workspace-view overview-view" aria-labelledby="overview-title">
            <CurrentWorkCenter
              reviewRemaining={reviewableStoryboardCount}
              materialRequirementCount={reviewData.productionModel.counts.requiredMaterialRequirements ?? 0}
              value={currentWorkView}
              onChange={setCurrentWorkView}
            />
          </section>}

          {activeProductionReady && activeView === 'pipeline' && <section className="workspace-view pipeline-view v6-page" aria-labelledby="pipeline-v6-title">
            <header className="workspace-heading v6-page-heading"><div><p>FULL PRODUCTION</p><h1 id="pipeline-v6-title">从拆镜表达，到整集成片</h1></div><p>讲清每镜要表达什么，准备输入并生成，再从场与集审阅合成效果。导出前统一核对跨集连续性、权利与技术要求；未锁定的正式范围保持 UNKNOWN。</p></header>
            <FullProductionWorkbench model={productionModel} context={productionContext} onNavigate={navigateProduction} onOpenMaterial={(requirementId) => void openMaterialCenter(requirementId, `全剧制作 · 输入素材 ${publicRef(requirementId)}`)} dataWindow={{ ...pipelineWindow, onLoadMore: () => void onNeedProduction({ resource: 'production', filters: pipelineFilters, mode: 'next' }), onRetry: () => void onNeedProduction({ resource: 'production', filters: pipelineFilters, mode: pipelineWindow.initialized ? 'next' : 'initial' }) }} />
          </section>}

      {activeView === 'story' && <section className="content-section story-section" id="story">
        <StoryWorkspaceHeading><div className="segmented story-mode-tabs" role="tablist" aria-label="故事创作方式">{[
          ['source', '来源资料'], ['story-structure', '故事结构'], ['logic', '叙事拆解'],
        ].map(([id, label], index, items) => <button
          id={`story-tab-${id}`}
          key={id}
          role="tab"
          aria-controls="story-mode-panel"
          aria-selected={storyView === id || id === 'logic' && storyView === 'audit'}
          tabIndex={storyView === id || id === 'logic' && storyView === 'audit' ? 0 : -1}
          className={storyView === id || id === 'logic' && storyView === 'audit' ? 'active' : ''}
          onClick={() => selectStoryMode(id as StoryView)}
          onKeyDown={(event) => {
            const current = items.findIndex(([itemId]) => itemId === id);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowLeft' ? (current - 1 + items.length) % items.length : event.key === 'ArrowRight' ? (current + 1) % items.length : -1;
            if (next < 0) return;
            event.preventDefault();
            const nextTabId = `story-tab-${items[next][0]}`;
            document.getElementById(nextTabId)?.focus();
            selectStoryMode(items[next][0] as StoryView);
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.getElementById(nextTabId)?.focus()));
          }}
        >{label}</button>)}</div></StoryWorkspaceHeading>
        {storyInstruction[storyView==='audit'?'logic':storyView] && <p className="story-instruction">{storyInstruction[storyView==='audit'?'logic':storyView]}</p>}

        <div id="story-mode-panel" role="tabpanel" aria-labelledby={`story-tab-${storyView === 'audit' ? 'logic' : storyView}`}>


        {genericAuthoring&&storyView==='source'&&<GenericSourceReader onDocumentChange={setGenericSourceFocus}/>}
        {genericAuthoring&&storyView!=='source'&&<GenericAuthoringWorkspace kind={storyView==='story-structure'?'STORY_OUTLINE':'EPISODE_PLAN'}/>}
        {genericAuthoring&&storyView==='story-structure'&&<GenericAuthoringWorkspace kind="SCREENPLAY"/>}
        {!genericAuthoring && storyView !== 'source' && !resolvedEpisodePlan && <section className="review-bootstrap-state"><p>{episodePlanError || '正在读取分集方案及完整正文…'}</p>{episodePlanError && <button type="button" onClick={() => { const url = new URL(window.location.href); for (const key of ['episodePlanRevision', 'episode', 'scene', 'confirmScene', 'auditBeat', 'verifyIssue', 'storySegment']) url.searchParams.delete(key); window.history.replaceState(window.history.state, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }}>读取最新方案</button>}</section>}

        {!genericAuthoring && (storyView === 'source' || (storyView === 'audit' && !narrativeCandidate)) && !storySourcesReady && <section className="review-bootstrap-state" aria-live="polite"><p>{storySourcesError ? `完整来源资料暂时无法读取：${storySourcesError}` : '正在按需读取完整逐字稿与辅助梗概……'}</p>{storySourcesError && <button type="button" onClick={() => { setStorySourcesError(''); setStorySourcesAttempt((value) => value + 1); }}>重新读取</button>}{storySourcesLoading && <span>读取中…</span>}</section>}

        {!genericAuthoring && storyView === 'audit' && !narrativeCandidate && storySourcesReady && !adaptationAudit && !adaptationAuditError && <section className="review-bootstrap-state"><p>正在读取原文改编审计……</p></section>}
        {!genericAuthoring && storyView === 'audit' && !narrativeCandidate && storySourcesReady && adaptationAuditError && <section className="review-bootstrap-state"><p>原文改编审计暂时无法读取：{adaptationAuditError}</p><button type="button" onClick={() => { setAdaptationAuditError(''); setAdaptationAuditAttempt((value) => value + 1); }}>重新读取</button></section>}

        {!genericAuthoring && storyView === 'source' && narrativeCandidate && storySourcesReady && auditVerificationIssueId && <HistoricalVerificationSource key={`${reviewData.snapshotId}:${auditVerificationIssueId}`} issueId={auditVerificationIssueId} snapshotId={reviewData.snapshotId} segments={storySources.transcript.segments} sectionIds={storySources.transcript.sections.map(section=>section.id)} defaultSectionId={storySources.transcript.sections[0]?.id||''}/>}
        {!genericAuthoring && storyView === 'source' && storySourcesReady && <GenericSourceReader onDocumentChange={setGenericSourceFocus} builtin={{documentIds:['legacy-source:'+storySources.transcript.sourcePath,'legacy-source:'+storySources.outline.sourcePath],navigation:<><nav className="source-evidence-tree" aria-label="故事来源层级">
              <section className={`source-tree-branch ${storySourceMode === 'transcript' ? 'active' : ''}`}>
                <button aria-expanded={storySourceMode === 'transcript'} onClick={() => { setStorySourceMode('transcript'); setReaderAnchor(null); }}><span>主工作文本</span><b>完整逐字稿</b><small>{storySources.transcript.segmentCount}段 · 下含{storySources.transcript.sections.length}个时段</small></button>
                {storySourceMode === 'transcript' && <div className="transcript-section-list" role="tablist" aria-label="完整逐字稿的各时段">
                  {storySources.transcript.sections.map((item) => <button role="tab" aria-selected={transcriptSection.id === item.id} className={transcriptSection.id === item.id ? 'active' : ''} key={item.id} onClick={() => { setTranscriptSectionId(item.id); setReaderAnchor(null); }}><span>{item.id}</span><b>{item.title.replace(/（.+$/, '')}</b><small>{item.startTimecode}–{item.endTimecode} · {item.segmentCount}段</small></button>)}
                </div>}
              </section>
              <section className={`source-tree-branch auxiliary ${storySourceMode === 'outline' ? 'active' : ''}`}><button onClick={() => { setStorySourceMode('outline'); setReaderAnchor(null); }}><span>辅助对照 · 独立来源</span><b>网友故事梗概</b><small>不是逐字稿父级，不能覆盖一手录音</small></button></section>
            </nav></>,content:<section className="text-reader-document">
            <header className="text-reader-head"><div><small>{storySourceMode === 'transcript' ? 'DERIVED · COMPLETE TRANSCRIPT' : 'AUXILIARY ONLY'}</small><h3>{storySourceMode === 'transcript' ? transcriptSection.title : storySources.outline.title}</h3><p>{storySourceMode === 'transcript' ? `${visibleText(storySources.transcript.sourcePath)} · ${storySources.transcript.payloadCharacterCount.toLocaleString()}字正文` : `${visibleText(storySources.outline.sourcePath)} · 仅作关系与顺序辅助核对`}</p></div><span>{storySourceMode === 'transcript' ? `${transcriptSegments.length}段` : '辅助源'}</span></header>
            <div className="text-reader-scroll" ref={readerScrollRef}>
              <div className="text-reader-body">
                {storySourceMode === 'transcript' ? <>
                  <section className="source-audio-panel"><div><span>原始录音 · 第一核对源</span><b>{storySources.audio.title}</b><p>{storySources.audio.duration} · {formatBytes(storySources.audio.byteSize)} · 点击任一时间码可从该处回听</p></div><audio ref={storyAudioRef} data-review-audio controls preload="metadata" src={storySources.audio.audioUrl} onPointerDown={stopSeamAudition} onPlay={(event) => handleReviewAudioPlay(event.currentTarget)}>你的浏览器不支持音频播放。</audio><small>{storySources.audio.reviewUse}</small></section>
                  {transcriptSection?.id === storySources.transcript.sections[0]?.id && <section className="source-intro"><DocumentBlocks blocks={storySources.transcript.introBlocks} highlightedAnchor={readerAnchor} /></section>}
                  <div className="transcript-segments">{transcriptSegments.map((segment) => <article id={segment.id} className={readerAnchor === segment.id ? 'reader-search-hit' : ''} key={segment.id}><button onClick={() => seekStoryAudio(segment.seconds)} title={`从 ${segment.timecode} 回听原始录音`}><time>{segment.timecode}</time><span>从此回听</span></button><p>{segment.text}</p><small>源行 {segment.sourceLine} · {segment.characterCount}字</small></article>)}</div>
                </> : <>
                  <section className="authority-note"><b>辅助材料，不是事实母本</b><p>这份梗概保留全文供对照人物关系、案件数量与叙事顺序；若与录音或规整逐字稿冲突，以原始录音为先。</p></section>
                  <DocumentBlocks blocks={storySources.outline.blocks} highlightedAnchor={readerAnchor} />
                </>}
              </div>
            </div>
          </section>}} />}

        {storyView === 'story-structure' && resolvedEpisodePlan?.content.narrativeRevision && <NarrativeOverview plan={resolvedEpisodePlan} tab={narrativeSection} onSelectTab={selectNarrativeSection}/>}
        {storyView === 'story-structure' && resolvedEpisodePlan && !narrativeCandidate && storyOverview && <StoryStructureWorkbench
          overview={storyOverview}
          selectedSection={storyStructureSection}
          onSelectSection={setStoryStructureSection}
          onOpenImage={(src, opener) => openLightbox(src, 100, opener)}
        />}
        {!genericAuthoring && storyView === 'story-structure' && !storyOverview && <section className="review-bootstrap-state"><p>当前快照没有可读取的全剧故事结构。</p></section>}

        {(storyView === 'logic' || storyView === 'audit') && !urlReady && <p role="status">正在核对本集与本场的精确审阅范围…</p>}
        {urlReady && (storyView === 'logic' || storyView === 'audit') && selectedEpisodeDecision && resolvedEpisodePlan && <section className="narrative-architecture">
          <EpisodePlanWorkbench
            resolvedPlan={resolvedEpisodePlan}
            model={productionModel}
            snapshotId={reviewData.snapshotId}
            baseRevisionHash={storyStructure.sourceSha256}
            sceneIds={(resolvedEpisodePlan.content.narrativeRevision?.scenes || reviewData.creativeLineage.scenes).map((scene) => scene.id)}
            selectedEpisodeId={selectedEpisodeDecision.episodeUid}
            onSelectEpisode={selectEpisodeForReview}
            selectedCriterionId={selectedLogic.groupId}
            selectedItemId={selectedLogic.itemId}
            onSelectCriterion={selectLogicCriterion}
            selectedSceneId={storyView === 'audit' ? auditSceneId : null}
            onSelectScene={id => id ? openStoryScene(id, '叙事拆解') : selectEpisodeForReview(selectedEpisodeDecision.episodeUid)}
            sceneLabels={Object.fromEntries((resolvedEpisodePlan.content.narrativeRevision?.scenes || reviewData.creativeLineage.scenes).map(scene => [scene.id, {displayId: 'displayId' in scene ? String(scene.displayId) : scene.id, title: 'title' in scene ? scene.title : scene.slugline}]))}
            renderEpisodeSummary={({criterionStates})=><EpisodeLogicSummary episode={selectedEpisodeDecision} criterionStates={criterionStates} sceneLabels={Object.fromEntries((resolvedEpisodePlan.content.narrativeRevision?.scenes||[]).map(scene=>[scene.id,scene.displayId]))} sceneRuntimes={Object.fromEntries((resolvedEpisodePlan.content.narrativeRevision?.scenes||[]).map(scene=>[scene.id,scene.runtime]))}/>}
            renderSceneReading={id=><EpisodeSceneReading plan={resolvedEpisodePlan} sceneId={id}/>}
            renderEpisodeLayout={({ criterionStates,navigation,criteria }) => <StoryCommentsProvider key={`${resolvedEpisodePlan.revisionId}:${selectedEpisodeDecision.episodeUid}`} plan={resolvedEpisodePlan} episodeUid={selectedEpisodeDecision.episodeUid} onReveal={(target,blockId)=>{if(target.episodeUid===previousEpisodeDecision?.episodeUid){selectLogicCriterion('opening-boundary');return;}if(target.episodeUid===nextEpisodeDecision?.episodeUid){selectLogicCriterion('ending-propulsion');return;}if(target.kind==='SCENE_SCRIPT'){openStoryScene(target.subjectId,'正文评论定位');return;}if(target.kind==='EPISODE_DESIGN'){const group=target.blocks.find(b=>b.id===blockId)?.groupId;if(target.episodeUid===selectedEpisodeDecision.episodeUid&&group)selectLogicCriterion(group as EpisodeCriterionId);}}}>{navigation}<div className="episode-review-workspace episode-review-workspace-integrated"><EpisodeLogicReview hideSummary
              plan={resolvedEpisodePlan}
              episode={selectedEpisodeDecision}
              reviewSpec={resolvedEpisodePlan.reviewSpec}
              presentation={resolvedEpisodePlan.presentation}
              subjectNames={resolvedEpisodePlan.subjectNames}
              sceneLabels={Object.fromEntries((resolvedEpisodePlan.content.narrativeRevision?.scenes || []).map((scene) => [scene.id,scene.displayId]))}
              previousEpisode={previousEpisodeDecision}
              nextEpisode={nextEpisodeDecision}
              causalChains={resolvedEpisodePlan.content.narrativeRevision?.causalChains || causalChains}
              selectedGroupId={selectedLogic.groupId}
              selectedItemId={selectedLogic.itemId}
              selectedCausalChainId={causeChainId}
              criterionStates={criterionStates}
              onSelect={selectLogicItem}
              onOpenScene={(sceneId) => openStoryScene(sceneId, `叙事拆解 · ${selectedEpisodeDecision.episodeId} · ${sceneId}`)}
            />{criteria}</div></StoryCommentsProvider>}
          />
        </section>}

        {(storyView === 'logic' || storyView === 'audit') && resolvedEpisodePlan && !selectedEpisodeDecision && <section className="review-bootstrap-state"><p>此集不属于当前方案，请从本方案重新选择。</p></section>}
        </div>
      </section>}

      {activeProductionReady && activeView === 'materials' && <section className="content-section material-section v6-page" id="materials">
        <div className="section-heading"><div><p>SCREENPLAY → REUSABLE MATERIALS</p><h2>按实体分类管理可复用素材</h2></div><p className="section-intro">素材的产物、Review、全部生产资料、用途和版本血缘统一收进一张信息卡；镜头、场、集与全剧产物继续只在“全剧制作”管理。</p></div>
        {materialWindow.error&&<p role="alert">后续素材摘要读取未完成：{materialWindow.error}<button onClick={()=>void onNeedProduction({resource:materialResource,filters:materialFilters,mode:'all'})}>继续读取素材目录</button></p>}
        <MaterialProductionCenter
          catalogLoading={materialWindow.loading||materialWindow.hasMore}
          catalogTotal={materialWindow.total}
          model={productionModel}
          snapshotId={reviewData.snapshotId}
          stateProjection={operationalProjection}
          viewState={materialCenterState}
          onViewStateChange={setMaterialCenterState}
          onOpenStoryScene={(sceneId) => openStoryScene(sceneId, `素材管理 · ${sceneId}`)}
          onOpenConsumer={(shotId) => void openProductionIntent({ shotId }, `素材管理 · ${shotId}`)}
        />
      </section>}

      {activeView === 'settings' && <StorySettingsWorkspace />}
      {urlReady && activeView === 'system' && <SystemManagement technicalAppendix={<SystemDocumentation />} />}

          <footer className="site-footer"><div><span className="brand-mark">{instance.branding.mark}</span><p><b>{instance.branding.title}</b><small>故事创作与制作审阅</small></p></div><p>故事资料、制作配置与审阅状态以当前实例为准；具体来源见“系统管理 → 数据与运行 → 技术附录”。</p></footer>
        </div>
      </div>

      <nav className="mobile-nav is-six-entries" aria-label="移动端导航">{workspaceViews.map((item) => <button key={item.id} aria-label={item.title} className={activeView === item.id ? 'active' : ''} aria-current={activeView === item.id ? 'page' : undefined} onClick={() => goToView(item.id)}>{item.short}</button>)}</nav>

      {lightbox && <div ref={lightboxRef} className="lightbox" role="dialog" aria-modal="true" aria-label="证据图放大查看" onKeyDown={trapLightboxFocus}><header><b>证据图 · 制作示意</b><div><button onClick={() => setZoom((value) => Math.max(60, value - 20))} aria-label="缩小证据图">−</button><span>{zoom}%</span><button onClick={() => setZoom((value) => Math.min(220, value + 20))} aria-label="放大证据图">＋</button><button ref={lightboxCloseRef} onClick={closeLightbox}>关闭</button></div></header><div className="lightbox-canvas"><img src={lightbox} alt="放大的项目证据图" style={{ width: `${zoom}%` }} /></div></div>}
    </main>
    </EvidenceReaderProvider>
  );
}
