import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {legacyContextApiFixture,queueAssetContextFixture} from './fixtures/asset-context-revalidation.mjs';
import {changeDomain} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {ASSET_CONTEXT_NS} from '../host/instance-runtime/asset-context-revalidation-service.mjs';

const exec=promisify(execFile);
async function worker(f){
 const result=await exec(process.execPath,[path.join(f.softwareRoot,'scripts/instance-shot-production-worker.mjs'),'--instance',f.root,'--once'],{cwd:f.softwareRoot,env:{...process.env},timeout:60000,maxBuffer:1024*1024});
 return result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
for(const changed of [false,true])test('actual shared worker CLI '+(changed?'rejects a queued context after DOMAIN changes':'dispatches queued legacy-context revalidation exactly once'),{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await legacyContextApiFixture(t),q=await queueAssetContextFixture(f),queued=JSON.parse((await f.repo.getAux(ASSET_CONTEXT_NS.jobs,q.queued.jobId)).bytes);
 assert.equal(queued.requirementId,q.preview.revalidation.basis.current.requirementId);
 if(changed){const view=await f.repo.readView(),entity=view.snapshot.productionModel.domainGraph.entities.find(e=>e.id==='character:letter-writer');await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:domainHash(entity),value:{...entity,description:'A source change after queue must be checked by the real worker.'}}]);}
 const before=await f.repo.readView(),media=await f.repo.listMedia(),rows=await worker(f),job=JSON.parse((await f.repo.getAux(ASSET_CONTEXT_NS.jobs,q.queued.jobId)).bytes),after=await f.repo.readView();
 assert.equal(rows.length,1,JSON.stringify(rows));assert.equal(job.status,changed?'FAILED':'SUCCEEDED',JSON.stringify(job));assert.equal(rows[0].status,job.status);
 assert.deepEqual(after.eventsByKind.review||[],before.eventsByKind.review||[]);assert.deepEqual(after.eventsByKind.run||[],before.eventsByKind.run||[]);assert.deepEqual(after.eventsByKind['asset-version']||[],before.eventsByKind['asset-version']||[]);assert.deepEqual(await f.repo.listMedia(),media);
 if(changed){assert.equal(after.releaseId,before.releaseId);assert.deepEqual(after.sourceRevisionIds,before.sourceRevisionIds);assert.deepEqual(after.snapshot,before.snapshot);assert.deepEqual(after.eventsByKind,before.eventsByKind);}
 else{assert.equal(rows[0].contextRevalidationPerformed,true);assert.equal(rows[0].formalAdoptionPerformed,false);assert.equal(rows[0].modelCalls,0);assert.equal(after.eventsByKind['asset-context-revalidation'].length,1);assert.equal((await f.store.operationalSnapshot()).stateProjection.assetVersionsById[f.target.versionId].canFlowDownstream,true);}
 assert.deepEqual(await worker(f),[]);assert.equal(f.externalCalls(),0);
});
