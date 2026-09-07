import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {maintenanceUploadDirectory} from '../../../../../host/instance-runtime/maintenance-files.mjs';
import {validateMutationRequest,errorResponse,jsonResponse,HttpError} from '../../../v8/_store';
export const runtime='nodejs';
export async function POST(request:Request){
 try{
  await validateMutationRequest(request);
  if(!process.env.REVIEW_INSTANCE_ROOT||!request.body)throw new HttpError(422,'请选择完整备份文件');
  const uploadId='upload_'+randomUUID(),file=path.join(await maintenanceUploadDirectory(process.env.REVIEW_INSTANCE_ROOT),uploadId+'.review-backup.gz');
  let bytes=0;const limit=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;callback(bytes>64*1024**3?new Error('备份超过64GB，请使用项目内目录导入'):null,chunk);}});
  await pipeline(Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),limit,createWriteStream(file,{flags:'wx',mode:0o600}));
  if(!(await lstat(file)).size)throw new HttpError(422,'备份文件为空');
  return jsonResponse({uploadId,bytes,status:'UPLOADED_NOT_VERIFIED'});
 }catch(error){return errorResponse(error,'备份上传未完成，未登记或恢复');}
}
