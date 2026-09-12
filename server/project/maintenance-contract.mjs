import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { check, hash, identity } from "../shared/contracts.mjs";
import { fileSha } from "../transport-contract.mjs";
export const maintenanceKinds = [
  "MAINTENANCE_VERIFY",
  "MAINTENANCE_BACKUP",
  "MAINTENANCE_RESTORE",
  "MAINTENANCE_EXPORT",
  "MAINTENANCE_IMPORT",
];
export function workspaceMaintenanceRequest(input,{operationId,runtimeEpoch}) {
  const kind={import:'MAINTENANCE_IMPORT',verify:'MAINTENANCE_VERIFY',backup:'MAINTENANCE_BACKUP',restore:'MAINTENANCE_RESTORE',export:'MAINTENANCE_EXPORT'}[input.action];
  check(kind,'MAINTENANCE_ACTION','维护动作无效');
  const request={kind,operationId,runtimeEpoch,...(kind==='MAINTENANCE_IMPORT'?{sourcePath:input.sourcePath}:{}),...(kind==='MAINTENANCE_RESTORE'?{backupId:input.backupId,targetName:input.target,explicit:true}:{})};
  validateMaintenance(request);return request;
}
const taskId = (id) => "maintenance-" + hash(id).slice(0, 24);
export async function ownedBackup(pool, root, id) {
  identity(id);
  const row = (
    await pool.query(
      "SELECT result FROM operations WHERE id=$1 AND kind IN ('MAINTENANCE_BACKUP','MAINTENANCE_EXPORT','MAINTENANCE_IMPORT') AND status='SUCCEEDED'",
      [id],
    )
  ).rows[0];
  check(
    row?.result?.backupId === id,
    "BACKUP_NOT_FOUND",
    "请选择本实例已核验的完整备份",
    404,
  );
  const expected = path.join(
    path.dirname(root),
    ".process/stages",
    taskId(id),
    "execute",
  );
  check(
    row.result.directory === expected,
    "BACKUP_OWNERSHIP",
    "备份登记路径发生改变",
    409,
  );
  const info = await lstat(expected).catch(() => null);
  check(
    info?.isDirectory() && !info.isSymbolicLink(),
    "BACKUP_MISSING",
    "已登记备份缺失或不是普通目录",
    409,
  );
  return row.result;
}
export function validateMaintenance(request) {
  check(
    maintenanceKinds.includes(request.kind),
    "MAINTENANCE_KIND",
    "维护任务类型无效",
  );
  if(request.kind==="MAINTENANCE_IMPORT")check((typeof request.filename==="string"&&/^[a-f0-9]{64}$/.test(request.sha256))||(typeof request.sourcePath==="string"&&path.isAbsolute(request.sourcePath)),"PACKAGE_INPUT","请选择完整项目包文件或项目内的业务包目录");
  if (request.kind === "MAINTENANCE_RESTORE") {
    identity(request.backupId);
    check(
      typeof request.targetName === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(request.targetName),
      "RESTORE_NAME",
      "新实例目录名须为 1–64 位字母、数字、横线或下划线",
    );
    check(
      request.explicit === true,
      "RESTORE_CONFIRMATION",
      "请明确确认恢复到独立新实例",
    );
  }
}
export async function maintenanceState(pool) {
  const rows = (
    await pool.query(
      `SELECT id,kind,status,result,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM operations WHERE kind=ANY($1::text[]) ORDER BY created_at DESC LIMIT 100`,
      [maintenanceKinds],
    )
  ).rows;
  return {
    operations: rows.map(r=>({...r,operationId:r.id,action:{MAINTENANCE_VERIFY:'verify',MAINTENANCE_BACKUP:'backup',MAINTENANCE_RESTORE:'restore',MAINTENANCE_EXPORT:'export',MAINTENANCE_IMPORT:'import'}[r.kind],error:r.error?.message||r.error||null})),
    backups: rows
      .filter(
        (r) => ['MAINTENANCE_BACKUP','MAINTENANCE_EXPORT','MAINTENANCE_IMPORT'].includes(r.kind) && r.status === "SUCCEEDED",
      )
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        sha256: r.result?.sha256,
        mediaFiles: r.result?.mediaFiles,
        downloadUrl:
          "/api/v1/maintenance/" + encodeURIComponent(r.id) + "/download",
      })),
  };
}
export async function backupDownload(pool, root, id) {
  const backup = await ownedBackup(pool, root, id),
    file = path.join(backup.directory, "project-package.tar"),
    info = await lstat(file);
  check(
    info.isFile() &&
      !info.isSymbolicLink() &&
      (await fileSha(file)) === backup.archiveSha256,
    "BACKUP_HASH",
    "备份归档与核验 SHA 不符",
    409,
  );
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Length": String(info.size),
      "Content-Disposition":
        'attachment; filename="review-project-package.tar"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
