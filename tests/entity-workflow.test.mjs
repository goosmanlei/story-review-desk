/**
 * Entity/workflow refactor safety contracts.
 * Run from project root with Node >= 22.18:
 *   node --test output/implementation/entity-workflow-20260907/regression-contracts.test.mjs
 * Pure functions + in-memory repository only. No network, DB, service or media writes.
 * Failures are product-contract regressions, not an assertion that deployment passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  materialCreatorStageOptions,
  projectMaterialCreatorStage,
} from '../app/material-taxonomy.ts';
import {
  readProductionPreparation,
  saveProductionPreparation,
  commentProductionPreparation,
} from '../host/instance-runtime/production-preparation.mjs';
import { workflowOverview } from '../host/instance-runtime/workflow-overview.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const clone = (value) => structuredClone(value);

function fixture() {
  const episodes = [
    { episodeUid: 'episode-permanent-a', displayId: 'E01', title: '第一集', sceneIds: ['scene-permanent-a'] },
    { episodeUid: 'episode-permanent-b', displayId: 'E02', title: '第二集', sceneIds: ['scene-permanent-b'] },
  ];
  const scenes = episodes.map((ep, i) => ({
    id: ep.sceneIds[0], displayId: `S0${i + 1}`, title: `第${i + 1}场`,
    episodeUid: ep.episodeUid, contentHash: hash(`candidate-scene-${i}`),
  }));
  const candidate = {
    subjectKind: 'EPISODE_PLAN', subjectId: 'plan-a', creativeRevisionId: 'candidate-a',
    contentHash: hash('candidate-a'), eventSequence: 1, recordedAt: '2026-09-07T00:00:00Z',
    content: { episodes, narrativeRevision: { scenes } },
  };
  const view = {
    releaseId: 'release-a', profile: { episodePlanId: 'plan-a' },
    snapshot: { instance: { episodePlanId: 'plan-a' }, productionModel: {} },
    eventsByKind: { 'creative-revision': [candidate] },
  };
  const aux = new Map();
  let sequence = 0;
  const tx = {
    readView: async () => clone(view),
    getAux: async (namespace, key) => aux.get(`${namespace}/${key}`) || null,
    listAux: async (namespace) => [...aux.entries()].filter(([key]) => key.startsWith(`${namespace}/`)).map(([, value]) => value),
    putAux: async ({ namespace, key, bytes, expectedRevisionId }) => {
      const address = `${namespace}/${key}`;
      assert.equal(aux.get(address)?.revisionId || null, expectedRevisionId, 'in-memory CAS must hold');
      const data = Buffer.from(bytes);
      const record = { namespace, key, bytes: data, revisionId: `aux-${++sequence}`, sha256: hash(data) };
      aux.set(address, record);
      return record;
    },
  };
  const content = {
    basis: { candidateRevisionId: candidate.creativeRevisionId, candidateContentHash: candidate.contentHash },
    episodes: clone(episodes),
    scenes: scenes.map((scene) => ({
      sceneId: scene.id, displayId: scene.displayId, episodeUid: scene.episodeUid,
      sceneContentHash: scene.contentHash, sourceSummary: { title: scene.title },
      preparation: { visualIntent: 'UNKNOWN', materialGaps: ['依赖待核'] },
    })),
  };
  const input = { requestId: 'request-a', expectedReleaseId: 'release-a', expectedRevisionId: null, content };
  return { tx, aux, view, candidate, content, input };
}

test('素材筛选只呈现四个逻辑状态', () => {
  assert.deepEqual(materialCreatorStageOptions.map(({ label }) => label), ['已定义', '待生成', '待审阅', '已通过']);
});

test('素材四态基础映射和未知兜底', () => {
  for (const [lifecycleState, expected] of Object.entries({
    WAITING_UPSTREAM: 'INITIAL', READY_TO_START: 'PRODUCTION_READY', REVIEW_PENDING: 'PENDING_REVIEW',
    RELEASED: 'APPROVED', REVISION_REQUIRED: 'INITIAL', DO_NOT_USE: 'INITIAL', UNKNOWN: 'INITIAL',
  })) assert.equal(projectMaterialCreatorStage({ lifecycleState }).creatorStage, expected, lifecycleState);
});

test('旧通过版本不满足当前需求时不能呈现已通过', () => {
  for (const flags of [{ coverageSatisfied: false }, { bindingStale: true }]) {
    assert.equal(projectMaterialCreatorStage({ lifecycleState: 'RELEASED', ...flags }).creatorStage, 'INITIAL');
  }
});

test('结果未知优先于历史 CLAIMED，不能伪装为可直接生成', () => {
  const projection = projectMaterialCreatorStage({ lifecycleState: 'RESULT_UNKNOWN', executionRequestState: 'CLAIMED' });
  assert.equal(projection.creatorStage, 'INITIAL');
  assert.match([projection.creatorStageDetail, projection.creatorStageNextStep].join(' '), /核查|核对|禁止.*重试/);
});

test('权利阻断优先于历史 AUTHORIZED', () => {
  assert.equal(projectMaterialCreatorStage({
    lifecycleState: 'RIGHTS_HOLD', executionRequestState: 'AUTHORIZED', flowBlockReasons: ['CURRENT_RIGHTS_BLOCKED'],
  }).creatorStage, 'INITIAL');
});

test('存在缺失执行定义的显式证据时不能标待生成', () => {
  assert.equal(projectMaterialCreatorStage({
    lifecycleState: 'READY_TO_START', executionBlockReasons: ['EXECUTION_DEFINITION_MISSING'],
  }).creatorStage, 'INITIAL');
});

test('工作流程深链使用页面实际接受的 view/storyMode', () => {
  const data = workflowOverview({ productionPhases: [{ id: 'PHASE_A', label: '镜头方案与预演' }] }, null);
  const allowed = new Set(['today', 'story', 'settings', 'materials', 'pipeline', 'system']);
  for (const node of data.nodes) {
    const url = new URL(node.href, 'http://localhost');
    assert.ok(allowed.has(url.searchParams.get('view')), node.href);
    assert.equal(url.searchParams.has('storyView'), false, node.href);
    if (node.id === 'PREPARATION' || node.id === 'PHASE_A') assert.equal(url.searchParams.get('view'), 'pipeline');
  }
  assert.equal(data.denominatorState, 'UNKNOWN');
});

test('准备稿保存仅写辅助稿，不形成正式采用或事件', async () => {
  // Preparation remains separate from the formal scope projection.
  const f = fixture();
  const beforeEvents = clone(f.view.eventsByKind);
  const result = await saveProductionPreparation(f.tx, f.input);
  assert.equal(result.formalAdoptionPerformed, false);
  assert.deepEqual(f.view.eventsByKind, beforeEvents);
  assert.deepEqual([...f.aux.keys()].map((key) => key.split('/')[0]).sort(), ['production-preparation', 'production-preparation-requests']);
  const state = await readProductionPreparation(f.tx);
  assert.equal(state.content.scenes[0].preparation.visualIntent, 'UNKNOWN');
  assert.equal(state.denominatorState, 'UNKNOWN');
});

test('工作流拓扑不由CURRENT镜头或未经有效投影的裸ScopeLock推断正式分母', () => {
  // Formal scope is not inferred from discovered objects.
  for (const model of [
    { shots: [{ id: 'shot-a', scopeRole: 'CURRENT', activeInCurrentProduction: true }] },
    { shots: [{ id: 'shot-a', scopeRole: 'EVIDENCE_ONLY' }] },
    { shots: [{ id: 'shot-a', scopeRole: 'CURRENT' }], scopeLocks: [{ id: 'raw-lock', scopeType: 'PROJECT', scopeId: 'project-a', lockState: 'LOCKED', denominatorState: 'KNOWN', denominator: 1 }] },
  ]) assert.equal(workflowOverview(model, null).denominatorState, 'UNKNOWN');
});

test('工作流四阶段深链同时绑定creatorStage与精确默认门禁，不保留旧phase节点', () => {
  const expected = [
    ['SHOT_BREAKDOWN', 'PREVIS', 'SHOT_PLAN_INPUT_LOCK'],
    ['SHOT_GENERATION', 'PREVIS', 'STORYBOARD_DIALOGUE'],
    ['SCENE_EDIT', 'SCENE_FINISH', 'PICTURE_LOCK'],
    ['EPISODE_EDIT', 'EPISODE_FINISH', 'EPISODE_ASSEMBLY'],
  ];
  const canonicalIds = ['PREVIS', 'SHOT_FINISH', 'SCENE_FINISH', 'EPISODE_FINISH', 'SERIES_DELIVERY'];
  const model = { productionPhases: canonicalIds.map(id => ({ id, label: id })) };
  const before = JSON.stringify(model), result = workflowOverview(model, null);
  assert.deepEqual(result.nodes.filter(node => node.group === '全剧制作').map(node => node.id), expected.map(([id]) => id));
  for (const [id, phaseId, gateId] of expected) {
    const url = new URL(result.nodes.find(node => node.id === id).href, 'http://localhost');
    assert.equal(url.searchParams.get('view'), 'pipeline');
    assert.equal(url.searchParams.get('creatorStage'), id.toLowerCase().replaceAll('_', '-'));
    assert.equal(url.searchParams.get('productionPhase'), phaseId.toLowerCase().replaceAll('_', '-'));
    assert.equal(url.searchParams.get('productionGate'), gateId.toLowerCase().replaceAll('_', '-'));
    assert.equal(url.searchParams.has('phase'), false);
  }
  assert.ok(canonicalIds.every(id => !result.nodes.some(node => node.id === id)));
  assert.equal(result.nodes.some(node => node.id === 'PREPARATION'), false);
  assert.equal(JSON.stringify(model), before);
  assert.equal(result.definition.phases, model.productionPhases);
});

test('候选准备稿与原采用结构分别解释，不以历史采用记录或旧草稿冒充当前通过', () => {
  const content = { scenes: [{ sceneId: 'scene-a' }, { sceneId: 'scene-b' }] };
  const preparation = { revisionId: 'prep-a', candidate: { revisionId: 'candidate-a' }, content, stale: true };
  const model = { episodePlanRevisions: [{ isCurrent: false, scopeRole: 'EVIDENCE_ONLY' }] };
  const result = workflowOverview(model, preparation);
  assert.match(result.nodes.find(node => node.id === 'STORY').detail, /候选待审阅与受控采用/);
  assert.equal(result.preparationWork.status, 'BLOCKED');
  assert.deepEqual(result.preparationWork.capabilities, []);
  assert.match(result.preparationWork.reason, /原稿保留，不自动换绑/);
  assert.equal(result.preparationWork.sceneCount, 2);
  assert.equal(result.denominatorState, 'UNKNOWN');
});

test('准备稿旧 release/revision 提交失败关闭', async () => {
  for (const invalid of [{ expectedReleaseId: 'old-release' }, { expectedRevisionId: 'old-revision' }]) {
    const f = fixture();
    await assert.rejects(saveProductionPreparation(f.tx, { ...f.input, ...invalid }), { code: 'DOMAIN_CONFLICT' });
    assert.equal(f.aux.size, 0);
  }
});

test('准备稿保存请求可幂等回读，但相同 requestId 不可换内容', async () => {
  const f = fixture();
  const first = await saveProductionPreparation(f.tx, f.input);
  assert.deepEqual(await saveProductionPreparation(f.tx, f.input), first);
  const changed = clone(f.input);
  changed.content.scenes[0].preparation.visualIntent = '另一版';
  await assert.rejects(saveProductionPreparation(f.tx, changed), { code: 'DOMAIN_CONFLICT' });
});

test('准备稿必须精确覆盖当前候选身份与每场哈希，不能沿用旧场号', async () => {
  for (const mutate of [
    (content) => content.scenes.pop(),
    (content) => { content.scenes[1] = clone(content.scenes[0]); },
    (content) => { content.scenes[0].sceneId = 'S01'; },
    (content) => { content.scenes[0].sceneContentHash = hash('old-scene'); },
  ]) {
    const f = fixture(); mutate(f.content);
    await assert.rejects(saveProductionPreparation(f.tx, f.input), { code: 'DOMAIN_INVALID' });
    assert.equal(f.aux.size, 0);
  }
});

test('准备稿场不能换绑到另一个集 UID', async () => {
  const f = fixture();
  f.content.scenes[0].episodeUid = f.content.scenes[1].episodeUid;
  await assert.rejects(saveProductionPreparation(f.tx, f.input), { code: 'DOMAIN_INVALID' });
});

test('准备稿逐场准备内容须为字段对象而不是数组', async () => {
  const f = fixture(); f.content.scenes[0].preparation = [];
  await assert.rejects(saveProductionPreparation(f.tx, f.input), { code: 'DOMAIN_INVALID' });
});

test('候选依据改变后原准备稿保持不变且意见提交失败关闭', async () => {
  const f = fixture();
  await saveProductionPreparation(f.tx, f.input);
  const before = await readProductionPreparation(f.tx);
  const changedCandidate = clone(f.candidate);
  changedCandidate.creativeRevisionId = 'candidate-b'; changedCandidate.contentHash = hash('candidate-b'); changedCandidate.eventSequence = 2;
  f.view.eventsByKind['creative-revision'].push(changedCandidate);
  const after = await readProductionPreparation(f.tx);
  assert.equal(after.stale, true);
  assert.deepEqual(after.content, before.content);
  await assert.rejects(commentProductionPreparation(f.tx, {
    requestId: 'comment-a', expectedReleaseId: after.releaseId, expectedRevisionId: after.revisionId,
    sceneId: after.content.scenes[0].sceneId, text: '不得绑定到新版',
  }), { code: 'DOMAIN_CONFLICT' });
});
