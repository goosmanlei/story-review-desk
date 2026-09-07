import path from 'node:path';
import { withSourceMediaReadScope, captureSourceMedia } from './instance-source-media.mjs';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { canonicalJson, sha256 } from './instance-runtime/index.mjs';
import { compileInstanceSource, sourceRelative, validateCompiler } from './instance-source-compiler.mjs';
import { HOST_NAMESPACE, requireSource, objectHash, verifyInstanceSourceProof } from './instance-source-proof.mjs';

const eventFingerprint = async (tx) => objectHash((await tx.listEvents()).filter((row) => row.eventKind !== 'source-operation'));
const json = (value) => canonicalJson(value);
export async function assertHistoricalDatabaseProofs(tx) {
  for (const event of (await tx.listEvents('source-operation'))) {
    if (event.operationState !== 'SUCCEEDED' || !['INSTANCE_SQLITE_RELEASE_AND_SOURCE_RECORDS','INSTANCE_POSTGRES_RELEASE_AND_SOURCE_RECORDS'].includes(event.hostWorkerProof?.verificationMode)) continue;
    const endpoint = event.deployedEndpointProof; const proof = event.hostWorkerProof;
    const record = (await tx.getAux(HOST_NAMESPACE, `commits/${event.sourceOperationId}.json`)); const commit = record && !record.deleted ? JSON.parse(record.bytes) : null;
    const release = endpoint?.releaseId ? (await tx.readRelease(endpoint.releaseId)) : null;
    requireSource(['INSTANCE_SQLITE','INSTANCE_POSTGRES'].includes(endpoint?.authority) && endpoint.instanceId === (await tx.readView()).instanceId && typeof endpoint.runtimeEpoch === 'string' && endpoint.runtimeEpoch && release && commit?.releaseId === release.releaseId && commit?.runtimeEpoch === endpoint.runtimeEpoch && commit?.runtimeBundleId === event.runtimeBundleId && release.snapshotSha256 === event.reviewDataSha256 && release.recipesSha256 === event.recipeSha256 && proof.proofPayload && objectHash(proof.proofPayload) === proof.digest && proof.proofPayload.deployedEndpointProofHash === objectHash(endpoint), 'SOURCE_HISTORICAL_PROOF', 'An instance source operation lacks verifiable historical database release evidence');
  }
}
async function assertApproved(tx, manifest) {
  requireSource(['CREATIVE_REVISION_SYNC', 'PROMPT_SYNC'].includes(manifest.operationType), 'SOURCE_OPERATION_TYPE', 'This source worker accepts only approved creative or Prompt synchronization');
  const impact = manifest.impact || {}; const reviews = (await tx.listEvents('review'));
  const review = reviews.find((row) => row.eventId === impact.reviewEventId);
  requireSource(review?.action === 'APPROVE_AND_RELEASE' && review.sourceSyncRequired === true && review.sourceSyncState === 'PENDING' && review.effect === 'APPLIED' && review.applicationStatus === 'APPLIED', 'SOURCE_APPROVAL', 'Exact applied approval awaiting source synchronization is required');
  const head = reviews.find((row) => row.effect === 'APPLIED' && row.applicationStatus === 'APPLIED' && row.subjectType === review.subjectType && row.subjectId === review.subjectId && row.subjectKind === review.subjectKind);
  requireSource(head?.eventId === review.eventId, 'SOURCE_APPROVAL_SUPERSEDED', 'A newer judgement supersedes this approval');
  requireSource(!(await tx.listEvents('source-operation')).some((row) => row.operationState === 'SUCCEEDED' && (row.reviewEventId || row.impact?.reviewEventId) === review.eventId), 'SOURCE_ALREADY_SYNCED', 'This review has already been synchronized');
  if (manifest.operationType === 'CREATIVE_REVISION_SYNC') {
    const candidate = (await tx.listEvents('creative-revision')).find((row) => (row.creativeRevisionId || row.revisionId) === impact.creativeRevisionId);
    requireSource(review.subjectType === 'CREATIVE_REVISION' && candidate && review.subjectKind === impact.subjectKind && candidate.subjectKind === impact.subjectKind && (review.subjectRevisionId || review.creativeRevisionId) === impact.creativeRevisionId && review.subjectRevisionHash === impact.subjectRevisionHash && candidate.contentHash === impact.subjectRevisionHash && review.basisBindingsHash === impact.basisBindingsHash && candidate.basisBindingsHash === impact.basisBindingsHash, 'SOURCE_CANDIDATE_BINDING', 'Source manifest differs from the exact approved creative candidate');
    const view=(await tx.readView());if(view.profile.configurationRef&&candidate.subjectKind==='EPISODE_PLAN'){const pin=view.snapshot.productionModel.configurationCandidates?.find(r=>r.id===candidate.creativeRevisionId);const spec=pin?.reviewSpec||candidate.reviewSpec;requireSource(spec&&(spec.hash===review.reviewSpecHash||spec.legacy&&!review.reviewSpecHash),'SOURCE_REVIEW_STANDARD_BINDING','Approved candidate review standard differs from its current binding');}
    // Recompute the authored payload instead of trusting stored hash labels.
    requireSource(objectHash(candidate.content) === candidate.contentHash && objectHash(candidate.basisBindings) === candidate.basisBindingsHash, 'SOURCE_CANDIDATE_HASH', 'Approved creative candidate content or basis bytes differ from their canonical hashes');
  } else {
    const candidate = (await tx.listEvents('asset-version')).find((row) => row.versionId === impact.versionId);
    requireSource(review.versionId === impact.versionId && review.sourceSyncBinding?.actualPromptHash === impact.actualPromptHash && candidate?.actualPromptHash === impact.actualPromptHash, 'SOURCE_PROMPT_BINDING', 'Source manifest differs from the reviewed Prompt version');
  }
  return review;
}

