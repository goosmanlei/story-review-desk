import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {getShotProductionWorkspace,saveShotProductionDraft,previewShotProduction,enqueueShotProduction} from '../host/instance-runtime/shot-production-service.mjs';
import {runShotProductionWorkerIteration} from '../scripts/instance-shot-production-worker.mjs';
import {sharedStoryPostgres} from './fixtures/shared-story-postgres.mjs';
import {fixture as modelFixture,sceneId} from './shot-previs-stage-v2.fixture.mjs';

// The story-neutral fixture declares its narrative and design approvals. This
// test exercises actual PostgreSQL/CAS/source publication, not narrative review
// validation or a provider. There are no actual base masters or media candidates.
const api={
 projectOperationalState(data){return {assetFamiliesById:Object.fromEntries(data.productionModel.assetFamilies.map(f=>[f.id,f])),assetVersionsById:{}};},
 projectEpisodeNarrativeReleases(data){return Object.fromEntries(data.productionModel.episodeNarrativeReleases.map(r=>[r.episodeUid,{...r,canFlowDownstream:true}]));},
 projectedReviewIndexes(){return {bySubject:[]};},projectedStructureReviewIndexes(){return {bySubject:[]};},
 projectedScopeLocks(data){return Object.fromEntries(data.productionModel.scopeLocks.map(l=>[l.id,l]));}
};
const environmentKeys=['REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PORT','REVIEW_POSTGRES_PASSWORD_FILE','REVIEW_POSTGRES_PASSWORD','REVIEW_POSTGRES_USER','REVIEW_INSTANCE_READ_ONLY','REVIEW_REMOTE_READ_ONLY'];

