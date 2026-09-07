import type {ReviewData, EventRecord} from './_store';
import type {EpisodePlanContent} from '../../episode-plan-context';
import type {episodeReviewInput} from './episode-plan-reviews/_scope';

/** A read-only navigation catalogue, never a formal denominator or adoption.
 * Scoped releases and unsynced candidate identities must not rewrite the
 * legacy canonical scene set or silently acquire an E01 alias as identity.
 */
export function productionDirectory(data:ReviewData,candidates:EventRecord[]=[]){
  const latest=candidates.find(c=>c.subjectKind==='EPISODE_PLAN'&&c.revisionState==='CANDIDATE'&&(c.content as EpisodePlanContent|undefined)?.narrativeRevision);
  const content=latest?.content as EpisodePlanContent|undefined;
  const releases=(data.productionModel as unknown as {episodeNarrativeReleases?:Array<{scopeRole:string;reviewInput:ReturnType<typeof episodeReviewInput>}>}).episodeNarrativeReleases||[];
  const scopedEpisodes=content?.episodes||releases.filter(r=>r.scopeRole==='CURRENT').map(r=>r.reviewInput.episode);
  const scopedScenes=content?.narrativeRevision?.scenes||releases.filter(r=>r.scopeRole==='CURRENT').flatMap(r=>r.reviewInput.scenes);
  const episodes=scopedEpisodes.map(e=>({...e,displayId:'displayId' in e?e.displayId:undefined,id:e.episodeUid,canonicalScopeId:e.episodeUid,identityMode:'PERMANENT_ONLY',scopeRole:'DISCOVERED',denominatorState:'UNKNOWN'}));
  const scenes=scopedScenes.map(s=>({...s,episodeUid:scopedEpisodes.find(e=>e.sceneIds.includes(s.id))?.episodeUid,scopeRole:'DISCOVERED',denominatorState:'UNKNOWN'}));
  return {
    episodes:[...episodes,...(data.productionModel.episodes||[]).filter(e=>!episodes.some(n=>n.episodeUid===e.episodeUid))],
    scenes:[...scenes,...(data.productionModel.scenes||[]).filter(s=>!scenes.some(n=>n.id===s.id))],
  };
}
