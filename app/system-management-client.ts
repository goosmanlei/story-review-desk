export async function readManagementResponse<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({ error: `服务返回 HTTP ${response.status}` })) as {error?:string|{message?:string};message?:string};
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || value.message || '操作未完成');
  return value as T;
}

export async function managementMutation<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const state = await readManagementResponse<{ mutationEtag: string }>(await fetch('/api/v8/operations/snapshot?summary=1', { cache: 'no-store' }));
  const multipart = body instanceof FormData;
  const binary = body instanceof Blob;
  const headers: Record<string, string> = { 'If-Match': state.mutationEtag, 'Idempotency-Key': `management:${crypto.randomUUID()}` };
  if (!multipart) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
  const result=await readManagementResponse<T>(await fetch(url, { method, headers, body: multipart || binary ? body : JSON.stringify(body) }));
  window.dispatchEvent(new Event('review:operations-updated'));
  return result;
}

export const managementLabel = (value: unknown): string => {
  if (value == null || value === '' || value === 'UNKNOWN') return '待确认';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};
