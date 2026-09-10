import { pagedProductionUrl, type PagedProductionFilters, type PagedProductionPayload, type PagedProductionResource } from './paged-production-data';

type Entry<T> = { value: T; etag: string; bytes: number; basis?: string };
type Pending = { controller: AbortController; users: number; promise: Promise<unknown> };
const complete = new Map<string, Entry<unknown>>();
const pending = new Map<string, Pending>();
const MAX_ENTRIES = 12, MAX_BYTES = 24 * 1024 * 1024;
const aborted = () => new DOMException('读取已取消', 'AbortError');
function retain(key: string, entry: Entry<unknown>) {
  complete.delete(key); complete.set(key, entry);
  let bytes = [...complete.values()].reduce((sum, value) => sum + value.bytes, 0);
  for (const [oldKey, old] of complete) {
    if (complete.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    complete.delete(oldKey); bytes -= old.bytes;
  }
}
/** Only successful complete reads are retained. Every entry is revalidated on use. */
function sharedRecord<T>(key: string, signal: AbortSignal | undefined,
  read: (previous: Entry<T> | undefined, signal: AbortSignal) => Promise<Entry<T>>): Promise<Entry<T>> {
  if (signal?.aborted) return Promise.reject(aborted());
  let task = pending.get(key);
  if (!task || task.controller.signal.aborted) {
    const controller = new AbortController();
    const created: Pending = { controller, users: 0, promise: Promise.resolve() };
    created.promise = read(complete.get(key) as Entry<T> | undefined, controller.signal).then(entry => {
      if (controller.signal.aborted) throw aborted();
      retain(key, entry); return entry;
    }).finally(() => { if (pending.get(key) === created) pending.delete(key); });
    task = created; pending.set(key, task);
  }
  const owned = task; owned.users++;
  return new Promise<Entry<T>>((resolve, reject) => {
    let done = false;
    const finish = (error: unknown, value?: Entry<T>) => {
      if (done) return; done = true; signal?.removeEventListener('abort', cancel);
      if (--owned.users === 0) owned.controller.abort();
      if (error) reject(error); else resolve(value as Entry<T>);
    };
    const cancel = () => finish(aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    owned.promise.then(value => finish(null, value as Entry<T>), error => finish(error));
  });
}
async function responseJson<T>(response: Response): Promise<{value:T;bytes:number}> {
  const text = await response.text();
  let value: T & {error?: string; message?: string};
  try { value = JSON.parse(text); } catch { throw new Error('读取接口未返回有效数据'); }
  if (!response.ok) throw Object.assign(new Error(value.error || value.message || `HTTP ${response.status}`), { status: response.status });
  return { value, bytes: text.length * 2 };
}
export function workspaceCacheScope(instance: {instanceId:string;deployment:{runtimeEpoch:string};configurationRef?:{revisionId:string}}) {
  return `${instance.instanceId}:${instance.deployment.runtimeEpoch}:${instance.configurationRef?.revisionId || ''}`;
}
function readWorkspaceRecord<T>(url: string, scope: string, signal?: AbortSignal): Promise<Entry<T>> {
  return sharedRecord<T>(`${scope}:${url}`, signal, async (previous, signal) => {
    const response = await fetch(url, { cache: 'no-store', signal, headers: { 'X-Review-Workspace':'1', ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}) } });
    if (response.status === 304) { if (!previous) throw new Error('缺少已核验的工作区缓存'); return {...previous,basis:response.headers.get('X-Review-Basis')||previous.basis}; }
    return { ...await responseJson<T>(response), basis:response.headers.get('X-Review-Basis')||'', etag: response.headers.get('ETag') || '' };
  });
}
function readCompleteProductionRecord(resource: PagedProductionResource, filters: PagedProductionFilters,
  scope: string, signal?: AbortSignal): Promise<Entry<PagedProductionPayload>> {
  const firstUrl = pagedProductionUrl(resource, filters, null);
  return sharedRecord<PagedProductionPayload>(`${scope}:complete:${firstUrl}`, signal, async (previous, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        let cursor: string | null = null, first: PagedProductionPayload | undefined, bytes = 0, etag = '', basis = '', loaded = 0;
        const cursors = new Set<string>(), rows = new Map<string, Map<string, {id:string}>>();
        do {
          const response:Response = await fetch(pagedProductionUrl(resource, filters, cursor), { cache:'no-store', signal,
            headers: !cursor && previous?.etag && attempt === 0 ? {'If-None-Match':previous.etag} : {} });
          if (response.status === 304 && !cursor && previous) return {...previous,basis:response.headers.get('X-Review-Basis')||previous.basis};
          const decoded:{value:PagedProductionPayload;bytes:number} = await responseJson<PagedProductionPayload>(response);
          const page:PagedProductionPayload = decoded.value;
          if (!first) { first = page; etag = response.headers.get('ETag') || ''; basis = response.headers.get('X-Review-Basis') || ''; }
          if ((basis && basis !== response.headers.get('X-Review-Basis')) || page.snapshotId !== first.snapshotId || page.readVersion !== first.readVersion || page.operationRevision !== first.operationRevision || page.total !== first.total)
            throw Object.assign(new Error('工作区版本在分页中变化，正在重新读取'), {status:409});
          if (page.hasMore !== Boolean(page.nextCursor) || page.count < 0) throw new Error('分页返回不完整，无法展示目录');
          for (const [collection, values] of Object.entries(page.page)) {
            if (!Array.isArray(values)) continue;
            let index = rows.get(collection); if (!index) { index = new Map(); rows.set(collection, index); }
            for (const row of values) index.set(row.id, row);
          }
          bytes += decoded.bytes; loaded += page.count; cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('分页游标重复，已停止读取');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (!first || loaded !== first.total || (rows.get(resource==='materials'?'materialRequirements':'workItems')?.size || 0) !== first.total) throw new Error('工作区对象数与目录总数不一致，请重试');
        return { value: {...first, page:Object.fromEntries([...rows].map(([key, values]) => [key, [...values.values()]])), count:loaded, hasMore:false, nextCursor:null}, bytes, etag, basis };
      } catch (error) {
        if ((error as {status?:number}).status !== 409 || attempt >= 1 || signal.aborted) throw error;
      }
    }
  });
}

