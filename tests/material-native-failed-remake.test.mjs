import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,lstat,realpath,symlink} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {materialProductionFixture,imageRequirementId,legacyObjects} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {assertFailedMaterialAttempt} from '../host/instance-runtime/material-production-failed-attempt.mjs';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
import {preserveMaterialProductionProjection} from '../host/instance-runtime/material-production-preservation.mjs';

// Real repository/append-only media and event fixtures; approval projection is
// intentionally narrow here. The separate PostgreSQL API suite exercises the
// real authorization, Review and candidate consumers without a provider call.
const baseApi={projectOperationalState(snapshot,reviews,candidates){
 const model=snapshot.productionModel,versions=[...model.assetVersions,...candidates.map(c=>({...c,id:c.versionId,outputState:'PRESENT'}))],families=model.assetFamilies.map(f=>({...f}));
 for(const f of families){const adopted=reviews.find(e=>e.familyId===f.id&&e.action==='APPROVE_AND_RELEASE'&&e.applicationStatus==='APPLIED');if(adopted){f.currentVersionId=adopted.versionId;const v=versions.find(v=>v.id===adopted.versionId);Object.assign(v,{canFlowDownstream:true,lifecycleState:'RELEASED'});}}
 return {assetFamiliesById:Object.fromEntries(families.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(versions.map(v=>[v.id,v]))};
}};
const content=prompt=>({model:'codex:gpt-image-2',prompt,negativePrompt:'无不明人物或漂移。',parameters:{width:1024,height:1024},inputBindings:[]});
const apis=new WeakMap();
const workspace=repo=>repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api:apis.get(repo)}));
async function stage(repo,prompt='干净人物母版。'){
 const w=await workspace(repo),saved=await repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:w.basisHash,content:content(prompt)},{api:apis.get(repo)})),preview=await repo.readTransaction(tx=>previewMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:saved.revisionId},{api:apis.get(repo)}));
 return {w,saved,preview};
}
async function queue(repo,s,key){return repo.writeTransaction(tx=>enqueueMaterialProduction(tx,{requirementId:imageRequirementId,draftRevisionId:s.saved.revisionId,previewHash:s.preview.previewHash,requestId:key},{api:apis.get(repo)}));}
async function provision(repo,prompt,key){const s=await stage(repo,prompt),job=await queue(repo,s,key);return repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api:apis.get(repo)}));}
let nextEvent=0;
async function event(repo,kind,payload){const id='failed-remake-fixture:'+String(++nextEvent);return (await repo.writeTransaction(tx=>tx.appendEvent({kind,idempotencyKey:id,requestHash:sha256(id),eventSchemaVersion:'2.2',payload}))).event;}
async function register(f,{review='REQUEST_REVISION',metadata={authorityDomain:'FORMAL'},label}={}){
 const view=await f.repo.readView(),plan=view.snapshot.productionModel.materialProductionPlans[0],work=view.snapshot.productionModel.materialWorkItems.find(w=>w.id===plan.workItemId),definition=view.recipes.executionDefinitions.find(d=>d.id===work.executionDefinitionRef),output=view.snapshot.productionModel.expectedOutputs.find(o=>o.id===definition.output.expectedOutputRef),versionId=plan.familyId+'@'+(label||output.plannedVersionLabel),bytes=Buffer.from('isolated fixture '+versionId);
 await mkdir(path.dirname(path.join(f.root,output.targetPath)),{recursive:true});await writeFile(path.join(f.root,output.targetPath),bytes,{flag:'wx'});
 const executionRequestId='request:'+versionId,runId='run:'+versionId,runBinding={executionRequestId,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,inputBindingsHash:domainHash([])};
 await event(f.repo,'execution-request',{...runBinding,workItemId:work.id,familyId:plan.familyId,executor:'CODEX',requestState:'CLAIMED',maxOutputs:1,snapshotId:view.snapshot.snapshotId});
 await event(f.repo,'run',{...runBinding,runId,runState:'SUCCEEDED'});
 await f.repo.writeTransaction(tx=>tx.registerMedia({mediaId:plan.familyId,versionId,relativePath:output.targetPath,sha256:sha256(bytes),byteSize:bytes.length,aliases:[output.targetPath],metadata}));
 const candidate=await event(f.repo,'asset-version',{...runBinding,runId,familyId:plan.familyId,versionId,expectedOutputId:output.id,path:output.targetPath,sha256:sha256(bytes),parentVersionId:definition.parentVersionId,inputBindings:[],lifecycleState:'REVIEW_PENDING',projectRightsGate:'UNKNOWN'});
 if(review)await event(f.repo,'review',{subjectType:'ASSET',familyId:plan.familyId,versionId,versionSha256:candidate.sha256,action:review,effect:'APPLIED',applicationStatus:'APPLIED'});
 return {plan,work,definition,output,candidate};
}
async function preserve(repo){const view=await repo.readView(),documents=await Promise.all(view.sourceRevisionIds.map(id=>repo.readDocumentRevision(id))),snapshot=structuredClone(view.snapshot),recipes=structuredClone(view.recipes),model=snapshot.productionModel,plans=model.materialProductionPlans,ids=new Set(plans.map(p=>p.familyId)),works=new Set(plans.map(p=>p.workItemId));
 for(const key of ['assetFamilies','assetVersions','expectedOutputs'])model[key]=model[key].filter(row=>!ids.has(row.familyId||row.id));
 model.materialWorkItems=model.materialWorkItems.filter(w=>!works.has(w.id));model.reviewContexts=[];model.materialProductionPlans=[];model.materialProductionRecipeRevisions=[];recipes.executionDefinitions=recipes.executionDefinitions.filter(d=>!works.has(d.workItemRef));recipes.promptRevisions=[];
 return {input:{snapshot,recipes,baseSnapshot:view.snapshot,baseRecipes:view.recipes,documents},result:preserveMaterialProductionProjection({snapshot,recipes,baseSnapshot:view.snapshot,baseRecipes:view.recipes,documents})};
}

