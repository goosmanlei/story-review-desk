import {readFileSync} from 'node:fs';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import {defineConfig} from 'vite';
const PLACEHOLDER_DATABASE_ID='00000000-0000-4000-8000-000000000000';
export default defineConfig(async()=>{
  process.env.WRANGLER_WRITE_LOGS??='false';
  process.env.WRANGLER_LOG_PATH??='.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH??='.wrangler/registry';
  const sitesTarget=process.env.REVIEW_BUILD_TARGET==='sites';
  if(sitesTarget&&(!process.env.REVIEW_EXPORT_DIR||process.env.REVIEW_REMOTE_READ_ONLY!=='1'))throw Error('Sites builds require explicit read-only export inputs');
  const hosting=sitesTarget?JSON.parse(readFileSync(new URL('./.openai/hosting.json',import.meta.url),'utf8')):{};
  const config={main:'vinext/server/app-router-entry',compatibility_flags:['nodejs_compat'],
    vars:{REVIEW_REMOTE_READ_ONLY:'1',REVIEW_SOFTWARE_COMMIT:process.env.REVIEW_SOFTWARE_COMMIT||'UNVERSIONED',REVIEW_PROJECT_COMMIT:process.env.REVIEW_PROJECT_COMMIT||'UNVERSIONED'},
    d1_databases:hosting.d1?[{binding:hosting.d1,database_name:'site-creator-d1',database_id:PLACEHOLDER_DATABASE_ID}]:[],
    r2_buckets:hosting.r2?[{binding:hosting.r2,bucket_name:'site-creator-r2'}]:[]};
  const cloudflare=sitesTarget?(await import('@cloudflare/vite-plugin')).cloudflare({viteEnvironment:{name:'rsc',childEnvironments:['ssr']},config}):null;
  return {build:sitesTarget?undefined:{rolldownOptions:{external:['cloudflare:workers']}},
    ssr:sitesTarget?undefined:{external:['cloudflare:workers']},
    publicDir:process.env.REVIEW_EXPORT_DIR?'.hosted-public':'public',
    define:sitesTarget?{'process.env.REVIEW_REMOTE_READ_ONLY':JSON.stringify('1'),'process.env.REVIEW_SOFTWARE_COMMIT':JSON.stringify(process.env.REVIEW_SOFTWARE_COMMIT||'UNVERSIONED'),'process.env.REVIEW_PROJECT_COMMIT':JSON.stringify(process.env.REVIEW_PROJECT_COMMIT||'UNVERSIONED')}:undefined,
    css:{postcss:{plugins:[tailwindcss()]}},
    server:process.env.CODEX_SANDBOX==='seatbelt'?{watch:{useFsEvents:false,usePolling:true}}:undefined,
    plugins:[vinext(),...(sitesTarget?[(await import('@openai/sites-vite-plugin')).sites()]:[]),...(cloudflare?[cloudflare]:[])]};
});
