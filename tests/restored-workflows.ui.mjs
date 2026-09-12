import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { workspaceReady } from "./browser-readiness.mjs";
const { values } = parseArgs({
  options: { url: { type: "string" }, output: { type: "string" } },
});
assert(process.env.REVIEW_PROCESS_CONTEXT);
const base = new URL(values.url),
  get = async (r) => {
    const x = await fetch(new URL("api/v1/" + r, base));
    assert(x.ok);
    return x.json();
  },
  health = await get("health");
assert(
  health.project.instanceId.startsWith("ui-fixture-"),
  "Only an isolated fixture can be mutated",
);
const request = async (commands) => {
  const r = await fetch(new URL("api/v1/transactions", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-review-runtime": health.project.runtimeEpoch,
    },
    body: JSON.stringify({ operationId: randomUUID(), commands }),
  });
  const v = await r.json();
  assert(r.ok, JSON.stringify(v));
  return v;
};
const marker = "UI-" + randomUUID(),
  scene = marker + "-scene",
  episode = marker + "-episode";
await request([
  {
    type: "save",
    id: scene,
    kind: "SCENE",
    title: marker,
    expectedVersion: 0,
    content: {
      blocks: [
        {
          id: scene + "-b1",
          type: "action",
          text: "旅人在站台上看见一封等待寄出的信，停下来仔细核对信封。",
        },
      ],
      purpose: "仅用于隔离界面验收",
    },
  },
]);
await request([
  {
    type: "save",
    id: episode,
    kind: "EPISODE",
    title: marker + " 分集",
    expectedVersion: 0,
    content: {
      reviewDossier: {
        purpose: { episodeTask: { text: "核对信件的来源", class: "A" } },
        payoff: { deliveredResult: { text: "发现新的线索", class: "A" } },
      },
    },
    links: [{ id: scene, role: "SCENE", expectedVersion: 1 }],
  },
]);
const browser = await chromium.launch({ channel: "chrome", headless: true }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [],
  checked = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (
    m.type() === "error" &&
    /Cannot update|hydration|Each child/.test(m.text())
  )
    errors.push(m.text());
});
const nav = (label) =>
  page
    .getByRole("navigation", { name: "工作区" })
    .getByRole("button", { name: new RegExp(label) });
