// Shared, pure read projections. Published release bytes and source hashes are never rewritten.
export const phaseSpecs = [
  ['PREVIS', '镜头方案与预演', 'SCENE', 'LOCKED_AUDIOVISUAL_PLAN', '从当前正文和采用素材出发，完成镜头设计、对白并行与场级锁时。', [
    ['SHOT_PLAN_INPUT_LOCK', '镜头设计与输入锁定', 'SCENE', '先以场为单位完成镜头计划，再冻结每个镜头的剧本、空间坐标与采用素材版本。'],
    ['STORYBOARD_DIALOGUE', '粗分镜与对白并行', 'SHOT', '并行确认镜头结构和适用对白干声。'],
    ['ANIMATIC_LOCK', 'Animatic锁时', 'SCENE', '汇合粗分镜和锁定干声，形成场级时长基线。'],
  ]],
  ['SHOT_FINISH', '镜头成品', 'SHOT', 'LOCKED_SHOT', '完成每个当前镜头的关键帧、运动画面和最终锁镜版本。', [
    ['KEYFRAMES', '正式首尾帧', 'SHOT', '分别审阅首帧与尾帧。'],
    ['SHOT_VIDEO', '镜头视频', 'SHOT', '按锁定关键帧和分支生成运动画面。'],
    ['SHOT_LOCK', '单镜锁定', 'SHOT', '所有镜头都必须形成最终锁镜版本；口型仅是条件分支。'],
  ]],
  ['SCENE_FINISH', '场景成片', 'SCENE', 'LOCKED_SCENE', '将已锁镜头剪成场，先锁画面，再完成声音、字幕和场级QA。', [
    ['PICTURE_LOCK', '场剪辑与画面锁定', 'SCENE', '登记场剪辑母版、EDL与连续性检查，先锁画面再进入同步声音。'],
    ['SOUND_MIX_SUBTITLES', '场声音与混音字幕', 'SCENE', '按锁定画面完成声音后期、混音与字幕。'],
    ['SCENE_QA', '场级QA', 'SCENE', '对锁定画面、声音、字幕和连续性形成独立场级结论。'],
  ]],
  ['EPISODE_FINISH', '分集成片', 'EPISODE', 'EPISODE_MASTER', '只对正式分集对象完成组装、审阅和技术QC。', [
    ['EPISODE_ASSEMBLY', '分集组装', 'EPISODE', '按当前已确认分集方案与完整剧本发布快照组装已放行场景。'],
    ['EPISODE_REVIEW', '分集审阅', 'EPISODE', '对每个正式分集对象形成独立审阅结论。'],
    ['EPISODE_TECH_QC', '分集技术QC', 'EPISODE', '按发行配置完成技术检查；配置未确认时保持UNKNOWN。'],
  ]],
  ['SERIES_DELIVERY', '全剧交付', 'PROJECT', 'SERIES_DELIVERY_PACKAGE', '完成跨集连续性、终检以及可追溯的全剧交付归档。', [
    ['SERIES_CONTINUITY', '跨集连续性', 'PROJECT', '核对跨集剧情、人物、空间、物证和版本血缘。'],
    ['RIGHTS_SAFETY_TECH', '权利敏感技术终检', 'PROJECT', '汇总权利事实、敏感内容与技术门禁；未核实事实继续保持UNKNOWN。'],
    ['DELIVERY_ARCHIVE', '交付归档', 'PROJECT', '形成交付清单、哈希和审计归档。'],
  ]],
];

export const blankModelArrayKeys = Object.freeze(['workflowSteps','continuityGroups','stageDefinitions','episodes','scenes','segments','beats','shots','reviewContexts','structureCards','workItems','workPackages','materialRequirements','materialWorkItems','stageInstances','productionReferences','deletionTombstones','assetRetirementEvents','assetFamilies','assetVersions','expectedOutputs','dependencyEdges','issues','storyRevisions','scriptRevisions','sceneScriptRevisions','episodePlanRevisions','sceneCoveragePlanRevisions','screenplayReleaseSnapshots','scopeLocks','shotPlanSetRevisions']);

