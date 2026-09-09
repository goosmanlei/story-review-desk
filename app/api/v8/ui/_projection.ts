import {currentMaterialRequirementRows} from '../../../../host/instance-runtime/material-requirement-disposition.mjs';
type ProductionRecord = Record<string, unknown> & {
  shots?: Array<Record<string, unknown> & { id: string; sceneId?: string; episodeId?: string; workPackageRefs?: string[]; issueRefs?: string[] }>;
  workPackages?: Array<Record<string, unknown> & { id: string; workItemRefs?: string[] }>;
  workItems?: Array<Record<string, unknown> & { id: string; outputAssetRef?: string | null; inputAssetRefs?: string[] }>;
  materialRequirements?: Array<Record<string, unknown> & { id: string; requirementClass?: string }>;
  materialWorkItems?: Array<Record<string, unknown> & { id: string }>;
  structureCards?: Array<Record<string, unknown> & { id: string; sceneId?: string }>;
  assetFamilies?: Array<Record<string, unknown> & { id: string; versionRefs?: string[] }>;
  assetVersions?: Array<Record<string, unknown> & { id: string }>;
  episodes?: Array<Record<string, unknown> & { id: string }>;
  scenes?: Array<Record<string, unknown> & { id: string }>;
  segments?: Array<Record<string, unknown> & { sceneId?: string }>;
  beats?: Array<Record<string, unknown> & { sceneId?: string }>;
  issues?: Array<Record<string, unknown> & { id: string }>;
  reviewContextCatalog?: Record<string, unknown>;
  reviewContexts?: Array<Record<string, unknown> & { id: string }>;
  expectedOutputs?: Array<Record<string, unknown> & { id: string; familyId?: string }>;
};

export function compactProductionModel(model: ProductionRecord) {
  return {
    ...model,
    stageInstances: undefined,
    dependencyEdges: undefined,
    reviewContextCatalog: model.reviewContextCatalog ? {
      ...model.reviewContextCatalog,
      evidenceCatalog: undefined,
    } : undefined,
  };
}

