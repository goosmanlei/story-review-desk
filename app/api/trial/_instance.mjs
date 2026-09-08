import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../../../host/instance-runtime/bytes.mjs';

export class TrialRepositoryError extends Error {
  constructor(code, message) { super(message); this.name = 'TrialRepositoryError'; this.code = code; }
}
const ensure = (condition, code, message) => { if (!condition) throw new TrialRepositoryError(code, message); };
const parse = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));
const hashJson = (value) => sha256(canonicalJson(value));
const originalBody = (row) => JSON.parse(row.body);
const kinds = ['IMAGE', 'AUDIO', 'VIDEO'];
const blockedObservation = (qa) => qa?.technicalStatus === 'NEEDS_CORRECTION' || qa?.visualPass === false;

async function scopeIds(tx) {
  const index = await tx.getAux('local-trial-index', 'scopes');
  if (!index || index.deleted) return [];
  const ids = parse(index.bytes);
  ensure(Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length, 'TRIAL_IMPORT_INVALID', '试制范围索引无效。');
  return ids;
}
export async function instanceTrialScopes(repository) {
  return repository.readTransaction(async (tx) => {
    const scopes = [];
    for (const id of await scopeIds(tx)) {
      const record = await tx.getAux(`local-trial:${id}`, 'meta/config');
      ensure(record && !record.deleted, 'TRIAL_IMPORT_INVALID', '试制配置缺失。');
      const config = JSON.parse(parse(record.bytes).value);
      ensure(config.scope?.id === id && config.scope.countsTowardFormalProject === false, 'TRIAL_SCOPE_INVALID', '试制权限范围不匹配。');
      scopes.push(config.scope);
    }
    return { scopes, defaultScopeId: scopes[0]?.id ?? null, sourceAuthority: 'POSTGRES', formalProjectChanged: false };
  });
}