async function capture(tx, manifest) {
  const view = (await tx.readView()); const baseRelease = (await tx.readRelease());
  requireSource(baseRelease && manifest.schemaVersion === '1.0' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(manifest.operationId || ''), 'SOURCE_MANIFEST', 'Versioned manifest and stable operationId are required');
  requireSource((manifest.baseSnapshotId || manifest.snapshotId) === baseRelease.snapshotId, 'SOURCE_BASE_CHANGED', 'Manifest snapshot differs from the active database release');
  requireSource((await tx.getConfig('instance-profile')).revisionId === baseRelease.profileRevisionId, 'SOURCE_PROFILE_UNPUBLISHED', 'Publish the profile head before planning a source operation');
  (await assertApproved(tx, manifest));
  (await assertHistoricalDatabaseProofs(tx));
  const documents = await Promise.all(baseRelease.sourceRevisionIds.map(async (id) => (await tx.readDocumentRevision(id))));
  requireSource((await Promise.all(documents.map(async (row) => row && !row.deleted && (await tx.readDocument(row.documentId))?.revisionId === row.revisionId))).every(Boolean), 'SOURCE_HEAD_CHANGED', 'A pinned document is missing or has an unpublished head');
  requireSource(Array.isArray(manifest.changes) && manifest.changes.length > 0 && manifest.changes.length <= 50, 'SOURCE_CHANGES', 'An exact nonempty change list is required');
  const changes = manifest.changes.map((change) => {
    sourceRelative(change.path); const document = documents.find((row) => row.aliases.includes(change.path));
    requireSource(document && change.expectedSha256 === document.sha256, 'SOURCE_OLD_HASH', `Source old hash differs: ${change.path}`);
    requireSource(!('sourceFile' in change) && (typeof change.content === 'string') !== (typeof change.contentBase64 === 'string'), 'SOURCE_INLINE_ONLY', 'Exactly one inline content or contentBase64 is required; external sourceFile reads are prohibited');
    const bytes = Buffer.from(change.content ?? change.contentBase64, change.content === undefined ? 'base64' : 'utf8');
    requireSource(bytes.length <= 5 * 1024 * 1024 && sha256(bytes) === change.newSha256, 'SOURCE_NEW_HASH', `Source replacement bytes differ: ${change.path}`);
    if (manifest.operationType === 'PROMPT_SYNC') requireSource(document.metadata.sourceRole === 'DIRECT_PROMPT', 'SOURCE_ALLOWLIST', 'Prompt synchronization requires an imported DIRECT_PROMPT record');
    return { path: change.path, documentId: document.documentId, revisionId: document.revisionId, oldSha256: document.sha256, newSha256: change.newSha256, bytes };
  });
  requireSource(new Set(changes.map((row) => row.path)).size === changes.length, 'SOURCE_DUPLICATE', 'Source changes contain duplicates');
  if (manifest.operationType === 'CREATIVE_REVISION_SYNC') requireSource(changes.length === 1 && changes[0].path === view.profile.sourceBindings?.creativeRevisionPaths?.[manifest.impact.subjectKind], 'SOURCE_ALLOWLIST', 'Creative synchronization must change only its bound source document');
  const derived = view.profile.sourceBindings?.derivedRegistryPaths;
  requireSource(Array.isArray(derived) && derived.length === 9 && new Set(derived).size === 9 && derived.every((alias) => documents.some((row) => row.aliases.includes(alias))), 'SOURCE_DERIVED_SET', 'All nine derived registry records must be pinned in the same release');
  const compilerRevisions = validateCompiler(manifest.compiler, documents);
  const { media, activeMedia, retiredMedia, retiredContactMedia, mediaFingerprint, activeMediaFingerprint, retiredMediaFingerprint, retiredContactMediaFingerprint } = await captureSourceMedia(tx);
  return { view, baseRelease, documents, changes, media, activeMedia, retiredMedia, retiredContactMedia, events: (await tx.listEvents()), context: {
    instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, baseReleaseId: baseRelease.releaseId, baseSnapshotId: baseRelease.snapshotId,
    profileRevisionId: baseRelease.profileRevisionId, profileHeadRevisionId: (await tx.getConfig('instance-profile')).revisionId,
    sourceRevisionIds: baseRelease.sourceRevisionIds, eventFingerprint: (await eventFingerprint(tx)), mediaFingerprint, activeMediaFingerprint, retiredMediaFingerprint, retiredContactMediaFingerprint, compilerRevisions, compilerAdapterVersion: 'INSTANCE_SOURCE_COMPILER_1.1',
  } };
}
async function assertContext(tx, context) {
  const view = (await tx.readView()); const release = (await tx.readRelease());
  const { mediaFingerprint, activeMediaFingerprint, retiredMediaFingerprint, retiredContactMediaFingerprint } = await captureSourceMedia(tx);
  requireSource(retiredMediaFingerprint === context.retiredMediaFingerprint, 'SOURCE_CAS_CONFLICT', 'Exact historical media retirement bindings changed during compilation');
  requireSource(view.instanceId === context.instanceId && view.runtimeEpoch === context.runtimeEpoch && release?.releaseId === context.baseReleaseId && (await tx.getConfig('instance-profile')).revisionId === context.profileHeadRevisionId && (await eventFingerprint(tx)) === context.eventFingerprint && mediaFingerprint === context.mediaFingerprint && activeMediaFingerprint === context.activeMediaFingerprint && retiredContactMediaFingerprint === context.retiredContactMediaFingerprint, 'SOURCE_CAS_CONFLICT', 'Instance release, profile, media or review inputs changed during compilation; create a new plan');
  for (const id of context.sourceRevisionIds) { const document = (await tx.readDocumentRevision(id)); requireSource(document && (await tx.readDocument(document.documentId))?.revisionId === id, 'SOURCE_CAS_CONFLICT', 'A source document head changed during compilation'); }
}
const artifactSummary = (built) => ({ targetSnapshotId: JSON.parse(built.snapshotBytes).snapshotId, reviewDataSha256: sha256(built.snapshotBytes), recipeSha256: sha256(built.recipesBytes), derivedArtifactHashes: Object.fromEntries(built.derived.map((row) => [row.path, sha256(row.bytes)])), mapProxyAdapter: built.qa?.mapProxyAdapter ?? null, semanticQaAdapter: built.qa?.semanticQaAdapter ?? null, sourceProxyBindings: built.qa?.sourceProxyBindings ?? null });

