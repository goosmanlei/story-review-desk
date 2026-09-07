import { narrativeExcerpt, validateNarrativeRevision } from './_narrative-revision';
import {candidateReviewSpec,resolveFormalReviewSpec} from './_review-spec';
import { episodePlanIdFor } from '../../instance-profile';
import { episodePlanContentFromRecord, type EpisodePlanContent, type EpisodePlanContext } from '../../episode-plan-context';
import { episodeExcerptBlocks } from './_episode-evidence';
import { assertCreativeRevisionBasisCurrent, currentCreativeSubjectBaseHash, HttpError, stableObjectHash, type ReviewData, operationalSnapshot } from './_store';

type Operations = Awaited<ReturnType<typeof operationalSnapshot>>;

export function assertEpisodeCandidateContract(candidate: Record<string, unknown>) {
  const content = candidate.content as EpisodePlanContent;
  if (!content || !Array.isArray(content.episodes) || !content.episodes.length || stableObjectHash(content) !== candidate.contentHash) throw new HttpError(409, '分集候选内容校验失败');
  const schemas = new Set(content.episodes.map((episode) => episode.reviewDossier.schemaVersion));
  if (schemas.size !== 1 || !['1.0','1.1'].includes(content.episodes[0].reviewDossier.schemaVersion)) throw new HttpError(409, '整套方案必须使用同一版审阅标准');
  if (schemas.has('1.1') && (candidate.criteriaVersion !== '2.0' || candidate.contextHash !== stableObjectHash({ subjectKind: candidate.subjectKind, subjectId: candidate.subjectId, baseRevisionHash: candidate.baseRevisionHash, basisBindingsHash: candidate.basisBindingsHash, criteriaVersion: '2.0' }))) throw new HttpError(409, '候选审阅标准或上下文校验失败');
  if (schemas.has('1.0') && candidate.criteriaVersion != null && candidate.criteriaVersion !== '1.0') throw new HttpError(409, '卷宗与审阅标准不匹配');
}

export function validateEpisodePlanEvidence(data: ReviewData, content: EpisodePlanContent, adopted = false) {
  const narrative = content.narrativeRevision ? validateNarrativeRevision(data, content.narrativeRevision, adopted) : null;
  return Object.fromEntries(content.episodes.map((episode) => {
    const dossier = episode.reviewDossier;
    if (dossier.schemaVersion !== '1.1') return [episode.episodeUid, { opening: null, ending: null }];
    if (dossier.boundaryEvidence.opening.sceneId !== episode.sceneIds[0] || dossier.boundaryEvidence.ending.sceneId !== episode.sceneIds.at(-1)) throw new HttpError(409, '首尾正文不属于当前分集边界');
    return [episode.episodeUid, Object.fromEntries((['opening', 'ending'] as const).map((key) => [key, {
      sceneId: dossier.boundaryEvidence[key].sceneId, blocks: narrative ? narrativeExcerpt(narrative, dossier.boundaryEvidence[key], key) : episodeExcerptBlocks(data, dossier.boundaryEvidence[key], key),
    }]))];
  })) as EpisodePlanContext['presentation'];
}

