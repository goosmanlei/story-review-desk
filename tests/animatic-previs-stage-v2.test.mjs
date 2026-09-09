import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {blankProfile,blankSnapshot} from '../host/instance-runtime/blank.mjs';
import {createInstanceRepository} from '../host/instance-runtime/index.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {defaultShotProductionPlan,validateShotProductionPlan,compileShotProductionPlan,resolveShotProductionScope,productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {reuseShotProductionObjects} from '../host/instance-runtime/shot-production-reuse.mjs';
import {resolveShotProductionProducer} from '../host/instance-runtime/shot-production-stage-policy.mjs';
import {animaticHashes,animaticSchedule,animaticImpact,validateAnimaticTimeline} from '../host/instance-runtime/animatic-model.mjs';
import {assertAnimaticInputs,readAnimaticState,saveAnimaticTimeline,reconcileAnimaticLocks} from '../host/instance-runtime/animatic-service.mjs';
import {fixture as productionFixture,sceneId,episodeUid} from './shot-previs-stage-v2.fixture.mjs';

const keys=['workItems','workPackages','assetFamilies','expectedOutputs','reviewContexts'];
const copy=value=>structuredClone(value);
const active=clip=>!clip.muted&&clip.volume>0;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2VQAAAAASUVORK5CYII=','base64');
function wav(){const buffer=Buffer.alloc(44+48000*2*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(48000,24);buffer.writeUInt32LE(96000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(buffer.length-44,40);return buffer;}

// Real V2 compiler/source revisions, reuse lineage and actual registered local
// bytes; canFlowDownstream is an explicitly declared approval fixture. These
// tests do not claim to generate or review story media or exercise audio quality.
async function fixture(t){
 const temporaryParent=path.resolve(import.meta.dirname,'.test-tmp');await mkdir(temporaryParent,{recursive:true});
 const root=await mkdtemp(path.join(temporaryParent,'animatic-previs-v2-'));await mkdir(path.join(root,'media'));
 const profile=blankProfile({title:'Independent PREVIS V2 Animatic test'}),repo=await createInstanceRepository({dbPath:path.join(root,'data/test.sqlite'),instanceId:profile.instanceId,profile});
 t.after(async()=>{await repo.close();await rm(root,{recursive:true,force:true});});
 const snapshot=blankSnapshot(profile),model=snapshot.snapshot.productionModel;Object.assign(model,productionFixture().model);model.assetFamilies=[];model.assetVersions=[];
 const design=model.shotPlanSetRevisions[0],third={...copy(design.content.shots[1]),shotId:sceneId+'-SH03',order:3};design.content.shots.push(third);design.contentHash=productionHash(design.content);design.scopeType='SCENE';design.sceneId=sceneId;
 model.shots=design.content.shots.map(s=>({...s,id:s.shotId,scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:design.id,shotPlanSetRevisionHash:design.contentHash}));
 model.scopeLocks[0].shotIds=model.shots.map(s=>s.id);model.scopeLocks[0].shotPlanSetRevisionHash=design.contentHash;
 const scope=resolveShotProductionScope(model,sceneId),content=defaultShotProductionPlan(scope);
 for(const [index,shot] of content.shots.entries()){shot.keyframeStrategy={mode:'START_ONLY',reason:'简单表演',intermediateFrameCount:0};shot.dialogueLines=index===1?[]:[{id:'LINE-'+(index+1),text:'这是给我的？',speakerEntityId:'ENTITY-girl',purpose:'TEMPORARY',performance:'迟疑'}];}
 const settings=validateShotProductionPlan(content,scope);
 await repo.writeTransaction(async tx=>{
  const source=await tx.putDocument({documentId:'test:previs-plan:initial',aliases:['story/shot-production/previs-initial.json'],expectedRevisionId:null,bytes:canonicalJson({schemaVersion:'1.0',content:settings,contentHash:productionHash(settings)}),metadata:{sourceRole:'SHOT_PRODUCTION_PLAN'}});
  const compiled=compileShotProductionPlan(scope,settings,{id:'PLAN-previs-initial',revisionId:source.revisionId,sourceRef:'story/shot-production/previs-initial.json'});for(const key of keys)model[key]=compiled[key];
  model.shotProductionPlans=[{id:'PLAN-previs-initial',sceneId,episodeUid,scopeRole:'CURRENT',content:settings,contentHash:productionHash(settings),workItemIds:compiled.workItems.map(w=>w.id),sourceRevisionId:source.revisionId,sourceSha256:source.sha256,sourcePath:'story/shot-production/previs-initial.json'}];
  await tx.publishRelease({...snapshot,expectedReleaseId:null,sourceRevisionIds:[source.revisionId]});
 });
 const works=(kind,index)=>{const plan=model.shotProductionPlans.find(p=>p.scopeRole==='CURRENT');return model.workItems.filter(w=>plan.workItemIds.includes(w.id)&&w.deliverableKey===kind&&(index===undefined||w.shotId===model.shots[index].id));};
 const media=new Map();
 async function register(work,label='V001',metadata={authorityDomain:'FORMAL',visibility:'PUBLIC'}){
  const family=model.assetFamilies.find(f=>f.id===work.outputAssetRef),bytes=family.kind==='IMAGE'?png:wav(),relativePath='media/'+family.id+'-'+label+(family.kind==='IMAGE'?'.png':'.wav');
  await writeFile(path.join(root,relativePath),bytes,{flag:'wx'});const binding={familyId:family.id,versionId:family.id+'@'+label,sha256:sha256(bytes)};
  await repo.writeTransaction(tx=>tx.registerMedia({mediaId:family.id,versionId:binding.versionId,relativePath,sha256:binding.sha256,byteSize:bytes.length,metadata}));
  Object.assign(family,{currentVersionId:binding.versionId,canFlowDownstream:true});model.assetVersions.push({id:binding.versionId,familyId:family.id,path:relativePath,sha256:binding.sha256,canFlowDownstream:true,scopeRole:'CURRENT',lifecycleState:'APPROVED'});media.set(work.id,binding);return binding;
 }
 for(const work of [...works('STORYBOARD'),...works('DIALOGUE_TEMP')])await register(work);
 const shots=model.shots.map((shot,index)=>({shotId:shot.id,durationFrames:24,panels:[{id:'PANEL-'+index,media:media.get(works('STORYBOARD',index)[0].id),startFrame:0,endFrame:24,motion:'STILL'}],beats:[]}));
 const audio=works('DIALOGUE_TEMP').map((work,index)=>({id:'AUDIO-'+index,anchorShotId:work.shotId,offsetFrames:index===0?12:0,sourceInFrames:0,durationFrames:index===0?36:24,media:media.get(work.id),role:'DIALOGUE',temporary:true,volume:1,muted:false,lineIds:[work.lineId]}));
 const timeline=validateAnimaticTimeline({schemaVersion:'1.0',sceneId,shotPlanRevisionId:scope.plan.id,fps:24,width:1920,height:1080,shots,audio,cards:[]},{sceneId,shotPlanRevisionId:scope.plan.id,shotIds:shots.map(s=>s.shotId)});
 async function addFinal({registerFinal=true}={}){
  const previous=model.shotProductionPlans.find(p=>p.scopeRole==='CURRENT'),nextContent=copy(previous.content);nextContent.shots[0].dialogueLines[0].purpose='FINAL';
  await repo.writeTransaction(async tx=>{
   const view=await tx.readView(),source=await tx.putDocument({documentId:'test:previs-plan:final',aliases:['story/shot-production/previs-final.json'],expectedRevisionId:null,bytes:canonicalJson({schemaVersion:'1.0',content:nextContent,contentHash:productionHash(nextContent)}),metadata:{sourceRole:'SHOT_PRODUCTION_PLAN'}});
   const compiled=compileShotProductionPlan(scope,nextContent,{id:'PLAN-previs-final',revisionId:source.revisionId,sourceRef:'story/shot-production/previs-final.json'}),reuse=reuseShotProductionObjects(model,previous,compiled);
   assert(reuse.reusedWorkItemIds.includes(works('DIALOGUE_TEMP',0)[0].id));for(const key of keys)model[key].push(...reuse.additions[key]);previous.scopeRole='EVIDENCE_ONLY';
   model.shotProductionPlans.unshift({id:'PLAN-previs-final',sceneId,episodeUid,scopeRole:'CURRENT',content:nextContent,contentHash:productionHash(nextContent),workItemIds:reuse.workItemIds,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,sourcePath:'story/shot-production/previs-final.json'});
   await tx.publishRelease({snapshot:{...view.snapshot,productionModel:model},recipes:view.recipes,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId],expectedReleaseId:view.releaseId});
  });
  const work=works('DIALOGUE_DRY',0)[0];return {work,media:registerFinal?await register(work):null};
 }
 async function foreignDialogue(){
  const foreignModel=JSON.parse(JSON.stringify(productionFixture().model).replaceAll('SCENE-letter','SCENE-foreign'));
  const design=foreignModel.shotPlanSetRevisions[0];design.contentHash=productionHash(design.content);foreignModel.scopeLocks[0].shotPlanSetRevisionHash=design.contentHash;for(const shot of foreignModel.shots)shot.shotPlanSetRevisionHash=design.contentHash;
  const foreignScope=resolveShotProductionScope(foreignModel,'SCENE-foreign'),foreignContent=defaultShotProductionPlan(foreignScope);foreignContent.shots[0].dialogueLines=[{id:'LINE-foreign',text:'这是给我的？',speakerEntityId:'ENTITY-girl',purpose:'TEMPORARY',performance:'迟疑'}];
  let work;await repo.writeTransaction(async tx=>{const view=await tx.readView(),source=await tx.putDocument({documentId:'test:previs-plan:foreign',aliases:['story/shot-production/previs-foreign.json'],expectedRevisionId:null,bytes:canonicalJson({schemaVersion:'1.0',content:foreignContent,contentHash:productionHash(foreignContent)}),metadata:{sourceRole:'SHOT_PRODUCTION_PLAN'}}),compiled=compileShotProductionPlan(foreignScope,foreignContent,{id:'PLAN-previs-foreign',revisionId:source.revisionId,sourceRef:'story/shot-production/previs-foreign.json'});
   for(const key of keys)model[key].push(...compiled[key]);model.shotProductionPlans.push({id:'PLAN-previs-foreign',sceneId:'SCENE-foreign',episodeUid,scopeRole:'CURRENT',content:foreignContent,contentHash:productionHash(foreignContent),workItemIds:compiled.workItems.map(w=>w.id),sourceRevisionId:source.revisionId,sourceSha256:source.sha256});work=compiled.workItems.find(w=>w.deliverableKey==='DIALOGUE_TEMP');
   await tx.publishRelease({snapshot:{...view.snapshot,productionModel:model},recipes:view.recipes,sourceRevisionIds:[...view.sourceRevisionIds,source.revisionId],expectedReleaseId:view.releaseId});
  });return {work,media:await register(work)};
 }
 const state=()=>({assetFamiliesById:Object.fromEntries(model.assetFamilies.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(model.assetVersions.map(v=>[v.id,v])),workItemsById:Object.fromEntries(model.workItems.map(w=>[w.id,w]))});
 const check=(value=timeline,{render=false}={})=>repo.readTransaction(tx=>assertAnimaticInputs(tx,validateAnimaticTimeline(value),model,{render}));
 function projectedLock(value=timeline){
  const schedule=animaticSchedule(value),hashes=animaticHashes(value),renderWork=works('ANIMATIC')[0],renderFamily=model.assetFamilies.find(f=>f.id===renderWork.outputAssetRef),renderedVersion={familyId:renderFamily.id,versionId:renderFamily.id+'@V001',sha256:productionHash('declared-reviewed-render')};
  // Reconciliation receives this already-projected review fixture. No fake
  // worker Run, result file or formal Review is written to the repository.
  Object.assign(renderFamily,{currentVersionId:renderedVersion.versionId,canFlowDownstream:true});model.assetVersions.push({id:renderedVersion.versionId,familyId:renderFamily.id,sha256:renderedVersion.sha256,canFlowDownstream:true});
  const lock={productionSchemaVersion:'2.0',stagePolicy:'PREVIS_FIRST_V1',productionPurpose:'PREVIS_ONLY',allowedUse:'PREVIS_TIMING',sceneId,shotPlanRevisionId:value.shotPlanRevisionId,timelineRevisionId:'TIMELINE-reviewed',reviewEventId:'REVIEW-fixture',scopeRole:'CURRENT',fullSceneCurrent:true,applicableShotIds:value.shots.map(s=>s.shotId),renderedVersion,shotSlices:hashes.shotSlices,dialogueBindings:value.audio.filter(a=>a.role==='DIALOGUE'&&active(a)).map(copy),shotBindings:value.shots.map(shot=>{const interval=schedule.shots.find(s=>s.shotId===shot.shotId);return {shotId:shot.shotId,storyboards:shot.panels.map(p=>p.media),audio:value.audio.filter(a=>{const start=schedule.shots.find(s=>s.shotId===a.anchorShotId).startFrame+a.offsetFrames;return active(a)&&start<interval.endFrame&&start+a.durationFrames>interval.startFrame;}).map(copy)};})};
  model.animaticLocks=[lock];model.animaticTimelines=[{sceneId,timelineRevisionId:lock.timelineRevisionId,content:copy(value),hashes}];return lock;
 }
 return {repo,model,scope,timeline,works,media,register,addFinal,foreignDialogue,state,check,projectedLock};
}

test('V2 schema-1.0 Animatic draft may omit boards/dialogue; exact selected registered media still validates',async t=>{
 const f=await fixture(t),empty=copy(f.timeline);empty.shots.forEach(s=>s.panels=[]);empty.audio=[];assert.deepEqual(await f.check(empty),[]);await assert.rejects(f.check(empty,{render:true}));
 const before=await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId,model:f.model}));const saved=await f.repo.writeTransaction(tx=>saveAnimaticTimeline(tx,{sceneId,expectedReleaseId:before.releaseId,expectedRevisionId:null,requestId:'previs:draft:incomplete',content:empty},{model:f.model}));
 assert.equal(before.basis.stagePolicy,'PREVIS_FIRST_V1');assert.deepEqual(before.basis.dialogueLines.map(l=>l.lineId),['LINE-1','LINE-3']);assert(before.availableMedia.some(row=>row.deliverableKey==='DIALOGUE_TEMP'&&row.productionPurpose==='TEMPORARY'&&row.workItemId&&row.lineId==='LINE-1'));
 assert(saved.timelineRevisionId);const read=await f.repo.readTransaction(tx=>readAnimaticState(tx,{sceneId,model:f.model}));assert.equal(read.content.schemaVersion,'1.0');assert.equal(read.content.audio.length,0);
 const selected=copy(empty);selected.shots[0].panels=copy(f.timeline.shots[0].panels);assert.equal((await f.check(selected)).length,1);
 const version=f.model.assetVersions.find(v=>v.id===selected.shots[0].panels[0].media.versionId);version.canFlowDownstream=false;await assert.rejects(f.check(selected),'draft cannot freeze an unapproved selected version');
});

