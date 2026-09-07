import {startInitializationWorker} from './initialization-worker.mjs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  callOpenAIMaterialReview,
  defaultMaterialReviewModel,
  hashMaterialReviewInput,
  MaterialReviewProviderError,
  officialResponsesUrl,
  validateMaterialReviewWorkerInput,
} from './material-review-core.mjs';
import { MaterialReviewIdempotencyLedger, replayMaterialReviewRecord } from './material-review-idempotency.mjs';

if (!process.env.REVIEW_INSTANCE_ROOT && process.env.MATERIAL_REVIEW_ALLOW_TEST_UPSTREAM !== '1') throw new Error('REVIEW_INSTANCE_ROOT is required');
const host = process.env.MATERIAL_REVIEW_HOST || '127.0.0.1';
const port = Number(process.env.MATERIAL_REVIEW_PORT || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('MATERIAL_REVIEW_PORT is invalid');
const model = process.env.OPENAI_MATERIAL_REVIEW_MODEL || defaultMaterialReviewModel;
const configuredUrl = process.env.OPENAI_RESPONSES_URL || officialResponsesUrl;
const responsesUrl = (() => {
  const parsed = new URL(configuredUrl);
  if (parsed.href === officialResponsesUrl) return parsed.href;
  if (process.env.MATERIAL_REVIEW_ALLOW_TEST_UPSTREAM === '1' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)) return parsed.href;
  throw new Error('OPENAI_RESPONSES_URL must use the official OpenAI endpoint');
})();
if (!process.env.REVIEW_INSTANCE_ROOT && !['127.0.0.1', 'localhost'].includes(new URL(responsesUrl).hostname)) throw new Error('Filesystem fixtures require a loopback mock provider');
const ledger = new MaterialReviewIdempotencyLedger(process.env.MATERIAL_REVIEW_IDEMPOTENCY_DIR || '/tmp/review-material-review-fixture-idempotency', {
  successRetentionMs: Number(process.env.MATERIAL_REVIEW_SUCCESS_RETENTION_MS || 10 * 60_000),
});
const inFlight = new Map();

// A process can stop after writing a successful result to its atomic-replace
// temporary file but before rename/finally.  Remove those unreachable plaintext
// files before accepting traffic, then enforce expiry on finalized records.
await ledger.discardOrphanedTemporaryFiles();
await ledger.redactExpiredSuccesses();

async function apiKey() {
  if (process.env.OPENAI_API_KEY_FILE) {
    try { return (await readFile(process.env.OPENAI_API_KEY_FILE, 'utf8')).trim(); } catch { return ''; }
  }
  return String(process.env.OPENAI_API_KEY || '').trim();
}
const providerKey = await apiKey();
let initializationReady=false;
if(process.env.REVIEW_INSTANCE_ROOT){await startInitializationWorker({apiKey:providerKey});initializationReady=true;}

const sweep = setInterval(() => void ledger.redactExpiredSuccesses().catch(() => {}), 60_000);
sweep.unref();

function send(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new MaterialReviewProviderError(415, 'INVALID_REQUEST', 'content type must be application/json');
  const announced = Number(request.headers['content-length'] || 0);
  if (announced > 512 * 1024) throw new MaterialReviewProviderError(413, 'INVALID_REQUEST', 'request body is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) throw new MaterialReviewProviderError(413, 'INVALID_REQUEST', 'request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MaterialReviewProviderError(400, 'INVALID_REQUEST', 'request body is not valid JSON'); }
}

async function review(input) {
  const requestHash = hashMaterialReviewInput(input);
  const active = inFlight.get(input.requestId);
  if (active) {
    if (active.requestHash !== requestHash) throw new MaterialReviewProviderError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was reused with different input');
    return { ...(await active.promise), replayed: true };
  }
  const promise = (async () => {
    if (!providerKey || providerKey.length > 512) throw new MaterialReviewProviderError(503, 'PROVIDER_CONFIGURATION', 'OPENAI_API_KEY is unavailable');
    const claim = await ledger.claim(input.requestId, requestHash);
    if (!claim.claimed) {
      if (claim.record.requestHash !== requestHash) throw new MaterialReviewProviderError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was reused with different input');
      return replayMaterialReviewRecord(claim.record);
    }
    try {
      const result = await callOpenAIMaterialReview({
        input: { requestId: input.requestId, inputBindingHash: input.inputBindingHash, context: input.context },
        apiKey: providerKey,
        model,
        responsesUrl,
      });
      await ledger.settle(input.requestId, requestHash, 'SUCCEEDED', result);
      return { ...result, replayed: false };
    } catch (reason) {
      const error = reason instanceof MaterialReviewProviderError ? reason : new MaterialReviewProviderError(504, 'RESULT_UNKNOWN', 'OpenAI result is unknown; no automatic retry was made', 'UNKNOWN');
      await ledger.settle(input.requestId, requestHash, error.resultState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', { status: error.status, code: error.code, message: error.message, resultState: error.resultState, providerRequestId: error.providerRequestId || '' });
      throw error;
    }
  })();
  inFlight.set(input.requestId, { requestHash, promise });
  try { return await promise; } finally { inFlight.delete(input.requestId); }
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    let ledgerReady = false;
    try { ledgerReady = await ledger.checkWritable(); } catch {}
    const healthy = Boolean(providerKey) && ledgerReady;
    send(response, healthy ? 200 : 503, { status: healthy ? 'ok' : 'unavailable', configured: Boolean(providerKey), ledgerReady, model, initialization:initializationReady && Boolean(providerKey) });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/material-review') { send(response, 404, { error: 'not found' }); return; }
  if (request.headers['x-material-review-protocol'] !== (process.env.MATERIAL_REVIEW_PROTOCOL || 'review-material-review-v1')) { send(response, 403, { error: 'worker protocol is not allowed' }); return; }
  let requestId = '';
  try {
    const input = validateMaterialReviewWorkerInput(await readJson(request));
    requestId = input.requestId;
    const result = await review(input);
    console.info(JSON.stringify({ event: 'material_review_completed', requestId, inputBindingHash: input.inputBindingHash, providerRequestId: result.providerRequestId, model: result.model, elapsedMs: result.elapsedMs, replayed: result.replayed }));
    send(response, 200, { draft: result.draft, observations: result.observations, unobserved: result.unobserved, model: result.model, providerRequestId: result.providerRequestId || null, replayed: result.replayed });
  } catch (reason) {
    const error = reason instanceof MaterialReviewProviderError ? reason : new MaterialReviewProviderError(500, 'WORKER_ERROR', 'material AI review worker failed');
    console.warn(JSON.stringify({ event: 'material_review_failed', code: error.code, status: error.status, resultState: error.resultState, requestId: requestId || undefined, providerRequestId: error.providerRequestId || undefined }));
    send(response, error.status, { error: error.message, code: error.code, resultState: error.resultState, providerRequestId: error.providerRequestId || null });
  }
});

server.listen(port, host, () => console.info(JSON.stringify({ event: 'material_review_worker_ready', host, port, model, configured: Boolean(providerKey) })));
