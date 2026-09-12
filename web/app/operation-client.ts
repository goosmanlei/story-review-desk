'use client';
export async function waitForOperation(operationId:string,signal?:AbortSignal){
 const deadline=Date.now()+10*60*1000;
 while(Date.now()<deadline){
  signal?.throwIfAborted();
  const response=await fetch('/api/v1/operations/'+encodeURIComponent(operationId),{cache:'no-store',signal});
  if(!response.ok)throw Error(`操作 ${operationId} 状态读取失败；请查询原操作`);
  const value=await response.json();
  if(value.status==='SUCCEEDED')return value;
  if(['FAILED','CANCELLED','RESULT_UNKNOWN'].includes(value.status))throw Error(`操作 ${operationId}：${value.error?.message||value.status}；请查询原操作`);
  await new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,1000);const abort=()=>{clearTimeout(timer);reject(signal?.reason);};signal?.addEventListener('abort',abort,{once:true});});
 }
 throw Error(`操作 ${operationId} 仍未完成，请查询原操作；当前未重新提交`);
}
