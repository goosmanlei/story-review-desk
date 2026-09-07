import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,realpath,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {runInstanceCli} from '../host/instance-runtime/transport.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {MAINTENANCE_NAMESPACE,claimMaintenance,finishMaintenance,validateMaintenanceRequest} from '../host/instance-runtime/maintenance-service.mjs';
import {runMaintenanceProcess} from './instance-maintenance.mjs';
import {writeMaintenanceHeartbeat,clearMaintenanceHeartbeat} from '../host/instance-runtime/maintenance-runtime.mjs';
import {maintenanceImportSource} from '../host/instance-runtime/maintenance-files.mjs';
import {packBackup} from '../host/instance-runtime/backup-stream.mjs';

const filename=fileURLToPath(import.meta.url),softwareRoot=path.resolve(path.dirname(filename),'..');
const decode=record=>record?JSON.parse(Buffer.from(record.bytesBase64,'base64').toString('utf8')):null;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function maintenanceEnvironment(){const allowed=['PATH','HOME','LANG','LC_ALL','TMPDIR','TZ','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','REVIEW_INSTANCE_READ_ONLY'];return Object.fromEntries(allowed.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='EPERM')return true;return false;}};
function localUrl(url){const value=new URL(url);if(value.protocol!=='http:'||!['localhost','127.0.0.1'].includes(value.hostname)||value.username||value.password)throw new Error('维护工作器只能核验本机审阅台');return value.origin;}
async function safeDirectory(target){try{const info=await lstat(target);if(info.isSymbolicLink()||!info.isDirectory())throw new Error('维护目录不是安全普通目录');}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(target,{mode:0o700});}if(await realpath(target)!==target)throw new Error('维护目录不能通过符号链接定位');return target;}
export async function maintenanceOutputRoot(root,instanceId){const parent=await realpath(path.dirname(root));const base=await safeDirectory(path.join(parent,'.maintenance'));return safeDirectory(path.join(base,sha256(instanceId).slice(0,20)));}
async function maintenanceArchivePath(root,operationId){const base=await safeDirectory(path.join(await realpath(root),'backups'));const directory=await safeDirectory(path.join(base,'maintenance'));return path.join(directory,operationId+'.review-backup.gz');}
export async function resolveRestoreTarget(root,target){validateMaintenanceRequest({action:'restore',backupId:'maintenance_00000000-0000-0000-0000-000000000000',target});const parent=await realpath(path.dirname(root)),output=path.join(parent,target);if(output===root)throw new Error('恢复目录不能是当前实例');try{await lstat(output);throw new Error('恢复目录已经存在，不能覆盖');}catch(e){if(e.code!=='ENOENT')throw e;}return output;}

