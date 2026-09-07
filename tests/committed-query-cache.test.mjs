import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {committedQueryJson} from '../host/instance-runtime/committed-query-cache.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function fixture(run){
  const parent=path.resolve('.test-tmp/committed-query-cache');await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'instance-')),profile=blankProfile();
  const pg=process.env.REVIEW_TEST_POSTGRES==='1'?await sharedStoryPostgres(root):null;
  let repo;
  try{repo=await createInstanceRepository({...pg?{root,backend:'postgres',database:pg.database}:{dbPath:path.join(root,'review.sqlite')},instanceId:profile.instanceId,profile});await repo.writeTransaction(async tx=>{await tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null});await tx.putAux({namespace:'qa',key:'value',bytes:'old',expectedRevisionId:null});});await run(repo,profile);}finally{await repo?.close();await pg?.cleanup();await rm(root,{recursive:true,force:true});}
}
const value=async tx=>({metadata:await tx.getMetadata(),value:(await tx.getAux('qa','value')).bytes.toString()});
async function writeValue(repo,text){await repo.writeTransaction(async tx=>{const old=await tx.getAux('qa','value');await tx.putAux({namespace:'qa',key:'value',bytes:text,expectedRevisionId:old.revisionId});});}

test('five readers share one committed projection and receive independent immutable JSON',()=>fixture(async repo=>{
  let calls=0;const entered=deferred(),release=deferred();
  const read=async tx=>{calls++;entered.resolve();await release.promise;return value(tx);};
  const requests=Array.from({length:5},()=>committedQueryJson(repo,'current',read));
  await entered.promise;release.resolve();const results=await Promise.all(requests);
  assert.equal(calls,1);assert.equal(new Set(results).size,1);
  const changed=JSON.parse(results[0]);changed.value='local mutation';
  assert.equal(JSON.parse(await committedQueryJson(repo,'current',read)).value,'old');assert.equal(calls,1);
  await committedQueryJson(repo,'history:other',read);assert.equal(calls,2);
}));

test('aux drafts, event watermarks, published releases and runtime epochs invalidate cached GETs',()=>fixture(async(repo,profile)=>{
  const read=()=>committedQueryJson(repo,'state',value);
  const before=JSON.parse(await read());await writeValue(repo,'draft changed');const draft=JSON.parse(await read());
  assert.equal(draft.value,'draft changed');assert.equal(draft.metadata.releaseId,before.metadata.releaseId);assert(draft.metadata.repositoryRevision>before.metadata.repositoryRevision);
  await repo.writeTransaction(tx=>tx.appendEvent({kind:'qa',idempotencyKey:'first',requestHash:'a'.repeat(64),payload:{purpose:'cache event boundary'}}));
  const event=JSON.parse(await read());assert(event.metadata.eventSequence>draft.metadata.eventSequence);
  await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:event.metadata.releaseId}));
  const published=JSON.parse(await read());assert.notEqual(published.metadata.releaseId,event.metadata.releaseId);
  await repo.writeTransaction(tx=>tx.resetRuntimeEpoch());const restored=JSON.parse(await read());assert.notEqual(restored.metadata.runtimeEpoch,published.metadata.runtimeEpoch);
}));

test('an old in-flight reader stays on its snapshot and cannot mask a newer committed response',()=>fixture(async repo=>{
  const entered=deferred(),release=deferred();let calls=0;
  const read=async tx=>{calls++;if(calls===1){entered.resolve();await release.promise;}return value(tx);};
  const old=committedQueryJson(repo,'racing',read);await entered.promise;
  await writeValue(repo,'new committed');const fresh=JSON.parse(await committedQueryJson(repo,'racing',read));assert.equal(fresh.value,'new committed');
  release.resolve();const earlier=JSON.parse(await old);assert.equal(earlier.value,'old');assert.notEqual(earlier.metadata.repositoryRevision,fresh.metadata.repositoryRevision);
  assert.deepEqual(JSON.parse(await committedQueryJson(repo,'racing',read)),fresh);assert.equal(calls,2);
}));

test('nested writes and pinned reads bypass shared cache, including rolled-back values',()=>fixture(async repo=>{
  let calls=0;const read=async tx=>{calls++;return value(tx);};
  const original=await committedQueryJson(repo,'private',read);
  await assert.rejects(repo.writeTransaction(async tx=>{
    const old=await tx.getAux('qa','value');await tx.putAux({namespace:'qa',key:'value',bytes:'never committed',expectedRevisionId:old.revisionId});
    assert.equal(JSON.parse(await committedQueryJson(repo,'private',read)).value,'never committed');throw new Error('rollback');
  }),/rollback/);
  assert.equal(await committedQueryJson(repo,'private',read),original);assert.equal(calls,2);
  await repo.readTransaction(async()=>{await committedQueryJson(repo,'private',read);await committedQueryJson(repo,'private',read);});assert.equal(calls,4);
}));

test('factory or transaction completion errors reject followers and are never cached',()=>fixture(async repo=>{
  let failCommit=true,calls=0,arrivals=0;const allMetadata=deferred();
  const wrapper={get inTransaction(){return repo.inTransaction;},readTransaction:callback=>repo.readTransaction(async tx=>{
    const observed=Object.create(tx);let first=true;
    observed.getMetadata=async()=>{const metadata=await tx.getMetadata();if(first){first=false;if(++arrivals===5)setImmediate(allMetadata.resolve);}return metadata;};
    const result=await callback(observed);if(failCommit){await allMetadata.promise;throw new Error('transaction completion failed');}return result;
  })};
  const read=async tx=>{calls++;return value(tx);};
  const rejected=await Promise.allSettled(Array.from({length:5},()=>committedQueryJson(wrapper,'failure',read)));
  assert(rejected.every(r=>r.status==='rejected'));assert.equal(calls,1);
  failCommit=false;assert.equal(JSON.parse(await committedQueryJson(wrapper,'failure',read)).value,'old');assert.equal(calls,2);
  let failFactory=true;const factory=async tx=>{if(failFactory)throw new Error('factory failed');return value(tx);};
  await assert.rejects(committedQueryJson(repo,'factory',factory),/factory failed/);failFactory=false;assert.equal(JSON.parse(await committedQueryJson(repo,'factory',factory)).value,'old');
}));