/** Imported table rows keep their original TEXT columns; the aux revision owns the mutable head. */
async function tableRows(tx, namespace, table) {
  return (await tx.listAux(namespace, { prefix: `${table}/` })).map((record) => ({ record, row: parse(record.bytes) }))
    .sort((a, b) => Number(a.record.metadata.sourceRowid ?? a.row.sequence ?? 0) - Number(b.record.metadata.sourceRowid ?? b.row.sequence ?? 0) || a.record.key.localeCompare(b.record.key));
}
async function scopeState(tx, explicitScopeId) {
  const index = (await tx.getAux('local-trial-index', 'scopes'));
  ensure(index && !index.deleted, 'TRIAL_NOT_IMPORTED', '本实例尚未导入试制范围。');
  const scopes = parse(index.bytes);
  ensure(Array.isArray(scopes) && scopes.every((id) => typeof id === 'string') && new Set(scopes).size === scopes.length, 'TRIAL_IMPORT_INVALID', '试制范围索引无效。');
  const scopeId = explicitScopeId || (scopes.length === 1 ? scopes[0] : null);
  ensure(scopeId && scopes.includes(scopeId), 'TRIAL_SCOPE_REQUIRED', '存在多个试制范围，请明确选择本次范围。');
  const namespace = `local-trial:${scopeId}`;
  const configuration = (await tx.getAux(namespace, 'meta/config'));
  ensure(configuration && !configuration.deleted, 'TRIAL_IMPORT_INVALID', '试制配置缺失。');
  const config = JSON.parse(parse(configuration.bytes).value);
  ensure(config.mode === 'LOCAL_TRIAL' && config.scope?.id === scopeId && config.scope.countsTowardFormalProject === false, 'TRIAL_SCOPE_INVALID', '试制权限范围不匹配。');
  const events = (await tableRows(tx, namespace, 'events')).sort((a, b) => a.row.sequence - b.row.sequence);
  let previous = '0'.repeat(64);
  for (const { row } of events) {
    const event = originalBody(row);
    ensure(event.eventId === row.id && event.eventType === row.type && event.scopeId === scopeId && event.isFormalProjectEvent === false && event.previousHash === previous && row.previous_hash === previous && hashJson(event) === row.hash, 'TRIAL_EVENT_INTEGRITY', '试制事件原文或历史链不一致。');
    previous = row.hash;
  }
  const epoch = (await tx.readView()).runtimeEpoch;
  return { namespace, scopeId, config, events, eventHead: previous, etag: `"trial:${epoch}:${previous}"`, assets: (await tableRows(tx, namespace, 'assets')), executions: (await tableRows(tx, namespace, 'executions')) };
}
function blockingFacts(item) {
  const metadata = item.metadata ?? {}; const qa = item.qa ?? {};
  const blocked = (...values) => values.some((value) => value === 'BLOCKED' || value?.status === 'BLOCKED' || value?.blocked === true);
  const issues = (qa.blockingIssues ?? []).filter((value) => typeof value === 'string').map((value) => value.toUpperCase());
  return blocked(item.rightsStatus, metadata.RIGHTS_STATUS, metadata.rightsStatus, qa.RIGHTS_STATUS, qa.rightsStatus, qa.rights)
    || metadata.RIGHTS_ISSUE_LEVEL === 'B' || qa.rightsIssueLevel === 'B' || issues.some((value) => value.includes('RIGHT'))
    || blocked(item.safetyStatus, metadata.SAFETY_STATUS, metadata.safetyStatus, qa.SAFETY_STATUS, qa.safetyStatus, qa.safety)
    || blocked(item.minorSafetyStatus, metadata.MINOR_SAFETY_STATUS, metadata.minorSafetyStatus, qa.MINOR_SAFETY_STATUS, qa.minorSafetyStatus, qa.minorSafety)
    || issues.some((value) => value.includes('SAFETY') || value.includes('MINOR'));
}
function projectAsset(state, entry) {
  const { row } = entry; const item = originalBody(row);
  ensure(item.id === row.id && item.versionId === row.version_id && item.sha256 === row.sha256 && item.mediaId === row.media_id, 'TRIAL_ASSET_INTEGRITY', '素材登记身份不一致。');
  const events = state.events.map(({ row: event }) => ({ ...originalBody(event), hash: event.hash }));
  const latestReview = row.review_head ? events.find((event) => event.eventId === row.review_head && event.eventType === 'TRIAL_ASSET_REVIEW') : null;
  ensure(!row.review_head || (latestReview?.payload.versionId === item.versionId && latestReview.payload.sha256 === item.sha256), 'TRIAL_REVIEW_INTEGRITY', '已保存的审阅结论绑定不一致。');
  const technicalRejection = events.filter((event) => event.eventType === 'TRIAL_TECHNICAL_REJECTION' && event.payload.assetId === item.id).at(-1) ?? null;
  const qaObservations = events.filter((event) => event.eventType === 'TRIAL_ASSET_QA_OBSERVATION' && event.payload.assetId === item.id && event.payload.versionId === item.versionId && event.payload.sha256 === item.sha256)
    .map((event) => ({ ...event.payload, eventId: event.eventId, eventType: event.eventType, createdAt: event.createdAt, hash: event.hash }));
  const failed = qaObservations.find((observation) => blockedObservation(observation.observations));
  const qualityBlocked = blockedObservation(item.qa) || Boolean(failed);
  const index = state.assets.indexOf(entry);
  const newer = state.assets.slice(index + 1).find((candidate) => candidate.row.media_id === item.mediaId);
  const used = state.executions.find(({ row: execution }) => (originalBody(execution).input?.bindings ?? []).some((binding) => binding.versionId === item.versionId && binding.sha256 === item.sha256));
  const reviewLock = { locked: Boolean(newer || used), reason: newer ? '该版本已有后继版本，请切换到最新版本审阅。' : used ? '该版本已被下游执行精确绑定，当前结论已锁定。' : '' };
  return { ...item, lifecycle: row.lifecycle, reviewHeadId: row.review_head, latestReview, technicalRejection, qaObservations, qualityBlocked,
    qualityBlockReason: failed?.observations.summary || (qualityBlocked ? '这版已确认不符合固定制作要求，请修正后登记新候选。' : ''),
    scopeId: state.scopeId, nonWaivableBlocked: blockingFacts(item), reviewLock, mediaUrl: `/api/trial/media/${encodeURIComponent(item.id)}?scopeId=${encodeURIComponent(state.scopeId)}` };
}
async function snapshotFrom(tx, state) {
  const allRecipes = (await tableRows(tx, state.namespace, 'recipes')).map(({ row }) => originalBody(row));
  const superseded = new Set(allRecipes.map((recipe) => recipe.sourceRecipeId).filter(Boolean));
  const latest = new Map(); for (const recipe of allRecipes) latest.set(recipe.originalSubjectId ?? recipe.subjectId, recipe.id);
  const recipes = allRecipes.filter((recipe) => !superseded.has(recipe.id) && latest.get(recipe.originalSubjectId ?? recipe.subjectId) === recipe.id);
  const reservations = (await tableRows(tx, state.namespace, 'reservations')).map(({ row }) => row);
  const budgets = kinds.map((kind) => {
    const rows = reservations.filter((row) => row.kind === kind);
    const reserved = rows.filter((row) => row.state === 'RESERVED').reduce((sum, row) => sum + row.amount, 0);
    const spent = rows.filter((row) => row.state === 'SETTLED').reduce((sum, row) => sum + row.actual, 0);
    const limit = state.config.limits[kind]; return { kind, unit: kind === 'VIDEO' ? 'OPENART_CREDITS' : 'MODEL_CALLS', limit, reserved, spent, available: limit - reserved - spent };
  });
  return { schemaVersion: 'trial-control/1.0', mode: 'LOCAL_TRIAL', instanceId: state.config.instanceId, scope: state.config.scope, checkpoint: state.config.checkpoint, story: state.config.story,
    recipes, recipeHistory: allRecipes.filter((recipe) => !recipes.includes(recipe)), assets: state.assets.map((entry) => projectAsset(state, entry)),
    executions: state.executions.map(({ row }) => { const result = { ...originalBody(row) }; delete result.leaseToken; return result; }),
    budgets, eventHead: state.eventHead, mutationEtag: state.etag, sourceAuthority: 'POSTGRES', formalProjectChanged: false };
}
export async function instanceTrialSnapshot(repository, { scopeId } = {}) {
  return repository.readTransaction(async (tx) => (await snapshotFrom(tx, (await scopeState(tx, scopeId)))));
}
export async function instanceTrialAsset(repository, id, { scopeId } = {}) {
  return repository.readTransaction(async (tx) => {
    const matches = [];
    for (const candidateScopeId of scopeId ? [scopeId] : await scopeIds(tx)) {
      const state = await scopeState(tx, candidateScopeId);
      for (const entry of state.assets.filter(({ row }) => row.id === id || row.version_id === id)) matches.push({ state, entry });
    }
    ensure(matches.length > 0, 'ASSET_NOT_FOUND', '此试制版本不存在。');
    ensure(matches.length === 1, 'TRIAL_SCOPE_REQUIRED', '版本身份匹配多个试制范围，请明确选择。');
    return projectAsset(matches[0].state, matches[0].entry);
  });
}
function optionalComment(value, label) {
  ensure(value === undefined || (typeof value === 'string' && value.length <= 20_000), 'REVIEW_CRITERIA', `${label}需为两万字以内的文本。`);
}

