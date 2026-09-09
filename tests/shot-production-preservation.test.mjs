import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {productionHash,defaultShotProductionPlan,compileShotProductionPlan} from '../host/instance-runtime/shot-production-model.mjs';
import {compileShotRecipePreview} from '../host/instance-runtime/shot-production-recipes.mjs';
import {reuseShotProductionObjects} from '../host/instance-runtime/shot-production-reuse.mjs';
import {preserveShotProductionProjection,preserveShotRecipeProjection} from '../host/instance-runtime/shot-production-preservation.mjs';

const copy=structuredClone;
function fixture(){
 const sceneId='scene-letter',shotId='shot-letter',episodeUid='episode-letter';
 const spec={shotId,sceneId,order:1,title:'打开信',narrativeBeat:'收到来信',audienceTakeaway:'来信改变决定',materialRequirementRefs:[],inputBindings:[]};
 const content={sceneId,identityChangeReason:'NO_IDENTITY_CHANGE',shots:[spec]};
 const design={id:'design-letter',scopeId:sceneId,sceneId,episodeUid,content,contentHash:productionHash(content)};
 const scope={sceneId,episodeUid,plan:design,shots:[{...spec,id:shotId}]},settings=defaultShotProductionPlan(scope,{schemaVersion:'1.0'});
 settings.shots[0].keyframeStrategy={mode:'START_END',reason:'打开信前后的动作状态',intermediateFrameCount:0};
 const documents=[],doc=(path,revisionId,value,role)=>{const bytes=canonicalJson(value),result={revisionId,aliases:[path],bytes,sha256:sha256(bytes),metadata:{sourceRole:role}};documents.push(result);return result;};
 const makePlan=(id,settings)=>{const sourcePath=`story/shot-production/${id}.json`,sourceRevisionId=`source-${id}`;
  const source=doc(sourcePath,sourceRevisionId,{schemaVersion:'1.0',productionPlanId:id,content:settings,contentHash:productionHash(settings),shotPlanRevisionId:design.id},'SHOT_PRODUCTION_PLAN');
  return {id,sceneId,episodeUid,content:copy(settings),contentHash:productionHash(settings),sourcePath,sourceRevisionId,sourceSha256:source.sha256,scopeRole:'CURRENT'};
 };
 const p1=makePlan('plan-1',settings),c1=compileShotProductionPlan(scope,settings,{id:p1.id,revisionId:p1.sourceRevisionId,sourceRef:p1.sourcePath});p1.workItemIds=c1.workItems.map(w=>w.id);
 const model={shotPlanSetRevisions:[design],shots:[{...spec,id:shotId,shotPlanSetRevisionId:design.id,workPackageRefs:c1.workPackages.filter(p=>p.scopeType==='SHOT').map(p=>p.id)}],shotProductionPlans:[p1],assetVersions:[],...c1};
 const changed=copy(settings);changed.shots[0].handles.tailFrames=12;
 const p2=makePlan('plan-2',changed),c2=compileShotProductionPlan(scope,changed,{id:p2.id,revisionId:p2.sourceRevisionId,sourceRef:p2.sourcePath}),reuse=reuseShotProductionObjects(model,p1,c2);p2.workItemIds=reuse.workItemIds;
 for(const key of ['workItems','assetFamilies','expectedOutputs','workPackages','reviewContexts'])model[key]=[...model[key].map(r=>reuse.retained[key].has(r.id)?r:{...r,scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false}),...reuse.additions[key]];
 model.shotProductionPlans=[p2,{...p1,scopeRole:'EVIDENCE_ONLY'}];
 model.shots[0].workPackageRefs=model.workPackages.filter(p=>p.scopeRole==='CURRENT'&&p.scopeType==='SHOT').map(p=>p.id);
 const work=model.workItems.find(w=>w.deliverableKey==='STORYBOARD'),family=model.assetFamilies.find(f=>f.id===work.outputAssetRef),output=model.expectedOutputs.find(o=>o.id===family.currentExpectedOutputId);
 const version={id:family.id+'@V1',familyId:family.id,sha256:productionHash('real-registered-image'),path:output.targetPath};
 family.versionRefs=[version.id];family.currentVersionId=version.id;model.assetVersions.push(version);
 const recipes={executionDefinitions:[],promptRevisions:[]};model.shotProductionRecipeRevisions=[];
 for(const n of [1,2]){
  const ctx={work,family,output,model,state:{assetFamiliesById:{},assetVersionsById:{}},inputs:[],basis:{workItemId:work.id,outputBasisHash:work.outputBasisHash},basisHash:productionHash(work.outputBasisHash),view:{releaseId:'release-fixture'}};
  const definition=compileShotRecipePreview(ctx,{model:'image-provider',prompt:'依照本镜设计生成粗分镜 '+n,negativePrompt:'不要水印',parameters:{resolution:'1024x1024'}},{draftRevisionId:'recipe-draft-'+n}).definition;
  const sourcePath='story/shot-production/recipes/'+definition.id+'.json',source=doc(sourcePath,'source-'+definition.id,definition,'SHOT_EXECUTION_DEFINITION');
  const binding={sourceRef:sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256};
  recipes.executionDefinitions.push({...definition,...binding});recipes.promptRevisions.push({id:definition.currentRevisionId,executionDefinitionId:definition.id,definitionHash:definition.definitionHash,prompt:definition.prompt,...binding});
  model.shotProductionRecipeRevisions.push({id:definition.id,workItemId:work.id,sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256,definitionHash:definition.definitionHash});
  work.executionDefinitionRef=definition.id;work.promptRef=definition.currentRevisionId;
 }
 return {baseSnapshot:{productionModel:model},baseRecipes:recipes,documents,sceneId,shotId,design,work};
}
const preserve=f=>preserveShotProductionProjection({snapshot:{productionModel:{shots:copy(f.baseSnapshot.productionModel.shots)}},...f});
const preserveRecipes=f=>preserveShotRecipeProjection({snapshot:preserve(f),recipes:{executionDefinitions:[],promptRevisions:[]},...f});

