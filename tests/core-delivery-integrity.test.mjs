import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspectPackageSource,readPackageSource,assertPackageSourceUnchanged} from '../scripts/instance-package-source.mjs';
import {verifySoftwarePin} from '../scripts/instance-software-pin.mjs';
import {assertHostedBuildOutput,assertHostedExportUnchanged} from '../scripts/instance-build-output.mjs';
import {snapshotShards} from '../scripts/instance-hosted-export.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function temporary(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'core-delivery-integrity-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const noGit=()=>{throw Error('No source Git root');};
test('wrong Git SHA and dirty Git source are rejected before packaging',async t=>{
 const root=await temporary(t),commit='a'.repeat(40);
 const gitRead=(_root,args)=>args.includes('--show-toplevel')?root:args.includes('HEAD')?commit:args[0]==='status'?' M app/page.tsx':'';
 await assert.rejects(inspectPackageSource(root,{requestedCommit:'b'.repeat(40),gitRead}),/exact clean/);
 await assert.rejects(inspectPackageSource(root,{requestedCommit:commit,gitRead}),/exact clean/);
});
test('clean exact Git source freezes blob identity and rechecks HEAD/clean after copy',async t=>{
 const root=await temporary(t),commit='a'.repeat(40),bytes=Buffer.from('export default 1;\n'),file='app/page.mjs';
 await mkdir(path.join(root,'app'));await writeFile(path.join(root,file),bytes);
 const blob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');let head=commit,dirty='';
 const gitRead=(_root,args)=>args.includes('--show-toplevel')?root:args[0]==='rev-parse'?head:args[0]==='status'?dirty:'100644 blob '+blob+'\t'+file+'\0';
 const source=await inspectPackageSource(root,{requestedCommit:commit,gitRead});assert.equal(source.kind,'EXACT_GIT_COMMIT');
 assert.deepEqual(await readPackageSource(source,file),bytes);await assertPackageSourceUnchanged(source,{gitRead});
 await writeFile(path.join(root,file),'uncommitted but assume-unchanged');
 await assert.rejects(readPackageSource(source,file),/frozen source identity/);
 await assert.rejects(readPackageSource(source,'app/not-tracked.mjs'),/ENOENT/);
 dirty=' M app/page.mjs';await assert.rejects(assertPackageSourceUnchanged(source,{gitRead}),/exact clean/);
 dirty='';head='b'.repeat(40);await assert.rejects(assertPackageSourceUnchanged(source,{gitRead}),/exact clean/);
});
async function releasedPackage(t){
 const root=await temporary(t),software=path.join(root,'review-software');await mkdir(path.join(software,'app'),{recursive:true});
 const bytes=Buffer.from('export default 1;\n');await writeFile(path.join(software,'app/page.mjs'),bytes);
 const manifest={kind:'STORY_NEUTRAL_SOFTWARE',softwareCommit:'a'.repeat(40),copiedBusinessData:false,copiedCredentials:false,productionStorySpecificHits:[],files:[{path:'app/page.mjs',bytes:bytes.length,sha256:sha(bytes)}]};
 const body=JSON.stringify(manifest)+'\n';await writeFile(path.join(software,'software-manifest.json'),body);
 await writeFile(path.join(root,'core-lock.json'),JSON.stringify({schemaVersion:'1.0',kind:'CORE_SOFTWARE_PIN',packagePath:'review-software',repository:'https://github.com/example/core',commit:manifest.softwareCommit,softwareManifestSha256:sha(body)}));
 return {root,software,manifest,bytes};
}
test('released non-Git package remains a valid new-project packaging source, even inside a project Git root',async t=>{
 const f=await releasedPackage(t);
 const source=await inspectPackageSource(f.software,{gitRead:()=>f.root});
 assert.equal(source.kind,'VERIFIED_SOFTWARE_PACKAGE');assert.equal(source.softwareCommit,'a'.repeat(40));
 assert.deepEqual(await readPackageSource(source,'app/page.mjs'),f.bytes);
 await assertPackageSourceUnchanged(source,{gitRead:()=>f.root});await verifySoftwarePin(f.root);
});
test('non-Git package rejects a mismatched commit, changed managed bytes and added source',async t=>{
 const f=await releasedPackage(t);
 await assert.rejects(inspectPackageSource(f.software,{requestedCommit:'b'.repeat(40),gitRead:noGit}),/manifest differs/);
 const source=await inspectPackageSource(f.software,{gitRead:noGit});await writeFile(path.join(f.software,'app/page.mjs'),'changed');
 await assert.rejects(assertPackageSourceUnchanged(source,{gitRead:noGit}),/Managed software changed/);
 await writeFile(path.join(f.software,'app/page.mjs'),f.bytes);await writeFile(path.join(f.software,'app/extra.mjs'),'extra');
 await assert.rejects(inspectPackageSource(f.software,{gitRead:noGit}),/Unmanaged software file/);
});
test('unversioned output is explicit development only and cannot satisfy a project pin',async t=>{
 const root=await temporary(t);await assert.rejects(inspectPackageSource(root,{requestedCommit:'a'.repeat(40),gitRead:noGit}),/No exact source Git root/);
 await assert.rejects(inspectPackageSource(root,{requestedCommit:'UNVERSIONED',gitRead:noGit}),/explicit development/);
 assert.equal((await inspectPackageSource(root,{requestedCommit:'UNVERSIONED',explicitDevelopment:true,gitRead:noGit})).softwareCommit,'UNVERSIONED');
 const f=await releasedPackage(t),pin=JSON.parse(await readFile(path.join(f.root,'core-lock.json'),'utf8'));pin.commit='UNVERSIONED';await writeFile(path.join(f.root,'core-lock.json'),JSON.stringify(pin));await assert.rejects(verifySoftwarePin(f.root),/Invalid exact core pin/);
});
async function builtFixture(t,snapshotId='snapshot:A'){
 const root=await temporary(t),client=path.join(root,'client');await mkdir(path.join(client,'runtime'),{recursive:true});
 const bytes=Buffer.from(JSON.stringify({snapshotId})+'\n'),file={path:'review-data-core.generated.json',bytes:bytes.length,sha256:sha(bytes)};
 const manifest={snapshotId,instanceId:'instance:fixture',releaseId:'release:fixture',repositoryRevision:1,manifestSha256:sha(snapshotId),files:[file],media:[]};
 const runtime={mode:'HOSTED_READ_ONLY',snapshotId,recipeSnapshotId:snapshotId,instanceId:manifest.instanceId,releaseId:manifest.releaseId,repositoryRevision:1,exportManifestSha256:manifest.manifestSha256,files:[{filename:file.path,sizeBytes:file.bytes,sha256:file.sha256}],media:[]};
 await writeFile(path.join(client,'runtime',file.path),bytes);await writeFile(path.join(client,'runtime/manifest.json'),JSON.stringify(runtime));return {root,client,exported:{manifest},runtime,file};
}
test('emitted snapshot and bytes must match the pre-build export, not a same-path replacement',async t=>{
 const a=await builtFixture(t),b=await builtFixture(t,'snapshot:B');
 await assertHostedBuildOutput(a.root,a.exported);
 assert.throws(()=>assertHostedExportUnchanged(a.exported,b.exported),/changed during/);
 await assert.rejects(assertHostedBuildOutput(b.root,a.exported),/frozen export identity/);
 // A -> B -> A source replacement is caught by emitted B even when final input is A.
 assertHostedExportUnchanged(a.exported,a.exported);await assert.rejects(assertHostedBuildOutput(b.root,a.exported),/frozen export identity/);
});
test('forged runtime proof, changed shard bytes and extra public media are rejected',async t=>{
 const f=await builtFixture(t);
 await writeFile(path.join(f.client,'runtime',f.file.path),'other');await assert.rejects(assertHostedBuildOutput(f.root,f.exported),/snapshot bytes differ/);
 await writeFile(path.join(f.client,'runtime',f.file.path),JSON.stringify({snapshotId:'snapshot:A'})+'\n');
 await mkdir(path.join(f.client,'media'));await writeFile(path.join(f.client,'media/private.mp3'),'not public');
 await assert.rejects(assertHostedBuildOutput(f.root,f.exported),/Unlisted built public media/);
});
test('wrapper checks emitted artifacts and export identity before replacing previous dist',async()=>{
 const source=await readFile(new URL('../scripts/instance-site-build.mjs',import.meta.url),'utf8');
 assert(source.indexOf('assertHostedBuildOutput(built,exported)')<source.indexOf('await rename(destination,'));
 assert(source.indexOf('verifySoftwarePin(project);verifyProjectRevision()')<source.indexOf('await rename(destination,'));
 assert(source.includes('REVIEW_EXPECTED_EXPORT_MANIFEST_SHA256:exported.manifest.manifestSha256'));
 const preparation=await readFile(new URL('../scripts/prepare-hosted-runtime.mjs',import.meta.url),'utf8');assert(preparation.includes('Hosted export differs from the build-frozen manifest'));
});