export async function runMaintenanceIteration({root,url,workerId,call=runInstanceCli,run=runMaintenanceProcess,heartbeatWriter=writeMaintenanceHeartbeat,recover=false}){
 const metadata=await call(root,['host-profile']);const epoch=metadata.runtimeEpoch;
 const put=async(namespace,key,value,expectedRevisionId)=>call(root,['aux-put','--namespace',namespace,'--key',key,'--expected-revision',expectedRevisionId||'NULL','--expected-runtime-epoch',epoch],{input:{bytesBase64:Buffer.from(canonicalJson(value)).toString('base64'),mediaType:'application/json'}});
 const heartbeat=()=>heartbeatWriter(root,{workerId,instanceId:metadata.instanceId,runtimeEpoch:epoch,heartbeatAt:new Date().toISOString(),pid:process.pid});
 await heartbeat();
 const records=await call(root,['aux-list','--namespace',MAINTENANCE_NAMESPACE]);
 const ordered=records.filter(r=>!r.deleted).sort((a,b)=>{const left=decode(a),right=decode(b);return (recover?Number(right.status==='RUNNING')-Number(left.status==='RUNNING'):0)||left.createdAt.localeCompare(right.createdAt);});
 for(const record of ordered){
  const op=decode(record);
  if(op.status==='RUNNING'&&recover){const failed={...op,status:'FAILED',completedAt:new Date().toISOString(),error:'上次工作器在执行中停止，结果待核查；未自动重试。',result:null,resultUnknown:true,recoveryWorkerId:workerId};await put(MAINTENANCE_NAMESPACE,record.key,failed,record.revisionId);continue;}
  if(op.status!=='QUEUED')continue;
  if(op.runtimeEpoch!==epoch||op.instanceId!==metadata.instanceId){await put(MAINTENANCE_NAMESPACE,record.key,{...op,status:'FAILED',completedAt:new Date().toISOString(),error:'实例已恢复或运行期改变，旧任务未自动执行。'},record.revisionId);continue;}
  const claimed=claimMaintenance(op,{instanceId:metadata.instanceId,runtimeEpoch:epoch,workerId});let claimRecord;
  try{claimRecord=await put(MAINTENANCE_NAMESPACE,record.key,claimed,record.revisionId);}catch(e){if(['HEAD_CONFLICT','INSTANCE_CLI_FAILED'].includes(e.code))continue;throw e;}
  let completion;
  try{
   const current=await call(root,['host-profile']);if(current.releaseId!==op.requestedReleaseId||current.runtimeEpoch!==epoch)throw new Error('任务排队后当前发布或运行期已变化，请按最新内容重新发起。');
   const args=[];let script;
   if(op.action==='verify'){script='instance-verify.mjs';args.push('--instance',root,'--url',localUrl(url));}
   else if(op.action==='restore'){
    const saved=decode(await call(root,['aux-get','--namespace',MAINTENANCE_NAMESPACE,'--key',op.input.backupId]));
    if(saved?.status!=='SUCCEEDED'||!['backup','import'].includes(saved.action)||saved.instanceId!==metadata.instanceId)throw new Error('备份完成事实已不匹配');
    const outputRoot=await maintenanceOutputRoot(root,metadata.instanceId),backup=await realpath(saved.result.output);
    const legacyRoot=path.join(await realpath(path.dirname(root)),'.maintenance',sha256(metadata.instanceId).slice(0,20));
    if(![outputRoot,legacyRoot].includes(path.dirname(backup)))throw new Error('备份不在本实例受管维护目录');
    const manifest=JSON.parse(await readFile(path.join(backup,'backup-manifest.json'),'utf8'));if(manifest.manifestSha256!==saved.result.manifestSha256)throw new Error('备份清单已变化，恢复失败关闭');
    script='instance-restore.mjs';args.push('--backup',backup,'--output',await resolveRestoreTarget(root,op.input.target));
   }else{
    const output=path.join(await maintenanceOutputRoot(root,metadata.instanceId),op.operationId);
    try{await lstat(output);throw new Error('本任务的输出目录已存在，结果待核查；不自动重试。');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(op.action==='import'){script='instance-import-backup.mjs';args.push('--source',await maintenanceImportSource(root,op.input),'--output',output,'--archive',await maintenanceArchivePath(root,op.operationId),'--instance-id',metadata.instanceId);}
    else {script=op.action==='backup'?'instance-backup.mjs':'instance-export-hosted.mjs';args.push('--instance',root,'--output',output);}
   }
   let pendingHeartbeat=null;const timer=setInterval(()=>{if(pendingHeartbeat)return;pendingHeartbeat=heartbeat().catch(()=>{}).finally(()=>{pendingHeartbeat=null;});},10_000);
   let proof;try{const result=await run(process.execPath,[path.join(softwareRoot,'scripts',script),...args],{env:maintenanceEnvironment()});proof=JSON.parse(result.stdout);if(op.action==='backup'){const packed=await packBackup(proof.output,await maintenanceArchivePath(root,op.operationId));proof.archivePath=packed.path;}}finally{clearInterval(timer);await pendingHeartbeat;}
   completion=finishMaintenance(claimed,{workerId,status:'SUCCEEDED',result:proof});
  }catch(e){completion=finishMaintenance(claimed,{workerId,status:'FAILED',error:e instanceof Error?e.message:'维护执行失败'});}
  await put(MAINTENANCE_NAMESPACE,record.key,completion,claimRecord.revisionId);
  return{processed:true,operationId:op.operationId,status:completion.status};
 }
 return{processed:false};
}

export async function maintenanceWorker(root,url,{once=false}={}){
 root=await realpath(root);url=localUrl(url);await runInstanceCli(root,['host-profile']);const lockDir=await safeDirectory(path.join(root,'runtime','locks')),lock=path.join(lockDir,'maintenance-host.json');
 const workerId=`maintenance-worker_${randomUUID()}`,body={workerId,pid:process.pid,root,url,script:filename,scriptSha256:sha256(await readFile(filename))};
 try{await writeFile(lock,canonicalJson(body),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const previous=JSON.parse(await readFile(lock,'utf8'));if(alive(previous.pid))throw new Error('本实例已有维护工作器');await unlink(lock);await writeFile(lock,canonicalJson(body),{flag:'wx',mode:0o600});}
 let stopped=false;const stop=()=>{stopped=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{let recover=true;do{try{await runMaintenanceIteration({root,url,workerId,recover});recover=false;}catch(e){process.stderr.write(JSON.stringify({status:'WORKER_RETRY_LATER',message:e instanceof Error?e.message:'维护服务不可用'})+'\n');}if(once||stopped)break;await pause(5000);}while(!stopped);}
 finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await clearMaintenanceHeartbeat(root,workerId);const current=JSON.parse(await readFile(lock,'utf8').catch(()=>'{}'));if(current.workerId===workerId)await unlink(lock);}
}

export async function startMaintenanceWorker(root,url){
 root=await realpath(root);url=localUrl(url);const directory=await safeDirectory(path.join(root,'runtime','locks')),lock=path.join(directory,'maintenance-host.json');
 try{const current=JSON.parse(await readFile(lock,'utf8'));if(current.root===root&&current.script===filename&&alive(current.pid)){
  if(current.scriptSha256===sha256(await readFile(filename))&&current.url===url)return{status:'ALREADY_RUNNING',pid:current.pid};
  const command=(await runMaintenanceProcess('ps',['-p',String(current.pid),'-o','command='])).stdout;
  if(!command.includes(filename)||!command.includes(root))throw new Error('维护工作器进程身份无法核实，未停止未知进程');
  process.kill(current.pid,'SIGTERM');for(let attempt=0;attempt<50&&alive(current.pid);attempt++)await pause(100);
  if(alive(current.pid))throw new Error('旧维护工作器仍在收尾，待其完成后重新启动实例');
 }}catch(e){if(e.code!=='ENOENT')throw e;}
 const logs=await safeDirectory(path.join(root,'runtime','logs')),fd=openSync(path.join(logs,'maintenance-worker.log'),'a',0o600);
 const child=spawn(process.execPath,[filename,'--instance',root,'--url',url],{detached:true,stdio:['ignore',fd,fd],env:maintenanceEnvironment()});child.unref();closeSync(fd);
 for(let attempt=0;attempt<50;attempt++){await pause(100);try{const current=JSON.parse(await readFile(lock,'utf8'));if(current.pid===child.pid)return{status:'STARTED',pid:child.pid};}catch(e){if(e.code!=='ENOENT')throw e;}}
 throw new Error('维护工作器启动未得到确认，请检查实例维护日志');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const{values}=parseArgs({options:{instance:{type:'string'},url:{type:'string'},once:{type:'boolean'}}});if(!values.instance||!values.url)throw new Error('Explicit --instance and --url required');await maintenanceWorker(values.instance,values.url,{once:values.once});}
