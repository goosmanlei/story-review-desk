import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, createInstanceRepository, openInstanceRepository, sha256 } from '../host/instance-runtime/index.mjs';
import { instanceTrialAsset, instanceTrialReview, instanceTrialSnapshot, instanceTrialScopes } from '../app/api/trial/_instance.mjs';

const temporary = path.join(path.dirname(fileURLToPath(import.meta.url)), '.test-tmp');
mkdirSync(temporary, { recursive: true });
const suite = mkdtempSync(path.join(temporary, 'trial-suite-'));
after(() => { rmSync(suite, { recursive: true, force: true }); try { rmdirSync(temporary); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } });
const hashJson = (value) => sha256(canonicalJson(value));
const criteria = ['intent', 'material', 'composition', 'safety'].map((id) => ({ id, label: id, description: `${id}标准` }));
const code = (expected) => (error) => error.code === expected;
const tables = { meta: 'key', recipes: 'id', executions: 'id', reservations: 'id', assets: 'id', events: 'sequence', idempotency: 'key' };

async function importRows(repo, rows, scopeId, highwater = []) {
  await repo.writeTransaction(async (tx) => {
    (await tx.putAux({ namespace: 'local-trial-index', key: 'scopes', bytes: JSON.stringify([scopeId]), expectedRevisionId: null }));
    for (const [table, primaryKey] of Object.entries(tables)) {
      for (const [index, row] of (rows[table] || []).entries()) {
        (await tx.putAux({ namespace: `local-trial:${scopeId}`, key: `${table}/${row[primaryKey]}`, bytes: JSON.stringify(row), expectedRevisionId: null, metadata: { authorityDomain: 'LOCAL_TRIAL', deliveryScopeId: scopeId, sourceTable: table, sourcePrimaryKey: row[primaryKey], sourceRowid: index + 1 } }));
        if (table === 'events') (await tx.importEvent({ bytes: row.body, authorityDomain: 'LOCAL_TRIAL', sourceRef: { scopeId, sequence: row.sequence, previousHash: row.previous_hash, hash: row.hash } }));
      }
    }
    (await tx.putAux({ namespace: `local-trial:${scopeId}`, key: '_schema/sqlite_sequence', bytes: JSON.stringify(highwater), expectedRevisionId: null }));
  });
}
async function newRepository(name) {
  const dbPath = path.join(suite, name, 'instance.sqlite'); const instanceId = `test:${name}`;
  return (await createInstanceRepository({ dbPath, instanceId, profile: { instanceId, title: '隔离测试' } }));
}
async function fixture(name) {
  const repo = (await newRepository(name)); const scopeId = 'fixture:local-trial';
  const config = { mode: 'LOCAL_TRIAL', instanceId: 'old-trial:instance', scope: { id: scopeId, title: '试制', projectTitle: '测试', countsTowardFormalProject: false }, story: { episodes: [], sourceScenes: [], shotProposals: [], dialogue: [] }, checkpoint: { id: 'CP1', state: 'USER_CONFIRMED' }, limits: { IMAGE: 40, AUDIO: 30, VIDEO: 2800 } };
  const rows = { meta: [{ key: 'config', value: JSON.stringify(config, null, 2) }], recipes: [], executions: [], reservations: [], assets: [], events: [], idempotency: [] };
  const addEvent = (eventType, payload) => {
    const sequence = rows.events.length + 1; const previousHash = rows.events.at(-1)?.hash || '0'.repeat(64);
    const event = { eventId: `trial-event:fixture-${sequence}`, eventType, payload, createdAt: 1750000000000 + sequence, mode: 'LOCAL_TRIAL', scopeId, target: `TRIAL:${scopeId}`, isFormalProjectEvent: false, previousHash };
    rows.events.push({ sequence, id: event.eventId, type: eventType, previous_hash: previousHash, hash: hashJson(event), body: JSON.stringify(event, null, 2) + '\n' }); return event;
  };
  addEvent('TRIAL_CREATED', {});
  for (let index = 0; index < 6; index++) {
    const subjectId = `material:${index}`;
    const recipe = { id: `recipe:${index}`, subjectId, label: index === 5 ? '堂屋空间' : `已放行素材${index + 1}`, model: 'FIXTURE_ONLY', fullPrompt: `原始完整Prompt ${index}` };
    rows.recipes.push({ id: recipe.id, hash: hashJson(recipe), body: JSON.stringify(recipe) });
    for (let version = 1; version <= (index === 5 ? 3 : 1); version++) {
      const id = `asset:${index}-${version}`; const versionId = `${subjectId}@v${version}`;
      const item = { id, mediaId: subjectId, versionId, version, sha256: sha256(`fixture:${id}`), relativePath: `media/${id}.png`, mediaKind: index > 1 && index < 5 ? 'AUDIO' : 'IMAGE', prompt: { full: `实际Prompt\r\n${id}` }, metadata: { RIGHTS_STATUS: 'UNKNOWN' }, rightsStatus: 'UNKNOWN', qa: {}, reviewCriteria: criteria, recipeId: recipe.id };
      const requestId = `execution:${id}`;
      rows.executions.push({ id: requestId, recipe_id: recipe.id, state: 'SUCCEEDED', body: JSON.stringify({ requestId, state: 'SUCCEEDED', input: { bindings: [] }, leaseToken: 'private-lease-token' }) });
      rows.reservations.push({ id: requestId, kind: item.mediaKind, amount: 1, state: 'SETTLED', actual: 1 });
      const event = index < 5 ? addEvent('TRIAL_ASSET_REVIEW', { actor: 'USER', mediaId: item.mediaId, versionId, sha256: item.sha256, decision: 'RELEASED', comment: `已保存用户结论${index}`, criteria: criteria.map(({ id: criterionId }) => ({ id: criterionId, result: 'PASS', comment: '' })) }) : null;
      rows.assets.push({ id, request_id: requestId, media_id: item.mediaId, version_id: versionId, sha256: item.sha256, lifecycle: index < 5 ? 'RELEASED' : 'REVISION_REQUIRED', review_head: event?.eventId ?? null, body: JSON.stringify(item, null, 2) + '\r\n' });
    }
  }
  const hall = JSON.parse(rows.assets.at(-1).body);
  addEvent('TRIAL_ASSET_QA_OBSERVATION', { assetId: hall.id, versionId: hall.versionId, sha256: hall.sha256, observations: { technicalStatus: 'NEEDS_CORRECTION', visualPass: false, summary: '固定几何不符合：门洞与房间进深需修正。' }, sourceSHA: sha256('qa-report') });
  await importRows(repo, rows, scopeId, [{ name: 'events', seq: rows.events.length }]);
  return { repo, rows, scopeId };
}
function reviewBody(asset, decision = 'RELEASED') {
  return { mediaId: asset.mediaId, versionId: asset.versionId, sha256: asset.sha256, decision, comment: '', criteria: criteria.map(({ id }) => ({ id, result: 'PASS', comment: '' })), rightsAttestation: 'PROJECT_INTERNAL_ONLY', ...(asset.reviewHeadId ? { supersedesReviewEventId: asset.reviewHeadId } : {}) };
}

