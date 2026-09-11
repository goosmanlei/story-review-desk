import {mutationGate} from './runtime-gate.mjs';
import {readFile,mkdir,copyFile,rename,rm,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {transaction} from './db.mjs';
import {check,hash,identity,ReviewError} from './shared/contracts.mjs';
import {importRecords,fileSha} from './transfer.mjs';
import {readObject} from './repository.mjs';
import {execute} from './commands.mjs';
import {verifyAdoption as verifyInputs} from './production/service.mjs';

export async function enqueue(pool,request){
  identity(request.operationId);check(['AI_SUGGEST','IMPORT','MEDIA_REGISTER','GENERATE','MEDIA_PROCESS'].includes(request.kind),'JOB_KIND','后台任务类型无效');
  const fingerprint={...request};delete fingerprint.filename;const requestHash=hash(fingerprint);
  return transaction(pool,async tx=>{
    await mutationGate(tx,request.runtimeEpoch);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[request.operationId]);
    const old=(await tx.query('SELECT request_hash,status FROM operations WHERE id=$1',[request.operationId])).rows[0];
    if(old){check(old.request_hash===requestHash,'OPERATION_ID_CONFLICT','同一操作编号不能用于不同请求',409);return {operationId:request.operationId,status:old.status,replayed:true};}
    await tx.query('SELECT pg_advisory_xact_lock(890670313)');
    check(Number((await tx.query("SELECT count(*) AS n FROM operations WHERE status IN ('QUEUED','RUNNING')")).rows[0].n)<100,'QUEUE_FULL','后台队列已满，请稍后再试',429);
    if(['AI_SUGGEST','GENERATE','MEDIA_PROCESS'].includes(request.kind)){
      const object=(await tx.query('SELECT * FROM objects WHERE id=$1 FOR UPDATE',[request.objectId])).rows[0];check(object&&object.version===request.expectedVersion,'VERSION_CONFLICT','对象版本已改变',409);check([object.draft_revision_id,object.adopted_revision_id].includes(request.revisionId),'REVISION_CONFLICT','任务依据修订无效',409);
      if(request.kind==='AI_SUGGEST')check(typeof request.prompt==='string'&&request.prompt.trim()&&request.prompt.length<=16000,'PROMPT_REQUIRED','请填写有界的问题');
      else {
        check(request.authorized===true&&request.authorization?.objectId===object.id&&request.authorization?.revisionId===request.revisionId,'GENERATION_AUTHORIZATION','制作任务需要本轮精确生成授权',403);
        check(object.kind==='INPUT_LOCK'&&object.state==='ADOPTED'&&object.adopted_revision_id===request.revisionId,'INPUT_LOCK_REQUIRED','制作任务须绑定已采用的实际输入锁定',409);
        check(!(await tx.query('SELECT 1 FROM invalidations WHERE consumer_revision_id=$1 LIMIT 1',[request.revisionId])).rowCount,'STALE_INPUT','实际输入依据已改变',409);
        await verifyInputs(tx,object,request.revisionId);
      }
    }
    await tx.query("INSERT INTO operations(id,request_hash,kind,status,request) VALUES($1,$2,$3,'QUEUED',$4)",[request.operationId,requestHash,request.kind,request]);return {operationId:request.operationId,status:'QUEUED'};
  });
}
export async function cancelJob(pool,id){
  const result=await pool.query("UPDATE operations SET status='CANCELLED',updated_at=now() WHERE id=$1 AND status='QUEUED' RETURNING id",[id]);check(result.rowCount===1,'CANCEL_CONFLICT','只有尚未启动的任务可以直接取消；其他状态先查询结果',409);return {operationId:id,status:'CANCELLED'};
}
export async function suggestion(pool,id){
  const result=(await pool.query('SELECT operation_id AS "operationId",object_id AS "objectId",based_on_revision_id AS "revisionId",content,expires_at AS "expiresAt",applied_revision_id AS "appliedRevisionId" FROM suggestions WHERE operation_id=$1 AND (expires_at>now() OR applied_revision_id IS NOT NULL)',[id])).rows[0];check(result,'SUGGESTION_EXPIRED','建议尚未完成或已超过 10 分钟保留期',404);return result;
}
export async function applySuggestion(pool,id,request){
  identity(request.objectId);
  return execute(pool,{operationId:request.operationId,runtimeEpoch:request.runtimeEpoch,actor:{kind:'HUMAN',label:'用户应用 AI 建议'},commands:[{type:'suggestion.apply',suggestionId:id,id:request.objectId,expectedVersion:request.expectedVersion}]});
}
async function registerMedia(pool,request,root){
  check(path.dirname(request.filename)===path.join(root,'runtime','spool'),'SPOOL_PATH','媒体须来自当前实例的受控暂存目录');
  check(await fileSha(request.filename)===request.sha256,'MEDIA_HASH','暂存媒体 SHA 不符',409);await mkdir(path.join(root,'media'),{recursive:true});
  const destination=path.join(root,'media',request.sha256),exists=await lstat(destination).catch(()=>null);
  if(exists)check(exists.isFile()&&!exists.isSymbolicLink()&&await fileSha(destination)===request.sha256,'MEDIA_COLLISION','同 SHA 媒体目标出现未知内容',409);
  else await copyFile(request.filename,destination,1);
  if(request.forImport)return {operationId:request.operationId,status:'SUCCEEDED',sha256:request.sha256,bytes:request.bytes};
  return transaction(pool,async tx=>{
    const old=(await tx.query('SELECT sha256,byte_size FROM media WHERE id=$1 AND version_id=$2',[request.mediaId,request.versionId])).rows[0];
    check(!old||old.sha256===request.sha256&&Number(old.byte_size)===request.bytes,'MEDIA_VERSION_CONFLICT','媒体版本身份已被其他字节占用',409);
    if(!old)await tx.query("INSERT INTO media(id,version_id,sha256,byte_size,mime_type,availability,evidence) VALUES($1,$2,$3,$4,$5,'PRESENT',$6)",[request.mediaId,request.versionId,request.sha256,request.bytes,request.mimeType||'application/octet-stream',{operationId:request.operationId}]);
    const result={operationId:request.operationId,status:'SUCCEEDED',mediaId:request.mediaId,versionId:request.versionId,sha256:request.sha256};await tx.query("UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now() WHERE id=$1",[request.operationId,result]);return result;
  });
}
export async function workOnce(pool,{root,workerId,providers={}}){
  const job=await transaction(pool,async tx=>{
    const result=(await tx.query("SELECT * FROM operations WHERE status='QUEUED' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];if(!result)return null;
    await tx.query("UPDATE operations SET status='RUNNING',worker_id=$2,lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",[result.id,workerId]);return result;
  });if(!job)return false;
  const heartbeat=setInterval(()=>pool.query("UPDATE operations SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND worker_id=$2 AND status='RUNNING'",[job.id,workerId]).catch(()=>{}),5000);heartbeat.unref();
  let externalStarted=false,externalCompleted=false;
  try{
    let result;const request=job.request;
    if(request.filename)check(path.dirname(request.filename)===path.join(root,'runtime','spool'),'SPOOL_PATH','任务暂存目录无效');
    if(job.kind==='IMPORT')result=await importRecords(pool,request.filename,{expectedSha256:request.sha256,mediaRoot:path.join(root,'media'),operationId:job.id});
    else if(job.kind==='MEDIA_REGISTER')result=await registerMedia(pool,request,root);
    else if(job.kind==='AI_SUGGEST'){
      check(typeof providers.suggest==='function','ASSISTANT_NOT_CONFIGURED','本机尚未配置 AI 助手',503);
      const object=await readObject(pool,request.objectId);check(object.version===request.expectedVersion&&object.revision.id===request.revisionId,'SUGGESTION_STALE','排队期间对象已改变',409);
      externalStarted=true;const value=await providers.suggest({request,object,onRequestId:id=>pool.query('UPDATE operations SET provider_request_id=$2 WHERE id=$1',[job.id,id])});externalCompleted=true;
      check(value&&typeof value.summary==='string'&&value.patch&&typeof value.patch==='object'&&!Array.isArray(value.patch)&&Buffer.byteLength(JSON.stringify(value))<=1024*1024,'SUGGESTION_FORMAT','助手输出未通过格式校验');
      await transaction(pool,async tx=>{await tx.query('INSERT INTO suggestions(operation_id,object_id,based_on_revision_id,content) VALUES($1,$2,$3,$4)',[job.id,object.id,request.revisionId,value]);result={operationId:job.id,status:'SUCCEEDED',suggestionId:job.id};await tx.query("UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now() WHERE id=$1",[job.id,result]);});
    }else{
      check(typeof providers.generate==='function','PRODUCTION_NOT_CONFIGURED','本机尚未配置相应制作执行器',503);
      const object=await readObject(pool,request.objectId);check(object.version===request.expectedVersion,'VERSION_CONFLICT','排队期间制作定义已改变',409);
      externalStarted=true;result=await providers.generate({request,object,onRequestId:id=>pool.query('UPDATE operations SET provider_request_id=$2 WHERE id=$1',[job.id,id])});externalCompleted=true;
    }
    await pool.query("UPDATE operations SET status='SUCCEEDED',result=$2,updated_at=now(),lease_until=null WHERE id=$1",[job.id,result]);
    if(request.filename)await rm(request.filename,{force:true});
  }catch(error){
    const status=externalStarted&&!externalCompleted?'RESULT_UNKNOWN':'FAILED';
    await pool.query('UPDATE operations SET status=$2,error=$3,updated_at=now(),lease_until=null WHERE id=$1',[job.id,status,{code:error.code||'WORKER_ERROR',message:error instanceof ReviewError?error.message:'后台执行中断，请先查询原操作'}]);
    if(status==='FAILED'&&job.request.filename&&path.dirname(job.request.filename)===path.join(root,'runtime','spool'))await rm(job.request.filename,{force:true});
  }finally{clearInterval(heartbeat);}
  return true;
}
export async function sweepJobs(pool){
  await pool.query("UPDATE operations SET status='RESULT_UNKNOWN',error=jsonb_build_object('code','WORKER_LEASE_EXPIRED','message','工作器中断；先核查原请求，禁止自动重试'),updated_at=now() WHERE status='RUNNING' AND lease_until<now()");
  await pool.query('DELETE FROM suggestions WHERE expires_at<=now()');
}
