import test from 'node:test';
import assert from 'node:assert/strict';
import {materialProductionFixture,imageRequirementId} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {resolveMaterialProductionRequirement} from '../host/instance-runtime/material-production-requirement.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';

const api={projectOperationalState(snapshot){const m=snapshot.productionModel;return{assetFamiliesById:Object.fromEntries(m.assetFamilies.map(x=>[x.id,x])),assetVersionsById:{}};}};
async function fixed(t){
 const f=await materialProductionFixture(t),requirementId=imageRequirementId;
 const w=await f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId,api}));
 const s=await f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:null,content:{model:'codex:gpt-image-2',prompt:'Synthetic identity fixture.',negativePrompt:'No additional identities.',parameters:{width:1,height:1},inputBindings:[]}},{api}));
 const p=await f.repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId,draftRevisionId:s.revisionId},{api}));
 const j=await f.repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId,draftRevisionId:s.revisionId,previewHash:p.previewHash,requestId:'native-closure:fixture'},{api}));
 await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:j.jobId,api}));
 const view=await f.repo.readView(),m=view.snapshot.productionModel,plan=m.materialProductionPlans[0],requirement=m.materialRequirements.find(r=>r.id===requirementId),demand=m.domainGraph.requirements.find(r=>r.id===requirementId),representation=m.domainGraph.representations.find(r=>r.id===demand.representationId),family=m.assetFamilies.find(r=>r.id===plan.familyId),work=m.materialWorkItems.find(r=>r.id===plan.workItemId);
 return {...f,view,c:{plan,requirement,demand,representation,family,work}};
}
const omitted=c=>{const n=structuredClone(c);delete n.requirement.materialWorkItemRef;delete n.requirement.plannedAssetFamilyId;return n;};

test('omitted native links are recovered only in a read-only copy from the exact immutable first source',async t=>{
 const f=await fixed(t),before=await f.repo.exportState(),c=omitted(f.c);
 const resolved=await f.repo.readTransaction(tx=>resolveMaterialProductionRequirement(tx,c));
 assert.deepEqual(resolved,f.c.requirement);assert.equal(Object.hasOwn(c.requirement,'materialWorkItemRef'),false);assert.deepEqual(await f.repo.exportState(),before);
 const one=structuredClone(f.c);delete one.requirement.plannedAssetFamilyId;
 assert.deepEqual(await f.repo.readTransaction(tx=>resolveMaterialProductionRequirement(tx,one)),f.c.requirement);
});

for(const [label,alter] of [
 ['explicit wrong work',c=>c.requirement.materialWorkItemRef='another-work'],
 ['explicit null family',c=>c.requirement.plannedAssetFamilyId=null],
 ['changed requirement hash',c=>c.requirement.requirementHash='0'.repeat(64)],
 ['changed entity ownership',c=>c.representation.entityId='another-person'],
 ['changed requirement scope',c=>c.demand.scope=[{scopeType:'PROJECT',scopeId:'another-scope'}]],
 ['changed family ownership',c=>c.family.id='another-family'],
 ['changed plan identity',c=>c.plan.id='another-plan'],
 ['changed source revision',c=>c.plan.sourceRevisionId='missing-revision'],
 ['changed source SHA',c=>c.plan.sourceSha256='f'.repeat(64)],
])test('native omitted-link compatibility rejects '+label,async t=>{
 const f=await fixed(t),c=omitted(f.c),before=await f.repo.exportState();alter(c);
 await assert.rejects(f.repo.readTransaction(tx=>resolveMaterialProductionRequirement(tx,c)),e=>['DOMAIN_CONFLICT','MATERIAL_PRODUCTION_SOURCE_CONFLICT'].includes(e.code));assert.deepEqual(await f.repo.exportState(),before);
});
for(const [label,alter] of [
 ['missing source',()=>null],['corrupt source bytes',d=>({...d,bytes:Buffer.from('{}')})],['wrong source alias',d=>({...d,aliases:['another/path.json']})],['wrong source role',d=>({...d,metadata:{...d.metadata,sourceRole:'SOURCE_DOCUMENT'}})],
])test('native omitted-link compatibility rejects '+label,async t=>{
 const f=await fixed(t),before=await f.repo.exportState();
 await assert.rejects(f.repo.readTransaction(tx=>{const read=tx.readDocumentRevision.bind(tx);tx.readDocumentRevision=async id=>alter(await read(id));return resolveMaterialProductionRequirement(tx,omitted(f.c));}),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});assert.deepEqual(await f.repo.exportState(),before);
});

test('domain projection preserves explicit native links without inventing, laundering or copying them to changed demand/representation closures',async t=>{
 const f=await fixed(t),before=structuredClone(f.view.snapshot),graph=before.productionModel.domainGraph,ref=before.productionModel.domainGraphRef;
 const project=(snapshot,g=graph)=>projectDomainGraph(snapshot,g,{...ref,sha256:domainHash(g)}).productionModel.materialRequirements.find(r=>r.id===imageRequirementId);
 const next=project(before);for(const key of ['materialWorkItemRef','plannedAssetFamilyId'])assert.equal(next[key],f.c.requirement[key]);
 assert.deepEqual(before,f.view.snapshot);
 const broken=structuredClone(before),r=broken.productionModel.materialRequirements.find(r=>r.id===imageRequirementId);r.materialWorkItemRef='explicit-conflict';assert.equal(project(broken).materialWorkItemRef,'explicit-conflict');
 delete r.materialWorkItemRef;delete r.plannedAssetFamilyId;assert.equal(Object.hasOwn(project(broken),'materialWorkItemRef'),false);
 const changed=structuredClone(graph);changed.requirements.find(r=>r.id===imageRequirementId).acceptanceCriteria.push('A new explicit acceptance condition.');assert.equal(Object.hasOwn(project(before,changed),'materialWorkItemRef'),false);
});
