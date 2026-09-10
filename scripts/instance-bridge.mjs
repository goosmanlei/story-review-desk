import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_CODEX_BRIDGE_CONFIGURATION,
  configHash,
  normalizeCodexBridgeConfiguration,
} from "../host/instance-runtime/configuration-model.mjs";
import { sha256 } from "../host/instance-runtime/bytes.mjs";
import {
  applicationRoot,
  loadInstanceRuntime,
} from "./instance-profile.mjs";
import {
  resolveStorageOwner,
  runInstanceCli,
} from "../host/instance-runtime/transport.mjs";
import { runMaintenanceProcess } from "./instance-maintenance.mjs";

const filename = fileURLToPath(import.meta.url);
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const managerLockName = "runtime/locks/codex-bridge-host.json";
const managerStartTimeoutMilliseconds = 90_000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

async function safeDirectory(target) {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Bridge 运行目录不是安全普通目录");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(target, { mode: 0o700 });
  }
  if ((await realpath(target)) !== target)
    throw new Error("Bridge 运行目录不能通过符号链接定位");
  return target;
}

async function readJsonFile(target) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576)
    throw new Error("Bridge 状态文件无效");
  return JSON.parse(await readFile(target, "utf8"));
}

async function removeIfPresent(target) {
  try {
    await unlink(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function atomicJson(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export function bridgeEnvironment(environment = process.env) {
  const allowed = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TZ",
    "REVIEW_UV_BINARY",
    "REVIEW_CODEX_BINARY",
    "REVIEW_CODEX_AUTH_HOME",
    "REVIEW_EXECUTABLE_PATH",
    "REVIEW_PYTHON_BINARY",
    "REVIEW_DEPLOYMENT_MODE",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, environment[key]]),
  );
}

export function bridgeServiceConfiguration(profile) {
  const value = normalizeCodexBridgeConfiguration(
    profile?.assistant?.codexBridge,
  );
  if (
    typeof value.autoStart !== "boolean" ||
    typeof value.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.model) ||
    !Number.isInteger(value.maxConcurrent) ||
    value.maxConcurrent < 1 ||
    value.maxConcurrent > 8 ||
    !Number.isInteger(value.idleTtlSeconds) ||
    value.idleTtlSeconds < 0 ||
    value.idleTtlSeconds > 86_400
  )
    throw new Error("Published Codex Bridge service configuration is invalid");
  return {
    ...value,
    enabled: profile?.capabilities?.assistantEnabled !== false && value.autoStart,
  };
}

export function bridgePythonArguments(settings, command = "serve", codexBinary) {
  if (!["serve", "doctor"].includes(command))
    throw new Error("Bridge command must be serve or doctor");
  const args = [
    "run",
    ...(process.env.REVIEW_PYTHON_BINARY ? ["--python", process.env.REVIEW_PYTHON_BINARY] : []),
    path.join(applicationRoot, "host/codex_conversation_bridge.py"),
    command,
    "--concurrency",
    String(settings.maxConcurrent),
    "--idle-ttl-seconds",
    String(settings.idleTtlSeconds),
    "--model",
    settings.model,
  ];
  if (codexBinary) args.push("--codex-bin", codexBinary);
  return args;
}

async function processDetails(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !alive(pid)) return null;
  let result;
  try {
    result = await runMaintenanceProcess(
      "ps",
      ["-p", String(pid), "-o", "ppid=,command="],
      { env: bridgeEnvironment() },
    );
  } catch (error) {
    if (!alive(pid)) return null;
    throw error;
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
  return match
    ? { pid, parentPid: Number(match[1]), command: match[2] }
    : null;
}

async function verifiedManager(record, root) {
  if (!Number.isSafeInteger(record?.pid)) return null;
  const processInfo = await processDetails(record.pid);
  if (!processInfo) return null;
  if (
    record.root !== root ||
    record.script !== filename ||
    !processInfo.command.includes(filename) ||
    !processInfo.command.includes("--managed") ||
    !processInfo.command.includes(root)
  )
    throw new Error("Bridge 托管锁指向无法核实的进程，未停止未知进程");
  return processInfo;
}

async function stopManager(lock, record, root) {
  const processInfo = await verifiedManager(record, root);
  if (!processInfo) {
    await removeIfPresent(lock);
    return false;
  }
  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 150 && alive(record.pid); attempt += 1)
    await pause(100);
  if (alive(record.pid))
    throw new Error("旧 Codex Bridge 仍在收尾，请稍后重新启动实例");
  await removeIfPresent(lock);
  return true;
}

