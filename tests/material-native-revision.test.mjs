import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {materialProductionFixture,imageRequirementId,imageRepresentationId,legacyObjects,changeDomain} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {preserveMaterialProductionProjection} from '../host/instance-runtime/material-production-preservation.mjs';

// Real repository/append-only media and event fixtures; approval projection is
// intentionally narrow here. The separate PostgreSQL API suite exercises the
// real authorization, Review and candidate consumers without a provider call.
const api={projectOperationalState(snapshot,reviews,candidates){
 const model=snapshot.productionModel,versions=[...model.assetVersions,...candidates.map(c=>({...c,id:c.versionId,outputState:'PRESENT'}))],families=model.assetFamilies.map(f=>({...f}));
 for(const f of families){const adopted=reviews.find(e=>e.familyId===f.id&&e.action==='APPROVE_AND_RELEASE'&&e.applicationStatus==='APPLIED');if(adopted){f.currentVersionId=adopted.versionId;const v=versions.find(v=>v.id===adopted.versionId);Object.assign(v,{canFlowDownstream:true,lifecycleState:'RELEASED'});}}
 return {assetFamiliesById:Object.fromEntries(families.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(versions.map(v=>[v.id,v]))};
}};
const content=prompt=>({model:'codex:gpt-image-2',prompt,negativePrompt:'无不明人物或漂移。',parameters:{width:1024,height:1024},inputBindings:[]});
const workspace=repo=>repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api}));
async function stage(repo,prompt='干净人物母版。'){
 const w=await workspace(repo),saved=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:content(prompt)},{api})),preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:saved.revisionId},{api}));
 return {w,saved,preview};
}
async function queue(repo,s,key){return repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:s.saved.revisionId,previewHash:s.preview.previewHash,requestId:key},{api}));}
async function provision(repo,prompt,key){const s=await stage(repo,prompt),job=await queue(repo,s,key);return repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));}
let nextEvent=0;
async function event(repo,kind,payload){const id='native-revision-fixture:'+String(++nextEvent);return (await repo.writeTransaction(tx=>tx.appendEvent({kind,idempotencyKey:id,requestHash:sha256(id),eventSchemaVersion:'2.2',payload}))).event;}
async function register(f,{review='REQUEST_REVISION',metadata={authorityDomain:'FORMAL'},label}={}){
 const view=await f.repo.readView(),plan=view.snapshot.productionModel.materialProductionPlans[0],work=view.snapshot.productionModel.materialWorkItems.find(w=>w.id===plan.workItemId),definition=view.recipes.executionDefinitions.find(d=>d.id===work.executionDefinitionRef),output=view.snapshot.productionModel.expectedOutputs.find(o=>o.id===definition.output.expectedOutputRef),versionId=plan.familyId+'@'+(label||output.plannedVersionLabel),bytes=Buffer.from('isolated fixture '+versionId);
 await mkdir(path.dirname(path.join(f.root,output.targetPath)),{recursive:true});await writeFile(path.join(f.root,output.targetPath),bytes,{flag:'wx'});
 const executionRequestId='request:'+versionId,runId='run:'+versionId,runBinding={executionRequestId,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash};
 await event(f.repo,'execution-request',{...runBinding,workItemId:work.id,familyId:plan.familyId,executor:'CODEX',requestState:'CLAIMED',maxOutputs:1,snapshotId:view.snapshot.snapshotId});
 await event(f.repo,'run',{...runBinding,runId,runState:'SUCCEEDED'});
 await f.repo.writeTransaction(tx=>tx.registerMedia({mediaId:plan.familyId,versionId,relativePath:output.targetPath,sha256:sha256(bytes),byteSize:bytes.length,aliases:[],metadata}));
 const candidate=await event(f.repo,'asset-version',{...runBinding,runId,familyId:plan.familyId,versionId,expectedOutputId:output.id,path:output.targetPath,sha256:sha256(bytes),parentVersionId:definition.parentVersionId,inputBindings:[],lifecycleState:'REVIEW_PENDING',projectRightsGate:'UNKNOWN'});
 if(review)await event(f.repo,'review',{subjectType:'ASSET',familyId:plan.familyId,versionId,versionSha256:candidate.sha256,action:review,effect:'APPLIED',applicationStatus:'APPLIED'});
 return {plan,work,definition,output,candidate};
}
async function preserve(repo){const view=await repo.readView(),documents=await Promise.all(view.sourceRevisionIds.map(id=>repo.readDocumentRevision(id))),snapshot=structuredClone(view.snapshot),recipes=structuredClone(view.recipes),model=snapshot.productionModel,plans=model.materialProductionPlans,ids=new Set(plans.map(p=>p.familyId)),works=new Set(plans.map(p=>p.workItemId));
 for(const key of ['assetFamilies','assetVersions','expectedOutputs'])model[key]=model[key].filter(row=>!ids.has(row.familyId||row.id));
 model.materialWorkItems=model.materialWorkItems.filter(w=>!works.has(w.id));model.reviewContexts=[];model.materialProductionPlans=[];model.materialProductionRecipeRevisions=[];recipes.executionDefinitions=recipes.executionDefinitions.filter(d=>!works.has(d.workItemRef));recipes.promptRevisions=[];
 return {input:{snapshot,recipes,baseSnapshot:view.snapshot,baseRecipes:view.recipes,documents},result:preserveMaterialProductionProjection({snapshot,recipes,baseSnapshot:view.snapshot,baseRecipes:view.recipes,documents})};
}

