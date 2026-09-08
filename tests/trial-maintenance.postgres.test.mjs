import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runMaintenanceProcess } from '../scripts/instance-maintenance.mjs';
import { runPostgresMaintenance, pgBootstrap, docker } from '../scripts/instance-postgres.mjs';
import { runInstanceCli } from '../host/instance-runtime/transport.mjs';
import { sha256 } from '../host/instance-runtime/bytes.mjs';

test('real PostgreSQL maintenance CLI holds the current shared media lease across inspect and image registration', { skip: process.env.REVIEW_TEST_POSTGRES !== '1', timeout: 180000 }, async () => {
  const parent = path.resolve('tests/.test-tmp'); await mkdir(parent, { recursive: true });
  const suite = await mkdtemp(path.join(parent, 'trial-maintenance-')), root = path.join(suite, 'instance');
  let postgres;
  const cli = async (command, { file, scope, etag, key } = {}) => JSON.parse((await runPostgresMaintenance(root, ['scripts/instance-trial-worker.mjs', command, '--instance', '/instance', ...(file ? ['--file', `/instance/scratch/${file}`] : []), ...(scope ? ['--scope', scope] : []), ...(etag ? ['--if-match', etag] : []), ...(key ? ['--idempotency-key', key] : [])])).toString());
  const manifest = async (name, value) => { await writeFile(path.join(root, 'scratch', name), JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return name; };
  try {
    await runMaintenanceProcess(process.execPath, [path.resolve('scripts/instance-create.mjs'), '--instance', root, '--title', '受控图片试制命令测试']);
    postgres = await pgBootstrap(root);
    const before = await runInstanceCli(root, ['host-profile']), first = await cli('inspect');
    assert.equal(first.instanceId, before.instanceId); assert.equal(first.releaseId, before.releaseId); assert.deepEqual(first.scopeIds, []);
    const scope = 'trial:maintenance-fixture';
    const scopeFile = await manifest('scope.json', { expectedReleaseId: first.releaseId, expectedIndexRevisionId: first.indexRevisionId, scope: { id: scope, title: '图片试制', projectTitle: '隔离命令测试', countsTowardFormalProject: false }, limits: { IMAGE: 1, AUDIO: 0, VIDEO: 0 }, authorization: { id: 'fixture:batch', userInstruction: '只允许合成测试数据，无模型调用', maxOutputsPerRecipe: 1 } });
    const created = await cli('prepare-scope', { file: scopeFile, key: 'fixture-create-scope' });
    const sourceBytes = '固定来源测试依据'; await writeFile(path.join(root, 'scratch/source.md'), sourceBytes, { flag: 'wx' });
    const recipe = { id: 'fixture:recipe', subjectId: 'fixture:image', label: '合成测试图片', mediaKind: 'IMAGE', model: 'GPT-IMG-2', fullPrompt: '仅测试执行协议，不调用模型', inputBindings: [], sourceBindings: [{ path: 'scratch/source.md', sha256: sha256(sourceBytes) }], output: { relativePath: 'media/_review_pending/fixture/test.png', versionId: 'fixture:image@TRIAL-V001' }, authorization: { id: 'fixture:image-call', userInstruction: '测试执行协议，不调用模型', maxOutputs: 1 }, runtimeBlockers: [] };
    const recipeFile = await manifest('recipe.json', { scopeId: scope, recipe });
    const dryRun = await cli('dry-run', { file: recipeFile, scope }); assert.equal(dryRun.status, 'PREFLIGHT_PASSED'); assert.equal(dryRun.mutationEtag, created.mutationEtag);
    const prepared = await cli('prepare-recipe', { file: recipeFile, scope, etag: created.mutationEtag, key: 'fixture-prepare-recipe' });
    const reserved = await cli('reserve', { file: await manifest('reserve.json', { recipeId: recipe.id, workerId: 'fixture:worker' }), scope, etag: prepared.mutationEtag, key: 'fixture-reserve-image' });
    const binding = Object.fromEntries(['requestId', 'leaseToken', 'fencingToken', 'inputHash', 'promptHash'].map((key) => [key, reserved.execution[key]]));
    const started = await cli('start', { file: await manifest('start.json', binding), scope, etag: reserved.mutationEtag, key: 'fixture-start-image' });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIasAAAAASUVORK5CYII=', 'base64');
    await mkdir(path.dirname(path.join(root, recipe.output.relativePath)), { recursive: true }); await writeFile(path.join(root, recipe.output.relativePath), bytes, { flag: 'wx', mode: 0o600 });
    const resultFile = await manifest('result.json', { ...binding, outcome: 'SUCCEEDED', file: recipe.output.relativePath, sha256: sha256(bytes), receipt: { dispatchId: started.execution.dispatchId, modelVersion: 'FIXTURE_NO_PROVIDER_CALL' }, qa: { visualStatus: 'UNKNOWN' } });
    const result = await cli('result', { file: resultFile, scope, etag: started.mutationEtag, key: 'fixture-result-image' });
    assert.equal(result.asset.lifecycle, 'REVIEW_PENDING'); assert.equal(result.asset.rightsStatus, 'UNKNOWN');
    const replay = await cli('result', { file: resultFile, scope, etag: started.mutationEtag, key: 'fixture-result-image' }); assert.equal(replay.replayed, true); assert.equal(replay.asset.id, result.asset.id);
    const final = await cli('inspect', { scope }); assert.equal(final.assets.length, 1); assert.equal(final.budgets[0].spent, 1); assert.equal(final.executions[0].leaseToken, undefined);
    const after = await runInstanceCli(root, ['host-profile']); assert.equal(after.releaseId, before.releaseId); assert.equal(after.snapshotId, before.snapshotId); assert.ok(after.repositoryRevision > before.repositoryRevision);
  } finally {
    if (postgres) { await docker(['rm', '-f', postgres.container]); await docker(['volume', 'rm', postgres.volume]); await docker(['network', 'rm', postgres.network]); }
    await rm(suite, { recursive: true, force: true });
  }
});
