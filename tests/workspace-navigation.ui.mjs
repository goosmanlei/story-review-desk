// Read-only browser regression against a populated, isolated acceptance project.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
const { values } = parseArgs({
  options: { url: { type: "string" }, output: { type: "string" } },
});
assert(
  process.env.REVIEW_PROCESS_CONTEXT,
  "Run UI verification through the process executor",
);
const base = new URL(values.url),
  browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [],
  checked = [];
page.on("pageerror", (e) => errors.push(e.message));
const get = async (route) => {
  const r = await fetch(new URL("api/v1/" + route, base));
  assert(r.ok);
  return r.json();
};
const health = await get("health");
assert(
  health.project.instanceId.startsWith("ui-fixture-"),
  "Only an isolated UI acceptance fixture is allowed",
);
async function ready(module, kind) {
  await page.waitForFunction(
    ({ module, kind }) => {
      const w = document.querySelector(".workbench");
      if (
        w?.dataset.module !== module ||
        w.dataset.kind !== kind ||
        w.dataset.ready !== "workspace"
      )
        return false;
      const rows = w.querySelectorAll("[data-catalog-id]"),
        d = w.querySelector("article[data-ready=detail]");
      if (!rows.length) return !d;
      return (
        d?.dataset.objectKind === kind &&
        [...rows].some(
          (r) =>
            r.getAttribute("aria-current") === "location" &&
            r.dataset.catalogId === d.dataset.objectId,
        )
      );
    },
    { module, kind },
  );
}
try {
  // Hold catalog responses long enough to expose any reuse of a previous query.
  await page.route("**/api/v1/objects?*", async (route) => {
    await new Promise((r) => setTimeout(r, 120));
    await route.continue();
  });
  await page.goto(new URL("?view=story&kind=SCENE", base).href);
  await ready("story", "SCENE");
  for (const [module, kinds] of Object.entries({
    story: ["SOURCE", "STORY", "EPISODE", "SCENE"],
    settings: ["ENTITY", "STATE", "REPRESENTATION", "SPACE", "RELATION"],
    materials: [
      "MATERIAL",
      "REQUIREMENT",
      "ASSET",
      "PROMPT",
      "CALL",
      "EXPECTED_OUTPUT",
    ],
    production: [
      "PREPARATION",
      "COVERAGE",
      "SHOT_DESIGN",
      "SHOT",
      "INPUT_LOCK",
      "ASSEMBLY",
      "DELIVERABLE",
    ],
  })) {
    for (const kind of kinds) {
      await page.goto(new URL("?view=" + module + "&kind=" + kind, base).href);
      await ready(module, kind);
      checked.push({ module, kind });
    }
  }
  await page
    .getByRole("navigation", { name: "工作区" })
    .getByRole("button", { name: /故事创作/ })
    .click();
  await page.getByRole("tab", { name: "叙事拆解", exact: true }).click();
  await page.getByRole("tab", { name: "场正文", exact: true }).click();
  await ready("story", "SCENE");
  const episodes = await get("objects?kind=EPISODE&limit=200&historical=false");
  let episode, scenes;
  for (const candidate of episodes.items) {
    const rows = await get(
      "objects?kind=SCENE&limit=50&historical=false&owner=" +
        encodeURIComponent(candidate.id),
    );
    if (rows.items.length > 1) {
      episode = candidate;
      scenes = rows;
      break;
    }
  }
  assert(
    episode && scenes,
    "The acceptance fixture needs an episode with at least two scenes",
  );
  const chosen = scenes.items[1],
    search = page.getByRole("textbox", { name: "搜索对象", exact: true });
  await search.fill(chosen.title);
  await ready("story", "SCENE");
  const matching = await get(
    "objects?kind=SCENE&historical=false&query=" +
      encodeURIComponent(chosen.title),
  );
  assert.equal(
    await page
      .locator("article[data-ready=detail]")
      .getAttribute("data-object-id"),
    matching.items[0].id,
  );
  await search.fill("");
  await ready("story", "SCENE");
  const owner = page.getByRole("combobox", { name: "分集筛选" });
  await owner.selectOption(episode.id);
  await ready("story", "SCENE");
  const filtered = await get(
    "objects?kind=SCENE&historical=false&owner=" +
      encodeURIComponent(episode.id),
  );
  const id = filtered.items[0].id;
  assert.equal(
    await page
      .locator("article[data-ready=detail]")
      .getAttribute("data-object-id"),
    id,
  );
  const current = await get("objects/" + encodeURIComponent(id));
  // Capture both a reading position and a text selection for this exact revision.
  const selected = await page.locator(".content-body").evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()))
      if ((node.textContent || "").trim().length > 12) break;
    if (!node) throw Error("Scene fixture has no selectable content");
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 10);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const before = range.cloneRange();
    before.selectNodeContents(body);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return {
      text: selection.toString(),
      start,
      slice: body.textContent.slice(start, start + range.toString().length),
    };
  });
  await page.locator(".detail-scroll").evaluate((element) => {
    element.scrollTop = Math.min(
      250,
      element.scrollHeight - element.clientHeight,
    );
  });
  const scroll = await page
    .locator(".detail-scroll")
    .evaluate((e) => e.scrollTop);
  await page
    .getByRole("navigation", { name: "工作区" })
    .getByRole("button", { name: /故事设定/ })
    .click();
  await page
    .getByRole("navigation", { name: "工作区" })
    .getByRole("button", { name: /故事创作/ })
    .click();
  await ready("story", "SCENE");
  try {
    await page.waitForFunction(
      (text) => window.getSelection()?.toString() === text,
      selected.text,
      { timeout: 3000 },
    );
  } catch {
    throw Error(
      JSON.stringify({
        selectionExpected: selected,
        actual: await page.evaluate(() => ({
          selection: window.getSelection()?.toString(),
          object: document.querySelector("article[data-ready=detail]")?.dataset
            .objectId,
          slice: document
            .querySelector(".content-body")
            ?.textContent?.slice(0, 30),
        })),
        id,
      }),
    );
  }
  assert.equal(await owner.inputValue(), episode.id);
  await page.waitForFunction(
    (top) =>
      Math.abs(document.querySelector(".detail-scroll").scrollTop - top) <= 1,
    scroll,
  );
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  const text = page.getByRole("textbox", {
    name:
      current.revision.content.blocks || current.revision.content.scriptBlocks
        ? "第 1 段正文"
        : "场正文",
    exact: true,
  });
  const original = await text.inputValue();
  await text.fill(original + "\nUnsaved UI regression check");
  await page
    .getByRole("navigation", { name: "工作区" })
    .getByRole("button", { name: /故事设定/ })
    .click();
  await page
    .getByRole("navigation", { name: "工作区" })
    .getByRole("button", { name: /故事创作/ })
    .click();
  await ready("story", "SCENE");
  await text.waitFor();
  assert.equal(
    await text.inputValue(),
    original + "\nUnsaved UI regression check",
  );
  assert.equal(
    (await get("objects/" + encodeURIComponent(id))).version,
    current.version,
  );
  assert.deepEqual(errors, []);
  const result = {
    status: "PASSED",
    commit: health.softwareCommit,
    checked,
    filterIdentity: true,
    readingPosition: true,
    selection: true,
    unsavedDraft: true,
    businessWrites: 0,
    errors,
  };
  await writeFile(
    values.output || path.join(process.env.REVIEW_TASK_DIR, "navigation.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
