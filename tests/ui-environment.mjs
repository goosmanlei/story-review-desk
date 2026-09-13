// Managed, isolated browser fixture. Optional mirroring uses the public export
// and exact registered SHA files. All model responses are controlled test data.
import {
  mkdir,
  readFile,
  writeFile,
  cp,
  symlink,
  link,
  lstat,
} from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import { requiredPhase } from "../tools/process-resources.mjs";
import { createProject } from "../tools/project.mjs";
import { resolveSource, snapshotSource } from "../tools/deployment.mjs";
import { importRecords, fileSha } from "../server/transfer.mjs";
import { execute } from "../server/commands.mjs";
import { runMaintenance } from "../server/project/maintenance.mjs";
import { workOnce } from "../server/jobs.mjs";

const { values } = parseArgs({
  options: {
    mirror: { type: "string" },
    "media-root": { type: "string" },
    port: { type: "string", default: "3911" },
    standalone: { type: "boolean" },
    blank: { type: "boolean" },
    supplement: { type: "string" },
    committed: { type: "boolean" },
  },
});
const phase = await requiredPhase(process.cwd());
if (!phase) throw Error("Use the managed process runner");
const workspace = process.env.REVIEW_TASK_DIR,
  source = path.join(workspace, "source"),
  project = path.join(workspace, "project"),
  port = Number(values.port);
await mkdir(source);
let softwareCommit = "UI-DEVELOPMENT";
if (values.committed) {
  const selected = await resolveSource(process.cwd());
  await snapshotSource(selected, source);
  softwareCommit = selected.commit;
} else
  for (const name of [
    "web",
    "server",
    "tools",
    "scripts",
    "docs",
    "tests",
    "package.json",
    "package-lock.json",
  ])
    await cp(path.resolve(name), path.join(source, name), {
      recursive: true,
      filter: (p) =>
        !p.includes(path.sep + ".next") && !p.endsWith(".tsbuildinfo"),
    });
await symlink(path.resolve("node_modules"), path.join(source, "node_modules"));
execFileSync(process.execPath,[path.join(source,'tools/handbook.mjs'),'build'],{cwd:source,env:process.env,stdio:'inherit'});
const container = "review-ui-" + randomUUID();
const labels = await phase.expect("container", container);
execFileSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    container,
    ...labels,
    "--tmpfs",
    "/var/lib/postgresql:rw,size=1g",
    "-e",
    "POSTGRES_USER=review",
    "-e",
    "POSTGRES_DB=review",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "postgres:18.6",
  ],
  { stdio: "pipe" },
);
await phase.capture("container", container);
const info = JSON.parse(
  execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
)[0];
const database = {
  host: "127.0.0.1",
  port: Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort),
  user: "review",
  database: "review",
};
const pool = new pg.Pool({ ...database, max: 4 });
for (let i = 0; ; i++) {
  try {
    await pool.query("SELECT 1");
    break;
  } catch (e) {
    if (i > 100) throw e;
    await new Promise((r) => setTimeout(r, 100));
  }
}
await pool.query(await readFile("server/schema.sql", "utf8"));
const instanceId = "ui-fixture-" + randomUUID();
await createProject(project, {
  title: "界面验收实例",
  port,
  database,
  instanceId,
  initializeGit: false,
});
await pool.query(
  "INSERT INTO project(instance_id,runtime_epoch,title) VALUES($1,$2,'界面验收实例')",
  [instanceId, randomUUID()],
);
if (values.mirror) {
  if (!values["media-root"])
    throw Error("Mirroring requires the registered media root");
  const file = path.join(workspace, "fixture.ndjson");
  const response = await fetch(new URL("/api/v1/export", values.mirror));
  if (!response.ok) throw Error("Fixture export failed");
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(file, { flags: "wx", mode: 0o600 }),
  );
  const hashes = new Set();
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })) {
    const r = JSON.parse(line);
    if (
      r.table !== "media" ||
      r.row.availability !== "PRESENT" ||
      hashes.has(r.row.sha256)
    )
      continue;
    const sha = r.row.sha256;
    if (!/^[a-f0-9]{64}$/.test(sha)) throw Error("Invalid media SHA");
    hashes.add(sha);
    const original = path.join(path.resolve(values["media-root"]), sha),
      target = path.join(project, "instance/media", sha);
    const st = await lstat(original);
    if (!st.isFile() || st.isSymbolicLink())
      throw Error("Unregistered media path");
    await link(original, target);
  }
  const imported = await importRecords(pool, file, {
    expectedSha256: await fileSha(file),
    mediaRoot: path.join(project, "instance/media"),
  });
  console.log(
    JSON.stringify({
      fixture: "IMPORTED",
      objects: imported.counts.objects,
      media: imported.verifiedMedia,
    }),
  );
} else if(!values.blank) {
  const save = async (id, kind, content, links = []) => {
    const r = await execute(pool, {
      operationId: randomUUID(),
      commands: [
        {
          type: "save",
          id,
          kind,
          title: id,
          content,
          links,
          expectedVersion: 0,
        },
      ],
    });
    if (r.status !== "SUCCEEDED") throw Error(JSON.stringify(r));
  };
  await save("原始故事", "SOURCE", {
    text: "雨后的车站，旅人发现一封尚未寄出的信。",
    authority: "F",
  });
  for (let ep = 1; ep <= 3; ep++) {
    const scenes = [];
    for (let scene = 1; scene <= 3; scene++) {
      const id = "episode-" + ep + "-scene-" + scene;
      scenes.push({ id, role: "SCENE" });
      await save(id, "SCENE", {
        blocks: [
          {
            id: id + "-action",
            type: "action",
            text: "灯光照着站台，旅人停下脚步，核对信封上的名字。",
          },
          {
            id: id + "-dialogue",
            type: "dialogue",
            speaker: "旅人",
            text: "这封信似乎还在等待它的收信人。",
          },
        ],
        purpose: "让人物得到新的线索",
        runtime: { baseSec: 24 },
      });
    }
    await save(
      "episode-" + ep,
      "EPISODE",
      {
        coreAdvance: "发现一条新的线索",
        reviewDossier: {
          purpose: { episodeTask: { text: "建立人物的寻找目标", class: "A" } },
          payoff: { deliveredResult: { text: "人物决定继续寻找", class: "A" } },
        },
      },
      scenes,
    );
  }
  await save("旅人", "ENTITY", {
    type: "CHARACTER",
    description: "来寻找信件收件人的旅人",
  });
  await save("车站", "ENTITY", {
    type: "LOCATION",
    description: "雨后的火车站",
  });
  await save(
    "同行",
    "RELATION",
    { type: "REFERENCE", label: "寻找", status: "CONFIRMED" },
    [
      { id: "旅人", role: "ENTITY" },
      { id: "车站", role: "ENTITY" },
    ],
  );
  await save("素材需求", "REQUIREMENT", {
    mediaType: "IMAGE",
    description: "车站空间",
    storyBasis: { whyNeeded: "建立人物行动的空间依据" },
  });
  await save(
    "空间母图",
    "MATERIAL",
    { kind: "IMAGE", description: "用于空间连续性核对" },
    [
      { id: "车站", role: "ENTITY" },
      { id: "素材需求", role: "REQUIREMENT" },
    ],
  );
  await save(
    "制作准备",
    "PREPARATION",
    {
      sourceSummary: "人物在站台发现线索",
      visualIntent: "先交代环境，再跟随人物",
    },
    [{ id: "episode-1-scene-1", role: "SCENE" }],
  );
}
let running = true,
  ticking = false;
