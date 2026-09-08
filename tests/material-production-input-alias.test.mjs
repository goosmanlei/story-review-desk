import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {RETIREMENT_NAMESPACES} from '../host/instance-runtime/media-retirement.mjs';
import {materialProductionFixture,imageRequirementId} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';

// Only release projection is supplied by this focused fixture. Registrations,
// logical alias resolution, retirement, CAS and publications use the repository.
const api={projectOperationalState({productionModel:m}){return{assetFamiliesById:Object.fromEntries(m.assetFamilies.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(m.assetVersions.map(v=>[v.id,v]))};}};
const logical='production/generated/01_style/fixture-master.png';
const author=binding=>({model:'fixture:image',prompt:'Reference binding protocol fixture; no generation.',negativePrompt:'',parameters:{width:1,height:1},inputBindings:[binding]});
async function fixture(t,{metadata={authorityDomain:'FORMAL'},alias='exact',retired=false,bindingOverride={}}={}){
 const f=await materialProductionFixture(t),bytes=Buffer.from('fixed reference bytes, not generated'),hash=sha256(bytes),physical='media/blobs/'+hash+'.png',binding={familyId:'legacy-family',versionId:'legacy-reference@V002',sha256:hash};
 await mkdir(path.dirname(path.join(f.root,physical)),{recursive:true});await writeFile(path.join(f.root,physical),bytes,{flag:'wx'});
 await f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),m=snapshot.productionModel;
  const graph=structuredClone(m.domainGraph),graphHead=await tx.getAux('domain-graph','current');
  graph.representations.push({...graph.representations.find(r=>r.type==='IDENTITY'),id:'representation:legacy-master',assetFamilyIds:[binding.familyId],requirementIds:['legacy-demand']});
  const graphRecord=await tx.putAux({namespace:'domain-graph',key:'current',expectedRevisionId:graphHead.revisionId,bytes:canonicalJson(graph),mediaType:'application/json'});
  m.domainGraph=graph;m.domainGraphRef={revisionId:graphRecord.revisionId,sha256:domainHash(graph)};snapshot.creativeLineage={...snapshot.creativeLineage,domainGraphRef:m.domainGraphRef};
  Object.assign(m.assetFamilies.find(f=>f.id===binding.familyId),{currentVersionId:binding.versionId,versionRefs:[binding.versionId],canFlowDownstream:true});
  m.assetVersions.push({id:binding.versionId,familyId:binding.familyId,path:logical,sha256:hash,byteSize:bytes.length,outputState:'PRESENT',lifecycleState:'RELEASED',canFlowDownstream:true});
  await tx.registerMedia({mediaId:binding.familyId,versionId:binding.versionId,relativePath:physical,sha256:hash,byteSize:bytes.length,aliases:alias==='exact'?[logical]:[],metadata});
  // The same logical alias may retain historical versions. Exact bindings must
  // select V002; byte equality never substitutes another family or version.
  await tx.registerMedia({mediaId:alias==='cross-family'?'other-family':binding.familyId,versionId:alias==='cross-family'?binding.versionId:'legacy-reference@V001',relativePath:physical,sha256:hash,byteSize:bytes.length,aliases:alias==='missing'?[]:[logical],metadata:{authorityDomain:'FORMAL'}});
  if(retired)await tx.putAux({namespace:RETIREMENT_NAMESPACES.tombstones,key:sha256(physical)+':020:fixture',expectedRevisionId:null,mediaType:'application/json',bytes:canonicalJson({phase:'QUARANTINED',sequence:1,originalRelativePath:physical,sha256:hash,registrations:[{mediaId:binding.familyId,versionId:binding.versionId,sha256:hash}]})});
  await tx.publishRelease({snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
 });
 return {...f,binding:{...binding,...bindingOverride},bytes,physical};
}
const workspace=f=>f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api}));
const save=(f,w)=>f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,content:author(f.binding)},{api}));