test('source recompile retains all plan generations, reused identities, immutable ShotSpecs and recipe history byte for byte',()=>{
 const f=fixture(),before=canonicalJson(f),result=preserveRecipes(f),m=result.snapshot.productionModel,prior=f.baseSnapshot.productionModel;
 for(const key of ['shotProductionPlans','workItems','assetFamilies','assetVersions','expectedOutputs','workPackages','reviewContexts','shotProductionRecipeRevisions','shots'])assert.deepEqual(m[key],prior[key],key);
 assert.deepEqual(result.recipes,f.baseRecipes);assert.equal(canonicalJson(f),before);
 assert.equal(m.shotProductionPlans.length,2);assert.equal(result.recipes.executionDefinitions.length,2);
 const current=new Set(m.shotProductionPlans[0].workItemIds),old=m.shotProductionPlans[1];assert(current.has(f.work.id));assert(old.workItemIds.some(id=>!current.has(id)));
 assert.equal(m.workItems.find(w=>w.id===f.work.id).shotProductionPlanId,old.id);
});
test('every historical production source must retain the exact document identity, SHA and parsed content',()=>{
 for(const mutate of [f=>f.documents.shift(),f=>f.documents[0].bytes+=' ',f=>f.documents[0].aliases=[],f=>f.baseSnapshot.productionModel.shotProductionPlans[1].sourceRevisionId='wrong',f=>f.baseSnapshot.productionModel.shotProductionPlans[0].contentHash=productionHash('other')]){
  const f=fixture();mutate(f);assert.throws(()=>preserve(f),{code:'SCOPED_SOURCE_CONFLICT'});
 }
});
test('source preservation rejects truncated and substituted logical output closures',()=>{
 for(const mutate of [m=>m.shotProductionPlans[0].workItemIds.pop(),m=>m.shotProductionPlans[0].workItemIds.push(m.shotProductionPlans[0].workItemIds[0]),m=>m.shotProductionPlans[0].workItemIds[0]=m.shotProductionPlans[0].workItemIds[1],m=>m.workItems[0].outputBasisHash=productionHash('changed'),m=>m.workItems.find(w=>w.deliverableKey==='ANIMATIC').inputAssetRefs=[],m=>m.shotPlanSetRevisions=[]]){
  const f=fixture();mutate(f.baseSnapshot.productionModel);assert.throws(()=>preserve(f),{code:'SCOPED_SOURCE_CONFLICT'});
 }
});
test('producer package, exact context, family, all ExpectedOutputs and referenced versions cannot disappear during recompile',()=>{
 for(const key of ['workItems','workPackages','assetFamilies','reviewContexts','expectedOutputs','assetVersions']){const f=fixture();f.baseSnapshot.productionModel[key]=[];assert.throws(()=>preserve(f),{code:'SCOPED_SOURCE_CONFLICT'},key);}
 for(const mutate of [m=>m.workPackages[0].workItemRefs.push(m.workItems[1].id),m=>m.workPackages[0].scopeId='other-shot',m=>m.reviewContexts[0].judgment.purpose.text='silently changed',m=>m.assetFamilies[0].ownerRef='other-work']){const f=fixture();mutate(f.baseSnapshot.productionModel);assert.throws(()=>preserve(f),{code:'SCOPED_SOURCE_CONFLICT'});}
});
test('legacy compiler may not collide with frozen production or recipe identities',()=>{
 const f=fixture(),work={...f.work,label:'compiler replaced the label'};
 assert.throws(()=>preserveShotProductionProjection({...f,snapshot:{productionModel:{workItems:[work]}}}),{code:'SCOPED_SOURCE_CONFLICT'});
 assert.throws(()=>preserveShotRecipeProjection({...f,snapshot:preserve(f),recipes:{executionDefinitions:[{...f.baseRecipes.executionDefinitions[0],title:'changed'}]}}),{code:'SCOPED_SOURCE_CONFLICT'});
});
test('recipe sources, exact prompt revision and producer ownership are mandatory for historical definitions',()=>{
 for(const mutate of [f=>f.documents.pop(),f=>f.baseRecipes.executionDefinitions[0].sourceRevisionId='wrong',f=>f.baseRecipes.promptRevisions.shift(),f=>f.baseRecipes.promptRevisions[0].prompt.main='changed',f=>f.baseRecipes.promptRevisions[0].sourceSha256=productionHash('wrong'),f=>f.baseSnapshot.productionModel.shotProductionRecipeRevisions[0].workItemId='missing-work']){
  const f=fixture();mutate(f);assert.throws(()=>preserveRecipes(f),{code:'SCOPED_SOURCE_CONFLICT'});
 }
});