async function managerRecord(lock) {
  try {
    return await readJsonFile(lock);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function stopManagedBridge(root) {
  root = await realpath(root);
  const lock = path.join(root, managerLockName), record = await managerRecord(lock);
  return {status: record && await stopManager(lock, record, root) ? "STOPPED" : "NOT_RUNNING"};
}

export function decodeBridgeHealthRecord(record) {
  if (!record) return null;
  if (
    typeof record.bytesBase64 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256 || "")
  )
    throw new Error("Bridge 健康记录无效");
  const bytes = Buffer.from(record.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== record.bytesBase64 ||
    sha256(bytes) !== record.sha256
  )
    throw new Error("Bridge 健康记录校验失败");
  return JSON.parse(bytes.toString("utf8"));
}

async function bridgeHealth(root) {
  const record = await runInstanceCli(root, [
    "aux-get",
    "--namespace",
    "assistant-public",
    "--key",
    "health.json",
  ]);
  return decodeBridgeHealthRecord(record);
}

export function bridgeProcessOwnedByManager(
  managerPid,
  launcherPid,
  launcher,
  bridge,
) {
  if (
    !launcher ||
    launcher.pid !== launcherPid ||
    launcher.parentPid !== managerPid ||
    !launcher.command.includes("codex_conversation_bridge.py") ||
    !bridge ||
    !bridge.command.includes("codex_conversation_bridge.py")
  )
    return false;
  return bridge.pid === launcherPid || bridge.parentPid === launcherPid;
}

async function matchingHealth(
  root,
  managerPid,
  launcherPid,
  settings,
  startedAt,
) {
  const health = await bridgeHealth(root);
  if (!health) return null;
  if (
    !["READY", "PROCESSING"].includes(health.status) ||
    health.mode !== "REAL" ||
    health.securityPreflightVerified !== true ||
    health.workContextPreflightVerified !== true ||
    health.model !== settings.model ||
    health.configuredConcurrency !== settings.maxConcurrent ||
    Number(health.idleTtlSeconds) !== settings.idleTtlSeconds ||
    !Number.isFinite(Date.parse(health.checkedAt)) ||
    Date.parse(health.checkedAt) < startedAt
  )
    return null;
  const [launcher, processInfo] = await Promise.all([
    processDetails(launcherPid),
    processDetails(health.pid),
  ]);
  if (
    !bridgeProcessOwnedByManager(
      managerPid,
      launcherPid,
      launcher,
      processInfo,
    )
  )
    return null;
  return health;
}

export async function startManagedBridge(runtime) {
  const root = await realpath(runtime.root);
  const settings = bridgeServiceConfiguration(runtime.profile);
  const lockDirectory = await safeDirectory(path.join(root, "runtime", "locks"));
  const lock = path.join(lockDirectory, path.basename(managerLockName));
  const current = await managerRecord(lock);
  if (!settings.enabled) {
    if (current) await stopManager(lock, current, root);
    return {
      status: "DISABLED_BY_CONFIGURATION",
      autoStart: settings.autoStart,
      assistantEnabled: runtime.profile.capabilities?.assistantEnabled !== false,
      modelCalls: 0,
    };
  }
  const identity = {
    instanceId: runtime.instanceId,
    runtimeEpoch: runtime.runtimeEpoch,
    profileRevisionId: runtime.profileRevisionId,
    releaseId: runtime.releaseId,
    softwareCommit: runtime.softwareCommit,
  };
  const settingsHash = configHash({ ...identity, settings });
  if (current) {
    const manager = await verifiedManager(current, root);
    if (
      manager &&
      current.settingsHash === settingsHash &&
      current.scriptSha256 === sha256(await readFile(filename))
    ) {
      const health = await matchingHealth(
        root,
        current.pid,
        current.childPid,
        settings,
        Date.now() - 10_000,
      );
      return {
        status: health ? "ALREADY_RUNNING" : "DEGRADED",
        pid: current.pid,
        childPid: health?.pid || current.childPid || null,
        model: settings.model,
        maxConcurrent: settings.maxConcurrent,
        idleTtlSeconds: settings.idleTtlSeconds,
        modelCalls: 0,
      };
    }
    await stopManager(lock, current, root);
  }
  await safeDirectory(path.join(root, "runtime", "logs"));
  const log = path.join(root, "runtime", "logs", "codex-bridge-service.log");
  const descriptor = openSync(log, "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      filename,
      "--managed",
      "--instance",
      root,
      "--model",
      settings.model,
      "--concurrency",
      String(settings.maxConcurrent),
      "--idle-ttl-seconds",
      String(settings.idleTtlSeconds),
      "--settings-hash",
      settingsHash,
    ],
    {
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      env: bridgeEnvironment(),
    },
  );
  child.unref();
  closeSync(descriptor);
  const startedAt = Date.now();
  const deadline = Date.now() + managerStartTimeoutMilliseconds;
  while (Date.now() < deadline) {
    await pause(500);
    if (!alive(child.pid)) break;
    const record = await managerRecord(lock);
    if (record?.pid !== child.pid || record.settingsHash !== settingsHash)
      continue;
    const health = await matchingHealth(
      root,
      child.pid,
      record.childPid,
      settings,
      startedAt,
    );
    if (health)
      return {
        status: "STARTED",
        pid: child.pid,
        childPid: health.pid,
        model: settings.model,
        maxConcurrent: settings.maxConcurrent,
        idleTtlSeconds: settings.idleTtlSeconds,
        securityPreflightVerified: true,
        workContextPreflightVerified: true,
        modelCalls: 0,
      };
  }
  const record = await managerRecord(lock);
  return {
    status: "DEGRADED",
    pid: alive(child.pid) ? child.pid : null,
    childPid: record?.childPid || null,
    model: settings.model,
    maxConcurrent: settings.maxConcurrent,
    idleTtlSeconds: settings.idleTtlSeconds,
    reason: "Bridge 未在启动期限内通过安全与上下文预检，请检查宿主日志",
    modelCalls: 0,
  };
}

