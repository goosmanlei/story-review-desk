import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,rename,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {verifySoftwarePin} from '../scripts/instance-software-pin.mjs';
import {canonicalHostingConfig,assertProjectBuildRevision,assertHostedPublicationIdentity} from '../scripts/instance-build-contract.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('explicit unversioned development software packages reproducibly in different directories',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'review-package-repeat-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const manifests=[];
 for(const name of ['first','second']){
  const destination=path.join(root,name);
  const result=spawnSync(process.execPath,['scripts/instance-package.mjs','--output',destination,'--software-commit','UNVERSIONED'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  manifests.push(await readFile(path.join(destination,'software-manifest.json')));
 }
 assert.deepEqual(manifests[0],manifests[1]);
 const manifest=JSON.parse(manifests[0]);
 assert.equal(manifest.softwareCommit,'UNVERSIONED');
 assert.equal(manifest.copiedBusinessData,false);
 assert.deepEqual(manifest.productionStorySpecificHits,[]);
 assert.ok(manifest.files.length>100);
});
async function fixture(t){
 const project=await realpath(await mkdtemp(path.join(tmpdir(),'review-core-pin-'))),software=path.join(project,'review-software');
 t.after(()=>rm(project,{recursive:true,force:true}));await mkdir(path.join(software,'app'),{recursive:true});
 const bytes=Buffer.from('export default function Page(){return null;}\n');await writeFile(path.join(software,'app/page.tsx'),bytes);
 const manifest={kind:'STORY_NEUTRAL_SOFTWARE',softwareCommit:'a'.repeat(40),copiedBusinessData:false,copiedCredentials:false,productionStorySpecificHits:[],files:[{path:'app/page.tsx',bytes:bytes.length,sha256:hash(bytes)}]};
 async function persist(){const body=JSON.stringify(manifest)+'\n';await writeFile(path.join(software,'software-manifest.json'),body);await writeFile(path.join(project,'core-lock.json'),JSON.stringify({schemaVersion:'1.0',kind:'CORE_SOFTWARE_PIN',repository:'https://github.com/example/story-review-desk',commit:manifest.softwareCommit,softwareManifestSha256:hash(body),packagePath:'review-software'}));}
 await persist();return {project,software,manifest,persist};
}
test('exact package verifies without requiring a source checkout',async t=>{const f=await fixture(t),r=await verifySoftwarePin(f.project);assert.equal(r.manifest.files.length,1);});
test('a modified managed source fails',async t=>{const f=await fixture(t);await writeFile(path.join(f.software,'app/page.tsx'),'changed');await assert.rejects(verifySoftwarePin(f.project),/Managed software changed/);});
for(const file of ['app/api/extra/route.ts','host/extra.py','scripts/extra.mjs','extra.js']){
 test('unmanaged source is rejected: '+file,async t=>{const f=await fixture(t);const p=path.join(f.software,file);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,'unmanaged');await assert.rejects(verifySoftwarePin(f.project),/Unmanaged software file/);});
}
test('intermediate directory symlink cannot pass by preserving the final bytes',async t=>{const f=await fixture(t),outside=path.join(f.project,'other-app');await rename(path.join(f.software,'app'),outside);await symlink(outside,path.join(f.software,'app'));await assert.rejects(verifySoftwarePin(f.project),/Managed software changed|symlink/);});
test('cache root symlink is rejected too',async t=>{const f=await fixture(t),outside=path.join(f.project,'cache');await mkdir(outside);await symlink(outside,path.join(f.software,'node_modules'));await assert.rejects(verifySoftwarePin(f.project),/symlink/);});
test('unmanaged regular generated blank data is permitted, real story data is not',async t=>{const f=await fixture(t);await mkdir(path.join(f.software,'data'));const file=path.join(f.software,'data/review-data-core.generated.json');await writeFile(file,JSON.stringify({snapshotId:'REVIEW-EMPTY-V1'}));await verifySoftwarePin(f.project);await writeFile(file,JSON.stringify({snapshotId:'story-private'}));await assert.rejects(verifySoftwarePin(f.project),/Unmanaged software/);});
test('unknown generated-looking executable is rejected',async t=>{const f=await fixture(t);await mkdir(path.join(f.software,'data'));await writeFile(path.join(f.software,'data/extra.mjs'),'export default 1');await assert.rejects(verifySoftwarePin(f.project),/Unmanaged software/);});
test('manifest traversal and duplicates fail even after the pin hash is recomputed',async t=>{for(const malformed of ['../escape','app/../escape','app/page.tsx']){const f=await fixture(t);f.manifest.files.push({...f.manifest.files[0],path:malformed});await f.persist();await assert.rejects(verifySoftwarePin(f.project),/Invalid manifest/);}});
test('current project_id hosting shape is preserved canonically',()=>{assert.deepEqual(canonicalHostingConfig({project_id:'appgprj_example',d1:null,r2:null}),{project_id:'appgprj_example',d1:null,r2:null});});
test('legacy id is read-compatible but output always uses project_id',()=>{assert.deepEqual(canonicalHostingConfig({id:'appgprj_example'}),{project_id:'appgprj_example'});});
for(const bad of [{project_id:'appgprj_a',id:'appgprj_b'},{project_id:'bad'},{project_id:'appgprj_a',token:'not-a-credential'},{project_id:'appgprj_a',d1:{}},{project_id:'appgprj_a',r2:'bad/name'}])test('unsafe hosting configuration rejects '+Object.keys(bad).join(','),()=>assert.throws(()=>canonicalHostingConfig(bad)));
test('build source must match an actual clean commit, not an arbitrary flag',()=>{const c='a'.repeat(40);assert.equal(assertProjectBuildRevision(c,c,''),c);assert.throws(()=>assertProjectBuildRevision(c,'b'.repeat(40),''));assert.throws(()=>assertProjectBuildRevision(c,c,' M tracked-source'));});
test('published Sites source and served artifact both match exact commits and export',()=>{const expected={projectCommit:'a'.repeat(40),coreCommit:'b'.repeat(40),exportManifestSha256:'c'.repeat(64),snapshotId:'snapshot:one',siteId:'appgprj_example'},proof={kind:'PROJECT_READ_ONLY_BUILD',canWrite:false,...expected},remote={source:{commit_sha:expected.projectCommit}};assert.equal(assertHostedPublicationIdentity(remote,proof,expected).state,'SOURCE_AND_ARTIFACT_IDENTITY_MATCH');for(const field of ['projectCommit','coreCommit','exportManifestSha256','snapshotId','siteId'])assert.throws(()=>assertHostedPublicationIdentity(remote,{...proof,[field]:'wrong'},expected));assert.throws(()=>assertHostedPublicationIdentity({source:{commit_sha:'d'.repeat(40)}},proof,expected));assert.throws(()=>assertHostedPublicationIdentity(remote,{...proof,canWrite:true},expected));});
test('Sites wrapper materializes its config and exposes a served build proof',async()=>{const source=await readFile(new URL('../scripts/instance-site-build.mjs',import.meta.url),'utf8');for(const text of ['canonicalHostingConfig','hosting.project_id',"path.join(client,'core-build-proof.json')","gitRead(['rev-parse','HEAD'])",'verifySoftwarePin(project);verifyProjectRevision()'])assert.ok(source.includes(text),text);});

