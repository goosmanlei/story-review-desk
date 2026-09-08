import {isRequirementDrivenPlanningVersion} from '../../../../host/instance-runtime/shot-design-contract.mjs';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  appendEvent,
  assertCreativeRevisionBasisCurrent,
  assertDeployedCreativeRevisionBinding,
  assertDeployedShotPlanMaterialSet,
  assertJsonObject,
  assertSha256,
  assertSourceOperationSucceededEvidence,
  assertShotPlanMaterialBasisCurrent,
  assertStableId,
  currentCreativeSubjectBaseHash,
  creativeRevisionSourcePathBySubjectKind,
  derivedArtifactHashMap,
  derivedRegistryPaths,
  errorResponse,
  eventLimit,
  HttpError,
  instanceRepository,
  instanceRepositoryMode,
  isDirectPromptSourcePath,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  optionalString,
  recipeCatalogPath,
  replayIdempotentEvent,
  stableObjectHash,
  validateMutationRequest,
  type ReviewData,
} from '../_store';
import { latestAggregateEvent } from '../_workflow';
import { verifyInstanceSourceProof } from '../../../../host/instance-source-proof.mjs';

const states = new Set(['REQUESTED', 'STARTED', 'BUILT', 'DEPLOYED', 'SUCCEEDED', 'FAILED']);
const operationTypes = new Set([
  'CREATIVE_REVISION_SYNC',
  'PROMPT_SYNC',
  'RUNTIME_REBUILD',
  'DOWNSTREAM_INVALIDATION',
  'CANDIDATE_IMPORT',
]);
const transitions: Record<string, Set<string>> = {
  REQUESTED: new Set(['REQUESTED', 'STARTED', 'FAILED']),
  STARTED: new Set(['STARTED', 'BUILT', 'FAILED']),
  BUILT: new Set(['BUILT', 'DEPLOYED', 'FAILED']),
  DEPLOYED: new Set(['DEPLOYED', 'SUCCEEDED', 'FAILED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
};
const candidateMediaSuffixes = new Set(['.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.m4a', '.flac', '.aac', '.mp4', '.mov', '.webm']);

function sourcePathIsAllowlisted(candidate: string) {
  if (
    Object.values(creativeRevisionSourcePathBySubjectKind).includes(candidate)
  ) return true;
  const segments = candidate.split('/');
  if (isDirectPromptSourcePath(candidate)) return true;
  if (candidate.startsWith('production/generated/') && segments.includes('_review_pending')) {
    const suffix = path.posix.extname(candidate).toLowerCase();
    return candidateMediaSuffixes.has(suffix) || suffix === '.json';
  }
  return candidate.startsWith('production/00_control/review_site_runtime/')
    && segments.length >= 4
    && path.posix.extname(candidate).toLowerCase() === '.json';
}

function projectPaths(value: unknown, required: boolean) {
  if (value == null && !required) return [] as string[];
  if (!Array.isArray(value) || value.length < (required ? 1 : 0) || value.length > 100) {
    throw new HttpError(400, 'sourcePaths must contain between 1 and 100 project-relative paths');
  }
  const paths = value.map((item, index) => {
    const candidate = optionalString(item, 2000);
    if (!candidate || candidate.includes('\\') || path.posix.isAbsolute(candidate)) {
      throw new HttpError(400, `sourcePaths[${index}] must be a project-relative forward-slash path`);
    }
    const normalized = path.posix.normalize(candidate);
    if (normalized === '..' || normalized.startsWith('../') || normalized !== candidate) {
      throw new HttpError(400, `sourcePaths[${index}] escapes or is not normalized`);
    }
    if (!sourcePathIsAllowlisted(candidate)) {
      throw new HttpError(422, `sourcePaths[${index}] is outside the controlled source-operation allowlist`);
    }
    return candidate;
  });
  if (new Set(paths).size !== paths.length) throw new HttpError(400, 'sourcePaths contains duplicates');
  return paths;
}

function hashMap(value: unknown, name: string, required: boolean) {
  if (value == null && !required) return {} as Record<string, string | null>;
  const source = assertJsonObject(value, name, 100_000);
  const result: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(source)) {
    const candidatePath = projectPaths([key], true)[0];
    result[candidatePath] = raw == null || raw === '' ? null : assertSha256(raw, `${name}.${key}`);
  }
  return result;
}

function optionalObject(value: unknown, name: string) {
  return value == null ? null : assertJsonObject(value, name, 250_000);
}

function assertHashCoverage(
  hashes: Record<string, string | null>,
  sourcePaths: string[],
  name: string,
  requireMaterialized: boolean,
) {
  const keys = Object.keys(hashes).sort();
  const expected = [...sourcePaths].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new HttpError(422, `${name} keys must exactly match sourcePaths`);
  }
  if (requireMaterialized && Object.values(hashes).some((value) => value == null)) {
    throw new HttpError(422, `${name} must contain a complete SHA-256 for every sourcePath`);
  }
}

function operationState(event: Record<string, unknown>) {
  return String(event.operationState || event.state || '');
}

function sourceBinding(operationType: string, impact: Record<string, unknown> | null) {
  if (operationType !== 'PROMPT_SYNC' && operationType !== 'CREATIVE_REVISION_SYNC') return {};
  if (!impact) throw new HttpError(422, `${operationType} requires an impact object with immutable review bindings`);
  const reviewEventId = assertStableId(impact.reviewEventId, 'impact.reviewEventId');
  if (operationType === 'PROMPT_SYNC') {
    return {
      reviewEventId,
      versionId: assertStableId(impact.versionId, 'impact.versionId'),
      actualPromptHash: assertSha256(impact.actualPromptHash, 'impact.actualPromptHash'),
    };
  }
  const subjectKind = assertStableId(impact.subjectKind, 'impact.subjectKind', 32);
  return {
    reviewEventId,
    creativeRevisionId: assertStableId(impact.creativeRevisionId, 'impact.creativeRevisionId'),
    subjectRevisionHash: assertSha256(impact.subjectRevisionHash, 'impact.subjectRevisionHash'),
    subjectKind,
    basisBindingsHash: assertSha256(impact.basisBindingsHash, 'impact.basisBindingsHash'),
  };
}

