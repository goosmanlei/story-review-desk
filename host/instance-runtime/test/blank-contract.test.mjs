import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { blankProfile, blankSnapshot } from '../blank.mjs';
import { createInstanceRepository } from '../index.mjs';
import { blankProductionGraph, isLegacyBlankSnapshot, normalizeEmptyProductionFilters, normalizeReviewSnapshot } from '../snapshot-contract.mjs';
import { defaultConfiguration, projectConfiguration } from '../configuration-model.mjs';

const phaseIds = ['PREVIS','SHOT_FINISH','SCENE_FINISH','EPISODE_FINISH','SERIES_DELIVERY'];
function legacySnapshot() {
  const { snapshot, recipes } = blankSnapshot(blankProfile());
  const labels = [
    ['镜头方案与预演', ['镜头设计与输入锁定','粗分镜与对白并行','Animatic锁时']],
    ['镜头成品', ['正式首尾帧','镜头视频','单镜锁定']],
    ['场景成片', ['场剪辑与画面锁定','场声音与混音字幕','场级QA']],
    ['分集成片', ['分集组装','分集审阅','分集技术QC']],
    ['全剧交付', ['跨集连续性','权利敏感技术终检','交付归档']],
  ];
  snapshot.productionModel.productionPhases = labels.map(([label, gates], index) => {
    const number = String(index + 1).padStart(2, '0');
    return { id: `phase-${number}`, label, title: label, gates: gates.map((label, gateIndex) => ({ id: `gate-${number}-${gateIndex + 1}`, label })) };
  });
  snapshot.productionModel.productionGates = snapshot.productionModel.productionPhases.flatMap((phase) => phase.gates);
  snapshot.creativeLineage.storyStructure = {};
  snapshot.creativeLineage.spatialEvidence = [];
  return { snapshot, recipes };
}

function configuredLegacySnapshot() {
  const { snapshot } = legacySnapshot();
  const config = defaultConfiguration();
  const reference = { revisionId: 'irv_blank_configuration', sha256: 'a'.repeat(64) };
  snapshot.instance.configurationRef = reference;
  snapshot.productionModel.instance = snapshot.instance;
  snapshot.productionModel.configurationCandidates = [];
  snapshot.productionModel.systemConfiguration = { reference, config, defaults: defaultConfiguration() };
  snapshot.storySources.evidenceOrder = config.sources.order.map((row) => row.label);
  return snapshot;
}

test('published configuration on a precise legacy blank projects without changing configuration or source bytes', () => {
  const snapshot = configuredLegacySnapshot(), raw = JSON.stringify(snapshot);
  assert.equal(isLegacyBlankSnapshot(snapshot), true);
  const projected = normalizeReviewSnapshot(snapshot);
  assert.deepEqual(projected.productionModel.productionPhases.map((phase) => phase.id), phaseIds);
  assert.equal(projected.productionModel.productionGates.length, 15);
  assert.equal(projected.productionModel.systemConfiguration, snapshot.productionModel.systemConfiguration);
  assert.equal(projected.productionModel.configurationCandidates, snapshot.productionModel.configurationCandidates);
  assert.deepEqual(projected.storySources.evidenceOrder, snapshot.storySources.evidenceOrder);
  assert.equal(projected.snapshotId, snapshot.snapshotId);
  assert.equal(normalizeReviewSnapshot(projected), projected);
  assert.equal(normalizeEmptyProductionFilters(projected, { phaseId: 'phase-01', gateId: 'gate-01-1' }).phaseId, 'PREVIS');
  assert.equal(JSON.stringify(snapshot), raw);
});

test('configuration cannot disguise nonempty or damaged legacy business data or unknown metadata', () => {
  const mutations = [
    (s) => { s.productionModel.scenes.push({ id: 'SCENE-EXISTING' }); },
    (s) => { s.productionModel.configurationCandidates.push({ id: 'CANDIDATE-EXISTING' }); },
    (s) => { s.productionModel.systemConfiguration.reference = { revisionId: 'irv_other', sha256: 'b'.repeat(64) }; },
    (s) => { s.productionModel.systemConfiguration.reference = { revisionId: 'irv_blank_configuration', sha256: 'invalid' }; },
    (s) => { s.storySources.evidenceOrder.reverse(); },
    (s) => { s.productionModel.extraBusiness = {}; },
    (s) => { s.extraBusiness = {}; },
    (s) => { s.productionModel.systemConfiguration.extra = {}; },
    (s) => { s.productionModel.systemConfiguration.config.extra = {}; },
    (s) => { s.productionModel.productionGates[0].phaseId = 'phase-02'; },
    (s) => { s.creativeLineage.storyStructure.planStatus = 'CURRENT'; },
  ];
  for (const mutate of mutations) {
    const snapshot = configuredLegacySnapshot(); mutate(snapshot);
    assert.equal(isLegacyBlankSnapshot(snapshot), false);
    assert.throws(() => normalizeReviewSnapshot(snapshot), /legacy blank production graph/);
  }
});