test('render accepts one actual TEMP per current line and may choose FINAL independently without requiring both',async t=>{
 const f=await fixture(t);assert.equal((await f.check(f.timeline,{render:true})).length,5);
 const final=await f.addFinal();assert.equal((await f.check(f.timeline,{render:true})).length,5,'unused FINAL adds no compulsory track');
 const mixed=copy(f.timeline);mixed.audio[0].media=final.media;mixed.audio[0].temporary=false;assert.equal((await f.check(mixed,{render:true})).length,5);
 assert.deepEqual(resolveShotProductionProducer(f.model,f.timeline.audio[0].media).blockers,[],'reused TEMP resolves through the immutable original EVIDENCE plan');
});

test('render requires exactly one active selection per current line; omissions, muted-only, zero-volume and duplicates fail',async t=>{
 const f=await fixture(t),final=await f.addFinal();
 for(const change of [v=>v.audio.splice(0,1),v=>{v.audio[0].muted=true;},v=>{v.audio[0].volume=0;},v=>{v.audio.push({...copy(v.audio[0]),id:'DUPLICATE-TEMP'});},v=>{v.audio.push({...copy(v.audio[0]),id:'DUPLICATE-FINAL',media:final.media,temporary:false});}]){const bad=copy(f.timeline);change(bad);await assert.rejects(f.check(bad,{render:true}));}
 const mutedAlternative=copy(f.timeline);mutedAlternative.audio.push({...copy(mutedAlternative.audio[0]),id:'MUTED-FINAL',media:final.media,temporary:false,muted:true});await f.check(mutedAlternative,{render:true});
});

