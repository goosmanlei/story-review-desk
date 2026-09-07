import { readClosedHistory } from './_history';
import { getStoryComments, postStoryComment } from './_story';
import {
  appendEvent,
  assertSha256,
  assertStableId,
  errorResponse,
  eventLimit,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  operationalSnapshot,
  optionalString,
  projectScriptCommentEvents,
  replayIdempotentEvent,
  reviewData,
  scriptCommentTextHash,
  storyConfirmationTargets,
  validateMutationRequest,
  type ReviewData,
  type ScriptCommentProjection,
} from '../_store';
import { currentSceneCommentTarget, parseSceneCommentAnchor } from './_context';

const actions = new Set(['CREATE', 'EDIT', 'ASSIGN_AI', 'AI_START', 'RESOLVE_USER', 'RESOLVE_AI', 'REOPEN']);
const schemaVersions = new Set(['1.0', '1.1']);
const statuses = new Set(['OPEN', 'AI_QUEUED', 'AI_PROCESSING', 'RESOLVED']);
function decorateThread(data: ReviewData, thread: ScriptCommentProjection) {
  const target = storyConfirmationTargets(data).find((item) => String(item.sceneId || '') === thread.sceneId);
  const currentSceneContentHash = String(target?.sceneContentHash || '').toLowerCase();
  const currentBusinessContextHash = String(target?.businessContextHash || '').toLowerCase();
  const reasons: string[] = [];
  if (!target) reasons.push('SCENE_COMMENT_TARGET_UNAVAILABLE');
  if (target && thread.sceneContentHash.toLowerCase() !== currentSceneContentHash) reasons.push('SCENE_CONTENT_HASH_CHANGED');
  if (target && thread.businessContextHash.toLowerCase() !== currentBusinessContextHash) reasons.push('BUSINESS_CONTEXT_HASH_CHANGED');
  let anchorMatchesCurrentText = false;
  if (target) {
    try {
      parseSceneCommentAnchor(data, thread.sceneId, thread.anchor);
      anchorMatchesCurrentText = true;
    } catch {
      reasons.push('ANCHOR_TEXT_CHANGED_OR_BLOCK_UNAVAILABLE');
    }
  }
  const resolutionAlignedToCurrent = thread.status === 'RESOLVED'
    && Boolean(target)
    && thread.alignedSceneContentHash?.toLowerCase() === currentSceneContentHash;
  return {
    ...thread,
    anchorMatchesCurrentText,
    applicabilityState: reasons.length ? 'STALE' : 'CURRENT',
    staleReasons: [...new Set(reasons)],
    resolutionAlignedToCurrent,
    currentSceneContentHash: currentSceneContentHash || null,
    currentBusinessContextHash: currentBusinessContextHash || null,
  };
}


