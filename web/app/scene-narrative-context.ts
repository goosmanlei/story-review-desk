import type { EpisodePlanContext } from './episode-plan-context';
import type { StoryClaim } from './story-review-types';
import type { StoryConfirmationTarget } from './adaptation-audit';
import type { ReviewSpec } from '../presentation/configuration-model.mjs';

export type SceneRequirement = {
  id: string; label: string; scope: 'EPISODE' | 'SCENE'; claim: StoryClaim;
  sceneIds: string[]; blockIds: string[];
};
export type SceneNarrativeContext = {
  revisionId: string; planContentHash: string; episodeUid: string; sceneId: string;
  sceneContentHash: string; contextHash: string; snapshotId: string;
  upstreamState: 'HISTORICAL' | 'PENDING_REVIEW' | 'REVISION_REQUIRED' | 'DO_NOT_USE' | 'APPROVED_PENDING_SYNC' | 'CURRENT';
  episode: { displayId: string; title: string; scenePosition: number; sceneCount: number };
  requirements: SceneRequirement[];
  neighbours: Array<{ id: string; label: string; direction: 'previous' | 'next'; transition: string }>;
  chains: Array<{ id: string; title: string; requirement: string; role: string; setup: string[]; payoff: string[] }>;
  sceneLabels: Record<string, string>; missing: string[]; reviewSpec: ReviewSpec;
  formalTarget: StoryConfirmationTarget | null; formalBlockReason: string | null;
  sceneDocument?: {id:string;title:string;displayId:string;contentHash:string;scriptBlocks:Array<{id:string;type:string;speaker:string;performanceNote:string;text:string}>;sourceBindings:Array<{sourceId:string;revisionId:string;sha256:string}>};
};

/** Project author-owned claims only. No generated assessment or fuzzy block matching. */
export function sceneRequirements(plan: EpisodePlanContext, sceneId: string) {
  const owners = plan.content.episodes.filter(ep => ep.sceneIds.includes(sceneId));
  if (owners.length !== 1) throw new Error('此场未唯一绑定到所选分集方案');
  const episode = owners[0], dossier = episode.reviewDossier;
  const requirements: SceneRequirement[] = [], missing: string[] = [];
  const add = (id: string, label: string, claim: StoryClaim | undefined, scope: SceneRequirement['scope'], sceneIds = [sceneId], blockIds: string[] = []) => {
    if (!claim || !claim.text || claim.class === 'U' || claim.text === 'UNKNOWN') missing.push(`${label}：${claim?.text || 'UNKNOWN'}`);
    requirements.push({ id, label, claim: claim || { class: 'U', text: 'UNKNOWN', evidenceRefs: [] }, scope, sceneIds, blockIds });
  };
  add('episode-task', '本集任务', dossier.purpose.episodeTask, 'EPISODE', episode.sceneIds);
  add('expression-focus', '本集重点表达', dossier.purpose.expressionFocus, 'EPISODE', episode.sceneIds);
  add('audience-position','本集观众应知',dossier.informationLayers.audiencePosition,'EPISODE',episode.sceneIds);
  add('hidden-truth','作者所知与揭晓边界',dossier.informationLayers.hiddenTruth,'EPISODE',episode.sceneIds);
  add('episode-payoff', '本集阶段回报', dossier.payoff.deliveredResult, 'EPISODE', episode.sceneIds);
  add('episode-opening', '本集开场要求', {class:'A',text:episode.openingHook,evidenceRefs:[]}, 'EPISODE', [episode.sceneIds[0]]);
  add('episode-ending', '本集结尾要求', {class:'A',text:episode.endingCliffhanger,evidenceRefs:[]}, 'EPISODE', [episode.sceneIds.at(-1)!]);
  const flow = dossier.schemaVersion === '1.1' ? dossier.sceneFlow.filter(row => row.sceneId === sceneId) : [];
  if (flow.length > 1) throw new Error('本场作用存在重复绑定');
  add('scene-function', '本场承担的作用', flow[0]?.function, 'SCENE');
  for (const slice of dossier.progressionSlices.filter(row => row.sceneIds.includes(sceneId))) {
    if (slice.sceneIds.some(id => !episode.sceneIds.includes(id))) throw new Error('推进段包含相邻集场次');
    add(`slice:${slice.sliceId}`, `所在推进段：${slice.sequenceTitle.text}`, slice.structuralRole, 'EPISODE', slice.sceneIds);
  }
  for (const beat of dossier.comedyBeats.filter(row => row.sceneIds.includes(sceneId))) add(`comedy:${beat.canonicalStoryId}`, '本场笑点与作用', beat.role, 'SCENE', beat.sceneIds);
  if (dossier.schemaVersion === '1.1') {
    for (const [key,label] of [['opening','本集开场在此场落实'],['ending','本集结尾在此场落实']] as const) {
      const ref = dossier.boundaryEvidence[key];
      if (ref.sceneId === sceneId) add(`boundary:${key}`,label,{class:'A',text:key === 'opening' ? episode.openingHook : episode.endingCliffhanger,evidenceRefs:[]},'SCENE',[sceneId],ref.blockIds);
    }
    missing.push(...dossier.authoringUnknowns.map(c=>`资料待核：${c.text}`));
  }
  return {episode, requirements, missing};
}
