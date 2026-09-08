import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {exerciseLegacyAudioDelegation} from './fixtures/legacy-audio-candidate-delegation.mjs';
import path from 'node:path';
import {apiFixture} from './fixtures/legacy-audio-candidate-api.mjs';
import {legacyFamily,legacyWork,wav} from './material-legacy-audio-fixture.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {legacyAudioCandidateProof,assertLegacyAudioCandidatePreservation} from '../host/instance-legacy-audio-candidate-proof.mjs';
import {nativeMaterialCandidateProof} from '../host/instance-native-candidate-proof.mjs';
import {preserveLegacyAudioProjection} from '../host/instance-runtime/material-legacy-audio-preservation.mjs';
async function capture(f){return f.repo.readTransaction(async tx=>{const v=await tx.readView(),baseRelease=await tx.readRelease(),activeMedia=await tx.listMedia(),pinnedMediaHashes={};for(const m of activeMedia){const bytes=await readFile(path.join(f.root,m.relativePath));assert.equal(sha256(bytes),m.sha256);assert.equal(bytes.length,m.byteSize);for(const alias of [m.relativePath,...m.aliases||[],m.metadata?.sourcePath,m.metadata?.legacyVersion?.path].filter(Boolean))pinnedMediaHashes[alias]=m.sha256;}return{documents:await Promise.all(v.sourceRevisionIds.map(id=>tx.readDocumentRevision(id))),events:Object.values(v.eventsByKind).flat(),activeMedia,pinnedMediaHashes,baseRelease,compiler:{eventDirectory:'events'}};});}

test('legacy proof does not select ordinary/native events or invent an unregistered legacy revision',()=>{
 assert.equal(legacyAudioCandidateProof({events:[]}),null);
 assert.equal(legacyAudioCandidateProof({events:[{eventKind:'asset-version',familyId:'MP-AF-f',executionDefinitionId:'MP-CALL-f'}]}),null);
 assert.throws(()=>legacyAudioCandidateProof({events:[{eventKind:'asset-version',executionDefinitionId:'LA-CALL-unknown'}]}),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});
});

