import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  callOpenAICommentPolish,
  CommentPolishProviderError,
  defaultCommentPolishModel,
  hashCommentPolishInput,
  officialResponsesUrl,
  validateCommentPolishWorkerInput,
} from './comment-polish-core.mjs';
import {
  CommentPolishIdempotencyLedger,
  replayCommentPolishRecord,
} from './comment-polish-idempotency.mjs';

if (!process.env.REVIEW_INSTANCE_ROOT && process.env.COMMENT_POLISH_ALLOW_TEST_UPSTREAM !== '1') throw new Error('REVIEW_INSTANCE_ROOT is required');
const host = process.env.COMMENT_POLISH_HOST || '127.0.0.1';
const port = Number(process.env.COMMENT_POLISH_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('COMMENT_POLISH_PORT is invalid');
const model = process.env.OPENAI_COMMENT_POLISH_MODEL || defaultCommentPolishModel;
const configuredUrl = process.env.OPENAI_RESPONSES_URL || officialResponsesUrl;
const responsesUrl = (() => {
  const parsed = new URL(configuredUrl);
  if (parsed.href === officialResponsesUrl) return parsed.href;
  if (process.env.COMMENT_POLISH_ALLOW_TEST_UPSTREAM === '1' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)) return parsed.href;
  throw new Error('OPENAI_RESPONSES_URL must use the official OpenAI endpoint');
})();
if (!process.env.REVIEW_INSTANCE_ROOT && !['127.0.0.1', 'localhost'].includes(new URL(responsesUrl).hostname)) throw new Error('Filesystem fixtures require a loopback mock provider');
const idempotencyDirectory = process.env.COMMENT_POLISH_IDEMPOTENCY_DIR || '/tmp/review-comment-polish-fixture-idempotency';
const successRetentionMs = Number(process.env.COMMENT_POLISH_SUCCESS_RETENTION_MS || 10 * 60_000);
if (!Number.isInteger(successRetentionMs) || successRetentionMs < 1_000 || successRetentionMs > 24 * 60 * 60_000) {
  throw new Error('COMMENT_POLISH_SUCCESS_RETENTION_MS is invalid');
}
const idempotencyLedger = new CommentPolishIdempotencyLedger(idempotencyDirectory, { successRetentionMs });
const inFlight = new Map();
const retentionSweep = setInterval(() => {
  void idempotencyLedger.redactExpiredSuccesses().catch((reason) => {
    const error = reason instanceof CommentPolishProviderError
      ? reason
      : new CommentPolishProviderError(503, 'IDEMPOTENCY_LEDGER_UNAVAILABLE', 'The AI polishing idempotency ledger is unavailable');
    console.warn(JSON.stringify({ event: 'comment_polish_retention_sweep_failed', code: error.code, status: error.status }));
  });
}, Math.max(1_000, Math.min(60_000, Math.floor(successRetentionMs / 2))));
retentionSweep.unref();

async function apiKey() {
  if (process.env.OPENAI_API_KEY_FILE) {
    try {
      return (await readFile(process.env.OPENAI_API_KEY_FILE, 'utf8')).trim();
    } catch {
      return '';
    }
  }
  return String(process.env.OPENAI_API_KEY || '').trim();
}

// Docker Compose 5 requires file-backed secrets for read-only services. Read
// the short-lived mount once at startup so the host-side staging file can be
// removed immediately after the container becomes healthy.
const providerKey = await apiKey();

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new CommentPolishProviderError(415, 'INVALID_REQUEST', 'content type must be application/json');
  const announced = Number(request.headers['content-length'] || 0);
  if (announced > 128 * 1024) throw new CommentPolishProviderError(413, 'INVALID_REQUEST', 'request body is too large');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let raw = '';
  let size = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    if (!(bytes instanceof Uint8Array)) {
      throw new CommentPolishProviderError(400, 'INVALID_REQUEST', 'request body is not valid UTF-8 JSON');
    }
    size += bytes.byteLength;
    if (size > 128 * 1024) throw new CommentPolishProviderError(413, 'INVALID_REQUEST', 'request body is too large');
    try {
      raw += decoder.decode(bytes, { stream: true });
    } catch {
      throw new CommentPolishProviderError(400, 'INVALID_REQUEST', 'request body is not valid UTF-8 JSON');
    }
  }
  try {
    raw += decoder.decode();
    return JSON.parse(raw);
  } catch {
    throw new CommentPolishProviderError(400, 'INVALID_REQUEST', 'request body is not valid JSON');
  }
}

