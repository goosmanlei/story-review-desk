#!/usr/bin/env node
import {
  database,
  machineConfiguration,
  closeDatabase,
} from "../server/db.mjs";
import { workOnce, sweepJobs } from "../server/jobs.mjs";
import { runMaintenance } from "../server/project/maintenance.mjs";
import { randomUUID } from "node:crypto";
import { processProvider } from "../server/process-provider.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { root, machine } = await machineConfiguration(),
  pool = await database(),
  workerId = randomUUID();
let stopped = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopped = true;
  });
const providers = {
    maintenance: (request) => runMaintenance(pool, root, request),
  },
  runningPhases = new Map();
async function invoke(command, payload, onRequestId) {
  const result = await processProvider({ root, command, payload, onRequestId });
  runningPhases.set(payload.request.operationId, result);
  return result;
}
if (machine.assistant?.provider === "codex")
  providers.suggest = async ({ request, object, onRequestId }) => {
    const script = fileURLToPath(
      new URL("../server/collaboration/codex_suggest.py", import.meta.url),
    );
    const result = await invoke(
      [machine.assistant.pythonBinary || "python3", script],
      {
        codexBin: machine.assistant.codexBinary || "codex",
        model: machine.assistant.model || null,
        cwd: path.dirname(root),
        apiUrl: machine.apiUrl,
        request,
        object,
      },
      onRequestId,
    );
    return result.value;
  };
if (Array.isArray(machine.production?.command))
  providers.generate = async ({ request, object, inputs, onRequestId }) => {
    const result = await invoke(
      machine.production.command,
      { request, object, inputs },
      onRequestId,
    );
    return {
      ...result.value,
      outputDirectory: path.join(result.directory, "outputs"),
    };
  };
providers.finalize = async ({ operationId, status }) => {
  const result = runningPhases.get(operationId);
  if (!result) return;
  if (status === "RESULT_UNKNOWN")
    await result.phase.retain(
      "path",
      result.directory,
      "实际执行已发生，结果或登记待核；禁止自动再次调用",
    );
  await result.phase.finish({ outcome: status });
  runningPhases.delete(operationId);
};
const heartbeat = async () =>
  pool.query(
    "INSERT INTO runtime_status(name,value,updated_at) VALUES('worker',$1,now()) ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [
      {
        workerId,
        softwareCommit: process.env.REVIEW_SOFTWARE_COMMIT || "DEVELOPMENT",
        concurrency: 1,
        capabilities: [
          "IMPORT",
          "MEDIA_REGISTER",
          "MAINTENANCE_VERIFY",
          "MAINTENANCE_BACKUP",
          "MAINTENANCE_RESTORE",
          ...(providers.suggest ? ["AI_SUGGEST"] : []),
          ...(providers.generate ? ["GENERATE", "MEDIA_PROCESS"] : []),
        ],
      },
    ],
  );
await heartbeat();
let lastSweep = 0;
try {
  while (!stopped) {
    if (Date.now() - lastSweep > 5000) {
      await heartbeat();
      await sweepJobs(pool);
      lastSweep = Date.now();
    }
    const worked = await workOnce(pool, { root, workerId, providers });
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 500));
  }
} finally {
  await pool.query(
    "DELETE FROM runtime_status WHERE name='worker' AND value->>'workerId'=$1",
    [workerId],
  );
  await closeDatabase();
}
