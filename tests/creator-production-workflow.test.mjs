import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CREATOR_PRODUCTION_STAGES,creatorProductionGateDefinition,creatorProductionStageForGate,creatorProductionStageDefinition,creatorProductionScopeForGate,resolveCreatorProductionStage} from '../host/instance-runtime/creator-production-workflow.mjs';
import {phaseSpecs,blankProductionGraph} from '../host/instance-runtime/snapshot-contract.mjs';
import {workflowOverview} from '../host/instance-runtime/workflow-overview.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stageIds=['SHOT_PRODUCTION','SCENE_EDIT','EPISODE_EDIT'];
test('three creator modules are a total, disjoint grouping of the unchanged fifteen canonical gates',()=>{
  assert.deepEqual(CREATOR_PRODUCTION_STAGES.map(s=>s.id),stageIds);
  assert.deepEqual(CREATOR_PRODUCTION_STAGES.map(s=>s.label),['镜头制作','场景剪辑','分集成片']);
  const ids=CREATOR_PRODUCTION_STAGES.flatMap(s=>s.gateIds);
  assert.equal(ids.length,15);assert.equal(new Set(ids).size,15);
  const original=hash(phaseSpecs);
  for(const [phaseId,,,,,gates] of phaseSpecs)for(const [gateId,,scopeType] of gates){
    const gate=creatorProductionGateDefinition(gateId);
    assert.equal(gate.phaseId,phaseId);assert.equal(gate.scopeType,scopeType);
    assert.equal(creatorProductionScopeForGate(gateId),scopeType);
    assert.equal(creatorProductionStageForGate(gateId),gate.creatorStageId);
    assert.ok(creatorProductionStageDefinition(gate.creatorStageId).gateIds.includes(gateId));
  }
  assert.equal(phaseSpecs.length,5);assert.equal(hash(phaseSpecs),original);
});
test('shot production joins by exact gate, not by phase or gate label',()=>{
  assert.equal(creatorProductionStageForGate('SHOT_PLAN_INPUT_LOCK'),'SHOT_PRODUCTION');
  for(const id of ['STORYBOARD_DIALOGUE','ANIMATIC_LOCK','KEYFRAMES','SHOT_VIDEO','SHOT_LOCK'])assert.equal(creatorProductionStageForGate(id),'SHOT_PRODUCTION');
  assert.equal(creatorProductionStageForGate('PREVIS'),null);
  assert.equal(creatorProductionScopeForGate('STORYBOARD_DIALOGUE'),'SHOT');
  assert.equal(creatorProductionStageDefinition('SHOT_PRODUCTION').scope,'SCENE');
});
test('project export checks are grouped with episode editing but retain PROJECT identity',()=>{
  const stage=creatorProductionStageDefinition('EPISODE_EDIT');
  assert.equal(stage.scope,'EPISODE');
  assert.deepEqual(stage.exportGateIds,['SERIES_CONTINUITY','RIGHTS_SAFETY_TECH','DELIVERY_ARCHIVE']);
  for(const id of stage.exportGateIds)assert.deepEqual(creatorProductionGateDefinition(id),{gateId:id,creatorStageId:'EPISODE_EDIT',phaseId:'SERIES_DELIVERY',scopeType:'PROJECT',subarea:'EXPORT_CHECKS'});
  assert.equal(creatorProductionGateDefinition('EPISODE_TECH_QC').subarea,'WORKSPACE');
});
test('stage progress exits never use the project export gate as an episode denominator',()=>{
  assert.deepEqual(CREATOR_PRODUCTION_STAGES.map(stage=>stage.gateIds.filter(id=>!stage.exportGateIds.includes(id)).at(-1)),['SHOT_LOCK','SCENE_QA','EPISODE_TECH_QC']);
  assert.deepEqual(CREATOR_PRODUCTION_STAGES.map(stage=>stage.defaultGateId),['SHOT_PLAN_INPUT_LOCK','PICTURE_LOCK','EPISODE_ASSEMBLY']);
});
test('unknown IDs, aliases and coercion objects never infer a stage or scope',()=>{
  for(const id of ['',null,undefined,0,'shot-lock','SHOT_LOCK ','单镜锁定','P12','__proto__',{toString:()=> 'SHOT_LOCK'}]){
    assert.equal(creatorProductionGateDefinition(id),null);assert.equal(creatorProductionStageForGate(id),null);assert.equal(creatorProductionScopeForGate(id),null);assert.equal(creatorProductionStageDefinition(id),null);
  }
});
test('all shared stage and gate values are deeply immutable',()=>{
  assert.throws(()=>CREATOR_PRODUCTION_STAGES.push({}),TypeError);
  for(const stage of CREATOR_PRODUCTION_STAGES){assert.throws(()=>stage.label='changed',TypeError);assert.throws(()=>stage.gateIds.push('FAKE'),TypeError);assert.throws(()=>stage.exportGateIds.push('FAKE'),TypeError);}
  assert.throws(()=>creatorProductionGateDefinition('SHOT_LOCK').scopeType='PROJECT',TypeError);
});
test('host overview has exactly three production nodes and retains original configuration bytes',()=>{
  const graph=blankProductionGraph(),model={systemConfiguration:{config:{workflow:{phases:graph.productionPhases,gates:graph.productionGates}}}},before=hash(model);
  model.systemConfiguration.config.workflow.gates[0].label='实例自定义检查名称';
  const frozen=hash(model),projection=workflowOverview(model,null);
  assert.deepEqual(projection.nodes.filter(n=>n.group==='全剧制作').map(n=>n.id),stageIds);
  assert.equal(projection.nodes.some(n=>n.id==='PREPARATION'||n.id==='SERIES_DELIVERY'),false);
  assert.equal(projection.definition.phases,model.systemConfiguration.config.workflow.phases);assert.equal(projection.definition.gates,model.systemConfiguration.config.workflow.gates);
  assert.equal(projection.definition.gates[0].label,'实例自定义检查名称');assert.equal(hash(model),frozen);assert.notEqual(frozen,before);
  assert.equal(projection.denominatorState,'UNKNOWN');assert.ok(projection.nodes.filter(n=>n.group==='全剧制作').every(n=>n.definitionState==='DEFINED'));
  const ids=new Set(projection.nodes.map(n=>n.id));for(const edge of projection.edges){assert.ok(ids.has(edge.from));assert.ok(ids.has(edge.to));}
});
test('candidate preparation stays a separate task reference under shot breakdown, never a denominator',()=>{
  const content={scenes:[{sceneId:'permanent-scene',preparation:{generationAuthorized:false,formalShotIds:[]}}]},prep={revisionId:'preparation-revision',content,stale:false},before=hash(prep);
  const result=workflowOverview(blankProductionGraph(),prep);
  assert.equal(result.preparationWork.sceneCount,1);assert.match(result.preparationWork.href,/creatorStage=shot-production/);
  assert.deepEqual(result.preparationWork.capabilities,['人可推进','AI可辅助']);assert.match(result.preparationWork.boundary,/不构成正式审阅、生成授权或镜头制作分母/);
  assert.equal(result.denominatorState,'UNKNOWN');assert.equal(hash(prep),before);
  const stale=workflowOverview(blankProductionGraph(),{...prep,stale:true});assert.equal(stale.preparationWork.status,'BLOCKED');assert.deepEqual(stale.preparationWork.capabilities,[]);
});
test('missing or contradictory canonical definitions remain visibly incomplete',()=>{
  const graph=blankProductionGraph();graph.productionGates.find(g=>g.id==='STORYBOARD_DIALOGUE').scopeType='SCENE';
  graph.productionGates=graph.productionGates.filter(g=>g.id!=='DELIVERY_ARCHIVE');
  const projection=workflowOverview(graph,null);
  assert.deepEqual(projection.nodes.find(n=>n.id==='SHOT_PRODUCTION').missingGateIds,['STORYBOARD_DIALOGUE']);
  assert.deepEqual(projection.nodes.find(n=>n.id==='EPISODE_EDIT').missingGateIds,['DELIVERY_ARCHIVE']);
  assert.equal(projection.nodes.find(n=>n.id==='SHOT_PRODUCTION').definitionState,'INCOMPLETE');
  const empty=workflowOverview({},null);assert.equal(empty.definition.gates.length,0);assert.ok(empty.nodes.filter(n=>n.group==='全剧制作').every(n=>n.definitionState==='INCOMPLETE'));
});

test('legacy stage URLs preserve their exact entry while new navigation uses one module',()=>{
 assert.deepEqual(resolveCreatorProductionStage('shot-breakdown'),{stageId:'SHOT_PRODUCTION',defaultGateId:'SHOT_PLAN_INPUT_LOCK'});
 assert.deepEqual(resolveCreatorProductionStage('shot-generation'),{stageId:'SHOT_PRODUCTION',defaultGateId:'STORYBOARD_DIALOGUE'});
 assert.deepEqual(resolveCreatorProductionStage('shot-production'),{stageId:'SHOT_PRODUCTION',defaultGateId:'SHOT_PLAN_INPUT_LOCK'});
 for(const invalid of ['shot-generation ',{},null,'P07'])assert.equal(resolveCreatorProductionStage(invalid),null);
 assert.equal(creatorProductionStageDefinition('SHOT_GENERATION'),null);
});
