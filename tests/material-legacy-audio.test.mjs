import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {legacyAudioFixture,audioRequirementId,legacyFamily,legacyWork,content,wav,localMediaVerifier} from './material-legacy-audio-fixture.mjs';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
let seq=0;
async function event(repo,kind,payload){const key='legacy-test-'+(++seq);return (await repo.writeTransaction(tx=>tx.appendEvent({kind,idempotencyKey:key,requestHash:sha256(key),eventSchemaVersion:'2.2',payload}))).event;}
async function fixture(t,metadata={authorityDomain:'FORMAL'},blob=false){
 const f=await legacyAudioFixture(t),view=await f.repo.readView(),def=view.recipes.executionDefinitions.find(d=>d.workItemRef===legacyWork),versionId=legacyFamily+'@V001',bytes=wav(),physical=blob?'media/blobs/'+sha256(bytes)+'.wav':'media/_review_pending/'+legacyFamily+'/FIXTURE_VOICE_MASTER_V001.wav';
 await mkdir(path.dirname(path.join(f.root,physical)),{recursive:true});await writeFile(path.join(f.root,physical),bytes,{flag:'wx'});
 await f.repo.writeTransaction(tx=>tx.registerMedia({mediaId:legacyFamily,versionId,relativePath:physical,sha256:sha256(bytes),byteSize:bytes.length,availability:'PRESENT',metadata,aliases:[def.output.path]}));
 const run={runId:'run_fixture',executionRequestId:'xreq_fixture',executionDefinitionId:def.id,callPackageHash:def.definitionHash};
 await event(f.repo,'execution-request',{...run,workItemId:legacyWork,familyId:legacyFamily,requestState:'CLAIMED',maxOutputs:1,inputBindings:[]});await event(f.repo,'run',{...run,state:'SUCCEEDED'});
 await event(f.repo,'asset-version',{...run,familyId:legacyFamily,versionId,sha256:sha256(bytes),path:def.output.path,expectedOutputId:def.output.expectedOutputRef,parentVersionId:null,inputBindings:[]});
 await event(f.repo,'review',{subjectType:'ASSET',familyId:legacyFamily,versionId,versionSha256:sha256(bytes),action:'REQUEST_REVISION',applicationStatus:'APPLIED',effect:'APPLIED'});
 const api={projectOperationalState(snapshot,reviews,candidates){return {assetFamiliesById:Object.fromEntries(snapshot.productionModel.assetFamilies.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(candidates.map(c=>[c.versionId,{...c,id:c.versionId}]))};},safeGeneratedPath:localMediaVerifier(f)};
 const workspace=()=>f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:audioRequirementId,api}));
 const save=async(w,prompt='Revised clear voice.')=>f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:audioRequirementId,expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:w.draftHeadRevisionId,content:content(prompt)},{api}));
 return {...f,api,workspace,save,run,versionId,physical};
}
test('legacy actual parent SHA is reread; file tampering blocks authoring before any AUX write',async t=>{
 const f=await fixture(t),w=await f.workspace();assert.equal(w.mode,'LEGACY_AUDIO_REVISION');assert.deepEqual(w.blockers,[]);await writeFile(path.join(f.root,f.physical),wav(2));const before=await f.repo.exportState();await assert.rejects(()=>f.save(w),/Actual media SHA/);assert.deepEqual(await f.repo.exportState(),before);
});
for(const metadata of [{authorityDomain:'PRIVATE'},{authorityDomain:'LOCAL_TRIAL'},{authorityDomain:'UNKNOWN'},{authorityDomain:'FORMAL',visibility:'PRIVATE'},{authorityDomain:'FORMAL',visibility:'UNKNOWN'},{authorityDomain:'FORMAL',sourceRole:'ORIGINAL_SOURCE'}])test('legacy parent rejects nonpublic or nonformal registration '+JSON.stringify(metadata),async t=>{
 const f=await fixture(t,metadata),w=await f.workspace();assert.ok(w.blockers.some(b=>b.includes('登记媒体')));const before=await f.repo.exportState();await assert.rejects(()=>f.save(w),{code:'DOMAIN_CONFLICT'});assert.deepEqual(await f.repo.exportState(),before);
});
test('legacy queued revision freezes actual Review head and atomically refuses a later judgement',async t=>{
 const f=await fixture(t),w=await f.workspace(),saved=await f.save(w),preview=await f.repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:audioRequirementId,draftRevisionId:saved.revisionId},{api:f.api}));
 const job=await f.repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:audioRequirementId,draftRevisionId:saved.revisionId,previewHash:preview.previewHash,requestId:'legacy-queue'},{api:f.api}));
 await event(f.repo,'review',{subjectType:'ASSET',familyId:legacyFamily,versionId:f.versionId,versionSha256:sha256(wav()),action:'DO_NOT_USE',applicationStatus:'APPLIED',effect:'APPLIED'});const before=await f.repo.exportState();await assert.rejects(()=>f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api:f.api})),{code:'DOMAIN_CONFLICT'});assert.deepEqual(await f.repo.exportState(),before);
});
test('legacy preservation cannot use a changed unpublished source head as the same recipe',async t=>{
 const f=await fixture(t),w=await f.workspace();await f.repo.writeTransaction(async tx=>{const d=await tx.readDocument('fixture:direct-voice');await tx.putDocument({documentId:d.documentId,expectedRevisionId:d.revisionId,bytes:Buffer.from(d.bytes).toString()+'changed',aliases:d.aliases,metadata:d.metadata});});const before=await f.repo.exportState();await assert.rejects(()=>f.save(w),/当前发布修订/);assert.deepEqual(await f.repo.exportState(),before);
});
for(const runState of ['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN','SUCCEEDED'])test('legacy orphan '+runState+' Run prevents a second production request',async t=>{
 const f=await fixture(t);await event(f.repo,'run',{...f.run,runId:'run_unreconciled',state:runState});const w=await f.workspace();assert.ok(w.blockers.some(b=>b.includes('run_unreconciled')));await assert.rejects(()=>f.save(w),{code:'DOMAIN_CONFLICT'});
});
test('legacy draft requires complete unchanged delivery before a preview can be published',async t=>{
 const f=await fixture(t),w=await f.workspace(),bad=content('New voice.');delete bad.parameters.delivery;
 const saved=await f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:audioRequirementId,expectedReleaseId:w.releaseId,expectedBasisHash:w.basisHash,expectedDraftRevisionId:null,content:bad},{api:f.api}));const before=await f.repo.exportState();await assert.rejects(()=>f.repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:audioRequirementId,draftRevisionId:saved.revisionId},{api:f.api})),/delivery/);assert.deepEqual(await f.repo.exportState(),before);
});

test('legacy imported blob parent resolves through the exact logical EO alias and actual SHA',async t=>{const f=await fixture(t,{authorityDomain:'IMPORTED_EVIDENCE'},true),w=await f.workspace();assert.deepEqual(w.blockers,[]);assert.match(w.basis.revision.parentMedia.relativePath,/^media\/blobs\//);const saved=await f.save(w);assert.ok(saved.revisionId);});
test('legacy source maintenance lease blocks authoring without creating a competing publication',async t=>{const f=await fixture(t);await f.repo.writeTransaction(tx=>tx.putAux({namespace:'source-operation-host',key:'lease',expectedRevisionId:null,bytes:'{"owner":"fixture-worker"}'}));const w=await f.workspace();assert.ok(w.blockers.some(b=>b.includes('租约')));await assert.rejects(()=>f.save(w),{code:'DOMAIN_CONFLICT'});});
