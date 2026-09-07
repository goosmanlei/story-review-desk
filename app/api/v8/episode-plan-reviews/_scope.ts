import { HttpError, stableObjectHash, type EventRecord } from '../_store';
import type { EpisodePlanContent } from '../../../episode-plan-context';
import { assertEpisodeCandidateContract } from '../_episode-plan';
import { narrativeExcerpt } from '../_narrative-revision';
import { assertEpisodeSubmissionBindings, episodeSubmissionHeads, parseEpisodeFindings, validateEpisodeAction } from './_contract';

export const EPISODE_REVIEW_INPUT_VERSION = '1.0';

/** Immutable, local review evidence. Deliberately excludes the whole-plan revision/hash.
 * A changed neighbour matters only through the boundary shown to this episode; a
 * causal reference includes its actual endpoint scenes, not merely its stable ID.
 */
export function episodeReviewInput(candidate: EventRecord, episodeUid: string, reviewSpecHash: string) {
  assertEpisodeCandidateContract(candidate);
  const plan = candidate.content as EpisodePlanContent;
  const narrative = plan.narrativeRevision;
  const index = plan.episodes.findIndex(e => e.episodeUid === episodeUid);
  const episode = plan.episodes[index];
  if (!narrative || !episode || episode.reviewDossier.schemaVersion !== '1.1' || !/^[a-f0-9]{64}$/.test(reviewSpecHash)) {
    throw new HttpError(409, '无法从不可变候选精确重建本集审阅材料，需重新审阅');
  }
  const scene = (id: string) => {
    const rows = narrative.scenes.filter(s => s.id === id);
    if (rows.length !== 1 || stableObjectHash(rows[0].scriptBlocks) !== rows[0].contentHash) throw new HttpError(409, '本集审阅依据中的场正文缺失或校验失败');
    const { displayId: _alias, ...record } = rows[0];
    return record;
  };
  const boundary = (neighbour: typeof episode | undefined, side: 'opening' | 'ending') => {
    if (!neighbour) return null;
    const ref = neighbour.reviewDossier.schemaVersion === '1.1' ? neighbour.reviewDossier.boundaryEvidence[side] : null;
    if (!ref) throw new HttpError(409, '相邻集缺少精确承接材料');
    const blocks = narrativeExcerpt(narrative, ref, side);
    return { episodeUid: neighbour.episodeUid, design: side === 'opening' ? neighbour.openingHook : neighbour.endingCliffhanger, sceneId: ref.sceneId, blocks };
  };
  const causalIds = new Set([...episode.reviewDossier.causalChainIds, ...narrative.causalChains.filter(c => [...c.setupSceneIds, ...c.payoffSceneIds].some(id => episode.sceneIds.includes(id))).map(c => c.id)]);
  const causalChains = [...causalIds].sort().map(id => {
    const rows = narrative.causalChains.filter(c => c.id === id);
    if (rows.length !== 1) throw new HttpError(409, '本集关联因果链缺失或不唯一');
    const chain = rows[0];
    return { chain, scenes: [...new Set([...chain.setupSceneIds, ...chain.payoffSceneIds])].sort().map(id => {
      const owners = plan.episodes.filter(e => e.sceneIds.includes(id));
      if (owners.length !== 1) throw new HttpError(409, '因果端点没有唯一永久集归属');
      return { episodeUid: owners[0].episodeUid, scene: scene(id) };
    }) };
  });
  const localSceneIds = new Set([...episode.sceneIds,...causalChains.flatMap(c=>c.scenes.map(row=>row.scene.id))]);
  const { displayId: _displayAlias, ...episodeContent } = episode;
  return {
    schemaVersion: EPISODE_REVIEW_INPUT_VERSION, planId: plan.planId, episodeUid,
    criteriaVersion: candidate.criteriaVersion || '1.0', reviewSpecHash,
    position: index === 0 ? 'FIRST' : index === plan.episodes.length - 1 ? 'LAST' : 'MIDDLE',
    isLast: index === plan.episodes.length - 1,
    episode: episodeContent, scenes: episode.sceneIds.map(scene),
    previousEnding: boundary(plan.episodes[index - 1], 'ending'), nextOpening: boundary(plan.episodes[index + 1], 'opening'),
    causalChains, runtimeMethod: narrative.runtimeMethod,
    sourceNarration: narrative.sourceNarrationIndex.filter(s => s.sceneIds.some(id => localSceneIds.has(id)))
      .map(s => ({ ...s, sceneIds: s.sceneIds.filter(id => localSceneIds.has(id)) })).sort((a,b) => a.id.localeCompare(b.id)),
  };
}

export function episodeReviewInputHash(candidate: EventRecord, episodeUid: string, reviewSpecHash: string) {
  return stableObjectHash(episodeReviewInput(candidate, episodeUid, reviewSpecHash));
}

export type EpisodeCarryForwardOption = {
  episodeUid: string; sourceSubmissionEventId: string; sourceRevisionId: string;
  sourceRecordedAt: string; recommendation: string; state: 'ELIGIBLE' | 'CHANGED' | 'UNAVAILABLE';
  reviewInputHash?: string; reason: string;
};