test('imported five releases, three hall versions, original judgments and prompts are read-only projections', async () => {
  const { repo, rows, scopeId } = await fixture('projection'); const revision = (await repo.readView()).repositoryRevision;
  const snapshot = await instanceTrialSnapshot(repo);
  assert.equal(snapshot.assets.filter((asset) => asset.lifecycle === 'RELEASED').length, 5);
  assert.equal(snapshot.assets.length, 8); assert.equal(snapshot.recipes.length, 6);
  assert.equal(snapshot.assets.at(-1).qualityBlocked, true);
  assert.match(snapshot.assets.at(-1).qualityBlockReason, /固定几何/);
  assert.equal(snapshot.assets[5].reviewLock.locked, true);
  assert.equal(snapshot.assets[0].latestReview.payload.comment, '已保存用户结论0');
  assert.equal(snapshot.executions.some((execution) => Object.hasOwn(execution, 'leaseToken')), false);
  assert.deepEqual((await repo.listEvents()), []);
  assert.equal((await repo.listEvents(null, { authorityDomain: 'LOCAL_TRIAL' })).length, rows.events.length);
  for (const row of rows.assets) {
    const stored = JSON.parse((await repo.getAux(`local-trial:${scopeId}`, `assets/${row.id}`)).bytes);
    assert.equal(stored.body, row.body);
    assert.deepEqual((await instanceTrialAsset(repo, row.id)).prompt, JSON.parse(row.body).prompt);
  }
  assert.equal((await repo.readView()).repositoryRevision, revision);
});

test('hall QA cannot be overridden by all PASS, while revision and FAIL opinions may be empty', async () => {
  const { repo } = await fixture('qa-optional'); const before = await instanceTrialSnapshot(repo); const hall = before.assets.at(-1);
  let mediaReads = 0; const verifyMedia = () => { mediaReads++; };
  await assert.rejects(instanceTrialReview(repo, reviewBody(hall), { ifMatch: before.mutationEtag, idempotencyKey: 'hall-release-rejected', verifyMedia }), code('QUALITY_BLOCK'));
  assert.equal(mediaReads, 0);
  assert.equal((await instanceTrialSnapshot(repo)).mutationEtag, before.mutationEtag);
  const body = reviewBody(hall, 'REVISION_REQUIRED'); body.criteria[0].result = 'FAIL';
  const result = await instanceTrialReview(repo, body, { ifMatch: before.mutationEtag, idempotencyKey: 'hall-revision-empty-notes', verifyMedia });
  assert.equal(result.asset.lifecycle, 'REVISION_REQUIRED'); assert.equal(result.event.payload.comment, '');
  assert.equal(result.event.payload.criteria[0].comment, ''); assert.equal(result.asset.qualityBlocked, true);
  assert.equal(mediaReads, 1); assert.deepEqual((await repo.listEvents()), []);
});

