import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: ["system-configuration.ui.spec.ts", "configuration-layout.ui.spec.ts"],
  workers: 1,
  timeout: 45000,
  expect: { timeout: 12000 },
  outputDir: "./.test-tmp/configuration-ui-results",
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4197",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});
