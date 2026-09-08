import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {inspectExecutionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {materialProductionFixture,legacyObjects,changeDomain,imageRequirementId,audioRequirementId,imageRepresentationId} from './material-production-fixture.mjs';
import {MATERIAL_PRODUCTION_NS,getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob,runMaterialProductionIteration} from '../host/instance-runtime/material-production-service.mjs';

// This projection adapter supplies no review approvals for new material. Tests
// that deliberately mark a reference usable still require real media registry
// checks to reject private/trial/original bytes independently of that flag.
const api={projectOperationalState(snapshot){const model=snapshot.productionModel;return{assetFamiliesById:Object.fromEntries(model.assetFamilies.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(model.assetVersions.map(v=>[v.id,v]))};},projectEpisodeNarrativeReleases(){return{};},projectedReviewIndexes(){return{bySubject:[]};},projectedStructureReviewIndexes(){return{bySubject:[]};},projectedScopeLocks(){return{};}};
const author=(kind='IMAGE')=>({model:'test-'+kind.toLowerCase()+'-model',prompt:kind==='IMAGE'?'生成本次明确人物身份的干净母版。':'青年女性的独立声音身份，语速平缓。',negativePrompt:'不要加入不明来源的身份或声音。',parameters:kind==='IMAGE'?{width:1024,height:1024}:{sampleRate:48000},inputBindings:[]});
async function stage(repo,requirementId=imageRequirementId,content=author()){
 const workspace=await repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId,api})),saved=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId,expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId,content},{api})),preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId,draftRevisionId:saved.revisionId},{api}));return{workspace,saved,preview};
}
const queue=(repo,staged,requirementId=imageRequirementId,requestId='material-service:queue')=>repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId,draftRevisionId:staged.saved.revisionId,previewHash:staged.preview.previewHash,requestId},{api}));
async function assertNoProduction(repo){const view=await repo.readView();assert.equal(view.snapshot.productionModel.assetVersions.length,0);assert.equal((await repo.listMedia()).length,0);for(const kind of ['review','asset-version','run','execution-request'])assert.equal(view.eventsByKind[kind]?.length||0,0,kind);}

