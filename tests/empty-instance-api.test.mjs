import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { blankProfile, blankSnapshot } from '../host/instance-runtime/blank.mjs';
import { createInstanceRepository } from '../host/instance-runtime/index.mjs';

test('real instance search and production GETs preserve release bytes and validate every empty gate', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const parent = path.join(root, 'host/instance-runtime/test/.test-tmp');
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(path.join(parent, 'blank-api-'));
  const profile = blankProfile();
  const dbPath = path.join(temporary, 'review.sqlite');
  const repo = createInstanceRepository({ dbPath, instanceId: profile.instanceId, profile });
  const keys = ['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY','REVIEW_SITE_ROOT'];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { REVIEW_INSTANCE_DB: dbPath, REVIEW_INSTANCE_ID: profile.instanceId, REVIEW_INSTANCE_ROOT: '', REVIEW_INSTANCE_READ_ONLY: '', REVIEW_REMOTE_READ_ONLY: '', REVIEW_SITE_ROOT: root });
  const server = await createServer({ root, configFile: false, logLevel: 'error', cacheDir: path.join(temporary, 'vite-cache'), server: { middlewareMode: true }, appType: 'custom' });
  let store;
  try {
    store = await server.ssrLoadModule('/app/api/v8/_store.ts');
    const search = await server.ssrLoadModule('/app/api/v8/ui/search/route.ts');
    const production = await server.ssrLoadModule('/app/api/v8/ui/production/route.ts');
    const materials = await server.ssrLoadModule('/app/api/v8/ui/materials/route.ts');
    const pagination = await server.ssrLoadModule('/app/api/v8/ui/_pagination.ts');
    const { normalizeEmptyProductionFilters } = await import('../host/instance-runtime/snapshot-contract.mjs');
    for (const legacy of [false, true]) {
      const fixture = blankSnapshot(profile);
      if (legacy) {
        fixture.snapshot.productionModel.productionPhases = fixture.snapshot.productionModel.productionPhases.map((phase, index) => {
          const number = String(index + 1).padStart(2, '0');
          return { id: `phase-${number}`, label: phase.label, title: phase.label, gates: fixture.snapshot.productionModel.productionGates.filter((gate) => gate.phaseId === phase.id).map((gate, gateIndex) => ({ id: `gate-${number}-${gateIndex + 1}`, label: gate.label })) };
        });
        fixture.snapshot.productionModel.productionGates = fixture.snapshot.productionModel.productionPhases.flatMap((phase) => phase.gates);
        fixture.snapshot.creativeLineage.storyStructure = {};
        fixture.snapshot.creativeLineage.spatialEvidence = [];
      }
      await repo.writeTransaction((tx) => tx.publishRelease({ ...fixture, expectedReleaseId: tx.readRelease()?.releaseId || null }));
      const before = repo.exportState();
      for (const query of ['新故事','hello','S01','E01','无结果']) {
        const response = await search.GET(new Request(`http://localhost/api/v8/ui/search?q=${encodeURIComponent(query)}`));
        assert.equal(response.status, 200, `legacy=${legacy} search=${query}`);
        const result = await response.json();
        assert.equal(result.total, 0);
        assert.deepEqual(result.data, []);
      }
      const projected = await store.reviewData();
      for (const [index, phase] of projected.productionModel.productionPhases.entries()) {
        const number = String(index + 1).padStart(2, '0');
        const gates = projected.productionModel.productionGates.filter((gate) => gate.phaseId === phase.id);
        for (const [gateIndex, gate] of gates.entries()) {
          for (const [phaseId, gateId] of [[phase.id, gate.id], [`phase-${number}`, `gate-${number}-${gateIndex + 1}`]]) {
            for (const resource of [production, materials]) {
              const response = await resource.GET(new Request(`http://localhost/api/v8/ui/production?phaseId=${phaseId}&gateId=${gateId}`));
              assert.equal(response.status, 200, `${phaseId}/${gateId}`);
              const result = await response.json();
              assert.equal(result.total, 0);
              assert.equal(result.appliedFilters.phaseId, phase.id);
              assert.equal(result.appliedFilters.gateId, gate.id);
            }
          }
        }
      }
      for (const query of ['phaseId=SHOT_FINISH&gateId=SHOT_PLAN_INPUT_LOCK', 'phaseId=phase-02&gateId=gate-01-1', 'phaseId=phase-99']) {
        for (const resource of [production, materials]) assert.equal((await resource.GET(new Request(`http://localhost/api/v8/ui/production?${query}`))).status, 422);
      }
      const parse = (query) => pagination.parseUiPageRequest(new Request(`http://localhost/?${query}`), 'production', projected.snapshotId, (filters) => normalizeEmptyProductionFilters(projected, filters));
      assert.equal(parse('phaseId=phase-01&gateId=gate-01-1').filterHash, parse('phaseId=PREVIS&gateId=SHOT_PLAN_INPUT_LOCK').filterHash);
      assert.deepEqual(repo.exportState(), before);
    }
    // Search uses current location/package/route relationships regardless of their IDs.
    const fixture = blankSnapshot(profile);
    fixture.snapshot.creativeLineage.spatialEvidence = {
      locations: [{ id: 'LOC-CUSTOM', name: '测试地点' }],
      locationPackages: [{ id: 'LOC-CUSTOM', zones: [{ id: 'ZONE-CUSTOM', label: '通用路线关键词' }] }],
      sceneRouteLocks: [{ sceneId: 'SCENE-CUSTOM', locationIds: ['LOC-CUSTOM'], orderedZones: ['ZONE-CUSTOM'] }],
      mapCards: [],
    };
    await repo.writeTransaction((tx) => tx.publishRelease({ ...fixture, expectedReleaseId: tx.readRelease().releaseId }));
    const response = await search.GET(new Request(`http://localhost/api/v8/ui/search?q=${encodeURIComponent('通用路线关键词')}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((entry) => [entry.kind, entry.mapLocationId, entry.sceneId]), [['空间证据','LOC-CUSTOM','SCENE-CUSTOM']]);
  } finally {
    (await store?.instanceRepository())?.close();
    repo.close();
    await server.close();
    for (const key of keys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});