test('PREVIS V2 actual isolated PostgreSQL publishes per-shot work and preserves TEMP identity/source while adding FINAL',{skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},async t=>{
 const temporaryParent=path.resolve(import.meta.dirname,'.test-tmp');await mkdir(temporaryParent,{recursive:true});
 const root=await mkdtemp(path.join(temporaryParent,'previs-v2-postgres-')),env=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]])),originalFetch=globalThis.fetch;
 let pg,repo,externalCalls=0;
 t.after(async()=>{globalThis.fetch=originalFetch;await repo?.close();await pg?.cleanup();await rm(root,{recursive:true,force:true});for(const key of environmentKeys){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}});
 process.env.REVIEW_INSTANCE_READ_ONLY='';process.env.REVIEW_REMOTE_READ_ONLY='';
 const profile=blankProfile({title:'Isolated PREVIS V2 publication protocol'});
 pg=await sharedStoryPostgres(root);repo=await createInstanceRepository({root,instanceId:profile.instanceId,backend:'postgres',database:pg.database,profile});
 await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));
 await repo.writeTransaction(tx=>initializeConfiguration(tx));
 await repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),model=snapshot.productionModel;Object.assign(model,modelFixture().model);model.assetFamilies=[];
  for(const requirement of model.materialRequirements)requirement.mediaType=requirement.id==='VOICE-REQ'?'AUDIO':'IMAGE';
  for(const row of model.shotPlanSetRevisions){row.scopeType='SCENE';row.sceneId=sceneId;}
  snapshot.snapshotId='snapshot:previs-v2-test-fixture';await tx.publishRelease({snapshot,recipes:{...view.recipes,snapshotId:snapshot.snapshotId},expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds});
 });
 globalThis.fetch=async()=>{externalCalls++;throw Error('Provider calls are forbidden in the PREVIS V2 PostgreSQL protocol test');};
 const workspace=()=>repo.readTransaction(tx=>getShotProductionWorkspace(tx,{sceneId,api}));
 const stage=async(content,key)=>{
  const w=await workspace(),before=await repo.readView();
  const saved=await repo.writeTransaction(tx=>saveShotProductionDraft(tx,{sceneId,content,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId},{api}));
  const preview=await repo.readTransaction(tx=>previewShotProduction(tx,{sceneId,draftRevisionId:saved.revisionId},{api}));
  const request={sceneId,draftRevisionId:saved.revisionId,previewHash:preview.previewHash,requestId:key};
  const job=await repo.writeTransaction(tx=>enqueueShotProduction(tx,request,{api}));
  assert.deepEqual(await repo.writeTransaction(tx=>enqueueShotProduction(tx,request,{api})),job,'queue retry is idempotent for the exact request');
  const queued=await repo.readView();assert.equal(queued.releaseId,before.releaseId);assert.deepEqual(queued.snapshot,before.snapshot);assert.deepEqual(queued.recipes,before.recipes);
  const result=await runShotProductionWorkerIteration({repository:repo,api});assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));assert.equal(result.result.actualMediaCreated,false);
  return {saved,preview,result,model:(await repo.readView()).snapshot.productionModel};
 };
 const content=structuredClone((await workspace()).defaultContent);
 content.shots.forEach((shot,index)=>{shot.keyframeStrategy={mode:'START_ONLY',reason:'固定构图中的轻微表演',intermediateFrameCount:0};shot.dialogueLines=[{id:'TEMP-LINE-'+index,text:'这是给我的？',speakerEntityId:'ENTITY-girl',purpose:'TEMPORARY',performance:'迟疑后低声问'}];});
 assert.equal(content.schemaVersion,'2.0');assert.equal(content.stagePolicy,'PREVIS_FIRST_V1');
 assert(content.shots.every(s=>s.inputs.length===0&&s.previsInputs.length===0&&s.space.freeze==='UNKNOWN'));
 const first=await stage(content,'previs:temporary:first'),plan=first.model.shotProductionPlans.find(p=>p.scopeRole==='CURRENT');
 const temporary=first.model.workItems.filter(w=>w.deliverableKey==='DIALOGUE_TEMP'),boards=first.model.workItems.filter(w=>w.deliverableKey==='STORYBOARD');
 assert.equal(temporary.length,2);assert.equal(first.model.workItems.filter(w=>w.deliverableKey==='DIALOGUE_DRY').length,0);
 const locks=first.model.workItems.filter(w=>w.deliverableKey==='SHOT_INPUT_LOCK');assert.equal(locks.length,2);assert(locks.every(w=>w.scopeType==='SHOT'&&w.shotId===w.scopeId));
 const source=await repo.readDocumentRevision(plan.sourceRevisionId);assert.equal(sha256(source.bytes),plan.sourceSha256);assert.equal(source.metadata.sourceRole,'SHOT_PRODUCTION_PLAN');
 const envelope=JSON.parse(source.bytes);assert.equal(envelope.schemaVersion,'1.0');assert.equal(envelope.content.schemaVersion,'2.0');assert.equal(envelope.contentHash,productionHash(envelope.content));
 const firstWorkspace=await workspace();
 for(const work of [...temporary,...boards])assert.deepEqual(firstWorkspace.stageEntries.find(row=>row.id===work.id).blockers,[]);
 const frame=firstWorkspace.stageEntries.find(row=>row.deliverableKey==='START_FRAME');assert(frame.blockers.includes('INPUT_LOCK_REQUIRED'));assert(frame.blockers.some(reason=>reason.startsWith('MATERIAL_INPUT_MISSING:')));
 const retainedIds=new Set([...temporary,...boards,...first.model.workItems.filter(w=>w.deliverableKey==='ANIMATIC')].map(w=>w.id));
 const retainedWorks=first.model.workItems.filter(w=>retainedIds.has(w.id)),retainedFamilies=first.model.assetFamilies.filter(f=>retainedWorks.some(w=>w.outputAssetRef===f.id)),retainedOutputs=first.model.expectedOutputs.filter(o=>retainedFamilies.some(f=>f.id===o.familyId));
 const finalContent=structuredClone(content);finalContent.shots[0].dialogueLines[0].purpose='FINAL';
 const second=await stage(finalContent,'previs:final:second');
 for(const work of retainedWorks){assert(second.preview.reusedWorkItemIds.includes(work.id));assert.deepEqual(second.model.workItems.find(row=>row.id===work.id),work);}
 for(const family of retainedFamilies)assert.deepEqual(second.model.assetFamilies.find(row=>row.id===family.id),family);
 for(const output of retainedOutputs)assert.deepEqual(second.model.expectedOutputs.find(row=>row.id===output.id),output);
 assert.deepEqual(await repo.readDocumentRevision(plan.sourceRevisionId),source,'the prior published source revision is immutable');
 const finalWorks=second.model.workItems.filter(w=>w.deliverableKey==='DIALOGUE_DRY');assert.equal(finalWorks.length,1);assert.equal(finalWorks[0].shotId,content.shots[0].shotId);assert.equal(finalWorks[0].productionPurpose,'FINAL');assert.equal(finalWorks[0].allowedUse,'PRODUCTION');
 const finalFamily=second.model.assetFamilies.find(f=>f.id===finalWorks[0].outputAssetRef),finalOutput=second.model.expectedOutputs.find(o=>o.familyId===finalFamily.id);
 assert.equal(finalFamily.productionPurpose,'FINAL');assert.equal(finalOutput.allowedUse,'PRODUCTION');assert(finalOutput.targetPath);assert(!retainedOutputs.some(o=>o.targetPath===finalOutput.targetPath));
 const finalWorkspace=await workspace();assert(finalWorkspace.stageEntries.find(row=>row.id===finalWorks[0].id).blockers.some(reason=>reason.startsWith('INPUT_SPEAKER_')),'adding a final target cannot bypass the actual adopted voice master');
 assert.deepEqual(finalWorkspace.stageEntries.find(row=>row.id===temporary[0].id).blockers,[]);
 const stable=await repo.exportState();
 await assert.rejects(repo.writeTransaction(tx=>saveShotProductionDraft(tx,{sceneId,content:finalContent,expectedReleaseId:first.result.result.releaseId,expectedDraftRevisionId:finalWorkspace.draftHeadRevisionId},{api})),/发布版本已变化/);
 assert.deepEqual(await repo.exportState(),stable,'stale publication CAS writes nothing');
 const finalView=await repo.readView();assert.equal(finalView.snapshot.productionModel.assetVersions.length,0);assert.equal((await repo.listMedia()).length,0);assert(Object.values(finalView.eventsByKind).every(events=>events.length===0));assert.equal(externalCalls,0);
});
