import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import {
  blankProfile,
  blankSnapshot,
} from "../host/instance-runtime/blank.mjs";
import { createInstanceRepository } from "../host/instance-runtime/index.mjs";
import {
  defaultConfiguration,
  validateConfiguration,
  reviewSpec,
  configHash,
  projectConfiguration,
  semanticConfiguration,
} from "../host/instance-runtime/configuration-model.mjs";
import {
  initializeConfiguration,
  getConfiguration,
  previewConfiguration,
  publishConfiguration,
  preserveConfigurationProjection,
} from "../host/instance-runtime/configuration-service.mjs";
import {
  configuredGates,
  executionEligibilityReasons,
} from "../app/gate-evaluation.ts";
async function fixture(run) {
  const parent = path.resolve("host/instance-runtime/test/.test-tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "configuration-"));
  const profile = blankProfile();
  const repo = (await createInstanceRepository({
    dbPath: path.join(root, "review.sqlite"),
    instanceId: profile.instanceId,
    profile,
  }));
  try {
    const blank = blankSnapshot(profile);
    blank.snapshot.productionModel.materialRequirements = [
      {
        id: "material-a",
        requirementClass: "REQUIRED",
        mediaType: "IMAGE",
        businessCategoryPrimary: "人物",
        businessCategorySecondary: "人物身份",
        acceptanceCriteria: ["原对象的身份与用途"],
        assetFamilyRefs: [],
      },
    ];
    await repo.writeTransaction(async (tx) =>
      (await tx.publishRelease({ ...blank, expectedReleaseId: null })),
    );
    await run(repo);
  } finally {
    (await repo.close());
    rmSync(root, { recursive: true, force: true });
  }
}
async function input(tx, configuration, upgradeKeys = []) {
  const current = (await getConfiguration(tx));
  const value = {
    configuration,
    upgradeKeys,
    expectedReleaseId: current.releaseId,
    expectedConfigurationRevisionId: current.revisionId,
  };
  return {
    ...value,
    previewHash: (await previewConfiguration(tx, value)).previewHash,
    requestId: crypto.randomUUID(),
  };
}
test("legacy configuration without domain upgrades atomically while preserving frozen object standards", async () => fixture(async repo => {
  await repo.writeTransaction(tx => initializeConfiguration(tx));
  const legacy = structuredClone((await repo.readTransaction(getConfiguration)).configuration);
  legacy.schemaVersion = '1.0'; delete legacy.domain;
  await repo.writeTransaction(async tx => publishConfiguration(tx, await input(tx, legacy)));
  const before = await repo.readTransaction(getConfiguration);
  const next = {...legacy, schemaVersion: '2.0', domain: defaultConfiguration().domain};
  await repo.writeTransaction(async tx => {
    const value = await input(tx, next);
    const preview = await previewConfiguration(tx, value);
    assert(preview.changedGroups.includes('domain'));
    await publishConfiguration(tx, value);
  });
  const after = await repo.readTransaction(getConfiguration);
  assert.equal(after.configuration.schemaVersion, '2.0');
  assert.deepEqual(after.bindings, before.bindings);
}));
test("published defaults preserve old objects, explicit upgrade changes only selected standards, historical bytes stay exact", async () =>
  (await fixture(async (repo) => {
    const old = (await repo.readRelease());
    const tech = defaultConfiguration().technical;
    tech.picture = {
      aspectRatio: "16:9",
      width: 1920,
      height: 1080,
      fps: 24,
      confirmation: "CONFIRMED",
    };
    await repo.writeTransaction(async (tx) =>
      (await initializeConfiguration(tx, { technical: tech })),
    );
    const before = (await repo.readView());
    const bound =
      before.snapshot.productionModel.materialRequirements[0]
        .configurationBinding;
    assert.deepEqual(bound.technical, tech);
    assert.equal(bound.reviewSpec.criteria[0].id, "material-01");
    await repo.writeTransaction(async (tx) => {
      const config = (await getConfiguration(tx)).configuration;
      config.reviewProfiles.find(
        (p) => p.id === "material-type-identity",
      ).criteria[0].question = "新的通用问题";
      (await publishConfiguration(tx, (await input(tx, config))));
    });
    assert.deepEqual(
      (await repo.readView()).snapshot.productionModel.materialRequirements[0]
        .configurationBinding,
      bound,
    );
    await repo.writeTransaction(async (tx) =>
      (await publishConfiguration(
        tx,
        (await input(tx, (await getConfiguration(tx)).configuration, ["material:material-a"])),
      )),
    );
    assert.equal(
      (await repo.readView()).snapshot.productionModel.materialRequirements[0]
        .reviewSpec.criteria[0].question,
      "新的通用问题",
    );
    assert.deepEqual((await repo.readView()).eventsByKind, before.eventsByKind);
    assert.deepEqual(
      (await repo.readRelease(old.releaseId)).snapshotBytes,
      old.snapshotBytes,
    );
  })));
test("CAS, preview hash, immutable replay, and profile/snapshot integrity fail closed", async () =>
  (await fixture(async (repo) => {
    await repo.writeTransaction(async (tx) => (await initializeConfiguration(tx)));
    let proposed;
    await repo.readTransaction(async (tx) => {
      const config = (await getConfiguration(tx)).configuration;
      config.presentation.title = "配置变化";
      proposed = (await input(tx, config));
    });
    await assert.rejects(
      repo.writeTransaction(async (tx) =>
        (await publishConfiguration(tx, { ...proposed, previewHash: "0".repeat(64) })),
      ),
      /预览/,
    );
    const published = await repo.writeTransaction(async (tx) =>
      (await publishConfiguration(tx, proposed)),
    );
    assert.deepEqual(
      await repo.writeTransaction(async (tx) => (await publishConfiguration(tx, proposed))),
      published,
    );
    await assert.rejects(
      repo.writeTransaction(async (tx) =>
        (await publishConfiguration(tx, {
          ...proposed,
          requestId: crypto.randomUUID(),
        })),
      ),
      /发布已变化/,
    );
    await assert.rejects(
      repo.writeTransaction(async (tx) => {
        const view = (await tx.readView());
        view.snapshot.productionModel.systemConfiguration.config.presentation.title =
          "未绑定";
        (await tx.publishRelease({
          snapshot: view.snapshot,
          recipes: view.recipes,
          expectedReleaseId: view.releaseId,
        }));
      }),
      /same configuration revision/,
    );
  })));
test("source compilation preserves event candidates even when compiler does not know configuration fields", async () =>
  (await fixture(async (repo) => {
    await repo.writeTransaction(async (tx) =>
      (await tx.importEvent({
        bytes: JSON.stringify({
          eventId: "candidate-event",
          recordedAt: "2026-09-06T00:00:00Z",
          eventKind: "creative-revision",
          creativeRevisionId: "candidate-a",
          subjectKind: "EPISODE_PLAN",
          subjectId: "plan-a",
          criteriaVersion: "2.0",
        }),
      })),
    );
    await repo.writeTransaction(async (tx) => (await initializeConfiguration(tx)));
    const before = (await repo.readView()),
      snapshot = structuredClone(before.snapshot);
    delete snapshot.productionModel.configurationCandidates;
    delete snapshot.productionModel.systemConfiguration;
    const next = preserveConfigurationProjection({
      snapshot,
      recipes: before.recipes,
      baseSnapshot: before.snapshot,
      profile: before.profile,
    });
    assert.deepEqual(
      next.snapshot.productionModel.configurationCandidates,
      before.snapshot.productionModel.configurationCandidates,
    );
  })));
test("unsupported nested fields, invalid fixed profiles, alias collisions, incomplete confirmation and dependency cycles are rejected", () => {
  for (const mutate of [
    (c) => (c.collaboration.providerApiKey = "private"),
    (c) => (c.collaboration.codexBridge.maxConcurrent = 9),
    (c) => (c.collaboration.codexBridge.idleTtlSeconds = -1),
    (c) => (c.collaboration.codexBridge.model = "bad model"),
    (c) => {
      c.reviewProfiles[0].subjectKind = "ASSET";
    },
    (c) => (c.technical.delivery = { confirmation: "CONFIRMED" }),
    (c) => (c.workflow.phases[0].label = {}),
    (c) => c.taxonomy.categories[0].aliases.push("scene"),
    (c) =>
      c.workflow.gates[0].extraPrerequisites.push(c.workflow.gates.at(-1).id),
  ]) {
    const c = defaultConfiguration();
    mutate(c);
    assert.throws(() => validateConfiguration(c));
  }
});
test("Codex Bridge settings project into the host profile without rebinding review semantics", () => {
  const profile = blankProfile();
  const snapshot = blankSnapshot(profile).snapshot;
  const config = defaultConfiguration(profile);
  const beforeSemantic = configHash(semanticConfiguration(config));
  config.collaboration.codexBridge = {
    autoStart: true,
    model: "gpt-5.6-sol",
    maxConcurrent: 5,
    idleTtlSeconds: 15,
  };
  const validated = validateConfiguration(config);
  const projected = projectConfiguration(snapshot, validated, {}, {
    revisionId: "irv_test",
    sha256: "0".repeat(64),
  });
  assert.deepEqual(
    projected.instance.assistant.codexBridge,
    validated.collaboration.codexBridge,
  );
  assert.equal(configHash(semanticConfiguration(validated)), beforeSemantic);
});
test("a collaboration-only publish does not misclassify a pre-existing uncatalogued requirement as deletion", async () =>
  fixture(async (repo) => {
    await repo.writeTransaction((tx) => initializeConfiguration(tx));
    await repo.writeTransaction(async (tx) => {
      const view = await tx.readView();
      const snapshot = structuredClone(view.snapshot);
      const requirement = snapshot.productionModel.materialRequirements[0];
      delete requirement.businessCategoryPrimaryId;
      delete requirement.businessCategorySecondaryId;
      requirement.businessCategoryPrimary = "历史未登记分类";
      requirement.businessCategorySecondary = "历史未登记类型";
      const projected = preserveConfigurationProjection({
        snapshot,
        recipes: view.recipes,
        baseSnapshot: view.snapshot,
        profile: view.profile,
      });
      await tx.publishRelease({
        ...projected,
        expectedReleaseId: view.releaseId,
        sourceRevisionIds: view.sourceRevisionIds,
      });
    });
    await repo.readTransaction(async (tx) => {
      const current = await getConfiguration(tx);
      const configuration = structuredClone(current.configuration);
      configuration.collaboration.codexBridge.autoStart = true;
      const preview = await previewConfiguration(tx, {
        configuration,
        expectedReleaseId: current.releaseId,
        expectedConfigurationRevisionId: current.revisionId,
        upgradeKeys: [],
      });
      assert.equal(preview.semanticChange, false);
      assert.deepEqual(preview.changedGroups, ["collaboration"]);
    });
  }));
test("production standards render actual scoped evidence instead of borrowing navigation-shot identity", () => {
  const c = defaultConfiguration();
  const spec = reviewSpec(
    c,
    "WORK_PRODUCT",
    { deliverableKey: "ANIMATIC" },
    {
      scopeContext: {
        scopeType: "SCENE",
        scopeId: "S-2",
        judgment: {
          reviewQuestion: { text: "本场误会是否成立？" },
          purpose: { text: "建立误会" },
          audienceTakeaway: { text: "认识分歧" },
        },
      },
    },
  );
  assert.equal(spec.criteria[0].id, "narrative-fit");
  assert(spec.criteria[0].question.includes("本场误会是否成立？"));
  assert(spec.criteria[0].question.includes("S-2"));
  assert(!spec.criteria.some(c=>c.id==="scope-identity"));
  assert(!JSON.stringify(spec).includes("{{"));
});
test("additional reports block gate exit and cross-gate consumption, while same-gate report production remains possible", () => {
  const config = defaultConfiguration();
  const same = config.workflow.gates.filter((g) => g.scopeType === "SCENE");
  const first = same[0],
    second = same[1];
  first.additionalOutputTypes = ["TECHNICAL_REPORT"];
  second.extraPrerequisites = [first.id];
  const binding = {
    workflow: config.workflow,
    configurationHash: configHash(config),
  };
  const item = (id, gate, output, extras = {}) => ({
    id,
    gateId: gate.id,
    sceneId: "S1",
    scopeId: "S1",
    scopeType: "SCENE",
    activeInCurrentProduction: true,
    outputAssetRef: output,
    configurationBinding: binding,
    ...extras,
  });
  const main = item("main", first, "main-family"),
    next = item("next", second, "next-family", {
      inputAssetRefs: ["main-family"],
    }),
    report = item("report", first, "report-family", {
      deliverableKey: "TECHNICAL_REPORT",
      inputAssetRefs: ["main-family"],
    });
  const projection = {
    workItemsById: {
      main: { canFlowDownstream: true },
      next: { lifecycleState: "READY_TO_START" },
      report: { lifecycleState: "READY_TO_START" },
    },
    assetFamiliesById: {
      "main-family": { currentVersionId: "main-v", canFlowDownstream: true },
    },
    assetVersionsById: {
      "main-v": { sha256: "a".repeat(64), canFlowDownstream: true },
    },
  };
  let result = configuredGates(
    { workItems: [main, next], materialWorkItems: [] },
    projection,
  );
  assert(
    result.main.exitReasons.includes("CONFIGURED_OUTPUT_DEFINITION_MISSING"),
  );
  assert(result.next.entryReasons.length);
  result = configuredGates({ workItems: [main, next, report] }, projection);
  assert.deepEqual(result.report.entryReasons, []);
  assert(result.next.entryReasons.length);
  projection.assetFamiliesById["report-family"] = {
    currentVersionId: "report-v",
    canFlowDownstream: true,
  };
  projection.assetVersionsById["report-v"] = {
    sha256: "b".repeat(64),
    canFlowDownstream: true,
  };
  projection.workItemsById.report.canFlowDownstream = true;
  result = configuredGates({ workItems: [main, next, report] }, projection);
  assert.deepEqual(result.next.entryReasons, []);
  projection.configuredGatesByWorkItem = result;
  assert(
    executionEligibilityReasons(
      { stateProjection: projection },
      {
        declaredGate: "READY_TO_START",
        output: { assetFamilyRef: "next-family" },
      },
      { workItemId: "next", familyId: "next-family", inputBindings: [] },
    ).includes("EXECUTION_DEFINITION_NOT_READY"),
  );
  const definition = {
    definitionStatus: "DEFINED",
    definitionHash: "c".repeat(64),
    declaredGate: "READY_TO_START",
    output: { assetFamilyRef: "next-family" },
  };
  assert(
    executionEligibilityReasons({ stateProjection: projection }, definition, {
      workItemId: "next",
      familyId: "next-family",
      inputBindings: [
        {
          assetFamilyRef: "main-family",
          assetVersionRef: "main-v",
          sha256: "d".repeat(64),
        },
      ],
    }).includes("INPUT_1_SHA_STALE"),
  );
});