test('concurrent correction uses one CAS and persists event, original asset bytes and idempotency together', async () => {
  const { repo, scopeId } = await fixture('correction'); const other = (await openInstanceRepository({ dbPath: repo.dbPath, instanceId: repo.instanceId }));
  const before = await instanceTrialSnapshot(repo); const asset = before.assets[0]; const body = reviewBody(asset, 'DO_NOT_USE');
  const old = (await repo.getAux(`local-trial:${scopeId}`, `assets/${asset.id}`)); const original = JSON.parse(old.bytes);
  const outcomes = await Promise.allSettled([repo, other].map((connection, index) => instanceTrialReview(connection, body, { ifMatch: before.mutationEtag, idempotencyKey: `concurrent-correction-${index}`, verifyMedia: () => {} })));
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((result) => result.status === 'rejected').reason.code, 'CAS_CONFLICT');
  const succeeded = outcomes.findIndex((result) => result.status === 'fulfilled'); const result = outcomes[succeeded].value;
  const replay = await instanceTrialReview(other, body, { ifMatch: 'stale-after-success', idempotencyKey: `concurrent-correction-${succeeded}`, verifyMedia: () => { throw new Error('replay must not repeat verification'); } });
  assert.equal(replay.replayed, true); assert.equal(replay.event.eventId, result.event.eventId);
  await assert.rejects(instanceTrialReview(other, { ...body, comment: 'changed' }, { ifMatch: result.mutationEtag, idempotencyKey: `concurrent-correction-${succeeded}` }), code('IDEMPOTENCY_CONFLICT'));
  const current = JSON.parse((await repo.getAux(`local-trial:${scopeId}`, `assets/${asset.id}`)).bytes);
  assert.equal(current.body, original.body); assert.equal(current.review_head, result.event.eventId);
  assert.equal(JSON.parse((await repo.getAux(`local-trial:${scopeId}`, `assets/${asset.id}`, { revisionId: old.revisionId })).bytes).lifecycle, 'RELEASED');
  assert.deepEqual((await repo.listEvents()), []);
});

test('a late idempotency storage failure rolls back the new event and changed asset head', async () => {
  const { repo } = await fixture('rollback'); const before = await instanceTrialSnapshot(repo); const revision = (await repo.readView()).repositoryRevision;
  const failing = { writeTransaction: (callback) => repo.writeTransaction((tx) => callback(new Proxy(tx, { get(target, property) {
    if (property === 'putAux') return (input) => { if (input.key.startsWith('idempotency/')) throw new Error('simulated receipt failure'); return target.putAux(input); };
    return Reflect.get(target, property);
  } }))) };
  await assert.rejects(instanceTrialReview(failing, reviewBody(before.assets[0], 'REVISION_REQUIRED'), { ifMatch: before.mutationEtag, idempotencyKey: 'rollback-after-event', verifyMedia: () => {} }), /simulated receipt failure/);
  assert.deepEqual(await instanceTrialSnapshot(repo), before);
  assert.equal((await repo.readView()).repositoryRevision, revision);
});

test('media mismatch and exact review binding fail closed without changing user conclusions', async () => {
  const { repo } = await fixture('media-fail'); const before = await instanceTrialSnapshot(repo); const body = reviewBody(before.assets[0]);
  await assert.rejects(instanceTrialReview(repo, { ...body, sha256: sha256('wrong-media') }, { ifMatch: before.mutationEtag, idempotencyKey: 'bad-media-binding', verifyMedia: () => {} }), code('REVIEW_BINDING'));
  await assert.rejects(instanceTrialReview(repo, body, { ifMatch: before.mutationEtag, idempotencyKey: 'bad-actual-media', verifyMedia: () => { throw new Error('actual bytes mismatch'); } }), /actual bytes mismatch/);
  assert.deepEqual(await instanceTrialSnapshot(repo), before);
  await assert.rejects(instanceTrialReview(repo, reviewBody(before.assets[5], 'DO_NOT_USE'), { ifMatch: before.mutationEtag, idempotencyKey: 'old-version-locked', verifyMedia: () => {} }), code('REVIEW_LOCKED'));
});