for(const [requirementId,kind] of [[imageRequirementId,'IMAGE'],[audioRequirementId,'AUDIO']])test(`native ${kind} demand first provisions exact family/output/work/recipe in one host publication`,async t=>{
 const {repo}=await materialProductionFixture(t),before=await repo.readView(),old=legacyObjects(before),originalRequirement=before.snapshot.productionModel.materialRequirements.find(r=>r.id===requirementId);assert.deepEqual(originalRequirement.assetFamilyRefs,[]);
 let externalCalls=0;const fetch=t.mock.method(globalThis,'fetch',async()=>{externalCalls++;throw Error('No model call is authorized');});
 const staged=await stage(repo,requirementId,author(kind));assert.equal(staged.preview.modelCalls,0);assert.equal((await repo.readView()).releaseId,before.releaseId);const job=await queue(repo,staged,requirementId);assert.deepEqual(await queue(repo,staged,requirementId),job);assert.equal((await repo.readView()).releaseId,before.releaseId);
 const result=await repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));assert.deepEqual(await repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api})),result);
 const after=await repo.readView(),model=after.snapshot.productionModel;assert.notEqual(after.releaseId,before.releaseId);assert.equal(after.snapshot.snapshotId,after.recipes.snapshotId);assert.deepEqual(legacyObjects(after),old);
 const requirement=model.materialRequirements.find(r=>r.id===requirementId);assert.equal(requirement.assetFamilyRefs.length,1);const family=model.assetFamilies.find(f=>f.id===requirement.assetFamilyRefs[0]),representation=model.domainGraph.representations.find(r=>r.id===requirement.representationRef),demand=model.domainGraph.requirements.find(r=>r.id===requirementId);
 assert.deepEqual(representation.assetFamilyIds,[family.id]);assert.equal(requirement.requirementHash,domainHash({demand,representation}));assert.equal(model.domainGraphRef.sha256,domainHash(model.domainGraph));assert.equal(family.kind,kind);assert.deepEqual(family.versionRefs,[]);assert.equal(family.currentVersionId,null);
 const output=model.expectedOutputs.find(o=>o.id===family.currentExpectedOutputId),work=model.materialWorkItems.find(w=>w.outputAssetRef===family.id),definition=after.recipes.executionDefinitions.find(d=>d.id===work.executionDefinitionRef);
 assert.ok(output);assert.equal(output.familyId,family.id);assert.equal(output.expectationState,'PLANNED');assert.equal(output.realizedVersionId,null);assert.equal(work.scopeRole,'CURRENT');assert.ok(work.reviewSpec?.hash);assert.ok(work.configurationBinding);assert.equal(definition.output.assetFamilyRef,family.id);assert.equal(definition.output.expectedOutputRef,output.id);assert.equal(definition.output.path,output.targetPath);assert.equal(definition.workItemRef,work.id);assert.deepEqual(definition.upload.items,[]);assert.equal(inspectExecutionDefinitionHash(definition).valid,true);
 assert.equal(model.materialProductionPlans.length,1);assert.equal(after.recipes.executionDefinitions.length,before.recipes.executionDefinitions.length+1);
 const plan=model.materialProductionPlans[0],source=await repo.readDocumentRevision(plan.sourceRevisionId),frozen=JSON.parse(source.bytes),reviewContext=model.reviewContexts.find(c=>c.id===work.reviewContextRef);
 assert.equal(source.metadata.sourceRole,'MATERIAL_PRODUCTION_PLAN');assert.equal(source.sha256,plan.sourceSha256);assert.equal(sha256(source.bytes),plan.sourceSha256);assert.ok(after.sourceRevisionIds.includes(source.revisionId));assert.deepEqual(frozen.requirementBefore,originalRequirement);assert.deepEqual(frozen.requirementAfter,requirement);assert.equal(frozen.basis.requirementHash,originalRequirement.requirementHash);assert.equal(domainHash(frozen.basis),plan.basisHash);
 assert.equal(work.requirementRef,requirementId);assert.equal(work.requirementHash,requirement.requirementHash);assert.equal(definition.materialRequirementRef,requirementId);assert.equal(definition.materialRequirementHash,requirement.requirementHash);assert.equal(reviewContext.binding.requirementHash,requirement.requirementHash);assert.equal(reviewContext.binding.domainContextHash,family.domainContext.hash);assert.equal(frozen.reviewSpecRef,originalRequirement.reviewSpec.hash);assert.deepEqual(requirement.reviewSpec,originalRequirement.reviewSpec);
 const graphHead=await repo.getAux('domain-graph','current');assert.equal(plan.graphRevisionId,graphHead.revisionId);assert.equal(graphHead.sha256,model.domainGraphRef.sha256);assert.equal(graphHead.sha256,domainHash(JSON.parse(graphHead.bytes)));
 assert.equal(externalCalls,0);fetch.mock.restore();await assertNoProduction(repo);
 await assert.rejects(stage(repo,requirementId,author(kind)),/已有|首次|素材族|建档/);
});

test('draft CAS, exact preview and queue idempotency fail without rewriting prior state',async t=>{
 const {repo}=await materialProductionFixture(t),staged=await stage(repo),before=await repo.exportState();
 await assert.rejects(repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:staged.workspace.releaseId,expectedDraftRevisionId:null,content:author()},{api})));
 await assert.rejects(repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:staged.saved.revisionId,previewHash:'0'.repeat(64),requestId:'material-service:bad-preview'},{api})));assert.deepEqual(await repo.exportState(),before);
 const queued=await queue(repo,staged);assert.deepEqual(await queue(repo,staged),queued);await assert.rejects(queue(repo,staged,imageRequirementId,'material-service:duplicate'));
 await assert.rejects(repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:audioRequirementId,draftRevisionId:staged.saved.revisionId,previewHash:staged.preview.previewHash,requestId:'material-service:queue'},{api})));assert.equal((await repo.listAux(MATERIAL_PRODUCTION_NS.jobs)).length,1);await assertNoProduction(repo);
});

test('host transaction rolls back source, graph, family and completion receipt together on publication failure',async t=>{
 const {repo}=await materialProductionFixture(t),staged=await stage(repo),job=await queue(repo,staged),before=await repo.exportState();
 await assert.rejects(repo.writeTransaction(tx=>{tx.publishRelease=async()=>{throw Error('injected first-family publication conflict');};return applyMaterialProductionJob(tx,{jobId:job.jobId,api});}),/injected/);assert.deepEqual(await repo.exportState(),before);
 assert.ok((await repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}))).releaseId);await assertNoProduction(repo);
});

