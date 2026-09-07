import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, rmdirSync, symlinkSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planInstanceImport, importInstance } from '../../../scripts/instance-import.mjs';
import { canonicalJson, sha256, openInstanceRepository, importRepositoryState } from '../index.mjs';
import { instanceCandidateRelativePath } from '../media-paths.mjs';

const temporaryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '.test-tmp');
mkdirSync(temporaryRoot, { recursive: true });
const suiteRoot = mkdtempSync(path.join(temporaryRoot, 'importer-'));
after(() => { rmSync(suiteRoot, { recursive: true, force: true }); try { rmdirSync(temporaryRoot); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; } });
function write(root, name, bytes) { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); return file; }
const formalKinds = ['review', 'episode-plan-submission', 'run', 'asset-version', 'creative-revision', 'execution-request', 'source-operation', 'verification', 'script-comment'];
function fixture(name, { trial = false } = {}) {
  const root = path.join(suiteRoot, name); mkdirSync(root);
  const sourceBytes = Buffer.from('# 正文\r\n  原始空白保留。  \r\n');
  for (const guide of ['README.md', 'AGENTS.md', 'STATE.md']) write(root, guide, `# ${guide}\r\n`);
  write(root, 'docs/story.md', sourceBytes);
  write(root, 'production/prompts/direct/01_prompt.md', '完整 Prompt\r\n');
  write(root, 'scripts/compiler.py', 'print("fixture compiler")\n');
  const mediaBytes = Buffer.from('original exact image bytes');
  write(root, 'production/generated/image.png', mediaBytes);
  write(root, 'source.mp3', 'fixture original audio');
  write(root, 'review-site/public/media/preview.jpg', 'fixture proxy');
  const snapshot = { snapshotId: 'snapshot:legacy', storySources: { audio: { sourcePath: 'source.mp3', sha256: sha256('fixture original audio') } }, productionModel: { assetVersions: [{ id: 'version:original', familyId: 'family:original', sha256: sha256(mediaBytes), path: 'production/generated/image.png', lifecycleState: 'RELEASED' }] } };
  const snapshotBytes = Buffer.from(` ${JSON.stringify(snapshot, null, 2)}\r\n`);
  const recipes = { snapshotId: snapshot.snapshotId, sourceCatalog: [{ path: 'docs/story.md', sha256: sha256(sourceBytes) }, { path: 'STATE.md', sha256: sha256('older guide') }] };
  write(root, 'review-site/app/review-data.generated.json', snapshotBytes);
  write(root, 'review-site/data/review-recipes.generated.json', JSON.stringify(recipes));
  const events = formalKinds.map((eventKind, index) => Buffer.from(` { "eventId": "old:${eventKind}", "eventKind": "${eventKind}", "eventSequence": ${index + 1}, "recordedAt": "2026-09-01T00:00:00Z", "comment": " 原始意见 " }\r\n`));
  events.forEach((bytes, index) => write(root, `events/${String(index).padStart(2, '0')}.json`, bytes));
  write(root, 'assistant/public/contexts/exact.json', ' { "contextHash": "old-context", "purpose": "咨询" }\r\n');
  write(root, 'assistant/public/health.json', '{"state":"old-host-health"}\r\n');
  write(root, 'assistant/private/threads/thread.json', '{"threadId":"private-thread"}\r\n');
  write(root, 'assistant/private/auth.json', '{"fixtureCredential":"must-not-import"}');
  const sdkFile = write(root, 'assistant/private/sqlite/state.sqlite', '');
  const sdk = new DatabaseSync(sdkFile); sdk.exec("CREATE TABLE conversations(id TEXT); INSERT INTO conversations VALUES('original-provider-id')"); sdk.close();
  const profile = { schemaVersion: '1.0', instanceId: `instance:${name}`, projectId: `project:${name}`, episodePlanId: `plan:${name}`, title: '自定义故事' };
  const profileFile = write(root, 'profile.json', JSON.stringify(profile));
  const options = { projectRoot: root, profileFile, instance: path.join(root, 'instance'), events: 'events', assistantPublic: 'assistant/public', assistantPrivate: 'assistant/private', trial: 'pilot/local-trial/trial.sqlite' };
  if (trial) {
    const trialMedia = Buffer.from('trial actual media'); write(root, 'pilot/local-trial/media/output.wav', trialMedia);
    const trialDb = new DatabaseSync(path.join(root, options.trial));
    trialDb.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE recipes(id TEXT PRIMARY KEY,hash TEXT,body TEXT); CREATE TABLE executions(id TEXT PRIMARY KEY,recipe_id TEXT,state TEXT,body TEXT); CREATE TABLE reservations(id TEXT PRIMARY KEY,kind TEXT,amount INTEGER,state TEXT,actual INTEGER); CREATE TABLE assets(id TEXT PRIMARY KEY,request_id TEXT,media_id TEXT,version_id TEXT,sha256 TEXT,lifecycle TEXT,review_head TEXT,body TEXT); CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT,type TEXT,previous_hash TEXT,hash TEXT,body TEXT); CREATE TABLE idempotency(key TEXT PRIMARY KEY,binding_hash TEXT,response TEXT)`);
    const config = { mode: 'LOCAL_TRIAL', scope: { id: 'scope:test', countsTowardFormalProject: false }, limits: { IMAGE: 40, AUDIO: 30, VIDEO: 2800 } };
    trialDb.prepare('INSERT INTO meta VALUES(?,?)').run('config', JSON.stringify(config));
    trialDb.prepare('INSERT INTO recipes VALUES(?,?,?)').run('recipe:1', sha256('prompt'), ' {"id":"recipe:1","fullPrompt":"原始 Prompt"} ');
    trialDb.prepare('INSERT INTO executions VALUES(?,?,?,?)').run('request:1', 'recipe:1', 'SUCCEEDED', '{"requestId":"provider-request","inputHash":"old-hash"}');
    trialDb.prepare('INSERT INTO reservations VALUES(?,?,?,?,?)').run('request:1', 'AUDIO', 1, 'SETTLED', 1);
    trialDb.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)').run('asset:1', 'request:1', 'family:trial', 'version:trial', sha256(trialMedia), 'RELEASED', 'trial:review', JSON.stringify({ relativePath: 'media/output.wav', metadata: { RIGHTS_STATUS: 'UNKNOWN' } }));
    const trialEvent = { eventId: 'trial:review', eventType: 'TRIAL_REVIEW', createdAt: 10, previousHash: '0'.repeat(64), payload: { decision: 'RELEASED', rightsAttestation: 'PROJECT_INTERNAL_ONLY' } };
    trialDb.prepare('INSERT INTO events(id,type,previous_hash,hash,body) VALUES(?,?,?,?,?)').run(trialEvent.eventId, trialEvent.eventType, trialEvent.previousHash, sha256(canonicalJson(trialEvent)), canonicalJson(trialEvent));
    trialDb.prepare('INSERT INTO idempotency VALUES(?,?,?)').run('once', sha256('exact-request'), '{"replayed":false,"eventId":"trial:review"}'); trialDb.close();
  }
  return { root, options, profile, events, sourceBytes, snapshotBytes, mediaBytes };
}

test('one-way importer preserves nine event kinds, exact bytes, source roles, all media aliases and trial authority', async () => {
  const f = fixture('complete', { trial: true }); const plan = await planInstanceImport(f.options);
  assert.equal(plan.report.readyForImport, true); assert.equal(plan.report.rebases.length, 1);
  assert.equal(plan.report.counts.formalEvents, 9); assert.equal(plan.report.counts.trialTables.events, 1);
  assert.equal(existsSync(f.options.instance), false, 'dry run must create no instance');
  write(f.root, 'assistant/public/health.json', '{"state":"new-heartbeat"}\r\n');
  const sourceState = readFileSync(path.join(f.root, 'STATE.md')); const sourceTrial = readFileSync(path.join(f.root, f.options.trial));
  const result = await importInstance(plan, f.options); assert.equal(result.integrity.ok, true);
  assert.deepEqual(readFileSync(path.join(f.root, 'STATE.md')), sourceState);
  assert.deepEqual(readFileSync(path.join(f.root, f.options.trial)), sourceTrial);
  const repo = openInstanceRepository({ dbPath: path.join(f.options.instance, 'data/review.sqlite'), instanceId: f.profile.instanceId });
  const view = repo.readView(); assert.equal(view.snapshot.instance.projectId, f.profile.projectId);
  assert.deepEqual(repo.readRelease().snapshotBytes, f.snapshotBytes);
  assert.equal(repo.readRelease('missing'), null);
  assert.deepEqual(repo.readDocument('docs/story.md').bytes, f.sourceBytes);
  assert.equal(repo.readDocument('STATE.md').metadata.legacyExpectedSha256, sha256('older guide'));
  assert.equal(repo.readDocument('scripts/compiler.py').metadata.sourceRole, 'INSTANCE_EXTENSION');
  assert.equal(repo.readDocument('production/prompts/direct/01_prompt.md').metadata.sourceRole, 'DIRECT_PROMPT');
  for (const doc of repo.listDocuments()) assert.ok(view.sourceRevisionIds.includes(doc.revisionId));
  for (const revisionId of view.sourceRevisionIds) assert.equal(repo.readDocumentRevision(revisionId).revisionId, revisionId);
  assert.equal(repo.readDocumentRevision(repo.getConfig('instance-profile').revisionId), null, 'document revision lookup cannot expose settings or aux');
  assert.equal(repo.listMedia().length, 4);
  assert.equal(repo.listEvents().length, 9); assert.equal(repo.listEvents(undefined, { authorityDomain: 'LOCAL_TRIAL' })[0].eventId, 'trial:review');
  assert.equal(repo.getAux('assistant-private', 'auth.json'), null);
  assert.equal(repo.getAux('assistant-public', 'health.json'), null, 'old host health must not become active instance health');
  assert.equal(repo.getAux('assistant-runtime-history', 'health.json').bytes.toString(), '{"state":"old-host-health"}\r\n');
  assert.equal(repo.getAux('assistant-runtime-history', 'health.json').metadata.stale, true);
  assert.equal(repo.getAux('assistant-private', 'sqlite/state.sqlite').metadata.notActiveBusinessDatabase, true);
  assert.equal(repo.getAux('assistant-public', 'contexts/exact.json').bytes.toString(), ' { "contextHash": "old-context", "purpose": "咨询" }\r\n');
  const row = JSON.parse(repo.getAux('local-trial:scope:test', 'assets/asset:1').bytes);
  assert.equal(row.lifecycle, 'RELEASED'); assert.equal(row.review_head, 'trial:review');
  assert.equal(JSON.parse(row.body).metadata.RIGHTS_STATUS, 'UNKNOWN');
  for (const alias of ['version:original', 'production/generated/image.png', '/review-audio/story-source.mp3', '/media/preview.jpg', 'asset:1']) {
    const media = repo.resolveMedia(alias); assert.equal(sha256(readFileSync(path.join(f.options.instance, media.relativePath))), media.sha256);
  }
  const db = new DatabaseSync(path.join(f.options.instance, 'data/review.sqlite'), { readOnly: true });
  for (const bytes of f.events) assert.deepEqual(Buffer.from(db.prepare('SELECT event_bytes FROM domain_events WHERE event_id=?').get(JSON.parse(bytes).eventId).event_bytes), bytes);
  assert.deepEqual(Buffer.from(db.prepare('SELECT snapshot_bytes FROM releases').get().snapshot_bytes), f.snapshotBytes); db.close();
});

test('business mismatch and trial media mismatch fail dry-run without writing a target', async () => {
  const f = fixture('mismatch', { trial: true });
  write(f.root, 'docs/story.md', 'changed business text'); write(f.root, 'pilot/local-trial/media/output.wav', 'changed media');
  const plan = await planInstanceImport(f.options); assert.equal(plan.report.readyForImport, false);
  assert.deepEqual(plan.report.issues.map((item) => item.code).sort(), ['SOURCE_HASH_MISMATCH', 'TRIAL_MEDIA_UNAVAILABLE']);
  await assert.rejects(importInstance(plan, f.options), /Business source conflicts/);
  assert.equal(existsSync(f.options.instance), false);
});

test('new assistant facts during capture abort atomically, and symlink targets never receive files', async () => {
  const f = fixture('races'); const plan = await planInstanceImport(f.options);
  write(f.root, 'assistant/public/turns/new.json', '{"new":"turn"}');
  await assert.rejects(importInstance(plan, f.options), /Assistant file set changed/);
  assert.equal(existsSync(path.join(f.options.instance, 'instance.json')), false);
  const db = new DatabaseSync(path.join(f.options.instance, 'data/review.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM domain_events').get().n, 0); db.close();
  const safe = fixture('symlink'); const safePlan = await planInstanceImport(safe.options);
  const elsewhere = path.join(suiteRoot, 'elsewhere'); mkdirSync(elsewhere); symlinkSync(elsewhere, path.join(safe.root, 'link'));
  await assert.rejects(importInstance(safePlan, { instance: path.join(safe.root, 'link', 'instance') }), /symlink ancestor/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('full business export restores raw bytes and identities, rejects tampering, and rotates only runtime identity', async () => {
  const f = fixture('archive'); const plan = await planInstanceImport(f.options); await importInstance(plan, f.options);
  const repo = openInstanceRepository({ dbPath: path.join(f.options.instance, 'data/review.sqlite'), instanceId: f.profile.instanceId });
  const archive = repo.exportState(); const restored = importRepositoryState({ dbPath: path.join(f.root, 'restore.sqlite'), archive, instanceId: f.profile.instanceId });
  assert.equal(restored.integrityCheck().ok, true); assert.notEqual(restored.readView().runtimeEpoch, repo.readView().runtimeEpoch);
  const imported = restored.exportState();
  for (const table of Object.keys(archive.tables).filter((name) => name !== 'repository_meta')) assert.deepEqual(imported.tables[table], archive.tables[table]);
  assert.deepEqual(imported.sequence, archive.sequence); assert.equal(imported.mediaIncluded, false);
  const corrupt = structuredClone(archive); corrupt.tables.record_revisions[0].content_bytes.bytes = Buffer.from('tampered').toString('base64');
  assert.throws(() => importRepositoryState({ dbPath: path.join(f.root, 'bad.sqlite'), archive: corrupt, instanceId: f.profile.instanceId }), { code: 'EXPORT_HASH_MISMATCH' });
  assert.equal(existsSync(path.join(f.root, 'bad.sqlite')), false);
});

test('readonly runtime rejects direct unit writes and a restored inode requires existing services to restart', async () => {
  const f = fixture('runtime-guards'); const plan = await planInstanceImport(f.options); await importInstance(plan, f.options);
  const dbPath = path.join(f.options.instance, 'data/review.sqlite');
  const repo = openInstanceRepository({ dbPath, instanceId: f.profile.instanceId });
  const prior = process.env.REVIEW_INSTANCE_READ_ONLY;
  try {
    process.env.REVIEW_INSTANCE_READ_ONLY = '1';
    const diagnostic = openInstanceRepository({ dbPath, instanceId: f.profile.instanceId, readOnly: false });
    assert.equal(diagnostic.readView().snapshot.snapshotId, plan.snapshot.snapshotId);
    await assert.rejects(diagnostic.writeTransaction((tx) => tx.putAux({ namespace: 'escape', key: 'bad', bytes: '{}', expectedRevisionId: null })), { code: 'READ_ONLY' });
    await assert.rejects(repo.writeTransaction(() => {}), { code: 'READ_ONLY' }, 'a previously opened writable repository must obey the process read-only switch');
    assert.equal(repo.getAux('escape', 'bad'), null);
  } finally { if (prior === undefined) delete process.env.REVIEW_INSTANCE_READ_ONLY; else process.env.REVIEW_INSTANCE_READ_ONLY = prior; }
  const archive = repo.exportState();
  const replacementPath = path.join(f.root, 'replacement.sqlite');
  const replacement = importRepositoryState({ dbPath: replacementPath, archive, instanceId: f.profile.instanceId });
  const replacementEpoch = replacement.readView().runtimeEpoch; replacement.close();
  renameSync(dbPath, `${dbPath}.pre-restore`); renameSync(replacementPath, dbPath);
  assert.throws(() => repo.readView(), { code: 'DATABASE_REPLACED' });
  await assert.rejects(repo.writeTransaction(() => {}), { code: 'DATABASE_REPLACED' });
  const restarted = openInstanceRepository({ dbPath, instanceId: f.profile.instanceId });
  assert.equal(restarted.readView().runtimeEpoch, replacementEpoch);
  assert.equal(restarted.integrityCheck().ok, true);
});

test('legacy execution targets preserve logical identity while mapping only to isolated instance media', () => {
  const target = 'production/generated/audio/_review_pending/voice/voice.wav';
  const managed = instanceCandidateRelativePath(target);
  assert.equal(managed, `media/_review_pending/legacy-targets/${target}`);
  assert.equal(instanceCandidateRelativePath('media/_review_pending/native/v1.png'), 'media/_review_pending/native/v1.png');
  for (const invalid of ['/production/generated/_review_pending/a.png', 'production/generated/../../_review_pending/a.png', 'media/x/../_review_pending/a.png', 'production/generated/locked/a.png', 'docs/_review_pending/a.md', 'media\\_review_pending\\a.png']) {
    assert.throws(() => instanceCandidateRelativePath(invalid), { code: 'INVALID_MEDIA_PATH' });
  }
});