test('生产准备按整字段分片，导出与构建逐字一致，仍拒绝超限且不覆盖旧产物',async t=>{
 const root=await temporary(t),limit=16*1024*1024,unit=1024*1024;
 const snapshot={schemaVersion:'1.0',snapshotId:'snapshot:large-neutral-fixture',productionModel:{
  scenes:[{id:'scene:fixture',body:'a'.repeat(9*unit)}],
  productionPreparation:{authorCuts:[{id:'cut:fixture',text:'b'.repeat(5*unit)}]},
  materialDirectory:{description:'c'.repeat(12*unit)},
  domainProductionCompatibilities:[{id:'proof:fixture',scope:['scene:fixture'],history:'保留历史'}],
  futureUnknownField:{nested:['完整保留新增字段']},
 }};
 const parts=snapshotShards(snapshot),serialize=value=>JSON.stringify(value)+'\n';
 assert(Buffer.byteLength(serialize({...parts[2].productionModel,productionPreparation:snapshot.productionModel.productionPreparation}))>limit);
 assert(parts.every(part=>Buffer.byteLength(serialize(part))<=limit));
 assert.deepEqual({...parts[0],productionModel:{...parts[1].productionModel,...parts[2].productionModel}},snapshot);
 assert.equal(parts[1].productionModel.productionPreparation,snapshot.productionModel.productionPreparation);
 assert.equal(Object.hasOwn(parts[2].productionModel,'productionPreparation'),false);
 // 只复制源码，避免并行测试的临时数据库在复制期间退出／删除。
 for(const dir of ['scripts','host'])await cp(new URL('../'+dir,import.meta.url),path.join(root,dir),{recursive:true,filter:source=>!['test','tests','__pycache__'].includes(path.basename(source))&&!path.basename(source).startsWith('.')});
 for(const dir of ['app','data'])await mkdir(path.join(root,dir));
 const source=path.join(root,'app/review-data.generated.json');await writeFile(source,serialize(snapshot));
 await writeFile(path.join(root,'data/review-recipes.generated.json'),serialize({snapshotId:snapshot.snapshotId}));
 await writeFile(path.join(root,'data/hosted-material-events.generated.json'),serialize({snapshotId:snapshot.snapshotId,mode:'HOSTED_READ_ONLY_EVENT_PROJECTION'}));
 const run=()=>promisify(execFile)(process.execPath,[path.join(root,'scripts/prepare-hosted-runtime.mjs')],{cwd:root,env:{...process.env,REVIEW_EXPORT_DIR:'',REVIEW_LEGACY_FIXTURE:'1'},maxBuffer:1024*1024});
 await run();const manifestPath=path.join(root,'public/runtime/manifest.json'),manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes);
 assert.equal(manifest.files.length,5);assert.equal(manifest.maxAssetBytes,limit);
 for(const [i,file] of manifest.files.entries()){
  const bytes=await readFile(path.join(root,'public/runtime',file.filename));assert.equal(bytes.length,file.sizeBytes);assert.equal(sha(bytes),file.sha256);assert(bytes.length<=limit);
  if(i<3)assert.equal(bytes.toString(),serialize(parts[i]));
 }
 snapshot.productionModel.productionPreparation.authorCuts[0].text='x'.repeat(17*unit);await writeFile(source,serialize(snapshot));
 await assert.rejects(run(),/review-data-production-a.generated.json.*16777216/);
 assert.deepEqual(await readFile(manifestPath),manifestBytes);
 for(const file of manifest.files){const bytes=await readFile(path.join(root,'public/runtime',file.filename));assert.equal(bytes.length,file.sizeBytes);assert.equal(sha(bytes),file.sha256);}
});
