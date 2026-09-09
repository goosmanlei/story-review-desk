import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {preserveMaterialProductionProjection} from '../host/instance-runtime/material-production-preservation.mjs';

// Install an old producer's source shape in an isolated test repository before
// its first request. This is fixture import, never a production migration and
// never an in-place edit of an existing source, definition, event or media row.
async function publishHistoricalSecond(f){
 const w=await f.workspace(),saved=await f.materialPost(f.saveBody(w,'Historical second definition fixture.'));
 assert.equal(saved.status,200,JSON.stringify(saved.body));
 const preview=await f.materialPost({action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const plan=structuredClone(preview.body.plan);
 assert.equal(plan.schemaVersion,'MATERIAL_PRODUCTION_RECIPE_V1');
 assert.ok(plan.parentVersionSha256);assert.ok(plan.basis.revision.parentVersionSha256);
 delete plan.executionDefinition.parentVersionSha256;
 plan.executionDefinition.definitionHash=executionDefinitionHash(plan.executionDefinition);
 plan.promptRevision.definitionHash=plan.executionDefinition.definitionHash;
 const result=await f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),source=await tx.putDocument({documentId:'material-production-recipe:'+plan.id,aliases:[plan.sourcePath],expectedRevisionId:null,bytes:canonicalJson(plan),mediaType:'application/json',metadata:{sourceRole:'MATERIAL_PRODUCTION_RECIPE'}});
  const snapshot=structuredClone(view.snapshot),model=snapshot.productionModel,recipes=structuredClone(view.recipes),sourceEnvelope={sourceRef:plan.sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256};
  model.assetFamilies=model.assetFamilies.map(family=>family.id===plan.assetFamily.id?plan.assetFamily:family);
  model.materialWorkItems=model.materialWorkItems.map(work=>work.id===plan.materialWorkItem.id?plan.materialWorkItem:work);
  model.expectedOutputs.push(plan.expectedOutput);
  recipes.executionDefinitions.push({...plan.executionDefinition,...sourceEnvelope});recipes.promptRevisions.push({...plan.promptRevision,...sourceEnvelope});
  model.materialProductionRecipeRevisions=[...(model.materialProductionRecipeRevisions||[]),{id:plan.id,materialProductionPlanId:plan.materialProductionPlanId,requirementId:plan.requirementId,representationId:plan.representationId,familyId:plan.assetFamily.id,workItemId:plan.materialWorkItem.id,expectedOutputId:plan.expectedOutput.id,definitionId:plan.executionDefinition.id,definitionHash:plan.executionDefinition.definitionHash,previousDefinitionId:plan.previousDefinitionId,previousExpectedOutputId:plan.previousExpectedOutputId,parentVersionId:plan.parentVersionId,parentVersionSha256:plan.parentVersionSha256,requirementHash:plan.requirementAfter.requirementHash,basisHash:plan.basisHash,sourcePath:plan.sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256}];
  const documents=[...await Promise.all(view.sourceRevisionIds.map(id=>tx.readDocumentRevision(id))),source];
  preserveMaterialProductionProjection({snapshot,recipes,baseSnapshot:snapshot,baseRecipes:recipes,documents});
  snapshot.snapshotId='snapshot_'+domainHash({previous:view.snapshot.snapshotId,historicalFixture:source.sha256}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
  await tx.publishRelease({snapshot,recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId]});
  return {familyId:plan.assetFamily.id,workItemId:plan.materialWorkItem.id,definitionId:plan.executionDefinition.id,expectedOutputId:plan.expectedOutput.id,sourceRevisionId:source.revisionId};
 });
 const view=await f.repo.readView();
 return {result,plan,view,recipe:view.recipes.executionDefinitions.find(d=>d.id===result.definitionId)};
}

