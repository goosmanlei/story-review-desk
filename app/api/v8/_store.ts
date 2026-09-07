import type {ExecutionRuntime} from '../../../host/instance-runtime/execution-epoch.mjs';
import { projectEpisodeNarrativeReleases, assertScopedEpisodeSceneBasis, assertScopedSceneSyncBinding, SCENE_SYNC_PROTOCOL } from './episode-plan-reviews/_release';
import {applyDomainInvalidations} from '../../../host/instance-runtime/domain-invalidation.mjs';
import {episodePlanContentFromRecord, type EpisodePlanContent} from '../../episode-plan-context';
import {resolveFormalReviewSpec, candidateReviewSpec} from './_review-spec';
import {automaticEpisodeSubmissions} from './episode-plan-reviews/_automatic';
import {assertEpisodeSubmissionBindings} from './episode-plan-reviews/_contract';
import {assertEpisodeSubmissionInput} from './episode-plan-reviews/_scope';
import {configuredGates,executionEligibilityReasons,type ConfiguredGate} from '../../gate-evaluation';
import { createReadStream, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveLifecycleState, type StatusRecord } from '../../status-contract';
import { projectMaterialCreatorStage } from '../../material-taxonomy';
import { instanceProfile, projectIdFor, episodePlanIdFor } from '../../instance-profile';
import type { InstanceReadUnit, InstanceRepository } from '../../../host/instance-runtime/index.mjs';
import { instanceCandidateRelativePath } from '../../../host/instance-runtime/media-paths.mjs';
import { normalizeReviewSnapshot } from '../../../host/instance-runtime/snapshot-contract.mjs';
export { instanceCandidateRelativePath } from '../../../host/instance-runtime/media-paths.mjs';

export type EventKind =
  | 'review'
  | 'episode-plan-submission'
  | 'run'
  | 'asset-version'
  | 'creative-revision'
  | 'execution-request'
  | 'source-operation'
  | 'verification'
  | 'script-comment';

export const eventKinds: readonly EventKind[] = [
  'review',
  'episode-plan-submission',
  'run',
  'asset-version',
  'creative-revision',
  'execution-request',
  'source-operation',
  'verification',
  'script-comment',
] as const;

export let derivedRegistryPaths: readonly string[] = [
  'production/00_control/registries/episodes.json',
  'production/00_control/registries/scenes.json',
  'production/00_control/registries/entities.json',
  'production/00_control/registries/lines.json',
  'production/00_control/registries/locations.json',
  'production/00_control/registries/states.json',
  'production/00_control/registries/rights.json',
  'production/00_control/registries/sensitivity.json',
  'production/00_control/registries/external_video_returns.json',
] as const;

export let creativeRevisionSourcePathBySubjectKind: Readonly<Record<string, string>> = Object.freeze({
  EPISODE_PLAN: 'data/story_structure.v2.json',
  SCENE_COVERAGE: 'data/scene_coverage.v1.json',
  SHOT_PLAN_SET: 'data/shot_plan_sets.v1.json',
});

let publishedPromptAliases = new Set<string>();
export function isDirectPromptSourcePath(candidate: string) {
  if (instanceRepositoryMode()) {
    if (!activeInstanceRepository) return false;
    return publishedPromptAliases.has(candidate);
  }
  const segments = candidate.split('/');
  return candidate.startsWith('production/prompts/direct/')
    && segments.length === 4
    && path.posix.extname(candidate).toLowerCase() === '.md';
}

export function derivedArtifactHashMap(value: unknown, name = 'derivedArtifactHashes') {
  const source = assertJsonObject(value, name, 20_000);
  const expectedKeys = [...derivedRegistryPaths];
  const actualKeys = Object.keys(source);
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key) => !expectedKeys.includes(key as typeof derivedRegistryPaths[number]))
  ) {
    throw new HttpError(422, `${name} keys must exactly match the nine controlled registry paths`, {
      expectedKeys,
      actualKeys,
    });
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, assertSha256(source[key], `${name}.${key}`)])) as Record<string, string>;
}

type WorkItem = {
  id: string;
  lane?: string | null;
  requirementRef?: string | null;
  requirementHash?: string | null;
  declaredExecutionGate?: string | null;
  executionBlockReasons?: string[];
  outputAssetRef?: string | null;
  additionalOutputAssetRefs?: string[];
  inputAssetRefs?: string[];
  upstreamWorkRelations?: Array<{
    resolutionState?: string | null;
    flowBlockReason?: string | null;
    workItemRefs?: string[];
    [key: string]: unknown;
  }>;
  executionDefinitionRef?: string | null;
  inputVersionBindings?: Array<{
    assetFamilyRef?: string | null;
    assetVersionRef?: string | null;
    familyId?: string | null;
    versionId?: string | null;
    sha256?: string | null;
  }>;
  workflowStepId?: string | null;
  pipelineStageCode?: string | null;
  phaseId?: string | null;
  gateId?: string | null;
  activityRole?: string | null;
  activeInCurrentProduction?: boolean;
  scopeType?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT' | string | null;
  scopeId?: string | null;
  shotId?: string | null;
  sceneId?: string | null;
  episodeId?: string | null;
  episodeUid?: string | null;
  sourceRef?: string | null;
  applicabilityState?: string | null;
  upstreamReadiness?: string | null;
  executionGate?: string | null;
  latestRun?: { state?: string | null; [key: string]: unknown } | null;
  outputState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  historyRole?: string | null;
  lifecycleState?: string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[];
  reviewActionability?: 'ACTIONABLE' | 'WAITING_DEPENDENCY' | 'BLOCKED' | 'NOT_APPLICABLE';
  reviewBlockers?: Array<{ familyId: string; workItemId?: string | null; requiredVersionId?: string | null; reasonCode: string }>;
  reviewDependencyDepth?: number;
  reviewFrontier?: boolean;
  reviewContextRef?: string | null;
  deliverableKey?: string | null;
  shotPlanSetRevisionId?: string | null;
  shotPlanSetRevisionHash?: string | null;
  planningBasisBindingsHash?: string | null;
  legacyState?: { materializationState?: string | null; rightsStatus?: string | null; [key: string]: unknown } | null;
};

type WorkPackage = {
  id: string;
  stepId?: string | null;
  phaseId?: string | null;
  gateId?: string | null;
  activityRole?: string | null;
  activeInCurrentProduction?: boolean;
  workItemRefs?: string[];
  shotIds?: string[];
  sceneId?: string | null;
  episodeId?: string | null;
  episodeUid?: string | null;
  reviewContextRef?: string | null;
  shotPlanSetRevisionId?: string | null;
  shotPlanSetRevisionHash?: string | null;
  scopeType?: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT' | string | null;
  scopeId?: string | null;
  applicabilityState?: string | null;
  lifecycleState?: string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[];
};

type AssetFamily = {
  id: string;
  label?: string | null;
  currentVersionId?: string | null;
  decisionVersionId?: string | null;
  versionRefs?: string[];
  outputState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  historyRole?: string | null;
  lifecycleState?: string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[];
  subtype?: string | null;
  ownerRef?: string | null;
  materialRequirementRefs?: string[];
  expectedOutputRefs?: string[];
  currentExpectedOutputId?: string | null;
  versionDeepLinkAliases?: Array<{ legacyVersionId?: string | null; expectedOutputId?: string | null }>;
  legacyState?: { materializationState?: string | null; rightsStatus?: string | null; [key: string]: unknown } | null;
};

export type ExpectedOutput = {
  id: string;
  familyId: string;
  label?: string | null;
  targetPath?: string | null;
  plannedVersionLabel?: string | null;
  legacyVersionId?: string | null;
  expectationState?: 'PLANNED' | 'REALIZED' | string;
  [key: string]: unknown;
};

export type ReviewContext = {
  id: string;
  scopeType: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  scopeId: string;
  semanticStatus?: string | null;
  reviewable?: boolean;
  contextHash?: string | null;
  binding?: {
    shotPlanRevisionId?: string | null;
    shotDefinitionHash?: string | null;
    bindingStatus?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export type AssetVersion = {
  id: string;
  familyId: string;
  path: string | null;
  sha256: string | null;
  outputState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  historyRole?: string | null;
  lifecycleState?: string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[];
  rightsWarning?: boolean | null;
  sourceSyncRequired?: boolean | null;
  sourceSyncState?: string | null;
  legacyState?: { materializationState?: string | null; rightsStatus?: string | null; [key: string]: unknown } | null;
  materializationState?: string | null;
  expectedOutputId?: string | null;
  executionDefinitionRef?: string | null;
  inputVersionBindings?: Array<{
    assetFamilyRef?: string | null;
    assetVersionRef?: string | null;
    familyId?: string | null;
    versionId?: string | null;
    sha256?: string | null;
  }>;
  materialRequirementBindings?: Array<{
    requirementRef?: string | null;
    requirementHash?: string | null;
    executionDefinitionRef?: string | null;
    definitionHash?: string | null;
  }>;
};

type MaterialRequirement = {
  id: string;
  requirementHash: string;
  assetFamilyRefs: string[];
  requirementClass?: string | null;
  coverageContextHash?: string | null;
  [key: string]: unknown;
};

export type ReviewData = {
  instance?: ReturnType<typeof instanceProfile>;
  schemaVersion: string;
  snapshotId: string;
  scope?: { storyScenes?: number | null; [key: string]: unknown };
  sourceHashes?: Record<string, unknown>;
  storySources?: {
    audio?: { sourcePath?: string; sha256?: string; [key: string]: unknown };
    transcript?: {
      segments?: Array<{
        id?: string;
        text?: string;
        contentSha256?: string;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  adaptationAudit?: {
    summary?: Record<string, unknown>;
    beats?: Array<Record<string, unknown>>;
    sceneAudits?: Array<Record<string, unknown>>;
    asrIssues?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  actionModel?: {
    schemaVersion?: string;
    storyConfirmations?: Array<Record<string, unknown>>;
    audioVerifications?: Array<Record<string, unknown>>;
    materialLanes?: Record<string, unknown>;
    [key: string]: unknown;
  };
  actionQueueInputs?: {
    rewrittenSceneConfirmations?: Array<Record<string, unknown>>;
    audioVerifications?: Array<Record<string, unknown>>;
    sceneReviewDossiers?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  creativeLineage?: {
    scriptDocument?: { sourcePath?: string; sha256?: string; [key: string]: unknown };
    storyStructure?: { sourceSha256?: string; [key: string]: unknown };
    scenes?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  productionModel: {
    genericSyncProof?: Record<string, unknown>;
    domainGraph?: import('../../../host/instance-runtime/domain-model.mjs').DomainGraph;
    domainReferenceRules?: Array<Record<string,unknown>>;
    domainReferenceTargets?: Record<string, {entityIds:string[];entityTypes:string[];representationTypes:string[];unresolved?:boolean}>;
    domainInvalidations?: Array<{familyId:string;previousHash:string;currentHash:string;versionIds:string[]}>;
    systemConfiguration?: {reference:import('../../../host/instance-runtime/configuration-model.mjs').ConfigurationRef;config:import('../../../host/instance-runtime/configuration-model.mjs').Configuration;defaults?:import('../../../host/instance-runtime/configuration-model.mjs').Configuration};
    productionPhases?: Array<{ id: string; slug?: string; order: number; label: string; purpose?: string; gateIds?: string[]; denominatorState?: string; denominator?: number | null; [key: string]: unknown }>;
    productionGates?: Array<{ id: string; slug?: string; phaseId: string; order: number; label: string; purpose?: string; scopeType?: string; denominatorState?: string; denominator?: number | null; [key: string]: unknown }>;
    productionGraph?: { activeWorkItemRefs?: string[]; activeWorkPackageRefs?: string[]; [key: string]: unknown };
    shots?: Array<{ id: string; sceneId?: string; episodeId?: string; title?: string; branch?: string; scopeRole?: string; activityRole?: string; activeInCurrentProduction?: boolean; shotPlanSetRevisionId?: string; shotPlanSetRevisionHash?: string; storyHandoff?: Record<string, unknown>; workPackageRefs?: string[]; reviewContext?: { contextHash?: string; neighbours?: { previous?: { id?: string | null }; next?: { id?: string | null } }; [key: string]: unknown }; lifecycleState?: string; canFlowDownstream?: boolean; flowBlockReasons?: string[] }>;
    scenes?: Array<{ id: string; episodeId?: string; shotIds?: string[]; scopeRole?: string; storyHandoff?: Record<string, unknown>; lifecycleState?: string; canFlowDownstream?: boolean; flowBlockReasons?: string[]; [key: string]: unknown }>;
    episodes?: Array<{ id: string; displayId?: string; episodeUid?: string; canonicalScopeId?: string; sceneIds?: string[]; scopeRole?: string; storyHandoff?: Record<string, unknown>; lifecycleState?: string; canFlowDownstream?: boolean; flowBlockReasons?: string[]; [key: string]: unknown }>;
    storyRevisions?: Array<Record<string, unknown>>;
    scriptRevisions?: Array<Record<string, unknown>>;
    sceneScriptRevisions?: Array<Record<string, unknown>>;
    episodePlanRevisions?: Array<Record<string, unknown>>;
    sceneCoveragePlanRevisions?: Array<Record<string, unknown>>;
    screenplayReleaseSnapshots?: Array<Record<string, unknown>>;
    scopeLocks?: Array<Record<string, unknown>>;
    shotPlanSetRevisions?: Array<Record<string, unknown>>;
    workItems: WorkItem[];
    workPackages: WorkPackage[];
    materialRequirements?: MaterialRequirement[];
    materialWorkItems?: WorkItem[];
    materialStoryRelations?: Record<string, unknown>;
    assetFamilies: AssetFamily[];
    assetVersions: AssetVersion[];
    expectedOutputs?: ExpectedOutput[];
    reviewContexts?: ReviewContext[];
    counts?: { p07Materialized?: number; p07Released?: number; [key: string]: unknown };
    systemModel?: {
      stateModel?: {
        reviewContract?: {
          schemaVersion?: string;
          actions?: string[];
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
  };
};

export type RecipeCatalog = {
  snapshotId: string;
  executionDefinitions: Array<{
    id: string;
    definitionStatus?: string | null;
    declaredGate?: string | null;
    [key: string]: unknown;
  }>;
  promptRevisions: Array<{ id: string; executionDefinitionId: string; [key: string]: unknown }>;
};

export type EventRecord = Record<string, unknown> & {
  eventId?: string;
  eventKind?: EventKind;
  recordedAt?: string;
  requestHash?: string;
  eventSequence?: number;
};

export type ApplicabilityState = 'CURRENT' | 'STALE' | 'EXPIRED' | 'REVALIDATION_REQUIRED';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
  }
}

let dataCache: ReviewData | null = null;
let recipeCache: RecipeCatalog | null = null;
let dataCacheFingerprint = '';
let recipeCacheFingerprint = '';
let hostedDataPromise: Promise<ReviewData> | null = null;
let hostedRecipePromise: Promise<RecipeCatalog> | null = null;
let hostedEventPromise: Promise<{ snapshotId: string; events: Partial<Record<EventKind, EventRecord[]>> }> | null = null;

let activeInstanceRepository: InstanceRepository | null = null;
let activeInstanceRepositoryKey = '';
export function instanceRepositoryMode() {
  return Boolean(process.env.REVIEW_INSTANCE_ROOT || process.env.REVIEW_INSTANCE_DB || process.env.REVIEW_INSTANCE_ID);
}
export const instanceMode = instanceRepositoryMode;
// Only isolated legacy tests may opt into filesystem-backed business data.
// REVIEW_NODE_DEV and REVIEW_TRIAL_LEGACY_FIXTURE do not grant this capability.
function requireLegacyFixtureMode() {
  if (process.env.REVIEW_LEGACY_FIXTURE !== '1') throw new HttpError(503, 'An explicit story instance is required; filesystem business-data fallback is disabled');
}

export async function instanceRepository() {
  if (hostedReadOnlyMode()) throw new HttpError(405, 'Hosted mirror cannot access a local business repository');
  if (!instanceRepositoryMode()) return null;
  const runtimeUrl = pathToFileURL(path.resolve(process.env.REVIEW_SITE_ROOT || process.cwd(), 'host/instance-runtime/index.mjs')).href;
  const runtime = await import(/* @vite-ignore */ runtimeUrl);
  const resolved = process.env.REVIEW_INSTANCE_ROOT ? runtime.resolveInstance(process.env.REVIEW_INSTANCE_ROOT) : null;
  const dbPath = resolved?.dbPath || process.env.REVIEW_INSTANCE_DB;
  const isPostgres = resolved?.backend === 'postgres';
  const instanceId = resolved?.instanceId || process.env.REVIEW_INSTANCE_ID;
  if ((!dbPath && !isPostgres) || !instanceId) throw new HttpError(503, 'Explicit instance database and instance identity are required; legacy fallback is disabled');
  if (resolved && process.env.REVIEW_INSTANCE_ID && process.env.REVIEW_INSTANCE_ID !== resolved.instanceId) throw new HttpError(503, 'Configured instance identities diverge');
  if (resolved && !isPostgres && process.env.REVIEW_INSTANCE_DB && path.resolve(process.env.REVIEW_INSTANCE_DB) !== resolved.dbPath) throw new HttpError(503, 'Configured instance databases diverge');
  const readOnly = instanceReadOnlyMode();
  const key = `${resolved?.root || dbPath}:${instanceId}:${readOnly}`;
  if (!activeInstanceRepository || activeInstanceRepositoryKey !== key) {
    activeInstanceRepository = (await runtime.openInstanceRepository({ ...resolved, dbPath, instanceId, readOnly })); activeInstanceRepositoryKey = key;
  }
  return activeInstanceRepository;
}
async function publishedInstanceDocument(repository: InstanceReadUnit, alias: string, revisionId?: string) {
  const release = (await repository.readRelease());
  if (!release) throw new HttpError(503, 'Instance has no published source release');
  if (revisionId) return release.sourceRevisionIds.includes(revisionId) ? (await repository.readDocument(alias, { revisionId })) : null;
  const head = (await repository.readDocument(alias));
  if (!head) return null;
  if (release.sourceRevisionIds.includes(head.revisionId)) return head;
  for (const id of release.sourceRevisionIds) {
    const published = (await repository.readDocument(head.documentId, { revisionId: id }));
    if (published) return published;
  }
  return null;
}
export async function readPublishedInstanceDocuments() {
  const repository = await instanceRepository();
  if (!repository) throw new HttpError(503, 'Instance document reads require the business repository');
  return repository.readTransaction(async (tx) => {
    const release = (await tx.readRelease());
    if (!release) throw new HttpError(503, 'Instance has no published source release');
    const documents = await Promise.all(release.sourceRevisionIds.map(async (id) => {
      const document = (await tx.readDocumentRevision(id));
      if (!document || document.deleted) throw new HttpError(503, 'Published source revision is missing or invalid');
      return document;
    }));
    if (new Set(documents.map((document) => document.documentId)).size !== documents.length) throw new HttpError(503, 'Published source identity has more than one revision');
    return documents;
  });
}
export async function readInstanceDocument(alias: string, revisionId?: string) {
  const repository = await instanceRepository();
  if (!repository) throw new HttpError(503, 'Instance document reads require the business repository');
  return repository.readTransaction(async (tx) => {
    const document = (await publishedInstanceDocument(tx, alias, revisionId));
    if (!document || document.deleted) throw new HttpError(404, 'Published instance source document is unavailable');
    return document;
  });
}
function bindInstanceSourceRoles(profile: ReturnType<typeof instanceProfile>) {
  derivedRegistryPaths = Object.freeze([...profile.sourceBindings.derivedRegistryPaths]);
  creativeRevisionSourcePathBySubjectKind = Object.freeze({ ...profile.sourceBindings.creativeRevisionPaths });
}

export function hostedReadOnlyMode() {
  return process.env.REVIEW_REMOTE_READ_ONLY === '1';
}
export function instanceReadOnlyMode() {
  return process.env.REVIEW_INSTANCE_READ_ONLY === '1';
}

async function hostedAssetJson<T>(pathname: string, label: string): Promise<T> {
  let bindingReason: unknown = 'ASSETS binding is unavailable';
  try {
    const { env } = await import('cloudflare:workers');
    const assets = (env as unknown as { ASSETS?: { fetch(request: Request): Promise<Response> | Response } }).ASSETS;
    if (assets) {
      const response = await assets.fetch(new Request(new URL(pathname, 'https://review-runtime.invalid')));
      if (!response.ok) throw new Error(`ASSETS returned HTTP ${response.status}`);
      return await response.json() as T;
    }
  } catch (reason) {
    bindingReason = reason;
  }

  // `vinext start` uses Node rather than the Cloudflare runtime. This fallback
  // keeps the hosted profile locally testable while production continues to
  // read the exact same generated files through the ASSETS binding.
  const publicRoot = path.resolve(localReviewRoot(), process.env.REVIEW_EXPORT_DIR ? '.hosted-public' : 'public');
  const localPath = path.resolve(publicRoot, pathname.replace(/^\/+/, ''));
  if (!localPath.startsWith(`${publicRoot}${path.sep}`)) {
    throw new HttpError(503, `${label} hosted asset path is invalid`);
  }
  try {
    return JSON.parse(await readFile(localPath, 'utf8')) as T;
  } catch (localReason) {
    throw new HttpError(503, `${label} hosted asset is unavailable`, {
      bindingCause: String(bindingReason),
      localCause: String(localReason),
    });
  }
}

function localReviewRoot() {
  if (!hostedReadOnlyMode()) requireLegacyFixtureMode();
  const candidates = [process.env.REVIEW_SITE_ROOT, process.env.INIT_CWD, process.env.PWD, process.cwd()].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(path.join(candidate, 'app', 'review-data.generated.json'))) || process.cwd();
}

export function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'Cache-Control': 'no-store', ...(init.headers || {}) },
  });
}

export function errorResponse(reason: unknown, fallback = 'request failed') {
  if (reason instanceof HttpError) {
    return jsonResponse({ error: reason.message, ...(reason.details || {}) }, { status: reason.status });
  }
  if (reason instanceof SyntaxError) return jsonResponse({ error: 'request body is not valid JSON' }, { status: 400 });
  if (reason instanceof Error && 'code' in reason && reason.code === 'READ_ONLY') return jsonResponse({ error: 'This instance is read-only' }, { status: 405 });
  if (reason instanceof Error && 'code' in reason && reason.code === 'DATABASE_REPLACED') return jsonResponse({ error: 'Instance database was restored or replaced; restart the runtime' }, { status: 503 });
  // Only repository-verified retirement codes map to these statuses. Never
  // expose its private path, registration metadata or tombstone details.
  if (reason instanceof Error && 'code' in reason && reason.code === 'MEDIA_PURGED') return jsonResponse({ error: '历史媒体已清理；版本、原审阅与审计记录保留' }, { status: 410 });
  if (reason instanceof Error && 'code' in reason && reason.code === 'MEDIA_RETIRED') return jsonResponse({ error: '媒体已隔离或正在清理，请核查退役状态' }, { status: 409 });
  console.error('[review-site:v8]', reason);
  return jsonResponse({ error: fallback }, { status: 500 });
}

// Immutable release data is verified once per release, not on every object request.
const publishedViews = new Map<string, Promise<Awaited<ReturnType<InstanceReadUnit['readView']>>>>();
async function publishedView(repository: NonNullable<Awaited<ReturnType<typeof instanceRepository>>>):Promise<Awaited<ReturnType<InstanceReadUnit['readView']>>> {
  if(!repository.inTransaction)return repository.readTransaction(()=>publishedView(repository));
  if(repository.transactionMode==='WRITE')return repository.readView();
  const metadata = await repository.getMetadata();
  const key = `${metadata.instanceId}:${metadata.runtimeEpoch}:${metadata.releaseId}`;
  let pending = publishedViews.get(key);
  if (!pending) {
    pending = (async () => {
      const view = await repository.readView();
      const documents = await repository.listPublishedDocumentMetadata();
      publishedPromptAliases = new Set(documents.filter(row=>row.metadata.sourceRole === 'DIRECT_PROMPT').flatMap(row=>row.aliases));
      return view;
    })();
    publishedViews.set(key, pending);
    pending.catch(()=>publishedViews.delete(key));
    if(publishedViews.size>3) publishedViews.delete(publishedViews.keys().next().value!);
  }
  return pending;
}

export async function reviewData() {
  if (!hostedReadOnlyMode() && instanceRepositoryMode()) {
    const repository = (await instanceRepository())!;
    const view = await publishedView(repository);
    if (dataCache && dataCacheFingerprint === view.dataFingerprint) return dataCache;
    if (!view.snapshot?.snapshotId || !view.snapshot.productionModel || !view.recipes || view.snapshot.snapshotId !== view.recipes.snapshotId) throw new HttpError(503, 'Instance has no coherent active business release');
    const parsed = normalizeReviewSnapshot(view.snapshot as ReviewData);
    if (!parsed.instance || parsed.instance.instanceId !== view.instanceId) throw new HttpError(503, 'Instance release profile is missing or mismatched');
    bindInstanceSourceRoles(instanceProfile(parsed));
    dataCache = parsed; dataCacheFingerprint = view.dataFingerprint;
    return parsed;
  }
  if (hostedReadOnlyMode()) {
    if (dataCache && dataCacheFingerprint.startsWith('hosted:')) return dataCache;
    hostedDataPromise ??= (async () => {
      const [core, productionA, productionB] = await Promise.all([
        hostedAssetJson<Omit<ReviewData, 'productionModel'>>('/runtime/review-data-core.generated.json', 'review snapshot core'),
        hostedAssetJson<{ snapshotId: string; productionModel: Partial<ReviewData['productionModel']> }>('/runtime/review-data-production-a.generated.json', 'review production model A'),
        hostedAssetJson<{ snapshotId: string; productionModel: Partial<ReviewData['productionModel']> }>('/runtime/review-data-production-b.generated.json', 'review production model B'),
      ]);
      if (core?.snapshotId !== productionA?.snapshotId || core?.snapshotId !== productionB?.snapshotId) {
        throw new HttpError(503, 'hosted review snapshot shards diverge');
      }
      const parsed = {
        ...core,
        productionModel: {
          ...productionA.productionModel,
          ...productionB.productionModel,
        },
      } as ReviewData;
      if (!parsed?.snapshotId || !parsed.productionModel) throw new HttpError(503, 'hosted review snapshot is invalid');
      dataCache = normalizeReviewSnapshot(parsed);
      dataCacheFingerprint = `hosted:${parsed.snapshotId}`;
      return dataCache;
    })();
    try {
      return await hostedDataPromise;
    } finally {
      hostedDataPromise = null;
    }
  }
  requireLegacyFixtureMode();
  const dataPath = process.env.REVIEW_DATA_PATH || path.join(localReviewRoot(), 'app', 'review-data.generated.json');
  const info = await stat(dataPath);
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  if (dataCache && dataCacheFingerprint === fingerprint) return dataCache;
  let parsed: ReviewData;
  try {
    parsed = JSON.parse(await readFile(dataPath, 'utf8')) as ReviewData;
  } catch (reason) {
    throw new HttpError(503, 'review snapshot is being replaced or is invalid', { cause: String(reason) });
  }
  const after = await stat(dataPath);
  const afterFingerprint = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`;
  if (afterFingerprint !== fingerprint) throw new HttpError(503, 'review snapshot changed while it was being read');
  if (!parsed?.snapshotId || !parsed.productionModel) throw new HttpError(503, 'review snapshot is invalid');
  dataCache = normalizeReviewSnapshot(parsed);
  dataCacheFingerprint = fingerprint;
  return dataCache;
}

export type WorkProductReviewBinding = {
  workItemId: string;
  workPackageId: string;
  reviewContextRef: string;
  reviewScopeType: 'SHOT' | 'SCENE' | 'EPISODE' | 'PROJECT';
  reviewScopeId: string;
  contextHash: string;
  semanticStatus: string;
  reviewable: boolean;
  shotId: string | null;
};

export function workProductReviewBinding(
  data: ReviewData,
  workItemId: string,
  workPackageId: string,
): WorkProductReviewBinding | null {
  const workItem = data.productionModel.workItems.find((item) => item.id === workItemId);
  const workPackage = data.productionModel.workPackages.find((item) => item.id === workPackageId);
  if (!workItem || !workPackage || !workPackage.workItemRefs?.includes(workItemId)) return null;
  const reviewContextRef = String(workItem.reviewContextRef || workPackage.reviewContextRef || '');
  const referencedContext = reviewContextRef
    ? data.productionModel.reviewContexts?.find((context) => context.id === reviewContextRef)
    : null;
  // LINE work items are deliberately reviewed in their owning SHOT context.
  // Therefore the explicit ReviewContext is authoritative over the technical
  // work-item scope. Without a ref, only the four formal review scopes may be
  // inferred from the business object itself.
  const rawScopeType = String(
    referencedContext?.scopeType
    || (['SHOT', 'SCENE', 'EPISODE', 'PROJECT'].includes(String(workItem.scopeType).toUpperCase()) ? workItem.scopeType : '')
    || (['SHOT', 'SCENE', 'EPISODE', 'PROJECT'].includes(String(workPackage.scopeType).toUpperCase()) ? workPackage.scopeType : '')
    || (workItem.shotId ? 'SHOT' : ''),
  ).toUpperCase();
  if (!['SHOT', 'SCENE', 'EPISODE', 'PROJECT'].includes(rawScopeType)) return null;
  const reviewScopeType = rawScopeType as WorkProductReviewBinding['reviewScopeType'];
  const reviewScopeId = String(
    referencedContext?.scopeId
    || (reviewScopeType === 'SHOT' ? workItem.shotId || workPackage.scopeId : null)
    || (reviewScopeType === 'SCENE' ? workItem.sceneId || workPackage.sceneId || workItem.scopeId || workPackage.scopeId : null)
    || (reviewScopeType === 'EPISODE'
      ? (workItem.scopeType === 'EPISODE' ? workItem.scopeId : null)
        || (workPackage.scopeType === 'EPISODE' ? workPackage.scopeId : null)
        || workItem.episodeUid
        || workPackage.episodeUid
        || workItem.episodeId
        || workPackage.episodeId
      : null)
    || (reviewScopeType === 'PROJECT' ? workItem.scopeId || workPackage.scopeId || projectIdFor(data) : null)
    || '',
  );
  if (!reviewScopeId) return null;
  const reviewContext = referencedContext
    || data.productionModel.reviewContexts?.find((context) => context.scopeType === reviewScopeType && context.scopeId === reviewScopeId);
  if (reviewContext) {
    const semanticStatus = String(reviewContext.semanticStatus || '');
    const contextHash = String(reviewContext.contextHash || '').toLowerCase();
    const reviewable = reviewContext.reviewable === true
      && semanticStatus !== 'UNKNOWN_STALE_BINDING';
    if (
      reviewContext.scopeType !== reviewScopeType
      || reviewContext.scopeId !== reviewScopeId
      || !/^[a-f0-9]{64}$/.test(contextHash)
    ) return null;
    if (reviewScopeType === 'SHOT') {
      const shot = data.productionModel.shots?.find((item) => item.id === reviewScopeId);
      if (
        !shot
        || workItem.shotId !== reviewScopeId
        || !workPackage.shotIds?.includes(reviewScopeId)
        || !shot.workPackageRefs?.includes(workPackageId)
      ) return null;
    } else if (
      (reviewScopeType === 'SCENE' && workItem.sceneId !== reviewScopeId)
      || (reviewScopeType === 'EPISODE' && (
        String(workItem.scopeType === 'EPISODE' ? workItem.scopeId : workItem.episodeUid || workItem.episodeId || '') !== reviewScopeId
        || String(workPackage.scopeType === 'EPISODE' ? workPackage.scopeId : workPackage.episodeUid || workPackage.episodeId || '') !== reviewScopeId
      ))
      || (reviewScopeType === 'PROJECT' && ![projectIdFor(data), reviewScopeId].includes(String(workItem.scopeId || projectIdFor(data))))
    ) {
      return null;
    }
    return {
      workItemId,
      workPackageId,
      reviewContextRef: reviewContext.id,
      reviewScopeType,
      reviewScopeId,
      contextHash,
      semanticStatus,
      reviewable,
      shotId: reviewScopeType === 'SHOT' ? reviewScopeId : null,
    };
  }

  // Compatibility for pre-V8.4 shot contexts. Scope-level work products never
  // fall back to an arbitrary first shot.
  if (reviewScopeType !== 'SHOT') return null;
  const shot = data.productionModel.shots?.find((item) => item.id === reviewScopeId);
  const contextHash = String(shot?.reviewContext?.contextHash || '').toLowerCase();
  if (
    !shot
    || workItem.shotId !== reviewScopeId
    || !workPackage.shotIds?.includes(reviewScopeId)
    || !shot.workPackageRefs?.includes(workPackageId)
    || !/^[a-f0-9]{64}$/.test(contextHash)
  ) return null;
  return {
    workItemId,
    workPackageId,
    reviewContextRef: '',
    reviewScopeType,
    reviewScopeId,
    contextHash,
    semanticStatus: String(shot.reviewContext?.semanticStatus || 'AUTHORED_DRAFT'),
    reviewable: true,
    shotId: reviewScopeId,
  };
}

export async function recipeCatalogPath() {
  if (instanceRepositoryMode() && !hostedReadOnlyMode()) throw new HttpError(503, 'Instance recipes are database records, not a writable filesystem catalog');
  requireLegacyFixtureMode();
  const recipePath = process.env.REVIEW_RECIPE_PATH || path.join(localReviewRoot(), 'data', 'review-recipes.generated.json');
  const info = await stat(recipePath);
  if (!info.isFile()) throw new HttpError(503, 'execution recipe catalog is unavailable');
  return recipePath;
}

export async function recipeCatalog() {
  if (!hostedReadOnlyMode() && instanceRepositoryMode()) {
    const view = await publishedView((await instanceRepository())!);
    if (!view.recipes || !view.snapshot || view.recipes.snapshotId !== view.snapshot.snapshotId) throw new HttpError(503, 'Instance recipe and snapshot release mismatch');
    recipeCache = view.recipes as RecipeCatalog; recipeCacheFingerprint = view.recipeFingerprint;
    return recipeCache;
  }
  if (hostedReadOnlyMode()) {
    if (!recipeCache || !recipeCacheFingerprint.startsWith('hosted:')) {
      hostedRecipePromise ??= (async () => {
        const parsed = await hostedAssetJson<RecipeCatalog>('/runtime/review-recipes.generated.json', 'execution recipe catalog');
        if (!parsed?.snapshotId || !Array.isArray(parsed.executionDefinitions) || !Array.isArray(parsed.promptRevisions)) {
          throw new HttpError(503, 'hosted execution recipe catalog is invalid');
        }
        recipeCache = parsed;
        recipeCacheFingerprint = `hosted:${parsed.snapshotId}`;
        return parsed;
      })();
      try {
        await hostedRecipePromise;
      } finally {
        hostedRecipePromise = null;
      }
    }
    const catalog = recipeCache;
    if (!catalog) throw new HttpError(503, 'hosted execution recipe catalog is unavailable');
    const data = await reviewData();
    if (catalog.snapshotId !== data.snapshotId) {
      recipeCache = null;
      recipeCacheFingerprint = '';
      throw new HttpError(503, 'hosted execution recipe catalog and review snapshot diverge');
    }
    return catalog;
  }
  const recipePath = await recipeCatalogPath();
  const info = await stat(recipePath);
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  if (!recipeCache || recipeCacheFingerprint !== fingerprint) {
    let parsed: RecipeCatalog;
    try {
      parsed = JSON.parse(await readFile(recipePath, 'utf8')) as RecipeCatalog;
    } catch (reason) {
      throw new HttpError(503, 'execution recipe catalog is being replaced or is invalid', { cause: String(reason) });
    }
    const after = await stat(recipePath);
    const afterFingerprint = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`;
    if (afterFingerprint !== fingerprint) throw new HttpError(503, 'execution recipe catalog changed while it was being read');
    if (!parsed?.snapshotId || !Array.isArray(parsed.executionDefinitions) || !Array.isArray(parsed.promptRevisions)) {
      throw new HttpError(503, 'execution recipe catalog is invalid');
    }
    recipeCache = parsed;
    recipeCacheFingerprint = fingerprint;
  }
  const data = await reviewData();
  if (recipeCache.snapshotId !== data.snapshotId) {
    recipeCache = null;
    recipeCacheFingerprint = '';
    throw new HttpError(503, 'execution recipe catalog and review snapshot diverge');
  }
  return recipeCache;
}

export function eventStorePath() {
  if (instanceRepositoryMode() && !hostedReadOnlyMode()) throw new HttpError(503, 'Instance events use SQLite; legacy event directory fallback is forbidden');
  requireLegacyFixtureMode();
  return process.env.REVIEW_EVENT_STORE_PATH
    || path.resolve(localReviewRoot(), '..', 'production', '00_control', 'review_site_store', 'events');
}

function configuredOrigins() {
  const raw = process.env.REVIEW_ALLOWED_ORIGINS || process.env.SITE_BASE_URL || 'http://localhost:3000,http://127.0.0.1:3000';
  const origins = new Set<string>();
  for (const item of raw.split(',').map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(item);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) continue;
      origins.add(parsed.origin);
    } catch {
      // Invalid configured entries fail closed instead of widening the origin set.
    }
  }
  return origins;
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  try {
    const allowed = configuredOrigins();
    const browserOrigin = new URL(origin).origin;
    const requestOrigin = new URL(request.url).origin;
    return browserOrigin === requestOrigin
      && allowed.has(browserOrigin)
      && allowed.has(requestOrigin);
  } catch {
    return false;
  }
}

function unquoteStrongEtag(value: string | null) {
  const candidate = value?.trim() || '';
  if (!candidate || candidate.startsWith('W/') || candidate.includes(',')) return '';
  if (candidate.startsWith('"') && candidate.endsWith('"')) return candidate.slice(1, -1);
  return candidate;
}

export function quoteEtag(value: string) {
  return `"${value.replace(/["\\]/g, '')}"`;
}

export async function validateMutationRequest(request: Request) {
  if (instanceReadOnlyMode()) throw new HttpError(405, 'This instance is read-only');
  if (hostedReadOnlyMode()) {
    throw new HttpError(405, 'chatgpt.site is a read-only mirror; use http://localhost:3000 for formal review and production writes');
  }
  if (!sameOrigin(request)) throw new HttpError(403, 'mutation origin is not allowed');
  const ifMatchHeader = request.headers.get('if-match');
  if (!ifMatchHeader) {
    const operations = await operationalSnapshot();
    throw new HttpError(428, 'If-Match header is required', {
      currentEtag: operations.etag,
      mutationEtag: operations.mutationEtag,
      baseSnapshotId: operations.baseSnapshotId,
      operationRevision: operations.operationRevision,
      operationalRevision: operations.operationalRevision,
    });
  }
  const ifMatch = unquoteStrongEtag(ifMatchHeader);
  if (!ifMatch) throw new HttpError(400, 'If-Match must contain one strong ETag');
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() || '';
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
    throw new HttpError(400, 'valid Idempotency-Key header is required');
  }
  return { data: await reviewData(), idempotencyKey, ifMatch };
}

