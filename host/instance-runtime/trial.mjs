import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from './bytes.mjs';

// Host-only adapter: all business state remains in PostgreSQL. No provider calls,
// formal release mutations, rights attestations or file moves occur here.
export class TrialExecutionError extends Error {
  constructor(code, message) { super(message); this.name = 'TrialExecutionError'; this.code = code; }
}
const ensure = (value, code, message) => { if (!value) throw new TrialExecutionError(code, message); };
const parse = (value) => JSON.parse(Buffer.from(value).toString('utf8'));
const hash = (value) => sha256(canonicalJson(value));
const text = (value, label) => { ensure(typeof value === 'string' && value.trim(), 'INVALID_INPUT', `${label} is required`); return value; };
const digest = (value) => ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_SHA', 'Exact SHA-256 required');
const kinds = ['IMAGE', 'AUDIO', 'VIDEO'];
const decode = (entry) => JSON.parse(entry.row.body);
const publicExecution = (request) => { const result = { ...request }; delete result.leaseToken; return result; };
const criteria = [
  { id: 'intent', label: '用途与叙事', description: '符合候选用途，不增加未授权故事事实。' },
  { id: 'material', label: '身份与材质', description: '主体、状态、材质符合完整 Prompt 与精确输入。' },
  { id: 'composition', label: '构图与技术质量', description: '检查构图、完整性、尺寸及实际可见瑕疵。' },
  { id: 'safety', label: '权利与内容检查', description: '检查未经授权的真人、商标、音源及使用范围。' },
];
async function rows(tx, namespace, table) {
  return (await tx.listAux(namespace, { prefix: `${table}/` })).filter((item) => !item.deleted)
    .map((record) => ({ record, row: parse(record.bytes) }))
    .sort((a, b) => Number(a.record.metadata.sourceRowid ?? a.row.sequence ?? 0) - Number(b.record.metadata.sourceRowid ?? b.row.sequence ?? 0) || a.record.key.localeCompare(b.record.key));
}
async function indexState(tx) {
  const record = await tx.getAux('local-trial-index', 'scopes'), scopes = record && !record.deleted ? parse(record.bytes) : [];
  ensure(Array.isArray(scopes) && scopes.every((id) => typeof id === 'string') && new Set(scopes).size === scopes.length, 'TRIAL_INDEX_INVALID', 'Trial scope index is invalid');
  return { record, scopes };
}
async function state(tx, scopeId) {
  const index = await indexState(tx);
  ensure(scopeId && index.scopes.includes(scopeId), 'TRIAL_SCOPE_REQUIRED', 'An existing explicit trial scope is required');
  const namespace = `local-trial:${scopeId}`, configEntry = await tx.getAux(namespace, 'meta/config');
  ensure(configEntry && !configEntry.deleted, 'TRIAL_CONFIG_MISSING', 'Trial configuration is missing');
  const config = JSON.parse(parse(configEntry.bytes).value), events = await rows(tx, namespace, 'events');
  ensure(config.mode === 'LOCAL_TRIAL' && config.scope?.id === scopeId && config.scope.countsTowardFormalProject === false, 'TRIAL_SCOPE_INVALID', 'Trial scope is invalid');
  events.sort((a, b) => a.row.sequence - b.row.sequence);
  let eventHead = '0'.repeat(64);
  for (const entry of events) {
    const event = decode(entry), row = entry.row;
    ensure(event.eventId === row.id && event.eventType === row.type && event.scopeId === scopeId && event.isFormalProjectEvent === false && event.previousHash === eventHead && row.previous_hash === eventHead && hash(event) === row.hash, 'TRIAL_EVENT_INTEGRITY', 'Trial event history is inconsistent');
    eventHead = row.hash;
  }
  const view = await tx.readView();
  return { namespace, scopeId, config, events, eventHead, view, mutationEtag: `"trial:${view.runtimeEpoch}:${eventHead}"`, recipes: await rows(tx, namespace, 'recipes'), executions: await rows(tx, namespace, 'executions'), assets: await rows(tx, namespace, 'assets'), reservations: await rows(tx, namespace, 'reservations') };
}
async function putRow(tx, current, table, key, row, old) {
  const ordinal = table === 'events' ? row.sequence : (await rows(tx, current.namespace, table)).reduce((max, item) => Math.max(max, Number(item.record.metadata.sourceRowid ?? 0)), 0) + 1;
  return tx.putAux({ namespace: current.namespace, key: `${table}/${key}`, bytes: canonicalJson(row), expectedRevisionId: old?.record.revisionId ?? null, mediaType: 'application/json', metadata: old?.record.metadata ?? { authorityDomain: 'LOCAL_TRIAL', deliveryScopeId: current.scopeId, sourceTable: table, sourcePrimaryKey: key, sourceRowid: ordinal } });
}
async function event(tx, current, eventType, payload) {
  const highwater = await tx.getAux(current.namespace, '_schema/sqlite_sequence');
  const sequence = Math.max(current.events.at(-1)?.row.sequence ?? 0, ...(highwater ? parse(highwater.bytes) : []).filter((row) => row.name === 'events').map((row) => row.seq), 0) + 1;
  const body = { eventId: `trial-event:${randomUUID()}`, eventType, payload, createdAt: new Date().toISOString(), mode: 'LOCAL_TRIAL', scopeId: current.scopeId, target: `TRIAL:${current.scopeId}`, isFormalProjectEvent: false, previousHash: current.eventHead };
  const eventHash = hash(body), row = { sequence, id: body.eventId, type: eventType, previous_hash: current.eventHead, hash: eventHash, body: canonicalJson(body) };
  await putRow(tx, current, 'events', sequence, row);
  await tx.importEvent({ bytes: row.body, authorityDomain: 'LOCAL_TRIAL', sourceRef: { scopeId: current.scopeId, sequence, previousHash: current.eventHead, hash: eventHash } });
  current.events.push({ row }); current.eventHead = eventHash; current.mutationEtag = `"trial:${current.view.runtimeEpoch}:${eventHash}"`;
  return { ...body, hash: eventHash };
}
function verifyRepository(repository) { ensure(repository.backend === 'postgres', 'POSTGRES_REQUIRED', 'Trial execution requires authoritative PostgreSQL'); }
function currentAuthorization(current, value) {
  ensure(value?.instanceId === current.view.instanceId && value?.runtimeEpoch === current.view.runtimeEpoch,
    'RUNTIME_EPOCH_CONFLICT', 'Restored trial authorization cannot dispatch; prepare a new authorized scope and recipe');
}
function expectedRuntime(current, body) {
  ensure(typeof body.runtimeEpoch === 'string' && body.runtimeEpoch === current.view.runtimeEpoch,
    'RUNTIME_EPOCH_CONFLICT', 'Request must name the current instance runtime epoch');
}
function validKey(value) { ensure(typeof value === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(value), 'IDEMPOTENCY_REQUIRED', 'Invalid idempotency key'); }
async function mutate(repository, action, body, options, callback) {
  verifyRepository(repository); text(options.scopeId, 'scopeId'); validKey(options.idempotencyKey);
  ensure(!body.scopeId || body.scopeId === options.scopeId, 'RECIPE_SCOPE', 'Body and selected scope differ');
  if (options.root && repository.options?.root) ensure(await realpath(options.root) === await realpath(repository.options.root), 'INSTANCE_MISMATCH', 'Media root differs from the repository instance');
  return repository.writeTransaction(async (tx) => {
    const current = await state(tx, options.scopeId);
    if (['reserve', 'start', 'result'].includes(action)) expectedRuntime(current, body);
    if (['reserve', 'start', 'prepare-recipe'].includes(action)) currentAuthorization(current, current.config);
    const bindingHash = hash({ action, body }), prior = await tx.getAux(current.namespace, `idempotency/${options.idempotencyKey}`);
    if (prior && !prior.deleted) {
      const receipt = parse(prior.bytes);
      if (['reserve', 'start', 'prepare-recipe', 'result'].includes(action)) currentAuthorization(current, receipt);
      ensure(receipt.binding_hash === bindingHash, 'IDEMPOTENCY_CONFLICT', 'Request key was used with different inputs');
      return { ...JSON.parse(receipt.response), replayed: true };
    }
    ensure(options.ifMatch === current.mutationEtag, 'CAS_CONFLICT', 'Trial scope changed; inspect its current ETag');
    const result = { ...await callback(tx, current), mutationEtag: current.mutationEtag, formalProjectChanged: false, replayed: false };
    await putRow(tx, current, 'idempotency', options.idempotencyKey, { key: options.idempotencyKey, binding_hash: bindingHash, response: canonicalJson(result), instanceId: current.view.instanceId, runtimeEpoch: current.view.runtimeEpoch });
    return result;
  });
}
function relativeFile(value) {
  text(value, 'relative path');
  ensure(!path.isAbsolute(value) && !value.includes('\\') && !value.split('/').some((part) => !part || part === '.' || part === '..'), 'PATH_ESCAPE', 'Unambiguous instance-relative path required');
}
async function checkedFile(root, relativePath, { absent = false } = {}) {
  const base = await realpath(root); relativeFile(relativePath); let cursor = base;
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    try { const info = await lstat(cursor); ensure(!info.isSymbolicLink(), 'PATH_ESCAPE', 'Symlink media paths are forbidden'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (absent) return { path: relativePath }; throw error; }
  }
  ensure(!absent, 'OUTPUT_EXISTS', 'Candidate output exists; overwrites are forbidden');
  ensure((await lstat(cursor)).isFile(), 'INVALID_FILE', 'A regular file is required');
  const bytes = await readFile(cursor); return { path: relativePath, bytes, sha256: sha256(bytes), byteSize: bytes.length };
}
function privateOutput(output) {
  ensure(output && typeof output === 'object', 'OUTPUT_REQUIRED', 'Frozen candidate output required');
  relativeFile(output.relativePath); text(output.versionId, 'output.versionId');
  ensure(output.relativePath.startsWith('media/_review_pending/'), 'PRIVATE_OUTPUT_REQUIRED', 'Trial outputs must remain in media/_review_pending');
}
async function verifySources(tx, recipe, root) {
  for (const binding of recipe.sourceBindings ?? []) {
    digest(binding.sha256);
    if (binding.revisionId) {
      const document = await tx.readDocumentRevision(binding.revisionId);
      ensure(document && document.sha256 === binding.sha256 && (!binding.documentId || document.documentId === binding.documentId || document.aliases?.includes(binding.documentId)), 'SOURCE_BINDING', 'Source revision or SHA differs');
    } else { const file = await checkedFile(root, binding.path); ensure(file.sha256 === binding.sha256, 'SOURCE_BINDING', 'Source evidence changed'); }
  }
  for (const binding of recipe.inputBindings ?? []) {
    digest(binding.sha256); const file = await checkedFile(root, binding.path); ensure(file.sha256 === binding.sha256, 'INPUT_CHANGED', 'Input reference bytes changed');
    if (binding.mediaId || binding.versionId) {
      text(binding.mediaId, 'input.mediaId'); text(binding.versionId, 'input.versionId'); const media = await tx.getMedia(binding.mediaId, binding.versionId);
      ensure(media && media.availability === 'PRESENT' && media.sha256 === binding.sha256 && media.relativePath === binding.path, 'INPUT_MEDIA_BINDING', 'Reference differs from its registered version');
    }
  }
}
async function verifyOutputVacant(tx, recipe, root) {
  privateOutput(recipe.output); await checkedFile(root, recipe.output.relativePath, { absent: true });
  ensure(!(await tx.listMedia()).some((item) => item.relativePath === recipe.output.relativePath || item.mediaId === recipe.subjectId && item.versionId === recipe.output.versionId), 'OUTPUT_REGISTERED', 'Output path or version is already registered');
}
function normalizeRecipe(recipe, current) {
  currentAuthorization(current, current.config);
  ensure(recipe && typeof recipe === 'object' && !Array.isArray(recipe), 'RECIPE_REQUIRED', 'Complete recipe required');
  for (const key of ['id', 'subjectId', 'label', 'model', 'fullPrompt']) text(recipe[key], `recipe.${key}`);
  ensure(recipe.mediaKind === 'IMAGE', 'IMAGE_ONLY', 'Audio must use the existing Seed Audio run protocol');
  ensure(['GPT-IMG-2', 'GPT-IMAGE-2', 'gpt-image-2'].includes(recipe.model), 'MODEL_REQUIRED', 'Explicit GPT Image 2 recipe required');
  ensure(Array.isArray(recipe.inputBindings) && Array.isArray(recipe.sourceBindings) && recipe.sourceBindings.length > 0 && Array.isArray(recipe.runtimeBlockers) && recipe.runtimeBlockers.length === 0, 'RECIPE_BLOCKED', 'Exact bindings and cleared preflight blockers required');
  ensure(recipe.authorization?.maxOutputs === 1, 'ONE_CANDIDATE', 'Authorization must permit exactly one candidate');
  text(recipe.authorization.id, 'authorization.id'); text(recipe.authorization.userInstruction, 'authorization.userInstruction'); privateOutput(recipe.output);
  ensure(!recipe.scopeId || recipe.scopeId === current.scopeId, 'RECIPE_SCOPE', 'Recipe belongs to another scope');
  const result = { ...recipe, instanceId: current.view.instanceId, runtimeEpoch: current.view.runtimeEpoch, scopeId: current.scopeId, sourceReleaseId: current.view.releaseId, cost: 1, maximumOutputs: 1, countsTowardFormalProject: false, proposedParameters: recipe.proposedParameters ?? {}, metadataPreparation: recipe.metadataPreparation ?? {}, reviewCriteria: recipe.reviewCriteria ?? criteria };
  ensure(Array.isArray(result.reviewCriteria) && result.reviewCriteria.length > 0 && new Set(result.reviewCriteria.map((item) => item.id)).size === result.reviewCriteria.length && result.reviewCriteria.every((item) => item.id && item.label && item.description), 'REVIEW_CRITERIA', 'Unique complete review criteria required');
  return result;
}
function budget(current, kind) {
  const reservations = current.reservations.map((entry) => entry.row).filter((row) => row.kind === kind);
  const spent = reservations.filter((row) => row.state === 'SETTLED').reduce((total, row) => total + row.actual, 0), reserved = reservations.filter((row) => row.state === 'RESERVED').reduce((total, row) => total + row.amount, 0), limit = current.config.limits[kind] ?? 0;
  return { kind, limit, spent, reserved, available: limit - spent - reserved };
}
export async function instanceTrialInspect(repository, { scopeId } = {}) {
  verifyRepository(repository);
  return repository.readTransaction(async (tx) => {
    const index = await indexState(tx), view = await tx.readView();
    if (!scopeId) return { instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, releaseId: view.releaseId, scopeIds: index.scopes, indexRevisionId: index.record?.revisionId ?? null, formalProjectChanged: false };
    const current = await state(tx, scopeId);
    return { instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, releaseId: view.releaseId, config: current.config, scopeId, mutationEtag: current.mutationEtag, recipes: current.recipes.map(decode), assets: current.assets.map((entry) => ({ ...decode(entry), lifecycle: entry.row.lifecycle })), executions: current.executions.map((entry) => publicExecution(decode(entry))), budgets: kinds.map((kind) => budget(current, kind)), formalProjectChanged: false };
  });
}
export async function instanceTrialPrepareScope(repository, body, options = {}) {
  verifyRepository(repository); validKey(options.idempotencyKey);
  ensure(body.scope?.countsTowardFormalProject === false, 'TRIAL_SCOPE_INVALID', 'Scope must exclude the formal denominator');
  for (const key of ['id', 'title', 'projectTitle']) text(body.scope[key], `scope.${key}`);
  ensure(body.authorization?.maxOutputsPerRecipe === 1, 'ONE_CANDIDATE', 'Scope authorization must limit each recipe to one candidate');
  text(body.authorization.id, 'authorization.id'); text(body.authorization.userInstruction, 'authorization.userInstruction');
  for (const kind of kinds) ensure(Number.isSafeInteger(body.limits?.[kind]) && body.limits[kind] >= 0, 'BUDGET_INVALID', 'All budgets must be explicit nonnegative integers');
  return repository.writeTransaction(async (tx) => {
    const view = await tx.readView();
    const namespace = `local-trial:${body.scope.id}`, bindingHash = hash({ action: 'prepare-scope', body }), prior = await tx.getAux(namespace, `idempotency/${options.idempotencyKey}`);
    if (prior) { const receipt = parse(prior.bytes); currentAuthorization({view}, receipt); ensure(receipt.binding_hash === bindingHash, 'IDEMPOTENCY_CONFLICT', 'Scope request differs'); return { ...JSON.parse(receipt.response), replayed: true }; }
    const index = await indexState(tx);
    ensure(body.expectedReleaseId === view.releaseId && view.releaseId, 'RELEASE_CONFLICT', 'Published release differs');
    ensure(body.expectedIndexRevisionId === (index.record?.revisionId ?? null), 'CAS_CONFLICT', 'Trial index changed');
    ensure(!index.scopes.includes(body.scope.id) && !await tx.getAux(namespace, 'meta/config'), 'SCOPE_EXISTS', 'Trial scope already exists');
    const config = { schemaVersion: 'trial-control/1.0', mode: 'LOCAL_TRIAL', instanceId: view.instanceId, runtimeEpoch: view.runtimeEpoch, scope: { ...body.scope, formalDenominatorEffect: 'NONE' }, limits: body.limits, authorization: body.authorization, sourceReleaseId: view.releaseId, snapshotId: view.snapshot.snapshotId, story: body.story ?? { episodes: [], sourceScenes: [], shotProposals: [], dialogue: [] }, checkpoint: { id: 'GENERATION_AUTHORIZED', state: 'USER_CONFIRMED', decision: body.authorization.userInstruction, next: 'MATERIAL_REVIEW', includesRightsAttestation: false } };
    await tx.putAux({ namespace, key: 'meta/config', bytes: canonicalJson({ key: 'config', value: canonicalJson(config) }), expectedRevisionId: null, metadata: { authorityDomain: 'LOCAL_TRIAL', deliveryScopeId: body.scope.id } });
    await tx.putAux({ namespace: 'local-trial-index', key: 'scopes', bytes: canonicalJson([...index.scopes, body.scope.id]), expectedRevisionId: index.record?.revisionId ?? null });
    const current = await state(tx, body.scope.id), created = await event(tx, current, 'TRIAL_GENERATION_SCOPE_PREPARED', { scopeId: current.scopeId, authorization: body.authorization, sourceReleaseId: view.releaseId, actor: 'CODEX', reviewEffect: 'NO_REVIEW_OR_RELEASE' });
    const result = { scope: config.scope, config, event: created, mutationEtag: current.mutationEtag, formalProjectChanged: false, replayed: false };
    await putRow(tx, current, 'idempotency', options.idempotencyKey, { key: options.idempotencyKey, binding_hash: bindingHash, response: canonicalJson(result), instanceId: current.view.instanceId, runtimeEpoch: current.view.runtimeEpoch }); return result;
  });
}
async function preflightRecipe(tx, current, supplied, root) {
  const recipe = normalizeRecipe(supplied, current);
  ensure(!current.recipes.some((entry) => entry.row.id === recipe.id), 'RECIPE_EXISTS', 'Recipes are immutable; use a new identity');
  if (recipe.sourceRecipeId) {
    const previous = current.recipes.find((entry) => entry.row.id === recipe.sourceRecipeId);
    ensure(previous && (decode(previous).originalSubjectId ?? decode(previous).subjectId) === (recipe.originalSubjectId ?? recipe.subjectId), 'RECIPE_REVISION_SCOPE', 'Recipe revision must preserve the exact logical subject');
  }
  await verifySources(tx, recipe, root); await verifyOutputVacant(tx, recipe, root); return recipe;
}
export async function instanceTrialDryRun(repository, body, { scopeId, root } = {}) {
  verifyRepository(repository);
  ensure(!body.scopeId || body.scopeId === scopeId, 'RECIPE_SCOPE', 'Body and selected scope differ');
  if (repository.options?.root) ensure(await realpath(root) === await realpath(repository.options.root), 'INSTANCE_MISMATCH', 'Media root differs from the repository instance');
  return repository.readTransaction(async (tx) => {
    const current = await state(tx, scopeId), recipe = await preflightRecipe(tx, current, body.recipe, root);
    return { status: 'PREFLIGHT_PASSED', recipe, recipeHash: hash(recipe), mutationEtag: current.mutationEtag, modelCalled: false, formalProjectChanged: false };
  });
}
export async function instanceTrialPrepareRecipe(repository, body, options = {}) {
  return mutate(repository, 'prepare-recipe', body, options, async (tx, current) => {
    const recipe = await preflightRecipe(tx, current, body.recipe, options.root);
    await putRow(tx, current, 'recipes', recipe.id, { id: recipe.id, hash: hash(recipe), body: canonicalJson(recipe) });
    const prepared = await event(tx, current, 'TRIAL_RECIPE_REVISION_PREPARED', { recipeId: recipe.id, sourceRecipeId: recipe.sourceRecipeId ?? null, recipeHash: hash(recipe), sourceBindings: recipe.sourceBindings, authorization: recipe.authorization, actor: 'CODEX_TECHNICAL_PREFLIGHT', reviewEffect: 'NO_REVIEW_OR_RELEASE' });
    return { recipe, recipeHash: hash(recipe), event: prepared };
  });
}
export async function instanceTrialReserve(repository, body, options = {}) {
  return mutate(repository, 'reserve', body, options, async (tx, current) => {
    const entry = current.recipes.find((item) => item.row.id === body.recipeId); ensure(entry, 'RECIPE_NOT_FOUND', 'Recipe not found');
    const recipe = decode(entry); currentAuthorization(current, recipe); ensure(recipe.output && recipe.authorization?.maxOutputs === 1 && hash(recipe) === entry.row.hash, 'RECIPE_NOT_EXECUTABLE', 'Recipe has no frozen one-call authorization');
    ensure(recipe.sourceReleaseId === current.view.releaseId, 'RELEASE_CONFLICT', 'Published release changed after recipe preparation');
    ensure(recipe.runtimeBlockers.length === 0 && recipe.mediaKind === 'IMAGE', 'RECIPE_BLOCKED', 'Recipe cannot use this image executor');
    const logicalMediaId = recipe.originalSubjectId ?? recipe.subjectId;
    const prior = current.executions.map(decode).filter((request) => request.recipeId === recipe.id || request.logicalMediaId === logicalMediaId || request.mediaId === recipe.subjectId || current.recipes.some((item) => item.row.id === request.recipeId && (decode(item).originalSubjectId ?? decode(item).subjectId) === logicalMediaId));
    ensure(!prior.some((request) => request.recipeId === recipe.id || request.authorizationId === recipe.authorization.id), 'ONE_CANDIDATE', 'Exact recipe/authorization already reserved its one call');
    ensure(!prior.some((request) => ['CLAIMED', 'RUNNING', 'RESULT_UNKNOWN'].includes(request.state)), 'EXECUTION_BLOCKED', 'Outstanding or unknown request blocks another call');
    const previousAsset = current.assets.filter((item) => item.row.media_id === recipe.subjectId).at(-1);
    ensure(!previousAsset || ['REVISION_REQUIRED', 'DO_NOT_USE'].includes(previousAsset.row.lifecycle), 'REVIEW_REQUIRED', 'Review the previous candidate before requesting its successor');
    ensure(budget(current, recipe.mediaKind).available >= 1, 'BUDGET_EXHAUSTED', 'Trial budget exhausted');
    await verifySources(tx, recipe, options.root); await verifyOutputVacant(tx, recipe, options.root);
    const leaseMs = body.leaseMs ?? 3600000; ensure(Number.isSafeInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 3600000, 'LEASE_INVALID', 'Lease must be between one second and one hour');
    const now = Date.now(), input = { instanceId: current.view.instanceId, runtimeEpoch: current.view.runtimeEpoch, scopeId: current.scopeId, recipeId: recipe.id, recipeHash: hash(recipe), authorizationId: recipe.authorization.id, sourceReleaseId: current.view.releaseId, bindings: recipe.inputBindings, sourceBindings: recipe.sourceBindings, model: recipe.model, parameters: recipe.proposedParameters, fullPrompt: recipe.fullPrompt, output: recipe.output, maxOutputs: 1 };
    const requestId = `xreq_${randomUUID()}`, request = { requestId, instanceId: current.view.instanceId, runtimeEpoch: current.view.runtimeEpoch, executionRequestId: requestId, recipeId: recipe.id, mediaId: recipe.subjectId, logicalMediaId, scopeId: current.scopeId, authorizationId: recipe.authorization.id, state: 'CLAIMED', executor: 'CODEX', workerId: text(body.workerId, 'workerId'), maxOutputs: 1, registeredOutputs: 0, input, inputHash: hash(input), promptHash: sha256(recipe.fullPrompt), fullPrompt: recipe.fullPrompt, leaseToken: randomUUID(), leaseExpiresAt: now + leaseMs, fencingToken: prior.length + 1, createdAt: now, reservedAmount: 1, mediaKind: recipe.mediaKind };
    await putRow(tx, current, 'executions', requestId, { id: requestId, recipe_id: recipe.id, state: request.state, body: canonicalJson(request) });
    await putRow(tx, current, 'reservations', requestId, { id: requestId, kind: recipe.mediaKind, amount: 1, state: 'RESERVED', actual: 0 });
    await event(tx, current, 'TRIAL_EXECUTION_REQUEST_RESERVED', { ...request, leaseToken: '[HOST_ONLY]' }); return { execution: request };
  });
}
function boundRequest(current, body, allowed, { unexpired = false, reconcile = false } = {}) {
  const entry = current.executions.find((item) => item.row.id === body.requestId); ensure(entry, 'EXECUTION_NOT_FOUND', 'Execution request not found'); const request = decode(entry);
  ensure(request.instanceId === current.view.instanceId && typeof request.runtimeEpoch === 'string'
    && request.input?.instanceId === request.instanceId && request.input.runtimeEpoch === request.runtimeEpoch
    && hash(request.input) === request.inputHash, 'RUNTIME_EPOCH_CONFLICT', 'Execution lacks its original runtime binding');
  if (reconcile) ensure(body.originRuntimeEpoch === request.runtimeEpoch, 'RUNTIME_EPOCH_CONFLICT', 'Reconciliation must name the exact original runtime epoch');
  else currentAuthorization(current, request);
  ensure(allowed.includes(request.state), 'EXECUTION_STATE', `Execution ${request.state} cannot accept this action`);
  ensure(request.leaseToken === body.leaseToken && request.fencingToken === body.fencingToken && (!unexpired || request.leaseExpiresAt > Date.now()), 'LEASE_CONFLICT', 'Lease/fencing token differs or dispatch lease expired');
  ensure(request.inputHash === body.inputHash && request.promptHash === body.promptHash, 'INPUT_HASH_MISMATCH', 'Exact input and complete prompt hashes required'); return { entry, request };
}
export async function instanceTrialStart(repository, body, options = {}) {
  return mutate(repository, 'start', body, options, async (tx, current) => {
    const { entry, request } = boundRequest(current, body, ['CLAIMED'], { unexpired: true }), recipe = decode(current.recipes.find((item) => item.row.id === request.recipeId));
    currentAuthorization(current, recipe);
    ensure(recipe.sourceReleaseId === current.view.releaseId, 'RELEASE_CONFLICT', 'Published release changed before dispatch');
    ensure(!request.dispatchedAt, 'ALREADY_DISPATCHED', 'Request already consumed its dispatch');
    await verifySources(tx, recipe, options.root); await verifyOutputVacant(tx, recipe, options.root);
    request.state = 'RUNNING'; request.dispatchedAt = Date.now(); request.dispatchId = `trial-dispatch:${randomUUID()}`;
    await putRow(tx, current, 'executions', request.requestId, { ...entry.row, state: request.state, body: canonicalJson(request) }, entry);
    await event(tx, current, 'TRIAL_EXECUTION_STARTED', { requestId: request.requestId, dispatchId: request.dispatchId, inputHash: request.inputHash, promptHash: request.promptHash, fencingToken: request.fencingToken, maxOutputs: 1 }); return { execution: request };
  });
}
const blocked = (metadata, qa, key) => metadata[key] === 'BLOCKED' || qa[key] === 'BLOCKED' || qa[key]?.status === 'BLOCKED';
export async function instanceTrialResult(repository, body, options = {}) {
  ensure(['SUCCEEDED', 'FAILED', 'RESULT_UNKNOWN'].includes(body.outcome), 'RESULT_OUTCOME', 'Unsupported result outcome');
  return mutate(repository, 'result', body, options, async (tx, current) => {
    const { entry, request } = boundRequest(current, body, body.reconciled === true ? ['RUNNING', 'RESULT_UNKNOWN'] : ['RUNNING'], {reconcile: body.reconciled === true});
    const recipe = decode(current.recipes.find((item) => item.row.id === request.recipeId)), receipt = body.receipt ?? {}, qa = body.qa ?? {}, metadata = { ...recipe.metadataPreparation, ...body.metadata };
    ensure(Boolean(request.dispatchedAt && request.dispatchId) && receipt.dispatchId === request.dispatchId, 'RECEIPT_BINDING', 'Receipt must identify the exact dispatch');
    if (body.reconciled === true) {
      text(receipt.requestId, 'receipt.requestId');
      ensure(!request.receipt?.requestId || request.receipt.requestId === receipt.requestId, 'RECEIPT_BINDING', 'Reconciliation cannot replace the original provider request');
    }
    if (body.outcome === 'FAILED') ensure(receipt.definitiveFailure === true, 'UNKNOWN_NOT_FAILURE', 'Only definitive provider failures may be FAILED');
    let asset = null;
    if (body.outcome === 'SUCCEEDED') {
      ensure(body.file === recipe.output.relativePath, 'OUTPUT_BINDING', 'File must match the frozen output'); digest(body.sha256);
      const file = await checkedFile(options.root, body.file);
      ensure(file.byteSize > 0 && file.sha256 === body.sha256, 'MEDIA_SHA', 'Actual media bytes differ from reported SHA');
      ensure(['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(file.path).toLowerCase()), 'MEDIA_TYPE', 'Image extension invalid');
      ensure(!current.assets.some((item) => item.row.request_id === request.requestId || item.row.version_id === recipe.output.versionId), 'DUPLICATE_OUTPUT', 'Request/version already has an output');
      ensure(!(await tx.listMedia()).some((item) => item.relativePath === body.file), 'OUTPUT_REGISTERED', 'Candidate path already registered');
      const id = `trial-asset:${randomUUID()}`, version = current.assets.filter((item) => item.row.media_id === request.mediaId).length + 1;
      const status = (key) => blocked(recipe.metadataPreparation, qa, key) || blocked(metadata, qa, key) ? 'BLOCKED' : 'UNKNOWN';
      asset = { id, mediaId: request.mediaId, subjectId: request.mediaId, versionId: recipe.output.versionId, version, sha256: file.sha256, byteSize: file.byteSize, relativePath: file.path, sourcePath: file.path, requestId: request.requestId, recipeId: recipe.id, mediaKind: recipe.mediaKind, title: recipe.label, lifecycle: 'REVIEW_PENDING', rightsStatus: status('RIGHTS_STATUS'), safetyStatus: status('SAFETY_STATUS'), minorSafetyStatus: status('MINOR_SAFETY_STATUS'), scopeId: current.scopeId, countsTowardFormalProject: false, sourceRequirementId: recipe.sourceRequirementId ?? null, sourceTrialThemeId: recipe.sourceTrialThemeId ?? null, createdAt: Date.now(), metadata: { ...metadata, RIGHTS_STATUS: status('RIGHTS_STATUS'), EXECUTION_REQUEST_ID: request.requestId, INPUT_HASH: request.inputHash, PROMPT_HASH: request.promptHash, MODEL_VERSION: receipt.modelVersion ?? 'UNKNOWN_UNTIL_PROVIDER_RECEIPT' }, prompt: { main: recipe.mainPrompt ?? recipe.fullPrompt, negative: recipe.negativePrompt ?? '', full: request.fullPrompt, sha256: request.promptHash, model: recipe.model, parameters: recipe.proposedParameters, inputs: recipe.inputBindings }, qa, receipt, reviewCriteria: recipe.reviewCriteria };
      await tx.registerMedia({ mediaId: asset.mediaId, versionId: asset.versionId, relativePath: asset.relativePath, sha256: asset.sha256, byteSize: asset.byteSize, metadata: { authorityDomain: 'LOCAL_TRIAL', trialAssetId: id, trialScopeId: current.scopeId, visibility: 'PRIVATE', countsTowardFormalProject: false, rightsStatus: asset.rightsStatus } });
      await putRow(tx, current, 'assets', id, { id, request_id: request.requestId, media_id: asset.mediaId, version_id: asset.versionId, sha256: asset.sha256, lifecycle: 'REVIEW_PENDING', review_head: null, body: canonicalJson(asset) });
      request.registeredOutputs = 1; request.assetVersionId = asset.versionId;
    }
    request.state = body.outcome; request.receipt = receipt; request.finishedAt = Date.now();
    const reservation = current.reservations.find((item) => item.row.id === request.requestId); ensure(reservation, 'RESERVATION_MISSING', 'Original budget reservation missing');
    // Failures and unknown results consume their one call; neither creates free retries.
    await putRow(tx, current, 'reservations', request.requestId, { ...reservation.row, state: 'SETTLED', actual: 1 }, reservation);
    await putRow(tx, current, 'executions', request.requestId, { ...entry.row, state: request.state, body: canonicalJson(request) }, entry);
    await event(tx, current, 'TRIAL_EXECUTION_RESULT_RECORDED', { requestId: request.requestId, outcome: body.outcome, receipt, assetId: asset?.id ?? null, sha256: asset?.sha256 ?? null, lifecycle: asset ? 'REVIEW_PENDING' : null, retryAllowed: false, runtimeEpoch: current.view.runtimeEpoch, originRuntimeEpoch: request.runtimeEpoch, reconciled: body.reconciled === true });
    return { execution: publicExecution(request), asset };
  });
}
export async function instanceTrialAnnotateQa(repository, body, options = {}) {
  return mutate(repository, 'annotate-qa', body, options, async (tx, current) => {
    digest(body.sha256); digest(body.evidenceSha256);
    const entry = current.assets.find((item) => item.row.version_id === body.versionId); ensure(entry && entry.row.sha256 === body.sha256, 'QA_BINDING', 'QA must identify exact version and SHA');
    const asset = decode(entry), media = await checkedFile(options.root, asset.relativePath); ensure(media.sha256 === asset.sha256, 'MEDIA_SHA', 'Candidate bytes changed');
    const evidence = await checkedFile(options.root, body.evidencePath); ensure(evidence.sha256 === body.evidenceSha256 && ['.json', '.md', '.markdown'].includes(path.extname(evidence.path)), 'QA_EVIDENCE_SHA', 'Exact JSON or Markdown evidence required');
    ensure(body.observations && typeof body.observations === 'object' && !Array.isArray(body.observations), 'QA_OBSERVATIONS', 'Structured QA observations required'); text(body.observations.summary, 'QA summary');
    ensure(body.observations.visualPass === undefined || typeof body.observations.visualPass === 'boolean', 'QA_OBSERVATIONS', 'visualPass must be boolean');
    const observation = await event(tx, current, 'TRIAL_ASSET_QA_OBSERVATION', { assetId: asset.id, mediaId: asset.mediaId, versionId: asset.versionId, sha256: asset.sha256, actor: 'CODEX', observations: body.observations, evidence: { path: evidence.path, sha256: evidence.sha256, content: evidence.bytes.toString('utf8') }, sourceSHA: evidence.sha256, isUserReview: false, reviewEffect: 'NO_REVIEW_OR_RELEASE' });
    return { event: observation, asset: { ...asset, lifecycle: entry.row.lifecycle } };
  });
}
