import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function rootDirectory() {
  const roots = process.env.REVIEW_DOCUMENTATION_ROOT
    ? [path.resolve(process.env.REVIEW_DOCUMENTATION_ROOT)]
    : [path.resolve("web/.handbook"), path.resolve(".handbook")];
  for (const root of roots) {
    const file = path.join(root, "catalog.json");
    if ((await lstat(file).catch(() => null))?.isFile()) return root;
  }
  throw Error("系统手册尚未构建");
}
export async function documentationResponse(request, route, { root } = {}) {
  if (request.method !== "GET")
    return Response.json(
      { error: { code: "READ_ONLY", message: "系统手册只读，由核心软件维护" } },
      { status: 405, headers: { Allow: "GET" } },
    );
  try {
    root ||= await rootDirectory();
    const bytes = await readFile(path.join(root, "catalog.json"));
    const catalog = JSON.parse(bytes);
    let data,
      mime = "application/json; charset=utf-8";
    const version = process.env.REVIEW_SOFTWARE_COMMIT || "DEVELOPMENT";
    if (route.length === 1 || (route.length === 2 && route[1] === "catalog"))
      data = JSON.stringify({ ...catalog, softwareCommit: version });
    else if (
      route.length === 3 &&
      route[1] === "chapters" &&
      catalog.chapters.some((c) => c.id === route[2])
    ) {
      const doc = JSON.parse(
        await readFile(path.join(root, route[2] + ".json"), "utf8"),
      );
      data = JSON.stringify({
        ...doc,
        softwareCommit: version,
        bookSha256: catalog.contentSha256,
      });
    } else if (
      route.length === 3 &&
      route[1] === "assets" &&
      catalog.diagrams.some((d) => d.id === route[2])
    ) {
      data = await readFile(path.join(root, route[2] + ".svg"));
      mime = "image/svg+xml";
    } else
      return Response.json(
        {
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "手册章节或图表不存在",
          },
        },
        { status: 404 },
      );
    const etag = '"' + sha(data) + '"';
    const headers = {
      "Content-Type": mime,
      "Cache-Control": "no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      ...(mime === "image/svg+xml"
        ? {
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          }
        : {}),
    };
    return new Response(
      request.headers.get("if-none-match") === etag ? null : data,
      {
        status: request.headers.get("if-none-match") === etag ? 304 : 200,
        headers,
      },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "DOCUMENT_UNAVAILABLE",
          message: "系统手册暂不可读取，请核对本次软件构建",
        },
      },
      { status: 503 },
    );
  }
}