test('same-family V002/V003 append frozen recipes, actual parents and ExpectedOutputs while all initial source and adopted media remain unchanged',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'第一母版。','first');const v1=await register(f,{review:'APPROVE_AND_RELEASE'}),before=await f.repo.readView(),old=legacyObjects(before),original=await f.repo.readDocumentRevision(v1.plan.sourceRevisionId),graph=await f.repo.getAux('domain-graph','current'),directory=await f.repo.getAux('material-directory','current');
 const w=await workspace(f.repo);assert.equal(w.mode,'REVISION');assert.deepEqual(w.blockers,[]);assert.equal(w.parentVersionId,v1.candidate.versionId);assert.equal(w.parentVersionSha256,v1.candidate.sha256);assert.equal(w.plannedVersionLabel,'V002');assert.equal(w.currentDefinitionId,v1.definition.id);assert.equal(w.draft,null);assert.equal(w.staleDraft.content.prompt,'第一母版。');assert.equal(w.defaults.prompt,'第一母版。');
 const revision=await provision(f.repo,'根据明确意见优化第二版。','second'),after=await f.repo.readView();assert.equal(revision.familyId,v1.plan.familyId);assert.equal(revision.workItemId,v1.plan.workItemId);assert.equal(revision.parentVersionId,v1.candidate.versionId);assert.equal(after.snapshot.productionModel.materialProductionPlans.length,1);assert.equal(after.snapshot.productionModel.materialProductionRecipeRevisions.length,1);assert.equal(after.snapshot.productionModel.assetFamilies.length,before.snapshot.productionModel.assetFamilies.length);assert.equal(after.snapshot.productionModel.materialWorkItems.length,before.snapshot.productionModel.materialWorkItems.length);assert.equal(after.eventsByKind.review.length,before.eventsByKind.review.length);assert.equal(after.eventsByKind['asset-version'].length,1);assert.equal((await f.repo.listMedia()).length,1);assert.deepEqual(legacyObjects(after),old);
 const eo2=after.snapshot.productionModel.expectedOutputs.find(o=>o.id===revision.expectedOutputId),def2=after.recipes.executionDefinitions.find(d=>d.id===revision.definitionId);assert.equal(eo2.plannedVersionLabel,'V002');assert.equal(eo2.legacyVersionId,v1.plan.expectedOutputId);assert.equal(def2.parentVersionId,v1.candidate.versionId);assert.equal(eo2.realizedVersionId,null);assert.equal(def2.prompt.main,'根据明确意见优化第二版。');assert.deepEqual(after.recipes.executionDefinitions.find(d=>d.id===v1.definition.id),v1.definition);assert.deepEqual(await f.repo.readDocumentRevision(v1.plan.sourceRevisionId),original);assert.deepEqual(await f.repo.getAux('domain-graph','current'),graph);assert.deepEqual(await f.repo.getAux('material-directory','current'),directory);assert.deepEqual(after.snapshot.productionModel.reviewContexts,before.snapshot.productionModel.reviewContexts);
 const projected=api.projectOperationalState(after.snapshot,after.eventsByKind.review,after.eventsByKind['asset-version']);assert.equal(projected.assetFamiliesById[v1.plan.familyId].currentVersionId,v1.candidate.versionId);assert.equal(projected.assetVersionsById[v1.candidate.versionId].canFlowDownstream,true);
 assert((await workspace(f.repo)).blockers.some(x=>/尚未形成/.test(x)));await assert.rejects(provision(f.repo,'不应跳过第二版实际生成。','premature'));
 const v2=await register(f),third=await provision(f.repo,'回到母版制作第三个候选。','third');assert.equal(third.parentVersionId,v2.candidate.versionId);assert.equal(third.plannedVersionLabel,'V003');
 const {result}=await preserve(f.repo),latest=await f.repo.readView();assert.deepEqual(result.recipes,latest.recipes);for(const key of ['materialProductionPlans','materialProductionRecipeRevisions','assetFamilies','expectedOutputs','materialWorkItems','reviewContexts'])assert.deepEqual(result.snapshot.productionModel[key],latest.snapshot.productionModel[key],key);
 assert.equal((await f.repo.readDocumentRevision(v1.plan.sourceRevisionId)).sha256,original.sha256);
});

