import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, statSync, utimesSync, renameSync } from 'node:fs';
import {createServer} from 'vite';
import { createInstanceRepository, sha256 } from '../index.mjs';

const site = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = fileURLToPath(new URL('./.test-tmp', import.meta.url)); mkdirSync(temporary, { recursive: true });
const directory = mkdtempSync(path.join(temporary, 'scope-'));
const server=await createServer({root:site,configFile:false,logLevel:'error',cacheDir:path.join(directory,'vite-cache'),server:{middlewareMode:true,hmr:false},appType:'custom'});
after(async () => { await server.close();rmSync(directory, { recursive: true, force: true }); try { rmdirSync(temporary); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } });
// Load real transitive imports and preserve dynamic ESM imports used by storage.
// The old hand-copied import list drifted away from the application graph.
const store = await server.ssrLoadModule('/app/api/v8/_store.ts');
const { canonicalStorySceneIds, storyConfirmationTargets, projectStoryHandoff } = store;
const data = (ids) => ({ snapshotId: 'test:snapshot', instance: { instanceId: 'test', projectId: 'project', episodePlanId: 'plan' }, scope: { storyScenes: ids.length }, creativeLineage: { scenes: ids.map((id) => ({ id })) }, productionModel: { scenes: ids.map((id) => ({ id })), episodePlanRevisions: [], screenplayReleaseSnapshots: [] } });

test('empty story stays empty and cannot claim completed screenplay or episode assembly', () => {
  const blank = data([]);
  assert.deepEqual(canonicalStorySceneIds(blank), []); assert.deepEqual(storyConfirmationTargets(blank), []);
  const handoff = projectStoryHandoff(blank, {}, {});
  assert.equal(handoff.requiredSceneScriptCount, 0); assert.equal(handoff.allSceneScriptsReleased, false); assert.equal(handoff.canEnterEpisodeAssembly, false);
});
test('arbitrary authored scene IDs are covered exactly once; incomplete, duplicate and cross-model sets fail', () => {
  const story = data(['chapter-b:scene', 'opening']);
  story.actionQueueInputs = { rewrittenSceneConfirmations: [{ sceneId: 'opening' }, { sceneId: 'chapter-b:scene' }] };
  assert.deepEqual(storyConfirmationTargets(story).map((row) => row.sceneId), ['opening', 'chapter-b:scene']);
  assert.equal(projectStoryHandoff(story, {}, {}).requiredSceneScriptCount, 2);
  for (const invalid of [
    { ...story, actionQueueInputs: { rewrittenSceneConfirmations: [{ sceneId: 'opening' }] } },
    { ...story, actionQueueInputs: { rewrittenSceneConfirmations: [{ sceneId: 'opening' }, { sceneId: 'opening' }] } },
    { ...story, creativeLineage: { scenes: [{ id: 'opening' }, { id: 'opening' }] } },
    { ...story, productionModel: { ...story.productionModel, scenes: [{ id: 'different' }] } },
    { ...story, scope: { storyScenes: 3 } },
  ]) assert.throws(() => storyConfirmationTargets(invalid), /STORY_CONFIRMATION_/);
});

const envKeys = ['REVIEW_INSTANCE_ROOT', 'REVIEW_INSTANCE_DB', 'REVIEW_INSTANCE_ID', 'REVIEW_SITE_ROOT', 'REVIEW_REMOTE_READ_ONLY', 'REVIEW_INSTANCE_READ_ONLY', 'REVIEW_SQLITE_OWNER', 'REVIEW_LEGACY_FIXTURE', 'REVIEW_TRIAL_LEGACY_FIXTURE', 'REVIEW_NODE_DEV', 'REVIEW_DATA_PATH', 'REVIEW_RECIPE_PATH', 'REVIEW_EVENT_STORE_PATH', 'GENERATED_ASSET_ROOT'];
async function environment(values, callback) {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, values);
  try { return await callback(); }
  finally { for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
}
function instance(name) {
  const root = path.join(directory, name); mkdirSync(path.join(root, 'data'), { recursive: true }); mkdirSync(path.join(root, 'media'));
  const instanceId = `instance:${name}`;
  writeFileSync(path.join(root, 'instance.json'), JSON.stringify({ schemaVersion: '1.0', instanceId, database: 'data/review.sqlite' }));
  const repo = createInstanceRepository({ dbPath: path.join(root, 'data/review.sqlite'), instanceId, profile: { instanceId, projectId: `project:${name}`, episodePlanId: `plan:${name}`, title: name } });
  return { root, repo, env: { REVIEW_INSTANCE_ROOT: root, REVIEW_SITE_ROOT: site } };
}
const httpStatus = (status) => (error) => error?.status === status;

