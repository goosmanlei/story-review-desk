import { randomUUID } from 'node:crypto';
import { blankModelArrayKeys, blankProductionGraph } from './snapshot-contract.mjs';

export function blankProfile({ title = '新故事', instanceId = `instance_${randomUUID()}`, projectId = `story_${randomUUID()}`, episodePlanId = `episode-plan_${randomUUID()}` } = {}) {
  return {
    schemaVersion: '1.0', instanceId, projectId, episodePlanId, title: `${title} · 审阅台`, storyTitle: title, locale: 'zh-CN',
    branding: { mark: '阅', title: `${title} · 审阅台`, description: '故事创作、素材审阅与全剧制作。' },
    assistant: { scopeKey: `local:${projectId}`, schedulerProtocol: 'REVIEW_CODEX_SCHEDULER_V1', conversationHashNamespace: 'REVIEW_CODEX_CONVERSATION_V1', archiveHashNamespace: 'REVIEW_CODEX_ARCHIVE_EVENTS_V1', contextMode: 'HOST_EXPORT' },
    sourceBindings: { creativeRevisionPaths: { EPISODE_PLAN: 'story/episode-plan.json', SCENE_COVERAGE: 'story/scene-coverage.json', SHOT_PLAN_SET: 'production/shot-plan.json' }, derivedRegistryPaths: [] },
    capabilities: { assistantEnabled: true, landingView: 'system', preferredCollaborator: 'HUMAN_AI', instanceAuthoring: 'DATABASE_DOCUMENTS' },
  };
}

export function blankSnapshot(profile) {
  const snapshotId = `snapshot_${randomUUID()}`;
  const arrays = Object.fromEntries(blankModelArrayKeys.map(key => [key, []]));
  const recipes = {schemaVersion: '8.7', snapshotId, counts: {}, executionDocuments: [], executionDefinitions: [], evidenceOnlyDefinitions: [], promptRevisions: [], sceneTimelines: [], postProductionTasks: [], sourceCatalog: [], integrity: {}};
  const snapshot = {
    schemaVersion: '8.7', snapshotId, snapshotDate: new Date().toISOString().slice(0,10), instance: profile,
    scope: {storyScenes:0, episodeCount:null, formalEpisodeDenominatorState:'UNKNOWN',formalEpisodeDenominator:null}, sources: {}, sourceHashes: {}, coverage:{}, unknowns: [],
    statusModel: {version:'2.0'}, storySources: {evidenceOrder:[], audio:null, transcript:{sections:[],segments:[],introBlocks:[],rawMarkdown:''},outline:{blocks:[],rawMarkdown:''}},
    adaptationAudit: {beats:[],canonicalStories:[],setupPayoffChains:[],sceneAudits:[],asrIssues:[],productionImpacts:[]}, storyRewrite:{}, characterPerformance:{},
    actionQueueInputs:{rewrittenSceneConfirmations:[],sceneReviewDossiers:[],audioVerifications:[],materialPreparation:[]},
    creativeLineage:{scenes:[],episodes:[],phases:[],causalChains:[],spatialEvidence:{mapCards:[],locations:[],locationPackages:[],sceneRouteLocks:[]},globalBaselineAssetRefs:[],scriptDocument:{rawMarkdown:'',blocks:[]},storyStructure:{sequences:[]},storyOverview:null,coverage:{}},
    productionModel:{schemaVersion:'8.7',instance:profile,...arrays,...blankProductionGraph(),policy:{},counts:{},reviewContextCatalog:{},systemModel:{},revisionPointers:{}},
    executionRecipeSummary:recipes,workItems:[],visualAssets:[],audioAssets:[],shots:[],p07:{storyboards:[],scenes:[],contactSheets:[]},outputArtifacts:[],
  };
  return {snapshot,recipes};
}
