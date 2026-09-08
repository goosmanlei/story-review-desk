import { test, expect } from "@playwright/test";

test("five configuration sections publish a preview while preserving existing object standards and formal events", async ({
  page,
  request,
  baseURL,
}) => {
  if (new URL(baseURL!).port !== "4197")
    throw new Error(
      "Configuration mutation E2E requires the isolated 4197 instance",
    );
  const before = await request
    .get("/api/instance/configuration")
    .then((r) => r.json());
  const runtime = await request
    .get("/api/instance/runtime")
    .then((r) => r.json());
  const title = before.configuration.presentation.title === "隔离配置验收 A" ? "隔离配置验收 B" : "隔离配置验收 A";
  await page.goto("/settings");
  await expect(
    page.getByRole("region", { name: "系统配置编辑器", exact: true }),
  ).toBeVisible();
  for (const name of [
    "项目设定",
    "资料与设定",
    "素材与制作",
    "审阅标准",
    "AI 配置",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".configuration-editor")).toBeVisible();
  }
  await expect(page.getByText('版本与维护',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'AI 配置',exact:true}).click();
  for (const name of ['AI 助手','项目 Codex','试制入口'])
    await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
  await expect(page.getByText('评论的 AI 生成／润色和审阅意见的 AI 辅助使用',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'项目 Codex',exact:true}).click();
  await expect(page.getByLabel('Bridge 模型',{exact:true})).toBeVisible();
  await expect(page.getByLabel('最大并发会话数',{exact:true})).toHaveValue('5');
  await expect(page.getByLabel('空闲回收时间（秒）',{exact:true})).toHaveValue('600');
  await page.getByRole('button',{name:'试制入口',exact:true}).click();
  await expect(page.getByLabel('试制入口名称',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'项目设定',exact:true}).click();
  for (const name of ['项目与画面','界面'])
    await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
  await page.getByLabel("审阅台名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByText("草稿已保存，当前有效规则保持原版本", { exact: true }),
  ).toBeVisible();
  expect(
    (await request.get("/api/instance/configuration").then((r) => r.json()))
      .revisionId,
  ).toBe(before.revisionId);
  await page.getByRole("button", { name: "预览影响", exact: true }).click();
  await expect(page.getByText("影响预览已完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "发布配置", exact: true }).click();
  await expect(
    page.getByText("配置已发布，当前实例已生效", { exact: true }),
  ).toBeVisible();
  const after = await request
    .get("/api/instance/configuration")
    .then((r) => r.json());
  expect(after.revisionId).not.toBe(before.revisionId);
  expect(after.configuration.presentation.title).toBe(title);
  expect(after.bindings).toEqual(before.bindings);
  expect(
    (await request.get("/api/instance/runtime").then((r) => r.json()))
      .formalEventCounts,
  ).toEqual(runtime.formalEventCounts);
  await page.reload();
  await page.getByRole("button", { name: "项目设定", exact: true }).click();
  await expect(page.getByLabel("审阅台名称", { exact: true })).toHaveValue(
    title,
  );
});

test("configuration remains readable without horizontal overflow on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await expect(
    page.getByRole("region", { name: "系统配置编辑器", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.getByRole("button", { name: "项目设定", exact: true }).click();
  await expect(page.getByLabel("画幅", { exact: true })).toBeVisible();
});