export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sceneId = url.searchParams.get('sceneId');
    const status = url.searchParams.get('status');
    const limit = eventLimit(url.searchParams.get('limit'), 500);
    if (sceneId) assertStableId(sceneId, 'sceneId');
    if (status && !statuses.has(status)) throw new HttpError(400, 'status is invalid');
    const data = await reviewData();
    const operations = await operationalSnapshot();
    if (url.searchParams.has('revisionId')) return await getStoryComments(data,operations,url);
    const current=operations.scriptComments.threads.filter(thread=>!thread.archived&&(!sceneId||thread.sceneId===sceneId)).map(thread=>decorateThread(data,thread));
    const history=readClosedHistory(operations,url,{snapshotId:data.snapshotId,sceneId},current);
    const metadata={schemaVersion:'1.3',snapshotId:data.snapshotId,mutationEtag:operations.mutationEtag,operationalRevision:operations.operationalRevision};
    if(['page','detail'].includes(url.searchParams.get('history')||'')||status==='RESOLVED')return jsonResponse({...metadata,...history},{headers:{ETag:operations.etag}});
    const threads=current.filter(thread=>thread.status!=='RESOLVED'&&(!status||thread.status===status)).slice(0,limit);
    return jsonResponse({...metadata,threads,count:threads.length,...history},{headers:{ETag:operations.etag}});
  } catch (reason) {
    return errorResponse(reason, 'script comments are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('script-comment', body);
    const replay = await replayIdempotentEvent('script-comment', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        replayed: true,
        event: replay.event,
        mutationEtag: replay.operations.mutationEtag,
        operationalRevision: replay.operations.operationalRevision,
      }, { headers: { ETag: replay.operations.etag } });
    }

    if (body.schemaVersion === '1.2') return await postStoryComment(data,body,idempotencyKey,ifMatch,rawRequestHash);
    const requestSchemaVersion = optionalString(body.schemaVersion, 16) || '1.0';
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const commentAction = assertStableId(body.commentAction || body.action, 'commentAction', 32);
    const commentId = assertStableId(body.commentId, 'commentId');
    const sceneId = assertStableId(body.sceneId, 'sceneId');
    if (!schemaVersions.has(requestSchemaVersion)) throw new HttpError(409, 'script comments require schemaVersion 1.0 or 1.1');
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    if (!actions.has(commentAction)) throw new HttpError(400, 'commentAction is invalid');
    if (commentAction === 'EDIT' && requestSchemaVersion !== '1.1') {
      throw new HttpError(409, 'EDIT requires schemaVersion 1.1');
    }
    const target = currentSceneCommentTarget(data, sceneId);
    const currentSceneContentHash = assertSha256(target.sceneContentHash, 'current target sceneContentHash');
    const currentBusinessContextHash = assertSha256(target.businessContextHash, 'current target businessContextHash');
    const suppliedSceneContentHash = assertSha256(body.sceneContentHash, 'sceneContentHash');
    const suppliedBusinessContextHash = assertSha256(body.businessContextHash, 'businessContextHash');
    const commentText = optionalString(body.commentText, 20_000);
    const resolutionNote = optionalString(body.resolutionNote, 20_000);
    const suppliedCommentRevisionId = body.commentRevisionId == null || body.commentRevisionId === ''
      ? ''
      : assertStableId(body.commentRevisionId, 'commentRevisionId');
    const suppliedAlignedHash = body.alignedSceneContentHash == null || body.alignedSceneContentHash === ''
      ? ''
      : assertSha256(body.alignedSceneContentHash, 'alignedSceneContentHash');

    let anchor: ReturnType<typeof parseSceneCommentAnchor> | Record<string, unknown>;
    let semanticRequest: Record<string, unknown>;
    let existingThread: ScriptCommentProjection | null = null;
    if (commentAction === 'CREATE') {
      if (suppliedSceneContentHash !== currentSceneContentHash || suppliedBusinessContextHash !== currentBusinessContextHash) {
        throw new HttpError(409, 'script comment binding is stale; reload the current scene before creating a comment');
      }
      if (!commentText) throw new HttpError(422, 'CREATE requires commentText');
      if (suppliedCommentRevisionId) throw new HttpError(422, 'CREATE cannot include commentRevisionId');
      if (resolutionNote || suppliedAlignedHash) throw new HttpError(422, 'CREATE cannot include resolution fields');
      anchor = parseSceneCommentAnchor(data, sceneId, body.anchor);
      semanticRequest = {
        schemaVersion: '1.1', snapshotId, creationSnapshotId: snapshotId, commentAction, commentId, sceneId,
        sceneContentHash: suppliedSceneContentHash, businessContextHash: suppliedBusinessContextHash,
        anchor, commentText, commentTextHash: scriptCommentTextHash(commentText), initialStatus: 'AI_QUEUED',
      };
    } else {
      existingThread = projectScriptCommentEvents(await listAllEvents('script-comment')).find((item) => item.commentId === commentId) || null;
      if (!existingThread || existingThread.sceneId !== sceneId) throw new HttpError(422, 'commentId does not resolve in the requested scene');
      if (existingThread.archived) throw new HttpError(409, '已归档历史只读保留，请在当前文字上另建评论');
      if (suppliedSceneContentHash !== existingThread.sceneContentHash.toLowerCase() || suppliedBusinessContextHash !== existingThread.businessContextHash.toLowerCase()) {
        throw new HttpError(409, 'comment thread binding does not match its immutable creation event');
      }
      const revisionBoundAiAction = ['AI_START', 'RESOLVE_AI'].includes(commentAction);
      const revisionRequired = commentAction === 'EDIT'
        || (revisionBoundAiAction && (requestSchemaVersion === '1.1' || existingThread.editCount > 0));
      if (revisionRequired && !suppliedCommentRevisionId) {
        throw new HttpError(422, `${commentAction} requires commentRevisionId`);
      }
      if (suppliedCommentRevisionId && suppliedCommentRevisionId !== existingThread.commentRevisionId) {
        throw new HttpError(409, 'commentRevisionId is stale; reload the current comment before continuing', {
          currentCommentRevisionId: existingThread.commentRevisionId,
        });
      }
      if (commentAction === 'EDIT') {
        if (existingThread.status === 'RESOLVED') throw new HttpError(409, 'a resolved comment cannot be edited');
        if (!commentText) throw new HttpError(422, 'EDIT requires commentText');
        if (commentText === existingThread.commentText.trim()) throw new HttpError(409, 'EDIT requires a changed commentText');
        if (resolutionNote) throw new HttpError(422, 'EDIT cannot include resolutionNote');
        if (suppliedAlignedHash !== currentSceneContentHash) {
          throw new HttpError(409, 'editing a comment must align to the current scene content hash');
        }
        parseSceneCommentAnchor(data, sceneId, existingThread.anchor);
      } else if (commentText) {
        throw new HttpError(422, 'only CREATE or EDIT can include commentText');
      }
      if (commentAction === 'ASSIGN_AI' && existingThread.status !== 'OPEN') throw new HttpError(409, 'only an open comment can be assigned to AI');
      if (commentAction === 'AI_START' && existingThread.status !== 'AI_QUEUED') throw new HttpError(409, 'AI_START requires an AI-queued comment');
      if (commentAction === 'RESOLVE_AI' && !['AI_QUEUED', 'AI_PROCESSING'].includes(existingThread.status)) throw new HttpError(409, 'RESOLVE_AI requires an AI-assigned comment');
      if (['RESOLVE_USER', 'RESOLVE_AI'].includes(commentAction)) {
        if (existingThread.status === 'RESOLVED') throw new HttpError(409, 'comment is already resolved');
        if (suppliedAlignedHash !== currentSceneContentHash) throw new HttpError(409, 'closing a comment must align to the current scene content hash');
        if (commentAction === 'RESOLVE_AI' && !resolutionNote) throw new HttpError(422, 'RESOLVE_AI requires a concrete resolutionNote');
      } else if (commentAction !== 'EDIT' && (resolutionNote || suppliedAlignedHash)) {
        throw new HttpError(422, 'resolution fields are only valid when closing or editing a comment');
      }
      if (commentAction === 'REOPEN') {
        if (existingThread.status !== 'RESOLVED') throw new HttpError(409, 'only a resolved comment can be reopened');
        if (existingThread.sceneContentHash.toLowerCase() !== currentSceneContentHash || existingThread.businessContextHash.toLowerCase() !== currentBusinessContextHash) {
          throw new HttpError(409, 'a comment anchored to an older scene revision cannot be reopened; select the current passage and create a new comment');
        }
      }
      anchor = existingThread.anchor;
      const effectiveCommentRevisionId = suppliedCommentRevisionId
        || (revisionBoundAiAction ? existingThread.commentRevisionId : '');
      semanticRequest = commentAction === 'EDIT'
        ? {
          schemaVersion: '1.1', snapshotId, commentAction, commentId, sceneId,
          creationSnapshotId: existingThread.creationSnapshotId,
          sceneContentHash: existingThread.sceneContentHash,
          businessContextHash: existingThread.businessContextHash,
          anchor,
          commentRevisionId: suppliedCommentRevisionId,
          commentText,
          commentTextHash: scriptCommentTextHash(commentText),
          editAlignedSnapshotId: snapshotId,
          editAlignedSceneContentHash: suppliedAlignedHash,
        }
        : {
          schemaVersion: '1.1', snapshotId, commentAction, commentId, sceneId,
          creationSnapshotId: existingThread.creationSnapshotId,
          sceneContentHash: existingThread.sceneContentHash,
          businessContextHash: existingThread.businessContextHash,
          anchor,
          ...(effectiveCommentRevisionId ? { commentRevisionId: effectiveCommentRevisionId } : {}),
          alignedSnapshotId: ['RESOLVE_USER', 'RESOLVE_AI'].includes(commentAction) ? snapshotId : null,
          alignedSceneContentHash: ['RESOLVE_USER', 'RESOLVE_AI'].includes(commentAction) ? suppliedAlignedHash : null,
          resolutionNote: ['RESOLVE_USER', 'RESOLVE_AI'].includes(commentAction)
            ? resolutionNote || '用户确认该评论已处理。'
            : null,
        };
    }

    const { event, replayed, operations } = await appendEvent(
      'script-comment',
      idempotencyKey,
      mutationRequestHash('script-comment', semanticRequest),
      ifMatch,
      { ...semanticRequest, rawRequestHash },
      '1.1',
      async () => {
        const current = projectScriptCommentEvents(await listAllEvents('script-comment')).find((item) => item.commentId === commentId) || null;
        if (commentAction === 'CREATE' && (await listAllEvents('script-comment')).some((event) => event.commentId === commentId)) throw new HttpError(409, 'commentId already exists or was retired');
        if (commentAction !== 'CREATE') {
          if (
            !current || !existingThread
            || current.latestEventId !== existingThread.latestEventId
            || current.commentRevisionId !== existingThread.commentRevisionId
            || current.status !== existingThread.status
          ) {
            throw new HttpError(409, 'comment changed while the action was prepared; reload and try again');
          }
          if (suppliedCommentRevisionId && current.commentRevisionId !== suppliedCommentRevisionId) {
            throw new HttpError(409, 'comment revision changed while the action was prepared; reload and try again');
          }
        }
      },
    );
    return jsonResponse({
      eventId: event.eventId,
      commentId,
      replayed,
      event,
      mutationEtag: operations.mutationEtag,
      operationalRevision: operations.operationalRevision,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'invalid script comment event');
  }
}
