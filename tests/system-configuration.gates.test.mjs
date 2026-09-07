import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredGates,
  configuredProductionProgress,
  executionEligibilityReasons,
} from "../app/gate-evaluation.ts";
import { defaultConfiguration } from "../host/instance-runtime/configuration-model.mjs";

function setup() {
  const config = defaultConfiguration();
  const gates = config.workflow.gates.filter((g) => g.scopeType === "SCENE");
  const first = gates[0],
    nextGate = gates[1];
  first.additionalOutputTypes = ["TECHNICAL_REPORT"];
  const binding = {
    workflow: config.workflow,
    configurationHash: "c".repeat(64),
  };
  const item = (id, gate, output, extra = {}) => ({
    id,
    gateId: gate.id,
    sceneId: "S1",
    scopeId: "S1",
    scopeType: "SCENE",
    activeInCurrentProduction: true,
    outputAssetRef: output,
    configurationBinding: binding,
    ...extra,
  });
  const main = item("main", first, "main-family");
  const next = item("next", nextGate, "next-family");
  const report = item("report", first, "report-family", {
    deliverableKey: "TECHNICAL_REPORT",
    inputAssetRefs: ["main-family"],
  });
  const projection = {
    workItemsById: {
      main: { canFlowDownstream: true },
      next: { lifecycleState: "READY_TO_START" },
      report: { lifecycleState: "READY_TO_START" },
    },
    materialWorkItemsById: {},
    assetFamiliesById: {
      "main-family": { currentVersionId: "main-v", canFlowDownstream: true },
    },
    assetVersionsById: {
      "main-v": { sha256: "a".repeat(64), canFlowDownstream: true },
    },
  };
  return {
    config,
    first,
    nextGate,
    binding,
    main,
    next,
    report,
    projection,
    item,
  };
}

test("work-item relation cannot bypass missing configured output", () => {
  const f = setup();
  f.next.upstreamWorkRelations = [
    { workItemRefs: ["main"], resolutionState: "RESOLVED" },
  ];
  const r = configuredGates({ workItems: [f.main, f.next] }, f.projection);
  assert(r.main.exitReasons.length);
  assert(r.next.entryReasons.length, JSON.stringify(r));
});

test("same gate in another scene cannot use sibling-report exemption", () => {
  const f = setup();
  Object.assign(f.next, {
    gateId: f.first.id,
    sceneId: "S2",
    scopeId: "S2",
    inputAssetRefs: ["main-family"],
  });
  const r = configuredGates({ workItems: [f.main, f.next] }, f.projection);
  assert(r.main.exitReasons.length);
  assert(r.next.entryReasons.length, JSON.stringify(r));
});

test("same gate report can still consume main output before gate exit", () => {
  const f = setup();
  const r = configuredGates({ workItems: [f.main, f.report] }, f.projection);
  assert.deepEqual(r.report.entryReasons, []);
  assert(r.main.exitReasons.length);
});

test("non-flowable report work cannot satisfy gate from released family alone", () => {
  const f = setup();
  f.next.inputAssetRefs = ["main-family"];
  f.projection.assetFamiliesById["report-family"] = {
    currentVersionId: "report-v",
    canFlowDownstream: true,
  };
  f.projection.assetVersionsById["report-v"] = {
    sha256: "b".repeat(64),
    canFlowDownstream: true,
  };
  f.projection.workItemsById.report = {
    activeInCurrentProduction: false,
    canFlowDownstream: false,
    lifecycleState: "EVIDENCE_ONLY",
  };
  const r = configuredGates(
    { workItems: [f.main, f.next, f.report] },
    f.projection,
  );
  assert(r.main.exitReasons.length, JSON.stringify(r));
  assert(r.next.entryReasons.length, JSON.stringify(r));
});

test("disabled early ambience requires full picture-lock gate exit", () => {
  const f = setup();
  f.config.workflow.earlyAmbience = false;
  const pictureGate = f.config.workflow.gates.find(
    (g) => g.id === "PICTURE_LOCK",
  );
  pictureGate.additionalOutputTypes = ["TECHNICAL_REPORT"];
  const picture = f.item("picture", pictureGate, "picture-family");
  const req = {
    id: "ambience-req",
    businessCategorySecondaryId: "ambience-bed",
    sceneIds: ["S1"],
    configurationBinding: f.binding,
  };
  const ambience = {
    id: "ambience",
    requirementRef: req.id,
    configurationBinding: f.binding,
  };
  f.projection.workItemsById.picture = { canFlowDownstream: true };
  f.projection.materialWorkItemsById.ambience = {
    lifecycleState: "READY_TO_START",
  };
  const r = configuredGates(
    {
      workItems: [picture],
      materialRequirements: [req],
      materialWorkItems: [ambience],
    },
    f.projection,
  );
  assert(r.picture.exitReasons.length);
  assert(r.ambience.entryReasons.length, JSON.stringify(r));
});

