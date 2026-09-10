import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,constants} from 'node:fs';
import {lstat,readFile,realpath,readdir,mkdir,chmod,open,rename} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {canonicalJson,sha256} from './bytes.mjs';
import {validateRuntimeCapacity,validateRestoreMeasurement,restoreContractFromFiles,restoreMethodSha256} from './vps-capacity.mjs';

export const PACKAGE_MANIFEST='vps-package.json';
export function relativePackagePath(value){
 if(typeof value!=='string'||!value||value.includes('\\')||value.startsWith('/')||value.includes('\0')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe release package path');return value;
}
export async function canonicalFile(root,relative){
 const filename=path.join(root,relativePackagePath(relative)),info=await lstat(filename);
 if(!info.isFile()||info.isSymbolicLink()||await realpath(filename)!==filename)throw Error('Release files must be canonical regular files: '+relative);
 return filename;
}
export async function fileDescriptor(root,relative){
 const filename=await canonicalFile(root,relative),hash=createHash('sha256'),before=await lstat(filename,{bigint:true});let bytes=0;
 for await(const chunk of createReadStream(filename,{flags:constants.O_RDONLY|constants.O_NOFOLLOW})){hash.update(chunk);bytes+=chunk.length;}
 const after=await lstat(filename,{bigint:true});if(['ino','dev','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||BigInt(bytes)!==after.size)throw Error('File changed while hashing: '+relative);
 return {path:relative,bytes,sha256:hash.digest('hex')};
}
export async function listPackageFiles(root,prefix=''){
 const result=[];
 for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})){
  const relative=prefix?prefix+'/'+entry.name:entry.name;
  if(entry.isSymbolicLink())throw Error('Release package may not contain symlinks');
  if(entry.isDirectory())result.push(...await listPackageFiles(root,relative));
  else if(entry.isFile())result.push(relative);else throw Error('Release package may not contain special files');
 }
 return result.sort();
}
export function validatePackageManifest(value,{target,allowDevelopment=false}={}){
 const {manifestSha256,...body}=value||{};
 if(body.kind!=='REVIEW_VPS_PACKAGE'||body.schemaVersion!=='1.0'||manifestSha256!==sha256(canonicalJson(body)))throw Error('Invalid VPS package manifest SHA/schema');
 if(!/^[a-f0-9]{40}$/.test(body.softwareCommit||'')&&!(allowDevelopment&&body.softwareCommit==='UNVERSIONED'))throw Error('VPS package requires an exact core commit');
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,100}$/.test(body.releaseId||'')||body.architecture!=='linux/amd64'||body.credentialsIncluded!==false||body.runtimeIncluded!==false)throw Error('Invalid package release/architecture/exclusions');
 if(!body.business?.instanceId||!body.business.sourceReleaseId||!body.baseline||body.baseline.instanceId!==body.business.instanceId||body.baseline.releaseId!==body.business.sourceReleaseId||body.baseline.schemaVersion!=='2.0')throw Error('Release package business binding differs');
 if(target&&(body.basePath!==target.basePath||body.architecture!==target.runtime.architecture))throw Error('Package target build contract differs');
 if(!Array.isArray(body.files)||body.files.length===0||new Set(body.files.map(f=>f.path)).size!==body.files.length)throw Error('Package file inventory is invalid');
 for(const file of body.files){relativePackagePath(file.path);if(!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid package file size/SHA');}
 const files=new Map(body.files.map(f=>[f.path,f]));
 for(const item of [body.baseline.database,...body.baseline.files]){
  const registered=files.get('baseline/'+relativePackagePath(item.path));if(!registered||registered.sha256!==item.sha256||registered.bytes!==item.bytes)throw Error('Baseline file inventory differs');
 }
 if(!Array.isArray(body.images)||body.images.length!==2||body.images.map(i=>i.role).sort().join(',')!=='app,postgres')throw Error('Package needs complete app and PostgreSQL images');
 for(const image of body.images){if(!files.has(image.path)||!/^sha256:[a-f0-9]{64}$/.test(image.id)||image.reference!=='review-vps-artifact:'+body.releaseId+'-'+image.role||!Number.isSafeInteger(image.loadedBytes)||image.loadedBytes<=0||image.architecture!=='linux/amd64')throw Error('Invalid immutable image descriptor');}
 if(body.totalFileBytes!==body.files.reduce((n,f)=>n+f.bytes,0)||!Number.isSafeInteger(body.runtimeBudgetBytes)||body.runtimeBudgetBytes<=0)throw Error('Package capacity inventory differs');
 if(body.capacity)validateRuntimeCapacity(body.capacity,body.baseline,body.files,body.runtimeBudgetBytes);
 return Object.freeze(value);
}
export async function readPackage(directory,options={}){
 const root=await realpath(directory);if(root!==path.resolve(directory))throw Error('Package directory must be canonical');
 const manifest=validatePackageManifest(JSON.parse(await readFile(await canonicalFile(root,PACKAGE_MANIFEST),'utf8')),options);
 return {root,manifest,open:file=>verifiedFileStream(root,manifest.files.find(f=>f.path===file)||(()=>{throw Error('Unregistered stream path');})())};
}
export async function* verifiedFileStream(root,descriptor){
 const filename=await canonicalFile(root,descriptor.path),before=await lstat(filename,{bigint:true}),hash=createHash('sha256');let bytes=0;
 if(before.size!==BigInt(descriptor.bytes))throw Error('Stream source size differs');
 for await(const chunk of createReadStream(filename,{flags:constants.O_RDONLY|constants.O_NOFOLLOW})){bytes+=chunk.length;if(bytes>descriptor.bytes)throw Error('Stream source grew');hash.update(chunk);yield chunk;}
 const after=await lstat(filename,{bigint:true});if(bytes!==descriptor.bytes||hash.digest('hex')!==descriptor.sha256||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]))throw Error('Stream source changed or SHA differs');
}
export async function verifyPackage(directory,options={}){
 const source=await readPackage(directory,options),{root,manifest}=source;
 const actual=await listPackageFiles(root),expected=[...manifest.files.map(f=>f.path),PACKAGE_MANIFEST].sort();
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Package contains missing or unregistered files');
 for(const file of manifest.files)for await(const _chunk of source.open(file.path)){};
 const baseline=JSON.parse(await readFile(path.join(root,'baseline/backup-manifest.json'),'utf8'));
 if(canonicalJson(baseline)!==canonicalJson(manifest.baseline))throw Error('Embedded baseline manifest differs');
 const {verifyBackup}=await import('../../scripts/instance-transfer.mjs');await verifyBackup(path.join(root,'baseline'));
 const {verifySoftwarePackage}=await import('../../scripts/instance-software-pin.mjs');
 await verifySoftwarePackage(path.join(root,'software'),{expectedCommit:manifest.softwareCommit,allowUnversioned:options.allowDevelopment});
 if(manifest.capacity){const software=JSON.parse(await readFile(path.join(root,'software/software-manifest.json'),'utf8'));const implementation=restoreMethodSha256(await readFile(path.join(root,'software/host/instance-runtime/vps-driver.mjs'),'utf8'));validateRestoreMeasurement(manifest.capacity.measurement,baseline,{restoreContractSha256:restoreContractFromFiles(software.files,implementation)});}
 return {status:'VPS_PACKAGE_VERIFIED',releaseId:manifest.releaseId,softwareCommit:manifest.softwareCommit,instanceId:manifest.business.instanceId,manifestSha256:manifest.manifestSha256,files:manifest.files.length,bytes:manifest.totalFileBytes};
}
export async function immutablePackage(root){
 for(const filename of await listPackageFiles(root))await chmod(path.join(root,filename),0o444);
 const freeze=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isDirectory())await freeze(path.join(directory,entry.name));await chmod(directory,0o555);};await freeze(root);
}
export async function writeJsonAtomic(filename,value){
 const temporary=filename+'.next',handle=await open(temporary,'w',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 await rename(temporary,filename);const directory=await open(path.dirname(filename),'r');try{await directory.sync();}finally{await directory.close();}
}
export async function receiveFile(source,file,filename,{resume=false}={}){
 if(resume){try{const existing=await fileDescriptor(path.dirname(filename),path.basename(filename));if(existing.bytes===file.bytes&&existing.sha256===file.sha256)return;}catch(error){if(error.code!=='ENOENT')throw error;}}
 await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
 // Incomplete bytes occupy the final slot, never an additional full archive.
 const output=createWriteStream(filename,{flags:'wx',mode:0o600}),hash=createHash('sha256');let bytes=0;
 async function* chunks(){for await(const chunk of source.open(file.path)){bytes+=chunk.length;if(bytes>file.bytes)throw Error('Transfer exceeds frozen capacity');hash.update(chunk);yield chunk;}if(bytes!==file.bytes||hash.digest('hex')!==file.sha256)throw Error('Transfer SHA/size differs');}
 await pipeline(chunks(),output);const handle=await open(filename,'r');try{await handle.sync();}finally{await handle.close();}
}
