import { canonicalJson, sha256 } from './instance-runtime/index.mjs';
import { withSourceMediaReadScope, captureSourceMedia } from './instance-source-media.mjs';
import { compileInstanceExtension, sourceRelative, validateCompiler } from './instance-source-compiler.mjs';
import { HOST_NAMESPACE, objectHash, requireSource } from './instance-source-proof.mjs';
import { assertHistoricalDatabaseProofs } from './instance-source-controller.mjs';
import { assertMapProxyAdapterParity } from './instance-map-proxy-adapter.mjs';
import { assertSemanticQaAdapterParity } from './instance-semantic-qa-adapter.mjs';

export const EXTENSION_NAMESPACE = 'instance-extension-maintenance';
const strict = (value, keys, code) => requireSource(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)), code, 'Unexpected manifest fields are forbidden');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const compilerKeys = ['workflowPath', 'storyQaPath', 'registryBuilderPath', 'snapshotBuilderPath', 'semanticQaPath', 'snapshotPath', 'recipesPath', 'eventDirectory'];
const artifactSummary = result => ({ snapshotHash: objectHash(JSON.parse(result.snapshotBytes)), recipesHash: objectHash(JSON.parse(result.recipesBytes)), derived: Object.fromEntries(result.derived.map(row => [row.path, objectHash(JSON.parse(row.bytes))]).sort(([a], [b]) => a.localeCompare(b))) });
// These are generated release metadata projections, never event/candidate/context identities.
const snapshotIdPaths = {
  snapshot: [['snapshotId'], ['executionRecipeSummary', 'snapshotId'], ['productionModel', 'executionRecipeSummary', 'snapshotId'], ['productionModel', 'systemModel', 'snapshotId'], ['productionModel', 'snapshotManifest', 'snapshotId']],
  recipes: [['snapshotId']],
};
const sourceCatalogPaths = {
  snapshot: [['executionRecipeSummary', 'sourceCatalog'], ['productionModel', 'executionRecipeSummary', 'sourceCatalog'], ['productionModel', 'snapshotManifest', 'sourceCatalog']],
  recipes: [['sourceCatalog']],
};
const at = (value, parts) => parts.reduce((parent, key) => parent?.[key], value);
const pointer = parts => '/' + parts.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
function semanticDifferences(before, after) {
  const paths = []; let total = 0;
  function walk(a, b, parts) {
    if (canonicalJson(a) === canonicalJson(b)) return;
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(a[key], b[key], [...parts, key]);
      return;
    }
    total += 1;
    if (paths.length < 100) paths.push({ path: pointer(parts), beforeHash: a === undefined ? null : objectHash(a), afterHash: b === undefined ? null : objectHash(b) });
  }
  walk(before, after, []); return { total, paths, truncated: total > paths.length };
}
function compareArtifacts(baseline, proposed, input) {
  const parse = result => ({ snapshot: JSON.parse(result.snapshotBytes), recipes: JSON.parse(result.recipesBytes), derived: Object.fromEntries(result.derived.map(row => [row.path, JSON.parse(row.bytes)])) });
  const before = parse(baseline); const after = parse(proposed); const normalizations = [];
  const allowed = new Map(input.changes.flatMap(change => input.documents.find(row => row.documentId === change.documentId).aliases.map(alias => [alias, change])));
  for (const [artifact, paths] of Object.entries(sourceCatalogPaths)) for (const parts of paths) {
    const oldRows = at(before[artifact], parts); const newRows = at(after[artifact], parts);
    if (!Array.isArray(oldRows) || !Array.isArray(newRows)) continue;
    for (let index = 0; index < oldRows.length; index += 1) {
      const oldRow = oldRows[index]; const newRow = newRows[index]; const change = allowed.get(oldRow?.path);
      // Identity, order, role, authority, and every other catalog field still compare in full.
      if (!change || oldRow.role !== 'GENERATOR_CODE' || newRow?.role !== 'GENERATOR_CODE' || newRow.path !== oldRow.path || oldRow.sha256 !== change.oldSha || newRow.sha256 !== change.newSha) continue;
      normalizations.push({ path: pointer([artifact, ...parts, index, 'sha256']), kind: 'AUTHORIZED_GENERATOR_SHA', alias: oldRow.path, oldSha: change.oldSha, newSha: change.newSha });
      newRow.sha256 = oldRow.sha256;
    }
  }
  const oldId = before.snapshot.snapshotId; const newId = after.snapshot.snapshotId;
  // An ID-only change is not exempt. A changed exact generator fingerprint must explain it.
  if (oldId !== newId && normalizations.length) for (const [artifact, paths] of Object.entries(snapshotIdPaths)) for (const parts of paths) {
    if (at(before[artifact], parts) !== oldId || at(after[artifact], parts) !== newId) continue;
    normalizations.push({ path: pointer([artifact, ...parts]), kind: 'GENERATED_SNAPSHOT_ID', before: oldId, after: newId });
    at(after[artifact], parts.slice(0, -1))[parts.at(-1)] = oldId;
  }
  const differences = semanticDifferences(before, after);
  if (differences.total) {
    const error = new Error(`New extensions alter current business projection at ${differences.total} field(s): ${differences.paths.slice(0, 10).map(row => row.path).join(', ')}`);
    error.code = 'EXTENSION_SEMANTIC_DRIFT'; error.differences = differences; error.allowedMetadataChanges = normalizations; throw error;
  }
  return { mode: 'FULL_BUSINESS_PARITY_EXACT_GENERATOR_METADATA', status: 'PASS', artifacts: artifactSummary(proposed), baselineArtifacts: artifactSummary(baseline), normalizedArtifactHash: objectHash(before), allowedMetadataChanges: normalizations };
}
const receiptKey = operationId => `commits/${operationId}.json`;