test('revision draft requires exact same-release Review/Run basis and worker rejects changed parent state atomically',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'母版。','first');const v1=await register(f),w=await workspace(f.repo),before=await f.repo.exportState();
 await assert.rejects(f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,content:content('更改。')},{api})),/基线/);assert.deepEqual(await f.repo.exportState(),before);
 const s=await stage(f.repo,'精确当前输入。'),job=await queue(f.repo,s,'revision');await event(f.repo,'review',{subjectType:'ASSET',familyId:v1.plan.familyId,versionId:v1.candidate.versionId,versionSha256:v1.candidate.sha256,action:'DO_NOT_USE',applicationStatus:'APPLIED',effect:'APPLIED'});const current=await f.repo.exportState();
 await assert.rejects(f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api})),/基线|输入/);assert.deepEqual(await f.repo.exportState(),current);assert.equal((await f.repo.readView()).releaseId,w.releaseId);
});

for(const state of ['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN','SUCCEEDED'])test('revision blocks unresolved '+state+' Run even when an older candidate exists',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'母版。','first');const v1=await register(f);await event(f.repo,'run',{executionRequestId:'unknown-request',executionDefinitionId:v1.definition.id,callPackageHash:v1.definition.definitionHash,runId:'new-run',runState:state});const w=await workspace(f.repo);assert(w.blockers.some(x=>/Run/.test(x)));await assert.rejects(stage(f.repo,'禁止未核清结果时另起版本。'),/Run/);
});
for(const metadata of [{authorityDomain:'PRIVATE'},{authorityDomain:'LOCAL_TRIAL'},{authorityDomain:'FORMAL',visibility:'PRIVATE'}])test('revision rejects nonformal parent '+JSON.stringify(metadata),async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'母版。','first');await register(f,{metadata});assert((await workspace(f.repo)).blockers.some(x=>/父版本/.test(x)));await assert.rejects(stage(f.repo,'不能借返修洗白。'),/父版本/);
});

