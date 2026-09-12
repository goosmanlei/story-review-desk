import {
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  rm,
  realpath,
  lstat,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "../server/shared/contracts.mjs";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import {
  exists,
  json,
  run,
  command,
  atomic,
  requireValue,
  treeManifest,
  verifyTree,
  freePort,
  token,
  health,
} from "./io.mjs";
import { activeRelease, startService, stopService } from "./service.mjs";
import {
  phaseRecords,
  readProcessConfig,
  ProcessPhase,
} from "./process-resources.mjs";

export function runtimeDependencies(){
  const [major,minor]=process.versions.node.split('.').map(Number);
  requireValue(major>22||major===22&&minor>=13,'需要 Node.js 22.13 或更新版本');
  return {node:process.version,npm:run('npm',['--version']),docker:run('docker',['version','--format','{{.Server.Version}}']),python:run('python3',['--version']),ffmpeg:run('ffmpeg',['-version']).split('\n')[0],ffprobe:run('ffprobe',['-version']).split('\n')[0]};
}

export async function resolveSource(directory, commit) {
  const source = await realpath(directory),
    top = await realpath(
      run("git", ["-C", source, "rev-parse", "--show-toplevel"]),
    );
  requireValue(top === source, "--source 须指向核心仓库根目录");
  const selected = commit || run("git", ["-C", source, "rev-parse", "HEAD"]);
  requireValue(/^[a-f0-9]{40}$/.test(selected), "Git 提交 SHA 无效");
  run("git", ["-C", source, "cat-file", "-e", selected + "^{commit}"]);
  const pkg = JSON.parse(
    run("git", ["-C", source, "show", selected + ":package.json"]),
  );
  requireValue(pkg.name === "story-review-desk", "选定提交不是通用审阅台核心");
  run("git", ["-C", source, "cat-file", "-e", selected + ":server/schema.sql"]);
  run("git", ["-C", source, "cat-file", "-e", selected + ":tools/deploy.mjs"]);
  return {
    source,
    commit: selected,
    dirty: Boolean(
      run("git", [
        "--no-optional-locks",
        "-C",
        source,
        "status",
        "--porcelain",
      ]),
    ),
  };
}
export async function snapshotSource(selected, destination) {
  await mkdir(destination, { recursive: true });
  const git = spawn(
      "git",
      ["-C", selected.source, "archive", "--format=tar", selected.commit],
      { stdio: ["ignore", "pipe", "pipe"] },
    ),
    tar = spawn("tar", ["-xf", "-", "-C", destination], {
      stdio: ["pipe", "ignore", "pipe"],
    });
  git.stdout.pipe(tar.stdin);
  git.stderr.resume();
  tar.stderr.resume();
  const [[a], [b]] = await Promise.all([once(git, "exit"), once(tar, "exit")]);
  requireValue(a === 0 && b === 0, "无法从选定 Git 提交导出干净源码");
  return { commit: selected.commit, files: await treeManifest(destination) };
}
export async function verifyInstalledSoftware(root) {
  const directory = path.join(root, "review-software");
  if (!(await exists(directory))) return null;
  if (!(await readdir(directory)).length) return null;
  const manifest = await json(
    path.join(directory, ".review-managed.json"),
  ).catch(() => null);
  requireValue(
    manifest?.schemaVersion === "1.0",
    "review-software 存在无法确认归属的文件",
  );
  await verifyTree(directory, manifest.files, {
    exclude: [".review-managed.json"],
  });
  return manifest;
}
export async function installSoftware(
  root,
  source,
  manifest,
  { operationId, phase, updatePin = false } = {},
) {
  const previous = await verifyInstalledSoftware(root),
    target = path.join(root, "review-software"),
    candidate = path.join(root, ".process/shared", operationId + "-software");
  await phase.directory(candidate);
  await cp(source, candidate, { recursive: true });
  await atomic(path.join(candidate, ".review-managed.json"), {
    schemaVersion: "1.0",
    ...manifest,
  });
  await verifyTree(candidate, manifest.files, {
    exclude: [".review-managed.json"],
  });
  const displaced = path.join(
    root,
    ".process/shared",
    operationId + "-previous-software",
  );
  requireValue(
    !(await exists(displaced)),
    "软件替换的恢复目录已存在，请按原操作续作",
  );
  // Record both locations before rename; recovery only reconciles these exact trees.
  await atomic(path.join(root, "instance/runtime/software-switch.json"), {
    operationId,
    target,
    candidate,
    displaced,
    previous,
    next: { schemaVersion: "1.0", ...manifest },
    status: "PREPARED",
  });
  if (await exists(target)) {
    const info = await lstat(target);
    await phase.update((r) =>
      r.resources.push({
        kind: "path",
        path: displaced,
        dev: info.dev,
        ino: info.ino,
        state: "INTENT",
        consumers: ["activation"],
      }),
    );
    await rename(target, displaced);
    await phase.update((r) => {
      r.resources.find((x) => x.path === displaced).state = "TEMPORARY";
    });
  }
  try {
    await rename(candidate, target);
  } catch (e) {
    if ((await exists(displaced)) && !(await exists(target)))
      await rename(displaced, target);
    throw e;
  }
  await phase.retain(
    "path",
    candidate,
    "受管软件已原子移入 review-software，源位置不再存在",
  );
  if (updatePin) await updateCorePin(root, manifest);
  // A previous source tree is reconstructible from its verified Git manifest.
  if (await exists(displaced)) {
    if (previous)
      await verifyTree(displaced, previous.files, {
        exclude: [".review-managed.json"],
      });
    else
      requireValue(
        !(await readdir(displaced)).length,
        "旧软件目录出现未知文件",
      );
  }
  await atomic(path.join(root, "instance/runtime/software-switch.json"), {
    operationId,
    target,
    candidate,
    displaced,
    previous,
    next: { schemaVersion: "1.0", ...manifest },
    status: "INSTALLED",
  });
}
export async function updateCorePin(root, manifest) {
  await atomic(path.join(root, "core-lock.json"), {
    schemaVersion: "3.0",
    repository: "https://github.com/goosmanlei/story-review-desk",
    commit: manifest.commit,
    filesSha256: (await import("../server/shared/contracts.mjs")).hash(
      manifest.files,
    ),
  });
}

export async function reconcileSoftware(root) {
  const file = path.join(root, "instance/runtime/software-switch.json"),
    journal = await json(file).catch(() => null);
  if (!journal || journal.status !== "PREPARED") return;
  requireValue(
    journal.target === path.join(root, "review-software") &&
      [journal.candidate, journal.displaced].every(
        (p) => path.dirname(p) === path.join(root, ".process/shared"),
      ),
    "软件切换记录路径无效",
  );
  const target = await exists(journal.target),
    candidate = await exists(journal.candidate),
    displaced = await exists(journal.displaced);
  if (target) {
    const installed = await verifyInstalledSoftware(root);
    if (installed?.commit === journal.next.commit) {
      await atomic(file, { ...journal, status: "INSTALLED" });
      return;
    }
    requireValue(
      !displaced && installed?.commit === journal.previous?.commit && candidate,
      "软件替换现场与原清单不一致",
    );
    await verifyTree(journal.candidate, journal.next.files, {
      exclude: [".review-managed.json"],
    });
    await rename(journal.target, journal.displaced);
    await rename(journal.candidate, journal.target);
  } else if (candidate) {
    await verifyTree(journal.candidate, journal.next.files, {
      exclude: [".review-managed.json"],
    });
    await rename(journal.candidate, journal.target);
  } else {
    requireValue(displaced, "软件替换恢复输入缺失");
    await verifyTree(journal.displaced, journal.previous.files, {
      exclude: [".review-managed.json"],
    });
    await rename(journal.displaced, journal.target);
    await atomic(file, { ...journal, status: "RESTORED" });
    return;
  }
  await verifyInstalledSoftware(root);
  await atomic(file, { ...journal, status: "INSTALLED" });
}

export async function databaseConnection(root, release) {
  const machine = await json(path.join(root, "instance/runtime/machine.json"));
  if (!release) release = (await activeRelease(root)).release;
  const { default: pg } = await import(
      pathToFileURL(path.join(release, "node_modules/pg/lib/index.js"))
    ),
    connection = { ...machine.database };
  const password = connection.passwordFile
    ? (await readFile(connection.passwordFile, "utf8")).trim()
    : connection.passwordEnv
      ? process.env[connection.passwordEnv]
      : undefined;
  delete connection.passwordFile;
  delete connection.passwordEnv;
  return new pg.Pool({
    ...connection,
    password,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
}

export async function maintenance(
  root,
  operationId,
  { enabled, release, timeoutMs = 60000 } = {},
) {
  const pool = await databaseConnection(root, release);
  try {
    await pool.query("BEGIN");
    await pool.query("SELECT pg_advisory_xact_lock(890670314)");
    const current = (
      await pool.query(
        "SELECT value FROM runtime_status WHERE name='maintenance'",
      )
    ).rows[0]?.value;
    requireValue(
      !current?.enabled || current.operationId === operationId,
      "其他部署维护尚未结束",
    );
    await pool.query(
      "INSERT INTO runtime_status(name,value) VALUES('maintenance',$1) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=now()",
      [{ enabled, operationId }],
    );
    await pool.query("COMMIT");
    if (enabled) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const jobs = (
          await pool.query(
            "SELECT id,status FROM operations WHERE status IN ('QUEUED','RUNNING','RESULT_UNKNOWN') LIMIT 101",
          )
        ).rows;
        requireValue(
          !jobs.some((x) => x.status === "RESULT_UNKNOWN"),
          "存在结果未知的操作；先按原操作编号核查",
        );
        if (!jobs.length) break;
        requireValue(
          Date.now() < deadline,
          "工作器尚未结束；保留原服务，稍后按原部署续作",
        );
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
}
export async function retireReleases(root) {
  if (!(await exists(path.join(root, "instance/runtime/retention.json"))))
    return [];
  const policy = await readProcessConfig(root),
    retention = await json(path.join(root, "instance/runtime/retention.json")),
    protectedPaths = new Set(
      retention.protectedHotPaths.map((x) => path.resolve(root, x.path)),
    ),
    removed = [];
  for (const { file, record } of await phaseRecords(root)) {
    if (record.status !== "CLEANED") continue;
    for (const resource of record.resources.filter(
      (r) =>
        r.kind === "path" &&
        r.state === "RETAINED" &&
        r.path.startsWith(
          path.join(root, "instance/runtime/releases") + path.sep,
        ) &&
        !protectedPaths.has(r.path),
    )) {
      if (!(await exists(resource.path))) continue;
      const metadata = await json(path.join(resource.path, "release.json"));
      requireValue(metadata.instanceId === policy.projectId, "恢复包归属不明");
      await verifyTree(resource.path, metadata.files, {
        exclude: ["release.json"],
      });
      const phase = new ProcessPhase(policy, file, record.token);
      await phase.update((r) => {
        r.resources.find((x) => x.path === resource.path).state = "TEMPORARY";
        r.status = "CLEANUP_REQUIRED";
      });
      const result = await phase.finish({
        recover: true,
        outcome: record.outcome,
      });
      requireValue(result.status === "CLEANED", "旧运行包清理未完成");
      removed.push(resource.path);
    }
  }
  return removed;
}
export async function buildRelease(
  root,
  frozen,
  manifest,
  { phase, operationId } = {},
) {
  const scratch = (await phase.read()).resources[0].path,
    build = path.join(scratch, "build");
  await cp(frozen, build, { recursive: true });
  const environment = {
    ...process.env,
    ...(await phase.environment()),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const npm = run("which", ["npm"]);
  await command(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: build,
    env: environment,
  });
  await command(
    process.execPath,
    [
      path.join(build, "node_modules/next/dist/bin/next"),
      "build",
      "web",
      "--webpack",
    ],
    { cwd: build, env: environment },
  );
  const instance = await json(path.join(root, "instance/instance.json")),
    release = path.join(
      root,
      "instance/runtime/releases",
      operationId + "-" + process.platform + "-" + process.arch,
    );
  await phase.directory(release);
  await cp(path.join(build, "web/.next/standalone"), release, {
    recursive: true,
  });
  await cp(
    path.join(build, "web/.next/static"),
    path.join(release, "web/.next/static"),
    { recursive: true },
  );
  await cp(path.join(frozen, "server"), path.join(release, "server"), {
    recursive: true,
  });
  await mkdir(path.join(release, "scripts"), { recursive: true });
  await cp(
    path.join(frozen, "scripts/worker.mjs"),
    path.join(release, "scripts/worker.mjs"),
  );
  await cp(path.join(frozen, "tools"), path.join(release, "tools"), {
    recursive: true,
  });
  const metadata = {
    schemaVersion: "1.0",
    instanceId: instance.id,
    commit: manifest.commit,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    files: await treeManifest(release),
  };
  await atomic(path.join(release, "release.json"), metadata);
  return { release, metadata, build };
}
export async function provisionDatabase(
  root,
  release,
  { phase, databaseSalt = "", retain = true } = {},
) {
  const instance = await json(path.join(root, "instance/instance.json")),
    filename = path.join(root, "instance/runtime/machine.json"),
    machine = await json(filename);
  if (!machine.database) {
    const key = token(instance.id + databaseSalt),
      name = "review-db-" + key,
      volume = "review-db-data-" + key,
      credential = path.join(
        root,
        "instance/runtime/credentials/database.secret",
      ),
      journalFile = path.join(root, "instance/runtime/database-provision.json");
    let journal = await json(journalFile).catch(() => null);
    if (!journal) {
      requireValue(
        !(await exists(credential)),
        "存在未归属的数据库凭据，未覆盖",
      );
      journal = {
        instanceId: instance.id,
        name,
        volume,
        port: await freePort(),
        credential,
        status: "PREPARED",
      };
      await atomic(journalFile, journal);
    }
    requireValue(
      journal.instanceId === instance.id &&
        journal.name === name &&
        journal.volume === volume &&
        journal.credential === credential,
      "数据库初始化范围发生改变",
    );
    await mkdir(path.dirname(credential), { recursive: true, mode: 0o700 });
    let password;
    if (await exists(credential)) {
      const bytes = await readFile(credential);
      requireValue(
        hash(bytes) === journal.credentialSha256,
        "数据库凭据文件出现未知修改",
      );
      password = bytes.toString().trim();
    } else {
      requireValue(
        !phase.object("container", name) && !phase.object("volume", volume),
        "数据库恢复所需凭据缺失",
      );
      password = randomUUID() + randomUUID();
      journal.credentialSha256 = hash(Buffer.from(password + "\n"));
      await atomic(journalFile, journal);
      await writeFile(credential, password + "\n", { flag: "wx", mode: 0o600 });
    }
    const verifyExisting = async (kind, name) => {
      const actual = phase.object(kind, name);
      if (!actual) return false;
      const labels =
        kind === "container" ? actual.Config?.Labels : actual.Labels;
      const owner = (await phaseRecords(phase.config.root)).find(
        (x) =>
          x.record.token === labels?.["review.process.token"] &&
          x.record.projectId === labels?.["review.process.project"] &&
          x.record.resources.some((r) => r.kind === kind && r.name === name),
      );
      requireValue(
        owner && labels?.["review.process.project"] === phase.config.projectId,
        "数据库资源属于未知任务，未接管",
      );
      const ownedPhase = new ProcessPhase(
        await readProcessConfig(phase.config.root),
        owner.file,
        owner.record.token,
      );
      await ownedPhase.update((r) => {
        const resource = r.resources.find(
          (x) => x.kind === kind && x.name === name,
        );
        ownedPhase.assertObject(r, resource, actual);
        resource.expectedId = actual.Id || actual.Name;
        if (retain) {
          resource.state = "RETAINED";
          resource.reason = "正式数据库初始化及恢复点";
        }
      });
      return actual;
    };
    if (!(await verifyExisting("volume", volume))) {
      const labels = await phase.expect("volume", volume);
      if (retain)
        await phase.retain("volume", volume, "正式数据库初始化及恢复点");
      run("docker", ["volume", "create", ...labels, volume]);
      await phase.capture("volume", volume);
      if (retain) await phase.retain("volume", volume, "正式实例数据库卷");
    }
    const container = await verifyExisting("container", name);
    if (!container) {
      const labels = await phase.expect("container", name);
      if (retain)
        await phase.retain("container", name, "正式数据库初始化及恢复点");
      const envFile = path.join(
        (await phase.read()).resources[0].path,
        "postgres-" + randomUUID() + ".env",
      );
      await writeFile(
        envFile,
        "POSTGRES_USER=review\nPOSTGRES_DB=review\nPOSTGRES_PASSWORD=" +
          password +
          "\n",
        { mode: 0o600, flag: "wx" },
      );
      try {
        run("docker", [
          "run",
          "-d",
          "--name",
          name,
          ...labels,
          "--restart",
          "unless-stopped",
          "--env-file",
          envFile,
          "-p",
          "127.0.0.1:" + journal.port + ":5432",
          "-v",
          volume + ":/var/lib/postgresql",
          "postgres:18.6",
        ]);
        await phase.capture("container", name);
        if (retain)
          await phase.retain("container", name, "正式实例 PostgreSQL 服务");
      } finally {
        await rm(envFile);
      }
    } else if (!container.State.Running) run("docker", ["start", name]);
    machine.database = {
      host: "127.0.0.1",
      port: journal.port,
      database: "review",
      user: "review",
      passwordFile: credential,
    };
    machine.managedDatabase = { container: name, volume };
    await atomic(filename, machine);
    await atomic(journalFile, { ...journal, status: "READY" });
  }
  const { default: pg } = await import(
      pathToFileURL(path.join(release, "node_modules/pg/lib/index.js"))
    ),
    connection = { ...machine.database };
  const password = connection.passwordFile
    ? (await readFile(connection.passwordFile, "utf8")).trim()
    : connection.passwordEnv
      ? process.env[connection.passwordEnv]
      : undefined;
  delete connection.passwordFile;
  delete connection.passwordEnv;
  const pool = new pg.Pool({
    ...connection,
    password,
    max: 2,
    connectionTimeoutMillis: 5000,
  });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (e) {
        if (attempt >= 100) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const installed = (
      await pool.query("SELECT to_regclass('public.schema_version') AS name")
    ).rows[0].name;
    if (!installed) {
      await pool.query("BEGIN");
      try {
        await pool.query(
          await readFile(path.join(release, "server/schema.sql"), "utf8"),
        );
        await pool.query(
          "INSERT INTO project(instance_id,runtime_epoch,title) VALUES($1,$2,$3)",
          [instance.id, randomUUID(), instance.title],
        );
        await pool.query(
          "INSERT INTO configurations(scope,version,content) VALUES('system',1,'{}'),('project',1,$1)",
          [{ title: instance.title, locale: "zh-CN" }],
        );
        await pool.query("COMMIT");
      } catch (e) {
        await pool.query("ROLLBACK");
        throw e;
      }
    }
    const identity = (await pool.query("SELECT instance_id FROM project"))
      .rows[0];
    requireValue(
      identity?.instance_id === instance.id,
      "数据库绑定了其他实例，拒绝接管",
    );
    requireValue(
      (await pool.query("SELECT max(version) AS version FROM schema_version"))
        .rows[0].version === 1,
      "数据库 Schema 与软件不兼容",
    );
    return { schemaVersion: 1, instanceId: instance.id };
  } finally {
    await pool.end();
  }
}
export async function activateLocal(
  root,
  built,
  { phase, operationId, saveJournal, restoreOnFailure = true } = {},
) {
  const { release, metadata } = built,
    instance = await json(path.join(root, "instance/instance.json")),
    prior = await json(path.join(root, "instance/runtime/active.json")).catch(
      () => null,
    );
  await verifyTree(release, metadata.files, { exclude: ["release.json"] });
  const next = {
    schemaVersion: "1.0",
    instanceId: instance.id,
    commit: metadata.commit,
    release: path.relative(root, release),
    operationId,
  };
  await saveJournal({ stage: "SWITCHING", previous: prior, next });
  await stopService(root);
  await atomic(path.join(root, "instance/runtime/retention.json"), {
    protectedHotPaths: [
      { path: next.release, reason: "当前运行软件" },
      ...(prior ? [{ path: prior.release, reason: "上一版软件恢复点" }] : []),
    ],
  });
  await phase.retain("path", release, "当前运行软件及部署恢复点");
  await atomic(path.join(root, "instance/runtime/active.json"), next);
  try {
    const proof = await startService(root, { commit: metadata.commit });
    await atomic(path.join(root, "instance/runtime/previous.json"), prior);
    await saveJournal({ stage: "VERIFIED", proof });
    return proof;
  } catch (error) {
    if (!restoreOnFailure) throw error;
    await saveJournal({ stage: "RESTORING", error: error.message });
    await stopService(root);
    if (prior) {
      await atomic(path.join(root, "instance/runtime/active.json"), prior);
      await startService(root, { commit: prior.commit });
      await saveJournal({ stage: "RESTORED", error: error.message });
    } else {
      await rm(path.join(root, "instance/runtime/active.json"), {
        force: true,
      });
      await saveJournal({ stage: "RESTORED", error: error.message });
    }
    throw error;
  }
}

export async function retireDatabases(root) {
  const retention = await json(
    path.join(root, "instance/runtime/database-retention.json"),
  ).catch(() => null);
  if (!retention) return [];
  const protectedNames = new Set(
      [retention.current, retention.previous]
        .filter(Boolean)
        .flatMap((x) => [
          x.managedDatabase?.container,
          x.managedDatabase?.volume,
        ]),
    ),
    protectedDirectories = new Set(
      [retention.current?.directory, retention.previous?.directory].filter(
        Boolean,
      ),
    );
  const policy = await readProcessConfig(root),
    removed = [];
  for (const { file, record } of await phaseRecords(root)) {
    if (record.status !== "CLEANED") continue;
    const candidates = record.resources.filter(
      (x) =>
        x.state === "RETAINED" &&
        ((["container", "volume"].includes(x.kind) &&
          /^review-db(-data)?-/.test(x.name) &&
          !protectedNames.has(x.name)) ||
          (x.kind === "path" &&
            x.path.startsWith(
              path.join(root, "instance/runtime/database-recovery") + path.sep,
            ) &&
            !protectedDirectories.has(x.path))),
    );
    if (!candidates.length) continue;
    const phase = new ProcessPhase(policy, file, record.token);
    await phase.update((r) => {
      for (const x of r.resources)
        if (
          candidates.some(
            (c) =>
              c.kind === x.kind &&
              (c.name ? c.name === x.name : c.path === x.path),
          )
        )
          x.state = "TEMPORARY";
      r.status = "CLEANUP_REQUIRED";
    });
    const result = await phase.finish({
      recover: true,
      outcome: record.outcome,
    });
    requireValue(result.status === "CLEANED", "旧数据库恢复点清理未完成");
    removed.push(...candidates.map((x) => x.name || x.path));
  }
  return removed;
}