test('multiple scopes preserve old media URLs and require exact review scope without changing the formal release', async () => {
  const { repo, scopeId } = await fixture('multiple-scopes');
  const before = await instanceTrialSnapshot(repo, { scopeId });
  const formal = await repo.readView();
  const secondId = 'fixture:second-scope';
  await repo.writeTransaction(async tx => {
    const index = await tx.getAux('local-trial-index', 'scopes');
    await tx.putAux({ namespace: 'local-trial-index', key: 'scopes', bytes: JSON.stringify([scopeId, secondId]), expectedRevisionId: index.revisionId });
    const config = { mode: 'LOCAL_TRIAL', scope: { id: secondId, title: '第二范围', countsTowardFormalProject: false }, limits: { IMAGE: 1, AUDIO: 0, VIDEO: 0 } };
    await tx.putAux({ namespace: `local-trial:${secondId}`, key: 'meta/config', bytes: JSON.stringify({ key: 'config', value: JSON.stringify(config) }), expectedRevisionId: null });
    const item = { ...before.assets[0], id: 'second-asset', versionId: 'second-version', mediaId: 'second-material', lifecycle: 'REVIEW_PENDING', reviewHeadId: null };
    await tx.putAux({ namespace: `local-trial:${secondId}`, key: 'assets/second-asset', bytes: JSON.stringify({ id: item.id, version_id: item.versionId, media_id: item.mediaId, sha256: item.sha256, review_head: null, lifecycle: 'REVIEW_PENDING', body: JSON.stringify(item) }), expectedRevisionId: null });
  });
  const scopes = await instanceTrialScopes(repo);
  assert.deepEqual(scopes.scopes.map(scope => scope.id), [scopeId, secondId]);
  assert.equal(scopes.sourceAuthority, 'POSTGRES');
  await assert.rejects(instanceTrialSnapshot(repo), code('TRIAL_SCOPE_REQUIRED'));
  const oldMedia = await instanceTrialAsset(repo, before.assets[0].id);
  assert.equal(oldMedia.scopeId, scopeId);
  assert.match(oldMedia.mediaUrl, /scopeId=fixture%3Alocal-trial$/);
  const next = await instanceTrialSnapshot(repo, { scopeId: secondId });
  assert.equal(next.assets[0].scopeId, secondId);
  await assert.rejects(instanceTrialAsset(repo, next.assets[0].id, { scopeId }), code('ASSET_NOT_FOUND'));
  await assert.rejects(instanceTrialReview(repo, { ...reviewBody(next.assets[0]), scopeId: secondId }, { scopeId, ifMatch: before.mutationEtag, idempotencyKey: 'wrong-scope-review', verifyMedia: () => {} }), code('REVIEW_BINDING'));
  const saved = await instanceTrialReview(repo, { ...reviewBody(next.assets[0], 'REVISION_REQUIRED'), scopeId: secondId }, { scopeId: secondId, ifMatch: next.mutationEtag, idempotencyKey: 'second-scope-review', verifyMedia: () => {} });
  assert.equal(saved.asset.scopeId, secondId);
  assert.equal((await instanceTrialSnapshot(repo, { scopeId })).mutationEtag, before.mutationEtag);
  assert.equal((await repo.readView()).releaseId, formal.releaseId);
  assert.deepEqual(await repo.listEvents(), []);
});

test('optional real trial database imports into a private fixture with all five user releases unchanged', { skip: !process.env.TRIAL_IMPORT_TEST_SOURCE_DB }, async () => {
  const source = new DatabaseSync(process.env.TRIAL_IMPORT_TEST_SOURCE_DB, { readOnly: true });
  let rows, highwater;
  try {
    source.exec('BEGIN');
    rows = Object.fromEntries(Object.keys(tables).map((table) => [table, source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
    highwater = source.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
    source.exec('COMMIT');
  } finally { source.close(); }
  const config = JSON.parse(rows.meta.find((row) => row.key === 'config').value); const repo = (await newRepository('real-import'));
  await importRows(repo, rows, config.scope.id, highwater);
  const before = (await repo.readView()).repositoryRevision; const snapshot = await instanceTrialSnapshot(repo);
  assert.equal(snapshot.assets.length, 8); assert.equal(snapshot.assets.filter((asset) => asset.lifecycle === 'RELEASED').length, 5);
  assert.equal(snapshot.assets.filter((asset) => asset.qualityBlocked).length, 1);
  assert.match(snapshot.assets.find((asset) => asset.qualityBlocked).versionId, /V003$/);
  for (const row of rows.assets) {
    const projected = snapshot.assets.find((asset) => asset.id === row.id);
    assert.equal(projected.lifecycle, row.lifecycle); assert.equal(projected.reviewHeadId, row.review_head);
    assert.deepEqual(projected.prompt, JSON.parse(row.body).prompt);
  }
  const events = (await repo.listEvents(null, { authorityDomain: 'LOCAL_TRIAL' }));
  assert.equal(events.length, rows.events.length);
  assert.deepEqual((await repo.listEvents()), []);
  assert.equal((await repo.readView()).repositoryRevision, before);
});