test('published document reads pin the release despite a newer head and reject unpublished explicit revisions', async () => {
  const f = instance('published');
  const first = await f.repo.writeTransaction((tx) => tx.putDocument({ documentId: 'doc:story', bytes: '# Published', aliases: ['story.md'], expectedRevisionId: null, metadata: { sourceRole: 'DIRECT_PROMPT' } }));
  await f.repo.writeTransaction((tx) => tx.publishRelease({ snapshot: { snapshotId: 'published' }, recipes: { snapshotId: 'published' }, expectedReleaseId: null, sourceRevisionIds: [first.revisionId] }));
  const second = await f.repo.writeTransaction((tx) => {
    tx.putDocument({ documentId: 'doc:draft', bytes: 'Private draft', aliases: ['draft.md'], expectedRevisionId: null });
    return tx.putDocument({ documentId: first.documentId, bytes: '# Not published', expectedRevisionId: first.revisionId, metadata: { sourceRole: 'OTHER' } });
  });
  await environment(f.env, async () => {
    assert.equal((await store.readInstanceDocument('story.md')).bytes.toString(), '# Published');
    assert.deepEqual((await store.readPublishedInstanceDocuments()).map((row) => row.revisionId), [first.revisionId]);
    assert.equal((await store.readInstanceDocument('story.md', first.revisionId)).revisionId, first.revisionId);
    await assert.rejects(store.readInstanceDocument('story.md', second.revisionId), httpStatus(404));
    await assert.rejects(store.readInstanceDocument('draft.md'), httpStatus(404));
    assert.equal((await store.readInstanceDocument('story.md')).metadata.sourceRole, 'DIRECT_PROMPT');
    assert.equal(store.isDirectPromptSourcePath('story.md'), false, 'a document read alone does not prime the published application prompt whitelist');
  });
});

test('registered media rejects changed bytes despite restored mtime, then revalidates recovery and exact size', async () => {
  const f = instance('media');
  const bytes = Buffer.from('original media bytes');
  const file = path.join(f.root, 'media/source.bin'); writeFileSync(file, bytes);
  await f.repo.writeTransaction((tx) => {
    tx.registerMedia({ mediaId: 'media:one', versionId: 'version:one', relativePath: 'media/source.bin', sha256: sha256(bytes), byteSize: bytes.length, aliases: ['/review-audio/story-source.mp3'] });
    tx.registerMedia({ mediaId: 'media:size', versionId: 'version:size', relativePath: 'media/source.bin', sha256: sha256(bytes), byteSize: bytes.length + 1, aliases: ['/wrong-size'] });
  });
  await environment(f.env, async () => {
    assert.equal(await store.safeGeneratedPath('/review-audio/story-source.mp3'), file);
    assert.equal(await store.safeGeneratedPath('/review-audio/story-source.mp3'), file);
    const before = statSync(file); writeFileSync(file, Buffer.alloc(bytes.length, 'x')); utimesSync(file, before.atime, before.mtime);
    assert.equal(statSync(file).size, before.size);
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(store.safeGeneratedPath('/review-audio/story-source.mp3'), httpStatus(409));
    writeFileSync(file, bytes);
    assert.equal(await store.safeGeneratedPath('/review-audio/story-source.mp3'), file);
    await assert.rejects(store.safeGeneratedPath('/wrong-size'), httpStatus(409));
    const replacement = path.join(f.root, 'media/replace.bin'); writeFileSync(replacement, Buffer.alloc(bytes.length, 'z')); renameSync(replacement, file);
    await assert.rejects(store.safeGeneratedPath('/review-audio/story-source.mp3'), httpStatus(409));
  });
});

