import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {withRepositoryMediaRead} from '../host/instance-runtime/media-read-lease.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';

test('saturated original streams leave query capacity available and cancelled bodies release exact media locks',
 {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:120000},async()=>{
  const parent=path.resolve('.test-tmp/media-read-capacity');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'instance-')),profile=blankProfile(),pg=await sharedStoryPostgres(root);
  let repo;
  try{
   repo=await createInstanceRepository({root,backend:'postgres',database:pg.database,instanceId:profile.instanceId,profile,poolSize:4});
   await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null}));
   const baseline=await repo.getMetadata();
   // Bodies remain open without ending: all four media connections are held.
   const responses=await Promise.all(Array.from({length:4},()=>withRepositoryMediaRead(repo,async()=>{
    assert.equal((await repo.getMetadata()).instanceId,profile.instanceId);
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}}));
   })));
   const metadata=await Promise.race([repo.getMetadata(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Media streams starved metadata reads')),1000);timer.unref();})]);
   assert.equal(metadata.repositoryRevision,baseline.repositoryRevision);
   assert.equal(repo.mediaPool.options.max,4);
   await Promise.all(responses.map(response=>response.body.cancel()));
   // Session unlock runs after body completion. Wait for it before testing exclusivity.
   for(let i=0;i<100&&repo.mediaPool.idleCount!==repo.mediaPool.totalCount;i++)await new Promise(r=>setTimeout(r,10));
   await repo.withExclusiveMediaLease(async lease=>{await lease.assertHeld();assert.equal((await repo.getMetadata()).instanceId,profile.instanceId);});
   assert.equal((await repo.getMetadata()).repositoryRevision,baseline.repositoryRevision);
  }finally{await repo?.close();await pg.cleanup();await rm(root,{recursive:true,force:true});}
 });
