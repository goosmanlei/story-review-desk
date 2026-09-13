import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { systemdServiceContent } from "../tools/service.mjs";
import { requiredPhase } from "../tools/process-resources.mjs";

test("generated Linux service passes the real systemd unit parser", {
  skip: process.platform !== "linux",
}, async () => {
  const phase = await requiredPhase(process.cwd());
  assert(phase, "Run through the managed process runner");
  const scratch = (await phase.read()).resources[0].path;
  for (const [i, name] of ["plain", "story with spaces", "故事 100%"].entries()) {
    const root = path.join(scratch, name);
    await mkdir(root);
    const file = path.join(scratch, `review-unit-${i}.service`);
    await writeFile(file, systemdServiceContent(root, {
      nodeBinary: process.execPath,
      driver: path.join(root, "service.mjs"),
      name: `fixture-${i}`,
      system: false,
    }));
    execFileSync("systemd-analyze", ["--user", "verify", file], { stdio: "pipe" });
  }
});
