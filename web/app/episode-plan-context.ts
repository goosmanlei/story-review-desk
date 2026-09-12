import type { NarrativeRevision } from './narrative-revision';
import type { EpisodeReviewDossier } from './story-review-types';

export type EpisodePlanEpisode = {
  episodeUid: string; displayId: string; title: string; sceneIds: string[];
  openingHook: string; coreAdvance: string; endingCliffhanger: string; reviewQuestion: string;
  reviewDossier: EpisodeReviewDossier;
};
export type EpisodePlanContent = { planId: string; episodes: EpisodePlanEpisode[]; retiredEpisodeUids: string[]; changeSummary?: string; narrativeRevision?: NarrativeRevision };
export type EpisodeExcerpt = { sceneId: string; blocks: Array<{ id: string; type: string; speaker: string; performanceNote: string; text: string }> };
export type EpisodePlanContext = {
  revisionId: string; readOnly?: boolean; archived?:boolean; sourceRole: 'CURRENT' | 'PROPOSAL' | 'CANDIDATE';
  snapshotId: string; contentHash: string; contextHash: string | null; baseRevisionHash: string;
  subjectNames: Record<string, string>;
  reviewSpec?: import("../presentation/configuration-model.mjs").ReviewSpec;
  criteriaVersion: string; basisBindingsHash: string | null;
  content: EpisodePlanContent;
  presentation: Record<string, { opening: EpisodeExcerpt | null; ending: EpisodeExcerpt | null }>;
};

/** Preserve the complete canonical payload when reading an adopted revision. */
export function episodePlanContentFromRecord(record: EpisodePlanContent): EpisodePlanContent {
  return {planId:record.planId,episodes:record.episodes.map(episode=>({episodeUid:episode.episodeUid,displayId:episode.displayId,title:episode.title,sceneIds:episode.sceneIds,openingHook:episode.openingHook,coreAdvance:episode.coreAdvance,endingCliffhanger:episode.endingCliffhanger,reviewQuestion:episode.reviewQuestion,reviewDossier:episode.reviewDossier})),retiredEpisodeUids:record.retiredEpisodeUids || [],...(record.changeSummary ? {changeSummary:record.changeSummary}:{}),...(record.narrativeRevision ? {narrativeRevision:record.narrativeRevision}:{})};
}