test('revision queue CAS and host rollback preserve prior adopted candidate and immutable recipe history',async t=>{
 const f=await materialProductionFixture(t);await provision(f.repo,'母版。','first');await register(f);const s=await stage(f.repo,'新候选。'),job=await queue(f.repo,s,'second');assert.deepEqual(await queue(f.repo,s,'second'),job);await assert.rejects(queue(f.repo,s,'concurrent'),/已有/);const before=await f.repo.exportState();
 await assert.rejects(f.repo.writeTransaction(tx=>{tx.publishRelease=async()=>{throw Error('injected revision transaction rollback');};return applyMaterialProductionJob(tx,{jobId:job.jobId,api});}),/injected/);assert.deepEqual(await f.repo.exportState(),before);
 await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));const {input}=await preserve(f.repo);
 for(const mutate of [i=>i.documents=i.documents.filter(d=>d.metadata.sourceRole!=='MATERIAL_PRODUCTION_RECIPE'),i=>i.baseSnapshot.productionModel.materialProductionRecipeRevisions[0].sourceSha256='0'.repeat(64),i=>i.baseSnapshot.productionModel.materialProductionRecipeRevisions[0].parentVersionId='other-family@V001',i=>i.baseSnapshot.productionModel.materialProductionRecipeRevisions.push(structuredClone(i.baseSnapshot.productionModel.materialProductionRecipeRevisions[0])),i=>i.baseRecipes.executionDefinitions.find(d=>d.id===i.baseSnapshot.productionModel.materialProductionRecipeRevisions[0].definitionId).parentVersionId=null]){const broken=structuredClone(input);mutate(broken);assert.throws(()=>preserveMaterialProductionProjection(broken),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});}
});

test('first native material setup retains original row evidence after a source advances and still verifies historical bytes',async t=>{
 const f=await materialProductionFixture(t);let original;
 await f.repo.writeTransaction(async tx=>{const view=await tx.readView();original=await tx.putDocument({documentId:'native-history',aliases:['story/native-history.md'],expectedRevisionId:null,bytes:'原人物身份说明。',metadata:{sourceRole:'SOURCE_DOCUMENT'}});await tx.publishRelease({snapshot:view.snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,original.revisionId]});});
 const rep=(await f.repo.readView()).snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId),evidence={sourceId:'source_'+original.sha256,revisionId:original.revisionId,sha256:original.sha256,locator:'原身份说明',quote:'原人物身份说明'};
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,evidence:[evidence]}}]);
 await f.repo.writeTransaction(async tx=>{const view=await tx.readView(),fresh=await tx.putDocument({documentId:original.documentId,expectedRevisionId:original.revisionId,bytes:'已发布的新来源说明。',metadata:{sourceRole:'SOURCE_DOCUMENT'}});await tx.publishRelease({snapshot:view.snapshot,recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds.filter(id=>id!==original.revisionId),fresh.revisionId]});});
 const s=await stage(f.repo,'只为原表现添加正式制作族。');assert.deepEqual(s.preview.plan.graphBinding.beforeRepresentation.evidence,[evidence]);assert.deepEqual(s.preview.plan.graphBinding.afterRepresentation.evidence,[evidence]);
 for(const fault of [()=>null,doc=>({...doc,bytes:Buffer.from('changed bytes')}),doc=>({...doc,sha256:'f'.repeat(64)})])await assert.rejects(f.repo.readTransaction(tx=>{const read=tx.readDocumentRevision.bind(tx);tx.readDocumentRevision=async id=>{const doc=await read(id);return id===original.revisionId?fault(doc):doc;};return previewMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:s.saved.revisionId},{api});}),/历史来源/);
 const job=await queue(f.repo,s,'historic-first');await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}));const after=await f.repo.readView();assert(!after.sourceRevisionIds.includes(original.revisionId));assert.deepEqual(after.snapshot.productionModel.domainGraph.representations.find(r=>r.id===rep.id).evidence,[evidence]);assert.equal(after.eventsByKind.review?.length||0,0);
});