export async function planInstanceSource(repository, { instanceRoot, manifest, compiler = compileInstanceSource }) {
  return withSourceMediaReadScope(repository, async mediaReadScope => {
  const input = await repository.readTransaction(async (tx) => (await capture(tx, manifest)));
  const built = await compiler({ instanceRoot, ...input, manifest, profile: input.view.profile, mediaReadScope });
  requireSource(built.qa?.status === 'PASS' && objectHash(built.derived.map((row) => row.path).sort()) === objectHash([...input.view.profile.sourceBindings.derivedRegistryPaths].sort()), 'SOURCE_BUILD_QA', 'Compiler must pass QA and return the exact nine derived registries');
  const snapshot = JSON.parse(built.snapshotBytes); const recipes = JSON.parse(built.recipesBytes);
  requireSource(snapshot.snapshotId && snapshot.snapshotId === recipes.snapshotId, 'SOURCE_BUILD_RELEASE', 'Compiler snapshot and recipes differ');
  if (manifest.operationType === 'PROMPT_SYNC') {
    const candidate = input.events.find((row) => row.eventKind === 'asset-version' && row.versionId === manifest.impact.versionId);
    const definitions = recipes.executionDefinitions || [];
    const actual = definitions.find((row) => row.id === candidate.executionDefinitionId);
    requireSource(actual && objectHash(candidate.actualPrompt) === manifest.impact.actualPromptHash && objectHash(actual.prompt) === manifest.impact.actualPromptHash, 'SOURCE_PROMPT_OUTPUT', 'Compiled Prompt is not the exact Prompt used by the approved candidate');
    const previous = JSON.parse(input.baseRelease.recipesBytes).executionDefinitions || [];
    requireSource(definitions.length === previous.length && previous.every((row) => row.id === actual.id || definitions.some((next) => next.id === row.id && objectHash(next.prompt) === objectHash(row.prompt))), 'SOURCE_PROMPT_UNAPPROVED', 'Prompt synchronization changed another execution definition');
  }
  await repository.readTransaction(async (tx) => (await assertContext(tx, input.context)));
  const plan = { schemaVersion: '1.0', mode: 'PLAN_ONLY', sourceMutationPerformed: false, manifest, context: input.context, ...artifactSummary(built), changes: input.changes.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'bytes'))) };
  return { plan: { ...plan, planHash: objectHash(plan) }, input, built };
  });
}
async function aux(tx, key, value) { const old = (await tx.getAux(HOST_NAMESPACE, key)); return (await tx.putAux({ namespace: HOST_NAMESPACE, key, bytes: json(value), expectedRevisionId: old?.revisionId ?? null, mediaType: 'application/json' })); }
async function journal(tx, operationId, phase, data) { const prefix = `journals/${operationId}/`; const sequence = (await tx.listAux(HOST_NAMESPACE, { prefix })).length + 1; (await aux(tx, `${prefix}${String(sequence).padStart(6, '0')}.json`, { operationId, phase, recordedAt: new Date().toISOString(), ...data })); }

