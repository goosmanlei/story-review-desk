import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';

assert.ok(await requiredPhase(process.cwd()), 'Use managed runner');
const base = process.env.REVIEW_UI_BASE || 'http://127.0.0.1:3916';
const get = async path => {
  const response = await fetch(base + '/api/v1/' + path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const profile = await get('workspaces/profile');
assert.match(profile.instanceId, /^ui-fixture-/, 'Writes only in isolated fixture');
const before = (await get('workspaces/views/episode-plan')).plan;
const story = await get('objects/' + encodeURIComponent(before.content.planId));
const browser = await chromium.launch({channel: 'chrome'});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  const overview = page.locator('.narrative-overview');
  const normal = base + '/?view=story&storyMode=story-structure';
  await page.goto(normal + '&episodePlanRevision=' + encodeURIComponent(before.revisionId), {waitUntil: 'networkidle'});
  await overview.waitFor();
  await page.waitForFunction(() => !new URL(location.href).searchParams.has('episodePlanRevision'));
  assert.equal(await page.getByText('查看原始方案版本', {exact: true}).count(), 0);
  for (const label of ['创作说明', '分集与视角接力', '铺垫与揭晓']) {
    await overview.getByRole('button', {name: label, exact: true}).click();
    assert((await overview.innerText()).length > 100);
  }
  assert.match(await overview.innerText(), /当前为草稿/);

  // Save a new working revision without adopting it; all three tabs must follow it.
  const marker = '隔离当前稿验证-' + randomUUID();
  const content = structuredClone(story.revision.content);
  content.documents = [{id: 'current-draft-test', title: marker, text: '# ' + marker,
    sha256: createHash('sha256').update('# ' + marker).digest('hex')}];
  content.runtimeMethod = marker;
  content.causalChains = [{id: 'current-chain-test', title: marker, mustPreserve: marker,
    setupSceneIds: [], payoffSceneIds: [], status: 'UNKNOWN'}];
  const historicalRevision = 'fixture-history-' + randomUUID();
  const originalEvent = JSON.stringify({subjectKind: 'EPISODE_PLAN', creativeRevisionId: historicalRevision,
    content: before.content, recordedAt: new Date().toISOString(), contentHash: before.contentHash});
  const originalSha = createHash('sha256').update(originalEvent).digest('hex');
  const operationId = randomUUID();
  const response = await fetch(base + '/api/v1/transactions', {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Review-Runtime': profile.deployment.runtimeEpoch, 'Idempotency-Key': operationId},
    body: JSON.stringify({operationId, commands: [{type: 'save', id: story.id,
      expectedVersion: story.version, content}, {type: 'save', id: historicalRevision, kind: 'SOURCE',
      title: '隔离历史方案', expectedVersion: 0, content: {role: 'ARCHIVED_EPISODE_PLAN',
        originalRevisionId: historicalRevision, originalEventSha256: originalSha, sha256: originalSha, text: originalEvent}}]})});
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, 'SUCCEEDED');
  const after = (await get('workspaces/views/episode-plan')).plan;
  assert.notEqual(after.revisionId, before.revisionId);
  for (const label of ['创作说明', '分集与视角接力', '铺垫与揭晓']) {
    await overview.getByRole('button', {name: label, exact: true}).click();
    await overview.getByText(marker, {exact: true}).first().waitFor();
    assert.equal(new URL(page.url()).searchParams.has('episodePlanRevision'), false);
  }
  await page.reload({waitUntil: 'networkidle'});
  await overview.getByText(marker, {exact: true}).first().waitFor();
  await page.goto(normal + '&episodePlanArchive=1&episodePlanRevision=' + encodeURIComponent(historicalRevision), {waitUntil: 'networkidle'});
  await overview.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('episodePlanRevision'), historicalRevision);
  assert.equal((await overview.innerText()).includes(marker), false);
  assert.match(await overview.innerText(), /历史方案/);
  await page.getByRole('tab', {name: '故事结构', exact: true}).click();
  await overview.getByText(marker, {exact: true}).first().waitFor();
  assert.equal(new URL(page.url()).searchParams.has('episodePlanArchive'), false);
  const unchanged = await get('objects/' + encodeURIComponent(story.id) + '?revisionId=' + encodeURIComponent(before.revisionId));
  assert.deepEqual(unchanged.revision.content, story.revision.content);
  assert.equal((await get('objects/' + encodeURIComponent(story.id))).adoptedRevisionId, story.adoptedRevisionId);
  assert.deepEqual(writes, [], 'Reading and navigation do not write business data');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({status: 'PASSED', checks: ['three complete tabs', 'unpinned normal route', 'new draft in all tabs', 'reload current draft', 'exact historical revision', 'normal tab exits history', 'history and adoption preserved', 'no browser writes'], fixture: profile.instanceId}));
} finally { await browser.close(); }
