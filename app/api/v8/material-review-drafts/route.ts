import {
  assertSha256,
  assertStableId,
  errorResponse,
  hostedReadOnlyMode,
  HttpError,
  jsonResponse,
  operationalSnapshot,
  reviewData,
  validateMutationRequest,
} from '../_store';
import { buildMaterialReviewAuthorityContext, type MaterialReviewAuthorityContext } from './_context';

const allowedBodyFields = new Set(['schemaVersion', 'snapshotId', 'requirementId', 'familyId', 'versionId', 'versionSha256', 'contextHash', 'reviewSpecHash']);
const maxRequestBytes = 24 * 1024;
const workerTimeoutMs = 45_000;
const safeWorkerErrorCodes = new Set([
  'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_ALREADY_COMPLETED', 'IDEMPOTENCY_LEDGER_UNAVAILABLE',
  'INVALID_PROVIDER_OUTPUT', 'INVALID_REQUEST', 'MEDIA_CHANGED', 'MEDIA_UNSUPPORTED',
  'PROVIDER_AUTH', 'PROVIDER_CONFIGURATION', 'PROVIDER_ERROR', 'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT', 'RESULT_UNKNOWN', 'WORKER_ERROR',
]);

async function requestBody(request: Request) {
  const type = request.headers.get('content-type')?.toLowerCase() || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'content type must be application/json');
  const announced = Number(request.headers.get('content-length') || 0);
  if (announced > maxRequestBytes) throw new HttpError(413, 'material AI review request is too large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxRequestBytes) throw new HttpError(413, 'material AI review request is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new HttpError(400, 'request body is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'material AI review request body is invalid');
  return parsed as Record<string, unknown>;
}

function workerUrl() {
  const value = process.env.MATERIAL_REVIEW_WORKER_URL || '';
  if (!value) throw new HttpError(503, '素材AI Review服务尚未配置');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new HttpError(503, '素材AI Review服务配置无效'); }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new HttpError(503, '素材AI Review服务配置无效');
  }
  if (!['material-review-worker', '127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new HttpError(503, '素材AI Review服务必须运行在本机受控网络');
  }
  return parsed.href.replace(/\/$/, '');
}

function safeWorkerError(status: number, payload: unknown, requestId: string) {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const candidate = typeof value.code === 'string' ? value.code : '';
  const code = safeWorkerErrorCodes.has(candidate) ? candidate : 'WORKER_ERROR';
  const resultState = value.resultState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
  if (status === 504 || resultState === 'UNKNOWN') {
    return new HttpError(504, 'AI Review结果状态未知，本次没有自动重试；请保留请求编号后核查', { code: code === 'PROVIDER_TIMEOUT' ? code : 'RESULT_UNKNOWN', resultState: 'UNKNOWN', requestId });
  }
  if (status === 429) return new HttpError(429, 'OpenAI当前繁忙，本次没有自动重试', { code: 'PROVIDER_RATE_LIMITED', resultState, requestId });
  if (status === 503) return new HttpError(503, '素材AI Review服务或OpenAI权限尚未就绪', { code, resultState, requestId });
  if ([400, 409, 413, 415].includes(status)) return new HttpError(status, '素材AI Review请求未通过安全校验', { code, resultState, requestId });
  return new HttpError(502, '素材AI Review暂时无法完成，本次没有自动重试', { code, resultState, requestId });
}

function strings(value: unknown, maxItems = 80, maxLength = 2_000) {
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(502, 'AI Review工作器返回了无效列表');
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLength) throw new HttpError(502, 'AI Review工作器返回了无效文本');
    return item.trim();
  });
}