test("legacy WAITING_P07_APPROVAL is eligible after store verifies its P07", () => {
  const f = setup();
  const definition = {
    definitionStatus: "DEFINED",
    definitionHash: "d".repeat(64),
    declaredGate: "WAITING_P07_APPROVAL",
    output: { assetFamilyRef: "next-family" },
  };
  const reasons = executionEligibilityReasons(
    { stateProjection: f.projection, p07Released: { allReleased: true } },
    definition,
    { workItemId: "next", familyId: "next-family", inputBindings: [] },
  );
  assert.deepEqual(reasons, []);
});

test("missing report removes the scope from gate and phase completed counts", () => {
  const f = setup();
  const model = {
    workItems: [f.main],
    productionGates: [
      {
        id: f.first.id,
        scopeType: "SCENE",
        denominatorUnit: "SCENE",
        denominatorState: "KNOWN",
        denominator: 1,
        releasedObjectCount: 1,
        completionState: "RELEASED",
      },
    ],
    productionPhases: [
      {
        id: "PHASE",
        exitGateId: f.first.id,
        denominatorUnit: "SCENE",
        denominatorState: "KNOWN",
        denominator: 1,
        releasedObjectCount: 1,
        completionState: "RELEASED",
      },
    ],
  };
  f.projection.configuredGatesByWorkItem = configuredGates(model, f.projection);
  const progress = configuredProductionProgress(model, f.projection);
  for (const row of [
    ...progress.productionGates,
    ...progress.productionPhases,
  ]) {
    assert.equal(row.releasedObjectCount, 0);
    assert.equal(row.denominator, 1);
    assert(!["COMPLETE", "RELEASED"].includes(row.completionState));
  }
});

test("released extra report shares scope denominator and does not inflate it", () => {
  const f = setup();
  f.projection.workItemsById.report = { canFlowDownstream: true };
  f.projection.assetFamiliesById["report-family"] = {
    currentVersionId: "report-v",
    canFlowDownstream: true,
  };
  f.projection.assetVersionsById["report-v"] = {
    sha256: "b".repeat(64),
    canFlowDownstream: true,
  };
  const model = {
    workItems: [f.main, f.report],
    productionGates: [
      {
        id: f.first.id,
        scopeType: "SCENE",
        denominatorUnit: "SCENE",
        denominatorState: "KNOWN",
        denominator: 1,
      },
    ],
    productionPhases: [
      {
        id: "PHASE",
        exitGateId: f.first.id,
        denominatorUnit: "SCENE",
        denominatorState: "KNOWN",
        denominator: 1,
      },
    ],
  };
  f.projection.configuredGatesByWorkItem = configuredGates(model, f.projection);
  const progress = configuredProductionProgress(model, f.projection);
  for (const row of [
    ...progress.productionGates,
    ...progress.productionPhases,
  ]) {
    assert.equal(row.releasedObjectCount, 1);
    assert.equal(row.currentObjectCount, 1);
    assert.equal(row.denominator, 1);
    assert(["COMPLETE", "RELEASED"].includes(row.completionState));
  }
});

test("configured progress preserves UNKNOWN scope denominator", () => {
  const f = setup();
  const model = {
    workItems: [f.main],
    productionGates: [
      {
        id: f.first.id,
        scopeType: "SCENE",
        denominatorUnit: "SCENE",
        denominatorState: "UNKNOWN",
        denominator: null,
      },
    ],
    productionPhases: [],
  };
  f.projection.configuredGatesByWorkItem = configuredGates(model, f.projection);
  const row = configuredProductionProgress(model, f.projection)
    .productionGates[0];
  assert.equal(row.denominatorState, "UNKNOWN");
  assert.equal(row.denominator, null);
  assert.equal(row.completionState, "UNKNOWN");
});