const slug = (id) => id.toLowerCase().replaceAll('_', '-');
function unknownProgress() {
  return { denominatorState: 'UNKNOWN', denominator: null, globalDenominatorState: 'UNKNOWN', globalDenominator: null, discoveredCount: 0, currentObjectCount: 0, currentWorkPackageCount: 0, currentWorkItemCount: 0, releasedWorkPackageCount: 0, releasedObjectCount: 0, completionState: 'UNKNOWN', lifecycleRollup: {}, flowBlockReasons: [] };
}

export function blankProductionGraph() {
  const productionPhases = phaseSpecs.map(([id, label, exitScopeType, exitObjectType, purpose, gates], index) => ({
    id, slug: slug(id), order: index + 1, label, purpose, gateIds: gates.map(([gateId]) => gateId),
    entryGateId: gates[0][0], exitGateId: gates.at(-1)[0], exitScopeType, exitObjectType, denominatorUnit: exitScopeType,
    ...unknownProgress(), scopeRole: 'CURRENT', activityRole: 'PRODUCTION_PHASE_DEFINITION', countsTowardCurrent: false,
  }));
  const productionGates = phaseSpecs.flatMap(([phaseId, , , , , gates]) => gates.map(([id, label, scopeType, purpose], index) => ({
    id, slug: slug(id), phaseId, order: index + 1, label, scopeType, purpose, denominatorUnit: scopeType,
    ...unknownProgress(), scopeRole: 'CURRENT', activityRole: 'PRODUCTION_GATE_DEFINITION', countsTowardCurrent: false,
  })));
  return { productionPhases, productionGates };
}

function legacyProductionGraph() {
  const productionPhases = phaseSpecs.map(([, label, , , , gates], index) => {
    const number = String(index + 1).padStart(2, '0');
    return { id: `phase-${number}`, label, title: label, gates: gates.map(([, label], index) => ({ id: `gate-${number}-${index + 1}`, label })) };
  });
  return { productionPhases, productionGates: productionPhases.flatMap((phase) => phase.gates) };
}

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const emptyArray = (value) => Array.isArray(value) && value.length === 0;
const emptyRecord = (value) => isRecord(value) && Object.keys(value).length === 0;
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  return isRecord(left) && isRecord(right) && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

// Configuration publication adds only these two model fields and the configured
// source-order labels to an otherwise exact blank. Peel that verified projection
// for recognition only; callers retain the published configuration and all bytes.
function blankConfigurationBasis(snapshot) {
  const model = snapshot?.productionModel;
  if (!isRecord(model)) return snapshot;
  if (!Object.hasOwn(model, 'systemConfiguration') && !Object.hasOwn(model, 'configurationCandidates')) return snapshot;
  const projection = model.systemConfiguration;
  if (Object.hasOwn(model, 'configurationCandidates') && !emptyArray(model.configurationCandidates)
    || !exactKeys(projection, ['reference','config','defaults'])
    || !exactKeys(projection.reference, ['revisionId','sha256'])
    || typeof projection.reference.revisionId !== 'string' || !projection.reference.revisionId
    || typeof projection.reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(projection.reference.sha256)
    || !sameJson(projection.reference, snapshot.instance?.configurationRef)) return null;
  const configKeys = ['schemaVersion','template','presentation','sources','technical','taxonomy','workflow','reviewProfiles','collaboration'];
  for (const config of [projection.config, projection.defaults]) {
    if (!['1.0','2.0'].includes(config?.schemaVersion)
      || !exactKeys(config, [...configKeys, ...(config.schemaVersion === '2.0' ? ['domain'] : [])])
      || !configKeys.filter((key) => !['schemaVersion','reviewProfiles'].includes(key)).every((key) => isRecord(config[key]))
      || !Array.isArray(config.reviewProfiles)
      || config.schemaVersion === '2.0' && !isRecord(config.domain)) return null;
  }
  const order = projection.config.sources.order;
  if (!Array.isArray(order) || !order.length
    || order.some((row) => !exactKeys(row, ['id','label','role'])
      || typeof row.id !== 'string' || !row.id || typeof row.label !== 'string' || !row.label
      || !['PRIMARY','DERIVED','AUXILIARY'].includes(row.role))
    || new Set(order.map((row) => row.id)).size !== order.length
    || !sameJson(snapshot.storySources?.evidenceOrder, order.map((row) => row.label))) return null;
  const businessModel = { ...model };
  delete businessModel.systemConfiguration;
  delete businessModel.configurationCandidates;
  return { ...snapshot, productionModel: businessModel, storySources: { ...snapshot.storySources, evidenceOrder: [] } };
}

