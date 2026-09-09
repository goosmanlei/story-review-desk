import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInstanceRepository,canonicalJson,sha256} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {domainOwnership} from '../host/instance-runtime/domain-ownership.mjs';
import {projectDomainGraph} from '../host/instance-runtime/domain-projection.mjs';
import {executionDefinitionHash} from '../host/instance-runtime/execution-definition-hash.mjs';
import {getDomainWorkspace,saveDomainWorkspace,previewDomainWorkspace,publishDomainWorkspace} from '../host/instance-runtime/domain-workspaces.mjs';
import {replacementFixture} from './fixtures/material-requirement-replacement.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'replacement-workspace-')),profile=blankProfile({title:'中性需求替代事务测试'}),repo=await createInstanceRepository({dbPath:path.join(root,'data/review.sqlite'),instanceId:profile.instanceId,profile});
 t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
 await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));
 const f=replacementFixture(),scope=[{scopeType:'PROJECT',scopeId:profile.projectId}];for(const graph of [f.before,f.after])for(const c of ['states','requirements'])for(const row of graph[c])row.scope=scope;
 f.aggregate.replaces.requirementHash=domainHash({demand:f.before.requirements[0],representation:f.before.representations[0]});
 const work={id:'material-work',requirementRef:'old-broad',requirementHash:f.aggregate.replaces.requirementHash,outputAssetRef:'original-family',executionDefinitionRef:'definition',scopeRole:'CURRENT',activeInCurrentProduction:true};
 const definition={id:'definition',workItemRef:work.id,executorKind:'MODEL_CALL',upload:{items:[]},output:{assetFamilyRef:'original-family',expectedOutputRef:'expected-output',path:'media/_review_pending/original-family/V001.png'}};definition.definitionHash=executionDefinitionHash(definition);
 await repo.writeTransaction(async tx=>{const source=await tx.putDocument({documentId:'fixture-definition-source',bytes:canonicalJson({schemaVersion:'TEST_EXECUTION_SOURCE_V1',definition}),expectedRevisionId:null,aliases:['fixture/definition.json']});definition.sourceRevisionId=source.revisionId;definition.sourceSha256=source.sha256;definition.definitionHash=executionDefinitionHash(definition);const view=await tx.readView(),record=await tx.putAux({namespace:'domain-graph',key:'current',bytes:canonicalJson(f.before),expectedRevisionId:null}),base=structuredClone(view.snapshot);base.productionModel.assetFamilies=[{id:'original-family',ownerRef:work.id,versionRefs:[],currentVersionId:null,projectRightsGate:'UNKNOWN'}];base.productionModel.expectedOutputs=[{id:'expected-output',familyId:'original-family',targetPath:definition.output.path}];base.productionModel.materialWorkItems=[work];const snapshot=projectDomainGraph(base,f.before,{revisionId:record.revisionId,sha256:record.sha256});snapshot.productionModel.materialRequirements[0].materialWorkItemRef=work.id;snapshot.productionModel.domainOwnership=domainOwnership(f.before);await tx.publishRelease({snapshot,recipes:{...view.recipes,executionDefinitions:[definition]},expectedReleaseId:view.releaseId,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId]});});
 const changes=['states','representations','requirements'].flatMap(collection=>f.after[collection].filter(row=>!f.before[collection].some(r=>r.id===row.id)).map(value=>({collection,id:value.id,beforeHash:null,value})));
 async function save(){const s=await repo.readTransaction(tx=>getDomainWorkspace(tx,'MATERIAL'));return repo.writeTransaction(tx=>saveDomainWorkspace(tx,{owner:'MATERIAL',expectedReleaseId:s.releaseId,expectedDraftRevisionId:s.draftHeadRevisionId,changes}));}
 const preview=draft=>repo.readTransaction(tx=>previewDomainWorkspace(tx,{owner:'MATERIAL',draftRevisionId:draft.revisionId}));
 const publish=(draft,p,id)=>repo.writeTransaction(tx=>publishDomainWorkspace(tx,{owner:'MATERIAL',draftRevisionId:draft.revisionId,previewHash:p.previewHash,requestId:id}));
 let n=0;async function append(kind,payload){const published=await repo.readView();payload={snapshotId:published.snapshot.snapshotId,...payload};await new Promise(resolve=>setTimeout(resolve,2));return (await repo.writeTransaction(tx=>tx.appendEvent({kind,idempotencyKey:'fixture-'+(++n),requestHash:domainHash(payload),payload}))).event;}
 const request=(state='AUTHORIZED',extra={})=>append('execution-request',{executionRequestId:'request',workItemId:work.id,familyId:work.outputAssetRef,executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,inputBindings:[],inputBindingsHash:domainHash([]),requestState:state,maxOutputs:1,...extra});
 const run=state=>append('run',{runId:'run',executionRequestId:'request',executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,inputBindingsHash:domainHash([]),runState:state});
 async function register(){
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R4sAAAAASUVORK5CYII=','base64'),digest=sha256(bytes),relativePath='media/blobs/'+digest+'.png';await mkdir(path.dirname(path.join(root,relativePath)),{recursive:true});await writeFile(path.join(root,relativePath),bytes);
  const event=await append('asset-version',{runId:'run',executionRequestId:'request',executionDefinitionId:definition.id,callPackageHash:definition.definitionHash,familyId:work.outputAssetRef,expectedOutputId:'expected-output',versionId:'original-family@V001',path:definition.output.path,sha256:digest});
  await repo.writeTransaction(tx=>tx.registerMedia({mediaId:work.outputAssetRef,versionId:event.versionId,sha256:digest,byteSize:bytes.length,relativePath,aliases:[definition.output.path],metadata:{authorityDomain:'FORMAL',registrationEventId:event.eventId}}));assert.equal(sha256(await readFile(path.join(root,relativePath))),event.sha256);return event;
 }
 return {repo,root,profile,save,preview,publish,request,run,register,append,definition,work,changes,before:f.before};
}
const isExecutionConflict=e=>e.code==='DOMAIN_CONFLICT'&&e.impact?.reasons?.length>0;

