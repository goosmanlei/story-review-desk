import test from 'node:test';
import assert from 'node:assert/strict';
import {replacementFixture} from './fixtures/material-requirement-replacement.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {applyRequirementCompositionCoverage,requirementInputFamilyIds} from '../host/instance-runtime/material-requirement-composition.mjs';
import {deriveShotDesignRequirementBasisV3} from '../host/instance-runtime/shot-design-requirement-basis.mjs';
import {productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';
import {configuredGates} from '../app/gate-evaluation.ts';

function fixture(){
 const f=replacementFixture(),familyId='original-family',versionId=familyId+'@V001';
 const family={id:familyId,currentVersionId:versionId,adoptedVersionId:versionId,canFlowDownstream:true};
 const version={id:versionId,familyId,sha256:'a'.repeat(64),path:'media/original.png',canFlowDownstream:true};
 const raw={productionModel:{assetFamilies:[family],assetVersions:[version],materialRequirements:[],workItems:[],materialWorkItems:[]}};
 const before=projectDomainGraph(raw,f.before,{revisionId:'before',sha256:domainHash(f.before)});
 const after=projectDomainGraph(before,f.after,{revisionId:'after',sha256:domainHash(f.after)});
 const state={assetFamiliesById:{[familyId]:family},assetVersionsById:{[versionId]:version},materialRequirementsById:{},workItemsById:{},materialWorkItemsById:{}};
 return {...f,before,after,model:after.productionModel,state,binding:{familyId,versionId,sha256:version.sha256}};
}
const all=(id,requirementId)=>({id,requirementHash:domainHash(id),requirementClass:'REQUIRED',assetFamilyRefs:[],composition:{schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'part',requirementId}]}});
test('a former root retains original asset approval but cannot supply a current requirement binding',()=>{
 const f=fixture(),before=JSON.stringify(f.model.assetFamilies);
 assert.deepEqual(productionBindingReasons(f.model,f.state,f.binding),[]);
 assert.ok(productionBindingReasons(f.model,f.state,{...f.binding,requirementId:'old-broad'}).includes('REQUIREMENT_REPLACED_FOR_CURRENT_SELECTION'));
 assert.equal(JSON.stringify(f.model.assetFamilies),before);
 f.state.assetVersionsById[f.binding.versionId].canFlowDownstream=false;
 assert.ok(productionBindingReasons(f.model,f.state,f.binding).includes('INPUT_VERSION_NOT_CURRENT_RELEASED'),'source exemption never bypasses actual approval');
});
test('another ALL cannot launder a former root into current coverage or expanded inputs',()=>{
 const f=fixture(),rows=f.model.materialRequirements.map(r=>({...r,coverageSatisfied:r.id==='old-broad',coveredByFamilyRefs:r.id==='old-broad'?[f.binding.familyId]:[],coveredByVersionRefs:r.id==='old-broad'?[f.binding.versionId]:[]}));
 rows.push(all('other-aggregate','old-broad'));
 const projected=applyRequirementCompositionCoverage(rows),byId=Object.fromEntries(projected.map(r=>[r.id,r]));
 assert.equal(byId['old-broad'].coverageSatisfied,true,'historical coverage is retained');
 assert.equal(byId['other-aggregate'].coverageSatisfied,false);
 assert.equal(byId['complete-new'].coverageSatisfied,false,'one original file does not satisfy new leaves');
 f.model.materialRequirements=rows;f.state.materialRequirementsById=byId;
 assert.deepEqual(requirementInputFamilyIds(f.model,f.state,byId['old-broad']),[]);
 assert.deepEqual(requirementInputFamilyIds(f.model,f.state,byId['other-aggregate']),[]);
});
test('generic execution gate blocks only the old target while retaining family-only reference work',()=>{
 const f=fixture();f.model.materialWorkItems=[{id:'old-work',requirementRef:'old-broad',outputAssetRef:'original-family'},{id:'new-work',requirementRef:'leaf-a',inputAssetRefs:['original-family']}];
 const gates=configuredGates(f.model,f.state);
 assert.ok(gates['old-work'].entryReasons.includes('REQUIREMENT_REPLACED_FOR_CURRENT_SELECTION'));
 assert.equal(gates['new-work'].entryReasons.includes('REQUIREMENT_REPLACED_FOR_CURRENT_SELECTION'),false);
});
function coverage(model,requirementId){
 const content={sceneId:'scene-a',beats:[{beatId:'beat',materialRequirementRefs:[requirementId]}]};
 model.sceneCoveragePlanRevisions=[{id:'coverage',scopeId:'scene-a',scopeRole:'CURRENT',revisionState:'CURRENT',isCurrent:true,content,contentHash:domainHash(content)}];
}
test('current V3 design refuses an old root and requires an explicit new leaf selection',()=>{
 const f=fixture();coverage(f.model,'old-broad');
 assert.throws(()=>deriveShotDesignRequirementBasisV3(f.model,'scene-a'),/已拆分|异常|REQUIREMENT_REPLACED/);
 coverage(f.model,'leaf-a');const basis=deriveShotDesignRequirementBasisV3(f.model,'scene-a');
 assert.deepEqual(basis.bindings.map(r=>r.requirementId),['leaf-a']);
});
test('replacement disposition and a first leaf family allocation do not reopen a new semantic design',()=>{
 const f=fixture();coverage(f.model,'leaf-a');const before=deriveShotDesignRequirementBasisV3(f.model,'scene-a');
 const next=structuredClone(f.after.productionModel.domainGraph);next.representations.find(r=>r.id==='rep:leaf-a').assetFamilyIds=['leaf-family'];
 const after=projectDomainGraph(f.after,next,{revisionId:'leaf-allocation',sha256:domainHash(next)});
 assert.deepEqual(deriveShotDesignRequirementBasisV3(after.productionModel,'scene-a'),before);
});
