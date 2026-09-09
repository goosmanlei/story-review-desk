import {defineConfig} from '@playwright/test';
// The specs intercept every page and API request; no live instance or worker.
export default defineConfig({testDir:'.',testMatch:['material-production-rebase.ui.spec.ts','material-production-setup.ui.spec.ts'],workers:1,timeout:35_000,expect:{timeout:8_000},reporter:[['list']],outputDir:'.test-tmp/material-production-rebase-ui',use:{baseURL:'http://127.0.0.1:4294',channel:'chrome',viewport:{width:1440,height:1000},serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure'}});
