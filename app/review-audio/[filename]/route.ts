import {withInstanceMediaRead} from '../../api/v8/_media-read';
import {errorResponse} from '../../api/v8/_store';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { hostedReadOnlyMode, instanceMode, instanceRepository, safeGeneratedPath } from '../../api/v8/_store';

type RouteContext = { params: Promise<{ filename: string }> };

async function resolveAudioPath(filename: string) {
  if (instanceMode()) {
    const media = await (await instanceRepository())!.resolveMedia(`/review-audio/${filename}`);
    if (!media) return null;
    return safeGeneratedPath(`/review-audio/${filename}`, { versionId: media.versionId, sha256: media.sha256 });
  }
  if (!/^[a-z0-9-]+\.mp3$/.test(filename)) return null;
  if (filename === 'story-source.mp3') {
    return process.env.STORY_AUDIO_SOURCE_PATH || null;
  }
  return path.join(process.cwd(), 'public', 'media', 'audio', filename);
}

function baseHeaders(size: number) {
  return {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Content-Type': 'audio/mpeg',
    'Content-Disposition': 'inline',
    'Content-Length': String(size),
  };
}

async function audioFile(filename: string) {
  const filePath = await resolveAudioPath(filename);
  if (!filePath) return null;
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? { filePath, size: fileStat.size } : null;
  } catch {
    return null;
  }
}

async function HEADWithoutLease(_request: Request, { params }: RouteContext) {
  if (hostedReadOnlyMode()) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  const { filename } = await params;
  const file = await audioFile(filename);
  if (!file) return new Response(null, { status: 404 });
  return new Response(null, { status: 200, headers: baseHeaders(file.size) });
}

async function GETWithoutLease(request: Request, { params }: RouteContext) {
  if (hostedReadOnlyMode()) {
    return Response.json({ error: 'source audio and local media are not published in the hosted mirror' }, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const { filename } = await params;
  const file = await audioFile(filename);
  if (!file) return new Response('Not found', { status: 404 });

  const range = request.headers.get('range');
  if (!range) {
    const stream = Readable.toWeb(createReadStream(file.filePath));
    return new Response(stream as ReadableStream<Uint8Array>, { status: 200, headers: baseHeaders(file.size) });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
  }

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
    headers: {
      ...baseHeaders(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${file.size}`,
    },
  });
}

export async function HEAD(request:Request,context:RouteContext){return withInstanceMediaRead(()=>HEADWithoutLease(request,context),{signal:request.signal}).catch(error=>errorResponse(error,'媒体读取失败'));}
export async function GET(request:Request,context:RouteContext){return withInstanceMediaRead(()=>GETWithoutLease(request,context),{signal:request.signal}).catch(error=>errorResponse(error,'媒体读取失败'));}
