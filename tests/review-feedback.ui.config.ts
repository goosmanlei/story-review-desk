import {defineConfig} from '@playwright/test';
import path from 'node:path';

// Shared, neutral preview is started by the site owner. Every test intercepts
// its own business requests; there is no live instance or generation worker.
export default defineConfig({
  testDir:'.',testMatch:['free-canvas.ui.spec.ts','canvas-geometry.ui.spec.ts','material-entity-review.ui.spec.ts','workflow-review-feedback.ui.spec.ts','closed-comment-history.ui.spec.ts','story-settings.ui.spec.ts','entity-workflow.ui.spec.ts','empty-instance.ui.spec.ts','pipeline-preparation-entry.ui.spec.ts','narrative-unified.ui.spec.ts','narrative-reading.spec.tsx','narrative-six-groups.spec.tsx','preparation-four-stage.ui.spec.ts'],
  workers:1,timeout:45_000,expect:{timeout:12_000},reporter:[['list']],outputDir:path.resolve(import.meta.dirname,'.test-tmp/review-feedback-browser'),
  use:{baseURL:process.env.REVIEW_UI_BASE_URL||'http://127.0.0.1:4294',channel:'chrome',viewport:{width:1440,height:1000},serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure'},
});