test('draft dialogue purpose/line/producer closure is exact; render also checks the corresponding shot board',async t=>{
 const f=await fixture(t),final=await f.addFinal();
 const cases=[v=>{v.audio[0].temporary=false;},v=>{v.audio[0].media=final.media;},v=>{v.audio[0].lineIds=['LINE-3'];},v=>{v.audio[0].lineIds=[];},v=>{v.audio[0].lineIds=['LINE-1','LINE-3'];},v=>{v.audio[0].lineIds=['LINE-outside'];}];
 for(const [index,change] of cases.entries()){const bad=copy(f.timeline);change(bad);await assert.rejects(f.check(bad),'dialogue case '+index);}
 const wrongBoard=copy(f.timeline);wrongBoard.shots[0].panels[0].media=copy(wrongBoard.shots[2].panels[0].media);await assert.rejects(f.check(wrongBoard,{render:true}));
 const work=f.works('DIALOGUE_TEMP',0)[0],original=work.shotProductionPlanId;work.shotProductionPlanId='PLAN-unproven-outside';await assert.rejects(f.check());work.shotProductionPlanId=original;
 f.model.assetFamilies.find(family=>family.id===work.outputAssetRef).ownerRef='OTHER-work';await assert.rejects(f.check());
});

test('MUSIC/SFX cannot disguise a TEMP/FINAL dialogue asset or carry line IDs',async t=>{
 const f=await fixture(t),final=await f.addFinal();
 for(const role of ['MUSIC','SFX'])for(const binding of [f.timeline.audio[0].media,final.media]){const bad=copy(f.timeline);bad.audio[0]={...bad.audio[0],media:binding,role,lineIds:[],temporary:binding===final.media?false:true};await assert.rejects(f.check(bad));}
 const other={id:'WORK-sfx',outputAssetRef:'FAMILY-sfx'},family={id:other.outputAssetRef,ownerRef:other.id,kind:'AUDIO',label:'独立测试音效'};f.model.workItems.push(other);f.model.assetFamilies.push(family);const sound=await f.register(other);
 const good=copy(f.timeline);good.audio.push({...copy(good.audio[0]),id:'SFX-clean',role:'SFX',media:sound,lineIds:[],temporary:false});await f.check(good,{render:true});good.audio.at(-1).lineIds=['LINE-1'];await assert.rejects(f.check(good));
});

