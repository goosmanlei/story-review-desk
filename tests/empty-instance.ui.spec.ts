import { expect, test, type Page } from '@playwright/test';
import {emptyDomainGraph,defaultDomainConfiguration} from '../host/instance-runtime/domain-model.mjs';
import { blankProfile, blankSnapshot } from '../host/instance-runtime/blank.mjs';
import { workflowOverview } from '../host/instance-runtime/workflow-overview.mjs';
import {defaultConfiguration} from '../host/instance-runtime/configuration-model.mjs';
import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition} from '../host/instance-runtime/creator-production-workflow.mjs';
import {buildEmptyActionQueueFixture} from './fixtures/empty-action-queue.mjs';

const profile = blankProfile({ title: '独立故事测试', instanceId: 'ui-fixture-instance', projectId: 'ui-fixture-story', episodePlanId: 'ui-fixture-plan' });
const snapshot = blankSnapshot(profile).snapshot;
const configuration=defaultConfiguration(profile);
const sourceSha = (id: string) => (id === 'A' ? 'a' : 'b').repeat(64);
const sources = ['A', 'B'].map(id => ({ id: `registered-source-${id}`, documentId: `source-${id}`, documentRevisionId: `revision-${id}`, documentSha256: sourceSha(id), title: `来源 ${id}`, role: 'DERIVED', format: 'TXT', observation: 'DERIVED_UNVERIFIED', textAvailable: true, rightsStatus: 'UNKNOWN' }));
const sourceBody = (id: string) => ({ documentId: `source-${id}`, revisionId: `revision-${id}`, sha256: sourceSha(id), focusId: `source-focus-${id}`, title: `来源 ${id}`, text: `来源 ${id} 的完整正文`, truncated: false });
let unexpected: string[];

