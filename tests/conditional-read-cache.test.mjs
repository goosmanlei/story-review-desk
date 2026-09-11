import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
import {conditionalWorkspaceRead,retainReadValidator} from '../host/instance-runtime/conditional-read-cache.mjs';
import {workspaceReadMetadata,readBasis} from '../host/instance-runtime/read-basis.mjs';
test('conditional responses remain exact across heartbeat, business changes, rollback, instance boundaries and eviction',async()=>{
 const parent=path.resolve('tests/.test-tmp/conditional-read');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(path.join(parent,'instance-')),profile=blankProfile(),pg=process.env.REVIEW_TEST_POSTGRES==='1'?await sharedStoryPostgres(root):null;
 let repo;
 try {
  repo=await createInstanceRepository({...pg?{root,backend:'postgres',database:pg.database}:{dbPath:path.join(root,'review.sqlite')},instanceId:profile.instanceId,profile});
  await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null}));
  const request=(id='one',etag='"complete"')=>new Request('http://localhost/api/materials?filter='+id,{headers:{'If-None-Match':etag}});
  const remember=async(id='one',status=200)=>{const metadata=await repo.readTransaction(workspaceReadMetadata);retainReadValidator(repo,request(id),new Response(null,{status,headers:{ETag:'"complete"','X-Review-Basis':readBasis(metadata)}}));};
  await remember();assert.equal((await conditionalWorkspaceRead(repo,request())).status,304);
  assert.equal(await conditionalWorkspaceRead(repo,request('different')),null);assert.equal(await conditionalWorkspaceRead(repo,request('one','"different"')),null);
  await repo.writeTransaction(tx=>tx.putAux({namespace:'assistant-public',key:'health.json',bytes:'{}',expectedRevisionId:null}));
  assert.equal((await conditionalWorkspaceRead(repo,request())).status,304);
  await repo.writeTransaction(tx=>tx.putAux({namespace:'drafts',key:'one',bytes:'{}',expectedRevisionId:null}));
  assert.equal(await conditionalWorkspaceRead(repo,request()),null);await remember();
  await assert.rejects(repo.writeTransaction(async()=>{await remember('rollback');assert.equal(await conditionalWorkspaceRead(repo,request()),null);throw Error('rollback');}));
  assert.equal(await conditionalWorkspaceRead(repo,request('rollback')),null);
  await remember('failed',503);assert.equal(await conditionalWorkspaceRead(repo,request('failed')),null);
  const foreign={inTransaction:false,readTransaction:()=>{throw Error('must not read another repository');}};
  assert.equal(await conditionalWorkspaceRead(foreign,request()),null);
  const read=repo.readTransaction.bind(repo);repo.readTransaction=async callback=>{await read(callback);throw Error('commit failed');};
  await assert.rejects(conditionalWorkspaceRead(repo,request()),/commit failed/);repo.readTransaction=read;
  await repo.writeTransaction(tx=>tx.resetRuntimeEpoch());assert.equal(await conditionalWorkspaceRead(repo,request()),null);
  for(let i=0;i<65;i++)await remember(String(i));assert.equal(await conditionalWorkspaceRead(repo,request('0')),null);assert.equal((await conditionalWorkspaceRead(repo,request('64'))).status,304);
 } finally {await repo?.close();await pg?.cleanup();await rm(root,{recursive:true,force:true});}
});
