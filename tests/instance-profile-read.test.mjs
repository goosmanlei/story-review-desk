import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'vite';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
test('identity polls read the pinned published profile without production projections or unpublished heads',async()=>{
 const root=path.resolve(import.meta.dirname,'..'),parent=path.join(root,'tests/.test-tmp/profile-read');await mkdir(parent,{recursive:true});
 const directory=await mkdtemp(path.join(parent,'instance-')),profile=blankProfile(),dbPath=path.join(directory,'review.sqlite');
 const keys=['REVIEW_INSTANCE_DB','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_ROOT','REVIEW_REMOTE_READ_ONLY','REVIEW_INSTANCE_READ_ONLY','REVIEW_SITE_ROOT'],before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 let repo,server,loaded;
 try {
  repo=await createInstanceRepository({dbPath,instanceId:profile.instanceId,profile});await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null}));
  await repo.writeTransaction(async tx=>{const head=await tx.getConfig('instance-profile');await tx.putConfig({configId:'instance-profile',value:{...profile,title:'unpublished'},expectedRevisionId:head.revisionId});});
  Object.assign(process.env,{REVIEW_INSTANCE_DB:dbPath,REVIEW_INSTANCE_ID:profile.instanceId,REVIEW_INSTANCE_ROOT:'',REVIEW_REMOTE_READ_ONLY:'',REVIEW_INSTANCE_READ_ONLY:'',REVIEW_SITE_ROOT:root});
  server=await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(directory,'vite-cache'),server:{middlewareMode:true},appType:'custom'});
  const store=await server.ssrLoadModule('/app/api/v8/_store.ts');loaded=await store.instanceRepository();loaded.readView=async()=>{throw Error('identity must not load production');};
  const route=await server.ssrLoadModule('/app/api/instance/profile/route.ts'),response=await route.GET();assert.equal(response.status,200);const data=await response.json();
  assert.equal(data.title,profile.title);assert.equal(data.instanceId,profile.instanceId);assert.equal(data.projectId,profile.projectId);
  const published=await repo.getMetadata();await repo.writeTransaction(async tx=>{const head=await tx.getConfig('instance-profile');await tx.publishRelease({...blankSnapshot({...profile,title:'unpublished'}),expectedReleaseId:published.releaseId});});
  assert.equal((await (await route.GET()).json()).title,'unpublished');
 } finally {await server?.close();await loaded?.close();await repo?.close();for(const k of keys)if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];await rm(directory,{recursive:true,force:true});}
});