export function assertString(value: unknown, name: string, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${name} is invalid`);
  return value.trim();
}

export function optionalString(value: unknown, max = 20000) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new HttpError(400, 'optional text is invalid');
  }
  return value.trim();
}

export function assertSha256(value: unknown, name = 'sha256') {
  const result = assertString(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new HttpError(400, `${name} must be a complete SHA-256`);
  return result;
}

export function currentCreativeSubjectBaseHash(
  data: ReviewData,
  subjectKind: string,
  subjectId: string,
) {
  if (subjectKind === 'EPISODE_PLAN') {
    const sourceHash = String(data.creativeLineage?.storyStructure?.sourceSha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) {
      throw new HttpError(503, 'the current EpisodePlan source base hash is unavailable');
    }
    return sourceHash;
  }
  const rows = subjectKind === 'SCENE_COVERAGE'
    ? data.productionModel.sceneCoveragePlanRevisions
    : subjectKind === 'SHOT_PLAN_SET'
      ? data.productionModel.shotPlanSetRevisions
      : null;
  const row = rows?.find((candidate) => candidate.planId === subjectId);
  const baseHash = String(row?.revisionHash || row?.contentHash || '').toLowerCase();
  if (!row || !/^[a-f0-9]{64}$/.test(baseHash)) {
    throw new HttpError(503, `the current ${subjectKind} subject base hash is unavailable`);
  }
  return baseHash;
}

export type AdoptedMaterialStateProjection = {
  assetFamiliesById?: Record<string, Record<string, unknown> | undefined>;
  assetVersionsById?: Record<string, Record<string, unknown> | undefined>;
};

export function deriveCurrentAdoptedMaterialSet(
  data: ReviewData,
  state: AdoptedMaterialStateProjection,
  sceneId: string,
) {
  const scene = data.creativeLineage?.scenes?.find((row) => row.id === sceneId) || {};
  const scopedCoverage = data.productionModel.sceneCoveragePlanRevisions?.find(row => row.scopeId === sceneId && row.scopeRole === 'CURRENT' && row.episodeNarrativeReleaseId);
  const coverageRefs = scopedCoverage ? [...new Set(((scopedCoverage.content as {beats?:Array<{materialRequirementRefs:string[]}>})?.beats || []).flatMap(beat => beat.materialRequirementRefs))] : [];
  const scopedFamilies = coverageRefs.flatMap(ref => {
    const requirement = data.productionModel.materialRequirements?.find(r => r.id === ref && r.requirementClass === 'REQUIRED');
    if (!requirement || !Array.isArray(requirement.assetFamilyRefs) || !requirement.assetFamilyRefs.length) throw new HttpError(409, '本场已采用镜头意图仍有未绑定素材需求，不能把缺项当作空输入集');
    return requirement.assetFamilyRefs.map(String);
  });
  const familyRefs = [...new Set([
    ...scopedFamilies,
    ...(Array.isArray(scene.visualAssetRefs) ? scene.visualAssetRefs.map(String) : []),
    ...(Array.isArray(scene.audioAssetRefs) ? scene.audioAssetRefs.map(String) : []),
    ...(Array.isArray(scene.materialAssetRefs) ? scene.materialAssetRefs.map(String) : []),
  ])].sort();
  const bindings = familyRefs.flatMap((familyId) => {
    const family = state.assetFamiliesById?.[familyId];
    const versionId = String(family?.currentVersionId || '');
    const version = versionId ? state.assetVersionsById?.[versionId] : null;
    const sha256 = String(version?.sha256 || '').toLowerCase();
    if (scopedFamilies.includes(familyId) && (!versionId || version?.familyId !== familyId || !/^[a-f0-9]{64}$/.test(sha256) || version?.canFlowDownstream !== true || version?.lifecycleState !== 'RELEASED')) throw new HttpError(409, '本场素材尚无可下传的实际采用版本，不能以空输入集合替代');
    return versionId
      && version?.familyId === familyId
      && /^[a-f0-9]{64}$/.test(sha256)
      ? [{ familyId, versionId, sha256 }]
      : [];
  });
  return {
    id: `ADOPTED-MATERIAL-SET:${sceneId}`,
    bindings,
    contentHash: stableObjectHash(bindings),
  };
}

/** V2 authoring freezes demand and setting facts, never pretends missing media
 * are adopted inputs. Operational material status is deliberately not hashed. */
export function deriveCurrentMaterialRequirementSet(data: ReviewData, sceneId: string) {
  const coverageRows = (data.productionModel.sceneCoveragePlanRevisions || []).filter(row =>
    row.scopeId === sceneId && row.scopeRole === 'CURRENT' && row.revisionState === 'CURRENT' && row.isCurrent === true);
  if (coverageRows.length !== 1) throw new HttpError(409, '本场必须有唯一当前已采用镜头意图');
  const coverage = coverageRows[0];
  const content = coverage.content as { beats?: Array<{materialRequirementRefs?: unknown}> };
  if (!Array.isArray(content?.beats) || !content.beats.length || stableObjectHash(content) !== coverage.contentHash) {
    throw new HttpError(409, '本场镜头意图内容或哈希不完整');
  }
  const refs = [...new Set(content.beats.flatMap(beat => {
    if (!Array.isArray(beat.materialRequirementRefs) || beat.materialRequirementRefs.some(ref => typeof ref !== 'string')) {
      throw new HttpError(409, '本场镜头意图素材需求不完整');
    }
    return beat.materialRequirementRefs as string[];
  }))].sort();
  const model = data.productionModel as unknown as Record<string, unknown>;
  const directory = (model.materialDirectory || {}) as {
    bindings?: Array<Record<string, unknown>>; staleIds?: string[];
    graph?: {entities?:Array<Record<string,unknown>>; states?:Array<Record<string,unknown>>; representations?:Array<Record<string,unknown>>};
  };
  const graph = directory.graph || (model.domainGraph || {}) as NonNullable<typeof directory.graph>;
  const bindings = refs.map(requirementId => {
    const rows = (data.productionModel.materialRequirements || []).filter(row => row.id === requirementId);
    const requirement = rows[0] as Record<string, unknown> | undefined;
    if (rows.length !== 1 || requirement?.requirementClass !== 'REQUIRED'
      || !/^[a-f0-9]{64}$/.test(String(requirement.requirementHash || ''))
      || directory.staleIds?.includes(requirementId)) {
      throw new HttpError(409, '镜头意图引用了缺失、失效或无精确哈希的素材需求', {requirementId});
    }
    const ownership = directory.bindings?.filter(row => row.requirementId === requirementId) || [];
    if (ownership.length > 1) throw new HttpError(409, '素材需求归属不唯一', {requirementId});
    const owner = ownership[0];
    if (owner && owner.requirementHash !== requirement.requirementHash) {
      throw new HttpError(409, '素材目录与需求哈希不一致', {requirementId});
    }
    const stateId = String(owner?.stateId || requirement.stateRef || '');
    const representationId = String(owner?.representationId || requirement.representationRef || '');
    const exact = (rows: Array<Record<string, unknown>> | undefined, id: string, kind: string) => {
      if (!id) return null;
      const found = (rows || []).filter(row => row.id === id);
      if (found.length !== 1) throw new HttpError(409, '素材条件无法精确解析', {requirementId, kind, id});
      const value = kind === 'ENTITY'
        ? Object.fromEntries(['id','type','name','aliases','description','authority','evidence'].filter(key => found[0][key] !== undefined).map(key => [key, found[0][key]]))
        : found[0];
      return {id, hash:stableObjectHash(value), value};
    };
    return {
      requirementId, requirementHash: String(requirement.requirementHash),
      acceptanceCriteria: requirement.acceptanceCriteria || [],
      authority: requirement.authorityClass || requirement.authority || 'UNKNOWN',
      conditions: {
        entityId: owner?.entityId || requirement.entityRef || null,
        entity: exact(graph.entities, String(owner?.entityId || requirement.entityRef || ''), 'ENTITY'),
        state: exact(graph.states, stateId, 'STATE'),
        representation: exact(graph.representations, representationId, 'REPRESENTATION'),
      },
    };
  });
  const value = {schemaVersion:'2.0', sceneId, coverageRevisionId:String(coverage.id),
    coverageContentHash:String(coverage.contentHash), bindings};
  return {id:`MATERIAL-REQUIREMENT-SET:${sceneId}`, ...value, contentHash:stableObjectHash(value)};
}

export function assertShotPlanMaterialBasisCurrent(
  data: ReviewData,
  state: AdoptedMaterialStateProjection,
  sceneId: string,
  rawBasisBindings: unknown,
) {
  const basisBindings = Array.isArray(rawBasisBindings)
    ? rawBasisBindings.filter((binding): binding is Record<string, unknown> => (
        Boolean(binding) && typeof binding === 'object' && !Array.isArray(binding)
      ))
    : [];
  const requirementBasis = basisBindings.some(binding => binding.bindingType === 'MATERIAL_REQUIREMENT_SET');
  const bindingType = requirementBasis ? 'MATERIAL_REQUIREMENT_SET' : 'ADOPTED_MATERIAL_SET';
  if (requirementBasis && basisBindings.some(binding => binding.bindingType === 'ADOPTED_MATERIAL_SET')) {
    throw new HttpError(409, '镜头设计需求依据与 V1 实际采用素材依据不能混合');
  }
  const adopted = basisBindings.filter((binding) => binding.bindingType === bindingType);
  const current = requirementBasis ? deriveCurrentMaterialRequirementSet(data, sceneId) : deriveCurrentAdoptedMaterialSet(data, state, sceneId);
  const binding = adopted[0];
  if (
    adopted.length !== 1
    || binding.bindingId !== current.id
    || binding.bindingHash !== current.contentHash
    || binding.scopeType !== 'SCENE'
    || binding.scopeId !== sceneId
  ) {
    throw new HttpError(409, bindingType + ' does not resolve to the current exact scene basis', {
      reasonCode: requirementBasis ? 'CURRENT_MATERIAL_REQUIREMENT_SET_REQUIRED' : 'CURRENT_ADOPTED_MATERIAL_SET_REQUIRED',
      expectedBindingId: current.id,
      currentBindingHash: current.contentHash,
    });
  }
  return current;
}

export function assertDeployedShotPlanMaterialSet(
  data: ReviewData,
  creativeRevisionId: string,
  expected: ReturnType<typeof deriveCurrentAdoptedMaterialSet> | ReturnType<typeof deriveCurrentMaterialRequirementSet>,
) {
  const revision = data.productionModel.shotPlanSetRevisions?.find((row) => (
    row.id === creativeRevisionId
    && row.scopeRole === 'CURRENT'
    && row.revisionState === 'CURRENT'
    && row.isCurrent === true
  ));
  const deployed = 'schemaVersion' in expected ? revision?.materialRequirementSet : revision?.adoptedMaterialSet;
  if (
    !deployed
    || typeof deployed !== 'object'
    || Array.isArray(deployed)
    || stableObjectHash(deployed) !== stableObjectHash(expected)
  ) {
    throw new HttpError(409, 'deployed ShotPlanSet adopted material set does not equal the current operational adoption projection', {
      reasonCode: 'DEPLOYED_ADOPTED_MATERIAL_SET_MISMATCH',
    });
  }
}

export type CreativeBasisStateProjection = AdoptedMaterialStateProjection & {
  episodeNarrativeReleasesByUid?: Record<string, Record<string, unknown> | undefined>;
  structuresById?: Record<string, Record<string, unknown> | undefined>;
  scriptScenesById?: Record<string, Record<string, unknown> | undefined>;
  scopeLocksById?: Record<string, Record<string, unknown> | undefined>;
};

export function assertCreativeRevisionBasisCurrent(
  data: ReviewData,
  state: CreativeBasisStateProjection,
  revision: Record<string, unknown>,
  options: { requireCurrentPredecessor?: boolean } = {},
) {
  const subjectKind = String(revision.subjectKind || '');
  const subjectId = String(revision.subjectId || '');
  const basisBindings = Array.isArray(revision.basisBindings)
    ? revision.basisBindings.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    ))
    : [];
  const expectedTypes: Record<string, string[]> = {
    EPISODE_PLAN: ['SCRIPT_REVISION', 'STORY_REVISION'],
    SCENE_COVERAGE: ['CONTINUITY_SPEC', basisBindings.some(b=>b.bindingType==='EPISODE_NARRATIVE_RELEASE')?'EPISODE_NARRATIVE_RELEASE':'EPISODE_PLAN_REVISION', 'SCENE_SCRIPT_REVISION'],
    SHOT_PLAN_SET: [basisBindings.some(b => b.bindingType === 'MATERIAL_REQUIREMENT_SET') ? 'MATERIAL_REQUIREMENT_SET' : 'ADOPTED_MATERIAL_SET', 'SCENE_COVERAGE_REVISION'],
  };
  const requiredTypes = expectedTypes[subjectKind];
  const actualTypes = basisBindings.map((item) => String(item.bindingType || '')).sort();
  if (
    !requiredTypes
    || stableObjectHash(actualTypes) !== stableObjectHash(requiredTypes)
    || stableObjectHash(basisBindings) !== revision.basisBindingsHash
  ) {
    throw new HttpError(409, `${subjectKind || 'creative revision'} basis bindings are no longer canonical`, {
      reasonCode: 'CURRENT_CREATIVE_BASIS_REQUIRED',
    });
  }
  if (
    options.requireCurrentPredecessor !== false
    && revision.baseRevisionHash !== currentCreativeSubjectBaseHash(data, subjectKind, subjectId)
  ) {
    throw new HttpError(409, `${subjectKind} predecessor changed after candidate creation`, {
      reasonCode: 'CURRENT_CREATIVE_PREDECESSOR_REQUIRED',
    });
  }
  const bindingByType = new Map(basisBindings.map((item) => [String(item.bindingType || ''), item]));
  const id = (row: Record<string, unknown>) => String(row.id || row.revisionId || row.planId || '');
  const hash = (row: Record<string, unknown>) => String(row.revisionHash || row.contentHash || row.sourceSha256 || '').toLowerCase();
  const exactRow = (rows: Array<Record<string, unknown>> | undefined, bindingType: string) => {
    const binding = bindingByType.get(bindingType);
    const row = rows?.find((candidate) => id(candidate) === binding?.bindingId);
    if (!binding || !row || hash(row) !== binding.bindingHash) {
      throw new HttpError(409, `${bindingType} no longer resolves to the exact current creative basis`, {
        reasonCode: 'CURRENT_CREATIVE_BASIS_REQUIRED',
      });
    }
    return { binding, row };
  };

  if (subjectKind === 'EPISODE_PLAN') {
    const story = exactRow(data.productionModel.storyRevisions, 'STORY_REVISION').row;
    const script = exactRow(data.productionModel.scriptRevisions, 'SCRIPT_REVISION').row;
    const genericRoots=((data.productionModel as unknown as {genericAuthoring?:{roots:Array<Record<string,unknown>>}}).genericAuthoring?.roots)||[];
    const genericStory=genericRoots.find(root=>root.id===story.rootId&&root.revisionId===id(story)&&root.contentHash===hash(story));
    const genericScript=genericRoots.find(root=>root.id===script.rootId&&root.revisionId===id(script)&&root.contentHash===hash(script));
    const firstAuthoredBasis=story.authoringEntry==='GENERIC_AUTHORING_DRAFT'&&script.authoringEntry==='GENERIC_AUTHORING_DRAFT'
      &&story.scopeRole==='PROPOSAL'&&script.scopeRole==='PROPOSAL'&&genericStory?.kind==='STORY_OUTLINE'&&genericScript?.kind==='SCREENPLAY'
      &&genericScript.parentId===genericStory.id
      &&!(data.productionModel.storyRevisions||[]).some(row=>row.scopeRole==='CURRENT')
      &&!(data.productionModel.scriptRevisions||[]).some(row=>row.scopeRole==='CURRENT');
    if ((story.scopeRole !== 'CURRENT' || script.scopeRole !== 'CURRENT')&&!firstAuthoredBasis) {
      throw new HttpError(409, 'EpisodePlan story/script basis is no longer current', {
        reasonCode: 'CURRENT_CREATIVE_BASIS_REQUIRED',
      });
    }
    return;
  }

  const subjectRow = (subjectKind === 'SCENE_COVERAGE'
    ? data.productionModel.sceneCoveragePlanRevisions
    : data.productionModel.shotPlanSetRevisions)?.find((row) => row.planId === subjectId);
  const sceneId = String((revision.content as Record<string, unknown> | undefined)?.sceneId || subjectRow?.scopeId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(sceneId) || subjectRow?.scopeId !== sceneId) {
    throw new HttpError(409, `${subjectKind} scene scope no longer resolves`, {
      reasonCode: 'CURRENT_CREATIVE_BASIS_REQUIRED',
    });
  }

  if (subjectKind === 'SCENE_COVERAGE') {
    if (bindingByType.has('EPISODE_NARRATIVE_RELEASE')) {
      assertScopedEpisodeSceneBasis(data, state.episodeNarrativeReleasesByUid, sceneId, basisBindings);
      return;
    }
    const episode = exactRow(data.productionModel.episodePlanRevisions, 'EPISODE_PLAN_REVISION');
    const sceneScript = exactRow(data.productionModel.sceneScriptRevisions, 'SCENE_SCRIPT_REVISION');
    const continuity = bindingByType.get('CONTINUITY_SPEC');
    const episodeProjection = state.structuresById?.[`EPISODE_PLAN::${episodePlanIdFor(data)}`];
    const sceneProjection = state.scriptScenesById?.[sceneId];
    const episodeIsCurrent = episode.row.scopeRole === 'CURRENT'
      && episode.row.revisionState === 'CURRENT'
      && episode.row.isCurrent === true;
    const projectedEpisodeIsCurrent = episodeProjection?.subjectRevisionId === episode.binding.bindingId
      && episodeProjection?.subjectRevisionHash === episode.binding.bindingHash
      && episodeProjection?.reviewDecision === 'RELEASED'
      && episodeProjection?.sourceSyncState === 'SUCCEEDED'
      && episodeProjection?.canFlowDownstream === true;
    if (
      (!episodeIsCurrent && !projectedEpisodeIsCurrent)
      || sceneScript.row.sceneId !== sceneId
      || sceneScript.binding.scopeType !== 'SCENE'
      || sceneScript.binding.scopeId !== sceneId
      || sceneProjection?.subjectRevisionHash !== sceneScript.binding.bindingHash
      || sceneProjection?.reviewDecision !== 'RELEASED'
      || sceneProjection?.lifecycleState !== 'RELEASED'
      || sceneProjection?.canFlowDownstream !== true
      || continuity?.bindingId !== 'PRODUCTION-MAP-SPEC'
      || continuity?.bindingHash !== String(data.sourceHashes?.productionMapSha256 || '').toLowerCase()
    ) {
      throw new HttpError(409, 'SceneCoverage creative basis changed after candidate creation', {
        reasonCode: 'CURRENT_CREATIVE_BASIS_REQUIRED',
        sceneId,
      });
    }
    return;
  }

  const coverage = exactRow(data.productionModel.sceneCoveragePlanRevisions, 'SCENE_COVERAGE_REVISION');
  const scopeLock = Object.values(state.scopeLocksById || {}).find((row) => (
    row?.scopeType === 'SCENE' && row.scopeId === sceneId && row.lockPurpose === 'SHOT_PLAN_SET'
  ));
  if (
    coverage.row.scopeId !== sceneId
    || coverage.binding.scopeType !== 'SCENE'
    || coverage.binding.scopeId !== sceneId
    || coverage.row.scopeRole !== 'CURRENT'
    || coverage.row.revisionState !== 'CURRENT'
    || coverage.row.isCurrent !== true
    || !scopeLock
    || (
      !['READY_TO_LOCK', 'LOCKED'].includes(String(scopeLock.lockState || scopeLock.scopeLockState || ''))
      || scopeLock.readyRevisionId !== coverage.binding.bindingId
      || scopeLock.readyRevisionHash !== coverage.binding.bindingHash
    )
  ) {
    throw new HttpError(409, 'ShotPlanSet SceneCoverage basis changed after candidate creation', {
      reasonCode: 'CURRENT_CREATIVE_BASIS_REQUIRED',
      sceneId,
    });
  }
  assertCreativeRevisionBasisCurrent(data, state, {
    subjectKind: 'SCENE_COVERAGE',
    subjectId: coverage.row.planId,
    content: coverage.row.content,
    baseRevisionHash: coverage.row.baseRevisionHash,
    basisBindings: coverage.row.basisBindings,
    basisBindingsHash: coverage.row.basisBindingsHash,
  }, { requireCurrentPredecessor: false });
  const materialSet = assertShotPlanMaterialBasisCurrent(data, state, sceneId, basisBindings);
  const v2 = bindingByType.has('MATERIAL_REQUIREMENT_SET');
  const frozenSet = v2 ? revision.materialRequirementSet : revision.adoptedMaterialSet;
  if (v2 !== (revision.planningContractVersion === '2.0') || v2 && revision.adoptedMaterialSet != null || !v2 && revision.materialRequirementSet != null) {
    throw new HttpError(409, '镜头设计 V2 必须声明独立契约，不可冒充已采用实际素材');
  }
  if (
    !frozenSet
    || typeof frozenSet !== 'object'
    || Array.isArray(frozenSet)
    || stableObjectHash(frozenSet) !== stableObjectHash(materialSet)
  ) {
    throw new HttpError(409, 'ShotPlanSet adopted material basis changed after candidate creation', {
      reasonCode: 'CURRENT_ADOPTED_MATERIAL_SET_REQUIRED',
      sceneId,
    });
  }
}

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/;

export function assertStableId(value: unknown, name: string, max = 300) {
  const result = assertString(value, name, max);
  if (!stableIdPattern.test(result)) throw new HttpError(400, `${name} must be a stable identifier`);
  return result;
}

export function optionalStableId(value: unknown, name: string, max = 300) {
  if (value == null || value === '') return '';
  return assertStableId(value, name, max);
}

export function assertJsonObject(value: unknown, name: string, maxBytes = 250_000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${name} must be an object`);
  let encoded = '';
  try { encoded = JSON.stringify(value); } catch { throw new HttpError(400, `${name} is not valid JSON`); }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new HttpError(413, `${name} is too large`);
  return value as Record<string, unknown>;
}

export function assertJsonArray(value: unknown, name: string, maxItems = 500, maxBytes = 500_000) {
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, `${name} must be an array with at most ${maxItems} entries`);
  let encoded = '';
  try { encoded = JSON.stringify(value); } catch { throw new HttpError(400, `${name} is not valid JSON`); }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw new HttpError(413, `${name} is too large`);
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function stableObjectHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function assertDeployedCreativeRevisionBinding(
  data: ReviewData,
  binding: Record<string, unknown>,
) {
  const subjectKind = String(binding.subjectKind || '');
  const creativeRevisionId = String(binding.creativeRevisionId || '');
  const subjectRevisionHash = String(binding.subjectRevisionHash || '').toLowerCase();
  if (!creativeRevisionSourcePathBySubjectKind[subjectKind]) {
    throw new HttpError(422, 'deployed creative revision subjectKind is unsupported');
  }
  assertStableId(creativeRevisionId, 'creativeRevisionId');
  assertSha256(subjectRevisionHash, 'subjectRevisionHash');

  if (subjectKind === 'EPISODE_PLAN') {
    const storyStructure = data.creativeLineage?.storyStructure;
    if (
      storyStructure?.planId !== episodePlanIdFor(data)
      || storyStructure.planStatus !== 'CURRENT'
      || storyStructure.reviewStatus !== 'ADOPTED'
      || storyStructure.adoptedCreativeRevisionId !== creativeRevisionId
      || storyStructure.adoptedCreativeRevisionHash !== subjectRevisionHash
      || storyStructure.canonicalContentHash !== subjectRevisionHash
    ) {
      throw new HttpError(409, 'deployed episode-plan source does not equal the approved creative revision binding');
    }
  }

  const revisions = subjectKind === 'EPISODE_PLAN'
    ? data.productionModel.episodePlanRevisions
    : subjectKind === 'SCENE_COVERAGE'
      ? data.productionModel.sceneCoveragePlanRevisions
      : data.productionModel.shotPlanSetRevisions;
  const matches = (revisions || []).filter((revision) => revision.id === creativeRevisionId);
  if (
    matches.length !== 1
    || (subjectKind === 'EPISODE_PLAN' && (revisions || []).length !== 1)
  ) {
    throw new HttpError(409, `deployed ${subjectKind} runtime must expose exactly one approved CreativeRevision`);
  }
  const revision = matches[0];
  const content = revision.content;
  const isSceneScoped = subjectKind !== 'EPISODE_PLAN';
  const expectedPlanId = isSceneScoped
    ? `${subjectKind === 'SCENE_COVERAGE' ? 'SCENE-COVERAGE-PLAN' : 'SHOT-PLAN-SET'}:${String((content as Record<string, unknown> | undefined)?.sceneId || '')}`
    : episodePlanIdFor(data);
  const basisBindingsHash = assertSha256(binding.basisBindingsHash, 'basisBindingsHash');
  const currentSceneRows = isSceneScoped
    ? (revisions || []).filter((candidate) => (
      candidate.scopeId === revision.scopeId
      && candidate.scopeRole === 'CURRENT'
      && candidate.revisionState === 'CURRENT'
      && candidate.isCurrent === true
    ))
    : [];
  if (
    revision.revisionId !== creativeRevisionId
    || revision.creativeRevisionId !== creativeRevisionId
    || revision.adoptedCreativeRevisionId !== creativeRevisionId
    || revision.contentHash !== subjectRevisionHash
    || revision.revisionHash !== subjectRevisionHash
    || revision.adoptedCreativeRevisionHash !== subjectRevisionHash
    || revision.planId !== expectedPlanId
    || revision.status !== 'CURRENT'
    || revision.isCurrent !== true
    || revision.revisionState !== 'CURRENT'
    || revision.scopeRole !== 'CURRENT'
    || revision.basisBindingsHash !== basisBindingsHash
    || !Array.isArray(revision.basisBindings)
    || stableObjectHash(revision.basisBindings) !== basisBindingsHash
    || (isSceneScoped && (
      currentSceneRows.length !== 1
      || currentSceneRows[0]?.id !== creativeRevisionId
      || currentSceneRows[0]?.planId !== expectedPlanId
    ))
    || (isSceneScoped && (
      !content
      || typeof content !== 'object'
      || Array.isArray(content)
      || stableObjectHash(content) !== subjectRevisionHash
      || revision.sceneId !== (content as Record<string, unknown>).sceneId
      || revision.scopeId !== revision.sceneId
      || revision.sourceSyncState !== 'SUCCEEDED'
      || (revision.sync as Record<string, unknown> | undefined)?.state !== 'SUCCEEDED'
      || (revision.review as Record<string, unknown> | undefined)?.state !== 'ADOPTED'
    ))
  ) {
    throw new HttpError(409, `deployed ${subjectKind} revision does not equal the approved creative revision binding`);
  }
}

export const formalReviewRuntimeUrl = 'http://localhost:3000';

function succeededEvidenceObject(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(422, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function succeededEvidenceString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(422, `${name} must be a non-empty string`);
  }
  return value;
}

