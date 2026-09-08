import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { blankProfile, blankSnapshot } from '../host/instance-runtime/blank.mjs';
import { normalizeReviewSnapshot } from '../host/instance-runtime/snapshot-contract.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRequire = createRequire(import.meta.url);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Exercise the real queue and journey functions without starting a server or
// opening a database. Only the authority-reading boundary is supplied by the
// fixture; scope filtering, program states and capabilities run in production code.
function projectionFixture({ sceneCount = 0, basisCurrent = false, ready = false, released = false } = {}) {
  const profile = blankProfile({ title: '独立空实例状态测试' });
  const { snapshot, recipes } = blankSnapshot(profile);
  const scenes = Array.from({ length: sceneCount }, (_, index) => ({ id: `S${String(index + 1).padStart(2, '0')}`, episodeId: 'E01', episodeUid: 'episode-fixture' }));
  snapshot.scope.storyScenes = sceneCount;
  snapshot.creativeLineage.scenes = scenes;
  snapshot.productionModel.scenes = scenes;
  snapshot.actionQueueInputs.rewrittenSceneConfirmations = scenes.map((scene) => ({ sceneId: scene.id, subjectId: scene.id, affectedDownstreamRefs: { episodeIds: ['E01'] } }));
  if (sceneCount) {
    const episode = { id: 'E01', episodeUid: 'episode-fixture', sceneIds: scenes.map((scene) => scene.id), title: '分集测试', openingHook: '开端', coreAdvance: '推进', endingCliffhanger: '追看', reviewQuestion: '是否连贯', reviewDossier: {} };
    snapshot.productionModel.episodes = [episode];
    snapshot.creativeLineage.episodes = [episode];
    snapshot.creativeLineage.storyStructure = { planStatus: ready ? 'CURRENT' : 'PROPOSAL', sourceSha256: basisCurrent ? 'a'.repeat(64) : '' };
    snapshot.productionModel.episodePlanRevisions = [{
      id: 'plan-fixture', planId: profile.episodePlanId, episodes: [episode],
      scopeRole: ready ? 'CURRENT' : 'PROPOSAL', revisionState: ready ? 'CURRENT' : 'PROPOSAL',
      isCurrent: ready, isCurrentProposal: !ready, basisBindingsHash: basisCurrent ? 'b'.repeat(64) : '',
      ...(ready ? { review: { state: 'RELEASED' }, sync: { state: 'SOURCE_CURRENT' } } : {}),
    }];
  }
  const operations = {
    snapshotId: snapshot.snapshotId, baseSnapshotId: snapshot.snapshotId,
    operationRevision: 'OP-FIXTURE', etag: '"fixture"',
    reviews: { events: [] }, creativeRevisions: { events: [] }, candidates: { events: [] },
    runs: { events: [] }, executionRequests: { current: [] }, sourceOperations: { latestById: [] },
    stateProjection: {
      workItemsById: {}, materialWorkItemsById: {}, assetFamiliesById: {}, assetVersionsById: {},
      materialRequirementsById: {}, scopeLocksById: {}, structuresById: {},
      scriptScenesById: released ? Object.fromEntries(scenes.map((scene) => [scene.id, { reviewDecision: 'RELEASED' }])) : {},
    },
  };
  const store = {
    reviewData: async () => normalizeReviewSnapshot(snapshot),
    operationalSnapshot: async () => operations,
    recipeCatalog: async () => recipes,
    storyConfirmationTargets: () => snapshot.actionQueueInputs.rewrittenSceneConfirmations,
    audioVerificationTargets: () => [],
    assertCreativeRevisionBasisCurrent: () => { if (!basisCurrent) throw new Error('fixture basis is unavailable'); },
    stableObjectHash: hash,
    workProductReviewBinding: () => { throw new Error('unexpected production output in story-only fixture'); },
  };
  const modules = new Map();
  function load(filename) {
    if(filename.endsWith('.mjs'))return nativeRequire(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const loadedModule = { exports: {} };
    modules.set(filename, loadedModule);
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: filename,
    }).outputText;
    const require = (specifier) => {
      if (specifier.endsWith('/_store') || specifier === './_store') return store;
      if (!specifier.startsWith('.')) return nativeRequire(specifier);
      return load(path.resolve(path.dirname(filename), /\.[cm]?[jt]sx?$/.test(specifier) ? specifier : `${specifier}.ts`));
    };
    new Function('require', 'module', 'exports', source)(require, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  return {
    snapshot, operations, recipes,
    ...load(path.join(appRoot, 'app/api/v8/_action-queue.ts')),
    ...load(path.join(appRoot, 'app/api/v8/_journeys.ts')),
  };
}

const program = (projection, id) => projection.programs.find((entry) => entry.id === id);

function productionStageFixture() {
  const f=projectionFixture(),model=f.snapshot.productionModel;
  const exits=['SHOT_PLAN_INPUT_LOCK','SHOT_LOCK','SCENE_QA','EPISODE_TECH_QC'];
  f.operations.stateProjection.configuredGatesByWorkItem={};
  f.operations.stateProjection.executionGatesByWorkItem={};
  const add=(gateId,scopeId,{released=true,blocked=false,active=true}={})=>{
    const gate=model.productionGates.find(g=>g.id===gateId),id='work-'+gateId+'-'+model.workItems.length;
    const work={id,phaseId:gate.phaseId,gateId,scopeType:gate.scopeType,scopeId,activeInCurrentProduction:true,scopeRole:'CURRENT',
      ...(gate.scopeType==='SCENE'?{sceneId:scopeId}:gate.scopeType==='SHOT'?{shotId:scopeId,sceneId:'scene-parent'}:gate.scopeType==='EPISODE'?{episodeUid:scopeId}:{})};
    model.workItems.push(work);model.workPackages.push({id:'package-'+id,phaseId:gate.phaseId,gateId,scopeType:gate.scopeType,scopeId,activeInCurrentProduction:true,workItemRefs:[id]});
    f.operations.stateProjection.workItemsById[id]={lifecycleState:'IN_PROGRESS',canFlowDownstream:released,activeInCurrentProduction:active};
    f.operations.stateProjection.configuredGatesByWorkItem[id]={entryReasons:blocked?['RIGHTS_BLOCKED']:[],exitReasons:[],reasons:[],status:blocked?'BLOCKED':'READY'};
    return work;
  };
  for(const [index,id] of exits.entries()){
    const gate=model.productionGates.find(g=>g.id===id);gate.denominatorState='KNOWN';gate.denominator=index+2;gate.denominatorUnit=gate.scopeType;
  }
  return {...f,add,exits};
}
const productionDomain=queue=>queue.workspaceSummary.domains.find(d=>d.id==='FULL_PRODUCTION');

test('creator queue has three module exits; design/input counts never inflate locked-shot or episode denominators',async()=>{
  const f=productionStageFixture();
  f.exits.forEach((id,index)=>f.add(id,'permanent-object-'+index));
  const project=f.snapshot.productionModel.productionGates.find(g=>g.id==='DELIVERY_ARCHIVE');project.denominatorState='KNOWN';project.denominator=99;
  for(let i=0;i<3;i++)f.add('DELIVERY_ARCHIVE','project-'+i);
  f.operations.stateProjection.scopeLocksById.fake={scopeType:'PROJECT',scopeId:f.snapshot.productionModel.projectId,lockState:'LOCKED',denominatorState:'KNOWN',denominator:999};
  const before=JSON.stringify([f.snapshot,f.operations]),domain=productionDomain(await f.buildActionQueue());
  assert.deepEqual(domain.stages.map(s=>s.id),['SHOT_PRODUCTION','SCENE_EDIT','EPISODE_EDIT']);
  assert.deepEqual(domain.stages.map(s=>[s.count,s.denominator,s.denominatorState]),[[1,3,'KNOWN'],[1,4,'KNOWN'],[1,5,'KNOWN']]);
  assert.equal(domain.metrics.find(m=>m.id==='PHASES').value,3);assert.equal(domain.metrics.some(m=>m.id==='GATES'),false);
  assert.equal(JSON.stringify([f.snapshot,f.operations]),before);
  const designOnly=productionStageFixture();designOnly.add('SHOT_PLAN_INPUT_LOCK','design-complete-scene');const designStage=productionDomain(await designOnly.buildActionQueue()).stages.find(s=>s.id==='SHOT_PRODUCTION');assert.equal(designStage.count,0,'passing design/input does not claim any locked shot');assert.equal(designStage.denominator,3);
});
test('creator exit progress deduplicates the actual object and checks every current output plus rights gates',async()=>{
  const f=productionStageFixture();f.add('SHOT_LOCK','same-shot');f.add('SHOT_LOCK','same-shot',{blocked:true});
  f.add('SHOT_LOCK','released-shot');f.add('SHOT_LOCK','inactive-shot',{active:false});
  const stage=productionDomain(await f.buildActionQueue()).stages.find(s=>s.id==='SHOT_PRODUCTION');
  assert.equal(stage.count,1);assert.equal(stage.denominator,3);assert.equal(stage.denominatorState,'KNOWN');
});
test('missing, duplicated and wrong-scope exit definitions keep creator counts and denominators unknown',async()=>{
  for(const change of ['missing','duplicate','scope','unit']){
    const f=productionStageFixture(),model=f.snapshot.productionModel,gate=model.productionGates.find(g=>g.id==='EPISODE_TECH_QC');
    f.add('EPISODE_TECH_QC','permanent-episode');
    if(change==='missing')model.productionGates=model.productionGates.filter(g=>g!==gate);
    if(change==='duplicate')model.productionGates.push({...gate});
    if(change==='scope')gate.scopeType='PROJECT';
    if(change==='unit')gate.denominatorUnit='PROJECT';
    const stage=productionDomain(await f.buildActionQueue()).stages.find(s=>s.id==='EPISODE_EDIT');
    assert.equal(stage.count,null,change);assert.equal(stage.denominator,null,change);assert.equal(stage.denominatorState,'UNKNOWN',change);
  }
});
test('raw canonical phase counts and preparation discovery cannot establish creator-stage denominators',async()=>{
  const f=projectionFixture();for(const phase of f.snapshot.productionModel.productionPhases){phase.denominatorState='KNOWN';phase.denominator=142;phase.currentObjectCount=142;}
  f.snapshot.productionModel.shots=[{id:'legacy-shot',scopeRole:'EVIDENCE_ONLY'}];
  const stages=productionDomain(await f.buildActionQueue()).stages;
  assert.equal(stages.length,3);assert.ok(stages.every(s=>s.count===0&&s.denominator===null&&s.denominatorState==='UNKNOWN'));
});
test('current production requests preserve their exact canonical gate and prohibited capabilities after collapse',async()=>{
  const f=productionStageFixture(),work=f.add('STORYBOARD_DIALOGUE','shot-exact',{released:false});
  f.operations.executionRequests.current=[{executionRequestId:'request-prod',workItemId:work.id,executor:'CODEX',requestState:'CLAIMED',registeredOutputs:0,maxOutputs:1}];
  f.operations.runs.events=[{eventId:'run-prod',runId:'run-prod',executionRequestId:'request-prod',runState:'RUNNING',eventSequence:1,recordedAt:'2026-09-07T00:00:00.000Z'}];
  const queue=await f.buildActionQueue(),entry=queue.items.find(i=>i.requiredAction==='MONITOR_RUNNING');
  assert(entry);assert.equal(entry.productionGateId,'STORYBOARD_DIALOGUE');assert.equal(entry.productionPhaseId,'PREVIS');
  const collapsed=queue.workUnits.find(i=>i.workUnitKey===entry.workUnitKey);assert.equal(collapsed.productionGateId,'STORYBOARD_DIALOGUE');
  assert.equal(collapsed.permissions.canAuthorizeCodex,false);assert.equal(collapsed.permissions.canAuthorizeExternal,false);
  assert.equal(productionDomain(queue).stages.find(s=>s.id==='SHOT_PRODUCTION').status,'ACTIVE');
  assert.equal(productionDomain(queue).stages.some(s=>s.id==='SHOT_BREAKDOWN'||s.id==='SHOT_GENERATION'),false);
  assert.equal(productionDomain(queue).stages.find(s=>s.id==='SCENE_EDIT').status,'UNKNOWN');
  assert.equal(collapsed.productionPhaseId,'PREVIS');
});

function exactMaterialFixture(lifecycleState='IN_PROGRESS',runState='RUNNING') {
  const fixture=projectionFixture();
  fixture.snapshot.productionModel.materialRequirements=[{id:'required-exact',requirementClass:'REQUIRED',materialWorkItemRef:'material-exact',coverageSatisfied:false}];
  fixture.snapshot.productionModel.materialWorkItems=[{id:'material-exact',requirementRef:'required-exact',lifecycleState,flowBlockReasons:lifecycleState==='RIGHTS_HOLD'?['RIGHTS_BLOCKED']:[],executionBlockReasons:[]}];
  fixture.operations.stateProjection.materialWorkItemsById={'material-exact':{lifecycleState,flowBlockReasons:lifecycleState==='RIGHTS_HOLD'?['RIGHTS_BLOCKED']:[]}};
  if(runState){
    fixture.operations.executionRequests.current=[{executionRequestId:'request-exact',workItemId:'material-exact',executor:'CODEX',requestState:'CLAIMED',registeredOutputs:0,maxOutputs:1}];
    fixture.operations.runs.events=[{eventId:'run-event',runId:'run-exact',executionRequestId:'request-exact',runState,eventSequence:1,recordedAt:'2026-09-07T00:00:00.000Z'}];
  }
  return fixture;
}

test('all exact material run paths bind the same REQUIRED stage before work-unit collapse',async()=>{
  for(const [lifecycle,runState,action,stage] of [
    ['IN_PROGRESS','RUNNING','MONITOR_RUNNING','PRODUCTION_READY'],
    ['RESULT_PENDING_REGISTRATION','SUCCEEDED','REGISTER_CANDIDATE','PRODUCTION_READY'],
    ['EXECUTION_FAILED','FAILED','RESOLVE_EXECUTION_FAILURE','INITIAL'],
    ['RESULT_UNKNOWN','RESULT_UNKNOWN','INVESTIGATE_RESULT_UNKNOWN','INITIAL'],
  ]){
    const fixture=exactMaterialFixture(lifecycle,runState),before=JSON.stringify([fixture.snapshot,fixture.operations]);
    const queue=await fixture.buildActionQueue(),entry=queue.items.find(item=>item.requiredAction===action);
    assert(entry);assert.equal(entry.requirementId,'required-exact');assert.equal(entry.materialCreatorStage,stage);
    const collapsed=queue.workUnits.find(item=>item.workUnitKey===entry.workUnitKey);assert.equal(collapsed.requirementId,'required-exact');assert.equal(collapsed.materialCreatorStage,stage);
    assert.equal(entry.permissions.canAuthorizeCodex,false);assert.equal(entry.permissions.canAuthorizeExternal,false);
    assert.equal(JSON.stringify([fixture.snapshot,fixture.operations]),before);
  }
});

test('ready authorization task gains exact stage without changing its explicit permissions',async()=>{
  const fixture=exactMaterialFixture('READY_TO_START',null),work=fixture.snapshot.productionModel.materialWorkItems[0];
  work.outputAssetRef='family-exact';work.executionDefinitionRef='definition-exact';
  fixture.recipes.executionDefinitions=[{id:'definition-exact',definitionStatus:'DEFINED',definitionHash:'a'.repeat(64),output:{assetFamilyRef:'family-exact'},upload:{items:[]}}];
  fixture.operations.stateProjection.executionGatesByWorkItem={'material-exact':[]};
  const entry=(await fixture.buildActionQueue()).items.find(item=>item.requiredAction==='AUTHORIZE_GENERATION');
  assert(entry);assert.equal(entry.requirementId,'required-exact');assert.equal(entry.materialCreatorStage,'PRODUCTION_READY');
  assert.equal(entry.permissions.canAuthorizeCodex,true);assert.equal(entry.permissions.canAuthorizeExternal,true);
});

test('request with changed execution bindings remains prohibited but retains exact stage',async()=>{
  const fixture=exactMaterialFixture('READY_TO_START',null);
  fixture.operations.executionRequests.current=[{executionRequestId:'request-exact',workItemId:'material-exact',executor:'CODEX',requestState:'AUTHORIZED'}];
  const queue=await fixture.buildActionQueue(),entry=queue.items.find(item=>item.requiredAction==='RESOLVE_EXECUTION_BINDINGS');
  assert(entry);assert.equal(entry.requirementId,'required-exact');assert.equal(entry.materialCreatorStage,'PRODUCTION_READY');
  assert.equal(entry.permissions.canAuthorizeCodex,false);assert.equal(entry.permissions.canRegisterResult,false);
});

test('duplicate or contradictory material identities stay explicitly unbound after collapse',async()=>{
  for(const mutation of [
    fixture=>fixture.snapshot.productionModel.materialWorkItems.push({...fixture.snapshot.productionModel.materialWorkItems[0]}),
    fixture=>fixture.snapshot.productionModel.materialRequirements[0].materialWorkItemRef='different-permanent-work',
    fixture=>fixture.snapshot.productionModel.materialRequirements[0].requirementClass='EVIDENCE_ONLY',
  ]){
    const fixture=exactMaterialFixture();mutation(fixture);const queue=await fixture.buildActionQueue(),entry=queue.items.find(item=>item.requiredAction==='MONITOR_RUNNING');
    assert(entry);assert.equal(entry.materialCreatorStage,undefined);assert(entry.reasonCodes.some(code=>code.startsWith('MATERIAL_STAGE_BINDING_')));assert.match(entry.reasonText,/素材阶段未归属/);
    const collapsed=queue.workUnits.find(item=>item.workUnitKey===entry.workUnitKey);assert.equal(collapsed.materialCreatorStage,undefined);assert.match(collapsed.reasonText,/素材阶段未归属/);
  }
});

test('hard rights or unknown state creates a prohibited exception inside INITIAL, not a fifth stage',async()=>{
  for(const lifecycle of ['RIGHTS_HOLD','RESULT_UNKNOWN','EXECUTION_FAILED','UNKNOWN']){
    const fixture=exactMaterialFixture(lifecycle,null);
    // A recipe-authoring gate cannot hide a stronger rights/unknown-result fact.
    fixture.snapshot.productionModel.materialWorkItems[0].declaredExecutionGate='WAITING_EXECUTION_DEFINITION';
    const queue=await fixture.buildActionQueue(),entry=queue.items.find(item=>item.requiredAction==='RESOLVE_MATERIAL_BLOCKER');
    assert(entry);assert.equal(entry.workState,'BLOCKED');assert.equal(entry.materialCreatorStage,'INITIAL');assert.equal(entry.actor,'NONE');
    assert.equal(Object.values(entry.permissions).some(Boolean),false);assert.equal(queue.items.some(item=>item.requiredAction==='AUTHOR_EXECUTION_DEFINITION'),false);
    const domain=queue.workspaceSummary.domains.find(item=>item.id==='WORLD_AND_MATERIALS');
    assert.deepEqual(domain.stages.map(stage=>stage.id),['INITIAL','PRODUCTION_READY','PENDING_REVIEW','APPROVED']);assert.equal(domain.stages.reduce((sum,stage)=>sum+stage.count,0),1);
    const blocked=domain.metrics.find(metric=>metric.id==='BLOCKED');assert.equal(blocked.value,1);assert.equal(blocked.denominator,1);assert.equal(blocked.unit,'工作项');
  }
});

test('explicit hard rights evidence cannot expose authorization even if a generic ready projection disagrees',async()=>{
  const fixture=exactMaterialFixture('READY_TO_START',null),work=fixture.snapshot.productionModel.materialWorkItems[0];
  work.outputAssetRef='family-exact';work.executionDefinitionRef='definition-exact';
  fixture.recipes.executionDefinitions=[{id:'definition-exact',definitionStatus:'DEFINED',definitionHash:'a'.repeat(64),output:{assetFamilyRef:'family-exact'},upload:{items:[]}}];
  fixture.operations.stateProjection.materialWorkItemsById['material-exact'].flowBlockReasons=['RIGHTS_BLOCKED'];
  fixture.operations.stateProjection.executionGatesByWorkItem={'material-exact':[]};
  const queue=await fixture.buildActionQueue();assert(queue.items.some(item=>item.requiredAction==='RESOLVE_MATERIAL_BLOCKER'));
  assert.equal(queue.items.some(item=>item.requiredAction==='AUTHORIZE_GENERATION'),false);assert(queue.items.every(item=>!item.permissions.canAuthorizeCodex&&!item.permissions.canAuthorizeExternal));
});

test('ordinary missing definition keeps scoped authoring available but never generation permission',async()=>{
  const fixture=exactMaterialFixture('WAITING_UPSTREAM',null);fixture.snapshot.productionModel.materialWorkItems[0].declaredExecutionGate='WAITING_EXECUTION_DEFINITION';
  const entry=(await fixture.buildActionQueue()).items.find(item=>item.requiredAction==='AUTHOR_EXECUTION_DEFINITION');
  assert(entry);assert.equal(entry.actor,'CODEX');assert.equal(entry.materialCreatorStage,'INITIAL');assert.equal(Object.values(entry.permissions).some(Boolean),false);
});

test('material tasks and counters share exact REQUIRED identities and four creator stages', async () => {
  const fixture = projectionFixture();
  const model = fixture.snapshot.productionModel;
  model.materialRequirements = [
    {id:'need-definition',requirementClass:'REQUIRED',materialWorkItemRef:'work-definition',coverageSatisfied:false},
    {id:'need-stale',requirementClass:'REQUIRED',bindingStale:true,coverageSatisfied:false},
    {id:'need-ready',requirementClass:'REQUIRED',materialWorkItemRef:'work-ready',coverageSatisfied:false},
    {id:'need-approved',requirementClass:'REQUIRED',coverageSatisfied:true},
    {id:'need-history',requirementClass:'EVIDENCE_ONLY',coverageSatisfied:true},
  ];
  model.materialWorkItems = [
    {id:'work-definition',requirementRef:'need-definition',declaredExecutionGate:'WAITING_EXECUTION_DEFINITION',lifecycleState:'WAITING_UPSTREAM',flowBlockReasons:[],executionBlockReasons:[]},
    {id:'work-ready',requirementRef:'need-ready',lifecycleState:'READY_TO_START',flowBlockReasons:[],executionBlockReasons:[]},
  ];
  const before = JSON.stringify([fixture.snapshot,fixture.operations]);
  const queue = await fixture.buildActionQueue();
  const stages = queue.workspaceSummary.domains.find(entry=>entry.id==='WORLD_AND_MATERIALS').stages;
  assert.deepEqual(stages.map(stage=>[stage.id,stage.count,stage.denominator]),[
    ['INITIAL',2,4],['PRODUCTION_READY',1,4],['PENDING_REVIEW',0,4],['APPROVED',1,4],
  ]);
  const action=queue.items.find(entry=>entry.requirementId==='need-definition');
  assert.equal(action.materialCreatorStage,'INITIAL');
  assert.equal(action.requiredAction,'AUTHOR_EXECUTION_DEFINITION');
  assert.equal(queue.workUnits.find(entry=>entry.workUnitKey===action.workUnitKey).materialCreatorStage,'INITIAL');
  assert.equal(queue.items.some(entry=>entry.requirementId==='need-history'),false);
  assert.equal(JSON.stringify([fixture.snapshot,fixture.operations]),before);
});

test('empty instance has no invented authoring work, completion or locked story denominator', async () => {
  const fixture = projectionFixture();
  const before = JSON.stringify([fixture.snapshot, fixture.operations]);
  const queue = await fixture.buildActionQueue();
  assert.equal(queue.count, 0);
  assert.deepEqual(queue.items, []);
  assert.equal(queue.recommendations.mainline, null);
  for (const id of ['EPISODE_PLAN', 'STORY_CONFIRMATION']) {
    assert.equal(program(queue, id).status, 'WAITING');
    assert.equal(program(queue, id).totalCount, 0);
    assert.doesNotMatch(program(queue, id).summary, /均已有正式结论|已采用|已完成/);
  }
  const story = queue.workspaceSummary.domains.find((entry) => entry.id === 'STORY_CREATION');
  assert.equal(story.status, 'WAITING');
  assert.match(story.navigationIntent.href, /storyMode=source/);
  for (const value of [...story.metrics, ...story.stages]) {
    assert.equal(value.denominator, null);
    assert.equal(value.denominatorState, 'UNKNOWN');
  }
  assert.equal(queue.workspaceSummary.domains.find((entry) => entry.id === 'WORLD_AND_MATERIALS').currentGate, '尚未登记素材需求');
  const journey = await fixture.buildJourney('PROJECT', '');
  assert.equal(journey.summary.actionable, 0);
  assert.equal(journey.scopeDenominator.denominatorState, 'UNKNOWN');
  assert.equal(journey.globalDenominator.denominator, null);
  assert.equal(journey.phases.length, 5);
  assert.equal(journey.phases.every((phase) => phase.gates.length === 3), true);
  assert.equal(program(journey, 'STORY_CONFIRMATION').status, 'WAITING');
  assert.equal(JSON.stringify([fixture.snapshot, fixture.operations]), before);
});

test('scene records without verified plan basis do not claim autonomous plan authoring', async () => {
  const fixture = projectionFixture({ sceneCount: 1 });
  const queue = await fixture.buildActionQueue();
  assert.equal(queue.items.some((entry) => entry.requiredAction === 'AUTHOR_EPISODE_PLAN'), false);
  assert.equal(program(queue, 'EPISODE_PLAN').status, 'WAITING');
  assert.equal(program(queue, 'EPISODE_PLAN').actionableCount, 0);
  assert.equal(queue.items[0].requiredAction, 'WAIT_FOR_EPISODE_PLAN');
  assert.equal(queue.items[0].actionability, 'WAITING_DEPENDENCY');
});

test('47-scene proposal retains formal review and journey plan counts match the queue', async () => {
  const fixture = projectionFixture({ sceneCount: 47, basisCurrent: true });
  const queue = await fixture.buildActionQueue();
  const planAction = queue.items.find((entry) => entry.workstream === 'EPISODE_PLANNING');
  assert.equal(planAction.requiredAction, 'FORMAL_REVIEW');
  assert.equal(planAction.actor, 'USER');
  assert.equal(planAction.permissions.canSubmitReview, true);
  assert.equal(queue.items.filter((entry) => entry.requiredAction === 'WAIT_FOR_EPISODE_PLAN').length, 47);
  const journey = await fixture.buildJourney('PROJECT', '');
  for (const key of ['totalCount', 'openCount', 'actionableCount', 'nextActionKey']) {
    assert.equal(program(journey, 'EPISODE_PLAN')[key], program(queue, 'EPISODE_PLAN')[key]);
  }
  assert.equal(program(journey, 'EPISODE_PLAN').actionableCount, 1);
  const sceneJourney = await fixture.buildJourney('SCENE', 'S01');
  assert.equal(program(sceneJourney, 'EPISODE_PLAN').openCount, 0);
  assert.equal(program(sceneJourney, 'STORY_CONFIRMATION').openCount, 1);
  const episodeJourney = await fixture.buildJourney('EPISODE', 'episode-fixture');
  assert.equal(program(episodeJourney, 'STORY_CONFIRMATION').totalCount, 47);
  assert.equal(program(episodeJourney, 'STORY_CONFIRMATION').openCount, 47);
});

test('47 approved scenes under a synced current plan keep completion and fixed program totals', async () => {
  const fixture = projectionFixture({ sceneCount: 47, basisCurrent: true, ready: true, released: true });
  const queue = await fixture.buildActionQueue();
  assert.equal(program(queue, 'EPISODE_PLAN').status, 'COMPLETE');
  assert.equal(program(queue, 'STORY_CONFIRMATION').status, 'COMPLETE');
  assert.equal(program(queue, 'STORY_CONFIRMATION').totalCount, 47);
  assert.equal(program(queue, 'STORY_CONFIRMATION').openCount, 0);
  const journey = await fixture.buildJourney('PROJECT', '');
  assert.equal(program(journey, 'EPISODE_PLAN').totalCount, 1);
  assert.equal(program(journey, 'EPISODE_PLAN').openCount, 0);
  assert.equal(program(journey, 'STORY_CONFIRMATION').totalCount, 47);
  assert.equal(program(journey, 'STORY_CONFIRMATION').status, 'COMPLETE');
});
