import {randomBytes} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,writeFile,readdir,rm,chmod,statfs,unlink} from 'node:fs/promises';
import path from 'node:path';
import {command} from './vps-process.mjs';
import {canonicalJson,sha256} from './bytes.mjs';
import {readPackage,validatePackageManifest,PACKAGE_MANIFEST,receiveFile,immutablePackage,fileDescriptor,listPackageFiles,writeJsonAtomic} from './vps-package.mjs';
import {applyNginxConfigInPlace,nginxSha,patchNginxConfig} from './vps-nginx.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const absent=error=>error.code==='ENOENT';
const readJson=async filename=>JSON.parse(await readFile(filename,'utf8'));
export class VpsDriver{
 constructor(target,state,{allowDevelopment=false}={}){this.target=target;this.state=state;this.allowDevelopment=allowDevelopment;}
 async save(state){this.state=state;await writeJsonAtomic(path.join(this.target.hostRoot,'state.json'),state);}
 docker(args,options){return command(this.target.runtime.dockerBinary,['run','create'].includes(args[0])?[args[0],'--platform','linux/amd64','--pull','never',...args.slice(1)]:args,options);}
 async object(type,name){try{return JSON.parse(await this.docker([...(type==='container'?[]:[type]),'inspect',...(type==='image'?['--platform','linux/amd64']:[]),name]))[0];}catch(error){if(!/No such (?:object|image|volume|network|container)|not found/i.test(error.message))throw error;return null;}}
 async measure(){
  const root=this.target.hostRoot;let measured=root,fs;for(;;){try{fs=await statfs(measured);break;}catch(error){if(!absent(error)||measured==='/')throw error;measured=path.dirname(measured);}}
  const diskUsed=Number((fs.blocks-fs.bfree)*fs.bsize),freeBytes=Number(fs.bavail*fs.bsize);
  // Docker volumes/layers may be on a different filesystem from hostRoot.
  // On Desktop the daemon filesystem is observable through the existing Nginx;
  // on Linux inspect DockerRootDir directly. No diagnostic container is created.
  const dockerRoot=(await this.docker(['info','--format','{{.DockerRootDir}}'])).trim();
  let dockerFreeBytes,dockerFilesystemUsedBytes;
  if(process.platform==='linux'){
   const dockerFs=await statfs(dockerRoot);dockerFreeBytes=Number(dockerFs.bavail*dockerFs.bsize);dockerFilesystemUsedBytes=Number((dockerFs.blocks-dockerFs.bfree)*dockerFs.bsize);
  }else if(this.allowDevelopment){
   const line=(await this.docker(['exec',this.target.nginx.container,'df','-Pk','/'])).split('\n').at(-1).trim().split(/\s+/);
   dockerFreeBytes=Number(line[3])*1024;dockerFilesystemUsedBytes=Number(line[2])*1024;
  }else throw Error('Cannot observe Docker storage filesystem');
  if(!Number.isSafeInteger(dockerFreeBytes)||dockerFreeBytes<0)throw Error('Invalid Docker filesystem capacity evidence');
  const directoryBytes=async directory=>{let bytes=0;for(const entry of await readdir(directory,{withFileTypes:true}).catch(e=>{if(absent(e))return [];throw e;})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Owned tree contains a symlink');bytes+=entry.isDirectory()?await directoryBytes(file):Number((await lstat(file)).blocks)*512;}return bytes;};
  const rootBytes=await directoryBytes(root),volumes=[];
  for(const runtime of [this.state.current?.runtime,this.state.pending?.runtime].filter(Boolean)){
   const pg=await this.object('container',runtime.pg);if(pg?.State.Running){const bytes=Number((await this.docker(['exec',runtime.pg,'du','-sk','/var/lib/postgresql'])).split(/\s+/)[0])*1024;volumes.push({name:runtime.volume,bytes});}
  }
  const images=[];for(const id of new Set([...(this.state.imageInventory||[]),...[this.state.current?.runtime,this.state.pending?.runtime].filter(Boolean).flatMap(r=>[r.appImage,r.pgImage])])){const found=await this.object('image',id);if(found)images.push({id,bytes:found.Size});}
  return {freeBytes:Math.min(freeBytes,dockerFreeBytes),hostFreeBytes:freeBytes,dockerFreeBytes,dockerFilesystemUsedBytes,filesystemUsedBytes:diskUsed,rootAllocatedBytes:rootBytes,volumes:[...new Map(volumes.map(v=>[v.name,v])).values()],images,temporaryLimitBytes:this.target.retention.maxTemporaryBytes};
 }
 async inspect(state=this.state){
  const usage=await this.measure(),nginx=await this.object('container',this.target.nginx.container);
  const configuration=await readFile(this.target.nginx.configPath),nginxSha256=nginxSha(configuration);
  const dependencies={};
  for(const [key,args] of [['nodeBinary',['--version']],['dockerBinary',['version','--format','{{.Server.Version}}']],['bashBinary',['--version']],['pythonBinary',['--version']],['uvBinary',['--version']],['codexBinary',['--version']]]){
   try{dependencies[key]={status:'AVAILABLE',version:(await command(this.target.runtime[key],args)).split('\n')[0]};}catch{dependencies[key]={status:'MISSING_OR_INCOMPATIBLE'};}
  }
  try{dependencies.compose={status:'AVAILABLE',version:await this.docker(['compose','version','--short'])};}catch{dependencies.compose={status:'MISSING_OR_INCOMPATIBLE'};}
  const credentials={};for(const [key,file] of Object.entries({codexAuth:path.join(this.target.credentials.codexHome,'auth.json'),providerKey:this.target.credentials.providerKeyFile})){try{const s=await lstat(file);credentials[key]=s.isFile()&&!s.isSymbolicLink()&&!(s.mode&0o077)?'PRESENT_NOT_AUTHENTICATED':'UNSAFE';}catch{credentials[key]='MISSING';}}
  let fallbackRuntimeBudgetBytes=0;if(state.current?.cleanReady){const source=await this.cleanSource(state.current);fallbackRuntimeBudgetBytes=source.manifest.runtimeBudgetBytes;}
  return {status:'INSPECTED_READ_ONLY',...usage,targetId:this.target.targetId,currentReleaseId:state.current?.releaseId||'NONE',phase:state.pending?.phase||'COMPLETE',nginxSha256,nginxRunning:Boolean(nginx?.State.Running),nginxId:nginx?.Id||null,nginxMount:nginx?.Mounts?.find(m=>m.Type==='bind'&&m.Source.replace(/^\/host_mnt(?=\/)/,'')===this.target.nginx.configPath)||null,dependencies,credentials,fallbackRuntimeBudgetBytes,architecture:process.arch,platform:process.platform};
 }
 async validatePrepared(inspection){
  if(!this.allowDevelopment&&(inspection.platform!=='linux'||inspection.architecture!=='x64'))throw Error('Target must be inspected Linux x86_64');
  for(const key of ['nodeBinary','dockerBinary','bashBinary','compose'])if(inspection.dependencies[key]?.status!=='AVAILABLE')throw Error('Host dependency is not ready: '+key);
  const nodeVersion=inspection.dependencies.nodeBinary.version.match(/^v(\d+)\.(\d+)/);
  if(!nodeVersion||Number(nodeVersion[1])<22||Number(nodeVersion[1])===22&&Number(nodeVersion[2])<13||Number(inspection.dependencies.dockerBinary.version.split('.')[0])<29)throw Error('Node >=22.13 and Docker >=29 with platform-specific image inspection are required');
  if(inspection.dependencies.pythonBinary?.status!=='AVAILABLE')throw Error('Python is required for the exclusive publisher lock');
  if(!inspection.nginxRunning||!inspection.nginxMount)throw Error('Existing Nginx single-file mount is not ready');
  if(inspection.nginxSha256!==this.state.nginxSha256&&!this.state.nginxIntent)throw Error('Nginx configuration drifted since preparation');
  const network=await this.object('network',this.target.nginx.network);if(network?.Labels?.['review.vps.target']!==this.target.targetId)throw Error('Dedicated ingress network is not owned by this target');
  const peers=Object.values(network.Containers||{});for(const peer of peers){if(peer.Name===this.target.nginx.container)continue;const container=await this.object('container',peer.Name);if(container?.Config.Labels?.['review.vps.target']!==this.target.targetId||container.Config.Labels['review.vps.role']!=='web')throw Error('Untrusted peer on the dedicated ingress network');}
 }
 async nginx(options){
  const target=this.target,filename=target.nginx.configPath,container=await this.object('container',target.nginx.container),mount=container?.Mounts?.find(m=>m.Type==='bind'&&m.Source.replace(/^\/host_mnt(?=\/)/,'')===filename);
  if(!mount)throw Error('Nginx single-file bind mount changed');
  const mounted=async()=>Buffer.from(await this.docker(['exec',target.nginx.container,'cat',mount.Destination],{raw:true}));
  const validate=()=>this.docker(['exec',target.nginx.container,'nginx','-t']);
  const reload=()=>this.docker(['exec',target.nginx.container,'nginx','-s','reload']);
  const current=await readFile(filename),currentSha=nginxSha(current);
  if(this.state.nginxIntent){
   const intent=this.state.nginxIntent;
   if(currentSha===intent.afterSha256){await validate();await reload();if(nginxSha(await mounted())!==currentSha)throw Error('Nginx mounted state differs after interruption');this.state.nginxSha256=currentSha;this.state.nginxIntent=null;await this.save(this.state);}
   else if(currentSha!==intent.beforeSha256)throw Error('Nginx interrupted patch needs exact manual recovery; other bytes will not be overwritten');
  }
  if(currentSha!==this.state.nginxSha256)throw Error('Nginx SHA CAS mismatch');
  const planned=patchNginxConfig(current.toString('utf8'),target,options);
  this.state.nginxIntent={beforeSha256:currentSha,afterSha256:planned.sha256,beforeContents:current.toString('utf8')};await this.save(this.state);
  const result=await applyNginxConfigInPlace(filename,target,{...options,expectedSha256:currentSha,validate,reload,readBack:mounted});
  this.state.nginxSha256=result.afterSha256;this.state.nginxIntent=null;await this.save(this.state);return result;
 }
 async loadImages(source){
  for(const image of source.manifest.images){
   let existing=await this.object('image',image.reference);
   if(!existing){
    this.state.imageInventory=[...new Set([...(this.state.imageInventory||[]),image.reference])];await this.save(this.state);
    await this.docker(['image','load','--platform','linux/amd64'],{input:source.open(image.path)});existing=await this.object('image',image.reference);
   }
   if(!existing||existing.Id!==image.id||existing.Architecture!=='amd64'||existing.Os!=='linux'||image.role==='app'&&existing.Config?.Labels?.['org.opencontainers.image.revision']!==source.manifest.softwareCommit)throw Error('Loaded image differs from manifest');
  }
 }
 async verifySource(source){
  validatePackageManifest(source.manifest,{target:this.target,allowDevelopment:this.allowDevelopment});
  for(const file of source.manifest.files)for await(const _chunk of source.open(file.path)){};
  await this.loadImages(source);
  const app=source.manifest.images.find(i=>i.role==='app');
  const verifier='review-vps-verify-'+sha256(this.target.targetId+source.manifest.manifestSha256).slice(0,20);
  this.state.verifiers=[...new Set([...(this.state.verifiers||[]),verifier])];await this.save(this.state);
  const previous=await this.object('container',verifier);
  if(previous){
   if(previous.Config.Labels?.['review.vps.target']!==this.target.targetId||previous.Config.Labels?.['review.vps.manifest']!==source.manifest.manifestSha256||previous.Config.Labels?.['review.vps.role']!=='verifier')throw Error('Unowned verification container');
   if(previous.State.Running)await this.docker(['stop','--time','3',verifier]);
   if(await this.object('container',verifier))await this.docker(['container','rm',verifier]);
  }
  async function* stream(){yield Buffer.from(JSON.stringify(source.manifest.baseline)+'\n');for(let pass=0;pass<2;pass++)yield*source.open('baseline/'+source.manifest.baseline.database.path);}
  const result=JSON.parse(await this.docker(['run','--rm','-i','--name',verifier,'--label','review.vps.target='+this.target.targetId,'--label','review.vps.manifest='+source.manifest.manifestSha256,'--label','review.vps.role=verifier','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','2g','--log-opt','max-size=1m','--log-opt','max-file=1',app.reference,'node','--max-old-space-size=1536','scripts/instance-vps-check.mjs'],{input:stream()}));
  this.state.verifiers=this.state.verifiers.filter(n=>n!==verifier);await this.save(this.state);
  if(result.status!=='BASELINE_STREAM_VERIFIED'||result.instanceId!==source.manifest.business.instanceId)throw Error('Baseline semantic proof differs');
 }
 async cleanSource(release){
  if(!['clean-0','clean-1'].includes(release.slot))throw Error('Invalid clean slot');
  const source=await readPackage(path.join(this.target.hostRoot,release.slot),{target:this.target,allowDevelopment:this.allowDevelopment});
  if(source.manifest.releaseId!==release.releaseId||source.manifest.manifestSha256!==release.manifestSha256)throw Error('Clean package differs from published state');return source;
 }
 async runtimeIntent(manifest,attempt){
  const key=sha256(this.target.targetId+attempt).slice(0,20),stem='review-vps-'+key;
  return {id:'runtime_'+attempt,root:path.join(this.target.hostRoot,'instances','runtime_'+attempt),targetId:this.target.targetId,instanceId:manifest.business.instanceId,releaseId:manifest.releaseId,softwareCommit:manifest.softwareCommit,appImage:manifest.images.find(i=>i.role==='app').reference,pgImage:manifest.images.find(i=>i.role==='postgres').reference,pg:stem+'-pg',web:stem+'-web',shot:stem+'-shot',comment:stem+'-comment',material:stem+'-material',importer:stem+'-import',volume:'review_pg_'+key,network:'review-net-'+key,runtimeEpoch:null};
 }
 labels(runtime,role){return ['--label','review.vps.target='+this.target.targetId,'--label','review.vps.runtime='+runtime.id,'--label','review.vps.role='+role,'--label','review.instance='+runtime.instanceId];}
 async owned(type,name,runtime){
  const found=await this.object(type,name);if(!found)return null;
  const labels=type==='container'?found.Config?.Labels:found.Labels;
  if(labels?.['review.vps.target']!==this.target.targetId||labels?.['review.vps.runtime']!==runtime.id)throw Error('Refusing an unowned '+type+': '+name);return found;
 }
 async directory(runtime){
  if(!/^runtime_[a-f0-9-]{36}$/.test(runtime.id)||runtime.root!==path.join(this.target.hostRoot,'instances',runtime.id))throw Error('Unsafe runtime inventory');
  const owner=await readJson(path.join(runtime.root,'.vps-owner.json'));if(owner.id!==runtime.id||owner.targetId!==this.target.targetId||await realpath(runtime.root)!==runtime.root)throw Error('Runtime directory ownership differs');
 }
 async maintenance(runtime){
  if(runtime){await this.directory(runtime);await writeFile(path.join(runtime.root,'runtime/vps-maintenance'),'publication in progress\n',{mode:0o600});}
  await this.nginx({maintenance:true});
 }
 async runtimeCheck(runtime,verifyMedia=false){
  const found=await this.owned('container',runtime.web,runtime);if(!found?.State.Running)throw Error('Runtime web process is not available for quiescence verification');
  return JSON.parse(await this.docker(['exec',runtime.web,'node','scripts/instance-vps-runtime-check.mjs',...(verifyMedia?['--verify-media']:[])]));
 }
 async assertQuiescent(runtime){if(!runtime)return;const check=await this.runtimeCheck(runtime);if(check.blockers.length)throw Error('Unfinished or unknown execution; retain the runtime: '+JSON.stringify(check.blockers.slice(0,20)));}
 async drain(runtime){
  if(!runtime)return;
  for(let pass=0;pass<30;pass++){const check=await this.runtimeCheck(runtime);if(!check.blockers.length)return;if(check.blockers.some(b=>['UNKNOWN','RESULT_UNKNOWN'].includes(b.state)))throw Error('Unknown external execution blocks publication; do not retry');await pause(1000);}
  throw Error('Owned workers did not finish; maintenance and runtime are retained');
 }
 async removeRuntime(runtime){
  try{await this.bridge(runtime,'stop');}catch(error){if(!absent(error))throw error;}
  // Exact write-ahead inventory, not names discovered by broad Docker filters.
  for(const name of [runtime.importer,runtime.shot,runtime.comment,runtime.material,runtime.web,runtime.pg].filter(Boolean)){const found=await this.owned('container',name,runtime);if(found){if(found.State.Running)await this.docker(['stop','--time','30',name]);if(await this.owned('container',name,runtime))await this.docker(['container','rm',name]);}}
  for(const [type,name] of [['volume',runtime.volume],['network',runtime.network]])if(await this.owned(type,name,runtime))await this.docker([type,'rm',name]);
  try{await this.directory(runtime);await rm(runtime.root,{recursive:true});}catch(error){if(!absent(error))throw error;}
 }
 mounts(runtime,{mediaReadOnly=false}={}){
  return ['--mount',`type=bind,source=${runtime.root}/instance.json,target=/instance/instance.json,readonly`,...['data','media','scratch','backups','runtime'].flatMap(name=>['--mount',`type=bind,source=${runtime.root}/${name},target=/instance/${name}${name==='media'&&mediaReadOnly?',readonly':''}`]),'--mount',`type=bind,source=${runtime.root}/runtime/private/postgres-password,target=/run/secrets/postgres-password,readonly`,'--tmpfs','/instance/runtime/assistant/private:rw,noexec,nosuid,nodev,size=1m,mode=000'];
 }
 environment(runtime){return Object.entries({REVIEW_INSTANCE_ROOT:'/instance',REVIEW_SQLITE_OWNER:'CONTAINER',REVIEW_DATABASE_BACKEND:'postgres',REVIEW_POSTGRES_HOST:'postgres',REVIEW_POSTGRES_PASSWORD_FILE:'/run/secrets/postgres-password',REVIEW_SOFTWARE_COMMIT:runtime.softwareCommit,REVIEW_DEPLOYMENT_MODE:'VPS',REVIEW_VPS_ACCESS_MODE:this.target.accessMode||'BASIC_AUTH',REVIEW_DEPLOYMENT_ID:runtime.id,REVIEW_BASE_PATH:this.target.basePath,REVIEW_PUBLIC_URL:this.target.publicUrl,REVIEW_ALLOWED_ORIGINS:new URL(this.target.publicUrl).origin,SITE_BASE_URL:this.target.publicUrl,REVIEW_GIT_CHECKPOINT_DISABLED:'1'}).flatMap(([key,value])=>['--env',key+'='+value]);}
 async restore(source,runtime){
  let proof;
  try{proof=await readJson(path.join(runtime.root,'runtime/restore-proof.json'));await this.directory(runtime);}catch(error){if(!absent(error))throw error;}
  if(!proof){
   // A interrupted import is discardable, but only under this exact inventory.
   await this.removeRuntime(runtime);
   await mkdir(runtime.root,{recursive:true,mode:0o700});await writeJsonAtomic(path.join(runtime.root,'.vps-owner.json'),{id:runtime.id,targetId:this.target.targetId});
   for(const folder of ['data','media','scratch','backups','runtime/locks','runtime/private','runtime/assistant/public','runtime/assistant/private'])await mkdir(path.join(runtime.root,folder),{recursive:true,mode:0o700});
   await writeJsonAtomic(path.join(runtime.root,'instance.json'),{schemaVersion:'2.0',instanceId:runtime.instanceId,database:{kind:'postgres',database:'review',service:'postgres',volume:runtime.volume}});
   await writeFile(path.join(runtime.root,'runtime/private/postgres-password'),randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
   await writeJsonAtomic(path.join(runtime.root,'runtime/restore-manifest.json'),source.manifest.baseline);
   for(const file of source.manifest.baseline.files)await receiveFile(source,{...file,path:'baseline/'+file.path},path.join(runtime.root,file.path));
   await this.docker(['network','create',...this.labels(runtime,'database'),runtime.network]);
   await this.docker(['volume','create',...this.labels(runtime,'database'),runtime.volume]);
   await this.docker(['run','-d','--name',runtime.pg,...this.labels(runtime,'database'),'--network',runtime.network,'--network-alias','postgres','--restart','unless-stopped','--log-opt','max-size=10m','--log-opt','max-file=2','--mount',`type=volume,source=${runtime.volume},target=/var/lib/postgresql`,'--mount',`type=bind,source=${runtime.root}/runtime/private/postgres-password,target=/run/secrets/postgres-password,readonly`,'--env','POSTGRES_USER=review','--env','POSTGRES_DB=review','--env','POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password',runtime.pgImage]);
   let ready=false;for(let count=0;count<60;count++){try{await this.docker(['exec',runtime.pg,'pg_isready','-U','review','-d','review']);ready=true;break;}catch{await pause(500);}}if(!ready)throw Error('New PostgreSQL did not become ready');
   async function* database(){for(let pass=0;pass<4;pass++)yield*source.open('baseline/'+source.manifest.baseline.database.path);}
   proof=JSON.parse(await this.docker(['run','--rm','-i','--name',runtime.importer,...this.labels(runtime,'importer'),'--network',runtime.network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user',`${process.getuid()}:${process.getgid()}`,'--memory','2g',...this.mounts(runtime),...this.environment(runtime),runtime.appImage,'node','--max-old-space-size=1536','scripts/instance-vps-import.mjs'],{input:database()}));
   if(proof.status!=='RESTORED_VERIFIED'||proof.instanceId!==runtime.instanceId||proof.releaseId!==source.manifest.business.sourceReleaseId)throw Error('Restoration proof identity differs');
   await writeJsonAtomic(path.join(runtime.root,'runtime/restore-proof.json'),proof);
  }
  runtime.runtimeEpoch=proof.runtimeEpoch;await this.startWeb(runtime);
  // Host bridge/transport is the exact small software tree, never a copy of
  // the complete release or its database/media/image archives.
  for(const file of source.manifest.files.filter(f=>f.path.startsWith('software/'))){
   const filename=path.join(runtime.root,file.path);let present;try{present=await fileDescriptor(runtime.root,file.path);}catch(error){if(!absent(error))throw error;}
   if(present){if(present.sha256!==file.sha256||present.bytes!==file.bytes)throw Error('Runtime host software differs');continue;}
   await receiveFile(source,file,filename);
  }
 }
 async startWeb(runtime){
  const nginx=await this.object('container',this.target.nginx.container),proxyIp=nginx?.NetworkSettings?.Networks?.[this.target.nginx.network]?.IPAddress;if(!proxyIp)throw Error('Nginx is not on the inspected dedicated network');
  const existing=await this.owned('container',runtime.web,runtime);if(existing){if(!existing.State.Running)await this.docker(['start',runtime.web]);return;}
  await this.docker(['create','--name',runtime.web,...this.labels(runtime,'web'),'--network',runtime.network,'--restart','unless-stopped','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--init','--user',`${process.getuid()}:${process.getgid()}`,'--log-opt','max-size=10m','--log-opt','max-file=2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m',...this.mounts(runtime),...this.environment(runtime),'--env','REVIEW_RUNTIME_EPOCH='+runtime.runtimeEpoch,'--env','REVIEW_TRUSTED_PROXY_IP='+proxyIp,'--env','COMMENT_POLISH_WORKER_URL=http://'+runtime.comment+':8787','--env','MATERIAL_REVIEW_WORKER_URL=http://'+runtime.material+':8788',runtime.appImage]);
  await this.docker(['network','connect',this.target.nginx.network,runtime.web]);await this.docker(['start',runtime.web]);
 }
 async verifyRuntime(runtime,manifest){
  let check,error;
  for(let pass=0;pass<60;pass++){try{check=await this.runtimeCheck(runtime,true);break;}catch(reason){error=reason;await pause(500);}}
  if(!check)throw error;
  if(check.metadata.runtimeEpoch!==runtime.runtimeEpoch||check.metadata.instanceId!==runtime.instanceId||check.metadata.releaseId!==manifest.business.sourceReleaseId||!check.integrity?.ok)throw Error('Runtime database/media proof differs');
  const container=await this.owned('container',runtime.web,runtime);
  for(const image of manifest.images){const actual=await this.object('image',image.reference);if(actual?.Id!==image.id)throw Error('Runtime image reference digest changed');}
  const runningImage=await this.object('image',container.Image);
  if(runningImage?.Id!==manifest.images.find(i=>i.role==='app').id)throw Error('Running container image differs from the frozen platform config');
  if(container.Config.Image!==runtime.appImage||Object.values(container.HostConfig.PortBindings||{}).some(v=>v?.length)||!container.NetworkSettings.Networks[this.target.nginx.network])throw Error('Web image/network/port isolation differs');
  const health=JSON.parse(await this.docker(['exec',runtime.web,'node','-e',"fetch('http://127.0.0.1:3000/__review_health').then(async r=>{if(!r.ok)throw Error('unready');console.log(JSON.stringify(await r.json()))})"]));
  if(health.runtimeEpoch!==runtime.runtimeEpoch||health.basePath!==this.target.basePath)throw Error('Gateway runtime binding differs');
  // Read actual application HTTP inside its container; the public socket is
  // separately verified through authenticated isolated Nginx during rehearsal.
  await this.docker(['exec',runtime.web,'node','-e',`fetch('http://127.0.0.1:3001${this.target.basePath}/api/instance/profile').then(r=>{if(!r.ok)process.exit(1)})`]);
  const bootstrap=await readJson(path.join(runtime.root,'instance.json'));
  await writeJsonAtomic(path.join(runtime.root,'runtime/storage-owner.json'),{schemaVersion:'2.0',backend:'postgres',database:bootstrap.database,instanceId:runtime.instanceId,mode:'DOCKER',containerId:container.Id,containerRoot:'/instance',imageId:container.Image,softwareCommit:runtime.softwareCommit,hostRoot:runtime.root,composeProject:'review-vps-'+this.target.targetId});
 }
 async startWorkers(runtime){
  for(const [role,name,script] of [['shot',runtime.shot,'scripts/instance-shot-production-worker.mjs'],['comment',runtime.comment,'workers/comment-polish-server.mjs'],['material',runtime.material,'workers/material-review-server.mjs']]){
   if(await this.owned('container',name,runtime))continue;
   const ai=role!=='shot',secret=[];
   if(ai){try{const info=await lstat(this.target.credentials.providerKeyFile);if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw Error('unsafe');secret.push('--mount',`type=bind,source=${this.target.credentials.providerKeyFile},target=/run/secrets/provider-key,readonly`,'--env','OPENAI_API_KEY_FILE=/run/secrets/provider-key');}catch{runtime.aiReadiness='MISSING_OR_UNSAFE_CREDENTIAL';continue;}}
   await this.docker(['run','-d','--name',name,...this.labels(runtime,role),'--network',runtime.network,'--network-alias',name,'--restart','unless-stopped','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--init','--user',`${process.getuid()}:${process.getgid()}`,'--log-opt','max-size=10m','--log-opt','max-file=2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m',...this.mounts(runtime,{mediaReadOnly:ai}),...this.environment(runtime),'--env','COMMENT_POLISH_HOST=0.0.0.0','--env','MATERIAL_REVIEW_HOST=0.0.0.0',...secret,runtime.appImage,'node',script,...(ai?[]:['--instance','/instance'])]);
  }
  // Process/configuration readiness is intentionally not provider authentication.
  runtime.aiReadiness||='CONFIGURED_NOT_AUTHENTICATED';
  try{
   const auth=await lstat(path.join(this.target.credentials.codexHome,'auth.json'));
   if(!auth.isFile()||auth.isSymbolicLink()||auth.mode&0o077)throw Error('unsafe');
   if(this.allowDevelopment){runtime.codexReadiness='MOCK_REHEARSAL_NO_REAL_AUTH';return;}
   const bridge=await this.bridge(runtime,'start');runtime.codexReadiness=bridge.status;runtime.codexModelAuthentication='NOT_VERIFIED_BY_STARTUP';
  }catch{runtime.codexReadiness='MISSING_CREDENTIAL_OR_PREFLIGHT_FAILED';}
 }
 async bridge(runtime,action){
  const script=path.join(runtime.root,'software/scripts/instance-vps-bridge.mjs');await lstat(script);
  const paths=[path.dirname(this.target.runtime.nodeBinary),path.dirname(this.target.runtime.codexBinary),path.dirname(this.target.runtime.uvBinary),path.dirname(this.target.runtime.pythonBinary),'/usr/local/bin','/usr/bin','/bin'];
  return JSON.parse(await command(this.target.runtime.nodeBinary,[script,action,runtime.root],{env:{PATH:[...new Set(paths)].join(':'),LANG:'C.UTF-8',REVIEW_DEPLOYMENT_MODE:'VPS',REVIEW_CODEX_AUTH_HOME:this.target.credentials.codexHome,REVIEW_NODE_BINARY:this.target.runtime.nodeBinary,REVIEW_PYTHON_BINARY:this.target.runtime.pythonBinary,REVIEW_UV_BINARY:this.target.runtime.uvBinary,REVIEW_CODEX_BINARY:this.target.runtime.codexBinary,REVIEW_EXECUTABLE_PATH:[...new Set(paths)].join(':')}}));
 }
 async open(runtime){
  await this.startWorkers(runtime);await unlink(path.join(runtime.root,'runtime/vps-maintenance')).catch(e=>{if(!absent(e))throw e;});
  const web=await this.owned('container',runtime.web,runtime),address=web.NetworkSettings.Networks[this.target.nginx.network].IPAddress;
  await this.nginx({upstream:address+':3000'});
 }
 async removeClean(release){
  if(!['clean-0','clean-1'].includes(release.slot))throw Error('Unsafe clean slot');const root=path.join(this.target.hostRoot,release.slot);
  let source;try{source=await this.cleanSource(release);}catch(error){if(absent(error))return;throw error;}
  const files=await listPackageFiles(root);if(JSON.stringify(files)!==JSON.stringify([...source.manifest.files.map(f=>f.path),PACKAGE_MANIFEST].sort()))throw Error('Unregistered clean-package contents; refusing deletion');
  const writable=async directory=>{await chmod(directory,0o700);for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isDirectory())await writable(path.join(directory,entry.name));};await writable(root);await rm(root,{recursive:true});
 }
 async saveClean(source,release){
  const root=path.join(this.target.hostRoot,release.slot),ownerFile=root+'.owner.json';
  let owner;try{owner=await readJson(ownerFile);}catch(error){if(!absent(error))throw error;}
  if(owner&&owner.manifestSha256!==release.manifestSha256){try{await lstat(root);throw Error('Clean slot still belongs to another release');}catch(error){if(!absent(error))throw error;}}
  await writeJsonAtomic(ownerFile,{manifestSha256:release.manifestSha256,targetId:this.target.targetId});await mkdir(root,{recursive:true,mode:0o700});
  if(await realpath(root)!==root)throw Error('Clean slot may not be a symlink');
  try{const completed=await this.cleanSource(release);await this.verifySource(completed);await immutablePackage(root);await this.reclaimUnusedImages();return;}catch(error){if(!absent(error))throw error;}
  for(const file of source.manifest.files){const filename=path.join(root,file.path);let existing;try{existing=await fileDescriptor(root,file.path);}catch(error){if(!absent(error))throw error;}
   if(existing?.sha256===file.sha256&&existing.bytes===file.bytes)continue;
   if(existing)await unlink(filename);await receiveFile(source,file,filename);
  }
  await writeJsonAtomic(path.join(root,PACKAGE_MANIFEST),source.manifest);const saved=await this.cleanSource(release);await this.verifySource(saved);await immutablePackage(root);
  await this.reclaimUnusedImages();
 }
 async reclaimUnusedImages(){
  const current=this.state.current?.runtime,retained=new Set([current?.appImage,current?.pgImage]);
  const containers=JSON.parse(await this.docker(['container','ls','-a','--no-trunc','--format','json']).then(text=>'['+text.split('\n').filter(Boolean).join(',')+']'));
  const inUse=new Set();for(const item of containers){const c=await this.object('container',item.ID);if(c){inUse.add(c.Image);inUse.add(c.Config.Image);}}
  for(const id of this.state.imageInventory||[]){if(retained.has(id)||inUse.has(id))continue;const image=await this.object('image',id);if(image&&!inUse.has(image.Id))await this.docker(['image','rm',id]);}
 }
}
