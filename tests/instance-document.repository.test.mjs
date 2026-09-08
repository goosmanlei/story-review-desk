import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstanceRepository, openInstanceRepository, resolveInstance } from '../host/instance-runtime/index.mjs';
import { putInstanceDocument, publishedInstanceDocuments } from '../scripts/instance-document.mjs';

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = path.join(app, 'tests/.test-tmp'); mkdirSync(temporary, { recursive: true }); const suite = mkdtempSync(path.join(temporary, 'document-guard-'));
after(() => { rmSync(suite, { recursive: true, force: true }); try { rmdirSync(temporary); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } });
let number = 0;
async function fixture() {
  const root = path.join(suite, String(number++)); mkdirSync(root);
  const instanceId = `instance:guard:${number}`; const profile = { instanceId, projectId: `story:${number}`, episodePlanId: `plan:${number}`, sourceBindings: { creativeRevisionPaths: { EPISODE_PLAN: 'story/current.json' }, derivedRegistryPaths: Array.from({ length: 9 }, (_, n) => `registry/${n}.json`) } };
  const repo = (await createInstanceRepository({ dbPath: path.join(root, 'review.sqlite'), instanceId, profile }));
  writeFileSync(path.join(root, 'instance.json'), JSON.stringify({ schemaVersion: '1.0', instanceId, database: 'review.sqlite' }));
  const snapshotBytes = Buffer.from(' {"snapshotId":"snapshot:original","productionModel":{}}\r\n');
  const recipesBytes = Buffer.from(' {"snapshotId":"snapshot:original","sourceCatalog":[{"path":"source/screenplay.md"}]}\n');
  await repo.writeTransaction(async tx => {
    const ids = [];
    for (const alias of ['story/current.json', ...profile.sourceBindings.derivedRegistryPaths, 'source/screenplay.md', 'production/prompts/direct/current.md']) ids.push((await tx.putDocument({ documentId: `legacy-source:${alias}`, aliases: [alias, `notes/${path.basename(alias)}`], bytes: 'original', expectedRevisionId: null, metadata: { sourceRole: 'SOURCE_DOCUMENT' } })).revisionId);
    ids.push((await tx.putDocument({ documentId: 'guidance', aliases: ['README.md'], bytes: 'original guide', expectedRevisionId: null, metadata: { sourceRole: 'INSTANCE_GUIDANCE' } })).revisionId);
    (await tx.publishRelease({ snapshotBytes, recipesBytes, expectedReleaseId: null, sourceRevisionIds: ids }));
  });
  return { root, repo, snapshotBytes, recipesBytes };
}

test('generic document put rejects all nine registries, creative aliases/IDs, source catalog and direct Prompts atomically', async () => {
  const f = await fixture(); const before = (await f.repo.exportState()).exportSha256;
  for (const alias of ['story/current.json', 'notes/current.json', 'legacy-source:story/current.json', ...Array.from({ length: 9 }, (_, n) => `registry/${n}.json`), 'notes/0.json', 'source/screenplay.md', 'notes/screenplay.md', 'production/prompts/direct/current.md', 'notes/current.md']) {
    const document = (await f.repo.readDocument(alias));
    await assert.rejects(putInstanceDocument(f.repo, { alias, bytes: Buffer.from('bypass'), expectedRevisionId: document.revisionId }), /controlled source sync/);
  }
  assert.equal((await f.repo.exportState()).exportSha256, before);
});

test('new draft publication never adopts unrelated heads and preserves original snapshot and recipe bytes', async () => {
  const f = await fixture(); const release = (await f.repo.readRelease()); const old = (await f.repo.readDocument('story/current.json'));
  const hidden = await f.repo.writeTransaction(async tx => (await tx.putDocument({ documentId: old.documentId, bytes: 'UNPUBLISHED', expectedRevisionId: old.revisionId, metadata: old.metadata })));
  const draft = await putInstanceDocument(f.repo, { alias: 'story/source-notes.md', bytes: Buffer.from('new evidence'), expectedRevisionId: null, sourceRole: 'SOURCE_DOCUMENT' });
  const published = (await f.repo.readRelease()); assert.equal(published.sourceRevisionIds.length, release.sourceRevisionIds.length + 1);
  assert.ok(published.sourceRevisionIds.includes(old.revisionId)); assert.ok(!published.sourceRevisionIds.includes(hidden.revisionId)); assert.ok(published.sourceRevisionIds.includes(draft.revisionId));
  assert.deepEqual(published.snapshotBytes, f.snapshotBytes); assert.deepEqual(published.recipesBytes, f.recipesBytes); assert.equal((await f.repo.listEvents()).length, 0);
  const read = spawnSync(process.execPath, [path.join(app, 'scripts/instance-document.mjs'), 'read', '--instance', f.root, '--alias', old.documentId], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr); assert.equal(read.stdout, 'original');
  const list = spawnSync(process.execPath, [path.join(app, 'scripts/instance-document.mjs'), 'list', '--instance', f.root], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr); assert.equal(JSON.parse(list.stdout).find(row => row.documentId === old.documentId).revisionId, old.revisionId);
});

