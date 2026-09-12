import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  requiredPhase,
  phaseRecords,
  readProcessConfig,
  ProcessPhase,
} from "../tools/process-resources.mjs";
import { createProject } from "../tools/project.mjs";
import {
  resolveSource,
  snapshotSource,
  updateCorePin,
  databaseConnection,
} from "../tools/deployment.mjs";
import { execute, operation } from "../server/commands.mjs";
import { hash } from "../server/shared/contracts.mjs";
import { readObject } from "../server/repository.mjs";
import { enqueue, workOnce } from "../server/jobs.mjs";
import { runMaintenance } from "../server/project/maintenance.mjs";
import {
  backupDownload,
  maintenanceState,
  validateMaintenance,
} from "../server/project/maintenance-contract.mjs";

test("maintenance backup, download, verification and independent restore share the worker and preserve the source", async (t) => {
  const phase = await requiredPhase(process.cwd());
  assert(phase);
  const root = path.join(process.env.REVIEW_TASK_DIR, "maintenance-project"),
    container = "review-maintenance-fixture-" + randomUUID(),
    labels = await phase.expect("container", container);
  execFileSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      ...labels,
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
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
    )[0],
    database = {
      host: "127.0.0.1",
      port: Number(info.NetworkSettings.Ports["5432/tcp"][0].HostPort),
      database: "review",
      user: "review",
    },
    pool = new pg.Pool({ ...database, max: 3 });
  for (let i = 0; ; i++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  t.after(() => pool.end());
  await createProject(root, {
    database,
    initializeGit: false,
    host: "fixture",
    source: process.cwd(),
    instanceId: "maintenance-fixture",
  });
  await pool.query(await readFile("server/schema.sql", "utf8"));
  await pool.query(
    "INSERT INTO project(instance_id,runtime_epoch,title) VALUES('maintenance-fixture',$1,'验收故事')",
    [randomUUID()],
  );
  await execute(pool, {
    operationId: "seed",
    commands: [
      {
        type: "save",
        id: "story",
        kind: "SCENE",
        title: "验收场次",
        expectedVersion: 0,
        content: { text: "需要完整保留的原稿。" },
      },
    ],
  });
  const guidanceText = "# 当前指引\n\n保留采用正文与已登记路径。\n";
  await execute(pool, {
    operationId: "seed-guidance",
    commands: [
      {
        type: "save",
        id: "guide",
        kind: "GUIDANCE",
        title: "guide",
        expectedVersion: 0,
        content: {
          text: guidanceText,
          originalRevisionId: "guide-source-original",
        },
      },
    ],
  });
  const guide = await readObject(pool, "guide");
  await pool.query(
    "INSERT INTO source_documents(revision_id,original_revision_id,original_sha256,mime_type,content_bytes,logical_path,role) VALUES($1,$2,$3,'text/markdown',$4,'guidance/review-ui.md','PROJECT_GUIDANCE')",
    [
      guide.revision.id,
      "guide-source-original",
      hash(guidanceText),
      Buffer.from(guidanceText),
    ],
  );
  assert.equal(
    (
      await execute(pool, {
        operationId: "adopt-guidance",
        commands: [
          { type: "submit", id: "guide", expectedVersion: guide.version },
          {
            type: "review",
            id: "guide",
            expectedVersion: guide.version + 1,
            revisionId: guide.revision.id,
            decision: "ADOPT",
            explicit: true,
            note: "受控恢复验收",
            findings: [],
          },
        ],
      })
    ).status,
    "SUCCEEDED",
  );
  const selected = await resolveSource(process.cwd()),
    manifest = await snapshotSource(
      selected,
      path.join(root, "review-software"),
    );
  await writeFile(
    path.join(root, "review-software/.review-managed.json"),
    JSON.stringify({ schemaVersion: "1.0", ...manifest }),
  );
  await updateCorePin(root, manifest);
  t.after(async () => {
    const policy = await readProcessConfig(root);
    for (const { file, record } of await phaseRecords(root)) {
      const owned = new ProcessPhase(policy, file, record.token);
      await owned.update((r) => {
        for (const resource of r.resources)
          if (resource.state === "RETAINED") resource.state = "TEMPORARY";
        r.status = "CLEANUP_REQUIRED";
      });
      assert.equal(
        (
          await owned.finish({
            recover: true,
            outcome: "CONTROLLED_FIXTURE_COMPLETED",
          })
        ).status,
        "CLEANED",
      );
    }
  });
  const run = async (kind, extra = {}) => {
    const request = { operationId: randomUUID(), kind, ...extra };
    await enqueue(pool, request);
    assert.equal((await enqueue(pool, request)).replayed, true);
    await workOnce(pool, {
      root: path.join(root, "instance"),
      workerId: "fixture",
      providers: {
        maintenance: (r) =>
          runMaintenance(pool, path.join(root, "instance"), r),
      },
    });
    const result = await operation(pool, request.operationId);
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result.error));
    return result;
  };
  const before = (
    await pool.query(
      "SELECT id,version,draft_revision_id FROM objects ORDER BY id",
    )
  ).rows;
  const backup = await run("MAINTENANCE_BACKUP");
  assert.equal(
    (await maintenanceState(pool)).backups[0].id,
    backup.operationId,
  );
  const download = await backupDownload(
    pool,
    path.join(root, "instance"),
    backup.operationId,
  );
  assert.equal(download.status, 200);
  assert((await download.arrayBuffer()).byteLength > 1000);
  await run("MAINTENANCE_VERIFY");
  const restore = await run("MAINTENANCE_RESTORE", {
    backupId: backup.operationId,
    targetName: "restored-fixture",
    explicit: true,
  });
  assert.notEqual(restore.result.instanceId, "maintenance-fixture");
  assert.equal(
    await readFile(
      path.join(restore.result.target, "guidance/review-ui.md"),
      "utf8",
    ),
    guidanceText,
  );
  const restored = await databaseConnection(
    restore.result.target,
    process.cwd(),
  );
  try {
    assert.deepEqual(
      (
        await restored.query(
          "SELECT id,version,draft_revision_id FROM objects ORDER BY id",
        )
      ).rows,
      before,
    );
    assert.equal(
      (await restored.query("SELECT count(*)::integer n FROM operations"))
        .rows[0].n,
      0,
    );
  } finally {
    await restored.end();
  }
  assert.deepEqual(
    (
      await pool.query(
        "SELECT id,version,draft_revision_id FROM objects ORDER BY id",
      )
    ).rows,
    before,
  );
  assert.throws(
    () =>
      validateMaintenance({
        kind: "MAINTENANCE_RESTORE",
        backupId: backup.operationId,
        targetName: "../jiutouan.backup",
        explicit: true,
      }),
    /目录名/,
  );
  await assert.rejects(
    backupDownload(pool, path.join(root, "instance"), "unknown"),
    /已核验/,
  );
});
