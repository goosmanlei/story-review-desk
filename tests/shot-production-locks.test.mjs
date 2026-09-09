import test from 'node:test';
import assert from 'node:assert/strict';
import {productionHash,resolveShotProductionScope,defaultShotProductionPlan,compileShotProductionPlan,shotProductionVisualInputHash} from '../host/instance-runtime/shot-production-model.mjs';
import {recordShotProductionReview,readShotProductionReviewEvidence,applyShotProductionLocksProjection,SHOT_LOCK_NS,validateShotProductionEvidence} from '../host/instance-runtime/shot-production-locks.mjs';
import {productionSpaceReasons} from '../host/instance-runtime/shot-production-space.mjs';
import {previewShotProductionManifest,enqueueShotProductionManifest,claimShotProductionManifest,writeShotProductionManifest,finishShotProductionManifest,applyShotProductionManifestProjection,shotManifestCandidateMatchesJob,runShotProductionManifestIteration} from '../host/instance-runtime/shot-production-manifest.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';

function fixture({schemaVersion='1.0',withVoice=false}={}){
 const sceneId='SCENE-test',episodeUid='EP-test',content={sceneId,shots:[1,2].map(i=>({shotId:'SHOT-'+i,sceneId,order:i,materialRequirementRefs:['REQ-'+i]}))},plan={id:'DESIGN-1',scopeId:sceneId,episodeUid,scopeRole:'CURRENT',sourceOperationId:'SYNC-1',sourceSyncState:'SUCCEEDED',content,contentHash:productionHash(content),episodeNarrativeReleaseId:'EP-RELEASE'};
 const model={shotPlanSetRevisions:[plan],episodeNarrativeReleases:[{id:'EP-RELEASE',episodeUid,scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',reviewInput:{scenes:[{id:sceneId,contentHash:productionHash('script')} ]}}],sceneScriptRevisions:[{sceneId,scopeRole:'CURRENT',episodeNarrativeReleaseId:'EP-RELEASE',contentHash:productionHash('script')}],scopeLocks:[{id:'scope-lock',scopeType:'SCENE',scopeId:sceneId,lockPurpose:'SHOT_PLAN_SET',lockState:'LOCKED',denominatorState:'KNOWN',shotPlanSetRevisionId:plan.id,shotPlanSetRevisionHash:plan.contentHash,shotIds:content.shots.map(s=>s.shotId)}],shots:content.shots.map(s=>({...s,id:s.shotId,scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:plan.id,shotPlanSetRevisionHash:plan.contentHash})),materialRequirements:[1,2].map(i=>({id:'REQ-'+i,requirementClass:'REQUIRED',assetFamilyRefs:['BASE-'+i],entityRef:'ROOM-ENTITY',stateRef:'ROOM-STATE'})),domainGraph:{entities:[{id:'ROOM-ENTITY',type:'LOCATION'}],states:[{id:'ROOM-STATE',entityId:'ROOM-ENTITY',authority:'L'}],representations:[]},spatialEvidence:{sourceRef:'production/maps.json',sourceSha256:productionHash('map'),locations:[{id:'ROOM'}],locationPackages:[{id:'ROOM',zones:[{id:'ZONE'}],cameras:[{id:'CAM',zoneId:'ZONE'}]}]},sourceHashes:{productionMapSha256:productionHash('map')}};
 if(withVoice){
  for(const shot of content.shots)shot.materialRequirementRefs.push('REQ-VOICE');
  plan.contentHash=productionHash(content);model.scopeLocks[0].shotPlanSetRevisionHash=plan.contentHash;model.shots.forEach(s=>s.shotPlanSetRevisionHash=plan.contentHash);
  model.materialRequirements.push({id:'REQ-VOICE',requirementClass:'REQUIRED',assetFamilyRefs:['VOICE'],representationRef:'REP-VOICE'});
  model.domainGraph.representations.push({id:'REP-VOICE',entityId:'SPEAKER',type:'VOICE_IDENTITY',assetFamilyIds:['VOICE'],requirementIds:['REQ-VOICE']});
 }
 const scope=resolveShotProductionScope(model,sceneId),settings=defaultShotProductionPlan(scope,{schemaVersion});
 for(const [index,s] of settings.shots.entries())Object.assign(s,{keyframeStrategy:{mode:'START_END',reason:'明确起止姿态',intermediateFrameCount:0},space:{loc:'ROOM',zone:'ZONE',camera:'CAM',state:'ROOM-STATE',freeze:productionHash('map')},inputs:[{requirementId:'REQ-'+(index+1),familyId:'BASE-'+(index+1),versionId:'BASE-'+(index+1)+'@V1',sha256:productionHash('base'+index),purpose:'REFERENCE'}],videoBranch:'SILENT'});
 if(withVoice)for(const s of settings.shots)s.inputs.push({requirementId:'REQ-VOICE',familyId:'VOICE',versionId:'VOICE@V1',sha256:productionHash('voice'),purpose:'VOICE_MASTER'});
 Object.assign(model,compileShotProductionPlan(scope,settings,{id:'PROD-1',revisionId:'PROD-REV-1',sourceRef:'story/production.json'}));
 model.shotProductionPlans=[{id:'PROD-1',sceneId,scopeRole:'CURRENT',sourceRevisionId:'PROD-REV-1',content:settings,contentHash:productionHash(settings),workItemIds:model.workItems.map(w=>w.id)}];
 const state={assetFamiliesById:{},assetVersionsById:{}},aux=new Map(),media=new Map(),view={releaseId:'RELEASE-instance',snapshot:{snapshotId:'SNAP-1',productionModel:model,creativeLineage:{spatialEvidence:model.spatialEvidence},sourceHashes:model.sourceHashes},eventsByKind:{review:[]}};let sequence=0;
 const tx={readView:async()=>view,getMetadata:async()=>({instanceId:'INSTANCE-test',runtimeEpoch:1,releaseId:view.releaseId}),getAux:async(ns,key)=>aux.get(ns+'|'+key)||null,listAux:async ns=>[...aux.entries()].filter(([key])=>key.startsWith(ns+'|')).map(([,value])=>value),putAux:async({namespace,key,bytes,expectedRevisionId})=>{const old=aux.get(namespace+'|'+key);assert.equal(old?.revisionId||null,expectedRevisionId);const record={bytes,revisionId:'aux-'+(++sequence)};aux.set(namespace+'|'+key,record);return record;},getMedia:async(f,v)=>media.get(f+'|'+v),getPublishedDocument:async source=>source===model.spatialEvidence.sourceRef?{sha256:model.spatialEvidence.sourceSha256}:null,appendEvent:async({kind,payload})=>{const event={...payload,eventId:'EVENT-'+(++sequence),eventSequence:sequence};(view.eventsByKind[kind]??=[]).unshift(event);return{event};},registerMedia:async row=>{media.set(row.mediaId+'|'+row.versionId,{...row,availability:'PRESENT'});return row;}};
 function register(family,versionId,sha256){state.assetFamiliesById[family.id]={...family,currentVersionId:versionId,canFlowDownstream:true};state.assetVersionsById[versionId]={id:versionId,familyId:family.id,path:'media/'+versionId,sha256,canFlowDownstream:true};media.set(family.id+'|'+versionId,{mediaId:family.id,versionId,sha256,relativePath:'media/'+versionId,availability:'PRESENT',metadata:{authorityDomain:'FORMAL'}});}
 for(const s of settings.shots)for(const b of s.inputs)register({id:b.familyId},b.versionId,b.sha256);
 for(const family of model.assetFamilies)register(family,family.id+'@V1',productionHash(family.id));
 const animaticWork=model.workItems.find(w=>w.deliverableKey==='ANIMATIC'),animaticVersionId=state.assetFamiliesById[animaticWork.outputAssetRef].currentVersionId;
 model.animaticLocks=[{sceneId,scopeRole:'CURRENT',shotPlanRevisionId:plan.id,renderJobId:'RENDER-1',timelineRevisionId:'TL-1',reviewEventId:'ANIM-REVIEW',shotSlices:settings.shots.map(s=>({shotId:s.shotId,...Object.fromEntries(['timingHash','visualHash','overlayHash','boundaryHash'].map(h=>[h,productionHash(h+s.shotId)]))}))}];
 model.animaticRenderJobs=[{jobId:'RENDER-1',status:'SUCCEEDED',result:{versionId:animaticVersionId}}];model.animaticTimelines=[{timelineRevisionId:'TL-1',content:{shots:settings.shots.map(s=>({shotId:s.shotId}))}}];
 const work=(kind,shotId='SHOT-1')=>model.workItems.find(w=>w.deliverableKey===kind&&(w.shotId===shotId||w.scopeType==='SCENE'));
 const version=w=>state.assetFamiliesById[w.outputAssetRef].currentVersionId;
 const template=w=>readShotProductionReviewEvidence(tx,{workItemId:w.id,versionId:version(w),model,state});
 function review(w,evidence){const p=model.workPackages.find(p=>p.workItemRefs.includes(w.id)),ctx=model.reviewContexts.find(c=>c.id===w.reviewContextRef),v=state.assetVersionsById[version(w)],event={eventId:'REVIEW-'+(++sequence),eventSequence:sequence,recordedAt:'2026-09-08T00:00:00.000Z',schemaVersion:'2.2',subjectType:'WORK_PRODUCT',subjectId:w.id,workItemId:w.id,workPackageId:p.id,productionGateId:w.gateId,productionPhaseId:w.phaseId,scopeType:w.scopeType,scopeId:w.scopeId,familyId:w.outputAssetRef,versionId:v.id,versionSha256:v.sha256,reviewContextRef:ctx.id,contextHash:ctx.contextHash,action:'APPROVE_AND_RELEASE',applicationStatus:'APPLIED',effect:'APPLIED',canFlowDownstream:true,adoptionIntent:'ADOPT_THIS_VERSION',shotProductionEvidence:evidence};view.eventsByKind.review.unshift(event);return event;}
 const apply=event=>recordShotProductionReview(tx,{reviewEventId:event.eventId,model,state});
 return{model,settings,state,tx,aux,media,view,work,version,template,review,apply,register};
}
const finding=note=>({outcome:'PASS',note});
const joint={continuity:finding('首尾人物身份、姿态与道具状态一致，动作转换可连续完成'),composition:finding('起止景别与视线关系符合本镜设计')};
async function approveInputs(f){if((await f.tx.listAux(SHOT_LOCK_NS.records)).some(r=>JSON.parse(r.bytes).kind==='INPUT_LOCK'))return;const work=f.work('SHOT_INPUT_LOCK'),template=await f.template(work);await f.apply(f.review(work,template.evidence));}
async function approveFrames(f,shotId='SHOT-1'){
 await approveInputs(f);
 for(const kind of ['START_FRAME','END_FRAME']){const w=f.work(kind,shotId),t=await f.template(w);t.evidence.observedImageIds=t.requiredObservedImageIds;t.evidence.jointFindings=joint;await f.apply(f.review(w,t.evidence));}
 return (await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state})).shotKeyframeSets.find(s=>s.shotId===shotId&&s.scopeRole==='CURRENT');
}

test('formal input lock proves exact adopted media and registered source; request data alone cannot create a record',async()=>{
 const f=fixture(),w=f.work('SHOT_INPUT_LOCK'),t=await f.template(w);assert.deepEqual(t.requiredObservedImageIds,[]);
 assert.equal(await f.apply({eventId:'FORGED'}),null);assert.equal(f.aux.size,0);
 const event=f.review(w,t.evidence),binding=f.settings.shots[0].inputs[0];f.state.assetFamiliesById[binding.familyId].canFlowDownstream=false;
 await assert.rejects(f.apply(event),/实际采用/);assert.equal(f.aux.size,0);f.state.assetFamiliesById[binding.familyId].canFlowDownstream=true;
 const result=await f.apply(event);assert.equal(result.kind,'INPUT_LOCK');assert.equal(result.perShotHashes.length,2);assert.deepEqual(await f.apply(event),result);assert.equal((await f.tx.listAux(SHOT_LOCK_NS.records)).length,1);
 f.state.assetVersionsById[binding.versionId].sha256=productionHash('changed');const projection=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(projection.shotInputLocks[0].scopeRole,'CURRENT');assert.deepEqual(projection.shotInputLocks[0].applicableShotIds,['SHOT-2']);
});
test('space freeze rejects arbitrary identifiers, cross-location coordinates and unbound material state',()=>{
 const f=fixture();assert.deepEqual(productionSpaceReasons(f.model,f.settings.shots[0]),[]);
 for(const [key,value] of [['freeze','FREEZE-1'],['loc','OTHER'],['camera','OTHER'],['zone','OTHER'],['state','OTHER']]){const s=structuredClone(f.settings.shots[0]);s.space[key]=value;assert.ok(productionSpaceReasons(f.model,s).length);}
 f.settings.shots[0].inputs=[];assert.ok(productionSpaceReasons(f.model,f.settings.shots[0]).includes('SPACE_STATE_NOT_BOUND_TO_ADOPTED_INPUT'));
});
test('frame adoption does not invent joint observations; complete independently reviewed members create one immutable set',async()=>{
 const f=fixture();await approveInputs(f);const start=f.work('START_FRAME'),end=f.work('END_FRAME'),first=await f.template(start);
 assert.deepEqual(first.evidence.observedImageIds,[]);assert.deepEqual(first.evidence.jointFindings,{});assert.equal(first.observationMedia[0].sha256,f.state.assetVersionsById[first.requiredObservedImageIds[0]].sha256);
 await assert.rejects(f.apply(f.review(start,first.evidence)),/实际观察/);
 first.evidence.observedImageIds=[f.version(start)];assert.equal((await f.apply(f.review(start,first.evidence))).pending,true);assert.equal((await f.tx.listAux(SHOT_LOCK_NS.records)).length,1);
 const last=await f.template(end);last.evidence.observedImageIds=last.requiredObservedImageIds;await assert.rejects(f.apply(f.review(end,last.evidence)),/逐项实际验收/);
 last.evidence.jointFindings=joint;const event=f.review(end,last.evidence),record=await f.apply(event);assert.equal(record.kind,'KEYFRAME_SET');assert.equal(record.members.length,2);assert.equal(record.memberReviewEventIds.length,2);assert.equal(record.jointReviewEventId,event.eventId);assert.deepEqual(await f.apply(event),record);
 const projected=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(projected.shotKeyframeSets[0].scopeRole,'CURRENT');
});
test('strategy slots, local hashes and exact member SHA must agree across all frame review events',async()=>{
 const f=fixture();await approveInputs(f);const start=f.work('START_FRAME'),first=await f.template(start);first.evidence.observedImageIds=first.requiredObservedImageIds;await f.apply(f.review(start,first.evidence));
 const end=f.work('END_FRAME'),last=await f.template(end);last.evidence.observedImageIds=last.requiredObservedImageIds;last.evidence.jointFindings=joint;
 last.evidence.members[1].sha256=productionHash('wrong');await assert.rejects(f.apply(f.review(end,last.evidence)),/全部关键帧/);
 const reset=await f.template(end);reset.evidence.observedImageIds=reset.requiredObservedImageIds;reset.evidence.jointFindings=joint;f.model.animaticLocks[0].shotSlices[0].visualHash=productionHash('new framing');await assert.rejects(f.apply(f.review(end,reset.evidence)),/Animatic/);
 const broken=fixture();broken.model.workItems=broken.model.workItems.filter(w=>w.id!==broken.work('END_FRAME').id);await assert.rejects(broken.template(broken.work('START_FRAME')),/完整覆盖/);
});
test('local invalidation preserves other shots and media adoption; unchanged plan ownership may be reused',async()=>{
 const f=fixture(),a=await approveFrames(f),b=await approveFrames(f,'SHOT-2');assert.ok(a&&b);
 const old=f.model.shotProductionPlans[0];old.scopeRole='EVIDENCE_ONLY';f.model.shotProductionPlans.unshift({...structuredClone(old),id:'PROD-2',sourceRevisionId:'PROD-REV-2',scopeRole:'CURRENT'});
 let result=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(result.shotKeyframeSets.filter(s=>s.scopeRole==='CURRENT').length,2);
 f.model.animaticLocks[0].shotSlices[0].overlayHash=productionHash('card changed');result=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(result.shotKeyframeSets.find(s=>s.id===a.id).scopeRole,'EVIDENCE_ONLY');assert.equal(result.shotKeyframeSets.find(s=>s.id===b.id).scopeRole,'CURRENT');assert.equal(f.state.assetFamiliesById[a.members[0].familyId].canFlowDownstream,true);
});
test('an older input lock retains only unchanged per-shot closure after a new scene input plan',async()=>{
 const f=fixture(),w=f.work('SHOT_INPUT_LOCK'),template=await f.template(w);await f.apply(f.review(w,template.evidence));const old=f.model.shotProductionPlans[0];old.scopeRole='EVIDENCE_ONLY';
 const next={...structuredClone(old),id:'PROD-2',sourceRevisionId:'PROD-REV-2',scopeRole:'CURRENT'};next.content.shots[0].inputs[0].purpose='CHANGED';f.model.shotProductionPlans.unshift(next);w.activeInCurrentProduction=false;w.scopeRole='EVIDENCE_ONLY';
 const result=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(result.shotInputLocks[0].scopeRole,'CURRENT');assert.deepEqual(result.shotInputLocks[0].perShotHashes.map(s=>s.shotId),['SHOT-2']);
});
test('shot lock requires actual reviewed video, complete playback observations and five explicit acceptance findings',async()=>{
 const f=fixture(),set=await approveFrames(f),video=f.work('SHOT_VIDEO');f.review(video,null);const lock=f.work('LOCKED_SHOT'),template=await f.template(lock);
 assert.equal(template.requiredObservedVideoIds.length,2);assert.equal(template.evidence.keyframeSetId,set.id);assert.deepEqual(template.evidence.adjacentShotIds,['SHOT-2']);
 await assert.rejects(f.apply(f.review(lock,template.evidence)),/实际观察/);template.evidence.observedVideoIds=template.requiredObservedVideoIds;await assert.rejects(f.apply(f.review(lock,template.evidence)),/逐项实际验收/);
 template.evidence.videoFindings=Object.fromEntries(['action','camera','consistency','timing','adjacency'].map(k=>[k,finding('已在完整上下文逐帧检查：'+k)]));const record=await f.apply(f.review(lock,template.evidence));assert.equal(record.kind,'SHOT_LOCK');assert.equal(record.members[0].versionId,f.version(video));
 let projected=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(projected.shotLocks[0].scopeRole,'CURRENT');
 f.model.animaticLocks[0].shotSlices[0].boundaryHash=productionHash('reorder');projected=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(projected.shotLocks[0].scopeRole,'EVIDENCE_ONLY');
});
test('evidence rejects unsupported fields and immutable proof corruption fails closed',async()=>{
 assert.throws(()=>validateShotProductionEvidence({schemaVersion:'1.0',kind:'KEYFRAME',approveAll:true}),/结构无效/);const f=fixture(),set=await approveFrames(f),entry=f.aux.get(SHOT_LOCK_NS.records+'|'+set.id),tampered=JSON.parse(entry.bytes);tampered.members=[];entry.bytes=JSON.stringify(tampered);
 const result=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(result.shotKeyframeSets[0].scopeRole,'EVIDENCE_ONLY');assert.ok(result.shotKeyframeSets[0].staleReasons.includes('LOCK_PROOF_HASH_MISMATCH'));
});

async function manifestFixture(t,options){
 const f=fixture(options),parent=path.resolve('tests/.test-tmp');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'shot-manifest-'));await mkdir(path.join(root,'media'));
 for(let i=0;i<f.settings.shots.length;i++){const b=f.settings.shots[i].inputs[0];const bytes=Buffer.from(canonicalJson('base'+i));await writeFile(path.join(root,'media',b.versionId),bytes);f.media.get(b.familyId+'|'+b.versionId).byteSize=bytes.length;}
 t.after(()=>rm(root,{recursive:true,force:true}));const repository={readOnly:false,readTransaction:fn=>fn(f.tx),writeTransaction:fn=>fn(f.tx),withMediaReadLease:fn=>fn({assertHeld:async()=>{}})};
 return{...f,root,repository,api:{projectOperationalState:()=>f.state}};
}
test('deterministic manifest queues with CAS, writes actual SHA bytes and registers a candidate without review or model run',async t=>{
 const f=await manifestFixture(t),workItemId=f.work('SHOT_INPUT_LOCK').id,options={model:f.model,state:f.state},preview=await previewShotProductionManifest(f.tx,{workItemId,...options}),input={workItemId,requestId:'manifest:create:1',expectedReleaseId:preview.expectedReleaseId,manifestHash:preview.manifestHash};
 const queued=await enqueueShotProductionManifest(f.tx,input,options);assert.deepEqual(await enqueueShotProductionManifest(f.tx,input,options),queued);assert.equal(f.view.eventsByKind['asset-version'],undefined);
 await assert.rejects(enqueueShotProductionManifest(f.tx,{...input,requestId:'manifest:create:2',manifestHash:productionHash('changed')},options),/基线已变化/);
 const claimed=await claimShotProductionManifest(f.tx,{jobId:queued.jobId,workerId:'WORKER-1'},options),result=await writeShotProductionManifest({repository:f.repository,instanceRoot:f.root,job:claimed.job});
 assert.equal(result.sha256,sha256(await readFile(path.join(f.root,result.relativePath))));assert.equal(JSON.parse(await readFile(path.join(f.root,result.relativePath),'utf8')).lockState,'REVIEW_REQUIRED');
 await assert.rejects(writeShotProductionManifest({repository:f.repository,instanceRoot:f.root,job:claimed.job}),/EEXIST/);
 await finishShotProductionManifest(f.tx,{jobId:queued.jobId,jobRevisionId:claimed.jobRevisionId,workerId:'WORKER-1',result},options);
 const projected=await applyShotProductionManifestProjection(f.tx,f.model),candidate=f.view.eventsByKind['asset-version'][0];assert.equal(shotManifestCandidateMatchesJob(candidate,projected.shotProductionManifestJobs),true);assert.equal(shotManifestCandidateMatchesJob({...candidate,sha256:productionHash('spoof')},projected.shotProductionManifestJobs),false);assert.equal(candidate.executorKind,'DETERMINISTIC_MANIFEST');assert.equal(candidate.observation,'UNOBSERVED');assert.equal(candidate.modelRunId,undefined);assert.equal(f.view.eventsByKind.review.length,0);assert.equal(f.view.eventsByKind.run,undefined);
});
test('manifest claim and completion revalidate exact inputs; missing or altered real media cannot be rendered',async t=>{
 const f=await manifestFixture(t),workItemId=f.work('SHOT_INPUT_LOCK').id,options={model:f.model,state:f.state},preview=await previewShotProductionManifest(f.tx,{workItemId,...options}),input={workItemId,requestId:'manifest:claim:1',expectedReleaseId:preview.expectedReleaseId,manifestHash:preview.manifestHash},queued=await enqueueShotProductionManifest(f.tx,input,options);
 f.state.assetFamiliesById['BASE-1'].canFlowDownstream=false;await assert.rejects(claimShotProductionManifest(f.tx,{jobId:queued.jobId,workerId:'WORKER-1'},options),/实际采用/);f.state.assetFamiliesById['BASE-1'].canFlowDownstream=true;
 const claimed=await claimShotProductionManifest(f.tx,{jobId:queued.jobId,workerId:'WORKER-1'},options);await writeFile(path.join(f.root,'media','BASE-1@V1'),'altered');await assert.rejects(writeShotProductionManifest({repository:f.repository,instanceRoot:f.root,job:claimed.job}),/SHA|hash|bytes/i);assert.equal(f.view.eventsByKind['asset-version'],undefined);
});
test('manifest refuses symlink output and unknown completion never retries',async t=>{
 const f=await manifestFixture(t),workItemId=f.work('SHOT_INPUT_LOCK').id,preview=await previewShotProductionManifest(f.tx,{workItemId,model:f.model,state:f.state});await enqueueShotProductionManifest(f.tx,{workItemId,requestId:'manifest:unknown:1',expectedReleaseId:preview.expectedReleaseId,manifestHash:preview.manifestHash},{model:f.model,state:f.state});
 const first=await runShotProductionManifestIteration({repository:f.repository,instanceRoot:f.root,workerId:'WORKER-1',api:f.api,write:async({job})=>{const target=path.join(f.root,job.expectedOutput.targetPath);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,'unregistered');throw Error('completion transport failed');}});assert.equal(first.status,'RESULT_UNKNOWN');assert.equal((await runShotProductionManifestIteration({repository:f.repository,instanceRoot:f.root,workerId:'WORKER-1',api:f.api})).processed,false);assert.equal(f.view.eventsByKind['asset-version'],undefined);
 await assert.rejects(enqueueShotProductionManifest(f.tx,{workItemId,requestId:'manifest:unknown:2',expectedReleaseId:preview.expectedReleaseId,manifestHash:preview.manifestHash},{model:f.model,state:f.state}),/结果待核/);
 const g=await manifestFixture(t),p=await previewShotProductionManifest(g.tx,{workItemId:g.work('SHOT_INPUT_LOCK').id,model:g.model,state:g.state}),q=await enqueueShotProductionManifest(g.tx,{workItemId:g.work('SHOT_INPUT_LOCK').id,requestId:'manifest:symlink:1',expectedReleaseId:p.expectedReleaseId,manifestHash:p.manifestHash},{model:g.model,state:g.state}),claim=await claimShotProductionManifest(g.tx,{jobId:q.jobId,workerId:'WORKER-1'},{model:g.model,state:g.state});await symlink(g.root,path.join(g.root,'media','_review_pending'));await assert.rejects(writeShotProductionManifest({repository:g.repository,instanceRoot:g.root,job:claim.job}),/符号链接/);
});