function validateDraft(payload: unknown, context: MaterialReviewAuthorityContext) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(502, 'AI Review工作器返回了无效响应');
  const value = payload as Record<string, unknown>;
  const draft = value.draft && typeof value.draft === 'object' && !Array.isArray(value.draft) ? value.draft as Record<string, unknown> : null;
  if (!draft) throw new HttpError(502, 'AI Review工作器没有返回结构化草稿');
  const expectedIds = context.requirement.acceptanceCriteria.map((item) => item.criterionId);
  const rawFindings = Array.isArray(draft.criterionFindings) ? draft.criterionFindings : [];
  if (rawFindings.length !== expectedIds.length) throw new HttpError(502, 'AI Review工作器没有逐项覆盖验收口径');
  const allowedEvidence = new Set(context.evidenceRefs);
  const findings = rawFindings.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(502, 'AI Review工作器返回了无效判断项');
    const item = raw as Record<string, unknown>;
    const criterionId = String(item.criterionId || '');
    if (criterionId !== expectedIds[index]) throw new HttpError(502, 'AI Review判断项与权威验收口径不一致');
    const verdict = String(item.verdict || '');
    if (!['PASS', 'FAIL', 'NA', 'UNKNOWN'].includes(verdict)) throw new HttpError(502, 'AI Review判断项包含无效结论');
    if (context.observationMode === 'METADATA_ONLY' && !['NA', 'UNKNOWN'].includes(verdict)) {
      throw new HttpError(502, 'AI Review未观察原始媒体，不得返回感知性通过或失败结论');
    }
    const note = typeof item.note === 'string' && item.note.trim() && item.note.length <= 4_000 ? item.note.trim() : null;
    if (!note) throw new HttpError(502, 'AI Review判断项缺少有效说明');
    const evidenceRefs = strings(item.evidenceRefs, 20, 500);
    if (evidenceRefs.some((ref) => !allowedEvidence.has(ref))) throw new HttpError(502, 'AI Review引用了未提供的证据');
    return { criterionId, verdict: verdict as 'PASS' | 'FAIL' | 'NA' | 'UNKNOWN', note, evidenceRefs };
  });
  const recommendation = String(draft.qualityRecommendation || '');
  if (!['QUALITY_PASS_ON_OBSERVED_EVIDENCE', 'REQUEST_REVISION', 'DO_NOT_USE', 'INSUFFICIENT_EVIDENCE'].includes(recommendation)) {
    throw new HttpError(502, 'AI Review工作器返回了无效质量建议');
  }
  const overallNote = typeof draft.overallNote === 'string' && draft.overallNote.trim() && draft.overallNote.length <= 8_000 ? draft.overallNote.trim() : null;
  if (!overallNote) throw new HttpError(502, 'AI Review工作器缺少总体说明');
  const revision = draft.revisionInstructions && typeof draft.revisionInstructions === 'object' && !Array.isArray(draft.revisionInstructions)
    ? draft.revisionInstructions as Record<string, unknown>
    : null;
  const revisionInstructions = revision ? {
    preserve: strings(revision.preserve),
    change: strings(revision.change),
    mustNotRegress: strings(revision.mustNotRegress),
  } : null;
  const observations = strings(value.observations || [], 80, 2_000);
  const unobserved = strings(value.unobserved || [], 80, 2_000);
  const verdicts = findings.map((item) => item.verdict);
  const hasPass = verdicts.includes('PASS');
  const hasFail = verdicts.includes('FAIL');
  const hasUnknown = verdicts.includes('UNKNOWN');
  if (recommendation === 'QUALITY_PASS_ON_OBSERVED_EVIDENCE' && (!hasPass || hasFail || hasUnknown)) {
    throw new HttpError(502, 'AI Review质量建议与逐项判断矛盾');
  }
  if (recommendation === 'REQUEST_REVISION' && (!hasFail || !revisionInstructions?.change.length)) {
    throw new HttpError(502, 'AI Review返修建议缺少失败项或明确修改要求');
  }
  if (recommendation === 'DO_NOT_USE' && !hasFail) {
    throw new HttpError(502, 'AI Review禁用建议缺少失败项');
  }
  if (context.observationMode === 'METADATA_ONLY' && !unobserved.length) throw new HttpError(502, 'metadata-only AI Review must declare unobserved perceptual evidence');
  const qualityRecommendation = context.observationMode === 'METADATA_ONLY'
    ? 'INSUFFICIENT_EVIDENCE' as const
    : recommendation as 'QUALITY_PASS_ON_OBSERVED_EVIDENCE' | 'REQUEST_REVISION' | 'DO_NOT_USE' | 'INSUFFICIENT_EVIDENCE';
  return {
    summary: overallNote,
    criterionFindings: findings,
    qualityRecommendation,
    overallNote,
    revisionInstructions,
    observations,
    unobserved,
  };
}

