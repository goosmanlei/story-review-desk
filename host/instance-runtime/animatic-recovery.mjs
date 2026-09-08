import {randomUUID,createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson} from './bytes.mjs';
import {animaticHash,animaticHashes} from './animatic-model.mjs';
import {ANIMATIC_NS} from './animatic-service.mjs';
import {animaticProcess} from './animatic-render.mjs';

export const ANIMATIC_RECOVERY_NS={jobs:'animatic-reconciliations',requests:'animatic-reconciliation-requests'};
const read=row=>row&&!row.deleted?JSON.parse(row.bytes):null;
const fail=message=>{throw Object.assign(Error(message),{code:'DOMAIN_CONFLICT'});};
const put=(tx,namespace,key,value,expectedRevisionId=null)=>tx.putAux({namespace,key,bytes:canonicalJson(value),expectedRevisionId,mediaType:'application/json'});
export async function enqueueAnimaticReconciliation(tx,input){
 if(['sceneId','jobId','expectedJobRevisionId','expectedRuntimeEpoch','expectedReleaseId'].some(key=>typeof input[key]!=='string'||!input[key].trim()))fail('核查缺少精确任务、发布或运行代次');
 if(typeof input.requestId!=='string'||!/^[A-Za-z0-9:_.-]{8,160}$/.test(input.requestId))fail('核查请求缺少幂等身份');
 const previous=read(await tx.getAux(ANIMATIC_RECOVERY_NS.requests,input.requestId));if(previous){if(previous.requestHash!==animaticHash(input))fail('核查请求身份已用于其他输入');return previous.result;}
 const meta=await tx.getMetadata(),row=await tx.getAux(ANIMATIC_NS.jobs,input.jobId),job=read(row);
 if(meta.releaseId!==input.expectedReleaseId||meta.runtimeEpoch!==input.expectedRuntimeEpoch||row?.revisionId!==input.expectedJobRevisionId||job?.sceneId!==input.sceneId||job.instanceId!==meta.instanceId)fail('任务、发布或运行代次已变化，请重读后核查');
 if(!['RUNNING','RESULT_UNKNOWN'].includes(job.status))fail('仅可核查执行中或结果待核的预演任务');
 if((await tx.listAux(ANIMATIC_RECOVERY_NS.jobs)).map(read).some(r=>r?.jobId===job.jobId&&r.status==='QUEUED'))fail('此任务已有待处理核查');
 const reconciliationId='animatic_check_'+randomUUID(),value={reconciliationId,jobId:job.jobId,sceneId:job.sceneId,jobRevisionId:row.revisionId,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,releaseId:meta.releaseId,originRuntimeEpoch:job.runtimeEpoch,status:'QUEUED',createdAt:new Date().toISOString()};await put(tx,ANIMATIC_RECOVERY_NS.jobs,reconciliationId,value);
 const result={reconciliationId,status:'QUEUED',automaticRetry:false};await put(tx,ANIMATIC_RECOVERY_NS.requests,input.requestId,{requestHash:animaticHash(input),result});return result;
}

/** Absence is checked without creating directories. Existing paths cannot follow symlinks. */
export async function inspectAnimaticOutput(instanceRoot,relativePath,{run=animaticProcess}={}){
 if(typeof relativePath!=='string'||!relativePath.startsWith('media/_review_pending/')||!relativePath.endsWith('.mp4')||/[\\\0]/.test(relativePath)||relativePath.split('/').some(p=>!p||p==='.'||p==='..'))fail('核查输出不在预演路径白名单');
 const root=await realpath(instanceRoot);if(root!==path.resolve(instanceRoot))fail('实例根目录不是规范路径');let file=root;const parts=relativePath.split('/');
 for(let i=0;i<parts.length;i++){file=path.join(file,parts[i]);let stat;try{stat=await lstat(file);}catch(e){if(e.code==='ENOENT')return{state:'ABSENT',relativePath};throw e;}if(stat.isSymbolicLink()||i<parts.length-1&&!stat.isDirectory()||i===parts.length-1&&!stat.isFile()||await realpath(file)!==file)fail('核查路径包含符号链接或不明归属');}
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);let digest,byteSize;
 try{const before=await handle.stat();if(!before.isFile()||before.size<=0||before.size>512*1024*1024)fail('核查文件不是有界普通 MP4');const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0;while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}const after=await handle.stat(),entry=await lstat(file);if(!same(before,after)||!same(after,entry)||entry.isSymbolicLink()||position!==before.size)fail('核查过程中输出文件发生变化');digest=hash.digest('hex');byteSize=position;
 const probe=JSON.parse(await run('ffprobe',['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=width,height,r_frame_rate,nb_read_frames','-of','json',file],{timeout:30000})),stream=probe.streams?.[0];if(!same(after,await lstat(file)))fail('探测过程中输出文件发生变化');
 if(!stream||stream.r_frame_rate!=='24/1'||stream.width!==1920||stream.height!==1080||!Number.isSafeInteger(Number(stream.nb_read_frames))||Number(stream.nb_read_frames)<=0)fail('实际预演文件的帧率、尺寸或帧数无法核验');
 return{state:'PRESENT',relativePath,sha256:digest,byteSize,frameCount:Number(stream.nb_read_frames),fps:24,width:1920,height:1080};
 }finally{await handle.close();}
}

