import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {legacyObjects} from './material-production-fixture.mjs';
import {productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';

for(const initialAction of ['REQUEST_REVISION','APPROVE_AND_RELEASE']){
 test('native material real API '+(initialAction==='REQUEST_REVISION'?'V001 revision → V002 approval':'V001 approved → V002 revision → V003 approval')+' preserves exact history and consumers',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
  const f=await apiFixture(t),legacy=legacyObjects(await f.repo.readView());
  const first=await f.provision(await f.workspace(),'First fixed fixture, no generation.');assert.equal(first.plan.schemaVersion,'MATERIAL_PRODUCTION_PLAN_V1');
  const run1=await f.beginRun(first);
  if(initialAction==='REQUEST_REVISION'){
   const running=await f.post(f.runs,'v8/runs',{...run1,state:'RUNNING',note:'Fixture running state only.'});assert.equal(running.status,201);
   const busy=await f.workspace();assert.ok(busy.blockers.some(b=>b.includes(run1.runId)));const before=await f.repo.exportState();assert.equal((await f.materialPost(f.saveBody(busy,'Must not dispatch while busy'))).status,409);assert.deepEqual(await f.repo.exportState(),before);
   const unknown=await f.post(f.runs,'v8/runs',{...run1,state:'RESULT_UNKNOWN',note:'Fixture result reconciliation pending.'});assert.equal(unknown.status,201);
   const blocked=await f.workspace(),stateBefore=await f.repo.exportState();assert.ok(blocked.blockers.some(b=>b.includes(run1.runId)));assert.equal((await f.materialPost(f.saveBody(blocked,'No retry of unknown result'))).status,409);assert.deepEqual(await f.repo.exportState(),stateBefore);
  }
  const v1=await f.register(first,run1,pngs[0],{unknown:initialAction==='REQUEST_REVISION'});assert.equal(v1.versionId,first.result.familyId+'@V001');
  await f.evidence(first.result.familyId,v1);
  const review1=await f.review(first,v1,initialAction),beforeRevision=await f.repo.readView(),eventsBefore=structuredClone(beforeRevision.eventsByKind),w=await f.workspace();
  assert.equal(w.mode,'REVISION');assert.equal(w.parentVersionId,v1.versionId);assert.equal(w.parentVersionSha256,v1.sha256);assert.equal(w.currentDefinitionId,first.recipe.id);assert.equal(w.plannedVersionLabel,'V002');assert.deepEqual(w.blockers,[]);
  const savedBody=f.saveBody(w,'Second fixed fixture, no generation.'),unchanged=await f.repo.exportState();
  assert.equal((await f.materialPost(savedBody,{headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await f.materialPost(savedBody,{headers:{'If-Match':'"stale-cas"'}})).status,412);
  const {expectedBasisHash,...withoutBasis}=savedBody;assert.equal((await f.materialPost(withoutBasis)).status,409);
  assert.equal((await f.materialPost({...savedBody,expectedBasisHash:'0'.repeat(64)})).status,409);
  for(const key of ['REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY']){try{process.env[key]='1';assert.equal((await f.materialPost(savedBody)).status,405);}finally{process.env[key]='';}}
  assert.deepEqual(await f.repo.exportState(),unchanged,'CAS and basis rejections write no AUX, media, source, review or release');
  const second=await f.provision(w,'Second fixed fixture, no generation.',{expectedMode:'REVISION'});
  assert.equal(second.plan.schemaVersion,'MATERIAL_PRODUCTION_RECIPE_V1');assert.equal(second.result.familyId,first.result.familyId);assert.equal(second.result.workItemId,first.result.workItemId);
  assert.notEqual(second.recipe.id,first.recipe.id);assert.notEqual(second.recipe.output.expectedOutputRef,first.recipe.output.expectedOutputRef);assert.equal(second.recipe.parentVersionId,v1.versionId);assert.equal(second.recipe.parentVersionSha256,v1.sha256);assert.equal(second.plan.parentVersionSha256,v1.sha256);assert.equal(second.plan.expectedOutput.plannedVersionLabel,'V002');
  const published=await f.repo.readView();assert.deepEqual(published.recipes.executionDefinitions.find(d=>d.id===first.recipe.id),first.recipe);assert.deepEqual(published.snapshot.productionModel.expectedOutputs.find(o=>o.id===first.recipe.output.expectedOutputRef),beforeRevision.snapshot.productionModel.expectedOutputs.find(o=>o.id===first.recipe.output.expectedOutputRef));
  assert.deepEqual(published.eventsByKind,eventsBefore,'publishing V002 recipe cannot rewrite candidate, run or formal review events');
  const revision=published.snapshot.productionModel.materialProductionRecipeRevisions.at(-1),source=await f.repo.readTransaction(tx=>tx.readDocumentRevision(revision.sourceRevisionId));assert.equal(source.metadata.sourceRole,'MATERIAL_PRODUCTION_RECIPE');assert.equal(sha256(source.bytes),revision.sourceSha256);
  const boundV1={familyId:first.result.familyId,versionId:v1.versionId,sha256:v1.sha256};
  const checkAdoptedV1=async()=>{const data=await f.store.reviewData(),op=await f.store.operationalSnapshot(),state=op.stateProjection;assert.equal(state.assetFamiliesById[first.result.familyId].currentVersionId,v1.versionId);assert.equal(state.assetVersionsById[v1.versionId].canFlowDownstream,true);assert.deepEqual(productionBindingReasons(data.productionModel,state,boundV1),[],'new planned output must not invalidate exact adopted V001 consumer');assert.ok((await f.workspace()).availableInputs.some(b=>b.familyId===boundV1.familyId&&b.versionId===boundV1.versionId&&b.sha256===boundV1.sha256),'the previous adopted version stays selectable as an exact input');};
  if(initialAction==='APPROVE_AND_RELEASE')await checkAdoptedV1();
  const run2=await f.beginRun(second),v2=await f.register(second,run2,pngs[1]);assert.equal(v2.versionId,first.result.familyId+'@V002');assert.notEqual(v2.sha256,v1.sha256);
  await f.evidence(first.result.familyId,v1);await f.evidence(first.result.familyId,v2);
  const pending=await f.store.operationalSnapshot();assert.equal(pending.stateProjection.assetVersionsById[v2.versionId].canFlowDownstream,false);if(initialAction==='APPROVE_AND_RELEASE')await checkAdoptedV1();
  const event2=(await f.repo.readView()).eventsByKind['asset-version'].find(e=>e.versionId===v2.versionId);assert.equal(event2.parentVersionId,v1.versionId);assert.equal(event2.executionDefinitionId,second.recipe.id);assert.equal(event2.expectedOutputId,second.recipe.output.expectedOutputRef);
  let adopted=v2;
  if(initialAction==='APPROVE_AND_RELEASE'){
   await f.review(second,v2,'REQUEST_REVISION');await checkAdoptedV1();
   const thirdWorkspace=await f.workspace();assert.equal(thirdWorkspace.parentVersionId,v2.versionId);assert.equal(thirdWorkspace.parentVersionSha256,v2.sha256);assert.equal(thirdWorkspace.plannedVersionLabel,'V003');assert.deepEqual(thirdWorkspace.blockers,[]);
   const third=await f.provision(thirdWorkspace,'Third fixed fixture, no generation.',{expectedMode:'REVISION'});assert.equal(third.recipe.parentVersionId,v2.versionId);await checkAdoptedV1();
   const run3=await f.beginRun(third),v3=await f.register(third,run3,pngs[0],{wrongParentVersionId:v1.versionId});assert.equal(v3.versionId,first.result.familyId+'@V003');await checkAdoptedV1();
   await f.evidence(first.result.familyId,v1);await f.evidence(first.result.familyId,v2);await f.evidence(first.result.familyId,v3);await f.review(third,v3,'APPROVE_AND_RELEASE');adopted=v3;
  }else await f.review(second,v2,'APPROVE_AND_RELEASE');
  const final=await f.store.operationalSnapshot();assert.equal(final.stateProjection.assetFamiliesById[first.result.familyId].currentVersionId,adopted.versionId);assert.equal(final.stateProjection.assetVersionsById[adopted.versionId].canFlowDownstream,true);
  const end=await f.repo.readView();assert.deepEqual(end.eventsByKind.review.find(e=>e.eventId===review1.eventId),review1);assert.deepEqual(end.eventsByKind['asset-version'].find(e=>e.versionId===v1.versionId),eventsBefore['asset-version'].find(e=>e.versionId===v1.versionId));assert.equal(sha256(await readFile(path.join(f.root,first.recipe.output.path))),v1.sha256);assert.deepEqual(legacyObjects(end),legacy);assert.equal(f.externalCalls(),0);
 });
}