test('real repository save and preview reject affected activity without changing any formal or AUX bytes',async t=>{
 const f=await fixture(t);await f.request();let before=await f.repo.exportState();await assert.rejects(f.save(),isExecutionConflict);assert.deepEqual(await f.repo.exportState(),before);
 await f.request('CANCELLED');const draft=await f.save();const p=await f.preview(draft);assert.deepEqual(p.impact.replacementExecution.currentWorkIds,['material-work']);
 await f.request('CLAIMED');before=await f.repo.exportState();await assert.rejects(f.preview(draft),isExecutionConflict);assert.deepEqual(await f.repo.exportState(),before);
});

test('a claim created after preview is rejected by the actual publish transaction; fresh cancelled proof can publish',async t=>{
 const f=await fixture(t),draft=await f.save(),preview=await f.preview(draft),release=(await f.repo.readView()).releaseId;
 await f.request('CLAIMED');const before=await f.repo.exportState();await assert.rejects(f.publish(draft,preview,'blocked-after-preview'),isExecutionConflict);assert.deepEqual(await f.repo.exportState(),before);assert.equal((await f.repo.readView()).releaseId,release);
 await f.request('CANCELLED');await assert.rejects(f.publish(draft,preview,'stale-proof'),/预览已变化/);const current=await f.preview(draft),result=await f.publish(draft,current,'fresh-proof');assert.notEqual(result.releaseId,release);
 const after=await f.repo.readView();assert.equal(after.snapshot.productionModel.materialRequirements.find(r=>r.id==='old-broad').currentDisposition,'REPLACED');assert.deepEqual(after.snapshot.productionModel.domainGraph.requirements.find(r=>r.id==='old-broad'),f.before.requirements[0]);
});

test('succeeded run is held until its actual PNG is registered; replacement preserves its original event, registry and bytes',async t=>{
 const f=await fixture(t);await f.request('CLAIMED');await f.run('SUCCEEDED');await assert.rejects(f.save(),isExecutionConflict);
 const candidate=await f.register(),old=await f.repo.readView(),media=await f.repo.getMedia(candidate.familyId,candidate.versionId),physical=await readFile(path.join(f.root,media.relativePath)),draft=await f.save(),preview=await f.preview(draft);
 assert.deepEqual(preview.impact.replacementExecution.reasons,[]);await f.publish(draft,preview,'registered-output');
 const after=await f.repo.readView();assert.deepEqual(after.eventsByKind,old.eventsByKind);assert.deepEqual(await f.repo.getMedia(candidate.familyId,candidate.versionId),media);assert.deepEqual(await readFile(path.join(f.root,media.relativePath)),physical);assert.deepEqual(after.snapshot.productionModel.assetFamilies,old.snapshot.productionModel.assetFamilies);assert.equal((after.eventsByKind.review||[]).length,0,'no synthetic art observation or adoption is performed');
});

