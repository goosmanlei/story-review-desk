import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,realpath} from 'node:fs/promises';
import {createWriteStream,constants} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {backupPostgresInstance,verifyBackup} from './instance-transfer.mjs';
import {inspectPackageSource,assertPackageSourceUnchanged} from './instance-package-source.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {listPackageFiles,fileDescriptor,verifyPackage,immutablePackage,PACKAGE_MANIFEST} from '../host/instance-runtime/vps-package.mjs';
import {restoreContractFromFiles,restoreMethodSha256,runtimeCapacity,validateRestoreMeasurement} from '../host/instance-runtime/vps-capacity.mjs';
import {measureVpsRestore} from './instance-vps-capacity.mjs';

export async function command(binary,args,{cwd,input,output,maxOutputBytes=4*1024**2,env=process.env}={}){
 const child=spawn(binary,args,{cwd,env,stdio:['pipe','pipe','pipe']});let out='',err='';
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(`${path.basename(binary)} ${args[0]} failed (${code}): ${err.slice(-8000)}`)));});
 done.catch(()=>{});
 child.stderr.on('data',chunk=>{err=(err+chunk).slice(-16000);});
 let reader;
 if(output)reader=pipeline(child.stdout,createWriteStream(output,{flags:'wx',mode:0o600}));
 else child.stdout.on('data',chunk=>{out+=chunk;if(Buffer.byteLength(out)>maxOutputBytes)child.kill('SIGTERM');});
 try{if(input)await pipeline(input,child.stdin);else child.stdin.end();await done;if(reader)await reader;return out.trim();}catch(error){child.kill('SIGTERM');await done.catch(()=>{});throw error;}
}
export async function copyFrozenBaseline(source,output){
 source=await realpath(source);output=path.resolve(output);
 if(output===source||output.startsWith(source+'/'))throw Error('Baseline output must be independent');
 const proof=await verifyBackup(source),bytes=await readFile(path.join(source,'backup-manifest.json')),manifest=JSON.parse(bytes);
 const {manifestSha256,...body}=manifest;
 if(manifestSha256!==proof.manifestSha256||sha256(canonicalJson(body))!==manifestSha256||manifest.schemaVersion!=='2.0'||proof.streamed!==true)throw Error('Verified PostgreSQL baseline required');
 await mkdir(output,{mode:0o700});
 // Only registered archive/media bytes are copied, not extra files or state.
 for(const file of [manifest.database,...manifest.files]){const target=path.join(output,file.path);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(path.join(source,file.path),target,constants.COPYFILE_EXCL);}
 await writeFile(path.join(output,'backup-manifest.json'),bytes,{flag:'wx',mode:0o600});
 const copied=await verifyBackup(output);if(copied.manifestSha256!==proof.manifestSha256)throw Error('Baseline changed during copy');return copied;
}
export async function packVps({target,instance,baseline:baselineSource,capacityMeasurement,output,sourceRoot,development=false}){
 if(Boolean(instance)===Boolean(baselineSource))throw Error('Choose one live instance or verified local baseline');
 const source=await inspectPackageSource(sourceRoot,{requestedCommit:development?'UNVERSIONED':undefined,explicitDevelopment:development}),root=path.resolve(output);
 if(root===source.root||root.startsWith(source.root+'/'))throw Error('Release packages must be outside source checkout');
 await mkdir(root,{mode:0o700});
 const releaseId='release_'+randomUUID(),software=path.join(root,'software');
 await command(process.execPath,['scripts/instance-package.mjs','--output',software,'--software-commit',source.softwareCommit],{cwd:sourceRoot});
 // A native-architecture immutable reader uses this release's archive fixes,
 // without replacing the live owner or requiring emulation for the large scan.
 // This image is local-only; only the linux/amd64 runtime images enter the pack.
 const backupTag='review-vps-backup:'+releaseId;
 if(!baselineSource||!capacityMeasurement){
  await command('docker',['build','--build-arg','REVIEW_SOFTWARE_COMMIT='+source.softwareCommit,'-t',backupTag,software]);
 }
 if(baselineSource)await copyFrozenBaseline(baselineSource,path.join(root,'baseline'));
 else{
  const backupImage=JSON.parse(await command('docker',['image','inspect',backupTag]))[0];
  await backupPostgresInstance(instance,path.join(root,'baseline'),{maintenanceTimeoutMs:3600000,backupSoftware:{imageId:backupImage.Id,softwareCommit:source.softwareCommit}});
 }
 const baseline=JSON.parse(await readFile(path.join(root,'baseline/backup-manifest.json'),'utf8'));
 const softwareManifest=JSON.parse(await readFile(path.join(software,'software-manifest.json'),'utf8'));
 const restoreContractSha256=restoreContractFromFiles(softwareManifest.files,restoreMethodSha256(await readFile(path.join(software,'host/instance-runtime/vps-driver.mjs'),'utf8')));
 let measurement;
 if(capacityMeasurement)measurement=validateRestoreMeasurement(JSON.parse(await readFile(capacityMeasurement,'utf8')),baseline,{restoreContractSha256});
 else{
  const native=JSON.parse(await command('docker',['image','inspect',backupTag]))[0],architecture=native.Os+'/'+native.Architecture;
  await command('docker',['pull','--platform',architecture,'postgres:18.6']);
  measurement=await measureVpsRestore({target,baselineRoot:path.join(root,'baseline'),baseline,softwareCommit:source.softwareCommit,restoreContractSha256,appImage:backupTag,postgresImage:'postgres:18.6',architecture,auditPath:root+'.capacity.json'});
 }
 if(!baselineSource||!capacityMeasurement)await command('docker',['image','rm',backupTag]);
 await mkdir(path.join(root,'images'),{mode:0o700});
 const tag='review-vps-build:'+releaseId,build=['build','--no-cache','--platform','linux/amd64','--build-arg','REVIEW_SOFTWARE_COMMIT='+source.softwareCommit,'--build-arg','REVIEW_DEPLOYMENT_MODE=VPS','--build-arg','REVIEW_BASE_PATH='+target.basePath,'-t',tag,software];
 await command('docker',build);await command('docker',['pull','--platform','linux/amd64','postgres:18.6']);
 const images=[];
 for(const [role,image] of [['app',tag],['postgres','postgres:18.6']]){
  const info=JSON.parse(await command('docker',['image','inspect','--platform','linux/amd64',image]))[0];
  if(info.Os!=='linux'||info.Architecture!=='amd64'||role==='app'&&info.Config.Labels['org.opencontainers.image.revision']!==source.softwareCommit)throw Error('Built image architecture or exact commit differs');
  // Docker's containerd image store exposes platform config IDs which are not
  // necessarily directly addressable. A package-owned tag transports that
  // platform; its config digest is checked before every use with --pull never.
  const reference='review-vps-artifact:'+releaseId+'-'+role;
  await command('docker',['image','tag',image,reference]);
  const relative='images/'+role+'.tar';await command('docker',['image','save','--platform','linux/amd64',reference],{output:path.join(root,relative)});
  images.push({role,path:relative,id:info.Id,reference,loadedBytes:info.Size,architecture:'linux/amd64'});
 }
 const files=[];for(const file of await listPackageFiles(root))files.push(await fileDescriptor(root,file));
 const capacity=runtimeCapacity(measurement,baseline,files);
 const body={schemaVersion:'1.0',kind:'REVIEW_VPS_PACKAGE',releaseId,softwareCommit:source.softwareCommit,architecture:'linux/amd64',basePath:target.basePath,business:{instanceId:baseline.instanceId,sourceReleaseId:baseline.releaseId,repositoryRevision:baseline.repositoryRevision},baseline,images,files,totalFileBytes:files.reduce((n,f)=>n+f.bytes,0),capacity,runtimeBudgetBytes:capacity.runtimeBudgetBytes,credentialsIncluded:false,runtimeIncluded:false,createdAt:new Date().toISOString()};
 await writeFile(path.join(root,PACKAGE_MANIFEST),JSON.stringify({...body,manifestSha256:sha256(canonicalJson(body))},null,2)+'\n',{flag:'wx',mode:0o600});
 await assertPackageSourceUnchanged(source);const verified=await verifyPackage(root,{target,allowDevelopment:development});await immutablePackage(root);return {...verified,output:root};
}