export function createSourceApiClient(url = 'http://localhost:3000') {
  const parsed = new URL(url);
  requireSource(parsed.origin === 'http://localhost:3000' && parsed.pathname === '/' && !parsed.username && !parsed.password, 'SOURCE_FORMAL_URL', 'Source apply requires the formal localhost:3000 instance runtime');
  const get = async (route) => { const response = await fetch(new URL(route, parsed), { cache: 'no-store', signal: AbortSignal.timeout(30_000) }); requireSource(response.ok, 'SOURCE_HTTP', `Runtime read failed: ${response.status}`); return response.json(); };
  return { url: parsed.origin, get, async post(body, key) {
    const operations = await get('/api/v8/operations/snapshot'); const payload = { ...body, snapshotId: operations.baseSnapshotId || operations.snapshotId };
    const response = await fetch(new URL('/api/v8/source-operations', parsed), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: parsed.origin, 'If-Match': operations.mutationEtag || operations.etag, 'Idempotency-Key': key }, body: json(payload), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); requireSource(response.ok, 'SOURCE_HTTP', `Source ${body.state} failed (${response.status}): ${result.error || 'unknown error'}`); return result;
  } };
}
async function assertRuntime(repository, client) {
  const view = (await repository.readView()); const runtime = await client.get('/api/instance/runtime');
  for (const field of ['instanceId', 'runtimeEpoch', 'releaseId', 'dataFingerprint', 'recipeFingerprint']) requireSource(runtime[field] === view[field], 'SOURCE_RUNTIME_MISMATCH', `Formal endpoint serves another ${field}`);
  requireSource(runtime.legacySourceFallback === false && ['SINGLE_INSTANCE_SQLITE','SINGLE_INSTANCE_POSTGRESQL'].includes(runtime.storageMode), 'SOURCE_RUNTIME_MODE', 'Formal endpoint is not exclusively using the instance database');
  const bootstrap = await client.get('/api/v8/ui/bootstrap');
  requireSource(bootstrap.snapshotId === view.snapshot.snapshotId && bootstrap.data?.instance?.instanceId === view.instanceId, 'SOURCE_RUNTIME_SNAPSHOT', 'Formal UI bootstrap differs from the database release');
  return view;
}