test('changed representation invalidates queued first-family work and the worker does not retry',async t=>{
 const {repo}=await materialProductionFixture(t),staged=await stage(repo);await queue(repo,staged);const previous=(await repo.readView()).snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId);await changeDomain(repo,'MATERIAL',[{collection:'representations',id:previous.id,beforeHash:domainHash(previous),value:{...previous,label:'已修改的表现规格'}}]);
 const before=await repo.readView(),run=await runMaterialProductionIteration({repository:repo,api});assert.equal(run.status,'FAILED');assert.equal((await repo.readView()).releaseId,before.releaseId);assert.equal((await repo.readView()).snapshot.productionModel.assetFamilies.length,before.snapshot.productionModel.assetFamilies.length);assert.deepEqual(await runMaterialProductionIteration({repository:repo,api}),{processed:false});await assertNoProduction(repo);
});

test('unknown job result requires reconciliation and cannot create or dispatch another first-family task',async t=>{
 const {repo}=await materialProductionFixture(t),staged=await stage(repo),job=await queue(repo,staged);await repo.writeTransaction(async tx=>{const row=await tx.getAux(MATERIAL_PRODUCTION_NS.jobs,job.jobId),value=JSON.parse(row.bytes);await tx.putAux({namespace:MATERIAL_PRODUCTION_NS.jobs,key:job.jobId,expectedRevisionId:row.revisionId,bytes:canonicalJson({...value,status:'RESULT_UNKNOWN'}),mediaType:'application/json'});});
 const before=await repo.exportState();assert.deepEqual(await runMaterialProductionIteration({repository:repo,api}),{processed:false});await assert.rejects(repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api})));await assert.rejects(queue(repo,staged,imageRequirementId,'material-service:unknown-retry'));assert.deepEqual(await repo.exportState(),before);await assertNoProduction(repo);
});

test('first-family worker refuses read-only instances without dispatch or publication',async t=>{
 const {repo}=await materialProductionFixture(t),staged=await stage(repo);await queue(repo,staged);const before=await repo.exportState();await assert.rejects(runMaterialProductionIteration({repository:{readOnly:true},api}),/只读/);assert.deepEqual(await repo.exportState(),before);
});

for(const metadata of [{authorityDomain:'PRIVATE'},{authorityDomain:'LOCAL_TRIAL'},{authorityDomain:'UNKNOWN'},{authorityDomain:'FORMAL',visibility:'UNKNOWN'},{authorityDomain:'FORMAL',sourceRole:'ORIGINAL_SOURCE'},{authorityDomain:'FORMAL',visibility:'PRIVATE'}])test(`registered ${JSON.stringify(metadata)} reference is excluded despite usable projection flags`,async t=>{
 const {repo,root}=await materialProductionFixture(t),bytes=Buffer.from('fixture-only-media-bytes'),relativePath='media/reference.png',binding={familyId:'legacy-family',versionId:'legacy-reference',sha256:sha256(bytes)};await mkdir(path.join(root,'media'));await writeFile(path.join(root,relativePath),bytes);
 await repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot),model=snapshot.productionModel;Object.assign(model.assetFamilies.find(f=>f.id===binding.familyId),{currentVersionId:binding.versionId,versionRefs:[binding.versionId],canFlowDownstream:true});model.assetVersions.push({id:binding.versionId,familyId:binding.familyId,path:relativePath,sha256:binding.sha256,byteSize:bytes.length,outputState:'PRESENT',lifecycleState:'RELEASED',canFlowDownstream:true});await tx.registerMedia({mediaId:binding.familyId,versionId:binding.versionId,relativePath,sha256:binding.sha256,byteSize:bytes.length,aliases:[],metadata});await tx.publishRelease({snapshot,recipes:view.recipes,sourceRevisionIds:view.sourceRevisionIds,expectedReleaseId:view.releaseId});});
 const before=await repo.readView(),workspace=await repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api}));assert.equal(workspace.availableInputs.some(v=>v.versionId===binding.versionId),false);
 await assert.rejects(stage(repo,imageRequirementId,{...author(),inputBindings:[binding]}));const after=await repo.readView();assert.equal(after.releaseId,before.releaseId);assert.equal(after.snapshot.productionModel.assetFamilies.length,before.snapshot.productionModel.assetFamilies.length);assert.equal((await repo.listAux(MATERIAL_PRODUCTION_NS.jobs)).length,0);
});
