import test from 'node:test';
import assert from 'node:assert/strict';
import {domainHash,validateDomainGraph,validateRequirementReplacementTransition} from '../host/instance-runtime/domain-model.mjs';
import {projectDomainGraph,preserveDomainProjection} from '../host/instance-runtime/domain-projection.mjs';
import {currentMaterialRequirementRows,materialRequirementDisposition,materialRequirementSelectionReasons,projectMaterialRequirementDispositions} from '../host/instance-runtime/material-requirement-disposition.mjs';
import {replacementFixture} from './fixtures/material-requirement-replacement.mjs';
const invalid=fn=>assert.throws(fn,e=>e.code==='DOMAIN_INVALID');
function modelFixture(){const f=replacementFixture();const raw={productionModel:{assetFamilies:[{id:'original-family',currentVersionId:'original-family@V001',adoptedVersionId:'original-family@V001',canFlowDownstream:true,reviewDecision:'RELEASED',projectRightsGate:'CLEAR_BY_USER_ATTESTATION'}],assetVersions:[{id:'original-family@V001',familyId:'original-family',sha256:'a'.repeat(64)}],materialRequirements:[]}};const before=projectDomainGraph(raw,f.before,{revisionId:'before',sha256:domainHash(f.before)});const after=projectDomainGraph(before,f.after,{revisionId:'after',sha256:domainHash(f.after)});return {...f,beforeSnapshot:before,afterSnapshot:after,model:after.productionModel};}

test('exact IMAGE ALL replacement validates without changing its original graph records',()=>{const f=replacementFixture();const b=JSON.stringify(f.before);validateDomainGraph(f.after,{previousGraph:f.before});assert.equal(JSON.stringify(f.before),b);for(const col of ['entities','states','representations','relations','requirements'])for(const row of f.before[col])assert.deepEqual(f.after[col].find(r=>r.id===row.id),row);});
for(const [label,mutate]of[
 ['extra replacement key',f=>f.aggregate.replaces.optional=true],
 ['bad parent hash',f=>f.aggregate.replaces.requirementHash='0'.repeat(64)],
 ['missing parent',f=>f.aggregate.replaces.requirementId='missing'],
 ['self parent',f=>f.aggregate.replaces.requirementId=f.aggregate.id],
 ['not ALL',f=>delete f.aggregate.composition],
 ['nonempty aggregate family',f=>f.after.representations.find(r=>r.id===f.aggregate.representationId).assetFamilyIds.push('unexpected')],
 ['AUDIO widening',f=>f.aggregate.mediaType='AUDIO'],
 ['TEXT widening',f=>f.aggregate.mediaType='TEXT'],
 ['parent AUDIO widening',f=>{f.after.requirements[0].mediaType='AUDIO';f.aggregate.replaces.requirementHash=domainHash({demand:f.after.requirements[0],representation:f.after.representations[0]});}],
 ['cross subject',f=>{f.after.entities.push({...f.after.entities[0],id:'other'});const rep=f.after.representations.find(r=>r.id===f.aggregate.representationId);rep.entityId='other';f.after.states.find(r=>r.id===rep.stateId).entityId='other';}],
 ['missing original scope',f=>f.aggregate.scope=f.scope.slice(0,1)],
 ['scope revision drift',f=>f.aggregate.scope=[{...f.scope[0],revisionId:'later'},f.scope[1]]],
 ['duplicate scope',f=>f.aggregate.scope=[...f.scope,f.scope[0]]],
 ['component cross scope',f=>f.after.requirements.find(r=>r.id==='leaf-a').scope=[{scopeType:'SCENE',scopeId:'future',revisionId:'future-r'}]],
 ['component missing coverage',f=>f.after.requirements.find(r=>r.id==='leaf-b').scope=[f.scope[0]]],
 ['parent-as-component bypass',f=>f.aggregate.composition.requiredComponents[0].requirementId='old-broad'],
 ['missing component',f=>f.aggregate.composition.requiredComponents[0].requirementId='missing'],
 ['duplicate successor',f=>{const q=f.append(f.after,'another',f.scope);q.composition=structuredClone(f.aggregate.composition);q.replaces=structuredClone(f.aggregate.replaces);}],
])test('strict replacement rejects '+label,()=>{const f=replacementFixture();mutate(f);invalid(()=>validateDomainGraph(f.after,{previousGraph:f.before}));});

