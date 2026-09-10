import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './bytes.mjs';

export const MAINTENANCE_NAMESPACE='instance-maintenance-operations';
const fail=(message,code='MAINTENANCE_INVALID')=>{throw Object.assign(new Error(message),{code});};
const read=record=>record?JSON.parse(Buffer.from(record.bytes).toString('utf8')):null;
export function validateMaintenanceRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','backupId','target','uploadId','sourcePath'].includes(k))||!['backup','verify','export','restore','import'].includes(input.action))fail('不支持的实例维护请求');
 if(input.action==='import'){
  if(input.backupId!==undefined||input.target!==undefined||Boolean(input.uploadId)===Boolean(input.sourcePath))fail('请选择一个备份文件或项目内备份目录');
  if(input.uploadId!==undefined&&(typeof input.uploadId!=='string'||!/^upload_[a-f0-9-]{36}$/.test(input.uploadId)))fail('上传文件身份无效');
  if(input.sourcePath!==undefined&&(typeof input.sourcePath!=='string'||!input.sourcePath.startsWith('/')||input.sourcePath.length>4096||input.sourcePath.includes('\0')))fail('备份目录路径无效');
  return structuredClone(input);
 }
 if(input.uploadId!==undefined||input.sourcePath!==undefined)fail('此任务不接受导入文件');
 if(input.action==='restore'){
  if(typeof input.backupId!=='string'||!/^maintenance_[a-f0-9-]{36}$/.test(input.backupId))fail('请选择本实例已核验的完整备份');
  if(typeof input.target!=='string'||!/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,99}$/u.test(input.target)||['.','..'].includes(input.target)||input.target.endsWith('.'))fail('恢复目录必须是当前实例旁边尚不存在的新目录名');
 }else if(input.backupId!==undefined||input.target!==undefined)fail('此任务不接受备份或恢复目录字段');
 return structuredClone(input);
}
export async function maintenanceState(tx,{worker=null}={}){
  if(process.env.REVIEW_DEPLOYMENT_MODE==='VPS')return {runtime:{...(await tx.getMetadata()),status:'VPS 完整发布、备份与回滚由 instance-vps 管理'},storage:{provider:'PostgreSQL',authority:'本实例数据库与受管媒体'},backups:[],capabilities:{backup:false,verify:false,export:false,restore:false,import:false,workerOnline:false},operations:[],readOnly:true};
 const metadata=await tx.getMetadata(),profile=await tx.getProfile(),records=await tx.listAux(MAINTENANCE_NAMESPACE);
 const operations=records.filter(r=>!r.deleted).map(r=>({...read(r),revisionId:r.revisionId})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const age=worker?Date.now()-Date.parse(worker.heartbeatAt):NaN;
 const workerOnline=Boolean(worker&&worker.instanceId===metadata.instanceId&&worker.runtimeEpoch===metadata.runtimeEpoch&&age>=0&&age<30_000);
 return{runtime:{instanceId:metadata.instanceId,projectId:profile.projectId,releaseId:metadata.releaseId,runtimeEpoch:metadata.runtimeEpoch,status:workerOnline?'维护工作器在线':'维护工作器离线，任务将保留排队'},storage:{provider:tx.backend==='postgres'?'PostgreSQL':'SQLite',authority:'本实例数据库与受管媒体'},backups:operations.filter(o=>['backup','import'].includes(o.action)&&o.status==='SUCCEEDED').map(o=>({id:o.operationId,title:`${o.completedAt} · ${o.result.mediaFiles??0}份媒体`,createdAt:o.completedAt,manifestSha256:o.result.manifestSha256,output:o.result.output,downloadUrl:o.result.archivePath?'/api/instance/maintenance/download?id='+encodeURIComponent(o.operationId):null})),capabilities:{backup:true,verify:true,export:true,restore:true,import:true,workerOnline},operations:operations.slice(0,100),readOnly:false};
}
export async function enqueueMaintenance(tx,input,{requestId,expectedEtag}={}){
 if(process.env.REVIEW_DEPLOYMENT_MODE==='VPS')fail('VPS 完整实例传输由 instance-vps 管理，避免额外完整副本','MAINTENANCE_CONFLICT');
 input=validateMaintenanceRequest(input);if(typeof requestId!=='string'||requestId.length<8)fail('维护请求缺少幂等身份');
 const requestHash=sha256(canonicalJson(input)),previous=await tx.getAux('instance-maintenance-requests',requestId);
 if(previous){const saved=read(previous);if(saved.requestHash!==requestHash)fail('请求编号已经用于其他维护任务','MAINTENANCE_CONFLICT');const record=await tx.getAux(MAINTENANCE_NAMESPACE,saved.operationId);if(!record)fail('已登记维护任务缺失','MAINTENANCE_CONFLICT');return read(record);}
 const metadata=await tx.getMetadata();if(!metadata.releaseId)fail('实例尚未发布初始版本');
 const active=(await tx.listAux(MAINTENANCE_NAMESPACE)).filter(r=>!r.deleted).map(read).filter(o=>['QUEUED','RUNNING'].includes(o.status)&&o.runtimeEpoch===metadata.runtimeEpoch);if(active.length>=10)fail('已有10项维护任务待完成，请稍后再试','MAINTENANCE_CONFLICT');
 if(input.action==='restore'){const backup=read(await tx.getAux(MAINTENANCE_NAMESPACE,input.backupId));if(!backup||!['backup','import'].includes(backup.action)||backup.status!=='SUCCEEDED'||backup.instanceId!==metadata.instanceId||!backup.result?.manifestSha256)fail('恢复只能使用本实例已完成核验的备份');}
 const operation={schemaVersion:'1.0',operationId:`maintenance_${randomUUID()}`,instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,requestedReleaseId:metadata.releaseId,action:input.action,status:'QUEUED',createdAt:new Date().toISOString(),input,expectedEtag:expectedEtag||null,workerId:null,result:null,error:null};
 await tx.putAux({namespace:MAINTENANCE_NAMESPACE,key:operation.operationId,bytes:canonicalJson(operation),expectedRevisionId:null,mediaType:'application/json'});
 await tx.putAux({namespace:'instance-maintenance-requests',key:requestId,bytes:canonicalJson({operationId:operation.operationId,requestHash}),expectedRevisionId:null,mediaType:'application/json'});
 return operation;
}
export function claimMaintenance(operation,{instanceId,runtimeEpoch,workerId,now=new Date().toISOString()}){
 if(operation.status!=='QUEUED'||operation.instanceId!==instanceId||operation.runtimeEpoch!==runtimeEpoch||typeof workerId!=='string'||!workerId)fail('维护任务身份或状态已变化','MAINTENANCE_CONFLICT');
 return{...operation,status:'RUNNING',workerId,startedAt:now};
}
export function finishMaintenance(operation,{workerId,status,result,error,now=new Date().toISOString()}){
 if(operation.status!=='RUNNING'||operation.workerId!==workerId||!['SUCCEEDED','FAILED'].includes(status))fail('维护任务不属于当前工作器','MAINTENANCE_CONFLICT');
 if(status==='SUCCEEDED'){
  const valid=['backup','import'].includes(operation.action)?result?.status==='BACKUP_VERIFIED'&&result.instanceId===operation.instanceId&&/^[a-f0-9]{64}$/.test(result.manifestSha256||''):operation.action==='restore'?result?.status==='RESTORED_VERIFIED'&&result.instanceId===operation.instanceId&&result.runtimeEpoch&&result.runtimeEpoch!==operation.runtimeEpoch:operation.action==='verify'?result?.passed===true&&result.instanceId===operation.instanceId:result?.status==='HOSTED_EXPORT_VERIFIED'&&/^[a-f0-9]{64}$/.test(result.manifestSha256||'')&&result.instanceId===operation.instanceId&&result.originalAudioIncluded===false&&result.privateAssistantIncluded===false;
  if(!valid)fail('维护结果缺少对应任务的完成证据');
 }
 return{...operation,status,completedAt:now,result:status==='SUCCEEDED'?result:null,error:status==='FAILED'?String(error||'执行未完成；结果需要核查').slice(0,1500):null};
}