function classify(view,media,job,revision,slot,file){
 if(!revision||animaticHashes(revision.content).timelineHash!==job.timelineHash||revision.hashes.timelineHash!==job.timelineHash||slot?.jobId!==job.jobId||slot.timelineRevisionId!==job.timelineRevisionId||slot.id!==job.expectedOutput.id||slot.familyId!==job.expectedOutput.familyId||slot.legacyVersionId!==job.expectedOutput.versionId||slot.targetPath!==job.expectedOutput.targetPath)fail('任务、时间线或输出版本槽的冻结依据不一致');
 const candidates=(view.eventsByKind?.['asset-version']||[]).filter(e=>e.renderJobId===job.jobId||e.familyId===job.expectedOutput.familyId&&e.versionId===job.expectedOutput.versionId),registered=media.filter(m=>m.mediaId===job.expectedOutput.familyId&&m.versionId===job.expectedOutput.versionId||m.relativePath===job.expectedOutput.targetPath);
 if(file.state==='ABSENT'){if(candidates.length||registered.length||job.result?.sha256)fail('任务或登记记录声称已有结果，但实际文件缺失');return{status:'FAILED',outcome:'NO_OUTPUT_CONFIRMED',result:null};}
 if(file.frameCount!==revision.hashes.totalFrames)fail('实际文件帧数与冻结时间线不符');
 if(job.result?.sha256&&(job.result.sha256!==file.sha256||job.result.byteSize!==file.byteSize||job.result.relativePath!==file.relativePath))fail('实际文件与工作器返回的 SHA 证据不符');
 if(!candidates.length&&!registered.length)return{status:'RECONCILED_UNREGISTERED',outcome:'OUTPUT_RETAINED_UNREGISTERED',result:null};
 const event=candidates[0],record=registered[0];
 if(candidates.length!==1||registered.length!==1||event.familyId!==job.expectedOutput.familyId||event.versionId!==job.expectedOutput.versionId||event.snapshotId!==job.snapshotId||event.executorKind!=='DETERMINISTIC_RENDER'||event.renderJobId!==job.jobId||event.timelineRevisionId!==job.timelineRevisionId||event.timelineHash!==job.timelineHash||event.expectedOutputId!==job.expectedOutput.id||event.workItemId!==job.workItemId||event.path!==file.relativePath||event.sha256!==file.sha256||event.byteSize!==file.byteSize||event.inputBindingsHash!==animaticHash(job.inputBindings)||animaticHash(event.inputBindings)!==animaticHash(job.inputBindings)||!event.renderProof||['relativePath','sha256','byteSize','frameCount','fps','width','height'].some(key=>event.renderProof[key]!==file[key])||record.mediaId!==job.expectedOutput.familyId||record.versionId!==job.expectedOutput.versionId||record.sha256!==file.sha256||record.byteSize!==file.byteSize||record.relativePath!==file.relativePath||record.availability!=='PRESENT'||record.metadata?.authorityDomain!=='FORMAL'||record.metadata?.renderJobId!==job.jobId||record.metadata?.registrationEventId!==event.eventId)fail('实际文件与正式候选／媒体登记证明不一致');
 const mediaToken='m_'+createHash('sha256').update(record.versionId).digest('base64url').slice(0,28);
 return{status:'SUCCEEDED',outcome:'EXISTING_REGISTRATION_VERIFIED',result:{...file,observed:false,versionId:record.versionId,familyId:record.mediaId,registrationEventId:event.eventId,mediaUrl:'/api/v8/media/'+mediaToken}};
}
/** Explicit queued reconciliation only. An exclusive media lease fences every renderer. */
export async function runAnimaticReconciliationIteration({repository,instanceRoot,workerId,inspect=inspectAnimaticOutput}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')fail('只读实例不能核查预演任务');
 const pending=await repository.readTransaction(async tx=>(await tx.listAux(ANIMATIC_RECOVERY_NS.jobs)).map(read).filter(r=>r?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]);if(!pending)return{processed:false};
 if(typeof repository.withExclusiveMediaLease!=='function')fail('预演核查需要实际受控媒体排他租约');
 try{return await repository.withExclusiveMediaLease(async lease=>{
  if(!lease.exclusive)fail('预演核查未持有排他租约');await lease.assertHeld();
  return repository.writeTransaction(async tx=>{
   const checkRow=await tx.getAux(ANIMATIC_RECOVERY_NS.jobs,pending.reconciliationId),check=read(checkRow),meta=await tx.getMetadata(),jobRow=await tx.getAux(ANIMATIC_NS.jobs,pending.jobId),job=read(jobRow);if(check?.status!=='QUEUED')return{processed:false};
   const completedAt=new Date().toISOString();if(meta.instanceId!==lease.instanceId||meta.instanceId!==check.instanceId||meta.runtimeEpoch!==check.runtimeEpoch||meta.releaseId!==check.releaseId||jobRow?.revisionId!==check.jobRevisionId||job?.instanceId!==check.instanceId||job.sceneId!==check.sceneId||job.runtimeEpoch!==check.originRuntimeEpoch||!['RUNNING','RESULT_UNKNOWN'].includes(job.status)){await put(tx,ANIMATIC_RECOVERY_NS.jobs,check.reconciliationId,{...check,status:'SUPERSEDED',completedAt,error:'核查依据已变化，请重读当前任务'},checkRow.revisionId);return{processed:true,reconciliationId:check.reconciliationId,status:'SUPERSEDED'};}
   let outcome,file;try{file=await inspect(instanceRoot,job.expectedOutput.targetPath);await lease.assertHeld();outcome=classify(await tx.readView(),await tx.listMedia(),job,read(await tx.getAux(ANIMATIC_NS.revisions,job.timelineRevisionId)),read(await tx.getAux(ANIMATIC_NS.slots,job.expectedOutput.id)),file);}catch(e){await lease.assertHeld();const error=String(e.message||e).slice(0,1000);await put(tx,ANIMATIC_NS.jobs,job.jobId,{...job,status:'RESULT_UNKNOWN',error},jobRow.revisionId);await put(tx,ANIMATIC_RECOVERY_NS.jobs,check.reconciliationId,{...check,status:'BLOCKED',completedAt,error},checkRow.revisionId);return{processed:true,reconciliationId:check.reconciliationId,status:'BLOCKED'};}
   const evidence={reconciliationId:check.reconciliationId,checkedAt:completedAt,workerId,lease:'EXCLUSIVE_MEDIA_SESSION',originRuntimeEpoch:job.runtimeEpoch,runtimeEpoch:meta.runtimeEpoch,jobRevisionId:jobRow.revisionId,outcome:outcome.outcome,file,observed:false,formalReviewCreated:false};
   await lease.assertHeld();await put(tx,ANIMATIC_NS.jobs,job.jobId,{...job,status:outcome.status,result:outcome.result,reconciliation:evidence,error:null,completedAt},jobRow.revisionId);await put(tx,ANIMATIC_RECOVERY_NS.jobs,check.reconciliationId,{...check,status:'SUCCEEDED',completedAt,outcome:outcome.outcome},checkRow.revisionId);return{processed:true,reconciliationId:check.reconciliationId,status:outcome.status,outcome:outcome.outcome};
  });
 });}catch(e){if(['MEDIA_MAINTENANCE_BUSY','MEDIA_LEASE_LOST'].includes(e.code))return{processed:false,reconciliationPending:true};throw e;}
}
