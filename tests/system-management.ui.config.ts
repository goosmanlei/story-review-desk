import { defineConfig } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir:'.',testMatch:['system-management.ui.spec.ts','story-settings.ui.spec.ts','entity-workflow.ui.spec.ts'],workers:1,timeout:45_000,reporter:[['list']],outputDir:'./.test-tmp/system-management-ui-results',
  use:{baseURL:'http://127.0.0.1:4293',channel:'chrome',viewport:{width:1440,height:1000},screenshot:'only-on-failure'},
  webServer:{command:'node_modules/.bin/vinext dev -H 127.0.0.1 -p 4293',cwd:path.resolve(import.meta.dirname,'..'),url:'http://127.0.0.1:4293',timeout:60_000,reuseExistingServer:false,env:{REVIEW_NODE_DEV:'1',REVIEW_REMOTE_READ_ONLY:'',OPENAI_API_KEY:'',OPENAI_API_KEY_FILE:'',REVIEW_INSTANCE_ROOT:'',REVIEW_INSTANCE_DB:'',REVIEW_INSTANCE_ID:'',REVIEW_TRIAL_WORKER_URL:'',REVIEW_LEGACY_FIXTURE:'',REVIEW_EXPORT_DIR:'',REVIEW_ALLOWED_ORIGINS:'http://127.0.0.1:4293'}},
});
