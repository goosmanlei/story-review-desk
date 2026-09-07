import {withInstanceMediaRead} from '../../api/v8/_media-read';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {hostedReadOnlyMode,instanceRepository,safeGeneratedPath,errorResponse} from '../../api/v8/_store';
type Context={params:Promise<{path:string[]}>};
async function serve(request:Request,{params}:Context,head=false){
  if(hostedReadOnlyMode())return new Response(null,{status:404});
  const parts=(await params).path;
  if(!parts.length||parts.some(part=>!part||part==='.'||part==='..'||part.includes('/')||part.includes('\\')))return new Response(null,{status:404});
  try{
    const repo=await instanceRepository();if(!repo)return new Response(null,{status:404});
    const alias=`/media/${parts.join('/')}`;
    const media=await repo.resolveMedia(alias);if(!media||media.availability!=='PRESENT')return new Response(null,{status:404});
    const file=await safeGeneratedPath(alias,{versionId:media.versionId,sha256:media.sha256});
    const info=await stat(file);if(info.size!==media.byteSize)return new Response('媒体大小与登记不符',{status:409});
    const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf'};
    const headers:Record<string,string>={'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':String(info.size),'Accept-Ranges':'bytes','ETag':`"${media.sha256}"`,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'};
    let start=0,end=info.size-1,status=200;
    const range=request.headers.get('range');
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});start=match[1]?Number(match[1]):Math.max(0,info.size-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),info.size-1):info.size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=info.size||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;headers['Content-Length']=String(end-start+1);}
    return new Response(head?null:Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream<Uint8Array>,{status,headers});
  }catch(error){return errorResponse(error,'媒体读取失败');}
}
export async function GET(request:Request,context:Context){return withInstanceMediaRead(()=>serve(request,context),{signal:request.signal}).catch(error=>errorResponse(error,'媒体读取失败'));}
export async function HEAD(request:Request,context:Context){return withInstanceMediaRead(()=>serve(request,context,true),{signal:request.signal}).catch(error=>errorResponse(error,'媒体读取失败'));}
