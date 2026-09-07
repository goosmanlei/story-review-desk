import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'review-standards.ui.spec.ts',workers:1,timeout:60000,expect:{timeout:15000},outputDir:'./.test-tmp/standards-ui-results',reporter:[['list']],use:{baseURL:'http://127.0.0.1:4197',channel:'chrome',viewport:{width:1440,height:1000},screenshot:'only-on-failure'}});