function succeededEvidenceTimestamp(value: unknown, name: string) {
  const result = succeededEvidenceString(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new HttpError(422, `${name} must be a valid timestamp`);
  return result;
}

function succeededSourceBlockHashes(event: EventRecord) {
  const sourcePaths = event.sourcePaths;
  if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.some((item) => typeof item !== 'string' || !item)) {
    throw new HttpError(422, 'SUCCEEDED sourcePaths must be a non-empty string array');
  }
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    throw new HttpError(422, 'SUCCEEDED sourcePaths must not contain duplicates');
  }
  const hashes = succeededEvidenceObject(event.newBlockHashes, 'SUCCEEDED newBlockHashes');
  const actualKeys = Object.keys(hashes).sort();
  const expectedKeys = [...sourcePaths].sort();
  if (stableObjectHash(actualKeys) !== stableObjectHash(expectedKeys)) {
    throw new HttpError(422, 'SUCCEEDED newBlockHashes keys must exactly match sourcePaths');
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, assertSha256(hashes[key], `newBlockHashes.${key}`)]));
}

/**
 * Re-validates the immutable evidence carried by a terminal SourceOperation.
 *
 * POST additionally checks the referenced host files. This pure validator is
 * intentionally shared by POST and event replay so a malformed/raw event can
 * never acquire source-sync authority merely by claiming SUCCEEDED.
 */
export function assertSourceOperationSucceededEvidence(event: EventRecord, expectedTargetSnapshotId?: string) {
  if ((event.operationState || event.state) !== 'SUCCEEDED') {
    throw new HttpError(422, 'source operation evidence is not terminal SUCCEEDED');
  }
  const sourceOperationId = succeededEvidenceString(event.sourceOperationId, 'sourceOperationId');
  const targetSnapshotId = succeededEvidenceString(event.targetSnapshotId, 'targetSnapshotId');
  if (expectedTargetSnapshotId && targetSnapshotId !== expectedTargetSnapshotId) {
    throw new HttpError(409, 'SUCCEEDED targetSnapshotId does not match the active review snapshot');
  }
  const runtimeBundleId = succeededEvidenceString(event.runtimeBundleId, 'runtimeBundleId');
  if (path.basename(runtimeBundleId) !== runtimeBundleId) {
    throw new HttpError(422, 'SUCCEEDED runtimeBundleId is not a safe bundle identifier');
  }
  const reviewDataSha256 = assertSha256(event.reviewDataSha256, 'reviewDataSha256');
  const recipeSha256 = assertSha256(event.recipeSha256, 'recipeSha256');
  const derivedArtifactHashes = derivedArtifactHashMap(event.derivedArtifactHashes);
  const newBlockHashes = succeededSourceBlockHashes(event);
  const sourcePaths = event.sourcePaths as string[];
  const operationType = succeededEvidenceString(event.operationType, 'operationType');
  if (operationType === 'PROMPT_SYNC' || operationType === 'CREATIVE_REVISION_SYNC') {
    const impact = succeededEvidenceObject(event.impact, `${operationType} impact`);
    const bindingFields = operationType === 'PROMPT_SYNC'
      ? ['reviewEventId', 'versionId', 'actualPromptHash'] as const
      : ['reviewEventId', 'creativeRevisionId', 'subjectRevisionHash', 'subjectKind', 'basisBindingsHash'] as const;
    for (const field of bindingFields) {
      if (!(field in event) || !(field in impact) || event[field] !== impact[field]) {
        throw new HttpError(422, `${operationType} top-level ${field} must exactly match impact.${field}`);
      }
      succeededEvidenceString(event[field], `${operationType}.${field}`);
    }
    if (operationType === 'PROMPT_SYNC') {
      assertSha256(event.actualPromptHash, 'PROMPT_SYNC.actualPromptHash');
      if (sourcePaths.some((sourcePath) => !isDirectPromptSourcePath(sourcePath))) {
        throw new HttpError(422, 'PROMPT_SYNC sourcePaths must contain only direct Prompt Markdown sources');
      }
    } else {
      assertSha256(event.subjectRevisionHash, 'CREATIVE_REVISION_SYNC.subjectRevisionHash');
      const subjectKind = String(event.subjectKind);
      const expectedSourcePath = creativeRevisionSourcePathBySubjectKind[subjectKind];
      if (!expectedSourcePath) {
        throw new HttpError(422, 'CREATIVE_REVISION_SYNC subjectKind is not supported');
      }
      if (sourcePaths.length !== 1 || sourcePaths[0] !== expectedSourcePath) {
        throw new HttpError(422, `CREATIVE_REVISION_SYNC ${subjectKind} sourcePaths do not match its authoritative source`);
      }
      assertSha256(event.basisBindingsHash, 'CREATIVE_REVISION_SYNC.basisBindingsHash');
    }
  }

  const qa = succeededEvidenceObject(event.qa, 'SUCCEEDED qa');
  if (qa.status !== 'PASS') throw new HttpError(422, 'SUCCEEDED requires qa.status=PASS');
  const recovery = succeededEvidenceObject(event.recovery, 'SUCCEEDED recovery');
  for (const field of ['strategy', 'journal', 'backup'] as const) {
    succeededEvidenceString(recovery[field], `recovery.${field}`);
  }

  const deployedEndpointProof = succeededEvidenceObject(
    event.deployedEndpointProof,
    'SUCCEEDED deployedEndpointProof',
  );
  const deployedDerivedArtifactHashes = derivedArtifactHashMap(
    deployedEndpointProof.derivedArtifactHashes,
    'deployedEndpointProof.derivedArtifactHashes',
  );
  const deployedExact: Record<string, unknown> = {
    url: formalReviewRuntimeUrl,
    snapshotId: targetSnapshotId,
    runtimeBundleId,
    reviewDataSha256,
    recipeSha256,
  };
  for (const [field, expected] of Object.entries(deployedExact)) {
    if (deployedEndpointProof[field] !== expected) {
      throw new HttpError(422, `deployedEndpointProof.${field} does not match the SourceOperation event`);
    }
  }
  if (
    deployedEndpointProof.endpoint != null
    && deployedEndpointProof.endpoint !== formalReviewRuntimeUrl
  ) {
    throw new HttpError(422, 'deployedEndpointProof.endpoint is not the formal localhost runtime');
  }
  if (stableObjectHash(deployedDerivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes)) {
    throw new HttpError(422, 'deployedEndpointProof.derivedArtifactHashes do not match the SourceOperation event');
  }
  const containerFileHashes = succeededEvidenceObject(
    deployedEndpointProof.containerFileHashes,
    'deployedEndpointProof.containerFileHashes',
  );
  if (
    containerFileHashes.reviewDataSha256 !== reviewDataSha256
    || containerFileHashes.recipeSha256 !== recipeSha256
  ) {
    throw new HttpError(422, 'deployedEndpointProof.containerFileHashes do not match the SourceOperation event');
  }

  const hostWorkerProof = succeededEvidenceObject(event.hostWorkerProof, 'SUCCEEDED hostWorkerProof');
  const hostWorkerProofKeys = Object.keys(hostWorkerProof).sort();
  const expectedHostWorkerProofKeys = ['digest', 'proofPayload', 'ref', 'verificationMode', 'verifiedAt'].sort();
  if (stableObjectHash(hostWorkerProofKeys) !== stableObjectHash(expectedHostWorkerProofKeys)) {
    throw new HttpError(422, 'hostWorkerProof must contain the exact replay-verifiable proof summary');
  }
  const instanceSourceProof = instanceRepositoryMode()
    && ['INSTANCE_SQLITE_RELEASE_AND_SOURCE_RECORDS','INSTANCE_POSTGRES_RELEASE_AND_SOURCE_RECORDS'].includes(String(hostWorkerProof.verificationMode));
  if (hostWorkerProof.verificationMode !== 'HOST_FILESYSTEM_AND_FORMAL_RUNTIME_FILES' && !instanceSourceProof) {
    throw new HttpError(422, 'hostWorkerProof.verificationMode is invalid');
  }
  if (instanceSourceProof && (
    !['INSTANCE_SQLITE','INSTANCE_POSTGRES'].includes(String(deployedEndpointProof.authority))
    || typeof deployedEndpointProof.releaseId !== 'string' || !deployedEndpointProof.releaseId
    || typeof deployedEndpointProof.runtimeEpoch !== 'string' || !deployedEndpointProof.runtimeEpoch
  )) {
    throw new HttpError(422, 'SQLite source proof requires the exact active release and runtime epoch');
  }
  const expectedProofRef = `host_proofs/${sourceOperationId}.json`;
  if (hostWorkerProof.ref !== expectedProofRef) {
    throw new HttpError(422, 'hostWorkerProof.ref is not bound to sourceOperationId');
  }
  const proofDigest = assertSha256(hostWorkerProof.digest, 'hostWorkerProof.digest');
  const proofVerifiedAt = succeededEvidenceTimestamp(hostWorkerProof.verifiedAt, 'hostWorkerProof.verifiedAt');
  const proofPayload = succeededEvidenceObject(hostWorkerProof.proofPayload, 'hostWorkerProof.proofPayload');
  const expectedProofPayloadKeys = [
    'apiSourceOperationId',
    'deployedEndpointProofHash',
    'derivedArtifactHashes',
    'formalRuntimeQaStatus',
    'formalUrl',
    'preDeploymentQaStatus',
    'proofType',
    'recipeSha256',
    'reviewDataSha256',
    'runtimeBundleId',
    'schemaVersion',
    'sourceBlockHashes',
    'targetSnapshotId',
    'verifiedAt',
    'workerOperationId',
  ].sort();
  if (stableObjectHash(Object.keys(proofPayload).sort()) !== stableObjectHash(expectedProofPayloadKeys)) {
    throw new HttpError(422, 'hostWorkerProof.proofPayload fields are incomplete or unexpected');
  }
  const proofDerivedArtifactHashes = derivedArtifactHashMap(
    proofPayload.derivedArtifactHashes,
    'hostWorkerProof.proofPayload.derivedArtifactHashes',
  );
  const proofExact: Record<string, unknown> = {
    schemaVersion: '1.1',
    proofType: 'HOST_WORKER_FORMAL_DEPLOYMENT_QA',
    apiSourceOperationId: sourceOperationId,
    targetSnapshotId,
    runtimeBundleId,
    reviewDataSha256,
    recipeSha256,
    sourceBlockHashes: newBlockHashes,
    formalUrl: formalReviewRuntimeUrl,
    preDeploymentQaStatus: 'PASS',
    formalRuntimeQaStatus: 'PASS',
    deployedEndpointProofHash: stableObjectHash(deployedEndpointProof),
    verifiedAt: proofVerifiedAt,
  };
  for (const [field, expected] of Object.entries(proofExact)) {
    if (!(field in proofPayload) || stableObjectHash(proofPayload[field]) !== stableObjectHash(expected)) {
      throw new HttpError(422, `hostWorkerProof.proofPayload.${field} does not match the SourceOperation event`);
    }
  }
  succeededEvidenceString(proofPayload.workerOperationId, 'hostWorkerProof.proofPayload.workerOperationId');
  if (stableObjectHash(proofDerivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes)) {
    throw new HttpError(422, 'hostWorkerProof.proofPayload.derivedArtifactHashes do not match the SourceOperation event');
  }
  if (stableObjectHash(proofPayload) !== proofDigest) {
    throw new HttpError(422, 'hostWorkerProof.digest does not match hostWorkerProof.proofPayload');
  }
  const deployedHostDigest = deployedEndpointProof.hostWorkerProofDigest;
  if (deployedHostDigest != null && deployedHostDigest !== proofDigest) {
    throw new HttpError(422, 'deployedEndpointProof.hostWorkerProofDigest does not match hostWorkerProof.digest');
  }
  return {
    sourceOperationId,
    targetSnapshotId,
    runtimeBundleId,
    reviewDataSha256,
    recipeSha256,
    derivedArtifactHashes,
    deployedEndpointProof,
    containerFileHashes,
    hostWorkerProof,
    proofPayload,
  };
}

export function assetReviewContextHash(
  data: ReviewData,
  familyId: string,
  versionId: string,
  versionSha256: string,
) {
  const materialRequirements = (data.productionModel.materialRequirements || [])
    .filter((requirement) => requirement.assetFamilyRefs.includes(familyId))
    .map((requirement) => ({ id: requirement.id, requirementHash: requirement.requirementHash }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return stableObjectHash({
    subjectType: 'ASSET',
    familyId,
    versionId,
    versionSha256: versionSha256.toLowerCase(),
    materialRequirements,
  });
}

function legacyAssetReviewContextHash(data: ReviewData, familyId: string, versionId: string, versionSha256: string) {
  return stableObjectHash({
    snapshotId: data.snapshotId,
    subjectType: 'ASSET',
    familyId,
    versionId,
    versionSha256: versionSha256.toLowerCase(),
  });
}

export type StoryConfirmationTarget = {
  reviewSpec?: import("../../../host/instance-runtime/configuration-model.mjs").ReviewSpec;
  sceneId: string;
  subjectId: string;
  title: string;
  scriptPath: string;
  scriptSha256: string;
  scriptRef?: string;
  sceneContentHash: string;
  subjectRevisionHash?: string;
  businessContextHash: string;
  contextHash?: string;
  sourceBeatIds: string[];
  affectedDownstreamRefs: unknown;
  [key: string]: unknown;
};

export type AudioVerificationTarget = {
  issueId: string;
  subjectId: string;
  audioSha256: string;
  timecodeStart: string;
  timecodeEnd: string;
  transcriptText: string;
  currentText: string;
  currentTextHash: string;
  safeRendering: string;
  question: string;
  beatIds: string[];
  primaryReviewSceneId: string;
  affectedSceneIds: string[];
  sceneApprovalPolicy: string;
  businessContextHash: string;
  contextHash?: string;
  [key: string]: unknown;
};

export type SceneReviewDossierTarget = {
  dossierId: string;
  sceneId: string;
  subjectId: string;
  directBeatIds: string[];
  relatedBeatIds: string[];
  beatBindings: Array<Record<string, unknown>>;
  perspectiveCounts: Record<string, number>;
  asrIssueIds: string[];
  primaryAsrIssueIds: string[];
  hardBlockers: Array<Record<string, unknown>>;
  dossierHash: string;
  [key: string]: unknown;
};

export function sceneReviewDossierTargets(data: ReviewData): SceneReviewDossierTarget[] {
  const declared = data.actionQueueInputs?.sceneReviewDossiers;
  if (!Array.isArray(declared)) return [];
  return declared.map((item) => {
    const sceneId = String(item.sceneId || item.subjectId || '');
    return {
      ...item,
      dossierId: String(item.dossierId || `SCENE-REVIEW-DOSSIER:${sceneId}`),
      sceneId,
      subjectId: sceneId,
      directBeatIds: Array.isArray(item.directBeatIds) ? item.directBeatIds.map(String) : [],
      relatedBeatIds: Array.isArray(item.relatedBeatIds) ? item.relatedBeatIds.map(String) : [],
      beatBindings: Array.isArray(item.beatBindings) ? item.beatBindings as Array<Record<string, unknown>> : [],
      perspectiveCounts: item.perspectiveCounts && typeof item.perspectiveCounts === 'object' && !Array.isArray(item.perspectiveCounts)
        ? item.perspectiveCounts as Record<string, number>
        : {},
      asrIssueIds: Array.isArray(item.asrIssueIds) ? item.asrIssueIds.map(String) : [],
      primaryAsrIssueIds: Array.isArray(item.primaryAsrIssueIds) ? item.primaryAsrIssueIds.map(String) : [],
      hardBlockers: Array.isArray(item.hardBlockers) ? item.hardBlockers as Array<Record<string, unknown>> : [],
      dossierHash: String(item.dossierHash || '').toLowerCase(),
    };
  });
}

export function canonicalStorySceneIds(data: ReviewData): string[] {
  const lineage = data.creativeLineage?.scenes;
  const model = data.productionModel.scenes;
  const ids = (rows: Array<{ id?: unknown }> | undefined) => (rows || []).map((item) => typeof item.id === 'string' ? item.id : '');
  const canonicalSceneIds = ids(Array.isArray(lineage) ? lineage : model);
  const modelIds = ids(model);
  const malformed = (values: string[]) => values.some((value) => !value.trim()) || new Set(values).size !== values.length;
  const declaredCount = data.scope?.storyScenes;
  if (malformed(canonicalSceneIds) || malformed(modelIds)
    || (Array.isArray(lineage) && Array.isArray(model) && [...canonicalSceneIds].sort().join('|') !== [...modelIds].sort().join('|'))
    || (Number.isSafeInteger(declaredCount) && declaredCount !== canonicalSceneIds.length)) {
    throw new HttpError(500, 'STORY_CONFIRMATION_CANONICAL_SCENES_INCOMPLETE', {
      modelSceneIds: modelIds,
      declaredSceneCount: declaredCount ?? null,
      actualSceneIds: canonicalSceneIds,
    });
  }
  return canonicalSceneIds;
}

export function storyConfirmationTargets(data: ReviewData): StoryConfirmationTarget[] {
  const lineageScenes = data.creativeLineage?.scenes || data.productionModel.scenes || [];
  const expectedSceneIds = canonicalStorySceneIds(data);
  const declared = data.actionQueueInputs?.rewrittenSceneConfirmations || data.actionModel?.storyConfirmations;
  if (Array.isArray(declared) && declared.length) {
    const normalized = declared.map((item) => {
      const auditContext = item.auditContext && typeof item.auditContext === 'object' && !Array.isArray(item.auditContext)
        ? item.auditContext as Record<string, unknown>
        : {};
      const sourceBeatIds = item.sourceBeatIds || auditContext.mustBeatIds;
      const sceneId = String(item.sceneId || item.subjectId || '');
      const spec = sceneReviewDossierTargets(data).find(d=>d.sceneId===sceneId)?.reviewSpec as import("../../../host/instance-runtime/configuration-model.mjs").ReviewSpec | undefined;
      const baseContextHash = String(item.businessContextHash || item.basisHash || '').toLowerCase();
      const currentId = (data.productionModel as unknown as {revisionPointers?:{currentEpisodePlanRevisionId?:string}}).revisionPointers?.currentEpisodePlanRevisionId;
      const current = (data.productionModel.episodePlanRevisions || []).find(r=>r.id===currentId && r.isCurrent===true && r.scopeRole==='CURRENT' && r.revisionState==='CURRENT');
      const currentContent = current ? episodePlanContentFromRecord(current as unknown as EpisodePlanContent) : null;
      const owners = currentContent?.episodes.filter(ep=>ep.sceneIds.includes(sceneId)) || [];
      const contextHash = spec?.criteria.some(c=>c.id==='episode-inheritance')
        ? stableObjectHash({baseContextHash,episodePlanRevisionId:current?.id || null,episodePlanContentHash:currentContent ? stableObjectHash(currentContent):null,episodeUid:owners.length===1?owners[0].episodeUid:null,sceneId,sceneContentHash:item.sceneContentHash || item.sceneContentSha256,reviewSpecHash:spec.hash})
        : baseContextHash;
      return {
        ...item,
        reviewSpec: spec,
        sceneId,
        subjectId: sceneId,
        title: String(item.title || sceneId),
        scriptPath: String(item.scriptPath || item.screenplayPath || ''),
        scriptSha256: String(item.scriptSha256 || item.screenplaySha256 || '').toLowerCase(),
        sceneContentHash: String(item.sceneContentHash || item.sceneContentSha256 || '').toLowerCase(),
        subjectRevisionHash: typeof item.subjectRevisionHash === 'string' ? item.subjectRevisionHash.toLowerCase() : undefined,
        businessContextHash: contextHash,
        contextHash: typeof item.contextHash === 'string' ? item.contextHash.toLowerCase() : undefined,
        sourceBeatIds: Array.isArray(sourceBeatIds) ? sourceBeatIds.map(String) : [],
        affectedDownstreamRefs: item.affectedDownstreamRefs || item.impactScope || [],
      };
    });
    const declaredSceneIds = normalized.map((item) => item.sceneId).sort();
    if (declaredSceneIds.join('|') !== [...expectedSceneIds].sort().join('|')) {
      throw new HttpError(500, 'STORY_CONFIRMATION_TARGETS_INCOMPLETE', {
        expectedSceneIds,
        actualSceneIds: declaredSceneIds,
      });
    }
    return normalized;
  }
  const sceneAudits = new Map((data.adaptationAudit?.sceneAudits || []).map((item) => [String(item.scene_id || ''), item]));
  const scenes = new Map(lineageScenes.map((item) => [String(item.id || ''), item]));
  const scriptPath = String(data.creativeLineage?.scriptDocument?.sourcePath || '');
  const scriptSha256 = String(data.creativeLineage?.scriptDocument?.sha256 || '').toLowerCase();
  return expectedSceneIds.map((sceneId): StoryConfirmationTarget => {
    const scene = scenes.get(sceneId) || {};
    const audit = sceneAudits.get(sceneId) || {};
    const sceneContentHash = stableObjectHash({ sceneId, scriptSha256, scene });
    return {
      sceneId,
      subjectId: sceneId,
      title: String(scene.slugline || audit.title || sceneId),
      scriptPath,
      scriptSha256,
      scriptRef: String(audit.script_ref || ''),
      sceneContentHash,
      businessContextHash: stableObjectHash({
        subjectType: 'SCRIPT_SCENE',
        sceneId,
        sceneContentHash,
        auditResult: audit.audit_result || null,
        rewriteStatus: audit.rewrite_status || null,
        sourceBeatIds: audit.source_beat_ids || [],
      }),
      sourceBeatIds: Array.isArray(audit.source_beat_ids) ? audit.source_beat_ids.map(String) : [],
      affectedDownstreamRefs: [],
    };
  });
}

export function audioVerificationTargets(data: ReviewData): AudioVerificationTarget[] {
  const declared = data.actionQueueInputs?.audioVerifications || data.actionModel?.audioVerifications;
  if (Array.isArray(declared) && declared.length) {
    const transcriptSegments = data.storySources?.transcript?.segments || [];
    const transcriptById = new Map(transcriptSegments.map((segment) => [String(segment.id || ''), segment]));
    return declared.map((item) => {
      const timeRange = item.timeRange && typeof item.timeRange === 'object' && !Array.isArray(item.timeRange)
        ? item.timeRange as Record<string, unknown>
        : {};
      const auditContext = item.auditContext && typeof item.auditContext === 'object' && !Array.isArray(item.auditContext)
        ? item.auditContext as Record<string, unknown>
        : {};
      const issueId = String(item.issueId || item.subjectId || '');
      const beatIds = Array.isArray(item.beatIds) ? item.beatIds : item.beatId ? [item.beatId] : [];
      const normalizedBeatIds = beatIds.map(String);
      const transcriptSegmentsForIssue = normalizedBeatIds
        .map((beatId) => transcriptById.get(beatId))
        .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
      const transcriptText = String(
        item.transcriptText
        || item.currentText
        || transcriptSegmentsForIssue.map((segment) => String(segment.text || '')).filter(Boolean).join('\n'),
      );
      const safeRendering = String(item.safeRendering || auditContext.currentSafeRendering || '');
      const affectedSceneIdsSource = item.affectedSceneIds || auditContext.affectedSceneIds || auditContext.targetSceneIds;
      const affectedSceneIds = Array.isArray(affectedSceneIdsSource) ? affectedSceneIdsSource.map(String) : [];
      const primaryReviewSceneId = String(
        item.primaryReviewSceneId
        || auditContext.primaryReviewSceneId
        || affectedSceneIds[0]
        || '',
      );
      return {
        ...item,
        issueId,
        subjectId: issueId,
        audioSha256: String(item.audioSha256 || '').toLowerCase(),
        timecodeStart: String(item.timecodeStart || timeRange.start || ''),
        timecodeEnd: String(item.timecodeEnd || timeRange.end || ''),
        transcriptText,
        currentText: transcriptText,
        currentTextHash: String(item.currentTextHash || item.currentTextSha256 || '').toLowerCase(),
        safeRendering,
        question: String(item.question || auditContext.question || 'UNKNOWN'),
        beatIds: normalizedBeatIds,
        primaryReviewSceneId,
        affectedSceneIds,
        sceneApprovalPolicy: String(item.sceneApprovalPolicy || auditContext.sceneApprovalPolicy || ''),
        businessContextHash: String(item.businessContextHash || item.basisHash || '').toLowerCase(),
        contextHash: typeof item.contextHash === 'string' ? item.contextHash.toLowerCase() : undefined,
      };
    });
  }
  const audioSha256 = String(data.storySources?.audio?.sha256 || '').toLowerCase();
  const transcriptById = new Map((data.storySources?.transcript?.segments || []).map((segment) => [String(segment.id || ''), segment]));
  return (data.adaptationAudit?.asrIssues || [])
    .filter((item) => item.status === 'AUDIO_VERIFY_REQUIRED')
    .map((item): AudioVerificationTarget => {
      const issueId = String(item.issue_id || '');
      const timecode = String(item.timecode || '');
      const [timecodeStart = '', timecodeEnd = ''] = timecode.split('-', 2);
      const beatIds = Array.isArray(item.beat_ids) ? item.beat_ids.map(String) : [];
      const transcriptSegmentsForIssue = beatIds
        .map((beatId) => transcriptById.get(beatId))
        .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
      const transcriptText = transcriptSegmentsForIssue.map((segment) => String(segment.text || '')).filter(Boolean).join('\n');
      const currentTextHash = transcriptSegmentsForIssue.length === 1
        ? String(transcriptSegmentsForIssue[0].contentSha256 || '').toLowerCase()
        : createHash('sha256').update(transcriptText).digest('hex');
      const affectedSceneIds = Array.isArray(item.affected_scene_ids) ? item.affected_scene_ids.map(String) : [];
      const primaryReviewSceneId = String(item.primary_review_scene_id || affectedSceneIds[0] || '');
      return {
        issueId,
        subjectId: issueId,
        audioSha256,
        timecodeStart,
        timecodeEnd,
        transcriptText,
        currentText: transcriptText,
        currentTextHash,
        safeRendering: String(item.current_safe_rendering || ''),
        question: String(item.question || 'UNKNOWN'),
        beatIds,
        primaryReviewSceneId,
        affectedSceneIds,
        sceneApprovalPolicy: String(item.scene_approval_policy || ''),
        businessContextHash: stableObjectHash({
          subjectType: 'AUDIO_SOURCE',
          issueId,
          audioSha256,
          timecodeStart,
          timecodeEnd,
          currentTextHash,
        }),
      };
    });
}

export function mutationRequestHash(kind: EventKind, payload: Record<string, unknown>) {
  return createHash('sha256').update(canonicalJson({ kind, payload })).digest('hex');
}

async function eventFromPath(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as EventRecord;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.recordedAt !== 'string' || typeof parsed.eventId !== 'string') {
    throw new HttpError(500, 'event store contains an invalid event');
  }
  return parsed;
}

export async function listAllEvents(kind: EventKind) {
  if (hostedReadOnlyMode()) {
    hostedEventPromise ??= hostedAssetJson<{ snapshotId: string; events: Partial<Record<EventKind, EventRecord[]>> }>(
      '/runtime/hosted-material-events.generated.json',
      'hosted material event projection',
    );
    const bundle = await hostedEventPromise;
    const data = await reviewData();
    if (bundle.snapshotId !== data.snapshotId) throw new HttpError(503, 'hosted material events belong to another snapshot');
    return [...(bundle.events[kind] || [])].sort((a, b) => {
      const leftSequence = Number.isSafeInteger(a.eventSequence) && Number(a.eventSequence) > 0 ? Number(a.eventSequence) : null;
      const rightSequence = Number.isSafeInteger(b.eventSequence) && Number(b.eventSequence) > 0 ? Number(b.eventSequence) : null;
      if (leftSequence != null && rightSequence != null && leftSequence !== rightSequence) return rightSequence - leftSequence;
      if (leftSequence != null && rightSequence == null) return -1;
      if (leftSequence == null && rightSequence != null) return 1;
      const byTime = String(b.recordedAt).localeCompare(String(a.recordedAt));
      return byTime || String(b.eventId).localeCompare(String(a.eventId));
    });
  }
  if (instanceRepositoryMode()) return (await (await instanceRepository())!.listEvents(kind)) as EventRecord[];
  const root = eventStorePath();
  try {
    const names = (await readdir(root)).filter((name) => name.startsWith(`${kind}-`) && name.endsWith('.json'));
    const events = await Promise.all(names.map((name) => eventFromPath(path.join(root, name))));
    return events.sort((a, b) => {
      const leftSequence = Number.isSafeInteger(a.eventSequence) && Number(a.eventSequence) > 0 ? Number(a.eventSequence) : null;
      const rightSequence = Number.isSafeInteger(b.eventSequence) && Number(b.eventSequence) > 0 ? Number(b.eventSequence) : null;
      if (leftSequence != null && rightSequence != null && leftSequence !== rightSequence) return rightSequence - leftSequence;
      if (leftSequence != null && rightSequence == null) return -1;
      if (leftSequence == null && rightSequence != null) return 1;
      const byTime = String(b.recordedAt).localeCompare(String(a.recordedAt));
      return byTime || String(b.eventId).localeCompare(String(a.eventId));
    });
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw reason;
  }
}

export function eventLimit(raw: string | null, fallback = 100) {
  const parsed = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, 'limit must be a positive integer');
  return Math.min(parsed, 5000);
}

export async function listEvents(kind: EventKind, limit = 100) {
  return (await listAllEvents(kind)).slice(0, Math.max(1, Math.min(limit, 5000)));
}

function latestBy(events: EventRecord[], key: (event: EventRecord) => string) {
  const result = new Map<string, EventRecord>();
  for (const event of events) {
    const value = key(event);
    if (value && !result.has(value)) result.set(value, event);
  }
  return [...result.entries()].map(([aggregateId, event]) => ({ aggregateId, event }));
}

export type ScriptCommentProjection = {
  target?: import("../../story-comment-model").StoryCommentTarget;
  commentId: string;
  sceneId: string;
  creationSnapshotId: string;
  sceneContentHash: string;
  businessContextHash: string;
  anchor: Record<string, unknown>;
  commentText: string;
  commentRevisionId: string;
  commentTextHash: string;
  editCount: number;
  lastEditedAt: string | null;
  status: 'OPEN' | 'AI_QUEUED' | 'AI_PROCESSING' | 'RESOLVED';
  assignee: 'USER' | 'AI';
  createdAt: string;
  updatedAt: string;
  createdEventId: string;
  latestEventId: string;
  resolvedBy: 'USER' | 'AI' | null;
  resolutionNote: string;
  alignedSnapshotId: string | null;
  alignedSceneContentHash: string | null;
  eventCount: number;
  archived?: boolean;
  resolutionTarget?: Record<string, unknown>;
};

export function scriptCommentTextHash(commentText: string) {
  return createHash('sha256').update(commentText).digest('hex');
}

export function visibleScriptCommentEvents(events: EventRecord[]) {
  const deleted = new Set(events.filter((event) => event.commentAction === 'RESOLVE_AND_DELETE' && event.visibility === 'DELETED_AUDIT').map((event) => String(event.commentId)));
  return events.filter((event) => !deleted.has(String(event.commentId)));
}

