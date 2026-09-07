import { reviewSpec } from '../../../host/instance-runtime/configuration-model.mjs';
import { resolveFormalReviewSpec } from './_review-spec';
import { resolveEpisodePlan } from './_episode-plan';
import { HttpError, stableObjectHash, storyConfirmationTargets, type ReviewData, type operationalSnapshot } from './_store';
import { sceneRequirements, type SceneNarrativeContext } from '../../scene-narrative-context';
import type { EpisodePlanContext } from '../../episode-plan-context';

type Operations = Awaited<ReturnType<typeof operationalSnapshot>>;
export function resolveSceneNarrativeContext(data: ReviewData, operations: Operations, sceneId: string, requestedRevisionId?: string | null, resolved?: EpisodePlanContext): SceneNarrativeContext {
  const plan = resolved || resolveEpisodePlan(data, operations, requestedRevisionId);
  if (!plan) throw new HttpError(409, '尚无可用分集方案');
  if (plan.content.episodes.filter(episode=>episode.sceneIds.includes(sceneId)).length!==1) throw new HttpError(409, '此场未唯一绑定到所选分集方案，请重新选择当前场次');
  const {episode, requirements, missing} = sceneRequirements(plan, sceneId);
  const narrative = plan.content.narrativeRevision;
  const scenes = (narrative?.scenes || data.creativeLineage?.scenes || []) as Array<{id:string;title?:string;displayId?:string;slugline?:string;transition?:string;scriptBlocks?:Array<{id:string}>}>;
  const scene = scenes.find(s=>s.id===sceneId);
  if (!scene) throw new HttpError(409, '所选方案缺少本场正文');
  const target = storyConfirmationTargets(data).find(t=>t.sceneId===sceneId);
  const sceneContentHash = narrative?.scenes.find(s=>s.id===sceneId)?.contentHash || target?.sceneContentHash;
  if (!sceneContentHash) throw new HttpError(409, '本场正文缺少精确版本');
  const blocks = scene.scriptBlocks || [];
  if(narrative) for(const requirement of requirements) for(const ref of requirement.claim.evidenceRefs) {
    if(!ref.startsWith('NARRATIVE:')) continue;
    const match=/^NARRATIVE:([^:]+):([a-f0-9]{64})$/.exec(ref);
    const source=match && narrative.scenes.find(s=>s.id===match[1]);
    if(!match || !source || source.contentHash!==match[2]) throw new HttpError(409,'承接要求的正文依据已变化');
  }
  for (const requirement of requirements) if (requirement.blockIds.some(id=>!blocks.some(b=>b.id===id))) throw new HttpError(409, '承接依据正文块已变化');
  const spec = target?.reviewSpec || (data.productionModel.systemConfiguration ? reviewSpec(data.productionModel.systemConfiguration.config, 'SCRIPT_SCENE', {}) : resolveFormalReviewSpec(data,'SCRIPT_SCENE',sceneId)!);
  const review = operations.reviews.events.find(e=>e.subjectKind==='EPISODE_PLAN' && e.effect==='APPLIED' && e.applicationStatus==='APPLIED' && (e.subjectRevisionId===plan.revisionId || e.creativeRevisionId===plan.revisionId) && e.subjectRevisionHash===plan.contentHash && e.contextHash===plan.contextHash);
  const upstreamState: SceneNarrativeContext['upstreamState'] = plan.sourceRole==='CURRENT' ? 'CURRENT' : review?.action==='APPROVE_AND_RELEASE' ? 'APPROVED_PENDING_SYNC' : review?.action==='REQUEST_REVISION' ? 'REVISION_REQUIRED' : review?.action==='DO_NOT_USE' ? 'DO_NOT_USE' : 'PENDING_REVIEW';
  const handoff = operations.stateProjection.storyHandoff as {currentEpisodePlanRevisionId?: string;episodePlanSourceSyncState?: string} | undefined;
  const currentBound = upstreamState==='CURRENT' && handoff?.currentEpisodePlanRevisionId===plan.revisionId && ['SOURCE_CURRENT','SUCCEEDED'].includes(handoff.episodePlanSourceSyncState || '') && target?.sceneContentHash===sceneContentHash;
  const labels = Object.fromEntries(scenes.map(s=>[s.id, `${s.displayId || s.id} ${'title' in s ? s.title : s.slugline || ''}`]));
  const allIds = plan.content.episodes.flatMap(ep=>ep.sceneIds), index=allIds.indexOf(sceneId);
  const neighbours: SceneNarrativeContext['neighbours'] = [];
  for (const [offset,direction] of [[-1,'previous'],[1,'next']] as const) {
    const other = scenes.find(s=>s.id===allIds[index+offset]);
    if (other) neighbours.push({id:other.id,label:labels[other.id],direction,transition:direction==='previous' ? other.transition || 'UNKNOWN' : scene.transition || 'UNKNOWN'});
  }
  const chains = ((narrative?.causalChains || data.creativeLineage?.causalChains || []) as Array<{id:string;title:string;mustPreserve:string;setupSceneIds:string[];payoffSceneIds:string[]}>).filter(c=>c.setupSceneIds.includes(sceneId)||c.payoffSceneIds.includes(sceneId)).map(c=>({id:c.id,title:c.title,requirement:c.mustPreserve,role:c.setupSceneIds.includes(sceneId) ? c.payoffSceneIds.includes(sceneId) ? '本场同时铺垫与回收' : '本场负责铺垫，回收在后续场' : '本场负责回收前文铺垫',setup:c.setupSceneIds,payoff:c.payoffSceneIds}));
  const contextHash = stableObjectHash({revisionId:plan.revisionId,planContentHash:plan.contentHash,episodeUid:episode.episodeUid,sceneId,sceneContentHash,requirements,chains,reviewSpecHash:spec.hash});
  return {revisionId:plan.revisionId,planContentHash:plan.contentHash,episodeUid:episode.episodeUid,sceneId,sceneContentHash,contextHash,snapshotId:plan.snapshotId,upstreamState,episode:{displayId:episode.displayId,title:episode.title,scenePosition:episode.sceneIds.indexOf(sceneId)+1,sceneCount:episode.sceneIds.length},requirements,neighbours,chains,sceneLabels:labels,missing,reviewSpec:spec,formalTarget:currentBound ? {...target,reviewSpec:spec} as SceneNarrativeContext['formalTarget'] : null,formalBlockReason:currentBound ? null : upstreamState==='APPROVED_PENDING_SYNC' ? '分集方案已获批，完成受控源同步后开放本场正式审阅。' : upstreamState==='CURRENT' ? '本场正文或交接绑定尚未就绪，请核对当前发布版本。' : '请先在叙事拆解完成整套分集方案审阅，并在获批后完成受控源同步。'};
}
