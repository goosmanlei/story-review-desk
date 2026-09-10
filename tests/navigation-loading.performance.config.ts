import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'navigation-loading.performance.spec.ts',workers:1,timeout:300000,reporter:[['list']],outputDir:'.test-tmp/navigation-loading-performance',use:{channel:'chrome',trace:'retain-on-failure',screenshot:'only-on-failure'}});
