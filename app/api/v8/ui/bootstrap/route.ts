import { errorResponse, jsonResponse, reviewData } from '../../_store';
import { productionBootstrapSeed } from '../_projection';

export async function GET() {
  try {
    const data = await reviewData() as unknown as Record<string, unknown> & {
      schemaVersion: string;
      snapshotId: string;
      creativeLineage?: Record<string, unknown> & { storyStructure?: Record<string, unknown> };
      storySources?: Record<string, unknown> & {
        transcript?: Record<string, unknown>;
        outline?: Record<string, unknown>;
      };
      productionModel?: Record<string, unknown> & {
        reviewContextCatalog?: Record<string, unknown>;
      };
    };
    const productionModel = data.productionModel ? productionBootstrapSeed(data.productionModel) : undefined;
    const lineageSceneSummary = (scene: Record<string, unknown>) => ({
      id: scene.id,
      number: scene.number,
      act: scene.act,
      actTitle: scene.actTitle,
      phaseId: scene.phaseId,
      slugline: scene.slugline,
      scriptExcerpt: typeof scene.scriptExcerpt === 'string' ? scene.scriptExcerpt.slice(0, 240) : scene.scriptExcerpt,
      scriptCharacterCount: scene.scriptCharacterCount,
      sourceLineStart: scene.sourceLineStart,
      sourceLineEnd: scene.sourceLineEnd,
      sourceRef: scene.sourceRef,
      time: scene.time,
      primaryLocation: scene.primaryLocation,
      zone: scene.zone,
      route: scene.route,
      stateIds: scene.stateIds,
      segmentCount: scene.segmentCount,
      shotCount: scene.shotCount,
      structureCardCount: scene.structureCardCount,
      authoringStatus: scene.authoringStatus,
      promptDefinitionStatus: scene.promptDefinitionStatus,
      episodeAssignment: scene.episodeAssignment,
      issueRefs: scene.issueRefs,
      nextAction: scene.nextAction,
      relationStatus: scene.relationStatus,
      storySequenceId: scene.storySequenceId,
      scopeRole: scene.scopeRole,
      storyHandoff: scene.storyHandoff,
    });
    const creativeLineage = data.creativeLineage ? {
      ...data.creativeLineage,
      characterPerformance: undefined,
      storyStructure: data.creativeLineage.storyStructure ? {
        ...data.creativeLineage.storyStructure,
        evidenceCatalog: undefined,
      } : undefined,
      scriptDocument: data.creativeLineage.scriptDocument && typeof data.creativeLineage.scriptDocument === 'object' ? {
        ...(data.creativeLineage.scriptDocument as Record<string, unknown>),
        rawMarkdown: undefined,
      } : data.creativeLineage.scriptDocument,
      scenes: Array.isArray(data.creativeLineage.scenes)
        ? (data.creativeLineage.scenes as Record<string, unknown>[]).map(lineageSceneSummary)
        : [],
    } : undefined;
    const storySources = data.storySources ? {
      ...data.storySources,
      transcript: data.storySources.transcript ? {
        ...data.storySources.transcript,
        rawMarkdown: undefined,
        introBlocks: [],
        segments: [],
        bootstrapState: 'SUMMARY_ONLY_USE_STORY_SOURCES_ENDPOINT',
      } : undefined,
      outline: data.storySources.outline ? {
        ...data.storySources.outline,
        rawMarkdown: undefined,
        blocks: [],
        bootstrapState: 'SUMMARY_ONLY_USE_STORY_SOURCES_ENDPOINT',
      } : undefined,
    } : undefined;
    const bootstrapData = {
      instance: data.instance,
      schemaVersion: data.schemaVersion,
      snapshotId: data.snapshotId,
      snapshotDate: data.snapshotDate,
      scope: data.scope,
      statusModel: data.statusModel,
      sources: data.sources,
      sourceHashes: data.sourceHashes,
      coverage: data.coverage,
      unknowns: data.unknowns,
      storySources,
      storyRewrite: data.storyRewrite,
      creativeLineage,
      productionModel,
      workItems: Array.isArray(data.workItems) ? data.workItems : [],
      visualAssets: Array.isArray(data.visualAssets) ? data.visualAssets : [],
      audioAssets: Array.isArray(data.audioAssets) ? data.audioAssets : [],
      shots: [],
      p07: data.p07 && typeof data.p07 === 'object' ? data.p07 : { storyboards: [], scenes: [] },
      outputArtifacts: [],
    };
    return jsonResponse({
      schemaVersion: data.schemaVersion,
      snapshotId: data.snapshotId,
      bootstrapMode: 'SUMMARY_ONLY',
      capabilities: {
        productionPage: '/api/v8/ui/production',
        materialsPage: '/api/v8/ui/materials',
        storySources: '/api/v8/ui/story-sources',
        fullProductionCompatibilityView: '/api/v8/ui/views/production',
      },
      data: bootstrapData,
    });
  } catch (reason) {
    return errorResponse(reason, 'review UI bootstrap failed');
  }
}
