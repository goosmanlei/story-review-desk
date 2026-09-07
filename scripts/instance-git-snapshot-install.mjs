import {createReadStream} from 'node:fs';
import {readFile,writeFile,readdir,lstat,mkdir,realpath,rename,rm,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
const names=['RESTORE.md','manifest.json','repository.jsonl.gz'];
const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
async function exists(file){try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function safeDirectory(file){const info=await lstat(file);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(file)!==file)throw Error('Checkpoint directory is not canonical');}
export async function verifyManagedSnapshot(folder,instanceId,expectedSha){
 await safeDirectory(folder);
 if((await readdir(folder)).sort().join(',')!==names.join(','))throw Error('Snapshot contains unknown or incomplete files; preserve for inspection');
 for(const name of names){const file=path.join(folder,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||await realpath(file)!==file)throw Error('Managed snapshot file is not canonical');}
 const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8')),{manifestSha256,...body}=manifest;
 if(body.kind!=='REVIEW_GIT_BUSINESS_SNAPSHOT_1'||body.instanceId!==instanceId||sha256(canonicalJson(body))!==manifestSha256||expectedSha&&manifestSha256!==expectedSha||body.database.path!=='repository.jsonl.gz'||body.documentation?.path!=='RESTORE.md')throw Error('Managed snapshot identity differs');
 if((await lstat(path.join(folder,'repository.jsonl.gz'))).size!==body.database.bytes||await digest(path.join(folder,'repository.jsonl.gz'))!==body.database.sha256||await digest(path.join(folder,'RESTORE.md'))!==body.documentation.sha256)throw Error('Existing snapshot was modified or is incomplete; never overwrite user bytes');
 return manifest;
}
async function workRoot(instanceRoot){const folder=path.join(instanceRoot,'runtime','git-checkpoint');try{await mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}await safeDirectory(folder);return folder;}
export async function recoverCheckpointInstall(instanceRoot,binding){
 const work=await workRoot(instanceRoot),journal=path.join(work,'pending-install.json');if(!await exists(journal))return false;
 const info=await lstat(journal);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('Checkpoint install journal is unsafe');
 const value=JSON.parse(await readFile(journal,'utf8')),{sha256:hash,...body}=value;
 const target=path.join(binding.repositoryRoot,binding.snapshotPath);
 if(sha256(canonicalJson(body))!==hash||body.instanceId!==binding.instanceId||body.target!==target||path.dirname(body.staging)!==binding.repositoryRoot||!path.basename(body.staging).startsWith(binding.snapshotPath+'-staging-')||path.dirname(body.previous)!==work||!/^replaced-[a-f0-9-]{36}$/.test(path.basename(body.previous)))throw Error('Checkpoint install journal escapes its explicit binding');
 if(await exists(target)){
  const current=await verifyManagedSnapshot(target,binding.instanceId);
  if(current.manifestSha256!==body.newManifestSha){
   if(current.manifestSha256!==body.previousManifestSha||await exists(body.previous))throw Error('Checkpoint target changed during install');
   await verifyManagedSnapshot(body.staging,binding.instanceId,body.newManifestSha);await rename(target,body.previous);
  }
 }
 if(!await exists(target)){
  if(body.previousManifestSha)await verifyManagedSnapshot(body.previous,binding.instanceId,body.previousManifestSha);
  await verifyManagedSnapshot(body.staging,binding.instanceId,body.newManifestSha);await rename(body.staging,target);
 }
 await verifyManagedSnapshot(target,binding.instanceId,body.newManifestSha);
 for(const [folder,expected]of [[body.previous,body.previousManifestSha],[body.staging,body.newManifestSha]])if(await exists(folder)){await verifyManagedSnapshot(folder,binding.instanceId,expected);await rm(folder,{recursive:true,force:true});}
 await unlink(journal);return true;
}
export async function installCheckpointSnapshot(instanceRoot,binding,staging){
 if(await recoverCheckpointInstall(instanceRoot,binding))throw Error('Recovered a prior checkpoint; reread its business fingerprint before starting another');
 const work=await workRoot(instanceRoot),target=path.join(binding.repositoryRoot,binding.snapshotPath),previous=path.join(work,'replaced-'+randomUUID());
 const next=await verifyManagedSnapshot(staging,binding.instanceId),old=await exists(target)?await verifyManagedSnapshot(target,binding.instanceId):null;
 const body={instanceId:binding.instanceId,target,staging,previous,newManifestSha:next.manifestSha256,previousManifestSha:old?.manifestSha256||null};
 await writeFile(path.join(work,'pending-install.json'),canonicalJson({...body,sha256:sha256(canonicalJson(body))}),{flag:'wx',mode:0o600});
 await recoverCheckpointInstall(instanceRoot,binding);
}