test('nested component scope is checked through the leaf closure',()=>{const f=replacementFixture();const nested=f.append(f.after,'nested',[f.scope[0]]);nested.composition={schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'a',requirementId:'leaf-a'}]};f.aggregate.composition.requiredComponents[0].requirementId='nested';validateDomainGraph(f.after,{previousGraph:f.before});f.after.requirements.find(r=>r.id==='leaf-a').scope=[{scopeType:'SCENE',scopeId:'other',revisionId:'other'}];invalid(()=>validateDomainGraph(f.after,{previousGraph:f.before}));});

test('already published replacement cannot be deleted, stripped or rebound to revive old coverage',()=>{const f=replacementFixture();for(const mutate of[g=>g.requirements.splice(g.requirements.findIndex(r=>r.id===f.aggregate.id),1),g=>delete g.requirements.find(r=>r.id===f.aggregate.id).replaces,g=>{g.requirements.find(r=>r.id===f.aggregate.id).replaces.requirementId='leaf-a';}]){const next=structuredClone(f.after);mutate(next);invalid(()=>validateRequirementReplacementTransition(f.after,next));const {afterSnapshot}=modelFixture();invalid(()=>projectDomainGraph(afterSnapshot,next,{revisionId:'bad',sha256:domainHash(next)}));}});

test('first replacement requires an existing unchanged parent and a fresh aggregate identity',()=>{
 const f=replacementFixture();invalid(()=>validateRequirementReplacementTransition(undefined,f.after));
 const changed=structuredClone(f.after);changed.entities[0].description='changed together';invalid(()=>validateRequirementReplacementTransition(f.before,changed));
 const already=structuredClone(f.after);delete already.requirements.find(r=>r.id===f.aggregate.id).replaces;invalid(()=>validateRequirementReplacementTransition(already,f.after));
});

test('projection adds selection-only fields; original source hash, asset adoption and context are exact',()=>{
 const f=modelFixture(),before=f.beforeSnapshot.productionModel;assert.deepEqual(f.model.assetFamilies,before.assetFamilies);assert.deepEqual(f.model.assetVersions,before.assetVersions);assert.deepEqual(f.model.domainInvalidations,[]);const old=f.model.materialRequirements.find(r=>r.id==='old-broad');assert.equal(old.requirementHash,before.materialRequirements[0].requirementHash);assert.equal(old.requirementClass,'REQUIRED');assert.deepEqual(old.domainContext,before.materialRequirements[0].domainContext);assert.equal(old.currentDisposition,'REPLACED');assert.equal(old.requirementReplacement.replacedByRequirementId,'complete-new');assert.deepEqual(f.model.domainGraph,f.after);
});

test('selection excludes old roots, counts shared atomic leaves once and exposes ALL separately',()=>{const {model}=modelFixture();assert.deepEqual(currentMaterialRequirementRows(model).map(r=>r.id),['leaf-a','leaf-b','complete-new']);assert.deepEqual(currentMaterialRequirementRows(model,{atomicOnly:true}).map(r=>r.id),['leaf-a','leaf-b']);assert.equal(materialRequirementDisposition(model,'complete-new').countsAsAtomic,false);assert.deepEqual(materialRequirementSelectionReasons(model,'old-broad'),['REQUIREMENT_REPLACED_FOR_CURRENT_SELECTION']);assert.deepEqual(materialRequirementSelectionReasons(model,'leaf-a'),[]);});

for(const use of ['USAGE_SOURCE','ORIGINAL_ASSET_PROVENANCE','HISTORICAL_FROZEN'])test(use+' keeps its original asset qualification contract',()=>{const {model}=modelFixture();assert.deepEqual(materialRequirementSelectionReasons(model,'old-broad',{use}),[]);assert.equal(model.assetFamilies[0].canFlowDownstream,true);});

test('old models without replacement are byte-identical and gain no new gates',()=>{const rows=[{id:'a',requirementClass:'REQUIRED'},{id:'b',requirementClass:'EVIDENCE_ONLY'}],model={materialRequirements:rows},before=JSON.stringify(model);assert.equal(projectMaterialRequirementDispositions(model),rows);assert.equal(JSON.stringify(model),before);for(const id of ['a','b','missing'])assert.deepEqual(materialRequirementSelectionReasons(model,id),[]);});

