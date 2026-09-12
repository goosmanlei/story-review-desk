'use client';
export type CommentPolishResult={operationId:string;requestId:string;polishedComment:string;model?:string;snapshotId?:string;sceneId?:string;sceneContentHash?:string;businessContextHash?:string;requestMode?:'POLISH_DRAFT'|'SUGGEST_FROM_CONTEXT';sourceContext?:{directBeatCount?:number;relatedBeatCount?:number}};
async function read(response:Response){const value=await response.json();if(!response.ok)throw new Error(typeof value.error==='string'?value.error:value.error?.message||`HTTP ${response.status}`);return value;}
function pause(signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},1000);if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});});}
export async function requestCommentPolish(input:unknown,operationId:string,signal?:AbortSignal):Promise<CommentPolishResult>{
  let submitted=false;
  try{
    submitted=true;
    const receipt=await read(await fetch('/api/v1/workspaces/script-comments/polish',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':operationId},body:JSON.stringify(input),signal}));
    if(receipt.operationId!==operationId)throw new Error('评论建议回执编号不一致');
    const deadline=Date.now()+10*60*1000;
    for(;;){
      const operation=await read(await fetch('/api/v1/operations/'+encodeURIComponent(operationId),{cache:'no-store',signal}));
      if(operation.status==='SUCCEEDED')return await read(await fetch('/api/v1/workspaces/script-comments/polish?operationId='+encodeURIComponent(operationId),{cache:'no-store',signal}));
      if(!['QUEUED','RUNNING'].includes(operation.status))throw new Error(operation.error?.message||`评论建议状态：${operation.status}`);
      if(Date.now()>deadline)throw new Error('后台请求仍在处理，请按原操作编号查询');
      await pause(signal);
    }
  }catch(error){if(signal?.aborted)throw error;throw new Error(`${error instanceof Error?error.message:'评论建议未完成'}${submitted?`（操作编号 ${operationId}；未自动重复调用）`:''}`);}
}
