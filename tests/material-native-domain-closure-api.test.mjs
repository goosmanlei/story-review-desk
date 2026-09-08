import test from 'node:test';
import assert from 'node:assert/strict';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain,imageRequirementId,audioRequirementId,audioRepresentationId} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';

const options={skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000};
async function omitHistoricLinks(f,ids){
 // Isolated synthetic release recreates the already-published defect. This is
 // never a production migration or an overwrite of the frozen first source.
 await f.repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot);for(const r of snapshot.productionModel.materialRequirements)if(ids.includes(r.id)){delete r.materialWorkItemRef;delete r.plannedAssetFamilyId;}await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});
}
async function unrelatedDomainPublish(f,id){
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id,beforeHash:null,value:{id,type:'PROP',name:'Unrelated isolated fixture',aliases:[],description:'No production relation to existing voices or image.',authority:'A',evidence:[]}}]);
}
const get=(f,requirementId)=>f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId,api:f.adapter}));

test('native image can revise after unrelated domain publication and recover omitted links without rewriting V001 or pretending FAILED V002 is a parent',options,async t=>{
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'Fixed PNG fixture; no provider.'),v1=await f.register(first,await f.beginRun(first),pngs[0]);await f.review(first,v1,'REQUEST_REVISION');
 const original=await f.repo.readView(),plan=original.snapshot.productionModel.materialProductionPlans[0],source=await f.repo.readDocumentRevision(plan.sourceRevisionId);
 await unrelatedDomainPublish(f,'prop:unrelated-native-image');
 const projected=await f.repo.readView(),r=projected.snapshot.productionModel.materialRequirements.find(x=>x.id===imageRequirementId);assert.equal(r.materialWorkItemRef,first.result.workItemId);assert.equal(r.plannedAssetFamilyId,first.result.familyId);assert.deepEqual((await f.workspace()).blockers,[]);
 await omitHistoricLinks(f,[imageRequirementId]);const missing=await f.repo.exportState(),w=await f.workspace();assert.equal(w.requirement.materialWorkItemRef,first.result.workItemId);assert.equal(w.requirement.plannedAssetFamilyId,first.result.familyId);assert.deepEqual(w.blockers,[]);assert.deepEqual(await f.repo.exportState(),missing,'GET never persists the recovered links');
 const second=await f.provision(w,'Second fixed attempt; source authoring only.',{expectedMode:'REVISION'}),run2=await f.beginRun(second),failed=await f.post(f.runs,'v8/runs',{...run2,state:'FAILED',note:'Synthetic explicit failure with no output; no provider called.'});assert.equal(failed.status,201,JSON.stringify(failed.body));
 await omitHistoricLinks(f,[imageRequirementId]);const again=await f.repo.exportState(),remake=await f.workspace();assert.equal(remake.plannedVersionLabel,'V003');assert.equal(remake.parentVersionId,v1.versionId);assert.equal(remake.parentVersionSha256,v1.sha256);assert.deepEqual(remake.blockers,[]);assert.deepEqual(await f.repo.exportState(),again);
 const third=await f.provision(remake,'Fresh third attempt based on actual V001; no provider.',{expectedMode:'REVISION'});assert.equal(third.recipe.parentVersionId,v1.versionId);
 const final=await f.repo.readView();assert.deepEqual(final.eventsByKind['asset-version'],original.eventsByKind['asset-version']);assert.deepEqual(final.eventsByKind.review,original.eventsByKind.review);assert.equal(await f.repo.getMedia(first.result.familyId,first.result.familyId+'@V002'),null);assert.deepEqual(await f.repo.readDocumentRevision(plan.sourceRevisionId),source);assert.deepEqual(final.recipes.executionDefinitions.find(d=>d.id===first.recipe.id),first.recipe);assert.ok(final.eventsByKind.run.some(e=>e.eventId===failed.body.event.eventId));
 // A real authored change in the requirement/representation remains a conflict.
 const rep=final.snapshot.productionModel.domainGraph.representations.find(x=>x.id===plan.representationId);await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'An explicitly changed material specification'}}]);
 const changed=await f.repo.exportState();await assert.rejects(get(f,imageRequirementId),{code:'DOMAIN_CONFLICT'});assert.deepEqual(await f.repo.exportState(),changed);assert.equal(f.externalCalls(),0);
});