test('same-transaction AUX host job evidence affects publication and completed jobs permit a fresh preview',async t=>{
 const f=await fixture(t),draft=await f.save(),preview=await f.preview(draft);const record=await f.repo.writeTransaction(tx=>tx.putAux({namespace:'material-production-jobs',key:'pending-job',bytes:canonicalJson({jobId:'pending-job',requirementId:'old-broad',status:'RESULT_UNKNOWN',instanceId:f.profile.instanceId,runtimeEpoch:1}),expectedRevisionId:null}));
 const before=await f.repo.exportState();await assert.rejects(f.publish(draft,preview,'blocked-host-job'),isExecutionConflict);assert.deepEqual(await f.repo.exportState(),before);
 await f.repo.writeTransaction(tx=>tx.putAux({namespace:'material-production-jobs',key:'pending-job',bytes:canonicalJson({jobId:'pending-job',requirementId:'old-broad',status:'FAILED',instanceId:f.profile.instanceId,runtimeEpoch:1}),expectedRevisionId:record.revisionId}));const fresh=await f.preview(draft);assert.equal(fresh.impact.replacementExecution.hostJobs[0].status,'FAILED');await f.publish(draft,fresh,'host-resolved');
});

async function nextRecipeRelease(f){
 return f.repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot),definition={...f.definition,id:'new-definition',output:{...f.definition.output,expectedOutputRef:'new-output',path:'media/_review_pending/original-family/V002.png'}};definition.definitionHash=executionDefinitionHash(definition);snapshot.productionModel.materialWorkItems[0].executionDefinitionRef=definition.id;snapshot.productionModel.expectedOutputs=[{id:'new-output',familyId:'original-family',targetPath:definition.output.path}];return tx.publishRelease({snapshot,recipes:{...view.recipes,executionDefinitions:[definition]},expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});});
}

test('actual historical publication supplies old definition and EO after current recipe switches; original candidate remains terminal',async t=>{
 const f=await fixture(t),historical=await f.repo.readView();await f.request('CLAIMED');await f.run('SUCCEEDED');const candidate=await f.register();await nextRecipeRelease(f);
 const current=await f.repo.readView();assert.ok(!current.recipes.executionDefinitions.some(d=>d.id===f.definition.id));assert.ok(!current.snapshot.productionModel.expectedOutputs.some(o=>o.id==='expected-output'));
 const draft=await f.save(),preview=await f.preview(draft);assert.deepEqual(preview.impact.replacementExecution.reasons,[]);assert.equal(preview.impact.replacementExecution.historicalReleaseProofs.length,1);assert.equal(preview.impact.replacementExecution.historicalReleaseProofs[0].releaseId,historical.releaseId);
 await f.publish(draft,preview,'historical-complete');assert.equal((await f.repo.getMedia(candidate.familyId,candidate.versionId)).sha256,candidate.sha256);
});

for(const mode of ['wrong snapshot SHA','future release time','foreign profile','missing pinned domain','missing definition document'])test('historical '+mode+' stays UNKNOWN even when old run says SUCCEEDED',async t=>{
 const f=await fixture(t);await f.request('CLAIMED');await f.run('SUCCEEDED');await f.register();await nextRecipeRelease(f);const current=await f.repo.readTransaction(tx=>getDomainWorkspace(tx,'MATERIAL')),before=await f.repo.exportState();
 await assert.rejects(f.repo.writeTransaction(async tx=>{
  let historicalRead=false;const originalHistorical=tx.readPublishedReleaseAt.bind(tx);tx.readPublishedReleaseAt=async input=>{historicalRead=true;return originalHistorical(input);};
  if(mode==='wrong snapshot SHA'||mode==='future release time'){const read=tx.readPublishedReleaseAt.bind(tx);tx.readPublishedReleaseAt=async input=>{const r=await read(input);return mode==='wrong snapshot SHA'?{...r,snapshotSha256:'0'.repeat(64)}:{...r,createdAt:input.recordedBefore};};}
  if(mode==='foreign profile'){const read=tx.getRecord.bind(tx);tx.getRecord=(...args)=>{const r=read(...args);if(!historicalRead||args[0]!=='settings'||args[1]!=='instance-profile'||!args[2])return r;const bytes=Buffer.from(canonicalJson({...JSON.parse(r.bytes),instanceId:'foreign'}));return {...r,bytes,sha256:sha256(bytes)};};}
  if(mode==='missing definition document'){const read=tx.readDocumentRevision.bind(tx);tx.readDocumentRevision=async(...args)=>historicalRead&&args[0]===f.definition.sourceRevisionId?null:read(...args);}
  if(mode==='missing pinned domain'){const read=tx.getAux.bind(tx);tx.getAux=async(...args)=>historicalRead&&args[0]==='domain-graph'&&args[2]?.revisionId?null:read(...args);}
  return saveDomainWorkspace(tx,{owner:'MATERIAL',expectedReleaseId:current.releaseId,expectedDraftRevisionId:current.draftHeadRevisionId,changes:f.changes});
 }),e=>isExecutionConflict(e)&&e.impact.reasons.some(r=>r.startsWith('REPLACEMENT_HISTORICAL_CONTEXT_UNKNOWN')));
 assert.deepEqual(await f.repo.exportState(),before);
});

