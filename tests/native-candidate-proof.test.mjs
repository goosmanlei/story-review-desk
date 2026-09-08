import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {materialProductionFixture,imageRequirementId} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {defaultShotProductionPlan,compileShotProductionPlan,productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {compileShotRecipePreview} from '../host/instance-runtime/shot-production-recipes.mjs';
import {nativeMaterialCandidateProof,assertNativeCandidatePreservation} from '../host/instance-native-candidate-proof.mjs';
const hash=x=>sha256(canonicalJson(x));
const api={projectOperationalState({productionModel:m}){return{assetFamiliesById:Object.fromEntries(m.assetFamilies.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(m.assetVersions.map(v=>[v.id,v]))};}};
const content={model:'fixture-model',prompt:'Synthetic candidate protocol fixture.',negativePrompt:'',parameters:{width:1,height:1},inputBindings:[]};
function complete({snapshot,recipes,documents,definition,work,output}){
 const bytes=Buffer.from('fixed native fixture bytes'),familyId=output.familyId,versionId=familyId+'@'+output.plannedVersionLabel;
 const common={snapshotId:snapshot.snapshotId,executionRequestId:'request:fixture',executionDefinitionId:definition.id,executionDefinitionHash:definition.definitionHash,promptRevisionId:definition.currentRevisionId,callPackageHash:definition.definitionHash,inputBindingsHash:hash([])};
 const events=['AUTHORIZE','CLAIM','SUBMITTED','SUCCEEDED'].map((s,i)=>({...common,eventId:'evt:'+i,idempotencyKeyHash:hash('event:'+i),eventSequence:i+1,eventKind:i<2?'execution-request':'run',...(i<2?{action:s,authorized:true,maxOutputs:1,familyId,workItemId:work.id,inputBindings:[]}:{state:s,runId:'run:fixture'})}));
 const event={...common,eventKind:'asset-version',schemaVersion:'1.1',eventId:'evt:candidate',idempotencyKeyHash:hash('candidate'),eventSequence:5,familyId,versionId,expectedOutputId:output.id,path:output.targetPath,plannedVersionId:output.legacyVersionId||output.id,realizationRelation:'REALIZES',realizes:{relationType:'REALIZES',expectedOutputId:output.id,assetVersionId:versionId},sha256:sha256(bytes),byteSize:bytes.length,outputState:'PRESENT',historyRole:'CANDIDATE',lifecycleState:'REVIEW_PENDING',reviewDecision:'PENDING',registrationState:'CANDIDATE_REGISTERED_EXPECTED_OUTPUT_REALIZED',adoptionPerformed:false,inputBindings:[],runId:'run:fixture',parentVersionId:null,parentVersionSha256:null,parentBindingState:'EXPLICIT_ROOT',actualPrompt:definition.prompt,actualPromptHash:hash(definition.prompt),recipePromptHash:hash(definition.prompt),promptChangedFromCallPackage:false,promptSyncRequired:false};events.push(event);
 return{snapshot,recipes,event,input:{documents,events,activeMedia:[{mediaId:familyId,versionId,relativePath:'media/blobs/'+event.sha256+'.png',sha256:event.sha256,byteSize:bytes.length,availability:'PRESENT',metadata:{authorityDomain:'FORMAL',registrationEventId:event.eventId}}],pinnedMediaHashes:{[event.path]:event.sha256},compiler:{eventDirectory:'events'},baseRelease:{releaseId:'release:fixture',snapshotBytes:canonicalJson(snapshot),recipesBytes:canonicalJson(recipes)}}};
}
async function mpFixture(t){
 const f=await materialProductionFixture(t),repo=f.repo,w=await repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api}));
 const saved=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:null,content},{api}));
 const input={requirementId:imageRequirementId,draftRevisionId:saved.revisionId},preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,input,{api})),queued=await repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{...input,previewHash:preview.previewHash,requestId:'native-proof:fixture'},{api}));
 const r=await repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.jobId,api})),view=await repo.readView(),m=view.snapshot.productionModel;
 return complete({snapshot:view.snapshot,recipes:view.recipes,documents:await Promise.all(view.sourceRevisionIds.map(id=>repo.readDocumentRevision(id))),definition:view.recipes.executionDefinitions.find(d=>d.id===r.definitionId),work:m.materialWorkItems.find(w=>w.id===r.workItemId),output:m.expectedOutputs.find(o=>o.id===r.expectedOutputId)});
}
function spFixture(){
 const sceneId='scene:fixture',episodeUid='episode:fixture',spec={shotId:'shot:fixture',sceneId,order:1,title:'Fixture',narrativeBeat:'A fixed beat',audienceTakeaway:'A fixed outcome',materialRequirementRefs:[],inputBindings:[]},designContent={sceneId,identityChangeReason:'NO_IDENTITY_CHANGE',shots:[spec]},design={id:'design:fixture',scopeId:sceneId,episodeUid,content:designContent,contentHash:productionHash(designContent)};
 const scope={sceneId,episodeUid,plan:design,shots:[{...spec,id:spec.shotId}]},settings=defaultShotProductionPlan(scope),documents=[];
 const document=(sourcePath,revisionId,body,sourceRole)=>{const bytes=canonicalJson(body),d={revisionId,aliases:[sourcePath],bytes,sha256:sha256(bytes),metadata:{sourceRole}};documents.push(d);return d;};
 const plan={id:'plan:fixture',sceneId,episodeUid,content:settings,contentHash:productionHash(settings),sourcePath:'story/shot-production/fixture.json',sourceRevisionId:'source:plan',scopeRole:'EVIDENCE_ONLY'};
 const doc=document(plan.sourcePath,plan.sourceRevisionId,{schemaVersion:'1.0',productionPlanId:plan.id,content:settings,contentHash:plan.contentHash,shotPlanRevisionId:design.id},'SHOT_PRODUCTION_PLAN');plan.sourceSha256=doc.sha256;
 const compiled=compileShotProductionPlan(scope,settings,{id:plan.id,revisionId:doc.revisionId,sourceRef:plan.sourcePath});plan.workItemIds=compiled.workItems.map(w=>w.id);
 const model={shotPlanSetRevisions:[design],shots:[{...spec,id:spec.shotId}],shotProductionPlans:[plan],assetVersions:[],...compiled},work=model.workItems.find(w=>w.deliverableKey==='STORYBOARD'),family=model.assetFamilies.find(f=>f.id===work.outputAssetRef),output=model.expectedOutputs.find(o=>o.id===family.currentExpectedOutputId);
 const definition=compileShotRecipePreview({work,family,output,model,state:{assetFamiliesById:{},assetVersionsById:{}},inputs:[],basis:{workItemId:work.id},basisHash:hash(work.id),view:{releaseId:'release:fixture'}},{model:content.model,prompt:content.prompt,negativePrompt:'',parameters:content.parameters},{draftRevisionId:'draft:fixture'}).definition;
 const sourcePath='story/shot-production/recipes/'+definition.id+'.json',source=document(sourcePath,'source:recipe',definition,'SHOT_EXECUTION_DEFINITION'),binding={sourceRef:sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256};
 model.shotProductionRecipeRevisions=[{id:definition.id,workItemId:work.id,sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,definitionHash:definition.definitionHash}];work.executionDefinitionRef=definition.id;work.promptRef=definition.currentRevisionId;
 const stored={...definition,...binding},snapshot={snapshotId:'snapshot:fixture',productionModel:model},recipes={snapshotId:snapshot.snapshotId,executionDefinitions:[stored],promptRevisions:[{id:definition.currentRevisionId,executionDefinitionId:definition.id,definitionHash:definition.definitionHash,prompt:definition.prompt,...binding}]};return complete({snapshot,recipes,documents,definition:stored,work,output});
}