export function projectScriptCommentEvents(events: EventRecord[], { includeRetired = false } = {}) {
  const byId = new Map<string, ScriptCommentProjection>();
  for (const event of [...(includeRetired ? events : visibleScriptCommentEvents(events))].reverse()) {
    const commentId = String(event.commentId || '');
    const action = String(event.commentAction || '');
    if (!commentId || !action) continue;
    if (action === 'CREATE') {
      if (byId.has(commentId)) continue;
      const initialStatus = event.initialStatus === 'AI_QUEUED' ? 'AI_QUEUED' : 'OPEN';
      const commentText = String(event.commentText || '');
      byId.set(commentId, {
        commentId,
        sceneId: String(event.sceneId || ''),
        ...(event.schemaVersion === '1.2' && event.target ? {target:event.target as import('../../story-comment-model').StoryCommentTarget} : {}),
        creationSnapshotId: String(event.creationSnapshotId || event.snapshotId || ''),
        sceneContentHash: String(event.sceneContentHash || ''),
        businessContextHash: String(event.businessContextHash || ''),
        anchor: event.anchor && typeof event.anchor === 'object' && !Array.isArray(event.anchor)
          ? event.anchor as Record<string, unknown>
          : {},
        commentText,
        commentRevisionId: String(event.eventId || ''),
        commentTextHash: scriptCommentTextHash(commentText),
        editCount: 0,
        lastEditedAt: null,
        status: initialStatus,
        assignee: initialStatus === 'AI_QUEUED' ? 'AI' : 'USER',
        createdAt: String(event.recordedAt || ''),
        updatedAt: String(event.recordedAt || ''),
        createdEventId: String(event.eventId || ''),
        latestEventId: String(event.eventId || ''),
        resolvedBy: null,
        resolutionNote: '',
        alignedSnapshotId: null,
        alignedSceneContentHash: null,
        eventCount: 1,
      });
      continue;
    }
    const current = byId.get(commentId);
    if (!current) continue;
    if (current.archived) continue;
    const eventCommentRevisionId = String(event.commentRevisionId || '');
    const archiveAction = action === 'RESOLVE_AND_DELETE' || action === 'RESOLVE_WITH_HISTORY';
    if (archiveAction && (
      (action === 'RESOLVE_AND_DELETE' && (!includeRetired || event.visibility !== 'DELETED_AUDIT'))
      || (action === 'RESOLVE_WITH_HISTORY' && event.visibility !== 'CLOSED_HISTORY')
      || event.resolutionStatus !== 'RESOLVED'
      || eventCommentRevisionId !== current.commentRevisionId
      || event.expectedLatestEventId !== current.latestEventId
    )) continue;
    if (action === 'EDIT') {
      if (
        !['1.1','1.2'].includes(String(event.schemaVersion))
        || typeof event.commentText !== 'string'
        || !event.commentText.trim()
        || current.status === 'RESOLVED'
        || eventCommentRevisionId !== current.commentRevisionId
      ) continue;
    }
    if (action === 'AI_START' || action === 'RESOLVE_AI') {
      if (
        ((['1.1','1.2'].includes(String(event.schemaVersion)) || current.editCount > 0) && !eventCommentRevisionId)
        || (eventCommentRevisionId && eventCommentRevisionId !== current.commentRevisionId)
      ) continue;
    }
    current.updatedAt = String(event.recordedAt || current.updatedAt);
    current.latestEventId = String(event.eventId || current.latestEventId);
    current.eventCount += 1;
    if (action === 'EDIT') {
      current.commentText = String(event.commentText);
      current.commentRevisionId = String(event.eventId || current.commentRevisionId);
      current.commentTextHash = scriptCommentTextHash(current.commentText);
      current.editCount += 1;
      current.lastEditedAt = String(event.recordedAt || current.updatedAt);
      current.status = 'AI_QUEUED';
      current.assignee = 'AI';
      current.resolvedBy = null;
      current.resolutionNote = '';
      current.alignedSnapshotId = null;
      current.alignedSceneContentHash = null;
    } else if (action === 'ASSIGN_AI') {
      current.status = 'AI_QUEUED';
      current.assignee = 'AI';
      current.resolvedBy = null;
      current.resolutionNote = '';
    } else if (action === 'AI_START') {
      current.status = 'AI_PROCESSING';
      current.assignee = 'AI';
    } else if (archiveAction) {
      current.status = 'RESOLVED';
      current.archived = true;
      current.resolvedBy = null;
      current.resolutionNote = String(event.resolutionNote || '');
      current.alignedSnapshotId = String(event.snapshotId || '') || null;
      current.alignedSceneContentHash = null;
      if (event.resolutionTarget && typeof event.resolutionTarget === 'object' && !Array.isArray(event.resolutionTarget)) current.resolutionTarget = event.resolutionTarget as Record<string, unknown>;
    } else if (action === 'RESOLVE_USER' || action === 'RESOLVE_AI') {
      current.status = 'RESOLVED';
      current.assignee = action === 'RESOLVE_AI' ? 'AI' : 'USER';
      current.resolvedBy = action === 'RESOLVE_AI' ? 'AI' : 'USER';
      current.resolutionNote = String(event.resolutionNote || '');
      current.alignedSnapshotId = String(event.alignedSnapshotId || event.snapshotId || '') || null;
      current.alignedSceneContentHash = String(event.alignedSceneContentHash || '') || null;
    } else if (action === 'REOPEN') {
      current.status = 'OPEN';
      current.assignee = 'USER';
      current.resolvedBy = null;
      current.resolutionNote = '';
      current.alignedSnapshotId = null;
      current.alignedSceneContentHash = null;
    }
  }
  return [...byId.values()].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || right.commentId.localeCompare(left.commentId)
  ));
}

/** A read-only archive. Never feed these historical rows back to the action queue. */
export function closedScriptCommentHistory(events: EventRecord[]) {
  return projectScriptCommentEvents(events, { includeRetired: true }).filter(thread => thread.status === 'RESOLVED').map(thread => ({
    commentId: thread.commentId, commentRevisionId: thread.commentRevisionId, latestEventId: thread.latestEventId,
    commentText: thread.commentText, quote: String(thread.anchor.quote || ''), createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    resolutionNote: thread.resolutionNote, resolvedBy: thread.resolvedBy, archived: Boolean(thread.archived),
    originalTarget: {kind: thread.target?.kind || 'SCENE_SCRIPT', subjectId: thread.target?.subjectId || thread.sceneId,
      label: thread.target?.label || `历史场 ${thread.sceneId || '未知'}`, revisionId: thread.target?.revisionId || null,
      snapshotId: thread.creationSnapshotId, contentHash: thread.sceneContentHash},
    resolutionTarget: thread.resolutionTarget || null, readOnly: true as const,
  }));
}

export type ProjectedExecutionRequest = EventRecord & { registeredOutputs: number };

export function projectedExecutionRequests(
  requestEvents: EventRecord[],
  candidates: EventRecord[],
): ProjectedExecutionRequest[] {
  const latest = latestBy(requestEvents, (event) => String(event.executionRequestId || ''))
    .map(({ event }) => event);
  const candidateVersionsByRequest = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const requestId = String(candidate.executionRequestId || '');
    const versionId = String(candidate.versionId || candidate.eventId || '');
    if (!requestId || !versionId) continue;
    const versions = candidateVersionsByRequest.get(requestId) || new Set<string>();
    versions.add(versionId);
    candidateVersionsByRequest.set(requestId, versions);
  }
  return latest.map((event): ProjectedExecutionRequest => {
    const requestId = String(event.executionRequestId || '');
    const registeredOutputs = candidateVersionsByRequest.get(requestId)?.size || 0;
    const declaredMaxOutputs = Number(event.maxOutputs);
    const maxOutputs = Number.isInteger(declaredMaxOutputs) && declaredMaxOutputs > 0 ? declaredMaxOutputs : 1;
    if (registeredOutputs < maxOutputs) return { ...event, registeredOutputs } as ProjectedExecutionRequest;
    return {
      ...event,
      requestState: 'FULFILLED',
      status: 'FULFILLED',
      registeredOutputs,
      fulfillmentSource: 'ASSET_VERSION_EVENT_PROJECTION',
    } as ProjectedExecutionRequest;
  });
}

function reviewSubjectBinding(event: EventRecord) {
  const subjectType = typeof event.subjectType === 'string' && event.subjectType
    ? event.subjectType
    : event.workItemId
      ? 'WORK_PRODUCT'
      : '';
  const subjectId = typeof event.subjectId === 'string' && event.subjectId
    ? event.subjectId
    : typeof event.workItemId === 'string'
      ? event.workItemId
      : '';
  const subjectRevisionHash = typeof event.subjectRevisionHash === 'string' && event.subjectRevisionHash
    ? event.subjectRevisionHash
    : typeof event.versionSha256 === 'string'
      ? event.versionSha256
      : '';
  const contextHash = typeof event.contextHash === 'string' ? event.contextHash : '';
  return { subjectType, subjectId, subjectRevisionHash, contextHash };
}

type StatusProjection = {
  outputState?: string | null;
  reviewDecision?: string | null;
  projectRightsGate?: string | null;
  historyRole?: string | null;
  applicabilityState?: string | null;
  upstreamReadiness?: string | null;
  executionGate?: string | null;
  latestRun?: { state?: string | null; [key: string]: unknown } | null;
  preflight?: { status?: string | null; role?: string | null; sourceRef?: string | null; [key: string]: unknown } | null;
  rightsWarning?: boolean | null;
  sourceSyncRequired?: boolean | null;
  sourceSyncState?: string | null;
  lifecycleState?: string | null;
  canFlowDownstream?: boolean | null;
  flowBlockReasons?: string[];
  reviewActionability?: 'ACTIONABLE' | 'WAITING_DEPENDENCY' | 'BLOCKED' | 'NOT_APPLICABLE';
  reviewBlockers?: Array<{ familyId: string; workItemId?: string | null; requiredVersionId?: string | null; reasonCode: string }>;
  reviewDependencyDepth?: number;
  reviewFrontier?: boolean;
};

type ProjectedVersion = AssetVersion & StatusProjection & {
  label?: string;
  mediaToken?: string | null;
  source?: 'BASE_SNAPSHOT' | 'ASSET_VERSION_EVENT';
  realizes?: {
    relationType: 'REALIZES';
    expectedOutputId: string;
  } | null;
};

export type ReviewCorrectionLockReason = {
  code:
    | 'NEWER_ASSET_VERSION_REGISTERED'
    | 'LATER_VERSION_ADOPTED'
    | 'DOWNSTREAM_ASSET_VERSION_BOUND'
    | 'DOWNSTREAM_WORK_ITEM_INPUT_LOCKED'
    | 'DOWNSTREAM_EXECUTION_REQUEST_ACTIVE'
    | 'DOWNSTREAM_RUN_RECORDED'
    | 'CURRENT_SHOT_PLAN_MATERIAL_LOCK'
    | 'SOURCE_OPERATION_REGISTERED'
    | 'TARGET_ASSET_VERSION_ALREADY_ADVANCED'
    | 'DOWNSTREAM_BINDING_UNVERIFIED'
    | 'REVIEW_SUPERSESSION_CHAIN_UNVERIFIED';
  evidenceType: 'ASSET_VERSION' | 'REVIEW_EVENT' | 'WORK_ITEM' | 'EXECUTION_REQUEST' | 'RUN' | 'SHOT_PLAN_SET' | 'SOURCE_OPERATION';
  evidenceId: string;
  recordedAt: string | null;
  message: string;
};

export type ReviewCorrectionProjection = {
  mode: 'APPEND_ONLY_SUPERSESSION';
  state: 'OPEN' | 'LOCKED' | 'UNKNOWN';
  headEventId: string;
  headAction: string;
  lockReasons: ReviewCorrectionLockReason[];
};

type ReviewRollup = {
  stage: string;
  required: number;
  released: number;
  lifecycleState: 'RELEASED' | 'REVIEW_PENDING' | 'WAITING_UPSTREAM';
  source: 'APPLIED_REVIEW_EVENT_PROJECTION';
  targetWorkItemIds: string[];
};

function statusSlice(record: StatusProjection) {
  return {
    outputState: record.outputState || null,
    reviewDecision: record.reviewDecision || null,
    projectRightsGate: record.projectRightsGate || null,
    historyRole: record.historyRole || null,
    upstreamReadiness: record.upstreamReadiness || null,
    executionGate: record.executionGate || null,
    latestRun: record.latestRun || null,
    preflight: record.preflight || null,
    rightsWarning: record.rightsWarning === true,
    sourceSyncRequired: record.sourceSyncRequired === true,
    sourceSyncState: record.sourceSyncState || 'NOT_REQUIRED',
    lifecycleState: record.lifecycleState || 'UNKNOWN',
    canFlowDownstream: Boolean(record.canFlowDownstream),
    flowBlockReasons: record.flowBlockReasons || [],
    reviewActionability: record.reviewActionability || 'NOT_APPLICABLE',
    reviewBlockers: record.reviewBlockers || [],
    reviewDependencyDepth: record.reviewDependencyDepth || 0,
    reviewFrontier: record.reviewFrontier === true,
  };
}

function aggregateLifecycle(records: StatusProjection[]) {
  if (!records.length) return { lifecycleState: 'NOT_APPLICABLE', canFlowDownstream: true, flowBlockReasons: [] as string[] };
  const states = records.map((record) => record.lifecycleState || 'UNKNOWN');
  const first = (values: string[]) => values.find((value) => states.includes(value));
  const lifecycleState = first([
    'DO_NOT_USE', 'RIGHTS_HOLD', 'BLOCKED', 'EXECUTION_FAILED', 'RESULT_UNKNOWN',
    'REVISION_REQUIRED', 'REVIEW_PENDING', 'IN_PROGRESS', 'RESULT_PENDING_REGISTRATION',
    'WAITING_UPSTREAM', 'READY_TO_START', 'UNKNOWN',
  ]) || (states.every((value) => value === 'NOT_APPLICABLE')
    ? 'NOT_APPLICABLE'
    : states.every((value) => ['SATISFIED_BY_EXISTING', 'NOT_APPLICABLE'].includes(value))
      ? 'SATISFIED_BY_EXISTING'
      : states.every((value) => ['RELEASED', 'SATISFIED_BY_EXISTING', 'NOT_APPLICABLE'].includes(value))
        ? 'RELEASED'
        : 'UNKNOWN');
  const canFlowDownstream = records.every((record) => record.canFlowDownstream || ['NOT_APPLICABLE', 'SATISFIED_BY_EXISTING'].includes(record.lifecycleState || ''));
  const flowBlockReasons = [...new Set(records.flatMap((record) => record.flowBlockReasons || []))];
  return { lifecycleState, canFlowDownstream, flowBlockReasons };
}

function versionLifecycle(version: ProjectedVersion) {
  return deriveLifecycleState(version as StatusRecord);
}

function versionIsMaterialized(version: ProjectedVersion | undefined | null) {
  if (!version?.path || !version.sha256 || !/^[a-f0-9]{64}$/i.test(version.sha256)) return false;
  if (version.outputState) return version.outputState === 'PRESENT';
  return version.materializationState === 'GENERATED' || version.legacyState?.materializationState === 'GENERATED';
}

function versionCanProjectAsCurrentDecision(version: ProjectedVersion | undefined | null) {
  if (!versionIsMaterialized(version)) return false;
  const roles = [version?.historyRole, version?.outputState, version?.lifecycleState].map((value) => String(value || ''));
  return !roles.some((value) => ['EVIDENCE_ONLY', 'DO_NOT_USE', 'DELETED_AUDIT'].includes(value));
}

