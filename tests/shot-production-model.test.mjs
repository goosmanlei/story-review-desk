import test from 'node:test';
import assert from 'node:assert/strict';
import {productionHash,resolveShotProductionScope,defaultShotProductionPlan,validateShotProductionPlan,compileShotProductionPlan,productionBindingReasons,shotProductionReadiness} from '../host/instance-runtime/shot-production-model.mjs';

const copy=structuredClone,sceneId='SCENE-letter',episodeUid='EPUID-letter';
function fixture(){
 const content={sceneId,identityChangeReason:'初次镜头设计',shots:[1,2].map(i=>({shotId:`${sceneId}-SH0${i}`,sceneId,order:i,title:`镜头${i}`,narrativeBeat:'拿信后产生迟疑',audienceTakeaway:'来信改变决定',materialRequirementRefs:[`MATREQ-${i}`,'VOICE-REQ']}))};
 const plan={id:'DESIGN-r1',episodeUid,episodeNarrativeReleaseId:'RELEASE-r1',scopeId:sceneId,scopeRole:'CURRENT',sourceOperationId:'SYNC-1',sourceSyncState:'SUCCEEDED',content,contentHash:productionHash(content)};
 const model={shotPlanSetRevisions:[plan],episodeNarrativeReleases:[{id:'RELEASE-r1',episodeUid,scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',reviewInput:{scenes:[{id:sceneId,contentHash:productionHash('script')} ]}}],sceneScriptRevisions:[{id:'SCRIPT-r1',sceneId,scopeRole:'CURRENT',episodeNarrativeReleaseId:'RELEASE-r1',contentHash:productionHash('script')}],scopeLocks:[{id:'LOCK-design',scopeType:'SCENE',scopeId:sceneId,lockPurpose:'SHOT_PLAN_SET',lockState:'LOCKED',denominatorState:'KNOWN',shotPlanSetRevisionId:plan.id,shotPlanSetRevisionHash:plan.contentHash,shotIds:content.shots.map(s=>s.shotId)}],shots:content.shots.map(s=>({...s,id:s.shotId,scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:plan.id,shotPlanSetRevisionHash:plan.contentHash})),materialRequirements:[1,2].map(i=>({id:`MATREQ-${i}`,requirementClass:'REQUIRED',assetFamilyRefs:[`BASE-${i}`]}))};
 const scope=resolveShotProductionScope(model,sceneId),settings=defaultShotProductionPlan(scope);
 settings.shots.forEach((s,i)=>Object.assign(s,{keyframeStrategy:{mode:i===0?'START_ONLY':'MULTI_KEYFRAME',reason:'动作状态明确',intermediateFrameCount:i===0?0:1},dialogueLines:[{id:`LINE-${i+1}`,text:'这是给我的？',speakerEntityId:'ENTITY-girl',purpose:'FINAL',performance:'迟疑后低声问'}],inputs:[{requirementId:`MATREQ-${i+1}`,familyId:`BASE-${i+1}`,versionId:`BASE-${i+1}@V1`,sha256:productionHash(`base-${i+1}`),purpose:'REFERENCE'}],space:{loc:'ROOM',state:'NIGHT',zone:'TABLE',camera:'CAMERA-A',freeze:'FREEZE-r1'},handles:{headFrames:8,tailFrames:12},videoBranch:'POST_LIP'}));
 const mapHash=productionHash('spatial');model.sourceHashes={productionMapSha256:mapHash};model.spatialEvidence={sourceRef:'story/spatial.json',sourceSha256:mapHash,locations:[{id:'ROOM'}],locationPackages:[{id:'ROOM',zones:[{id:'TABLE'}],cameras:[{id:'CAMERA-A',zoneId:'TABLE'}]}]};model.domainGraph={entities:[{id:'ENTITY-room',type:'LOCATION'}],states:[{id:'NIGHT',entityId:'ENTITY-room',authority:'L'}],representations:[]};for(const r of model.materialRequirements){r.stateRef='NIGHT';r.entityRef='ENTITY-room';}for(const s of settings.shots)s.space.freeze=mapHash;
 model.materialRequirements.push({id:'VOICE-REQ',requirementClass:'REQUIRED',assetFamilyRefs:['VOICE-A'],requirementHash:productionHash('voice-requirement'),representationRef:'VOICE-REP'});
 model.domainGraph.entities.push({id:'ENTITY-girl',type:'CHARACTER',authority:'A'});model.domainGraph.representations.push({id:'VOICE-REP',entityId:'ENTITY-girl',type:'VOICE_IDENTITY',authority:'L',assetFamilyIds:['VOICE-A'],requirementIds:['VOICE-REQ']});model.assetFamilies=[{id:'VOICE-A',kind:'AUDIO'}];
 for(const shot of settings.shots)shot.inputs.push({requirementId:'VOICE-REQ',familyId:'VOICE-A',versionId:'VOICE-A@V1',sha256:productionHash('voice-a'),purpose:'VOICE_MASTER'});
 return {model,scope,content:validateShotProductionPlan(settings,scope)};
}
function readyFixture(){
 const f=fixture(),{model,scope,content}=f,compiled=compileShotProductionPlan(scope,content,{id:'PRODUCTION-1',revisionId:'SOURCE-1',sourceRef:'story/production-1.json'});
 const baseFamilies=model.assetFamilies;Object.assign(model,compiled);model.assetFamilies=[...baseFamilies,...compiled.assetFamilies];model.shotProductionPlans=[{id:'PRODUCTION-1',sceneId,scopeRole:'CURRENT',sourceRevisionId:'SOURCE-1',content,contentHash:productionHash(content),workItemIds:compiled.workItems.map(w=>w.id)}];
 const state={assetFamiliesById:{},assetVersionsById:{},executionGatesByWorkItem:{},episodeNarrativeReleasesByUid:{[episodeUid]:{id:'RELEASE-r1',canFlowDownstream:true}},scopeLocksById:{'LOCK-design':model.scopeLocks[0]}};
 const register=(family,versionId,sha256)=>{state.assetFamiliesById[family.id]={...family,currentVersionId:versionId,canFlowDownstream:true};state.assetVersionsById[versionId]={id:versionId,familyId:family.id,path:`media/${versionId}`,sha256,canFlowDownstream:true};};
 for(const s of content.shots)for(const b of s.inputs)register({id:b.familyId},b.versionId,b.sha256);
 for(const w of compiled.workItems){register(compiled.assetFamilies.find(f=>f.id===w.outputAssetRef),`${w.outputAssetRef}@V1`,productionHash(w.id));if(w.deliverableKey==='SHOT_VIDEO'){w.executionDefinitionRef='CALL-'+w.id;state.executionGatesByWorkItem[w.id]=[];}}
 const shotSlices=content.shots.map(s=>({shotId:s.shotId,...Object.fromEntries(['timingHash','visualHash','overlayHash','boundaryHash'].map(key=>[key,productionHash(key+s.shotId)]))}));
 model.animaticLocks=[{sceneId,scopeRole:'CURRENT',shotPlanRevisionId:scope.plan.id,shotSlices}];
 model.shotInputLocks=[{sceneId,scopeRole:'CURRENT',productionPlanId:'PRODUCTION-1',perShotHashes:content.shots.map(s=>({shotId:s.shotId,inputHash:productionHash({shotId:s.shotId,inputs:s.inputs,space:s.space})}))}];
 model.shotKeyframeSets=content.shots.map(s=>({id:'FRAMES-'+s.shotId,productionPlanId:'PRODUCTION-1',scopeRole:'CURRENT',...shotSlices.find(row=>row.shotId===s.shotId),strategyHash:productionHash(s.keyframeStrategy),members:compiled.workItems.filter(w=>w.shotId===s.shotId&&w.gateId==='KEYFRAMES').map(w=>({workItemId:w.id,slot:w.outputSlot,familyId:w.outputAssetRef,versionId:state.assetFamiliesById[w.outputAssetRef].currentVersionId,sha256:state.assetVersionsById[state.assetFamiliesById[w.outputAssetRef].currentVersionId].sha256}))}));
 return {...f,compiled,state,read:()=>shotProductionReadiness(model,state,sceneId)};
}

test('scope is derived solely from exact current permanent release, plan and denominator',()=>{
 const {model,scope}=fixture();assert.equal(scope.shots.length,2);assert.equal(scope.episodeUid,episodeUid);
 for(const mutate of [m=>m.shotPlanSetRevisions.push(copy(m.shotPlanSetRevisions[0])),m=>m.episodeNarrativeReleases[0].sourceSyncState='STALE',m=>m.sceneScriptRevisions[0].contentHash=productionHash('changed'),m=>m.scopeLocks[0].shotIds.reverse(),m=>m.scopeLocks[0].shotPlanSetRevisionHash=productionHash('other'),m=>m.shots[0].shotPlanSetRevisionId='DESIGN-other',m=>m.shots.push(copy(m.shots[0]))]){const next=copy(model);mutate(next);assert.throws(()=>resolveShotProductionScope(next,sceneId));}
 const historical=copy(model);historical.shots.push({id:'OLD-SH231',sceneId,scopeRole:'EVIDENCE_ONLY'});assert.equal(resolveShotProductionScope(historical,sceneId).shots.length,2);
});
test('production default keeps design estimates separate and does not claim locks or actual input versions',()=>{
 const {scope}=fixture();scope.shots[0].design={estimatedDurationSeconds:5.2,keyframeStrategy:{mode:'START_ONLY',reason:'固定机位',intermediateFrameCount:0}};
 const result=defaultShotProductionPlan(scope);assert.deepEqual(result.shots[0].inputs,[]);assert.equal(result.shots[0].keyframeStrategy.mode,'START_ONLY');assert.equal(result.shots[0].videoBranch,'UNKNOWN');assert.equal(result.shots[0].durationSeconds,undefined);assert.equal(result.shots[0].locked,undefined);
});
test('strict production contract checks every strategy, line, input and owned shot in order',()=>{
 const {scope,content}=fixture();assert.deepEqual(validateShotProductionPlan(content,scope),content);
 const invalid=[c=>c.shotPlanHash=productionHash('other'),c=>c.shots.reverse(),c=>c.shots.pop(),c=>c.shots[0].inputs={},c=>c.shots[0].dialogueLines=null,c=>c.shots[0].keyframeStrategy.intermediateFrameCount=1,c=>c.shots[1].keyframeStrategy.intermediateFrameCount=0,c=>c.shots[0].keyframeStrategy.reason=' ',c=>c.shots[0].keyframeStrategy.locked=true,c=>c.shots[1].dialogueLines[0].id=c.shots[0].dialogueLines[0].id,c=>c.shots[0].dialogueLines[0].text='',c=>c.shots[0].dialogueLines[0].speakerEntityId='',c=>c.shots[0].dialogueLines[0].id='line with spaces',c=>c.shots[0].dialogueLines[0].observed=true,c=>c.shots[0].inputs[0].requirementId='OTHER',c=>c.shots[0].inputs[0].sha256='fake',c=>c.shots[0].inputs.push(copy(c.shots[0].inputs[0])),c=>c.shots[0].space.authorized=true,c=>c.shots[0].handles.headFrames=1.5,c=>c.shots[0].videoBranch='SILENT'];
 for(const mutate of invalid){const next=copy(content);mutate(next);assert.throws(()=>validateShotProductionPlan(next,scope),{code:'DOMAIN_INVALID'});}
});
test('compile gives every producer exactly one package, context, family and planned output without fake versions',()=>{
 const {scope,content}=fixture(),c=compileShotProductionPlan(scope,content,{id:'PLAN-1',revisionId:'REV-1',sourceRef:'story/plan.json'});
 assert.equal(c.workItems.length,c.workPackages.length);assert.equal(c.workItems.length,c.reviewContexts.length);assert.equal(c.assetVersions,undefined);
 for(const w of c.workItems){const owners=c.workPackages.filter(p=>p.workItemRefs.includes(w.id));assert.equal(owners.length,1);assert.deepEqual(owners[0].workItemRefs,[w.id]);assert.match(w.outputBasisHash,/^[a-f0-9]{64}$/);const f=c.assetFamilies.find(f=>f.id===w.outputAssetRef);assert.equal(f.ownerRef,w.id);assert.equal(f.currentVersionId,null);assert.deepEqual(f.versionRefs,[]);assert.equal(c.expectedOutputs.find(o=>o.familyId===f.id).realizedVersionId,null);assert.equal(w.canFlowDownstream,false);}
 for(const key of ['workItems','workPackages','assetFamilies','expectedOutputs','reviewContexts'])for(const row of c[key])assert.equal(row.shotProductionPlanId,'PLAN-1');
 assert.equal(c.workItems.filter(w=>w.deliverableKey==='START_FRAME').length,2);assert.equal(c.workItems.filter(w=>w.deliverableKey==='END_FRAME').length,1);assert.equal(c.workItems.filter(w=>w.deliverableKey==='INTERMEDIATE_FRAME').length,1);
 const lock=c.workItems.find(w=>w.deliverableKey==='LOCKED_SHOT'),family=c.assetFamilies.find(f=>f.id===lock.outputAssetRef);assert.equal(family.kind,'TEXT');assert.equal(family.subtype,'LOCKED_SHOT');
});
test('output basis hashes preserve unaffected shots and storyboard/keyframes when only dialogue changes',()=>{
 const {scope,content}=fixture(),run=(id,c)=>compileShotProductionPlan(scope,c,{id,revisionId:id,sourceRef:'preview'}),a=run('P1',content),b=run('P2',content),key=w=>[w.scopeId,w.deliverableKey,w.outputSlot].join('|');
 const before=new Map(a.workItems.map(w=>[key(w),w.outputBasisHash]));for(const w of b.workItems)assert.equal(w.outputBasisHash,before.get(key(w)));
 const next=copy(content);next.shots[0].dialogueLines[0].text='你早就知道了，对吗？';const changed=run('P3',next).workItems.filter(w=>w.outputBasisHash!==before.get(key(w)));
 assert.deepEqual(changed.map(w=>w.deliverableKey).sort(),['ANIMATIC','DIALOGUE_DRY','LOCKED_SHOT','SHOT_VIDEO']);assert.ok(changed.every(w=>w.shotId===scope.shots[0].id||w.scopeType==='SCENE'));
});
test('binding readiness rejects mismatched family/version/SHA and superseded registered assets',()=>{
 const f=readyFixture(),binding=f.content.shots[0].inputs[0];assert.deepEqual(productionBindingReasons(f.model,f.state,binding),[]);
 const v=f.state.assetVersionsById[binding.versionId];v.familyId='OTHER';assert.deepEqual(productionBindingReasons(f.model,f.state,binding),['INPUT_FILE_OR_SHA_MISSING']);v.familyId=binding.familyId;f.state.assetFamiliesById[binding.familyId].currentVersionId='OLD';assert.ok(productionBindingReasons(f.model,f.state,binding).includes('INPUT_VERSION_NOT_CURRENT_RELEASED'));
});
test('pre-video readiness includes complete exact reviewed frame set and does not itself lock the shot',()=>{
 const f=readyFixture(),result=f.read();assert.equal(result.ready,true);assert.equal(result.readyCount,2);assert.equal(result.shots[0].locked,undefined);assert.equal(f.model.shotLocks,undefined);
 delete f.model.shotProductionPlans[0].workItemIds;assert.equal(f.read().ready,true,'legacy plan-id ownership remains readable');
});
test('readiness fails closed on malformed/ambiguous plans, missing work, empty frame members and incomplete dialogue',()=>{
 const mutations=[f=>f.model.shotProductionPlans[0].content.shots.pop(),f=>f.model.shotProductionPlans.push(copy(f.model.shotProductionPlans[0])),f=>f.model.shotProductionPlans[0].workItemIds.push('WORK-missing'),f=>f.model.shotKeyframeSets[0].members=[],f=>f.model.shotKeyframeSets[0].members[0].workItemId='WRONG',f=>f.model.shotKeyframeSets[0].strategyHash=productionHash('other'),f=>{const line=f.model.workItems.find(w=>w.shotId===f.scope.shots[0].id&&w.deliverableKey==='DIALOGUE_DRY');f.model.workItems=f.model.workItems.filter(w=>w!==line);f.model.shotProductionPlans[0].workItemIds=f.model.shotProductionPlans[0].workItemIds.filter(id=>id!==line.id);},f=>f.state.episodeNarrativeReleasesByUid[episodeUid].canFlowDownstream=false,f=>f.state.scopeLocksById['LOCK-design'].lockState='REOPENED'];
 for(const change of mutations){const f=readyFixture();change(f);assert.doesNotThrow(f.read);assert.equal(f.read().ready,false);}
 const f=readyFixture();f.model.scopeLocks=[];assert.equal(f.read().denominatorState,'UNKNOWN');assert.equal(f.read().shotCount,null);
});
for(const key of ['timingHash','visualHash','overlayHash','boundaryHash'])test(`${key} changes invalidate only the affected shot's keyframe closure`,()=>{
 const f=readyFixture();f.model.animaticLocks[0].shotSlices[0][key]=productionHash('edited');const result=f.read();assert.equal(result.shots[0].ready,false);assert.ok(result.shots[0].blockers.includes('KEYFRAME_SET_REVIEW_REQUIRED'));assert.equal(result.shots[1].ready,true);
});
test('current explicit work closure can reuse prior-plan outputs and exact local locks',()=>{
 const f=readyFixture();f.model.shotProductionPlans[0].id='PRODUCTION-2';f.model.shotProductionPlans[0].sourceRevisionId='SOURCE-2';assert.equal(f.read().ready,true);
 const content=f.model.shotProductionPlans[0].content;content.shots[0].space.camera='CAMERA-B';f.model.shotProductionPlans[0].contentHash=productionHash(content);const result=f.read();assert.equal(result.shots[0].ready,false);assert.ok(result.shots[0].blockers.includes('INPUT_LOCK_REQUIRED'));assert.ok(result.shots[0].blockers.includes('PRODUCTION_WORK_INPUTS_CHANGED'));assert.equal(result.shots[1].ready,true);
});