test('isolated PostgreSQL API registers actual WAV V001 → formal revision → LA V002/V003 and proves untouched histories',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const f=await apiFixture(t),initial=await f.repo.readView(),definition=initial.recipes.executionDefinitions.find(d=>d.workItemRef===legacyWork),first={result:{familyId:legacyFamily,workItemId:legacyWork},recipe:definition};
 const v1=await f.register(first,await f.beginRun(first),wav(0),{parentVersionId:null});await f.review(first,v1,'REQUEST_REVISION');
 const second=await f.provision(await f.workspace(),'A second synthetic local WAV protocol fixture.'),run2=await f.beginRun(second);
 assert.equal((await f.post(f.runs,'v8/runs',{...run2,state:'RUNNING',note:'Fixed fixture in progress; no provider.'})).status,201);
 const v2=await f.register(second,run2,wav(1)),input=await capture(f),before=await f.repo.exportState(),proof=legacyAudioCandidateProof(input);
 assert.equal(proof.schemaVersion,'LEGACY_AUDIO_CANDIDATE_PROOF_V1');assert.equal(proof.records.length,1);assert.equal(proof.records[0].versionId,v2.versionId);assert.equal(proof.records[0].parentVersionId,v1.versionId);assert.equal(proof.records[0].parentVersionSha256,v1.sha256);assert.equal(proof.records[0].mediaProof.length,2);assert.equal(proof.records[0].sourceProof.length,3);assert.equal(proof.records[0].eventProof.length,14);assert.equal(proof.records[0].baseVersionHash,null);
 assert.equal(nativeMaterialCandidateProof(input),null,'LA is not misclassified as native MP');
 const delegated=await exerciseLegacyAudioDelegation(input,proof,{mediaRoot:f.root});assert.deepEqual(delegated.legacyAudioCandidateDelegation.eventIds,[proof.records[0].eventId]);assert.equal(delegated.nativeCandidateDelegation,undefined);assert.equal(delegated.baseCandidateVersionsCreated,0);
 for(const kind of ['event','parent'])await assert.rejects(()=>exerciseLegacyAudioDelegation(input,proof,{mediaRoot:f.root,mutate:({root})=>writeFile(path.join(root,kind==='event'?proof.records[0].eventPath:proof.records[0].mediaProof[1].path),'changed')}),/frozen event bytes differ|legacy audio parent\/output bytes differ|candidate bytes differ/);
 const snapshot=JSON.parse(input.baseRelease.snapshotBytes),recipes=JSON.parse(input.baseRelease.recipesBytes),restored=preserveLegacyAudioProjection({snapshot:initial.snapshot,recipes:initial.recipes,baseSnapshot:snapshot,baseRecipes:recipes,documents:input.documents});
 assert.equal(assertLegacyAudioCandidatePreservation({proof,...restored,events:input.events}).baseCandidateVersionsCreated,0);
 assert.deepEqual(await f.repo.exportState(),before,'read-only proof must not append or rewrite authority');
 const candidate=x=>x.events.find(e=>e.eventKind==='asset-version'&&e.versionId===v2.versionId),parent=x=>x.events.find(e=>e.eventKind==='asset-version'&&e.versionId===v1.versionId);
 const mutations={
  'unknown LA EO':x=>candidate(x).expectedOutputId='LA-EO-unproved',
  'native EO alias':x=>candidate(x).expectedOutputId='MP-EO-alias',
  'changed candidate parent SHA':x=>candidate(x).parentVersionSha256='0'.repeat(64),
  'changed parent original event':x=>parent(x).sha256='0'.repeat(64),
  'missing original parent event':x=>x.events=x.events.filter(e=>e!==parent(x)),
  'changed parent successful Run':x=>x.events.find(e=>e.eventKind==='run'&&e.runId===parent(x).runId&&e.state==='SUCCEEDED').state='FAILED',
  'unknown candidate Run':x=>x.events.find(e=>e.eventKind==='run'&&e.runId===run2.runId&&e.state==='SUCCEEDED').state='RESULT_UNKNOWN',
  'claim input divergence':x=>x.events.find(e=>e.eventKind==='execution-request'&&e.executionRequestId===run2.executionRequestId&&e.action==='CLAIM').inputBindings=[{}],
  'changed request definition':x=>x.events.find(e=>e.eventKind==='execution-request'&&e.executionRequestId===run2.executionRequestId).executionDefinitionHash='0'.repeat(64),
  'missing actual parent bytes pin':x=>delete x.pinnedMediaHashes[parent(x).path],
  'wrong actual output byte pin':x=>x.pinnedMediaHashes[candidate(x).path]='0'.repeat(64),
  'output registration event differs':x=>x.activeMedia.find(m=>m.versionId===v2.versionId).metadata.registrationEventId='different',
  'parent registration missing':x=>x.activeMedia=x.activeMedia.filter(m=>m.versionId!==v1.versionId),
  'same bytes wrong logical alias':x=>{const m=x.activeMedia.find(m=>m.versionId===v2.versionId);m.aliases=[];delete m.metadata.sourcePath;delete m.metadata.legacyVersion;},
  'PRIVATE output':x=>x.activeMedia.find(m=>m.versionId===v2.versionId).metadata.authorityDomain='PRIVATE',
  'ORIGINAL parent':x=>x.activeMedia.find(m=>m.versionId===v1.versionId).metadata.sourceRole='ORIGINAL_SOURCE',
  'PRIVATE visibility':x=>x.activeMedia.find(m=>m.versionId===v2.versionId).metadata.visibility='PRIVATE',
  'unknown authority':x=>x.activeMedia.find(m=>m.versionId===v2.versionId).metadata.authorityDomain='UNKNOWN',
  'changed frozen review':x=>x.events.find(e=>e.eventKind==='review'&&e.versionId===v1.versionId).action='APPROVE_AND_RELEASE',
  'missing frozen revision source':x=>x.documents=x.documents.filter(d=>d.metadata.sourceRole!=='LEGACY_MATERIAL_RECIPE_REVISION'),
  'modified frozen source bytes':x=>{x.documents.find(d=>d.metadata.sourceRole==='LEGACY_MATERIAL_RECIPE_REVISION').bytes=Buffer.from('{}');},
  'wrong frozen source authority':x=>{x.documents.find(d=>d.metadata.sourceRole==='LEGACY_MATERIAL_RECIPE_REVISION').metadata.sourceRole='MATERIAL_PRODUCTION_RECIPE';},
  'duplicate candidate identity':x=>x.events.push({...candidate(x),eventId:'duplicate'}),
 };
 for(const[name,mutate]of Object.entries(mutations)){const x=structuredClone(input);mutate(x);assert.throws(()=>legacyAudioCandidateProof(x),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'},name);}
 for(const[key,id]of[['assetFamilies',legacyFamily],['materialWorkItems',legacyWork],['expectedOutputs',second.recipe.output.expectedOutputRef],['legacyMaterialRecipeRevisions',proof.records[0].revisionId]]){const changed=structuredClone(snapshot);changed.productionModel[key].find(r=>r.id===id).unexpected='drift';assert.throws(()=>assertLegacyAudioCandidatePreservation({proof,snapshot:changed,recipes,events:input.events}),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});}
 const existing=structuredClone(input),existingSnapshot=JSON.parse(Buffer.from(existing.baseRelease.snapshotBytes).toString());const publishedVersion={id:v2.versionId,familyId:legacyFamily,path:second.recipe.output.path,sha256:v2.sha256,lifecycleState:'RELEASED'};existingSnapshot.productionModel.assetVersions.push(publishedVersion);existing.baseRelease.snapshotBytes=canonicalJson(existingSnapshot);const existingProof=legacyAudioCandidateProof(existing);assert.equal(existingProof.records[0].baseVersionHash,sha256(canonicalJson(publishedVersion)));assert.equal(assertLegacyAudioCandidatePreservation({proof:existingProof,snapshot:existingSnapshot,recipes,events:existing.events}).baseCandidateVersionsCreated,0);existingSnapshot.productionModel.assetVersions.find(v=>v.id===v2.versionId).lifecycleState='CHANGED';assert.throws(()=>assertLegacyAudioCandidatePreservation({proof:existingProof,snapshot:existingSnapshot,recipes,events:existing.events}),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});
 const changedParent=structuredClone(recipes);changedParent.executionDefinitions.find(d=>d.id===definition.id).unexpected=true;assert.throws(()=>assertLegacyAudioCandidatePreservation({proof,snapshot,recipes:changedParent,events:input.events}),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});
 const leaked=structuredClone(snapshot);leaked.productionModel.assetVersions.push({id:v2.versionId});assert.throws(()=>assertLegacyAudioCandidatePreservation({proof,snapshot:leaked,recipes,events:input.events}),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});
 await f.review(second,v2,'REQUEST_REVISION');const third=await f.provision(await f.workspace(),'A third synthetic local WAV protocol fixture.'),run3=await f.beginRun(third);
 assert.equal((await f.post(f.runs,'v8/runs',{...run3,state:'RESULT_UNKNOWN',note:'Synthetic unknown; no provider or retry.'})).status,201);
 const v3=await f.register(third,run3,wav(2),{unknown:true}),chainInput=await capture(f),chainProof=legacyAudioCandidateProof(chainInput);assert.deepEqual(chainProof.records.map(r=>r.versionId),[v2.versionId,v3.versionId]);assert.equal(chainProof.records[1].parentVersionId,v2.versionId);
 const bad=structuredClone(chainInput);delete bad.events.find(e=>e.eventKind==='run'&&e.runId===run3.runId&&e.state==='SUCCEEDED').reconciliationEvidence;assert.throws(()=>legacyAudioCandidateProof(bad),{code:'SOURCE_LEGACY_AUDIO_CANDIDATE_BINDING'});
 assert.equal(f.externalCalls(),0);
});