for(const [label,change]of[
 ['missing successor',m=>{m.materialRequirements=m.materialRequirements.filter(r=>r.id!=='complete-new');m.domainGraph.requirements=m.domainGraph.requirements.filter(r=>r.id!=='complete-new');}],
 ['stripped successor declaration',m=>{delete m.domainGraph.requirements.find(r=>r.id==='complete-new').replaces;delete m.materialRequirements.find(r=>r.id==='complete-new').replaces;}],
 ['wrong current parent hash',m=>m.materialRequirements.find(r=>r.id==='old-broad').requirementHash='0'.repeat(64)],
 ['partial component model',m=>m.materialRequirements=m.materialRequirements.filter(r=>r.id!=='leaf-a')],
 ['projected declaration missing',m=>delete m.materialRequirements.find(r=>r.id==='complete-new').replaces],
 ['projected receipt protocol invalid',m=>m.materialRequirements.find(r=>r.id==='old-broad').requirementReplacement.protocol='invented'],
])test('selection fails closed for '+label+' and never mutates original source eligibility',()=>{const {model}=modelFixture(),before=JSON.stringify(model.assetFamilies);change(model);assert.equal(materialRequirementDisposition(model,'old-broad').currentSelectable,false);assert.ok(materialRequirementSelectionReasons(model,'old-broad').length);assert.equal(JSON.stringify(model.assetFamilies),before);assert.deepEqual(materialRequirementSelectionReasons(model,'old-broad',{use:'USAGE_SOURCE'}),[]);});

test('partial projected rows without a full graph still refuse a missing successor',()=>{const {model}=modelFixture();delete model.domainGraph;model.materialRequirements=model.materialRequirements.filter(r=>r.id!=='complete-new');assert.equal(materialRequirementDisposition(model,'old-broad').kind,'INVALID_REPLACEMENT');});

test('foreign or invented use cannot opt into provenance exemptions',()=>{assert.deepEqual(materialRequirementSelectionReasons(modelFixture().model,'old-broad',{use:'client_allow'}),['REQUIREMENT_SELECTION_USE_INVALID']);});


test('source preservation restores the exact published replacement from a compiler model without host graph fields',()=>{
 const f=modelFixture(),base=f.afterSnapshot;
 base.productionModel.sceneScriptRevisions=f.scope.map(s=>({sceneId:s.scopeId,id:s.revisionId}));
 const compiled=structuredClone(base);delete compiled.productionModel.domainGraph;delete compiled.productionModel.domainGraphRef;compiled.productionModel.materialRequirements=[];
 const out=preserveDomainProjection({snapshot:compiled,baseSnapshot:base});
 assert.deepEqual(out.productionModel.domainGraph,base.productionModel.domainGraph);
 assert.equal(out.productionModel.materialRequirements.find(r=>r.id==='old-broad').currentDisposition,'REPLACED');
 assert.deepEqual(out.productionModel.assetFamilies,base.productionModel.assetFamilies);
 const bad=structuredClone(base);bad.productionModel.domainGraphRef.sha256='0'.repeat(64);
 assert.throws(()=>preserveDomainProjection({snapshot:compiled,baseSnapshot:bad}),/SHA/);
});

test('source replay recalculates disposition after permanent scene scope is retired',()=>{
 const f=modelFixture(),base=f.afterSnapshot;const out=preserveDomainProjection({snapshot:structuredClone(base),baseSnapshot:base});
 const old=out.productionModel.materialRequirements.find(r=>r.id==='old-broad');
 assert.equal(old.requirementClass,'EVIDENCE_ONLY');assert.equal(old.currentDisposition,'INVALID_REPLACEMENT');
 assert.equal(materialRequirementDisposition(out.productionModel,'old-broad').currentSelectable,false);
});


test('no-marker catalogue preserves legacy REQUIRED rows without introducing active/scope exclusions',()=>{
 const rows=[{id:'legacy',requirementClass:'REQUIRED',scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false},{id:'audit',requirementClass:'EVIDENCE_ONLY'}];
 assert.deepEqual(currentMaterialRequirementRows({materialRequirements:rows}),[rows[0]]);
 assert.equal(materialRequirementDisposition({materialRequirements:rows},'legacy').currentSelectable,true);
});

test('untrusted currentDisposition cannot revive an exact replaced root',()=>{const {model}=modelFixture();model.materialRequirements.find(r=>r.id==='old-broad').currentDisposition='CURRENT_ATOMIC';assert.equal(materialRequirementDisposition(model,'old-broad').kind,'REPLACED');assert.ok(materialRequirementSelectionReasons(model,'old-broad').length);});

