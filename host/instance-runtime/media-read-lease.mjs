import {AsyncLocalStorage} from 'node:async_hooks';
import {constants} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const scopes=new AsyncLocalStorage();
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
/** Keeps a shared media session lease through byte reads or the returned Response body. */
export async function withRepositoryMediaRead(repository,operation,{signal}={}){
 if(!repository)return operation();
 if(repository.inTransaction){
  const value=await operation();
  if(value instanceof Response&&value.body)fail('MEDIA_STREAM_TRANSACTION','A stream cannot escape the transaction that owns its media lock');
  return value;
 }
 if(scopes.getStore()===repository)return operation();
 if(typeof repository.withMediaReadLease!=='function')fail('MEDIA_LEASE_NOT_INSTALLED','Media readers require the installed shared lease');
 let deliver,reject,delivered=false,streamFailure;
 const result=new Promise((resolve,rejected)=>{deliver=resolve;reject=rejected;});
 const running=repository.withMediaReadLease(async lease=>scopes.run(repository,async()=>{
  if(signal?.aborted)throw signal.reason||new Error('Media request aborted');
  await lease.assertHeld();const value=await operation();await lease.assertHeld();
  if(!(value instanceof Response)||!value.body)return value;
  const reader=value.body.getReader();let finish,finished=false,stopping=false,stopPromise,controller,health;
  const complete=new Promise(resolve=>{finish=()=>{if(finished)return;finished=true;clearInterval(health);signal?.removeEventListener('abort',aborted);resolve();};});
  const stop=(reason,showError=false)=>{
   if(finished)return Promise.resolve();if(stopPromise)return stopPromise;stopping=true;
   stopPromise=(async()=>{try{await reader.cancel(reason);}catch{}
    finally{if(showError)try{controller?.error(reason);}catch{}finish();}})();return stopPromise;
  };
  const aborted=()=>{void stop(signal?.reason||new Error('Media request aborted'),true);};
  streamFailure=reason=>{void stop(reason,true);};
  health=setInterval(()=>{void lease.assertHeld().catch(streamFailure);},1000);
  const body=new ReadableStream({
   start(value){controller=value;},
   async pull(value){
    if(finished)return;
    try{
     await lease.assertHeld();const chunk=await reader.read();await lease.assertHeld();
     if(finished||stopping)return;
     if(chunk.done){value.close();finish();}else value.enqueue(chunk.value);
    }catch(error){await stop(error,true);}
   },
   async cancel(reason){await stop(reason);}
  });
  signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  const response=new Response(body,{status:value.status,statusText:value.statusText,headers:value.headers});
  delivered=true;deliver(response);
  await complete;
  try{reader.releaseLock();}catch{}
  return response;
 }));
 void running.then(value=>{if(!delivered)deliver(value);},error=>{if(delivered)streamFailure?.(error);else reject(error);});
 return result;
}

/** Called inside an existing repository transaction/lease. No path escapes to a later reader. */
export async function readRegisteredMediaBytes(root,media,{maxBytes=25*1024*1024}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>25*1024*1024)fail('MEDIA_SIZE_LIMIT','Bounded media read required');
 if(!media||media.availability!=='PRESENT'||!media.relativePath?.startsWith('media/')||!Number.isSafeInteger(media.byteSize)||media.byteSize>maxBytes)fail('MEDIA_SIZE_LIMIT','Registered media is missing or exceeds the byte limit');
 const parts=media.relativePath.split('/');if(parts.some(p=>!p||p==='.'||p==='..')||/[\\\u0000]/.test(media.relativePath))fail('MEDIA_PATH','Invalid media path');
 const canonical=await realpath(path.resolve(root));if(canonical!==path.resolve(root))fail('MEDIA_PATH','Instance root is not canonical');
 let at=canonical;
 for(let i=0;i<parts.length;i++){at=path.join(at,parts[i]);const st=await lstat(at);if(st.isSymbolicLink()||(i<parts.length-1&&!st.isDirectory())||await realpath(at)!==at)fail('MEDIA_PATH','Media path is not a confined regular path');}
 const handle=await open(at,constants.O_RDONLY|constants.O_NOFOLLOW);
 const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
 try{
  const before=await handle.stat();if(!before.isFile()||before.size!==media.byteSize||before.size>maxBytes)fail('MEDIA_CHANGED','Registered media size changed');
  const bytes=await handle.readFile(),after=await handle.stat(),entry=await lstat(at);
  if(entry.isSymbolicLink()||!same(before,after)||!same(after,entry)||bytes.length!==media.byteSize||createHash('sha256').update(bytes).digest('hex')!==media.sha256)fail('MEDIA_CHANGED','Registered media bytes changed');
  return bytes;
 }finally{await handle.close();}
}
