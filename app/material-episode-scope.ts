type EpisodeIdentity = {
  id: string;
  displayId?: string;
  episodeUid?: string;
  canonicalScopeId?: string;
};

type RequirementEpisodeIdentity = {
  episodeIds: string[];
  episodeUids?: string[];
};

type SceneEpisodeIdentity = {
  episodeId: string;
  episodeUid?: string;
};

function stableEpisodeIdentities(episode: EpisodeIdentity) {
  return [episode.canonicalScopeId, episode.episodeUid]
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export function materialRequirementVisibleInEpisodePlan(
  requirement: RequirementEpisodeIdentity,
  episodes: EpisodeIdentity[],
  currentEpisodePlan: boolean,
) {
  if (!currentEpisodePlan) return true;
  const currentIdentities = new Set(episodes.flatMap(stableEpisodeIdentities));
  const declaredStableIdentities = (requirement.episodeUids || []).filter(Boolean);
  if (declaredStableIdentities.some((identity) => currentIdentities.has(identity))) return true;
  return requirement.episodeIds.length === 0 && declaredStableIdentities.length === 0;
}

export function materialRequirementMatchesEpisode(
  requirement: RequirementEpisodeIdentity,
  episode: EpisodeIdentity,
  currentEpisodePlan: boolean,
) {
  if (currentEpisodePlan) {
    const identities = new Set(stableEpisodeIdentities(episode));
    return (requirement.episodeUids || []).some((identity) => identities.has(identity));
  }
  return requirement.episodeIds.includes(episode.displayId || episode.id);
}

export function materialSceneMatchesEpisode(
  scene: SceneEpisodeIdentity,
  episode: EpisodeIdentity,
  currentEpisodePlan: boolean,
) {
  if (currentEpisodePlan) return stableEpisodeIdentities(episode).includes(scene.episodeUid || '');
  return scene.episodeId === (episode.displayId || episode.id);
}
