import { assertEpisodeCandidateContract } from '../../_episode-plan';
import { validateNarrativeRevision } from '../../_narrative-revision';
import { appendEvent, assertCreativeRevisionBasisCurrent, operationalSnapshot, assertSha256, assertStableId, assertString, errorResponse, HttpError, jsonResponse, listAllEvents, mutationRequestHash, projectScriptCommentEvents, replayIdempotentEvent, stableObjectHash, validateMutationRequest } from '../../_store';

/** Close against exact replacement text; preserve readable history and original identity. */
export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('script-comment', body);
    const replay = await replayIdempotentEvent('script-comment', idempotencyKey, rawRequestHash);
    if (replay) return jsonResponse({ eventId: replay.event.eventId, replayed: true, mutationEtag: replay.operations.mutationEtag });
    if (body.snapshotId !== data.snapshotId) throw new HttpError(412, '评论清理必须绑定当前快照');
    const commentId = assertStableId(body.commentId, 'commentId');
    const expectedLatestEventId = assertStableId(body.expectedLatestEventId, 'expectedLatestEventId');
    const commentRevisionId = assertStableId(body.commentRevisionId, 'commentRevisionId');
    const candidateRevisionId = assertStableId(body.candidateRevisionId, 'candidateRevisionId');
    const candidateContentHash = assertSha256(body.candidateContentHash, 'candidateContentHash');
    const resolutionNote = assertString(body.resolutionNote, 'resolutionNote', 20000);
    const all = await listAllEvents('creative-revision');
    const candidate = all.find((event) => event.creativeRevisionId === candidateRevisionId && event.subjectKind === 'EPISODE_PLAN');
    if (!candidate || candidate.contentHash !== candidateContentHash || all.find((event) => event.subjectKind === 'EPISODE_PLAN' && event.subjectId === candidate.subjectId)?.eventId !== candidate.eventId) throw new HttpError(409, '评论处理目标必须是精确的最新完整候选');
    assertEpisodeCandidateContract(candidate);
    assertCreativeRevisionBasisCurrent(data, (await operationalSnapshot()).stateProjection, candidate);
    const narrative = validateNarrativeRevision(data, (candidate.content as Record<string, unknown>).narrativeRevision);
    const thread = projectScriptCommentEvents(await listAllEvents('script-comment')).find((thread) => thread.commentId === commentId);
    if (!thread || thread.archived || thread.latestEventId !== expectedLatestEventId || thread.commentRevisionId !== commentRevisionId) throw new HttpError(409, '评论已变化或已归档，请重新核对');
    if (!Array.isArray(body.sceneBindings) || !body.sceneBindings.length) throw new HttpError(422, '须提供解决意见的精确新稿正文块');
    const sceneBindings = body.sceneBindings.map((raw) => {
      const ref = raw as Record<string, unknown>;
      const scene = narrative.scenes.find((scene) => scene.id === ref.sceneId && scene.oldSceneIds.includes(thread.sceneId));
      if (!scene || scene.contentHash !== ref.contentHash || !Array.isArray(ref.blockIds) || !ref.blockIds.length || new Set(ref.blockIds).size !== ref.blockIds.length) throw new HttpError(409, '意见处理场次或哈希不匹配');
      const blocks = ref.blockIds.map((id) => scene.scriptBlocks.find((block) => block.id === id));
      if (blocks.some((block) => !block) || stableObjectHash(blocks) !== ref.blocksHash) throw new HttpError(409, '意见处理正文块哈希不匹配');
      return { sceneId: scene.id, contentHash: scene.contentHash, blockIds: ref.blockIds, blocksHash: String(ref.blocksHash) };
    });
    const semantic = { snapshotId: data.snapshotId, commentId, commentRevisionId, expectedLatestEventId,
      sceneId: thread.sceneId, commentAction: 'RESOLVE_WITH_HISTORY', resolutionStatus: 'RESOLVED', visibility: 'CLOSED_HISTORY',
      resolutionNote, resolutionTarget: { candidateRevisionId, candidateContentHash, sceneBindings },
      previousStatus: thread.status, physicalHistoryDeleted: false };
    const result = await appendEvent('script-comment', idempotencyKey, mutationRequestHash('script-comment', semantic), ifMatch,
      { ...semantic, rawRequestHash }, '1.2', async (locked) => {
        const current = projectScriptCommentEvents(await listAllEvents('script-comment')).find((item) => item.commentId === commentId);
        const currentCandidate = (await listAllEvents('creative-revision')).find((event) => event.subjectKind === 'EPISODE_PLAN' && event.subjectId === candidate.subjectId);
        if (!currentCandidate || !current || current.latestEventId !== expectedLatestEventId || current.commentRevisionId !== commentRevisionId || currentCandidate?.eventId !== candidate.eventId) throw new HttpError(409, '评论或候选在清理前发生变化');
        assertCreativeRevisionBasisCurrent(data, locked.stateProjection, currentCandidate);
      });
    return jsonResponse({ eventId: result.event.eventId, commentId, resolutionStatus: 'RESOLVED', visibility: 'CLOSED_HISTORY', physicalHistoryDeleted: false, mutationEtag: result.operations.mutationEtag }, {status: 201});
  } catch (reason) { return errorResponse(reason, '评论关闭与历史保留未完成'); }
}
