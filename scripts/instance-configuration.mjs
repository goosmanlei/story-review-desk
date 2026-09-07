import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import {
  resolveInstance,
  openInstanceRepository,
} from "../host/instance-runtime/index.mjs";
import {
  initializeConfiguration,
  getConfiguration,
} from "../host/instance-runtime/configuration-service.mjs";
import { delegateInstanceMaintenance } from "./instance-maintenance.mjs";
const argv = process.argv.slice(2);
if (!(await delegateInstanceMaintenance("instance-configuration.mjs", argv))) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { instance: { type: "string" }, file: { type: "string" } },
  });
  if (
    !values.instance ||
    positionals.length !== 1 ||
    !["inspect", "initialize"].includes(positionals[0])
  )
    throw new Error(
      "Usage: instance-configuration.mjs inspect|initialize --instance PATH [--file MIGRATION_OVERRIDES.json]",
    );
  const repo = (await openInstanceRepository({
    ...resolveInstance(values.instance),
    readOnly: positionals[0] === "inspect",
  }));
  try {
    const overrides = values.file
      ? JSON.parse(await readFile(values.file, "utf8"))
      : {};
    const result =
      positionals[0] === "inspect"
        ? await repo.readTransaction(async (tx) => (await getConfiguration(tx)))
        : await repo.writeTransaction(async (tx) =>
            (await initializeConfiguration(tx, overrides)),
          );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    (await repo.close());
  }
}
