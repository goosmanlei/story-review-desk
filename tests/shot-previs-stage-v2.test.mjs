import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sceneId,episodeUid} from './shot-previs-stage-v2.fixture.mjs';
import {productionHash,defaultShotProductionPlan,validateShotProductionPlan,compileShotProductionPlan,shotProductionEntryGates,shotProductionVisualInputHash,productionBindingReasons} from '../host/instance-runtime/shot-production-model.mjs';
import {resolveShotProductionProducer,shotProductionInputConsumptionReasons,shotProductionProjectedConsumptionReasons,shotProductionPolicy} from '../host/instance-runtime/shot-production-stage-policy.mjs';
import {reuseShotProductionObjects} from '../host/instance-runtime/shot-production-reuse.mjs';

function setup({formalInputs=false,final=false}={}){
 const f=fixture(),content=defaultShotProductionPlan(f.scope);
 for(const [i,s] of content.shots.entries()){
  s.keyframeStrategy={mode:'START_ONLY',reason:'静止构图预演',intermediateFrameCount:0};
  s.dialogueLines=[{id:'LINE-'+(i+1),text:'这是给我的？',speakerEntityId:'ENTITY-girl',purpose:final?'FINAL':'TEMPORARY',performance:'迟疑后低声问'}];
  if(formalInputs){s.inputs=f.content.shots[i].inputs.filter(b=>b.requirementId!=='VOICE-REQ');s.space=f.content.shots[i].space;}
  s.videoBranch='POST_LIP';
 }
 const checked=validateShotProductionPlan(content,f.scope),compiled=compileShotProductionPlan(f.scope,checked,{id:'V2-PLAN',revisionId:'V2-SOURCE',sourceRef:'story/v2-plan.json'}),originalFamilies=f.model.assetFamilies;
 Object.assign(f.model,compiled);f.model.assetFamilies=[...originalFamilies,...compiled.assetFamilies];f.model.shotProductionPlans=[{id:'V2-PLAN',sceneId,episodeUid,scopeRole:'CURRENT',sourceRevisionId:'V2-SOURCE',content:checked,contentHash:productionHash(checked),workItemIds:compiled.workItems.map(w=>w.id)}];
 const state={assetFamiliesById:{},assetVersionsById:{},workItemsById:Object.fromEntries(compiled.workItems.map(w=>[w.id,w])),executionGatesByWorkItem:{},episodeNarrativeReleasesByUid:{[episodeUid]:{id:'RELEASE-r1',canFlowDownstream:true}},scopeLocksById:{'LOCK-design':f.model.scopeLocks[0]}};
 function register(family,versionId=family.id+'@V001',sha256=productionHash(family.id)){
  const v={id:versionId,familyId:family.id,path:'media/'+versionId,sha256,canFlowDownstream:true};state.assetFamiliesById[family.id]={...family,currentVersionId:versionId,canFlowDownstream:true};state.assetVersionsById[v.id]=v;return{familyId:family.id,versionId:v.id,sha256};
 }
 if(formalInputs)for(const s of checked.shots)for(const b of s.inputs)register({id:b.familyId,kind:'IMAGE'},b.versionId,b.sha256);
 const work=(kind,shot=0,lineId)=>compiled.workItems.find(w=>w.deliverableKey===kind&&(kind==='ANIMATIC'||w.shotId===checked.shots[shot].shotId)&&(!lineId||w.lineId===lineId));
 const release=w=>register(compiled.assetFamilies.find(f=>f.id===w.outputAssetRef));
 return {...f,content:checked,compiled,state,work,register,release,gates:()=>shotProductionEntryGates(f.model,state)};
}

test('new V2 declares independent purposes, per-shot input locks and exact work/family/EO usage',()=>{
 const f=setup({final:true});assert.equal(f.content.schemaVersion,'2.0');assert.equal(f.content.stagePolicy,'PREVIS_FIRST_V1');
 assert.deepEqual(f.content.shots.map(s=>s.visualRequirementIds),[['MATREQ-1'],['MATREQ-2']]);
 assert.equal(f.compiled.inputLockWorkItemIds.length,2);assert(f.compiled.workItems.filter(w=>w.deliverableKey==='SHOT_INPUT_LOCK').every(w=>w.scopeType==='SHOT'));
 assert.equal(f.compiled.workItems.filter(w=>w.deliverableKey==='DIALOGUE_TEMP').length,2);assert.equal(f.compiled.workItems.filter(w=>w.deliverableKey==='DIALOGUE_DRY').length,2);
 for(const w of f.compiled.workItems){const family=f.compiled.assetFamilies.find(a=>a.id===w.outputAssetRef),eo=f.compiled.expectedOutputs.find(a=>a.familyId===family.id);for(const key of ['productionSchemaVersion','stagePolicy','productionPurpose','allowedUse']){assert.equal(family[key],w[key]);assert.equal(eo[key],w[key]);}}
 assert(f.work('ANIMATIC').inputAssetRefs.every(id=>f.compiled.assetFamilies.find(a=>a.id===id).subtype==='STORYBOARD'));
 assert.equal(f.work('DIALOGUE_TEMP').dialogue.voiceBinding,undefined);assert.equal(f.work('DIALOGUE_TEMP').dialogue.purpose,'TEMPORARY');
});