// All API traffic is fulfilled inside this browser fixture. No business database,
// settings write, model request or production-instance endpoint is contacted.
async function mockDesk(page: Page, landingView = 'story') {
  const queue=await buildEmptyActionQueueFixture(snapshot);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/instance/profile') return route.fulfill({ json: { ...profile, capabilities: { ...profile.capabilities, landingView } } });
    if (url.pathname === '/api/v8/ui/bootstrap') return route.fulfill({ json: { snapshotId: snapshot.snapshotId, data: snapshot } });
    if(url.pathname==='/api/instance/sources')return route.fulfill({json:{releaseId:'empty',sources:[],readOnly:false}});
    if(url.pathname==='/api/instance/material-directory')return route.fulfill({json:{releaseId:'empty',revisionId:null,graph:emptyDomainGraph(),bindings:[],trials:[],staleIds:[],readOnly:false}});
    if(url.pathname==='/api/instance/production-preparation')return route.fulfill({json:{releaseId:'empty',revisionId:null,content:null,candidate:null,comments:[],materialLinks:null,materialLinksStale:false,stale:false,readOnly:false,formalAdoptionPerformed:false,denominatorState:'UNKNOWN'}});
    if(url.pathname==='/api/instance/workflow'){const workflow=workflowOverview(snapshot.productionModel,null,{queue,snapshotId:snapshot.snapshotId});return route.fulfill({json:url.searchParams.get('workspace')==='1'?{queue,workflow}:workflow});}
    if(url.pathname==='/api/v8/action-queue')return route.fulfill({json:queue});
    if(url.pathname==='/api/instance/configuration')return route.fulfill({json:{configuration,defaults:configuration,releaseId:'empty',revisionId:null,sha256:null,history:[],bindings:[],boundStandards:[],reviewCatalog:{},initialized:false,draft:null,readOnly:false}});
    if(url.pathname==='/api/instance/authoring')return route.fulfill({json:{releaseId:'empty',roots:[],initializationReady:false}});
    if(url.pathname==='/api/instance/domain-workspaces')return route.fulfill({json:{snapshotId:snapshot.snapshotId,releaseId:'empty',revisionId:null,graph:emptyDomainGraph(),ownership:{},configuration:defaultDomainConfiguration(),requirements:[],spatial:null,draft:null,draftHeadRevisionId:null,legacyDrafts:[],readOnly:false}});
    if (url.pathname === '/api/instance/documents') return route.fulfill({ json: { documents: [] } });
    if (url.pathname === '/api/assistant/v1/conversations' && request.method() === 'GET') return route.fulfill({ json: { conversations: [], bridge: { online: false }, pagination: {} } });
    if (url.pathname === '/api/assistant/v1/context' && request.method() === 'POST') {
      const { focus } = request.postDataJSON();
      return route.fulfill({ json: { context: { focus, resources: [], missing: [], draftTargets: [] } } });
    }
    if (url.pathname === '/api/trial/scopes') return route.fulfill({ json: { scopes: [], defaultScopeId: null } });
    if (url.pathname === '/api/trial/snapshot') return route.fulfill({ status: 503, json: { error: 'TRIAL_NOT_IMPORTED', message: '本实例尚未导入试制范围。' } });
    if (url.pathname.startsWith('/api/trial/media/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64') });
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 418, json: { error: 'UNEXPECTED_FIXTURE_REQUEST_BLOCKED' } });
  });
  return queue;
}
async function focusTitle(page: Page, title: string) {
  await page.getByRole('button', { name: '项目 Codex', exact: true }).click();
  await expect(page.getByRole('region', { name: '本轮工作上下文' })).toContainText(title);
  await page.getByRole('button', { name: '收起项目 Codex' }).click();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
test.beforeEach(() => { unexpected = []; });
test.afterEach(() => { expect(unexpected, 'fixture API requests must not reach a live instance').toEqual([]); });

test('URL view overrides the configured default and back to the root restores it without duplicate entries', async ({ page }) => {
  await mockDesk(page, 'story');
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await expect(page.getByRole('heading', { name: '从来源核对、结构理解到分集与逐场成稿', exact: true })).toBeVisible();
  const initialHistory = await page.evaluate(() => history.length);
  await navigation.getByRole('button', { name: '故事创作', exact: true }).click();
  expect(await page.evaluate(() => history.length)).toBe(initialHistory);
  await navigation.getByRole('button', { name: '素材管理' }).click();
  await navigation.getByRole('button', { name: '素材管理' }).click();
  expect(await page.evaluate(() => history.length)).toBe(initialHistory + 1);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(page.getByRole('heading', { name: '从来源核对、结构理解到分集与逐场成稿', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '素材管理', exact: true })).toBeVisible();
  await page.goto('/?view=pipeline');
  await expect(page.getByRole('heading', { name: '从拆镜表达，到整集成片', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation',{name:'全剧制作四阶段',exact:true}).getByRole('button')).toHaveCount(4);
  await page.goto('/?view=not-a-view');
  await expect(page.getByRole('heading', { name: '从来源核对、结构理解到分集与逐场成稿', exact: true })).toBeVisible();
});

test('empty stories preserve the original desk shell, palette, navigation and workspace tabs', async ({ page }) => {
  const queue=await mockDesk(page, 'overview');
  await page.goto('/');
  await expect(page.locator('.review-shell.empty-desk')).toBeVisible();
  await expect(page.locator('.empty-instance-layout')).toHaveCount(0);
  await expect(page.locator('.workspace-sidebar')).toHaveCSS('background-color', 'rgb(23, 25, 21)');
  await expect(page.locator('.workspace-main')).toHaveCSS('overflow-y', 'auto');
  await expect(page.locator('.workspace-nav > button')).toHaveCount(6);
  expect(queue.items).toEqual([]);expect(queue.recommendations.mainline).toBeNull();
  expect(queue.workspaceSummary.domains.map((domain:{status:string})=>domain.status)).toEqual(['WAITING','WAITING','UNKNOWN']);
  const chains=page.getByRole('navigation',{name:'三条主体工作链',exact:true});
  await expect(chains.getByRole('button')).toHaveCount(3);
  for(const domain of queue.workspaceSummary.domains){
    const chain=chains.getByRole('button').filter({has:page.getByText(domain.label,{exact:true})});
    await chain.click();await expect(chain).toHaveAttribute('aria-pressed','true');
    await expect(chain).toContainText('0 项可推进 · 0 项等待或阻断');
    await expect(chain).toContainText(domain.status==='UNKNOWN'?'范围未锁定':'等待上游');
    await expect(page.getByRole('navigation',{name:domain.label+'阶段选择',exact:true})).toBeVisible();
    await expect(page.locator('.workflow-work-center .free-canvas')).toHaveCount(0);
    const stages=page.getByRole('navigation',{name:domain.label+'阶段选择',exact:true});
    await expect(stages.getByRole('button')).toHaveCount(domain.stages.length);
    for(const stage of domain.stages){
      const button=stages.getByRole('button').filter({has:page.getByText(stage.label,{exact:true})});
      await button.click();await expect(button).toHaveAttribute('aria-pressed','true');
      if(domain.id!=='WORLD_AND_MATERIALS'){
        expect(stage.denominatorState).toBe('UNKNOWN');expect(stage.denominator).toBeNull();
        await expect(page.locator('.workflow-stage-inspector')).toContainText('正式分母未锁定');
        await expect(page.locator('.workflow-empty')).toContainText('不代表已经完成');
      }else{
        // The empty requirement inventory is a known zero, not a completed workflow.
        expect(stage.denominatorState).toBe('KNOWN');expect(stage.denominator).toBe(0);
        await expect(page.locator('.workflow-stage-inspector')).toContainText('0 / 0');
      }
      await expect(page.locator('.workflow-stage-inspector')).not.toContainText('已完成');
    }
  }
  await expect(page.locator('.workflow-preparation-task')).toHaveCount(0);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '故事创作', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '故事创作方式' }).getByRole('tab')).toHaveText(['来源资料','故事结构','叙事拆解']);
  await page.getByRole('tab', { name: '叙事拆解', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: '叙事拆解', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '素材管理', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '素材管理视角' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '剧集视角管理', exact: true })).toHaveCount(0);
  await expect(page.locator('.material-entity-review')).toHaveAttribute('data-material-view','classification');
  await expect(page.locator('.material-entity-review [data-canvas-node-id]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '素材管理', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '全剧制作', exact: true }).click();
  const production=page.getByRole('region',{name:'场景上下文的全剧制作',exact:true});
  const stages=production.getByRole('navigation',{name:'全剧制作四阶段',exact:true});
  await expect(stages.getByRole('button')).toHaveCount(4);
  await expect(stages.locator('button strong')).toHaveText(['镜头拆解','镜头生成','场景剪辑','分集成片']);
  const episodes=production.getByRole('navigation',{name:'制作上下文分集',exact:true});
  await expect(episodes.getByRole('button')).toHaveCount(0);
  await expect(episodes).toContainText('尚未建立候选分集。正式制作范围仍待确定。');
  await expect(production).toContainText('尚未登记制作准备稿');
  // Creator navigation groups, but does not replace, the 15 canonical checks.
  // An empty instance has no invented episode/scene or adopted production scope.
  const checkedGates=new Set<string>();
  for(const stage of CREATOR_PRODUCTION_STAGES){
    const stageButton=stages.locator(`[data-creator-stage="${stage.id}"]`);
    await stageButton.click();await expect(stageButton).toHaveAttribute('aria-pressed','true');
    const sceneDirectory=production.getByRole('navigation',{name:'制作上下文场次',exact:true});
    if(stage.scope==='SCENE'){
      await expect(sceneDirectory).toHaveCount(1);await expect(sceneDirectory.getByRole('button')).toHaveCount(0);
      const directorySurface=production.locator('.preparation-scene-directory');
      await expect(directorySurface).toBeVisible();
      await expect(directorySurface.getByText('此集尚无可定位的场准备。',{exact:true})).toBeVisible();
      await expect(production.locator('.preparation-stage-layout')).not.toHaveClass(/is-episode/);
    }else{
      await expect(sceneDirectory).toHaveCount(0);
      await expect(production.locator('.preparation-stage-layout')).toHaveClass(/is-episode/);
    }
    const expected=configuration.workflow.gates.filter(gate=>stage.gateIds.includes(gate.id));
    expect(expected.map(gate=>gate.id).sort()).toEqual([...stage.gateIds].sort());
    await expect(production.locator('[data-production-check]')).toHaveCount(expected.length);
    // Only this stage's checks exist, and each group stays behind a disclosure.
    const checkGroups=production.locator('details.preparation-stage-checks');
    await expect(checkGroups).toHaveCount(stage.exportGateIds.length?2:1);
    for(const group of await checkGroups.all()){
      if(await group.getAttribute('open')!==null)await group.locator('summary').click();
      await expect(group).not.toHaveAttribute('open','');
      await expect(group.locator('[data-production-check]:visible')).toHaveCount(0);
      await group.locator('summary').click();
      for(const button of await group.locator('[data-production-check]').all()){
        const gateId=await button.getAttribute('data-production-check');
        const gate=expected.find(item=>item.id===gateId);
        expect(gate,`configured check ${gateId}`).toBeDefined();
        const canonical=creatorProductionGateDefinition(gate!.id);
        expect(canonical).not.toBeNull();
        await expect(button.locator('strong')).toHaveText(gate!.label);
        await button.click();await expect(button).toHaveAttribute('aria-pressed','true');
        await expect(production.getByRole('heading',{name:'本上下文尚未建立正式制作对象',exact:true})).toBeVisible();
        const empty=production.locator('.workflow-empty').filter({hasText:'准备稿不解锁制作'});
        await expect(empty).toBeVisible();await expect(empty).toContainText('正式范围与进度：待确定（UNKNOWN）');
        await expect(empty.locator('small')).toHaveText('正式范围与进度：待确定（UNKNOWN）');
        await expect(production.locator('[data-creator-scope]')).toHaveAttribute('data-creator-scope',canonical!.scopeType==='PROJECT'?'PROJECT':stage.scope);
        const params=new URL(page.url()).searchParams;
        expect(params.get('creatorStage')).toBe(stage.id.toLowerCase().replaceAll('_','-'));
        expect(params.get('productionGate')).toBe(gate!.id.toLowerCase().replaceAll('_','-'));
        expect(params.get('productionPhase')).toBe(canonical!.phaseId.toLowerCase().replaceAll('_','-'));
        for(const key of ['episode','scene','preparationEpisode','preparationScene'])expect(params.has(key)).toBe(false);
        if(canonical!.scopeType==='PROJECT')await expect(group).toContainText('这些检查覆盖全剧，不作为所选分集的通过或采用。');
        checkedGates.add(gate!.id);
      }
    }
    await expect(episodes.getByRole('button')).toHaveCount(0);
    await expect(production.locator('.preparation-authoring-basis')).toHaveCount(0);
    await expect(production.getByRole('button',{name:/^(编辑本场准备内容|保存本场准备稿|保存准备意见)$/})).toHaveCount(0);
  }
  expect([...checkedGates].sort()).toEqual(configuration.workflow.gates.map(gate=>gate.id).sort());
  expect(checkedGates.size).toBe(15);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('.mobile-nav > button')).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('source loading and failure remain distinct from empty data, with retry for the directory and body', async ({ page }) => {
  await mockDesk(page);
  const listGate = deferred();
  let listReads = 0, bodyReads = 0;
  await page.route('**/api/instance/sources', async route => {
    listReads += 1;
    if (listReads === 1) { await listGate.promise; return route.fulfill({ status: 503, json: { error: '来源目录暂时无法读取。' } }); }
    return route.fulfill({ json: { sources, readOnly:false } });
  });
  await page.route('**/api/instance/documents*', async route => {
    if (!new URL(route.request().url()).searchParams.has('id')) return route.fulfill({ json:{documents:[]} });
    bodyReads += 1;
    return route.fulfill(bodyReads === 1 ? { status:503,json:{error:'来源正文暂时无法读取'} } : { json:sourceBody('A') });
  });
  await page.goto('/?view=story');
  await expect(page.getByRole('status')).toHaveText('正在读取来源目录…');
  await expect(page.getByText('尚未导入来源。使用左侧“补充来源”登记最初的故事资料。', { exact: true })).toHaveCount(0);
  listGate.resolve();
  await expect(page.getByRole('alert')).toHaveText('来源目录暂时无法读取。');
  await expect(page.getByText('尚未导入来源。使用左侧“补充来源”登记最初的故事资料。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重新读取资料',exact:true }).click();
  await page.getByRole('button', { name: /^来源 A(?:\s|$)/ }).click();
  await expect(page.getByRole('alert')).toHaveText('来源正文暂时无法读取');
  await page.getByRole('button', { name: '重新读取资料',exact:true }).click();
  await expect(page.locator('.story-source-reader .empty-source-text')).toContainText(sourceBody('A').text);
  await focusTitle(page, '来源 A');
  await page.getByRole('button',{name:'＋ 补充来源',exact:true}).click();
  await expect(page.locator('.story-source-reader .empty-source-text')).toHaveCount(0);
  await focusTitle(page, '独立故事测试');
  await page.getByRole('button',{name:'返回阅读',exact:true}).click();
  await expect(page.locator('.story-source-reader .empty-source-text')).toContainText(sourceBody('A').text);
  await focusTitle(page, '来源 A');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '素材管理' }).click();
  await focusTitle(page, '独立故事测试');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '故事创作' }).click();
  await expect(page.locator('.story-source-reader .empty-source-text')).toHaveCount(0);
});

