import test from 'node:test';
import assert from 'node:assert/strict';
import {shotProductionPolicyMarkers,shotProductionInputConsumptionReasons,shotProductionProjectedConsumptionReasons} from '../host/instance-runtime/shot-production-stage-policy.mjs';
import {executionEligibilityReasons} from '../app/gate-evaluation.ts';
import {selectShotRecipeInputFamilies,compileShotRecipePreview} from '../host/instance-runtime/shot-production-recipes.mjs';
import {defaultConfiguration,validateConfiguration,reviewSpec} from '../host/instance-runtime/configuration-model.mjs';
import {productionHash} from '../host/instance-runtime/shot-production-model.mjs';

function fixture(){
 const work=(id,deliverableKey)=>({id,shotProductionPlanId:'PLAN',outputAssetRef:'F-'+id,deliverableKey,...shotProductionPolicyMarkers(deliverableKey),lifecycleState:'READY_TO_START'});
 const works=[work('TEMP','DIALOGUE_TEMP'),work('BOARD','STORYBOARD'),work('ANIMATIC','ANIMATIC'),work('FRAME','START_FRAME'),work('FINAL','DIALOGUE_DRY'),work('VIDEO','SHOT_VIDEO')];
 const families=works.map(w=>({id:w.outputAssetRef,ownerRef:w.id,...shotProductionPolicyMarkers(w.deliverableKey),currentVersionId:w.outputAssetRef+'@V001',canFlowDownstream:true}));
 const model={workItems:works,assetFamilies:families,expectedOutputs:families.map(f=>({id:'EO-'+f.id,familyId:f.id,...shotProductionPolicyMarkers(works.find(w=>w.id===f.ownerRef).deliverableKey)})),shotProductionPlans:[{id:'PLAN',content:{schemaVersion:'2.0',stagePolicy:'PREVIS_FIRST_V1'},workItemIds:works.map(w=>w.id)}]};
 const state={workItemsById:Object.fromEntries(works.map(w=>[w.id,w])),assetFamiliesById:Object.fromEntries(families.map(f=>[f.id,f])),assetVersionsById:Object.fromEntries(families.map(f=>[f.currentVersionId,{id:f.currentVersionId,familyId:f.id,sha256:'a'.repeat(64),canFlowDownstream:true}]))};
 const binding={order:1,path:'media/temp.wav',assetFamilyRef:'F-TEMP',assetVersionRef:'F-TEMP@V001',sha256:'a'.repeat(64)};
 return{model,state,binding,work:id=>works.find(w=>w.id===id)};
}
test('approved temporary audio is usable only by explicit previs consumers, including authorization/claim eligibility',()=>{
 const f=fixture();
 for(const consumer of ['BOARD','ANIMATIC'])assert.deepEqual(shotProductionInputConsumptionReasons(f.model,f.work(consumer),f.binding),[]);
 for(const consumer of ['FRAME','FINAL','VIDEO']){
  assert(shotProductionInputConsumptionReasons(f.model,f.work(consumer),f.binding).includes('PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION'));
  const definition={definitionStatus:'DEFINED',definitionHash:'b'.repeat(64),declaredGate:'READY_TO_START',output:{assetFamilyRef:f.work(consumer).outputAssetRef}};
  assert(executionEligibilityReasons({stateProjection:f.state},definition,{workItemId:consumer,familyId:f.work(consumer).outputAssetRef,inputBindings:[f.binding]}).includes('PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION'));
 }
 for(const consumer of [undefined,{id:'BASE-VOICE'},{id:'OLD-VIDEO',deliverableKey:'SHOT_VIDEO'}])assert(shotProductionInputConsumptionReasons(f.model,consumer,f.binding).includes('PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION'));
});
test('client purpose flags cannot promote a temporary output; broken source or projected owner closure rejects',()=>{
 for(const mutate of [m=>m.expectedOutputs[0].allowedUse='PRODUCTION',m=>m.assetFamilies[0].productionPurpose='FINAL',m=>m.workItems[0].allowedUse='PRODUCTION',m=>m.shotProductionPlans[0].workItemIds.shift(),m=>m.shotProductionPlans=[]]){
  const f=fixture();mutate(f.model);assert(shotProductionInputConsumptionReasons(f.model,f.work('ANIMATIC'),{...f.binding,temporary:false,productionPurpose:'FINAL'}).includes('SHOT_PRODUCTION_USAGE_BINDING_CHANGED'));
 }
 const f=fixture();f.state.assetFamiliesById['F-TEMP'].ownerRef='FINAL';assert(shotProductionProjectedConsumptionReasons(f.state,f.work('ANIMATIC'),f.binding).includes('SHOT_PRODUCTION_USAGE_BINDING_CHANGED'));
});
test('versioned temporary zero-reference recipe freezes independent purpose and exact output without voice master',()=>{
 const f=fixture(),work=f.work('TEMP');assert.deepEqual(selectShotRecipeInputFamilies(f.model,work,{inputs:[]}),{familyIds:[],blockers:[]});
 const output={id:'EO-TEMP',familyId:work.outputAssetRef,targetPath:'media/_review_pending/shot-production/F-TEMP/V001.wav',plannedVersionLabel:'V001',expectationState:'PLANNED',...shotProductionPolicyMarkers('DIALOGUE_TEMP')};
 const c={work,view:{releaseId:'r1'},model:{expectedOutputs:[output],assetVersions:[]},state:{assetFamiliesById:{},assetVersionsById:{}},family:{id:work.outputAssetRef,kind:'AUDIO'},output,inputs:[],basis:{lineId:'LINE-1',text:'给我的？'},basisHash:productionHash('exact-line')};
 const preview=compileShotRecipePreview(c,{model:'seed-audio-1.0',prompt:'给我的？低声迟疑。',negativePrompt:'',parameters:{}},{draftRevisionId:'DRAFT-TEMP'});
 assert.deepEqual(preview.definition.upload.items,[]);assert.equal(preview.definition.allowedUse,'PREVIS_TIMING');assert.equal(preview.expectedOutput.id,output.id);assert.equal(preview.modelCalls,0);
 assert(selectShotRecipeInputFamilies(f.model,{...work,productionSchemaVersion:undefined},{inputs:[]}).blockers.length);
});
test('new previs review standards are explicit and old published configuration remains valid unchanged',()=>{
 const config=defaultConfiguration(),before=JSON.stringify(config);assert.doesNotThrow(()=>validateConfiguration(config));
 for(const key of ['STORYBOARD','DIALOGUE_TEMP','SHOT_INPUT_LOCK']){
  const spec=reviewSpec(config,'WORK_PRODUCT',{deliverableKey:key,...shotProductionPolicyMarkers(key)});
  assert(spec.criteria.length>=3);assert.match(spec.profileId,/-previs-v1$/);assert.equal(spec.hash,productionHash(Object.fromEntries(Object.entries(spec).filter(([k])=>k!=='hash'))));
 }
 assert.equal(JSON.stringify(config),before);
 assert.equal(reviewSpec(config,'WORK_PRODUCT',{deliverableKey:'STORYBOARD'}).profileId,'production-storyboard');
});
