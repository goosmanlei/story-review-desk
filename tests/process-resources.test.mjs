import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
  chmod,
  utimes,
  lstat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginPhase,
  phaseRecords,
  processAlive,
  processIdentity,
  releaseConsumer,
  sweepProcessTasks,
  finishProcessTask,
  trimProcessLogs,
  readProcessConfig,
  requiredPhase,
} from "../tools/process-resources.mjs";
import { runPhase } from "../tools/process.mjs";
const cli = fileURLToPath(new URL("../tools/process.mjs", import.meta.url));
const exists = async (p) =>
  Boolean(
    await lstat(p).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    }),
  );
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "process-fixture-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "instance/runtime"), { recursive: true });
  await mkdir(path.join(root, "output"));
  const docker = path.join(root, "docker.mjs");
  await writeFile(
    docker,
    "#!/usr/bin/env node\n" +
      `import{readFileSync,writeFileSync}from'node:fs';const file=${JSON.stringify(path.join(root, "objects.json"))},s=JSON.parse(readFileSync(file)),a=process.argv.slice(2);if(a[0]==='ps'){console.log(Object.values(s).filter(x=>x.kind==='container').map(x=>x.Name).join('\\n'));process.exit(0)}const key=a[0]+':'+a.at(-1),o=s[key];if(a[1]==='inspect'){if(!o){console.error('No such '+a[0]);process.exit(1)}console.log(JSON.stringify([o]));}else if(a[1]==='rm'){delete s[key];writeFileSync(file,JSON.stringify(s));}else if(a[0]==='stop'){}else{console.error('Unsupported mock docker call '+a);process.exit(2)}`,
  );
  await chmod(docker, 0o755);
  await writeFile(path.join(root, "objects.json"), "{}");
  await writeFile(
    path.join(root, "instance/runtime/process-policy.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      enabled: true,
      projectId: "fixture",
      host: "fixture",
      registry: "receipts",
      parentTasks: "tasks",
      workspace: "scratch",
      temporaryRoots: ["output"],
      protectedPaths: ["formal"],
      maxTemporaryBytes: 1e8,
      reserveBytes: 0,
      dockerBinary: docker,
    }),
  );
  return root;
}
test("successful and failed stages remove their files directly; failures retain only a bounded diagnostic", async (t) => {
  const root = await fixture(t);
  for (const code of [0, 7]) {
    const result = await runPhase({
      root,
      task: "lifecycle",
      phase: "exit-" + code,
      command: [
        process.execPath,
        "-e",
        `require('fs').writeFileSync(process.env.TMPDIR+'/payload',Buffer.alloc(1024*1024));process.exit(${code})`,
      ],
    });
    assert.equal(result.exitCode, code);
    assert.equal(result.status, "CLEANED");
    assert.equal(
      await exists(path.join(root, "scratch/lifecycle/exit-" + code)),
      false,
    );
  }
  assert.equal((await finishProcessTask(root, "lifecycle")).status, "CLEANED");
  const log = await readFile(
    path.join(root, "receipts/logs/lifecycle--exit-7.log"),
  );
  assert(log.length < 1024);
});
test("consumer handoff survives producer cleanup and is released by the named consumer only", async (t) => {
  const root = await fixture(t),
    producer = await beginPhase(root, "handoff", "build"),
    output = await producer.directory(path.join(root, "output/package"));
  await writeFile(path.join(output, "image.tar"), "fixture");
  await producer.transfer("path", output, "deploy");
  assert.equal((await producer.finish()).status, "WAITING_CONSUMERS");
  assert(await exists(output));
  await releaseConsumer(root, "handoff", "other");
  assert(await exists(output));
  await releaseConsumer(root, "handoff", "deploy");
  assert.equal(await exists(output), false);
});
test("CLI parent task preserves a dead producer handoff through sweeps, then closes explicitly", async (t) => {
  const root = await fixture(t),
    output = path.join(root, "output/cli-package"),
    resourceModule = new URL("../tools/process-resources.mjs", import.meta.url).href;
  const invoke = (...args) => JSON.parse(execFileSync(process.execPath,
    [cli, ...args, "--root", root, "--task", "cli-handoff"], { encoding: "utf8" }));
  execFileSync(process.execPath, [cli, "run", "--root", root, "--task", "cli-handoff", "--phase", "build", "--", process.execPath, "--input-type=module", "-e",
    `import{requiredPhase}from ${JSON.stringify(resourceModule)};const p=await requiredPhase(process.cwd());const output=await p.directory(${JSON.stringify(output)});await p.transfer('path',output,'consume');`], { encoding: "utf8" });
  assert(await exists(output));
  assert.equal(JSON.parse(await readFile(path.join(root, "tasks/cli-handoff/task.json"))).status, "OPEN");
  await sweepProcessTasks(root);
  assert(await exists(output), "The producer process has exited, but its parent still owns the handoff");
  execFileSync(process.execPath, [cli, "run", "--root", root, "--task", "cli-handoff", "--phase", "consume", "--", process.execPath, "-e", ""], { encoding: "utf8" });
  assert.equal(await exists(output), false);
  assert.equal(invoke("finish").status, "CLEANED");
  assert.equal(JSON.parse(await readFile(path.join(root, "tasks/cli-handoff/task.json"))).status, "COMPLETED");
  assert.throws(() => execFileSync(process.execPath, [cli, "run", "--root", root, "--task", "cli-handoff", "--phase", "late", "--", process.execPath, "-e", ""], { stdio: "pipe" }), /Command failed/);
});
test("identity drift, unregistered paths, Git work and retained children fail closed", async (t) => {
  const root = await fixture(t),
    phase = await beginPhase(root, "safety", "qa");
  await assert.rejects(phase.directory(path.join(root, "formal")), /retained/);
  await assert.rejects(phase.directory(path.join(root, "outside")), /outside/);
  const output = await phase.directory(path.join(root, "output/owned"));
  await mkdir(path.join(output, ".git"));
  assert.equal((await phase.finish()).status, "CLEANUP_REQUIRED");
  assert(await exists(output));
  await rm(path.join(output, ".git"), { recursive: true });
  assert.equal((await phase.finish()).status, "CLEANED");
  const drift = await beginPhase(root, "safety", "drift"),
    dir = await drift.directory(path.join(root, "output/drift"));
  await rm(dir, { recursive: true });
  await symlink(path.join(root, "output"), dir);
  assert.equal((await drift.finish()).status, "CLEANUP_REQUIRED");
  assert(await exists(path.join(root, "output")));
});
test("only exact labelled Docker identities are removed and foreign objects survive", async (t) => {
  const root = await fixture(t),
    phase = await beginPhase(root, "docker", "qa"),
    record = await phase.read(),
    objects = {};
  for (const kind of ["container", "network", "volume", "image"]) {
    const name = "fixture-" + kind;
    const args = await phase.expect(kind, name),
      labels = {};
    for (let i = 1; i < args.length; i += 2) {
      const [key, value] = args[i].split("=");
      labels[key] = value;
    }
    objects[kind + ":" + name] = {
      kind,
      Name: name,
      Id: "id-" + kind,
      Labels: labels,
      Config: { Labels: labels },
      State: { Running: false },
      Mounts: [],
    };
    await writeFile(path.join(root, "objects.json"), JSON.stringify(objects));
    await phase.capture(kind, name);
  }
  objects["volume:foreign"] = {
    kind: "volume",
    Name: "foreign",
    Id: "foreign",
    Labels: {},
  };
  await writeFile(path.join(root, "objects.json"), JSON.stringify(objects));
  assert.equal((await phase.finish()).status, "CLEANED");
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(path.join(root, "objects.json")))),
    ["volume:foreign"],
  );
  const bad = await beginPhase(root, "docker", "bad");
  await bad.expect("volume", "drift");
  objects["volume:drift"] = {
    kind: "volume",
    Name: "drift",
    Id: "other",
    Labels: {},
  };
  await writeFile(path.join(root, "objects.json"), JSON.stringify(objects));
  assert.equal((await bad.finish()).status, "CLEANUP_REQUIRED");
});
test("a killed runner is reclaimed after its child exits; live phases and reused PIDs are distinguished", async (t) => {
  const root = await fixture(t),
    ready = path.join(root, "ready");
  const child = spawn(
    process.execPath,
    [
      cli,
      "run",
      "--root",
      root,
      "--task",
      "interrupted",
      "--phase",
      "kill",
      "--",
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},800)`,
    ],
    { stdio: "ignore", detached: true },
  );
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  });
  for (let i = 0; i < 100 && !(await exists(ready)); i++)
    await new Promise((r) => setTimeout(r, 30));
  assert(await exists(ready));
  const before = await sweepProcessTasks(root);
  assert.equal(before.results.length, 0);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("close", r));
  await new Promise((r) => setTimeout(r, 1100));
  const swept = await sweepProcessTasks(root);
  assert.equal(swept.status, "CLEANED");
  assert.equal((await phaseRecords(root))[0].record.status, "CLEANED");
  assert(processAlive(processIdentity()));
  assert.equal(
    processAlive({ ...processIdentity(), birth: "another process" }),
    false,
  );
});
test("SIGTERM is forwarded, the child exits, and scratch is removed before return", async (t) => {
  const root = await fixture(t),
    ready = path.join(root, "ready"),
    child = spawn(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--task",
        "cancelled",
        "--phase",
        "qa",
        "--",
        process.execPath,
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
      ],
      { stdio: "ignore" },
    );
  for (let i = 0; i < 100 && !(await exists(ready)); i++)
    await new Promise((r) => setTimeout(r, 30));
  assert(await exists(ready));
  child.kill("SIGTERM");
  await new Promise((r) => child.once("close", r));
  const record = (await phaseRecords(root))[0].record;
  assert.equal(record.status, "CLEANED");
  assert.equal(record.outcome, "CANCELLED");
});
test("remote unknown status blocks completion even after local deletion; retry is idempotent", async (t) => {
  const root = await fixture(t),
    producer = await beginPhase(root, "remote", "pack"),
    output = await producer.directory(path.join(root, "output/package"));
  await producer.transfer("path", output, "deploy");
  await producer.finish();
  const phase = await beginPhase(root, "remote", "deploy");
  await phase.hostReceipt("vps-bj", { status: "UNKNOWN" });
  assert.equal((await phase.finish()).status, "CLEANUP_REQUIRED");
  await assert.rejects(finishProcessTask(root, "remote"), /CLEANUP_REQUIRED/);
  assert(
    await exists(output),
    "the same-operation recovery source must survive unknown remote results",
  );
  await phase.hostReceipt("vps-bj", { status: "CLEANED" });
  assert.equal((await finishProcessTask(root, "remote")).status, "CLEANED");
  assert.equal((await finishProcessTask(root, "remote")).status, "CLEANED");
});
test("registered project entrypoints require a task and old diagnostic logs expire", async (t) => {
  const root = await fixture(t),
    context = process.env.REVIEW_PROCESS_CONTEXT;
  delete process.env.REVIEW_PROCESS_CONTEXT;
  try {
    await assert.rejects(requiredPhase(root), /TASK_REQUIRED/);
  } finally {
    process.env.REVIEW_PROCESS_CONTEXT = context;
  }
  const config = await readProcessConfig(root),
    logs = path.join(root, config.registry, "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, "old.log"), "old");
  await writeFile(path.join(logs, "new.log"), "new");
  await utimes(path.join(logs, "old.log"), new Date(0), new Date(0));
  await trimProcessLogs(config);
  assert.equal(await exists(path.join(logs, "old.log")), false);
  assert(await exists(path.join(logs, "new.log")));
});
