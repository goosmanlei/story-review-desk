import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bridgeProcessOwnedByManager,
  bridgeEnvironment,
  bridgePythonArguments,
  bridgeServiceConfiguration,
  decodeBridgeHealthRecord,
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

test("managed Bridge accepts its uv launcher chain but rejects unrelated processes", () => {
  const managerPid = 100;
  const launcher = {
    pid: 101,
    parentPid: managerPid,
    command: "uv run /app/host/codex_conversation_bridge.py serve",
  };
  const python = {
    pid: 102,
    parentPid: launcher.pid,
    command: "python /app/host/codex_conversation_bridge.py serve",
  };
  assert.equal(
    bridgeProcessOwnedByManager(managerPid, launcher.pid, launcher, python),
    true,
  );
  assert.equal(
    bridgeProcessOwnedByManager(managerPid, launcher.pid, launcher, {
      ...python,
      parentPid: 999,
    }),
    false,
  );
  assert.equal(
    bridgeProcessOwnedByManager(
      managerPid,
      launcher.pid,
      { ...launcher, command: "uv run unrelated.py" },
      python,
    ),
    false,
  );
});

test("managed Bridge decodes the verified auxiliary health record used by PostgreSQL instances", () => {
  const bytes = Buffer.from(JSON.stringify({ status: "READY", pid: 102 }));
  const record = {
    bytesBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  assert.deepEqual(decodeBridgeHealthRecord(record), {
    status: "READY",
    pid: 102,
  });
  assert.throws(() =>
    decodeBridgeHealthRecord({ ...record, sha256: "0".repeat(64) }),
  );
});