test('four independent native VOICE_IDENTITY definitions keep exact authorization eligibility after domain publication and omitted-link recovery',options,async t=>{
 const f=await apiFixture(t),view=await f.repo.readView(),templateRep=view.snapshot.productionModel.domainGraph.representations.find(x=>x.id===audioRepresentationId),templateDemand=view.snapshot.productionModel.domainGraph.requirements.find(x=>x.id===audioRequirementId);
 const ids=[audioRequirementId,...['anonymous','concealed','creditor'].map(name=>'demand:voice-fixture-'+name)],entities=ids.slice(1).map((id,i)=>({id:'character:voice-fixture-'+i,type:'CHARACTER',name:'Independent synthetic voice '+i,aliases:[],description:'Original fictional voice identity for protocol testing, without real-person cloning.',authority:'A',evidence:[]}));
 await changeDomain(f.repo,'SETTINGS',entities.map(value=>({collection:'entities',id:value.id,beforeHash:null,value})));
 const changes=entities.flatMap((entity,i)=>{const requirementId=ids[i+1],rep={...templateRep,id:'representation:voice-fixture-'+i,entityId:entity.id,requirementIds:[requirementId]},demand={...templateDemand,id:requirementId,representationId:rep.id};return[['representations',rep],['requirements',demand]].map(([collection,value])=>({collection,id:value.id,beforeHash:null,value}));});await changeDomain(f.repo,'MATERIAL',changes);
 const provisions=[];
 for(const requirementId of ids){
  const w=await get(f,requirementId),content={model:'seed-audio-1.0',prompt:'Independent original voice identity fixture. Calm, clearly articulated baseline. No scene dialogue timing is claimed.',negativePrompt:'No real-person voice cloning, music or environmental effects.',parameters:{audio_config:{sample_rate:48000,format:'wav'},delivery:{sample_rate:48000,bit_depth:24,channels:1,max_peak_dbfs:-3.0},watermark:{}},inputBindings:[]};
  const saved=await f.materialPost({requirementId,action:'save',expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,content});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const preview=await f.materialPost({requirementId,action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));const queued=await f.materialPost({requirementId,action:'publish',draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash});assert.equal(queued.status,200,JSON.stringify(queued.body));
  const result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter})),v=await f.repo.readView();provisions.push({requirementId,result,recipe:v.recipes.executionDefinitions.find(d=>d.id===result.definitionId),source:await f.repo.readDocumentRevision(result.sourceRevisionId)});
 }
 const before=await f.repo.readView();await unrelatedDomainPublish(f,'prop:unrelated-voices');
 const afterDomain=await f.repo.readView();for(const p of provisions){const r=afterDomain.snapshot.productionModel.materialRequirements.find(x=>x.id===p.requirementId);assert.equal(r.materialWorkItemRef,p.result.workItemId);assert.equal(r.plannedAssetFamilyId,p.result.familyId);}
 await omitHistoricLinks(f,ids);const missing=await f.repo.exportState();
 for(const p of provisions){const w=await get(f,p.requirementId);assert.equal(w.currentDefinitionId,p.recipe.id);assert.equal(w.requirement.materialWorkItemRef,p.result.workItemId);assert.ok(w.blockers.some(x=>/唯一实际候选/.test(x)),'new revision is blocked until first real output');}
 assert.deepEqual(await f.repo.exportState(),missing,'workspace recovery has zero writes');
 for(const p of provisions){
  const op=await f.store.operationalSnapshot();assert.equal(op.stateProjection.materialWorkItemsById[p.result.workItemId].lifecycleState,'READY_TO_START');
  const authorized=await f.post(f.requests,'v8/execution-requests',{action:'AUTHORIZE',workItemId:p.result.workItemId,familyId:p.result.familyId,executionDefinitionId:p.recipe.id,callPackageHash:p.recipe.definitionHash,executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:[]});assert.equal(authorized.status,201,JSON.stringify(authorized.body));assert.equal(authorized.body.event.callPackageHash,p.recipe.definitionHash);
 }
 const final=await f.repo.readView();assert.deepEqual(final.recipes,before.recipes);assert.equal(final.eventsByKind['execution-request'].length,4);for(const kind of ['run','asset-version','review'])assert.equal(final.eventsByKind[kind]?.length||0,0);assert.equal((await f.repo.listMedia()).length,0);for(const p of provisions){const plan=final.snapshot.productionModel.materialProductionPlans.find(x=>x.requirementId===p.requirementId);assert.deepEqual(await f.repo.readDocumentRevision(plan.sourceRevisionId),p.source);}assert.equal(f.externalCalls(),0);
});
