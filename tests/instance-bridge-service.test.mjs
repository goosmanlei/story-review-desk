import test from "node:test";
import assert from "node:assert/strict";
import {
  bridgeEnvironment,
  bridgePythonArguments,
  bridgeServiceConfiguration,
} from "../scripts/instance-bridge.mjs";

test("legacy profiles keep managed Bridge disabled until an instance publishes service settings", () => {
  assert.deepEqual(bridgeServiceConfiguration({ capabilities: {} }), {
    autoStart: false,
    model: "gpt-5.6-sol",
    maxConcurrent: 5,
    idleTtlSeconds: 600,
    enabled: false,
  });
});

test("published Bridge service settings produce bounded host arguments", () => {
  const settings = bridgeServiceConfiguration({
    capabilities: { assistantEnabled: true },
    assistant: {
      codexBridge: {
        autoStart: true,
        model: "gpt-5.6-sol",
        maxConcurrent: 5,
        idleTtlSeconds: 15,
      },
    },
  });
  assert.equal(settings.enabled, true);
  const args = bridgePythonArguments(settings);
  assert.deepEqual(args.slice(-6), [
    "--concurrency",
    "5",
    "--idle-ttl-seconds",
    "15",
    "--model",
    "gpt-5.6-sol",
  ]);
  assert.throws(() =>
    bridgeServiceConfiguration({
      capabilities: { assistantEnabled: true },
      assistant: {
        codexBridge: { ...settings, maxConcurrent: 99 },
      },
    }),
  );
});

test("managed Bridge environment excludes provider keys and arbitrary project variables", () => {
  const environment = bridgeEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    OPENAI_API_KEY: "secret",
    REVIEW_OPENAI_API_KEY_FILE: "/private/key",
    REVIEW_INSTANCE_ROOT: "/other/project",
  });
  assert.deepEqual(environment, {
    PATH: "/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
  });
});
