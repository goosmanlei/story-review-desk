import {defineConfig} from '@playwright/test';
// Every document, original-image fixture and API request is intercepted by the
// spec. This suite never starts a project server or contacts a live instance.
export default defineConfig({testDir:'.',testMatch:['material-usage.ui.spec.ts'],workers:1,timeout:35_000,expect:{timeout:8_000},reporter:[['list']],outputDir:'.test-tmp/material-usage-ui',use:{channel:'chrome',viewport:{width:1440,height:1000},serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure'}});