test('an actually registered, approved and source-proven foreign scene dialogue cannot bind this scene',async t=>{
 const f=await fixture(t),foreign=await f.foreignDialogue();assert.deepEqual(resolveShotProductionProducer(f.model,foreign.media).blockers,[]);
 for(const lineId of ['LINE-1','LINE-foreign']){const bad=copy(f.timeline);bad.audio[0].media=foreign.media;bad.audio[0].lineIds=[lineId];await assert.rejects(f.check(bad));await assert.rejects(f.check(bad,{render:true}));}
});

test('selected actual SHA, adoption, rights/availability and work/family/EO marker closure cannot be forged',async t=>{
 const f=await fixture(t),binding=f.timeline.audio[0].media,work=f.works('DIALOGUE_TEMP',0)[0],family=f.model.assetFamilies.find(row=>row.id===binding.familyId),version=f.model.assetVersions.find(row=>row.id===binding.versionId),eo=f.model.expectedOutputs.find(row=>row.familyId===binding.familyId);
 for(const [row,key,value] of [[version,'sha256','f'.repeat(64)],[version,'canFlowDownstream',false],[family,'canFlowDownstream',false],[family,'currentVersionId','OTHER@V001'],[version,'lifecycleState','RIGHTS_HOLD'],[work,'allowedUse','PRODUCTION'],[family,'productionPurpose','FINAL'],[eo,'allowedUse','PRODUCTION']]){const previous=row[key];row[key]=value;await assert.rejects(f.check());row[key]=previous;}
 const bad=copy(f.timeline);bad.audio[0].media.sha256='e'.repeat(64);await assert.rejects(f.check(bad));
});

