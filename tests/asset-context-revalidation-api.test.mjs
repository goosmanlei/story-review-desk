import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {legacyContextApiFixture,queueAssetContextFixture,readAssetContextFixtureProof} from './fixtures/asset-context-revalidation.mjs';
import {changeDomain,imageRequirementId} from './material-production-fixture.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {runAssetContextRevalidationIteration,ASSET_CONTEXT_NS} from '../host/instance-runtime/asset-context-revalidation-service.mjs';
import {validateAssetContextLedger} from '../host/instance-runtime/asset-context-revalidation-model.mjs';

test('real legacy published adoption remains INITIAL-locked while dedicated current-domain revalidation restores only exact source context',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await legacyContextApiFixture(t),w=await f.workspace();assert.equal(w.status,200,JSON.stringify(w.body));assert.deepEqual(w.body.blockers,[]);
 const data=await f.store.reviewData(),spec=w.body.reviewSpec,base=await f.repo.exportState();
 const initial=await f.basePost(f.reviews,'v8/reviews',{schemaVersion:'2.2',subjectType:'ASSET',subjectId:f.target.familyId,familyId:f.target.familyId,versionId:f.target.versionId,versionSha256:f.target.sha256,contextHash:f.store.assetReviewContextHash(data,f.target.familyId,f.target.versionId,f.target.sha256),reviewSpecHash:spec.hash,action:'APPROVE_AND_RELEASE',criterionFindings:f.observation(w.body).criterionFindings,revisionInstructions:null,note:'A legacy imported adoption must never be converted to an invented initial Review.'});
 assert.equal(initial.status,409,JSON.stringify(initial.body));assert.equal(initial.body.reasonCode,'REVIEW_INITIAL_DECISION_LOCKED');assert.deepEqual(await f.repo.exportState(),base);
 const old=await f.repo.readView(),media=await f.repo.listMedia(),bytes=await readFile(path.join(f.root,f.physical)),q=await queueAssetContextFixture(f),result=await runAssetContextRevalidationIteration({repository:f.repo,api:f.api});
 assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(result.contextRevalidationPerformed,true);assert.equal(result.formalAdoptionPerformed,false);
 const view=await f.repo.readView(),op=await f.store.operationalSnapshot();assert.equal(op.stateProjection.assetVersionsById[f.target.versionId].canFlowDownstream,true,JSON.stringify(op.stateProjection.assetVersionsById[f.target.versionId]));assert.equal(op.stateProjection.materialRequirementsById[imageRequirementId].coverageSatisfied,true,JSON.stringify(op.stateProjection.materialRequirementsById[imageRequirementId]));
 assert.deepEqual(view.eventsByKind.review||[],old.eventsByKind.review||[]);assert.deepEqual(view.eventsByKind['asset-version']||[],old.eventsByKind['asset-version']||[]);assert.deepEqual(view.eventsByKind.run||[],old.eventsByKind.run||[]);assert.deepEqual(view.snapshot.productionModel.assetVersions,old.snapshot.productionModel.assetVersions);assert.deepEqual(view.snapshot.productionModel.assetFamilies,old.snapshot.productionModel.assetFamilies);assert.deepEqual(view.recipes.executionDefinitions,old.recipes.executionDefinitions);assert.deepEqual(view.snapshot.productionModel.domainInvalidations,old.snapshot.productionModel.domainInvalidations);assert.deepEqual(await f.repo.listMedia(),media);assert.deepEqual(await readFile(path.join(f.root,f.physical)),bytes);
 const events=view.eventsByKind['asset-context-revalidation'];assert.equal(events.length,1);assert.equal(events[0].subjectType,'ASSET_CONTEXT');assert.equal(events[0].action,'CONFIRM_CURRENT_DOMAIN');assert.equal(events[0].originalAdoptionChanged,false);
 const source=await f.repo.readDocumentRevision(result.sourceRevisionId);assert.equal(sha256(source.bytes),result.sourceSha256);const body=JSON.parse(source.bytes);assert.deepEqual(body.basis.legacyAdoptionProof,q.preview.revalidation.basis.legacyAdoptionProof);assert.equal(body.basis.legacyAdoptionProof.releaseId,old.releaseId);
 const done=await f.workspace();assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.head.eventId,result.eventId);assert.equal(done.body.jobs.find(j=>j.jobId===q.queued.jobId)?.requestId,'context-fixture:publish');assert(done.body.blockers.length);
 assert.deepEqual(await runAssetContextRevalidationIteration({repository:f.repo,api:f.api}),{processed:false});
 const proof=await readAssetContextFixtureProof(f);assert.equal(validateAssetContextLedger(proof).length,1);
 assert.throws(()=>validateAssetContextLedger({...proof,releaseContext:()=>null}));
 assert.throws(()=>validateAssetContextLedger({...proof,events:proof.events.filter(e=>e.eventKind!=='asset-context-revalidation')}));
 assert.throws(()=>validateAssetContextLedger({...proof,documents:proof.documents.filter(d=>d.revisionId!==result.sourceRevisionId)}));
 // Imported historical-child counterfactual remains purely in memory; no child
 // was manufactured or approved in the repository to weaken the API guard.
 const projected=await f.store.reviewData(),counter=structuredClone(projected),parent=counter.productionModel.assetVersions.find(v=>v.id===f.target.versionId),child={...parent,id:'LEGACY-CHILD@V001',familyId:'LEGACY-CHILD',path:'media/legacy/child.png',parentVersionId:parent.id,inputVersionBindings:[{familyId:parent.familyId,versionId:parent.id,sha256:parent.sha256,path:parent.path}],sha256:sha256('counterfactual child')};
 counter.productionModel.assetFamilies.push({...counter.productionModel.assetFamilies.find(a=>a.id===f.target.familyId),id:child.familyId,currentVersionId:child.id,versionRefs:[child.id]});counter.productionModel.assetVersions.push(child);
 const state=f.store.projectOperationalState(counter,view.eventsByKind.review||[],view.eventsByKind['asset-version']||[],view.eventsByKind.run||[],view.eventsByKind['source-operation']||[],view.eventsByKind['execution-request']||[]);
 assert.equal(state.assetVersionsById[parent.id].canFlowDownstream,true);assert.equal(state.assetVersionsById[child.id].canFlowDownstream,false);
 const entity=view.snapshot.productionModel.domainGraph.entities.find(e=>e.id==='character:letter-writer');
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:domainHash(entity),value:{...entity,description:'A later, distinct domain condition must invalidate this exact revalidation.'}}]);
 const later=await f.store.operationalSnapshot();assert.equal(later.stateProjection.assetVersionsById[parent.id].canFlowDownstream,false);assert.deepEqual((await f.repo.readView()).eventsByKind['asset-context-revalidation'],events);assert.equal(f.externalCalls(),0);
});