test('historical native failed V002 with source-only parent SHA creates real V003 through API/worker and preserves all legacy bytes',
 {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'Original synthetic image fixture.'),run1=await f.beginRun(first),v1=await f.register(first,run1,pngs[0]);
 await f.review(first,v1,'APPROVE_AND_RELEASE');
 const second=await publishHistoricalSecond(f),legacySource=await f.repo.readDocumentRevision(second.result.sourceRevisionId),legacyBytes=Buffer.from(legacySource.bytes),oldDefinition=canonicalJson(second.recipe);
 assert.equal(Object.hasOwn(second.recipe,'parentVersionSha256'),false);
 const run2=await f.beginRun(second),running=await f.workspace();assert(running.blockers.some(s=>s.includes('Run')));
 const unresolved=await f.post(f.runs,'v8/runs',{...run2,state:'RESULT_UNKNOWN',note:'Synthetic lost tool result for boundary validation; no actual provider call.'});assert.equal(unresolved.status,201,JSON.stringify(unresolved.body));
 const unknown=await f.workspace(),unchanged=await f.repo.exportState();assert(unknown.blockers.length);
 const denied=await f.materialPost(f.saveBody(unknown,'Cannot retry unknown.'));assert.equal(denied.status,409,JSON.stringify(denied.body));assert.deepEqual(await f.repo.exportState(),unchanged);
 const failed=await f.post(f.runs,'v8/runs',{...run2,state:'FAILED',note:'Synthetic HTTP 400 moderation_blocked fixture; output returned false. No actual provider call.',reconciliationEvidence:{requestId:run2.executionRequestId,logId:'isolated-failure-receipt',providerStatusCheckedAt:new Date().toISOString(),providerConclusion:'FAILED'}});assert.equal(failed.status,201,JSON.stringify(failed.body));
 const ready=await f.workspace();assert.deepEqual(ready.blockers,[]);assert.equal(ready.plannedVersionLabel,'V003');assert.equal(ready.parentVersionId,v1.versionId);assert.equal(ready.parentVersionSha256,v1.sha256);assert.equal(ready.basis.revision.failedAttempt.schemaVersion,'FAILED_OUTPUT_REMAKE_V1');
 const beforeStale=await f.repo.exportState(),stale=await f.materialPost({...f.saveBody(ready,'New safe fixture.'),expectedBasisHash:unknown.basisHash});assert.equal(stale.status,409,JSON.stringify(stale.body));assert.deepEqual(await f.repo.exportState(),beforeStale);
 // Actual bytes, not just source metadata, must still match the parent SHA.
 const parentPath=path.join(f.root,first.recipe.output.path),parentBytes=await readFile(parentPath);
 try{await writeFile(parentPath,'changed fixture bytes');const bad=await f.workspace();assert(bad.blockers.some(s=>s.includes('失败重制')));const state=await f.repo.exportState(),save=await f.materialPost(f.saveBody(bad,'No changed parent.'));assert.equal(save.status,409);assert.deepEqual(await f.repo.exportState(),state);}finally{await writeFile(parentPath,parentBytes);}
 const before=await f.repo.readView(),events=canonicalJson(before.eventsByKind),failedOutput=before.snapshot.productionModel.expectedOutputs.find(o=>o.id===second.result.expectedOutputId);
 const third=await f.provision(await f.workspace(),'A new safe, nonsexual inanimate sculpture definition fixture.',{expectedMode:'REVISION'});
 assert.equal(third.plan.expectedOutput.plannedVersionLabel,'V003');assert.notEqual(third.recipe.id,second.recipe.id);assert.notEqual(third.recipe.definitionHash,second.recipe.definitionHash);assert.equal(third.recipe.parentVersionId,v1.versionId);assert.equal(third.recipe.parentVersionSha256,v1.sha256);
 assert.equal(canonicalJson((await f.repo.readView()).eventsByKind),events,'publishing V003 does not retry V002 or invent a Run');
 const after=await f.repo.readView(),documents=await Promise.all(after.sourceRevisionIds.map(id=>f.repo.readDocumentRevision(id))),input={snapshot:after.snapshot,recipes:after.recipes,baseSnapshot:after.snapshot,baseRecipes:after.recipes,documents};
 assert.equal(canonicalJson(after.recipes.executionDefinitions.find(d=>d.id===second.recipe.id)),oldDefinition);assert.deepEqual(after.snapshot.productionModel.expectedOutputs.find(o=>o.id===failedOutput.id),failedOutput);assert.deepEqual(Buffer.from((await f.repo.readDocumentRevision(legacySource.revisionId)).bytes),legacyBytes);
 assert.deepEqual(preserveMaterialProductionProjection(input).recipes,after.recipes);
 assert.throws(()=>preserveMaterialProductionProjection({...input,documents:documents.filter(d=>d.revisionId!==legacySource.revisionId)}));
 assert.throws(()=>preserveMaterialProductionProjection({...input,documents:documents.map(d=>d.revisionId===legacySource.revisionId?{...d,bytes:canonicalJson({...JSON.parse(d.bytes),parentVersionSha256:'0'.repeat(64)})}:d)}));
 const run3=await f.beginRun(third),v3=await f.register(third,run3,pngs[1]);await f.evidence(third.result.familyId,v3);await f.review(third,v3,'APPROVE_AND_RELEASE');
 const state=(await f.store.operationalSnapshot()).stateProjection;assert.equal(state.assetFamiliesById[third.result.familyId].currentVersionId,v3.versionId);assert.equal(state.assetVersionsById[v3.versionId].canFlowDownstream,true);
 const final=await f.repo.readView();assert.equal(final.eventsByKind['asset-version'].filter(e=>e.familyId===third.result.familyId).length,2);assert.equal(final.eventsByKind['asset-version'].some(e=>e.expectedOutputId===second.result.expectedOutputId),false);assert.equal((await f.repo.listMedia()).filter(m=>m.mediaId===third.result.familyId).length,2);assert.equal(sha256(await readFile(parentPath)),v1.sha256);assert.equal(f.externalCalls(),0);
});
