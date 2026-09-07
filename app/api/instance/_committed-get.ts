import { committedQueryJson } from '../../../host/instance-runtime/committed-query-cache.mjs';
import type { InstanceReadUnit, InstanceRepository } from '../../../host/instance-runtime/index.mjs';

export async function committedGet(repository: InstanceRepository, queryKey: string,
  read: (tx: InstanceReadUnit) => unknown | Promise<unknown>) {
  return new Response(await committedQueryJson(repository, queryKey, read), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