function appliedReviewEvents(events: EventRecord[]) {
  return events
    .filter((event) => ['2.0', '2.1', '2.2'].includes(String(event.schemaVersion)) && event.effect === 'APPLIED' && event.applicationStatus === 'APPLIED')
    .filter((event) => {
      const action = String(event.action || '');
      const reviewDecision = String(event.reviewDecision || '');
      const lifecycleState = String(event.lifecycleState || '');
      if (event.subjectType === 'SCRIPT_SCENE') {
        if (action === 'APPROVE_AND_RELEASE') {
          return reviewDecision === 'RELEASED'
            && lifecycleState === 'RELEASED'
            && event.canFlowDownstream === true
            && event.adoptionIntent === 'ADOPT_THIS_SCENE'
            && event.internalDownstreamEligibility === 'ELIGIBLE';
        }
        if (action === 'REQUEST_REVISION') {
          return reviewDecision === 'REVISION_REQUIRED'
            && lifecycleState === 'REVISION_REQUIRED'
            && event.canFlowDownstream === false
            && event.adoptionIntent === 'DO_NOT_ADOPT'
            && event.internalDownstreamEligibility === 'INELIGIBLE';
        }
        return action === 'DO_NOT_USE'
          && reviewDecision === 'DO_NOT_USE'
          && lifecycleState === 'DO_NOT_USE'
          && event.canFlowDownstream === false
          && event.adoptionIntent === 'DO_NOT_ADOPT'
          && event.internalDownstreamEligibility === 'INELIGIBLE';
      }
      if (event.subjectType === 'STRUCTURE' || event.subjectType === 'CREATIVE_REVISION') {
        if (action === 'APPROVE_AND_RELEASE') {
          const immediateEligibility = event.canFlowDownstream === true
            && event.internalDownstreamEligibility === 'ELIGIBLE';
          const pendingSourceSync = event.canFlowDownstream === false
            && event.internalDownstreamEligibility === 'INELIGIBLE_PENDING_SOURCE_SYNC'
            && event.sourceSyncRequired === true
            && event.sourceSyncState === 'PENDING';
          return reviewDecision === 'RELEASED'
            && lifecycleState === 'RELEASED'
            && event.adoptionIntent === 'ADOPT_THIS_REVISION'
            && (immediateEligibility || pendingSourceSync);
        }
        if (action === 'REQUEST_REVISION') {
          return reviewDecision === 'REVISION_REQUIRED'
            && lifecycleState === 'REVISION_REQUIRED'
            && event.canFlowDownstream === false
            && event.adoptionIntent === 'DO_NOT_ADOPT'
            && event.internalDownstreamEligibility === 'INELIGIBLE';
        }
        return action === 'DO_NOT_USE'
          && reviewDecision === 'DO_NOT_USE'
          && lifecycleState === 'DO_NOT_USE'
          && event.canFlowDownstream === false
          && event.adoptionIntent === 'DO_NOT_ADOPT'
          && event.internalDownstreamEligibility === 'INELIGIBLE';
      }
      const projectRightsGateAtReview = String(event.projectRightsGateAtReview || '');
      const appliedProjectRightsGate = String(event.appliedProjectRightsGate || '');
      if (!['CLEAR', 'CLEAR_BY_USER_ATTESTATION', 'UNKNOWN', 'BLOCKED', 'NOT_APPLICABLE'].includes(projectRightsGateAtReview)) return false;
      if (!['CLEAR', 'CLEAR_BY_USER_ATTESTATION', 'UNKNOWN', 'BLOCKED', 'NOT_APPLICABLE'].includes(appliedProjectRightsGate)) return false;
      if (action === 'APPROVE_AND_RELEASE') {
        const confirmation = event.rightsUnknownConfirmation as Record<string, unknown> | null | undefined;
        const rightsTransitionIsValid = projectRightsGateAtReview === 'UNKNOWN'
          ? appliedProjectRightsGate === 'CLEAR_BY_USER_ATTESTATION'
            && confirmation?.confirmed === true
            && confirmation?.scope === 'PROJECT_INTERNAL_ONLY'
            && typeof confirmation?.basis === 'string'
            && Boolean(confirmation.basis.trim())
          : appliedProjectRightsGate === projectRightsGateAtReview && confirmation == null;
        const immediateEligibility = event.canFlowDownstream === true
          && event.internalDownstreamEligibility === 'ELIGIBLE';
        const pendingPromptSync = event.canFlowDownstream === false
          && event.internalDownstreamEligibility === 'INELIGIBLE_PENDING_PROMPT_SYNC'
          && event.sourceSyncRequired === true
          && event.sourceSyncState === 'PENDING';
        return reviewDecision === 'RELEASED'
          && lifecycleState === 'RELEASED'
          && event.adoptionIntent === 'ADOPT_THIS_VERSION'
          && (immediateEligibility || pendingPromptSync)
          && projectRightsGateAtReview !== 'BLOCKED'
          && ['CLEAR', 'CLEAR_BY_USER_ATTESTATION', 'NOT_APPLICABLE'].includes(appliedProjectRightsGate)
          && rightsTransitionIsValid;
      }
      if (action === 'REQUEST_REVISION') {
        return reviewDecision === 'REVISION_REQUIRED'
          && lifecycleState === 'REVISION_REQUIRED'
          && event.canFlowDownstream === false
          && event.adoptionIntent === 'DO_NOT_ADOPT'
          && event.internalDownstreamEligibility === 'INELIGIBLE'
          && appliedProjectRightsGate === projectRightsGateAtReview;
      }
      return action === 'DO_NOT_USE'
        && reviewDecision === 'DO_NOT_USE'
        && lifecycleState === 'DO_NOT_USE'
        && event.canFlowDownstream === false
        && event.adoptionIntent === 'DO_NOT_ADOPT'
        && event.internalDownstreamEligibility === 'INELIGIBLE'
        && appliedProjectRightsGate === projectRightsGateAtReview;
    })
    .sort((left, right) => {
      const leftSequence = Number.isSafeInteger(left.eventSequence) && Number(left.eventSequence) > 0
        ? Number(left.eventSequence)
        : null;
      const rightSequence = Number.isSafeInteger(right.eventSequence) && Number(right.eventSequence) > 0
        ? Number(right.eventSequence)
        : null;
      if (leftSequence != null && rightSequence != null && leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      if (leftSequence != null && rightSequence == null) return 1;
      if (leftSequence == null && rightSequence != null) return -1;
      const byTime = String(left.recordedAt).localeCompare(String(right.recordedAt));
      return byTime || String(left.eventId).localeCompare(String(right.eventId));
    });
}

/** Database compilation has its own atomic publication receipt. Its proof must
 * be anchored in the verified published snapshot, never just an event claim. */
export function assertGenericDatabaseSyncBinding(data: ReviewData, event: EventRecord, review: EventRecord) {
  const protocol = 'GENERIC_DATABASE_COMPILER_V1';
  const anchor = data.productionModel.genericSyncProof;
  const proof = event.transactionProof as Record<string, unknown> | undefined;
  const revision = data.productionModel.episodePlanRevisions?.find(row => row.id === event.creativeRevisionId);
  const fail = () => { throw new HttpError(409, 'Generic database adoption does not match the current published source and review'); };
  if (!anchor || !proof || !revision || event.protocol !== protocol || anchor.protocol !== protocol || proof.protocol !== protocol
      || review.subjectType !== 'CREATIVE_REVISION' || review.subjectKind !== 'EPISODE_PLAN'
      || review.action !== 'APPROVE_AND_RELEASE' || review.applicationStatus !== 'APPLIED' || review.effect !== 'APPLIED'
      || event.applicationStatus !== 'APPLIED' || event.effect !== 'APPLIED') return fail();
  const fields = ['protocol','sourceOperationId','creativeRevisionId','subjectRevisionHash','basisBindingsHash','reviewEventId','sourceRevisionId','sourceSha256','rootRevisionIds'] as const;
  const payload = Object.fromEntries(fields.map(key => [key, proof[key]]));
  if (fields.some(key => stableObjectHash(proof[key] ?? null) !== stableObjectHash(anchor[key] ?? null))
      || stableObjectHash(payload) !== proof.proofHash || proof.proofHash !== anchor.proofHash
      || !/^[a-f0-9]{64}$/.test(String(proof.snapshotSha256 || ''))
      || !Array.isArray(proof.rootRevisionIds) || !proof.rootRevisionIds.length
      || !String(event.resultReleaseId || '').startsWith('release_')) return fail();
  for (const key of ['sourceOperationId','creativeRevisionId','subjectRevisionHash','basisBindingsHash','reviewEventId']) {
    if (proof[key] !== event[key]) return fail();
  }
  const sourcePath = `story/adopted/${String(event.creativeRevisionId)}.json`;
  const sync = revision.sync as Record<string, unknown> | undefined;
  const newBlockHashes = event.newBlockHashes as Record<string, unknown> | undefined;
  if (revision.authoringEntry !== 'GENERIC_AUTHORING_DRAFT' || revision.scopeRole !== 'CURRENT'
      || revision.revisionState !== 'CURRENT' || revision.isCurrent !== true
      || data.productionModel.episodePlanRevisions?.filter(row => row.scopeRole === 'CURRENT').length !== 1
      || revision.sourceRevisionId !== proof.sourceRevisionId || revision.sourceSha256 !== proof.sourceSha256
      || revision.sourcePath !== sourcePath || newBlockHashes?.[sourcePath] !== proof.sourceSha256
      || stableObjectHash(event.sourcePaths) !== stableObjectHash([sourcePath])
      || stableObjectHash(revision.content) !== event.subjectRevisionHash
      || revision.contentHash !== event.subjectRevisionHash || revision.basisBindingsHash !== event.basisBindingsHash
      || sync?.protocol !== protocol || sync.sourceOperationId !== event.sourceOperationId || sync.proofHash !== proof.proofHash
      || anchor.reviewEventId !== review.eventId || revision.scopeId !== review.scopeId) return fail();
}

export function sourceSyncSucceeded(
  data: ReviewData,
  sourceOperations: EventRecord[],
  review: EventRecord,
  mediaStateProjection: CreativeBasisStateProjection = {},
) {
  if (review.sourceSyncRequired !== true) return true;
  const expectedType = ['STRUCTURE', 'CREATIVE_REVISION'].includes(String(review.subjectType || ''))
    ? 'CREATIVE_REVISION_SYNC'
    : 'PROMPT_SYNC';
  const newestById = latestBy(sourceOperations, (event) => String(event.sourceOperationId || '')).map(({ event }) => event);
  return newestById.some((event) => {
    if (event.operationType !== expectedType || (event.operationState || event.state) !== 'SUCCEEDED') return false;
    const genericSync = event.protocol === 'GENERIC_DATABASE_COMPILER_V1';
    const scopedSceneSync = event.protocol === SCENE_SYNC_PROTOCOL;
    try {
      if (scopedSceneSync) assertScopedSceneSyncBinding(data, event, review);
      else if (genericSync) assertGenericDatabaseSyncBinding(data, event, review);
      else assertSourceOperationSucceededEvidence(event, data.snapshotId);
    } catch {
      return false;
    }
    const impact = event.impact && typeof event.impact === 'object' && !Array.isArray(event.impact)
      ? event.impact as Record<string, unknown>
      : {};
    if (event.reviewEventId !== review.eventId || impact.reviewEventId !== review.eventId) return false;
    if (review.subjectType === 'STRUCTURE' || review.subjectType === 'CREATIVE_REVISION') {
      const exactBinding = event.creativeRevisionId === (review.subjectRevisionId || review.creativeRevisionId)
        && impact.creativeRevisionId === event.creativeRevisionId
        && event.subjectRevisionHash === review.subjectRevisionHash
        && impact.subjectRevisionHash === event.subjectRevisionHash
        && event.subjectKind === review.subjectKind
        && impact.subjectKind === event.subjectKind
        && event.basisBindingsHash === review.basisBindingsHash
        && impact.basisBindingsHash === event.basisBindingsHash;
      if (!exactBinding) return false;
      try {
        if (!genericSync) assertDeployedCreativeRevisionBinding(data, event);
        const deployedRevisions = review.subjectKind === 'EPISODE_PLAN'
          ? data.productionModel.episodePlanRevisions
          : review.subjectKind === 'SCENE_COVERAGE'
            ? data.productionModel.sceneCoveragePlanRevisions
            : data.productionModel.shotPlanSetRevisions;
        const deployedRevision = deployedRevisions?.find((row) => row.id === event.creativeRevisionId);
        if (!deployedRevision) return false;
        assertCreativeRevisionBasisCurrent(data, mediaStateProjection, {
          ...review,
          content: deployedRevision.content,
          adoptedMaterialSet: deployedRevision.adoptedMaterialSet,
          materialRequirementSet: deployedRevision.materialRequirementSet,
          planningContractVersion: deployedRevision.planningContractVersion,
        }, { requireCurrentPredecessor: false });
        if (review.subjectKind === 'SHOT_PLAN_SET') {
          const adoptedMaterialSet = assertShotPlanMaterialBasisCurrent(
            data,
            mediaStateProjection,
            String(review.scopeId || ''),
            review.basisBindings,
          );
          assertDeployedShotPlanMaterialSet(
            data,
            String(review.subjectRevisionId || review.creativeRevisionId || ''),
            adoptedMaterialSet,
          );
        }
      } catch {
        return false;
      }
      return true;
    }
    const binding = review.sourceSyncBinding && typeof review.sourceSyncBinding === 'object' && !Array.isArray(review.sourceSyncBinding)
      ? review.sourceSyncBinding as Record<string, unknown>
      : {};
    return event.versionId === review.versionId
      && impact.versionId === event.versionId
      && event.actualPromptHash === binding.actualPromptHash
      && impact.actualPromptHash === event.actualPromptHash;
  });
}

export function assetReviewOwnership(data: ReviewData, familyId: string) {
  const materialOwnerWorkItemIds = (data.productionModel.materialWorkItems || [])
    .filter((item) => item.outputAssetRef === familyId)
    .map((item) => item.id);
  const productionOwnerWorkItemIds = data.productionModel.workItems
    .filter((item) => item.outputAssetRef === familyId || (item.additionalOutputAssetRefs || []).includes(familyId))
    .map((item) => item.id);
  return {
    reviewable: materialOwnerWorkItemIds.length === 1 && productionOwnerWorkItemIds.length === 0,
    materialOwnerWorkItemIds,
    productionOwnerWorkItemIds,
  };
}

function reviewBindsCurrentGraph(data: ReviewData, event: EventRecord) {
  const subjectType = String(event.subjectType || '');
  const subjectId = String(event.subjectId || '');
  const familyId = String(event.familyId || '');
  if (!subjectId) return false;
  if(data.productionModel.systemConfiguration&&['ASSET','SCRIPT_SCENE','WORK_PRODUCT'].includes(subjectType)){const standard=resolveFormalReviewSpec(data,subjectType,subjectId);if(standard&&(!standard.legacy||event.reviewSpecHash)&&event.reviewSpecHash!==standard.hash)return false;}
  if (subjectType === 'SCRIPT_SCENE') {
    const target = storyConfirmationTargets(data).find((item) => String(item.sceneId || item.subjectId || '') === subjectId);
    if (!target) return false;
    const targetRevisionHash = String(target.sceneContentHash || target.subjectRevisionHash || '').toLowerCase();
    const targetContextHash = String(target.businessContextHash || target.contextHash || '').toLowerCase();
    return Boolean(
      targetRevisionHash
      && targetContextHash
      && String(event.subjectRevisionHash || '').toLowerCase() === targetRevisionHash
      && String(event.businessContextHash || event.contextHash || '').toLowerCase() === targetContextHash
    );
  }
  if (!familyId) return false;
  if (subjectType === 'ASSET') {
    if (subjectId !== familyId) return false;
    if (!assetReviewOwnership(data, familyId).reviewable) return false;
    const versionId = String(event.versionId || '');
    const versionSha256 = String(event.versionSha256 || '').toLowerCase();
    const contextHash = String(event.contextHash || '');
    if (!versionId || !versionSha256 || !contextHash) return false;
    return contextHash === assetReviewContextHash(data, familyId, versionId, versionSha256)
      || contextHash === legacyAssetReviewContextHash(data, familyId, versionId, versionSha256);
  }
  if (subjectType !== 'WORK_PRODUCT') return false;
  const workItem = data.productionModel.workItems.find((item) => item.id === subjectId);
  if (!workItem || workItem.outputAssetRef !== familyId) return false;
  if (event.workItemId !== subjectId) return false;
  const workPackageId = String(event.workPackageId || '');
  const contextHash = String(event.contextHash || '');
  const binding = workProductReviewBinding(data, subjectId, workPackageId);
  if (!binding || !binding.reviewable) return false;
  const isCanonicalReview = event.schemaVersion === '2.2';
  const eventScopeType = String(isCanonicalReview ? event.scopeType || '' : event.reviewScopeType || (event.shotId ? 'SHOT' : ''));
  const eventScopeId = String(isCanonicalReview ? event.scopeId || '' : event.reviewScopeId || event.shotId || '');
  const eventContextRef = String(event.reviewContextRef || '');
  const workPackage = data.productionModel.workPackages.find((item) => item.id === workPackageId);
  const canonicalBindingMatches = !isCanonicalReview || Boolean(
    workPackage
    && event.productionPhaseId === workItem.phaseId
    && event.productionGateId === workItem.gateId
    && event.productionPhaseId === workPackage.phaseId
    && event.productionGateId === workPackage.gateId
    && eventScopeType === workItem.scopeType
    && eventScopeId === workItem.scopeId
    && eventScopeType === workPackage.scopeType
    && eventScopeId === workPackage.scopeId
  );
  return Boolean(
    contextHash
    && canonicalBindingMatches
    && binding.contextHash === contextHash
    && (!eventScopeType || eventScopeType === binding.reviewScopeType)
    && (!eventScopeId || eventScopeId === binding.reviewScopeId)
    && (!eventContextRef || eventContextRef === binding.reviewContextRef)
    && (isCanonicalReview || (binding.reviewScopeType === 'SHOT'
      ? String(event.shotId || '') === binding.shotId
      : !event.shotId))
  );
}

function normalizedCurrentProjectRightsGate(value: unknown) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const legacyState = record.legacyState && typeof record.legacyState === 'object' && !Array.isArray(record.legacyState)
    ? record.legacyState as Record<string, unknown>
    : {};
  const declared = typeof record.projectRightsGate === 'string' ? record.projectRightsGate : '';
  const legacy = typeof legacyState.rightsStatus === 'string' ? legacyState.rightsStatus : '';
  if (declared === 'BLOCKED' || legacy === 'BLOCKED' || legacy === 'DO_NOT_USE') return 'BLOCKED';
  if (['CLEAR', 'CLEAR_BY_USER_ATTESTATION', 'UNKNOWN', 'NOT_APPLICABLE'].includes(declared)) return declared;
  if (legacy === 'APPROVED' || legacy === 'CLEAR') return 'CLEAR';
  if (legacy === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
  return 'UNKNOWN';
}

function currentVersionRightsFacts(data: ReviewData, candidates: EventRecord[]) {
  const facts = new Map<string, string>();
  for (const version of data.productionModel.assetVersions) {
    if (version.id) facts.set(version.id, normalizedCurrentProjectRightsGate(version));
  }
  for (const event of [...candidates].reverse()) {
    const versionId = String(event.versionId || '');
    if (versionId) facts.set(versionId, normalizedCurrentProjectRightsGate(event));
  }
  return facts;
}

function bindingFamilyId(binding: NonNullable<AssetVersion['inputVersionBindings']>[number]) {
  return String(binding.assetFamilyRef || binding.familyId || '');
}

function bindingVersionId(binding: NonNullable<AssetVersion['inputVersionBindings']>[number]) {
  return String(binding.assetVersionRef || binding.versionId || '');
}

type P07ReviewBlocker = {
  familyId: string;
  workItemId?: string | null;
  requiredVersionId?: string | null;
  reasonCode: string;
};

function exactP07ParentBindingBlockers(
  item: WorkItem,
  outputVersion: ProjectedVersion | null | undefined,
  p07OwnerByFamily: Map<string, WorkItem>,
  families: Map<string, AssetFamily & StatusProjection>,
  versions: Map<string, ProjectedVersion>,
): P07ReviewBlocker[] {
  return (item.inputAssetRefs || []).flatMap((inputFamilyId) => {
    const upstreamItem = p07OwnerByFamily.get(inputFamilyId);
    if (!upstreamItem) return [];
    const upstreamFamily = families.get(inputFamilyId);
    const currentVersionId = upstreamFamily?.currentVersionId || upstreamFamily?.decisionVersionId || '';
    const currentVersion = currentVersionId ? versions.get(currentVersionId) : null;
    const exactBinding = outputVersion?.inputVersionBindings?.find(
      (binding) => bindingFamilyId(binding) === inputFamilyId,
    );
    if (
      !currentVersionId
      || !currentVersion?.sha256
      || !exactBinding
      || bindingVersionId(exactBinding) !== currentVersionId
      || String(exactBinding.sha256 || '').toLowerCase() !== currentVersion.sha256.toLowerCase()
    ) {
      return [{
        familyId: inputFamilyId,
        workItemId: upstreamItem.id,
        requiredVersionId: currentVersionId || null,
        reasonCode: 'UPSTREAM_VERSION_REBASE_REQUIRED',
      }];
    }
    return [];
  });
}

function versionBindings(data: ReviewData, candidates: EventRecord[]) {
  const result = new Map<string, { familyId: string; sha256: string }>();
  for (const version of data.productionModel.assetVersions) {
    if (version.id && version.familyId && version.sha256) {
      result.set(version.id, { familyId: version.familyId, sha256: version.sha256.toLowerCase() });
    }
  }
  for (const event of [...candidates].reverse()) {
    const versionId = String(event.versionId || '');
    const familyId = String(event.familyId || '');
    const sha256 = String(event.sha256 || '').toLowerCase();
    if (versionId && familyId && /^[a-f0-9]{64}$/.test(sha256)) result.set(versionId, { familyId, sha256 });
  }
  return result;
}

function currentMediaReviewLineage(data: ReviewData, reviews: EventRecord[], candidates: EventRecord[]) {
  const bindings = versionBindings(data, candidates);
  const rightsFacts = currentVersionRightsFacts(data, candidates);
  const identityBound = appliedReviewEvents(reviews)
    .filter((event) => event.subjectType === 'ASSET' || event.subjectType === 'WORK_PRODUCT')
    .filter((event) => {
      const binding = bindings.get(String(event.versionId || ''));
      return Boolean(
        binding
        && binding.familyId === event.familyId
        && binding.sha256 === String(event.versionSha256 || '').toLowerCase()
        && reviewBindsCurrentGraph(data, event)
      );
    });
  const latestByVersion = new Map<string, EventRecord>();
  for (const event of identityBound) latestByVersion.set(String(event.versionId || ''), event);
  const rightsDriftVersionIds = new Set(
    [...latestByVersion]
      .filter(([versionId, event]) => (
        rightsFacts.get(versionId) !== String(event.projectRightsGateAtReview || '')
      ))
      .map(([versionId]) => versionId),
  );
  return { bindings, rightsFacts, rightsDriftVersionIds };
}

function applicableReviewEvents(data: ReviewData, reviews: EventRecord[], candidates: EventRecord[]) {
  const { bindings, rightsFacts, rightsDriftVersionIds } = currentMediaReviewLineage(data, reviews, candidates);
  return appliedReviewEvents(reviews)
    .filter((event) => !['STRUCTURE', 'CREATIVE_REVISION'].includes(String(event.subjectType || '')))
    .filter((event) => {
    if (event.subjectType === 'SCRIPT_SCENE') return reviewBindsCurrentGraph(data, event);
    if (rightsDriftVersionIds.has(String(event.versionId || ''))) return false;
    const binding = bindings.get(String(event.versionId || ''));
    return Boolean(
      binding
      && binding.familyId === event.familyId
      && binding.sha256 === String(event.versionSha256 || '').toLowerCase()
      && rightsFacts.get(String(event.versionId || '')) === String(event.projectRightsGateAtReview || '')
      && reviewBindsCurrentGraph(data, event)
    );
  });
}

function compareEventOrder(left: EventRecord, right: EventRecord) {
  const leftSequence = Number.isSafeInteger(left.eventSequence) && Number(left.eventSequence) > 0
    ? Number(left.eventSequence)
    : null;
  const rightSequence = Number.isSafeInteger(right.eventSequence) && Number(right.eventSequence) > 0
    ? Number(right.eventSequence)
    : null;
  if (leftSequence != null && rightSequence != null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  if (leftSequence != null && rightSequence == null) return 1;
  if (leftSequence == null && rightSequence != null) return -1;
  const byTime = String(left.recordedAt || '').localeCompare(String(right.recordedAt || ''));
  return byTime || String(left.eventId || '').localeCompare(String(right.eventId || ''));
}

function eventOccursAfter(candidate: EventRecord, predecessor: EventRecord) {
  return compareEventOrder(candidate, predecessor) > 0;
}

function mediaReviewTargetKey(review: EventRecord) {
  const versionId = String(review.versionId || '');
  if (!versionId) return '';
  return review.subjectType === 'ASSET'
    ? ['ASSET', review.familyId, versionId, String(review.versionSha256 || '').toLowerCase()].join('::')
    : review.subjectType === 'WORK_PRODUCT'
      ? ['WORK_PRODUCT', review.workItemId, versionId, String(review.versionSha256 || '').toLowerCase(), review.contextHash].join('::')
      : '';
}

function latestApplicableMediaReviewProjection(applicableReviews: EventRecord[]) {
  const latestWorkProductByTarget = new Map<string, EventRecord>();
  const assetReviewsByTarget = new Map<string, EventRecord[]>();
  for (const review of [...applicableReviews].sort(compareEventOrder)) {
    const targetKey = mediaReviewTargetKey(review);
    if (!targetKey) continue;
    if (review.subjectType === 'WORK_PRODUCT') {
      latestWorkProductByTarget.set(targetKey, review);
      continue;
    }
    if (review.subjectType !== 'ASSET') continue;
    const targetReviews = assetReviewsByTarget.get(targetKey) || [];
    targetReviews.push(review);
    assetReviewsByTarget.set(targetKey, targetReviews);
  }

  const assetHeads: EventRecord[] = [];
  const assetChainIssuesByTarget = new Map<string, ReviewCorrectionLockReason[]>();
  for (const [targetKey, targetReviews] of assetReviewsByTarget) {
    let head: EventRecord | null = null;
    const issues: ReviewCorrectionLockReason[] = [];
    for (const review of targetReviews) {
      const role = String(review.reviewEventRole || '');
      const supersedes = String(review.supersedesReviewEventId || '');
      if (!head) {
        if ((role && role !== 'INITIAL_DECISION') || supersedes) {
          issues.push({
            code: 'REVIEW_SUPERSESSION_CHAIN_UNVERIFIED',
            evidenceType: 'REVIEW_EVENT',
            evidenceId: String(review.eventId || 'UNKNOWN'),
            recordedAt: typeof review.recordedAt === 'string' ? review.recordedAt : null,
            message: `首个审阅事件 ${String(review.eventId || 'UNKNOWN')} 的角色或前序指针无法验证`,
          });
          continue;
        }
        head = review;
        continue;
      }
      if (role === 'SUPERSEDING_CORRECTION' && supersedes === String(head.eventId || '')) {
        head = review;
        continue;
      }
      issues.push({
        code: 'REVIEW_SUPERSESSION_CHAIN_UNVERIFIED',
        evidenceType: 'REVIEW_EVENT',
        evidenceId: String(review.eventId || 'UNKNOWN'),
        recordedAt: typeof review.recordedAt === 'string' ? review.recordedAt : null,
        message: `审阅事件 ${String(review.eventId || 'UNKNOWN')} 未显式指向紧邻的当前裁决头 ${String(head.eventId || 'UNKNOWN')}`,
      });
    }
    if (head) assetHeads.push(head);
    if (issues.length) assetChainIssuesByTarget.set(targetKey, issues);
  }

  return {
    effectiveMediaReviews: [
      ...latestWorkProductByTarget.values(),
      ...assetHeads,
    ].sort(compareEventOrder),
    assetChainIssuesByTarget,
  };
}

type VersionBindingRelation = 'EXACT' | 'OTHER_VERSION' | 'UNVERIFIED_TARGET' | 'UNRELATED';

function versionBindingRelation(
  raw: unknown,
  target: { familyId: string; versionId: string; sha256: string },
  knownVersions: Map<string, { familyId: string; sha256: string }>,
) : VersionBindingRelation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'UNRELATED';
  const binding = raw as Record<string, unknown>;
  const familyAliases = [...new Set([binding.assetFamilyRef, binding.familyId].map((value) => String(value || '')).filter(Boolean))];
  const versionAliases = [...new Set([binding.assetVersionRef, binding.versionId].map((value) => String(value || '')).filter(Boolean))];
  const versionId = versionAliases[0] || '';
  const sha256 = String(binding.sha256 || '').toLowerCase();
  const mentionsTargetFamily = familyAliases.includes(target.familyId);
  const mentionsTargetVersion = versionAliases.includes(target.versionId);
  if (!mentionsTargetFamily && !mentionsTargetVersion) return 'UNRELATED';
  if (familyAliases.length > 1 || versionAliases.length > 1) return 'UNVERIFIED_TARGET';
  if (mentionsTargetFamily && versionId && versionId !== target.versionId) {
    const knownVersion = knownVersions.get(versionId);
    return /^[a-f0-9]{64}$/.test(sha256)
      && knownVersion?.familyId === target.familyId
      && knownVersion.sha256 === sha256
      ? 'OTHER_VERSION'
      : 'UNVERIFIED_TARGET';
  }
  if (mentionsTargetFamily && mentionsTargetVersion && sha256 === target.sha256) return 'EXACT';
  return 'UNVERIFIED_TARGET';
}

function exactVersionBinding(
  raw: unknown,
  target: { familyId: string; versionId: string; sha256: string },
  knownVersions: Map<string, { familyId: string; sha256: string }>,
) {
  return versionBindingRelation(raw, target, knownVersions) === 'EXACT';
}

function unverifiedTargetVersionBinding(
  raw: unknown,
  target: { familyId: string; versionId: string; sha256: string },
  knownVersions: Map<string, { familyId: string; sha256: string }>,
) {
  return versionBindingRelation(raw, target, knownVersions) === 'UNVERIFIED_TARGET';
}

function reviewCorrectionProjection(
  data: ReviewData,
  head: EventRecord,
  candidates: EventRecord[],
  effectiveMediaReviews: EventRecord[],
  executionRequests: EventRecord[],
  runs: EventRecord[],
  sourceOperations: EventRecord[],
  chainIssues: ReviewCorrectionLockReason[] = [],
): ReviewCorrectionProjection {
  const target = {
    familyId: String(head.familyId || ''),
    versionId: String(head.versionId || ''),
    sha256: String(head.versionSha256 || '').toLowerCase(),
  };
  const knownVersions = versionBindings(data, candidates);
  const reasons: ReviewCorrectionLockReason[] = [];
  const addReason = (reason: ReviewCorrectionLockReason) => {
    if (!reasons.some((item) => item.code === reason.code && item.evidenceId === reason.evidenceId)) reasons.push(reason);
  };
  for (const issue of chainIssues) addReason(issue);
  const addUnverifiedBinding = (
    evidenceType: ReviewCorrectionLockReason['evidenceType'],
    evidenceId: string,
    recordedAt: string | null,
  ) => addReason({
    code: 'DOWNSTREAM_BINDING_UNVERIFIED',
    evidenceType,
    evidenceId,
    recordedAt,
    message: `下游对象 ${evidenceId} 指向当前版本，但 familyId 或 SHA-256 缺失／冲突`,
  });

  for (const candidate of candidates) {
    const candidateVersionId = String(candidate.versionId || '');
    const candidateSha256 = String(candidate.sha256 || '').toLowerCase();
    if (!candidateVersionId || !/^[a-f0-9]{64}$/.test(candidateSha256)) continue;
    if (
      String(candidate.familyId || '') === target.familyId
      && candidateVersionId !== target.versionId
      && (
        eventOccursAfter(candidate, head)
        || (
          String(candidate.parentVersionId || '') === target.versionId
          && String(candidate.parentVersionSha256 || '').toLowerCase() === target.sha256
        )
      )
    ) {
      addReason({
        code: 'NEWER_ASSET_VERSION_REGISTERED',
        evidenceType: 'ASSET_VERSION',
        evidenceId: candidateVersionId,
        recordedAt: typeof candidate.recordedAt === 'string' ? candidate.recordedAt : null,
        message: `同一素材已经登记后续版本 ${candidateVersionId}`,
      });
    }
    if (
      candidateVersionId !== target.versionId
      && Array.isArray(candidate.inputBindings)
      && candidate.inputBindings.some((binding) => exactVersionBinding(binding, target, knownVersions))
    ) {
      addReason({
        code: 'DOWNSTREAM_ASSET_VERSION_BOUND',
        evidenceType: 'ASSET_VERSION',
        evidenceId: candidateVersionId,
        recordedAt: typeof candidate.recordedAt === 'string' ? candidate.recordedAt : null,
        message: `下游产物 ${candidateVersionId} 已精确绑定当前版本与 SHA-256`,
      });
    } else if (
      candidateVersionId !== target.versionId
      && Array.isArray(candidate.inputBindings)
      && candidate.inputBindings.some((binding) => unverifiedTargetVersionBinding(binding, target, knownVersions))
    ) {
      addUnverifiedBinding('ASSET_VERSION', candidateVersionId, typeof candidate.recordedAt === 'string' ? candidate.recordedAt : null);
    }
  }

  const staticFamily = data.productionModel.assetFamilies.find((family) => family.id === target.familyId);
  const staticVersionRefs = staticFamily?.versionRefs || [];
  const staticTargetIndex = staticVersionRefs.indexOf(target.versionId);
  if (staticTargetIndex >= 0) {
    for (const laterVersionId of staticVersionRefs.slice(staticTargetIndex + 1)) {
      addReason({
        code: 'NEWER_ASSET_VERSION_REGISTERED',
        evidenceType: 'ASSET_VERSION',
        evidenceId: laterVersionId,
        recordedAt: null,
        message: `同一素材已经登记后续版本 ${laterVersionId}`,
      });
    }
    const currentStaticVersionId = String(staticFamily?.currentVersionId || '');
    const currentStaticIndex = staticVersionRefs.indexOf(currentStaticVersionId);
    if (currentStaticVersionId && currentStaticVersionId !== target.versionId && currentStaticIndex > staticTargetIndex) {
      addReason({
        code: 'LATER_VERSION_ADOPTED',
        evidenceType: 'ASSET_VERSION',
        evidenceId: currentStaticVersionId,
        recordedAt: null,
        message: `同一素材的后续版本 ${currentStaticVersionId} 已被采用`,
      });
    }
  }

  for (const version of data.productionModel.assetVersions) {
    if (
      version.id !== target.versionId
      && Array.isArray(version.inputVersionBindings)
      && version.inputVersionBindings.some((binding) => exactVersionBinding(binding, target, knownVersions))
    ) {
      addReason({
        code: 'DOWNSTREAM_ASSET_VERSION_BOUND',
        evidenceType: 'ASSET_VERSION',
        evidenceId: version.id,
        recordedAt: null,
        message: `下游产物 ${version.id} 已精确绑定当前版本与 SHA-256`,
      });
    } else if (
      version.id !== target.versionId
      && Array.isArray(version.inputVersionBindings)
      && version.inputVersionBindings.some((binding) => unverifiedTargetVersionBinding(binding, target, knownVersions))
    ) {
      addUnverifiedBinding('ASSET_VERSION', version.id, null);
    }
  }

  for (const item of [...data.productionModel.workItems, ...(data.productionModel.materialWorkItems || [])]) {
    const downstreamStarted = item.outputState === 'PRESENT'
      || [
        'IN_PROGRESS',
        'EXECUTION_FAILED',
        'RESULT_PENDING_REGISTRATION',
        'RESULT_UNKNOWN',
        'REVIEW_PENDING',
        'RELEASED',
        'REVISION_REQUIRED',
        'DO_NOT_USE',
        'RIGHTS_HOLD',
        'SATISFIED_BY_EXISTING',
      ].includes(String(item.lifecycleState || ''))
      || Boolean(item.latestRun && !['NOT_STARTED', 'CANCELLED'].includes(String(item.latestRun.state || '')));
    const inputBindings = Array.isArray(item.inputVersionBindings) ? item.inputVersionBindings : [];
    const inputRelations = inputBindings.map((binding) => versionBindingRelation(binding, target, knownVersions));
    const exactInput = inputRelations.includes('EXACT');
    const declaredTargetFamily = (item.inputAssetRefs || []).includes(target.familyId);
    const hasCompleteFamilyBinding = inputRelations.some((relation) => relation === 'EXACT' || relation === 'OTHER_VERSION');
    const unverifiedInput = inputRelations.includes('UNVERIFIED_TARGET')
      || (declaredTargetFamily && !hasCompleteFamilyBinding);
    if (downstreamStarted && exactInput) {
      addReason({
        code: 'DOWNSTREAM_WORK_ITEM_INPUT_LOCKED',
        evidenceType: 'WORK_ITEM',
        evidenceId: item.id,
        recordedAt: null,
        message: `下游工作项 ${item.id} 已冻结当前版本输入`,
      });
    } else if (downstreamStarted && unverifiedInput) {
      addUnverifiedBinding('WORK_ITEM', item.id, null);
    }
  }

  for (const revision of data.productionModel.shotPlanSetRevisions || []) {
    const adopted = revision.adoptedMaterialSet;
    const bindings = adopted && typeof adopted === 'object' && !Array.isArray(adopted)
      ? (adopted as Record<string, unknown>).bindings
      : null;
    if (
      revision.scopeRole === 'CURRENT'
      && revision.revisionState === 'CURRENT'
      && revision.isCurrent === true
      && (
        ['SOURCE_CURRENT', 'SUCCEEDED'].includes(String(revision.sourceSyncState || ''))
        || (
          revision.sync
          && typeof revision.sync === 'object'
          && !Array.isArray(revision.sync)
          && ['SOURCE_CURRENT', 'SUCCEEDED'].includes(String((revision.sync as Record<string, unknown>).state || ''))
        )
      )
      && Array.isArray(bindings)
      && bindings.some((binding) => exactVersionBinding(binding, target, knownVersions))
    ) {
      const revisionId = String(revision.id || revision.revisionId || revision.planId || 'UNKNOWN');
      addReason({
        code: 'CURRENT_SHOT_PLAN_MATERIAL_LOCK',
        evidenceType: 'SHOT_PLAN_SET',
        evidenceId: revisionId,
        recordedAt: null,
        message: `当前镜头计划 ${revisionId} 已冻结采用本版本`,
      });
    } else if (
      revision.scopeRole === 'CURRENT'
      && revision.revisionState === 'CURRENT'
      && revision.isCurrent === true
      && (
        ['SOURCE_CURRENT', 'SUCCEEDED'].includes(String(revision.sourceSyncState || ''))
        || (
          revision.sync
          && typeof revision.sync === 'object'
          && !Array.isArray(revision.sync)
          && ['SOURCE_CURRENT', 'SUCCEEDED'].includes(String((revision.sync as Record<string, unknown>).state || ''))
        )
      )
      && Array.isArray(bindings)
      && bindings.some((binding) => unverifiedTargetVersionBinding(binding, target, knownVersions))
    ) {
      const revisionId = String(revision.id || revision.revisionId || revision.planId || 'UNKNOWN');
      addUnverifiedBinding('SHOT_PLAN_SET', revisionId, null);
    }
  }

  for (const review of effectiveMediaReviews) {
    if (
      review.eventId !== head.eventId
      && review.familyId === target.familyId
      && review.versionId !== target.versionId
      && review.action === 'APPROVE_AND_RELEASE'
      && eventOccursAfter(review, head)
    ) {
      addReason({
        code: 'LATER_VERSION_ADOPTED',
        evidenceType: 'REVIEW_EVENT',
        evidenceId: String(review.eventId || 'UNKNOWN'),
        recordedAt: typeof review.recordedAt === 'string' ? review.recordedAt : null,
        message: `同一素材的后续版本 ${String(review.versionId || 'UNKNOWN')} 已被采用`,
      });
    }
  }

  const projectedRequests = projectedExecutionRequests(executionRequests, candidates);
  const requestsById = new Map(projectedRequests.map((event) => [String(event.executionRequestId || ''), event]));
  for (const request of projectedRequests) {
    const requestState = String(request.requestState || request.status || '');
    const active = ['AUTHORIZED', 'CLAIMED', 'FULFILLED'].includes(requestState);
    const requestBindings = Array.isArray(request.inputBindings) ? request.inputBindings : [];
    const requestRelations = requestBindings.map((binding) => versionBindingRelation(binding, target, knownVersions));
    const exactInput = requestRelations.includes('EXACT');
    const declaredTargetFamily = Array.isArray(request.inputAssetRefs)
      && request.inputAssetRefs.map(String).includes(target.familyId);
    const hasCompleteFamilyBinding = requestRelations.some((relation) => relation === 'EXACT' || relation === 'OTHER_VERSION');
    const conflictingInput = requestRelations.includes('UNVERIFIED_TARGET')
      || (declaredTargetFamily && !hasCompleteFamilyBinding);
    const nextVersionRequest = String(request.familyId || '') === target.familyId && eventOccursAfter(request, head);
    if (active && conflictingInput) {
      addUnverifiedBinding(
        'EXECUTION_REQUEST',
        String(request.executionRequestId || request.eventId || 'UNKNOWN'),
        typeof request.recordedAt === 'string' ? request.recordedAt : null,
      );
      continue;
    }
    if (!active || (!exactInput && !nextVersionRequest)) continue;
    addReason({
      code: 'DOWNSTREAM_EXECUTION_REQUEST_ACTIVE',
      evidenceType: 'EXECUTION_REQUEST',
      evidenceId: String(request.executionRequestId || request.eventId || 'UNKNOWN'),
      recordedAt: typeof request.recordedAt === 'string' ? request.recordedAt : null,
      message: nextVersionRequest
        ? `同一素材的下一轮执行请求 ${String(request.executionRequestId || 'UNKNOWN')} 已启动`
        : `下游执行请求 ${String(request.executionRequestId || 'UNKNOWN')} 已精确绑定当前版本`,
    });
  }

  for (const run of runs) {
    const request = requestsById.get(String(run.executionRequestId || ''));
    if (!request) continue;
    const requestBindings = Array.isArray(request.inputBindings) ? request.inputBindings : [];
    const requestRelations = requestBindings.map((binding) => versionBindingRelation(binding, target, knownVersions));
    const exactInput = requestRelations.includes('EXACT');
    const declaredTargetFamily = Array.isArray(request.inputAssetRefs)
      && request.inputAssetRefs.map(String).includes(target.familyId);
    const hasCompleteFamilyBinding = requestRelations.some((relation) => relation === 'EXACT' || relation === 'OTHER_VERSION');
    const conflictingInput = requestRelations.includes('UNVERIFIED_TARGET')
      || (declaredTargetFamily && !hasCompleteFamilyBinding);
    if (conflictingInput) {
      addUnverifiedBinding(
        'RUN',
        String(run.runId || run.eventId || 'UNKNOWN'),
        typeof run.recordedAt === 'string' ? run.recordedAt : null,
      );
      continue;
    }
    const nextVersionRun = String(request.familyId || '') === target.familyId
      && (eventOccursAfter(request, head) || eventOccursAfter(run, head));
    if (!exactInput && !nextVersionRun) continue;
    addReason({
      code: 'DOWNSTREAM_RUN_RECORDED',
      evidenceType: 'RUN',
      evidenceId: String(run.runId || run.eventId || 'UNKNOWN'),
      recordedAt: typeof run.recordedAt === 'string' ? run.recordedAt : null,
      message: `后续模型执行 ${String(run.runId || 'UNKNOWN')} 已经发生`,
    });
  }

  for (const operation of sourceOperations) {
    if (operation.reviewEventId !== head.eventId) continue;
    addReason({
      code: 'SOURCE_OPERATION_REGISTERED',
      evidenceType: 'SOURCE_OPERATION',
      evidenceId: String(operation.sourceOperationId || operation.eventId || 'UNKNOWN'),
      recordedAt: typeof operation.recordedAt === 'string' ? operation.recordedAt : null,
      message: `源同步操作 ${String(operation.sourceOperationId || 'UNKNOWN')} 已绑定本次裁决`,
    });
  }

  return {
    mode: 'APPEND_ONLY_SUPERSESSION',
    state: reasons.some((reason) => [
      'DOWNSTREAM_BINDING_UNVERIFIED',
      'REVIEW_SUPERSESSION_CHAIN_UNVERIFIED',
    ].includes(reason.code))
      ? 'UNKNOWN'
      : reasons.length ? 'LOCKED' : 'OPEN',
    headEventId: String(head.eventId || ''),
    headAction: String(head.action || ''),
    lockReasons: reasons,
  };
}

export function assetReviewTransitionProjection(
  data: ReviewData,
  target: { familyId: string; versionId: string; sha256: string },
  events: {
    reviews: EventRecord[];
    candidates: EventRecord[];
    executionRequests: EventRecord[];
    runs: EventRecord[];
    sourceOperations: EventRecord[];
  },
): ReviewCorrectionProjection {
  const normalizedTarget = {
    familyId: String(target.familyId || ''),
    versionId: String(target.versionId || ''),
    sha256: String(target.sha256 || '').toLowerCase(),
  };
  const currentCandidates = events.candidates.filter((event) => candidateBindsCurrentGraph(data, event));
  const applicableReviews = applicableReviewEvents(data, events.reviews, currentCandidates);
  const { effectiveMediaReviews, assetChainIssuesByTarget } = latestApplicableMediaReviewProjection(applicableReviews);
  const targetKey = ['ASSET', normalizedTarget.familyId, normalizedTarget.versionId, normalizedTarget.sha256].join('::');
  const chainIssues = assetChainIssuesByTarget.get(targetKey) || [];
  const head = effectiveMediaReviews.find((review) => (
    review.subjectType === 'ASSET'
    && String(review.familyId || '') === normalizedTarget.familyId
    && String(review.versionId || '') === normalizedTarget.versionId
    && String(review.versionSha256 || '').toLowerCase() === normalizedTarget.sha256
  )) || null;
  if (head) {
    return reviewCorrectionProjection(
      data,
      head,
      currentCandidates,
      effectiveMediaReviews,
      events.executionRequests,
      events.runs,
      events.sourceOperations,
      chainIssues,
    );
  }

  const registration = [...currentCandidates]
    .filter((event) => (
      String(event.familyId || '') === normalizedTarget.familyId
      && String(event.versionId || '') === normalizedTarget.versionId
      && String(event.sha256 || '').toLowerCase() === normalizedTarget.sha256
    ))
    .sort(compareEventOrder)
    .at(-1) || null;
  const boundary: EventRecord = {
    ...(registration || {}),
    eventId: '',
    action: '',
    familyId: normalizedTarget.familyId,
    versionId: normalizedTarget.versionId,
    versionSha256: normalizedTarget.sha256,
  };
  const projection = reviewCorrectionProjection(
    data,
    boundary,
    currentCandidates,
    effectiveMediaReviews,
    events.executionRequests,
    events.runs,
    events.sourceOperations,
    chainIssues,
  );
  const staticVersion = data.productionModel.assetVersions.find((version) => (
    version.id === normalizedTarget.versionId
    && version.familyId === normalizedTarget.familyId
    && String(version.sha256 || '').toLowerCase() === normalizedTarget.sha256
  ));
  const family = data.productionModel.assetFamilies.find((entry) => entry.id === normalizedTarget.familyId);
  const outputState = staticVersion
    ? String(staticVersion.outputState || 'UNKNOWN')
    : String(registration?.outputState || 'PRESENT');
  const reviewDecision = staticVersion
    ? String(staticVersion.reviewDecision || 'UNKNOWN')
    : String(registration?.reviewDecision || 'PENDING');
  const lifecycleState = staticVersion
    ? String(staticVersion.lifecycleState || 'UNKNOWN')
    : String(registration?.lifecycleState || 'REVIEW_PENDING');
  const canFlowDownstream = staticVersion ? staticVersion.canFlowDownstream === true : registration?.canFlowDownstream === true;
  const targetAlreadyAdopted = String(family?.currentVersionId || '') === normalizedTarget.versionId;
  const initialDecisionReady = Boolean(
    (registration || staticVersion)
    && outputState === 'PRESENT'
    && reviewDecision === 'PENDING'
    && lifecycleState === 'REVIEW_PENDING'
    && !canFlowDownstream
    && !targetAlreadyAdopted
  );
  if (!initialDecisionReady) {
    projection.lockReasons.push({
      code: 'TARGET_ASSET_VERSION_ALREADY_ADVANCED',
      evidenceType: 'ASSET_VERSION',
      evidenceId: normalizedTarget.versionId || 'UNKNOWN',
      recordedAt: typeof registration?.recordedAt === 'string' ? registration.recordedAt : null,
      message: `资产版本 ${normalizedTarget.versionId || 'UNKNOWN'} 已不是未裁决的 REVIEW_PENDING 候选，不能补写初次裁决`,
    });
  }
  projection.headEventId = '';
  projection.headAction = '';
  projection.state = projection.lockReasons.some((reason) => [
    'DOWNSTREAM_BINDING_UNVERIFIED',
    'REVIEW_SUPERSESSION_CHAIN_UNVERIFIED',
  ].includes(reason.code))
    ? 'UNKNOWN'
    : projection.lockReasons.length ? 'LOCKED' : 'OPEN';
  return projection;
}

function applicableStructureReviewEvents(
  data: ReviewData,
  reviews: EventRecord[],
  creativeRevisions: EventRecord[],
  sourceOperations: EventRecord[] = [],
  mediaStateProjection: CreativeBasisStateProjection = {},
) {
  const revisions = new Map<string, EventRecord>();
  for (const revision of creativeRevisions) {
    const revisionId = String(revision.creativeRevisionId || revision.revisionId || '');
    if (revisionId && !revisions.has(revisionId)) revisions.set(revisionId, revision);
  }
  return appliedReviewEvents(reviews)
    .filter((event) => event.subjectType === 'STRUCTURE' || event.subjectType === 'CREATIVE_REVISION')
    .filter((event) => {
      const revisionId = String(event.subjectRevisionId || event.creativeRevisionId || '');
      const revision = revisions.get(revisionId);
      try {
        if (
          !revision
          || revision.subjectId !== event.subjectId
          || revision.subjectKind !== event.subjectKind
          || revision.contentHash !== event.subjectRevisionHash
          || revision.contextHash !== event.contextHash
          || revision.basisBindingsHash !== event.basisBindingsHash
          || !Array.isArray(revision.basisBindings)
          || stableObjectHash(revision.basisBindings) !== event.basisBindingsHash
        ) return false;
        if (sourceSyncSucceeded(data, sourceOperations, event, mediaStateProjection)) return true;
        if (
          revision.baseRevisionHash !== currentCreativeSubjectBaseHash(
            data,
            String(revision.subjectKind || ''),
            String(revision.subjectId || ''),
          )
        ) return false;
        assertCreativeRevisionBasisCurrent(data, mediaStateProjection, revision);
        return true;
      } catch {
        return false;
      }
    });
}

function applicableVerificationEvents(data: ReviewData, events: EventRecord[]) {
  const targets = new Map(audioVerificationTargets(data).map((item) => [String(item.issueId || item.subjectId || ''), item]));
  return events
    .filter((event) => event.schemaVersion === '1.0' && event.applicationStatus === 'APPLIED')
    .filter((event) => ['CONFIRMED_CURRENT', 'CORRECTED', 'UNRESOLVED_AFTER_LISTENING'].includes(String(event.outcome || '')))
    .filter((event) => {
      const issueId = String(event.issueId || event.subjectId || '');
      const target = targets.get(issueId);
      if (!target) return false;
      return String(event.audioSha256 || '').toLowerCase() === String(target.audioSha256 || '').toLowerCase()
        && String(event.currentTextHash || '').toLowerCase() === String(target.currentTextHash || '').toLowerCase()
        && String(event.businessContextHash || event.contextHash || '').toLowerCase() === String(target.businessContextHash || target.contextHash || '').toLowerCase();
    })
    .sort((left, right) => {
      const byTime = String(left.recordedAt).localeCompare(String(right.recordedAt));
      return byTime || String(left.eventId).localeCompare(String(right.eventId));
    });
}

export function projectedStructureReviewIndexes(
  data: ReviewData,
  reviews: EventRecord[],
  creativeRevisions: EventRecord[],
  sourceOperations: EventRecord[],
  mediaStateProjection: CreativeBasisStateProjection,
) {
  const canonicalSubjectKinds = new Set(['EPISODE_PLAN', 'SCENE_COVERAGE', 'SHOT_PLAN_SET']);
  const newestFirst = applicableStructureReviewEvents(
    data,
    reviews,
    creativeRevisions,
    sourceOperations,
    mediaStateProjection,
  )
    .filter((event) => (
      event.subjectType === 'CREATIVE_REVISION'
      && canonicalSubjectKinds.has(String(event.subjectKind || ''))
    ))
    .reverse();
  const decorate = (aggregateId: string, event: EventRecord) => {
    const syncApplied = sourceSyncSucceeded(data, sourceOperations, event, mediaStateProjection);
    return {
    aggregateId,
    event,
    projection: {
      subjectKind: String(event.subjectKind || ''),
      subjectRevisionId: String(event.subjectRevisionId || event.creativeRevisionId || ''),
      subjectRevisionHash: String(event.subjectRevisionHash || ''),
      action: String(event.action || ''),
      reviewDecision: String(event.reviewDecision || ''),
      lifecycleState: String(event.lifecycleState || ''),
      canFlowDownstream: event.action === 'APPROVE_AND_RELEASE' ? syncApplied : false,
      sourceSyncRequired: event.sourceSyncRequired === true,
      sourceSyncState: event.sourceSyncRequired === true ? (syncApplied ? 'SUCCEEDED' : 'PENDING') : 'NOT_REQUIRED',
    },
  };
  };
  const byRevision = latestBy(newestFirst, (event) => String(event.subjectRevisionId || event.creativeRevisionId || ''))
    .map(({ aggregateId, event }) => decorate(aggregateId, event));
  const bySubject = latestBy(newestFirst, (event) => (
    event.subjectKind && event.subjectId ? `${event.subjectKind}::${event.subjectId}` : ''
  )).map(({ aggregateId, event }) => decorate(aggregateId, event));
  return { byRevision, bySubject };
}

export function projectedScopeLocks(
  data: ReviewData,
  structuresById: Record<string, Record<string, unknown> | undefined>,
) {
  return Object.fromEntries((data.productionModel.scopeLocks || [])
    .filter((lock) => typeof lock.id === 'string' && lock.id)
    .map((lock) => {
      const baseLockState = String(lock.lockState || lock.scopeLockState || 'UNKNOWN');
      if (
        lock.scopeType !== 'SCENE'
        || typeof lock.scopeId !== 'string'
        || lock.lockPurpose !== 'SHOT_PLAN_SET'
      ) {
        return [String(lock.id), {
          ...lock,
          lockState: baseLockState,
          scopeLockState: baseLockState,
          effectiveLockSource: 'BASE_SNAPSHOT',
        }];
      }
      const coveragePlan = data.productionModel.sceneCoveragePlanRevisions?.find((row) => (
        row.scopeType === 'SCENE' && row.scopeId === lock.scopeId
      ));
      const shotPlan = data.productionModel.shotPlanSetRevisions?.find((row) => (
        row.scopeType === 'SCENE' && row.scopeId === lock.scopeId
      ));
      const coverageProjection = coveragePlan?.planId
        ? structuresById[`SCENE_COVERAGE::${String(coveragePlan.planId)}`]
        : null;
      const coverageReleasedAndSynced = Boolean(
        coverageProjection
        && coverageProjection.subjectKind === 'SCENE_COVERAGE'
        && coverageProjection.reviewDecision === 'RELEASED'
        && coverageProjection.lifecycleState === 'RELEASED'
        && coverageProjection.sourceSyncState === 'SUCCEEDED'
        && coverageProjection.canFlowDownstream === true
        && typeof coverageProjection.subjectRevisionId === 'string'
        && coverageProjection.subjectRevisionId
        && typeof coverageProjection.subjectRevisionHash === 'string'
        && /^[a-f0-9]{64}$/.test(coverageProjection.subjectRevisionHash)
      );
      const shotPlanProjection = shotPlan?.planId
        ? structuresById[`SHOT_PLAN_SET::${String(shotPlan.planId)}`]
        : null;
      const shotIds = Array.isArray(shotPlan?.shotIds)
        ? shotPlan.shotIds.filter((shotId): shotId is string => typeof shotId === 'string' && Boolean(shotId))
        : [];
      const shotPlanReleasedAndSynced = Boolean(
        coverageReleasedAndSynced
        && shotPlanProjection
        && shotPlanProjection.subjectKind === 'SHOT_PLAN_SET'
        && shotPlanProjection.reviewDecision === 'RELEASED'
        && shotPlanProjection.lifecycleState === 'RELEASED'
        && shotPlanProjection.sourceSyncState === 'SUCCEEDED'
        && shotPlanProjection.canFlowDownstream === true
        && shotPlan?.scopeRole === 'CURRENT'
        && shotPlan.revisionState === 'CURRENT'
        && shotPlan.id === shotPlanProjection.subjectRevisionId
        && shotPlan.revisionHash === shotPlanProjection.subjectRevisionHash
        && shotPlan.denominatorState === 'KNOWN'
        && shotPlan.denominator === shotIds.length
        && new Set(shotIds).size === shotIds.length
      );
      const effectiveLockState = shotPlanReleasedAndSynced
        ? 'LOCKED'
        : coverageReleasedAndSynced ? 'READY_TO_LOCK' : 'UNLOCKED';
      return [String(lock.id), {
        ...lock,
        lockState: effectiveLockState,
        scopeLockState: effectiveLockState,
        denominatorState: shotPlanReleasedAndSynced ? 'KNOWN' : 'UNKNOWN',
        denominator: shotPlanReleasedAndSynced ? shotIds.length : null,
        discoveredCount: shotPlanReleasedAndSynced ? shotIds.length : 0,
        shotIds: shotPlanReleasedAndSynced ? shotIds : [],
        effectiveLockSource: shotPlanReleasedAndSynced
          ? 'APPLIED_SYNCED_SHOT_PLAN_SET'
          : coverageReleasedAndSynced ? 'APPLIED_SYNCED_SCENE_COVERAGE_READY'
          : 'RUNTIME_GATE_CLOSED',
        lockedRevisionId: shotPlanReleasedAndSynced
          ? String(shotPlanProjection?.subjectRevisionId || '')
          : null,
        lockedRevisionHash: shotPlanReleasedAndSynced
          ? String(shotPlanProjection?.subjectRevisionHash || '')
          : null,
        readyRevisionId: coverageReleasedAndSynced
          ? String(coverageProjection?.subjectRevisionId || '')
          : null,
        readyRevisionHash: coverageReleasedAndSynced
          ? String(coverageProjection?.subjectRevisionHash || '')
          : null,
      }];
    }));
}

type ShotPlanDerivedProjection = {
  workItemsById: Record<string, Record<string, unknown> | undefined>;
  workPackagesById: Record<string, Record<string, unknown> | undefined>;
  shotsById: Record<string, Record<string, unknown> | undefined>;
  materialRequirementsById: Record<string, Record<string, unknown> | undefined>;
  materialStoryRelations?: Record<string, unknown>;
};

/**
 * The generated CURRENT ShotSpec/input-lock rows are only a cached projection
 * of a released, source-synchronised ShotPlanSet.  A later material adoption or
 * creative-basis change can invalidate that release without rebuilding the
 * static JSON immediately.  Close that window here so the stale cached rows do
 * not remain an independent production/action authority.
 */
function gateShotPlanDerivedOperationalProjection(
  data: ReviewData,
  projection: ShotPlanDerivedProjection,
  structuresById: Record<string, Record<string, unknown> | undefined>,
  scopeLocksById: Record<string, Record<string, unknown> | undefined>,
) {
  const shotPlans = data.productionModel.shotPlanSetRevisions || [];
  const scopeLockByScene = new Map(
    Object.values(scopeLocksById)
      .filter((lock): lock is Record<string, unknown> => Boolean(
        lock
        && lock.scopeType === 'SCENE'
        && typeof lock.scopeId === 'string'
        && lock.lockPurpose === 'SHOT_PLAN_SET',
      ))
      .map((lock) => [String(lock.scopeId), lock]),
  );
  const exactCurrentPlan = (
    sceneId: string,
    revisionId: string,
    revisionHash: string,
    shotId?: string,
  ) => {
    const currentForScene = shotPlans.filter((row) => (
      row.scopeType === 'SCENE'
      && row.scopeId === sceneId
      && row.sceneId === sceneId
      && row.scopeRole === 'CURRENT'
      && row.revisionState === 'CURRENT'
      && row.isCurrent === true
    ));
    if (currentForScene.length !== 1) return false;
    const plan = currentForScene[0];
    const planId = String(plan.planId || '');
    const planShotIds = Array.isArray(plan.shotIds)
      ? plan.shotIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [];
    const structure = structuresById[`SHOT_PLAN_SET::${planId}`];
    const scopeLock = scopeLockByScene.get(sceneId);
    return Boolean(
      planId
      && plan.id === revisionId
      && plan.revisionHash === revisionHash
      && (!shotId || planShotIds.includes(shotId))
      && structure?.subjectKind === 'SHOT_PLAN_SET'
      && structure.subjectRevisionId === revisionId
      && structure.subjectRevisionHash === revisionHash
      && structure.reviewDecision === 'RELEASED'
      && structure.lifecycleState === 'RELEASED'
      && structure.sourceSyncState === 'SUCCEEDED'
      && structure.canFlowDownstream === true
      && scopeLock?.lockState === 'LOCKED'
      && scopeLock.scopeLockState === 'LOCKED'
      && scopeLock.denominatorState === 'KNOWN'
      && scopeLock.denominator === planShotIds.length
      && scopeLock.lockedRevisionId === revisionId
      && scopeLock.lockedRevisionHash === revisionHash
      && Array.isArray(scopeLock.shotIds)
      && stableObjectHash(scopeLock.shotIds) === stableObjectHash(planShotIds)
    );
  };
  const mark = (
    target: Record<string, unknown> | undefined,
    current: boolean,
    activityRole: string,
  ) => {
    if (!target) return;
    if (current) {
      Object.assign(target, {
        activeInCurrentProduction: true,
        scopeRole: 'CURRENT',
        activityRole,
        shotPlanCurrentBindingState: 'CURRENT',
      });
      return;
    }
    Object.assign(target, {
      activeInCurrentProduction: false,
      scopeRole: 'EVIDENCE_ONLY',
      activityRole: 'HISTORICAL_EVIDENCE',
      historyRole: 'EVIDENCE_ONLY',
      upstreamReadiness: 'WAITING',
      lifecycleState: 'WAITING_UPSTREAM',
      canFlowDownstream: false,
      flowBlockReasons: ['SHOT_PLAN_SET_CURRENT_BINDING_REQUIRED'],
      shotPlanCurrentBindingState: 'STALE_UPSTREAM',
    });
  };

  for (const work of data.productionModel.workItems) {
    if (
      work.deliverableKey !== 'SHOT_INPUT_LOCK'
      || !work.shotPlanSetRevisionId
      || !work.shotPlanSetRevisionHash
    ) continue;
    const current = exactCurrentPlan(
      String(work.sceneId || ''),
      work.shotPlanSetRevisionId,
      work.shotPlanSetRevisionHash,
      String(work.shotId || ''),
    );
    mark(projection.workItemsById[work.id], current, 'CURRENT_PRODUCTION');
  }
  for (const workPackage of data.productionModel.workPackages) {
    if (!workPackage.shotPlanSetRevisionId || !workPackage.shotPlanSetRevisionHash) continue;
    const current = exactCurrentPlan(
      String(workPackage.sceneId || ''),
      workPackage.shotPlanSetRevisionId,
      workPackage.shotPlanSetRevisionHash,
    );
    mark(projection.workPackagesById[workPackage.id], current, 'CURRENT_PRODUCTION');
  }
  for (const shot of data.productionModel.shots || []) {
    if (!shot.shotPlanSetRevisionId || !shot.shotPlanSetRevisionHash) continue;
    const current = exactCurrentPlan(
      String(shot.sceneId || ''),
      shot.shotPlanSetRevisionId,
      shot.shotPlanSetRevisionHash,
      shot.id,
    );
    mark(projection.shotsById[shot.id], current, 'SHOT_PLANNING');
  }

  // Material consumers are a projection of the effective ShotPlanSet, never
  // an independent assertion copied from the last generated JSON. Rebuild the
  // relation after the runtime gate so an adopted-material/basis drift cannot
  // leave stale ShotSpecs visible as current consumers in the material views.
  const requirements = new Map(
    (data.productionModel.materialRequirements || []).map((requirement) => [requirement.id, requirement]),
  );
  const currentShotIdsByRequirement = new Map<string, string[]>(
    [...requirements.keys()].map((requirementId) => [requirementId, []]),
  );
  const effectiveCurrentShotIds = new Set<string>();
  for (const shot of data.productionModel.shots || []) {
    const projectedShot = projection.shotsById[shot.id];
    if (!(
      projectedShot?.shotPlanCurrentBindingState === 'CURRENT'
      && projectedShot.activeInCurrentProduction === true
      && projectedShot.scopeRole === 'CURRENT'
    )) continue;
    effectiveCurrentShotIds.add(shot.id);
    const requirementRefs = Array.isArray((shot as Record<string, unknown>).materialRequirementRefs)
      ? ((shot as Record<string, unknown>).materialRequirementRefs as unknown[]).map(String)
      : [];
    for (const requirementId of requirementRefs) {
      const requirement = requirements.get(requirementId);
      if (!requirement || requirement.requirementClass !== 'REQUIRED') {
        throw new HttpError(503, `current ShotSpec ${shot.id} has an invalid MaterialRequirement binding`);
      }
      currentShotIdsByRequirement.get(requirementId)?.push(shot.id);
    }
  }
  for (const requirement of requirements.values()) {
    const currentShotIds = [...new Set(currentShotIdsByRequirement.get(requirement.id) || [])]
      .sort((left, right) => left.localeCompare(right));
    const projectedRequirement = projection.materialRequirementsById[requirement.id];
    if (!projectedRequirement) {
      throw new HttpError(503, `MaterialRequirement ${requirement.id} is missing from the operational projection`);
    }
    Object.assign(projectedRequirement, {
      currentShotIds,
      currentShotRelationState: currentShotIds.length
        ? 'DECLARED_CURRENT_SHOT_SPECS'
        : 'UNKNOWN_PENDING_SHOT_PLAN_SET_SYNC',
    });
  }
  if (projection.materialStoryRelations) {
    Object.assign(projection.materialStoryRelations, {
      currentShotState: effectiveCurrentShotIds.size ? 'DECLARED' : 'UNKNOWN',
      currentShotCount: effectiveCurrentShotIds.size,
      currentShotIdentitySource: effectiveCurrentShotIds.size
        ? 'CURRENT_SHOT_PLAN_SET_REVISIONS'
        : 'UNKNOWN_PENDING_SHOT_PLAN_SET_SYNC',
    });
  }
}

export function projectedReviewIndexes(
  data: ReviewData,
  reviews: EventRecord[],
  candidates: EventRecord[],
  sourceOperations: EventRecord[] = [],
) {
  const applicable = applicableReviewEvents(data, reviews, candidates);
  const { effectiveMediaReviews } = latestApplicableMediaReviewProjection(applicable);
  const effectiveReviews = [
    ...applicable.filter((event) => !['ASSET', 'WORK_PRODUCT'].includes(String(event.subjectType || ''))),
    ...effectiveMediaReviews,
  ].sort(compareEventOrder);
  const newestFirst = [...effectiveReviews].reverse();
  const decorate = (aggregateId: string, event: EventRecord) => {
    const syncApplied = sourceSyncSucceeded(data, sourceOperations, event);
    return {
    aggregateId,
    event,
    projection: {
      action: String(event.action),
      projectRightsGate: typeof event.appliedProjectRightsGate === 'string'
        ? event.appliedProjectRightsGate
        : event.subjectType === 'SCRIPT_SCENE' ? 'NOT_APPLICABLE' : 'UNKNOWN',
      reviewDecision: String(event.reviewDecision),
      lifecycleState: String(event.lifecycleState),
      canFlowDownstream: event.action === 'APPROVE_AND_RELEASE' ? syncApplied : false,
      sourceSyncRequired: event.sourceSyncRequired === true,
      sourceSyncState: event.sourceSyncRequired === true ? (syncApplied ? 'SUCCEEDED' : 'PENDING') : 'NOT_REQUIRED',
    },
  };
  };
  const byVersion = latestBy(newestFirst, (event) => String(event.versionId || ''))
    .map(({ aggregateId, event }) => decorate(aggregateId, event));
  const byAssetVersion = latestBy(
    newestFirst.filter((event) => event.subjectType === 'ASSET'),
    (event) => String(event.versionId || ''),
  ).map(({ aggregateId, event }) => decorate(aggregateId, event));
  const bySubject = latestBy(newestFirst, (event) => {
    const binding = reviewSubjectBinding(event);
    return binding.subjectType && binding.subjectId ? `${binding.subjectType}::${binding.subjectId}` : '';
  }).map(({ aggregateId, event }) => decorate(aggregateId, event));
  const ownerIdsByFamily = new Map<string, string[]>();
  for (const item of [...data.productionModel.workItems, ...(data.productionModel.materialWorkItems || [])]) {
    if (!item.outputAssetRef) continue;
    const owners = ownerIdsByFamily.get(item.outputAssetRef) || [];
    owners.push(item.id);
    ownerIdsByFamily.set(item.outputAssetRef, owners);
  }
  const byWorkItem: ReturnType<typeof decorate>[] = [];
  const seen = new Set<string>();
  for (const event of newestFirst) {
    const explicit = typeof event.workItemId === 'string' && event.workItemId ? [event.workItemId] : [];
    const derived = typeof event.familyId === 'string' ? ownerIdsByFamily.get(event.familyId) || [] : [];
    for (const workItemId of [...new Set([...explicit, ...derived])]) {
      if (seen.has(workItemId)) continue;
      seen.add(workItemId);
      byWorkItem.push(decorate(workItemId, event));
    }
  }
  return { byVersion, byAssetVersion, byWorkItem, bySubject };
}

function recordIdentifier(record: Record<string, unknown> | null | undefined) {
  if (!record) return null;
  for (const key of ['id', 'snapshotId', 'revisionId', 'planId']) {
    if (typeof record[key] === 'string' && record[key]) return String(record[key]);
  }
  return null;
}

function explicitlyCurrent(record: Record<string, unknown>) {
  return record.scopeRole === 'CURRENT'
    || record.revisionState === 'CURRENT'
    || record.releaseState === 'CURRENT'
    || record.isCurrent === true;
}

export function projectStoryHandoff(
  data: ReviewData,
  structuresById: Record<string, Record<string, unknown> | undefined>,
  scriptScenesById: Record<string, Record<string, unknown> | undefined>,
  episodeNarrativeReleasesByUid: ReturnType<typeof projectEpisodeNarrativeReleases> = {},
) {
  const canonicalSceneIds = canonicalStorySceneIds(data);
  const episodePlanRows = data.productionModel.episodePlanRevisions || [];
  const staticCurrentPlan = episodePlanRows.find(explicitlyCurrent) || null;
  const staticPlanSync = staticCurrentPlan?.sync && typeof staticCurrentPlan.sync === 'object' && !Array.isArray(staticCurrentPlan.sync)
    ? staticCurrentPlan.sync as Record<string, unknown>
    : {};
  const staticPlanReview = staticCurrentPlan?.review && typeof staticCurrentPlan.review === 'object' && !Array.isArray(staticCurrentPlan.review)
    ? staticCurrentPlan.review as Record<string, unknown>
    : {};
  const staticPlanSourceSyncState = String(staticPlanSync.state || staticCurrentPlan?.sourceSyncState || 'UNKNOWN');
  const staticPlanIsCurrent = Boolean(
    staticCurrentPlan
    && ['SOURCE_CURRENT', 'SUCCEEDED'].includes(staticPlanSourceSyncState)
    && (
      ['ADOPTED', 'RELEASED', 'CURRENT'].includes(String(staticPlanReview.state || ''))
      || ['RELEASED', 'CURRENT'].includes(String(staticPlanReview.decision || ''))
    ),
  );
  const projectedPlan = structuresById[`EPISODE_PLAN::${episodePlanIdFor(data)}`];
  const projectedPlanCurrent = Boolean(
    projectedPlan
    && projectedPlan.reviewDecision === 'RELEASED'
    && projectedPlan.canFlowDownstream === true
    && projectedPlan.sourceSyncState === 'SUCCEEDED',
  );
  const currentPlanId = (staticPlanIsCurrent ? recordIdentifier(staticCurrentPlan) : null)
    || (projectedPlanCurrent ? String(projectedPlan?.subjectRevisionId || '') || null : null);
  const currentPlanAvailable = Boolean(currentPlanId);
  const sceneReleaseById = Object.fromEntries(canonicalSceneIds.map((sceneId) => {
    const projection = scriptScenesById[sceneId];
    const released = Boolean(
      projection
      && projection.reviewDecision === 'RELEASED'
      && projection.lifecycleState === 'RELEASED'
      && projection.canFlowDownstream === true,
    );
    const state = !currentPlanAvailable ? 'UNKNOWN' : released ? 'READY' : 'WAITING';
    return [sceneId, {
      state,
      hasAppliedReviewEvent: Boolean(projection),
      canCreateSceneCoverage: currentPlanAvailable && released,
      blockingReasons: [
        ...(!currentPlanAvailable ? ['CURRENT_EPISODE_PLAN_UNAVAILABLE'] : []),
        ...(!released ? ['SCENE_SCRIPT_RELEASE_REQUIRED'] : []),
      ],
    }];
  }));
  const releasedSceneIds = canonicalSceneIds.filter((sceneId) => sceneReleaseById[sceneId]?.canCreateSceneCoverage === true);
  const releaseSnapshots = data.productionModel.screenplayReleaseSnapshots || [];
  const currentReleaseSnapshot = releaseSnapshots.find(explicitlyCurrent) || null;
  const screenplayReleaseSnapshotId = recordIdentifier(currentReleaseSnapshot);
  const allSceneScriptsReleased = canonicalSceneIds.length > 0 && releasedSceneIds.length === canonicalSceneIds.length;
  const blockingReasons = [
    ...(!currentPlanAvailable ? ['CURRENT_EPISODE_PLAN_UNAVAILABLE'] : []),
    ...(!allSceneScriptsReleased ? ['SCENE_SCRIPT_RELEASES_INCOMPLETE'] : []),
    ...(!screenplayReleaseSnapshotId ? ['SCREENPLAY_RELEASE_SNAPSHOT_UNAVAILABLE'] : []),
  ];
  const state = screenplayReleaseSnapshotId && currentPlanAvailable && allSceneScriptsReleased
    ? 'READY'
    : currentPlanAvailable
      ? 'WAITING'
      : 'UNKNOWN';
  const scopedSceneReleaseById = Object.fromEntries(Object.values(episodeNarrativeReleasesByUid).flatMap(release => release.reviewInput.scenes.map(scene => [scene.id, {
    state: release.canFlowDownstream ? 'READY' : 'WAITING', hasAppliedReviewEvent: true, releaseSource: 'EPISODE_NARRATIVE', parentReviewEventId: release.reviewEventId,
    episodeUid: release.episodeUid, episodeNarrativeReleaseId: release.id, sceneContentHash: scene.contentHash,
    canCreateSceneCoverage: release.canFlowDownstream, blockingReasons: release.canFlowDownstream ? [] : [release.reason],
  }])));
  const episodeReleaseByUid = Object.fromEntries(Object.values(episodeNarrativeReleasesByUid).map(release => [release.episodeUid, {
    state: release.state, canEnterProduction: release.canFlowDownstream, canEnterEpisodeAssembly: release.canFlowDownstream,
    episodeNarrativeReleaseId: release.id, episodeScriptReleaseSnapshotId: release.episodeScriptReleaseSnapshot.id,
    episodeScriptReleaseSnapshotHash:release.episodeScriptReleaseSnapshot.contentHash,
    parentReviewEventId: release.reviewEventId, sceneIds: release.reviewInput.scenes.map(s => s.id),
    blockingReasons: release.canFlowDownstream ? [] : [release.reason], source: 'EPISODE_NARRATIVE_REVIEW_AND_SYNC',
  }]));
  return {
    state,
    currentEpisodePlanRevisionId: currentPlanId,
    episodePlanSourceSyncState: staticPlanIsCurrent ? staticPlanSourceSyncState : projectedPlanCurrent ? 'SUCCEEDED' : 'UNKNOWN',
    screenplayReleaseSnapshotId,
    requiredSceneScriptCount: canonicalSceneIds.length,
    releasedSceneScriptCount: releasedSceneIds.length,
    releasedSceneIds,
    allSceneScriptsReleased,
    canEnterEpisodeAssembly: state === 'READY',
    hasAppliedProjection: Boolean(projectedPlan || Object.keys(scriptScenesById).length || Object.keys(episodeReleaseByUid).length),
    blockingReasons,
    sceneReleaseById: {...sceneReleaseById, ...scopedSceneReleaseById},
    episodeReleaseByUid,
    source: 'BASE_SNAPSHOT_PLUS_APPLIED_EVENTS',
  };
}

function makeReviewRollup(stage: string, items: WorkItem[]): ReviewRollup {
  const released = items.filter((item) => (
    item.lifecycleState === 'SATISFIED_BY_EXISTING'
    || (item.lifecycleState === 'RELEASED' && item.canFlowDownstream === true)
  )).length;
  const hasUnreleasedMaterializedOutput = items.some((item) => (
    item.outputState === 'PRESENT'
    && item.lifecycleState !== 'RELEASED'
    && item.lifecycleState !== 'SATISFIED_BY_EXISTING'
  ));
  return {
    stage,
    required: items.length,
    released,
    lifecycleState: items.length > 0 && released === items.length
      ? 'RELEASED'
      : hasUnreleasedMaterializedOutput
        ? 'REVIEW_PENDING'
        : 'WAITING_UPSTREAM',
    source: 'APPLIED_REVIEW_EVENT_PROJECTION',
    targetWorkItemIds: items.map((item) => item.id),
  };
}

function candidateBindsCurrentGraph(data: ReviewData, event: EventRecord) {
  const familyId = String(event.familyId || '');
  const versionId = String(event.versionId || '');
  const sha256 = String(event.sha256 || '').toLowerCase();
  const projectPath = String(event.path || '');
  if (!familyId || !versionId || !projectPath || !/^[a-f0-9]{64}$/.test(sha256)) return false;
  const family = data.productionModel.assetFamilies.find((entry) => entry.id === familyId);
  if (!family) return false;
  if (event.schemaVersion === '1.1') {
    const expectedOutputId = String(event.expectedOutputId || '');
    const expected = (data.productionModel.expectedOutputs || []).find((entry) => entry.id === expectedOutputId);
    if (
      !expected
      || expected.familyId !== familyId
      || expected.targetPath !== projectPath
      || !(family.expectedOutputRefs || []).includes(expectedOutputId)
    ) return false;
  }
  const workItemId = String(event.workItemId || '');
  if (!workItemId) return true;
  const workItem = [...data.productionModel.workItems, ...(data.productionModel.materialWorkItems || [])]
    .find((item) => item.id === workItemId);
  return Boolean(workItem && workItem.outputAssetRef === familyId);
}

function candidateRealizesCurrentExpectedOutput(data: ReviewData, event: EventRecord) {
  const familyId = String(event.familyId || '');
  const family = data.productionModel.assetFamilies.find((entry) => entry.id === familyId);
  const currentExpectedOutputId = String(family?.currentExpectedOutputId || '');
  if (!family || !currentExpectedOutputId) return true;
  const eventExpectedOutputId = String(event.expectedOutputId || '');
  // New candidate events bind their exact ExpectedOutput explicitly.  Never
  // reinterpret an explicitly historical slot through the legacy fallback.
  if (eventExpectedOutputId) return eventExpectedOutputId === currentExpectedOutputId;
  const expected = (data.productionModel.expectedOutputs || [])
    .find((entry) => entry.id === currentExpectedOutputId);
  return Boolean(
    expected
    && String(event.plannedVersionId || '') === String(expected.legacyVersionId || '')
    && String(event.path || '') === String(expected.targetPath || ''),
  );
}

export function projectOperationalState(
  data: ReviewData,
  reviews: EventRecord[],
  candidates: EventRecord[],
  runs: EventRecord[],
  sourceOperations: EventRecord[] = [],
  executionRequests: EventRecord[] = [],
) {
  const currentCandidates = candidates.filter((event) => candidateBindsCurrentGraph(data, event));
  // Runs are immutable execution evidence.  A rebuild expires the authorization
  // lease, but it must never hide an unresolved provider attempt or make retry
  // look safe merely because the snapshot id changed.
  const currentRuns = runs;
  const applicableReviews = applicableReviewEvents(data, reviews, currentCandidates);
  const {
    effectiveMediaReviews,
    assetChainIssuesByTarget,
  } = latestApplicableMediaReviewProjection(applicableReviews);
  const immutableRightsFacts = currentVersionRightsFacts(data, currentCandidates);
  const rightsDriftVersionIds = currentMediaReviewLineage(
    data,
    reviews,
    currentCandidates,
  ).rightsDriftVersionIds;
  const materialItemByDefinition = new Map(
    (data.productionModel.materialWorkItems || [])
      .filter((item) => item.executionDefinitionRef)
      .map((item) => [item.executionDefinitionRef as string, item]),
  );
  const versions = new Map<string, ProjectedVersion>();
  for (const source of data.productionModel.assetVersions) {
    const version: ProjectedVersion = { ...source, source: 'BASE_SNAPSHOT' };
    version.lifecycleState = version.lifecycleState || versionLifecycle(version);
    versions.set(version.id, version);
  }

  for (const candidate of [...currentCandidates].reverse()) {
    const id = String(candidate.versionId || '');
    const familyId = String(candidate.familyId || '');
    const projectPath = typeof candidate.path === 'string' ? candidate.path : null;
    const sha256 = typeof candidate.sha256 === 'string' ? candidate.sha256 : null;
    if (!id || !familyId || !projectPath || !sha256) continue;
    const executionDefinitionRef = typeof candidate.executionDefinitionId === 'string'
      ? candidate.executionDefinitionId
      : null;
    const materialItem = executionDefinitionRef ? materialItemByDefinition.get(executionDefinitionRef) : null;
    versions.set(id, {
      id,
      familyId,
      label: typeof candidate.label === 'string' ? candidate.label : id,
      path: projectPath,
      sha256,
      mediaToken: typeof candidate.mediaToken === 'string' ? candidate.mediaToken : mediaToken(id),
      outputState: 'PRESENT',
      reviewDecision: 'PENDING',
      projectRightsGate: normalizedCurrentProjectRightsGate(candidate),
      historyRole: 'CANDIDATE',
      lifecycleState: 'REVIEW_PENDING',
      canFlowDownstream: false,
      flowBlockReasons: ['REVIEW_PENDING', 'RIGHTS_CONFIRMATION_REQUIRED_IN_REVIEW'],
      rightsWarning: true,
      preflight: { status: 'UNKNOWN', role: 'REVIEW_EVIDENCE_ONLY', sourceRef: null },
      expectedOutputId: typeof candidate.expectedOutputId === 'string' ? candidate.expectedOutputId : null,
      realizes: typeof candidate.expectedOutputId === 'string' ? {
        relationType: 'REALIZES',
        expectedOutputId: candidate.expectedOutputId,
      } : null,
      executionDefinitionRef,
      inputVersionBindings: Array.isArray(candidate.inputBindings)
          ? (candidate.inputBindings as Array<Record<string, unknown>>).map((binding) => ({
            assetFamilyRef: String(binding.assetFamilyRef || ''),
            assetVersionRef: String(binding.assetVersionRef || ''),
            familyId: String(binding.familyId || ''),
            versionId: String(binding.versionId || ''),
            sha256: String(binding.sha256 || '').toLowerCase(),
          }))
        : [],
      materialRequirementBindings: materialItem?.requirementRef && materialItem.requirementHash ? [{
        requirementRef: materialItem.requirementRef,
        requirementHash: materialItem.requirementHash,
        executionDefinitionRef,
        definitionHash: typeof candidate.executionDefinitionHash === 'string' ? candidate.executionDefinitionHash : null,
      }] : [],
      source: 'ASSET_VERSION_EVENT',
    });
  }

  const expectedOutputRealizations = new Map<string, {
    expectationState: 'REALIZED';
    relationType: 'REALIZES';
    expectedOutputId: string;
    realizedVersionId: string;
    realizedVersionSha256: string;
    realizedAt: string | null;
  }>();
  for (const expected of data.productionModel.expectedOutputs || []) {
    const plannedLegacyVersionId = String(expected.legacyVersionId || '');
    const matches = currentCandidates.filter((candidate) => (
      String(candidate.familyId || '') === expected.familyId
      && (
        String(candidate.expectedOutputId || '')
          ? String(candidate.expectedOutputId || '') === expected.id
          : (plannedLegacyVersionId && String(candidate.plannedVersionId || '') === plannedLegacyVersionId)
      )
    ));
    const realized = matches.find((candidate) => String(candidate.versionId || '') === plannedLegacyVersionId)
      || matches[matches.length - 1];
    const realizedVersionId = String(realized?.versionId || '');
    const realizedVersionSha256 = String(realized?.sha256 || '').toLowerCase();
    if (!realizedVersionId || !/^[a-f0-9]{64}$/.test(realizedVersionSha256)) continue;
    expectedOutputRealizations.set(expected.id, {
      expectationState: 'REALIZED',
      relationType: 'REALIZES',
      expectedOutputId: expected.id,
      realizedVersionId,
      realizedVersionSha256,
      realizedAt: typeof realized?.recordedAt === 'string' ? realized.recordedAt : null,
    });
  }

  const families = new Map<string, AssetFamily & StatusProjection>();
  for (const source of data.productionModel.assetFamilies) {
    families.set(source.id, { ...source, versionRefs: [...(source.versionRefs || [])] });
  }
  for (const version of versions.values()) {
    const family = families.get(version.familyId);
    if (family && !family.versionRefs?.includes(version.id)) family.versionRefs?.push(version.id);
  }

  const currentSlotCandidateVersionIdsByFamily = new Map<string, Set<string>>();
  for (const candidate of currentCandidates) {
    if (!candidateRealizesCurrentExpectedOutput(data, candidate)) continue;
    const familyId = String(candidate.familyId || '');
    const versionId = String(candidate.versionId || '');
    if (!familyId || !versionId) continue;
    const versionIds = currentSlotCandidateVersionIdsByFamily.get(familyId) || new Set<string>();
    versionIds.add(versionId);
    currentSlotCandidateVersionIdsByFamily.set(familyId, versionIds);
  }

  for (const review of effectiveMediaReviews) {
    const familyId = String(review.familyId || '');
    const versionId = String(review.versionId || '');
    const versionSha256 = String(review.versionSha256 || '').toLowerCase();
    const action = String(review.action || '');
    const version = versions.get(versionId);
    const family = families.get(familyId);
    if (!version || !family || version.familyId !== familyId || version.sha256?.toLowerCase() !== versionSha256) continue;
    const reviewTargetsCurrentSlot = !family.currentExpectedOutputId
      || (currentSlotCandidateVersionIdsByFamily.get(familyId) || new Set<string>()).has(versionId);
    if (!reviewTargetsCurrentSlot) {
      // Keep the immutable review visible on the historical version without
      // allowing that version to regain a current/adopted lifecycle role.
      version.reviewDecision = String(review.reviewDecision);
      version.projectRightsGate = String(review.appliedProjectRightsGate);
      version.historyRole = 'EVIDENCE_ONLY';
      version.lifecycleState = 'EVIDENCE_ONLY';
      version.canFlowDownstream = false;
      version.flowBlockReasons = ['HISTORICAL_EXPECTED_OUTPUT'];
      continue;
    }

    if (action === 'APPROVE_AND_RELEASE') {
      const syncApplied = sourceSyncSucceeded(data, sourceOperations, review);
      for (const candidate of versions.values()) {
        if (candidate.familyId !== familyId || candidate.id === versionId) continue;
        if (candidate.historyRole === 'CURRENT') candidate.historyRole = 'SUPERSEDED';
        if (candidate.historyRole === 'SUPERSEDED') {
          candidate.lifecycleState = 'EVIDENCE_ONLY';
          candidate.canFlowDownstream = false;
          candidate.flowBlockReasons = ['SUPERSEDED'];
        }
      }
      version.reviewDecision = String(review.reviewDecision);
      version.projectRightsGate = String(review.appliedProjectRightsGate);
      version.historyRole = 'CURRENT';
      version.lifecycleState = String(review.lifecycleState);
      version.canFlowDownstream = syncApplied;
      version.sourceSyncRequired = review.sourceSyncRequired === true;
      version.sourceSyncState = review.sourceSyncRequired === true ? (syncApplied ? 'SUCCEEDED' : 'PENDING') : 'NOT_REQUIRED';
      version.flowBlockReasons = syncApplied ? [] : ['SOURCE_SYNC_REQUIRED'];
      family.currentVersionId = versionId;
    } else if (action === 'REQUEST_REVISION') {
      version.reviewDecision = String(review.reviewDecision);
      version.projectRightsGate = String(review.appliedProjectRightsGate);
      version.lifecycleState = String(review.lifecycleState);
      version.canFlowDownstream = review.canFlowDownstream === true;
      version.flowBlockReasons = ['REVISION_REQUIRED'];
      version.historyRole = 'CANDIDATE';
      if (family.currentVersionId === versionId) family.currentVersionId = null;
      family.decisionVersionId = versionId;
    } else {
      version.reviewDecision = String(review.reviewDecision);
      version.projectRightsGate = String(review.appliedProjectRightsGate);
      version.lifecycleState = String(review.lifecycleState);
      version.canFlowDownstream = review.canFlowDownstream === true;
      version.flowBlockReasons = ['DO_NOT_USE'];
      version.historyRole = 'EVIDENCE_ONLY';
      if (family.currentVersionId === versionId || !family.currentVersionId) {
        family.currentVersionId = null;
        family.decisionVersionId = versionId;
      }
    }
  }

  // Rights are independent current facts, not review decisions.  A later
  // BLOCKED fact must win even if an older review attested UNKNOWN for internal
  // use or otherwise released the same immutable media bytes.
  for (const version of versions.values()) {
    const currentRightsFact = immutableRightsFacts.get(version.id) || 'UNKNOWN';
    if (currentRightsFact !== 'BLOCKED' && !rightsDriftVersionIds.has(version.id)) continue;
    version.projectRightsGate = currentRightsFact;
    version.lifecycleState = 'RIGHTS_HOLD';
    version.canFlowDownstream = false;
    version.rightsWarning = true;
    version.flowBlockReasons = [...new Set([
      ...(version.flowBlockReasons || []),
      currentRightsFact === 'BLOCKED'
        ? 'CURRENT_RIGHTS_BLOCKED'
        : 'CURRENT_RIGHTS_FACT_CHANGED_REVIEW_REQUIRED',
    ])];
  }

  // Relationship changes invalidate only the recorded versions and their exact descendants.
  // Review events remain immutable; the current usability projection carries the reason.
  const domainInvalidations=((data.productionModel as unknown as Record<string,unknown>).domainInvalidations||[]) as Array<{familyId:string;versionIds:string[]}>;
  applyDomainInvalidations(domainInvalidations,versions);

  for (const family of families.values()) {
    const familyVersions = [...versions.values()].filter((version) => version.familyId === family.id);
    const currentSlotCandidateVersionIds = currentSlotCandidateVersionIdsByFamily.get(family.id) || new Set<string>();
    const rawCurrent = family.currentVersionId ? versions.get(family.currentVersionId) : null;
    const current = rawCurrent && (!family.currentExpectedOutputId || currentSlotCandidateVersionIds.has(rawCurrent.id))
      ? rawCurrent
      : null;
    if (rawCurrent && !current) family.currentVersionId = null;
    const familyVersionsInCurrentSlot = family.currentExpectedOutputId
      ? familyVersions.filter((version) => currentSlotCandidateVersionIds.has(version.id))
      : familyVersions;
    const materializedFallback = [...familyVersionsInCurrentSlot]
      .reverse()
      .find((version) => versionCanProjectAsCurrentDecision(version));
    const latestCandidateEvent = currentCandidates.find((event) => (
      event.familyId === family.id && candidateRealizesCurrentExpectedOutput(data, event)
    ));
    const latestCandidate = latestCandidateEvent ? versions.get(String(latestCandidateEvent.versionId || '')) : null;
    const explicitTerminalDecision = family.decisionVersionId
      && (!family.currentExpectedOutputId || currentSlotCandidateVersionIds.has(family.decisionVersionId))
      ? versions.get(family.decisionVersionId)
      : null;
    const projection = versionCanProjectAsCurrentDecision(latestCandidate)
      ? latestCandidate
      : versionCanProjectAsCurrentDecision(current)
        ? current
        : explicitTerminalDecision?.lifecycleState === 'DO_NOT_USE'
          ? explicitTerminalDecision
          : materializedFallback;
    family.decisionVersionId = projection?.id || null;
    if (projection) Object.assign(family, statusSlice(projection));
    if (!current && projection?.reviewDecision === 'DO_NOT_USE') {
      family.lifecycleState = 'DO_NOT_USE';
      family.canFlowDownstream = false;
      family.flowBlockReasons = ['DO_NOT_USE', 'NO_CURRENT_VERSION'];
      family.historyRole = null;
    }
  }


  // P07 continuity is bound to the exact adopted parent bytes.  Replaying a
  // valid child review must not keep that child flowing after its parent family
  // adopts another version.  Check both the currently adopted and current
  // decision outputs; the family projection follows its current decision.
  const p07SourceOwnerByFamily = new Map<string, WorkItem>();
  for (const item of data.productionModel.workItems) {
    if (item.pipelineStageCode === 'P07' && item.outputAssetRef) {
      p07SourceOwnerByFamily.set(item.outputAssetRef, item);
    }
  }
  for (const [familyId, item] of p07SourceOwnerByFamily) {
    const family = families.get(familyId);
    if (!family) continue;
    const activeVersionIds = [...new Set([
      family.currentVersionId || '',
      family.decisionVersionId || '',
    ].filter(Boolean))];
    const blockersByVersion = new Map<string, P07ReviewBlocker[]>();
    for (const versionId of activeVersionIds) {
      const version = versions.get(versionId);
      if (!version || !versionIsMaterialized(version)) continue;
      const blockers = exactP07ParentBindingBlockers(
        item,
        version,
        p07SourceOwnerByFamily,
        families,
        versions,
      );
      if (!blockers.length) continue;
      blockersByVersion.set(versionId, blockers);
      version.lifecycleState = 'WAITING_UPSTREAM';
      version.canFlowDownstream = false;
      version.flowBlockReasons = [...new Set([
        ...(version.flowBlockReasons || []),
        'UPSTREAM_VERSION_REBASE_REQUIRED',
      ])];
    }
    const projectedVersionId = family.decisionVersionId || family.currentVersionId || '';
    const projectedBlockers = blockersByVersion.get(projectedVersionId) || [];
    if (!projectedBlockers.length) continue;
    family.lifecycleState = 'WAITING_UPSTREAM';
    family.canFlowDownstream = false;
    family.flowBlockReasons = [...new Set([
      ...(family.flowBlockReasons || []),
      'UPSTREAM_VERSION_REBASE_REQUIRED',
    ])];
    family.reviewActionability = 'BLOCKED';
    family.reviewBlockers = projectedBlockers;
    family.reviewFrontier = false;
  }
  let p07PropagationChanged = true;
  while (p07PropagationChanged) {
    p07PropagationChanged = false;
    for (const [familyId, item] of p07SourceOwnerByFamily) {
      const family = families.get(familyId);
      const projectedVersionId = family?.decisionVersionId || family?.currentVersionId || '';
      const projectedVersion = projectedVersionId ? versions.get(projectedVersionId) : null;
      if (!family || !projectedVersion || projectedVersion.canFlowDownstream !== true) continue;
      const blockedByP07Parent = (item.inputAssetRefs || []).some((inputFamilyId) => (
        p07SourceOwnerByFamily.has(inputFamilyId)
        && families.get(inputFamilyId)?.canFlowDownstream !== true
      ));
      if (!blockedByP07Parent) continue;
      projectedVersion.lifecycleState = 'WAITING_UPSTREAM';
      projectedVersion.canFlowDownstream = false;
      projectedVersion.flowBlockReasons = [...new Set([
        ...(projectedVersion.flowBlockReasons || []),
        'UPSTREAM_P07_NOT_FLOWABLE',
      ])];
      family.lifecycleState = 'WAITING_UPSTREAM';
      family.canFlowDownstream = false;
      family.flowBlockReasons = [...new Set([
        ...(family.flowBlockReasons || []),
        'UPSTREAM_P07_NOT_FLOWABLE',
      ])];
      p07PropagationChanged = true;
    }
  }

  const projectedRequestById = new Map(
    projectedExecutionRequests(executionRequests, currentCandidates)
      .map((request) => [String(request.executionRequestId || ''), request]),
  );
  const latestRunsByWorkItem = new Map<string, EventRecord>();
  for (const { event: run } of latestBy(currentRuns, (event) => String(event.runId || ''))) {
    const request = projectedRequestById.get(String(run.executionRequestId || ''));
    if (!request) continue;
    const state = String(run.runState || run.state || 'RESULT_UNKNOWN');
    if (request.snapshotId !== data.snapshotId && state !== 'RESULT_UNKNOWN') continue;
    if (
      run.executionDefinitionId !== request.executionDefinitionId
      || run.callPackageHash !== request.callPackageHash
    ) continue;
    const workItemId = String(request.workItemId || '');
    if (workItemId && !latestRunsByWorkItem.has(workItemId)) latestRunsByWorkItem.set(workItemId, run);
  }
  const calibrationP07SourceItems = data.productionModel.workItems
    .filter((item) => item.pipelineStageCode === 'P07' && item.outputState === 'PRESENT' && item.outputAssetRef);
  const calibrationP07AllReleased = calibrationP07SourceItems.length > 0 && calibrationP07SourceItems.every((item) => (
    item.outputAssetRef ? families.get(item.outputAssetRef)?.canFlowDownstream === true : false
  ));
  const workItems = new Map<string, WorkItem>();
  for (const source of data.productionModel.workItems) {
    const item: WorkItem = { ...source, flowBlockReasons: [...(source.flowBlockReasons || [])] };
    item.executionGate = typeof source.legacyState?.gateStatus === 'string' ? source.legacyState.gateStatus : null;
    if (item.applicabilityState === 'NOT_REQUIRED') {
      Object.assign(item, { lifecycleState: 'NOT_APPLICABLE', canFlowDownstream: true, flowBlockReasons: [] });
    } else if (item.applicabilityState === 'SATISFIED_BY_EXISTING') {
      Object.assign(item, { lifecycleState: 'SATISFIED_BY_EXISTING', canFlowDownstream: true, flowBlockReasons: [] });
    } else if (item.outputAssetRef && families.has(item.outputAssetRef) && (() => {
      const family = families.get(item.outputAssetRef)!;
      const projectedVersionId = family.decisionVersionId || family.currentVersionId || '';
      return Boolean(projectedVersionId && versionIsMaterialized(versions.get(projectedVersionId)));
    })()) {
      const family = families.get(item.outputAssetRef)!;
      Object.assign(item, statusSlice(family));
    } else {
      const latestRun = latestRunsByWorkItem.get(item.id) || null;
      if (latestRun) {
        const state = String(latestRun.runState || latestRun.state || 'RESULT_UNKNOWN');
        item.latestRun = { ...latestRun, state };
        item.outputState = 'NOT_PRODUCED';
        item.lifecycleState = deriveLifecycleState({ outputState: 'NOT_PRODUCED', latestRun: { state } });
        item.canFlowDownstream = false;
        item.flowBlockReasons = [item.lifecycleState];
      }
      if (item.outputState === 'NOT_PRODUCED' && !latestRun) {
        const inputFamilies = (item.inputAssetRefs || []).map((id) => families.get(id)).filter(Boolean) as Array<AssetFamily & StatusProjection>;
        const hasAllDeclaredInputs = inputFamilies.length === (item.inputAssetRefs || []).length;
        const unresolvedWorkRelations = (item.upstreamWorkRelations || [])
          .filter((relation) => relation.resolutionState !== 'RESOLVED');
        const executionDefinitionReady = Boolean(item.outputAssetRef && item.executionDefinitionRef);
        let declaredGateReady = executionDefinitionReady;
        if (item.executionGate === 'HOLD_P07_CALIBRATION') declaredGateReady = executionDefinitionReady && calibrationP07AllReleased;
        if (item.executionGate === 'WAITING_P07_APPROVAL') {
          const p07Item = data.productionModel.workItems.find((candidate) => (
            candidate.pipelineStageCode === 'P07' && candidate.shotId === item.shotId && candidate.outputAssetRef
          ));
          declaredGateReady = executionDefinitionReady && Boolean(p07Item?.outputAssetRef && families.get(p07Item.outputAssetRef)?.canFlowDownstream === true);
        }
        if (item.executionGate === 'WAITING_P14_AND_RELEASE_CONFIG') declaredGateReady = false;
        item.upstreamReadiness = hasAllDeclaredInputs
          && inputFamilies.every((family) => family.canFlowDownstream)
          && unresolvedWorkRelations.length === 0
          && declaredGateReady
          ? 'READY'
          : 'WAITING';
        item.lifecycleState = item.upstreamReadiness === 'READY' ? 'READY_TO_START' : 'WAITING_UPSTREAM';
        item.canFlowDownstream = false;
        item.flowBlockReasons = item.upstreamReadiness === 'READY'
          ? ['OUTPUT_NOT_PRESENT']
          : [
              'WAITING_UPSTREAM',
              ...unresolvedWorkRelations
                .map((relation) => relation.flowBlockReason)
                .filter((reason): reason is string => Boolean(reason)),
            ];
      }
    }
    workItems.set(item.id, item);
  }

  // Work relations are projected after every WorkItem has its event-aware
  // lifecycle.  A static relation state cannot pre-release newly authored P08
  // dialogue work whose current version is still pending review.
  for (const item of workItems.values()) {
    if (!(item.upstreamWorkRelations || []).length) continue;
    const projectedRelations = (item.upstreamWorkRelations || []).map((relation) => {
      const refs = relation.workItemRefs || [];
      const upstreamItems = refs.map((id) => workItems.get(id));
      if (!refs.length || upstreamItems.some((upstream) => !upstream)) {
        return { ...relation, resolutionState: 'WAITING_AUTHORING', flowBlockReason: 'P08_WORK_ITEM_NOT_AUTHORED' };
      }
      if (upstreamItems.every((upstream) => (
        upstream?.pipelineStageCode === 'P08'
        && upstream.lifecycleState === 'RELEASED'
        && upstream.canFlowDownstream === true
      ))) {
        return { ...relation, resolutionState: 'RESOLVED', flowBlockReason: null };
      }
      return { ...relation, resolutionState: 'WAITING_RELEASE', flowBlockReason: 'P08_WORK_ITEM_PENDING_RELEASE' };
    });
    item.upstreamWorkRelations = projectedRelations;
    if (item.outputState !== 'NOT_PRODUCED' || item.latestRun) continue;
    const inputFamilies = (item.inputAssetRefs || []).map((id) => families.get(id)).filter(Boolean) as Array<AssetFamily & StatusProjection>;
    const hasAllDeclaredInputs = inputFamilies.length === (item.inputAssetRefs || []).length;
    const unresolvedRelations = projectedRelations.filter((relation) => relation.resolutionState !== 'RESOLVED');
    const executionDefinitionReady = Boolean(item.outputAssetRef && item.executionDefinitionRef);
    let declaredGateReady = executionDefinitionReady;
    if (item.executionGate === 'HOLD_P07_CALIBRATION') declaredGateReady = executionDefinitionReady && calibrationP07AllReleased;
    if (item.executionGate === 'WAITING_P07_APPROVAL') {
      const p07Item = workItems.get(`STAGE:P07:${item.shotId || ''}`);
      declaredGateReady = executionDefinitionReady && Boolean(p07Item?.outputAssetRef && families.get(p07Item.outputAssetRef)?.canFlowDownstream === true);
    }
    if (item.executionGate === 'WAITING_P14_AND_RELEASE_CONFIG') declaredGateReady = false;
    item.upstreamReadiness = hasAllDeclaredInputs
      && inputFamilies.every((family) => family.canFlowDownstream)
      && unresolvedRelations.length === 0
      && declaredGateReady
      ? 'READY'
      : 'WAITING';
    item.lifecycleState = item.upstreamReadiness === 'READY' ? 'READY_TO_START' : 'WAITING_UPSTREAM';
    item.canFlowDownstream = false;
    item.flowBlockReasons = item.upstreamReadiness === 'READY'
      ? ['OUTPUT_NOT_PRESENT']
      : [
          'WAITING_UPSTREAM',
          ...unresolvedRelations
            .map((relation) => relation.flowBlockReason)
            .filter((reason): reason is string => Boolean(reason)),
        ];
  }

  // REVIEW_PENDING remains the one lifecycle state.  Review actionability is
  // a derived dependency view: a storyboard may exist and await review while
  // still being unsafe to decide before its exact predecessor is released.
  const p07OwnerByFamily = new Map<string, WorkItem>();
  for (const item of workItems.values()) {
    if (item.pipelineStageCode === 'P07' && item.outputAssetRef) p07OwnerByFamily.set(item.outputAssetRef, item);
  }
  const depthMemo = new Map<string, number>();
  const dependencyDepth = (item: WorkItem, visiting = new Set<string>()): number => {
    if (depthMemo.has(item.id)) return depthMemo.get(item.id)!;
    if (visiting.has(item.id)) return 0;
    const nextVisiting = new Set(visiting).add(item.id);
    const parents = (item.inputAssetRefs || []).map((id) => p07OwnerByFamily.get(id)).filter(Boolean) as WorkItem[];
    const depth = parents.length ? 1 + Math.max(...parents.map((parent) => dependencyDepth(parent, nextVisiting))) : 0;
    depthMemo.set(item.id, depth);
    return depth;
  };
  for (const item of workItems.values()) {
    item.reviewDependencyDepth = dependencyDepth(item);
    const hasDependencyInvalidation = (item.flowBlockReasons || []).some((reason) => (
      reason === 'UPSTREAM_VERSION_REBASE_REQUIRED' || reason === 'UPSTREAM_P07_NOT_FLOWABLE'
    ));
    if (
      item.pipelineStageCode !== 'P07'
      || !item.outputAssetRef
      || (item.lifecycleState !== 'REVIEW_PENDING' && !hasDependencyInvalidation)
    ) {
      item.reviewActionability = 'NOT_APPLICABLE';
      item.reviewFrontier = false;
      item.reviewBlockers = [];
      continue;
    }
    const outputFamily = families.get(item.outputAssetRef);
    const outputVersionId = outputFamily?.decisionVersionId || outputFamily?.currentVersionId || '';
    const outputVersion = outputVersionId ? versions.get(outputVersionId) : null;
    const exactBindingBlockers = exactP07ParentBindingBlockers(
      item,
      outputVersion,
      p07OwnerByFamily,
      families,
      versions,
    );
    const blockers = (item.inputAssetRefs || []).flatMap((inputFamilyId) => {
      const upstreamItem = p07OwnerByFamily.get(inputFamilyId);
      if (!upstreamItem) return [];
      const exactBindingBlocker = exactBindingBlockers.find((blocker) => blocker.familyId === inputFamilyId);
      if (exactBindingBlocker) return [exactBindingBlocker];
      const upstreamFamily = families.get(inputFamilyId);
      const currentVersionId = upstreamFamily?.currentVersionId || upstreamFamily?.decisionVersionId || '';
      if (!upstreamFamily || upstreamFamily.canFlowDownstream !== true) {
        const upstreamState = upstreamFamily?.lifecycleState || 'UNKNOWN';
        return [{
          familyId: inputFamilyId,
          workItemId: upstreamItem.id,
          requiredVersionId: currentVersionId || null,
          reasonCode: upstreamState === 'REVISION_REQUIRED'
            ? 'UPSTREAM_REVISION_REQUIRED'
            : upstreamState === 'DO_NOT_USE'
              ? 'UPSTREAM_DO_NOT_USE'
              : 'UPSTREAM_REVIEW_PENDING',
        }];
      }
      return [];
    });
    item.reviewBlockers = blockers;
    item.reviewActionability = blockers.some((blocker) => blocker.reasonCode !== 'UPSTREAM_REVIEW_PENDING')
      ? 'BLOCKED'
      : blockers.length
        ? 'WAITING_DEPENDENCY'
        : 'ACTIONABLE';
    item.reviewFrontier = item.reviewActionability === 'ACTIONABLE';
  }

  const materialWorkItems = new Map<string, WorkItem>();
  for (const source of data.productionModel.materialWorkItems || []) {
    const item: WorkItem = { ...source, flowBlockReasons: [...(source.flowBlockReasons || [])] };
    item.executionGate = source.declaredExecutionGate || null;
    const outputFamily = item.outputAssetRef ? families.get(item.outputAssetRef) : null;
    const projectedOutputVersionId = outputFamily?.decisionVersionId || outputFamily?.currentVersionId || '';
    const projectedOutputVersion = projectedOutputVersionId ? versions.get(projectedOutputVersionId) : null;
    const hasMaterializedOutput = Boolean(
      item.outputAssetRef && projectedOutputVersion && versionIsMaterialized(projectedOutputVersion)
    );
    if (outputFamily && hasMaterializedOutput) {
      Object.assign(item, statusSlice(outputFamily));
    } else {
      const latestRun = latestRunsByWorkItem.get(item.id) || null;
      if (latestRun) {
        const state = String(latestRun.runState || latestRun.state || 'RESULT_UNKNOWN');
        item.latestRun = { ...latestRun, state };
        item.outputState = 'NOT_PRODUCED';
        item.lifecycleState = deriveLifecycleState({ outputState: 'NOT_PRODUCED', latestRun: { state } });
        item.canFlowDownstream = false;
        item.flowBlockReasons = [item.lifecycleState];
      } else {
        const inputFamilies = (item.inputAssetRefs || []).map((id) => families.get(id)).filter(Boolean) as Array<AssetFamily & StatusProjection>;
        const hasAllDeclaredInputs = inputFamilies.length === (item.inputAssetRefs || []).length;
        const executionDefinitionReady = Boolean(item.executionDefinitionRef)
          && item.executionGate !== 'WAITING_EXECUTION_DEFINITION';
        const hardBlocked = /(?:BLOCK|DO_NOT_USE|REJECT|FAIL)/.test(String(item.executionGate || ''));
        const declaredGateReady = executionDefinitionReady
          && !/(?:WAIT|HOLD|BLOCK|DO_NOT_USE|REJECT|FAIL)/.test(String(item.executionGate || ''));
        item.outputState = 'NOT_PRODUCED';
        item.upstreamReadiness = hardBlocked
          ? 'BLOCKED'
          : hasAllDeclaredInputs
            && inputFamilies.every((family) => family.canFlowDownstream)
            && declaredGateReady
            ? 'READY'
            : 'WAITING';
        item.lifecycleState = item.upstreamReadiness === 'BLOCKED'
          ? 'BLOCKED'
          : item.upstreamReadiness === 'READY' ? 'READY_TO_START' : 'WAITING_UPSTREAM';
        item.canFlowDownstream = false;
        item.flowBlockReasons = item.upstreamReadiness === 'BLOCKED'
          ? [String(item.executionGate || 'BLOCKED')]
          : item.upstreamReadiness === 'READY' ? ['OUTPUT_NOT_PRESENT'] : ['WAITING_UPSTREAM'];
      }
    }
    materialWorkItems.set(item.id, item);
  }

  const materialRequirements = new Map<string, Record<string, unknown>>();
  for (const source of data.productionModel.materialRequirements || []) {
    const currentVersions = source.assetFamilyRefs
      .map((familyId) => families.get(familyId))
      .map((family) => family?.currentVersionId ? versions.get(family.currentVersionId) : null)
      .filter(Boolean) as ProjectedVersion[];
    const matchingBindings = currentVersions.flatMap((version) => version.materialRequirementBindings || [])
      .filter((binding) => binding.requirementRef === source.id);
    const bindingStale = currentVersions.length > 0 && !matchingBindings.some(
      (binding) => binding.requirementHash === source.requirementHash,
    );
    const coveredVersions = currentVersions.filter((version) => (
      version.outputState === 'PRESENT'
      && version.lifecycleState === 'RELEASED'
      && version.canFlowDownstream === true
    ));
    const coverageSatisfied = source.requirementClass === 'EVIDENCE_ONLY'
      || (!bindingStale && coveredVersions.length === source.assetFamilyRefs.length);
    const coverageReasons: string[] = [];
    if (source.requirementClass === 'EVIDENCE_ONLY') coverageReasons.push('EVIDENCE_ONLY_REQUIREMENT');
    if (source.isNewRequirement === true) coverageReasons.push('NEW_REQUIRED');
    if (!currentVersions.length && source.isNewRequirement !== true) coverageReasons.push('CURRENT_ASSET_VERSION_UNRESOLVED');
    if (bindingStale) coverageReasons.push('REQUIREMENT_HASH_VERSION_BINDING_STALE');
    const coveredFamilyIds = new Set(coveredVersions.map((version) => version.familyId));
    coverageReasons.push(...source.assetFamilyRefs.filter((familyId) => !coveredFamilyIds.has(familyId)).map((familyId) => `UNCOVERED_ASSET_FAMILY:${familyId}`));
    materialRequirements.set(source.id, {
      ...source,
      coverageSatisfied,
      bindingStale,
      coverageReasons: [...new Set(coverageReasons)],
      coveredByFamilyRefs: [...coveredFamilyIds],
      coveredByVersionRefs: coveredVersions.map((version) => version.id),
      materialWorkItemLifecycleState: source.materialWorkItemRef
        ? materialWorkItems.get(String(source.materialWorkItemRef))?.lifecycleState || 'UNKNOWN'
        : 'NOT_APPLICABLE',
    });
  }

  const workPackages = new Map<string, WorkPackage & StatusProjection>();
  for (const source of data.productionModel.workPackages) {
    const packageItems = (source.workItemRefs || []).map((id) => workItems.get(id)).filter(Boolean) as WorkItem[];
    workPackages.set(source.id, { ...source, ...aggregateLifecycle(packageItems) });
  }

  const shots = new Map<string, { id: string } & StatusProjection>();
  for (const source of data.productionModel.shots || []) {
    const packages = (source.workPackageRefs || []).map((id) => workPackages.get(id)).filter(Boolean) as Array<WorkPackage & StatusProjection>;
    shots.set(source.id, { id: source.id, ...aggregateLifecycle(packages) });
  }
  const scenes = new Map<string, { id: string } & StatusProjection>();
  for (const source of data.productionModel.scenes || []) {
    const children = (source.shotIds || []).map((id) => shots.get(id)).filter(Boolean) as Array<{ id: string } & StatusProjection>;
    scenes.set(source.id, { id: source.id, ...aggregateLifecycle(children) });
  }
  const episodes = new Map<string, { id: string } & StatusProjection>();
  for (const source of data.productionModel.episodes || []) {
    const children = (source.sceneIds || []).map((id) => scenes.get(id)).filter(Boolean) as Array<{ id: string } & StatusProjection>;
    episodes.set(source.id, { id: source.id, ...aggregateLifecycle(children) });
  }

  const calibrationP07 = [...workItems.values()].filter((item) => item.pipelineStageCode === 'P07' && item.outputState === 'PRESENT');
  const calibrationShotIds = new Set(calibrationP07.map((item) => item.shotId).filter(Boolean) as string[]);
  const calibrationSceneIds = new Set(calibrationP07.map((item) => item.sceneId).filter(Boolean) as string[]);
  const calibrationP09 = [...workItems.values()].filter((item) => item.pipelineStageCode === 'P09' && item.sceneId && calibrationSceneIds.has(item.sceneId));
  const calibrationP12 = [...calibrationShotIds].map((shotId) => (
    [...workItems.values()].find((item) => item.shotId === shotId && item.pipelineStageCode === 'P12')
    || [...workItems.values()].find((item) => item.shotId === shotId && item.pipelineStageCode === 'P11')
  )).filter(Boolean) as WorkItem[];
  const finalReview = [...workItems.values()].filter((item) => item.pipelineStageCode === 'P15');
  const reviewRollups = {
    P07: makeReviewRollup('P07', calibrationP07),
    P09: makeReviewRollup('P09', calibrationP09),
    P12: makeReviewRollup('P12', calibrationP12),
    P15: makeReviewRollup('P15', finalReview),
  };
  const reviewCorrectionByVersion = new Map<string, ReviewCorrectionProjection>(
    effectiveMediaReviews.filter((review) => review.subjectType === 'ASSET').map((review) => [
      String(review.versionId || ''),
      reviewCorrectionProjection(
        data,
        review,
        currentCandidates,
        effectiveMediaReviews,
        executionRequests,
        runs,
        sourceOperations,
        assetChainIssuesByTarget.get(mediaReviewTargetKey(review)) || [],
      ),
    ]),
  );
  for (const [targetKey, chainIssues] of assetChainIssuesByTarget) {
    const [subjectType, familyId, versionId, versionSha256] = targetKey.split('::');
    if (subjectType !== 'ASSET' || !familyId || !versionId || !versionSha256 || reviewCorrectionByVersion.has(versionId)) continue;
    const version = versions.get(versionId);
    if (!version || version.familyId !== familyId || String(version.sha256 || '').toLowerCase() !== versionSha256) continue;
    reviewCorrectionByVersion.set(versionId, {
      mode: 'APPEND_ONLY_SUPERSESSION',
      state: 'UNKNOWN',
      headEventId: '',
      headAction: '',
      lockReasons: chainIssues,
    });
  }

  return {
    schemaVersion: '2.0',
    source: 'BASE_SNAPSHOT_PLUS_APPLIED_EVENTS',
    appliedReviewEventCount: applicableReviews.length,
    assetVersionsById: Object.fromEntries([...versions].map(([id, version]) => [id, {
      id,
      familyId: version.familyId,
      path: version.path,
      sha256: version.sha256,
      label: version.label,
      mediaToken: version.mediaToken,
      inputVersionBindings: version.inputVersionBindings || [],
      expectedOutputId: version.expectedOutputId || null,
      realizes: version.realizes || null,
      reviewContextHash: version.sha256 ? assetReviewContextHash(data, version.familyId, id, version.sha256) : null,
      reviewCorrection: reviewCorrectionByVersion.get(id) || null,
      ...statusSlice(version),
    }])),
    assetFamiliesById: Object.fromEntries([...families].map(([id, family]) => [id, {
      id,
      domainContextHash: (family as unknown as Record<string,{hash?:string}>).domainContext?.hash || null,
      currentVersionId: family.currentVersionId || null,
      adoptedVersionId: family.currentVersionId || null,
      decisionVersionId: family.decisionVersionId || family.currentVersionId || null,
      candidateVersionId: family.decisionVersionId
        && family.decisionVersionId !== family.currentVersionId
        && versions.get(family.decisionVersionId)?.historyRole === 'CANDIDATE'
        ? family.decisionVersionId
        : null,
      currentExpectedOutputId: family.currentExpectedOutputId && !expectedOutputRealizations.has(family.currentExpectedOutputId)
        ? family.currentExpectedOutputId
        : null,
      realizedExpectedOutputIds: (family.expectedOutputRefs || []).filter((expectedId) => expectedOutputRealizations.has(expectedId)),
      versionRefs: family.versionRefs || [],
      ...statusSlice(family),
    }])),
    expectedOutputsById: Object.fromEntries(expectedOutputRealizations),
    workItemsById: Object.fromEntries([...workItems].map(([id, item]) => [id, {
      ...statusSlice(item),
      additionalOutputAssetRefs: item.additionalOutputAssetRefs || [],
    }])),
    materialWorkItemsById: Object.fromEntries([...materialWorkItems].map(([id, item]) => [id, statusSlice(item)])),
    materialRequirementsById: Object.fromEntries(materialRequirements),
    materialStoryRelations: data.productionModel.materialStoryRelations
      ? { ...data.productionModel.materialStoryRelations }
      : undefined,
    workPackagesById: Object.fromEntries([...workPackages].map(([id, item]) => [id, statusSlice(item)])),
    shotsById: Object.fromEntries([...shots].map(([id, item]) => [id, statusSlice(item)])),
    scenesById: Object.fromEntries([...scenes].map(([id, item]) => [id, statusSlice(item)])),
    episodesById: Object.fromEntries([...episodes].map(([id, item]) => [id, statusSlice(item)])),
    reviewRollups,
  };
}

export async function currentExecutionRuntime():Promise<ExecutionRuntime|null>{
 if(hostedReadOnlyMode()||!instanceRepositoryMode())return null;
 const repository=(await instanceRepository())!;const metadata=await repository.getMetadata();return {instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch};
}

async function buildOperationalSnapshot() {
  const base = !hostedReadOnlyMode() && instanceRepositoryMode() ? await publishedView((await instanceRepository())!) : null;
  const data = base ? (dataCache&&dataCacheFingerprint===base.dataFingerprint?dataCache:normalizeReviewSnapshot(base.snapshot as ReviewData)) : await reviewData();
  if(base){bindInstanceSourceRoles(instanceProfile(data));dataCache=data;dataCacheFingerprint=base.dataFingerprint;}
  const executionRuntime=base?{instanceId:base.instanceId,runtimeEpoch:base.runtimeEpoch}:null;
  const verifiedDataFingerprint = base?.dataFingerprint || dataCacheFingerprint;
  const gateCatalog = base ? base.recipes as RecipeCatalog : await recipeCatalog();
  const verifiedRecipeFingerprint = base?.recipeFingerprint || recipeCacheFingerprint;
  const [reviews, episodePlanSubmissions, candidates, runs, creativeRevisions, executionRequests, sourceOperations, verifications, scriptCommentEvents] = await Promise.all([
    listAllEvents('review'),
    listAllEvents('episode-plan-submission'),
    listAllEvents('asset-version'),
    listAllEvents('run'),
    listAllEvents('creative-revision'),
    listAllEvents('execution-request'),
    listAllEvents('source-operation'),
    listAllEvents('verification'),
    listAllEvents('script-comment'),
  ]);
  const orderedForHash = [
    ...reviews,
    ...episodePlanSubmissions,
    ...candidates,
    ...runs,
    ...creativeRevisions,
    ...executionRequests,
    ...sourceOperations,
    ...verifications,
    ...scriptCommentEvents,
  ].sort((a, b) => {
    const byKind = String(a.eventKind).localeCompare(String(b.eventKind));
    return byKind || String(a.eventId).localeCompare(String(b.eventId));
  });
  if (!base) {
    await reviewData(); await recipeCatalog();
    if(dataCacheFingerprint !== verifiedDataFingerprint || recipeCacheFingerprint !== verifiedRecipeFingerprint) throw new HttpError(503,'review runtime changed while reading');
  }
  const digest = createHash('sha256').update(canonicalJson({
    baseSnapshotId: data.snapshotId,
    dataFingerprint: verifiedDataFingerprint,
    recipeFingerprint: verifiedRecipeFingerprint,
    events: orderedForHash,
  })).digest('hex');
  const operationRevision = `OP-${orderedForHash.length}-${digest.slice(0, 24)}`;
  const etagValue = `${data.snapshotId}--${operationRevision}`;
  const mutationEtag = quoteEtag(etagValue);
  const reviewsByWorkItem = latestBy(reviews, (event) => String(event.workItemId || ''));
  const reviewsByWorkItemVersion = latestBy(reviews, (event) => event.workItemId && event.versionId ? `${event.workItemId}::${event.versionId}` : '');
  const reviewsBySubject = latestBy(reviews, (event) => {
    const binding = reviewSubjectBinding(event);
    return binding.subjectType && binding.subjectId ? `${binding.subjectType}::${binding.subjectId}` : '';
  });
  const reviewsBySubjectRevision = latestBy(reviews, (event) => {
    const binding = reviewSubjectBinding(event);
    return binding.subjectType && binding.subjectId && binding.subjectRevisionHash
      ? `${binding.subjectType}::${binding.subjectId}::${binding.subjectRevisionHash}`
      : '';
  });
  const reviewsBySubjectContext = latestBy(reviews, (event) => {
    const binding = reviewSubjectBinding(event);
    return binding.subjectType && binding.subjectId && binding.subjectRevisionHash && binding.contextHash
      ? `${binding.subjectType}::${binding.subjectId}::${binding.subjectRevisionHash}::${binding.contextHash}`
      : '';
  });
  const candidatesByFamily = latestBy(candidates, (event) => String(event.familyId || ''));
  const runsByDefinition = latestBy(runs, (event) => String(event.executionDefinitionId || ''));
  const runsByRunId = latestBy(runs, (event) => String(event.runId || ''));
  const creativeRevisionsBySubject = latestBy(creativeRevisions, (event) => (
    event.subjectKind && event.subjectId ? `${event.subjectKind}::${event.subjectId}` : ''
  ));
  const creativeRevisionsById = latestBy(creativeRevisions, (event) => String(event.creativeRevisionId || event.revisionId || ''));
  const projectedRequests = projectedExecutionRequests(executionRequests, candidates);
  const currentProjectedRequests = projectedRequests.filter((event) => event.snapshotId === data.snapshotId);
  const executionRequestsById = latestBy(currentProjectedRequests, (event) => String(event.executionRequestId || ''));
  const executionRequestsByWorkItem = latestBy(currentProjectedRequests, (event) => String(event.workItemId || ''));
  const sourceOperationsById = latestBy(sourceOperations, (event) => String(event.sourceOperationId || ''));
  const applicableVerifications = applicableVerificationEvents(data, verifications);
  const verificationsByIssue = latestBy([...applicableVerifications].reverse(), (event) => String(event.issueId || event.subjectId || ''));
  const scriptCommentThreads = projectScriptCommentEvents(scriptCommentEvents);
  const mediaStateProjection = projectOperationalState(data, reviews, candidates, runs, sourceOperations, executionRequests);
  const projectedReviews = projectedReviewIndexes(data, reviews, candidates, sourceOperations);
  const scriptScenesById = Object.fromEntries(
    projectedReviews.bySubject
      .filter(({ event }) => event.subjectType === 'SCRIPT_SCENE')
      .map(({ projection, event }) => [String(event.subjectId || ''), {
        ...projection,
        subjectId: String(event.subjectId || ''),
        subjectRevisionHash: String(event.subjectRevisionHash || ''),
        contextHash: String(event.businessContextHash || event.contextHash || ''),
        source: 'APPLIED_SCRIPT_SCENE_REVIEW_EVENT_PROJECTION',
      }]),
  );
  const episodeNarrativeReleasesByUid = projectEpisodeNarrativeReleases(data, creativeRevisions, reviews, episodePlanSubmissions, sourceOperations);
  const creativeBasisState = { ...mediaStateProjection, scriptScenesById, episodeNarrativeReleasesByUid };
  const prerequisiteStructureReviews = projectedStructureReviewIndexes(
    data,
    reviews.filter((event) => event.subjectKind !== 'SHOT_PLAN_SET'),
    creativeRevisions,
    sourceOperations,
    creativeBasisState,
  );
  const prerequisiteStructuresById = Object.fromEntries(
    prerequisiteStructureReviews.bySubject.map(({ aggregateId, projection, event }) => [
      aggregateId,
      {
        ...projection,
        subjectId: String(event.subjectId || ''),
        contextHash: String(event.contextHash || ''),
        source: 'APPLIED_CREATIVE_REVISION_REVIEW_EVENT_PROJECTION',
      },
    ]),
  );
  const prerequisiteScopeLocksById = projectedScopeLocks(data, prerequisiteStructuresById);
  const completeCreativeBasisState = {
    ...creativeBasisState,
    structuresById: prerequisiteStructuresById,
    scopeLocksById: prerequisiteScopeLocksById,
  };
  const projectedStructureReviews = projectedStructureReviewIndexes(
    data,
    reviews,
    creativeRevisions,
    sourceOperations,
    completeCreativeBasisState,
  );
  const structuresById = Object.fromEntries(projectedStructureReviews.bySubject.map(({ aggregateId, projection, event }) => [
    aggregateId,
    {
      ...projection,
      subjectId: String(event.subjectId || ''),
      contextHash: String(event.contextHash || ''),
      source: 'APPLIED_CREATIVE_REVISION_REVIEW_EVENT_PROJECTION',
    },
  ]));
  const scopeLocksById = projectedScopeLocks(data, structuresById);
  const storyHandoff = projectStoryHandoff(data, structuresById, scriptScenesById, episodeNarrativeReleasesByUid);
  gateShotPlanDerivedOperationalProjection(
    data,
    mediaStateProjection,
    structuresById,
    scopeLocksById,
  );
  const stateProjection = {
    ...mediaStateProjection,
    domainReferenceTargets: data.productionModel.domainReferenceTargets || {},
    domainReferenceRules: ((data.productionModel as unknown as Record<string,unknown>).domainReferenceRules||[]) as Array<Record<string,unknown>>,
    configuredGatesByWorkItem:{} as Record<string,ConfiguredGate>,
    executionGatesByWorkItem:{} as Record<string,string[]>,
    appliedStructureReviewEventCount: applicableStructureReviewEvents(
      data,
      reviews,
      creativeRevisions,
      sourceOperations,
      completeCreativeBasisState,
    ).length,
    structuresById,
    scopeLocksById,
    scriptScenesById,
    episodeNarrativeReleasesByUid,
    storyHandoff,
    verificationsByIssue: Object.fromEntries(verificationsByIssue.map(({ aggregateId, event }) => [aggregateId, {
      outcome: String(event.outcome || ''),
      note: String(event.note || ''),
      correctedText: String(event.correctedText || ''),
      audioSha256: String(event.audioSha256 || ''),
      timecodeStart: String(event.timecodeStart || ''),
      timecodeEnd: String(event.timecodeEnd || ''),
      currentTextHash: String(event.currentTextHash || ''),
      businessContextHash: String(event.businessContextHash || event.contextHash || ''),
      applicabilityState: 'CURRENT',
      eventId: String(event.eventId || ''),
      recordedAt: String(event.recordedAt || ''),
    }])),
    scriptCommentsById: Object.fromEntries(scriptCommentThreads.map((comment) => [comment.commentId, comment])),
  };
  const executionRequestByMaterialItem = new Map(
    executionRequestsByWorkItem.map(({ aggregateId, event }) => [aggregateId, event]),
  );
  const materialRequirementClassByItem = new Map(
    (data.productionModel.materialWorkItems || []).map((item) => {
      const requirement = (data.productionModel.materialRequirements || [])
        .find((candidate) => candidate.id === item.requirementRef);
      return [item.id, String(requirement?.requirementClass || 'REQUIRED')];
    }),
  );
  const materialWorkItemById = new Map(
    (data.productionModel.materialWorkItems || []).map((item) => [item.id, item]),
  );
  for (const [workItemId, projection] of Object.entries(stateProjection.materialWorkItemsById || {})) {
    const request = executionRequestByMaterialItem.get(workItemId);
    const requestState = request ? String(request.requestState || request.status || '') : null;
    const sourceItem = materialWorkItemById.get(workItemId);
    const requirement=(data.productionModel.materialRequirements||[]).find(r=>r.id===sourceItem?.requirementRef);
    Object.assign(projection, projectMaterialCreatorStage({
      lifecycleState: String(projection.lifecycleState || 'UNKNOWN'),
      executionRequestState: requestState,
      requirementClass: materialRequirementClassByItem.get(workItemId) || 'REQUIRED',
      coverageSatisfied:typeof requirement?.coverageSatisfied==='boolean'?requirement.coverageSatisfied:undefined,bindingStale:requirement?.bindingStale===true,
      flowBlockReasons: projection.flowBlockReasons,
      executionBlockReasons: sourceItem?.executionBlockReasons,
      executionGate: projection.executionGate || sourceItem?.declaredExecutionGate,
    }));
  }
  const p07Rollup = stateProjection.reviewRollups.P07;
  const releasedP07WorkItemIds = p07Rollup.targetWorkItemIds.filter((id) => {
    const item = stateProjection.workItemsById[id];
    return item?.reviewDecision === 'RELEASED' && item.canFlowDownstream === true;
  });
  const releasedP07WorkItemSet = new Set(releasedP07WorkItemIds);
  const releasedP07VersionIds = data.productionModel.workItems
    .filter((item) => releasedP07WorkItemSet.has(item.id) && item.outputAssetRef)
    .map((item) => item.outputAssetRef ? stateProjection.assetFamiliesById[item.outputAssetRef]?.currentVersionId || '' : '')
    .filter(Boolean);
  const p07Released = {
    reviewableWorkItems: p07Rollup.required,
    releasedWorkItems: p07Rollup.released,
    remainingWorkItems: p07Rollup.required - p07Rollup.released,
    allReleased: p07Rollup.required > 0 && p07Rollup.required === p07Rollup.released,
    reviewableWorkItemIds: p07Rollup.targetWorkItemIds,
    releasedWorkItemIds: releasedP07WorkItemIds,
    releasedVersionIds: releasedP07VersionIds,
    source: p07Rollup.source,
  };
  stateProjection.configuredGatesByWorkItem=configuredGates(data.productionModel as unknown as Record<string,unknown>,stateProjection);
  for(const work of [...data.productionModel.workItems,...(data.productionModel.materialWorkItems||[])]){
    const definition=gateCatalog.executionDefinitions.find(d=>d.id===work.executionDefinitionRef);
    const upload=(definition?.upload||{}) as {items?:Array<Record<string,unknown>>};const uploads=upload.items||[];
    stateProjection.executionGatesByWorkItem[work.id]=definition?executionEligibilityReasons({stateProjection,p07Released},definition,{workItemId:work.id,familyId:work.outputAssetRef,inputBindings:uploads.map(b=>({...b,sha256:stateProjection.assetVersionsById[String(b.assetVersionRef)]?.sha256}))}):['EXECUTION_DEFINITION_NOT_READY'];
  }
  return {
    executionRuntime,
    schemaVersion: '2.1',
    snapshotId: data.snapshotId,
    baseSnapshotId: data.snapshotId,
    operationRevision,
    operationalRevision: operationRevision,
    etagValue,
    etag: mutationEtag,
    mutationEtag,
    counts: {
      reviews: reviews.length,
      episodePlanSubmissions: episodePlanSubmissions.length,
      candidates: candidates.length,
      runs: runs.length,
      creativeRevisions: creativeRevisions.length,
      executionRequests: executionRequests.length,
      sourceOperations: sourceOperations.length,
      verifications: verifications.length,
      scriptComments: scriptCommentEvents.length,
      scriptCommentThreads: scriptCommentThreads.length,
      total: orderedForHash.length,
    },
    reviews: {
      events: reviews,
      latestByWorkItem: reviewsByWorkItem,
      latestByWorkItemVersion: reviewsByWorkItemVersion,
      latestBySubject: reviewsBySubject,
      latestBySubjectRevision: reviewsBySubjectRevision,
      latestBySubjectContext: reviewsBySubjectContext,
      projectedByVersion: projectedReviews.byVersion,
      projectedByAssetVersion: projectedReviews.byAssetVersion,
      projectedByWorkItem: projectedReviews.byWorkItem,
      projectedBySubject: projectedReviews.bySubject,
      projectedStructureByRevision: projectedStructureReviews.byRevision,
      projectedStructureBySubject: projectedStructureReviews.bySubject,
    },
    episodePlanSubmissions: { events: episodePlanSubmissions },
    projectedReviews: { ...projectedReviews, structure: projectedStructureReviews, p07Released },
    p07Released,
    candidates: { events: candidates, latestByFamily: candidatesByFamily },
    runs: { events: runs, latestByDefinition: runsByDefinition, latestByRunId: runsByRunId },
    creativeRevisions: { events: creativeRevisions, latestBySubject: creativeRevisionsBySubject, latestById: creativeRevisionsById },
    executionRequests: {
      events: executionRequests,
      projected: projectedRequests,
      current: currentProjectedRequests,
      latestById: executionRequestsById,
      latestByWorkItem: executionRequestsByWorkItem,
    },
    sourceOperations: { events: sourceOperations, latestById: sourceOperationsById },
    verifications: { events: verifications, applicable: applicableVerifications, latestByIssue: verificationsByIssue },
    // Keep the full closed-history index server-side; snapshot JSON must not serialize it.
    scriptComments: Object.defineProperty({ events: visibleScriptCommentEvents(scriptCommentEvents), threads: scriptCommentThreads }, 'closedHistory', {value:closedScriptCommentHistory(scriptCommentEvents),enumerable:false}) as {events:EventRecord[];threads:ScriptCommentProjection[];closedHistory:ReturnType<typeof closedScriptCommentHistory>},
    stateProjection,
    events: { reviews, episodePlanSubmissions, candidates, runs, creativeRevisions, executionRequests, sourceOperations, verifications, scriptComments: visibleScriptCommentEvents(scriptCommentEvents) },
    latest: {
      reviewsByWorkItem,
      reviewsByTargetVersion: reviewsByWorkItemVersion,
      reviewsBySubject,
      reviewsBySubjectRevision,
      reviewsBySubjectContext,
      candidatesByFamily,
      runsByDefinition,
      runsByRunId,
      creativeRevisionsBySubject,
      creativeRevisionsById,
      executionRequestsById,
      executionRequestsByWorkItem,
      sourceOperationsById,
      verificationsByIssue,
    },
  };
}

const operationsCache = new Map<string, Promise<Awaited<ReturnType<typeof buildOperationalSnapshot>>>>();
export async function operationalSnapshot(): Promise<Awaited<ReturnType<typeof buildOperationalSnapshot>>> {
  if (!hostedReadOnlyMode() && instanceRepositoryMode()) {
    const repository = (await instanceRepository())!;
    // Mutations always validate their own transaction; uncommitted projections never enter the shared cache.
    if (repository.transactionMode==='WRITE') return buildOperationalSnapshot();
    return repository.readTransaction(async () => {
      const meta = await repository.getMetadata();
      const key = `${meta.instanceId}:${meta.runtimeEpoch}:${meta.releaseId}:${meta.eventSequence}`;
      let pending = operationsCache.get(key);
      if(!pending){pending=buildOperationalSnapshot();operationsCache.set(key,pending);pending.catch(()=>operationsCache.delete(key));if(operationsCache.size>3)operationsCache.delete(operationsCache.keys().next().value!);}
      return pending;
    });
  }
  return buildOperationalSnapshot();
}

async function acquireMutationLock(root: string) {
  const lockPath = path.join(root, '.mutation.lock');
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      await handle.sync();
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30_000) await unlink(lockPath);
      } catch (lockReason) {
        if ((lockReason as NodeJS.ErrnoException).code !== 'ENOENT') throw lockReason;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new HttpError(503, 'event store is busy; retry the request');
}

