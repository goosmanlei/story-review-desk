import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
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
async function importPackage(phase,root,request,directory){
  const target=path.join(directory,'package');
  if(request.filename){
    check(path.dirname(request.filename)===path.join(root,'runtime/spool')&&(await fileSha(request.filename))===request.sha256,'PACKAGE_UPLOAD_HASH','上传文件与登记 SHA 不符',409);
    const unpacked=path.join(directory,'unpacked');
    await new Promise((resolve,reject)=>{
      const child=spawn('python3',['-I',path.join(path.dirname(fileURLToPath(import.meta.url)),'unpack_package.py'),request.filename,unpacked],{stdio:'ignore'});
      const registered=child.pid?phase.childStarted(child.pid):Promise.resolve();child.once('error',reject);child.once('close',async code=>{try{await registered;await phase.childEnded();check(code===0,'PACKAGE_ARCHIVE','项目包归档无效、路径不安全或超过临时预算');resolve();}catch(e){reject(e);}});
    });
    await rename(path.join(unpacked,'package'),target);
  }else{
    const allowed=path.join(path.dirname(root),'project-data'),source=path.resolve(request.sourcePath),relative=path.relative(allowed,source);
    check(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'PACKAGE_SCOPE','目录导入仅接受本项目 project-data 内的完整项目包；其他备份不在读取范围',409);
    let current=allowed;for(const part of ['',...relative.split(path.sep)]){if(part)current=path.join(current,part);const info=await lstat(current);check(info.isDirectory()&&!info.isSymbolicLink(),'PACKAGE_DIRECTORY','项目包路径不能使用符号链接');}
    const manifest=await verifyPackage(source);await mkdir(target,{mode:0o700});
    const names=['manifest.json',...manifest.chunks.map(c=>c.path),...manifest.media.map(m=>'media/'+m.sha256),...manifest.originals.map(s=>'originals/'+s)];
    for(const name of names){await mkdir(path.dirname(path.join(target,name)),{recursive:true});await copyFile(path.join(source,name),path.join(target,name),1);}
  }
  return verifyPackage(target);
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
    const manifest = request.kind==="MAINTENANCE_IMPORT"?await importPackage(phase,root,request,directory):await writePackageRecords(
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
    if (['MAINTENANCE_BACKUP','MAINTENANCE_EXPORT','MAINTENANCE_IMPORT'].includes(request.kind)) {
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
