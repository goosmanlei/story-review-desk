import test from 'node:test';
import assert from 'node:assert/strict';
import {validateShotRecipeContent,selectShotRecipeInputFamilies,shotRecipeExpectedOutput,compileShotRecipePreview,shotRecipeProductionBasis,shotRecipeDefinitionBindingReasons} from '../host/instance-runtime/shot-production-recipes.mjs';
import {productionHash} from '../host/instance-runtime/shot-production-model.mjs';
import {inspectExecutionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from '../host/instance-runtime/execution-definition-hash.mjs';

const author=()=>({model:'configured-model',prompt:'人物从门口停步，看到桌面的信封后迟疑。',negativePrompt:'手部不变形',parameters:{fps:24,durationSeconds:5}});
function context(kind='VIDEO'){
 const family={id:'OUTPUT',kind,expectedOutputRefs:['EXPECTED-1'],currentExpectedOutputId:'EXPECTED-1'},output={id:'EXPECTED-1',familyId:family.id,targetPath:'media/_review_pending/OUTPUT/V001.mp4',plannedVersionLabel:'V001',expectationState:'PLANNED',realizedVersionId:null};
 return{view:{releaseId:'release:1'},work:{id:'WORK',label:'本镜视频',pipelineStageCode:'P11',executionDefinitionRef:null},family,output,model:{expectedOutputs:[output],assetVersions:[]},state:{assetVersionsById:{},assetFamiliesById:{OUTPUT:{id:'OUTPUT',currentVersionId:null}}},settings:{handles:{headFrames:6,tailFrames:6}},timing:{durationFrames:108},inputs:[{order:1,path:'media/base.png',assetFamilyRef:'BASE',assetVersionRef:'BASE@V1',sha256:productionHash('base'),label:'干净母版'}],basis:{timingHash:productionHash('timing'),frameSetId:'FRAMES-1'},basisHash:productionHash('basis')};
}
test('recipe author content rejects unknown fields, credentials, execution paths and nonfinite parameters',()=>{
 const value=author();assert.deepEqual(validateShotRecipeContent(value),value);
 for(const mutate of [v=>v.extra=true,v=>v.model='UNKNOWN',v=>v.prompt='',v=>v.parameters.api_key='secret',v=>v.parameters.nested={Authorization:'secret'},v=>v.parameters.output='/tmp/out',v=>v.parameters.temperature=Infinity]){const invalid=author();mutate(invalid);assert.throws(()=>validateShotRecipeContent(invalid),{code:'DOMAIN_INVALID'});}
});
test('dialogue uses only the exact speaker voice master and blocks ambiguous or unrelated audio',()=>{
 const model={assetFamilies:[{id:'VOICE-A',kind:'AUDIO'},{id:'VOICE-B',kind:'AUDIO'},{id:'RAIN',kind:'AUDIO'}],domainGraph:{representations:[{id:'REP-A',entityId:'PERSON-A',type:'VOICE_IDENTITY',assetFamilyIds:['VOICE-A'],authority:'L'},{id:'REP-B',entityId:'PERSON-B',type:'VOICE_IDENTITY',assetFamilyIds:['VOICE-B'],authority:'L'}]}},work={deliverableKey:'DIALOGUE_DRY',dialogue:{speakerEntityId:'PERSON-A'},inputAssetRefs:['RAIN']},settings={inputs:[{familyId:'VOICE-A'},{familyId:'VOICE-B'},{familyId:'RAIN'}]};
 model.materialRequirements=['A','B'].map(key=>({id:'VOICE-REQ-'+key,representationRef:'REP-'+key,requirementClass:'REQUIRED',requirementHash:productionHash('voice-requirement-'+key),assetFamilyRefs:['VOICE-'+key]}));
 model.domainGraph.entities=['A','B'].map(key=>({id:'PERSON-'+key,type:'CHARACTER',authority:'A'}));
 settings.inputs=settings.inputs.map(input=>({...input,requirementId:'VOICE-REQ-'+input.familyId.slice(-1),versionId:input.familyId+'@V1',sha256:productionHash(input.familyId),purpose:'VOICE_MASTER'}));
 assert.deepEqual(selectShotRecipeInputFamilies(model,work,settings),{familyIds:['VOICE-A'],blockers:[]});
 assert.deepEqual(selectShotRecipeInputFamilies(model,{...work,dialogue:{speakerEntityId:'PERSON-C'}},settings).familyIds,[]);
 model.domainGraph.representations[1].entityId='PERSON-A';assert.deepEqual(selectShotRecipeInputFamilies(model,work,settings),{familyIds:[],blockers:['INPUT_SPEAKER_VOICE_MASTER_NOT_UNIQUE']});
 const board={deliverableKey:'STORYBOARD',inputAssetRefs:['IMAGE-A','IMAGE-A']};assert.deepEqual(selectShotRecipeInputFamilies(model,board,settings),{familyIds:['IMAGE-A'],blockers:[]});
});
test('an adopted output may start a successor recipe from its exact published expected slot',()=>{
 const c=context(),source={assetFamilies:[c.family]},model={...c.model,assetFamilies:[{...c.family,currentExpectedOutputId:null,currentVersionId:'OUTPUT@V1'}]};
 assert.equal(shotRecipeExpectedOutput(model,source,'OUTPUT').id,'EXPECTED-1');
 source.assetFamilies[0]={...c.family,expectedOutputRefs:['OTHER']};assert.equal(shotRecipeExpectedOutput(model,source,'OUTPUT'),null);
 model.expectedOutputs=[{...c.output,familyId:'OTHER'}];assert.equal(shotRecipeExpectedOutput(model,{assetFamilies:[c.family]},'OUTPUT'),null);
});
test('video call package covers locked frames plus both handles and binds exact inputs without execution',()=>{
 const c=context(),content=author(),before=structuredClone(c),preview=compileShotRecipePreview(c,content,{draftRevisionId:'DRAFT-1'});
 assert.equal(preview.modelCalls,0);assert.equal(preview.definition.output.expectedOutputRef,c.output.id);assert.equal(preview.definition.productionBasisHash,c.basisHash);assert.equal(preview.definition.upload.items[0].sha256,c.inputs[0].sha256);assert.equal(preview.definition.parentVersionId,null);assert.deepEqual(c,before);
 const {definitionHash,...definition}=preview.definition;assert.equal(productionHash(definition),definitionHash);assert.deepEqual(compileShotRecipePreview(c,content,{draftRevisionId:'DRAFT-1'}),preview);
 assert.equal(preview.definition.definitionHashSchemaVersion,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA);
 assert.equal(inspectExecutionDefinitionHash({...preview.definition,sourceRef:'story/shot-production/recipes/'+preview.definition.id+'.json',sourceRevisionId:'source-r1',sourceSha256:productionHash(preview.definition)}).valid,true);
 for(const mutate of [v=>v.parameters.durationSeconds=4.99,v=>v.parameters.fps=25,v=>delete v.parameters.durationSeconds]){const bad=author();mutate(bad);assert.throws(()=>compileShotRecipePreview(c,bad,{draftRevisionId:'DRAFT-1'}),/锁定时长/);}
 c.timing=null;assert.throws(()=>compileShotRecipePreview(c,content,{draftRevisionId:'DRAFT-1'}),/锁定时长/);
});
test('adopted and still-pending candidates receive fresh output identities; previous bytes are not overwritten',()=>{
 const c=context('IMAGE');c.state.assetFamiliesById.OUTPUT.currentVersionId='OUTPUT@V1';c.state.assetVersionsById['OUTPUT@V1']={id:'OUTPUT@V1',familyId:'OUTPUT',sha256:productionHash('original')};
 const result=compileShotRecipePreview(c,author(),{draftRevisionId:'DRAFT-2'});assert.notEqual(result.expectedOutput.id,c.output.id);assert.equal(result.expectedOutput.plannedVersionLabel,'V002');assert.match(result.expectedOutput.targetPath,/V002\.png$/);assert.equal(result.definition.parentVersionId,'OUTPUT@V1');assert.equal(c.output.plannedVersionLabel,'V001');
 c.state.assetFamiliesById.OUTPUT.currentVersionId=null;c.model.assetVersions=[{id:'OUTPUT@PENDING',familyId:'OUTPUT'}];const pending=compileShotRecipePreview(c,author(),{draftRevisionId:'DRAFT-3'});assert.notEqual(pending.expectedOutput.id,result.expectedOutput.id);assert.equal(pending.definition.parentVersionId,null);assert.equal(pending.expectedOutput.expectationState,'PLANNED');assert.equal(pending.expectedOutput.realizedVersionId,null);
});
test('unchanged image SHA cannot keep an older duration, frame set or handles call package ready',()=>{
 const work={id:'WORK',deliverableKey:'SHOT_VIDEO',shotId:'SHOT-1',sceneId:'SCENE',scopeRole:'CURRENT',activeInCurrentProduction:true,shotProductionPlanId:'PLAN',executionDefinitionRef:'CALL',outputAssetRef:'OUTPUT',outputBasisHash:productionHash('workbasis'),inputAssetRefs:['BASE']},settings={shotId:'SHOT-1',handles:{headFrames:6,tailFrames:6},videoBranch:'SILENT'},plan={id:'PLAN',sceneId:'SCENE',scopeRole:'CURRENT',workItemIds:['WORK'],content:{shotPlanRevisionId:'DESIGN',shots:[settings]}};
 const input={order:1,path:'media/base.png',assetFamilyRef:'BASE',assetVersionRef:'BASE@V1',sha256:productionHash('base')},state={assetFamiliesById:{BASE:{id:'BASE',currentVersionId:'BASE@V1',canFlowDownstream:true}},assetVersionsById:{'BASE@V1':{id:'BASE@V1',familyId:'BASE',sha256:input.sha256,path:input.path,canFlowDownstream:true}}};
 const model={workItems:[work],assetFamilies:[{id:'OUTPUT',kind:'VIDEO'}],shotProductionPlans:[plan],animaticLocks:[{scopeRole:'CURRENT',sceneId:'SCENE',shotPlanRevisionId:'DESIGN',shotSlices:[{shotId:'SHOT-1',durationFrames:108,timingHash:productionHash('old-timing')}]}],shotKeyframeSets:[{id:'SET-1',sceneId:'SCENE',shotId:'SHOT-1',scopeRole:'CURRENT',members:[{familyId:'BASE',versionId:'BASE@V1',sha256:input.sha256}]}]};
 const basis=shotRecipeProductionBasis(model,work,plan,[input]),definition={id:'CALL',workItemRef:'WORK',productionBasis:basis,productionBasisHash:productionHash(basis)};
 assert.deepEqual(shotRecipeDefinitionBindingReasons(model,state,definition),[]);
 for(const mutate of [m=>{m.animaticLocks[0].shotSlices[0].durationFrames=144;m.animaticLocks[0].shotSlices[0].timingHash=productionHash('longer');},m=>m.shotKeyframeSets[0].id='SET-2',m=>m.shotProductionPlans[0].content.shots[0].handles.tailFrames=12]){const next=structuredClone(model);mutate(next);assert.ok(shotRecipeDefinitionBindingReasons(next,state,definition).includes('SHOT_RECIPE_INPUT_BASIS_CHANGED'));assert.equal(state.assetVersionsById['BASE@V1'].sha256,input.sha256);}
 const unrelated=structuredClone(model);unrelated.animaticLocks.push({sceneId:'OTHER',scopeRole:'CURRENT',shotPlanRevisionId:'OTHER',shotSlices:[{shotId:'SHOT-2',durationFrames:200}]});assert.deepEqual(shotRecipeDefinitionBindingReasons(unrelated,state,definition),[]);
});