async function existingIdempotentEvent(filePath: string, requestHash: string) {
  try {
    const existing = await eventFromPath(filePath);
    if (existing.requestHash !== requestHash) {
      throw new HttpError(409, 'Idempotency-Key was already used with a different request body', {
        existingEventId: existing.eventId,
      });
    }
    return existing;
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw reason;
  }
}

export async function replayIdempotentEvent(kind: EventKind, idempotencyKey: string, rawRequestHash: string) {
  if (instanceReadOnlyMode()) throw new HttpError(405, 'This instance is read-only');
  if (hostedReadOnlyMode()) {
    throw new HttpError(405, 'chatgpt.site is a read-only mirror; mutation replay is unavailable');
  }
  if (instanceRepositoryMode()) {
    const repository = (await instanceRepository())!;
    const existing = (await repository.findIdempotentEvent(kind, idempotencyKey)) as EventRecord | null;
    if (!existing || typeof existing.rawRequestHash !== 'string') return null;
    if (existing.rawRequestHash !== rawRequestHash) throw new HttpError(409, 'Idempotency-Key was already used with a different request body', { existingEventId: existing.eventId });
    return { event: existing, replayed: true as const, operations: await operationalSnapshot() };
  }
  const root = eventStorePath();
  const keyHash = createHash('sha256').update(`${kind}:${idempotencyKey}`).digest('hex');
  const filePath = path.join(root, `${kind}-${keyHash}.json`);
  let existing: EventRecord;
  try {
    existing = await eventFromPath(filePath);
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw reason;
  }
  if (typeof existing.rawRequestHash !== 'string') return null;
  if (existing.rawRequestHash !== rawRequestHash) {
    throw new HttpError(409, 'Idempotency-Key was already used with a different request body', {
      existingEventId: existing.eventId,
    });
  }
  return { event: existing, replayed: true as const, operations: await operationalSnapshot() };
}

