import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beginPhase } from "../tools/process-resources.mjs";
import { hash, check } from "./shared/contracts.mjs";

// The configured executable receives JSON on stdin and emits request/answer
// events. Credentials stay in the host environment; no shell is involved.
export async function processProvider({ root, command, payload, onRequestId }) {
  check(
    Array.isArray(command) &&
      command.length > 0 &&
      command.every((x) => typeof x === "string"),
    "PROVIDER_COMMAND",
    "本机执行器命令无效",
  );
  const task = "job-" + hash(payload.request.operationId).slice(0, 24),
    phase = await beginPhase(path.dirname(root), task, randomUUID());
  const directory = (await phase.read()).resources[0].path;
  let outcome = "FAILED",
    started = false,
    complete = false;
  try {
    await phase.budget();
    const outputDirectory = path.join(directory, "outputs");
    await mkdir(outputDirectory);
    const value = await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), {
        cwd: path.dirname(root),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "",
        answer,
        bytes = 0,
        pending = Promise.resolve(),
        failure,
        timer,
        escalation;
      const fail = (error) => {
        failure ||= error;
        child.kill("SIGTERM");
        escalation ||= setTimeout(() => child.kill("SIGKILL"), 10000);
      };
      if (child.pid) {
        started = true;
        pending = pending.then(() => phase.childStarted(child.pid));
      }
      timer = setInterval(() => phase.budget().catch(fail), 30000);
      timer.unref();
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          ...payload,
          outputDirectory,
          privateDirectory: path.join(directory, "codex-private"),
        }),
      );
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) return fail(Error("执行器返回超过 1 MiB"));
        buffer += chunk.toString();
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "request") {
              check(
                typeof event.id === "string" && event.id.length <= 1024,
                "REQUEST_ID",
                "执行器请求编号无效",
              );
              pending = pending.then(() => onRequestId(event.id));
            } else if (event.type === "answer") {
              check(!complete, "DUPLICATE_ANSWER", "执行器重复返回结果");
              answer = event.value;
              complete = true;
            }
          } catch (error) {
            fail(error);
          }
        }
      });
      child.stderr.resume();
      child.once("error", (error) => {
        failure = Object.assign(error, { externalOutcome: "NOT_STARTED" });
      });
      child.once("close", async (code) => {
        clearInterval(timer);
        clearTimeout(escalation);
        try {
          await pending;
          await phase.childEnded();
          if (failure) throw failure;
          if (code !== 0) throw Error("执行器异常退出");
          check(complete, "PROVIDER_ANSWER", "执行器未返回结果");
          resolve(typeof answer === "string" ? JSON.parse(answer) : answer);
        } catch (error) {
          reject(Object.assign(error, { resultReceived: complete }));
        }
      });
    });
    await writeFile(
      path.join(directory, "answer.json"),
      JSON.stringify(value),
      { flag: "wx", mode: 0o600 },
    );
    outcome = "SUCCEEDED";
    return { value, directory, phase };
  } catch (error) {
    const unknown = started && error.externalOutcome !== "NOT_STARTED";
    if (unknown) {
      outcome = "RESULT_UNKNOWN";
      await phase.retain(
        "path",
        directory,
        "外部执行结果未知；按原操作核查后再清退",
      );
    }
    if (!started) error.externalOutcome = "NOT_STARTED";
    await phase.finish({ outcome });
    throw error;
  }
}
