/**
 * Integration target: review-site/tests/entity-workflow.ui.spec.ts
 * Add this filename to tests/system-management.ui.config.ts.testMatch, then run
 * against that isolated 4293 fixture server (never production 3000).
 *
 * This file intentionally uses the same ../host and ./fixtures imports as the
 * existing UI specs. It is authored in output/ for the main agent to integrate.
 * No server was started and these browser tests have NOT yet been executed.
 * All /api/ requests are intercepted; unexpected requests fail closed with 418.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { defaultConfiguration } from '../host/instance-runtime/configuration-model.mjs';
import { domainHash, type DomainGraph } from '../host/instance-runtime/domain-model.mjs';
import { workspaceProjection } from '../host/instance-runtime/domain-workspaces.mjs';
import type { MaterialRequirement } from '../app/production-workbench';

const BASE_CAPTURE = JSON.parse(readFileSync(new URL('./fixtures/generic-adopted-scene.json', import.meta.url), 'utf8'));
const ids = {
  entityA: 'fixture-person-a', entityB: 'fixture-person-b', location: 'fixture-location',
  stateA: 'fixture-state-before', directoryState: 'fixture-directory-night',
  requirementA: 'MATREQ-FIXTURE-A', requirementB: 'MATREQ-FIXTURE-B',
  episodeA: 'fixture-episode-uid-a', episodeB: 'fixture-episode-uid-b',
  sceneA: 'fixture-scene-uid-a', sceneB: 'fixture-scene-uid-b',
};
const H = { candidate: 'a'.repeat(64), sceneA: 'b'.repeat(64), sceneB: 'c'.repeat(64), requirementA: 'd'.repeat(64), requirementB: 'e'.repeat(64) };
const clone = <T,>(value: T): T => structuredClone(value);

function requirement(id: string, title: string, hash: string): MaterialRequirement {
  return {
    id, title, category: '人物身份', mediaKind: 'IMAGE', requirementClass: 'REQUIRED', reuseScope: 'PROJECT',
    productionLane: 'MATERIAL_PREP', workflowStepId: null, assetFamilyRefs: [], plannedAssetFamilyId: null,
    materialWorkItemRef: null, consumerWorkItemRefs: [], episodeIds: [], episodeUids: [], sceneIds: [], shotIds: [],
    currentShotIds: [], structureCardRefs: [], storyBasis: { sourceRef: 'fixture-exact-source', factBoundary: '制作提案；没有新增媒体观察', whyNeeded: '本场辨认主体', onScreenRequirement: title },
    storyApplicability: { kind: 'PROJECT_LEVEL', reason: '身份资料可以复用，逐场适用性另行确认' },
    acceptanceProfile: 'FIXTURE', acceptanceCriteria: ['主体身份不混淆', '未知信息不得伪装成事实'],
    requirementHash: hash, coverageContextHash: hash, coverageSatisfied: false, bindingStale: false,
    coverageReasons: ['NO_CURRENT_OUTPUT'], coveredByFamilyRefs: [], coveredByVersionRefs: [],
    materialWorkItemLifecycleState: 'WAITING_UPSTREAM',
  };
}

async function fixture(page: Page, { readOnly = false, extraMaterials = 0 } = {}) {
  // Reuse the populated generic shell fixture; do not create a second complete
  // bootstrap mock or import the real story's current business data.
  const capture = clone(BASE_CAPTURE);
  const snapshot = capture.responses.bootstrap.data;
  const profile = snapshot.instance;
  profile.capabilities.landingView = 'settings';
  const configuration = defaultConfiguration(profile);
  const graph: DomainGraph = {
    schemaVersion: '1.0',
    entities: [
      { id: ids.entityA, name: '人物甲', type: 'CHARACTER', description: '谨慎经营小店。', aliases: [], authority: 'A', evidence: [] },
      { id: ids.entityB, name: '人物乙', type: 'CHARACTER', description: '来访者，身份细节待核。', aliases: [], authority: 'U', evidence: [] },
      { id: ids.location, name: '小店', type: 'LOCATION', description: '北上东右；门向尚待确认。', aliases: [], authority: 'U', evidence: [] },
    ],
    states: [{ id: ids.stateA, entityId: ids.entityA, label: '到店之前', dimensions: { storyTime: '入夜前' }, scope: [], authority: 'A', evidence: [] }],
    representations: [
      { id: 'fixture-rep-a', entityId: ids.entityA, stateId: ids.stateA, type: 'IDENTITY', label: '人物甲入店形象', dimensions: {}, assetFamilyIds: [], requirementIds: [ids.requirementA], authority: 'A', evidence: [] },
      { id: 'fixture-rep-b', entityId: ids.entityB, stateId: null, type: 'IDENTITY', label: '人物乙夜间形象', dimensions: {}, assetFamilyIds: [], requirementIds: [ids.requirementB], authority: 'A', evidence: [] },
    ],
    relations: [{ id: 'fixture-social', type: 'SOCIAL', from: { kind: 'ENTITY', id: ids.entityA }, to: { kind: 'ENTITY', id: ids.entityB }, label: '互相认识', purpose: '', inherit: [], exclude: [], scope: [], authority: 'A', evidence: [], status: 'PROPOSED' }],
    requirements: [],
  };
  const requirements = [
    requirement(ids.requirementA, '人物甲入店形象', H.requirementA),
    requirement(ids.requirementB, '人物乙夜间形象', H.requirementB),
    ...Array.from({ length: extraMaterials }, (_, i) => requirement(`MATREQ-FIXTURE-EXTRA-${i}`, `人物甲额外状态素材 ${i + 1}`, String(i).padStart(64, '0'))),
  ];
  for (const item of requirements.slice(2)) graph.representations.push({
    id: `rep-${item.id}`, entityId: ids.entityA, stateId: ids.stateA, type: 'IDENTITY', label: item.title,
    dimensions: {}, assetFamilyIds: [], requirementIds: [item.id], authority: 'A', evidence: [],
  });
  Object.assign(snapshot.productionModel, {
    domainGraph: graph, systemConfiguration: { config: configuration }, materialRequirements: requirements,
    materialWorkItems: [], assetFamilies: [], assetVersions: [], expectedOutputs: [],
  });
  for (const episode of snapshot.productionModel.episodes) episode.title = '原发布旧集';
  // The current bootstrap deliberately has a different published scene set.
  // Entity episode browsing must use the preparation candidate, never these aliases.
  const directoryGraph = clone(graph);
  directoryGraph.states.push({ id: ids.directoryState, entityId: ids.entityB, label: '迁移状态：夜间西侧视角', dimensions: { viewpoint: '西侧', storyTime: '夜间' }, scope: [], authority: 'A', evidence: [] });
  const directory = {
    graph: directoryGraph, revisionId: 'directory-r1', releaseId: 'release-r1', readOnly,
    bindings: requirements.map(item => ({
      requirementId: item.id, requirementHash: item.requirementHash,
      entityId: item.id === ids.requirementB ? ids.entityB : ids.entityA,
      stateId: item.id === ids.requirementB ? ids.directoryState : ids.stateA,
    })), trials: [], staleIds: [],
  };
  const episodes = [
    { episodeUid: ids.episodeA, displayId: 'E01', title: '到店', sceneIds: [ids.sceneA] },
    { episodeUid: ids.episodeB, displayId: 'E02', title: '夜访', sceneIds: [ids.sceneB] },
  ];
  const candidateScenes = [
    { id: ids.sceneA, displayId: 'S01', title: '甲来到小店', contentHash: H.sceneA },
    { id: ids.sceneB, displayId: 'S02', title: '乙夜间来访', contentHash: H.sceneB },
  ];
  let preparation = {
    releaseId: 'release-r1', revisionId: 'prep-r1', stale: false, readOnly,
    formalAdoptionPerformed: false, denominatorState: 'UNKNOWN', comments: [],
    candidate: { revisionId: 'candidate-r1', contentHash: H.candidate, episodes, scenes: candidateScenes },
    content: {
      kind: 'PRODUCTION_PREPARATION', schemaVersion: '1.0', formalAdoptionPerformed: false,
      basis: { candidateRevisionId: 'candidate-r1', candidateContentHash: H.candidate }, episodes,
      scenes: candidateScenes.map((scene, index) => ({
        sceneId: scene.id, displayId: scene.displayId, episodeUid: episodes[index].episodeUid,
        sceneContentHash: scene.contentHash, sourceSummary: { title: scene.title, sourceStatus: 'UNKNOWN' },
        preparation: { sceneRole: '说明来访目的', visualIntent: index === 0 ? '原准备稿画面意图' : '夜间门外轮廓', reviewFocus: ['不得提前揭露身份'], materialGaps: ['精确输入版本待锁定'] },
      })),
    },
    materialLinks: {
      scenes: candidateScenes.map((scene, index) => ({
        sceneId: scene.id, sceneContentHash: scene.contentHash,
        references: [{ requirementId: requirements[index].id, requirementHash: requirements[index].requirementHash, reason: '本场主体精确筹备关系', matchKind: 'EXACT_PROPOSAL' }], unboundNeeds: [],
      })),
    },
  };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const unexpected: string[] = [], pageErrors: string[] = [];
  let preparationReads = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  const operations = { ...capture.responses.operations, snapshotId: snapshot.snapshotId, mutationEtag: '"fixture-operations"' };
  const pagePayload = (requestedId: string | null) => ({
    schemaVersion: '1.0', snapshotId: snapshot.snapshotId, operationRevision: 'fixture-op-r1', appliedMode: 'requirements', detailState: 'COMPLETE',
    page: { materialRequirements: requestedId ? requirements.filter(r => r.id === requestedId) : requirements, materialWorkItems: [], assetFamilies: [], assetVersions: [], expectedOutputs: [] },
    count: requestedId ? 1 : requirements.length, total: requestedId ? 1 : requirements.length, nextCursor: null, hasMore: false, appliedFilters: {},
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === '/api/assistant/v1/context' && request.method() === 'POST') {
      return json({ context: { focus: request.postDataJSON().focus, resources: [], missing: [], draftTargets: [] } });
    }
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path: url.pathname, body });
      if (readOnly) return route.fulfill({ status: 405, json: { error: 'FIXTURE_READ_ONLY' } });
      if (url.pathname === '/api/instance/production-preparation' && body.action === 'save') {
        expect(request.headers()['if-match']).toBe('"fixture-operations"');
        expect(request.headers()['idempotency-key']).toMatch(/^management:/);
        if (body.expectedReleaseId !== preparation.releaseId || body.expectedRevisionId !== preparation.revisionId) {
          return route.fulfill({ status: 409, json: { error: '准备稿已变化，本地修改未覆盖远端' } });
        }
        // Reaching this path after externalUpdate() means the UI promoted a new
        // revision into an old edit. The test explicitly rejects that behavior.
        preparation = { ...preparation, revisionId: 'prep-overwritten', content: body.content as typeof preparation.content };
        return json({ revisionId: preparation.revisionId, formalAdoptionPerformed: false });
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 418, json: { error: 'UNEXPECTED_FIXTURE_WRITE_BLOCKED' } });
    }
    if (url.pathname === '/api/instance/profile') return json(profile);
    if (url.pathname === '/api/v8/ui/bootstrap') return json({ snapshotId: snapshot.snapshotId, data: snapshot });
    if (url.pathname === '/api/v8/operations/snapshot') return json(operations);
    // Independent episode production now reads this endpoint even with no formal
    // release. Keep the legacy browser fixture isolated from every live API.
    if (url.pathname === '/api/v8/episode-production') return json({snapshotId:snapshot.snapshotId,episode:{episodeUid:url.searchParams.get('episodeUid'),displayId:'E01'},sceneId:url.searchParams.get('sceneId'),release:null,plans:[],wholePlanAdopted:false,formalShotCount:null});
    if (url.pathname === '/api/instance/shot-production') return json({sceneId:url.searchParams.get('sceneId'),releaseId:'release-r1',readOnly,basis:null,blockers:['尚未建立正式镜头设计'],defaultContent:null,currentPlan:null,draft:null,draftHeadRevisionId:null,availableInputs:[],jobs:[],readiness:{ready:false,readyCount:0,shotCount:null,shots:[]}});
    if (url.pathname === '/api/trial/scopes') return json({scopes:[],defaultScopeId:null});
    if (url.pathname === '/api/v8/ui/materials') return json(pagePayload(url.searchParams.get('requirementId')));
    if (url.pathname === '/api/v8/ui/production') return json({ snapshotId: snapshot.snapshotId, page: { workItems: [], workPackages: [], shots: [], assetFamilies: [], assetVersions: [], expectedOutputs: [] }, count: 0, total: 0, nextCursor: null, hasMore: false });
    if (url.pathname === '/api/instance/domain-workspaces') {
      const owner = url.searchParams.get('owner') === 'MATERIAL' ? 'MATERIAL' : 'SETTINGS';
      const projected = workspaceProjection(snapshot, graph, owner);
      return json({ ...projected, ownership: { ...projected.ownership, [`states:${ids.stateA}`]: { owner: 'MATERIAL', recordHash: domainHash(graph.states[0]), reason: '状态维护已迁移到素材' } }, requirements, releaseId: 'release-r1', revisionId: 'graph-r1', readOnly, draft: null, draftHeadRevisionId: null, legacyDrafts: [] });
    }
    if (url.pathname === '/api/instance/material-directory') return json(directory);
    if (url.pathname === '/api/instance/production-preparation') { preparationReads += 1; return json(preparation); }
    if (url.pathname === '/api/instance/relations') return json({ graph, configuration: configuration.domain, revisionId: 'graph-r1', releaseId: 'release-r1', readOnly, draft: null });
    if (url.pathname === '/api/instance/documents') return json({ documents: [] });
    if (url.pathname === '/api/instance/setting-extraction') return json({ releaseId: 'release-r1', sources: [], results: [], input: null, task: null, capability: { initialize: false }, readOnly });
    if (url.pathname === '/api/instance/spatial-settings') return json({ status: 'NOT_CONFIGURED', sourceBinding: null, specification: null, scene_route_locks: [] });
    if (url.pathname === '/api/instance/configuration') return json({ configuration, defaults: configuration, releaseId: 'release-r1', revisionId: 'config-r1', sha256: H.candidate, history: [], bindings: [], boundStandards: [], reviewCatalog: {}, initialized: true, draft: null, readOnly });
    if (url.pathname === '/api/assistant/v1/conversations') return json({ conversations: [], bridge: { online: false }, pagination: {} });
    if (url.pathname === '/api/v8/reviews') return json({ events: [] });
    // Existing bootstrap fixture routes remain authoritative for unchanged shell APIs.
    for (const [key, path] of Object.entries(capture.routes)) {
      if (url.pathname === String(path).split('?')[0]) return json(capture.responses[key]);
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 418, json: { error: 'UNEXPECTED_FIXTURE_READ_BLOCKED' } });
  });
  return {
    graph, directory, requirements, writes, unexpected, pageErrors,
    get preparationReads() { return preparationReads; },
    get preparation() { return preparation; },
    externalUpdate() {
      preparation = clone(preparation);
      preparation.revisionId = 'prep-r2';
      preparation.releaseId = 'release-r2';
      preparation.content.scenes[0].preparation.visualIntent = '外部已保存的新画面意图';
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function clean(f: Fixture) {
  expect(f.unexpected, 'all API traffic must be mocked; nothing may reach a live instance').toEqual([]);
  expect(f.pageErrors).toEqual([]);
}
async function box(locator: Locator) {
  await expect(locator).toBeVisible();
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}
function near(actual: number, expected: number) { expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2); }

test('全幅关系画布：选中主体保留全图位置与宽度，不打开详情', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=settings');
  const canvas = page.getByRole('region',{name:'主体与关联关系',exact:true});
  const browse = page.locator('.settings-browse').first();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const before=await box(canvas),browseBefore=await box(browse);
  expect(browseBefore.width).toBeGreaterThan((await box(page.locator('.settings-layout'))).width*.9);
  expect(before.width).toBeGreaterThan(browseBefore.width*.9);
  for(const [id,label] of [[ids.entityA,'人物甲'],[ids.entityB,'人物乙']]){
    const node=canvas.getByRole('button',{name:label,exact:true});
    await node.click();await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(canvas.locator(`[data-canvas-node-id="${id}"]`)).toHaveAttribute('aria-pressed','true');
    await expect(canvas).toHaveClass(/is-preserved-emphasis/);await expect(node).toHaveAttribute('data-canvas-node-related','true');
    expect(new URL(page.url()).searchParams.has('settingsEntity')).toBe(false);
    const after=await box(canvas);near(after.width,before.width);near(after.x,before.x);
    near((await box(browse)).width,browseBefore.width);
    await page.getByRole('button',{name:'取消高亮',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(node).toHaveAttribute('aria-pressed','false');
    expect(new URL(page.url()).searchParams.has('settingsEntity')).toBe(false);
  }
  expect(f.writes).toEqual([]);clean(f);
});

test('原状态仅作素材属性来源：故事设定旧引用仍精确打开永久来源审计', async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/?view=settings&settingsEntity=${ids.entityA}`);
  await expect(page.getByRole('dialog').getByRole('heading',{name:'人物甲',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'关闭对象详情',exact:true}).click();
  const settingsTabs = page.getByRole('tablist', { name: '故事设定视角' });
  await expect(settingsTabs.getByRole('tab')).toHaveCount(2);
  await expect(settingsTabs.getByRole('tab', { name: '状态与连续性', exact: true })).toHaveCount(0);
  await expect(settingsTabs.getByRole('tab', { name: '关系全景', exact: true })).toHaveCount(0);
  await page.goto(`/?view=settings&settingsEntity=${ids.entityA}`);
  await page.getByRole('dialog').locator('.settings-mini-cards button').filter({ hasText: '到店之前' }).click();
  await expect(page).toHaveURL(new RegExp(`view=materials.*entity=${ids.entityA}.*materialState=${ids.stateA}`));
  const materialWorkspace = page.locator('.material-entity-workspace');
  const drawer=page.locator('dialog.material-review-drawer[open]');
  await expect(drawer.getByRole('heading',{name:'到店之前',exact:true})).toBeVisible();
  await expect(drawer.locator('.material-panel-facts')).toContainText(ids.stateA);
  await expect(materialWorkspace.locator('[data-canvas-node-id="'+ids.stateA+'"]')).toHaveCount(0);
  await expect(drawer).toContainText('历史状态／属性来源审计');
  await expect(drawer.getByRole('button', { name: '维护这项状态定义', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('region', { name: '素材定义与依赖', exact: true })).toHaveCount(0);
  await expect(drawer.locator('[data-related-material-id="'+ids.requirementA+'"]')).toHaveCount(1);
  expect(f.writes).toEqual([]); clean(f);
});

test('目录条件成为素材属性且保留永久来源，零数筛选不换绑', async ({ page }) => {
 const f=await fixture(page);expect(f.graph.states.some(state=>state.id===ids.directoryState)).toBe(false);await page.goto('/?view=materials');
 const catalog=page.locator('.material-entity-review'),workspace=catalog.locator('.material-entity-workspace'),drawer=catalog.locator('dialog.material-review-drawer');
 await expect(catalog.locator('select')).toHaveCount(0);await catalog.locator('[data-entity-id="'+ids.entityB+'"]').click();await workspace.getByRole('button',{name:'适配全图',exact:true}).click();
 await expect(workspace.locator('[data-canvas-node-id="material:'+ids.requirementB+'"]')).toHaveCount(1);await expect(workspace.locator('[data-canvas-node-id="material:'+ids.requirementA+'"]')).toHaveCount(0);
 await expect(workspace.locator('[data-canvas-node-id="'+ids.directoryState+'"]')).toHaveCount(0);await workspace.locator('[data-canvas-node-id="material:'+ids.requirementB+'"]').dblclick();await expect(drawer.locator('.material-info-card')).toHaveAttribute('data-material-info-id',ids.requirementB);await expect(drawer.getByRole('region',{name:'素材条件与属性',exact:true})).toHaveCount(0);expect(f.directory.graph.states.some(state=>state.id===ids.directoryState)).toBe(true);
 await drawer.getByRole('button',{name:'关闭详情',exact:true}).click();await page.getByRole('button',{name:'媒介：音频，0项需求',exact:true}).click();
 await expect(workspace.locator('[data-canvas-node-id^="material:"]')).toHaveCount(0);await expect(page.getByRole('button',{name:'媒介：音频，0项需求',exact:true})).toHaveAttribute('aria-pressed','true');await expect(catalog.locator('[data-entity-id="'+ids.entityB+'"]')).toHaveAttribute('aria-pressed','true');
 expect(f.writes).toEqual([]);clean(f);
});

test('唯一分类入口按集场筛选仍使用同一素材信息卡与候选 UID 精确关系', async ({ page }) => {
 const f=await fixture(page);
 f.requirements.push({...f.requirements[0],id:'MATREQ-FIXTURE-HISTORY',title:'历史素材证据，不属当前目录',requirementClass:'EVIDENCE_ONLY'});
 (f.directory.trials as Array<{trialThemeId:string;entityId:string;stateId:string;title:string;mediaType:string;displayState:string;reason:string;versions:never[]}>).push({trialThemeId:'fixture-trial',entityId:ids.entityA,stateId:ids.stateA,title:'独立试制，不是集场需求',mediaType:'IMAGE',displayState:'已通过',reason:'保留试制原身份',versions:[]});
 await page.setViewportSize({width:1440,height:1000});await page.goto('/?view=materials');
 const catalog=page.locator('.material-entity-review'),directory=catalog.locator('.material-entity-directory'),workspace=catalog.locator('.material-entity-workspace'),drawer=catalog.locator('dialog.material-review-drawer');
 await expect(catalog.locator('[data-material-facet]')).toHaveCount(5);await expect(catalog.locator('select')).toHaveCount(0);await expect(page.getByRole('button',{name:'媒介：全部媒介，2项需求',exact:true})).toBeVisible();
 await expect(directory.locator('[data-entity-id="'+ids.entityA+'"] [data-entity-total-count]')).toHaveAttribute('data-entity-total-count','1');await expect(directory.locator('[data-entity-id="'+ids.entityA+'"] .material-entity-trial-count')).toHaveText('另 1 项独立试制');await expect(catalog.locator('[data-canvas-node-id="material:MATREQ-FIXTURE-HISTORY"]')).toHaveCount(0);
 await directory.locator('[data-entity-id="'+ids.entityB+'"]').click();await workspace.getByRole('button',{name:'适配全图',exact:true}).click();await workspace.locator('[data-canvas-node-id="material:'+ids.requirementB+'"]').dblclick();
 const card=drawer.locator('.material-info-card[data-material-info-id]');await expect(drawer.getByRole('heading',{name:'人物乙夜间形象',exact:true})).toBeVisible();const cardIdentity=await card.getAttribute('data-material-info-id');await drawer.getByRole('button',{name:'关闭详情',exact:true}).click();
 await expect(page.getByRole('tablist',{name:'素材管理视角'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'剧集视角管理',exact:true})).toHaveCount(0);await expect(catalog).toHaveAttribute('data-material-view','classification');await expect(drawer).not.toBeVisible();
 await expect(catalog.locator('[data-material-facet="集"] .material-filter-chip')).toHaveCount(f.preparation.candidate.episodes.length+1);await page.getByRole('button',{name:'集：E02，1项需求',exact:true}).click();await expect(page).toHaveURL(new RegExp('materialEpisode='+ids.episodeB));await page.getByRole('button',{name:'场：S02，1项需求',exact:true}).click();await expect(page).toHaveURL(new RegExp('materialScene='+ids.sceneB));
 await expect(page.getByRole('button',{name:'场：S01，0项需求',exact:true})).toBeVisible();await expect(directory.getByRole('heading',{name:'S02 · 实体',exact:true})).toBeVisible();await expect(workspace.locator('[data-canvas-node-id^="material:"]')).toHaveCount(1);await expect(workspace.locator('[data-canvas-node-id="material:fixture-trial"]')).toHaveCount(0);
 await workspace.getByRole('button',{name:'适配全图',exact:true}).click();await workspace.locator('[data-canvas-node-id="material:'+ids.requirementB+'"]').dblclick();await expect(card).toHaveAttribute('data-material-info-id',cardIdentity!);await expect(card.locator('[data-material-section="review"]')).toHaveCount(1);await expect(card.locator('[data-material-section="production"]')).toHaveCount(1);expect(await catalog.locator('[data-material-facet="集"]').textContent()).not.toContain('原发布旧集');expect(f.writes).toEqual([]);clean(f);
});

test('只读响应下设定、素材与准备稿不暴露写按钮，也不发业务写请求', async ({ page }) => {
  const f = await fixture(page, { readOnly: true });
  await page.goto(`/?view=settings&settingsEntity=${ids.entityA}`);
  await expect(page.getByRole('dialog').getByRole('heading', { name: '人物甲', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /编辑此项|登记主体|确认本模块更新/ })).toHaveCount(0);
  await page.goto('/?view=materials');
  await page.locator('.material-entity-directory [data-entity-id="'+ids.entityA+'"]').click();
  await page.locator('.material-entity-workspace').getByRole('button',{name:'适配全图',exact:true}).click();
  await page.locator('[data-canvas-node-id="material:'+ids.requirementA+'"]').dblclick();
  await expect(page.locator('.material-info-card[data-material-info-id]')).toBeVisible();
  await expect(page.getByRole('button', { name: /维护这项状态定义|新增状态或发展条件|登记素材需求|维护选中素材的定义与参考|确认本模块更新/ })).toHaveCount(0);
  await page.goto('/?view=pipeline');
  await expect(page.getByRole('navigation', { name: '全剧制作模块', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /编辑本场准备内容|保存本场准备稿|保存准备意见/ })).toHaveCount(0);
  expect(f.writes).toEqual([]); clean(f);
});

test('准备稿编辑时外部 revision 改变，仍以原编辑基线提交并拒绝覆盖', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/?view=pipeline');
  const panel = page.getByRole('region', { name: '场景上下文的全剧制作', exact: true });
  await panel.getByRole('button', { name: '编辑本场准备内容', exact: true }).click();
  const field = panel.getByRole('textbox', { name: '画面意图', exact: true });
  await field.fill('我尚未保存的画面意图');
  const readsBefore = f.preparationReads;
  f.externalUpdate();
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/instance/production-preparation' && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('review:operations-updated')));
  await refreshed;
  await expect.poll(() => f.preparationReads).toBeGreaterThan(readsBefore);
  await expect(field).toHaveValue('我尚未保存的画面意图');
  await panel.getByRole('button', { name: '保存本场准备稿', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('准备稿已变化，本地修改未覆盖远端');
  await expect(field).toHaveValue('我尚未保存的画面意图');
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].body).toMatchObject({ action: 'save', expectedReleaseId: 'release-r1', expectedRevisionId: 'prep-r1' });
  expect(f.preparation.revisionId).toBe('prep-r2');
  expect(f.preparation.content.scenes[0].preparation.visualIntent).toBe('外部已保存的新画面意图');
  clean(f);
});

test('390px：长目录不横向溢出，点选素材后详情可达', async ({ page }) => {
 const f=await fixture(page,{extraMaterials:12});await page.setViewportSize({width:390,height:844});await page.goto('/?view=materials');
 const directory=page.locator('.material-entity-directory'),workspace=page.locator('.material-entity-workspace'),drawer=page.locator('dialog.material-review-drawer');
 await expect(directory.locator('.material-entity-directory-card')).toHaveCount(2);await expect(directory.locator('.material-entity-card')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
 await directory.locator('[data-entity-id="'+ids.entityA+'"]').click();await expect(directory).toBeVisible();await expect(workspace).toBeVisible();await expect(workspace.locator('[data-canvas-node-id^="material:"]')).toHaveCount(13);
 const leftScrollBefore=await directory.locator('.material-entity-directory-list').evaluate(element=>element.scrollTop);await workspace.getByRole('button',{name:'适配全图',exact:true}).click();const origin=workspace.locator('[data-canvas-node-id="material:'+ids.requirementA+'"]');await origin.dblclick();
 const card=drawer.locator('.material-info-card[data-material-info-id]');await expect(drawer.getByRole('heading',{name:'人物甲入店形象',exact:true})).toBeVisible();await expect(card).toBeInViewport({ratio:0.01});await expect(drawer).toContainText('人物甲入店形象');expect(await directory.locator('.material-entity-directory-list').evaluate(element=>element.scrollTop)).toBe(leftScrollBefore);
 await expect(card.locator('.material-output-zone')).toHaveCount(1);await expect(card.locator('.material-output-canvas')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);const bounds=await drawer.boundingBox();expect(bounds).toEqual({x:0,y:0,width:390,height:844});
 await drawer.getByRole('button',{name:'关闭详情',exact:true}).click();await expect(drawer).not.toBeVisible();await expect(origin).toBeFocused();await expect(directory.locator('.material-entity-directory-card')).toHaveCount(2);expect(f.writes).toEqual([]);clean(f);
});