test('previs opens per shot and per line without high-quality assets, production space or final voice',()=>{
 const f=setup({final:true}),g=f.gates();for(const w of f.compiled.workItems.filter(w=>['STORYBOARD','DIALOGUE_TEMP'].includes(w.deliverableKey)))assert.deepEqual(g[w.id],[]);
 assert(g[f.work('DIALOGUE_DRY').id].some(r=>r.includes('VOICE')));assert(g[f.work('SHOT_INPUT_LOCK').id].some(r=>r.startsWith('MATERIAL_INPUT_MISSING')));assert(g[f.work('START_FRAME').id].includes('INPUT_LOCK_REQUIRED'));
 const line=f.work('DIALOGUE_TEMP');line.dialogue.text='篡改的工作项';assert(f.gates()[line.id].includes('PRODUCTION_WORK_INPUTS_CHANGED'));line.outputBasisHash='0'.repeat(64);assert(f.gates()[line.id].includes('PRODUCTION_WORK_INPUTS_CHANGED'));
});

test('unknown stage versions, forged visual classification and unresolved temporary speakers stay blocked',()=>{
 const f=setup();assert.throws(()=>validateShotProductionPlan({...f.content,schemaVersion:'3.0'},f.scope));assert.throws(()=>shotProductionPolicy({schemaVersion:'1.0',stagePolicy:'PREVIS_FIRST_V1'}));
 const changed=structuredClone(f.content);changed.shots[0].visualRequirementIds=[];assert.throws(()=>validateShotProductionPlan(changed,f.scope),/视觉需求分类/);
 f.model.domainGraph.entities=f.model.domainGraph.entities.filter(e=>e.id!=='ENTITY-girl');assert(f.gates()[f.work('DIALOGUE_TEMP').id].includes('INPUT_SPEAKER_IDENTITY_REQUIRED'));assert.deepEqual(f.gates()[f.work('STORYBOARD').id],[]);
});

test('adding final voice or unused production images/space preserves temporary, storyboard and timing bases',()=>{
 const f=setup(),run=c=>compileShotProductionPlan(f.scope,c,{id:'OTHER-PLAN',revisionId:'R2',sourceRef:'story/r2.json'}),key=w=>[w.shotId,w.deliverableKey,w.outputSlot].join('|'),original=new Map(f.compiled.workItems.map(w=>[key(w),w]));
 const next=structuredClone(f.content);next.shots[0].dialogueLines[0].purpose='FINAL';next.shots[0].inputs=f.scope.materialModel?fixture().content.shots[0].inputs:[];next.shots[0].space=fixture().content.shots[0].space;
 const changed=run(next);for(const w of changed.workItems.filter(w=>['STORYBOARD','DIALOGUE_TEMP','ANIMATIC'].includes(w.deliverableKey)))assert.equal(w.outputBasisHash,original.get(key(w)).outputBasisHash,w.deliverableKey);
 assert(changed.workItems.some(w=>w.deliverableKey==='DIALOGUE_DRY'));
 const reuse=reuseShotProductionObjects(f.model,f.model.shotProductionPlans[0],changed);assert(reuse.reusedWorkItemIds.includes(f.work('DIALOGUE_TEMP').id));assert(reuse.reusedWorkItemIds.includes(f.work('ANIMATIC').id));
 const changedText=structuredClone(next);changedText.shots[0].dialogueLines[0].text='你早就知道了，对吗？';const textWorks=run(changedText).workItems;assert.notEqual(textWorks.find(w=>w.deliverableKey==='DIALOGUE_TEMP'&&w.shotId===next.shots[0].shotId).outputBasisHash,f.work('DIALOGUE_TEMP').outputBasisHash);assert.equal(textWorks.find(w=>w.deliverableKey==='DIALOGUE_TEMP'&&w.shotId===next.shots[1].shotId).outputBasisHash,f.work('DIALOGUE_TEMP',1).outputBasisHash);
});