export async function applyInstanceSource(repository, { instanceRoot, manifest, planHash, client = createSourceApiClient(), compiler = compileInstanceSource }) {
  requireSource(/^[a-f0-9]{64}$/.test(planHash || ''), 'SOURCE_PLAN_REQUIRED', 'Explicit apply requires the exact reviewed plan hash');
  const { plan, input, built } = await planInstanceSource(repository, { instanceRoot, manifest, compiler });
  requireSource(plan.planHash === planHash, 'SOURCE_PLAN_CHANGED', 'The reviewed plan differs from the current exact compilation');
  await assertRuntime(repository, client);
  const sourceOperationId = `sop_${planHash.slice(0, 32)}`; const runtimeBundleId = `instance-build_${planHash}`;
  const operationId = manifest.operationId; let committed = false; let requested = false; let leaseRevision;
  const instanceReal = await realpath(instanceRoot); const backupDirectory = path.join(instanceReal, 'backups');
  try { requireSource(!(await lstat(backupDirectory)).isSymbolicLink(), 'SOURCE_SYMLINK', 'Backup directory cannot be a symbolic link'); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(backupDirectory); }
  const backupPath = path.join(backupDirectory, `source-${sourceOperationId}.${repository.backend==='postgres'?'repository.jsonl':'sqlite'}`);
  const recovery = { strategy: repository.backend==='postgres'?'POSTGRES_REPOSITORY_ARCHIVE_EXPLICIT_RESTORE_OR_RESUME':'SQLITE_ATOMIC_RELEASE_BACKUP_EXPLICIT_RESTORE_OR_RESUME', journal: `${HOST_NAMESPACE}/journals/${operationId}/`, backup: `backups/${path.basename(backupPath)}` };
  const common = { sourceOperationId, baseSnapshotId: plan.context.baseSnapshotId, operationType: manifest.operationType, sourcePaths: input.changes.map((row) => row.path), oldBlockHashes: Object.fromEntries(input.changes.map((row) => [row.path, row.oldSha256])), impact: manifest.impact,
    preview: { workerOperationId: operationId, planHash, changes: plan.changes }, recovery };
  try {
    await repository.writeTransaction(async (tx) => { (await assertContext(tx, plan.context)); requireSource(!(await tx.getAux(HOST_NAMESPACE, 'lease')) || (await tx.getAux(HOST_NAMESPACE, 'lease')).deleted, 'SOURCE_LEASE_HELD', 'Another source operation owns the instance lease; inspect its journal before recovery'); leaseRevision = (await aux(tx, 'lease', { sourceOperationId, planHash, operationId })).revisionId; (await aux(tx, `plans/${sourceOperationId}.json`, plan)); (await journal(tx, operationId, 'APPLY_LEASE_ACQUIRED', { sourceOperationId, planHash })); });
    const backup = (await repository.backupTo(backupPath));
    await repository.writeTransaction(async (tx) => { (await aux(tx, `backups/${sourceOperationId}.json`, { ...backup, path: recovery.backup })); (await journal(tx, operationId, 'BACKUP_VERIFIED', { sha256: backup.sha256, path: recovery.backup })); });
    await client.post({ ...common, state: 'REQUESTED' }, `${sourceOperationId}:REQUESTED`); requested = true;
    await client.post({ sourceOperationId, state: 'STARTED' }, `${sourceOperationId}:STARTED`);
    const activation = { ...artifactSummary(built), runtimeBundleId, newBlockHashes: Object.fromEntries(input.changes.map((row) => [row.path, row.newSha256])), qa: built.qa };
    await client.post({ sourceOperationId, state: 'BUILT', ...activation }, `${sourceOperationId}:BUILT`);
    await repository.writeTransaction(async (tx) => {
      (await assertContext(tx, plan.context)); (await assertApproved(tx, manifest));
      requireSource((await tx.getAux(HOST_NAMESPACE, 'lease'))?.revisionId === leaseRevision, 'SOURCE_LEASE_CHANGED', 'Source operation lease changed');
      const state = (await tx.listEvents('source-operation')).find((row) => row.sourceOperationId === sourceOperationId);
      requireSource(state?.operationState === 'BUILT' && state.preview?.planHash === planHash && state.runtimeBundleId === runtimeBundleId && objectHash(state.impact) === objectHash(manifest.impact) && state.reviewDataSha256 === activation.reviewDataSha256 && state.recipeSha256 === activation.recipeSha256 && objectHash(state.derivedArtifactHashes) === objectHash(activation.derivedArtifactHashes), 'SOURCE_API_AUTHORIZATION', 'The formal source API has not authorized this exact built operation');
      const replacements = new Map();
      for (const output of [...input.changes, ...built.derived]) {
        const old = input.documents.find((row) => row.aliases.includes(output.path));
        requireSource(old, 'SOURCE_DOCUMENT_MISSING', `No pinned source record for ${output.path}`);
        const next = (await tx.putDocument({ documentId: old.documentId, bytes: output.bytes, aliases: old.aliases, expectedRevisionId: old.revisionId, mediaType: old.mediaType, metadata: { ...old.metadata, sourceOperationId } })); replacements.set(old.revisionId, next.revisionId);
      }
      const view = (await tx.publishRelease({ snapshotBytes: built.snapshotBytes, recipesBytes: built.recipesBytes, expectedReleaseId: plan.context.baseReleaseId, sourceRevisionIds: plan.context.sourceRevisionIds.map((id) => replacements.get(id) || id) }));
      (await aux(tx, `commits/${sourceOperationId}.json`, { sourceOperationId, operationId, planHash, runtimeBundleId, releaseId: view.releaseId, runtimeEpoch: view.runtimeEpoch, instanceId: view.instanceId, activation, common, manifest, qa: built.qa }));
      (await journal(tx, operationId, 'RELEASE_COMMITTED', { sourceOperationId, releaseId: view.releaseId, runtimeBundleId, ...activation }));
    });
    committed = true;
    return await resumeInstanceSource(repository, { sourceOperationId, client });
  } catch (error) {
    await repository.writeTransaction(async (tx) => (await journal(tx, operationId, committed ? 'RUNTIME_VERIFICATION_REQUIRED' : 'APPLY_FAILED_NO_SOURCE_COMMIT', { sourceOperationId, error: String(error.message).slice(0, 20_000), recovery })));
    if (requested && !committed) { try { await client.post({ sourceOperationId, state: 'FAILED', newBlockHashes: {}, note: String(error.message).slice(0, 20_000) }, `${sourceOperationId}:FAILED`); } catch { /* Original error and journal remain authoritative; never claim a terminal HTTP state. */ } }
    throw error;
  } finally {
    if (leaseRevision) await repository.writeTransaction(async (tx) => { const lease = (await tx.getAux(HOST_NAMESPACE, 'lease')); if (lease?.revisionId === leaseRevision) (await tx.deleteAux({ namespace: HOST_NAMESPACE, key: 'lease', expectedRevisionId: leaseRevision })); });
  }
}

