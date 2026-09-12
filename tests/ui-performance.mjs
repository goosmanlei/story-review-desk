import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { workspaceReady } from "./browser-readiness.mjs";
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    minutes: { type: "string", default: "60" },
    switches: { type: "string", default: "300" },
    saves: { type: "string", default: "100" },
  },
});
assert(process.env.REVIEW_PROCESS_CONTEXT);
const base = new URL(values.url),
  get = async (route) => {
    const r = await fetch(new URL("api/v1/" + route, base));
    assert(r.ok);
    return r.json();
  },
  health = await get("health");
assert(health.project.instanceId.startsWith("ui-fixture-"));
const duration = Number(values.minutes) * 60000,
  steps = Number(values.switches),
  saveCount = Number(values.saves);
assert(steps >= 30 && saveCount > 0 && duration >= 0);
const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--enable-precise-memory-info"],
  }),
  errors = [],
  cold = [],
  moduleSamples = [],
  sceneSamples = [],
  saveSamples = [],
  resources = [];
const modules = [
  ["overview", "当前工作"],
  ["story", "故事创作"],
  ["settings", "故事设定"],
  ["materials", "素材管理"],
  ["production", "全剧制作"],
  ["project", "系统管理"],
];
const ready = async (page, module) => {
  if (module === "overview")
    await page.locator('.overview[data-ready="overview"]').waitFor();
  else if (module === "project")
    await page.locator('.system-panel[data-ready="workspace"]').waitFor();
  else await workspaceReady(page, module);
};
const observe = (page) => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Cannot update|hydration|Each child/.test(m.text())
    )
      errors.push(m.text());
  });
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: Math.round(s[Math.floor(s.length * 0.5)]),
    p95: Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]),
    max: Math.round(s.at(-1)),
  };
};
try {
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage();
    observe(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    const start = performance.now();
    await page.goto(base.href);
    await ready(page, "overview");
    cold.push(performance.now() - start);
    await context.close();
  }
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  observe(page);
  await page.goto(base.href);
  await ready(page, "overview");
  const nav = (label) =>
    page
      .getByRole("navigation", { name: "工作区" })
      .getByRole("button", { name: new RegExp(label) });
  for (let i = 0; i < 30; i++) {
    const [m, l] = modules[(i + 1) % 6],
      start = performance.now();
    await nav(l).click();
    await ready(page, m);
    moduleSamples.push(performance.now() - start);
  }
  const marker = "performance-" + randomUUID(),
    scene = marker + "-a",
    other = marker + "-b",
    episode = marker + "-episode";
  const seed = [
    ...[scene, other].map((id) => ({
      type: "save",
      id,
      kind: "SCENE",
      title: id,
      expectedVersion: 0,
      content: {
        blocks: [
          {
            id: id + "-block",
            type: "action",
            text: "旅人在站台核对信封上的收信人。",
          },
        ],
        purpose: "独立性能验收",
      },
    })),
    {
      type: "save",
      id: episode,
      kind: "EPISODE",
      title: marker,
      expectedVersion: 0,
      content: { coreAdvance: "独立性能验收" },
      links: [
        { id: scene, role: "SCENE" },
        { id: other, role: "SCENE" },
      ],
    },
  ];
  const result = await fetch(new URL("api/v1/transactions", base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-review-runtime": health.project.runtimeEpoch,
    },
    body: JSON.stringify({ operationId: randomUUID(), commands: seed }),
  });
  assert(result.ok, await result.text());
  await page.goto(
    new URL("?view=story&kind=SCENE&owner=" + episode + "&id=" + scene, base)
      .href,
  );
  await workspaceReady(page, "story", "SCENE", scene);
  for (let i = 0; i < 40; i++) {
    const id = i % 2 ? scene : other,
      start = performance.now();
    await page.locator('[data-catalog-id="' + id + '"]').click();
    await workspaceReady(page, "story", "SCENE", id);
    sceneSamples.push(performance.now() - start);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const sample = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    resources.push({
      at: Date.now(),
      ...(await cdp.send("Memory.getDOMCounters")),
      heap: await page.evaluate(() => performance.memory.usedJSHeapSize),
    });
  };
  await sample();
  const started = Date.now();
  let saves = 0,
    version = (await get("objects/" + scene)).version;
  for (let i = 0; i < steps; i++) {
    const [m, l] = modules[i % 6];
    await nav(l).click();
    await ready(page, m);
    if (saves < Math.floor(((i + 1) * saveCount) / steps)) {
      await nav("故事创作").click();
      await workspaceReady(page, "story", "SCENE", scene);
      await page.getByRole("button", { name: "编辑内容", exact: true }).click();
      const text = "隔离持续使用验收 " + saves;
      await page
        .getByRole("textbox", { name: "第 1 段正文", exact: true })
        .fill(text);
      const start = performance.now(),
        saved = page.waitForResponse(
          (r) =>
            r.url().includes("/api/v1/objects/" + scene) && r.status() === 200,
        );
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      const readback = await (await saved).json();
      assert.equal(readback.version, ++version);
      assert.equal(readback.revision.content.blocks[0].text, text);
      await workspaceReady(page, "story", "SCENE", scene);
      saveSamples.push(performance.now() - start);
      saves++;
      if (
        await page
          .getByRole("button", { name: "返回阅读", exact: true })
          .count()
      )
        await page
          .getByRole("button", { name: "返回阅读", exact: true })
          .click();
    }
    if (i % 25 === 24) {
      await sample();
      console.log(
        JSON.stringify({
          progress: i + 1,
          saves,
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
        }),
      );
    }
    const wait = started + ((i + 1) * duration) / steps - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await nav("故事创作").click();
  await workspaceReady(page, "story", "SCENE", scene);
  await sample();
  const report = {
    status: "PASSED",
    software: health.softwareCommit,
    fixture: health.project.instanceId,
    coldBrowserMs: cold.map(Math.round),
    moduleMs: stats(moduleSamples),
    sceneMs: stats(sceneSamples),
    saveMs: stats(saveSamples),
    soak: {
      minutes: Math.round((Date.now() - started) / 600) / 100,
      switches: steps,
      saves,
      resources,
    },
    errors,
    realModelCalls: 0,
    productionWrites: 0,
  };
  assert(
    cold.every((x) => x <= 3000),
    "Cold browser readiness exceeds 3 seconds",
  );
  assert(report.moduleMs.p95 <= 500, "Module P95 exceeds 500 ms");
  assert(report.sceneMs.p95 <= 300, "Scene P95 exceeds 300 ms");
  assert(report.saveMs.p95 <= 1000, "Save P95 exceeds 1 second");
  assert.equal(saves, saveCount);
  assert.deepEqual(errors, []);
  assert(
    resources.at(-1).heap - resources[0].heap < 32 * 1024 * 1024,
    "Heap continues growing beyond the bounded caches",
  );
  await writeFile(
    path.join(process.env.REVIEW_TASK_DIR, "performance.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
