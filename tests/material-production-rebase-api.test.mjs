import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {validateArchive,createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {writeArchiveFile} from '../host/instance-runtime/archive-file.mjs';
import {openArchiveRowsWithBinding,validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';
import {importRepositoryState,restoreInstanceRepository} from '../host/instance-runtime/index.mjs';
import {nativeMaterialCandidateProof,assertNativeCandidatePreservation} from '../host/instance-native-candidate-proof.mjs';
import assert from 'node:assert/strict';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain,imageRequirementId} from './material-production-fixture.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {getMaterialProductionWorkspace,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';
const jobStatus=async(f,jobId)=>{const response=await f.material.GET(new Request('http://localhost/api/instance/material-production?requirementId='+encodeURIComponent(imageRequirementId)+'&jobId='+encodeURIComponent(jobId)));assert.equal(response.status,200,await response.clone().text());return response.json();};
const options={skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000};
const mode='REQUIREMENT_REBASE';
const get=f=>f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,mode,api:f.adapter}));
async function setup(t){
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'Original isolated reference state; no provider.'),v1=await f.register(first,await f.beginRun(first),pngs[0]);await f.review(first,v1,'REQUEST_REVISION');
 const before=await f.repo.readView(),plan=before.snapshot.productionModel.materialProductionPlans[0],rep=before.snapshot.productionModel.domainGraph.representations.find(r=>r.id===plan.representationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'Explicit new static reference state; unchanged permanent ownership'}}]);
 return {f,first,v1,before,plan};
}
async function queue(f,w){
 const acknowledgement={confirmed:true,beforeHash:w.rebase.beforeHash,afterHash:w.rebase.afterHash,note:'Explicitly use the newly published state while keeping the original fixed review standard.'};
 const saved=await f.materialPost({...f.saveBody(w,'New isolated state candidate recipe; no provider.'),mode,acknowledgement});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const preview=await f.materialPost({action:'preview',mode,draftRevisionId:saved.body.revisionId});assert.equal(preview.status,200,JSON.stringify(preview.body));
 const queued=await f.materialPost({action:'publish',mode,draftRevisionId:saved.body.revisionId,previewHash:preview.body.previewHash});assert.equal(queued.status,200,JSON.stringify(queued.body));return{saved,preview,queued};
}
test('explicit native requirement rebase keeps original history and enables only a newly authored candidate under the changed current basis',options,async t=>{
 const {f,first,v1,before,plan}=await setup(t);
 await assert.rejects(f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api:f.adapter})),/偏离首次/);
 const w=await get(f);assert.equal(w.mode,mode);assert.deepEqual(w.blockers,[]);assert.equal(w.parentVersionId,v1.versionId);assert.equal(w.plannedVersionLabel,'V002');
 const {queued}=await queue(f,w);assert.equal((await jobStatus(f,queued.body.jobId)).status,'QUEUED');const result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter}));assert.equal(result.mode,mode);assert.equal((await jobStatus(f,queued.body.jobId)).status,'SUCCEEDED');await assert.rejects(get(f),/变化|改变|差异/);
 const next=await f.repo.readView(),recipe=next.recipes.executionDefinitions.find(d=>d.id===result.definitionId);assert.deepEqual(next.snapshot.productionModel.materialProductionPlans,before.snapshot.productionModel.materialProductionPlans);assert.deepEqual(next.recipes.executionDefinitions.find(d=>d.id===first.recipe.id),first.recipe);assert.deepEqual(next.eventsByKind,before.eventsByKind);assert.equal(recipe.parentVersionId,v1.versionId);assert.equal(recipe.parentVersionSha256,v1.sha256);
 assert.equal(next.snapshot.productionModel.reviewContexts.filter(c=>c.requirementId===imageRequirementId).length,2);assert.deepEqual(await f.repo.readDocumentRevision(plan.sourceRevisionId),await f.repo.readDocumentRevision(before.snapshot.productionModel.materialProductionPlans[0].sourceRevisionId));
 const current=await f.workspace();assert.equal(current.mode,'REVISION');assert.equal(current.currentDefinitionId,recipe.id);
 const p={result,recipe},v2=await f.register(p,await f.beginRun(p),pngs[1]);await f.review(p,v2,'REQUEST_REVISION');
 const third=await f.provision(await f.workspace(),'Ordinary successor preserves the new explicit semantic baseline.',{expectedMode:'REVISION'});assert.equal(third.recipe.materialProductionRequirementRebaseId,recipe.materialProductionRequirementRebaseId);assert.equal(third.recipe.parentVersionId,v2.versionId);
 const end=await f.repo.readView(),documents=await Promise.all(end.sourceRevisionIds.map(id=>f.repo.readDocumentRevision(id))),events=Object.values(end.eventsByKind).flat(),pinnedMediaHashes={};
 for(const candidate of end.eventsByKind['asset-version']){pinnedMediaHashes[candidate.path]=sha256(await readFile(path.join(f.root,candidate.path)));assert.equal(pinnedMediaHashes[candidate.path],candidate.sha256);}
 const proof=nativeMaterialCandidateProof({documents,events,activeMedia:await f.repo.listMedia(),pinnedMediaHashes,baseRelease:await f.repo.readRelease(),compiler:{eventDirectory:'events'}});
 assert.equal(proof.records.length,2);assert.ok(proof.records.every(record=>record.sourceProof.filter(source=>source.path.startsWith('story/material-production/domain-bases/')).length===2));assert.equal(assertNativeCandidatePreservation({proof,snapshot:end.snapshot,recipes:end.recipes,events}).eventsPreserved,true);
 const archive=await f.repo.exportState();validateArchive(archive,f.profile.instanceId);
 const filename=path.join(f.root,'rebase-archive.jsonl'),file=await writeArchiveFile(filename,archive),reader=await openArchiveRowsWithBinding(filename,file);try{assert.equal((await validateArchiveRows(reader,{instanceId:f.profile.instanceId,createValidator:createArchiveStreamValidator})).exportSha256,archive.exportSha256);}finally{await reader.close();}
 const restored=await importRepositoryState({archive,dbPath:path.join(f.root,'restored-rebase.sqlite'),instanceId:f.profile.instanceId});t.after(()=>restored.close());
 const restoredArchive=await restored.exportState();assert.notEqual((await restored.getMetadata()).runtimeEpoch,(await f.repo.getMetadata()).runtimeEpoch);
 for(const table of ['record_revisions','document_aliases','domain_events','releases','media_versions','media_aliases'])assert.deepEqual(restoredArchive.tables[table],archive.tables[table],table+' original rows survive restored epoch');
 validateArchive(restoredArchive,f.profile.instanceId);
 const backup=await restored.backupTo(path.join(f.root,'rebase-backup.sqlite')),rawRestored=await restoreInstanceRepository({backupPath:backup.path,expectedSha256:backup.sha256,dbPath:path.join(f.root,'rebase-raw-restored.sqlite'),instanceId:f.profile.instanceId});t.after(()=>rawRestored.close());
 const rawArchive=await rawRestored.exportState();for(const table of ['record_revisions','document_aliases','domain_events','releases','media_versions','media_aliases'])assert.deepEqual(rawArchive.tables[table],archive.tables[table],table+' original rows survive raw SQLite restore');


 assert.equal(f.externalCalls(),0);
});

