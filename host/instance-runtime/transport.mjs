/** Host-side routing only. This module never imports SQLite or opens a database. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dockerHostPath } from './docker-path.mjs';

export class StorageOwnerError extends Error { constructor(code,message){super(message);this.code=code;} }
const fail=(code,message)=>{throw new StorageOwnerError(code,message);};
const cliPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'cli.mjs');
export const READ_ONLY_CLI_COMMANDS=new Set(['orchestration-read','git-business-state','host-profile','host-context','aux-get','aux-list','document-get','assistant-source-read','assistant-source-search','media-resolve','integrity','read-model-cleanup-plan']);
export const isContainerStorageRuntime=()=>process.platform==='linux' && (process.env.REVIEW_SQLITE_OWNER==='CONTAINER'||process.env.REVIEW_DATABASE_BACKEND==='postgres') && existsSync('/.dockerenv');
function environment(){
  const allowed=['PATH','HOME','LANG','LC_ALL','TMPDIR','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','REVIEW_INSTANCE_READ_ONLY'];
  if(isContainerStorageRuntime())allowed.push('REVIEW_SQLITE_OWNER','REVIEW_INSTANCE_ROOT','REVIEW_INSTANCE_ID','REVIEW_INSTANCE_DB','REVIEW_DATABASE_BACKEND','REVIEW_POSTGRES_HOST','REVIEW_POSTGRES_PASSWORD_FILE');
  return Object.fromEntries(allowed.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
}
function execute(command,args,{input,maxBuffer=32*1024*1024,timeout=30000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env:environment(),stdio:['pipe','pipe','pipe']});
    const stdout=[],stderr=[];let total=0,failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill('SIGTERM');reject(new StorageOwnerError('INSTANCE_CLI_FAILED','Instance transport timed out; result requires verification'));},timeout);
    child.stdout.on('data',chunk=>{total+=chunk.length;if(total>maxBuffer){failed=true;child.kill('SIGTERM');reject(new StorageOwnerError('INSTANCE_CLI_FAILED','Instance transport response exceeded limit'));}else stdout.push(chunk);});
    child.stderr.on('data',chunk=>{if(stderr.reduce((sum,item)=>sum+item.length,0)<65536)stderr.push(chunk);});
    child.once('error',()=>{clearTimeout(timer);failed=true;reject(new StorageOwnerError('STORAGE_OWNER_UNAVAILABLE','Required instance transport is unavailable'));});
    child.once('exit',(code)=>{clearTimeout(timer);if(failed)return;if(code!==0){
      // Never echo CLI stdin, auxiliary bytes, provider configuration or Docker env.
      let detail;for(const line of Buffer.concat(stderr).toString('utf8').trim().split('\n').reverse()){try{detail=JSON.parse(line).error;if(detail)break;}catch{}}
      const error=new StorageOwnerError('INSTANCE_CLI_FAILED','Instance repository command rejected');
      if(typeof detail==='string' && /^[A-Z0-9_]+$/.test(detail))error.repositoryCode=detail;
      reject(error);return;
    }resolve(Buffer.concat(stdout).toString('utf8'));});
    child.stdin.on('error',()=>{});
    child.stdin.end(input===undefined?undefined:Buffer.isBuffer(input)||typeof input==='string'?input:JSON.stringify(input));
  });
}
async function bootstrapAt(instanceRoot){
  if(!instanceRoot)fail('STORAGE_OWNER_INVALID','Explicit instance root is required');
  const root=await realpath(path.resolve(instanceRoot));
  const filename=path.join(root,'instance.json');const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail('STORAGE_OWNER_INVALID','Invalid instance bootstrap');
  const bootstrap=JSON.parse(await readFile(filename,'utf8'));
  if(!['1.0','2.0'].includes(bootstrap.schemaVersion)||typeof bootstrap.instanceId!=='string'||!bootstrap.instanceId||(bootstrap.schemaVersion==='1.0'?bootstrap.database!=='data/review.sqlite':bootstrap.database?.kind!=='postgres'))fail('STORAGE_OWNER_INVALID','Unsupported instance bootstrap');
  for(const name of ['data','media']){const directory=path.join(root,name);const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)fail('STORAGE_OWNER_INVALID','Instance managed directory is not canonical');}
  return {root,bootstrap};
}

export async function resolveStorageOwner(instanceRoot,{allowStopped=false}={}){
  const {root,bootstrap}=await bootstrapAt(instanceRoot);
  const marker=path.join(root,'runtime','storage-owner.json');
  let info;try{info=await lstat(marker);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536||(await realpath(path.dirname(marker)))!==path.dirname(marker))fail('STORAGE_OWNER_INVALID','Invalid storage owner marker');
  const bytes=await readFile(marker);let owner;try{owner=JSON.parse(bytes.toString('utf8'));}catch{fail('STORAGE_OWNER_INVALID','Storage owner marker is not valid JSON');}
  if(!['1.0','2.0'].includes(owner.schemaVersion)||owner.mode!=='DOCKER'||owner.instanceId!==bootstrap.instanceId||owner.hostRoot!==root||owner.containerRoot!=='/instance'||!/^[a-f0-9]{64}$/.test(owner.containerId||'')||!/^sha256:[a-f0-9]{64}$/.test(owner.imageId||'')||!(owner.softwareCommit==='UNVERSIONED'||/^[a-f0-9]{40,64}$/.test(owner.softwareCommit||'')))fail('STORAGE_OWNER_INVALID','Storage owner marker identity is invalid');
  let inspected;
  try{const result=JSON.parse(await execute('docker',['inspect',owner.containerId]));if(result.length!==1)throw new Error();inspected=result[0];}
  catch{fail('STORAGE_OWNER_UNAVAILABLE','Recorded Docker owner cannot be inspected; native SQLite fallback is forbidden');}
  const env=Object.fromEntries((inspected.Config?.Env||[]).map(value=>{const i=value.indexOf('=');return [value.slice(0,i),value.slice(i+1)];}));
  if(bootstrap.schemaVersion==='2.0'&&(owner.schemaVersion!=='2.0'||env.REVIEW_DATABASE_BACKEND!=='postgres'))fail('STORAGE_OWNER_MISMATCH','PostgreSQL backend differs from locator');
  if(inspected.Id!==owner.containerId||inspected.Image!==owner.imageId||inspected.Config?.Labels?.['org.opencontainers.image.revision']!==owner.softwareCommit||env.REVIEW_INSTANCE_ROOT!==owner.containerRoot)fail('STORAGE_OWNER_MISMATCH','Docker owner image, revision or instance root differs from the marker');
  const mounts=inspected.Mounts||[];
  for(const [source,destination] of [['instance.json','/instance/instance.json'],['data','/instance/data'],['media','/instance/media']]){
    const exact=mounts.filter(mount=>mount.Destination===destination);
    if(exact.length!==1||exact[0].Type!=='bind'||dockerHostPath(exact[0].Source)!==path.join(root,source))fail('STORAGE_OWNER_MISMATCH','Docker owner does not bind the exact instance bootstrap, database and media');
  }
  if(mounts.some(mount=>mount.Destination==='/app'||mount.Destination.startsWith('/app/')))fail('STORAGE_OWNER_MISMATCH','Docker owner software cannot be replaced by a host mount');
  if(mounts.some(mount=>mount.Destination.startsWith('/instance/data/')||mount.Destination.startsWith('/instance/media/')))fail('STORAGE_OWNER_MISMATCH','Nested instance mounts may not override the registered root');
  const running=Boolean(inspected.State?.Running && !inspected.State?.Paused && !inspected.State?.Restarting);
  if(!running&&inspected.State?.Running)fail('STORAGE_OWNER_STOPPED','Paused or restarting owners do not permit a second maintenance container');
  if(!running&&!allowStopped)fail('STORAGE_OWNER_STOPPED','Recorded Docker owner is not running; native SQLite fallback is forbidden');
  return {owner,hostRoot:root,containerRoot:owner.containerRoot,imageId:owner.imageId,containerId:owner.containerId,running,readOnly:env.REVIEW_INSTANCE_READ_ONLY==='1',backend:bootstrap.schemaVersion==='2.0'?'postgres':'sqlite',composeProject:inspected.Config?.Labels?.['com.docker.compose.project'],dataWritable:mounts.find(mount=>mount.Destination==='/instance/data').RW===true,user:inspected.Config?.User||undefined,markerSha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function runInstanceCli(instanceRoot,args,{input,allowStoppedReadOnly=false,expectedOwnerHash}={}){
  if(!Array.isArray(args)||!args.length||args.some(arg=>typeof arg!=='string')||args.includes('--instance'))fail('STORAGE_OWNER_INVALID','CLI arguments must select one explicit instance');
  const readOnly=READ_ONLY_CLI_COMMANDS.has(args[0]);
  const {root,bootstrap}=await bootstrapAt(instanceRoot);
  const owner=await resolveStorageOwner(root,{allowStopped:allowStoppedReadOnly&&readOnly});
  if(expectedOwnerHash!==undefined && expectedOwnerHash!==(owner?.markerSha256||'NONE'))fail('STORAGE_OWNER_MISMATCH','Storage owner changed; restart required');
  let output;
  if(bootstrap.schemaVersion==='2.0'&&(!owner||!owner.running)){if(owner&&!allowStoppedReadOnly)fail('STORAGE_OWNER_STOPPED','Explicit stopped-instance read required');const {runPostgresMaintenance}=await import('../../scripts/instance-postgres.mjs');output=(await runPostgresMaintenance(root,['host/instance-runtime/cli.mjs',...args,'--instance','/instance'],{input:input===undefined?undefined:typeof input==='string'||Buffer.isBuffer(input)?input:JSON.stringify(input),readOnly,storageOwner:owner})).toString();}
  else if(!owner){output=await execute(process.execPath,[cliPath,...args,'--instance',root],{input});}
  else if(owner.running){
    if(!readOnly&&(owner.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'))fail('STORAGE_READ_ONLY','Read-only instance transport cannot write auxiliary records');
    const command=['exec','-i','-e','REVIEW_SQLITE_OWNER=CONTAINER','-e','REVIEW_INSTANCE_ROOT=/instance','-e','REVIEW_INSTANCE_ID='+owner.owner.instanceId];
    if(process.env.REVIEW_INSTANCE_READ_ONLY==='1')command.push('-e','REVIEW_INSTANCE_READ_ONLY=1');
    output=await execute('docker',[...command,owner.containerId,'node','/app/host/instance-runtime/cli.mjs',...args,'--instance','/instance'],{input});
  }else{
    if(!allowStoppedReadOnly||!readOnly)fail('STORAGE_OWNER_STOPPED','Stopped owner permits only explicit maintenance reads');
    const command=['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m'];
    if(owner.user)command.push('--user',owner.user);
    // Preserve the owner's existing mount permission. A writable data directory
    // may create SQLite WAL/SHM side files; SQLite and CLI remain strictly read-only.
    // Originally read-only data mounts never receive a writable fallback.
    for(const name of ['instance.json','data','media'])command.push('--mount',`type=bind,source=${path.join(root,name)},target=/instance/${name}${name==='data'&&owner.dataWritable?'':',readonly'}`);
    command.push('-e','REVIEW_SQLITE_OWNER=CONTAINER','-e','REVIEW_INSTANCE_READ_ONLY=1','-e','REVIEW_INSTANCE_ROOT=/instance','-e','REVIEW_INSTANCE_ID='+owner.owner.instanceId,owner.imageId,'node','/app/host/instance-runtime/cli.mjs',...args,'--instance','/instance');
    output=await execute('docker',command,{input,timeout:60000});
  }
  try{return JSON.parse(output);}catch{fail('INSTANCE_CLI_FAILED','Instance transport returned an invalid response');}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);const index=args.indexOf('--instance');
    if(index<0||!args[index+1])fail('STORAGE_OWNER_INVALID','Explicit --instance is required');
    const instance=args[index+1];args.splice(index,2);
    const ownerIndex=args.indexOf('--expected-storage-owner-hash');let expectedOwnerHash;
    if(ownerIndex>=0){expectedOwnerHash=args[ownerIndex+1];args.splice(ownerIndex,2);}
    const inputChunks=[];if(!process.stdin.isTTY)for await(const chunk of process.stdin)inputChunks.push(chunk);
    const result=await runInstanceCli(instance,args,{input:inputChunks.length?Buffer.concat(inputChunks):undefined,expectedOwnerHash});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){process.stderr.write(JSON.stringify({error:error.code||'INSTANCE_CLI_FAILED',repositoryCode:error.repositoryCode})+'\n');process.exitCode=1;}
}
