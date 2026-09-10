import {withInstanceMediaRead} from '../../_media-read';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  hashStableFile,
  hostedReadOnlyMode,
  HttpError,
  listAllEvents,
  mediaToken,
  reviewData,
  safeGeneratedPath,
} from '../../_store';

const contentTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8', vtt: 'text/vtt; charset=utf-8',
};

type ResolvedMedia = { path: string; sha256: string; versionId: string };

async function resolveToken(token: string): Promise<ResolvedMedia | null> {
  if (!/^m_[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  const data = await reviewData();
  const current = data.productionModel.assetVersions.find((version) => (
    version.path
    && version.sha256
    && ['PRESENT', 'EVIDENCE_ONLY'].includes(String(version.outputState || ''))
    && mediaToken(version.id) === token
  ));
  if (current?.path && current.sha256 && /^[a-f0-9]{64}$/i.test(current.sha256)) {
    return { path: current.path, sha256: current.sha256.toLowerCase(), versionId: current.id };
  }
  const candidate = (await listAllEvents('asset-version')).find((event) => event.mediaToken === token);
  if (
    candidate
    && typeof candidate.path === 'string'
    && typeof candidate.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate.sha256)
  ) {
    return { path: candidate.path, sha256: candidate.sha256.toLowerCase(), versionId: String(candidate.versionId) };
  }
  return null;
}

function headers(size: number, projectPath: string, sha256: string) {
  const extension = projectPath.split('.').pop()?.toLowerCase() || '';
  return {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Content-Length': String(size),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ETag: `"sha256-${sha256}"`,
  };
}

async function mediaFile(token: string) {
  const resolved = await resolveToken(token);
  if (!resolved) return null;
  const filePath = await safeGeneratedPath(resolved.path, { versionId: resolved.versionId, sha256: resolved.sha256 });
  const actual = await hashStableFile(filePath);
  if (actual.sha256 !== resolved.sha256) {
    throw new HttpError(409, 'registered media bytes do not match the version SHA-256');
  }
  return { filePath, projectPath: resolved.path, sha256: resolved.sha256, size: actual.size };
}

function mediaFailure(reason: unknown, head = false) {
  const status = reason instanceof HttpError ? reason.status : 500;
  const message = reason instanceof HttpError ? reason.message : 'media is unavailable';
  if (!(reason instanceof HttpError)) console.error('[review-site:v8:media]', reason);
  return new Response(head ? null : JSON.stringify({ error: message }), {
    status,
    headers: head ? undefined : { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
  });
}

async function HEADWithoutLease(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (hostedReadOnlyMode()) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const { token } = await params;
    const file = await mediaFile(token);
    if (!file) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: headers(file.size, file.projectPath, file.sha256) });
  } catch (reason) {
    return mediaFailure(reason, true);
  }
}

async function GETWithoutLease(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (hostedReadOnlyMode()) {
    return Response.json({ error: 'SHA-bound local originals are available only at http://localhost:3000' }, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  try {
    const { token } = await params;
    const file = await mediaFile(token);
    if (!file) return new Response('Not found', { status: 404 });
    // Retirement and registered-byte checks above run before conditional reuse.
    if(request.headers.get('If-None-Match')===`"sha256-${file.sha256}"`) {
      const cachedHeaders=new Headers(headers(file.size,file.projectPath,file.sha256));cachedHeaders.delete('Content-Length');
      return new Response(null,{status:304,headers:cachedHeaders});
    }
    const range = request.headers.get('range');
    if (!range) {
      const stream = Readable.toWeb(createReadStream(file.filePath));
      return new Response(stream as ReadableStream<Uint8Array>, { status: 200, headers: headers(file.size, file.projectPath, file.sha256) });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
    const suffixLength = !match[1] ? Number(match[2]) : null;
    const start = suffixLength === null ? Number(match[1]) : Math.max(0, file.size - suffixLength);
    const requestedEnd = match[2] && match[1] ? Number(match[2]) : file.size - 1;
    const end = Math.min(requestedEnd, file.size - 1);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= file.size || end < start) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
    }
    const chunkSize = end - start + 1;
    const stream = Readable.toWeb(createReadStream(file.filePath, { start, end }));
    return new Response(stream as ReadableStream<Uint8Array>, {
      status: 206,
      headers: { ...headers(chunkSize, file.projectPath, file.sha256), 'Content-Range': `bytes ${start}-${end}/${file.size}` },
    });
  } catch (reason) {
    return mediaFailure(reason);
  }
}

export async function HEAD(request:Request,context:{params:Promise<{token:string}>}){return withInstanceMediaRead(()=>HEADWithoutLease(request,context),{signal:request.signal}).catch(reason=>mediaFailure(reason,true));}
export async function GET(request:Request,context:{params:Promise<{token:string}>}){return withInstanceMediaRead(()=>GETWithoutLease(request,context),{signal:request.signal}).catch(reason=>mediaFailure(reason));}
