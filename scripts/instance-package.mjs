import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applicationRoot } from './instance-profile.mjs';
import {inspectPackageSource,readPackageSource,assertPackageSourceUnchanged} from './instance-package-source.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' }, 'software-commit': { type: 'string' }, refresh: { type: 'boolean' } } });
if (!values.output) throw new Error('Usage: node scripts/instance-package.mjs --output NEW_SOFTWARE_DIRECTORY');
const target = path.resolve(values.output);
if (target === applicationRoot || target.startsWith(applicationRoot + path.sep)) throw new Error('Software output must be a new directory outside the source checkout');
const files = [];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requestedCommit=values['software-commit']||process.env.REVIEW_SOFTWARE_COMMIT||undefined;
const sourceIdentity=await inspectPackageSource(applicationRoot,{requestedCommit,explicitDevelopment:requestedCommit==='UNVERSIONED'});
const softwareCommit=sourceIdentity.softwareCommit;
const managed = new Map();
if (values.refresh) {
  if ((await lstat(target)).isSymbolicLink()) throw new Error('Refresh target cannot be a symlink');
  const previous = JSON.parse(await readFile(path.join(target,'software-manifest.json'),'utf8'));
  if (previous.kind !== 'STORY_NEUTRAL_SOFTWARE' || previous.copiedBusinessData || !Array.isArray(previous.files)) throw new Error('Refresh requires a managed software manifest');
  for (const item of previous.files) {
    if (typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split('/').some(part=>!part||part==='.'||part==='..')) throw new Error('Unsafe managed path');
    const source=path.join(target,item.path); const info=await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || sha(await readFile(source)) !== item.sha256) throw new Error('User-modified software file cannot be overwritten: '+item.path);
    managed.set(item.path,item);
  }
  async function checkUnmanaged(relative='') {
    for (const entry of await readdir(path.join(target,relative),{withFileTypes:true})) {
      const name=relative ? relative+'/'+entry.name : entry.name;
      if (['node_modules','dist','.next','.vinext','.wrangler'].includes(name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Unmanaged symlink blocks refresh: '+name);
      if (entry.isDirectory()) await checkUnmanaged(name);
      else if (name==='software-manifest.json' || managed.has(name)) continue;
      else if (/^host\/__pycache__\/[A-Za-z0-9_]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(name) && entry.isFile()) continue;
      else if (name==='app/review-data.generated.json' || name.startsWith('public/runtime/') || name.startsWith('data/')) {
        const payload=JSON.parse(await readFile(path.join(target,name),'utf8'));
        if (payload.snapshotId!=='REVIEW-EMPTY-V1') throw new Error('Non-empty generated data blocks software refresh: '+name);
      } else throw new Error('Unmanaged user file blocks software refresh: '+name);
    }
  }
  await checkUnmanaged();
} else await mkdir(target, { mode: 0o755 });
async function put(relative, content, role) {
  const destination = path.join(target, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  await writeFile(destination, bytes, { flag: managed.has(relative) ? 'w' : 'wx', mode: 0o644 });
  files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes), role });
}
async function copy(relative) {
  await put(relative, await readPackageSource(sourceIdentity,relative), 'SOFTWARE_SOURCE');
}
async function tree(relative, allowed) {
  for (const entry of await readdir(path.join(applicationRoot, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['test', 'tests', '__pycache__'].includes(entry.name)) continue;
    const filename = relative + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not package inputs');
    if (entry.isDirectory()) await tree(filename, allowed);
    else if (entry.isFile() && allowed(filename)) await copy(filename);
  }
}
await tree('app', (filename) => /\.(tsx?|css|mjs|mts)$/.test(filename));
await tree('host/instance-runtime', (filename) => /\.(mjs|mts)$/.test(filename));
for (const filename of ['codex_conversation_bridge.py', 'codex_work_context.py', 'codex_work_preflight.py', 'codex_runtime_adapter.py', 'codex_project_actions.py', 'instance_aux.py']) await copy('host/' + filename);
for (const name of await readdir(path.join(applicationRoot, 'host'))) if (/^instance-.*\.(mjs|mts)$/.test(name)) await copy('host/' + name);
await tree('workers', (filename) => filename.endsWith('.mjs'));
await copy('docs/instance-isolation.md');
await copy('docs/system-configuration.md');
for(const name of ['system-management.md','story-settings.md','material-relationship-architecture.md','git-checkpoint.md'])await copy('docs/'+name);
for (const name of await readdir(path.join(applicationRoot, 'scripts'))) {
  if ((/^instance-.*\.mjs$/.test(name) && !name.includes('-test') && !name.includes('-trial-worker')) || ['build-runtime.mjs', 'prepare-hosted-runtime.mjs', 'deploy-local.mjs', 'export-hosted-material-events.mjs'].includes(name)) await copy('scripts/' + name);
}
for (const filename of ['Dockerfile', 'Dockerfile.comment-polish-worker', 'Dockerfile.material-review-worker', 'compose.yaml', '.dockerignore', 'tsconfig.json', 'next.config.ts', 'eslint.config.mjs']) {
  await copy(filename);
}
// This declaration is generated; never import an ignored checkout .next cache.
await put('next-env.d.ts', '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\nimport "vinext/types/augmentations";\nimport "./.next/types/routes.d.ts";\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n', 'GENERATED_SOFTWARE_TYPES');
const packageJson = JSON.parse(await readPackageSource(sourceIdentity,'package.json'));
packageJson.name = 'story-review-software';
packageJson.scripts = { dev: 'REVIEW_NODE_DEV=1 vinext dev', build: 'node scripts/build-runtime.mjs', start: 'vinext start',
  'project:create': 'node scripts/instance-project-create.mjs', 'instance:create': 'node scripts/instance-create.mjs', 'instance:start': 'node scripts/instance-start.mjs',
  'instance:guidance': 'node scripts/instance-guidance.mjs', 'instance:configuration': 'node scripts/instance-configuration.mjs', 'instance:document': 'node scripts/instance-document.mjs', 'instance:verify': 'node scripts/instance-verify.mjs', 'instance:source': 'node scripts/instance-source.mjs', 'instance:extension': 'node scripts/instance-extension.mjs',
  'instance:migrate': 'node scripts/instance-migrate.mjs', 'instance:sources': 'node scripts/instance-sources.mjs', 'instance:initialize': 'node scripts/instance-initialize.mjs', 'instance:relations': 'node scripts/instance-relations.mjs', 'instance:authoring': 'node scripts/instance-authoring.mjs',
  'instance:backup': 'node scripts/instance-backup.mjs', 'instance:restore': 'node scripts/instance-restore.mjs', 'instance:copy': 'node scripts/instance-copy.mjs',
  'codex:bridge': 'node scripts/instance-bridge.mjs', 'codex:doctor': 'node scripts/instance-bridge.mjs --command doctor', 'deploy:local': 'node scripts/deploy-local.mjs' };
await put('package.json', JSON.stringify(packageJson, null, 2) + '\n', 'SOFTWARE_PACKAGE');
const lock = JSON.parse(await readPackageSource(sourceIdentity,'package-lock.json'));
lock.name = packageJson.name;
if (lock.packages?.['']) lock.packages[''].name = packageJson.name;
await put('package-lock.json', JSON.stringify(lock, null, 2) + '\n', 'DEPENDENCY_LOCK');
await copy('vite.config.ts');
await put('public/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#18352c"/><path d="M17 17h30v30H17z" fill="none" stroke="#eadfc8" stroke-width="3"/><path d="M24 26h16M24 33h16M24 40h10" stroke="#eadfc8" stroke-width="3"/></svg>\n', 'GENERIC_SOFTWARE_ICON');
await tree('docs/software-guidance', filename => filename.endsWith('.md'));
for (const name of ['README.md','AGENTS.md','STATE.md']) await put(name, await readPackageSource(sourceIdentity,'docs/software-guidance/'+name), name==='STATE.md'?'SOFTWARE_STATE':'SOFTWARE_GUIDANCE');
// Scan actual packaged production text, never the source checkout's historical data.
const issues = [];
const STORY_SPECIFIC_PATTERN = /九头案|jiutouan|JTA|马三|闷二|塔家|六幕十SEQ|两集|双集|两个选段集|十镜|堂屋空间|zhenwuRoute|ALL_47|\/Users\//i; // PACKAGE_STORY_SCAN_RULE
for (const item of files) {
  const text = (await readFile(path.join(target,item.path))).toString('utf8');
  const scanText = text.split("\n").filter((line) => !line.endsWith("// PACKAGE_STORY_SCAN_RULE") && !(item.path === "package-lock.json" && line.trimStart().startsWith('"integrity":'))).join("\n");
  if (STORY_SPECIFIC_PATTERN.test(scanText)) issues.push(item.path);
}
// A core commit must produce byte-identical manifests across machines and runs.
const report = { schemaVersion:'1.0', kind:'STORY_NEUTRAL_SOFTWARE',
  softwareCommit, sourceCheckoutRequiredAtRuntime:false, gitRequired:false, copiedBusinessData:false, copiedPublicStoryMedia:false, copiedCredentials:false,
  excluded: ['data/**','app/*.generated.json','public/** historical inputs','.openai/**','.git/**','.env*','runtime/**','tests and test fixtures','optional legacy trial adapter'],
  productionStorySpecificHits: issues, files: files.sort((a,b)=>a.path.localeCompare(b.path)) };
await assertPackageSourceUnchanged(sourceIdentity);
for (const oldPath of managed.keys()) if (!files.some((item)=>item.path===oldPath)) await unlink(path.join(target,oldPath));
await writeFile(path.join(target,'software-manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:values.refresh?'w':'wx',mode:0o644});
if (issues.length) throw new Error('Story-neutral package scan failed: ' + issues.join(', '));
console.log(JSON.stringify({status:'SOFTWARE_PACKAGE_CREATED',output:target,files:files.length,bytes:files.reduce((sum,item)=>sum+item.bytes,0),storySpecificHits:0,buildVerified:false},null,2));
