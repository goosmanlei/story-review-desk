import {createReadStream,constants} from 'node:fs';
import {open,mkdir,rename,rm,statfs,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {check} from './shared/contracts.mjs';

export async function mediaResponse(request,pool,root,sha){
  check(/^[a-f0-9]{64}$/.test(sha),'MEDIA_SHA','媒体身份无效');
  const row=(await pool.query("SELECT mime_type,byte_size FROM media WHERE sha256=$1 AND availability='PRESENT' LIMIT 1",[sha])).rows[0];check(row,'MEDIA_UNAVAILABLE','媒体未登记、缺失或已退役',404);
  const handle=await open(path.join(root,'media',sha),constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>null);check(handle,'MEDIA_MISSING','登记的媒体文件缺失',404);
  const size=(await handle.stat()).size;if(size!==Number(row.byte_size)){await handle.close();check(false,'MEDIA_SIZE_CHANGED','媒体文件与登记大小不符',409);}
  let start=0,end=size-1,status=200;
  const range=request.headers.get('range');
  if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match||(!match[1]&&!match[2])){await handle.close();return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});}if(!match[1])start=Math.max(0,size-Number(match[2]));else start=Number(match[1]);if(match[2]&&match[1])end=Math.min(end,Number(match[2]));if(start>end||start>=size){await handle.close();return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});}status=206;}
  const headers={'Content-Type':row.mime_type,'Content-Length':String(Math.max(0,end-start+1)),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff','ETag':'"'+sha+'"'};
  if(!/^(image\/(png|jpeg|webp|gif|avif)|audio\/(wav|x-wav|mpeg|ogg|flac|mp4)|video\/(mp4|webm|quicktime))$/.test(row.mime_type)){
    headers['Content-Disposition']='attachment; filename="'+sha+'"';headers['Content-Security-Policy']="default-src 'none'; sandbox";
  }
  if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  if(size===0){await handle.close();return new Response(null,{status,headers});}
  return new Response(Readable.toWeb(handle.createReadStream({start,end,autoClose:true})),{status,headers});
}
const reservations=new Map();let allocation=Promise.resolve();
async function allocated(callback){const previous=allocation;let release;allocation=new Promise(resolve=>{release=resolve;});await previous;try{return await callback();}finally{release();}}
export async function receiveFile(request,root,{sha256,maxBytes=64*1024**3}={}){
  check(!sha256||/^[a-f0-9]{64}$/.test(sha256),'UPLOAD_HASH_REQUIRED','上传 SHA-256 无效');
  const length=Number(request.headers.get('content-length'));check(request.headers.has('content-length')&&Number.isSafeInteger(length)&&length>=0&&length<=maxBytes,'UPLOAD_LENGTH','上传需要已知长度，且不能超过 64 GiB 临时预算',411);
  const spool=path.join(root,'runtime','spool');await mkdir(spool,{recursive:true,mode:0o700});
  const filename=path.join(spool,randomUUID()+'.upload');
  await allocated(async()=>{
    let used=0;for(const name of await readdir(spool)){const file=path.join(spool,name);if(reservations.has(file))continue;const info=await lstat(file).catch(()=>null);check(!info||info.isFile()&&!info.isSymbolicLink(),'SPOOL_ENTRY','暂存目录含无法确认的文件');used+=info?.size||0;}
    const pending=[...reservations].filter(([file])=>path.dirname(file)===spool);used+=pending.reduce((n,[,size])=>n+size,0);
    check(pending.length<4,'UPLOAD_BUSY','同时上传数量已达到上限',429);
    check(used+length<=maxBytes,'UPLOAD_BUDGET','上传超过本机临时资源总预算',413);
    const free=await statfs(spool);check(free.bavail*free.bsize-pending.reduce((n,[,size])=>n+size,0)-length>=8*1024**3,'SPACE_REQUIRED','上传后须保留至少 8 GiB 空间',507);
    reservations.set(filename,length);
  });
  let handle;const digest=createHash('sha256');let bytes=0;
  try{
    handle=await open(filename,'wx',0o600);
    for await(const chunk of request.body){bytes+=chunk.byteLength;check(bytes<=length,'UPLOAD_LENGTH','上传字节超出声明长度',413);digest.update(chunk);let offset=0;while(offset<chunk.byteLength){const written=await handle.write(chunk,offset,chunk.byteLength-offset);offset+=written.bytesWritten;}}
    check(bytes===length,'UPLOAD_LENGTH','上传未完整到达');await handle.sync();const actualSha=digest.digest('hex');check(!sha256||actualSha===sha256,'UPLOAD_HASH','上传字节 SHA 不符',409);return {filename,sha256:actualSha,bytes};
  }catch(error){await rm(filename,{force:true});throw error;}finally{await handle?.close();await allocated(()=>reservations.delete(filename));}
}
