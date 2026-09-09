import {defineConfig} from '@playwright/test';
// Isolated browser harness. All requests are intercepted; no live project server.
export default defineConfig({testDir:'.',testMatch:['asset-context-revalidation.ui.spec.ts','image-purpose-configuration.ui.spec.ts'],workers:1,timeout:35_000,expect:{timeout:8_000},reporter:[['list']],outputDir:'.test-tmp/asset-context-revalidation-ui',use:{channel:'chrome',viewport:{width:1440,height:1000},serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure'}});