async function managedBridge(values) {
  const runtime = await loadInstanceRuntime(values.instance);
  await resolveStorageOwner(runtime.root);
  const settings = {
    autoStart: true,
    enabled: true,
    model: values.model,
    maxConcurrent: Number(values.concurrency),
    idleTtlSeconds: Number(values["idle-ttl-seconds"]),
  };
  bridgeServiceConfiguration({
    assistant: { codexBridge: settings },
    capabilities: { assistantEnabled: true },
  });
  const expectedSettingsHash = configHash({
    instanceId: runtime.instanceId,
    runtimeEpoch: runtime.runtimeEpoch,
    profileRevisionId: runtime.profileRevisionId,
    releaseId: runtime.releaseId,
    softwareCommit: runtime.softwareCommit,
    settings,
  });
  if (values["settings-hash"] !== expectedSettingsHash)
    throw new Error("Managed Bridge settings no longer match the published runtime");
  const lockDirectory = await safeDirectory(
    path.join(runtime.root, "runtime", "locks"),
  );
  const lock = path.join(lockDirectory, path.basename(managerLockName));
  const managerId = `codex-bridge-manager_${randomUUID()}`;
  const base = {
    schemaVersion: "1.0",
    managerId,
    pid: process.pid,
    childPid: null,
    root: runtime.root,
    script: filename,
    scriptSha256: sha256(await readFile(filename)),
    settingsHash: values["settings-hash"],
    settings,
    instanceId: runtime.instanceId,
    runtimeEpoch: runtime.runtimeEpoch,
    profileRevisionId: runtime.profileRevisionId,
    releaseId: runtime.releaseId,
    status: "STARTING",
    startedAt: new Date().toISOString(),
  };
  try {
    await writeFile(lock, JSON.stringify(base) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = await managerRecord(lock);
    if (await verifiedManager(previous, runtime.root))
      throw new Error("本实例已有 Codex Bridge 托管服务");
    await removeIfPresent(lock);
    await writeFile(lock, JSON.stringify(base) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  let stopping = false;
  let bridge = null;
  const stop = () => {
    stopping = true;
    if (bridge && alive(bridge.pid)) bridge.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const starts = [];
  try {
    while (!stopping) {
      const now = Date.now();
      const firstRecent = starts.findIndex((started) => now - started <= 600_000);
      if (firstRecent === -1) starts.length = 0;
      else if (firstRecent > 0) starts.splice(0, firstRecent);
      if (starts.length >= 5) {
        await atomicJson(lock, {
          ...base,
          childPid: null,
          status: "DEGRADED_RESTART_LIMIT",
          restartCount: starts.length,
          checkedAt: new Date().toISOString(),
        });
        break;
      }
      starts.push(now);
      bridge = spawn(
        process.env.REVIEW_UV_BINARY || "uv",
        bridgePythonArguments(
          settings,
          "serve",
          process.env.REVIEW_CODEX_BINARY,
        ),
        {
          cwd: applicationRoot,
          stdio: "inherit",
          env: {
            ...bridgeEnvironment(),
            REVIEW_INSTANCE_ROOT: runtime.root,
            REVIEW_NODE_BINARY: process.execPath,
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
      );
      await atomicJson(lock, {
        ...base,
        childPid: bridge.pid,
        status: starts.length === 1 ? "STARTING" : "RESTARTING",
        restartCount: starts.length - 1,
        checkedAt: new Date().toISOString(),
      });
      const outcome = await new Promise((resolve) => {
        bridge.once("error", (error) => resolve({ error }));
        bridge.once("exit", (code, signal) => resolve({ code, signal }));
      });
      bridge = null;
      if (stopping) break;
      process.stderr.write(
        JSON.stringify({
          status: "BRIDGE_RESTART_PENDING",
          code: outcome.code ?? null,
          signal: outcome.signal ?? null,
          error: outcome.error?.message || null,
          attempt: starts.length,
        }) + "\n",
      );
      await pause(Math.min(16_000, 1_000 * 2 ** (starts.length - 1)));
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (bridge && alive(bridge.pid)) {
      bridge.kill("SIGTERM");
      await new Promise((resolve) => bridge.once("exit", resolve));
    }
    const current = await managerRecord(lock);
    if (current?.managerId === managerId) await removeIfPresent(lock);
  }
}

export async function runBridge(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      instance: { type: "string" },
      command: { type: "string", default: "serve" },
      check: { type: "boolean" },
      managed: { type: "boolean" },
      model: {
        type: "string",
        default: DEFAULT_CODEX_BRIDGE_CONFIGURATION.model,
      },
      concurrency: {
        type: "string",
        default: String(DEFAULT_CODEX_BRIDGE_CONFIGURATION.maxConcurrent),
      },
      "idle-ttl-seconds": {
        type: "string",
        default: String(DEFAULT_CODEX_BRIDGE_CONFIGURATION.idleTtlSeconds),
      },
      "codex-binary": { type: "string" },
      "settings-hash": { type: "string" },
    },
  });
  if (!values.instance && !process.env.REVIEW_INSTANCE_ROOT)
    throw new Error("REVIEW_INSTANCE_ROOT or --instance is required");
  if (values.managed) {
    if (
      values.command !== "serve" ||
      values.check ||
      !/^[a-f0-9]{64}$/.test(values["settings-hash"] || "")
    )
      throw new Error("Managed Bridge requires an exact service settings hash");
    await managedBridge(values);
    return;
  }
  const runtime = await loadInstanceRuntime(values.instance);
  const settings = {
    autoStart: false,
    enabled: true,
    model: values.model,
    maxConcurrent: Number(values.concurrency),
    idleTtlSeconds: Number(values["idle-ttl-seconds"]),
  };
  bridgeServiceConfiguration({
    assistant: { codexBridge: settings },
    capabilities: { assistantEnabled: true },
  });
  if (values.check) {
    process.stdout.write(
      JSON.stringify(
        {
          mode: "PLAN_ONLY",
          instanceId: runtime.instanceId,
          projectId: runtime.profile.projectId,
          releaseId: runtime.releaseId,
          capabilityProfile: "READ_ONLY_ADVICE",
          contextMode: runtime.profile.assistant.contextMode,
          schedulerProtocol: runtime.profile.assistant.schedulerProtocol,
          conversationAuthority: "INSTANCE_AUX_RECORDS",
          storageBackend:
            runtime.bootstrap.schemaVersion === "2.0" ? "postgres" : "sqlite",
          storageTransport: "VERIFIED_OWNER_CLI",
          runtimeEpoch: runtime.runtimeEpoch,
          profileRevisionId: runtime.profileRevisionId,
          modelCalls: 0,
          requiresHostCodexLogin: true,
          model: settings.model,
          concurrency: settings.maxConcurrent,
          idleTtlSeconds: settings.idleTtlSeconds,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  await resolveStorageOwner(runtime.root);
  if (!runtime.runtimeEpoch || !runtime.profileRevisionId)
    throw new Error("Bridge requires an epoch-bound, release-bound runtime CLI");
  const child = spawn(
    process.env.REVIEW_UV_BINARY || "uv",
    bridgePythonArguments(settings, values.command, values["codex-binary"]),
    {
      cwd: applicationRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        REVIEW_INSTANCE_ROOT: runtime.root,
        REVIEW_NODE_BINARY: process.execPath,
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Bridge exited with ${signal || code || "UNKNOWN"}`)),
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await runBridge(process.argv.slice(2));