function assertCreativeRevisionSourcePath(subjectKind: string, sourcePaths: string[]) {
  const expectedSourcePath = creativeRevisionSourcePathBySubjectKind[subjectKind];
  if (!expectedSourcePath) {
    throw new HttpError(422, 'CREATIVE_REVISION_SYNC subjectKind is not supported', { subjectKind });
  }
  if (sourcePaths.length !== 1 || sourcePaths[0] !== expectedSourcePath) {
    throw new HttpError(422, `CREATIVE_REVISION_SYNC ${subjectKind} must use exactly ${expectedSourcePath}`, {
      subjectKind,
      expectedSourcePath,
    });
  }
}

function assertSourceBindingTargets(
  operationType: string,
  binding: Record<string, unknown>,
  reviews: Array<Record<string, unknown>>,
  candidates: Array<Record<string, unknown>>,
  creativeRevisions: Array<Record<string, unknown>>,
  sourcePaths: string[],
) {
  if (operationType !== 'PROMPT_SYNC' && operationType !== 'CREATIVE_REVISION_SYNC') return;
  const review = reviews.find((event) => event.eventId === binding.reviewEventId);
  if (!review || review.action !== 'APPROVE_AND_RELEASE' || review.sourceSyncRequired !== true) {
    throw new HttpError(422, 'source operation reviewEventId does not resolve to an approved revision awaiting source sync');
  }
  if (operationType === 'PROMPT_SYNC') {
    const sourceSyncBinding = review.sourceSyncBinding && typeof review.sourceSyncBinding === 'object' && !Array.isArray(review.sourceSyncBinding)
      ? review.sourceSyncBinding as Record<string, unknown>
      : {};
    const candidate = candidates.find((event) => event.versionId === binding.versionId);
    if (
      ['STRUCTURE', 'CREATIVE_REVISION'].includes(String(review.subjectType || ''))
      || review.versionId !== binding.versionId
      || sourceSyncBinding.actualPromptHash !== binding.actualPromptHash
      || candidate?.actualPromptHash !== binding.actualPromptHash
    ) {
      throw new HttpError(409, 'PROMPT_SYNC binding does not match the reviewed candidate prompt');
    }
    return;
  }
  if (review.subjectType !== 'CREATIVE_REVISION') {
    throw new HttpError(422, 'CREATIVE_REVISION_SYNC only accepts CREATIVE_REVISION reviews; legacy STRUCTURE reviews are read-only');
  }
  const revision = creativeRevisions.find((event) => (
    event.creativeRevisionId === binding.creativeRevisionId || event.revisionId === binding.creativeRevisionId
  ));
  const revisionSubjectKind = String(revision?.subjectKind || '');
  if (
    (review.subjectRevisionId || review.creativeRevisionId) !== binding.creativeRevisionId
    || review.subjectRevisionHash !== binding.subjectRevisionHash
    || revision?.contentHash !== binding.subjectRevisionHash
    || review.subjectKind !== revisionSubjectKind
    || binding.subjectKind !== revisionSubjectKind
    || revision?.basisBindingsHash !== binding.basisBindingsHash
    || review.basisBindingsHash !== binding.basisBindingsHash
  ) {
    throw new HttpError(409, 'CREATIVE_REVISION_SYNC binding does not match the reviewed creative revision');
  }
  assertCreativeRevisionSourcePath(revisionSubjectKind, sourcePaths);
}

type ProjectionEntry = {
  aggregateId: string;
  event: Record<string, unknown>;
  projection: Record<string, unknown>;
};

type SourceBindingSnapshot = {
  reviews: {
    events: Array<Record<string, unknown>>;
    projectedBySubject: ProjectionEntry[];
    projectedStructureBySubject: ProjectionEntry[];
  };
  candidates: { events: Array<Record<string, unknown>> };
  creativeRevisions: { events: Array<Record<string, unknown>> };
  sourceOperations: {
    events: Array<Record<string, unknown>>;
    latestById: Array<{ aggregateId: string; event: Record<string, unknown> }>;
  };
  stateProjection: {
    assetFamiliesById: Record<string, Record<string, unknown> | undefined>;
    assetVersionsById: Record<string, Record<string, unknown> | undefined>;
  };
};

function sameReviewSubject(left: Record<string, unknown>, right: Record<string, unknown>) {
  if (left.subjectType !== right.subjectType || left.subjectId !== right.subjectId) return false;
  return !['STRUCTURE', 'CREATIVE_REVISION'].includes(String(left.subjectType || '')) || left.subjectKind === right.subjectKind;
}

function sourceSyncAlreadySucceeded(snapshot: SourceBindingSnapshot, reviewEventId: unknown, currentOperationId: string) {
  return snapshot.sourceOperations.latestById.some(({ aggregateId, event }) => (
    aggregateId !== currentOperationId
    && operationState(event) === 'SUCCEEDED'
    && (event.reviewEventId || (event.impact as Record<string, unknown> | null)?.reviewEventId) === reviewEventId
  ));
}