export async function readWorkspaceJson<T>(url: string, scope: string, signal?: AbortSignal): Promise<T> {
  return (await readWorkspaceRecord<T>(url, scope, signal)).value;
}
export async function readCompleteProduction(resource: PagedProductionResource, filters: PagedProductionFilters,
  scope: string, signal?: AbortSignal): Promise<PagedProductionPayload> {
  return (await readCompleteProductionRecord(resource, filters, scope, signal)).value;
}
/** The server stamps committed reads with their repository snapshot. A release or
 * AUX update between parallel requests restarts the whole bundle before display. */
async function consistent<T extends Entry<unknown>[]>(read:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  for(let attempt=0;;attempt++) {
    const entries=await read();
    if(new Set(entries.map(entry=>entry.basis).filter(Boolean)).size<=1)return entries;
    if(signal?.aborted)throw aborted();
    if(attempt>=1)throw new Error('工作区版本在读取中变化，请重新完整读取');
  }
}
export async function readProductionWorkspace(resource:PagedProductionResource,filters:PagedProductionFilters,
  scope:string,prerequisites:string[],signal?:AbortSignal) {
  const [page,...contexts]=await consistent(()=>Promise.all([readCompleteProductionRecord(resource,filters,scope,signal),
    ...prerequisites.map(url=>readWorkspaceRecord<{releaseId?:string;snapshotId?:string}>(url,scope,signal))]),signal);
  return {payload:page.value,contexts:contexts.map(entry=>entry.value)};
}
export async function readWorkspaceBatch<T>(urls:string[],scope:string,signal?:AbortSignal):Promise<T[]> {
  return (await consistent(()=>Promise.all(urls.map(url=>readWorkspaceRecord<T>(url,scope,signal))),signal)).map(entry=>entry.value);
}