test('V2 visual input lock is one SHOT and ignores missing voices and unrelated shot media',async()=>{
 const f=fixture({schemaVersion:'2.0',withVoice:true}),w=f.work('SHOT_INPUT_LOCK'),t=await f.template(w);
 assert.equal(w.scopeType,'SHOT');assert.equal(w.scopeId,'SHOT-1');assert.equal(f.model.workItems.filter(w=>w.deliverableKey==='SHOT_INPUT_LOCK').length,2);
 assert.equal(t.evidence.shotId,'SHOT-1');assert.equal(t.evidence.inputHash,shotProductionVisualInputHash(f.model,f.settings.shots[0]));
 assert.deepEqual(f.settings.shots[0].visualRequirementIds,['REQ-1']);
 f.state.assetFamiliesById.VOICE.canFlowDownstream=false;f.media.delete('VOICE|VOICE@V1');
 f.state.assetFamiliesById['BASE-2'].canFlowDownstream=false;f.media.delete('BASE-2|BASE-2@V1');
 const record=await f.apply(f.review(w,t.evidence));assert.equal(record.shotId,'SHOT-1');assert.equal(record.perShotHashes.length,1);assert.equal(record.inputBindings.length,1);assert.deepEqual(record.inputBindings[0].inputs,[f.settings.shots[0].inputs[0]]);
 const projected=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.deepEqual(projected.shotInputLocks[0].applicableShotIds,['SHOT-1']);
 const other=f.work('SHOT_INPUT_LOCK','SHOT-2');await assert.rejects(f.apply(f.review(other,(await f.template(other)).evidence)),/实际采用/);
});
test('V2 visual lock still requires own source, state, adopted exact SHA and rejects PREVIS media',async()=>{
 for(const mode of ['source','sha','adoption','previs']){
  const f=fixture({schemaVersion:'2.0'}),w=f.work('SHOT_INPUT_LOCK');
  if(mode==='source')f.tx.getPublishedDocument=async()=>null;
  if(mode==='sha')f.media.get('BASE-1|BASE-1@V1').sha256=productionHash('changed');
  if(mode==='adoption')f.state.assetFamiliesById['BASE-1'].canFlowDownstream=false;
  if(mode==='previs'){
   const board=f.work('STORYBOARD'),family=f.model.assetFamilies.find(a=>a.id===board.outputAssetRef),version=f.state.assetVersionsById[f.version(board)];
   f.settings.shots[0].inputs[0]={requirementId:'REQ-1',familyId:family.id,versionId:version.id,sha256:version.sha256,purpose:'REFERENCE'};
   f.model.materialRequirements[0].assetFamilyRefs=[family.id];
   w.outputBasisHash=compileShotProductionPlan(resolveShotProductionScope(f.model,'SCENE-test'),f.settings,{id:'PROD-1',revisionId:'PROD-REV-1',sourceRef:'story/production.json'}).workItems.find(n=>n.id===w.id).outputBasisHash;
  }
  await assert.rejects(f.apply(f.review(w,(await f.template(w)).evidence)),/源字节|受管实际媒体|实际采用/);
  assert.equal((await f.tx.listAux(SHOT_LOCK_NS.records)).length,0);
 }
});
test('V2 visual lock reuse is local; unrelated shot and voice changes do not alter its immutable proof',async()=>{
 const f=fixture({schemaVersion:'2.0',withVoice:true}),w=f.work('SHOT_INPUT_LOCK'),record=await f.apply(f.review(w,(await f.template(w)).evidence));
 const old=f.model.shotProductionPlans[0],original=canonicalJson(record);old.scopeRole='EVIDENCE_ONLY';
 const next={...structuredClone(old),id:'PROD-2',sourceRevisionId:'PROD-REV-2',scopeRole:'CURRENT'};
 next.content.shots[0].inputs[1].sha256=productionHash('voice changed');next.content.shots[1].inputs[0].sha256=productionHash('other image changed');f.model.shotProductionPlans.unshift(next);
 let p=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(p.shotInputLocks[0].scopeRole,'CURRENT');assert.deepEqual(p.shotInputLocks[0].applicableShotIds,['SHOT-1']);
 next.content.shots[0].inputs[0].sha256=productionHash('own image changed');p=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(p.shotInputLocks[0].scopeRole,'EVIDENCE_ONLY');
 assert.equal(canonicalJson(JSON.parse(f.aux.get(SHOT_LOCK_NS.records+'|'+record.id).bytes)),original);
});
test('V2 own visual lock permits its keyframe set before other shot input locks or final voice',async()=>{
 const f=fixture({schemaVersion:'2.0',withVoice:true});f.state.assetFamiliesById.VOICE.canFlowDownstream=false;
 const set=await approveFrames(f);assert.equal(set.scopeRole,'CURRENT');
 const p=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(p.shotInputLocks.length,1);assert.equal(p.shotInputLocks[0].shotId,'SHOT-1');
 const other=f.work('START_FRAME','SHOT-2'),t=await f.template(other);t.evidence.observedImageIds=t.requiredObservedImageIds;t.evidence.jointFindings=joint;
 await assert.rejects(f.apply(f.review(other,t.evidence)),/本镜实际输入/);
});
test('V2 manifest renders only own visual inputs and preserves exact protocol and review-required status',async t=>{
 const f=await manifestFixture(t,{schemaVersion:'2.0',withVoice:true}),w=f.work('SHOT_INPUT_LOCK'),options={model:f.model,state:f.state};
 f.state.assetFamiliesById.VOICE.canFlowDownstream=false;f.media.delete('BASE-2|BASE-2@V1');
 const preview=await previewShotProductionManifest(f.tx,{workItemId:w.id,...options});
 assert.equal(preview.content.protocol,'SHOT_PRODUCTION_MANIFEST_V2');assert.equal(preview.content.stagePolicy,'PREVIS_FIRST_V1');assert.equal(preview.content.shotId,'SHOT-1');assert.equal(preview.inputBindings.length,1);assert.equal(preview.inputBindings[0].familyId,'BASE-1');
 const queued=await enqueueShotProductionManifest(f.tx,{workItemId:w.id,requestId:'manifest:v2:1',expectedReleaseId:preview.expectedReleaseId,manifestHash:preview.manifestHash},options);
 const claimed=await claimShotProductionManifest(f.tx,{jobId:queued.jobId,workerId:'WORKER-1'},options),result=await writeShotProductionManifest({repository:f.repository,instanceRoot:f.root,job:claimed.job});
 const content=JSON.parse(await readFile(path.join(f.root,result.relativePath),'utf8'));assert.equal(content.inputBindings.length,1);assert.equal(content.formalReviewCreated,false);assert.equal(content.lockState,'REVIEW_REQUIRED');assert.equal(f.view.eventsByKind.review.length,0);
 await finishShotProductionManifest(f.tx,{jobId:queued.jobId,jobRevisionId:claimed.jobRevisionId,workerId:'WORKER-1',result},options);
 const candidate=f.view.eventsByKind['asset-version'][0];assert.equal(candidate.productionSchemaVersion,'2.0');assert.equal(candidate.stagePolicy,'PREVIS_FIRST_V1');assert.equal(candidate.productionPurpose,'FINAL_PRODUCTION');assert.equal(candidate.allowedUse,'PRODUCTION');assert.equal(candidate.executorKind,'DETERMINISTIC_MANIFEST');assert.equal(candidate.modelRunId,undefined);assert.equal(f.view.eventsByKind.review.length,0);
});
test('V2 shot lock accepts PREVIS Animatic only as adopted exact review evidence',async()=>{
 const f=fixture({schemaVersion:'2.0'});await approveFrames(f);const video=f.work('SHOT_VIDEO');f.review(video,null);const lock=f.work('LOCKED_SHOT');
 const t=await f.template(lock),animatic=f.work('ANIMATIC'),animaticVersion=f.version(animatic),options={model:f.model,state:f.state};
 const preview=await previewShotProductionManifest(f.tx,{workItemId:lock.id,...options});assert.deepEqual(preview.content.reviewEvidenceBindings,[{familyId:animatic.outputAssetRef,versionId:animaticVersion,sha256:f.state.assetVersionsById[animaticVersion].sha256,consumerRole:'PREVIS_TIMING'}]);
 t.evidence.observedVideoIds=t.requiredObservedVideoIds;t.evidence.videoFindings=Object.fromEntries(['action','camera','consistency','timing','adjacency'].map(k=>[k,finding('实际视频与预演逐项核对：'+k)]));
 const record=await f.apply(f.review(lock,t.evidence));assert.equal(record.kind,'SHOT_LOCK');
 f.state.assetFamiliesById[animatic.outputAssetRef].canFlowDownstream=false;
 await assert.rejects(f.template(lock),/预演版本尚未实际放行/);
 const p=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(p.shotLocks[0].scopeRole,'EVIDENCE_ONLY');assert.equal(p.shotKeyframeSets[0].scopeRole,'CURRENT');
});
test('V2 visual lock rejects missing own visual requirements and frozen space',async()=>{
 for(const mode of ['input','space']){
  const f=fixture({schemaVersion:'2.0'}),w=f.work('SHOT_INPUT_LOCK');
  if(mode==='input')f.settings.shots[0].inputs=[];else f.settings.shots[0].space.camera='UNKNOWN';
  w.outputBasisHash=compileShotProductionPlan(resolveShotProductionScope(f.model,'SCENE-test'),f.settings,{id:'PROD-1',revisionId:'PROD-REV-1',sourceRef:'story/production.json'}).workItems.find(n=>n.id===w.id).outputBasisHash;
  await assert.rejects(f.apply(f.review(w,(await f.template(w)).evidence)),mode==='input'?/本镜视觉输入锁尚缺实际素材/:/SPACE_BINDING_REQUIRED/);
  assert.equal(f.aux.size,0);
 }
});
test('V2 local timing changes reopen only the affected keyframe set and retain its visual input lock',async()=>{
 const f=fixture({schemaVersion:'2.0'}),first=await approveFrames(f),other=f.work('SHOT_INPUT_LOCK','SHOT-2');await f.apply(f.review(other,(await f.template(other)).evidence));const second=await approveFrames(f,'SHOT-2');
 f.model.animaticLocks[0].shotSlices[0].timingHash=productionHash('longer first shot');
 const p=await applyShotProductionLocksProjection(f.tx,f.model,{state:f.state});assert.equal(p.shotKeyframeSets.find(s=>s.id===first.id).scopeRole,'EVIDENCE_ONLY');assert.equal(p.shotKeyframeSets.find(s=>s.id===second.id).scopeRole,'CURRENT');assert.equal(p.shotInputLocks.filter(s=>s.scopeRole==='CURRENT').length,2);
});