function assertCurrentSourceReviewBinding(
  operationType: string,
  binding: Record<string, unknown>,
  data: ReviewData,
  snapshot: SourceBindingSnapshot,
  sourceOperationId: string,
  state: string,
  sourcePaths: string[],
) {
  if (operationType !== 'PROMPT_SYNC' && operationType !== 'CREATIVE_REVISION_SYNC') return;
  assertSourceBindingTargets(
    operationType,
    binding,
    snapshot.reviews.events,
    snapshot.candidates.events,
    snapshot.creativeRevisions.events,
    sourcePaths,
  );
  const review = snapshot.reviews.events.find((event) => event.eventId === binding.reviewEventId);
  if (!review) throw new HttpError(409, 'the bound source-sync review is no longer available');
  const latestDecision = snapshot.reviews.events.find((event) => (
    ['2.0', '2.1', '2.2'].includes(String(event.schemaVersion || ''))
    && event.effect === 'APPLIED'
    && event.applicationStatus === 'APPLIED'
    && sameReviewSubject(event, review)
  ));
  if (!latestDecision || latestDecision.eventId !== review.eventId) {
    throw new HttpError(409, 'the bound source-sync review was superseded by a later decision');
  }
  if (review.sourceSyncState !== 'PENDING' || sourceSyncAlreadySucceeded(snapshot, review.eventId, sourceOperationId)) {
    throw new HttpError(409, 'the bound review is no longer awaiting source sync');
  }

  if (operationType === 'PROMPT_SYNC') {
    const projected = snapshot.reviews.projectedBySubject.find((entry) => entry.event.eventId === review.eventId);
    const versionId = String(binding.versionId || '');
    const familyId = String(review.familyId || '');
    const family = snapshot.stateProjection.assetFamiliesById[familyId];
    const version = snapshot.stateProjection.assetVersionsById[versionId];
    if (!projected || projected.projection.sourceSyncState !== 'PENDING') {
      throw new HttpError(409, 'the approved Prompt candidate is no longer the current applicable pending review');
    }
    if (
      !family || !version
      || family.currentVersionId !== versionId
      || version.historyRole !== 'CURRENT'
      || version.sourceSyncState !== 'PENDING'
    ) {
      throw new HttpError(409, 'the approved Prompt candidate is no longer the current adopted version awaiting sync');
    }
    return;
  }

  const revision = snapshot.creativeRevisions.events.find((event) => (
    event.creativeRevisionId === binding.creativeRevisionId || event.revisionId === binding.creativeRevisionId
  ));
  if (!revision) throw new HttpError(409, 'the approved creative revision is no longer available');
  assertCreativeRevisionBasisCurrent(data, snapshot.stateProjection, revision, {
    requireCurrentPredecessor: ['REQUESTED', 'STARTED'].includes(state),
  });
  if (revision.subjectKind === 'SHOT_PLAN_SET') {
    const revisionContent = revision.content && typeof revision.content === 'object' && !Array.isArray(revision.content)
      ? revision.content as Record<string, unknown>
      : {};
    const sceneId = String(revisionContent.sceneId || review.scopeId || '');
    const adoptedMaterialSet = assertShotPlanMaterialBasisCurrent(
      data,
      snapshot.stateProjection,
      sceneId,
      revision.basisBindings,
    );
    if (stableObjectHash(isRequirementDrivenPlanningVersion(revision.planningContractVersion) ? revision.materialRequirementSet : revision.adoptedMaterialSet) !== stableObjectHash(adoptedMaterialSet)) {
      throw new HttpError(409, 'the approved ShotPlanSet no longer binds the current adopted material versions');
    }
    if (['DEPLOYED', 'SUCCEEDED'].includes(state)) {
      assertDeployedShotPlanMaterialSet(
        data,
        String(binding.creativeRevisionId || ''),
        adoptedMaterialSet,
      );
    }
  }
  const projected = snapshot.reviews.projectedStructureBySubject.find((entry) => entry.event.eventId === review.eventId);
  if (['REQUESTED', 'STARTED'].includes(state)) {
    if (!projected || projected.projection.sourceSyncState !== 'PENDING') {
      throw new HttpError(409, 'the approved creative revision is no longer the current applicable pending review');
    }
    if (revision.baseRevisionHash !== currentCreativeSubjectBaseHash(
      data,
      String(revision.subjectKind || ''),
      String(revision.subjectId || ''),
    )) {
      throw new HttpError(409, 'the creative revision subject predecessor changed before controlled application');
    }
  }
  if (['DEPLOYED', 'SUCCEEDED'].includes(state)) {
    assertDeployedCreativeRevisionBinding(data, binding);
  }
  // Once STARTED has atomically replaced a structure source, the old base hash
  // is expected to stop projecting against the newly built snapshot.  From
  // BUILT onward we therefore retain the exact transaction binding, while the
  // latest-decision and no-other-success checks above still reject superseded
  // or already-consumed approvals.
}

export function assertDeployedEpisodePlanBinding(
  data: ReviewData,
  binding: Record<string, unknown>,
) {
  assertDeployedCreativeRevisionBinding(data, { ...binding, subjectKind: 'EPISODE_PLAN' });
}

function sha256Bytes(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function regularJsonFile(filePath: string, label: string) {
  if (!existsSync(filePath)) throw new HttpError(422, `${label} is unavailable`);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(422, `${label} must be a regular host-controlled file`);
  const bytes = await readFile(filePath);
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    parsed = value as Record<string, unknown>;
  } catch {
    throw new HttpError(422, `${label} is not valid JSON`);
  }
  return { bytes, parsed };
}

