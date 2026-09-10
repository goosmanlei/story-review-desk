import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {committedQueryJson,committedProjectionJson} from '../host/instance-runtime/committed-query-cache.mjs';
import {workspaceReadMetadata,readBasis} from '../host/instance-runtime/read-basis.mjs';
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

test('different scene reads reuse one committed common projection with private trees and exact revisions',()=>fixture(async repo=>{
  let calls=0;
  const shared=async tx=>{calls++;return value(tx);};
  const scene=key=>committedQueryJson(repo,key,async tx=>{
    const first=await committedProjectionJson(tx,'scene common',shared);
    assert.equal(await committedProjectionJson(tx,'scene common',shared),first);
    const own=JSON.parse(first);own.scene=key;return own;
  });
  const [one,two]=await Promise.all([scene('scene,one'),scene('scene,two')]);
  assert.equal(calls,1);assert.equal(JSON.parse(one).scene,'scene,one');assert.equal(JSON.parse(two).scene,'scene,two');
  await scene('third');assert.equal(calls,1);
  // Returning to other modules can churn all ordinary query entries without
  // dropping the compact common directory needed by a not-yet-opened scene.
  for(let n=0;n<24;n++)await committedQueryJson(repo,'page:'+n,async()=>({page:n}));
  await scene('unseen after module round trips');assert.equal(calls,1);
  await writeValue(repo,'changed');assert.equal(JSON.parse(await scene('fourth')).value,'changed');assert.equal(calls,2);
  await repo.writeTransaction(async tx=>{
    assert.equal(JSON.parse(await committedProjectionJson(tx,'scene common',shared)).value,'changed');
  });assert.equal(calls,3);
}));

test('a shared scene projection waits for COMMIT and is discarded on failed completion',()=>fixture(async repo=>{
  const entered=deferred(),release=deferred(),joined=deferred();let fail=true,calls=0;
  const wrapper={get inTransaction(){return repo.inTransaction;},readTransaction:callback=>repo.readTransaction(async tx=>{
    const result=await callback(tx);if(fail){entered.resolve();await release.promise;throw Error('commit rejected');}return result;
  })};
  const read=key=>committedQueryJson(wrapper,key,tx=>{
    const pending=committedProjectionJson(tx,'common',async current=>{calls++;return value(current);});
    if(key==='follower')joined.resolve();return pending;
  });
  const owner=read('owner');await entered.promise;let settled=false;
  const follower=read('follower').finally(()=>{settled=true;});
  await joined.promise;assert.equal(settled,false);release.resolve();
  const results=await Promise.allSettled([owner,follower]);assert(results.every(r=>r.status==='rejected'));assert.equal(calls,1);
  fail=false;await read('retry');assert.equal(calls,2);await read('other');assert.equal(calls,2);
}));

test('workspace reads survive health heartbeats but invalidate on drafts, media, events, releases and epochs',()=>fixture(async(repo,profile)=>{
  let calls=0;
  const read=key=>committedQueryJson(repo,key,async tx=>JSON.parse(await committedProjectionJson(tx,'workspace common',async()=>{
    calls++;return {value:(await tx.getAux('qa','value')).bytes.toString(),basis:readBasis(await workspaceReadMetadata(tx))};
  })),undefined,undefined,workspaceReadMetadata);
  const first=await read('scene:first'),metadata=await repo.getMetadata();
  await repo.writeTransaction(tx=>tx.putAux({namespace:'assistant-public',key:'health.json',bytes:'{"online":true}',expectedRevisionId:null}));
  assert((await repo.getMetadata()).repositoryRevision>metadata.repositoryRevision);
  assert.equal(await read('scene:second'),first);assert.equal(calls,1);
  await writeValue(repo,'new draft');assert.equal(JSON.parse(await read('scene:first')).value,'new draft');assert.equal(calls,2);
  let before=await read('scene:first');
  const invalidates=async mutation=>{await mutation();const after=await read('scene:first');assert.notEqual(after,before);before=after;};
  await invalidates(()=>repo.writeTransaction(tx=>tx.registerMedia({mediaId:'test-family',versionId:'test-v1',relativePath:'media/test.png',sha256:'a'.repeat(64),byteSize:4,aliases:['test-alias'],metadata:{authorityDomain:'FORMAL'}})));
  await invalidates(()=>repo.writeTransaction(tx=>tx.putAux({namespace:'media-retirement-tombstones',key:'test-v1',bytes:'{}',expectedRevisionId:null})));
  await invalidates(()=>repo.writeTransaction(tx=>tx.appendEvent({kind:'qa',idempotencyKey:'workspace-event',requestHash:'a'.repeat(64),payload:{purpose:'workspace watermark'}})));
  await invalidates(()=>repo.writeTransaction(async tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:(await tx.getMetadata()).releaseId})));
  await invalidates(()=>repo.writeTransaction(tx=>tx.resetRuntimeEpoch()));
  // Only health.json is excluded: future assistant data remains conservative.
  await invalidates(()=>repo.writeTransaction(tx=>tx.putAux({namespace:'assistant-public',key:'other.json',bytes:'{}',expectedRevisionId:null})));
  assert.equal(calls,8);
}));