test('explicit draft CAS remains editable but cannot downgrade imported authority or become executable guidance', async () => {
  const f = await fixture(); const first = await putInstanceDocument(f.repo, { alias: 'story/source-notes.md', bytes: Buffer.from('one'), expectedRevisionId: null });
  const second = await putInstanceDocument(f.repo, { alias: 'story/source-notes.md', bytes: Buffer.from('two'), expectedRevisionId: first.revisionId }); assert.notEqual(second.revisionId, first.revisionId);
  await assert.rejects(putInstanceDocument(f.repo, { alias: 'story/source-notes.md', bytes: Buffer.from('stale'), expectedRevisionId: first.revisionId }), error => error.code === 'HEAD_CONFLICT');
  await assert.rejects(putInstanceDocument(f.repo, { alias: 'story/source-notes.md', bytes: Buffer.from('role escalation'), expectedRevisionId: second.revisionId, sourceRole: 'INSTANCE_GUIDANCE' }), /cannot be relabeled/);
  await assert.rejects(putInstanceDocument(f.repo, { alias: 'scripts/new_module.py', bytes: Buffer.from('print("unsafe")'), expectedRevisionId: null }), /non-executable/);
  const guide = (await f.repo.readDocument('README.md')); await putInstanceDocument(f.repo, { alias: 'README.md', bytes: Buffer.from('new guide'), expectedRevisionId: guide.revisionId }); assert.equal((await f.repo.readDocument('README.md')).metadata.sourceRole, 'INSTANCE_GUIDANCE');
});

test('unpublished profile and draft heads cannot be silently promoted by a document update', async () => {
  const f = await fixture(); const draft = await putInstanceDocument(f.repo, { alias: 'drafts/new.md', bytes: Buffer.from('one'), expectedRevisionId: null });
  const hidden = await f.repo.writeTransaction(async tx => (await tx.putDocument({ documentId: draft.documentId, bytes: 'pending', expectedRevisionId: draft.revisionId, metadata: (await tx.readDocument(draft.documentId)).metadata })));
  await assert.rejects(putInstanceDocument(f.repo, { alias: 'drafts/new.md', bytes: Buffer.from('three'), expectedRevisionId: hidden.revisionId }), /unpublished document head/);
  await f.repo.writeTransaction(async tx => { const profile = (await tx.getConfig('instance-profile')); (await tx.putConfig({ configId: 'instance-profile', value: { ...profile.value, title: 'UNPUBLISHED' }, expectedRevisionId: profile.revisionId })); });
  const before = (await f.repo.exportState()).exportSha256;
  await assert.rejects(putInstanceDocument(f.repo, { alias: 'drafts/another.md', bytes: Buffer.from('one'), expectedRevisionId: null }), /controlled settings/);
  assert.equal((await f.repo.exportState()).exportSha256, before);
  assert.equal((await f.repo.readTransaction(publishedInstanceDocuments)).find(row => row.documentId === draft.documentId).revisionId, draft.revisionId);
});

test('legacy SQLite fixture new-story CLI creates a blank identity, imports readable evidence and checks offline startup without a legacy root', async () => {
  const root = path.join(suite, 'new-story-cli'); const input = path.join(suite, 'new-story-notes.md'); writeFileSync(input, '# 来源\n\n独立的新故事资料。\n');
  const run = (script, args) => {
    const output = spawnSync(process.execPath, [path.join(app, 'scripts', script), ...args], { cwd: app, encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'C.UTF-8', REVIEW_PROJECT_ROOT: path.join(suite, 'DOES_NOT_EXIST'), REVIEW_DATA_FILE: path.join(suite, 'DOES_NOT_EXIST.json') } });
    assert.equal(output.status, 0, output.stderr); return output.stdout;
  };
  const created = JSON.parse(run('instance-create.mjs', ['--instance', root, '--title', '独立测试故事', '--backend', 'sqlite']));
  const imported = JSON.parse(run('instance-document.mjs', ['put', '--instance', root, '--alias', 'story/source-notes.md', '--file', input, '--expected-revision', 'NULL', '--role', 'SOURCE_DOCUMENT']));
  assert.equal(imported.formalAdoptionPerformed, false);
  assert.equal(run('instance-document.mjs', ['read', '--instance', root, '--alias', 'story/source-notes.md']), '# 来源\n\n独立的新故事资料。\n');
  const startup = JSON.parse(run('instance-start.mjs', ['--instance', root, '--offline', '--port', '4199', '--check']));
  assert.equal(startup.mode, 'PLAN_ONLY'); assert.equal(startup.instanceId, created.instanceId); assert.equal(startup.parentProjectRequired, false); assert.deepEqual(startup.services, ['review-site','shot-production-worker']);
  const repo = (await openInstanceRepository({ ...resolveInstance(root), readOnly: true })); const view = (await repo.readView());
  assert.equal(view.profile.storyTitle, '独立测试故事'); assert.equal(view.sourceRevisionIds.length, 4); assert.deepEqual(view.profile.sourceBindings.derivedRegistryPaths, []); assert.deepEqual(view.snapshot.productionModel.episodes, []); assert.equal((await repo.listEvents()).length, 0);
});
