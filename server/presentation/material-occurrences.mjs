import { idsFor } from './read-unit.mjs';

// Imported occurrence evidence remains tied to its own two inputs. A change to
// another scene, the catalog, or a whole-plan header cannot invalidate it.
export function projectOccurrences(evidence, scenes, requirements, episodes) {
  const byScene = new Map(scenes.map(row => [row.id, row]));
  const byRequirement = new Map(requirements.map(row => [row.id, row]));
  const pending = [], result = [];
  for (const occurrence of evidence?.scenes || []) {
    const scene = byScene.get(occurrence.sceneId);
    const sceneHash = scene?.content.contentHash || scene?.sha256;
    const references = [];
    for (const reference of occurrence.references || []) {
      const requirement = byRequirement.get(reference.requirementId);
      const expectedSceneHash = reference.sourceSceneContentHash || reference.sceneContentHash || occurrence.sceneContentHash;
      const requirementHash = requirement?.content.requirementHash || requirement?.sha256;
      const reason = !scene || expectedSceneHash !== sceneHash ? '场正文依据已变化或不在当前方案中'
        : !requirement || reference.requirementHash !== requirementHash ? '素材需求依据已变化或已退出当前目录' : null;
      if (reason) pending.push({ sceneId: occurrence.sceneId, requirementId: reference.requirementId, reason });
      else references.push({ ...reference, formalUse: false });
    }
    if (scene) result.push({ ...occurrence, sceneContentHash: sceneHash,
      episodeUid: episodes.find(ep => idsFor(ep, 'SCENE').includes(scene.id))?.id || null,
      references, unboundNeeds: occurrence.sceneContentHash === sceneHash ? occurrence.unboundNeeds || [] : [] });
  }
  return { projectionPolicy: 'PER_OCCURRENCE_V2', scenes: result, pending };
}

export async function materialOccurrences(unit) {
  if (unit.materialOccurrences) return unit.materialOccurrences;
  const evidence = (await unit.tx.query("SELECT content FROM provenance WHERE kind='aux:preparation-material-links' ORDER BY id")).rows;
  // Multiple imported ledgers cannot be arbitrarily collapsed into a current one.
  const entries = evidence.length === 1 ? evidence[0].content : { scenes: [] };
  const scenes = await unit.rows(['SCENE']), requirements = await unit.rows(['REQUIREMENT']), episodes = await unit.rows(['EPISODE']);
  return unit.materialOccurrences = projectOccurrences(entries, scenes, requirements, episodes);
}
