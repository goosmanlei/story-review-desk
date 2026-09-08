import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
import {canonicalShotDesign,isRequirementDrivenPlanningVersion} from '../host/instance-runtime/shot-design-contract.mjs';

const {api}=loadModernEventRuntime(fileURLToPath(new URL('../',import.meta.url)));
const hash=api.stableObjectHash;
function design(){return {shotSize:'MEDIUM',cameraAngle:'EYE_LEVEL',cameraMovement:'PUSH',composition:'人在门右侧，信在桌面',performance:'迟疑后确认来信',lighting:'阴天窗光',estimatedDurationSeconds:5.2,subjectIds:['ENTITY-VISITOR'],continuity:{startState:'手停在信封上方',endState:'展开信纸',previousShotId:null,nextShotId:null,transitionIn:'接信件特写',transitionOut:'接人物反应'},keyframeStrategy:{mode:'START_END',reason:'明确拿信动作起止',intermediateFrameCount:0}};}
function fixture(version='2.0'){
 const sceneId='scene:letter',planId='SHOT-PLAN:letter',coverage={sceneId,beats:[{beatId:sceneId+'-B01',materialRequirementRefs:['MATREQ-LETTER']}]};
 const basis=[{bindingType:version==='1.0'?'ADOPTED_MATERIAL_SET':'MATERIAL_REQUIREMENT_SET',bindingId:'material-set:letter',bindingHash:hash('material-set')},{bindingType:'SCENE_COVERAGE_REVISION',bindingId:'coverage:letter',bindingHash:hash(coverage)}];
 const shot={shotId:sceneId+'-SH01',sceneId,order:1,title:'打开信',coverageBeatRefs:[sceneId+'-B01'],narrativeBeat:'获得消息',audienceTakeaway:'来信改变决定',visualIntent:'人物和信同框',actionIntent:'打开信',soundIntent:'纸声',dialogueContext:'无对白',materialRequirementRefs:['MATREQ-LETTER'],inputBindings:basis,...(version==='3.0'?{design:design()}:{})};
 const content={sceneId,identityChangeReason:'NO_IDENTITY_CHANGE',shots:[shot]};
 const data={productionModel:{materialRequirements:[{id:'MATREQ-LETTER',requirementClass:'REQUIRED'}],shots:[],shotPlanSetRevisions:[{planId,scopeType:'SCENE',scopeId:sceneId,content:{shots:[]}}],sceneCoveragePlanRevisions:[{id:'coverage:letter',scopeRole:'CURRENT',revisionState:'CURRENT',contentHash:hash(coverage),content:coverage}]}};
 return {data,content,basis,planId};
}
for(const version of ['1.0','2.0'])test(`legacy ShotSpec ${version} keeps its exact canonical content and SHA`,()=>{
 const f=fixture(version),before=JSON.stringify(f.content),contentHash=hash(f.content);
 const result=api.canonicalSceneScopedContent(f.data,'SHOT_PLAN_SET',f.planId,f.content,f.basis,version);
 assert.equal(JSON.stringify(result),before);assert.equal(hash(result),contentHash);assert.equal(Object.hasOwn(result.shots[0],'design'),false);
 f.content.shots[0].design=design();assert.throws(()=>api.canonicalSceneScopedContent(f.data,'SHOT_PLAN_SET',f.planId,f.content,f.basis,version),/ShotSpec contract/);
});
test('V3 persists structured intent without turning estimated duration into a timing lock',()=>{
 const f=fixture('3.0'),before=hash(f.content),result=api.canonicalSceneScopedContent(f.data,'SHOT_PLAN_SET',f.planId,f.content,f.basis,'3.0');
 assert.equal(hash(result),before);assert.equal(result.shots[0].design.estimatedDurationSeconds,5.2);assert.equal(Object.hasOwn(result.shots[0],'durationStatus'),false);
 assert.equal(api.scopedPlanningReviewSpec('SHOT_PLAN_SET','3.0').schemaVersion,'3.0');
 assert.notEqual(api.scopedPlanningReviewSpec('SHOT_PLAN_SET','3.0').hash,api.scopedPlanningReviewSpec('SHOT_PLAN_SET','2.0').hash);
});
test('V3 rejects an adopted-material baseline and does not infer a V3 contract from new fields',()=>{
 const f=fixture('3.0');f.basis[0].bindingType='ADOPTED_MATERIAL_SET';
 assert.throws(()=>api.canonicalSceneScopedContent(f.data,'SHOT_PLAN_SET',f.planId,f.content,f.basis,'3.0'),/需求基线/);
 const old=fixture('3.0');assert.throws(()=>api.canonicalSceneScopedContent(old.data,'SHOT_PLAN_SET',old.planId,old.content,old.basis),/ShotSpec contract/);
});
test('V3 rejects a foreign neighbour and missing or malformed structured fields',()=>{
 const f=fixture('3.0');f.content.shots[0].design.continuity.nextShotId='foreign:shot';
 assert.throws(()=>api.canonicalSceneScopedContent(f.data,'SHOT_PLAN_SET',f.planId,f.content,f.basis,'3.0'),/相邻镜头/);
 for(const mutate of [d=>{delete d.lighting;},d=>{d.timingStatus='LOCKED';},d=>{d.estimatedDurationSeconds=-1;},d=>{d.estimatedDurationSeconds='5.2';},d=>{d.subjectIds.push(d.subjectIds[0]);},d=>{d.keyframeStrategy.intermediateFrameCount=1;},d=>{d.keyframeStrategy.mode='MULTI_KEYFRAME';}]){
  const value=design();mutate(value);assert.throws(()=>canonicalShotDesign(value));
 }
});
test('single-start and multiple-keyframe strategies have explicit output expectations',()=>{
 const single=design();single.keyframeStrategy.mode='START_ONLY';assert.equal(canonicalShotDesign(single).keyframeStrategy.intermediateFrameCount,0);
 const multi=design();multi.keyframeStrategy={mode:'MULTI_KEYFRAME',reason:'转身需要约束中间朝向',intermediateFrameCount:2};assert.equal(canonicalShotDesign(multi).keyframeStrategy.intermediateFrameCount,2);
 const unknown=design();unknown.estimatedDurationSeconds=null;unknown.keyframeStrategy={mode:'UNDECIDED',reason:'待预演校准',intermediateFrameCount:0};assert.equal(canonicalShotDesign(unknown).estimatedDurationSeconds,null);
 assert.equal(isRequirementDrivenPlanningVersion('1.0'),false);assert.equal(isRequirementDrivenPlanningVersion('2.0'),true);assert.equal(isRequirementDrivenPlanningVersion('3.0'),true);assert.equal(isRequirementDrivenPlanningVersion('4.0'),false);
});
