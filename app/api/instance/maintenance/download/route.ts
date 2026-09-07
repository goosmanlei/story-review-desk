import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {MAINTENANCE_NAMESPACE} from '../../../../../host/instance-runtime/maintenance-service.mjs';
import {hostedReadOnlyMode,instanceRepository,errorResponse,HttpError} from '../../../v8/_store';
export const runtime='nodejs';
export async function GET(request:Request){
 try{
  if(hostedReadOnlyMode())throw new HttpError(405,'完整备份仅在本地可用');
  const id=new URL(request.url).searchParams.get('id')||'';
  if(!/^maintenance_[a-f0-9-]{36}$/.test(id))throw new HttpError(422,'备份身份无效');
  const repo=await instanceRepository();if(!repo||!process.env.REVIEW_INSTANCE_ROOT)throw new HttpError(503,'未绑定实例');
  const result=await repo.readTransaction(async tx=>{
   const record=await tx.getAux(MAINTENANCE_NAMESPACE,id),metadata=await tx.getMetadata();
   if(!record||record.deleted)throw new HttpError(404,'备份不存在');
   const op=JSON.parse(Buffer.from(record.bytes).toString('utf8'));
   if(op.status!=='SUCCEEDED'||!['backup','import'].includes(op.action)||op.instanceId!==metadata.instanceId||!op.result?.archivePath)throw new HttpError(409,'备份未核验或尚无下载文件');
   return {file:op.result.archivePath,instanceId:metadata.instanceId};
  });
  // Host operations store host paths; the Web process reads the corresponding
  // fixed backup mount, never a caller-supplied or host absolute path.
  const root=await realpath(process.env.REVIEW_INSTANCE_ROOT),expected=path.join(root,'backups','maintenance',id+'.review-backup.gz');
  if(!result.file.endsWith('/backups/maintenance/'+id+'.review-backup.gz')||await realpath(expected)!==expected||(await lstat(expected)).isSymbolicLink())throw new HttpError(409,'备份文件路径不匹配');
  const stat=await lstat(expected);if(!stat.isFile())throw new HttpError(404,'备份文件不存在');
  return new Response(Readable.toWeb(createReadStream(expected)) as ReadableStream,{headers:{'Content-Type':'application/gzip','Content-Length':String(stat.size),'Content-Disposition':'attachment; filename="'+id+'.review-backup.gz"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }catch(error){return errorResponse(error,'备份暂时无法下载');}
}