// Execute the actual private runtime gate without importing mutable store state.
const source=readFileSync(new URL('../app/api/v8/_store.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const declaration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='gateShotPlanDerivedOperationalProjection');
assert(declaration);
const module={exports:{}};
new Function('module','exports','stableObjectHash','HttpError',ts.transpileModule(declaration.getText(ast)+'\nexport {gateShotPlanDerivedOperationalProjection};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports,productionHash,Error);
const gate=module.exports.gateShotPlanDerivedOperationalProjection;
function gateFixture(){
 const f=fixture(),m=f.baseSnapshot.productionModel,d=m.shotPlanSetRevisions[0];
 Object.assign(d,{planId:'PLAN-SET',scopeType:'SCENE',scopeRole:'CURRENT',revisionState:'CURRENT',isCurrent:true,revisionHash:d.contentHash,shotIds:[f.shotId]});
 for(const s of m.shots)Object.assign(s,{shotPlanSetRevisionHash:d.contentHash});
 const projection={workItemsById:Object.fromEntries(m.workItems.map(w=>[w.id,copy(w)])),workPackagesById:Object.fromEntries(m.workPackages.map(w=>[w.id,copy(w)])),shotsById:Object.fromEntries(m.shots.map(w=>[w.id,copy(w)])),materialRequirementsById:{}};
 const structures={'SHOT_PLAN_SET::PLAN-SET':{subjectKind:'SHOT_PLAN_SET',subjectRevisionId:d.id,subjectRevisionHash:d.contentHash,reviewDecision:'RELEASED',lifecycleState:'RELEASED',sourceSyncState:'SUCCEEDED',canFlowDownstream:true}};
 const locks={scope:{scopeType:'SCENE',scopeId:f.sceneId,lockPurpose:'SHOT_PLAN_SET',lockState:'LOCKED',scopeLockState:'LOCKED',denominatorState:'KNOWN',denominator:1,lockedRevisionId:d.id,lockedRevisionHash:d.contentHash,shotIds:[f.shotId]}};
 return {...f,m,projection,structures,locks,run:()=>gate(f.baseSnapshot,projection,structures,locks)};
}
test('runtime gate keeps reused current work and packages while unreused historical outputs never revive',()=>{
 const f=gateFixture(),before=canonicalJson(f.m),ids=new Set(f.m.shotProductionPlans[0].workItemIds);f.run();
 for(const w of f.m.workItems)assert.equal(f.projection.workItemsById[w.id].activeInCurrentProduction,ids.has(w.id),w.deliverableKey);
 for(const p of f.m.workPackages)assert.equal(f.projection.workPackagesById[p.id].activeInCurrentProduction,p.workItemRefs.every(id=>ids.has(id)),p.id);
 assert.equal(canonicalJson(f.m),before);assert.equal(f.projection.workItemsById[f.work.id].scopeRole,'CURRENT');
});
test('foreign, duplicate, malformed or different-design current plan cannot revive production objects',()=>{
 for(const mutate of [m=>m.shotProductionPlans[0].sceneId='other-scene',m=>m.shotProductionPlans.push(copy(m.shotProductionPlans[0])),m=>m.shotProductionPlans[0].content.shotPlanHash=productionHash('wrong'),m=>m.shotProductionPlans[0].workItemIds='bad',m=>m.shotProductionPlans[0].workItemIds.push(m.shotProductionPlans[0].workItemIds[0])]){
  const f=gateFixture();mutate(f.m);assert.doesNotThrow(f.run);assert(Object.values(f.projection.workItemsById).every(w=>w.activeInCurrentProduction===false));assert(Object.values(f.projection.workPackagesById).every(w=>w.activeInCurrentProduction===false));
 }
});
test('design review reopening invalidates production packages and legacy design-only work retains its original gate',()=>{
 const f=gateFixture();f.locks.scope.lockState='REOPENED';f.run();assert(Object.values(f.projection.workItemsById).every(w=>w.activeInCurrentProduction===false));
 const legacy=gateFixture(),w=legacy.m.workItems.find(w=>w.deliverableKey==='SHOT_INPUT_LOCK');delete w.shotProductionPlanId;legacy.m.shotProductionPlans=[];legacy.run();assert.equal(legacy.projection.workItemsById[w.id].activeInCurrentProduction,true);
});

test('ambiguous formal scope locks cannot be silently resolved by map insertion order',()=>{
 const f=gateFixture();f.locks.duplicate=copy(f.locks.scope);f.run();
 assert(Object.values(f.projection.workItemsById).every(w=>w.activeInCurrentProduction===false));
 assert(Object.values(f.projection.workPackagesById).every(w=>w.activeInCurrentProduction===false));
});
