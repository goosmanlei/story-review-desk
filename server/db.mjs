import pg from "pg";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { check } from "./shared/contracts.mjs";

let singleton;
export async function machineConfiguration() {
  const root = process.env.REVIEW_INSTANCE_ROOT;
  check(
    root && path.isAbsolute(root),
    "INSTANCE_REQUIRED",
    "请显式配置 REVIEW_INSTANCE_ROOT",
    503,
  );
  const instance = JSON.parse(
    await readFile(path.join(root, "instance.json"), "utf8"),
  );
  const machine = JSON.parse(
    await readFile(path.join(root, "runtime", "machine.json"), "utf8"),
  );
  check(
    instance.schemaVersion === "3.0",
    "INSTANCE_SCHEMA",
    "实例尚未迁移到对象存储",
    503,
  );
  return { root, instance, machine };
}
export async function database() {
  if (!singleton) {
    singleton = (async () => {
      const { machine } = await machineConfiguration();
      check(
        machine.database && machine.database.host && machine.database.database,
        "DATABASE_CONFIGURATION",
        "数据库配置缺失",
        503,
      );
      const password = machine.database.passwordEnv
        ? process.env[machine.database.passwordEnv]
        : machine.database.passwordFile
          ? (await readFile(machine.database.passwordFile, "utf8")).trim()
          : undefined;
      const { passwordEnv, passwordFile, ...connection } = machine.database;
      const pool = new pg.Pool({
        ...connection,
        password,
        max: 8,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      });
      pool.on("error", () => {});
      return pool;
    })().catch((error) => {
      singleton = undefined;
      throw error;
    });
  }
  return singleton;
}
export async function transaction(
  pool,
  callback,
  { readOnly = false, timeoutMs = 15000 } = {},
) {
  const client = await pool.connect();
  try {
    await client.query(
      readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
    );
    await client.query("SELECT set_config('statement_timeout',$1,true)", [
      String(timeoutMs),
    ]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
export async function closeDatabase() {
  if (singleton) {
    const p = await singleton;
    singleton = undefined;
    await p.end();
  }
}