async function fixture(t){
 const f=await materialProductionFixture(t);
 const api={...baseApi,safeGeneratedPath:async(logical,b)=>{const m=await f.repo.resolveMedia(logical,b);assert(m);const file=path.join(f.root,m.relativePath);assert.equal(sha256(await readFile(file)),m.sha256);return file;},safeReviewPendingPath:async relative=>{assert(relative.startsWith('media/_review_pending/material-production/'));let p=f.root;for(const part of relative.split('/')){p=path.join(p,part);assert.equal((await lstat(p)).isSymbolicLink(),false,'Symbolic link output is unresolved');assert.equal(await realpath(p),p);}return p;}};
 apis.set(f.repo,api);await provision(f.repo,'Original actual fixture.','first');const v1=await register(f,{review:'APPROVE_AND_RELEASE'});await provision(f.repo,'Immutable attempted recipe.','second');const view=await f.repo.readView(),definition=view.recipes.executionDefinitions.find(d=>d.output.path.endsWith('/V002.png')),output=view.snapshot.productionModel.expectedOutputs.find(o=>o.id===definition.output.expectedOutputRef);
 return {...f,v1,definition,output,api};
}
async function attempt(f,{state='FAILED',requestState='CLAIMED',requestId='request:failed-second',hash=f.definition.definitionHash}={}){
 const binding={executionRequestId:requestId,executionDefinitionId:f.definition.id,callPackageHash:hash,inputBindingsHash:domainHash([])};
 await event(f.repo,'execution-request',{...binding,workItemId:f.v1.work.id,familyId:f.v1.plan.familyId,requestState,maxOutputs:1,inputBindings:[]});
 const run=await event(f.repo,'run',{...binding,runId:'run:'+requestId,runState:state,note:'Synthetic HTTP 400 moderation_blocked response; no returned media, no provider call in test.'});return run;
}
for(const terminal of ['FAILED','CANCELLED'])test('explicit '+terminal+' with no output appends V003 and retains actual V001 parent plus complete failed V002 source',async t=>{
 const f=await fixture(t),failed=await attempt(f,{state:terminal}),before=await f.repo.readView(),old=legacyObjects(before),original=await readFile(path.join(f.root,f.v1.output.targetPath)),w=await workspace(f.repo);
 assert.deepEqual(w.blockers,[]);assert.equal(w.parentVersionId,f.v1.candidate.versionId);assert.equal(w.parentVersionSha256,f.v1.candidate.sha256);assert.equal(w.plannedVersionLabel,'V003');assert.equal(w.basis.revision.failedAttempt.schemaVersion,'FAILED_OUTPUT_REMAKE_V1');assert.deepEqual(w.basis.revision.failedAttempt.runs,[failed]);
 const third=await provision(f.repo,'Fully clothed nonsexual museum sculpture.','third');assert.equal(third.plannedVersionLabel,'V003');assert.equal(third.parentVersionId,f.v1.candidate.versionId);
 const after=await f.repo.readView(),row=after.snapshot.productionModel.materialProductionRecipeRevisions.at(-1),source=await f.repo.readDocumentRevision(row.sourceRevisionId),body=JSON.parse(source.bytes);
 assert.equal(body.previousDefinitionId,f.definition.id);assert.equal(body.previousExpectedOutputId,f.output.id);assert.equal(body.parentVersionId,f.v1.candidate.versionId);assert.equal(body.executionDefinition.parentVersionSha256,f.v1.candidate.sha256);assert.deepEqual(body.basis.revision.failedAttempt.runs,[failed]);assert.match(body.basis.revision.failedAttempt.runs[0].note,/moderation_blocked/);
 assert.deepEqual(after.eventsByKind,before.eventsByKind);assert.deepEqual(after.recipes.executionDefinitions.find(d=>d.id===f.definition.id),f.definition);assert.deepEqual(after.snapshot.productionModel.expectedOutputs.find(o=>o.id===f.output.id),f.output);assert.deepEqual(legacyObjects(after),old);assert.deepEqual(await readFile(path.join(f.root,f.v1.output.targetPath)),original);assert.equal((await f.repo.listMedia()).length,1);
 const {result}=await preserve(f.repo);assert.deepEqual(result.recipes,after.recipes);assert.deepEqual(result.snapshot.productionModel.materialProductionRecipeRevisions,after.snapshot.productionModel.materialProductionRecipeRevisions);
 const v3=await register(f,{review:'APPROVE_AND_RELEASE'});assert.equal(v3.candidate.versionId,f.v1.plan.familyId+'@V003');assert.equal(v3.candidate.parentVersionId,f.v1.candidate.versionId);assert.equal((await workspace(f.repo)).parentVersionId,v3.candidate.versionId);await preserve(f.repo);
 const proof=body.basis.revision.failedAttempt,bindings={definition:f.definition,output:f.output,parentCandidate:f.v1.candidate,parentDefinition:f.v1.definition,parentOutput:f.v1.output,fail:message=>{throw Error(message);}};
 for(const mutate of [p=>p.runs[0].runState='RESULT_UNKNOWN',p=>p.runs[0].callPackageHash='0'.repeat(64),p=>p.requests[0].requestState='AUTHORIZED',p=>p.requests=[],p=>p.absence.fileState='PRESENT',p=>p.parentRun.runState='FAILED',p=>p.parentDefinitionId=f.definition.id,p=>p.parentMedia.sha256='0'.repeat(64)]){const broken=structuredClone(proof);mutate(broken);assert.throws(()=>assertFailedMaterialAttempt(broken,bindings));}
});
for(const state of ['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN','SUCCEEDED'])test('unproduced output '+state+' is never a failed-remake parent or permission',async t=>{const f=await fixture(t);await attempt(f,{state});const w=await workspace(f.repo);assert(w.blockers.length);const before=await f.repo.exportState();await assert.rejects(stage(f.repo,'Blocked.'),/Run|失败|基线/);assert.deepEqual(await f.repo.exportState(),before);});
for(const fault of ['no-run','authorized-unused','unknown-request','mismatched-hash','orphan-file','symlink-file','registered-fileless','other-family-alias','candidate-without-media','parent-bytes-changed','missing-inspector'])test('failed remake refuses '+fault+' without a write',async t=>{
 const f=await fixture(t);if(fault!=='no-run')await attempt(f,{...(fault==='unknown-request'?{requestState:'RESULT_UNKNOWN'}:{}),...(fault==='mismatched-hash'?{hash:'0'.repeat(64)}:{})});
 if(fault==='authorized-unused')await event(f.repo,'execution-request',{executionRequestId:'unused',executionDefinitionId:f.definition.id,callPackageHash:f.definition.definitionHash,workItemId:f.v1.work.id,familyId:f.v1.plan.familyId,requestState:'AUTHORIZED',maxOutputs:1});
 if(fault==='orphan-file')await writeFile(path.join(f.root,f.output.targetPath),'orphan bytes',{flag:'wx'});
 if(fault==='symlink-file')await symlink(path.join(f.root,f.v1.output.targetPath),path.join(f.root,f.output.targetPath));
 if(['registered-fileless','other-family-alias'].includes(fault))await f.repo.writeTransaction(tx=>tx.registerMedia({mediaId:fault==='other-family-alias'?'unrelated-family':f.v1.plan.familyId,versionId:fault==='other-family-alias'?'unrelated@V001':f.v1.plan.familyId+'@V002',relativePath:'media/blobs/orphan.png',sha256:'0'.repeat(64),byteSize:12,aliases:fault==='other-family-alias'?[f.output.targetPath]:[],metadata:{authorityDomain:'FORMAL'}}));
 if(fault==='candidate-without-media')await event(f.repo,'asset-version',{familyId:f.v1.plan.familyId,versionId:f.v1.plan.familyId+'@V002',expectedOutputId:f.output.id,path:f.output.targetPath,sha256:'0'.repeat(64),executionDefinitionId:f.definition.id,callPackageHash:f.definition.definitionHash});
 if(fault==='parent-bytes-changed')await writeFile(path.join(f.root,f.v1.output.targetPath),'corrupted fixture');
 if(fault==='missing-inspector')delete f.api.safeReviewPendingPath;
 const before=await f.repo.exportState(),w=await workspace(f.repo);assert(w.blockers.length,JSON.stringify(w));await assert.rejects(stage(f.repo,'Blocked.'));assert.deepEqual(await f.repo.exportState(),before);
});
test('failed-remake CAS, queue replay and worker revalidation preserve original failed attempt on late media or changed Run',async t=>{
 const f=await fixture(t);await attempt(f);const w=await workspace(f.repo),before=await f.repo.exportState();
 await assert.rejects(f.repo.writeTransaction(tx=>saveMaterialProductionDraft(tx,{requirementId:imageRequirementId,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId,expectedBasisHash:'0'.repeat(64),content:content('Changed safe recipe.')},{api:f.api})),/基线/);assert.deepEqual(await f.repo.exportState(),before);
 const s=await stage(f.repo,'Reviewed safe recipe.'),job=await queue(f.repo,s,'recovery');assert.deepEqual(await queue(f.repo,s,'recovery'),job);await assert.rejects(queue(f.repo,s,'other'),/已有/);
 await writeFile(path.join(f.root,f.output.targetPath),'late unregistered output',{flag:'wx'});const queued=await f.repo.exportState();await assert.rejects(f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api:f.api})),/实际文件|失败重制|基线/);assert.deepEqual(await f.repo.exportState(),queued);
});
test('a new unresolved request after saving invalidates the exact failure basis',async t=>{
 const f=await fixture(t);await attempt(f);const s=await stage(f.repo,'Safe corrected prompt.');await attempt(f,{state:'RESULT_UNKNOWN',requestId:'new-unresolved'});const before=await f.repo.exportState();await assert.rejects(queue(f.repo,s,'stale-failure-basis'),/变化|Run|失败/);assert.deepEqual(await f.repo.exportState(),before);
});

test('consecutive failed slots keep the same actual parent and allocate a fresh output each time',async t=>{
 const f=await fixture(t);await attempt(f);const third=await provision(f.repo,'Corrected safe prompt.','third-fails'),view=await f.repo.readView();f.definition=view.recipes.executionDefinitions.find(d=>d.id===third.definitionId);f.output=view.snapshot.productionModel.expectedOutputs.find(o=>o.id===third.expectedOutputId);await attempt(f,{requestId:'request:failed-third'});
 const fourth=await provision(f.repo,'Another reviewed safe definition.','fourth');assert.equal(fourth.plannedVersionLabel,'V004');assert.equal(fourth.parentVersionId,f.v1.candidate.versionId);const final=await f.repo.readView();assert.equal(final.eventsByKind['asset-version'].length,1);assert.equal(final.snapshot.productionModel.expectedOutputs.filter(o=>o.familyId===f.v1.plan.familyId).length,4);await preserve(f.repo);
});