/** Latest historical head only: never cherry-pick an older PASS over a newer FAIL. */
export function episodeCarryForwardOptions(candidates: EventRecord[], submissions: EventRecord[], target: EventRecord, standardHash: string, onlyEpisodeUid?: string): EpisodeCarryForwardOption[] {
  const plan = target.content as EpisodePlanContent;
  const targetId = String(target.creativeRevisionId || target.revisionId);
  const targetSequence = Number(target.eventSequence || Number.MAX_SAFE_INTEGER);
  const historical = candidates.filter(c => c.subjectKind === 'EPISODE_PLAN' && c.subjectId === target.subjectId
    && (c.creativeRevisionId || c.revisionId) !== targetId && Number(c.eventSequence || 0) < targetSequence);
  const heads = historical.flatMap(c => [...episodeSubmissionHeads(submissions, String(c.creativeRevisionId || c.revisionId)).values()].map(event => ({ candidate: c, event })))
    .sort((a, b) => Number(b.event.eventSequence || 0) - Number(a.event.eventSequence || 0) || String(b.event.recordedAt).localeCompare(String(a.event.recordedAt)));
  return plan.episodes.filter(episode => !onlyEpisodeUid || episode.episodeUid === onlyEpisodeUid).flatMap(episode => {
    const source = heads.find(row => row.event.episodeUid === episode.episodeUid);
    if (!source) return [];
    const { candidate, event } = source;
    const option: EpisodeCarryForwardOption = { episodeUid: episode.episodeUid, sourceSubmissionEventId: String(event.eventId), sourceRevisionId: String(event.subjectRevisionId), sourceRecordedAt: String(event.recordedAt || ''), recommendation: String(event.recommendation), state: 'UNAVAILABLE', reason: '历史审阅材料无法精确核验，请重新审阅。' };
    try {
      assertEpisodeSubmissionBindings(event, candidate, episode.episodeUid);
      const frozenSpec = event.schemaVersion === '1.1' ? event.reviewSpec : candidate.reviewSpec;
      if (!(frozenSpec as {hash?: string} | undefined)?.hash || (frozenSpec as {hash: string}).hash !== event.reviewSpecHash) return [option];
      if (event.schemaVersion === '1.1') assertEpisodeSubmissionInput(event,candidate,historical,submissions);
      const findings = parseEpisodeFindings(event.criterionFindings, episode.episodeUid);
      validateEpisodeAction(String(event.recommendation), findings, String(event.note || ''));
      const sourceHash = episodeReviewInputHash(candidate, episode.episodeUid, String(event.reviewSpecHash || ''));
      if (event.reviewInputHash && (event.reviewInputVersion !== EPISODE_REVIEW_INPUT_VERSION || event.reviewInputHash !== sourceHash)) return [option];
      const targetHash = episodeReviewInputHash(target, episode.episodeUid, standardHash);
      return [{ ...option, reviewInputHash: targetHash, state: sourceHash === targetHash ? 'ELIGIBLE' as const : 'CHANGED' as const,
        reason: sourceHash === targetHash ? '本集正文、设计、关联承接与因果依据及审阅标准均未变化，保留原六项判断。' : '本集审阅材料、关联承接／因果依据或标准已有变化，原提交保留为历史，需重新审阅。' }];
    } catch { return [option]; }
  });
}

export function assertEpisodeCarryForward(candidates: EventRecord[], submissions: EventRecord[], target: EventRecord, standardHash: string, episodeUid: string, sourceEventId: string, expectedInputHash: string) {
  // A provenance edge follows one episode only; expanding all episodes at each
  // ancestor would make automatic carry across successive candidates exponential.
  const option = episodeCarryForwardOptions(candidates, submissions, target, standardHash, episodeUid)[0];
  if (!option || option.state !== 'ELIGIBLE' || option.sourceSubmissionEventId !== sourceEventId || option.reviewInputHash !== expectedInputHash) throw new HttpError(409, '沿用依据或原提交头已变化，请重新读取；未写入审阅记录');
  return submissions.find(e => e.eventId === sourceEventId)!;
}

export function assertEpisodeSubmissionInput(event: EventRecord, candidate: EventRecord, candidates: EventRecord[], submissions: EventRecord[]) {
  if (event.schemaVersion === '1.0') return;
  if (event.schemaVersion !== '1.1' || !Number.isSafeInteger(event.eventSequence) || Number(event.eventSequence)<1 || !event.reviewSpec || event.reviewInputVersion !== EPISODE_REVIEW_INPUT_VERSION
    || event.reviewInputHash !== episodeReviewInputHash(candidate, String(event.episodeUid), String(event.reviewSpecHash))) throw new HttpError(409, '分集审阅输入哈希无效');
  if (event.operation === 'SUBMIT_EPISODE' && !event.carryForward) return;
  const provenance = event.carryForward as Record<string, unknown> | undefined;
  if (event.operation !== 'CARRY_FORWARD_EPISODE' || !provenance) throw new HttpError(409, '分集审阅沿用来源缺失');
  const source = assertEpisodeCarryForward(candidates, submissions.filter(e => Number(e.eventSequence) < Number(event.eventSequence)), candidate, String(event.reviewSpecHash), String(event.episodeUid), String(provenance.sourceSubmissionEventId), String(event.reviewInputHash));
  const expected = {sourceSubmissionEventId: source.eventId, sourceRevisionId: source.subjectRevisionId, sourceCandidateHash: source.subjectRevisionHash, sourceReviewSpecHash: source.reviewSpecHash, sourceReviewInputHash: event.reviewInputHash, targetReviewInputHash: event.reviewInputHash, sourceEventHash: stableObjectHash(source)};
  if (stableObjectHash(provenance) !== stableObjectHash(expected) || stableObjectHash(event.criterionFindings) !== stableObjectHash(source.criterionFindings)
    || event.recommendation !== source.recommendation || event.note !== source.note) throw new HttpError(409, '沿用记录与原六项判断不一致');
}
