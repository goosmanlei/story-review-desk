import {instanceSessionStorage} from './client-storage';
export async function readManagementResponse<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({ error: `服务返回 HTTP ${response.status}` })) as {error?:string|{message?:string};message?:string};
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || value.message || '操作未完成');
  return value as T;
}

export async function managementMutation<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const multipart = body instanceof FormData;
  const binary = body instanceof Blob;
  const json= multipart||binary?null:JSON.stringify(body);
  const fingerprint=json===null?null:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(method+' '+url+'\n'+json)))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const target=body&&typeof body==='object'?body as Record<string,unknown>:{};
  const scope=String(target.objectId||target.subjectId||target.rootId||target.episodeId||target.requirementId||target.sceneId||target.id||target.owner||'workspace');
  const key='pending-mutation:'+method+':'+url+':'+scope;
  const saved=fingerprint?instanceSessionStorage.getItem(key):null,existing=saved?JSON.parse(saved) as {operationId:string;fingerprint:string}:null;
  let operationId=existing?.operationId||`management:${crypto.randomUUID()}`;
  const clear=()=>{if(fingerprint)instanceSessionStorage.removeItem(key);};
  const recover=async():Promise<T|null>=>{
    const response=await fetch('/api/v1/operations/'+encodeURIComponent(operationId),{cache:'no-store'});
    if(response.status===404)return null;
    const receipt=await readManagementResponse<{status:string;result?:Record<string,unknown>;error?:{message?:string}}>(response);
    if(receipt.status==='SUCCEEDED'){clear();window.dispatchEvent(new Event('review:operations-updated'));const result=receipt.result||{};return {...result,...(result.workspace as object||{}),operationId,status:'SUCCEEDED'} as T;}
    if(['FAILED','CANCELLED'].includes(receipt.status)){clear();throw Error(receipt.error?.message||'原操作未完成');}
    throw Error(`原操作 ${operationId} 状态为 ${receipt.status}，请先核查；未重复提交。`);
  };
  if(existing){const result=await recover();if(result&&existing.fingerprint===fingerprint)return result;if(!result&&existing.fingerprint!==fingerprint)throw Error(`原操作 ${operationId} 尚未确认，先核查原结果再修改请求。`);if(result)operationId=`management:${crypto.randomUUID()}`;}
  if(fingerprint)instanceSessionStorage.setItem(key,JSON.stringify({operationId,fingerprint}));
  const headers: Record<string, string> = { 'Idempotency-Key':operationId };
  if (!multipart) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
  let response:Response;
  try{response=await fetch(url,{method,headers,body:multipart||binary?body:json});}
  catch{try{const result=await recover();if(result)return result;}catch(error){throw error;}throw Error(`尚未确认操作 ${operationId} 的结果；再次操作将先查询此编号。`);}
  if(!response.ok&&response.status<500)clear();
  const result=await readManagementResponse<T>(response);
  clear();
  window.dispatchEvent(new Event('review:operations-updated'));
  return result;
}

export const managementLabel = (value: unknown): string => {
  if (value == null || value === '' || value === 'UNKNOWN') return '待确认';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};
