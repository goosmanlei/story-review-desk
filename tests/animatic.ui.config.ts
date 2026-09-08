import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:['animatic.ui.spec.ts'],workers:1,timeout:30000,reporter:[['list']],outputDir:'.test-tmp/animatic-ui',use:{baseURL:'http://127.0.0.1:4298',channel:'chrome',viewport:{width:1440,height:1000},serviceWorkers:'block',screenshot:'only-on-failure'}});