test('late source responses cannot replace a newer selection or reopen a body after leaving story', async ({ page }) => {
  await mockDesk(page);
  const first = deferred(), second = deferred();
  let requested = 0;
  await page.route('**/api/instance/sources', route=>route.fulfill({json:{sources,readOnly:false}}));
  await page.route('**/api/instance/documents*', async route => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (!id) return route.fulfill({ json: { documents: [] } });
    if (id === 'source-A') { requested += 1; await (requested === 1 ? first.promise : second.promise); }
    try { await route.fulfill({ json: sourceBody(id.slice(-1)) }); } catch { /* A cancelled fetch may close its route. */ }
  });
  await page.goto('/?view=story');
  await page.getByRole('button', { name: /^来源 A(?:\s|$)/ }).click();
  await expect.poll(() => requested).toBe(1);
  await page.getByRole('button', { name: /^来源 B(?:\s|$)/ }).click();
  await expect(page.locator('.story-source-reader .empty-source-text')).toContainText(sourceBody('B').text);
  first.resolve();
  await focusTitle(page, '来源 B');
  await expect(page.getByText(sourceBody('A').text, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^来源 A(?:\s|$)/ }).click();
  await expect.poll(() => requested).toBe(2);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '全剧制作' }).click();
  second.resolve();
  await focusTitle(page, '独立故事测试');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '故事创作' }).click();
  await expect(page.locator('.story-source-reader .empty-source-text')).toHaveCount(0);
});