test('no instance fails closed even with legacy paths and developer or trial flags; only explicit legacy fixture opts in', async () => {
  const legacy = path.join(directory, 'legacy'); mkdirSync(legacy);
  const snapshot = path.join(legacy, 'snapshot.json'); const recipes = path.join(legacy, 'recipes.json'); const events = path.join(legacy, 'events'); mkdirSync(events);
  writeFileSync(snapshot, JSON.stringify({ snapshotId: 'legacy', productionModel: {} }));
  writeFileSync(recipes, JSON.stringify({ snapshotId: 'legacy', executionDefinitions: [], promptRevisions: [] }));
  await environment({ REVIEW_DATA_PATH: snapshot, REVIEW_RECIPE_PATH: recipes, REVIEW_EVENT_STORE_PATH: events, GENERATED_ASSET_ROOT: legacy, REVIEW_SITE_ROOT: site, REVIEW_NODE_DEV: '1', REVIEW_TRIAL_LEGACY_FIXTURE: '1' }, async () => {
    await assert.rejects(store.reviewData(), httpStatus(503));
    await assert.rejects(store.recipeCatalog(), httpStatus(503));
    await assert.rejects(store.recipeCatalogPath(), httpStatus(503));
    await assert.rejects(store.listAllEvents('review'), httpStatus(503));
    assert.throws(store.eventStorePath, httpStatus(503)); assert.throws(store.generatedRootPath, httpStatus(503));
    process.env.REVIEW_LEGACY_FIXTURE = '1';
    assert.equal((await store.reviewData()).snapshotId, 'legacy');
    assert.equal((await store.recipeCatalog()).snapshotId, 'legacy');
    assert.deepEqual(await store.listAllEvents('review'), []);
    delete process.env.REVIEW_LEGACY_FIXTURE;
    await assert.rejects(store.reviewData(), httpStatus(503));
    await assert.rejects(store.recipeCatalog(), httpStatus(503));
  });
});

test('a cached repository and verified media never bypass a newly assigned Docker owner or env impersonation', async () => {
  const f = instance('cached-owner'); const bytes = Buffer.from('cached-media'); const file = path.join(f.root, 'media/source.bin'); writeFileSync(file, bytes);
  await f.repo.writeTransaction(tx => tx.registerMedia({ mediaId: 'cached', versionId: 'cached:v1', relativePath: 'media/source.bin', sha256: sha256(bytes), byteSize: bytes.length, aliases: ['/cached'] }));
  await environment(f.env, async () => {
    assert.equal(await store.safeGeneratedPath('/cached'), file);
    mkdirSync(path.join(f.root, 'runtime'));
    writeFileSync(path.join(f.root, 'runtime/storage-owner.json'), JSON.stringify({ schemaVersion: '1.0', instanceId: 'instance:cached-owner', mode: 'DOCKER', containerRoot: '/instance' }));
    const denied = error => error?.code === 'OWNER_RUNTIME_REQUIRED';
    await assert.rejects(store.safeGeneratedPath('/cached'), denied);
    await assert.rejects(store.readPublishedInstanceDocuments(), denied);
    process.env.REVIEW_SQLITE_OWNER = 'CONTAINER';
    await assert.rejects(store.safeGeneratedPath('/cached'), denied);
    process.env.REVIEW_INSTANCE_READ_ONLY = '1';
    await assert.rejects(store.instanceRepository(), denied);
  });
});