export async function appendEvent(
  kind: EventKind,
  idempotencyKey: string,
  requestHash: string,
  expectedEtag: string,
  payload: Record<string, unknown>,
  eventSchemaVersion = '1.1',
  validateLocked?: (snapshot: Awaited<ReturnType<typeof operationalSnapshot>>) => void | Promise<void>,
) {
  if (instanceReadOnlyMode()) throw new HttpError(405, 'This instance is read-only');
  if (hostedReadOnlyMode()) {
    throw new HttpError(405, 'chatgpt.site is a read-only mirror; event writes are unavailable');
  }
  if (instanceRepositoryMode()) {
    const repository = (await instanceRepository())!;
    return repository.writeTransaction(async (tx) => {
      const existing = (await tx.findIdempotentEvent(kind, idempotencyKey)) as EventRecord | null;
      if (existing) {
        if (existing.requestHash !== requestHash) throw new HttpError(409, 'Idempotency-Key was already used with a different request body', { existingEventId: existing.eventId });
        return { event: existing, replayed: true, operations: await operationalSnapshot() };
      }
      const before = await operationalSnapshot();
      if (expectedEtag !== before.etagValue) throw new HttpError(412, 'operational snapshot mismatch', {
        currentEtag: before.etag, mutationEtag: before.mutationEtag, baseSnapshotId: before.baseSnapshotId,
        operationRevision: before.operationRevision, operationalRevision: before.operationalRevision,
      });
      if (validateLocked) await validateLocked(before);
      const result = (await tx.appendEvent({ kind, idempotencyKey, requestHash, payload, eventSchemaVersion }));
      if (kind === 'creative-revision' && payload.subjectKind === 'EPISODE_PLAN') {
        const candidate = result.event as EventRecord;
        const data = await reviewData();
        const inherited = automaticEpisodeSubmissions(candidate,
          [candidate, ...before.creativeRevisions.events], before.episodePlanSubmissions.events,
          candidateReviewSpec(data, candidate), data.snapshotId);
        const candidates = [candidate, ...before.creativeRevisions.events];
        const submissions = [...before.episodePlanSubmissions.events];
        for (const submission of inherited) {
          const carried = (await tx.appendEvent(submission)).event as EventRecord;
          submissions.push(carried);
          assertEpisodeSubmissionBindings(carried, candidate, String(carried.episodeUid));
          assertEpisodeSubmissionInput(carried, candidate, candidates, submissions);
        }
      }
      if (kind === 'asset-version') {
        (await tx.registerMedia({
          mediaId: assertString(payload.familyId, 'familyId'),
          versionId: assertString(payload.versionId, 'versionId'),
          relativePath: instanceCandidateRelativePath(assertString(payload.path, 'path')),
          sha256: assertSha256(payload.sha256, 'sha256'),
          byteSize: Number(payload.byteSize),
          aliases: [String(payload.versionId), String(payload.path)],
          metadata: { authorityDomain: 'FORMAL', registrationEventId: result.event.eventId },
        }));
      }
      return { event: result.event as EventRecord, replayed: result.replayed, operations: await operationalSnapshot() };
    });
  }
  const root = eventStorePath();
  await mkdir(root, { recursive: true });
  const release = await acquireMutationLock(root);
  try {
    const keyHash = createHash('sha256').update(`${kind}:${idempotencyKey}`).digest('hex');
    const filePath = path.join(root, `${kind}-${keyHash}.json`);
    const existing = await existingIdempotentEvent(filePath, requestHash);
    if (existing) return { event: existing, replayed: true, operations: await operationalSnapshot() };

    const before = await operationalSnapshot();
    if (expectedEtag !== before.etagValue) {
      throw new HttpError(412, 'operational snapshot mismatch', {
        currentEtag: before.etag,
        mutationEtag: before.mutationEtag,
        baseSnapshotId: before.baseSnapshotId,
        operationRevision: before.operationRevision,
        operationalRevision: before.operationalRevision,
      });
    }
    if (validateLocked) await validateLocked(before);

    const event: EventRecord = {
      schemaVersion: eventSchemaVersion,
      eventId: `evt_${randomUUID()}`,
      eventKind: kind,
      idempotencyKeyHash: keyHash,
      requestHash,
      recordedAt: new Date().toISOString(),
      ...payload,
      eventSequence: before.counts.total + 1,
    };
    const tempPath = path.join(root, `.${kind}-${keyHash}.${randomUUID()}.tmp`);
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(event, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    try {
      const directory = await open(root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      // Some platforms do not support fsync on directories; the file itself is synced.
    }
    return { event, replayed: false, operations: await operationalSnapshot() };
  } finally {
    await release();
  }
}

export function generatedRootPath() {
  if (instanceRepositoryMode()) {
    if (!process.env.REVIEW_INSTANCE_ROOT) throw new HttpError(503, 'Instance media requires an explicit instance root');
    return path.resolve(process.env.REVIEW_INSTANCE_ROOT, 'media');
  }
  requireLegacyFixtureMode();
  return process.env.GENERATED_ASSET_ROOT || path.resolve(localReviewRoot(), '..', 'production', 'generated');
}

function isWithin(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function safeInstanceMediaPath(relativePath: string) {
  if (!process.env.REVIEW_INSTANCE_ROOT) throw new HttpError(503, 'Instance media requires an explicit instance root');
  if (!relativePath.startsWith('media/') || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) throw new HttpError(400, 'Media must remain inside the instance media directory');
  const root = await realpath(process.env.REVIEW_INSTANCE_ROOT);
  let current = root;
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new HttpError(400, 'Symbolic links are not allowed in instance media paths');
  }
  const resolved = await realpath(current);
  if (!isWithin(path.join(root, 'media'), resolved) || !(await lstat(resolved)).isFile()) throw new HttpError(400, 'Instance media must be a regular confined file');
  return resolved;
}

const verifiedInstanceMedia = new Map<string, string>();
function mediaFileFingerprint(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

export async function safeGeneratedPath(projectPath: string, binding: { versionId?: string; sha256?: string } = {}) {
  if (instanceRepositoryMode() && !hostedReadOnlyMode()) {
    const registered = await Promise.resolve().then(async () => (await instanceRepository())!.resolveMedia(projectPath, binding)).catch((reason:unknown)=>{
      const retired=reason as {code?:string};
      if(retired.code==='MEDIA_PURGED'||retired.code==='MEDIA_RETIRED')throw new HttpError(retired.code==='MEDIA_PURGED'?410:409,'历史媒体已清理；版本、原审阅与审计记录保留');
      throw reason;
    });
    if (!registered || registered.availability !== 'PRESENT' || !registered.relativePath) throw new HttpError(404, 'Registered instance media is unavailable');
    const resolved = await safeInstanceMediaPath(registered.relativePath);
    const key = JSON.stringify([resolved, registered.versionId, registered.sha256, registered.byteSize]);
    const info = await lstat(resolved);
    const fingerprint = mediaFileFingerprint(info);
    if (info.isFile() && !info.isSymbolicLink() && verifiedInstanceMedia.get(key) === fingerprint) return resolved;
    // A changed or invalid file must not retain the earlier successful cache entry.
    verifiedInstanceMedia.delete(key);
    const actual = await hashStableFile(resolved);
    if (actual.sha256 !== registered.sha256 || actual.size !== registered.byteSize) throw new HttpError(409, 'Instance media no longer matches its registered SHA-256 and byte size');
    if (verifiedInstanceMedia.size >= 1024) verifiedInstanceMedia.delete(verifiedInstanceMedia.keys().next().value!);
    verifiedInstanceMedia.set(key, mediaFileFingerprint(actual));
    return resolved;
  }
  const prefix = 'production/generated/';
  if (!projectPath.startsWith(prefix) || projectPath === prefix) throw new HttpError(400, 'path must stay under production/generated');
  const relativePath = projectPath.slice(prefix.length);
  const configuredRoot = path.resolve(generatedRootPath());
  const lexicalPath = path.resolve(configuredRoot, relativePath);
  if (!isWithin(configuredRoot, lexicalPath)) throw new HttpError(400, 'path escapes generated asset root');
  let root: string;
  let info;
  try {
    root = await realpath(configuredRoot);
    info = await lstat(lexicalPath);
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(404, 'media path does not exist');
    }
    throw reason;
  }
  if (info.isSymbolicLink()) throw new HttpError(400, 'symbolic-link media paths are not allowed');
  const resolved = await realpath(lexicalPath);
  if (!isWithin(root, resolved)) throw new HttpError(400, 'resolved path escapes generated asset root');
  return resolved;
}

export async function safeReviewPendingPath(projectPath: string) {
  if (instanceRepositoryMode() && !hostedReadOnlyMode()) {
    let relativePath: string;
    try { relativePath = instanceCandidateRelativePath(projectPath); }
    catch { throw new HttpError(422, 'Candidate media requires a normalized instance or legacy _review_pending target'); }
    return safeInstanceMediaPath(relativePath);
  }
  const prefix = 'production/generated/';
  if (projectPath.includes('\\') || !projectPath.startsWith(prefix) || path.posix.normalize(projectPath) !== projectPath) {
    throw new HttpError(400, 'path must be a normalized project-relative forward-slash path');
  }
  const relativeSegments = projectPath.slice(prefix.length).split('/');
  if (relativeSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'path contains an invalid or escaping segment');
  }
  const pendingIndex = relativeSegments.lastIndexOf('_review_pending');
  if (pendingIndex < 0 || pendingIndex === relativeSegments.length - 1) {
    throw new HttpError(422, 'candidate media must be isolated under a _review_pending directory');
  }
  const configuredRoot = path.resolve(generatedRootPath());
  let current = configuredRoot;
  for (const segment of relativeSegments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HttpError(400, 'symbolic links are not allowed in candidate media paths');
      }
    } catch (reason) {
      if (reason instanceof HttpError) throw reason;
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'media path does not exist');
      throw reason;
    }
  }
  const resolved = await safeGeneratedPath(projectPath);
  const pendingPath = await realpath(path.join(configuredRoot, ...relativeSegments.slice(0, pendingIndex + 1)));
  if (!isWithin(pendingPath, resolved)) {
    throw new HttpError(422, 'candidate media resolves outside its _review_pending directory');
  }
  return resolved;
}

export async function hashStableFile(filePath: string) {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new HttpError(400, 'candidate path is not a regular file');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  const after = await lstat(filePath);
  if (
    after.isSymbolicLink() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
  ) {
    throw new HttpError(409, 'media file changed while it was being read');
  }
  return {
    sha256: digest.digest('hex'),
    size: after.size,
    dev: after.dev,
    ino: after.ino,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  };
}

export async function assertStableFileIdentity(
  filePath: string,
  expected: { size: number; dev: number; ino: number; mtimeMs: number; ctimeMs?: number },
) {
  const current = await lstat(filePath);
  if (
    current.isSymbolicLink() || !current.isFile()
    || current.dev !== expected.dev || current.ino !== expected.ino
    || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs
    || (expected.ctimeMs !== undefined && current.ctimeMs !== expected.ctimeMs)
  ) {
    throw new HttpError(409, 'media file changed before the bound event could be committed');
  }
}

export async function sha256Path(filePath: string) {
  return (await hashStableFile(filePath)).sha256;
}

export function mediaToken(versionId: string) {
  return 'm_' + createHash('sha256').update(versionId).digest('base64url').slice(0, 28);
}
