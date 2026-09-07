import { storyCommentPolishContext } from '../_story';
import { createHash } from 'node:crypto';
import {
  assertSha256,
  assertStableId,
  errorResponse,
  hostedReadOnlyMode,
  HttpError,
  jsonResponse,
  operationalSnapshot,
  optionalString,
  validateMutationRequest,
} from '../../_store';
import {
  buildSceneCommentPolishContext,
  currentSceneCommentTarget,
  parseSceneCommentAnchor,
} from '../_context';

const allowedBodyFields = new Set([
  'revisionId',
  'target',
  'schemaVersion',
  'snapshotId',
  'sceneId',
  'sceneContentHash',
  'businessContextHash',
  'anchor',
  'commentDraft',
]);
const maxRequestBytes = 64 * 1024;
const workerTimeoutMs = 30_000;
const safeWorkerErrorCodes = new Set([
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_ALREADY_COMPLETED',
  'IDEMPOTENCY_LEDGER_UNAVAILABLE',
  'INVALID_PROVIDER_OUTPUT',
  'INVALID_REQUEST',
  'PROVIDER_AUTH',
  'PROVIDER_CONFIGURATION',
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNREACHABLE',
  'RESULT_UNKNOWN',
  'WORKER_ERROR',
]);

async function requestBody(request: Request) {
  const type = request.headers.get('content-type')?.toLowerCase() || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'content type must be application/json');
  const announced = Number(request.headers.get('content-length') || 0);
  if (announced > maxRequestBytes) throw new HttpError(413, 'comment polish request is too large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxRequestBytes) throw new HttpError(413, 'comment polish request is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'comment polish request body is invalid');
  }
  return parsed as Record<string, unknown>;
}

function workerUrl() {
  const value = process.env.COMMENT_POLISH_WORKER_URL || '';
  if (!value) throw new HttpError(503, 'AI润色服务尚未配置');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(503, 'AI润色服务配置无效');
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new HttpError(503, 'AI润色服务配置无效');
  }
  if (!['comment-polish-worker', '127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new HttpError(503, 'AI润色服务必须运行在本机受控网络');
  }
  return parsed.href.replace(/\/$/, '');
}

function sanitizedWorkerError(status: number, payload: unknown, requestId: string) {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const candidateCode = typeof value.code === 'string' ? value.code : '';
  const code = safeWorkerErrorCodes.has(candidateCode) ? candidateCode : 'WORKER_ERROR';
  const resultState = value.resultState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
  const details = { code, resultState, requestId };
  if (status === 429) {
    return new HttpError(429, 'OpenAI当前繁忙，本次没有自动重试', {
      ...details,
      code: 'PROVIDER_RATE_LIMITED',
    });
  }
  if (status === 504 || resultState === 'UNKNOWN') {
    return new HttpError(504, 'AI润色结果状态未知，本次没有自动重试；请保留请求编号后核查', {
      ...details,
      code: code === 'PROVIDER_TIMEOUT' ? code : 'RESULT_UNKNOWN',
      resultState: 'UNKNOWN',
    });
  }
  if (status === 503) return new HttpError(503, 'AI润色服务或OpenAI权限尚未就绪', details);
  if ([400, 409, 413, 415].includes(status)) return new HttpError(status, 'AI润色请求未通过安全校验', details);
  return new HttpError(502, 'AI润色暂时无法完成，本次没有自动重试', details);
}

function workerOutputText(payload: unknown, name: string, max: number) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(502, 'AI润色工作器返回了无效响应', { code: 'INVALID_WORKER_OUTPUT' });
  }
  const value = (payload as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(502, 'AI润色工作器返回了无效响应', { code: 'INVALID_WORKER_OUTPUT' });
  }
  return value.trim();
}

