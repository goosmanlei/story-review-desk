import path from "node:path";
import { fileURLToPath } from "node:url";
export default {
  output: "standalone",
  outputFileTracingRoot: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  ),
  poweredByHeader: false,
  serverExternalPackages: ["pg", "pinyin-pro"],
  cacheMaxMemorySize: 0,
  outputFileTracingIncludes: { "/*": ["../server/schema.sql"] },
  experimental: { webpackMemoryOptimizations: true },
};
