#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exists, atomic, run, requireValue } from "./io.mjs";

export async function createProject(
  destination,
  {
    title = "空白故事",
    source,
    port = 3000,
    instanceId = randomUUID(),
    database,
    host = "local",
    initializeGit = true,
    transportOperationId,
  } = {},
) {
  const root = path.resolve(destination);
  if (await exists(root)) {
    requireValue(
      transportOperationId &&
        JSON.stringify(
          (
            await import("node:fs/promises").then((fs) => fs.readdir(root))
          ).sort(),
        ) === JSON.stringify([".process"]),
      "目标目录已存在；创建不会覆盖任何文件",
    );
    const owner = JSON.parse(
      await readFile(
        path.join(
          root,
          ".process/transport",
          transportOperationId,
          "ownership.json",
        ),
        "utf8",
      ),
    );
    requireValue(
      owner.operationId === transportOperationId && owner.root === root,
      "传输目标归属不符",
    );
  }
  requireValue(
    Number.isInteger(port) && port > 1024 && port < 65536,
    "端口须为 1025–65535",
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const directory of [
    "review-software",
    "instance/media",
    "instance/runtime",
    "guidance",
    "project-data",
    ".process",
  ])
    await mkdir(path.join(root, directory), { recursive: true, mode: 0o700 });
  const instance = { schemaVersion: "3.0", id: instanceId, title };
  const machine = {
    schemaVersion: "1.0",
    sourceRepository: source ? path.resolve(source) : null,
    port,
    listenHost: "127.0.0.1",
    apiUrl: `http://127.0.0.1:${port}/`,
    nodeBinary: process.execPath,
    servicePath: process.env.PATH,
    ...(database ? { database } : {}),
    targets: {},
  };
  const policy = {
    schemaVersion: "1.0",
    enabled: true,
    projectId: instanceId,
    host,
    maxTemporaryBytes: 64 * 1024 ** 3,
    reserveBytes: 8 * 1024 ** 3,
    registry: "instance/runtime/process",
    workspace: ".process/stages",
    parentTasks: ".process/tasks",
    temporaryRoots: [
      ".process/shared",
      "instance/runtime/releases",
      "instance/runtime/database-recovery",
    ],
    protectedPaths: [
      "instance/media",
      "project-data",
      "guidance",
      "review-software",
      "instance/runtime/machine.json",
      "instance/instance.json",
    ],
    retentionPolicy: "instance/runtime/retention.json",
    dockerBinary: run("which", ["docker"]),
  };
  await atomic(path.join(root, "instance/instance.json"), instance);
  await atomic(path.join(root, "instance/runtime/machine.json"), machine);
  await atomic(path.join(root, "instance/runtime/process-policy.json"), policy);
  await atomic(path.join(root, "instance/runtime/retention.json"), {
    protectedHotPaths: [],
  });
  const pkg = {
    name: "review-project",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      deploy: "node review-software/tools/deploy.mjs",
      review: "node review-software/scripts/review.mjs",
      process: "node review-software/tools/process.mjs",
      "cleanup:finish": "node review-software/tools/process.mjs finish",
      "cleanup:check": "node review-software/tools/process.mjs check",
      "cleanup:complete": "node review-software/tools/cleanup.mjs",
      "cleanup:sweep": "node review-software/tools/process.mjs sweep",
    },
  };
  await atomic(path.join(root, "package.json"), pkg);
  await writeFile(
    path.join(root, ".gitignore"),
    "instance/runtime/\ninstance/media/\nproject-data/media/\n.process/\n/review-library\n/.review-library-*\n.DS_Store\n*.swp\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(root, ".gitattributes"),
    "* text=auto\n*.ndjson -text\n*.png binary\n*.jpg binary\n*.mp4 binary\n*.wav binary\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(root, "README.md"),
    `# ${title}\n\n一个项目绑定一个故事。网页、项目 CLI 与助手共用对象服务。\n\n- [工作规则](AGENTS.md)\n- [运行与维护状态](STATE.md)\n- [软件及部署说明](review-software/README.md)\n\n运行 \`npm run deploy\` 部署本机核心仓库当前已提交版本；\`npm run deploy -- --help\` 查看目标与恢复选项。\n`,
    { flag: "wx" },
  );
  await writeFile(
    path.join(root, "AGENTS.md"),
    "# 项目工作规则\n\n默认中文。业务权威是本实例 PostgreSQL 中的对象修订；媒体按永久版本身份和 SHA 读取。网页、CLI 与助手通过 /api/v1 保存，修改携带 expectedVersion 和 operationId；不直接写数据库或受控源。\n\n草稿、待审、采用、权利事实、实际输入锁定和生成授权有各自语义。AI 建议先预览再应用为草稿；正式采用及生成需要明确用户动作或本轮精确授权。未知结果先查询原操作，禁止自动重复调用。原始资料、已登记媒体及正式历史保留；必要修订新建版本。\n\n配置字段分别属于系统、项目或本机；凭据、机器路径和会话仅存本机。过程资源先登记、结束即清理；不删除未知文件或全局清理 Docker。封存备份由用户控制，普通部署和清理不得读取。\n\n项目规则位于 guidance；通用代码、Schema、测试和部署工具只在核心仓库维护。修改软件时从核心仓库提交部署，不能直接改受管 review-software。\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(root, "STATE.md"),
    "# 运行与维护\n\n- 新项目已创建，尚未部署。\n- 本机配置：instance/runtime/machine.json；运行指针、部署回执和恢复点位于 instance/runtime。\n- 项目包：project-data；媒体：instance/media。\n",
    { flag: "wx" },
  );
  if (initializeGit) run("git", ["init", "-b", "main", root]);
  return { root, instance, machine };
}
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      title: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
      "no-deploy": { type: "boolean" },
    },
  });
  if (values.help || positionals[0] !== "create" || !positionals[1]) {
    console.log(
      "project create DIRECTORY --source CORE_REPOSITORY [--title 故事名称] [--port 3000] [--no-deploy]\n创建独立空白项目；默认部署核心仓库当前 Git HEAD。",
    );
    return;
  }
  const source = path.resolve(
    values.source ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  await (await import("./deployment.mjs")).resolveSource(source);
  const project = await createProject(positionals[1], {
    source,
    title: values.title,
    port: Number(values.port || 3000),
  });
  const { installSourceOnly, main: deploy } = await import("./deploy.mjs");
  await installSourceOnly(project.root, source);
  if (!values["no-deploy"])
    await deploy(["--project", project.root, "--source", source]);
  console.log(JSON.stringify({ status: "CREATED", project: project.root }));
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