test('issued non-Git package repackages new project software without a source checkout',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'review-issued-package-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const issued=path.join(root,'issued'),project=path.join(root,'new-project'),target=path.join(project,'review-software');await mkdir(project);
 const first=spawnSync(process.execPath,['scripts/instance-package.mjs','--output',issued,'--software-commit','UNVERSIONED'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(first.status,0,first.stderr||first.stdout);
 // A synthetic previously issued manifest; production Git authenticity is tested
 // separately. No Git repo or commit is created by this offline fixture.
 const manifestPath=path.join(issued,'software-manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.softwareCommit='a'.repeat(40);
 await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 // The real build generator must not change a managed type declaration and
 // make a correctly built installed package fail its exact pin afterwards.
 const beforeTypes=await readFile(path.join(issued,'next-env.d.ts'));
 await mkdir(path.join(issued,'node_modules'));
 await symlink(await realpath(new URL('../node_modules/next',import.meta.url)),path.join(issued,'node_modules/next'));
 const {generateRouteTypes}=await import(new URL('../node_modules/vinext/dist/typegen.js',import.meta.url).href);
 await generateRouteTypes({root:issued});
 assert.deepEqual(await readFile(path.join(issued,'next-env.d.ts')),beforeTypes);
 const packaged=spawnSync(process.execPath,[path.join(issued,'scripts/instance-package.mjs'),'--output',target],{cwd:root,encoding:'utf8',env:{...process.env,REVIEW_SOFTWARE_COMMIT:''}});
 assert.equal(packaged.status,0,packaged.stderr||packaged.stdout);
 const result=await readFile(path.join(target,'software-manifest.json'));assert.deepEqual(result,await readFile(manifestPath));
 await writeFile(path.join(project,'core-lock.json'),JSON.stringify({schemaVersion:'1.0',kind:'CORE_SOFTWARE_PIN',packagePath:'review-software',repository:'https://github.com/example/core',commit:manifest.softwareCommit,softwareManifestSha256:hash(result)}));
 await verifySoftwarePin(project);
});