export async function POST(request: Request) {
  try {
    if (hostedReadOnlyMode()) {
      throw new HttpError(405, 'chatgpt.site is a read-only mirror; AI comment polishing is available only at http://localhost:3000');
    }
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await requestBody(request);
    const extraFields = Object.keys(body).filter((key) => !allowedBodyFields.has(key));
    if (extraFields.length) throw new HttpError(400, 'comment polish request contains unsupported fields');
    const schemaVersion = optionalString(body.schemaVersion, 16) || '1.0';
    if (!['1.0', '1.1','1.2'].includes(schemaVersion)) {
      throw new HttpError(409, 'comment polishing requires schemaVersion 1.0 or 1.1');
    }

    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const story = schemaVersion==='1.2' ? storyCommentPolishContext(data,await operationalSnapshot(),body) : null;
    const sceneId = story?.target.subjectId || assertStableId(body.sceneId, 'sceneId');
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    const target = story?{sceneContentHash:story.target.contentHash,businessContextHash:story.target.contextHash}:currentSceneCommentTarget(data, sceneId);
    const sceneContentHash = assertSha256(story?.target.contentHash || body.sceneContentHash, 'sceneContentHash');
    const businessContextHash = assertSha256(story?.target.contextHash || body.businessContextHash, 'businessContextHash');
    if (sceneContentHash !== assertSha256(target.sceneContentHash, 'current target sceneContentHash')
      || businessContextHash !== assertSha256(target.businessContextHash, 'current target businessContextHash')) {
      throw new HttpError(409, 'comment polish binding is stale; reload the current scene');
    }
    const anchor = story?.anchor || parseSceneCommentAnchor(data, sceneId, body.anchor);
    if (!Object.prototype.hasOwnProperty.call(body, 'commentDraft') || typeof body.commentDraft !== 'string') {
      throw new HttpError(400, 'commentDraft must be an explicit string');
    }
    const commentDraft = optionalString(body.commentDraft, 20_000);
    if (schemaVersion !== '1.1' && !commentDraft) {
      throw new HttpError(400, 'schemaVersion 1.0 requires a non-empty commentDraft');
    }
    const requestMode = commentDraft ? 'POLISH_DRAFT' : 'SUGGEST_FROM_CONTEXT';
    const sceneContext = story?.sceneContext || buildSceneCommentPolishContext(data, sceneId, anchor);

    const operations = await operationalSnapshot();
    if (ifMatch !== operations.etagValue) {
      throw new HttpError(412, 'operational snapshot changed before AI polishing could start', {
        currentEtag: operations.etag,
        mutationEtag: operations.mutationEtag,
      });
    }
    const inputBindingHash = createHash('sha256').update(JSON.stringify({
      snapshotId,
      sceneId,
      sceneContentHash,
      businessContextHash,
      anchorHash: anchor.anchorHash,
      dossierHash: sceneContext.dossierHash,
      transcriptSha256: sceneContext.transcriptSha256,
      commentDraft,
      requestMode,
    })).digest('hex');
    const workerInput = {
      requestId: idempotencyKey,
      inputBindingHash,
      snapshotId,
      sceneId,
      sceneTitle: sceneContext.sceneTitle,
      sceneContentHash,
      businessContextHash,
      dossierHash: sceneContext.dossierHash,
      transcriptSha256: sceneContext.transcriptSha256,
      sceneScript: sceneContext.sceneScript,
      selectionText: sceneContext.selectionText,
      selectionPrefix: sceneContext.selectionPrefix,
      selectionSuffix: sceneContext.selectionSuffix,
      directSourceSegments: sceneContext.directSourceSegments,
      relatedContext: sceneContext.relatedContext,
      commentDraft,
      requestMode,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), workerTimeoutMs);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(`${workerUrl()}/v1/comment-polish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Comment-Polish-Protocol': 'review-comment-polish-v1',
        },
        body: JSON.stringify(workerInput),
        signal: controller.signal,
      });
      try {
        payload = await response.json();
      } catch (reason) {
        if (controller.signal.aborted || (reason as { name?: string })?.name === 'AbortError') throw reason;
        throw new HttpError(502, 'AI润色工作器返回了无效响应', {
          code: 'INVALID_WORKER_OUTPUT',
          resultState: 'FAILED',
          requestId: idempotencyKey,
        });
      }
    } catch (reason) {
      if (reason instanceof HttpError) throw reason;
      if (controller.signal.aborted || (reason as { name?: string })?.name === 'AbortError') {
        throw new HttpError(504, 'AI润色结果状态未知，本次没有自动重试；请保留请求编号后核查', {
          code: 'RESULT_UNKNOWN',
          resultState: 'UNKNOWN',
          requestId: idempotencyKey,
        });
      }
      throw new HttpError(503, '本地AI润色工作器不可用', {
        code: 'WORKER_UNAVAILABLE',
        resultState: 'FAILED',
        requestId: idempotencyKey,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw sanitizedWorkerError(response.status, payload, idempotencyKey);
    }
    const result = payload as Record<string, unknown>;
    const polishedComment = workerOutputText(result, 'polishedComment', 4_000);
    const model = workerOutputText(result, 'model', 128);
    return jsonResponse({
      schemaVersion: '1.1',
      snapshotId,
      sceneId,
      sceneContentHash,
      businessContextHash,
      anchorHash: anchor.anchorHash,
      inputBindingHash,
      requestMode,
      polishedComment,
      model,
      sourceContext: {
        directBeatCount: sceneContext.directSourceSegments.length,
        relatedBeatCount: sceneContext.relatedContext.length,
      },
      requestId: idempotencyKey,
      replayed: result.replayed === true,
    }, { headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'AI comment polishing failed');
  }
}
