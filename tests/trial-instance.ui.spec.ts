import { test, expect } from '@playwright/test';
import { blankProfile } from '../host/instance-runtime/blank.mjs';

type Snapshot = { mutationEtag: string; mode: string; recipes: Array<{ id: string; subjectId: string; label: string }>; assets: Array<{ id: string; mediaId: string; versionId: string; sha256: string; lifecycle: string; qualityBlocked?: boolean; reviewHeadId?: string; reviewCriteria: Array<{ id: string }> }> };
let snapshot: Snapshot;
test.beforeAll(async ({ request }) => {
  const source = process.env.TRIAL_READONLY_SNAPSHOT_URL;
  test.skip(!source, 'Set an explicit read-only snapshot URL to validate preserved real user judgments.');
  const response = await request.get(source!);
  expect(response.status()).toBe(200);
  snapshot = await response.json();
  expect(snapshot.assets).toHaveLength(8);
  expect(snapshot.assets.filter((asset) => asset.lifecycle === 'RELEASED')).toHaveLength(5);
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/instance/profile', route => route.fulfill({ json: blankProfile({ instanceId: 'trial-import-ui-fixture', title: '测试审阅台' }) }));
  const scope = (snapshot as Snapshot & { scope: { id: string } }).scope;
  await page.route('**/api/trial/scopes', route => route.fulfill({ json: { scopes: [scope], defaultScopeId: scope.id } }));
  await page.route('**/api/trial/snapshot*', (route) => route.fulfill({ json: snapshot, headers: { ETag: snapshot.mutationEtag } }));
  // No browser media or review request reaches the source instance.
  await page.route('**/api/trial/media/**', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64') }));
  await page.route('**/api/trial/reviews*', (route) => route.fulfill({ status: 409, json: { error: 'CAS_CONFLICT' } }));
});

test('all five real released versions show saved judgments and explain disabled review buttons', async ({ page }) => {
  await page.goto('/trial?view=materials');
  for (const asset of snapshot.assets.filter((item) => item.lifecycle === 'RELEASED')) {
    const recipe = snapshot.recipes.find((item) => item.subjectId === asset.mediaId)!;
    await page.getByRole('navigation', { name: '试制素材目录' }).getByRole('button', { name: recipe.label }).click();
    await expect(page.locator('.trial-version .trial-status')).toHaveText('已通过并放行');
    await expect(page.locator('#trial-common-reason')).toContainText('已保存审阅结论');
    for (const label of ['通过并放行', '要求修改', '禁止使用']) {
      const button = page.getByRole('button', { name: label, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-describedby', 'trial-common-reason');
    }
    const checked = page.getByRole('radio', { name: '符合', exact: true });
    for (const radio of await checked.all()) await expect(radio).toBeChecked();
    await expect(page.getByRole('button', { name: '纠正上次判断' })).toBeEnabled();
  }
});

test('hall geometry block explains the disabled release and historical versions stay read-only', async ({ page }) => {
  const asset = snapshot.assets.find((item) => item.qualityBlocked)!;
  const recipe = snapshot.recipes.find((item) => item.subjectId === asset.mediaId)!;
  await page.goto('/trial?view=materials');
  await page.getByRole('navigation', { name: '试制素材目录' }).getByRole('button', { name: recipe.label }).click();
  await expect(page.getByText('技术预检发现需要返修', { exact: true })).toBeVisible();
  await expect(page.locator('#trial-release-reason')).toContainText(/返修|修正|几何/);
  await expect(page.getByRole('button', { name: '通过并放行', exact: true })).toBeDisabled();
  for (const radio of await page.getByRole('radio', { name: '符合', exact: true }).all()) await radio.check();
  await page.getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: '通过并放行', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '要求修改', exact: true })).toBeEnabled();
  const versions = snapshot.assets.filter((item) => item.mediaId === asset.mediaId);
  await page.locator('.trial-version-select select').selectOption(versions[0].versionId);
  await expect(page.locator('#trial-common-reason')).toContainText('历史版本只读');
  await expect(page.getByRole('button', { name: '要求修改', exact: true })).toBeDisabled();
});

test('a FAIL permits empty optional opinions and a conflict preserves the selected judgment', async ({ page }) => {
  const asset = snapshot.assets.find((item) => item.lifecycle === 'RELEASED')!;
  const recipe = snapshot.recipes.find((item) => item.subjectId === asset.mediaId)!;
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/trial/reviews*', async (route) => { submitted = route.request().postDataJSON(); await route.fulfill({ status: 409, json: { error: 'CAS_CONFLICT' } }); });
  await page.goto('/trial?view=materials');
  await page.getByRole('navigation', { name: '试制素材目录' }).getByRole('button', { name: recipe.label }).click();
  await page.getByRole('button', { name: '纠正上次判断' }).click();
  await page.getByRole('radio', { name: '需要修改', exact: true }).first().check();
  await expect(page.getByRole('textbox', { name: '整体意见（选填）' })).toHaveValue('');
  await expect(page.getByRole('button', { name: '要求修改', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '要求修改', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('当前意见已保留');
  expect(submitted).toMatchObject({ decision: 'REVISION_REQUIRED', comment: '', versionId: asset.versionId, supersedesReviewEventId: asset.reviewHeadId });
  await expect(page.getByRole('radio', { name: '需要修改', exact: true }).first()).toBeChecked();
});

test.afterAll(async ({ request }) => {
  if (!snapshot) return;
  const after = await (await request.get(process.env.TRIAL_READONLY_SNAPSHOT_URL!)).json();
  expect(after.mutationEtag).toBe(snapshot.mutationEtag);
  expect(after.assets.map((asset: { versionId: string; lifecycle: string; reviewHeadId: string }) => [asset.versionId, asset.lifecycle, asset.reviewHeadId]))
    .toEqual(snapshot.assets.map((asset) => [asset.versionId, asset.lifecycle, asset.reviewHeadId]));
});