/** A requested revision never silently resolves to a different candidate or snapshot. */
export function resolveEpisodePlan(data: ReviewData, operations: Operations, requestedRevisionId?: string | null): EpisodePlanContext | null {
  if (data.snapshotId !== operations.snapshotId) throw new HttpError(409, '分集方案与运行快照不一致，请重新读取');
  const planId = episodePlanIdFor(data);
  const records = data.productionModel.episodePlanRevisions || [];
  const pointers = (data.productionModel as unknown as {revisionPointers?: {currentEpisodePlanRevisionId?: string; episodePlanProposalRevisionId?: string}}).revisionPointers;
  const candidates = operations.creativeRevisions.events.filter((event) => event.subjectKind === 'EPISODE_PLAN' && event.subjectId === planId);
  const latestContent = candidates[0]?.content as EpisodePlanContent | undefined;
  if (requestedRevisionId && latestContent?.narrativeRevision && requestedRevisionId !== candidates[0].creativeRevisionId) {
    const requestedCandidate = candidates.find((event) => event.creativeRevisionId === requestedRevisionId);
    const requested = (requestedCandidate?.content || records.find((record) => record.id === requestedRevisionId || record.creativeRevisionId === requestedRevisionId)) as EpisodePlanContent | undefined;
    const isAdopted = records.some(record=>record.id===pointers?.currentEpisodePlanRevisionId && record.isCurrent && record.scopeRole==='CURRENT' && record.revisionState==='CURRENT' && [record.id,record.creativeRevisionId].includes(requestedRevisionId));
    if (requestedCandidate && !isAdopted || requested?.episodes.some((episode) => latestContent.retiredEpisodeUids.includes(episode.episodeUid))) throw new HttpError(409, '该链接无法用于当前故事方案，请从故事创作重新选择。');
  }
  if (!records.length && !candidates.length) {
    if (requestedRevisionId) throw new HttpError(409, '指定分集方案不可用');
    return null;
  }
  const currentRecord = records.find((record) => record.id === pointers?.currentEpisodePlanRevisionId && record.isCurrent === true && record.scopeRole === 'CURRENT' && record.revisionState === 'CURRENT');
  const possibleCandidate = requestedRevisionId
    ? candidates.find((event) => event.creativeRevisionId === requestedRevisionId)
    : candidates[0];
  const candidate = currentRecord && possibleCandidate && [currentRecord.id, currentRecord.creativeRevisionId].includes(possibleCandidate.creativeRevisionId) ? undefined : possibleCandidate;
  let content: EpisodePlanContent;
  let sourceRole: EpisodePlanContext['sourceRole'];
  let revisionId: string;
  let contentHash: string;
  let contextHash: string | null = null;
  let basisBindingsHash: string | null = null;
  const baseRevisionHash = currentCreativeSubjectBaseHash(data, 'EPISODE_PLAN', planId);
  if (candidate) {
    assertEpisodeCandidateContract(candidate);
    content = candidate.content as EpisodePlanContent;
    if (stableObjectHash(content) !== candidate.contentHash) throw new HttpError(409, '分集候选内容校验失败');
    assertCreativeRevisionBasisCurrent(data, operations.stateProjection, candidate);
    sourceRole = 'CANDIDATE'; revisionId = String(candidate.creativeRevisionId);
    contentHash = String(candidate.contentHash); contextHash = String(candidate.contextHash);
    basisBindingsHash = String(candidate.basisBindingsHash);
  } else {
    const matches = records.filter((record) => record.planId === planId && (
      record.id === pointers?.currentEpisodePlanRevisionId && record.isCurrent && record.scopeRole === 'CURRENT' && record.revisionState === 'CURRENT'
      || record.id === pointers?.episodePlanProposalRevisionId && record.isCurrentProposal && record.scopeRole === 'PROPOSAL' && record.revisionState === 'PROPOSAL'
    ));
    const selected = requestedRevisionId ? matches.find((record) => record.id === requestedRevisionId || record.scopeRole === 'CURRENT' && record.creativeRevisionId === requestedRevisionId) : matches.find((record) => record.scopeRole === 'CURRENT') || matches[0];
    if (!selected) {
      if (!requestedRevisionId && !records.length && !candidates.length) return null;
      throw new HttpError(409, '指定分集方案不可用或已过期；请重新选择方案');
    }
    const record = selected as unknown as EpisodePlanContent & {id: string; scopeRole: 'CURRENT' | 'PROPOSAL'};
    content = episodePlanContentFromRecord({...record,planId});
    sourceRole = record.scopeRole as 'CURRENT' | 'PROPOSAL'; revisionId = record.id; contentHash = stableObjectHash(content);
  }
  if (new Set(content.episodes.map((episode) => episode.reviewDossier.schemaVersion)).size !== 1) throw new HttpError(409, '整套方案必须使用同一版审阅标准');
  const criteriaVersion = content.episodes.every((episode) => episode.reviewDossier.schemaVersion === '1.1') ? '2.0' : '1.0';
  if (candidate && criteriaVersion === '2.0' && (candidate.criteriaVersion !== criteriaVersion || contextHash !== stableObjectHash({subjectKind:'EPISODE_PLAN', subjectId:planId, baseRevisionHash, basisBindingsHash, criteriaVersion}))) throw new HttpError(409, '候选审阅标准或上下文校验失败');
  const profiles = (data as unknown as {characterPerformance?: {profiles?: Array<{character_id:string;name:string}>}}).characterPerformance?.profiles || [];
  const subjectNames = Object.fromEntries(profiles.map((profile) => [profile.character_id,profile.name]));
  return { reviewSpec: candidate ? candidateReviewSpec(data,candidate) : resolveFormalReviewSpec(data,'EPISODE_PLAN',revisionId) || undefined, subjectNames, snapshotId: data.snapshotId, revisionId, sourceRole, contentHash, contextHash, baseRevisionHash, basisBindingsHash, criteriaVersion, content, presentation: validateEpisodePlanEvidence(data, content, sourceRole === 'CURRENT') };
}
