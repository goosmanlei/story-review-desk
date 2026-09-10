import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {backupPostgresInstance} from './instance-transfer.mjs';
import {inspectPackageSource,assertPackageSourceUnchanged} from './instance-package-source.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {listPackageFiles,fileDescriptor,verifyPackage,immutablePackage,PACKAGE_MANIFEST} from '../host/instance-runtime/vps-package.mjs';

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
export async function packVps({target,instance,output,sourceRoot,development=false}){
 const source=await inspectPackageSource(sourceRoot,{requestedCommit:development?'UNVERSIONED':undefined,explicitDevelopment:development}),root=path.resolve(output);
 if(root===source.root||root.startsWith(source.root+'/'))throw Error('Release packages must be outside source checkout');
 await mkdir(root,{mode:0o700});
 const releaseId='release_'+randomUUID(),software=path.join(root,'software');
 await command(process.execPath,['scripts/instance-package.mjs','--output',software,'--software-commit',source.softwareCommit],{cwd:sourceRoot});
 await backupPostgresInstance(instance,path.join(root,'baseline'));
 const baseline=JSON.parse(await readFile(path.join(root,'baseline/backup-manifest.json'),'utf8'));
 await mkdir(path.join(root,'images'),{mode:0o700});
 const tag='review-vps-build:'+releaseId,build=['build','--platform','linux/amd64','--build-arg','REVIEW_SOFTWARE_COMMIT='+source.softwareCommit,'--build-arg','REVIEW_DEPLOYMENT_MODE=VPS','--build-arg','REVIEW_BASE_PATH='+target.basePath,'-t',tag,software];
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
 const databaseBytes=baseline.database.bytes,mediaBytes=baseline.files.reduce((n,f)=>n+f.bytes,0);
 const body={schemaVersion:'1.0',kind:'REVIEW_VPS_PACKAGE',releaseId,softwareCommit:source.softwareCommit,architecture:'linux/amd64',basePath:target.basePath,business:{instanceId:baseline.instanceId,sourceReleaseId:baseline.releaseId,repositoryRevision:baseline.repositoryRevision},baseline,images,files,totalFileBytes:files.reduce((n,f)=>n+f.bytes,0),runtimeBudgetBytes:Math.max(512*1024**2,databaseBytes*6)+mediaBytes+images.reduce((n,i)=>n+i.loadedBytes,0),credentialsIncluded:false,runtimeIncluded:false,createdAt:new Date().toISOString()};
 await writeFile(path.join(root,PACKAGE_MANIFEST),JSON.stringify({...body,manifestSha256:sha256(canonicalJson(body))},null,2)+'\n',{flag:'wx',mode:0o600});
 await assertPackageSourceUnchanged(source);const verified=await verifyPackage(root,{target,allowDevelopment:development});await immutablePackage(root);return {...verified,output:root};
}