test('rebase requires explicit current acknowledgement and mode at save, preview and worker; stale source never publishes',options,async t=>{
 const {f,first}=await setup(t),w=await get(f),body={...f.saveBody(w,'New scope content.'),mode},unchanged=await f.repo.exportState();
 for(const acknowledgement of [undefined,{confirmed:false,beforeHash:w.rebase.beforeHash,afterHash:w.rebase.afterHash,note:'no'},{confirmed:true,beforeHash:w.rebase.afterHash,afterHash:w.rebase.beforeHash,note:'wrong source'}]){
  const result=await f.materialPost({...body,...(acknowledgement?{acknowledgement}:{})});assert.equal(result.status,409,JSON.stringify(result.body));assert.deepEqual(await f.repo.exportState(),unchanged);
 }
 const old=await f.post(f.requests,'v8/execution-requests',{action:'AUTHORIZE',workItemId:first.result.workItemId,familyId:first.result.familyId,executionDefinitionId:first.recipe.id,callPackageHash:first.recipe.definitionHash,executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:[]});assert.equal(old.status,422,JSON.stringify(old.body));assert.ok(JSON.stringify(old.body).includes('MATERIAL_REQUIREMENT_BASIS_CHANGED'));assert.deepEqual(await f.repo.exportState(),unchanged);
 const {saved,queued}=await queue(f,w);for(const changedMode of [undefined,'REVISION','UNKNOWN']){const response=await f.materialPost({action:'preview',draftRevisionId:saved.body.revisionId,...(changedMode?{mode:changedMode}:{})});assert.ok([409,422].includes(response.status),JSON.stringify(response));}
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:'prop:unrelated-rebase-cas',beforeHash:null,value:{id:'prop:unrelated-rebase-cas',type:'PROP',name:'Unrelated publication advances exact CAS',aliases:[],description:'Test only',authority:'A',evidence:[]}}]);
 const before=await f.repo.exportState();await assert.rejects(f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter})),/变化/);assert.deepEqual(await f.repo.exportState(),before);
 assert.equal(f.externalCalls(),0);
});