function validateManifest(manifest, softwareCommit) {
  strict(manifest, ['schemaVersion', 'operationId', 'instanceId', 'baseReleaseId', 'softwareCommit', 'compiler', 'extensions'], 'EXTENSION_MANIFEST');
  requireSource(manifest.schemaVersion === '1.0' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(manifest.operationId || ''), 'EXTENSION_MANIFEST', 'Versioned manifest and stable operation identity required');
  requireSource(/^[a-f0-9]{40,64}$/.test(softwareCommit || '') && manifest.softwareCommit === softwareCommit, 'EXTENSION_SOFTWARE', 'Manifest must bind the exact current software commit');
  strict(manifest.compiler, compilerKeys, 'EXTENSION_COMPILER');
  requireSource(compilerKeys.every(key => typeof manifest.compiler[key] === 'string'), 'EXTENSION_COMPILER', 'All exact compiler entry and output paths required');
  requireSource(Array.isArray(manifest.extensions) && manifest.extensions.length >= 1 && manifest.extensions.length <= 50, 'EXTENSION_CHANGES', 'An exact nonempty extension change list is required');
}

async function capture(tx, manifest, softwareCommit) {
  validateManifest(manifest, softwareCommit);
  const view = (await tx.readView()); const baseRelease = (await tx.readRelease());
  requireSource(view.instanceId === manifest.instanceId && baseRelease?.releaseId === manifest.baseReleaseId, 'EXTENSION_BASE_CHANGED', 'Manifest instance or release differs from the active authority');
  requireSource((await tx.getConfig('instance-profile'))?.revisionId === baseRelease.profileRevisionId, 'EXTENSION_PROFILE_UNPUBLISHED', 'Profile head differs from the published profile');
  const sourceLease = (await tx.getAux(HOST_NAMESPACE, 'lease'));
  requireSource(!sourceLease || sourceLease.deleted, 'EXTENSION_SOURCE_BUSY', 'Source synchronization is active; complete or recover it first');
  (await assertHistoricalDatabaseProofs(tx));
  const documents = await Promise.all(baseRelease.sourceRevisionIds.map(async id => (await tx.readDocumentRevision(id))));
  requireSource((await Promise.all(documents.map(async row => row && !row.deleted && sha256(row.bytes) === row.sha256 && (await tx.readDocument(row.documentId))?.revisionId === row.revisionId))).every(Boolean), 'EXTENSION_HEAD_CHANGED', 'A published document is missing, modified, or has an unpublished head');
  const compilerRevisions = validateCompiler(manifest.compiler, documents);
  const protectedAliases = new Set([...Object.values(view.profile.sourceBindings?.creativeRevisionPaths || {}), ...(view.profile.sourceBindings?.derivedRegistryPaths || []), ...((JSON.parse(baseRelease.recipesBytes).sourceCatalog || []).filter(row => row.role !== 'GENERATOR_CODE').map(row => row.path).filter(Boolean))]);
  const changes = manifest.extensions.map(item => {
    strict(item, ['alias', 'oldRevisionId', 'oldSha', 'newSha', 'content'], 'EXTENSION_FIELDS');
    sourceRelative(item.alias);
    const document = documents.find(row => row.aliases.includes(item.alias));
    requireSource(document?.metadata.sourceRole === 'INSTANCE_EXTENSION' && document.revisionId === item.oldRevisionId && document.sha256 === item.oldSha, 'EXTENSION_NOT_PINNED', `Exact published INSTANCE_EXTENSION required: ${item.alias}`);
    requireSource(!document.aliases.some(alias => protectedAliases.has(alias) || /^production\/prompts\/direct\//.test(alias)), 'EXTENSION_PROTECTED_ALIAS', 'Extension identity collides with a protected business source');
    requireSource(typeof item.content === 'string' && Buffer.byteLength(item.content) <= 5 * 1024 * 1024 && digest(item.newSha) && sha256(item.content) === item.newSha && item.newSha !== item.oldSha, 'EXTENSION_BYTES', 'Replacement requires exact changed UTF-8 content and SHA');
    return { alias: item.alias, documentId: document.documentId, oldRevisionId: document.revisionId, oldSha: document.sha256, newSha: item.newSha, bytes: Buffer.from(item.content) };
  });
  requireSource(new Set(changes.map(item => item.documentId)).size === changes.length, 'EXTENSION_DUPLICATE', 'One extension identity may only occur once, including alternate aliases');
  const derived = view.profile.sourceBindings?.derivedRegistryPaths;
  requireSource(Array.isArray(derived) && derived.length === 9 && new Set(derived).size === 9 && derived.every(alias => documents.some(row => row.aliases.includes(alias))), 'EXTENSION_DERIVED_SET', 'The exact current nine-registry set must remain release bound');
  const { media, activeMedia, retiredMedia, retiredContactMedia, mediaFingerprint, activeMediaFingerprint, retiredMediaFingerprint, retiredContactMediaFingerprint } = await captureSourceMedia(tx); const events = (await tx.listEvents());
  const context = { instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, baseReleaseId: baseRelease.releaseId, profileRevisionId: baseRelease.profileRevisionId, sourceRevisionIds: baseRelease.sourceRevisionIds, documentFingerprint: objectHash(documents.map(({ documentId, revisionId, sha256, aliases, metadata }) => ({ documentId, revisionId, sha256, aliases, metadata }))), eventFingerprint: objectHash(events), mediaFingerprint, activeMediaFingerprint, retiredContactMediaFingerprint, sourceLeaseRevisionId: sourceLease?.revisionId || null, compilerRevisions, softwareCommit, adapterVersion: 'INSTANCE_EXTENSION_COMPATIBILITY_1.2' };
  context.retiredMediaFingerprint = retiredMediaFingerprint;
  return { view, baseRelease, documents, changes, media, activeMedia, retiredMedia, retiredContactMedia, events, context };
}
async function assertContext(tx, manifest, context, softwareCommit) {
  requireSource(objectHash((await capture(tx, manifest, softwareCommit)).context) === objectHash(context), 'EXTENSION_CAS_CONFLICT', 'Release, source heads, events, media, profile or source lease changed; create a new plan');
}
function validateBuild(result, input) {
  requireSource(result.qa?.status === 'PASS' && Array.isArray(result.derived) && objectHash(result.derived.map(row => row.path).sort()) === objectHash([...input.view.profile.sourceBindings.derivedRegistryPaths].sort()), 'EXTENSION_QA', 'Compiler must pass QA with the exact nine derived outputs');
  const data = JSON.parse(result.snapshotBytes); const recipes = JSON.parse(result.recipesBytes);
  requireSource(data.snapshotId && data.snapshotId === recipes.snapshotId, 'EXTENSION_BUILD_RELEASE', 'Snapshot and recipe identity differ');
}

export async function planInstanceExtension(repository, { instanceRoot, manifest, softwareCommit = process.env.REVIEW_SOFTWARE_COMMIT, compiler = compileInstanceExtension }) {
  return withSourceMediaReadScope(repository, async mediaReadScope => {
  const input = await repository.readTransaction(async tx => (await capture(tx, manifest, softwareCommit)));
  const common = { instanceRoot, ...input, manifest: { compiler: manifest.compiler, changes: [] }, profile: input.view.profile, mediaReadScope };
  const baseline = await compiler(common); validateBuild(baseline, input);
  const byId = new Map(input.changes.map(change => [change.documentId, change]));
  const documents = input.documents.map(document => { const change = byId.get(document.documentId); return change ? { ...document, bytes: change.bytes, sha256: change.newSha } : document; });
  const proposed = await compiler({ ...common, documents }); validateBuild(proposed, input);
  assertMapProxyAdapterParity(baseline.qa?.mapProxyAdapter, proposed.qa?.mapProxyAdapter);
  assertSemanticQaAdapterParity(baseline.qa?.semanticQaAdapter, proposed.qa?.semanticQaAdapter);
  const compatibility = { ...compareArtifacts(baseline, proposed, input), mapProxyAdapter: baseline.qa?.mapProxyAdapter ?? null, semanticQaAdapter: baseline.qa?.semanticQaAdapter ?? null };
  await repository.readTransaction(async tx => (await assertContext(tx, manifest, input.context, softwareCommit)));
  // Publication retains existing snapshot/recipe/registry bytes. Baseline compiler output
  // may expose preexisting generation drift; record it without adopting that drift.
  const plan = { schemaVersion: '1.0', mode: 'PLAN_ONLY', sourceMutationPerformed: false, businessAdoptionPerformed: false, manifestHash: objectHash(manifest), operationId: manifest.operationId, context: input.context, changes: input.changes.map(row => ({alias:row.alias,documentId:row.documentId,oldRevisionId:row.oldRevisionId,oldSha:row.oldSha,newSha:row.newSha})), compatibility, preservedRelease: { snapshotSha256: input.baseRelease.snapshotSha256, recipesSha256: input.baseRelease.recipesSha256 } };
  return { plan: { ...plan, planHash: objectHash(plan) }, input };
  });
}

export function createExtensionRuntimeClient(url = 'http://localhost:3000') {
  const origin = new URL(url);
  requireSource(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.pathname === '/' && !origin.username && !origin.password, 'EXTENSION_RUNTIME_URL', 'An explicit local instance runtime is required');
  return { url: origin.origin, async read() { const response = await fetch(new URL('/api/instance/runtime', origin), { cache: 'no-store', signal: AbortSignal.timeout(30_000) }); requireSource(response.ok, 'EXTENSION_RUNTIME_UNAVAILABLE', 'Instance runtime unavailable'); return response.json(); } };
}
async function verifyRuntime(repository, client, softwareCommit, expectedReleaseId, expectedRuntimeEpoch) {
  const runtime = await client.read(); const view = (await repository.readView());
  requireSource(view.runtimeEpoch === expectedRuntimeEpoch, 'EXTENSION_RUNTIME_EPOCH', 'Runtime was restored or copied after this operation; its old maintenance receipt cannot resume');
  requireSource(view.releaseId === expectedReleaseId && runtime.softwareCommit === softwareCommit && ['SINGLE_INSTANCE_SQLITE','SINGLE_INSTANCE_POSTGRESQL'].includes(runtime.storageMode) && runtime.legacySourceFallback === false, 'EXTENSION_RUNTIME_MISMATCH', 'Runtime software, release or storage mode differs');
  for (const key of ['instanceId', 'runtimeEpoch', 'releaseId', 'dataFingerprint', 'recipeFingerprint']) requireSource(runtime[key] === view[key], 'EXTENSION_RUNTIME_MISMATCH', `Runtime ${key} differs`);
  return { url: client.url, instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, releaseId: view.releaseId, softwareCommit, dataFingerprint: view.dataFingerprint, recipeFingerprint: view.recipeFingerprint };
}
export async function applyInstanceExtension(repository, { instanceRoot, manifest, planHash, softwareCommit = process.env.REVIEW_SOFTWARE_COMMIT, compiler = compileInstanceExtension, client = createExtensionRuntimeClient() }) {
  validateManifest(manifest, softwareCommit);
  requireSource(digest(planHash), 'EXTENSION_PLAN_REQUIRED', 'Explicit apply requires the reviewed plan hash');
  const prior = (await repository.getAux(EXTENSION_NAMESPACE, receiptKey(manifest.operationId)));
  if (prior && !prior.deleted) {
    const receipt = JSON.parse(prior.bytes);
    requireSource(receipt.planHash === planHash && receipt.manifestHash === objectHash(manifest), 'EXTENSION_OPERATION_REUSED', 'Operation identity has another committed manifest');
    await repository.readTransaction(async tx => {
      const release = (await tx.readRelease());
      requireSource(release?.releaseId === receipt.releaseId && (await tx.getConfig('instance-profile'))?.revisionId === release.profileRevisionId && release.profileRevisionId === receipt.context.profileRevisionId && release.snapshotSha256 === receipt.preservedRelease.snapshotSha256 && release.recipesSha256 === receipt.preservedRelease.recipesSha256, 'EXTENSION_RECEIPT_STALE', 'The committed extension release is no longer current');
      for (const id of release.sourceRevisionIds) { const record = (await tx.readDocumentRevision(id)); requireSource(record && (await tx.readDocument(record.documentId))?.revisionId === id, 'EXTENSION_RECEIPT_STALE', 'A committed source now has an unpublished head'); }
      for (const item of receipt.extensions) { const record = (await tx.readDocumentRevision(item.newRevisionId)); requireSource(release.sourceRevisionIds.includes(item.newRevisionId) && record?.sha256 === item.newSha && record?.documentId === item.documentId, 'EXTENSION_RECEIPT_STALE', 'The exact committed extension binding changed'); }
    });
    const runtime = await verifyRuntime(repository, client, softwareCommit, receipt.releaseId, receipt.runtimeEpoch);
    return { ...receipt, runtime, state: 'SUCCEEDED', replayed: true };
  }
  const { plan, input } = await planInstanceExtension(repository, { instanceRoot, manifest, softwareCommit, compiler });
  requireSource(plan.planHash === planHash, 'EXTENSION_PLAN_CHANGED', 'Current exact compilation differs from the reviewed plan');
  await verifyRuntime(repository, client, softwareCommit, input.baseRelease.releaseId, input.context.runtimeEpoch);
  const receipt = await repository.writeTransaction(async tx => {
    (await assertContext(tx, manifest, input.context, softwareCommit));
    requireSource(!(await tx.getAux(EXTENSION_NAMESPACE, receiptKey(manifest.operationId))), 'EXTENSION_OPERATION_REUSED', 'Operation identity is already recorded');
    const replacements = new Map(); const extensions = [];
    for (const change of input.changes) {
      const old = input.documents.find(document => document.documentId === change.documentId);
      const next = (await tx.putDocument({ documentId: old.documentId, aliases: old.aliases, bytes: change.bytes, expectedRevisionId: old.revisionId, mediaType: old.mediaType, metadata: { ...old.metadata, extensionMaintenanceOperationId: manifest.operationId, extensionSoftwareCommit: softwareCommit } }));
      replacements.set(old.revisionId, next.revisionId); extensions.push({ ...plan.changes.find(row => row.documentId === change.documentId), newRevisionId: next.revisionId });
    }
    const view = (await tx.publishRelease({ snapshotBytes: input.baseRelease.snapshotBytes, recipesBytes: input.baseRelease.recipesBytes, expectedReleaseId: input.baseRelease.releaseId, sourceRevisionIds: input.baseRelease.sourceRevisionIds.map(id => replacements.get(id) || id) }));
    const result = { schemaVersion: '1.0', operationId: manifest.operationId, manifestHash: objectHash(manifest), planHash, instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, baseReleaseId: input.baseRelease.releaseId, releaseId: view.releaseId, softwareCommit, extensions, context: plan.context, compatibility: plan.compatibility, preservedRelease: plan.preservedRelease, businessAdoptionPerformed: false, formalEventsWritten: 0, mediaMutations: 0, recordedAt: new Date().toISOString() };
    (await tx.putAux({ namespace: EXTENSION_NAMESPACE, key: receiptKey(manifest.operationId), bytes: canonicalJson(result), expectedRevisionId: null, mediaType: 'application/json' }));
    return result;
  });
  try { return { ...receipt, runtime: await verifyRuntime(repository, client, softwareCommit, receipt.releaseId, receipt.runtimeEpoch), state: 'SUCCEEDED', replayed: false }; }
  catch (cause) { const error = new Error('Extensions committed; runtime verification remains required', { cause }); error.code = 'EXTENSION_COMMITTED_RUNTIME_VERIFICATION_REQUIRED'; error.committedReleaseId = receipt.releaseId; error.operationId = manifest.operationId; throw error; }
}
