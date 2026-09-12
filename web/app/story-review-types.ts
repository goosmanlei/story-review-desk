export type StoryClaim = {
  class: 'A' | 'F' | 'L' | 'U';
  text: string;
  evidenceRefs: string[];
};

export type EpisodeProgressionSlice = {
  sliceId: string;
  sequenceId: string;
  sequenceTitle: StoryClaim;
  sceneIds: string[];
  coverageRole: 'FULL_SEQUENCE' | 'EPISODE_SLICE';
  structuralRole: StoryClaim;
  turningPoint: StoryClaim;
  audienceGain: StoryClaim;
  outputState: StoryClaim;
};

export type EpisodeReviewDossierV10 = {
  schemaVersion: '1.0';
  purpose: {
    episodeTask: StoryClaim;
    characterAction: StoryClaim;
    expressionFocus: StoryClaim;
  };
  progressionSlices: EpisodeProgressionSlice[];
  informationLayers: {
    visibleAction: StoryClaim;
    hiddenTruth: StoryClaim;
    audiencePosition: StoryClaim;
  };
  payoff: {
    deliveredResult: StoryClaim;
    changedState: StoryClaim;
    unresolvedQuestions: StoryClaim[];
  };
  comedyBeats: Array<{
    canonicalStoryId: string;
    sceneIds: string[];
    role: StoryClaim;
  }>;
  causalChainIds: string[];
};

export type SceneExcerptRef = {
  sceneId: string;
  sceneScriptRevisionId: string;
  sceneContentHash: string;
  blockIds: string[];
  excerptSha256: string;
};

export type EpisodeReviewDossierV11 = Omit<EpisodeReviewDossierV10, 'schemaVersion' | 'informationLayers'> & {
  schemaVersion: '1.1';
  sceneFlow: Array<{ sceneId: string; function: StoryClaim }>;
  boundaryEvidence: { opening: SceneExcerptRef; ending: SceneExcerptRef };
  informationLayers: EpisodeReviewDossierV10['informationLayers'] & {
    characterKnowledge: Array<{ subjectId: string; displayName?: string; knowledge: StoryClaim }>;
  };
  authoringUnknowns: StoryClaim[];
};
export type EpisodeReviewDossier = EpisodeReviewDossierV10 | EpisodeReviewDossierV11;

export type StoryOverviewSectionId =
  | 'overview'
  | 'spine'
  | 'characters'
  | 'truth-route'
  | 'audience'
  | 'space';

export type StoryOverview = {
  schemaVersion: '1.0';
  sourceBindings: Array<{ kind: string; sourcePath: string; sha256: string }>;
  overviewMap: { imageUrl: string; label: string; note: string };
  storySpine: {
    acts: Array<{ id: string; order: number; title: StoryClaim; sceneIds: string[]; sceneStart: string; sceneEnd: string }>;
    sequences: Array<{
      id: string;
      order: number;
      title: StoryClaim;
      sceneIds: string[];
      summary: StoryClaim;
      structuralRole: StoryClaim;
      turningPoint: { event: StoryClaim; structuralMeaning: StoryClaim };
      outputState: StoryClaim[];
    }>;
  };
  characterLines: Array<{ id: string; name: string; storyFunction: string; arc: string; evidenceRefs: string[] }>;
  truthRoute: Array<{ id: string; name: string; status: string; result: unknown; note?: string | null; sourceRef: string }>;
  audienceThreads: Array<{ id: string; title: string; sceneIds: string[]; functions: string[]; adaptationStatus: string; sourceRef: string }>;
  causalChains: Array<{
    id: string;
    title: string;
    setupSceneIds: string[];
    payoffSceneIds: string[];
    status: string;
    mustPreserve: string;
    sourceRef: string;
  }>;
  spatialSummary: {
    orientation: string;
    mapCards: Array<{ id: string; locationIds: string[]; label: string; imageUrl: string; note: string }>;
    locations: Array<{ id: string; name: string; zone: string; fact: string }>;
  };
};
