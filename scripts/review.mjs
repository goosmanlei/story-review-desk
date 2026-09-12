#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportPackage,
  importPackage,
  verifyPackage,
} from "../server/project/package.mjs";

const help = `review — 与网页共用 /api/v1 的业务命令

  review list --module story [--kind SCENE] [--owner EPISODE_ID]
  review read OBJECT_ID [--revision REVISION_ID]
  review context OBJECT_ID [--revision REVISION_ID]
  review facets --kind MATERIAL
  review relationships [--owner ENTITY_ID] [--offset N]
  review spatial
  review save OBJECT_ID --file draft.json --expected-version N
  review submit OBJECT_ID --expected-version N
  review review OBJECT_ID --file judgment.json --expected-version N
  review transaction --file transaction.json
  review configuration [system|project] [--file config.json --expected-version N]
  review status OPERATION_ID
  review maintenance [verify|backup|restore --file restore.json]
  review export --output PROJECT_PACKAGE_DIRECTORY
  review import --file PROJECT_PACKAGE_DIRECTORY
  review verify --file PROJECT_PACKAGE_DIRECTORY

  --url URL              默认本项目 runtime/machine.json 中的 API 地址
  --project DIRECTORY    默认当前目录
  --operation-id ID      重发使用同一编号；不指定时自动产生
  --output FILE          将结果写入文件
  --help                 显示帮助

save 文件包含 kind、title、content、links、dependencies 等对象字段。
review 文件明确 decision、revisionId、findings、note 和 explicit:true。
接口失败会返回非零退出码；RESULT_UNKNOWN 先查状态，不自动重试。
`;
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      url: { type: "string" },
      project: { type: "string" },
      file: { type: "string" },
      "expected-version": { type: "string" },
      "operation-id": { type: "string" },
      module: { type: "string" },
      kind: { type: "string" },
      owner: { type: "string" },
      revision: { type: "string" },
      query: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      historical: { type: "boolean" },
      category: { type: "string" },
      mediaType: { type: "string" },
      entity: { type: "string" },
      lane: { type: "string" },
      gate: { type: "string" },
      attention: { type: "string" },
      actor: { type: "string" },
      chain: { type: "string" },
      workStage: { type: "string" },
      workState: { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }
  if (positionals[0] === "verify") {
    const result = await verifyPackage(path.resolve(values.file));
    console.log(
      JSON.stringify({
        status: "VERIFIED",
        sha256: result.transfer.sha256,
        media: result.media.length,
      }),
    );
    return;
  }
  const project = path.resolve(values.project || ".");
  let base = values.url || process.env.REVIEW_API_URL;
  if (!base) {
    const machine = JSON.parse(
      await readFile(
        path.join(project, "instance/runtime/machine.json"),
        "utf8",
      ),
    );
    base = machine.apiUrl;
  }
  if (!base) throw Error("请通过 --url 或本机配置提供 API 地址");
  const root = new URL(base.endsWith("/") ? base : base + "/");
  if (positionals[0] === "export") {
    const result = await exportPackage(root, path.resolve(values.output));
    console.log(
      JSON.stringify({
        status: "EXPORTED",
        sha256: result.transfer.sha256,
        media: result.media.length,
      }),
    );
    return;
  }
  if (positionals[0] === "import") {
    const operationId = values["operation-id"] || randomUUID();
    console.error("operationId: " + operationId);
    console.log(
      JSON.stringify(
        await importPackage(root, path.resolve(values.file), { operationId }),
      ),
    );
    return;
  }
  let endpoint, body;
  const [command, id] = positionals;
  const readInput = async () => JSON.parse(await readFile(values.file, "utf8"));
  if (["list", "facets", "relationships"].includes(command)) {
    const query = new URLSearchParams();
    for (const k of [
      "module",
      "kind",
      "owner",
      "query",
      "offset",
      "limit",
      "historical",
      "category",
      "mediaType",
      "entity",
      "lane",
      "gate",
      "attention",
      "actor",
      "chain",
      "workStage",
      "workState",
    ])
      if (values[k] !== undefined) query.set(k, String(values[k]));
    endpoint = (command === "list" ? "objects" : command) + "?" + query;
  } else if (["read", "context"].includes(command))
    endpoint =
      (command === "read" ? "objects/" : "contexts/") +
      encodeURIComponent(id) +
      (values.revision
        ? "?revisionId=" + encodeURIComponent(values.revision)
        : "");
  else if (command === "spatial") endpoint = "settings/spatial-baseline";
  else if (command === "status")
    endpoint = "operations/" + encodeURIComponent(id);
  else if (command === "maintenance") {
    endpoint = id ? "jobs" : "maintenance";
    if (id) {
      if (!["verify", "backup", "restore"].includes(id))
        throw Error("维护任务类型无效");
      body = {
        ...(values.file ? await readInput() : {}),
        kind: "MAINTENANCE_" + id.toUpperCase(),
      };
    }
  } else if (command === "transaction") {
    endpoint = "transactions";
    body = await readInput();
  } else if (command === "configuration" && !values.file)
    endpoint = "configurations";
  else if (["save", "submit", "review", "configuration"].includes(command)) {
    const input = values.file ? await readInput() : {};
    body = {
      operationId: values["operation-id"] || randomUUID(),
      actor: { kind: "PROJECT_CODEX", label: "项目 CLI" },
      commands: [
        {
          ...input,
          type: command === "configuration" ? "configuration.save" : command,
          ...(command === "configuration" ? { scope: id } : { id }),
          expectedVersion: Number(values["expected-version"]),
        },
      ],
    };
    endpoint = "transactions";
  } else throw Error("未知命令；运行 review --help");
  if (body && !body.operationId)
    body.operationId = values["operation-id"] || randomUUID();
  // Print the identity before sending; an interrupted client can query the same operation.
  if (body?.operationId) console.error("operationId: " + body.operationId);
  const response = await fetch(new URL("api/v1/" + endpoint, root), {
    method: body ? "POST" : "GET",
    headers: body
      ? {
          "Content-Type": "application/json",
          "x-review-runtime":
            body.runtimeEpoch ||
            (await (await fetch(new URL("api/v1/health", root))).json()).project
              .runtimeEpoch,
        }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (values.output)
    await writeFile(values.output, text + "\n", { flag: "wx", mode: 0o600 });
  else console.log(text);
  if (!response.ok) process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
