import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {getShotProductionWorkspace,saveShotProductionDraft,previewShotProduction,enqueueShotProduction,applyShotProductionJob} from '../host/instance-runtime/shot-production-service.mjs';
import {runShotProductionWorkerIteration} from '../scripts/instance-shot-production-worker.mjs';

const sceneId='scene:letter',shotId=sceneId+':shot1';
// Business review validity is independently tested by the real episode compiler.
// This adapter lets these repository tests inject a review reopening mid-queue.
function validator(){let approved=true;return {reopen:()=>{approved=false;},api:{projectOperationalState(data){return {assetFamiliesById:Object.fromEntries(data.productionModel.assetFamilies.map(f=>[f.id,f])),assetVersionsById:{}};},projectEpisodeNarrativeReleases(data){const r=data.productionModel.episodeNarrativeReleases[0];return {[r.episodeUid]:{...r,canFlowDownstream:approved}};},projectedReviewIndexes(){return {bySubject:[]};},projectedStructureReviewIndexes(){return {bySubject:[]};},projectedScopeLocks(data){return Object.fromEntries(data.productionModel.scopeLocks.map(l=>[l.id,{...l,lockState:approved?'LOCKED':'UNLOCKED'}]));}}};}
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'shot-production-service-')),profile=blankProfile({title:'镜头生产验收'}),repo=await createInstanceRepository({dbPath:path.join(root,'data/review.sqlite'),instanceId:profile.instanceId,profile});try{
 const initial=blankSnapshot(profile),m=initial.snapshot.productionModel,sceneHash=productionHash('letter-script');
 const spec={shotId,sceneId,order:1,title:'打开信',narrativeBeat:'收到来信',audienceTakeaway:'来信改变决定',materialRequirementRefs:[],inputBindings:[],design:{keyframeStrategy:{mode:'START_ONLY',reason:'静止构图中的轻微表演',intermediateFrameCount:0}}};
 const content={sceneId,identityChangeReason:'NO_IDENTITY_CHANGE',shots:[spec]},hash=productionHash(content);
 m.episodeNarrativeReleases=[{id:'release:episode',episodeUid:'episode:1',scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',reviewInput:{scenes:[{id:sceneId,contentHash:sceneHash}]}}];
 m.sceneScriptRevisions=[{id:'script:scene',sceneId,scopeRole:'CURRENT',episodeNarrativeReleaseId:'release:episode',contentHash:sceneHash}];
 m.shotPlanSetRevisions=[{id:'design:1',episodeUid:'episode:1',sceneId,scopeId:sceneId,scopeRole:'CURRENT',sourceOperationId:'source:design',sourceSyncState:'SUCCEEDED',episodeNarrativeReleaseId:'release:episode',content,contentHash:hash}];
 m.scopeLocks=[{id:'scope:scene',scopeType:'SCENE',scopeId:sceneId,lockPurpose:'SHOT_PLAN_SET',lockState:'LOCKED',denominatorState:'KNOWN',shotPlanSetRevisionId:'design:1',shotPlanSetRevisionHash:hash,shotIds:[shotId]}];
 m.shots=[{...spec,id:shotId,shotPlanSetRevisionId:'design:1',shotPlanSetRevisionHash:hash,scopeRole:'CURRENT',activeInCurrentProduction:true,workPackageRefs:[]}];
 await repo.writeTransaction(tx=>tx.publishRelease({...initial,expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));
 const v=validator();await run(repo,v,root);
 }finally{await repo.close();await rm(root,{recursive:true,force:true});}}
async function stage(repo,api,mutate=x=>x){const workspace=await repo.readTransaction(tx=>getShotProductionWorkspace(tx,{sceneId,api}));const content=mutate(structuredClone(workspace.draft?.content||workspace.currentPlan?.content||workspace.defaultContent));const saved=await repo.writeTransaction(tx=>saveShotProductionDraft(tx,{sceneId,content,expectedReleaseId:workspace.releaseId,expectedDraftRevisionId:workspace.draftHeadRevisionId},{api}));const preview=await repo.readTransaction(tx=>previewShotProduction(tx,{sceneId,draftRevisionId:saved.revisionId},{api}));return {saved,preview};}
async function enqueue(repo,api,preview,requestId){return repo.writeTransaction(tx=>enqueueShotProduction(tx,{sceneId,draftRevisionId:preview.draftRevisionId,previewHash:preview.previewHash,requestId},{api}));}

test('plan publication is queued, atomic, idempotent and creates no fictional media',()=>fixture(async(repo,{api})=>{
 const before=await repo.readView(),{preview}=await stage(repo,api),job=await enqueue(repo,api,preview,'queue-first-plan');
 assert.equal((await repo.readView()).releaseId,before.releaseId);assert.deepEqual(await enqueue(repo,api,preview,'queue-first-plan'),job);
 const result=await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));assert.deepEqual(await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api})),result);
 const after=await repo.readView(),model=after.snapshot.productionModel;assert.notEqual(after.releaseId,before.releaseId);assert.equal(model.assetVersions.length,0);assert.equal((await repo.listMedia()).length,0);assert.equal(model.shotProductionPlans.length,1);assert.equal(model.workItems.length,preview.workItemCount);assert(model.workItems.every(w=>w.reviewSpec.hash&&w.configurationBinding));
 assert(model.workPackages.every(p=>p.workItemRefs.length===1));assert(model.workPackages.filter(p=>p.scopeType==='SHOT').every(p=>model.shots[0].workPackageRefs.includes(p.id)));
 assert.equal(model.shots[0].inputBindings.length,0);assert.equal((await repo.readTransaction(tx=>getShotProductionWorkspace(tx,{sceneId,api}))).readiness.ready,false);
 assert.equal(after.snapshot.snapshotId,after.recipes.snapshotId);
}));
test('review reopening after enqueue blocks worker publication and never retries automatically',()=>fixture(async(repo,v)=>{
 const {preview}=await stage(repo,v.api),job=await enqueue(repo,v.api,preview,'queue-stale-plan'),before=(await repo.readView()).releaseId;v.reopen();
 const result=await runShotProductionWorkerIteration({repository:repo,api:v.api});assert.equal(result.status,'FAILED');assert.equal((await repo.readView()).releaseId,before);assert.equal((await repo.readView()).snapshot.productionModel.workItems.length,0);assert.deepEqual(await runShotProductionWorkerIteration({repository:repo,api:v.api}),{processed:false});
 assert.equal(JSON.parse((await repo.getAux('shot-production-jobs',job.jobId)).bytes).status,'FAILED');
}));
test('CAS failure rolls back the source document, graph and completion together',()=>fixture(async(repo,{api})=>{
 const {preview}=await stage(repo,api),job=await enqueue(repo,api,preview,'queue-rollback-plan'),before=await repo.readView();
 await assert.rejects(repo.writeTransaction(async tx=>{tx.publishRelease=async()=>{throw Error('injected publication conflict');};return applyShotProductionJob(tx,{jobId:job.jobId,api});}),/injected/);
 assert.equal((await repo.readView()).releaseId,before.releaseId);assert.equal((await repo.readView()).snapshot.productionModel.workItems.length,0);
 assert.equal(JSON.parse((await repo.getAux('shot-production-jobs',job.jobId)).bytes).status,'QUEUED');
 const result=await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));assert(result.releaseId);
}));
test('unchanged settings reuse exact work and family identities while changing one output preserves unrelated work',()=>fixture(async(repo,{api})=>{
 let {preview}=await stage(repo,api),job=await enqueue(repo,api,preview,'queue-reuse-initial');await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));
 const before=(await repo.readView()).snapshot.productionModel,board=before.workItems.find(w=>w.deliverableKey==='STORYBOARD');
 ({preview}=await stage(repo,api,c=>{c.shots[0].handles.tailFrames=12;return c;}));assert(preview.reusedWorkItemIds.includes(board.id));assert(!preview.previousWorkItemIds.includes(board.id));
 job=await enqueue(repo,api,preview,'queue-reuse-change');await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));
 const after=(await repo.readView()).snapshot.productionModel;assert.deepEqual(after.workItems.find(w=>w.id===board.id),board);assert(after.shotProductionPlans[0].workItemIds.includes(board.id));assert.equal(after.assetFamilies.filter(f=>f.id===board.outputAssetRef).length,1);
}));

