import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import {
  buildHandbook,
  compileMarkdown,
  inventory,
} from "../tools/handbook.mjs";
import { renderDiagram } from "../tools/handbook-diagrams.mjs";
import { documentationResponse } from "../server/documentation.mjs";
import { requiredPhase } from "../tools/process-resources.mjs";

test("handbook compiles all chapters, keeps precise schema inventory and serves without database access", async () => {
  const phase = await requiredPhase(process.cwd());
  assert(phase);
  const root = process.cwd(),
    output = path.join(process.env.REVIEW_TASK_DIR, "handbook");
  const result = await buildHandbook({ root, output });
  assert.equal(result.chapters, 12);
  assert.equal(result.diagrams, 17);
  assert(result.bytes < 2 * 1024 * 1024);
  const schema = await inventory(root);
  assert.match(
    schema.tables.find((t) => t.name === "project").definition,
    /instance_id/,
  );
  assert.doesNotMatch(
    schema.tables.find((t) => t.name === "schema_version").definition,
    /CREATE TABLE/,
  );
  assert(schema.routes.includes("import"));
  assert(schema.routes.includes("upload"));
  assert(schema.enums.some((e) => e.values.includes("RESULT_UNKNOWN")));
  const get = (suffix, headers = {}) =>
    documentationResponse(
      new Request("http://fixture/api/v1/documentation/" + suffix, { headers }),
      ["documentation", ...suffix.split("/").filter(Boolean)],
      { root: output },
    );
  const catalog = await (await get("catalog")).json();
  assert.equal(catalog.chapters.length, 12);
  for (const chapter of catalog.chapters) {
    const response = await get("chapters/" + chapter.id);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.bookSha256, catalog.contentSha256);
    assert.match(data.html, /<h1/);
    assert(data.references.length > 0);
    assert(data.toc.length > 0);
    assert(!data.html.includes("<script"));
    const cached = await get("chapters/" + chapter.id, {
      "if-none-match": response.headers.get("etag"),
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
  }
  for (const figure of catalog.diagrams) {
    const response = await get("assets/" + figure.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    const svg = await response.text();
    assert.match(svg, /<title/);
    assert.match(svg, /<desc/);
    assert(!/<script|foreignObject|https?:\/\/(?!www.w3.org)/i.test(svg));
  }
  for (const route of [
    "assets/../catalog",
    "chapters/missing",
    "assets/missing",
    "chapters/runtime/extra",
  ])
    assert.equal((await get(route)).status, 404);
  assert.equal(
    (
      await documentationResponse(
        new Request("http://fixture", { method: "POST" }),
        ["documentation", "catalog"],
        { root: output },
      )
    ).status,
    405,
  );
  const previous = {
    root: process.env.REVIEW_DOCUMENTATION_ROOT,
    instance: process.env.REVIEW_INSTANCE_ROOT,
  };
  try {
    process.env.REVIEW_DOCUMENTATION_ROOT = output;
    process.env.REVIEW_INSTANCE_ROOT = "/unavailable-story-instance";
    const { dispatch } = await import("../server/api.mjs");
    assert.equal(
      (
        await dispatch(
          new Request("http://fixture/api/v1/documentation/catalog"),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await dispatch(
          new Request("http://fixture/api/v1/documentation/catalog", {
            method: "POST",
          }),
        )
      ).status,
      405,
    );
  } finally {
    for (const [key, value] of [
      ["REVIEW_DOCUMENTATION_ROOT", previous.root],
      ["REVIEW_INSTANCE_ROOT", previous.instance],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Markdown and diagram text cannot become executable content or arbitrary resource paths", () => {
  const c = [{ id: "intro" }, { id: "details" }];
  const doc = compileMarkdown(
    "# Intro\n\n<script>alert(1)</script>\n\n[go](details.md#part)\n\n![diagram](../assets/overview.svg)",
    "intro",
    c,
  );
  assert(!doc.html.includes("<script>"));
  assert(doc.html.includes("&lt;script&gt;"));
  assert(doc.html.includes("systemTab=architecture"));
  assert(doc.html.includes('data-diagram="overview"'));
  assert.throws(() =>
    compileMarkdown("# Intro\n\n![x](../../secret.svg)", "intro", c),
  );
  assert.throws(() =>
    compileMarkdown("# Intro\n\n[missing](missing.md)", "intro", c),
  );
  assert.throws(() =>
    compileMarkdown("# Intro\n\n## Repeat\n\n## Repeat", "intro", c),
  );
  assert(
    !compileMarkdown(
      "# Intro\n\n[x](javascript:alert(1))",
      "intro",
      c,
    ).html.includes('href="javascript:'),
  );
  const svg = renderDiagram({
    id: "escape-check",
    title: "<script>",
    description: '" onload="x',
    nodes: [
      {
        id: "x",
        label: "</text><script>",
        domain: "story",
        col: 0,
        row: 0,
        lines: ["<&>"],
      },
    ],
    edges: [],
  });
  assert(!svg.includes("<script>"));
  assert(svg.includes("&lt;script&gt;"));
});

test("coverage changes, stale diagrams, source drift and broken anchors block release", async () => {
  await requiredPhase(process.cwd());
  const root = path.join(process.env.REVIEW_TASK_DIR, "drift-fixture");
  await mkdir(root);
  await cp("docs/handbook", path.join(root, "docs/handbook"), {
    recursive: true,
  });
  const manifestPath = path.join(root, "docs/handbook/manifest.json"),
    original = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const file of new Set(original.chapters.flatMap((c) => c.sources))) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await cp(file, path.join(root, file));
  }
  const broken = structuredClone(original);
  delete broken.coverage.tables.objects;
  await writeFile(manifestPath, JSON.stringify(broken));
  await assert.rejects(
    buildHandbook({ root, mode: "check" }),
    /coverage drift/,
  );
  await writeFile(manifestPath, JSON.stringify(original));
  const diagram = path.join(root, "docs/handbook/assets/overview.svg"),
    bytes = await readFile(diagram);
  await writeFile(diagram, "changed");
  await assert.rejects(
    buildHandbook({ root, mode: "check" }),
    /Diagram out of date/,
  );
  await writeFile(diagram, bytes);
  const api = path.join(root, "server/api.mjs"),
    apiBytes = await readFile(api);
  await writeFile(
    api,
    Buffer.concat([apiBytes, Buffer.from("\n// changed implementation\n")]),
  );
  await assert.rejects(
    buildHandbook({ root, mode: "check" }),
    /needs implementation review/,
  );
  await writeFile(api, apiBytes);
  const chapter = path.join(root, "docs/handbook/chapters/overview.md");
  await writeFile(
    chapter,
    (await readFile(chapter, "utf8")) + "\n[bad](./runtime.md#nonexistent)\n",
  );
  await assert.rejects(
    buildHandbook({ root, mode: "check" }),
    /Broken handbook anchor/,
  );
});
