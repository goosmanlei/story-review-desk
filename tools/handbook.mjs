import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import MarkdownIt from "markdown-it";
import {
  digest,
  escape,
  renderDiagram,
  diagramDimensions,
} from "./handbook-diagrams.mjs";
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
const identifier = /^[a-z][a-z0-9-]*$/;
export function compileMarkdown(markdown, chapterId, catalog, diagrams = []) {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  });
  const tokens = md.parse(markdown, {}),
    toc = [],
    links = [],
    images = [],
    seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      const inline = tokens[i + 1],
        text = inline.content;
      const anchor = slug(text);
      if (!anchor || seen.has(anchor))
        throw Error(`Duplicate heading ${chapterId}: ${text}`);
      seen.add(anchor);
      token.attrSet("id", anchor);
      if (token.tag !== "h1")
        toc.push({
          id: anchor,
          title: text,
          level: Number(token.tag.slice(1)),
        });
    }
    for (const child of token.children || []) {
      if (child.type === "image") {
        const original = child.attrGet("src");
        const match = /^\.\.\/assets\/([a-z][a-z0-9-]*)\.svg$/.exec(
          original || "",
        );
        if (!match)
          throw Error(
            `Only registered handbook diagrams are allowed: ${original}`,
          );
        const shape = diagrams.find((d) => d.id === match[1]);
        if (shape) {
          const size = diagramDimensions(shape);
          child.attrSet("width", String(size.width));
          child.attrSet("height", String(size.height));
        }
        images.push(match[1]);
        child.attrSet("src", `/api/v1/documentation/assets/${match[1]}`);
        child.attrSet("loading", "lazy");
        child.attrSet("data-diagram", match[1]);
        child.attrSet("tabindex", "0");
        child.attrSet("role", "button");
        child.attrSet("aria-label", "放大图表：" + child.content);
      }
      if (child.type === "link_open") {
        const href = child.attrGet("href") || "";
        links.push(href);
        if (href.startsWith("#"))
          child.attrSet(
            "href",
            `?view=system&systemTab=architecture&chapter=${chapterId}${href}`,
          );
        else if (!/^https:\/\//.test(href)) {
          const match = /^(?:\.\/)?([a-z][a-z0-9-]*)\.md(?:#(.+))?$/.exec(href);
          if (!match || !catalog.some((c) => c.id === match[1]))
            throw Error(`Unregistered handbook link: ${href}`);
          child.attrSet(
            "href",
            `?view=system&systemTab=architecture&chapter=${match[1]}${match[2] ? "#" + match[2] : ""}`,
          );
        } else child.attrSet("rel", "noreferrer");
      }
    }
  }
  return {
    html: md.renderer.render(tokens, md.options, {}),
    toc,
    anchors: [...seen],
    links,
    images,
    text: tokens
      .filter((t) => t.type === "inline")
      .map((t) => t.content)
      .join("\n"),
  };
}
export async function inventory(root = here) {
  const sql = await readFile(path.join(root, "server/schema.sql"), "utf8");
  const tables = [];
  for (const match of sql.matchAll(/CREATE TABLE (\w+) \(/g)) {
    const start = match.index + match[0].length;
    let depth = 1,
      quote = false,
      end = start;
    for (; end < sql.length; end++) {
      const c = sql[end];
      if (c === "'") {
        if (quote && sql[end + 1] === "'") {
          end++;
          continue;
        }
        quote = !quote;
      }
      if (!quote) {
        if (c === "(") depth++;
        if (c === ")" && --depth === 0) break;
      }
    }
    if (depth !== 0) throw Error("Unbalanced CREATE TABLE");
    tables.push({ name: match[1], definition: sql.slice(start, end) });
  }
  const enums = [
    ...sql.matchAll(
      /([\w.]+) (?:text[^\n]*?)?CHECK\s*\(\s*([\w.]+)\s+IN\s*\(([^)]+)\)/g,
    ),
  ].map((m) => ({
    field: m[2],
    values: [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  }));
  const kinds = {};
  for (const domain of [
    "story",
    "settings",
    "materials",
    "production",
    "collaboration",
    "project",
  ]) {
    const code = await readFile(
      path.join(root, `server/${domain}/service.mjs`),
      "utf8",
    );
    kinds[domain] = [
      ...code
        .match(/export const kinds\s*=\s*\[([\s\S]*?)\]/)[1]
        .matchAll(/"([A-Z_]+)"/g),
    ].map((m) => m[1]);
  }
  const api = await readFile(path.join(root, "server/api.mjs"), "utf8");
  const families = [
    ...api.matchAll(/route\[0\]\s*===?\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  for (const match of api.matchAll(/\[([^\]\n]+)\]\.includes\(route\[0\]\)/g))
    for (const item of match[1].matchAll(/['"]([^'"]+)['"]/g))
      families.push(item[1]);
  const routes = [...new Set(families)].sort();
  return { tables, enums, kinds, routes };
}
export async function buildHandbook({
  root = here,
  output = path.join(root, "web/.handbook"),
  mode = "build",
} = {}) {
  const home = path.join(root, "docs/handbook");
  const manifest = JSON.parse(
    await readFile(path.join(home, "manifest.json"), "utf8"),
  );
  const diagrams = JSON.parse(
    await readFile(path.join(home, "diagrams.json"), "utf8"),
  );
  if (
    manifest.version !== 1 ||
    new Set(manifest.chapters.map((c) => c.id)).size !==
      manifest.chapters.length
  )
    throw Error("Invalid handbook manifest");
  if (mode === "diagrams")
    await mkdir(path.join(home, "assets"), { recursive: true });
  for (const diagram of diagrams) {
    const svg = renderDiagram(diagram),
      file = path.join(home, "assets", diagram.id + ".svg");
    if (mode === "diagrams") await writeFile(file, svg);
    else if ((await readFile(file, "utf8")) !== svg)
      throw Error(`Diagram out of date: ${diagram.id}; run docs:diagrams`);
  }
  if (mode === "diagrams")
    return { status: "GENERATED", diagrams: diagrams.length };
  const live = await inventory(root),
    coverage = manifest.coverage;
  for (const [label, actual, known] of [
    ["tables", live.tables.map((t) => t.name), Object.keys(coverage.tables)],
    ["kinds", Object.values(live.kinds).flat(), Object.keys(coverage.kinds)],
    ["routes", live.routes, Object.keys(coverage.routes)],
    [
      "states",
      [
        ...new Set(
          live.enums.flatMap((e) => e.values.map((v) => e.field + ":" + v)),
        ),
      ],
      Object.keys(coverage.states),
    ],
  ]) {
    const missing = actual.filter((x) => !known.includes(x)),
      stale = known.filter((x) => !actual.includes(x));
    if (missing.length || stale.length)
      throw Error(
        `Handbook ${label} coverage drift: missing=${missing}; stale=${stale}`,
      );
  }
  for (const id of Object.values(coverage).flatMap((v) => Object.values(v)))
    if (!manifest.chapters.some((c) => c.id === id))
      throw Error("Coverage refers to missing chapter");
  const documents = [];
  for (const c of manifest.chapters) {
    if (
      !identifier.test(c.id) ||
      !c.summary ||
      !/^\d{4}-\d{2}-\d{2}$/.test(c.reviewedAt)
    )
      throw Error("Incomplete handbook chapter metadata");
    let markdown = await readFile(
      path.join(home, "chapters", c.id + ".md"),
      "utf8",
    );
    const references = [];
    for (const reference of c.sources) {
      if (path.isAbsolute(reference) || reference.split("/").includes(".."))
        throw Error("Invalid source reference");
      const file = path.join(root, reference),
        info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink())
        throw Error("Invalid source file");
      references.push({
        path: reference,
        sha256: digest(await readFile(file)),
      });
    }
    // Source hashes acknowledge human review of the final implementation, without
    // pinning the chapter to a self-referential Git commit.
    if (c.sourceDigest !== digest(JSON.stringify(references)))
      throw Error(
        `Chapter needs implementation review: ${c.id}; refresh its sourceDigest after reviewing the cited sources`,
      );
    const compiled = compileMarkdown(
      markdown,
      c.id,
      manifest.chapters,
      diagrams,
    );
    for (const id of compiled.images)
      if (!diagrams.some((d) => d.id === id))
        throw Error("Unknown diagram " + id);
    if (c.id === "reference") {
      compiled.anchors.push('generated-index', 'object-kind-index', 'table-index', 'state-index', 'endpoint-index');
      compiled.toc.push({
        id: "generated-index",
        title: "从实现提取的完整索引",
        level: 2,
      });
    }
    documents.push({
      ...c,
      ...compiled,
      markdown,
      references,
      contentSha256: digest(markdown),
    });
  }
  for (const doc of documents)
    for (const href of doc.links) {
      const match = /^(?:(?:\.\/)?([a-z][a-z0-9-]*)\.md)?#(.+)$/.exec(href);
      if (match) {
        const target = documents.find((d) => d.id === (match[1] || doc.id));
        if (!target?.anchors.includes(decodeURIComponent(match[2])))
          throw Error(`Broken handbook anchor: ${href}`);
      }
    }
  const last = documents.find((d) => d.id === "reference");
  const dictionary =
    '\n<h2 id="generated-index">从实现提取的完整索引</h2>\n' +
    '<h3 id="object-kind-index">领域与对象类型</h3><table><thead><tr><th>领域</th><th>对象类型</th></tr></thead><tbody>' +
    Object.entries(live.kinds)
      .map(
        ([k, v]) =>
          `<tr><td>${escape(k)}</td><td>${escape(v.join(" · "))}</td></tr>`,
      )
      .join("") +
    "</tbody></table>" +
    '<h3 id="table-index">数据库表与字段</h3>' +
    live.tables
      .map(
        (t) =>
          `<details><summary><code>${escape(t.name)}</code> · ${escape(coverage.tables[t.name])}</summary><pre><code>${escape(t.definition.trim())}</code></pre></details>`,
      )
      .join("") +
    '<h3 id="state-index">约束中的状态与枚举</h3>' +
    live.enums
      .map(
        (e) =>
          `<p><code>${escape(e.field)}</code>：${escape(e.values.join(" · "))}</p>`,
      )
      .join("") +
    '<h3 id="endpoint-index">接口族覆盖</h3><table><thead><tr><th>/api/v1 下的接口族</th><th>说明章节</th></tr></thead><tbody>' +
    live.routes
      .map(
        (r) =>
          `<tr><td><code>${escape(r)}</code></td><td><a href="?view=system&amp;systemTab=architecture&amp;chapter=${coverage.routes[r]}">${escape(coverage.routes[r])}</a></td></tr>`,
      )
      .join("") +
    "</tbody></table>";
  last.html += dictionary;
  last.text +=
    "\n" +
    Object.keys(coverage.tables).join(" ") +
    "\n" +
    Object.values(live.kinds).flat().join(" ");
  const data = {
    version: 1,
    kinds: live.kinds,
    title: "审阅台 · 系统架构手册",
    contentSha256: digest(
      JSON.stringify(
        documents.map((d) => [d.id, d.contentSha256, d.references]),
      ) + JSON.stringify(diagrams),
    ),
    chapters: documents.map(
      ({ id, title, summary, part, toc, contentSha256, reviewedAt, text }) => ({
        id,
        title,
        summary,
        part,
        toc,
        contentSha256,
        reviewedAt,
        text,
      }),
    ),
    diagrams: diagrams.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      sha256: digest(renderDiagram(d)),
    })),
  };
  const assets = diagrams.map((d) => ({ id: d.id, svg: renderDiagram(d) }));
  const total = Buffer.byteLength(
    JSON.stringify(data) + JSON.stringify(documents) + JSON.stringify(assets),
  );
  if (total > 2 * 1024 * 1024)
    throw Error("Handbook exceeds the 2 MiB release budget");
  if (mode === "check")
    return {
      status: "VERIFIED",
      chapters: documents.length,
      diagrams: diagrams.length,
      bytes: total,
      tables: live.tables.length,
      kinds: Object.values(live.kinds).flat().length,
      routes: live.routes.length,
    };
  // This is a generated, private build directory, never a project business path.
  if (
    path.resolve(output) !== path.join(root, "web/.handbook") &&
    !path
      .resolve(output)
      .startsWith((process.env.REVIEW_TASK_DIR || "\0") + path.sep)
  )
    throw Error("Use the managed build output or phase scratch");
  await mkdir(output, { recursive: true });
  for (const name of await readdir(output)) {
    if (!/^(catalog\.json|[a-z][a-z0-9-]*\.(json|svg))$/.test(name))
      throw Error("Unknown handbook build artifact: " + name);
    await rm(path.join(output, name));
  }
  await writeFile(path.join(output, "catalog.json"), JSON.stringify(data));
  for (const doc of documents)
    await writeFile(path.join(output, doc.id + ".json"), JSON.stringify(doc));
  for (const a of assets)
    await writeFile(path.join(output, a.id + ".svg"), a.svg);
  return {
    status: "BUILT",
    chapters: documents.length,
    diagrams: diagrams.length,
    bytes: total,
    contentSha256: data.contentSha256,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const mode = process.argv[2] || "build";
  if (!["build", "check", "diagrams"].includes(mode))
    throw Error("Use handbook.mjs build|check|diagrams");
  if (mode !== "check") {
    const { requiredPhase } = await import("./process-resources.mjs");
    await requiredPhase(here);
  }
  console.log(JSON.stringify(await buildHandbook({ mode })));
}
