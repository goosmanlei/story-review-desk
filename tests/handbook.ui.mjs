import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { requiredPhase } from "../tools/process-resources.mjs";
import {
  timedInteraction,
  originalReady,
  originalModules,
} from "./original-readiness.mjs";
const phase = await requiredPhase(process.cwd());
assert(phase);
const base = process.env.REVIEW_UI_BASE || "http://127.0.0.1:3941",
  blank = process.env.REVIEW_HANDBOOK_EMPTY === "1";
const directory = path.resolve(
  ".process/shared/handbook-visual-" +
    (blank ? "blank" : "story") +
    "-" +
    Date.now(),
);
await mkdir(path.dirname(directory), { recursive: true });
await phase.directory(directory);
async function snapshot() {
  const response = await fetch(base + "/api/v1/export");
  assert(response.ok);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}
const before = await snapshot(),
  book = await (await fetch(base + "/api/v1/documentation/catalog")).json();
assert.equal(book.chapters.length, 12);
const browser = await chromium.launch({ channel: "chrome" }),
  errors = [],
  mutations = [],
  cold = [],
  chapterTimes = [],
  tabTimes = [];
let context, page;
try {
  for (let i = 0; i < 5; i++) {
    const c = await browser.newContext({
        viewport: { width: 1600, height: 1100 },
      }),
      p = await c.newPage();
    const start = performance.now();
    await p.goto(
      base + "/?view=system&systemTab=architecture&chapter=overview",
      { waitUntil: "domcontentloaded" },
    );
    await p.locator('[data-handbook-chapter="overview"]').waitFor();
    await p.locator(".handbook-prose img").evaluateAll((imgs) =>
      Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
              }),
        ),
      ),
    );
    cold.push(Math.round(performance.now() - start));
    if (i === 4) {
      context = c;
      page = p;
    } else await c.close();
  }
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/api/"))
      errors.push(r.status() + " " + r.url());
  });
  page.on("request", (r) => {
    if (
      r.method() !== "GET" &&
      r.url().includes("/api/") &&
      !r.url().endsWith("/assistant/context")
    )
      mutations.push(r.method() + " " + r.url());
  });
  const ready = async (id) => {
    await page.locator('[data-handbook-chapter="' + id + '"]').waitFor();
    if (id === "instance") await page.locator('[data-instance-ready="true"]').waitFor();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  };
  const button = (c) =>
    page.locator(".handbook-directory nav button").filter({ hasText: c.title });
  for (const c of book.chapters) {
    await button(c).click();
    await ready(c.id);
    if (c.id === "instance")
      await page.locator('[data-instance-ready="true"]').waitFor();
    assert.equal(
      await page.locator(".handbook-prose h1").innerText(),
      c.title === "术语、实现索引与设计决策"
        ? "术语、实现索引与设计决策"
        : c.title,
    );
  }
  for (let i = 0; i < 30; i++) {
    const c = book.chapters[i % book.chapters.length];
    chapterTimes.push(
      await timedInteraction(page, button(c), () => ready(c.id)),
    );
  }
  await button(book.chapters[0]).click();
  await ready("overview");
  await page.locator(".handbook-prose img").focus();
  await page.keyboard.press("Enter");
  await page.locator(".handbook-diagram-dialog[open]").waitFor();
  await page.getByLabel("图表缩放", { exact: true }).fill("1.5");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".handbook-diagram-dialog[open]").count(), 0);
  await page.getByRole("searchbox", { name: "搜索整本手册" }).fill("采用头");
  assert((await page.locator(".handbook-search-results button").count()) > 1);
  await page.getByRole("button", { name: "返回完整目录" }).click();
  await button(book.chapters.find((c) => c.id === "operations")).click();
  await ready("operations");
  await page.locator(".handbook-content").evaluate((e) => (e.scrollTop = 650));
  await page.waitForTimeout(250);
  const scroll = await page
    .locator(".handbook-content")
    .evaluate((e) => e.scrollTop);
  await page.getByRole("tab", { name: "数据与运行", exact: true }).click();
  await page.getByRole("tab", { name: "系统架构", exact: true }).click();
  await ready("operations");
  assert(
    Math.abs(
      (await page.locator(".handbook-content").evaluate((e) => e.scrollTop)) -
        scroll,
    ) < 4,
  );
  for (let i = 0; i < 30; i++) {
    await page.getByRole("tab", { name: "使用与初始化", exact: true }).click();
    tabTimes.push(
      await timedInteraction(
        page,
        page.getByRole("tab", { name: "系统架构", exact: true }),
        () => ready("operations"),
      ),
    );
  }
  await page.goto(
    base +
      "/?view=system&systemTab=architecture&chapter=data-model#素材与实际制作输入",
    { waitUntil: "domcontentloaded" },
  );
  await ready("data-model");
  await page.waitForTimeout(150);
  const distance = await page
    .locator(".handbook-content")
    .evaluate(
      (e) =>
        e.querySelector("#素材与实际制作输入").getBoundingClientRect().top -
        e.getBoundingClientRect().top,
    );
  assert(distance >= 0 && distance < 60, String(distance));
  await page.screenshot({
    path: path.join(directory, "reader.png"),
    fullPage: false,
  });
  await button(book.chapters.find((c) => c.id === "instance")).click();
  await ready("instance");
  await page.locator('[data-instance-ready="true"]').waitFor();
  if (blank) {
    assert(
      await page
        .locator(".handbook-object-picker")
        .innerText()
        .then((t) => t.includes("尚未登记")),
    );
  } else {
    await page.locator(".handbook-object-picker button").first().click();
    await page.locator("[data-handbook-object]").waitFor();
    const identity = await page
      .locator("[data-handbook-object]")
      .getAttribute("data-handbook-object");
    const data = await (
      await fetch(base + "/api/v1/contexts/" + encodeURIComponent(identity))
    ).json();
    assert.equal(
      await page
        .locator("[data-handbook-object]")
        .getAttribute("data-handbook-revision"),
      data.object.revision.id,
    );
    const select = page.getByLabel("实例修订", { exact: true });
    const versions = data.object.versions;
    if (versions.length > 1) {
      await select.selectOption(versions.at(-1).id);
      await page
        .locator('[data-handbook-revision="' + versions.at(-1).id + '"]')
        .waitFor();
    }
    await page.locator('.handbook-instance-graph').scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    const instancePosition = await page.locator('.handbook-content').evaluate(e => e.scrollTop);
    await button(book.chapters[0]).click();
    await ready('overview');
    await page.route('**/api/v1/contexts/**', async route => { await new Promise(resolve => setTimeout(resolve, 200)); await route.continue(); });
    await button(book.chapters.find(c => c.id === 'instance')).click();
    await page.locator('[data-instance-ready="true"]').waitFor();
    await page.waitForTimeout(50);
    assert(Math.abs(await page.locator('.handbook-content').evaluate(e => e.scrollTop) - instancePosition) < 4, 'Instance reading position waits for complete context');
    await page.unroute('**/api/v1/contexts/**');
    await page.screenshot({
      path: path.join(directory, "instance.png"),
      fullPage: false,
    });
  }
  await page.setViewportSize({ width: 620, height: 950 });
  await button(book.chapters.find((c) => c.id === "overview")).click();
  await ready("overview");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  await page.screenshot({ path: path.join(directory, "narrow.png") });
  await page.setViewportSize({ width: 1600, height: 1100 });
  if (!blank)
    for (const [id, label] of originalModules) {
      await page
        .locator(".workspace-nav button")
        .filter({ hasText: label })
        .click();
      await originalReady(page, id);
    }
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, []);
  assert.equal(
    await snapshot(),
    before,
    "Documentation reads must not change the business export",
  );
  const p95 = (values) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  assert(p95(chapterTimes) <= 300, JSON.stringify({ chapterTimes }));
  assert(p95(tabTimes) <= 500, JSON.stringify({ tabTimes }));
  assert(cold.every(value => value <= 3000), JSON.stringify({cold}));
  const receipt = {
    status: "PASSED",
    blank,
    chapters: 12,
    diagrams: 17,
    coldMs: cold,
    chapterP95: p95(chapterTimes),
    tabP95: p95(tabTimes),
    businessExportUnchanged: true,
    errors,
    mutations,
  };
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  await phase.transfer("path", directory, "visual-review");
  console.log(JSON.stringify({ ...receipt, directory }));
} finally {
  await browser.close();
}
