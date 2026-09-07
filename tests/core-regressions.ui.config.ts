import {defineConfig} from '@playwright/test';
import path from 'node:path';

// Owner starts an isolated, neutral preview. Specs intercept their own business
// requests; no project fixture, service worker, generation worker or live DB.
const baseURL=process.env.REVIEW_UI_BASE_URL||'http://127.0.0.1:4294';
const target=new URL(baseURL);
if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.protocol!=='http:'||!target.port||['3000','4197'].includes(target.port)||target.pathname!=='/'||target.search||target.hash||target.username||target.password)throw Error('Use a dedicated loopback neutral preview via REVIEW_UI_BASE_URL; never the formal 3000 or mutation 4197 instance.');
export default defineConfig({
  testDir:'.',
  testMatch:["empty-instance.ui.spec.ts","story-settings.ui.spec.ts","free-canvas.ui.spec.ts","optimization-components.ui.spec.ts","closed-comment-history.ui.spec.ts","material-entity-review.ui.spec.ts","canvas-geometry.ui.spec.ts","system-management.ui.spec.ts","entity-workflow.ui.spec.ts","workflow-review-feedback.ui.spec.ts","pipeline-preparation-entry.ui.spec.ts","preparation-four-stage.ui.spec.ts","narrative-unified.ui.spec.ts","narrative-reading.spec.tsx","narrative-six-groups.spec.tsx"],
  workers:1,timeout:45_000,expect:{timeout:12_000},reporter:[['list']],
  outputDir:path.resolve(import.meta.dirname,'.test-tmp/core-regressions'),
  use:{baseURL,channel:'chrome',viewport:{width:1440,height:1000},serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure'},
});
