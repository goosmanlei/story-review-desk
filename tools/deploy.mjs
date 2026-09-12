#!/usr/bin/env node
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  json,
  atomic,
  exists,
  requireValue,
  run,
  health,
  assertFreePort,
} from "./io.mjs";
import {
  processLock,
  beginPhase,
  checkProcessTask,
  releaseConsumer,
  processIdentity,
  processAlive,
  reapRetiredProcessImages,
  phaseRecords,
  readProcessConfig,
  ProcessPhase,
} from "./process-resources.mjs";
import {
  resolveSource,
  snapshotSource,
  verifyInstalledSoftware,
  installSoftware,
  buildRelease,
  provisionDatabase,
  activateLocal,
  updateCorePin,
  retireReleases,
  reconcileSoftware,
  maintenance,
  runtimeDependencies,
} from "./deployment.mjs";

const help = `审阅台自助部署

  npm run deploy                         默认本地，部署核心仓库当前 Git HEAD
  npm run deploy -- --target local        仅本地
  npm run deploy -- --target vps-bj       仅 VPS，使用冻结的本地业务基线
  npm run deploy -- --target all          本地成功后发布 VPS
  npm run deploy -- --target all --dry-run
  npm run deploy -- --source CORE_DIRECTORY
  npm run deploy -- --status OPERATION_ID
  npm run deploy -- --resume OPERATION_ID

启动时固定完整提交 SHA；未提交和未跟踪文件不进入包，执行期间 HEAD 改变不影响本次版本。
不自动提交、拉取、合并或推送。默认源位置读取 instance/runtime/machine.json。
退出码：0 全部成功且清理完成；2 含跳过；1 失败、结果未知或清理未完成。
--dry-run 只读检查，不构建、不切换服务、不修改实例。\n`;
export function parseDeploymentArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      target: { type: "string", default: "local" },
      source: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean" },
      "dry-run": { type: "boolean" },
      status: { type: "string" },
      resume: { type: "string" },
    },
  }).values;
}
function operationId(id) {
  requireValue(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(id || ""),
    "操作编号无效",
  );
  return id;
}
const targets = (value) => (value === "all" ? ["local", "vps-bj"] : [value]);
export function deploymentExit(receipt) {
  if (receipt.kind === "REMOTE_TARGET")
    return receipt.status === "SUCCEEDED" && receipt.cleanup === "CLEANED"
      ? 0
      : 1;
  if (
    receipt.cleanup !== "CLEANED" ||
    Object.values(receipt.targets).some((t) =>
      ["FAILED", "RESULT_UNKNOWN", "RUNNING", "PENDING"].includes(t.status),
    )
  )
    return 1;
  return Object.values(receipt.targets).some((t) => t.status === "SKIPPED")
    ? 2
    : 0;
}
export async function inspectDeployment(root, values) {
  requireValue(
    ["local", "vps-bj", "all"].includes(values.target),
    "目标须为 local、vps-bj 或 all",
  );
  const instance = await json(path.join(root, "instance/instance.json"));
  requireValue(
    instance.schemaVersion === "3.0",
    "请先在独立空白实例完成迁移；部署入口不会隐式改写旧项目",
  );
  const machine = await json(path.join(root, "instance/runtime/machine.json")),
    selected = await resolveSource(values.source || machine.sourceRepository);
  const installed = await verifyInstalledSoftware(root),
    active = await json(path.join(root, "instance/runtime/active.json")).catch(
      () => null,
    );
  requireValue(
    !active || active.instanceId === instance.id,
    "当前运行指针属于其他实例",
  );
  const chosen = targets(values.target);
  for (const name of chosen)
    if (name !== "local") {
      const target = machine.targets?.[name];
      requireValue(
        target &&
          typeof target.sshHost === "string" &&
          typeof target.projectRoot === "string" &&
          path.posix.isAbsolute(target.projectRoot),
        "请在本机配置中填写 VPS sshHost、projectRoot 和 port",
      );
      requireValue(
        !target.sshHost.startsWith("-") &&
          !/[\s\x00-\x1f]/.test(target.sshHost),
        "SSH 目标无效",
      );
    }
  const dependencies = runtimeDependencies();
  if (!active && chosen.includes("local"))
    await assertFreePort(machine.port, machine.listenHost || "127.0.0.1");
  if (active) {
    const running = await health(machine.apiUrl, { instanceId: instance.id });
    requireValue(running.schemaVersion === 1, "当前数据库版本不受支持");
  }
  return {
    root,
    instance,
    machine,
    selected,
    installed,
    active,
    targets: chosen,
    dependencies,
  };
}
export async function installSourceOnly(root, source) {
  const selected = await resolveSource(source),
    id = randomUUID(),
    task = "create-" + id,
    phase = await beginPhase(root, task, "software");
  try {
    const frozen = path.join((await phase.read()).resources[0].path, "source"),
      manifest = await snapshotSource(selected, frozen);
    await installSoftware(root, frozen, manifest, {
      operationId: id,
      phase,
      updatePin: true,
    });
    await releaseConsumer(root, task, "activation");
  } finally {
    const receipt = await phase.finish();
    requireValue(receipt.status === "CLEANED", "创建项目的软件安装清理未完成");
  }
}
export async function main(argv = process.argv.slice(2)) {
  const values = parseDeploymentArgs(argv);
  if (values.help) {
    console.log(help);
    return;
  }
  const root = path.resolve(values.project || "."),
    runtime = path.join(root, "instance/runtime");
  if (values.status) {
    const receipt = await json(
      path.join(runtime, "deployments", operationId(values.status) + ".json"),
    );
    console.log(JSON.stringify(receipt, null, 2));
    process.exitCode = deploymentExit(receipt);
    return receipt;
  }
  if (values["dry-run"]) {
    const inspection = await inspectDeployment(root, values),
      result = {
        status: "DRY_RUN",
        operation: "no mutation",
        targets: inspection.targets,
        commit: inspection.selected.commit,
        source: inspection.selected.source,
        uncommittedExcluded: inspection.selected.dirty,
        instanceId: inspection.instance.id,
        dependencies: inspection.dependencies,
      };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  requireValue(await exists(runtime), "尚未创建标准项目");
  return processLock(path.join(runtime, "deploy.lock"), async () => {
    const state = await json(path.join(runtime, "deploy-state.json")).catch(
      () => null,
    );
    let receipt, inspection, id;
    if (values.resume) {
      id = operationId(values.resume);
      receipt = await json(path.join(runtime, "deployments", id + ".json"));
      requireValue(
        !processAlive(receipt.owner),
        "原部署进程仍在运行，请查询状态",
      );
      requireValue(
        !state?.pendingOperation || state.pendingOperation === id,
        "另一个部署操作尚未处理",
      );
      const machine = await json(path.join(runtime, "machine.json")),
        instance = await json(path.join(root, "instance/instance.json"));
      requireValue(instance.id === receipt.instanceId, "实例身份已改变");
      const selected = await resolveSource(receipt.source, receipt.commit);
      inspection = {
        root,
        machine,
        instance,
        selected,
        targets: Object.keys(receipt.targets),
      };
    } else {
      requireValue(
        !state?.pendingOperation,
        "前一部署尚未核清；使用 --status 或 --resume " +
          state?.pendingOperation,
      );
      inspection = await inspectDeployment(root, values);
      id = randomUUID();
      receipt = {
        schemaVersion: "1.0",
        operationId: id,
        instanceId: inspection.instance.id,
        commit: inspection.selected.commit,
        source: inspection.selected.source,
        createdAt: new Date().toISOString(),
        targets: Object.fromEntries(
          inspection.targets.map((t) => [t, { status: "PENDING" }]),
        ),
        cleanup: "PENDING",
        attempt: 0,
      };
    }
    receipt.owner = processIdentity();
    receipt.attempt++;
    const journal = path.join(runtime, "deployments", id + ".json"),
      task = "deploy-" + id;
    const save = async () => {
      receipt.updatedAt = new Date().toISOString();
      await atomic(journal, receipt);
    };
    await save();
    await atomic(path.join(runtime, "deploy-state.json"), {
      pendingOperation: id,
    });
    await atomic(path.join(root, ".process/tasks", task, "task.json"), {
      status: "OPEN",
      taskId: task,
      runnerIdentity: receipt.owner,
    });
    const phase = await beginPhase(root, task, "attempt-" + receipt.attempt);
    let unsettled = false,
      maintenanceRelease;
    try {
      await reconcileSoftware(root);
      const frozen = path.join(
          (await phase.read()).resources[0].path,
          "source",
        ),
        manifest = await snapshotSource(inspection.selected, frozen);
      for (const target of inspection.targets) {
        if (receipt.targets[target].status === "SUCCEEDED") continue;
        const targetReceipt = receipt.targets[target];
        targetReceipt.status = "RUNNING";
        await save();
        try {
          if (target === "local") {
            const active = await json(path.join(runtime, "active.json")).catch(
              () => null,
            );
            if (values.resume && active?.operationId === id) {
              const { activeRelease, startService } = await import(
                "./service.mjs"
              );
              await activeRelease(root);
              try {
                await health(inspection.machine.apiUrl, {
                  commit: receipt.commit,
                  instanceId: receipt.instanceId,
                  worker: true,
                });
              } catch {
                await startService(root, { commit: receipt.commit });
              }
              const proof = await health(inspection.machine.apiUrl, {
                commit: receipt.commit,
                instanceId: receipt.instanceId,
                worker: true,
              });
              const installed = await verifyInstalledSoftware(root);
              requireValue(
                installed.commit === receipt.commit,
                "软件切换尚未完成",
              );
              await maintenance(root, id, { enabled: false });
              await releaseConsumer(root, task, "activation");
              await updateCorePin(root, manifest);
              Object.assign(targetReceipt, {
                status: "SUCCEEDED",
                stage: "VERIFIED",
                proof,
                reconciled: true,
              });
              await save();
              continue;
            }
            targetReceipt.stage = "BUILDING";
            await save();
            const built = await buildRelease(root, frozen, manifest, {
              phase,
              operationId: id + "-" + receipt.attempt,
            });
            targetReceipt.stage = "DATABASE";
            await save();
            const database = await provisionDatabase(root, built.release, {
              phase,
            });
            maintenanceRelease = built.release;
            targetReceipt.stage = "DRAINING";
            await save();
            await maintenance(root, id, {
              enabled: true,
              release: built.release,
            });
            targetReceipt.stage = "INSTALLING_SOFTWARE";
            await save();
            await installSoftware(root, frozen, manifest, {
              operationId: id + "-" + receipt.attempt,
              phase,
            });
            const proof = await activateLocal(root, built, {
              phase,
              operationId: id,
              saveJournal: async (update) => {
                Object.assign(targetReceipt, update);
                await save();
              },
            });
            await maintenance(root, id, {
              enabled: false,
              release: built.release,
            });
            maintenanceRelease = null;
            await updateCorePin(root, manifest);
            await releaseConsumer(root, task, "activation");
            Object.assign(targetReceipt, {
              status: "SUCCEEDED",
              proof,
              database,
              release: path.relative(root, built.release),
            });
          } else {
            const { deployRemote } = await import("./remote.mjs");
            Object.assign(
              targetReceipt,
              await deployRemote(root, {
                operationId: id,
                commit: receipt.commit,
                frozen,
                manifest,
                phase,
                target: inspection.machine.targets[target],
                resume: Boolean(values.resume),
                save: async (update) => {
                  Object.assign(targetReceipt, update);
                  await save();
                },
              }),
            );
          }
        } catch (error) {
          targetReceipt.status = [
            "SWITCHING",
            "RESTORING",
            "RESULT_UNKNOWN",
            "REMOTE_STARTED",
          ].includes(targetReceipt.stage)
            ? "RESULT_UNKNOWN"
            : "FAILED";
          targetReceipt.error = error.message;
          await save();
          if (target === "local") break;
        }
        await save();
      }
    } catch (error) {
      receipt.error = error.message;
      for (const t of Object.values(receipt.targets))
        if (t.status === "RUNNING") t.status = "FAILED";
    } finally {
      unsettled = Object.values(receipt.targets).some(
        (t) => t.status === "RESULT_UNKNOWN" || t.status === "RUNNING",
      );
      try {
        if (!unsettled) {
          if (maintenanceRelease)
            await maintenance(root, id, {
              enabled: false,
              release: maintenanceRelease,
            });
          await releaseConsumer(root, task, "activation");
        }
        const finished = await phase.finish({
          outcome: Object.values(receipt.targets).every(
            (t) => t.status === "SUCCEEDED",
          )
            ? "SUCCEEDED"
            : "FAILED",
        });
        receipt.cleanup = finished.status;
        if (!unsettled && finished.status === "CLEANED") {
          const config = await readProcessConfig(root);
          for (const { file, record } of await phaseRecords(root, task)) {
            if (file === phase.file || record.status === "CLEANED") continue;
            requireValue(!processAlive(record.owner), "旧阶段仍在运行");
            const result = await new ProcessPhase(
              config,
              file,
              record.token,
            ).finish({
              recover: true,
              outcome: record.outcome || "INTERRUPTED",
            });
            requireValue(result.status === "CLEANED", "旧阶段清理未完成");
          }
          await retireReleases(root);
          await reapRetiredProcessImages(root);
          await checkProcessTask(root, task);
          await atomic(path.join(root, ".process/tasks", task, "task.json"), {
            status: "COMPLETE",
            taskId: task,
          });
          await rm(path.join(root, ".process/tasks", task), {
            recursive: true,
          });
        }
      } catch (error) {
        receipt.cleanup = "CLEANUP_REQUIRED";
        receipt.cleanupError = error.message;
      }
      delete receipt.owner;
      await save();
      if (!unsettled && receipt.cleanup === "CLEANED")
        await atomic(path.join(runtime, "deploy-state.json"), {
          pendingOperation: null,
          lastOperation: id,
        });
    }
    process.exitCode = deploymentExit(receipt);
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(JSON.stringify({ status: "FAILED", error: error.message }));
    process.exitCode = 1;
  });
