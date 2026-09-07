import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, symlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInstanceRepository, openInstanceRepository, resolveInstance,
  restoreInstanceRepository, importRepositoryState, sha256,
} from '../index.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = path.join(testRoot, '.test-tmp');
mkdirSync(temporaryRoot, { recursive: true });
const suiteRoot = mkdtempSync(path.join(temporaryRoot, 'suite-'));
after(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
  try { rmdirSync(temporaryRoot); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
});

const errorCode = (code) => (error) => error?.code === code;
function fixture(name) {
  const root = path.join(suiteRoot, name);
  mkdirSync(root);
  const instanceId = `instance:${name}`;
  const dbPath = path.join(root, 'business.sqlite');
  const profile = { instanceId, projectId: `project:${name}`, episodePlanId: `plan:${name}`, title: '测试故事', format: { fps: 24 } };
  const profileBytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\r\n`);
  const repo = createInstanceRepository({ dbPath, instanceId, profile, profileBytes });
  return { root, dbPath, instanceId, repo, profile, profileBytes };
}
async function release(repo, name, expectedReleaseId = null, sourceRevisionIds = []) {
  const snapshot = { snapshotId: name, scenes: [{ id: 'scene:a', text: '雨停了。' }] };
  const recipes = { snapshotId: name, definitions: [{ id: 'recipe:a', prompt: '雨后的院落' }] };
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\r\n`);
  const recipesBytes = Buffer.from(` \n${JSON.stringify(recipes)}\n`);
  const view = await repo.writeTransaction((tx) => tx.publishRelease({ snapshotBytes, recipesBytes, expectedReleaseId, sourceRevisionIds }));
  return { view, snapshot, recipes, snapshotBytes, recipesBytes };
}
function withDatabase(dbPath, callback) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return callback(db); } finally { db.close(); }
}
function businessRows(dbPath) {
  return withDatabase(dbPath, (db) => Object.fromEntries([
    ['record_revisions', 'revision_id'], ['record_heads', 'namespace,record_key'],
    ['document_aliases', 'alias'], ['releases', 'release_id'],
    ['domain_events', 'storage_sequence'], ['media_versions', 'media_id,version_id'],
    ['media_aliases', 'alias,media_id,version_id'],
  ].map(([table, order]) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()])));
}

test('original document, configuration, event and release bytes survive import without normalization', async () => {
  const f = fixture('original-bytes');
  const documentBytes = Buffer.from('# 场景\r\n\r\n  她说：你好。  \r\n');
  const eventBytes = Buffer.from(' { "eventId": "old:event", "eventKind": "review", "recordedAt": "2025-01-02T00:00:00Z", "note": "原始意见" }\r\n');
  const doc = await f.repo.writeTransaction((tx) => {
    const value = tx.putDocument({ documentId: 'doc:scene', bytes: documentBytes, aliases: ['旧目录/剧本.md'], expectedRevisionId: null, mediaType: 'text/markdown' });
    tx.importEvent({ bytes: eventBytes, sourceRef: { path: 'events/review-old.json', sha256: sha256(eventBytes) } });
    return value;
  });
  const output = await release(f.repo, 'snapshot:original', null, [doc.revisionId]);
  assert.deepEqual(f.repo.readDocument('旧目录/剧本.md').bytes, documentBytes);
  assert.equal(f.repo.readDocument('doc:scene').sha256, sha256(documentBytes));
  assert.deepEqual(f.repo.getConfig('instance-profile').bytes, f.profileBytes);
  const publicProfile = { instanceId: f.instanceId, projectId: f.profile.projectId, episodePlanId: f.profile.episodePlanId, title: f.profile.title };
  assert.deepEqual(output.view.snapshot, { ...output.snapshot, instance: publicProfile, productionModel: { instance: publicProfile } });
  assert.deepEqual(output.view.recipes, output.recipes);
  assert.deepEqual(output.view.sourceRevisionIds, [doc.revisionId]);
  withDatabase(f.dbPath, (db) => {
    const event = db.prepare('SELECT * FROM domain_events WHERE event_id=?').get('old:event');
    assert.deepEqual(Buffer.from(event.event_bytes), eventBytes);
    assert.equal(event.event_sha256, sha256(eventBytes));
    const current = db.prepare('SELECT * FROM releases WHERE release_id=?').get(output.view.releaseId);
    assert.deepEqual(Buffer.from(current.snapshot_bytes), output.snapshotBytes);
    assert.deepEqual(Buffer.from(current.recipes_bytes), output.recipesBytes);
  });
  assert.equal(f.repo.integrityCheck().ok, true);
});