async function regularJsonFileWithin(rootReal: string, relativePath: string, label: string) {
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new HttpError(422, `${label} path is unsafe`);
  }
  let cursor = rootReal;
  const segments = normalized.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new HttpError(422, `${label} path must not traverse a symbolic link`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new HttpError(422, `${label} parent must be a regular directory`);
    }
  }
  const resolved = await realpath(cursor);
  const expected = path.resolve(rootReal, ...segments);
  if (resolved !== expected || !resolved.startsWith(`${rootReal}${path.sep}`)) {
    throw new HttpError(422, `${label} escaped its host-controlled root`);
  }
  return regularJsonFile(resolved, label);
}

async function sha256RegularFileWithin(rootReal: string, relativePath: string, label: string) {
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new HttpError(422, `${label} path is unsafe`);
  }
  let cursor = rootReal;
  const segments = normalized.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new HttpError(422, `${label} path must not traverse a symbolic link`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new HttpError(422, `${label} parent must be a regular directory`);
    }
  }
  const resolved = await realpath(cursor);
  const expected = path.resolve(rootReal, ...segments);
  if (resolved !== expected || !resolved.startsWith(`${rootReal}${path.sep}`)) {
    throw new HttpError(422, `${label} escaped its host-controlled root`);
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HttpError(422, `${label} must be a regular file`);
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

type VerifiedHostProof = {
  ref: string;
  digest: string;
  verifiedAt: string;
  verificationMode: 'HOST_FILESYSTEM_AND_FORMAL_RUNTIME_FILES' | 'INSTANCE_SQLITE_RELEASE_AND_SOURCE_RECORDS';
  proofPayload: Record<string, unknown>;
};

async function verifyHostWorkerSuccessProofFiles(
  data: ReviewData,
  sourceOperationId: string,
  runtimeBundleId: string,
  targetSnapshotId: string,
  reviewDataSha256: string,
  recipeSha256: string,
  derivedArtifactHashes: Record<string, string>,
  newBlockHashes: Record<string, string | null>,
  deployedEndpointProof: Record<string, unknown> | null,
): Promise<VerifiedHostProof> {
  if (!runtimeBundleId || path.basename(runtimeBundleId) !== runtimeBundleId) {
    throw new HttpError(422, 'SUCCEEDED runtimeBundleId is not a safe bundle identifier');
  }
  if (instanceRepositoryMode()) {
    return await verifyInstanceSourceProof((await instanceRepository())!, { sourceOperationId, runtimeBundleId, targetSnapshotId, reviewDataSha256, recipeSha256, derivedArtifactHashes, newBlockHashes, deployedEndpointProof }) as VerifiedHostProof;
  }
  const runtimeRoot = process.env.REVIEW_RUNTIME_ROOT
    || path.resolve(process.cwd(), '..', 'production', '00_control', 'review_site_runtime');
  const runtimeRootReal = await realpath(runtimeRoot);
  const projectRoot = process.env.REVIEW_PROJECT_ROOT || path.resolve(process.cwd(), '..');
  const projectRootReal = await realpath(projectRoot);
  await Promise.all(Object.entries(newBlockHashes).map(async ([sourcePath, expectedHash]) => {
    if (!expectedHash) throw new HttpError(422, `SUCCEEDED source hash is missing for ${sourcePath}`);
    const actualHash = await sha256RegularFileWithin(
      projectRootReal,
      sourcePath,
      `authoritative source ${sourcePath}`,
    );
    if (actualHash !== expectedHash) {
      throw new HttpError(409, `authoritative source changed after host proof: ${sourcePath}`);
    }
  }));
  await Promise.all(derivedRegistryPaths.map(async (registryPath) => {
    const actualHash = await sha256RegularFileWithin(
      projectRootReal,
      registryPath,
      `authoritative derived registry ${registryPath}`,
    );
    if (actualHash !== derivedArtifactHashes[registryPath]) {
      throw new HttpError(409, `authoritative derived registry changed after host proof: ${registryPath}`);
    }
  }));
  const expectedBundlePath = path.join(runtimeRootReal, 'bundles', runtimeBundleId);
  const bundleInfo = await lstat(expectedBundlePath);
  if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()) {
    throw new HttpError(409, 'claimed runtime bundle must be a regular host-controlled directory');
  }
  const currentTarget = await readlink(path.join(runtimeRootReal, 'current'));
  if (currentTarget !== `bundles/${runtimeBundleId}`) {
    throw new HttpError(409, 'formal runtime/current does not point to the claimed runtime bundle');
  }
  const currentReal = await realpath(path.join(runtimeRootReal, 'current'));
  const bundleReal = await realpath(expectedBundlePath);
  if (currentReal !== bundleReal || !bundleReal.startsWith(path.join(runtimeRootReal, 'bundles') + path.sep)) {
    throw new HttpError(409, 'formal runtime bundle pointer escaped or does not match the claimed bundle');
  }

  const servingRecipePath = await recipeCatalogPath();
  const [bundleManifest, bundleData, bundleRecipes, hostProof, bakedDataBytes, bakedRecipeBytes] = await Promise.all([
    regularJsonFileWithin(bundleReal, 'manifest.json', 'runtime bundle manifest'),
    regularJsonFileWithin(bundleReal, 'review-data.generated.json', 'runtime bundle review data'),
    regularJsonFileWithin(bundleReal, 'review-recipes.generated.json', 'runtime bundle recipes'),
    regularJsonFileWithin(runtimeRootReal, `host_proofs/${sourceOperationId}.json`, 'host worker deployment proof'),
    readFile(process.env.REVIEW_DATA_PATH || path.join(process.cwd(), 'app', 'review-data.generated.json')),
    readFile(servingRecipePath),
  ]);
  const derivedFiles = await Promise.all(derivedRegistryPaths.map((registryPath) => regularJsonFileWithin(
      bundleReal,
      `derived/${registryPath}`,
      `runtime bundle derived registry ${registryPath}`,
    )));
  const exact = {
    schemaVersion: '1.1',
    bundleId: runtimeBundleId,
    snapshotId: targetSnapshotId,
    reviewDataSha256,
    recipeSha256,
    derivedArtifactHashes,
  };
  for (const [field, value] of Object.entries(exact)) {
    const matches = field === 'derivedArtifactHashes'
      ? bundleManifest.parsed[field] !== undefined
        && stableObjectHash(bundleManifest.parsed[field]) === stableObjectHash(value)
      : bundleManifest.parsed[field] === value;
    if (!matches) {
      throw new HttpError(409, `runtime bundle manifest ${field} does not match`);
    }
  }
  if (
    bundleData.parsed.snapshotId !== targetSnapshotId
    || bundleRecipes.parsed.snapshotId !== targetSnapshotId
    || data.snapshotId !== targetSnapshotId
  ) {
    throw new HttpError(409, 'runtime bundle, current server and target snapshot do not agree');
  }
  const actualDataHash = sha256Bytes(bakedDataBytes);
  const actualRecipeHash = sha256Bytes(bakedRecipeBytes);
  if (
    sha256Bytes(bundleData.bytes) !== reviewDataSha256
    || sha256Bytes(bundleRecipes.bytes) !== recipeSha256
    || actualDataHash !== reviewDataSha256
    || actualRecipeHash !== recipeSha256
  ) {
    throw new HttpError(409, 'runtime bundle or formal server files do not match the claimed generated hashes');
  }
  for (const [index, registryPath] of derivedRegistryPaths.entries()) {
    if (sha256Bytes(derivedFiles[index].bytes) !== derivedArtifactHashes[registryPath]) {
      throw new HttpError(409, `runtime bundle derived registry hash does not match: ${registryPath}`);
    }
  }
  if (
    !deployedEndpointProof
    || deployedEndpointProof.url !== 'http://localhost:3000'
    || deployedEndpointProof.snapshotId !== targetSnapshotId
    || deployedEndpointProof.runtimeBundleId !== runtimeBundleId
    || deployedEndpointProof.reviewDataSha256 !== reviewDataSha256
    || deployedEndpointProof.recipeSha256 !== recipeSha256
    || stableObjectHash(derivedArtifactHashMap(
      deployedEndpointProof.derivedArtifactHashes,
      'deployedEndpointProof.derivedArtifactHashes',
    )) !== stableObjectHash(derivedArtifactHashes)
  ) {
    throw new HttpError(422, 'deployedEndpointProof does not match independently observed formal runtime facts');
  }
  const containerHashes = deployedEndpointProof.containerFileHashes;
  if (
    !containerHashes || typeof containerHashes !== 'object' || Array.isArray(containerHashes)
    || (containerHashes as Record<string, unknown>).reviewDataSha256 !== actualDataHash
    || (containerHashes as Record<string, unknown>).recipeSha256 !== actualRecipeHash
  ) {
    throw new HttpError(422, 'deployedEndpointProof.containerFileHashes do not match the serving process');
  }

  const claimedDigest = String(hostProof.parsed.proofDigest || '');
  const workerOperationId = String(hostProof.parsed.workerOperationId || '');
  if (!workerOperationId || bundleManifest.parsed.sourceOperationId !== workerOperationId) {
    throw new HttpError(409, 'host worker proof is not bound to the worker that published the runtime bundle');
  }
  const proofPayload = { ...hostProof.parsed };
  delete proofPayload.proofDigest;
  const hostProofDerivedArtifactHashes = derivedArtifactHashMap(
    hostProof.parsed.derivedArtifactHashes,
    'host worker deployment proof derivedArtifactHashes',
  );
  const expectedProof = {
    schemaVersion: '1.1',
    proofType: 'HOST_WORKER_FORMAL_DEPLOYMENT_QA',
    apiSourceOperationId: sourceOperationId,
    targetSnapshotId,
    runtimeBundleId,
    reviewDataSha256,
    recipeSha256,
    derivedArtifactHashes,
    sourceBlockHashes: newBlockHashes,
    formalUrl: 'http://localhost:3000',
    preDeploymentQaStatus: 'PASS',
    formalRuntimeQaStatus: 'PASS',
    deployedEndpointProofHash: stableObjectHash(deployedEndpointProof),
  };
  if (stableObjectHash(hostProofDerivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes)) {
    throw new HttpError(409, 'host worker deployment proof derivedArtifactHashes do not match the SourceOperation event');
  }
  for (const [field, value] of Object.entries(expectedProof)) {
    if (hostProof.parsed[field] === undefined || stableObjectHash(hostProof.parsed[field]) !== stableObjectHash(value)) {
      throw new HttpError(409, `host worker deployment proof ${field} does not match`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(claimedDigest) || stableObjectHash(proofPayload) !== claimedDigest) {
    throw new HttpError(409, 'host worker deployment proof digest does not match its payload');
  }
  const verifiedAt = optionalString(hostProof.parsed.verifiedAt, 100);
  if (!verifiedAt || !Number.isFinite(Date.parse(verifiedAt))) {
    throw new HttpError(409, 'host worker deployment proof lacks a valid verifiedAt timestamp');
  }
  return {
    ref: `host_proofs/${sourceOperationId}.json`,
    digest: claimedDigest,
    verifiedAt,
    verificationMode: 'HOST_FILESYSTEM_AND_FORMAL_RUNTIME_FILES',
    proofPayload,
  };
}

async function verifyHostWorkerSuccessProof(
  data: ReviewData,
  sourceOperationId: string,
  runtimeBundleId: string,
  targetSnapshotId: string,
  reviewDataSha256: string,
  recipeSha256: string,
  derivedArtifactHashes: Record<string, string>,
  newBlockHashes: Record<string, string | null>,
  deployedEndpointProof: Record<string, unknown> | null,
) {
  try {
    return await verifyHostWorkerSuccessProofFiles(
      data,
      sourceOperationId,
      runtimeBundleId,
      targetSnapshotId,
      reviewDataSha256,
      recipeSha256,
      derivedArtifactHashes,
      newBlockHashes,
      deployedEndpointProof,
    );
  } catch (reason) {
    if (reason instanceof HttpError) throw reason;
    throw new HttpError(422, instanceRepositoryMode() ? 'SUCCEEDED requires a matching instance database release, source revisions and host proof' : 'SUCCEEDED requires independently readable host-worker and formal-runtime filesystem proof', {
      proofError: reason instanceof Error ? reason.message : String(reason),
    });
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'));
    const sourceOperationId = url.searchParams.get('sourceOperationId');
    const state = url.searchParams.get('state');
    const operationType = url.searchParams.get('operationType');
    if (sourceOperationId) assertStableId(sourceOperationId, 'sourceOperationId');
    if (state && !states.has(state)) throw new HttpError(400, 'state is invalid');
    if (operationType && !operationTypes.has(operationType)) throw new HttpError(400, 'operationType is invalid');
    const events = (await listAllEvents('source-operation'))
      .filter((event) => !sourceOperationId || event.sourceOperationId === sourceOperationId)
      .filter((event) => !state || operationState(event) === state)
      .filter((event) => !operationType || event.operationType === operationType)
      .slice(0, limit);
    return jsonResponse({ events, count: events.length });
  } catch (reason) {
    return errorResponse(reason, 'source operation events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('source-operation', body);
    const replay = await replayIdempotentEvent('source-operation', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        sourceOperationId: replay.event.sourceOperationId,
        state: replay.event.operationState,
        replayed: true,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        operationalRevision: replay.operations.operationalRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
      }, { headers: { ETag: replay.operations.etag } });
    }
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const state = assertStableId(body.state, 'state', 32);
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    if (!states.has(state)) throw new HttpError(400, 'state must be REQUESTED, STARTED, BUILT, DEPLOYED, SUCCEEDED or FAILED');
    const suppliedId = body.sourceOperationId == null || body.sourceOperationId === ''
      ? ''
      : assertStableId(body.sourceOperationId, 'sourceOperationId');
    if (suppliedId && !suppliedId.startsWith('sop_')) throw new HttpError(400, 'sourceOperationId is invalid');
    if (!suppliedId && state !== 'REQUESTED') throw new HttpError(400, 'sourceOperationId is required after REQUESTED');
    const sourceOperationId = suppliedId || `sop_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
    const existingEvents = await listAllEvents('source-operation');
    const previous = latestAggregateEvent(existingEvents, 'sourceOperationId', sourceOperationId);
    const initial = existingEvents.filter((event) => event.sourceOperationId === sourceOperationId).at(-1) || null;
    const baseSnapshotId = body.baseSnapshotId == null || body.baseSnapshotId === ''
      ? String(previous?.baseSnapshotId || initial?.snapshotId || snapshotId)
      : assertStableId(body.baseSnapshotId, 'baseSnapshotId', 200);
    const targetSnapshotId = body.targetSnapshotId == null || body.targetSnapshotId === ''
      ? String(previous?.targetSnapshotId || '')
      : assertStableId(body.targetSnapshotId, 'targetSnapshotId', 200);
    if (!previous && baseSnapshotId !== snapshotId) throw new HttpError(409, 'new source operation baseSnapshotId must equal the current snapshot');
    const operationType = body.operationType == null || body.operationType === ''
      ? String(previous?.operationType || '')
      : assertStableId(body.operationType, 'operationType', 64);
    if (!operationTypes.has(operationType)) throw new HttpError(400, 'operationType is invalid');
    const sourcePaths = body.sourcePaths == null
      ? (Array.isArray(previous?.sourcePaths) ? previous.sourcePaths as string[] : [])
      : projectPaths(body.sourcePaths, true);
    if (!sourcePaths.length) throw new HttpError(400, 'sourcePaths is required');
    const oldBlockHashes = body.oldBlockHashes == null
      ? (previous?.oldBlockHashes as Record<string, string | null> || {})
      : hashMap(body.oldBlockHashes, 'oldBlockHashes', true);
    const newBlockHashes = body.newBlockHashes == null
      ? (previous?.newBlockHashes as Record<string, string | null> || {})
      : hashMap(body.newBlockHashes, 'newBlockHashes', false);
    const preview = optionalObject(body.preview == null ? previous?.preview : body.preview, 'preview');
    const impact = optionalObject(body.impact == null ? previous?.impact : body.impact, 'impact');
    const qa = optionalObject(body.qa == null ? previous?.qa : body.qa, 'qa');
    const recovery = optionalObject(body.recovery == null ? previous?.recovery : body.recovery, 'recovery');
    const runtimeBundleId = optionalString(body.runtimeBundleId == null ? previous?.runtimeBundleId : body.runtimeBundleId, 500);
    const reviewDataSha256 = body.reviewDataSha256 == null || body.reviewDataSha256 === ''
      ? String(previous?.reviewDataSha256 || '')
      : assertSha256(body.reviewDataSha256, 'reviewDataSha256');
    const recipeSha256 = body.recipeSha256 == null || body.recipeSha256 === ''
      ? String(previous?.recipeSha256 || '')
      : assertSha256(body.recipeSha256, 'recipeSha256');
    const previousDerivedArtifactHashes = previous?.derivedArtifactHashes
      && typeof previous.derivedArtifactHashes === 'object'
      && !Array.isArray(previous.derivedArtifactHashes)
      && Object.keys(previous.derivedArtifactHashes as Record<string, unknown>).length
      ? previous.derivedArtifactHashes
      : null;
    const derivedArtifactHashes = body.derivedArtifactHashes == null
      ? (previousDerivedArtifactHashes
          ? derivedArtifactHashMap(previousDerivedArtifactHashes)
          : {} as Record<string, string>)
      : derivedArtifactHashMap(body.derivedArtifactHashes);
    const deployedEndpointProof = optionalObject(
      body.deployedEndpointProof == null ? previous?.deployedEndpointProof : body.deployedEndpointProof,
      'deployedEndpointProof',
    );
    const note = optionalString(body.note, 20_000);
    const binding = sourceBinding(operationType, impact);
    if (operationType === 'PROMPT_SYNC' && sourcePaths.some((item) => !isDirectPromptSourcePath(item))) {
      throw new HttpError(422, 'PROMPT_SYNC may only bind direct Prompt Markdown source paths');
    }
    const [reviewEvents, candidateEvents, creativeRevisionEvents] = await Promise.all([
      listAllEvents('review'),
      listAllEvents('asset-version'),
      listAllEvents('creative-revision'),
    ]);
    assertSourceBindingTargets(operationType, binding, reviewEvents, candidateEvents, creativeRevisionEvents, sourcePaths);
    if (previous) {
      if (previous.baseSnapshotId !== baseSnapshotId || previous.operationType !== operationType) {
        throw new HttpError(409, 'sourceOperationId binding cannot change');
      }
      if (JSON.stringify(previous.sourcePaths) !== JSON.stringify(sourcePaths)) {
        throw new HttpError(409, 'sourceOperationId sourcePaths cannot change');
      }
      if (JSON.stringify(initial?.oldBlockHashes || {}) !== JSON.stringify(oldBlockHashes)) {
        throw new HttpError(409, 'sourceOperationId oldBlockHashes cannot change');
      }
      if (JSON.stringify(initial?.preview || null) !== JSON.stringify(preview)) {
        throw new HttpError(409, 'sourceOperationId preview cannot change');
      }
      if (JSON.stringify(initial?.impact || null) !== JSON.stringify(impact)) {
        throw new HttpError(409, 'sourceOperationId impact cannot change');
      }
      if (previous.targetSnapshotId && previous.targetSnapshotId !== targetSnapshotId) {
        throw new HttpError(409, 'sourceOperationId targetSnapshotId cannot change after build');
      }
      if (previous.runtimeBundleId && previous.runtimeBundleId !== runtimeBundleId) {
        throw new HttpError(409, 'sourceOperationId runtimeBundleId cannot change after build');
      }
      if (previous.reviewDataSha256 && previous.reviewDataSha256 !== reviewDataSha256) {
        throw new HttpError(409, 'sourceOperationId reviewDataSha256 cannot change after build');
      }
      if (previous.recipeSha256 && previous.recipeSha256 !== recipeSha256) {
        throw new HttpError(409, 'sourceOperationId recipeSha256 cannot change after build');
      }
      if (
        previous.derivedArtifactHashes
        && stableObjectHash(previous.derivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes)
      ) {
        throw new HttpError(409, 'sourceOperationId derivedArtifactHashes cannot change after build');
      }
      if (operationState(previous) === 'SUCCEEDED' && (
        JSON.stringify(previous.newBlockHashes || {}) !== JSON.stringify(newBlockHashes)
        || stableObjectHash(previous.derivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes)
        || JSON.stringify(previous.qa || null) !== JSON.stringify(qa)
        || JSON.stringify(previous.recovery || null) !== JSON.stringify(recovery)
        || JSON.stringify(previous.deployedEndpointProof || null) !== JSON.stringify(deployedEndpointProof)
      )) {
        throw new HttpError(409, 'a SUCCEEDED source operation cannot rewrite its terminal evidence');
      }
    }
    assertHashCoverage(oldBlockHashes, sourcePaths, 'oldBlockHashes', false);
    if (!['BUILT', 'DEPLOYED', 'SUCCEEDED'].includes(state) && Object.keys(newBlockHashes).length) {
      throw new HttpError(422, 'newBlockHashes is only valid after the controlled build');
    }
    if (['REQUESTED', 'STARTED'].includes(state) && Object.keys(derivedArtifactHashes).length) {
      throw new HttpError(422, 'derivedArtifactHashes is only valid after the controlled build');
    }
    if (['BUILT', 'DEPLOYED', 'SUCCEEDED'].includes(state)) {
      if (!targetSnapshotId || !runtimeBundleId || !reviewDataSha256 || !recipeSha256) {
        throw new HttpError(422, `${state} requires targetSnapshotId, runtimeBundleId, reviewDataSha256 and recipeSha256`);
      }
      assertHashCoverage(newBlockHashes, sourcePaths, 'newBlockHashes', true);
      derivedArtifactHashMap(derivedArtifactHashes);
    }
    if (['DEPLOYED', 'SUCCEEDED'].includes(state) && !deployedEndpointProof) {
      throw new HttpError(422, `${state} requires deployedEndpointProof from the formal localhost runtime`);
    }
    if (['DEPLOYED', 'SUCCEEDED'].includes(state) && deployedEndpointProof) {
      const deployedDerivedArtifactHashes = derivedArtifactHashMap(
        deployedEndpointProof.derivedArtifactHashes,
        'deployedEndpointProof.derivedArtifactHashes',
      );
      if (stableObjectHash(deployedDerivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes)) {
        throw new HttpError(422, `${state} deployedEndpointProof derivedArtifactHashes must match the SourceOperation event`);
      }
    }
    if (state === 'SUCCEEDED') {
      if (!deployedEndpointProof) throw new HttpError(422, 'SUCCEEDED requires deployedEndpointProof from the formal localhost runtime');
      if (!qa || !recovery) throw new HttpError(422, 'SUCCEEDED requires qa and recovery evidence');
      if (qa.status !== 'PASS') throw new HttpError(422, 'SUCCEEDED requires qa.status=PASS');
      if (targetSnapshotId !== data.snapshotId) throw new HttpError(409, 'SUCCEEDED targetSnapshotId must be the currently deployed snapshot');
      if (deployedEndpointProof.snapshotId !== targetSnapshotId || deployedEndpointProof.url !== 'http://localhost:3000') {
        throw new HttpError(422, 'SUCCEEDED deployedEndpointProof must bind the formal localhost:3000 target snapshot');
      }
      if (
        typeof recovery.strategy !== 'string' || !recovery.strategy.trim()
        || typeof recovery.journal !== 'string' || !recovery.journal.trim()
        || typeof recovery.backup !== 'string' || !recovery.backup.trim()
      ) {
        throw new HttpError(422, 'SUCCEEDED recovery must identify strategy, journal and backup');
      }
    }
    const hostWorkerProof = state === 'SUCCEEDED'
      ? await verifyHostWorkerSuccessProof(
          data,
          sourceOperationId,
          runtimeBundleId,
          targetSnapshotId,
          reviewDataSha256,
          recipeSha256,
          derivedArtifactHashes,
          newBlockHashes,
          deployedEndpointProof,
        )
      : null;
    if (state === 'FAILED' && !note) throw new HttpError(400, 'FAILED requires a concrete note');
    const carriesActivationEvidence = ['BUILT', 'DEPLOYED', 'SUCCEEDED'].includes(state);
    const carriesDeploymentEvidence = ['DEPLOYED', 'SUCCEEDED'].includes(state);
    const semanticRequest = {
      snapshotId,
      creationSnapshotId: previous?.creationSnapshotId || initial?.snapshotId || snapshotId,
      baseSnapshotId,
      targetSnapshotId: carriesActivationEvidence ? targetSnapshotId : null,
      sourceOperationId,
      operationType,
      state,
      sourcePaths,
      oldBlockHashes,
      newBlockHashes,
      preview,
      impact,
      qa,
      recovery,
      runtimeBundleId: carriesActivationEvidence ? runtimeBundleId : null,
      reviewDataSha256: carriesActivationEvidence ? reviewDataSha256 : null,
      recipeSha256: carriesActivationEvidence ? recipeSha256 : null,
      derivedArtifactHashes: carriesActivationEvidence ? derivedArtifactHashes : null,
      deployedEndpointProof: carriesDeploymentEvidence ? deployedEndpointProof : null,
      hostWorkerProof,
      note,
      ...binding,
    };
    if (state === 'SUCCEEDED') {
      assertSourceOperationSucceededEvidence(semanticRequest, data.snapshotId);
    }
    const { event, replayed, operations } = await appendEvent(
      'source-operation',
      idempotencyKey,
      mutationRequestHash('source-operation', semanticRequest),
      ifMatch,
      { ...semanticRequest, rawRequestHash, operationState: state },
      '1.0',
      async (locked) => {
        const lockedPrevious = latestAggregateEvent(locked.sourceOperations.events, 'sourceOperationId', sourceOperationId);
        if (!lockedPrevious) {
          if (state !== 'REQUESTED') throw new HttpError(409, 'new source operation must start at REQUESTED');
          assertCurrentSourceReviewBinding(
            operationType,
            binding,
            data,
            locked,
            sourceOperationId,
            state,
            sourcePaths,
          );
          return;
        }
        if (
          lockedPrevious.baseSnapshotId !== baseSnapshotId
          || lockedPrevious.operationType !== operationType
          || JSON.stringify(lockedPrevious.sourcePaths) !== JSON.stringify(sourcePaths)
          || JSON.stringify(lockedPrevious.oldBlockHashes) !== JSON.stringify(oldBlockHashes)
          || (lockedPrevious.derivedArtifactHashes
            && stableObjectHash(lockedPrevious.derivedArtifactHashes) !== stableObjectHash(derivedArtifactHashes))
        ) {
          throw new HttpError(409, 'source operation binding changed while the update was in flight');
        }
        assertSourceBindingTargets(
          operationType,
          binding,
          locked.reviews.events,
          locked.candidates.events,
          locked.creativeRevisions.events,
          sourcePaths,
        );
        assertCurrentSourceReviewBinding(
          operationType,
          binding,
          data,
          locked,
          sourceOperationId,
          state,
          sourcePaths,
        );
        const previousState = operationState(lockedPrevious);
        if (!transitions[previousState]?.has(state)) {
          throw new HttpError(409, `source operation cannot transition from ${previousState} to ${state}`);
        }
        if (state === 'SUCCEEDED') {
          const lockedProof = await verifyHostWorkerSuccessProof(
            data,
            sourceOperationId,
            runtimeBundleId,
            targetSnapshotId,
            reviewDataSha256,
            recipeSha256,
            derivedArtifactHashes,
            newBlockHashes,
            deployedEndpointProof,
          );
          if (lockedProof.digest !== hostWorkerProof?.digest) {
            throw new HttpError(409, 'host worker deployment proof changed while SUCCEEDED was in flight');
          }
        }
      },
    );
    return jsonResponse({
      eventId: event.eventId,
      sourceOperationId: event.sourceOperationId,
      state: event.operationState,
      replayed,
      event,
      operationRevision: operations.operationRevision,
      operationalRevision: operations.operationalRevision,
      etag: operations.etag,
      mutationEtag: operations.mutationEtag,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'invalid source operation event');
  }
}