test('lock reconciliation preserves all slices when an unused FINAL target is added',async t=>{
 const f=await fixture(t),lock=f.projectedLock(),before=copy(lock.shotSlices);assert.deepEqual(reconcileAnimaticLocks(f.model,f.state())[0].applicableShotIds,f.timeline.shots.map(s=>s.shotId));
 await f.addFinal({registerFinal:false});const result=reconcileAnimaticLocks(f.model,f.state())[0];assert.deepEqual(result.applicableShotIds,f.timeline.shots.map(s=>s.shotId));assert.deepEqual(result.shotSlices,before);assert.equal(result.fullSceneCurrent,true);
});

test('withdrawal of the selected cross-cut TEMP affects its covered shots, keeping the untouched shot slice',async t=>{
 const f=await fixture(t),lock=f.projectedLock();await f.addFinal();const selected=f.model.assetVersions.find(v=>v.id===f.timeline.audio[0].media.versionId);selected.canFlowDownstream=false;
 const result=reconcileAnimaticLocks(f.model,f.state())[0];assert.deepEqual(result.applicableShotIds,[f.timeline.shots[2].shotId]);assert.deepEqual(result.shotSlices,[lock.shotSlices[2]]);assert.equal(result.fullSceneCurrent,false);
});

test('replacing a selected cross-cut track changes only its overlap slices and respects adjacent boundary hashes',async t=>{
 const f=await fixture(t),lock=f.projectedLock(),final=await f.addFinal(),next=copy(f.timeline);next.audio[0].media=final.media;next.audio[0].temporary=false;
 assert.deepEqual(animaticImpact(f.timeline,next).map(row=>row.shotId),f.timeline.shots.slice(0,2).map(s=>s.shotId));
 const nextHashes=animaticHashes(next),unchanged=lock.shotSlices.filter(old=>{const current=nextHashes.shotSlices.find(row=>row.shotId===old.shotId);return old.timingHash===current.timingHash&&old.visualHash===current.visualHash&&old.boundaryHash===current.boundaryHash;}).map(row=>row.shotId);
 // This is the compatibility set supplied by the existing timeline projection;
 // reconciliation must not invalidate an unrelated shot due to the new FINAL.
 lock.applicableShotIds=unchanged;lock.fullSceneCurrent=false;f.model.animaticTimelines[0]={...f.model.animaticTimelines[0],content:next,hashes:nextHashes};
 assert.deepEqual(reconcileAnimaticLocks(f.model,f.state())[0].applicableShotIds,[f.timeline.shots[2].shotId]);
 const reordered=copy(next);[reordered.shots[1],reordered.shots[2]]=[reordered.shots[2],reordered.shots[1]];assert.equal(animaticImpact(next,reordered).filter(row=>row.boundaryChanged).length,3);
});