// This compatibility exception is deliberately narrower than "zero current scenes".
// A populated, damaged or unfamiliar snapshot must never be reinterpreted as a blank template.
function hasKnownEmptyBusinessShape(snapshot) {
  snapshot = blankConfigurationBasis(snapshot);
  const model = snapshot?.productionModel;
  const lineage = snapshot?.creativeLineage;
  const recipes = snapshot?.executionRecipeSummary;
  return snapshot?.schemaVersion === '8.7'
    && exactKeys(snapshot, ['schemaVersion','snapshotId','snapshotDate','instance','scope','sources','sourceHashes','coverage','unknowns','statusModel','storySources','adaptationAudit','storyRewrite','characterPerformance','actionQueueInputs','creativeLineage','productionModel','executionRecipeSummary','workItems','visualAssets','audioAssets','shots','p07','outputArtifacts'])
    && sameJson(snapshot.statusModel, { version: '2.0' })
    && exactKeys(snapshot.scope, ['storyScenes','episodeCount','formalEpisodeDenominatorState','formalEpisodeDenominator'])
    && snapshot?.scope?.storyScenes === 0
    && snapshot?.scope?.episodeCount === null
    && snapshot?.scope?.formalEpisodeDenominatorState === 'UNKNOWN'
    && snapshot?.scope?.formalEpisodeDenominator === null
    && snapshot?.instance?.capabilities?.instanceAuthoring === 'DATABASE_DOCUMENTS'
    && exactKeys(model, ['schemaVersion','instance',...blankModelArrayKeys,'productionPhases','productionGates','policy','counts','reviewContextCatalog','systemModel','revisionPointers'])
    && model.schemaVersion === '8.7' && sameJson(model.instance, snapshot.instance) && blankModelArrayKeys.every((key) => emptyArray(model[key]))
    && ['policy','counts','reviewContextCatalog','systemModel','revisionPointers'].every((key) => emptyRecord(model[key]))
    && ['sources','sourceHashes','coverage','storyRewrite','characterPerformance'].every((key) => emptyRecord(snapshot[key]))
    && ['unknowns','workItems','visualAssets','audioAssets','shots','outputArtifacts'].every((key) => emptyArray(snapshot[key]))
    && exactKeys(lineage, ['scenes','episodes','phases','causalChains','spatialEvidence','globalBaselineAssetRefs','scriptDocument','storyStructure','storyOverview','coverage'])
    && ['scenes','episodes','phases','causalChains','globalBaselineAssetRefs'].every((key) => emptyArray(lineage[key]))
    && lineage.storyOverview === null && emptyRecord(lineage.coverage)
    && sameJson(lineage.scriptDocument, { rawMarkdown: '', blocks: [] })
    && exactKeys(snapshot.storySources, ['evidenceOrder','audio','transcript','outline']) && emptyArray(snapshot.storySources.evidenceOrder) && snapshot.storySources.audio === null
    && sameJson(snapshot.storySources.transcript, { sections: [], segments: [], introBlocks: [], rawMarkdown: '' })
    && sameJson(snapshot.storySources.outline, { blocks: [], rawMarkdown: '' })
    && sameJson(snapshot.adaptationAudit, { beats: [], canonicalStories: [], setupPayoffChains: [], sceneAudits: [], asrIssues: [], productionImpacts: [] })
    && sameJson(snapshot.actionQueueInputs, { rewrittenSceneConfirmations: [], sceneReviewDossiers: [], audioVerifications: [], materialPreparation: [] })
    && sameJson(snapshot.p07, { storyboards: [], scenes: [], contactSheets: [] })
    && exactKeys(recipes, ['schemaVersion','snapshotId','counts','executionDocuments','executionDefinitions','evidenceOnlyDefinitions','promptRevisions','sceneTimelines','postProductionTasks','sourceCatalog','integrity'])
    && recipes.schemaVersion === '8.7' && recipes.snapshotId === snapshot.snapshotId
    && ['executionDocuments','executionDefinitions','evidenceOnlyDefinitions','promptRevisions','sceneTimelines','postProductionTasks','sourceCatalog'].every((key) => emptyArray(recipes[key]))
    && emptyRecord(recipes.counts) && emptyRecord(recipes.integrity);
}

