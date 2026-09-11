#!/usr/bin/env node
import {mkdir,cp,copyFile,readFile,writeFile,rm,lstat,rename} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createProject} from './project.mjs';
import {json,atomic,exists,requireValue,verifyTree,freePort,health} from './io.mjs';
import {processLock,processIdentity,processAlive,beginPhase,releaseConsumer,checkProcessTask,phaseRecords,readProcessConfig,ProcessPhase} from './process-resources.mjs';
import {buildRelease,provisionDatabase,installSoftware,activateLocal,updateCorePin,retireReleases,reconcileSoftware,maintenance} from './deployment.mjs';
import {importPackage,verifyPackage} from '../server/project/package.mjs';
import {fileSha} from '../server/transport-contract.mjs';
import {stopService,startService} from './service.mjs';

export async function remoteTarget(root,operationId,transportDirectory){
 root=path.resolve(root);requireValue(transportDirectory===path.join(root,'.process/transport',operationId),'VPS 传输目录不属于本次操作');
 const ownership=await json(path.join(transportDirectory,'ownership.json')),input=path.join(transportDirectory,'unpacked'),request=await json(path.join(input,'request.json')),manifest=await json(path.join(input,'software-manifest.json'));
 requireValue(ownership.root===root&&ownership.operationId===operationId&&request.operationId===operationId&&request.target.projectRoot===root&&manifest.commit===request.commit,'VPS 输入身份不符');await verifyTree(path.join(input,'software'),manifest.files);
 const business=await verifyPackage(path.join(input,'business'));requireValue(business.transfer.sha256===request.baselineSha256,'VPS 业务基线不符');
 if(!await exists(path.join(root,'instance/instance.json')))await createProject(root,{title:request.title,port:request.target.port,transportOperationId:operationId});
 const runtime=path.join(root,'instance/runtime');
 return processLock(path.join(runtime,'deploy.lock'),async()=>{
  const file=path.join(runtime,'deployments',operationId+'.json'),previous=await json(file).catch(()=>null),instance=await json(path.join(root,'instance/instance.json'));
  requireValue(!previous?.owner||!processAlive(previous.owner),'VPS 原操作仍在运行');
  if(previous?.status==='SUCCEEDED'){
   const machine=await json(path.join(runtime,'machine.json'));await health(machine.apiUrl,{commit:request.commit,instanceId:instance.id,worker:true});return {...previous,cleanup:'TRANSPORT_PENDING'};
  }
  requireValue(!previous||previous.status==='FAILED'&&previous.cleanup==='CLEANED','VPS 原操作尚未核清；保留原状态，禁止重复导入');
  const receipt={schemaVersion:'1.0',kind:'REMOTE_TARGET',operationId,commit:request.commit,instanceId:instance.id,baselineSha256:request.baselineSha256,status:'RUNNING',stage:'BUILDING',cleanup:'PENDING',owner:processIdentity(),attempt:(previous?.attempt||0)+1};
  const save=async update=>{Object.assign(receipt,update,{updatedAt:new Date().toISOString()});await atomic(file,receipt);};await save({});
  const task='remote-'+operationId,phase=await beginPhase(root,task,'attempt-'+receipt.attempt),scratch=(await phase.read()).resources[0].path;let children=[],switched=false,oldMachine,oldActive;
  async function stopPreview(){const active=children.filter(c=>c.exitCode===null);for(const c of active)c.kill('SIGTERM');await Promise.all(active.map(c=>once(c,'exit')));children=[];}
  try{
   const frozen=path.join(scratch,'source');await cp(path.join(input,'software'),frozen,{recursive:true});const built=await buildRelease(root,frozen,manifest,{phase,operationId:operationId+'-'+receipt.attempt});
   const preview=path.join(scratch,'preview'),port=await freePort();await createProject(preview,{title:request.title,port,instanceId:instance.id,initializeGit:false,host:'fixture'});
   await provisionDatabase(preview,built.release,{phase,databaseSalt:operationId,retain:false});
   const environment={...process.env,REVIEW_INSTANCE_ROOT:path.join(preview,'instance'),REVIEW_SOFTWARE_COMMIT:request.commit,PORT:String(port),HOSTNAME:'127.0.0.1',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1'},base='http://127.0.0.1:'+port+'/';
   for(const script of ['web/server.js','scripts/worker.mjs']){const child=spawn(process.execPath,[path.join(built.release,script)],{cwd:root,env:environment,stdio:['ignore','ignore','pipe']});child.stderr.resume();children.push(child);}
   for(let i=0;;i++){try{await health(base,{commit:request.commit,instanceId:instance.id,worker:true});break;}catch(error){if(i>100)throw error;await new Promise(r=>setTimeout(r,200));}}
   await save({stage:'IMPORTING'});const imported=await importPackage(base,path.join(input,'business'),{operationId:'baseline-'+operationId});await save({stage:'IMPORTED',imported});await stopPreview();
   oldMachine=await json(path.join(runtime,'machine.json'));oldActive=await json(path.join(runtime,'active.json')).catch(()=>null);const candidate=await json(path.join(preview,'instance/runtime/machine.json'));
   const credential=path.join(runtime,'credentials',operationId+'.secret');await mkdir(path.dirname(credential),{recursive:true,mode:0o700});requireValue(!await exists(credential),'本次凭据恢复点已经存在');await copyFile(candidate.database.passwordFile,credential);candidate.database.passwordFile=credential;
   await mkdir(path.join(root,'instance/media'),{recursive:true});for(const media of business.media){const to=path.join(root,'instance/media',media.sha256);if(await exists(to))requireValue(await fileSha(to)===media.sha256,'VPS 目标媒体存在未知修改');else await copyFile(path.join(preview,'instance/media',media.sha256),to);}
   const nextMachine={...oldMachine,database:candidate.database,managedDatabase:candidate.managedDatabase,port:request.target.port,listenHost:request.target.listenHost,apiUrl:'http://127.0.0.1:'+request.target.port+'/'};
   await atomic(path.join(runtime,'database-switch.json'),{operationId,previousActive:oldActive,previous:oldMachine.database,next:nextMachine.database,previousManaged:oldMachine.managedDatabase,nextManaged:nextMachine.managedDatabase,status:'PREPARED'});
   if(oldActive)await maintenance(root,operationId,{enabled:true});
   await save({stage:'SWITCHING',previousActive:oldActive});await stopService(root);await atomic(path.join(runtime,'machine.json'),nextMachine);switched=true;
   await installSoftware(root,frozen,manifest,{operationId:operationId+'-'+receipt.attempt,phase});
   const proof=await activateLocal(root,built,{phase,operationId,saveJournal:save,restoreOnFailure:false});
   await updateCorePin(root,manifest);await phase.retain('container',candidate.managedDatabase.container,'当前 VPS 干净业务基线');await phase.retain('volume',candidate.managedDatabase.volume,'当前 VPS 干净业务基线数据库');await releaseConsumer(root,task,'activation');
   await atomic(path.join(runtime,'database-switch.json'),{operationId,previous:oldMachine.database,current:nextMachine.database,previousManaged:oldMachine.managedDatabase,currentManaged:nextMachine.managedDatabase,status:'COMPLETED'});await save({status:'SUCCEEDED',stage:'VERIFIED',proof});
  }catch(error){
   await stopPreview();
   if(switched&&oldMachine){try{await stopService(root);await atomic(path.join(runtime,'machine.json'),oldMachine);if(oldActive){await atomic(path.join(runtime,'active.json'),oldActive);await maintenance(root,operationId,{enabled:false});await startService(root,{commit:oldActive.commit});}else await rm(path.join(runtime,'active.json'),{force:true});await save({status:'FAILED',stage:'RESTORED',error:error.message});}catch(restoreError){await save({status:'RESULT_UNKNOWN',stage:'RESTORING',error:error.message,restoreError:restoreError.message});}}
   else await save({status:'FAILED',error:error.message});
  }finally{
   await stopPreview();
   try{if(receipt.status!=='RESULT_UNKNOWN')await releaseConsumer(root,task,'activation');const finished=await phase.finish({outcome:receipt.status});receipt.cleanup=finished.status;
    if(finished.status==='CLEANED'){await checkProcessTask(root,task);await retireReleases(root);receipt.cleanup='TRANSPORT_PENDING';}
   }catch(error){receipt.cleanup='CLEANUP_REQUIRED';receipt.cleanupError=error.message;}
   delete receipt.owner;await save({});
  }
  return receipt;
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const [root,operationId,directory]=process.argv.slice(2);const result=await remoteTarget(root,operationId,directory);console.log(JSON.stringify(result));process.exitCode=['SUCCEEDED','FAILED'].includes(result.status)&&['TRANSPORT_PENDING','CLEANED'].includes(result.cleanup)?0:1;}