test('configuration publication normalizes a known old blank before applying configuration', () => {
  const { snapshot } = legacySnapshot(), raw = JSON.stringify(snapshot);
  const config = defaultConfiguration(), reference = { revisionId: 'irv_config_new', sha256: 'b'.repeat(64) };
  config.presentation.landingView = 'system';
  const projected = projectConfiguration(snapshot, config, {}, reference);
  assert.deepEqual(projected.productionModel.productionPhases.map((phase) => phase.id), phaseIds);
  assert.equal(projected.productionModel.productionGates.length, 15);
  assert.deepEqual(projected.creativeLineage.spatialEvidence.locations, []);
  assert.deepEqual(projected.productionModel.systemConfiguration.config, config);
  assert.equal(normalizeReviewSnapshot(projected), projected);
  assert.equal(JSON.stringify(snapshot), raw);
  assert.equal(projected.scope.formalEpisodeDenominatorState, 'UNKNOWN');
  assert.equal(projected.productionModel.scenes.length, 0);
  assert.equal(projected.productionModel.assetVersions.length, 0);
});

test('new blank graph has canonical navigation, ordered gate ownership and unknown denominators', () => {
  const { snapshot } = blankSnapshot(blankProfile());
  assert.equal(normalizeReviewSnapshot(snapshot), snapshot);
  assert.deepEqual(snapshot.productionModel.productionPhases.map((phase) => phase.id), phaseIds);
  assert.equal(snapshot.productionModel.productionGates.length, 15);
  for (const [index, phase] of snapshot.productionModel.productionPhases.entries()) {
    assert.equal(phase.order, index + 1);
    const gates = snapshot.productionModel.productionGates.filter((gate) => gate.phaseId === phase.id);
    assert.deepEqual(phase.gateIds, gates.map((gate) => gate.id));
    assert.equal(phase.entryGateId, gates[0].id);
    assert.equal(phase.exitGateId, gates[2].id);
    for (const entry of [phase, ...gates]) {
      assert.equal(entry.denominatorState, 'UNKNOWN');
      assert.equal(entry.denominator, null);
      assert.equal(entry.discoveredCount, 0);
      assert.equal(entry.currentObjectCount, 0);
      assert.equal(entry.releasedObjectCount, 0);
      assert.equal(entry.countsTowardCurrent, false);
      assert.match(entry.slug, /^[a-z]+(?:-[a-z]+)*$/);
    }
  }
  assert.deepEqual(snapshot.creativeLineage.storyStructure.sequences, []);
  assert.deepEqual(snapshot.creativeLineage.spatialEvidence.locations, []);
});

