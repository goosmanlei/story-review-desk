import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuration = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  ),
  poweredByHeader: false,
  serverExternalPackages: ["pg", "pinyin-pro"],
  cacheMaxMemorySize: 0,
  outputFileTracingIncludes: {
    "/*": ["../server/schema.sql", "../web/.handbook/**/*"],
  },
  experimental: { webpackMemoryOptimizations: true },
};
export default async function nextConfiguration(phase) {
  if ([PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD].includes(phase)) {
    // Older installed deployers invoke Next directly. Keep the artifact contract
    // with the selected source, so the first upgrade also ships its handbook.
    const { buildHandbook } = await import("../tools/handbook.mjs");
    await buildHandbook({ root });
  }
  return configuration;
}
