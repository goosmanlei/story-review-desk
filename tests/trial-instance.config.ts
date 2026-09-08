import { defineConfig } from '@playwright/test';
import path from 'node:path';

const siteRoot = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(siteRoot, 'tests/.test-tmp/trial-ui-fixture');
const existingBaseUrl = process.env.TRIAL_UI_BASE_URL;
export default defineConfig({
  testDir: '.', testMatch: ['trial-instance.ui.spec.ts', 'trial.spec.ts', 'material-entity-review.ui.spec.ts'], workers: 1, timeout: 60_000,
  outputDir: './.test-tmp/trial-ui-results', reporter: [['list']],
  use: { baseURL: existingBaseUrl || 'http://127.0.0.1:4291', channel: 'chrome', viewport: { width: 1440, height: 1000 } },
  webServer: existingBaseUrl ? undefined : {
    command: 'node_modules/.bin/vinext dev -H 127.0.0.1 -p 4291', cwd: siteRoot,
    url: 'http://127.0.0.1:4291/trial?view=materials', timeout: 60_000, reuseExistingServer: false,
    env: { REVIEW_NODE_DEV: '1', OPENAI_API_KEY: '', OPENAI_API_KEY_FILE: '', REVIEW_INSTANCE_ROOT: '', REVIEW_INSTANCE_DB: '', REVIEW_INSTANCE_ID: '', REVIEW_TRIAL_WORKER_URL: '', REVIEW_TRIAL_LEGACY_FIXTURE: '', REVIEW_EVENT_STORE_PATH: path.join(fixtures, 'events'), CODEX_CONVERSATION_STORE_PATH: path.join(fixtures, 'conversations'), REVIEW_ALLOWED_ORIGINS: 'http://127.0.0.1:4291' },
  },
});
