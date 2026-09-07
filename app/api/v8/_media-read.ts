import {withRepositoryMediaRead} from '../../../host/instance-runtime/media-read-lease.mjs';
import {hostedReadOnlyMode,instanceRepository,HttpError} from './_store';

export async function withInstanceMediaRead<T>(operation:()=>T|Promise<T>,options:{signal?:AbortSignal}={}):Promise<T>{
 try{
  const repository=hostedReadOnlyMode()?null:await instanceRepository();
  return await withRepositoryMediaRead(repository,operation,options);
 }catch(error){
  if(typeof (error as {code?:unknown})?.code==='string'&&/^(MEDIA_(?:LEASE|MAINTENANCE|STREAM)|RETIREMENT_BRIDGE)/.test(String((error as {code:string}).code))){
   throw new HttpError(503,'媒体维护中或读取锁已失效，请稍后重新读取。');
  }
  throw error;
 }
}