for(const retainWork of [false,true])test('old shot UNKNOWN remains blocked after plan/definition removal, historical work retained='+retainWork,async t=>{
 const f=await fixture(t);let def;
 await f.repo.writeTransaction(async tx=>{const v=await tx.readView(),s=structuredClone(v.snapshot),m=s.productionModel,req=m.materialRequirements[0],content={sceneId:'permanent-scene',shots:[{shotId:'old-shot',sceneId:'permanent-scene',materialRequirementRefs:[req.id]}]},pc={shotPlanRevisionId:'design-old',shots:[{shotId:'old-shot',inputs:[]}]},w={id:'old-shot-work',shotId:'old-shot',sceneId:'permanent-scene',scopeRole:'CURRENT',shotProductionPlanId:'old-production',outputAssetRef:'old-shot-family',executionDefinitionRef:'old-shot-def'};
  m.shotPlanSetRevisions=[{id:'design-old',scopeId:'permanent-scene',scopeRole:'CURRENT',content,contentHash:domainHash(content),materialRequirementSet:{schemaVersion:'2.0',bindings:[{requirementId:req.id,requirementHash:req.requirementHash}]}}];m.shotProductionPlans=[{id:'old-production',sceneId:'permanent-scene',scopeRole:'CURRENT',content:pc,contentHash:domainHash(pc),workItemIds:[w.id]}];m.workItems=[w];def={id:'old-shot-def',workItemRef:w.id,executorKind:'MODEL_CALL',upload:{items:[]},output:{assetFamilyRef:w.outputAssetRef,expectedOutputRef:'old-shot-output',path:'media/_review_pending/old-shot-family/V001.png'}};def.definitionHash=executionDefinitionHash(def);m.expectedOutputs.push({id:'old-shot-output',familyId:w.outputAssetRef,targetPath:def.output.path});await tx.publishRelease({snapshot:s,recipes:{...v.recipes,executionDefinitions:[...v.recipes.executionDefinitions,def]},expectedReleaseId:v.releaseId,sourceRevisionIds:v.sourceRevisionIds});});
 const q=await f.append('execution-request',{executionRequestId:'old-shot-request',workItemId:def.workItemRef,familyId:def.output.assetFamilyRef,executionDefinitionId:def.id,callPackageHash:def.definitionHash,inputBindings:[],inputBindingsHash:domainHash([]),requestState:'CLAIMED',maxOutputs:1});
 await f.append('run',{runId:'old-shot-run',executionRequestId:q.executionRequestId,executionDefinitionId:def.id,callPackageHash:def.definitionHash,inputBindingsHash:domainHash([]),runState:'RESULT_UNKNOWN'});
 await f.repo.writeTransaction(async tx=>{const v=await tx.readView(),s=structuredClone(v.snapshot);s.productionModel.shotPlanSetRevisions=[];s.productionModel.shotProductionPlans=[];s.productionModel.workItems=retainWork?s.productionModel.workItems.map(w=>({...w,scopeRole:'HISTORICAL',activeInCurrentProduction:false})):[];s.productionModel.expectedOutputs=s.productionModel.expectedOutputs.filter(o=>o.id!=='old-shot-output');await tx.publishRelease({snapshot:s,recipes:{...v.recipes,executionDefinitions:v.recipes.executionDefinitions.filter(d=>d.id!==def.id)},expectedReleaseId:v.releaseId,sourceRevisionIds:v.sourceRevisionIds});});
 const before=await f.repo.exportState();await assert.rejects(f.save(),e=>isExecutionConflict(e)&&e.impact.historicalWorkIds.includes('old-shot-work')&&!e.impact.currentWorkIds.includes('old-shot-work')&&e.impact.reasons.some(r=>r.startsWith('REPLACEMENT_RUN_PENDING:old-shot-run')));assert.deepEqual(await f.repo.exportState(),before);
});
