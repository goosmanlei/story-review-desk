import { committedQueryJson } from '../../../host/instance-runtime/committed-query-cache.mjs';
import type { InstanceReadUnit, InstanceRepository } from '../../../host/instance-runtime/index.mjs';
import { createHash } from 'node:crypto';
import { ReadTiming } from '../_read-timing';
import { readBasis } from '../../../host/instance-runtime/read-basis.mjs';

export async function committedGet(repository: InstanceRepository, queryKey: string,
  read: (tx: InstanceReadUnit) => unknown | Promise<unknown>, request?: Request) {
  const timing = new ReadTiming();
  let basis='';
  const json = await committedQueryJson(repository, queryKey, read, (name, ms) => timing.record(name, ms), metadata=>{basis=readBasis(metadata);});
  const version = createHash('sha256').update(json).digest('hex');
  const etag = `"${version}"`;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Review-Version': version, 'X-Review-Basis':basis, ...timing.headers() };
  return request?.headers.get('If-None-Match') === etag
    ? new Response(null, { status: 304, headers }) : new Response(json, { headers });
}
