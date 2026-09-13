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

export async function materialOccurrences(unit,{requirementIds}={}) {
  const key='occurrences:'+JSON.stringify(requirementIds||null);
  if(unit.loaded.has(key))return unit.loaded.get(key);
  const noteIds=requirementIds?(await unit.tx.query("SELECT owner_id FROM memberships WHERE role='REQUIREMENT' AND member_id=ANY($1::text[])",[requirementIds])).rows.map(r=>r.owner_id):undefined;
  const notes=await unit.rows(['NOTE'],{roles:['MATERIAL_OCCURRENCE'],ids:noteIds});
  const grouped=new Map();
  for(const row of notes){const c=row.content;let scene=grouped.get(c.sceneId);if(!scene){scene={sceneId:c.sceneId,sceneContentHash:c.sceneContentHash,references:[],unboundNeeds:[]};grouped.set(c.sceneId,scene);}scene.references.push(c.reference);}
  const entries={scenes:[...grouped.values()]};
  const scenes = await unit.rows(['SCENE'],{ids:[...grouped.keys()],fields:['contentHash']}), requirements = await unit.rows(['REQUIREMENT'],{ids:requirementIds,fields:['requirementHash']}), episodes = await unit.rows(['EPISODE'],{fields:[]});
  const result=projectOccurrences(entries, scenes, requirements, episodes);unit.loaded.set(key,result);return result;
}
