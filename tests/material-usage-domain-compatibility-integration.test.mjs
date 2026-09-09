import test from 'node:test';
import assert from 'node:assert/strict';
import {api,fixture as productionFixture} from './domain-new-production-fixture.mjs';
import {makeCompatibilityFixture,sealCompatibility} from './fixtures/domain-production-compatibility.mjs';
import {domainHash as hash} from '../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {materialUsageFixture} from './material-usage-fixture.mjs';
import {getMaterialUsageWorkspace,listMaterialUsageSources} from '../host/instance-runtime/material-usage-service.mjs';

// Real store projection and usage service; neutral in-memory read adapter only.
// This checks eligibility wiring, not actual media observation or registration.
function fixture(options={}) {
  const f=productionFixture(), c=makeCompatibilityFixture(options), m=f.data.productionModel;
  f.data.instance.instanceId=c.options.instanceId;
  Object.assign(m,structuredClone(c.model));
  m.materialWorkItems=m.assetFamilies.map((family,i)=>({id:'work:'+family.id,label:family.id,outputAssetRef:family.id,reviewOwner:'MATERIAL',inputAssetRefs:i?['family:root']:[],requirementRef:m.materialRequirements[i].id,requirementHash:m.materialRequirements[i].requirementHash}));
  m.assetFamilies.forEach((family,i)=>Object.assign(family,{label:family.id,kind:'IMAGE',ownerRef:m.materialWorkItems[i].id,reviewOwner:'MATERIAL',versionRefs:[m.assetVersions[i].id],expectedOutputRefs:[],currentExpectedOutputId:null}));
  m.materialRequirements.forEach((r,i)=>Object.assign(r,{assetFamilyRefs:[m.assetFamilies[i].id],acceptanceCriteria:[],sourceKind:'DOMAIN_GRAPH'}));
  m.assetVersions.forEach(v=>Object.assign(v,{path:'media/'+v.id+'.png',label:v.id,outputState:'PRESENT',projectRightsGate:'CLEAR',historyRole:'CANDIDATE',lifecycleState:'REVIEW_PENDING',canFlowDownstream:false,materialRequirementBindings:[{requirementRef:m.materialRequirements.find(r=>r.assetFamilyRefs.includes(v.familyId)).id,requirementHash:m.materialRequirements.find(r=>r.assetFamilyRefs.includes(v.familyId)).requirementHash}]}));
  // The two approvals are made against the real BEFORE context, then frozen.
  const before=structuredClone(f.data);before.productionModel.domainGraph=structuredClone(c.beforeGraph);before.productionModel.domainInvalidations=[];
  before.productionModel.materialRequirements.forEach((r,i)=>{r.requirementHash=hash({demand:c.beforeGraph.requirements[i],representation:c.beforeGraph.representations[i]});});
  for(const [i,v]of m.assetVersions.entries()){
    const review=f.review({versionId:v.id,familyId:v.familyId,sha256:v.sha256},10+i);
    review.contextHash=api.assetReviewContextHash(before,v.familyId,v.id,v.sha256);
    const b=m.domainProductionCompatibilities[0].versionBindings.find(b=>b.versionId===v.id);
    if(b)Object.assign(b,{reviewEventId:review.eventId,reviewContextHash:review.contextHash,reviewEventHash:hash(review)});
    v.materialRequirementBindings[0].requirementHash=before.productionModel.materialRequirements[i].requirementHash;
  }
  sealCompatibility(m.domainProductionCompatibilities[0]);
  return Object.assign(f,{c,record:m.domainProductionCompatibilities[0],before});
}

function workspaceFixture() {
  const f=fixture(),model=f.data.productionModel,root=model.assetVersions[0],usage=materialUsageFixture();
  const definition={id:'definition:root',prompt:{main:'fixed'},output:{assetFamilyRef:root.familyId}};
  definition.definitionHash=executionDefinitionHash(definition);
  root.executionDefinitionRef=definition.id;
  Object.assign(f.record.versionBindings[0],{executionDefinitionId:definition.id,executionDefinitionHash:definition.definitionHash});
  sealCompatibility(f.record);
  for(const key of ['entities','states','representations','requirements']) model.domainGraph[key].push(...usage.graph[key]);
  model.materialRequirements.push(usage.model.materialRequirements[0]);
  const view={releaseId:'release:neutral-current',snapshot:f.data,recipes:{executionDefinitions:[definition]},eventsByKind:{review:f.reviews},sourceRevisionIds:[]};
  const media={mediaId:root.familyId,versionId:root.id,sha256:root.sha256,relativePath:root.path,byteSize:10,availability:'PRESENT',metadata:{authorityDomain:'FORMAL',visibility:'PUBLIC'}};
  const tx={readView:async()=>view,listEvents:async()=>f.reviews,listPublishedDocumentMetadata:async()=>[],getMetadata:async()=>({instanceId:f.data.instance.instanceId,runtimeEpoch:'epoch:neutral'}),getAux:async()=>null,listAux:async()=>[],getMedia:async()=>media,resolveMedia:async()=>media};
  const target={requirementId:usage.target.requirementId,familyId:root.familyId,versionId:root.id,sha256:root.sha256};
  return {...f,model,root,definition,view,media,tx,target};
}

test('usage source list and workspace preserve the exact authoritative domain-compatible native approval',async()=>{
  const f=workspaceFixture(),frozen=hash({view:f.view,media:f.media});
  // Missing authoritative recipes must still fail closed at the projection layer.
  assert.equal(api.projectOperationalState(f.data,f.reviews,[],[],[],[]).assetVersionsById[f.root.id].canFlowDownstream,false);
  assert.equal(api.projectOperationalState(f.data,f.reviews,[],[],[],[],{executionDefinitions:f.view.recipes.executionDefinitions}).assetVersionsById[f.root.id].canFlowDownstream,true);
  const list=await listMaterialUsageSources(f.tx,{requirementId:f.target.requirementId},{api});
  assert(list.eligibleSources.some(source=>source.familyId===f.root.familyId&&source.versionId===f.root.id&&source.sha256===f.root.sha256));
  const workspace=await getMaterialUsageWorkspace(f.tx,f.target,{api});
  assert.deepEqual(workspace.blockers,[]);
  assert.equal(workspace.sourceAdoption.eventId,f.reviews[0].eventId);
  assert.equal(workspace.sourceVersion.adoption.sha256,hash(f.reviews[0]));
  assert.equal(hash({view:f.view,media:f.media}),frozen);
});

for(const [name,change] of [
  ['missing authoritative definition',f=>f.view.recipes.executionDefinitions=[]],
  ['modified definition bytes',f=>f.definition.prompt.main='changed'],
  ['duplicate authoritative definition',f=>f.view.recipes.executionDefinitions.push(structuredClone(f.definition))],
  ['missing compatibility proof',f=>f.model.domainProductionCompatibilities=[]],
  ['changed adopted bytes',f=>f.root.sha256='f'.repeat(64)],
  ['blocked original rights',f=>f.root.projectRightsGate='BLOCKED'],
  ['unregistered original',f=>f.tx.getMedia=async()=>null],
]) test('usage does not bypass '+name,async()=>{
  const f=workspaceFixture();change(f);
  const list=await listMaterialUsageSources(f.tx,{requirementId:f.target.requirementId},{api});
  assert.equal(list.eligibleSources.some(source=>source.familyId===f.root.familyId),false);
  assert((await getMaterialUsageWorkspace(f.tx,f.target,{api})).blockers.length>0);
});
