import { test, expect } from '@playwright/test';
import { blankProfile } from '../host/instance-runtime/blank.mjs';

const fixture = () => ({
  mode: 'LOCAL_TRIAL', mutationEtag: '"fixture-head-1"',
  scope: { id: 'fixture-trial', title: '试制测试范围', projectTitle: '测试审阅台', countsTowardFormalProject: false },
  checkpoint: { id: 'CP1', state: 'USER_CONFIRMED' },
  recipes: [{ id: 'test-recipe', subjectId: 'fixture-material', label: '空钱袋测试候选', model: 'TEST_ONLY' }],
  assets: [{ id: 'fixture-asset', mediaId: 'fixture-material', versionId: 'fixture-version-1', sha256: 'a'.repeat(64), version: 1, mediaKind: 'IMAGE', mediaUrl: '/api/trial/media/fixture-asset', recipeId: 'test-recipe', title: '空钱袋测试候选', lifecycle: 'REVIEW_PENDING', metadata: { RIGHTS_STATUS: 'UNKNOWN' }, prompt: { full: '测试用途完整生产资料' }, qa: {}, reviewCriteria: ['intent', 'material', 'composition', 'safety'].map((id, i) => ({ id, label: `检查${i + 1}`, description: `测试判断${i + 1}` })), reviewHeadId: null }],
  budgets: [], executions: [],
  story: { episodes: [{ episodeUid: 'trial-fixture-ep', displayLabel: '试制第1集', title: '测试故事', goal: '明确测试叙事目的', audienceKnowsAtEnd: '看懂测试因果', endingHook: '测试悬念', sourceSceneId: 'S02' }], sourceScenes: [], shotProposals: [], dialogue: [] },
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/instance/profile', route => route.fulfill({ json: blankProfile({ instanceId: 'trial-ui-fixture', title: '测试审阅台' }) }));
  await page.route('**/api/trial/scopes', (route) => route.fulfill({ json: { scopes: [fixture().scope], defaultScopeId: fixture().scope.id } }));
  await page.route('**/api/trial/snapshot*', (route) => route.fulfill({ json: fixture(), headers: { ETag: '"fixture-head-1"' } }));
  await page.route('**/api/trial/media/fixture-asset', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64') }));
});

test('release requires every judgment and internal-use attestation; conflict keeps the draft', async ({ page }) => {
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/trial/reviews*', async (route) => {
    submitted = route.request().postDataJSON();
    expect(route.request().headers()['if-match']).toBe('"fixture-head-1"');
    await route.fulfill({ status: 409, json: { error: 'CAS_CONFLICT' } });
  });
  await page.goto('/trial?view=materials');
  await expect(page.getByRole('heading', { name: '空钱袋测试候选' })).toBeVisible();
  const release = page.getByRole('button', { name: '通过并放行', exact: true });
  await expect(release).toBeDisabled();
  for (const radio of await page.getByRole('radio', { name: '符合', exact: true }).all()) await radio.check();
  await expect(release).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('textbox', { name: '整体意见' }).fill('这段意见在冲突后必须保留');
  await expect(release).toBeEnabled();
  await release.click();
  await expect(page.getByRole('status')).toContainText('已变化');
  await expect(page.getByRole('textbox', { name: '整体意见' })).toHaveValue('这段意见在冲突后必须保留');
  expect(submitted).toMatchObject({ mediaId: 'fixture-material', versionId: 'fixture-version-1', sha256: 'a'.repeat(64), decision: 'RELEASED', rightsAttestation: 'PROJECT_INTERNAL_ONLY' });
  expect(submitted).toMatchObject({ scopeId: 'fixture-trial' });
});

test('scope selection keeps media and review bound to the selected batch and preserves old scope links', async ({ page }) => {
  const first = fixture();
  const second = { ...fixture(), mutationEtag: '"second-scope-head"', scope: { ...fixture().scope, id: 'second-scope', title: '第二批独立候选' }, assets: fixture().assets.map(asset => ({ ...asset, mediaUrl: '/api/trial/media/second-asset?scopeId=second-scope', title: '第二批图像候选' })) };
  await page.route('**/api/trial/scopes', route => route.fulfill({ json: { scopes: [first.scope, second.scope], defaultScopeId: first.scope.id } }));
  await page.route('**/api/trial/snapshot*', route => { const scopeId = new URL(route.request().url()).searchParams.get('scopeId'); const snapshot = scopeId === second.scope.id ? second : first; return route.fulfill({ json: snapshot, headers: { ETag: snapshot.mutationEtag } }); });
  await page.route('**/api/trial/media/second-asset*', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64') }));
  let requestScope = ''; let requestEtag = '';
  await page.route('**/api/trial/reviews*', async route => { requestScope = new URL(route.request().url()).searchParams.get('scopeId') || ''; requestEtag = route.request().headers()['if-match']; expect(route.request().postDataJSON().scopeId).toBe(second.scope.id); await route.fulfill({ status: 409, json: { error: 'CAS_CONFLICT' } }); });
  await page.goto('/trial?view=materials');
  await expect(page.getByRole('heading', { name: first.scope.title })).toBeVisible();
  await page.getByRole('combobox', { name: '试制范围' }).selectOption(second.scope.id);
  await expect(page.getByRole('heading', { name: '第二批图像候选' })).toBeVisible();
  await expect(page.locator('.trial-media img')).toHaveAttribute('src', /scopeId=second-scope/);
  for (const radio of await page.getByRole('radio', { name: '符合', exact: true }).all()) await radio.check();
  await page.getByRole('button', { name: '要求修改', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('当前意见已保留');
  expect(requestScope).toBe(second.scope.id); expect(requestEtag).toBe(second.mutationEtag);
  await page.goto('/trial?view=materials&scopeId=fixture-trial');
  await expect(page.getByRole('heading', { name: '空钱袋测试候选' })).toBeVisible();
});

test('native image dialog closes with Escape and story scope navigation works', async ({ page }) => {
  await page.goto('/trial?view=materials');
  await page.getByRole('button', { name: '放大原图' }).click();
  await expect(page.getByRole('dialog', { name: '图片原件' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '图片原件' })).not.toBeVisible();
  await page.getByRole('link', { name: '02 故事创作' }).click();
  await expect(page.getByText('明确测试叙事目的', { exact: false })).toBeVisible();
});

test('mobile review has no horizontal overflow and remote-shaped requests fail closed', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/trial?view=materials');
  await expect(page.getByRole('heading', { name: '空钱袋测试候选' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const denied = await request.post('/api/trial/reviews', { headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, data: {} });
  expect(denied.status()).toBe(403);
});
