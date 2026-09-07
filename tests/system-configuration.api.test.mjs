import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import {
  blankProfile,
  blankSnapshot,
} from "../host/instance-runtime/blank.mjs";
import { createInstanceRepository } from "../host/instance-runtime/index.mjs";
import { initializeConfiguration } from "../host/instance-runtime/configuration-service.mjs";
test("configuration API saves drafts without applying, publishes exact previews, rejects races and preserves immutable replay", async () => {
  const root = path.resolve("."),
    parent = path.join(root, "host/instance-runtime/test/.test-tmp");
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(path.join(parent, "config-api-"));
  const profile = blankProfile();
  const dbPath = path.join(tmp, "review.sqlite");
  const repo = createInstanceRepository({
    dbPath,
    instanceId: profile.instanceId,
    profile,
  });
  await repo.writeTransaction(async (tx) => {
    await tx.publishRelease({ ...blankSnapshot(profile), expectedReleaseId: null });
    await initializeConfiguration(tx);
  });
  const keys = [
    "REVIEW_INSTANCE_DB",
    "REVIEW_INSTANCE_ID",
    "REVIEW_INSTANCE_ROOT",
    "REVIEW_INSTANCE_READ_ONLY",
    "REVIEW_REMOTE_READ_ONLY",
    "REVIEW_SITE_ROOT",
    "REVIEW_ALLOWED_ORIGINS",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    REVIEW_INSTANCE_DB: dbPath,
    REVIEW_INSTANCE_ID: profile.instanceId,
    REVIEW_INSTANCE_ROOT: "",
    REVIEW_INSTANCE_READ_ONLY: "",
    REVIEW_REMOTE_READ_ONLY: "",
    REVIEW_SITE_ROOT: root,
    REVIEW_ALLOWED_ORIGINS: "http://localhost:3000",
  });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    cacheDir: path.join(tmp, "vite-cache"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  let store;
  try {
    store = await server.ssrLoadModule("/app/api/v8/_store.ts");
    const route = await server.ssrLoadModule(
      "/app/api/instance/configuration/route.ts",
    );
    const preview = await server.ssrLoadModule(
      "/app/api/instance/configuration/preview/route.ts",
    );
    const publish = await server.ssrLoadModule(
      "/app/api/instance/configuration/publish/route.ts",
    );
    const get = async () =>
      await (
        await route.GET(
          new Request("http://localhost:3000/api/instance/configuration"),
        )
      ).json();
    const request = async (
      method,
      body,
      key = crypto.randomUUID(),
      origin = "http://localhost:3000",
    ) =>
      new Request("http://localhost:3000/api/instance/configuration", {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "If-Match": (await store.operationalSnapshot()).mutationEtag,
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
    const original = await get();
    const configuration = structuredClone(original.configuration);
    configuration.presentation.title = "API验证后的审阅台";
    const input = {
      configuration,
      expectedDraftRevision: null,
      expectedReleaseId: original.releaseId,
      expectedConfigurationRevisionId: original.revisionId,
      upgradeKeys: [],
    };
    assert.equal(
      (
        await route.PUT(
          await request("PUT", input, undefined, "https://untrusted.invalid"),
        )
      ).status,
      403,
    );
    const saved = await route.PUT(await request("PUT", input));
    assert.equal(saved.status, 200);
    const draft = await saved.json();
    assert.equal(
      (await get()).configuration.presentation.title,
      original.configuration.presentation.title,
    );
    assert.equal((await route.PUT(await request("PUT", input))).status, 409);
    const proposed = await preview.POST(
      await request("POST", { draftRevisionId: draft.revisionId }),
    );
    assert.equal(proposed.status, 200);
    const plan = await proposed.json();
    const body = {
        draftRevisionId: draft.revisionId,
        previewHash: plan.previewHash,
      },
      key = crypto.randomUUID();
    const result = await publish.POST(await request("POST", body, key));
    assert.equal(
      result.status,
      200,
      JSON.stringify(await result.clone().json()),
    );
    const receipt = await result.json();
    const current = await get();
    assert.equal(current.configuration.presentation.title, "API验证后的审阅台");
    assert.equal(current.history.length, 2);
    const historicalResponse=await route.GET(new Request(`http://localhost:3000/api/instance/configuration?history=${original.revisionId}`));
    const historical=await historicalResponse.json();
    assert.equal(historicalResponse.status,200);
    assert(Array.isArray(historical.bindings));assert(Array.isArray(historical.boundStandards));
    assert.deepEqual(historical.configuration,original.configuration);

    assert.deepEqual(repo.readView().eventsByKind, {});
    const nextDraft = await route.PUT(
      await request("PUT", {
        ...input,
        expectedDraftRevision: draft.revisionId,
        expectedReleaseId: current.releaseId,
        expectedConfigurationRevisionId: current.revisionId,
      }),
    );
    assert.equal(nextDraft.status, 200);
    const replay = await publish.POST(await request("POST", body, key));
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), receipt);
    assert.equal((await route.PUT(await request("PUT", null))).status, 422);
  } finally {
    (await store?.instanceRepository())?.close();
    await server.close();
    repo.close();
    for (const key of keys) { if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]; }
    rmSync(tmp, { recursive: true, force: true });
  }
});
