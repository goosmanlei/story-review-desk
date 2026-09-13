// Exercise the previous deployer's direct Next entrypoint, with no docs pre-step
// or manual handbook copy. The resulting server must outlive its build tree.
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  rename,
  readFile,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { requiredPhase } from "../tools/process-resources.mjs";

const phase = await requiredPhase(process.cwd());
assert(phase);
const scratch = process.env.REVIEW_TASK_DIR,
  source = path.join(scratch, "source"),
  runtime = path.join(scratch, "runtime");
await mkdir(source);
for (const name of [
  "web",
  "server",
  "tools",
  "scripts",
  "docs",
  "tests",
  "package.json",
  "package-lock.json",
])
  await cp(name, path.join(source, name), {
    recursive: true,
    filter: (p) =>
      !p.includes(path.sep + ".next") &&
      !p.includes(path.sep + ".handbook") &&
      !p.endsWith(".tsbuildinfo"),
  });
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };
execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: source,
  env,
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [
    path.join(source, "node_modules/next/dist/bin/next"),
    "build",
    "web",
    "--webpack",
  ],
  { cwd: source, env, stdio: "inherit" },
);
await cp(path.join(source, "web/.next/standalone"), runtime, {
  recursive: true,
});
await cp(
  path.join(source, "web/.next/static"),
  path.join(runtime, "web/.next/static"),
  { recursive: true },
);
const catalog = JSON.parse(
  await readFile(path.join(runtime, "web/.handbook/catalog.json"), "utf8"),
);
assert.equal(catalog.chapters.length, 12);
assert.equal(catalog.diagrams.length, 17);
async function checkLinks(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name),
      info = await lstat(file);
    if (info.isSymbolicLink())
      assert(
        (await realpath(file)).startsWith(runtime + path.sep),
        "Runtime link escapes its release",
      );
    else if (info.isDirectory()) await checkLinks(file);
  }
}
await checkLinks(runtime);
await rename(source, path.join(scratch, "source-offline"));
delete env.REVIEW_DOCUMENTATION_ROOT;
const child = spawn(process.execPath, [path.join(runtime, "web/server.js")], {
  cwd: runtime,
  env: {
    ...env,
    PORT: "3950",
    HOSTNAME: "127.0.0.1",
    REVIEW_SOFTWARE_COMMIT: "STANDALONE-VERIFICATION",
    REVIEW_INSTANCE_ROOT: path.join(scratch, "unavailable-instance"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (x) => (log = (log + x).slice(-4000)));
child.stderr.on("data", (x) => (log = (log + x).slice(-4000)));
const closed = new Promise((resolve) => child.once("close", resolve));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const response = await fetch(
      "http://127.0.0.1:3950/api/v1/documentation/catalog",
    ).catch(() => null);
    if (response?.ok) {
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, log);
  for (const c of catalog.chapters) {
    const response = await fetch(
      "http://127.0.0.1:3950/api/v1/documentation/chapters/" + c.id,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.softwareCommit, "STANDALONE-VERIFICATION");
    assert.equal(body.bookSha256, catalog.contentSha256);
  }
  for (const d of catalog.diagrams) {
    const response = await fetch(
      "http://127.0.0.1:3950/api/v1/documentation/assets/" + d.id,
    );
    assert.equal(response.status, 200);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex"),
      d.sha256,
    );
  }
  console.log(
    JSON.stringify({
      status: "PASSED",
      entrypoint: "direct-next-build",
      chapters: 12,
      diagrams: 17,
      buildTreeOffline: true,
      databaseUnavailable: true,
      manualDocumentationCopy: false,
      bookSha256: catalog.contentSha256,
    }),
  );
} finally {
  child.kill("SIGTERM");
  await closed;
}