test('projection-only replacement cycles and duplicate claims fail closed without recursion',()=>{
 const {model}=modelFixture();delete model.domainGraph;const original=model.materialRequirements.find(r=>r.id==='old-broad'),all=model.materialRequirements.find(r=>r.id==='complete-new');delete original.requirementReplacement;delete all.requirementReplacement;
 original.composition=structuredClone(all.composition);original.assetFamilyRefs=[];original.replaces={requirementId:all.id,requirementHash:all.requirementHash};
 assert.equal(materialRequirementDisposition(model,original.id).kind,'INVALID_REPLACEMENT');assert.ok(materialRequirementDisposition(model,original.id).reasons.includes('REPLACEMENT_CYCLE'));
 const f=modelFixture();delete f.model.domainGraph;const other=structuredClone(f.model.materialRequirements.find(r=>r.id==='complete-new'));other.id='duplicate';f.model.materialRequirements.push(other);assert.equal(materialRequirementDisposition(f.model,'old-broad').kind,'INVALID_REPLACEMENT');
});

test('present malformed receipts never downgrade a partial former root into current selection',()=>{
 for(const receipt of [null,false,{}, {protocol:'MATERIAL_REQUIREMENT_REPLACEMENT_V1',status:'VALID'}]){
  const {model}=modelFixture();delete model.domainGraph;model.materialRequirements=model.materialRequirements.filter(r=>r.id==='old-broad');model.materialRequirements[0].requirementReplacement=receipt;
  assert.equal(materialRequirementDisposition(model,'old-broad').currentSelectable,false);assert.ok(materialRequirementSelectionReasons(model,'old-broad').length);
 }
});

test('a local replacement leaves unrelated legacy REQUIRED selection unchanged even after projection',()=>{
 const {model}=modelFixture();const row={id:'unrelated',requirementClass:'REQUIRED',scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false};model.materialRequirements.push(row);
 assert.ok(currentMaterialRequirementRows(model).some(r=>r.id===row.id));model.materialRequirements=projectMaterialRequirementDispositions(model);
 assert.ok(currentMaterialRequirementRows(model).some(r=>r.id===row.id));assert.equal(materialRequirementDisposition(model,row.id).kind,'CURRENT_ATOMIC');assert.deepEqual(materialRequirementSelectionReasons(model,row.id),[]);
});

test('partial nested replacement checks grandchildren, cycles and exact leaf scope recursively',()=>{
 const f=replacementFixture();const nested=f.append(f.after,'nested',[f.scope[0]]);nested.composition={schemaVersion:'1.0',mode:'ALL',requiredComponents:[{id:'a',requirementId:'leaf-a'}]};f.aggregate.composition.requiredComponents[0].requirementId='nested';
 const before=projectDomainGraph({productionModel:{assetFamilies:[],materialRequirements:[]}},f.before,{revisionId:'before',sha256:domainHash(f.before)});
 const original=projectDomainGraph(before,f.after,{revisionId:'after',sha256:domainHash(f.after)}).productionModel;delete original.domainGraph;
 assert.equal(materialRequirementDisposition(original,'complete-new').kind,'CURRENT_AGGREGATE');
 for(const mutate of [m=>m.materialRequirements=m.materialRequirements.filter(r=>r.id!=='leaf-a'),m=>m.materialRequirements.find(r=>r.id==='leaf-a').scopeBindings=[f.scope[1]],m=>m.materialRequirements.find(r=>r.id==='nested').composition.requiredComponents[0].requirementId='nested']){
  const m=structuredClone(original);mutate(m);assert.equal(materialRequirementDisposition(m,'complete-new').kind,'INVALID_REPLACEMENT');assert.ok(materialRequirementSelectionReasons(m,'old-broad').length);
 }
});


test('a retained derived disposition without its receipt cannot silently downgrade in a partial model',()=>{const {model}=modelFixture();delete model.domainGraph;model.materialRequirements=model.materialRequirements.filter(r=>r.id==='old-broad');delete model.materialRequirements[0].requirementReplacement;assert.equal(materialRequirementDisposition(model,'old-broad').currentSelectable,false);assert.ok(materialRequirementSelectionReasons(model,'old-broad').includes('REPLACEMENT_RECEIPT_MISSING'));});