test('current-domain revalidation API rejects wrong identity, observations, CAS, Origin, readonly and UNKNOWN replay without formal changes',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await legacyContextApiFixture(t),w=(await f.workspace()).body,before=await f.repo.exportState();
 for(const extra of [{versionId:'LEGACY-IMAGE-CONTEXT@V002'},{sha256:'0'.repeat(64)}]){const r=await f.workspace(extra);assert.equal(r.status,409,JSON.stringify(r.body));assert.deepEqual(await f.repo.exportState(),before);}
 const base=f.saveBody(w);
 for(const content of [{...base.content,observedSha256:'0'.repeat(64)},{...base.content,purpose:'NORMAL_ADOPTION'},{...base.content,criterionFindings:base.content.criterionFindings.slice(1)},{...base.content,criterionFindings:base.content.criterionFindings.map((c,i)=>({...c,verdict:i===0?'FAIL':'PASS'}))}]){const r=await f.post({...base,content});assert.equal(r.status,409,JSON.stringify(r.body));assert.deepEqual(await f.repo.exportState(),before);}
 for(const patch of [{expectedBasisHash:'0'.repeat(64)},{expectedDraftRevisionId:'irv-stale'}]){const r=await f.post({...base,...patch});assert.equal(r.status,409,JSON.stringify(r.body));assert.deepEqual(await f.repo.exportState(),before);}
 const origin=await f.post(base,{headers:{Origin:'https://outside.invalid'}});assert.equal(origin.status,403);assert.deepEqual(await f.repo.exportState(),before);
 for(const flag of ['REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY']){const old=process.env[flag];process.env[flag]='1';try{const r=await f.post(base);assert.equal(r.status,405,JSON.stringify(r.body));}finally{if(old===undefined)delete process.env[flag];else process.env[flag]=old;}assert.deepEqual(await f.repo.exportState(),before);}
 const queued=await queueAssetContextFixture(f,{key:'context-fixture:unknown'});
 await f.repo.writeTransaction(async tx=>{const record=await tx.getAux(ASSET_CONTEXT_NS.jobs,queued.queued.jobId),job=JSON.parse(record.bytes);await tx.putAux({namespace:ASSET_CONTEXT_NS.jobs,key:job.jobId,bytes:canonicalJson({...job,status:'RESULT_UNKNOWN'}),mediaType:'application/json',expectedRevisionId:record.revisionId});});
 const unknownState=await f.repo.exportState(),unknown=await f.workspace();assert.equal(unknown.body.jobs[0].requestId,'context-fixture:unknown');assert.equal(unknown.body.jobs[0].status,'RESULT_UNKNOWN');
 const save=await f.post(f.saveBody(unknown.body));assert.equal(save.status,409);assert.deepEqual(await f.repo.exportState(),unknownState);assert.deepEqual(await runAssetContextRevalidationIteration({repository:f.repo,api:f.api}),{processed:false});assert.deepEqual(await f.repo.exportState(),unknownState);assert.equal(f.externalCalls(),0);
});