test('temporary media is timing-only through original source proof and projected producer bindings',()=>{
 const f=setup(),producer=f.work('DIALOGUE_TEMP'),binding=f.release(producer),consumer=f.work('ANIMATIC');
 assert.deepEqual(shotProductionInputConsumptionReasons(f.model,consumer,binding),[]);assert.deepEqual(productionBindingReasons(f.model,f.state,binding,{consumerRole:'PREVIS_TIMING'}),[]);
 for(const target of [null,{id:'BASIC-IDENTITY'},f.work('START_FRAME'),f.work('SHOT_VIDEO')])assert(shotProductionInputConsumptionReasons(f.model,target,{...binding,purpose:'FINAL'}).includes('PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION'));
 assert(productionBindingReasons(f.model,f.state,binding).includes('PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION'));
 assert.deepEqual(shotProductionProjectedConsumptionReasons(f.state,consumer,binding),[]);assert(shotProductionProjectedConsumptionReasons(f.state,f.work('SHOT_VIDEO'),binding).includes('PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION'));
 f.model.shotProductionPlans[0].scopeRole='EVIDENCE_ONLY';assert.deepEqual(resolveShotProductionProducer(f.model,binding).blockers,[]);
 const family=f.model.assetFamilies.find(a=>a.id===binding.familyId);family.allowedUse='PRODUCTION';assert(resolveShotProductionProducer(f.model,binding).blockers.length);stateStrip();function stateStrip(){delete f.state.assetFamiliesById[binding.familyId].allowedUse;assert(shotProductionProjectedConsumptionReasons(f.state,consumer,binding).includes('SHOT_PRODUCTION_USAGE_BINDING_CHANGED'));}
});

test('approved low-cost alternatives suffice for timing while final dialogue and visual masters remain unavailable',()=>{
 const f=setup({final:true});for(const w of f.compiled.workItems.filter(w=>['STORYBOARD','DIALOGUE_TEMP'].includes(w.deliverableKey)))f.release(w);
 assert.deepEqual(f.gates()[f.work('ANIMATIC').id],[]);assert(f.gates()[f.work('DIALOGUE_DRY').id].length);assert(f.gates()[f.work('START_FRAME').id].length);
 const first=f.work('DIALOGUE_TEMP');f.state.assetFamiliesById[first.outputAssetRef].canFlowDownstream=false;assert(f.gates()[f.work('ANIMATIC').id].includes('DIALOGUE_TIMING_NOT_RELEASED:LINE-1'));
});

test('own visual input lock and timing allow keyframes without final voice or another shot completeness',()=>{
 const f=setup({formalInputs:true,final:true}),first=f.content.shots[0];
 const shotSlices=[{shotId:first.shotId,...Object.fromEntries(['timingHash','visualHash','overlayHash','boundaryHash'].map(k=>[k,productionHash(k)]))}];f.model.animaticLocks=[{sceneId,scopeRole:'CURRENT',shotPlanRevisionId:f.scope.plan.id,shotSlices}];
 f.model.shotInputLocks=[{sceneId,shotId:first.shotId,scopeRole:'CURRENT',inputHash:shotProductionVisualInputHash(f.model,first)}];
 assert.deepEqual(f.gates()[f.work('START_FRAME').id],[]);assert(f.gates()[f.work('START_FRAME',1).id].includes('INPUT_LOCK_REQUIRED'));assert(f.gates()[f.work('DIALOGUE_DRY').id].length);assert(f.gates()[f.work('SHOT_VIDEO').id].includes('FINAL_DIALOGUE_NOT_RELEASED:LINE-1'));
 const input=first.inputs[0];f.state.assetFamiliesById[input.familyId].canFlowDownstream=false;assert(f.gates()[f.work('START_FRAME').id].some(r=>r.startsWith('INPUT_VERSION_NOT_CURRENT_RELEASED')));assert.deepEqual(f.gates()[f.work('STORYBOARD').id],[]);
});

test('V1 defaults and entire compiled output retain the pre-V2 source golden hashes',async()=>{
 const {readFile}=await import('node:fs/promises'),golden=JSON.parse(await readFile(new URL('./shot-production-v1-golden.json',import.meta.url),'utf8')),f=fixture();
 assert.equal(productionHash(f.content),golden.contentHash);assert.equal(productionHash(defaultShotProductionPlan(f.scope,{schemaVersion:'1.0'})),golden.defaultHash);assert.equal(productionHash(compileShotProductionPlan(f.scope,f.content,golden.identity)),golden.compiledHash);
});
