import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, hash, identity } from "../shared/contracts.mjs";
import { exportRecords, importRecords, fileSha } from "../transfer.mjs";
import {
  packageStream,
  verifyPackage,
  writePackageRecords,
} from "./package.mjs";
import { beginPhase } from "../../tools/process-resources.mjs";
import { createProject } from "../../tools/project.mjs";
import {
  databaseConnection,
  provisionDatabase,
  verifyInstalledSoftware,
} from "../../tools/deployment.mjs";
import { freePort } from "../../tools/io.mjs";

import { validateMaintenance, ownedBackup } from "./maintenance-contract.mjs";
const taskId = (id) => "maintenance-" + hash(id).slice(0, 24);
async function tar(phase, directory) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "tar",
      [
        "-cf",
        path.join(directory, "project-package.tar"),
        "-C",
        directory,
        "package",
      ],
      { stdio: "ignore" },
    );
    const registered = child.pid
      ? phase.childStarted(child.pid)
      : Promise.resolve();
    child.once("error", reject);
    child.once("close", async (code) => {
      try {
        await registered;
        await phase.childEnded();
        check(code === 0, "ARCHIVE_FAILED", "项目包归档未完成");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}
export async function runMaintenance(pool, root, request) {
  validateMaintenance(request);
  const project = path.dirname(root),
    phase = await beginPhase(project, taskId(request.operationId), "execute");
  const directory = (await phase.read()).resources[0].path;
  let outcome = "FAILED",
    restoredPool,
    durable = false;
  try {
    await phase.budget();
    if (request.kind === "MAINTENANCE_RESTORE") {
      const backup = await ownedBackup(pool, root, request.backupId),
        source = path.join(backup.directory, "package"),
        manifest = await verifyPackage(source);
      check(
        manifest.transfer.sha256 === backup.sha256,
        "BACKUP_CHANGED",
        "备份内容与原核验回执不符",
        409,
      );
      const installed = await verifyInstalledSoftware(project);
      check(
        installed,
        "SOFTWARE_REQUIRED",
        "当前实例尚未安装受管软件，不能建立恢复副本",
        409,
      );
      const machine = JSON.parse(
        await readFile(path.join(root, "runtime/machine.json"), "utf8"),
      );
      const target = path.join(directory, request.targetName);
      await createProject(target, {
        title: manifest.project.title,
        source: machine.sourceRepository || undefined,
        port: await freePort(),
        initializeGit: false,
      });
      await cp(
        path.join(project, "review-software"),
        path.join(target, "review-software"),
        { recursive: true },
      );
      await copyFile(
        path.join(project, "core-lock.json"),
        path.join(target, "core-lock.json"),
        1,
      );
      const runtime = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../..",
      );
      await provisionDatabase(target, runtime, { phase, retain: false });
      restoredPool = await databaseConnection(target, runtime);
      for (const media of manifest.media)
        await copyFile(
          path.join(source, "media", media.sha256),
          path.join(target, "instance/media", media.sha256),
          1,
        );
      const transfer = path.join(directory, "restore.ndjson");
      await pipeline(
        Readable.from(packageStream(source, manifest)),
        createWriteStream(transfer, { flags: "wx", mode: 0o600 }),
      );
      const imported = await importRecords(restoredPool, transfer, {
        expectedSha256: manifest.transfer.sha256,
        mediaRoot: path.join(target, "instance/media"),
      });
      const restored = (
        await restoredPool.query(
          "SELECT instance_id AS id,runtime_epoch AS epoch FROM project",
        )
      ).rows[0];
      // Local guidance is a controlled copy of the restored adopted revisions.
      const guides = (
        await restoredPool.query(
          "SELECT r.content,s.logical_path AS \"sourcePath\" FROM objects o JOIN revisions r ON r.id=o.adopted_revision_id LEFT JOIN source_documents s ON s.original_revision_id=r.content->>'originalRevisionId' WHERE o.kind='GUIDANCE'",
        )
      ).rows;
      for (const { content, sourcePath } of guides) {
        const alias = content.logicalPath || content.path || sourcePath;
        if (
          typeof alias === "string" &&
          /^(README|AGENTS|STATE)\.md$|^guidance\/(story-review|materials|production|review-ui|operations)\.md$/.test(
            alias,
          ) &&
          typeof content.text === "string"
        )
          await writeFile(path.join(target, alias), content.text);
      }
      await restoredPool.end();
      restoredPool = null;
      // Retain the project and its database in one receipt update. A partial
      // handoff must never preserve a database while cleaning its project.
      await phase.update((record) => {
        for (const resource of record.resources) {
          if (["container", "volume"].includes(resource.kind)) {
            resource.state = "RETAINED";
            resource.reason =
              "已核验的独立恢复实例数据库；由用户管理，不自动删除";
          } else if (resource.kind === "path" && resource.path === directory) {
            resource.state = "RETAINED";
            resource.reason =
              "已核验的独立恢复项目；当前实例未切换，不自动删除";
          }
        }
      });
      durable = true;
      outcome = "SUCCEEDED";
      return {
        operationId: request.operationId,
        status: "RESTORED_VERIFIED",
        target,
        instanceId: restored.id,
        runtimeEpoch: restored.epoch,
        sha256: manifest.transfer.sha256,
        counts: imported.counts,
        mediaFiles: manifest.media.length,
        started: false,
      };
    }
    const destination = path.join(directory, "package");
    const manifest = await writePackageRecords(
      Readable.from(exportRecords(pool)),
      destination,
      {
        copyMedia: async (m, file) => {
          const source = path.join(root, "media", m.sha256),
            info = await lstat(source);
          check(
            info.isFile() && !info.isSymbolicLink(),
            "MEDIA_PATH",
            "登记媒体不是普通文件",
            409,
          );
          await copyFile(source, file, 1);
        },
      },
    );
    await verifyPackage(destination);
    await phase.budget();
    const result = {
      operationId: request.operationId,
      status:
        request.kind === "MAINTENANCE_VERIFY"
          ? "INSTANCE_VERIFIED"
          : "BACKUP_VERIFIED",
      sha256: manifest.transfer.sha256,
      counts: manifest.counts,
      mediaFiles: manifest.media.length,
      passed: true,
    };
    if (request.kind === "MAINTENANCE_BACKUP") {
      await tar(phase, directory);
      await phase.budget();
      Object.assign(result, {
        backupId: request.operationId,
        directory,
        archiveSha256: await fileSha(
          path.join(directory, "project-package.tar"),
        ),
      });
      await phase.retain(
        "path",
        directory,
        "用户创建并核验的完整业务备份；不自动删除，不读取封存旧项目备份",
      );
      durable = true;
    }
    outcome = "SUCCEEDED";
    return result;
  } catch (error) {
    if (durable) {
      outcome = "RESULT_UNKNOWN";
      error.requiresRecovery = true;
    }
    throw error;
  } finally {
    await restoredPool?.end();
    try {
      await phase.finish({ outcome });
    } catch (error) {
      if (durable) error.requiresRecovery = true;
      throw error;
    }
  }
}
