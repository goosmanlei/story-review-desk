/** Dedicated local PostgreSQL owner. No published database port or shared story cluster. */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../host/instance-runtime/index.mjs';
import {dockerHostPath} from '../host/instance-runtime/docker-path.mjs';
const softwareRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const POSTGRES_IMAGE='postgres:18.6';
export function postgresNames(instanceId,volume){if(volume&&!/^review_pg_[a-f0-9]{20}$/.test(volume))throw new Error('Invalid PostgreSQL volume identity');const key=volume?volume.slice('review_pg_'.length):sha256(instanceId).slice(0,20);return {container:`review-pg-${key}`,network:`review-net-${key}`,volume:`review_pg_${key}`};}
export function docker(args,{input,timeout=180000,inherit=false}={}){return new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:inherit?['pipe','inherit','inherit']:['pipe','pipe','pipe']});const out=[],err=[];let size=0;const timer=setTimeout(()=>p.kill('SIGTERM'),timeout);if(!inherit){p.stdout.on('data',c=>{size+=c.length;if(size>512*1024*1024)p.kill('SIGTERM');else out.push(c);});p.stderr.on('data',c=>{if(err.reduce((n,x)=>n+x.length,0)<32000)err.push(c);});}p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('exit',code=>{clearTimeout(timer);if(code!==0)reject(Object.assign(new Error('PostgreSQL Docker operation failed'),{code:'POSTGRES_DOCKER_FAILED',detail:Buffer.concat(err).toString()}));else resolve(Buffer.concat(out));});p.stdin.on('error',()=>{});p.stdin.end(input);});}
export async function pgBootstrap(root){const real=await realpath(root),file=path.join(real,'instance.json'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw new Error('Unsafe instance bootstrap');const b=JSON.parse(await readFile(file,'utf8'));if(b.schemaVersion!=='2.0'||b.database?.kind!=='postgres')throw new Error('Explicit PostgreSQL instance required');const names=postgresNames(b.instanceId,b.database.volume);if(b.database.database!=='review'||b.database.service!=='postgres'||b.database.volume!==names.volume)throw new Error('Database locator identity mismatch');return {root:real,bootstrap:b,...names};}
export async function ensurePostgres(root,{create=false,start=true}={}){
 const p=await pgBootstrap(root),secret=path.join(p.root,'runtime/private/postgres-password');
 if(create){await mkdir(path.dirname(secret),{recursive:true,mode:0o700});try{await writeFile(secret,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
 const st=await lstat(secret);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw new Error('Unsafe database credential file');
 for(const [type,name] of [['network',p.network],['volume',p.volume]]){try{const found=JSON.parse(await docker([type,'inspect',name]))[0];if(found.Labels?.['review.instance']!==p.bootstrap.instanceId)throw new Error('PostgreSQL resource belongs to another instance');}catch(e){if(e.code!=='POSTGRES_DOCKER_FAILED')throw e;if(!create)throw new Error('PostgreSQL storage is missing; restore explicitly');await docker([type,'create','--label',`review.instance=${p.bootstrap.instanceId}`,name]);}}
 let inspection;try{inspection=JSON.parse(await docker(['inspect',p.container]))[0];}catch(e){if(e.code!=='POSTGRES_DOCKER_FAILED')throw e;}
 if(inspection){if(inspection.Config?.Labels?.['review.instance']!==p.bootstrap.instanceId||inspection.Config.Image!==POSTGRES_IMAGE||!inspection.Mounts?.some(m=>m.Type==='volume'&&m.Name===p.volume&&m.Destination==='/var/lib/postgresql')||!inspection.Mounts?.some(m=>m.Type==='bind'&&dockerHostPath(m.Source)===secret&&m.Destination==='/run/secrets/postgres-password'&&m.RW===false)||!inspection.NetworkSettings?.Networks?.[p.network]||Object.values(inspection.HostConfig?.PortBindings||{}).some(x=>x?.length))throw new Error('PostgreSQL owner identity mismatch');if(!inspection.State.Running){if(!start)throw new Error('PostgreSQL is stopped; start this instance explicitly');await docker(['start',p.container]);}}
 else {if(!start)throw new Error('PostgreSQL owner is unavailable');await docker(['run','-d','--name',p.container,'--label',`review.instance=${p.bootstrap.instanceId}`,'--restart','unless-stopped','--network',p.network,'--network-alias','postgres','--mount',`type=volume,source=${p.volume},target=/var/lib/postgresql`,'--mount',`type=bind,source=${secret},target=/run/secrets/postgres-password,readonly`,'--env','POSTGRES_USER=review','--env','POSTGRES_DB=review','--env','POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',POSTGRES_IMAGE]);}
 for(let i=0;i<60;i++){try{await docker(['exec',p.container,'pg_isready','-U','review','-d','review'],{timeout:3000});return p;}catch{await new Promise(r=>setTimeout(r,500));}}
 throw new Error('PostgreSQL did not become ready');
}
export async function runPostgresMaintenance(root,args,{input,readOnly=false,mounts=[],storageOwner,nodeHeapMiB,timeout=180000}={}){
 if(nodeHeapMiB!==undefined&&(!Number.isInteger(nodeHeapMiB)||nodeHeapMiB<256||nodeHeapMiB>8192))throw new Error('Maintenance heap must be 256..8192 MiB');
 if(!Number.isInteger(timeout)||timeout<1000||timeout>900000)throw new Error('Maintenance timeout must be 1000..900000 ms');
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
 const result=await docker(['run','--rm','-i','--init','--network',p.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m',...(owner?[]:bind({source:softwareRoot,target:'/app',readOnly:true})),...instanceMounts.flatMap(bind),...mounts.flatMap(bind),'--workdir','/app','--env','REVIEW_INSTANCE_ROOT=/instance','--env','REVIEW_DATABASE_BACKEND=postgres','--env','REVIEW_POSTGRES_HOST=postgres','--env','REVIEW_POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',...(readOnly?['--env','REVIEW_INSTANCE_READ_ONLY=1']:[]),owner?owner.imageId:'node:22-bookworm-slim','node',...(nodeHeapMiB===undefined?[]:[`--max-old-space-size=${nodeHeapMiB}`]),...args],{input,timeout});return result;
}