test('V2 real repository publishes temporary audio before masters and later FINAL retains the exact TEMP work and source',()=>fixture(async(repo,{api})=>{
 await repo.writeTransaction(async tx=>{const view=await tx.readView(),snapshot=structuredClone(view.snapshot);snapshot.productionModel.domainGraph={entities:[{id:'ENTITY-actor',type:'CHARACTER',authority:'A'}],representations:[]};snapshot.snapshotId='snapshot:temporary-dialogue-fixture';await tx.publishRelease({snapshot,recipes:{...view.recipes,snapshotId:snapshot.snapshotId},sourceRevisionIds:view.sourceRevisionIds,expectedReleaseId:view.releaseId});});
 const first=await stage(repo,api,c=>{c.shots[0].dialogueLines=[{id:'LINE-timing',text:'这是给我的？',speakerEntityId:'ENTITY-actor',purpose:'TEMPORARY',performance:'留出停顿，测试对白节奏'}];return c;}),job=await enqueue(repo,api,first.preview,'publish-temporary');await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));
 const initial=await repo.readView(),m=initial.snapshot.productionModel,plan=m.shotProductionPlans[0],temporary=m.workItems.find(w=>w.deliverableKey==='DIALOGUE_TEMP'),board=m.workItems.find(w=>w.deliverableKey==='STORYBOARD');
 assert.equal(plan.content.schemaVersion,'2.0');assert.equal(plan.content.stagePolicy,'PREVIS_FIRST_V1');assert.equal(temporary.allowedUse,'PREVIS_TIMING');assert(m.workItems.filter(w=>w.deliverableKey==='SHOT_INPUT_LOCK').every(w=>w.scopeType==='SHOT'));
 const workspace=await repo.readTransaction(tx=>getShotProductionWorkspace(tx,{sceneId,api}));assert.deepEqual(workspace.stageEntries.find(w=>w.id===temporary.id).blockers,[]);assert.deepEqual(workspace.stageEntries.find(w=>w.id===board.id).blockers,[]);assert(workspace.stageEntries.find(w=>w.deliverableKey==='START_FRAME').blockers.includes('INPUT_LOCK_REQUIRED'));
 const sourceBefore=await repo.readTransaction(tx=>tx.getPublishedDocument(plan.sourcePath)),tempBefore=structuredClone(temporary);
 const next=await stage(repo,api,c=>{c.shots[0].dialogueLines[0].purpose='FINAL';return c;}),nextJob=await enqueue(repo,api,next.preview,'publish-final-plan');assert(next.preview.reusedWorkItemIds.includes(temporary.id));await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:nextJob.jobId,api}));
 const after=await repo.readView();assert.deepEqual(after.snapshot.productionModel.workItems.find(w=>w.id===temporary.id),tempBefore);assert(after.snapshot.productionModel.workItems.some(w=>w.deliverableKey==='DIALOGUE_DRY'&&w.id!==temporary.id));const sourceAfter=await repo.readTransaction(tx=>tx.getPublishedDocument(plan.sourcePath));assert(sourceAfter.bytes.equals(sourceBefore.bytes));assert.equal((await repo.listMedia()).length,0);assert.equal(after.snapshot.productionModel.assetVersions.length,0);
}));
