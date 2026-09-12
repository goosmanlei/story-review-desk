#!/usr/bin/env node
import { mkdir, cp, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProject } from "./project.mjs";
import {
  json,
  atomic,
  exists,
  requireValue,
  verifyTree,
  freePort,
  health,
  run,
} from "./io.mjs";
import {
  processLock,
  processIdentity,
  processAlive,
  beginPhase,
  releaseConsumer,
  checkProcessTask,
  phaseRecords,
  readProcessConfig,
  ProcessPhase,
} from "./process-resources.mjs";
import {
  buildRelease,
  provisionDatabase,
  installSoftware,
  activateLocal,
  updateCorePin,
  retireReleases,
  retireDatabases,
  reconcileSoftware,
  maintenance,
  runtimeDependencies,
} from "./deployment.mjs";
import { importPackage, verifyPackage } from "../server/project/package.mjs";
import { fileSha } from "../server/transport-contract.mjs";
import { stopService, startService, activeRelease } from "./service.mjs";

export async function stopOwnedPreview(identities = []) {
  for (const identity of identities)
    if (processAlive(identity)) process.kill(identity.pid, "SIGTERM");
  const deadline = Date.now() + 10000;
  while (identities.some(processAlive) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  for (const identity of identities)
    if (processAlive(identity)) process.kill(identity.pid, "SIGKILL");
  for (let i = 0; identities.some(processAlive); i++) {
    requireValue(i < 100, "预览工作器未停止");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function remoteTarget(root, operationId, transportDirectory) {
  root = path.resolve(root);
  requireValue(
    transportDirectory === path.join(root, ".process/transport", operationId),
    "VPS 传输目录不属于本次操作",
  );
  const ownership = await json(path.join(transportDirectory, "ownership.json")),
    input = path.join(transportDirectory, "unpacked"),
    request = await json(path.join(input, "request.json")),
    manifest = await json(path.join(input, "software-manifest.json"));
  requireValue(
    ownership.root === root &&
      ownership.operationId === operationId &&
      request.operationId === operationId &&
      request.target.projectRoot === root &&
      manifest.commit === request.commit,
    "VPS 输入身份不符",
  );
  await verifyTree(path.join(input, "software"), manifest.files);
  const dependencies=runtimeDependencies();
  const business = await verifyPackage(path.join(input, "business"));
  requireValue(
    business.transfer.sha256 === request.baselineSha256,
    "VPS 业务基线不符",
  );
  if (!(await exists(path.join(root, "instance/instance.json"))))
    await createProject(root, {
      title: request.title,
      port: request.target.port,
      transportOperationId: operationId,
    });
  const runtime = path.join(root, "instance/runtime"),
    task = "remote-" + operationId;
  return processLock(path.join(runtime, "deploy.lock"), async () => {
    const file = path.join(runtime, "deployments", operationId + ".json"),
      previous = await json(file).catch(() => null),
      instance = await json(path.join(root, "instance/instance.json"));
    requireValue(
      !previous?.owner || !processAlive(previous.owner),
      "VPS 原操作仍在运行",
    );
    requireValue(
      !previous ||
        (previous.commit === request.commit &&
          previous.baselineSha256 === request.baselineSha256),
      "同一操作编号不能更换输入",
    );
    const receipt = {
      ...previous,
      schemaVersion: "1.0",
      kind: "REMOTE_TARGET",
      operationId,
      commit: request.commit,
      instanceId: instance.id,
      baselineSha256: request.baselineSha256,
      dependencies,
      owner: processIdentity(),
      cleanup: "PENDING",
    };
    const save = async (update) => {
      Object.assign(receipt, update, { updatedAt: new Date().toISOString() });
      await atomic(file, receipt);
    };
    const active = await json(path.join(runtime, "active.json")).catch(
      () => null,
    );
    const switchFile = path.join(runtime, "database-switch.json");
    let journal = await json(switchFile).catch(() => null),
      phase;
    const finishPhases = async ({ discardCandidate = false } = {}) => {
      await releaseConsumer(root, task, "activation");
      const policy = await readProcessConfig(root),
        current = await json(path.join(runtime, "machine.json"));
      for (const { file, record } of await phaseRecords(root)) {
        if (record.taskId !== task) continue;
        const owned = new ProcessPhase(policy, file, record.token);
        if (discardCandidate) {
          await owned.update((r) => {
            for (const x of r.resources) {
              if (x.state !== "RETAINED") continue;
              if (
                ["container", "volume"].includes(x.kind) &&
                x.name !== current.managedDatabase?.container &&
                x.name !== current.managedDatabase?.volume
              )
                x.state = "TEMPORARY";
              if (
                x.kind === "path" &&
                x.path.startsWith(
                  path.join(runtime, "database-recovery") + path.sep,
                ) &&
                x.path !== path.dirname(current.database?.passwordFile || "")
              )
                x.state = "TEMPORARY";
            }
            r.status = "CLEANUP_REQUIRED";
          });
        }
        const result = await owned.finish({
          recover: true,
          outcome: receipt.status,
        });
        requireValue(result.status === "CLEANED", "VPS 阶段资源尚未清理");
      }
      await checkProcessTask(root, task);
      await retireReleases(root);
      await retireDatabases(root);
    };
    const restorePrevious = async () => {
      requireValue(
        journal?.operationId === operationId && journal.previousMachine,
        "缺少本次受管数据库切换记录",
      );
      const actual = await json(path.join(runtime, "machine.json"));
      requireValue(
        [
          JSON.stringify(journal.previousMachine.database),
          JSON.stringify(journal.nextMachine.database),
        ].includes(JSON.stringify(actual.database)),
        "数据库定位出现未知修改",
      );
      await stopService(root);
      await atomic(path.join(runtime, "machine.json"), journal.previousMachine);
      if (journal.previousActive) {
        await atomic(path.join(runtime, "active.json"), journal.previousActive);
        await maintenance(root, operationId, { enabled: false });
        await startService(root, { commit: journal.previousActive.commit });
      } else await rm(path.join(runtime, "active.json"), { force: true });
      await atomic(
        path.join(runtime, "retention.json"),
        journal.previousRetention,
      );
      await atomic(
        path.join(runtime, "database-retention.json"),
        journal.previousDatabaseRetention || {},
      );
      journal = { ...journal, status: "RESTORED" };
      await atomic(switchFile, journal);
    };
    const finalize = async (proof) => {
      const actual = await json(path.join(runtime, "machine.json"));
      requireValue(
        journal?.operationId === operationId &&
          JSON.stringify(actual.database) ===
            JSON.stringify(journal.nextMachine.database),
        "运行数据库与切换记录不符",
      );
      await updateCorePin(root, manifest);
      await atomic(path.join(runtime, "database-retention.json"), {
        current: journal.nextSlot,
        previous:
          journal.previousDatabaseRetention?.current ||
          (journal.previousMachine.database
            ? {
                database: journal.previousMachine.database,
                managedDatabase: journal.previousMachine.managedDatabase,
              }
            : null),
      });
      await maintenance(root, operationId, { enabled: false });
      await atomic(switchFile, { ...journal, status: "COMPLETED" });
      await save({ status: "SUCCEEDED", stage: "VERIFIED", proof });
    };
    try {
      await stopOwnedPreview(previous?.previewProcesses);
      await save({ previewProcesses: [] });
      if (previous?.status === "SUCCEEDED") {
        // A historical successful operation is never reactivated over a newer deployment.
        if (active?.operationId === operationId) {
          const machine = await json(path.join(runtime, "machine.json"));
          await activeRelease(root);
          await health(machine.apiUrl, {
            commit: request.commit,
            instanceId: instance.id,
            worker: true,
          });
        }
        await finishPhases();
        await save({ status: "SUCCEEDED", cleanup: "TRANSPORT_PENDING" });
        delete receipt.owner;
        await save({});
        return receipt;
      }
      if (active?.operationId === operationId) {
        await reconcileSoftware(root);
        await activeRelease(root);
        requireValue(
          journal?.operationId === operationId &&
            receipt.imported?.status === "SUCCEEDED",
          "切换后的业务导入证明缺失",
        );
        const proof = await startService(root, { commit: request.commit });
        await finalize(proof);
        await finishPhases();
        await save({ cleanup: "TRANSPORT_PENDING" });
        delete receipt.owner;
        await save({});
        return receipt;
      }
      if (journal?.operationId === operationId && journal.status === "PREPARED")
        await restorePrevious();
      if (previous) {
        await reconcileSoftware(root);
        await finishPhases({ discardCandidate: true });
      }
      await save({
        status: "RUNNING",
        stage: "BUILDING",
        attempt: (previous?.attempt || 0) + 1,
        cleanup: "PENDING",
      });
      phase = await beginPhase(root, task, "attempt-" + receipt.attempt);
      const scratch = (await phase.read()).resources[0].path,
        frozen = path.join(scratch, "source");
      await cp(path.join(input, "software"), frozen, { recursive: true });
      const built = await buildRelease(root, frozen, manifest, {
        phase,
        operationId: operationId + "-" + receipt.attempt,
      });
      const preview = path.join(scratch, "preview"),
        port = await freePort();
      await createProject(preview, {
        title: request.title,
        port,
        instanceId: instance.id,
        initializeGit: false,
        host: "fixture",
      });
      await provisionDatabase(preview, built.release, {
        phase,
        databaseSalt: operationId + "-" + receipt.attempt,
        retain: false,
      });
      const environment = {
        ...process.env,
        REVIEW_INSTANCE_ROOT: path.join(preview, "instance"),
        REVIEW_SOFTWARE_COMMIT: request.commit,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      };
      for (const script of ["web/server.js", "scripts/worker.mjs"]) {
        const child = spawn(
          process.execPath,
          [path.join(built.release, script)],
          { cwd: root, env: environment, stdio: "ignore" },
        );
        child.on("error", () => {});
        await save({
          previewProcesses: [
            ...(receipt.previewProcesses || []),
            processIdentity(child.pid),
          ],
        });
      }
      const base = "http://127.0.0.1:" + port + "/";
      for (let i = 0; ; i++) {
        try {
          await health(base, {
            commit: request.commit,
            instanceId: instance.id,
            worker: true,
          });
          break;
        } catch (e) {
          if (i >= 100) throw e;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      await save({ stage: "IMPORTING" });
      const imported = await importPackage(base, path.join(input, "business"), {
        operationId: "baseline-" + operationId,
      });
      await save({ stage: "IMPORTED", imported });
      // Freeze candidate writes until the final pointer and receipt have been verified.
      await maintenance(preview, operationId, {
        enabled: true,
        release: built.release,
      });
      await stopOwnedPreview(receipt.previewProcesses);
      await save({ previewProcesses: [] });
      const oldMachine = await json(path.join(runtime, "machine.json")),
        oldActive = await json(path.join(runtime, "active.json")).catch(
          () => null,
        ),
        candidate = await json(
          path.join(preview, "instance/runtime/machine.json"),
        );
      const directory = path.join(
        runtime,
        "database-recovery",
        operationId + "-" + receipt.attempt,
      );
      await phase.directory(directory);
      const credential = path.join(directory, "database.secret");
      await copyFile(candidate.database.passwordFile, credential);
      candidate.database.passwordFile = credential;
      await phase.retain("path", directory, "本次数据库切换及恢复凭据");
      await phase.retain(
        "container",
        candidate.managedDatabase.container,
        "切换前固定的候选数据库",
      );
      await phase.retain(
        "volume",
        candidate.managedDatabase.volume,
        "切换前固定的候选数据库卷",
      );
      await mkdir(path.join(root, "instance/media"), { recursive: true });
      for (const media of business.media) {
        const to = path.join(root, "instance/media", media.sha256);
        if (await exists(to))
          requireValue(
            (await fileSha(to)) === media.sha256,
            "VPS 目标媒体存在未知修改",
          );
        else
          await copyFile(
            path.join(preview, "instance/media", media.sha256),
            to,
          );
      }
      const nextMachine = {
        ...oldMachine,
        database: candidate.database,
        managedDatabase: candidate.managedDatabase,
        port: request.target.port,
        listenHost: request.target.listenHost,
        apiUrl: "http://127.0.0.1:" + request.target.port + "/",
      };
      journal = {
        operationId,
        status: "PREPARED",
        previousMachine: oldMachine,
        nextMachine,
        previousActive: oldActive,
        previousRetention: await json(path.join(runtime, "retention.json")),
        previousDatabaseRetention: await json(
          path.join(runtime, "database-retention.json"),
        ).catch(() => null),
        nextSlot: {
          database: candidate.database,
          managedDatabase: candidate.managedDatabase,
          directory,
        },
      };
      await atomic(switchFile, journal);
      if (oldActive) await maintenance(root, operationId, { enabled: true });
      await save({ stage: "SWITCHING" });
      await stopService(root);
      await atomic(path.join(runtime, "machine.json"), nextMachine);
      await installSoftware(root, frozen, manifest, {
        operationId: operationId + "-" + receipt.attempt,
        phase,
      });
      const proof = await activateLocal(root, built, {
        phase,
        operationId,
        saveJournal: save,
        restoreOnFailure: false,
      });
      await finalize(proof);
    } catch (error) {
      await stopOwnedPreview(receipt.previewProcesses).catch(() => {});
      try {
        if (
          journal?.operationId === operationId &&
          journal.status === "PREPARED"
        )
          await restorePrevious();
        else if (await exists(path.join(runtime, "active.json")))
          await maintenance(root, operationId, { enabled: false });
        await save({
          status: "FAILED",
          stage: "RESTORED",
          error: error.message,
        });
      } catch (restoreError) {
        await save({
          status: "RESULT_UNKNOWN",
          stage: "RESTORING",
          error: error.message,
          restoreError: restoreError.message,
        });
      }
    }
    try {
      if (receipt.status !== "RESULT_UNKNOWN") {
        await finishPhases({ discardCandidate: receipt.status === "FAILED" });
        await save({ cleanup: "TRANSPORT_PENDING" });
      } else await save({ cleanup: "RECOVERY_REQUIRED" });
    } catch (error) {
      await save({ cleanup: "CLEANUP_REQUIRED", cleanupError: error.message });
    }
    delete receipt.owner;
    await save({});
    return receipt;
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [root, operationId, directory] = process.argv.slice(2),
    result = await remoteTarget(root, operationId, directory);
  console.log(JSON.stringify(result));
  process.exitCode =
    ["SUCCEEDED", "FAILED"].includes(result.status) &&
    ["TRANSPORT_PENDING", "CLEANED"].includes(result.cleanup)
      ? 0
      : 1;
}
