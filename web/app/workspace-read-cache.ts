import { pagedProductionUrl, type PagedProductionFilters, type PagedProductionPayload, type PagedProductionResource } from './paged-production-data';

type Entry<T> = { value: T; etag: string; bytes: number; basis?: string; accessedAt?:number };
type Pending = { controller: AbortController; users: number; promise: Promise<unknown> };
const complete = new Map<string, Entry<unknown>>();
const pending = new Map<string, Pending>();
const MAX_ENTRIES = 64, MAX_BYTES = 24 * 1024 * 1024;
const IDLE_MS=5*60*1000;
let expiry:ReturnType<typeof setTimeout>|undefined;
function expire(){
  const now=Date.now();for(const [key,entry]of complete)if(now-(entry.accessedAt||0)>=IDLE_MS)complete.delete(key);
  if(expiry)clearTimeout(expiry);
  expiry=complete.size?setTimeout(expire,Math.max(1,Math.min(...[...complete.values()].map(v=>(v.accessedAt||0)+IDLE_MS-now)))):undefined;
}
const aborted = () => new DOMException('读取已取消', 'AbortError');
function retain(key: string, entry: Entry<unknown>) {
  complete.delete(key); complete.set(key, {...entry,accessedAt:Date.now()});
  let bytes = [...complete.values()].reduce((sum, value) => sum + value.bytes, 0);
  for (const [oldKey, old] of complete) {
    if (complete.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    complete.delete(oldKey); bytes -= old.bytes;
  }
  expire();
}
/** Only successful complete reads are retained. Every entry is revalidated on use. */
function sharedRecord<T>(key: string, signal: AbortSignal | undefined,
  read: (previous: Entry<T> | undefined, signal: AbortSignal) => Promise<Entry<T>>): Promise<Entry<T>> {
  if (signal?.aborted) return Promise.reject(aborted());
  expire();
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
  let value: T & {error?: string|{message?:string;code?:string;details?:unknown}; message?: string;details?:unknown};
  try { value = JSON.parse(text); } catch { throw new Error('读取接口未返回有效数据'); }
  if (!response.ok) {const error=typeof value.error==='object'?value.error:null;throw Object.assign(new Error(typeof value.error==='string'?value.error:error?.message||value.message||`HTTP ${response.status}`),{status:response.status,code:error?.code,details:error?.details||value.details});}
  return { value, bytes: new TextEncoder().encode(text).byteLength };
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
  scope: string, signal?: AbortSignal, cursor:string|null=null): Promise<Entry<PagedProductionPayload>> {
  return readWorkspaceRecord<PagedProductionPayload>(pagedProductionUrl(resource,filters,cursor),scope,signal);
}

export async function readWorkspaceJson<T>(url: string, scope: string, signal?: AbortSignal): Promise<T> {
  return (await readWorkspaceRecord<T>(url, scope, signal)).value;
}
export async function readCompleteProduction(resource: PagedProductionResource, filters: PagedProductionFilters,
  scope: string, signal?: AbortSignal): Promise<PagedProductionPayload> {
  return (await readCompleteProductionRecord(resource, filters, scope, signal)).value;
}
/** Shared objects must refer to the same revision in parallel reads. Unrelated
 * object writes do not invalidate the selected workspace or its local draft. */
async function consistent<T extends Entry<unknown>[]>(read:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  for(let attempt=0;;attempt++) {
    const entries=await read();
    const seen=new Map<string,string>();let matches=true;
    for(const entry of entries){
      const data=entry.value as {_basis?:Array<{objectId:string;revisionId:string;expectedVersion:number;sha256:string}>;_configurationVersions?:Record<string,number>};
      for(const row of data?._basis||[]){const version=JSON.stringify([row.revisionId,row.expectedVersion,row.sha256]);if(seen.has(row.objectId)&&seen.get(row.objectId)!==version)matches=false;seen.set(row.objectId,version);}
      for(const [scope,version]of Object.entries(data?._configurationVersions||{})){const key='configuration:'+scope;if(seen.has(key)&&seen.get(key)!==String(version))matches=false;seen.set(key,String(version));}
    }
    if(matches)return entries;
    if(signal?.aborted)throw aborted();
    if(attempt>=1)throw new Error('工作区版本在读取中变化，请重新完整读取');
  }
}
export async function readProductionWorkspace(resource:PagedProductionResource,filters:PagedProductionFilters,
  scope:string,prerequisites:string[],signal?:AbortSignal,{cursor=null as string|null}={}) {
  // Every required object crosses the same version barrier before display.
  const entries=await consistent(async()=>{
    const [base,catalogue]=await Promise.all([
      Promise.all([readCompleteProductionRecord(resource,filters,scope,signal,cursor),...prerequisites.map(url=>readWorkspaceRecord<{releaseId?:string;snapshotId?:string}>(url,scope,signal))]),
      resource==='materials'?Promise.all([readWorkspaceRecord<{page:PagedProductionPayload['page'];total:number}>('/api/v1/workspaces/views/material-catalog',scope,signal)]):Promise.resolve([] as Entry<unknown>[]),
    ]);
    return [...base,...catalogue];
  },signal);
  const page=entries[0] as Entry<PagedProductionPayload>;
  let payload=page.value;
  if(resource==='materials'){
    const catalog=entries.at(-1)!.value as {page:PagedProductionPayload['page'];total:number};
    const combined={...catalog.page,...page.value.page} as Record<string,unknown>;
    for(const [key,rows]of Object.entries(catalog.page)){if(!Array.isArray(rows))continue;const incoming=(page.value.page as Record<string,unknown>)[key];combined[key]=[...new Map([...rows,...(Array.isArray(incoming)?incoming:[])].map(r=>[r.id,r])).values()];}
    payload={...page.value,page:combined as PagedProductionPayload['page'],count:catalog.total,total:catalog.total,hasMore:false,nextCursor:null};
  }
  const contexts=entries.slice(1,prerequisites.length+1) as Entry<{releaseId?:string;snapshotId?:string}>[];
  return {payload,contexts:contexts.map(entry=>entry.value),materialCatalog:resource==='materials'?{scope,values:contexts.map(entry=>entry.value)}:undefined};
}
export async function readWorkspaceBatch<T>(urls:string[],scope:string,signal?:AbortSignal):Promise<T[]> {
  return (await consistent(()=>Promise.all(urls.map(url=>readWorkspaceRecord<T>(url,scope,signal))),signal)).map(entry=>entry.value);
}
