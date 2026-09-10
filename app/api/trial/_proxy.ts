import {withInstanceMediaRead} from '../v8/_media-read';
import { assertAssistantLocal } from '../assistant/v1/_http';
import { errorResponse, HttpError, instanceRepository, instanceRepositoryMode, instanceReadOnlyMode, safeGeneratedPath, validateBrowserDeployment } from '../v8/_store';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { instanceTrialAsset, instanceTrialReview, instanceTrialSnapshot, instanceTrialScopes, TrialRepositoryError } from './_instance.mjs';

const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
async function registeredBytesWithoutLease(asset: { versionId: string; sha256: string }) {
  const file = await safeGeneratedPath(asset.versionId, { versionId: asset.versionId, sha256: asset.sha256 });
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new TrialRepositoryError('MEDIA_HASH_MISMATCH', '登记媒体字节已变化，请保留意见并核查原件。');
  return { file, bytes };
}

async function registeredBytes(asset:{versionId:string;sha256:string}){return withInstanceMediaRead(()=>registeredBytesWithoutLease(asset));}

/** Only review/read endpoints are exposed. Dispatch remains a host-worker action. */
export async function trialProxy(request: Request, endpoint: string) {
  try {
    assertAssistantLocal(request);
    let body: string | undefined;
    if (request.method === 'POST') {
      await validateBrowserDeployment(request);
      if(instanceReadOnlyMode())throw new HttpError(405,'只读实例不接受试制审阅写入。');
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, '请提交 JSON 审阅记录。');
      if (Number(request.headers.get('content-length') || 0) > 100_000) throw new HttpError(413, '审阅意见过长。');
      body = await request.text();
      if (new TextEncoder().encode(body).length > 100_000) throw new HttpError(413, '审阅意见过长。');
    }
    if (instanceRepositoryMode()) {
      const repository = (await instanceRepository())!;
      const scopeId = new URL(request.url).searchParams.get('scopeId') || undefined;
      const options = { scopeId };
      if (request.method === 'GET' && endpoint === '/api/trial/scopes') {
        return Response.json(await instanceTrialScopes(repository), { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'GET' && endpoint === '/api/trial/snapshot') {
        const snapshot = await instanceTrialSnapshot(repository, { scopeId: scopeId || process.env.REVIEW_TRIAL_SCOPE_ID });
        return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store', ETag: snapshot.mutationEtag } });
      }
      if (request.method === 'POST' && endpoint === '/api/trial/reviews') {
        let parsed: unknown;
        try { parsed = JSON.parse(body || ''); } catch { throw new HttpError(400, '审阅内容不是有效 JSON。'); }
        const result = await instanceTrialReview(repository, parsed, { ...options, ifMatch: request.headers.get('if-match'), idempotencyKey: request.headers.get('idempotency-key'), verifyMedia: registeredBytes });
        return Response.json(result, { headers: { 'Cache-Control': 'no-store', ETag: result.mutationEtag } });
      }
      if (request.method === 'GET' && endpoint.startsWith('/api/trial/media/')) {
        const asset = await instanceTrialAsset(repository, decodeURIComponent(endpoint.slice('/api/trial/media/'.length)), options);
        const { file, bytes } = await registeredBytes(asset);
        const headers: Record<string, string> = { 'Content-Type': mime[file.split('.').at(-1)?.toLowerCase() || ''] || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Length': String(bytes.length), ETag: `"${asset.sha256}"` };
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
          const requestedEnd = match?.[1] && match?.[2] ? Number(match[2]) : bytes.length - 1;
          if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= bytes.length || requestedEnd < start) return new Response(null, { status: 416, headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${bytes.length}` } });
          const end = Math.min(requestedEnd, bytes.length - 1);
          return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
        }
        return new Response(bytes, { headers });
      }
      throw new HttpError(405, '此接口不支持制作执行或模型调用。');
    }
    // Legacy transport exists only for explicitly isolated compatibility fixtures.
    // A missing instance configuration must never reconnect a production project.
    if (process.env.REVIEW_TRIAL_LEGACY_FIXTURE !== '1') throw new HttpError(503, '请配置实例数据库后审阅试制素材。');
    const configured = process.env.REVIEW_TRIAL_WORKER_URL;
    if (!configured) throw new HttpError(503, '试制工作器尚未连接。');
    const base = new URL(configured);
    if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
      || !['127.0.0.1', 'localhost', '[::1]', 'trial-worker'].includes(base.hostname)) {
      throw new HttpError(503, '试制工作器地址配置无效。');
    }
    const headers = new Headers();
    // The front door already checked the browser Origin. The worker checks its own origin.
    headers.set('Origin', base.origin);
    for (const name of ['content-type', 'if-match', 'idempotency-key', 'range']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const target = new URL(endpoint, base);
    const requestedScopeId = new URL(request.url).searchParams.get('scopeId');
    if (requestedScopeId) target.searchParams.set('scopeId', requestedScopeId);
    const response = await fetch(target, {
      method: request.method, headers, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    });
    const outputHeaders = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: outputHeaders });
  } catch (error) {
    if (error instanceof TrialRepositoryError) {
      const status = ['CAS_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'REVIEW_HEAD', 'REVIEW_LOCKED'].includes(error.code) ? 409 : ['TRIAL_NOT_IMPORTED', 'TRIAL_IMPORT_INVALID'].includes(error.code) ? 503 : error.code === 'ASSET_NOT_FOUND' ? 404 : 400;
      return Response.json({ error: error.code, message: error.message }, { status, headers: { 'Cache-Control': 'no-store' } });
    }
    if (error instanceof HttpError) return errorResponse(error);
    return errorResponse(new HttpError(503, '试制工作器暂时无法连接，请保留意见后重试。'));
  }
}
