import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredGates,executionEligibilityReasons} from '../app/gate-evaluation.ts';
import {shotProductionExecutionEntries} from '../host/instance-runtime/shot-production-gates.mjs';
import {productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {shotRecipeProductionBasis} from '../host/instance-runtime/shot-production-recipe-basis.mjs';

test('execution authorization consumes server basis gates; missing server evaluation fails closed',()=>{
 const work={id:'WORK',deliverableKey:'SHOT_VIDEO',shotId:'SHOT',sceneId:'SCENE',scopeRole:'CURRENT',activeInCurrentProduction:true,shotProductionPlanId:'PLAN',executionDefinitionRef:'CALL',outputAssetRef:'OUTPUT',outputBasisHash:productionHash('work'),inputAssetRefs:[]};
 const plan={id:'PLAN',sceneId:'SCENE',scopeRole:'CURRENT',workItemIds:[work.id],content:{shotPlanRevisionId:'DESIGN',shots:[{shotId:'SHOT',handles:{headFrames:6,tailFrames:6},videoBranch:'SILENT'}]}};
 const model={workItems:[work],assetFamilies:[{id:'OUTPUT',kind:'VIDEO'}],shotProductionPlans:[plan],animaticLocks:[{scopeRole:'CURRENT',sceneId:'SCENE',shotPlanRevisionId:'DESIGN',shotSlices:[{shotId:'SHOT',durationFrames:48,timingHash:productionHash('old')}]}],shotKeyframeSets:[]};
 const state={workItemsById:{WORK:{lifecycleState:'READY_TO_START'}},assetFamiliesById:{OUTPUT:{id:'OUTPUT',currentExpectedOutputId:'EO'}},assetVersionsById:{}};
 const productionBasis=shotRecipeProductionBasis(model,work,plan,[]),definition={id:'CALL',workItemRef:work.id,definitionStatus:'DEFINED',definitionHash:productionHash('call'),output:{assetFamilyRef:'OUTPUT',expectedOutputRef:'EO'},upload:{items:[]},productionBasis,productionBasisHash:productionHash(productionBasis)};
 assert.ok(configuredGates(model,state).WORK.entryReasons.includes('SHOT_PRODUCTION_GATE_PROJECTION_REQUIRED'));
 let entries=shotProductionExecutionEntries(model,state,{executionDefinitions:[definition]});
 assert.equal(entries.WORK.includes('SHOT_RECIPE_INPUT_BASIS_CHANGED'),false);
 model.animaticLocks[0].shotSlices[0].durationFrames=96;
 entries=shotProductionExecutionEntries(model,state,{executionDefinitions:[definition]});
 assert.ok(entries.WORK.includes('SHOT_RECIPE_INPUT_BASIS_CHANGED'));
 state.configuredGatesByWorkItem=configuredGates(model,state,entries);
 assert.ok(executionEligibilityReasons({stateProjection:state},definition,{workItemId:work.id,familyId:'OUTPUT',inputBindings:[]}).includes('SHOT_RECIPE_INPUT_BASIS_CHANGED'));
});