test('trial not imported is a normal empty state across all trial views while connection failures retain retry', async ({ page }) => {
  await mockDesk(page);
  for (const view of ['story', 'materials', 'pipeline']) {
    await page.goto(`/trial?view=${view}`);
    await expect(page.getByRole('heading', { name: '尚未设置试制范围' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/TRIAL_NOT_IMPORTED|两集选段|第一检查点已确认/)).toHaveCount(0);
  }
  let failed = true;
  await page.route('**/api/trial/scopes', route => route.fulfill(failed ? { status: 503, json: { message: '试制资料暂时无法读取' } } : { json: { scopes: [], defaultScopeId: null } }));
  await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(page.getByRole('alert')).toContainText('试制资料暂时无法读取');
  await expect(page.getByRole('heading', { name: '尚未设置试制范围' })).toHaveCount(0);
  failed = false;
  await page.getByRole('button', { name: '重新读取试制资料' }).click();
  await expect(page.getByRole('heading', { name: '尚未设置试制范围' })).toBeVisible();
});

const trialFixture = () => ({
  mode: 'LOCAL_TRIAL', mutationEtag: '"ui-trial-fixture"',
  scope: { id: 'fixture-scope', title: '独立试制测试', projectTitle: profile.title, countsTowardFormalProject: false },
  checkpoint: {}, budgets: [], executions: [],
  recipes: [{ id: 'recipe-fixture', subjectId: 'material-fixture', label: '测试道具', model: 'FIXTURE' }],
  assets: [{ id: 'asset-fixture', mediaId: 'material-fixture', versionId: 'version-fixture', sha256: 'a'.repeat(64), version: 1, mediaKind: 'IMAGE', mediaUrl: '/api/trial/media/fixture', title: '测试道具', lifecycle: 'REVIEW_PENDING', metadata: { RIGHTS_STATUS: 'UNKNOWN' }, prompt: '独立测试 Prompt', qa: {}, reviewCriteria: [{ id: 'intent', label: '用途判断', description: '核对实际用途。' }] }],
  story: { episodes: [{ episodeUid: 'episode-fixture', displayLabel: '试制选段', title: '测试选段', goal: '测试目标', audienceKnowsAtEnd: '测试所得', endingHook: '测试结尾', sourceSceneId: 'scene-fixture' }], sourceScenes: [], dialogue: [], shotProposals: [1, 2, 3].map(id => ({ id: `shot-${id}`, episodeUid: 'episode-fixture', displayLabel: `提案 ${id}`, title: '测试镜头', visualIntent: '测试画面', continuityIntent: '测试衔接', audienceGain: '测试信息', proposedDurationSeconds: 4 })) },
});

test('trial counts and review state come from the selected instance and missing usage stays explicit', async ({ page }) => {
  await mockDesk(page);
  await page.route('**/api/trial/scopes', route => route.fulfill({ json: { scopes: [trialFixture().scope], defaultScopeId: trialFixture().scope.id } }));
  await page.route('**/api/trial/snapshot*', route => route.fulfill({ json: trialFixture() }));
  await page.goto('/trial?view=story');
  await expect(page.locator('.trial-scope-note')).toContainText('已登记 1 个分集选段 · 3 项镜头提案 · 1 项素材配方');
  await expect(page.locator('.trial-shot')).toHaveCount(3);
  await expect(page.getByText(/第一检查点已确认|两个选段集|十镜方案已确认|两集选段/)).toHaveCount(0);
  await page.goto('/trial?view=materials');
  await expect(page.locator('.trial-usage')).toContainText('缺项：当前试制资料没有登记这项素材的用途与使用依据。');
  await expect(page.locator('.trial-version .trial-status')).toHaveText('待你审阅');
  await expect(page.getByRole('radio', { name: '符合', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '通过并放行', exact: true })).toBeDisabled();
  await expect(page.getByText(/堂屋空间|技术预检已完成/)).toHaveCount(0);
  await page.goto('/trial?view=pipeline');
  await expect(page.getByRole('heading', { name: '从素材进入试制成片' })).toBeVisible();
  await expect(page.locator('.trial-production > section p span')).toHaveText(Array(15).fill('进度未登记'));
});