for(const [kind,fixture]of [['MP',mpFixture],['SP',spFixture]])test(`pure ${kind} candidate proof preserves native identity, exact source and untouched events`,async t=>{
 const f=await fixture(t),before=hash(f.input),proof=nativeMaterialCandidateProof(f.input),row=proof.records[0];assert.equal(row.productionKind,kind);assert.equal(row.eventId,f.event.eventId);assert.equal(row.eventSha256,hash(f.event));assert.equal(row.eventProof.length,5);assert.ok(row.sourceProof.length);assert.equal(hash(f.input),before);
 assert.equal(assertNativeCandidatePreservation({proof,snapshot:f.snapshot,recipes:f.recipes,events:f.input.events}).baseCandidateVersionsCreated,0);
 for(const mutate of [x=>x.snapshot.productionModel.expectedOutputs.find(o=>o.id===row.expectedOutputId).targetPath='media/wrong.png',x=>x.snapshot.productionModel.assetVersions.push({id:row.versionId}),x=>x.recipes.executionDefinitions.find(d=>d.id===row.definitionId).prompt.main+='tampered',x=>x.events.pop()]){const x=structuredClone({snapshot:f.snapshot,recipes:f.recipes,events:f.input.events});mutate(x);assert.throws(()=>assertNativeCandidatePreservation({proof,...x}),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});}
});
for(const [name,mutate]of Object.entries({
 'missing plan source':f=>f.input.documents.splice(f.input.documents.findIndex(d=>d.metadata?.sourceRole==='MATERIAL_PRODUCTION_PLAN'),1),
 'changed source bytes':f=>{const d=f.input.documents.find(d=>d.metadata?.sourceRole==='MATERIAL_PRODUCTION_PLAN');d.bytes=Buffer.from('{}');},
 'unrecognized native family':f=>f.event.familyId='MP-AF-UNKNOWN',
 'legacy expected-output alias substitution':f=>f.event.expectedOutputId='EXPECTED_OUTPUT:'+f.event.versionId,
 'changed definition hash':f=>f.event.executionDefinitionHash='0'.repeat(64),
 'unknown run':f=>f.input.events[3].state='RESULT_UNKNOWN',
 'missing claim':f=>f.input.events.splice(1,1),
 'mismatched request input':f=>f.input.events[0].inputBindings=[{}],
 'mismatched run binding':f=>f.input.events[2].executionRequestId='request:other',
 'reordered event sequence':f=>f.input.events[0].eventSequence=99,
 'missing actual byte pin':f=>delete f.input.pinnedMediaHashes[f.event.path],
 'PRIVATE media':f=>f.input.activeMedia[0].metadata.authorityDomain='PRIVATE',
 'PRIVATE visibility':f=>f.input.activeMedia[0].metadata.visibility='PRIVATE',
 'original media':f=>f.input.activeMedia[0].metadata.sourceRole='ORIGINAL_SOURCE',
 'wrong registration proof':f=>f.input.activeMedia[0].metadata.registrationEventId='evt:other',
 'missing active media':f=>f.input.activeMedia=[],
 'parent substitution':f=>f.event.parentVersionId='version:other',
 'input substitution':f=>{f.event.inputBindings=[{}];f.event.inputBindingsHash=hash(f.event.inputBindings);},
 'actual prompt audit substitution':f=>f.event.actualPromptHash='0'.repeat(64),
 'duplicate event identity':f=>f.input.events[1].eventId=f.input.events[0].eventId,
}))test('native proof rejects '+name,async t=>{const f=await mpFixture(t);mutate(f);assert.throws(()=>nativeMaterialCandidateProof(f.input),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});});
test('ordinary legacy event is not selected and native unknown cannot fall back to legacy',async t=>{const f=await mpFixture(t);f.input.events=[{eventKind:'asset-version',familyId:'legacy-family',path:'production/generated/legacy.png'}];assert.equal(nativeMaterialCandidateProof(f.input),null);f.input.events[0].path='media/_review_pending/material-production/unregistered/V001.png';assert.throws(()=>nativeMaterialCandidateProof(f.input),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});});
test('a minimal legacy compiler fixture gets no new native requirements',()=>{assert.equal(nativeMaterialCandidateProof({events:[]}),null);assert.equal(nativeMaterialCandidateProof({events:[{eventKind:'asset-version',familyId:'legacy'}]}),null);});
test('unrelated publications preserve each event snapshot while the frozen call and inputs remain exact',()=>{const f=spFixture();for(const e of f.input.events)e.snapshotId='snapshot:stage-'+e.eventSequence;const proof=nativeMaterialCandidateProof(f.input);assert.equal(proof.records[0].eventProof.length,5);assert.equal(assertNativeCandidatePreservation({proof,snapshot:f.snapshot,recipes:f.recipes,events:f.input.events}).eventsPreserved,true);});