test('legacy event ordering remains deterministic and LOCAL_TRIAL events never enter formal views', async () => {
  const { repo } = fixture('event-order');
  const rows = [
    { eventId: 'legacy:a', recordedAt: '2025-09-01', eventSequence: 0 },
    { eventId: 'sequence:2', recordedAt: '2020-01-01', eventSequence: 2 },
    { eventId: 'legacy:b', recordedAt: '2025-09-01' },
    { eventId: 'sequence:1', recordedAt: '2026-01-01', eventSequence: 1 },
    { eventId: 'legacy:old', recordedAt: '2024-01-01' },
  ].map((item) => ({ ...item, eventKind: 'review' }));
  await repo.writeTransaction((tx) => {
    for (const event of rows) tx.importEvent({ bytes: JSON.stringify(event) });
    tx.importEvent({ bytes: JSON.stringify({ eventId: 'trial:only', eventKind: 'review', recordedAt: '2030-01-01', eventSequence: 99, isFormalProjectEvent: false }), authorityDomain: 'LOCAL_TRIAL' });
  });
  const expected = ['sequence:2', 'sequence:1', 'legacy:b', 'legacy:a', 'legacy:old'];
  assert.deepEqual(repo.listEvents('review').map((item) => item.eventId), expected);
  assert.deepEqual(repo.readView().eventsByKind.review.map((item) => item.eventId), expected);
  assert.deepEqual(repo.listEvents('review', { authorityDomain: 'LOCAL_TRIAL' }).map((item) => item.eventId), ['trial:only']);
  const result = await repo.writeTransaction((tx) => tx.appendEvent({ kind: 'review', idempotencyKey: 'new-event', requestHash: sha256('new-event'), payload: { decision: 'REVIEW_PENDING' } }));
  assert.equal(result.event.eventSequence, 6);
});