export function isLegacyBlankSnapshot(snapshot) {
  const graph = legacyProductionGraph();
  return hasKnownEmptyBusinessShape(snapshot)
    && emptyRecord(snapshot.creativeLineage.storyStructure) && emptyArray(snapshot.creativeLineage.spatialEvidence)
    && sameJson(snapshot.productionModel.productionPhases, graph.productionPhases)
    && sameJson(snapshot.productionModel.productionGates, graph.productionGates);
}

function recordOrMissing(value, name) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function withArrays(value, keys, name) {
  const source = recordOrMissing(value, name);
  let result = source;
  for (const key of keys) {
    if (source[key] === undefined) result = { ...result, [key]: [] };
    else if (!Array.isArray(source[key])) throw new TypeError(`${name}.${key} must be an array`);
  }
  return result;
}

function withChildren(source, children) {
  return Object.entries(children).every(([key, value]) => source[key] === value) ? source : { ...source, ...children };
}

export function normalizeReviewSnapshot(snapshot) {
  const source = recordOrMissing(snapshot, 'snapshot');
  const legacyBlank = isLegacyBlankSnapshot(source);
  let model = withArrays(source.productionModel, ['productionPhases','productionGates'], 'productionModel');
  const hasRetiredIds = [...model.productionPhases, ...model.productionGates]
    .some((item) => /^phase-|^gate-/.test(String(item?.id || '')));
  if (hasRetiredIds && !legacyBlank) throw new TypeError('Unrecognized legacy blank production graph');
  if (legacyBlank) model = { ...model, ...blankProductionGraph() };
  const lineage = withArrays(source.creativeLineage, ['scenes','episodes','causalChains'], 'creativeLineage');
  const storySources = recordOrMissing(source.storySources, 'storySources');
  return withChildren(source, {
    productionModel: withArrays(model, ['assetFamilies','assetVersions','materialRequirements','structureCards','shots','issues','workItems','workPackages'], 'productionModel'),
    creativeLineage: withChildren(lineage, {
      storyStructure: withArrays(lineage.storyStructure, ['sequences'], 'creativeLineage.storyStructure'),
      spatialEvidence: withArrays(legacyBlank ? undefined : lineage.spatialEvidence, ['mapCards','locations','locationPackages','sceneRouteLocks'], 'creativeLineage.spatialEvidence'),
    }),
    storySources: withChildren(storySources, {
      transcript: withArrays(storySources.transcript, ['segments'], 'storySources.transcript'),
      outline: withArrays(storySources.outline, ['blocks'], 'storySources.outline'),
    }),
    adaptationAudit: withArrays(source.adaptationAudit, ['beats','productionImpacts'], 'adaptationAudit'),
  });
}

// Only known empty templates accept the retired input aliases. Responses always use canonical IDs.
export function normalizeEmptyProductionFilters(snapshot, filters) {
  const graph = blankProductionGraph();
  if (!hasKnownEmptyBusinessShape(snapshot)
    || !sameJson(snapshot.creativeLineage.storyStructure, { sequences: [] })
    || !sameJson(snapshot.creativeLineage.spatialEvidence, { mapCards: [], locations: [], locationPackages: [], sceneRouteLocks: [] })
    || !sameJson(snapshot.productionModel.productionPhases, graph.productionPhases)
    || !sameJson(snapshot.productionModel.productionGates, graph.productionGates)) return filters;
  const aliases = legacyProductionGraph();
  const phaseIndex = aliases.productionPhases.findIndex((phase) => phase.id === filters.phaseId);
  const gateIndex = aliases.productionGates.findIndex((gate) => gate.id === filters.gateId);
  return { ...filters, phaseId: phaseIndex < 0 ? filters.phaseId : graph.productionPhases[phaseIndex].id, gateId: gateIndex < 0 ? filters.gateId : graph.productionGates[gateIndex].id };
}
