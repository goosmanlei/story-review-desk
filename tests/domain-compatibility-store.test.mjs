import test from 'node:test';
import assert from 'node:assert/strict';
import {api,fixture as productionFixture} from './domain-new-production-fixture.mjs';
import {makeCompatibilityFixture,sealCompatibility} from './fixtures/domain-production-compatibility.mjs';
import {domainHash as hash} from '../host/instance-runtime/domain-model.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {buildDomainProductionCompatibilityIndex} from '../host/instance-runtime/domain-production-compatibility.mjs';

// Real synchronous _store projection, synthetic in-memory immutable events only.
// No repository, media, network, model or runtime authority is configured.
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
const version=(f,id='version:root')=>f.project().assetVersionsById[id];
test('exact old formal reviews survive only the independently validated local compatibility',()=>{
  const f=fixture(),frozen=hash({data:f.data,reviews:f.reviews});
  const currentHash=api.assetReviewContextHash(f.data,'family:root','version:root','a'.repeat(64));
  assert.notEqual(currentHash,f.reviews[0].contextHash);
  for(const id of ['version:root','version:child']){assert.equal(version(f,id).canFlowDownstream,true);assert.equal(version(f,id).lifecycleState,'RELEASED');}
  assert.equal(api.assetReviewContextHash(f.data,'family:root','version:root','a'.repeat(64)),currentHash);
  assert.equal(hash({data:f.data,reviews:f.reviews}),frozen);
});
test('review list and correction predecessor resolve the same compatible immutable approval',()=>{
  const f=fixture(),root=f.data.productionModel.assetVersions[0];
  assert.equal(api.projectedReviewIndexes(f.data,f.reviews,[],[]).byAssetVersion.find(row=>row.aggregateId===root.id)?.event.eventId,f.reviews[0].eventId);
  const transition=api.assetReviewTransitionProjection(f.data,{familyId:root.familyId,versionId:root.id,sha256:root.sha256},{reviews:f.reviews,candidates:[],runs:[],executionRequests:[],sourceOperations:[]});
  assert.equal(transition.headEventId,f.reviews[0].eventId);
});
test('root-only compatibility never revives an uncovered old descendant',()=>{
  const f=fixture({includeChild:false});assert.equal(version(f).canFlowDownstream,true);
  assert.equal(version(f,'version:child').canFlowDownstream,false);
  assert(version(f,'version:child').flowBlockReasons.includes('DOMAIN_RELATION_INPUT_CHANGED'));
});
test('an old compatible review is not a fresh-production barrier for an uncovered later child',()=>{
  const f=fixture({includeChild:false}),parent=f.data.productionModel.assetVersions[0];
  const child=f.produce('uncovered:new',[{familyId:parent.familyId,versionId:parent.id,sha256:parent.sha256,path:parent.path}]);
  assert.equal(version(f).canFlowDownstream,true);
  assert.equal(version(f,child.versionId).canFlowDownstream,false);
  assert(version(f,child.versionId).flowBlockReasons.includes('DOMAIN_RELATION_INPUT_CHANGED'));
});
test('a changed parent family/SHA or input list cannot obtain the child compatibility exception',()=>{
  for(const mutate of [v=>v.inputVersionBindings[0].familyId='other',v=>v.inputVersionBindings[0].sha256='f'.repeat(64),v=>v.inputVersionBindings.push({...v.inputVersionBindings[0],versionId:'missing'})]){
    const f=fixture(),model=f.data.productionModel;mutate(model.assetVersions[1]);
    const index=buildDomainProductionCompatibilityIndex(model,{instanceId:f.data.instance.instanceId,versions:new Map(model.assetVersions.map(v=>[v.id,v]))});
    assert.equal(index.byVersion.has('version:child'),false);
  }
});
for(const [label,change]of [
  ['missing instance',f=>delete f.data.instance],
  ['wrong instance',f=>f.data.instance.instanceId='other-instance'],
  ['missing proof',f=>f.data.productionModel.domainProductionCompatibilities=[]],
  ['review event content changed',f=>f.reviews[0].note='not the approved immutable event'],
  ['review event identity changed',f=>f.reviews[0].eventId='other-review'],
  ['version bytes changed',f=>f.data.productionModel.assetVersions[0].sha256='e'.repeat(64)],
  ['proof bytes changed',f=>f.record.approval.reason+='unsealed'],
  ['current physical state changed',f=>f.data.productionModel.domainGraph.states[0].dimensions.appearance='different'],
  ['latest occurrence changed',f=>f.data.productionModel.domainInvalidations.push(structuredClone(f.data.productionModel.domainInvalidations[0]))],
])test('old approval fails closed: '+label,()=>{const f=fixture();change(f);assert.equal(version(f).canFlowDownstream,false);});
test('rights and correction lineage still override a compatible old approval',()=>{
  const f=fixture();f.data.productionModel.assetVersions[0].projectRightsGate='BLOCKED';assert.equal(version(f).canFlowDownstream,false);assert.equal(version(f).lifecycleState,'RIGHTS_HOLD');
});
test('compatibility without a formal review preserves unapproved candidate state',()=>{
  const f=fixture();f.reviews=[];assert.equal(version(f).canFlowDownstream,false);assert.notEqual(version(f).lifecycleState,'RELEASED');
});
test('modern compatibility needs the exact authoritative recipe, not a model-carried or missing definition',()=>{
  const f=fixture(),def={id:'definition:root',prompt:{main:'fixed'},output:{assetFamilyRef:'family:root'}};def.definitionHash=executionDefinitionHash(def);
  const root=f.data.productionModel.assetVersions[0];root.executionDefinitionRef=def.id;
  Object.assign(f.record.versionBindings[0],{executionDefinitionId:def.id,executionDefinitionHash:def.definitionHash});sealCompatibility(f.record);
  const project=definitions=>api.projectOperationalState(f.data,f.reviews,[],[],[],[],{executionDefinitions:definitions}).assetVersionsById[root.id];
  assert.equal(project(undefined).canFlowDownstream,false);
  f.data.productionModel.executionDefinitions=[def];assert.equal(project(undefined).canFlowDownstream,false);
  assert.equal(project([def]).canFlowDownstream,true);
  assert.equal(project([def,def]).canFlowDownstream,false);
  assert.equal(project([{...def,definitionHash:'0'.repeat(64)}]).canFlowDownstream,false);
  assert.equal(project([{...def,prompt:{main:'tampered'}}]).canFlowDownstream,false);
  delete f.record.versionBindings[0].executionDefinitionId;delete f.record.versionBindings[0].executionDefinitionHash;sealCompatibility(f.record);
  assert.equal(project([def]).canFlowDownstream,false);
});
test('current requirement bridge accepts only the exact additive scope and never mutates frozen hashes',()=>{
  const f=fixture({scopeExtension:true}),q=f.c.query,before=hash(f.data);
  assert.equal(api.hasMaterialRequirementCompatibility(f.data,q.requirementId,q.beforeHash,q.afterHash),true);
  assert.equal(api.hasMaterialRequirementCompatibility(f.data,q.requirementId,q.beforeHash,'f'.repeat(64)),false);
  assert.equal(api.hasMaterialRequirementCompatibility(f.data,'other',q.beforeHash,q.afterHash),false);
  assert.equal(hash(f.data),before);
  delete f.data.instance;assert.equal(api.hasMaterialRequirementCompatibility(f.data,q.requirementId,q.beforeHash,q.afterHash),false);
});
test('requirement coverage admits the exact version AND current scope bridge without rewriting its old binding',()=>{
  const f=fixture({scopeExtension:true}),q=f.c.query,stored=f.data.productionModel.assetVersions[0].materialRequirementBindings[0];
  assert.equal(f.project().materialRequirementsById[q.requirementId].bindingStale,false);
  assert.equal(stored.requirementHash,q.beforeHash);
  f.record.versionBindings=f.record.versionBindings.filter(b=>b.versionId!=='version:root');sealCompatibility(f.record);
  assert.equal(f.project().materialRequirementsById[q.requirementId].coverageSatisfied,false);
});
test('native new recipe keeps the adopted predecessor while its original work requirement hash stays frozen',()=>{
  const f=fixture({scopeExtension:true}),m=f.data.productionModel,q=f.c.query,work=m.materialWorkItems[0],family=m.assetFamilies[0],root=m.assetVersions[0];
  const planId='MP-PLAN-'+'1'.repeat(24),first='output:first',next='output:next';
  work.requirementHash=q.beforeHash;work.executionDefinitionRef='def:next';work.materialProductionPlanId=planId;
  family.materialProductionPlanId=planId;family.expectedOutputRefs=[first,next];family.currentExpectedOutputId=next;
  root.expectedOutputId=first;
  m.materialProductionPlans=[{id:planId,familyId:family.id,workItemId:work.id,definitionId:'def:first',expectedOutputId:first}];
  m.expectedOutputs=[{id:first,familyId:family.id,executionDefinitionRef:'def:first',legacyVersionId:first,materialProductionPlanId:planId},{id:next,familyId:family.id,executionDefinitionRef:'def:next',legacyVersionId:first,materialProductionPlanId:planId}];
  m.materialProductionRecipeRevisions=[{id:'revision:next',materialProductionPlanId:planId,familyId:family.id,workItemId:work.id,definitionId:'def:next',expectedOutputId:next,requirementId:q.requirementId,requirementHash:q.afterHash}];
  assert.equal(version(f).canFlowDownstream,true);assert.equal(f.project().assetFamiliesById[family.id].currentVersionId,root.id);
  assert.equal(work.requirementHash,q.beforeHash);
  m.materialProductionRecipeRevisions[0].requirementHash='9'.repeat(64);
  assert.equal(version(f).canFlowDownstream,false);
});
test('candidate requirement binding comes from its exact executed recipe, not the frozen work or latest demand',()=>{
  const f=productionFixture(),parent=f.addRoot(),child=f.produce('native-next',[parent]),work=f.data.productionModel.materialWorkItems.find(w=>w.outputAssetRef===child.familyId);
  work.requirementHash=hash('frozen work hash');
  const definition={id:child.definitionId,materialRequirementRef:work.requirementRef,materialRequirementHash:hash('executed exact scope hash')};definition.definitionHash=executionDefinitionHash(definition);
  child.candidate.executionDefinitionHash=definition.definitionHash;
  const requirement=f.data.productionModel.materialRequirements.find(r=>r.id===work.requirementRef);requirement.requirementHash=definition.materialRequirementHash;
  child.review.contextHash=api.assetReviewContextHash(f.data,child.familyId,child.versionId,child.sha256);
  const state=api.projectOperationalState(f.data,f.reviews,f.candidates,f.runs,[],f.requests,{executionDefinitions:[definition]});
  assert.equal(state.materialRequirementsById[work.requirementRef].bindingStale,false);
  assert.equal(work.requirementHash,hash('frozen work hash'));
});
