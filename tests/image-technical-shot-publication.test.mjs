import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {initializeConfiguration,getConfiguration,previewConfiguration,publishConfiguration} from '../host/instance-runtime/configuration-service.mjs';
import {getShotProductionWorkspace,saveShotProductionDraft,previewShotProduction,enqueueShotProduction,applyShotProductionJob} from '../host/instance-runtime/shot-production-service.mjs';
import {preserveShotProductionProjection} from '../host/instance-runtime/shot-production-preservation.mjs';
import {resolveImageTechnicalSpec,defaultImagePurposeProfiles} from '../host/instance-runtime/image-technical-spec.mjs';
import {fixture,sceneId} from './shot-previs-stage-v2.fixture.mjs';

// Narrative approval is declared by this neutral fixture; the test verifies
// actual repository/source publication, not an artistic observation or review.
const api={projectOperationalState:d=>({assetFamiliesById:Object.fromEntries(d.productionModel.assetFamilies.map(f=>[f.id,f])),assetVersionsById:{}}),projectEpisodeNarrativeReleases:d=>Object.fromEntries(d.productionModel.episodeNarrativeReleases.map(r=>[r.episodeUid,{...r,canFlowDownstream:true}])),projectedReviewIndexes:()=>({bySubject:[]}),projectedStructureReviewIndexes:()=>({bySubject:[]}),projectedScopeLocks:d=>Object.fromEntries(d.productionModel.scopeLocks.map(l=>[l.id,l]))};
test('new V2 publication freezes base-independent PREVIS and exact final-frame specs while a subsequent plan preserves reused image work',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'image-spec-shot-')),profile=blankProfile(),repo=await createInstanceRepository({dbPath:path.join(root,'review.sqlite'),instanceId:profile.instanceId,profile});t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
 await repo.writeTransaction(tx=>tx.publishRelease({...blankSnapshot(profile),expectedReleaseId:null,sourceRevisionIds:[]}));await repo.writeTransaction(tx=>initializeConfiguration(tx));
 await repo.writeTransaction(async tx=>{const c=await getConfiguration(tx),configuration=structuredClone(c.configuration);configuration.schemaVersion='2.1';configuration.technical.imagePurposeProfiles=defaultImagePurposeProfiles();configuration.technical.picture={aspectRatio:'16:9',width:1920,height:1080,fps:24,confirmation:'CONFIRMED'};const input={configuration,expectedReleaseId:c.releaseId,expectedConfigurationRevisionId:c.revisionId,upgradeKeys:[]},p=await previewConfiguration(tx,input);await publishConfiguration(tx,{...input,previewHash:p.previewHash,requestId:'image-spec-configuration'});});
 await repo.writeTransaction(async tx=>{const v=await tx.readView(),snapshot=structuredClone(v.snapshot);Object.assign(snapshot.productionModel,fixture().model);snapshot.productionModel.assetFamilies=[];for(const r of snapshot.productionModel.materialRequirements)r.mediaType=r.id==='VOICE-REQ'?'AUDIO':'IMAGE';await tx.publishRelease({snapshot,recipes:v.recipes,expectedReleaseId:v.releaseId,sourceRevisionIds:v.sourceRevisionIds});});
 const stage=async(mutate=x=>x)=>{const w=await repo.readTransaction(tx=>getShotProductionWorkspace(tx,{sceneId,api})),content=mutate(structuredClone(w.currentPlan?.content||w.defaultContent));for(const s of content.shots)s.keyframeStrategy={mode:'START_ONLY',reason:'Neutral continuous frame fixture',intermediateFrameCount:0};const saved=await repo.writeTransaction(tx=>saveShotProductionDraft(tx,{sceneId,content,expectedReleaseId:w.releaseId,expectedDraftRevisionId:w.draftHeadRevisionId},{api})),p=await repo.readTransaction(tx=>previewShotProduction(tx,{sceneId,draftRevisionId:saved.revisionId},{api})),job=await repo.writeTransaction(tx=>enqueueShotProduction(tx,{sceneId,draftRevisionId:saved.revisionId,previewHash:p.previewHash,requestId:crypto.randomUUID()},{api}));await repo.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));};
 await stage();const before=await repo.readView(),m=before.snapshot.productionModel,images=m.workItems.filter(w=>['STORYBOARD','START_FRAME'].includes(w.deliverableKey));assert.equal(images.length,4);
 for(const w of images){const output=m.expectedOutputs.find(o=>o.familyId===w.outputAssetRef),b=resolveImageTechnicalSpec(m,{familyId:w.outputAssetRef,expectedOutputId:output.id});assert.equal(b.technicalSpec.purpose,w.deliverableKey==='STORYBOARD'?'PREVIS_STILL':'PRODUCTION_FRAME');assert.equal(b.technicalSpec.canvas?.width||null,w.deliverableKey==='STORYBOARD'?null:1920);}
 const documents=[];for(const id of before.sourceRevisionIds)documents.push(await repo.readDocumentRevision(id));const compiled=structuredClone(before.snapshot);for(const key of ['shotProductionPlans','workItems','workPackages','assetFamilies','expectedOutputs','reviewContexts'])compiled.productionModel[key]=[];
 const preserved=preserveShotProductionProjection({snapshot:compiled,baseSnapshot:before.snapshot,documents});assert.deepEqual(preserved.productionModel.workItems,m.workItems);assert.deepEqual(preserved.productionModel.expectedOutputs,m.expectedOutputs);
 await stage(c=>{c.shots[0].handles.tailFrames=12;return c;});const after=await repo.readView();for(const w of images)assert.deepEqual(after.snapshot.productionModel.workItems.find(row=>row.id===w.id),w);assert.equal((await repo.listMedia()).length,0);
});