for(const fault of ['actual-file','epoch'])test('revalidation worker rechecks '+fault+' and creates no formal source or event on failure',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await legacyContextApiFixture(t),q=await queueAssetContextFixture(f),before=await f.repo.readView(),file=path.join(f.root,f.physical),bytes=await readFile(file);
 if(fault==='actual-file')await writeFile(file,'different fixture bytes');
 else await f.repo.writeTransaction(async tx=>{const record=await tx.getAux(ASSET_CONTEXT_NS.jobs,q.queued.jobId),job=JSON.parse(record.bytes);await tx.putAux({namespace:ASSET_CONTEXT_NS.jobs,key:job.jobId,bytes:canonicalJson({...job,runtimeEpoch:'another-test-epoch'}),mediaType:'application/json',expectedRevisionId:record.revisionId});});
 try{const result=await runAssetContextRevalidationIteration({repository:f.repo,api:f.api});assert.equal(result.status,'FAILED',JSON.stringify(result));const after=await f.repo.readView();assert.equal(after.releaseId,before.releaseId);assert.deepEqual(after.sourceRevisionIds,before.sourceRevisionIds);assert.deepEqual(after.eventsByKind,before.eventsByKind);assert.deepEqual(after.recipes,before.recipes);assert.deepEqual(after.snapshot,before.snapshot);}finally{await writeFile(file,bytes);}
 assert.equal(f.externalCalls(),0);
});

test('imported unresolved consumer evidence cannot be bypassed by a new context confirmation',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await legacyContextApiFixture(t);
 await f.repo.writeTransaction(tx=>tx.appendEvent({kind:'execution-request',idempotencyKey:'context-fixture:historical-active-consumer',requestHash:sha256('historical-active-consumer'),eventSchemaVersion:'2.0',payload:{executionRequestId:'xreq-imported-consumer',snapshotId:f.changed.snapshot.snapshotId,workItemId:'unresolved-historical-consumer',familyId:'consumer-family',executionDefinitionId:'unresolved-consumer-definition',callPackageHash:sha256('unknown old consumer definition'),requestState:'CLAIMED',action:'CLAIM',maxOutputs:1,executor:'CODEX',inputBindings:[{order:1,path:'media/legacy/context-image.png',assetFamilyRef:f.target.familyId,assetVersionRef:f.target.versionId,sha256:f.target.sha256}],inputBindingsHash:sha256('unresolved imported binding')}}));
 const before=await f.repo.exportState(),w=await f.workspace();assert.equal(w.status,200,JSON.stringify(w.body));assert(w.body.blockers.length,JSON.stringify(w.body));
 const save=await f.post(f.saveBody(w.body));assert.equal(save.status,409,JSON.stringify(save.body));assert.deepEqual(await f.repo.exportState(),before);assert.equal((await f.repo.readView()).eventsByKind['asset-context-revalidation']?.length||0,0);assert.equal(f.externalCalls(),0);
});

for(const fault of ['rights','current-version'])test('independent '+fault+' facts remain authoritative over context revalidation',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await legacyContextApiFixture(t),q=await queueAssetContextFixture(f);
 await f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),recipes=structuredClone(view.recipes),family=snapshot.productionModel.assetFamilies.find(v=>v.id===f.target.familyId),version=snapshot.productionModel.assetVersions.find(v=>v.id===f.target.versionId);
  if(fault==='rights'){version.projectRightsGate='BLOCKED';family.projectRightsGate='BLOCKED';}
  else family.currentVersionId=null;
  snapshot.snapshotId='snapshot_'+domainHash({previous:snapshot.snapshotId,testCurrentFact:fault}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
  await tx.publishRelease({snapshot,recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
 });
 const before=await f.repo.readView(),workspace=await f.workspace();
 if(fault==='rights'){assert.equal(workspace.status,200,JSON.stringify(workspace.body));assert(workspace.body.blockers.some(s=>s.includes('权利')));const op=await f.store.operationalSnapshot();assert.equal(op.stateProjection.assetVersionsById[f.target.versionId].canFlowDownstream,false);assert.equal(op.stateProjection.assetVersionsById[f.target.versionId].projectRightsGate,'BLOCKED');}
 else assert.equal(workspace.status,409,JSON.stringify(workspace.body));
 const result=await runAssetContextRevalidationIteration({repository:f.repo,api:f.api});assert.equal(result.status,'FAILED');assert.equal(result.jobId,q.queued.jobId);
 const after=await f.repo.readView();assert.equal(after.releaseId,before.releaseId);assert.deepEqual(after.snapshot,before.snapshot);assert.deepEqual(after.sourceRevisionIds,before.sourceRevisionIds);assert.deepEqual(after.eventsByKind,before.eventsByKind);assert.equal(f.externalCalls(),0);
});