async function polish(input) {
  const requestHash = hashCommentPolishInput(input);
  const active = inFlight.get(input.requestId);
  if (active) {
    if (active.requestHash !== requestHash) throw new CommentPolishProviderError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was reused with different input');
    return { ...(await active.promise), replayed: true };
  }
  const promise = (async () => {
    const key = providerKey;
    if (!key || key.length > 512) {
      throw new CommentPolishProviderError(503, 'PROVIDER_CONFIGURATION', 'OPENAI_API_KEY is unavailable');
    }
    const claim = await idempotencyLedger.claim(input.requestId, requestHash);
    if (!claim.claimed) {
      if (claim.record.requestHash !== requestHash) {
        throw new CommentPolishProviderError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was reused with different input');
      }
      return replayCommentPolishRecord(claim.record);
    }
    let result;
    try {
      result = await callOpenAICommentPolish({
        input,
        apiKey: key,
        model,
        responsesUrl,
      });
    } catch (reason) {
      const error = reason instanceof CommentPolishProviderError
        ? reason
        : new CommentPolishProviderError(504, 'RESULT_UNKNOWN', 'OpenAI result is unknown; no automatic retry was made', 'UNKNOWN');
      await idempotencyLedger.settle(
        input.requestId,
        requestHash,
        error.resultState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
        {
          status: error.status,
          code: error.code,
          message: error.message,
          resultState: error.resultState,
          providerRequestId: error.providerRequestId || '',
        },
      );
      throw error;
    }
    await idempotencyLedger.settle(input.requestId, requestHash, 'SUCCEEDED', result);
    return { ...result, replayed: false };
  })();
  inFlight.set(input.requestId, { requestHash, promise });
  try {
    return await promise;
  } finally {
    inFlight.delete(input.requestId);
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    const configured = Boolean(providerKey);
    let ledgerReady = false;
    try {
      ledgerReady = await idempotencyLedger.checkWritable();
    } catch {
      ledgerReady = false;
    }
    const healthy = configured && ledgerReady;
    send(response, healthy ? 200 : 503, { status: healthy ? 'ok' : 'unavailable', configured, ledgerReady, model });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/comment-polish') {
    send(response, 404, { error: 'not found' });
    return;
  }
  if (request.headers['x-comment-polish-protocol'] !== (process.env.COMMENT_POLISH_PROTOCOL || 'review-comment-polish-v1')) {
    send(response, 403, { error: 'worker protocol is not allowed' });
    return;
  }
  let requestId = '';
  try {
    const input = validateCommentPolishWorkerInput(await readJson(request));
    requestId = input.requestId;
    const result = await polish(input);
    console.info(JSON.stringify({
      event: 'comment_polish_completed',
      requestId: input.requestId,
      inputBindingHash: input.inputBindingHash,
      providerRequestId: result.providerRequestId,
      model: result.model,
      elapsedMs: result.elapsedMs,
      inputCharacterCount: result.inputCharacterCount,
      outputCharacterCount: result.outputCharacterCount,
      replayed: result.replayed,
    }));
    send(response, 200, {
      polishedComment: result.polishedComment,
      model: result.model,
      providerRequestId: result.providerRequestId || null,
      replayed: result.replayed,
    });
  } catch (reason) {
    const error = reason instanceof CommentPolishProviderError
      ? reason
      : new CommentPolishProviderError(500, 'WORKER_ERROR', 'AI polishing worker failed');
    console.warn(JSON.stringify({
      event: 'comment_polish_failed',
      code: error.code,
      status: error.status,
      resultState: error.resultState,
      requestId: requestId || undefined,
      providerRequestId: error.providerRequestId || undefined,
    }));
    send(response, error.status, {
      error: error.message,
      code: error.code,
      resultState: error.resultState,
      providerRequestId: error.providerRequestId || null,
    });
  }
});

server.listen(port, host, () => {
  console.info(JSON.stringify({ event: 'comment_polish_worker_ready', host, port, model, configured: Boolean(providerKey) }));
});
