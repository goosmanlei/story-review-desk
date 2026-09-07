// Creator navigation is a read-only grouping, never a replacement for frozen
// gate definitions, their real subject scope, prerequisites or review evidence.
const stageRows = [
  ['SHOT_BREAKDOWN', '镜头拆解', 'SCENE', '明确本场节拍、镜头意图和输入需要，再形成正式镜头计划。', ['SHOT_PLAN_INPUT_LOCK']],
  ['SHOT_GENERATION', '镜头生成', 'SCENE', '按镜头准备输入与 Prompt，完成分镜、对白、锁时及适用的镜头产出。', ['STORYBOARD_DIALOGUE', 'ANIMATIC_LOCK', 'KEYFRAMES', 'SHOT_VIDEO', 'SHOT_LOCK']],
  ['SCENE_EDIT', '场景剪辑', 'SCENE', '组合本场镜头，锁定画面后完成声音、字幕和场景检查。', ['PICTURE_LOCK', 'SOUND_MIX_SUBTITLES', 'SCENE_QA']],
  ['EPISODE_EDIT', '分集成片', 'EPISODE', '组装并审阅本集，在导出时核对相关连续性、权利、技术与归档要求。', ['EPISODE_ASSEMBLY', 'EPISODE_REVIEW', 'EPISODE_TECH_QC', 'SERIES_CONTINUITY', 'RIGHTS_SAFETY_TECH', 'DELIVERY_ARCHIVE']],
];
// Explicit canonical identities: PREVIS spans two creator stages, and export
// checks remain PROJECT-scoped even while displayed inside the episode workspace.
const gateRows = [
  ['SHOT_PLAN_INPUT_LOCK', 'SHOT_BREAKDOWN', 'PREVIS', 'SCENE'],
  ['STORYBOARD_DIALOGUE', 'SHOT_GENERATION', 'PREVIS', 'SHOT'],
  ['ANIMATIC_LOCK', 'SHOT_GENERATION', 'PREVIS', 'SCENE'],
  ['KEYFRAMES', 'SHOT_GENERATION', 'SHOT_FINISH', 'SHOT'],
  ['SHOT_VIDEO', 'SHOT_GENERATION', 'SHOT_FINISH', 'SHOT'],
  ['SHOT_LOCK', 'SHOT_GENERATION', 'SHOT_FINISH', 'SHOT'],
  ['PICTURE_LOCK', 'SCENE_EDIT', 'SCENE_FINISH', 'SCENE'],
  ['SOUND_MIX_SUBTITLES', 'SCENE_EDIT', 'SCENE_FINISH', 'SCENE'],
  ['SCENE_QA', 'SCENE_EDIT', 'SCENE_FINISH', 'SCENE'],
  ['EPISODE_ASSEMBLY', 'EPISODE_EDIT', 'EPISODE_FINISH', 'EPISODE'],
  ['EPISODE_REVIEW', 'EPISODE_EDIT', 'EPISODE_FINISH', 'EPISODE'],
  ['EPISODE_TECH_QC', 'EPISODE_EDIT', 'EPISODE_FINISH', 'EPISODE'],
  ['SERIES_CONTINUITY', 'EPISODE_EDIT', 'SERIES_DELIVERY', 'PROJECT'],
  ['RIGHTS_SAFETY_TECH', 'EPISODE_EDIT', 'SERIES_DELIVERY', 'PROJECT'],
  ['DELIVERY_ARCHIVE', 'EPISODE_EDIT', 'SERIES_DELIVERY', 'PROJECT'],
];
const gates = new Map(gateRows.map(([gateId, creatorStageId, phaseId, scopeType]) => [gateId, Object.freeze({
  gateId, creatorStageId, phaseId, scopeType,
  subarea: scopeType === 'PROJECT' ? 'EXPORT_CHECKS' : 'WORKSPACE',
})]));
export const CREATOR_PRODUCTION_STAGES = Object.freeze(stageRows.map(([id, label, scope, purpose, gateIds], index) => Object.freeze({
  id, label, scope, purpose, order: index + 1,
  gateIds: Object.freeze([...gateIds]), defaultGateId: gateIds[0],
  exportGateIds: Object.freeze(gateIds.filter(gateId => gates.get(gateId).subarea === 'EXPORT_CHECKS')),
})));
const stages = new Map(CREATOR_PRODUCTION_STAGES.map(stage => [stage.id, stage]));
export function creatorProductionGateDefinition(gateId) {
  return typeof gateId === 'string' ? gates.get(gateId) || null : null;
}
export function creatorProductionStageForGate(gateId) {
  return creatorProductionGateDefinition(gateId)?.creatorStageId || null;
}
export function creatorProductionStageDefinition(id) {
  return typeof id === 'string' ? stages.get(id) || null : null;
}
export function creatorProductionScopeForGate(gateId) {
  return creatorProductionGateDefinition(gateId)?.scopeType || null;
}
