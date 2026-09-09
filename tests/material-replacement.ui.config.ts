import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:['material-replacement.ui.spec.ts'],workers:1,timeout:40_000,expect:{timeout:8_000},reporter:[['list']],outputDir:'.test-tmp/material-replacement-ui',use:{channel:'chrome',viewport:{width:1500,height:1080},serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure'}});