for(const authorityDomain of ['FORMAL','IMPORTED_EVIDENCE'])test(`${authorityDomain} exact blob alias stays selectable and publishes the logical reference unchanged`,async t=>{
 const f=await fixture(t,{metadata:{authorityDomain}}),w=await workspace(f);assert.deepEqual(w.availableInputs.map(({familyId,versionId,sha256})=>({familyId,versionId,sha256})),[f.binding]);
 const before=await f.repo.readView(),mediaBefore=await f.repo.listMedia(),saved=await save(f,w),input={requirementId:imageRequirementId,draftRevisionId:saved.revisionId};
 const preview=await f.repo.readTransaction(tx=>previewMaterialProduction(tx,input,{api}));
 const queued=await f.repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{...input,previewHash:preview.previewHash,requestId:'alias-fixture:queue'},{api}));
 const result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.jobId,api}));assert.equal(result.modelCalls,0);
 const after=await f.repo.readView(),definition=after.recipes.executionDefinitions.find(d=>d.id===result.definitionId);
 assert.deepEqual(definition.upload.items,[{order:1,path:logical,assetFamilyRef:f.binding.familyId,assetVersionRef:f.binding.versionId,sha256:f.binding.sha256}]);
 assert.deepEqual(after.snapshot.productionModel.assetVersions,before.snapshot.productionModel.assetVersions);assert.deepEqual(await f.repo.listMedia(),mediaBefore);assert.deepEqual(after.eventsByKind,before.eventsByKind);
 assert.equal(sha256(await readFile(path.join(f.root,f.physical))),f.binding.sha256);
});

for(const [name,options] of [
 ['missing logical alias',{alias:'missing'}],['alias belongs to another version',{alias:'wrong-version'}],['alias belongs to another family with identical version and SHA',{alias:'cross-family'}],
 ['submitted version differs',{bindingOverride:{versionId:'legacy-reference@V001'}}],['submitted SHA differs',{bindingOverride:{sha256:'0'.repeat(64)}}],['submitted family differs',{bindingOverride:{familyId:'other-family'}}],
 ['PRIVATE authority',{metadata:{authorityDomain:'PRIVATE'}}],['LOCAL_TRIAL authority',{metadata:{authorityDomain:'LOCAL_TRIAL'}}],['unknown authority',{metadata:{authorityDomain:'UNKNOWN'}}],
 ['PRIVATE visibility',{metadata:{authorityDomain:'FORMAL',visibility:'PRIVATE'}}],['unknown visibility',{metadata:{authorityDomain:'FORMAL',visibility:'UNKNOWN'}}],['original source',{metadata:{authorityDomain:'FORMAL',sourceRole:'ORIGINAL_SOURCE'}}],['retired exact media',{retired:true}],
])test(`reference alias rejects ${name} without writing a draft or plan`,async t=>{
 const f=await fixture(t,options),before=await f.repo.exportState(),w=await workspace(f);
 if(!options.bindingOverride)assert.deepEqual(w.availableInputs,[]);
 await assert.rejects(save(f,w));assert.deepEqual(await f.repo.exportState(),before);
});

test('queued reference is revalidated against retirement before publishing',async t=>{
 const f=await fixture(t),w=await workspace(f),saved=await save(f,w),input={requirementId:imageRequirementId,draftRevisionId:saved.revisionId};
 const preview=await f.repo.readTransaction(tx=>previewMaterialProduction(tx,input,{api}));
 const queued=await f.repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{...input,previewHash:preview.previewHash,requestId:'alias-fixture:retire'},{api}));
 await f.repo.writeTransaction(tx=>tx.putAux({namespace:RETIREMENT_NAMESPACES.tombstones,key:sha256(f.physical)+':020:fixture',expectedRevisionId:null,mediaType:'application/json',bytes:canonicalJson({phase:'QUARANTINED',sequence:1,originalRelativePath:f.physical,sha256:f.binding.sha256,registrations:[{mediaId:f.binding.familyId,versionId:f.binding.versionId,sha256:f.binding.sha256}]})}));
 const before=await f.repo.exportState();await assert.rejects(f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.jobId,api})));assert.deepEqual(await f.repo.exportState(),before);
});