export async function POST(request: Request) {
  try {
    if (hostedReadOnlyMode()) throw new HttpError(405, 'chatgpt.site is a read-only mirror; material AI Review is available only at http://localhost:3000');
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await requestBody(request);
    const extra = Object.keys(body).filter((key) => !allowedBodyFields.has(key));
    if (extra.length) throw new HttpError(400, 'material AI review request contains unsupported fields');
    if (body.schemaVersion !== '1.0') throw new HttpError(409, 'material AI review requires schemaVersion 1.0');
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    const requirementId = assertStableId(body.requirementId, 'requirementId');
    const familyId = assertStableId(body.familyId, 'familyId');
    const versionId = assertStableId(body.versionId, 'versionId');
    const versionSha256 = assertSha256(body.versionSha256, 'versionSha256');
    const contextHash = assertSha256(body.contextHash, 'contextHash');
    const operations = await operationalSnapshot();
    if (ifMatch !== operations.etagValue) throw new HttpError(412, 'operational snapshot changed before AI Review could start', { currentEtag: operations.etag, mutationEtag: operations.mutationEtag });
    const context = await buildMaterialReviewAuthorityContext({ data, stateProjection: operations.stateProjection as unknown as Record<string, unknown>, requirementId, familyId, versionId, versionSha256, contextHash });
    if (data.productionModel.systemConfiguration && body.reviewSpecHash !== context.reviewSpec?.hash) throw new HttpError(409,"审阅标准已变化，请重新读取");

    const materialWorkerUrl = workerUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), workerTimeoutMs);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(`${materialWorkerUrl}/v1/material-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Material-Review-Protocol': 'review-material-review-v1' },
        body: JSON.stringify({ requestId: idempotencyKey, inputBindingHash: context.inputBindingHash, context: { ...context, resolvedMediaPath: undefined } }),
        signal: controller.signal,
      });
      payload = await response.json();
    } catch {
      throw new HttpError(504, 'AI Review结果状态未知，本次没有自动重试；请保留请求编号后核查', { code: 'RESULT_UNKNOWN', resultState: 'UNKNOWN', requestId: idempotencyKey });
    } finally { clearTimeout(timer); }
    if (!response.ok) throw safeWorkerError(response.status, payload, idempotencyKey);
    const draft = validateDraft(payload, context);

    const after = await operationalSnapshot();
    if (after.etagValue !== operations.etagValue) throw new HttpError(409, 'DRAFT_STALE: material state changed while AI Review was running');
    const rechecked = await buildMaterialReviewAuthorityContext({ data:await reviewData(), stateProjection: after.stateProjection as unknown as Record<string, unknown>, requirementId, familyId, versionId, versionSha256, contextHash });
    if (rechecked.inputBindingHash !== context.inputBindingHash) throw new HttpError(409, 'DRAFT_STALE: material evidence changed while AI Review was running');
    return jsonResponse({
      schemaVersion: '1.0',
      draftKind: 'AI_SUGGESTION_ONLY',
      target: context.target,
      inputBindingHash: context.inputBindingHash,
      evidenceBoundary: context.observationMode === 'IMAGE_DIRECT'
        ? 'AI直接观察了本次绑定的图片文件；未声明的外部事实仍为UNKNOWN。'
        : 'AI只读取了确定性技术资料，没有观察实际声音、表演、口型、运动、节奏或时序瑕疵；这些项目仍为UNKNOWN。',
      draft,
      requestId: idempotencyKey,
      replayed: Boolean((payload as Record<string, unknown>).replayed),
    }, { headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'material AI review failed');
  }
}