test('a read transaction keeps one view while an independent connection publishes another release', async () => {
  const f = fixture('read-isolation');
  const first = await release(f.repo, 'snapshot:before');
  let worker;
  try {
    await f.repo.readTransaction(async (tx) => {
      const before = tx.readView();
      worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { openInstanceRepository } = await import(workerData.moduleUrl);
          const repository = openInstanceRepository({ dbPath: workerData.dbPath, instanceId: workerData.instanceId });
          const output = await repository.writeTransaction(tx => {
            tx.putAux({ namespace: 'tasks', key: 'new-task', bytes: '{}', expectedRevisionId: null });
            return tx.publishRelease({ snapshot: { snapshotId: 'snapshot:after' }, recipes: { snapshotId: 'snapshot:after' }, expectedReleaseId: workerData.releaseId });
          });
          parentPort.postMessage({ releaseId: output.releaseId });
        })().catch(error => { parentPort.postMessage({ error: error.message, code: error.code }); process.exitCode = 1; });
      `, { eval: true, workerData: { moduleUrl: new URL('../index.mjs', import.meta.url).href, dbPath: f.dbPath, instanceId: f.instanceId, releaseId: first.view.releaseId } });
      const completed = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', (code) => { if (code !== 0) reject(new Error(`writer exit ${code}`)); }); });
      assert.equal(completed.error, undefined, completed.error);
      assert.notEqual(completed.releaseId, before.releaseId);
      assert.deepEqual(tx.readView(), before);
      assert.deepEqual(f.repo.readView(), before, 'repository reads must use their active read transaction');
      assert.equal(tx.getAux('tasks', 'new-task'), null);
      await assert.rejects(f.repo.writeTransaction(() => {}), errorCode('READ_ONLY_TRANSACTION'));
    });
    const after = f.repo.readView();
    assert.equal(after.snapshot.snapshotId, 'snapshot:after');
    assert.equal(after.recipes.snapshotId, 'snapshot:after');
    assert.ok(f.repo.getAux('tasks', 'new-task'));
  } finally { if (worker) await worker.terminate(); }
});

test('two repositories serialize writers and reject stale CAS and conflicting idempotency', async () => {
  const f = fixture('concurrent-cas');
  const other = openInstanceRepository({ dbPath: f.dbPath, instanceId: f.instanceId });
  const start = await f.repo.writeTransaction((tx) => tx.putDocument({ documentId: 'doc:scene', bytes: 'initial', expectedRevisionId: null }));
  const races = await Promise.allSettled([f.repo, other].map((repository, index) => repository.writeTransaction((tx) => tx.putDocument({ documentId: 'doc:scene', bytes: `edit:${index}`, expectedRevisionId: start.revisionId }))));
  assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(races.find((result) => result.status === 'rejected').reason.code, 'HEAD_CONFLICT');
  const request = { kind: 'review', idempotencyKey: 'review-once', requestHash: sha256('release-request'), payload: { versionId: 'version:1', decision: 'RELEASED' } };
  const events = await Promise.all([f.repo, other].map((repository) => repository.writeTransaction((tx) => tx.appendEvent(request))));
  assert.deepEqual(events.map((item) => item.replayed).sort(), [false, true]);
  assert.equal(events[0].event.eventId, events[1].event.eventId);
  assert.equal(f.repo.listEvents('review').length, 1);
  await assert.rejects(other.writeTransaction((tx) => tx.appendEvent({ ...request, requestHash: sha256('different-request') })), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.repo.listEvents('review').length, 1);
  await assert.rejects(other.writeTransaction((tx) => tx.putDocument({ documentId: 'doc:scene', bytes: 'blind overwrite' })), errorCode('CAS_REQUIRED'));
});

test('a failed transaction rolls back records, aliases, events, releases and repository revision together', async () => {
  const f = fixture('atomic-failure');
  const initial = await release(f.repo, 'snapshot:base');
  const rows = businessRows(f.dbPath);
  await assert.rejects(f.repo.writeTransaction((tx) => {
    const doc = tx.putDocument({ documentId: 'doc:uncommitted', bytes: 'not committed', aliases: ['source/uncommitted.md'], expectedRevisionId: null });
    tx.putAux({ namespace: 'operations', key: 'op:1', bytes: '{"state":"STARTED"}', expectedRevisionId: null });
    tx.appendEvent({ kind: 'review', idempotencyKey: 'uncommitted', requestHash: sha256('uncommitted'), payload: {} });
    tx.publishRelease({ snapshot: { snapshotId: 'snapshot:uncommitted' }, recipes: { snapshotId: 'snapshot:uncommitted' }, expectedReleaseId: initial.view.releaseId, sourceRevisionIds: [doc.revisionId] });
    throw new Error('deliberate failure after publish');
  }), /deliberate failure/);
  assert.deepEqual(f.repo.readView(), initial.view);
  assert.deepEqual(businessRows(f.dbPath), rows);
  assert.equal(f.repo.readDocument('source/uncommitted.md'), null);
  await assert.rejects(f.repo.writeTransaction((tx) => tx.publishRelease({ snapshot: { snapshotId: 'a' }, recipes: { snapshotId: 'b' }, expectedReleaseId: initial.view.releaseId })), errorCode('RELEASE_MISMATCH'));
  assert.deepEqual(f.repo.readView(), initial.view);
});

test('aux tombstones retain exact history and prefix queries cannot cross namespaces', async () => {
  const { repo } = fixture('aux-tombstones');
  const first = await repo.writeTransaction((tx) => {
    const item = tx.putAux({ namespace: 'conversations', key: 'turn:1', bytes: ' {"text":"保留原文"}\r\n', expectedRevisionId: null, metadata: { source: 'legacy' } });
    tx.putAux({ namespace: 'conversations', key: 'turn:2', bytes: '{}', expectedRevisionId: null });
    tx.putAux({ namespace: 'conversations', key: 'catalog:1', bytes: '{}', expectedRevisionId: null });
    tx.putAux({ namespace: 'LOCAL_TRIAL', key: 'turn:1', bytes: '{}', expectedRevisionId: null });
    return item;
  });
  const deleted = await repo.writeTransaction((tx) => tx.deleteAux({ namespace: 'conversations', key: 'turn:1', expectedRevisionId: first.revisionId, metadata: { reason: 'archived' } }));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.previousRevisionId, first.revisionId);
  assert.deepEqual(deleted.bytes, first.bytes);
  assert.equal(deleted.sha256, first.sha256);
  assert.equal(repo.getAux('conversations', 'turn:1', { revisionId: first.revisionId }).deleted, false);
  assert.deepEqual(repo.listAux('conversations', { prefix: 'turn:' }).map((item) => item.key), ['turn:2']);
  assert.deepEqual(repo.listAux('conversations', { prefix: 'turn:', includeDeleted: true }).map((item) => item.key), ['turn:1', 'turn:2']);
  assert.equal(repo.getAux('LOCAL_TRIAL', 'turn:1').deleted, false);
  await assert.rejects(repo.writeTransaction((tx) => tx.deleteAux({ namespace: 'conversations', key: 'turn:1', expectedRevisionId: first.revisionId })), errorCode('HEAD_CONFLICT'));
});

test('historical media aliases fail closed when ambiguous and resolve only the requested version bytes', async () => {
  const { repo } = fixture('media-aliases');
  const versions = [
    { mediaId: 'media:a', versionId: 'version:a', relativePath: 'media/a.png', sha256: sha256('image:a'), byteSize: 7, availability: 'PRESENT' },
    { mediaId: 'media:a', versionId: 'version:b', relativePath: null, sha256: sha256('image:b'), byteSize: 7, availability: 'MISSING_HISTORY' },
  ];
  await repo.writeTransaction((tx) => { for (const version of versions) tx.registerMedia({ ...version, aliases: ['production/generated/legacy.png'] }); });
  assert.throws(() => repo.resolveMedia('production/generated/legacy.png'), errorCode('AMBIGUOUS_MEDIA_ALIAS'));
  const exact = repo.resolveMedia('production/generated/legacy.png', { versionId: 'version:a', sha256: versions[0].sha256 });
  assert.equal(exact.relativePath, 'media/a.png');
  assert.equal(repo.resolveMedia('production/generated/legacy.png', { versionId: 'version:b', sha256: versions[0].sha256 }), null);
  assert.equal(repo.resolveMedia('version:b').availability, 'MISSING_HISTORY');
  await assert.rejects(repo.writeTransaction((tx) => tx.registerMedia({ ...versions[0], sha256: sha256('replacement') })), errorCode('MEDIA_CONFLICT'));
  await assert.rejects(repo.writeTransaction((tx) => tx.registerMedia({ ...versions[0], versionId: 'unsafe', relativePath: '../outside.png' })), errorCode('PATH_ESCAPE'));
});

test('backup and restore preserve every business row and hash while changing runtime epoch', async () => {
  const f = fixture('backup-restore');
  const doc = await f.repo.writeTransaction((tx) => {
    const item = tx.putDocument({ documentId: 'doc:1', bytes: '第一版\r\n', aliases: ['script.md'], expectedRevisionId: null });
    tx.putDocument({ documentId: 'doc:1', bytes: '第二版\r\n', expectedRevisionId: item.revisionId });
    tx.appendEvent({ kind: 'review', idempotencyKey: 'backup-review', requestHash: sha256('backup-review'), payload: { versionId: 'version:one' } });
    tx.putAux({ namespace: 'execution', key: 'request:one', bytes: '{ "state": "RESULT_UNKNOWN" }\r\n', expectedRevisionId: null });
    tx.registerMedia({ mediaId: 'media:one', versionId: 'version:one', relativePath: 'media/one.png', sha256: sha256('media'), byteSize: 5, aliases: ['original.png'] });
    return item;
  });
  await release(f.repo, 'snapshot:backup', null, [doc.revisionId]);
  const before = f.repo.readView();
  const rows = businessRows(f.dbPath);
  const backup = f.repo.backupTo(path.join(f.root, 'backup.sqlite'));
  assert.equal(backup.sha256, sha256(readFileSync(backup.path)));
  assert.equal(backup.mediaIncluded, false);
  assert.deepEqual(businessRows(backup.path), rows);
  const restored = await restoreInstanceRepository({ backupPath: backup.path, dbPath: path.join(f.root, 'restored.sqlite'), instanceId: f.instanceId, expectedSha256: backup.sha256 });
  const afterRestore = restored.readView();
  assert.deepEqual(businessRows(restored.dbPath), rows);
  assert.equal(afterRestore.releaseId, before.releaseId);
  assert.deepEqual(afterRestore.eventsByKind, before.eventsByKind);
  assert.notEqual(afterRestore.runtimeEpoch, before.runtimeEpoch);
  assert.notEqual(afterRestore.dataFingerprint, before.dataFingerprint);
  assert.notEqual(afterRestore.recipeFingerprint, before.recipeFingerprint);
  assert.equal(afterRestore.repositoryRevision, before.repositoryRevision + 1);
  assert.equal(restored.getAux('execution', 'request:one').bytes.toString(), '{ "state": "RESULT_UNKNOWN" }\r\n');
  assert.equal(restored.integrityCheck().ok, true);
  await assert.rejects(restoreInstanceRepository({ backupPath: backup.path, dbPath: path.join(f.root, 'wrong-hash.sqlite'), instanceId: f.instanceId, expectedSha256: sha256('wrong') }), errorCode('BACKUP_HASH_MISMATCH'));
  await assert.rejects(restoreInstanceRepository({ backupPath: backup.path, dbPath: restored.dbPath, instanceId: f.instanceId, expectedSha256: backup.sha256 }), errorCode('RESTORE_TARGET_EXISTS'));
  assert.deepEqual(businessRows(restored.dbPath), rows);
});

test('a profile edit takes effect only in its next published release and cannot change stable identity', async () => {
  const f = fixture('profile-release');
  const original = await release(f.repo, 'snapshot:profile-old');
  const originalProfileRecord = f.repo.getConfig('instance-profile');
  const changedProfile = { ...f.profile, title: '新的片名', branding: { accent: '#446688' }, format: { fps: 25 } };
  const changed = await f.repo.writeTransaction((tx) => tx.putConfig({ configId: 'instance-profile', value: changedProfile, expectedRevisionId: originalProfileRecord.revisionId }));
  assert.deepEqual(f.repo.getProfile(), changedProfile, 'editing changes the configuration head');
  const unpublished = f.repo.readView();
  assert.equal(unpublished.releaseId, original.view.releaseId);
  assert.deepEqual(unpublished.profile, f.profile, 'the released profile must remain frozen');
  assert.deepEqual(unpublished.snapshot, original.view.snapshot);
  assert.equal(unpublished.dataFingerprint, original.view.dataFingerprint);
  assert.equal(unpublished.snapshot.instance.title, '测试故事');
  assert.deepEqual(unpublished.snapshot.instance, unpublished.snapshot.productionModel.instance);
  for (const [field, expectedCode] of [['instanceId', 'INSTANCE_MISMATCH'], ['projectId', 'INSTANCE_IDENTITY_IMMUTABLE'], ['episodePlanId', 'INSTANCE_IDENTITY_IMMUTABLE']]) {
    await assert.rejects(f.repo.writeTransaction((tx) => tx.putConfig({ configId: 'instance-profile', value: { ...changedProfile, [field]: 'replacement-identity' }, expectedRevisionId: changed.revisionId })), errorCode(expectedCode));
    assert.equal(f.repo.getConfig('instance-profile').revisionId, changed.revisionId);
  }
  const published = await release(f.repo, 'snapshot:profile-new', original.view.releaseId);
  assert.deepEqual(published.view.profile, changedProfile);
  assert.equal(published.view.snapshot.instance.title, '新的片名');
  assert.deepEqual(published.view.snapshot.instance.branding, changedProfile.branding);
  assert.deepEqual(published.view.snapshot.instance, published.view.snapshot.productionModel.instance);
  assert.equal(published.view.snapshot.instance.format, undefined, 'the public projection does not expose every private profile field');
  withDatabase(f.dbPath, (db) => {
    const oldRelease = db.prepare('SELECT * FROM releases WHERE release_id=?').get(original.view.releaseId);
    const nextRelease = db.prepare('SELECT * FROM releases WHERE release_id=?').get(published.view.releaseId);
    assert.equal(oldRelease.profile_revision_id, originalProfileRecord.revisionId);
    assert.equal(nextRelease.profile_revision_id, changed.revisionId);
    assert.deepEqual(Buffer.from(oldRelease.snapshot_bytes), original.snapshotBytes);
    assert.deepEqual(Buffer.from(nextRelease.snapshot_bytes), published.snapshotBytes);
  });
});

test('instance bootstrap rejects traversal, symlink escape and extra authority fields', () => {
  const f = fixture('bootstrap');
  const bootstrap = path.join(f.root, 'instance.json');
  const document = { schemaVersion: '1.0', instanceId: f.instanceId, database: 'business.sqlite' };
  const writeBootstrap = (value) => writeFileSync(bootstrap, JSON.stringify(value));
  writeBootstrap(document);
  assert.deepEqual(resolveInstance(f.root), { root: f.root, instanceId: f.instanceId, dbPath: f.dbPath });
  for (const database of ['../outside.sqlite', f.dbPath, 'folder\\database.sqlite']) {
    writeBootstrap({ ...document, database });
    assert.throws(() => resolveInstance(f.root), errorCode('PATH_ESCAPE'));
  }
  const outside = fixture('bootstrap-outside');
  symlinkSync(outside.dbPath, path.join(f.root, 'escaped.sqlite'));
  writeBootstrap({ ...document, database: 'escaped.sqlite' });
  assert.throws(() => resolveInstance(f.root), errorCode('PATH_ESCAPE'));
  writeBootstrap({ ...document, sourceRoot: '../../legacy' });
  assert.throws(() => resolveInstance(f.root), errorCode('INVALID_BOOTSTRAP'));
  rmSync(bootstrap);
  writeFileSync(path.join(f.root, 'real-bootstrap.json'), JSON.stringify(document));
  symlinkSync(path.join(f.root, 'real-bootstrap.json'), bootstrap);
  assert.throws(() => resolveInstance(f.root), errorCode('UNSAFE_BOOTSTRAP'));
  assert.throws(() => openInstanceRepository({ dbPath: f.dbPath, instanceId: outside.instanceId }), errorCode('INSTANCE_MISMATCH'));
});

test('read views remain query-only for writable and explicitly read-only instances', async () => {
  const f = fixture('query-only-guard');
  const frozen = f.repo.readView().repositoryRevision;
  for (const repo of [f.repo, openInstanceRepository({ dbPath: f.dbPath, instanceId: f.instanceId, readOnly: true })]) {
    for (let i = 0; i < 8; i++) await repo.readTransaction(async (tx) => {
      assert.equal(tx.db.prepare('PRAGMA query_only').get().query_only, 1);
      assert.throws(() => tx.db.exec('UPDATE repository_meta SET repository_revision=999999'), /readonly/i);
      await assert.rejects(repo.writeTransaction(() => {}), (error) => ['READ_ONLY', 'READ_ONLY_TRANSACTION'].includes(error.code));
      assert.equal(tx.readView().repositoryRevision, frozen);
    });
  }
  assert.equal(f.repo.readView().repositoryRevision, frozen);
});

test('same-host writer churn and fresh query-only read connections preserve every committed head', async () => {
  const f = fixture('query-only-churn');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openInstanceRepository } = await import(workerData.moduleUrl);
      const repository = openInstanceRepository({ dbPath: workerData.dbPath, instanceId: workerData.instanceId });
      for (let i=0;i<80;i++) {
        await repository.writeTransaction(tx => tx.putAux({ namespace: 'churn', key: String(i), bytes: JSON.stringify({index:i}), expectedRevisionId: null }));
        await new Promise(resolve=>setTimeout(resolve,1));
      }
      parentPort.postMessage({written:80});
    })().catch(error => { parentPort.postMessage({error:error.message});process.exitCode=1; });
  `, { eval: true, workerData: { moduleUrl: new URL('../index.mjs', import.meta.url).href, dbPath: f.dbPath, instanceId: f.instanceId } });
  const completion = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try {
    let previousCount = 0;
    for (let i = 0; i < 120; i++) {
      const count = await f.repo.readTransaction((tx) => { assert.equal(tx.db.prepare('PRAGMA query_only').get().query_only, 1); return tx.listAux('churn').length; });
      assert.ok(count >= previousCount); previousCount = count;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.deepEqual(await completion, {written:80});
    assert.equal(f.repo.listAux('churn').length, 80);
    assert.equal(f.repo.integrityCheck().ok, true);
  } finally { await worker.terminate(); }
});

test('a Docker ownership marker rejects native reads, writes, cached handles and env-only impersonation before touching files', async () => {
  const f = fixture('docker-owner');
  const archive = f.repo.exportState();
  const backup = f.repo.backupTo(path.join(suiteRoot, 'owner-backup.sqlite'));
  writeFileSync(path.join(f.root, 'instance.json'), JSON.stringify({ schemaVersion: '1.0', instanceId: f.instanceId, database: 'business.sqlite' }));
  mkdirSync(path.join(f.root, 'runtime'));
  const marker = path.join(f.root, 'runtime/storage-owner.json');
  writeFileSync(marker, JSON.stringify({ schemaVersion: '1.0', instanceId: f.instanceId, mode: 'DOCKER', containerId: 'a'.repeat(64), containerRoot: '/instance', imageId: `sha256:${'b'.repeat(64)}`, hostRoot: f.root, softwareCommit: 'c'.repeat(40) }));
  const before = readFileSync(f.dbPath);
  const previous = process.env.REVIEW_SQLITE_OWNER;
  try {
    for (const env of [undefined, 'CONTAINER']) {
      if (env === undefined) delete process.env.REVIEW_SQLITE_OWNER; else process.env.REVIEW_SQLITE_OWNER = env;
      for (const readOnly of [false, true]) assert.throws(() => openInstanceRepository({ dbPath: f.dbPath, instanceId: f.instanceId, readOnly }), errorCode('OWNER_RUNTIME_REQUIRED'));
      assert.throws(() => f.repo.readView(), errorCode('OWNER_RUNTIME_REQUIRED'));
      assert.throws(() => f.repo.backupTo(path.join(f.root, 'denied-backup.sqlite')), errorCode('OWNER_RUNTIME_REQUIRED'));
      await assert.rejects(f.repo.writeTransaction(() => {}), errorCode('OWNER_RUNTIME_REQUIRED'));
    }
    const target = path.join(f.root, 'never-created.sqlite');
    assert.throws(() => createInstanceRepository({ dbPath: target, instanceId: f.instanceId, profile: f.profile }), errorCode('OWNER_RUNTIME_REQUIRED'));
    assert.throws(() => importRepositoryState({ dbPath: target, archive, instanceId: f.instanceId }), errorCode('OWNER_RUNTIME_REQUIRED'));
    await assert.rejects(restoreInstanceRepository({ dbPath: target, backupPath: backup.path, expectedSha256: backup.sha256, instanceId: f.instanceId }), errorCode('OWNER_RUNTIME_REQUIRED'));
    assert.equal(existsSync(target), false);
    assert.deepEqual(readFileSync(f.dbPath), before);
    writeFileSync(marker, '{broken');
    assert.throws(() => openInstanceRepository({ dbPath: f.dbPath, readOnly: true }), errorCode('OWNER_RUNTIME_REQUIRED'));
  } finally {
    if (previous === undefined) delete process.env.REVIEW_SQLITE_OWNER; else process.env.REVIEW_SQLITE_OWNER = previous;
    rmSync(marker);
  }
  assert.equal(f.repo.integrityCheck().ok, true);
});