test('exact legacy blank projects without mutating raw objects, identity, release or database records', async () => {
  const fixture = legacySnapshot();
  const raw = JSON.stringify(fixture);
  assert.equal(isLegacyBlankSnapshot(fixture.snapshot), true);
  const parent = path.join(import.meta.dirname, '.test-tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'blank-contract-'));
  const repo = createInstanceRepository({ dbPath: path.join(root, 'review.sqlite'), instanceId: fixture.snapshot.instance.instanceId, profile: fixture.snapshot.instance });
  try {
    await repo.writeTransaction((tx) => tx.publishRelease({ ...fixture, expectedReleaseId: null }));
    const before = repo.exportState();
    const release = repo.readRelease();
    const projection = normalizeReviewSnapshot(repo.readView().snapshot);
    assert.deepEqual(projection.productionModel, { ...fixture.snapshot.productionModel, ...blankProductionGraph() });
    assert.deepEqual(projection.instance, fixture.snapshot.instance);
    assert.equal(projection.snapshotId, fixture.snapshot.snapshotId);
    assert.equal(normalizeReviewSnapshot(projection), projection);
    assert.deepEqual(repo.readRelease(), release);
    assert.deepEqual(repo.exportState(), before);
    assert.equal(JSON.stringify(fixture), raw);
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('populated, unknown or corrupted legacy templates fail closed even with repaired spatial objects', () => {
  const mutations = [
    (snapshot) => { snapshot.productionModel.shots.push({ id: 'SHOT-EXISTING' }); },
    (snapshot) => { snapshot.productionModel.productionGates[0].phaseId = 'phase-02'; },
    (snapshot) => { snapshot.productionModel.productionPhases[0].id = 'phase-99'; },
    (snapshot) => { snapshot.productionModel.productionGraph = { activeWorkItemRefs: ['WORK-EXISTING'] }; },
    (snapshot) => { snapshot.creativeLineage.spatialEvidence = { locations: [], mapCards: [], locationPackages: [], sceneRouteLocks: [] }; },
    (snapshot) => { snapshot.creativeLineage.storyStructure.planStatus = 'CURRENT'; },
    (snapshot) => { snapshot.productionModel.assetVersions = null; },
  ];
  for (const mutate of mutations) {
    const { snapshot } = legacySnapshot();
    mutate(snapshot);
    assert.equal(isLegacyBlankSnapshot(snapshot), false);
    assert.throws(() => normalizeReviewSnapshot(snapshot), /legacy blank production graph/);
  }
});

test('missing optional search collections default to empty, wrong types remain errors', () => {
  for (const keys of [
    ['creativeLineage','storyStructure','sequences'],
    ['creativeLineage','spatialEvidence','locations'],
    ['creativeLineage','spatialEvidence','mapCards'],
    ['creativeLineage','spatialEvidence','locationPackages'],
    ['creativeLineage','spatialEvidence','sceneRouteLocks'],
    ['storySources','transcript','segments'],
    ['storySources','outline','blocks'],
  ]) {
    const { snapshot } = blankSnapshot(blankProfile());
    const owner = keys.slice(0, -1).reduce((value, key) => value[key], snapshot);
    const key = keys.at(-1);
    delete owner[key];
    const projection = normalizeReviewSnapshot(snapshot);
    assert.deepEqual(keys.reduce((value, key) => value[key], projection), []);
    assert.equal(Object.hasOwn(owner, key), false);
    for (const corrupt of [null, {}, 'invalid']) {
      owner[key] = corrupt;
      assert.throws(() => normalizeReviewSnapshot(snapshot), /must be an array/);
    }
  }
});

test('retired phase and gate aliases resolve only against known blank templates', () => {
  for (const snapshot of [normalizeReviewSnapshot(legacySnapshot().snapshot), blankSnapshot(blankProfile()).snapshot]) {
    for (let phase = 0; phase < 5; phase += 1) {
      for (let gate = 0; gate < 3; gate += 1) {
        const number = String(phase + 1).padStart(2, '0');
        const input = { phaseId: `phase-${number}`, gateId: `gate-${number}-${gate + 1}`, scopeType: null, scopeId: null };
        const result = normalizeEmptyProductionFilters(snapshot, input);
        assert.equal(result.phaseId, phaseIds[phase]);
        assert.equal(result.gateId, snapshot.productionModel.productionGates[phase * 3 + gate].id);
        assert.equal(input.phaseId, `phase-${number}`);
      }
    }
    const populated = structuredClone(snapshot);
    populated.productionModel.scenes.push({ id: 'SCENE-EXISTING' });
    const input = { phaseId: 'phase-01', gateId: 'gate-01-1' };
    assert.equal(normalizeEmptyProductionFilters(populated, input), input);
  }
});

test('existing story snapshot retains all source facts and production graph exactly', () => {
  const snapshot = blankSnapshot(blankProfile({title:'独立合成故事'})).snapshot;
  snapshot.productionModel.scenes = [{id:'scene:synthetic',title:'来信'}];
  snapshot.storySources.outline = {blocks:[{id:'source:block',text:'人物收到一封信。'}],rawMarkdown:'人物收到一封信。'};
  const before = JSON.stringify(snapshot);
  assert.equal(isLegacyBlankSnapshot(snapshot), false);
  assert.equal(normalizeReviewSnapshot(snapshot), snapshot);
  assert.equal(JSON.stringify(snapshot), before);
});