const ready = () => workspaceReady(page, "story", "SCENE", scene);
try {
  await page.goto(
    new URL("?view=story&kind=SCENE&id=" + scene + "&owner=" + episode, base)
      .href,
  );
  await ready();
  await page
    .getByRole("region", { name: "审阅上下文" })
    .getByText("核对信件的来源", { exact: false })
    .waitFor();
  checked.push("same-version episode context");
  await page.locator('[data-block-id="' + scene + '-b1"]').evaluate((el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) if (n.textContent.includes("旅人在")) break;
    const r = document.createRange();
    r.setStart(n, 0);
    r.setEnd(n, 7);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page
    .getByRole("textbox", { name: "我的评论", exact: true })
    .fill("请让这条意见指向可以核对的修改。");
  await page
    .getByRole("button", { name: "保存意见并请助手优化", exact: true })
    .click();
  const assistant = page.getByRole("complementary", {
    name: "AI 助手",
    exact: true,
  });
  await assistant.waitFor();
  await assistant
    .getByRole("button", { name: "请求建议", exact: true })
    .click();
  await assistant
    .getByRole("heading", { name: "建议预览", exact: true })
    .waitFor();
  const before = (await get("contexts/" + scene)).comments;
  assert.equal(before.length, 1);
  assert.equal(before[0].content.anchor.blockId, scene + "-b1");
  assert.equal(before[0].version, 1);
  assert.equal((await get("objects/" + scene)).version, 1);
  await assistant
    .getByRole("button", { name: "将此建议应用为草稿", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".assistant-panel") ||
      document.querySelector(".assistant-panel")?.textContent?.includes("草稿"),
  );
  await page.getByRole("button", { name: "收起 AI 助手", exact: true }).click();
  await page.waitForFunction(async (id) => {
    const r = await fetch("/api/v1/contexts/" + id);
    const x = await r.json();
    return x.comments[0]?.content.text.endsWith("（受控模拟优化）");
  }, scene);
  const after = (await get("contexts/" + scene)).comments[0];
  assert.equal(after.version, 2);
  assert.equal(
    after.content.target.revisionId,
    before[0].content.target.revisionId,
  );
  assert.equal((await get("objects/" + scene)).version, 1);
  checked.push("selection-comment-mock-suggestion-preview-explicit-draft");
  await page.getByRole("button", { name: "评论版本记录", exact: true }).click();
  await workspaceReady(page, "project", "COMMENT", after.id);
  await page
    .getByRole("button", { name: "← 返回故事创作", exact: true })
    .click();
  await ready();
  checked.push("comment history and return to source");
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  const editor = page.getByRole("textbox", {
    name: "第 1 段正文",
    exact: true,
  });
  await editor.fill("隔离验收修改：旅人仔细核对信封上的收信人。");
  await nav("故事设定").click();
  await nav("故事创作").click();
  await ready();
  await editor.waitFor();
  assert.equal(
    await editor.inputValue(),
    "隔离验收修改：旅人仔细核对信封上的收信人。",
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByText("已保存并核对回读", { exact: true }).waitFor();
  assert.equal((await get("objects/" + scene)).version, 2);
  checked.push("edit-save-readback-and-unsaved-navigation");
  if (await page.getByRole("button", { name: "返回阅读", exact: true }).count())
    await page.getByRole("button", { name: "返回阅读", exact: true }).click();
  await page.getByRole("button", { name: "提交审阅", exact: true }).click();
  await page.getByRole("button", { name: "采用此修订", exact: true }).waitFor();
  for (const fieldset of await page.locator(".review-panel fieldset").all())
    await fieldset.getByRole("button", { name: "通过", exact: true }).click();
  await page.getByRole("button", { name: "采用此修订", exact: true }).click();
  await page
    .getByRole("textbox", { name: "审阅说明", exact: true })
    .fill("仅对隔离验收对象确认。");
  await page.getByRole("button", { name: "提交判断", exact: true }).click();
  await page.getByText("此修订已采用。", { exact: true }).waitFor();
  const adopted = await get("objects/" + scene);
  assert.equal(adopted.state, "ADOPTED");
  checked.push("submit-review-adopt");
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  await editor.fill("保留这份尚未提交的并发修改。");
  await request([
    {
      type: "save",
      id: scene,
      expectedVersion: adopted.version,
      title: marker,
      content: { ...adopted.revision.content, purpose: "另一入口的隔离改动" },
    },
  ]);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page
    .getByRole("button", {
      name: "读取最新版本（保留未保存修改）",
      exact: true,
    })
    .waitFor();
  assert.equal(await editor.inputValue(), "保留这份尚未提交的并发修改。");
  checked.push("CAS conflict preserves draft");
  await page.getByRole("button", { name: "放弃本次修改", exact: true }).click();
  await nav("当前工作").click();
  await page.locator('[data-ready="overview"]').waitFor();
  await page
    .getByRole("navigation", { name: "三条主体工作链" })
    .getByRole("button", { name: /剧本 → 素材/ })
    .click();
  await page.getByRole("combobox", { name: "工作状态" }).selectOption("ALL");
  checked.push("current-work stages and filters");
  await nav("系统管理").click();
  await page.getByRole("button", { name: "系统配置", exact: true }).click();
  await page.locator(".configuration-workspace").waitFor();
  await page.getByRole("button", { name: "数据与运行", exact: true }).click();
  await page
    .getByRole("button", { name: "创建完整备份", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "核验当前实例", exact: true })
    .waitFor();
  checked.push("system configuration and maintenance entry points");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("故事创作").click();
  await ready();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Mobile viewport should not overflow",
  );
  checked.push("mobile layout");
  assert.deepEqual(errors, []);
  const result = {
    status: "PASSED",
    checked,
    errors,
    realModelCalls: 0,
    productionWrites: 0,
    fixture: health.project.instanceId,
  };
  await writeFile(
    values.output ||
      path.join(process.env.REVIEW_TASK_DIR, "restored-workflows.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