test('rebase cannot move permanent ownership or accept a missing actual parent even when the projected candidate exists',options,async t=>{
 const {f,first,v1}=await setup(t),w=await get(f);const snapshot=await f.repo.exportState();
 await assert.rejects(f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,mode,api:{...f.adapter,safeGeneratedPath:async()=>{throw Object.assign(Error('actual PNG unavailable'),{code:'ENOENT'});}}})),/actual PNG/);assert.deepEqual(await f.repo.exportState(),snapshot);
 const view=await f.repo.readView(),rep=view.snapshot.productionModel.domainGraph.representations.find(r=>r.id===w.representation.id);
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:'character:other-rebase',beforeHash:null,value:{id:'character:other-rebase',type:'CHARACTER',name:'Other permanent identity',aliases:[],description:'Independent test identity',authority:'A',evidence:[]}}]);
 const moved=await f.repo.exportState();await assert.rejects(changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,entityId:'character:other-rebase'}}]),/永久身份/);assert.deepEqual(await f.repo.exportState(),moved);assert.equal((await f.repo.getMedia(first.result.familyId,v1.versionId)).sha256,v1.sha256);assert.equal(f.externalCalls(),0);
});

test('same-family CLAIMED and RESULT_UNKNOWN real requests block requirement rebase across a later domain publication',options,async t=>{
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'Initial fixed fixture'),v1=await f.register(first,await f.beginRun(first),pngs[0]);await f.review(first,v1,'REQUEST_REVISION');
 const next=await f.provision(await f.workspace(),'Outstanding new attempt',{expectedMode:'REVISION'}),run=await f.beginRun(next);
 const unknown=await f.post(f.runs,'v8/runs',{...run,state:'RESULT_UNKNOWN',note:'Fixture explicitly unknown; do not retry or infer failure.'});assert.equal(unknown.status,201,JSON.stringify(unknown.body));
 const current=await f.repo.readView(),rep=current.snapshot.productionModel.domainGraph.representations.find(r=>r.id===current.snapshot.productionModel.materialProductionPlans[0].representationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'Changed current semantic basis with unknown old request'}}]);
 const before=await f.repo.exportState(),w=await get(f);assert.ok(w.blockers.some(r=>/Run|授权/.test(r)),JSON.stringify(w.blockers));
 const response=await f.materialPost({...f.saveBody(w,'Must not be saved'),mode,acknowledgement:{confirmed:true,beforeHash:w.rebase.beforeHash,afterHash:w.rebase.afterHash,note:'No override allowed'}});assert.equal(response.status,409,JSON.stringify(response.body));assert.deepEqual(await f.repo.exportState(),before);assert.equal(f.externalCalls(),0);
});