/** Resume only endpoint verification after a committed release; never reapply source bytes. */
export async function resumeInstanceSource(repository, { sourceOperationId, client = createSourceApiClient() }) {
  requireSource(/^sop_[a-f0-9]{32}$/.test(sourceOperationId), 'SOURCE_OPERATION_ID', 'Exact committed source operation ID is required');
  const record = (await repository.getAux(HOST_NAMESPACE, `commits/${sourceOperationId}.json`));
  requireSource(record && !record.deleted, 'SOURCE_COMMIT_MISSING', 'No committed source release exists for this operation');
  const commit = JSON.parse(record.bytes); const view = await assertRuntime(repository, client);
  requireSource(view.releaseId === commit.releaseId && view.runtimeEpoch === commit.runtimeEpoch, 'SOURCE_RESUME_STALE', 'A different release or restored runtime is active; inspect the backup and create a new plan');
  let state = (await repository.listEvents('source-operation')).find((row) => row.sourceOperationId === sourceOperationId)?.operationState;
  requireSource(['BUILT', 'DEPLOYED', 'SUCCEEDED'].includes(state), 'SOURCE_RESUME_STATE', 'Only a built or deployed committed operation may resume');
  const expected = { sourceOperationId, ...commit.activation };
  if (state === 'SUCCEEDED') { const event = (await repository.listEvents('source-operation')).find((row) => row.sourceOperationId === sourceOperationId); await verifyInstanceSourceProof(repository, { ...expected, deployedEndpointProof: event.deployedEndpointProof }); return { state, sourceOperationId, releaseId: view.releaseId, replayed: true }; }
  const endpoint = { url: client.url, authority: repository.backend === 'postgres' ? 'INSTANCE_POSTGRES' : 'INSTANCE_SQLITE', instanceId: view.instanceId, releaseId: view.releaseId, runtimeEpoch: view.runtimeEpoch,
    snapshotId: commit.activation.targetSnapshotId, runtimeBundleId: commit.runtimeBundleId, reviewDataSha256: commit.activation.reviewDataSha256, recipeSha256: commit.activation.recipeSha256, derivedArtifactHashes: commit.activation.derivedArtifactHashes,
    // Legacy HTTP field names retain their protocol shape; authority identifies these as database release byte hashes.
    containerFileHashes: { reviewDataSha256: commit.activation.reviewDataSha256, recipeSha256: commit.activation.recipeSha256 } };
  const existing = (await repository.getAux(HOST_NAMESPACE, `host_proofs/${sourceOperationId}.json`));
  const verifiedAt = existing ? JSON.parse(existing.bytes).verifiedAt : new Date().toISOString();
  const payload = { schemaVersion: '1.1', proofType: 'HOST_WORKER_FORMAL_DEPLOYMENT_QA', apiSourceOperationId: sourceOperationId, workerOperationId: commit.operationId,
    targetSnapshotId: commit.activation.targetSnapshotId, runtimeBundleId: commit.runtimeBundleId, reviewDataSha256: commit.activation.reviewDataSha256, recipeSha256: commit.activation.recipeSha256,
    derivedArtifactHashes: commit.activation.derivedArtifactHashes, sourceBlockHashes: commit.activation.newBlockHashes, formalUrl: client.url, preDeploymentQaStatus: 'PASS', formalRuntimeQaStatus: 'PASS', deployedEndpointProofHash: objectHash(endpoint), verifiedAt };
  await repository.writeTransaction(async (tx) => { requireSource((await tx.readView()).releaseId === commit.releaseId && (await tx.readView()).runtimeEpoch === commit.runtimeEpoch && (await tx.getAux(HOST_NAMESPACE, `commits/${sourceOperationId}.json`))?.revisionId === record.revisionId, 'SOURCE_PROOF_CAS', 'Source release changed during endpoint verification'); (await aux(tx, `host_proofs/${sourceOperationId}.json`, { ...payload, proofDigest: objectHash(payload) })); (await journal(tx, commit.operationId, 'FORMAL_RUNTIME_VERIFIED', { sourceOperationId, releaseId: view.releaseId, verifiedAt })); });
  await verifyInstanceSourceProof(repository, { ...expected, deployedEndpointProof: endpoint });
  if (state === 'BUILT') await client.post({ sourceOperationId, state: 'DEPLOYED', deployedEndpointProof: endpoint }, `${sourceOperationId}:DEPLOYED`);
  await client.post({ sourceOperationId, state: 'SUCCEEDED', deployedEndpointProof: endpoint, recovery: commit.common.recovery, qa: commit.qa }, `${sourceOperationId}:SUCCEEDED`);
  return { state: 'SUCCEEDED', sourceOperationId, releaseId: view.releaseId, runtimeEpoch: view.runtimeEpoch, sourceMutationPerformed: true };
}
