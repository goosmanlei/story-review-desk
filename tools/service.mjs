#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  rename,
  rm,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  atomic,
  json,
  exists,
  run,
  requireValue,
  token,
  health,
  verifyTree,
} from "./io.mjs";
import {
  processIdentity,
  processAlive,
  sweepProcessTasks,
} from "./process-resources.mjs";

export async function activeRelease(root) {
  const instance = await json(path.join(root, "instance/instance.json")),
    active = await json(path.join(root, "instance/runtime/active.json"));
  requireValue(
    active.instanceId === instance.id && /^[a-f0-9]{40}$/.test(active.commit),
    "运行指针身份或版本无效",
  );
  const release = path.resolve(root, active.release);
  requireValue(
    release.startsWith(path.join(root, "instance/runtime/releases") + path.sep),
    "运行路径不属于当前实例",
  );
  const metadata = await json(path.join(release, "release.json"));
  requireValue(
    metadata.commit === active.commit && metadata.instanceId === instance.id,
    "运行包身份不符",
  );
  await verifyTree(release, metadata.files, { exclude: ["release.json"] });
  return { instance, active, release };
}
async function logWriter(root) {
  const directory = path.join(root, "instance/runtime/logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let sequence = 0,
    bytes = 0,
    file = path.join(directory, Date.now() + "-" + process.pid + "-0.log"),
    pending = Promise.resolve();
  const trim = async () => {
    const files = [];
    for (const name of await readdir(directory)) {
      if (!/^\d+-\d+-\d+\.log$/.test(name)) continue;
      const p = path.join(directory, name),
        s = await lstat(p);
      if (s.isFile() && !s.isSymbolicLink()) files.push({ p, s });
    }
    files.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs);
    let total = 0;
    for (const item of files) {
      total += item.s.size;
      if (
        item.p !== file &&
        (total > 95 * 1024 * 1024 || Date.now() - item.s.mtimeMs > 7 * 86400000)
      )
        await rm(item.p);
    }
  };
  await trim();
  return {
    write(chunk) {
      pending = pending.then(async () => {
        if (bytes + chunk.length > 4 * 1024 * 1024) {
          bytes = 0;
          file = path.join(
            directory,
            Date.now() + "-" + process.pid + "-" + ++sequence + ".log",
          );
          await trim();
        }
        await appendFile(file, chunk, { mode: 0o600 });
        bytes += chunk.length;
      });
    },
    flush: () => pending,
    trim,
  };
}
export async function serve(root) {
  const { instance, active, release } = await activeRelease(root),
    machine = await json(path.join(root, "instance/runtime/machine.json")),
    runtime = path.join(root, "instance/runtime/service.json"),
    previous = await json(runtime).catch(() => null);
  requireValue(
    !previous || !processAlive(previous.owner),
    "此实例已有运行中的监督进程",
  );
  const log = await logWriter(root),
    runId = randomUUID(),
    env = {
      ...process.env,
      PATH: machine.servicePath || process.env.PATH,
      NODE_ENV: "production",
      PYTHONDONTWRITEBYTECODE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      REVIEW_INSTANCE_ROOT: path.join(root, "instance"),
      REVIEW_SOFTWARE_COMMIT: active.commit,
      PORT: String(machine.port),
      HOSTNAME: machine.listenHost || "127.0.0.1",
    },
    children = [];
  let stopped = false,
    exitCode = 0;
  function start(file) {
    const child = spawn(
      machine.nodeBinary || process.execPath,
      [path.join(release, file)],
      { cwd: release, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout.on("data", log.write);
    child.stderr.on("data", log.write);
    child.once("error", () => stop(1));
    child.once("exit", () => {
      if (!stopped) stop(1);
    });
    return child;
  }
  function stop(code = 0) {
    if (stopped) return;
    stopped = true;
    exitCode = code;
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
  }
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
  try {
    const web = start("web/server.js"),
      worker = start("scripts/worker.mjs");
    await atomic(runtime, {
      runId,
      instanceId: instance.id,
      commit: active.commit,
      owner: processIdentity(),
      web: processIdentity(web.pid),
      worker: processIdentity(worker.pid),
    });
    await sweepProcessTasks(root);
    let lastSweep = Date.now();
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 1000));
      if (Date.now() - lastSweep >= 300000) {
        await sweepProcessTasks(root);
        await log.trim();
        lastSweep = Date.now();
      }
    }
  } finally {
    stop(exitCode);
    const done = Promise.all(
      children.filter((c) => c.exitCode === null).map((c) => once(c, "exit")),
    );
    const timer = setTimeout(() => {
      for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
    }, 10000);
    await done;
    clearTimeout(timer);
    await log.flush();
    if ((await json(runtime).catch(() => null))?.runId === runId)
      await rm(runtime);
    await sweepProcessTasks(root);
  }
  process.exitCode = exitCode;
}
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function systemdServiceContent(root, { nodeBinary, driver, name, system }) {
  requireValue(path.posix.isAbsolute(root) && !/[\r\n]/.test(root) && root.trimEnd() === root,
    "systemd 项目路径须为无换行或尾部空白的绝对路径");
  const quote = (v) => '"' + String(v).replaceAll("%", "%%")
    .replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  // WorkingDirectory is a path value, not an ExecStart argument: systemd
  // preserves quotes here and then rejects the resulting non-absolute path.
  return `[Unit]\nDescription=Story Review ${name}\nAfter=network.target\n[Service]\nType=simple\nExecStart=${[nodeBinary, driver, "run", root].map(quote).join(" ")}\nWorkingDirectory=${root.replaceAll("%", "%%")}\nRestart=always\nRestartSec=5\nTimeoutStopSec=20\n[Install]\nWantedBy=${system ? "multi-user.target" : "default.target"}\n`;
}
export async function installService(root) {
  const instance = await json(path.join(root, "instance/instance.json")),
    machine = await json(path.join(root, "instance/runtime/machine.json")),
    name = "com.story-review." + token(instance.id),
    driver = path.join(root, "review-software/tools/service.mjs");
  const registration = path.join(
      root,
      "instance/runtime/service-installation.json",
    ),
    previous = await json(registration).catch(() => null);
  let filename, content, args;
  if (process.platform === "darwin") {
    filename = path.join(os.homedir(), "Library/LaunchAgents", name + ".plist");
    content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[machine.nodeBinary || process.execPath, driver, "run", root].map((v) => "<string>" + xml(v) + "</string>").join("")}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
    args = { kind: "launchd", domain: "gui/" + process.getuid(), name };
  } else {
    const system = process.getuid() === 0;
    filename = path.join(
      system
        ? "/etc/systemd/system"
        : path.join(os.homedir(), ".config/systemd/user"),
      name + ".service",
    );
    content = systemdServiceContent(root, {
      nodeBinary: machine.nodeBinary || process.execPath,
      driver, name: token(instance.id), system,
    });
    args = { kind: "systemd", system, name: name + ".service" };
  }
  requireValue(!/[\r\n]/.test(root), "项目路径不能包含换行");
  if (await exists(filename))
    requireValue(
      previous?.filename === filename &&
        previous.content === (await readFile(filename, "utf8")),
      "系统服务文件不属于当前实例，未覆盖",
    );
  await mkdir(path.dirname(filename), { recursive: true });
  await atomic(registration, {
    instanceId: instance.id,
    filename,
    content,
    ...args,
  });
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(filename, content, { mode: 0o600 }),
  );
  if (args.kind === "systemd")
    run("systemctl", [...(args.system ? [] : ["--user"]), "daemon-reload"]);
  return args;
}
export async function stopService(root) {
  const installation = await json(
    path.join(root, "instance/runtime/service-installation.json"),
  ).catch(() => null);
  if (!installation) return;
  if (installation.kind === "launchd") {
    try {
      run("launchctl", [
        "bootout",
        installation.domain + "/" + installation.name,
      ]);
    } catch (e) {
      if (!/Could not find service|No such process/.test(String(e.stderr)))
        throw e;
    }
  } else
    run("systemctl", [
      ...(installation.system ? [] : ["--user"]),
      "stop",
      installation.name,
    ]);
  const state = await json(
    path.join(root, "instance/runtime/service.json"),
  ).catch(() => null);
  for (let n = 0; state && processAlive(state.owner); n++) {
    requireValue(n < 200, "服务停止超时，未继续切换");
    await new Promise((r) => setTimeout(r, 100));
  }
}
export async function startService(root, { commit, timeoutMs = 30000 } = {}) {
  const installation = await installService(root);
  await stopService(root);
  if (installation.kind === "launchd") {
    const value = await json(
      path.join(root, "instance/runtime/service-installation.json"),
    );
    run("launchctl", ["bootstrap", installation.domain, value.filename]);
  } else
    run("systemctl", [
      ...(installation.system ? [] : ["--user"]),
      "enable",
      "--now",
      installation.name,
    ]);
  const machine = await json(path.join(root, "instance/runtime/machine.json")),
    instance = await json(path.join(root, "instance/instance.json")),
    deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      return await health(machine.apiUrl, {
        commit,
        instanceId: instance.id,
        worker: true,
      });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last || Error("服务启动超时");
}
export async function uninstallService(root) {
  const file = path.join(root, "instance/runtime/service-installation.json");
  const installed = await json(file).catch(() => null);
  if (!installed) return;
  const instance = await json(path.join(root, "instance/instance.json"));
  requireValue(installed.instanceId === instance.id, "服务登记属于其他实例");
  requireValue(
    (await readFile(installed.filename, "utf8")) === installed.content,
    "系统服务文件有未知修改，未删除",
  );
  await stopService(root);
  if (installed.kind === "systemd")
    run("systemctl", [
      ...(installed.system ? [] : ["--user"]),
      "disable",
      installed.name,
    ]);
  await rm(installed.filename);
  if (installed.kind === "systemd")
    run("systemctl", [
      ...(installed.system ? [] : ["--user"]),
      "daemon-reload",
    ]);
  await rm(file);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, selected] = process.argv.slice(2),
    root = path.resolve(selected || ".");
  const fn = {
    run: serve,
    start: startService,
    stop: stopService,
    install: installService,
    uninstall: uninstallService,
  }[action];
  if (!fn) {
    console.error("service run|start|stop|install PROJECT_DIRECTORY");
    process.exitCode = 1;
  } else await fn(root);
}