test('a failed rebased output retains the actual old parent, then a second rebase reuses historical domain sources without duplication',options,async t=>{
 const {f,v1}=await setup(t),w=await get(f),{queued}=await queue(f,w),result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter}));let view=await f.repo.readView();
 const second={result,recipe:view.recipes.executionDefinitions.find(d=>d.id===result.definitionId)},run=await f.beginRun(second),failed=await f.post(f.runs,'v8/runs',{...run,state:'FAILED',note:'Explicit failure without any output in this isolated fixture.'});assert.equal(failed.status,201,JSON.stringify(failed.body));
 const afterFailure=await f.workspace();assert.deepEqual(afterFailure.blockers,[]);assert.equal(afterFailure.parentVersionId,v1.versionId);assert.equal(afterFailure.plannedVersionLabel,'V003');
 const third=await f.provision(afterFailure,'Retry new semantic basis using actual old parent only as provenance',{expectedMode:'REVISION'}),v3=await f.register(third,await f.beginRun(third),pngs[1]);await f.review(third,v3,'REQUEST_REVISION');
 view=await f.repo.readView();const priorRows=structuredClone(view.snapshot.productionModel.materialProductionRecipeRevisions),rep=view.snapshot.productionModel.domainGraph.representations.find(r=>r.id===view.snapshot.productionModel.materialProductionPlans[0].representationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,label:'Second explicit actual semantic amendment'}}]);
 const w2=await get(f);assert.equal(w2.plannedVersionLabel,'V004');assert.equal(w2.parentVersionId,v3.versionId);const q=await queue(f,w2),fourth=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:q.queued.body.jobId,api:f.adapter}));assert.equal(fourth.mode,mode);
 const end=await f.repo.readView(),rows=end.snapshot.productionModel.materialProductionRecipeRevisions;assert.deepEqual(rows.slice(0,-1),priorRows);assert.equal(rows.at(-1).domainSources.before.revisionId,rows[0].domainSources.after.revisionId);assert.equal(new Set(end.sourceRevisionIds).size,end.sourceRevisionIds.length);assert.equal(await f.repo.getMedia(second.result.familyId,second.result.familyId+'@V002'),null);assert.equal(f.externalCalls(),0);
});

for(const kind of ['entity','state'])test(kind+'-only real domain change cannot authorize the old exact definition and requires explicit new semantic basis',options,async t=>{
 const f=await apiFixture(t);
 if(kind==='state'){
  const before=await f.repo.readView(),rep=before.snapshot.productionModel.domainGraph.representations.find(r=>r.id==='representation:letter-writer');
  await changeDomain(f.repo,'MATERIAL',[{collection:'states',id:'state:letter-writing',beforeHash:null,value:{id:'state:letter-writing',entityId:rep.entityId,label:'Original seated state',dimensions:{},scope:[],authority:'A',evidence:[]}},{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,stateId:'state:letter-writing'}}]);
 }
 const first=await f.provision(await f.workspace(),'Original context fixture'),v1=await f.register(first,await f.beginRun(first),pngs[0]);await f.review(first,v1,'REQUEST_REVISION');
 const before=await f.repo.readView(),req=before.snapshot.productionModel.materialRequirements.find(r=>r.id===imageRequirementId),collection=kind==='entity'?'entities':'states',row=before.snapshot.productionModel.domainGraph[collection][0];
 await changeDomain(f.repo,kind==='entity'?'SETTINGS':'MATERIAL',[{collection,id:row.id,beforeHash:domainHash(row),value:kind==='entity'?{...row,description:'New explicit neutral expression identity detail'}:{...row,label:'New standing static state'}}]);
 const after=await f.repo.readView();assert.equal(after.snapshot.productionModel.materialRequirements.find(r=>r.id===imageRequirementId).requirementHash,req.requirementHash,'demand+representation hash is deliberately unchanged');
 const immutable=await f.repo.exportState(),rejected=await f.post(f.requests,'v8/execution-requests',{action:'AUTHORIZE',workItemId:first.result.workItemId,familyId:first.result.familyId,executionDefinitionId:first.recipe.id,callPackageHash:first.recipe.definitionHash,executor:'CODEX',authorized:true,maxOutputs:1,inputBindings:[]});assert.equal(rejected.status,422,JSON.stringify(rejected.body));assert.ok(JSON.stringify(rejected.body).includes('MATERIAL_REQUIREMENT_BASIS_CHANGED'));assert.deepEqual(await f.repo.exportState(),immutable);
 await assert.rejects(f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId:imageRequirementId,api:f.adapter})),/偏离首次/);
 const w=await get(f);assert.ok(w.rebase.changes.some(change=>change.path.startsWith('/'+kind)),JSON.stringify(w.rebase.changes));assert.deepEqual(w.blockers,[]);assert.equal(f.externalCalls(),0);
});