/** One repository transaction commits the original trial event, asset head and idempotency receipt. */
export async function instanceTrialReview(repository, body, { ifMatch, idempotencyKey, scopeId, verifyMedia } = {}) {
  ensure(body && typeof body === 'object' && !Array.isArray(body), 'REVIEW_BINDING', '审阅内容无效。');
  ensure(!body.scopeId || !scopeId || body.scopeId === scopeId, 'REVIEW_BINDING', '审阅范围与请求地址不一致。');
  ensure(typeof idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey), 'IDEMPOTENCY_REQUIRED', '缺少有效审阅请求编号。');
  return repository.writeTransaction(async (tx) => {
    const state = (await scopeState(tx, scopeId || body.scopeId)); const bindingHash = hashJson({ action: 'review', body });
    const prior = (await tx.getAux(state.namespace, `idempotency/${idempotencyKey}`));
    if (prior && !prior.deleted) {
      const row = parse(prior.bytes); ensure(row.binding_hash === bindingHash, 'IDEMPOTENCY_CONFLICT', '同一请求编号已用于不同意见。');
      return { ...JSON.parse(row.response), replayed: true };
    }
    ensure(ifMatch === state.etag, 'CAS_CONFLICT', '素材或执行记录已变化，请刷新后检查。');
    const entry = state.assets.find(({ row }) => row.version_id === body.versionId);
    ensure(entry, 'ASSET_NOT_FOUND', '待审版本不存在。'); const item = projectAsset(state, entry);
    ensure(item.mediaId === body.mediaId && item.sha256 === body.sha256, 'REVIEW_BINDING', '意见必须绑定精确素材、版本和 SHA。');
    ensure(['RELEASED', 'REVISION_REQUIRED', 'DO_NOT_USE'].includes(body.decision), 'REVIEW_DECISION', '不支持此审阅结论。');
    ensure((body.supersedesReviewEventId ?? null) === item.reviewHeadId, 'REVIEW_HEAD', '纠错必须指向当前审阅结论。');
    ensure(!item.reviewLock.locked, 'REVIEW_LOCKED', item.reviewLock.reason);
    ensure(Array.isArray(body.criteria) && body.criteria.length === item.reviewCriteria.length && item.reviewCriteria.length > 0, 'REVIEW_CRITERIA', '请完成全部判断。');
    const ids = new Set();
    for (const criterion of body.criteria) {
      ensure(criterion && item.reviewCriteria.some((required) => required.id === criterion.id) && !ids.has(criterion.id) && ['PASS', 'FAIL'].includes(criterion.result), 'REVIEW_CRITERIA', '判断项缺失、重复或无效。');
      ids.add(criterion.id); optionalComment(criterion.comment, '逐项意见');
    }
    optionalComment(body.comment, '整体意见');
    const rights = item.rightsStatus || item.metadata?.RIGHTS_STATUS || item.metadata?.rightsStatus || 'UNKNOWN';
    if (body.decision === 'RELEASED') {
      ensure(!item.qualityBlocked, 'QUALITY_BLOCK', item.qualityBlockReason);
      ensure(!item.nonWaivableBlocked, 'NON_WAIVABLE_BLOCK', '权利、安全或未成年人问题不能通过内部使用确认豁免。');
      ensure(body.criteria.every((criterion) => criterion.result === 'PASS'), 'REVIEW_FAILED', '通过并放行要求全部判断为符合。');
      if (rights === 'UNKNOWN') ensure(body.rightsAttestation === 'PROJECT_INTERNAL_ONLY', 'RIGHTS_UNKNOWN', '请明确确认本项目内部使用范围。');
    }
    ensure(typeof verifyMedia === 'function', 'MEDIA_VERIFICATION_REQUIRED', '审阅前必须核验登记媒体。');
    await verifyMedia(item);
    const event = { eventId: `trial-event:${randomUUID()}`, eventType: 'TRIAL_ASSET_REVIEW', payload: { ...body, comment: body.comment || '', actor: 'USER', rightsStatusOriginal: rights,
      rightsProjection: body.decision === 'RELEASED' && rights === 'UNKNOWN' ? 'CLEAR_BY_USER_ATTESTATION' : rights, authority: 'LOCAL_TRIAL_ONLY', wholeCheckpointApproved: false },
    createdAt: new Date().toISOString(), mode: 'LOCAL_TRIAL', scopeId: state.scopeId, target: `TRIAL:${state.scopeId}`, isFormalProjectEvent: false, previousHash: state.eventHead };
    const hash = hashJson(event);
    const highwater = (await tx.getAux(state.namespace, '_schema/sqlite_sequence'));
    const sequenceRows = highwater ? parse(highwater.bytes) : [];
    const sequence = Math.max(state.events.at(-1)?.row.sequence ?? 0, ...sequenceRows.filter((row) => row.name === 'events').map((row) => row.seq), 0) + 1;
    const metadata = { authorityDomain: 'LOCAL_TRIAL', deliveryScopeId: state.scopeId, sourceRowid: sequence };
    const eventRow = { sequence, id: event.eventId, type: event.eventType, previous_hash: state.eventHead, hash, body: canonicalJson(event) };
    (await tx.putAux({ namespace: state.namespace, key: `events/${sequence}`, bytes: JSON.stringify(eventRow), expectedRevisionId: null, mediaType: 'application/json', metadata: { ...metadata, sourceTable: 'events', sourcePrimaryKey: sequence } }));
    (await tx.importEvent({ bytes: eventRow.body, authorityDomain: 'LOCAL_TRIAL', sourceRef: { scopeId: state.scopeId, sequence, previousHash: state.eventHead, hash } }));
    (await tx.putAux({ namespace: state.namespace, key: entry.record.key, bytes: JSON.stringify({ ...entry.row, lifecycle: body.decision, review_head: event.eventId }), expectedRevisionId: entry.record.revisionId, mediaType: entry.record.mediaType, metadata: entry.record.metadata }));
    const next = (await scopeState(tx, state.scopeId)); const current = next.assets.find(({ row }) => row.id === item.id);
    const result = { event: { ...event, hash }, asset: projectAsset(next, current), mutationEtag: next.etag, replayed: false };
    (await tx.putAux({ namespace: state.namespace, key: `idempotency/${idempotencyKey}`, bytes: JSON.stringify({ key: idempotencyKey, binding_hash: bindingHash, response: canonicalJson(result) }), expectedRevisionId: null, mediaType: 'application/json', metadata: { ...metadata, sourceTable: 'idempotency', sourcePrimaryKey: idempotencyKey } }));
    return result;
  });
}
