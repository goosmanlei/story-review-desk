import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,copyFile,lstat,mkdir,rename,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {applicationRoot} from './instance-profile.mjs';
const {values}=parseArgs({options:{output:{type:'string'},'software-commit':{type:'string'},'tests-manifest':{type:'string'}}});
if(!values.output||!/^[a-f0-9]{40}$/.test(values['software-commit']||'')||!values['tests-manifest'])throw Error('Use --output NEW_CORE --software-commit EXACT_SOURCE_SHA --tests-manifest REVIEWED_TEST_MANIFEST');
const run=(exe,args)=>{const result=spawnSync(exe,args,{cwd:applicationRoot,encoding:'utf8',stdio:['ignore','pipe','inherit']});if(result.status!==0)throw Error(exe+' failed');return result.stdout.trim();};
if(run('git',['rev-parse','HEAD'])!==values['software-commit']||run('git',['status','--porcelain','--untracked-files=all']))throw Error('Source export requires the reviewed exact clean commit');
const selected=JSON.parse(await readFile(values['tests-manifest'],'utf8'));
if(selected.kind!=='GENERIC_CORE_TEST_SELECTION'||!Array.isArray(selected.files)||new Set(selected.files.map(r=>r.path)).size!==selected.files.length)throw Error('Review the exact generic test selection first');
const destination=path.resolve(values.output),hash=b=>createHash('sha256').update(b).digest('hex');
for(const row of selected.files){
 if(!/^(tests\/|host\/test_|host\/instance-runtime\/test\/)/.test(row.path)||row.path.includes('\\')||row.path.split('/').some(s=>!s||s==='.'||s==='..')||!/\.(mjs|ts|tsx|py|json)$/.test(row.path))throw Error('Unsafe selected test path');
 const source=path.join(applicationRoot,row.path),info=await lstat(source);
 if(!info.isFile()||info.isSymbolicLink()||(await realpath(source))!==source||hash(await readFile(source))!==row.sha256)throw Error('Selected test changed: '+row.path);
}
run(process.execPath,['scripts/instance-package.mjs','--output',destination,'--software-commit',values['software-commit']]);
for(const row of selected.files){const target=path.join(destination,row.path);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(applicationRoot,row.path),target);}
const pkg=JSON.parse(await readFile(path.join(destination,'package.json'),'utf8'));pkg.name='story-review-desk';
pkg.scripts.build='node scripts/build-runtime.mjs';pkg.scripts['test:unit']='node --test '+selected.files.filter(r=>r.run==='NODE_TEST').map(r=>r.path).join(' ');
pkg.scripts['test:empty-ui']='playwright test --config tests/empty-instance-ui.config.ts';
pkg.scripts['test:ui']='playwright test --config tests/core-regressions.ui.config.ts';
pkg.scripts['test:ui:configuration-integration']='playwright test --config tests/system-configuration-ui.config.ts';
pkg.scripts['test:ui:standards-integration']='playwright test --config tests/review-standards-ui.config.ts';
pkg.scripts['test:types']='tsc --noEmit --pretty false --incremental false';
await writeFile(path.join(destination,'package.json'),JSON.stringify(pkg,null,2)+'\n');
const lock=JSON.parse(await readFile(path.join(destination,'package-lock.json'),'utf8'));lock.name=pkg.name;if(lock.packages?.[''])lock.packages[''].name=pkg.name;await writeFile(path.join(destination,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
const previous=JSON.parse(await readFile(path.join(destination,'software-manifest.json'),'utf8'));
await rename(path.join(destination,'software-manifest.json'),path.join(destination,'core-import-manifest.json'));
await writeFile(path.join(destination,'core-import-manifest.json'),JSON.stringify({schemaVersion:'1.0',kind:'CORE_SOURCE_IMPORT_PROVENANCE',sourceCommit:values['software-commit'],productionFileProof:previous.files,testFileProof:selected.files,notARuntimePackage:true,sourceCheckoutRequiredAtRuntime:false},null,2)+'\n');
await writeFile(path.join(destination,'.gitignore'),'node_modules/\ndist/\n.next/\n.vinext/\n.wrangler/\n.hosted-public*/\n.test-tmp/\ntests/.test-tmp/\ntest-results*/\nplaywright-report/\napp/*.generated.json\ndata/\npublic/runtime/\n.env*\n*.tsbuildinfo\n/next-env.d.ts\n__pycache__/\n*.pyc\n.openai/\n');
console.log(JSON.stringify({state:'CORE_SOURCE_EXPORTED_NOT_COMMITTED',output:destination,sourceCommit:values['software-commit'],genericTestFiles:selected.files.length,gitHistoryCopied:false,businessDataCopied:false,buildVerified:false}));