test('a preexisting published native version is retained by exact hash alongside its original candidate event',async t=>{
 const f=await mpFixture(t),version={id:f.event.versionId,familyId:f.event.familyId,path:f.event.path,sha256:f.event.sha256,lifecycleState:'RELEASED',canFlowDownstream:true};
 f.snapshot.productionModel.assetVersions.push(version);f.input.baseRelease.snapshotBytes=canonicalJson(f.snapshot);
 const proof=nativeMaterialCandidateProof(f.input);assert.equal(proof.records[0].baseVersionHash,hash(version));assert.equal(assertNativeCandidatePreservation({proof,snapshot:f.snapshot,recipes:f.recipes,events:f.input.events}).baseCandidateVersionsCreated,0);
 for(const mutate of [s=>s.productionModel.assetVersions.find(v=>v.id===version.id).lifecycleState='REVIEW_PENDING',s=>s.productionModel.assetVersions=s.productionModel.assetVersions.filter(v=>v.id!==version.id),s=>s.productionModel.assetVersions.push({...version})]){const snapshot=structuredClone(f.snapshot);mutate(snapshot);assert.throws(()=>assertNativeCandidatePreservation({proof,snapshot,recipes:f.recipes,events:f.input.events}),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});}
 for(const field of ['familyId','path','sha256']){const input=structuredClone(f.input),snapshot=JSON.parse(input.baseRelease.snapshotBytes);snapshot.productionModel.assetVersions.find(v=>v.id===version.id)[field]='different';input.baseRelease.snapshotBytes=canonicalJson(snapshot);assert.throws(()=>nativeMaterialCandidateProof(input),{code:'SOURCE_NATIVE_CANDIDATE_BINDING'});}
});