const tick = setInterval(async () => {
  if (ticking || !running) return;
  ticking = true;
  try {
    await pool.query(
      "INSERT INTO runtime_status(name,value,updated_at) VALUES('worker',$1,now()) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [
        {
          workerId: "controlled-ui-fixture",
          softwareCommit,
          capabilities: ["AI_SUGGEST", "MEDIA_REGISTER"],
        },
      ],
    );
    await workOnce(pool, {
      root: path.join(project, "instance"),
      workerId: "controlled-ui-fixture",
      providers: {
        maintenance: (request) =>
          runMaintenance(pool, path.join(project, "instance"), request),
        suggest: async ({ object }) => ({
          summary: "受控模拟：建议将意见明确为可核对的修改点。",
          patch:
            object.kind === "COMMENT"
              ? { text: object.revision.content.text + "（受控模拟优化）" }
              : { description: "受控模拟建议" },
          sourceVersions: [],
        }),
      },
    });
  } catch (e) {
    console.error("fixture-worker", e.code || e.message);
  } finally {
    ticking = false;
  }
}, 500);
if(values.supplement){
  const value=JSON.parse(await readFile(values.supplement,'utf8'));
  if(value.schemaVersion!=='UI_RESTORATION_SOURCES_V1'||!Array.isArray(value.commands)||value.commands.some(c=>c.type!=='save'||c.kind!=='SOURCE'||c.expectedVersion!==0||!['NARRATIVE_SUPPORT','SPATIAL_CATALOG','ARCHIVED_EPISODE_PLAN'].includes(c.content?.role)))throw Error('Invalid restoration supplement');
  const runtimeEpoch=(await pool.query('SELECT runtime_epoch FROM project')).rows[0].runtime_epoch;
  const receipt=await execute(pool,{operationId:'ui-original-restored-sources',runtimeEpoch,commands:value.commands});
  if(receipt.status!=='SUCCEEDED')throw Error(JSON.stringify(receipt));
  console.log(JSON.stringify({restoredSources:value.commands.length,sourceOperationId:receipt.operationId}));
}
if (values.standalone) {
  const build = spawn(
    process.execPath,
    [
      path.resolve("node_modules/next/dist/bin/next"),
      "build",
      "web",
      "--webpack",
    ],
    {
      cwd: source,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
    },
  );
  const code = await new Promise((resolve, reject) => {
    build.once("exit", resolve);
    build.once("error", reject);
  });
  if (code !== 0) throw Error("Standalone build failed");
  await cp(
    path.join(source, "web/.next/static"),
    path.join(source, "web/.next/standalone/web/.next/static"),
    { recursive: true },
  );
}
const child = spawn(
  process.execPath,
  values.standalone
    ? [path.join(source, "web/.next/standalone/web/server.js")]
    : [
        path.resolve("node_modules/next/dist/bin/next"),
        "dev",
        "web",
        "--webpack",
        "--port",
        String(port),
        "--hostname",
        "127.0.0.1",
      ],
  {
    cwd: source,
    env: {
      ...process.env,
      REVIEW_INSTANCE_ROOT: path.join(project, "instance"),
      REVIEW_SOFTWARE_COMMIT: softwareCommit,
      REVIEW_DOCUMENTATION_ROOT: path.join(source, "web/.handbook"),
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
console.log(
  JSON.stringify({
    fixture: "STARTING",
    url: "http://127.0.0.1:" + port,
    source,
    project,
    instanceId,
  }),
);
const stop = () => {
  running = false;
  clearInterval(tick);
  child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise((resolve, reject) => {
  child.once("exit", resolve);
  child.once("error", reject);
});
stop();
while (ticking) await new Promise((r) => setTimeout(r, 50));
await pool.end();
