import test from 'node:test';
import assert from 'node:assert/strict';
import {materialProductionCurrentBasisReasons as reasons} from '../host/instance-runtime/material-production-current-basis.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
const fixture=()=>{
 const demand={id:'req',representationId:'rep',title:'Fixed original requirement'},rep={id:'rep',assetFamilyIds:['family']},graph={requirements:[demand],representations:[rep]},hash=domainHash({demand,representation:rep});
 const work={id:'work',materialProductionPlanId:'plan',requirementRef:'req',requirementHash:hash,outputAssetRef:'family',executionDefinitionRef:'def',reviewContextRef:'ctx'},definition={id:'def',workItemRef:'work',materialProductionPlanId:'plan',materialRequirementRef:'req',materialRequirementHash:hash,output:{assetFamilyRef:'family',expectedOutputRef:'eo'}},model={domainGraph:graph,domainGraphRef:{sha256:domainHash(graph)},materialProductionPlans:[{id:'plan',workItemId:'work',familyId:'family',requirementId:'req',representationId:'rep'}],materialRequirements:[{id:'req',requirementHash:hash}],assetFamilies:[{id:'family',ownerRef:'work',reviewOwner:'MATERIAL',currentExpectedOutputId:'eo',domainContext:{hash:'domain'}}],reviewContexts:[{id:'ctx',requirementHash:hash,binding:{requirementHash:hash,domainContextHash:'domain'}}]};
 return {model,work,definition};
};
test('current native execution accepts the exact published basis and does not reinterpret unrelated legacy work',()=>{const f=fixture();assert.deepEqual(reasons(f.model,f.work,f.definition),[]);assert.deepEqual(reasons({}, {id:'legacy'},{id:'old'}),[]);});
for(const [name,change]of Object.entries({
 'semantic demand changes but old producer remains':f=>{f.model.domainGraph.requirements[0].title='New actual requirement';f.model.domainGraphRef.sha256=domainHash(f.model.domainGraph);f.model.materialRequirements[0].requirementHash=domainHash({demand:f.model.domainGraph.requirements[0],representation:f.model.domainGraph.representations[0]});},
 'upstream domain context changes only':f=>f.model.assetFamilies[0].domainContext.hash='changed relationship',
 'old definition after a newer output':f=>f.model.assetFamilies[0].currentExpectedOutputId='new-eo',
 'missing plan marker cannot drop native ownership':f=>{delete f.work.materialProductionPlanId;delete f.definition.materialProductionPlanId;},
 'missing requirement':f=>f.model.materialRequirements=[],
 'missing context':f=>f.model.reviewContexts=[],
 'wrong owner':f=>f.model.assetFamilies[0].ownerRef='another-work',
 'wrong graph pin':f=>f.model.domainGraphRef.sha256='0'.repeat(64),
 'missing definition':f=>f.definition=undefined,
 'duplicate plan':f=>f.model.materialProductionPlans.push(structuredClone(f.model.materialProductionPlans[0]))
}))test('current native execution refuses '+name,()=>{const f=fixture();change(f);assert.deepEqual(reasons(f.model,f.work,f.definition),['MATERIAL_REQUIREMENT_BASIS_CHANGED']);});
