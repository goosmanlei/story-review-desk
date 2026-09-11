/** Dedicated local PostgreSQL owner. No published database port or shared story cluster. */
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../host/instance-runtime/index.mjs';
import {dockerHostPath} from '../host/instance-runtime/docker-path.mjs';
import {requiredPhase} from '../host/instance-runtime/process-resources.mjs';
const softwareRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const POSTGRES_IMAGE='postgres:18.6';
export function validateBackupSoftware(args,{readOnly,backupSoftware},image){
 if(!readOnly||args[0]!=='scripts/instance-pg-transfer.mjs'||args[1]!=='backup')throw Error('Independent backup software is only allowed for explicit read-only backup');
 if(!backupSoftware||Object.keys(backupSoftware).sort().join(',')!=='imageId,softwareCommit'||!/^sha256:[a-f0-9]{64}$/.test(backupSoftware.imageId)||!(/^[a-f0-9]{40,64}$/.test(backupSoftware.softwareCommit)||backupSoftware.softwareCommit==='UNVERSIONED'))throw Error('Invalid immutable backup software identity');
 if(image&&(image.Id!==backupSoftware.imageId||image.Config?.Labels?.['org.opencontainers.image.revision']!==backupSoftware.softwareCommit))throw Error('Backup software image differs from its exact commit');
 return backupSoftware.imageId;
}
export function validateMaintenanceTimeout(args,{readOnly=false,timeout=180000}={}){
 const backup=readOnly&&args[0]==='scripts/instance-pg-transfer.mjs'&&args[1]==='backup';
 const maximum=backup?3600000:900000;
 if(!Number.isInteger(timeout)||timeout<1000||timeout>maximum)throw new Error(`Maintenance timeout must be 1000..${maximum} ms`);
 return timeout;
}
export function postgresNames(instanceId,volume){if(volume&&!/^review_pg_[a-f0-9]{20}$/.test(volume))throw new Error('Invalid PostgreSQL volume identity');const key=volume?volume.slice('review_pg_'.length):sha256(instanceId).slice(0,20);return {container:`review-pg-${key}`,network:`review-net-${key}`,volume:`review_pg_${key}`};}
export function postgresDockerFailure(stderr,{exitCode=null,signal=null,timedOut=false,outputLimitExceeded=false}={}){
 // Public diagnostics are an allowlisted classification, never raw stderr:
 // provider values, SQL payloads and filesystem paths may occur in that text.
 const diagnostic=timedOut?'TIMEOUT':outputLimitExceeded?'OUTPUT_LIMIT':/heap out of memory|allocation failed.*heap/i.test(stderr)?'NODE_HEAP_EXHAUSTED':exitCode===137||signal==='SIGKILL'?'PROCESS_KILLED_POSSIBLE_OOM':/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(stderr)?'DEPENDENCY_MISSING':/canceling statement due to statement timeout/i.test(stderr)?'DATABASE_STATEMENT_TIMEOUT':'PROCESS_FAILED';
 const detail=Object.freeze({exitCode:Number.isInteger(exitCode)?exitCode:null,signal:['SIGKILL','SIGTERM','SIGABRT','SIGSEGV','SIGINT'].includes(signal)?signal:null,timedOut:Boolean(timedOut),outputLimitExceeded:Boolean(outputLimitExceeded),diagnostic});
 return Object.assign(new Error('PostgreSQL Docker operation failed'),{code:'POSTGRES_DOCKER_FAILED',detail:JSON.stringify(detail),diagnostics:detail});
}
export function docker(args,{input,timeout=180000,inherit=false}={}){
 return new Promise((resolve,reject)=>{
  const p=spawn('docker',args,{stdio:inherit?['pipe','inherit','inherit']:['pipe','pipe','pipe']});
  const out=[],err=[];let size=0,errorBytes=0,timedOut=false,outputLimitExceeded=false;
  const timer=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');},timeout);
  if(!inherit){
   p.stdout.on('data',chunk=>{size+=chunk.length;if(size>512*1024*1024){outputLimitExceeded=true;p.kill('SIGTERM');}else out.push(chunk);});
   p.stderr.on('data',chunk=>{if(errorBytes<32000){const kept=chunk.subarray(0,32000-errorBytes);err.push(kept);errorBytes+=kept.length;}});
  }
  p.on('error',error=>{clearTimeout(timer);reject(error);});
  // close follows stderr drainage, unlike exit. Preserve the exit signal even
  // when an OOM kill emitted no stderr and the --rm container no longer exists.
  p.on('close',(exitCode,signal)=>{clearTimeout(timer);if(exitCode!==0||timedOut||outputLimitExceeded)reject(postgresDockerFailure(Buffer.concat(err).toString(),{exitCode,signal,timedOut,outputLimitExceeded}));else resolve(Buffer.concat(out));});
  p.stdin.on('error',()=>{});p.stdin.end(input);
 });
}
export async function pgBootstrap(root){const real=await realpath(root),file=path.join(real,'instance.json'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw new Error('Unsafe instance bootstrap');const b=JSON.parse(await readFile(file,'utf8'));if(b.schemaVersion!=='2.0'||b.database?.kind!=='postgres')throw new Error('Explicit PostgreSQL instance required');const names=postgresNames(b.instanceId,b.database.volume);if(b.database.database!=='review'||b.database.service!=='postgres'||b.database.volume!==names.volume)throw new Error('Database locator identity mismatch');return {root:real,bootstrap:b,...names};}
export async function ensurePostgres(root,{create=false,start=true}={}){
 const p=await pgBootstrap(root),secret=path.join(p.root,'runtime/private/postgres-password');
 const phase=create?await requiredPhase(root):null;
 if(phase&&!(await phase.read()).resources.some(r=>r.kind==='path'&&r.state==='TEMPORARY'&&(p.root===r.path||p.root.startsWith(r.path+path.sep))))throw Error('New PostgreSQL storage needs a phase-owned instance directory');
 if(create){await mkdir(path.dirname(secret),{recursive:true,mode:0o700});try{await writeFile(secret,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
 const st=await lstat(secret);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw new Error('Unsafe database credential file');
 for(const [type,name] of [['network',p.network],['volume',p.volume]]){try{const found=JSON.parse(await docker([type,'inspect',name]))[0];if(found.Labels?.['review.instance']!==p.bootstrap.instanceId)throw new Error('PostgreSQL resource belongs to another instance');}catch(e){if(e.code!=='POSTGRES_DOCKER_FAILED')throw e;if(!create)throw new Error('PostgreSQL storage is missing; restore explicitly');const labels=phase?await phase.expect(type,name):[];await docker([type,'create','--label',`review.instance=${p.bootstrap.instanceId}`,...labels,name]);if(phase)await phase.capture(type,name);}}
 let inspection;try{inspection=JSON.parse(await docker(['inspect',p.container]))[0];}catch(e){if(e.code!=='POSTGRES_DOCKER_FAILED')throw e;}
 if(inspection){if(inspection.Config?.Labels?.['review.instance']!==p.bootstrap.instanceId||inspection.Config.Image!==POSTGRES_IMAGE||!inspection.Mounts?.some(m=>m.Type==='volume'&&m.Name===p.volume&&m.Destination==='/var/lib/postgresql')||!inspection.Mounts?.some(m=>m.Type==='bind'&&dockerHostPath(m.Source)===secret&&m.Destination==='/run/secrets/postgres-password'&&m.RW===false)||!inspection.NetworkSettings?.Networks?.[p.network]||Object.values(inspection.HostConfig?.PortBindings||{}).some(x=>x?.length))throw new Error('PostgreSQL owner identity mismatch');if(!inspection.State.Running){if(!start)throw new Error('PostgreSQL is stopped; start this instance explicitly');await docker(['start',p.container]);}}
 else {if(!start)throw new Error('PostgreSQL owner is unavailable');const labels=phase?await phase.expect('container',p.container):[];await docker(['run','-d','--name',p.container,'--label',`review.instance=${p.bootstrap.instanceId}`,...labels,'--restart',phase?'no':'unless-stopped','--log-opt','max-size=10m','--log-opt','max-file=2','--network',p.network,'--network-alias','postgres','--mount',`type=volume,source=${p.volume},target=/var/lib/postgresql`,'--mount',`type=bind,source=${secret},target=/run/secrets/postgres-password,readonly`,'--env','POSTGRES_USER=review','--env','POSTGRES_DB=review','--env','POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',POSTGRES_IMAGE]);if(phase)await phase.capture('container',p.container);}
 for(let i=0;i<60;i++){try{await docker(['exec',p.container,'pg_isready','-U','review','-d','review'],{timeout:3000});return p;}catch{await new Promise(r=>setTimeout(r,500));}}
 throw new Error('PostgreSQL did not become ready');
}
export async function runPostgresMaintenance(root,args,{input,readOnly=false,mounts=[],storageOwner,backupSoftware,nodeHeapMiB,timeout=180000}={}){
 if(nodeHeapMiB!==undefined&&(!Number.isInteger(nodeHeapMiB)||nodeHeapMiB<256||nodeHeapMiB>8192))throw new Error('Maintenance heap must be 256..8192 MiB');
 validateMaintenanceTimeout(args,{readOnly,timeout});
 if(backupSoftware){validateBackupSoftware(args,{readOnly,backupSoftware});const images=JSON.parse(await docker(['image','inspect',backupSoftware.imageId]));if(images.length!==1)throw Error('Ambiguous backup image');validateBackupSoftware(args,{readOnly,backupSoftware},images[0]);}
 const p=await ensurePostgres(root,{start:false});
 // The transport CLI can call this while its own top-level module is evaluating.
 // Reusing its already validated owner avoids dynamically importing that module
 // back into itself (an unresolved top-level-await cycle).
 const owner=storageOwner===undefined?await (await import('../host/instance-runtime/transport.mjs')).resolveStorageOwner(root,{allowStopped:true}):storageOwner;readOnly=Boolean(readOnly||owner?.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1');
 const bind=({source,target,readOnly=false})=>{if([source,target].some(x=>x.includes(',')||x.includes('\0')))throw new Error('Unsupported maintenance bind path');return ['--mount',`type=bind,source=${source},target=${target}${readOnly?',readonly':''}`];};
 const instanceMounts=[{source:path.join(p.root,'instance.json'),target:'/instance/instance.json',readOnly:true},{source:path.join(p.root,'runtime/private/postgres-password'),target:'/run/secrets/postgres-password',readOnly:true}];
 for(const name of ['data','media','scratch','backups','runtime/locks']){
  const source=path.join(p.root,name);let info;try{info=await lstat(source);}catch(e){if(e.code!=='ENOENT')throw e;if(readOnly)continue;await mkdir(source,{recursive:true,mode:0o700});info=await lstat(source);}
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(source)!==source)throw new Error('Unsafe maintenance instance directory');
  instanceMounts.push({source,target:'/instance/'+name,readOnly});
 }
 // Initial provisioning uses a bounded software checkout; an active instance uses
 // its immutable app image through instance-maintenance instead of this entry.
 const phase=process.env.REVIEW_PROCESS_CONTEXT?await requiredPhase(root):null,name='review-process-maintenance-'+randomUUID(),labels=phase?await phase.expect('container',name):[];
 const result=await docker(['run','--rm','-i','--init','--log-opt','max-size=1m','--log-opt','max-file=1',...(phase?['--name',name,...labels]:[]),...(backupSoftware?['--pull','never','--user',`${process.getuid()}:${process.getgid()}`]:[]),'--network',p.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m',...(owner||backupSoftware?[]:bind({source:softwareRoot,target:'/app',readOnly:true})),...instanceMounts.flatMap(bind),...mounts.flatMap(bind),'--workdir','/app','--env','REVIEW_INSTANCE_ROOT=/instance','--env','REVIEW_DATABASE_BACKEND=postgres','--env','REVIEW_POSTGRES_HOST=postgres','--env','REVIEW_POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',...(readOnly?['--env','REVIEW_INSTANCE_READ_ONLY=1']:[]),backupSoftware?.imageId||(owner?owner.imageId:'node:22-bookworm-slim'),'node',...(nodeHeapMiB===undefined?[]:[`--max-old-space-size=${nodeHeapMiB}`]),...args],{input,timeout});return result;
}