export function productionBootstrapSeed(model: ProductionRecord) {
  const firstSceneId = (model.scenes ?? [])[0]?.id;
  const preferredScenes = new Set(firstSceneId ? [firstSceneId] : []);
  const shots = (model.shots ?? []).filter((shot, index, all) => preferredScenes.has(shot.sceneId ?? '') && all.findIndex((item) => item.sceneId === shot.sceneId) === index);
  const packageIds = new Set(shots.flatMap((shot) => (shot.workPackageRefs ?? []).slice(0, 1)));
  const workPackages = (model.workPackages ?? []).filter((item) => packageIds.has(item.id));
  const workItemIds = new Set(workPackages.flatMap((item) => item.workItemRefs ?? []));
  const workItems = (model.workItems ?? []).filter((item) => workItemIds.has(item.id));
  const familyIds = new Set(workItems.flatMap((item) => [...(item.outputAssetRef ? [item.outputAssetRef] : []), ...(item.inputAssetRefs ?? [])]));
  const assetFamilies = (model.assetFamilies ?? []).filter((item) => familyIds.has(item.id));
  const versionIds = new Set(assetFamilies.flatMap((item) => item.versionRefs ?? []));
  const expectedOutputIds = new Set(assetFamilies.flatMap((item) => (
    Array.isArray(item.expectedOutputRefs) ? item.expectedOutputRefs.map(String) : []
  )));
  const reviewContextIds = new Set([
    ...workPackages.map((item) => item.reviewContextRef),
    ...workItems.map((item) => item.reviewContextRef),
  ].filter((id): id is string => typeof id === 'string' && Boolean(id)));
  const issueIds = new Set(shots.flatMap((item) => item.issueRefs ?? []));
  const summaryEntity = (item: Record<string, unknown>) => ({
    id: item.id,
    number: item.number,
    title: item.title,
    label: item.label,
    episodeId: item.episodeId,
    episodeUid: item.episodeUid,
    displayId: item.displayId,
    canonicalScopeId: item.canonicalScopeId,
    sceneIds: item.sceneIds,
    shotIds: item.shotIds,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    scopeRole: item.scopeRole,
    storyHandoff: item.storyHandoff,
    lifecycleState: item.lifecycleState,
    canFlowDownstream: item.canFlowDownstream,
    flowBlockReasons: item.flowBlockReasons,
  });
  const summaryRevision = (item: Record<string, unknown>) => ({
    id: item.id,
    revisionId: item.revisionId,
    snapshotId: item.snapshotId,
    planId: item.planId,
    title: item.title,
    status: item.status,
    revisionState: item.revisionState,
    releaseState: item.releaseState,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    scopeRole: item.scopeRole,
    isCurrent: item.isCurrent,
    isCurrentProposal: item.isCurrentProposal,
    lockState: item.lockState,
    scopeLockState: item.scopeLockState,
    denominatorState: item.denominatorState,
    denominator: item.denominator,
    discoveredCount: item.discoveredCount,
    episodePlanRevisionId: item.episodePlanRevisionId,
    sceneScriptRevisionIds: item.sceneScriptRevisionIds,
    episodes: item.episodes,
    retiredEpisodeUids: item.retiredEpisodeUids,
    shotIds: item.shotIds,
    basisBindings: item.basisBindings,
    sourcePath: item.sourcePath,
    sourceSha256: item.sourceSha256,
    contentHash: item.contentHash,
    revisionHash: item.revisionHash,
    snapshotHash: item.snapshotHash,
    review: item.review,
    reviewSpec:item.reviewSpec,
    configurationBinding:item.configurationBinding,
    sync: item.sync,
    storyHandoff: item.storyHandoff,
  });
  const revisionKeys = [
    'storyRevisions',
    'scriptRevisions',
    'sceneScriptRevisions',
    'episodePlanRevisions',
    'sceneCoveragePlanRevisions',
    'screenplayReleaseSnapshots',
    'scopeLocks',
    'shotPlanSetRevisions',
  ];
  const revisionSummaries = Object.fromEntries(revisionKeys.map((key) => [
    key,
    Array.isArray(model[key]) ? (model[key] as Record<string, unknown>[]).map(summaryRevision) : [],
  ]));
  const recipeSummary = model.executionRecipeSummary && typeof model.executionRecipeSummary === 'object' && !Array.isArray(model.executionRecipeSummary)
    ? model.executionRecipeSummary as Record<string, unknown>
    : null;
  return {
    instance: model.instance,
    genericAuthoring: model.genericAuthoring ? { enabled: true } : undefined,
    systemConfiguration:model.systemConfiguration,
    configurationCandidates:model.configurationCandidates,
    schemaVersion: model.schemaVersion,
    bootstrapMode: 'SUMMARY_ONLY',
    policy: model.policy,
    productionPhases: model.productionPhases ?? [],
    productionGates: model.productionGates ?? [],
    productionGraph: model.productionGraph,
    workflowSteps: model.workflowSteps ?? [],
    stageDefinitions: model.stageDefinitions ?? [],
    episodes: (model.episodes ?? []).map(summaryEntity),
    scenes: (model.scenes ?? []).map(summaryEntity),
    shots,
    workPackages,
    workItems,
    materialRequirements: [],
    materialWorkItems: [],
    structureCards: [],
    assetFamilies,
    assetVersions: (model.assetVersions ?? []).filter((item) => versionIds.has(item.id)),
    expectedOutputs: (model.expectedOutputs ?? []).filter((item) => expectedOutputIds.has(item.id)),
    reviewContexts: (model.reviewContexts ?? []).filter((item) => reviewContextIds.has(item.id)),
    segments: [],
    beats: [],
    issues: (model.issues ?? []).filter((item) => issueIds.has(item.id)),
    counts: {
      ...((model.counts ?? {}) as Record<string, unknown>),
      requiredMaterialRequirements: currentMaterialRequirementRows(model,{atomicOnly:true}).length,
    },
    systemModel: model.systemModel,
    executionRecipeSummary: recipeSummary ? {
      schemaVersion: recipeSummary.schemaVersion,
      snapshotId: recipeSummary.snapshotId,
      counts: recipeSummary.counts,
      executionDocuments: recipeSummary.executionDocuments,
      integrity: recipeSummary.integrity,
      recipeApi: recipeSummary.recipeApi,
      summaryOnly: true,
    } : undefined,
    revisionPointers: model.revisionPointers,
    ...revisionSummaries,
  };
}
