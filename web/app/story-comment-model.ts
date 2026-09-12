import type { EpisodePlanContext } from './episode-plan-context';
import type { SceneCommentAnchor } from './scene-script-comments';

export type StoryCommentBlock = { id: string; text: string; label?: string; groupId?: string };
export type StoryCommentSource = {
  kind: 'SCENE_SCRIPT' | 'EPISODE_DESIGN'; subjectId: string; episodeUid: string;
  label: string; blocks: StoryCommentBlock[];
};
export type StoryCommentTarget = StoryCommentSource & {
  revisionId: string; planContentHash: string; contentHash: string; contextHash: string;
  objectRevisionId?:string;expectedVersion?:number;
};
export type StoryCommentThread = {
  commentId: string; commentRevisionId: string; latestEventId: string;
  target: StoryCommentTarget; anchor: SceneCommentAnchor; commentText: string;
  status: 'OPEN' | 'AI_QUEUED' | 'AI_PROCESSING' | 'RESOLVED'; updatedAt: string;
  anchorMatchesCurrentText: boolean; applicabilityState: 'CURRENT' | 'STALE';
};
export const commentTargetKey = (target: Pick<StoryCommentSource, 'kind' | 'subjectId'>) => `${target.kind}:${target.subjectId}`;
export const commentTargetBinding = (target: StoryCommentTarget) => ({kind:target.kind,subjectId:target.subjectId,revisionId:target.revisionId,planContentHash:target.planContentHash,contentHash:target.contentHash,contextHash:target.contextHash,objectRevisionId:target.objectRevisionId,expectedVersion:target.expectedVersion});

// Unkeyed authored lists are content-addressed. This is an identity token, not a
// security hash; the server also verifies the full text and cryptographic hash.
export function commentItemId(text: string, index: number) {
  let hash = BigInt('14695981039346656037');
  for (const char of text) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0)!)) * BigInt('1099511628211'));
  return `${index}-${hash.toString(16)}`;
}

/** The same explicit authored-field catalog drives DOM anchors and server lookup. */
export function storyCommentSources(plan: EpisodePlanContext): StoryCommentSource[] {
  return plan.content.episodes.flatMap(ep => {
    const d = ep.reviewDossier, blocks: StoryCommentBlock[] = [];
    const add = (id: string, text: string, label: string, groupId: string) => blocks.push({ id, text, label, groupId });
    add('openingHook', ep.openingHook, '开场的设计意图', 'opening-boundary');
    add('coreAdvance', ep.coreAdvance, '对主剧情的推进', 'episode-purpose');
    add('endingCliffhanger', ep.endingCliffhanger, '结尾的设计意图', 'ending-propulsion');
    for (const [id, label] of [['episodeTask','本集任务'],['characterAction','人物行动'],['expressionFocus','重点表达']]) add(`purpose.${id}`, d.purpose[id as keyof typeof d.purpose].text, label, 'episode-purpose');
    for (const [id, label] of [['visibleAction','明线'],['hiddenTruth','暗线'],['audiencePosition','观众所得']]) add(`informationLayers.${id}`, d.informationLayers[id as 'visibleAction'|'hiddenTruth'|'audiencePosition'].text, label, 'information-causality');
    for (const [id, label] of [['deliveredResult','本集回报'],['changedState','结束状态']]) add(`payoff.${id}`, d.payoff[id as 'deliveredResult'|'changedState'].text, label, 'episode-payoff');
    d.progressionSlices.forEach(s => { for (const id of ['sequenceTitle','structuralRole','turningPoint','audienceGain','outputState'] as const) add(`slice:${s.sliceId}:${id}`, s[id].text, s.sequenceTitle.text, 'escalation-turn'); });
    d.comedyBeats.forEach(b => add(`comedy:${b.canonicalStoryId}`, b.role.text, '笑点与节奏', 'escalation-turn'));
    d.payoff.unresolvedQuestions.forEach((c,i) => add(`question:${commentItemId(c.text,i)}`, c.text, '待解问题', 'episode-payoff'));
    if (d.schemaVersion === '1.1') {
      d.sceneFlow.forEach(s => add(`scene:${s.sceneId}:function`, s.function.text, '场次作用', 'episode-purpose'));
      d.informationLayers.characterKnowledge.forEach(c => add(`knowledge:${c.subjectId}`, c.knowledge.text, c.displayName || '人物所知', 'information-causality'));
      d.authoringUnknowns.forEach((c,i) => add(`unknown:${commentItemId(c.text,i)}`, c.text, '资料待核', 'episode-payoff'));
    }
    plan.content.narrativeRevision?.causalChains.filter(c => d.causalChainIds.includes(c.id)).forEach(c => add(`chain:${c.id}`, c.mustPreserve, c.title, 'information-causality'));
    const design: StoryCommentSource = {kind:'EPISODE_DESIGN', subjectId:ep.episodeUid, episodeUid:ep.episodeUid, label:`${ep.displayId} ${ep.title} · 分集设计`, blocks};
    const scenes: StoryCommentSource[] = (plan.content.narrativeRevision?.scenes || []).filter(s => ep.sceneIds.includes(s.id)).map(s => ({kind:'SCENE_SCRIPT', subjectId:s.id, episodeUid:ep.episodeUid, label:`${ep.displayId} · ${s.displayId} ${s.title}`, blocks:s.scriptBlocks.map(b => ({id:b.id,text:b.text}))}));
    return [design, ...scenes];
  });
}

export function requirementCommentField(id: string, sceneId: string) {
  const fields: Record<string,string> = {'episode-task':'purpose.episodeTask','expression-focus':'purpose.expressionFocus','audience-position':'informationLayers.audiencePosition','hidden-truth':'informationLayers.hiddenTruth','episode-payoff':'payoff.deliveredResult','episode-opening':'openingHook','episode-ending':'endingCliffhanger','boundary:opening':'openingHook','boundary:ending':'endingCliffhanger','scene-function':`scene:${sceneId}:function`};
  return fields[id] || (id.startsWith('slice:') ? `${id}:structuralRole` : id.startsWith('comedy:') ? id : null);
}
