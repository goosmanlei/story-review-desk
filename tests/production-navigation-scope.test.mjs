import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';

// Read actual checkout ASTs: no copied implementation, database or runtime mocks.
// Only pure functions are compiled; React/UI side effects are not loaded.
const sourceUrl=new URL('../app/production-workbench.tsx',import.meta.url);
const source=readFileSync(sourceUrl,'utf8');
const ast=ts.createSourceFile(sourceUrl.pathname,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const functionNames=['productionPackagesInNavigationScope','fullProductionPackagesForGate','fullProductionPackagesForStep','fullProductionCurrentShotIds','formalCurrentShotSpecIds','fullProductionCurrentP07ShotIds','gateForStep','productionGates'];
const declarations=functionNames.map(name=>{
  const nodes=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert.equal(nodes.length,1,'actual function resolves exactly once: '+name);
  return nodes[0].getText(ast);
});
const profileSource=readFileSync(new URL('../app/instance-profile.ts',import.meta.url),'utf8');
const profileModule={exports:{}};
new Function('module','exports',ts.transpileModule(profileSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(profileModule,profileModule.exports);
const module={exports:{}};
new Function('module','exports','projectIdFor',ts.transpileModule(declarations.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports,profileModule.exports.projectIdFor);
const {productionPackagesInNavigationScope:select}=module.exports;
const gates=[
 {id:'SCENE_QA',scopeType:'SCENE',phaseId:'SCENE_FINISH',legacyStepIds:[]},
 {id:'SHOT_LOCK',scopeType:'SHOT',phaseId:'SHOT_FINISH',legacyStepIds:[]},
 {id:'EPISODE_TECH_QC',scopeType:'EPISODE',phaseId:'EPISODE_FINISH',legacyStepIds:[]},
 {id:'DELIVERY_ARCHIVE',scopeType:'PROJECT',phaseId:'SERIES_DELIVERY',legacyStepIds:[]},
];
function fixture(){
 const model={instance:{projectId:'project-permanent'},counts:{currentP07ShotPlans:0},workPackages:[],workItems:[],reviewContexts:[],productionGates:gates,shots:[
  {id:'shot-a',sceneId:'scene-a',title:'S01',scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:'plan-current'},
  {id:'shot-b',sceneId:'scene-b',title:'S01',scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:'plan-current-b'},
  {id:'shot-old',sceneId:'scene-a',scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false,shotPlanSetRevisionId:'old-plan'},
 ]};
 const add=(gateId,id,extra={})=>{
  const gate=gates.find(g=>g.id===gateId),record={id,gateId,scopeType:gate.scopeType,scopeId:id,phaseId:gate.phaseId,stepId:'CUSTOM',activeInCurrentProduction:true,applicabilityState:'REQUIRED',shotIds:[],...extra};model.workPackages.push(record);return record;
 };
 return {model,add};
}
const ids=rows=>rows.map(r=>r.id);
const gate=id=>gates.find(g=>g.id===id);
test('scope selector is executed from the current source AST, not an embedded approximation',()=>{
 assert.equal(declarations.length,8);
 assert.match(createHash('sha256').update(source).digest('hex'),/^[a-f0-9]{64}$/);
 assert.equal(typeof select,'function');
});
test('episode navigation uses permanent UID and ignores matching display labels',()=>{
 const {model,add}=fixture();
 add('EPISODE_TECH_QC','ep-a',{scopeId:'episode-a',episodeUid:'episode-a',label:'E01'});
 add('EPISODE_TECH_QC','ep-b',{scopeId:'episode-b',episodeUid:'episode-b',label:'E01'});
 add('EPISODE_TECH_QC','legacy-alias',{scopeId:'E01',label:'E01'});
 assert.deepEqual(ids(select(model,gate('EPISODE_TECH_QC'),{navigationScopeType:'EPISODE',episodeUid:'episode-b',sceneId:'scene-a'})),['ep-b']);
 assert.deepEqual(select(model,gate('EPISODE_TECH_QC'),{navigationScopeType:'EPISODE',episodeUid:'E01'}),[]);
 assert.deepEqual(select(model,gate('EPISODE_TECH_QC'),{navigationScopeType:'EPISODE'}),[]);
});
test('project export remains project-wide regardless of selected episode and rejects episode narrowing',()=>{
 const {model,add}=fixture();add('DELIVERY_ARCHIVE','export',{scopeId:'project-permanent'});
 const before=JSON.stringify(model);
 for(const episodeUid of ['episode-a','episode-b',undefined])assert.deepEqual(ids(select(model,gate('DELIVERY_ARCHIVE'),{navigationScopeType:'PROJECT',episodeUid})),['export']);
 assert.deepEqual(select(model,gate('DELIVERY_ARCHIVE'),{navigationScopeType:'EPISODE',episodeUid:'episode-a'}),[]);
 assert.equal(JSON.stringify(model),before);
});
test('scene packages require both permanent scene and scope identity; titles and episode aliases never repair conflicts',()=>{
 const {model,add}=fixture();add('SCENE_QA','scene-good',{scopeId:'scene-a',sceneId:'scene-a'});
 add('SCENE_QA','wrong-scope',{scopeId:'scene-b',sceneId:'scene-a',label:'S01'});
 add('SCENE_QA','wrong-scene',{scopeId:'scene-a',sceneId:'scene-b',label:'S01'});
 add('SCENE_QA','title-only',{scopeId:'S01',label:'scene-a'});
 assert.deepEqual(ids(select(model,gate('SCENE_QA'),{navigationScopeType:'SCENE',sceneId:'scene-a'})),['scene-good']);
 assert.deepEqual(select(model,gate('SCENE_QA'),{navigationScopeType:'SCENE',sceneId:'S01'}),[]);
});
test('shot packages require current formal shot identity, exact membership and the actual parent scene',()=>{
 const {model,add}=fixture();add('SHOT_LOCK','shot-good',{scopeId:'shot-a',shotIds:['shot-a']});
 add('SHOT_LOCK','other-parent',{scopeId:'shot-b',shotIds:['shot-b'],sceneId:'scene-a'});
 add('SHOT_LOCK','history',{scopeId:'shot-old',shotIds:['shot-old']});
 add('SHOT_LOCK','missing-membership',{scopeId:'shot-a',shotIds:[]});
 add('SHOT_LOCK','title-only',{scopeId:'S01',shotIds:['shot-a'],label:'shot-a'});
 assert.deepEqual(ids(select(model,gate('SHOT_LOCK'),{navigationScopeType:'SCENE',sceneId:'scene-a'})),['shot-good']);
});
test('inactive, not-required and mismatched-gate packages remain excluded',()=>{
 const {model,add}=fixture();add('SCENE_QA','active',{scopeId:'scene-a',sceneId:'scene-a'});
 add('SCENE_QA','inactive',{scopeId:'scene-a',sceneId:'scene-a',activeInCurrentProduction:false});
 add('SCENE_QA','not-required',{scopeId:'scene-a',sceneId:'scene-a',applicabilityState:'NOT_REQUIRED'});
 add('SHOT_LOCK','other-gate',{scopeId:'scene-a',sceneId:'scene-a',scopeType:'SCENE'});
 assert.deepEqual(ids(select(model,gate('SCENE_QA'),{navigationScopeType:'SCENE',sceneId:'scene-a'})),['active']);
});

test('episode UID cannot override a contradictory permanent scope ID',()=>{
 const {model,add}=fixture();
 add('EPISODE_TECH_QC','conflicting-episode',{scopeId:'episode-other',episodeUid:'episode-a'});
 add('EPISODE_TECH_QC','alias-scope',{scopeId:'E01',episodeUid:'episode-a',label:'E01'});
 assert.deepEqual(select(model,gate('EPISODE_TECH_QC'),{navigationScopeType:'EPISODE',episodeUid:'episode-a'}),[]);
});
test('project navigation cannot admit another project through the same export gate',()=>{
 const {model,add}=fixture();
 add('DELIVERY_ARCHIVE','wrong-project',{scopeId:'project-other',episodeUid:'episode-a',label:'全剧归档'});
 add('DELIVERY_ARCHIVE','correct-project',{scopeId:'project-permanent',episodeUid:'episode-other'});
 assert.deepEqual(ids(select(model,gate('DELIVERY_ARCHIVE'),{navigationScopeType:'PROJECT',episodeUid:'episode-a'})),['correct-project']);
});
test('contradictory package scope cannot cross the canonical gate subject type',()=>{
 const {model,add}=fixture();add('SCENE_QA','shot-in-scene-gate',{scopeType:'SHOT',scopeId:'shot-a',shotIds:['shot-a']});
 add('SHOT_LOCK','scene-in-shot-gate',{scopeType:'SCENE',scopeId:'scene-a',sceneId:'scene-a'});
 assert.deepEqual(select(model,gate('SCENE_QA'),{navigationScopeType:'SCENE',sceneId:'scene-a'}),[]);
 assert.deepEqual(select(model,gate('SHOT_LOCK'),{navigationScopeType:'SCENE',sceneId:'scene-a'}),[]);
});
