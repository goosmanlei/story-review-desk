import {listWorkerRuntimeJobs} from './execution-epoch.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {lstat,mkdir,realpath,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson,sha256} from './bytes.mjs';
import {productionHash} from './shot-production-model.mjs';
import {shotProductionPolicyMarkers} from './shot-production-stage-policy.mjs';
import {buildShotProductionManifest} from './shot-production-locks.mjs';
import {readRegisteredMediaBytes} from './media-read-lease.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';

export const SHOT_MANIFEST_NS={jobs:'shot-production-manifest-jobs',requests:'shot-production-manifest-requests'};
const read=r=>r&&!r.deleted?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const put=(tx,namespace,key,value,expectedRevisionId=null)=>tx.putAux({namespace,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});
const token=id=>'m_'+createHash('sha256').update(id).digest('base64url').slice(0,28);

export async function previewShotProductionManifest(tx,{workItemId,...options}){
 const view=await tx.readView(),manifest=await buildShotProductionManifest(tx,{workItemId,...options});
 return{expectedReleaseId:view.releaseId,manifestHash:productionHash(manifest.content),...manifest};
}
export async function enqueueShotProductionManifest(tx,input,options={}){
 if(typeof input.requestId!=='string'||!/^[A-Za-z0-9:_.-]{8,160}$/.test(input.requestId))fail('制作清单缺少幂等请求身份');
 const previous=read(await tx.getAux(SHOT_MANIFEST_NS.requests,input.requestId));if(previous){if(previous.requestHash!==productionHash(input))fail('制作清单请求编号已用于其他输入');return previous.result;}
 const preview=await previewShotProductionManifest(tx,{workItemId:input.workItemId,...options});if(preview.expectedReleaseId!==input.expectedReleaseId||preview.manifestHash!==input.manifestHash)fail('制作清单或发布基线已变化，请重新预览');
 const active=(await tx.listAux(SHOT_MANIFEST_NS.jobs)).map(read).find(j=>j?.workItemId===input.workItemId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status));if(active)fail('制作清单存在排队、执行或结果待核任务，不能重复创建');
 const metadata=await tx.getMetadata(),jobId='sp_manifest_'+randomUUID(),versionId=preview.familyId+'@'+jobId;
 const job={schemaVersion:'1.0',jobId,status:'QUEUED',createdAt:new Date().toISOString(),instanceId:metadata.instanceId,runtimeEpoch:metadata.runtimeEpoch,releaseId:preview.expectedReleaseId,snapshotId:(await tx.readView()).snapshot.snapshotId,workItemId:preview.workItemId,manifestHash:preview.manifestHash,content:preview.content,inputBindings:preview.inputBindings,expectedOutput:{id:preview.expectedOutputId,familyId:preview.familyId,versionId,targetPath:'media/_review_pending/shot-production-manifests/'+jobId+'.json'},result:null};
 await put(tx,SHOT_MANIFEST_NS.jobs,jobId,job);const result={jobId,status:job.status,formalReviewCreated:false};await put(tx,SHOT_MANIFEST_NS.requests,input.requestId,{requestHash:productionHash(input),result});return result;
}
async function assertCurrent(tx,job,options){
 const metadata=await tx.getMetadata();if(metadata.instanceId!==job.instanceId||metadata.runtimeEpoch!==job.runtimeEpoch||metadata.releaseId!==job.releaseId)fail('制作清单的实例或发布基线已变化');
 const preview=await previewShotProductionManifest(tx,{workItemId:job.workItemId,...options});if(preview.manifestHash!==job.manifestHash||productionHash(job.content)!==job.manifestHash||productionHash(preview.inputBindings)!==productionHash(job.inputBindings))fail('制作清单的精确输入已变化');
}
export async function claimShotProductionManifest(tx,{jobId,workerId},options={}){
 const record=await tx.getAux(SHOT_MANIFEST_NS.jobs,jobId),job=read(record);if(!job||job.status!=='QUEUED')return null;await assertCurrent(tx,job,options);
 const value={...job,status:'RUNNING',workerId,startedAt:new Date().toISOString()},saved=await put(tx,SHOT_MANIFEST_NS.jobs,jobId,value,record.revisionId);return{job:value,jobRevisionId:saved.revisionId};
}
/** Actual file write belongs only to the controlled worker and never fabricates a model run. */
export async function writeShotProductionManifest({repository,instanceRoot,job,assertHeld=async()=>{}}){
 if(!/^sp_manifest_[a-f0-9-]{36}$/.test(job.jobId||'')||job.expectedOutput.targetPath!=='media/_review_pending/shot-production-manifests/'+job.jobId+'.json'||productionHash(job.content)!==job.manifestHash)fail('制作清单路径或冻结内容无效');
 const root=await realpath(instanceRoot);if(root!==path.resolve(instanceRoot))fail('实例目录必须为规范路径');
 for(const binding of job.inputBindings){await assertHeld();const media=await repository.readTransaction(tx=>tx.getMedia(binding.familyId,binding.versionId));if(!media||media.sha256!==binding.sha256)fail('制作清单引用版本已变化');await readRegisteredMediaBytes(root,media);}
 let directory=root;for(const part of ['media','_review_pending','shot-production-manifests']){directory=path.join(directory,part);await mkdir(directory,{recursive:true});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)fail('制作清单输出不能经过符号链接');}
 await assertHeld();const file=path.join(root,job.expectedOutput.targetPath),bytes=Buffer.from(canonicalJson(job.content)+'\n');await writeFile(file,bytes,{flag:'wx'});const actual=await readFile(file);if(sha256(actual)!==sha256(bytes))fail('制作清单落盘 SHA 不一致');await assertHeld();
 return{relativePath:job.expectedOutput.targetPath,sha256:sha256(actual),byteSize:actual.length,mediaType:'application/json',manifestHash:job.manifestHash};
}
export async function finishShotProductionManifest(tx,{jobId,jobRevisionId,workerId,result},options={}){
 const record=await tx.getAux(SHOT_MANIFEST_NS.jobs,jobId),job=read(record);if(!job||record.revisionId!==jobRevisionId||job.status!=='RUNNING'||job.workerId!==workerId)fail('制作清单任务状态已变化');await assertCurrent(tx,job,options);
 const bytes=Buffer.from(canonicalJson(job.content)+'\n');if(result?.relativePath!==job.expectedOutput.targetPath||result.sha256!==sha256(bytes)||result.byteSize!==bytes.length||result.manifestHash!==job.manifestHash)fail('制作清单缺少精确文件 SHA 证据');
 const output=job.expectedOutput,event=await tx.appendEvent({kind:'asset-version',idempotencyKey:job.jobId,requestHash:productionHash({jobId,result}),eventSchemaVersion:'2.0',payload:{schemaVersion:'2.0',...(job.content.schemaVersion==='2.0'?shotProductionPolicyMarkers(job.content.deliverableKey):{}),snapshotId:job.snapshotId,familyId:output.familyId,versionId:output.versionId,expectedOutputId:output.id,workItemId:job.workItemId,path:result.relativePath,sha256:result.sha256,byteSize:result.byteSize,mediaToken:token(output.versionId),outputState:'PRESENT',lifecycleState:'REVIEW_PENDING',registrationState:'REGISTERED',inputBindings:job.inputBindings,inputBindingsHash:productionHash(job.inputBindings),manifestJobId:job.jobId,manifestHash:job.manifestHash,executorKind:'DETERMINISTIC_MANIFEST',observation:'UNOBSERVED',parentVersionId:null,parentBindingState:'EXPLICIT_ROOT'}});
 await tx.registerMedia({mediaId:output.familyId,versionId:output.versionId,relativePath:result.relativePath,sha256:result.sha256,byteSize:result.byteSize,aliases:[output.versionId,result.relativePath],metadata:{authorityDomain:'FORMAL',registrationEventId:event.event.eventId,manifestJobId:job.jobId}});
 const value={...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result:{...result,familyId:output.familyId,versionId:output.versionId,registrationEventId:event.event.eventId,mediaUrl:'/api/v8/media/'+token(output.versionId)}};await put(tx,SHOT_MANIFEST_NS.jobs,jobId,value,record.revisionId);return value;
}
export function shotManifestCandidateMatchesJob(candidate,jobs){const job=(jobs||[]).find(j=>j.jobId===candidate.manifestJobId);return Boolean(job?.status==='SUCCEEDED'&&job.registrationVerified===true&&job.result?.registrationEventId===candidate.eventId&&job.result.versionId===candidate.versionId&&job.result.familyId===candidate.familyId&&job.expectedOutput.id===candidate.expectedOutputId&&job.workItemId===candidate.workItemId&&job.result.relativePath===candidate.path&&job.result.sha256===candidate.sha256&&job.result.byteSize===candidate.byteSize&&job.manifestHash===candidate.manifestHash&&productionHash(job.content)===candidate.manifestHash&&productionHash(job.inputBindings)===candidate.inputBindingsHash&&productionHash(candidate.inputBindings)===candidate.inputBindingsHash);}
export async function applyShotProductionManifestProjection(tx,model){
 const jobs=[];for(const row of await tx.listAux(SHOT_MANIFEST_NS.jobs)){const job=read(row);if(!job)continue;let registrationVerified=false;if(job.status==='SUCCEEDED'&&job.result){const media=await tx.getMedia(job.result.familyId,job.result.versionId);registrationVerified=Boolean(media&&media.relativePath===job.result.relativePath&&media.sha256===job.result.sha256&&media.byteSize===job.result.byteSize&&media.metadata?.registrationEventId===job.result.registrationEventId&&(await mediaRetirementOverlay(tx,media)).state==='ACTIVE');}jobs.push({...job,registrationVerified});}return{...model,shotProductionManifestJobs:jobs};
}
export async function runShotProductionManifestIteration({repository,instanceRoot,workerId,api,write=writeShotProductionManifest}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')fail('只读实例不能生成制作清单');
 const pending=await repository.readTransaction(async tx=>(await listWorkerRuntimeJobs(tx,SHOT_MANIFEST_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)));if(!pending.length)return{processed:false};
 const jobId=pending[0].jobId;let claimed,result;try{
  claimed=await repository.writeTransaction(tx=>claimShotProductionManifest(tx,{jobId,workerId},{api}));if(!claimed)return{processed:false};
  await repository.withMediaReadLease(async lease=>{result=await write({repository,instanceRoot,job:claimed.job,assertHeld:()=>lease.assertHeld()});await repository.writeTransaction(tx=>finishShotProductionManifest(tx,{jobId,workerId,jobRevisionId:claimed.jobRevisionId,result},{api}));});return{processed:true,jobId,status:'SUCCEEDED'};
 }catch(e){
  const exists=claimed&&await lstat(path.join(instanceRoot,claimed.job.expectedOutput.targetPath)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),status=exists||result?'RESULT_UNKNOWN':'FAILED';
  await repository.writeTransaction(async tx=>{const record=await tx.getAux(SHOT_MANIFEST_NS.jobs,jobId),job=read(record);if(!job||!['QUEUED','RUNNING'].includes(job.status))return;await put(tx,SHOT_MANIFEST_NS.jobs,jobId,{...job,status,result:result||null,error:String(e.message||e).slice(0,1500),completedAt:new Date().toISOString()},record.revisionId);});return{processed:true,jobId,status};
 }
}
