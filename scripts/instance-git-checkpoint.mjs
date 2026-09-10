import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,realpath,rename,unlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {runInstanceCli} from '../host/instance-runtime/transport.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {exportGitSnapshot} from './instance-git-export.mjs';
import {verifySoftwarePin} from './instance-software-pin.mjs';
import {recoverCheckpointInstall,installCheckpointSnapshot,verifyManagedSnapshot} from './instance-git-snapshot-install.mjs';
const filename=fileURLToPath(import.meta.url),SOFTWARE_ROOT=path.resolve(path.dirname(filename),'..');
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const safeRelative=value=>{if(typeof value!=='string'||path.isAbsolute(value)||/[\\\0]/.test(value)||value.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Unsafe configured project-relative path');return value;};
async function regular(filename,max=1024*1024){const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size>max||await realpath(filename)!==filename)throw Error('Expected canonical bounded regular file');return readFile(filename);}
async function directory(filename){try{await mkdir(filename,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}const info=await lstat(filename);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(filename)!==filename)throw Error('Unsafe checkpoint directory');return filename;}
export function checkpointEnvironment(){const allowed=['PATH','HOME','LANG','LC_ALL','TMPDIR','TZ','SSH_AUTH_SOCK','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'];return {...Object.fromEntries(allowed.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1',GCM_INTERACTIVE:'Never'};}
export async function checkpointCommand(command,args,{cwd,allowFailure=false,timeout=600000}={}){
 return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd,env:checkpointEnvironment(),stdio:['ignore','pipe','pipe']});let output='',errors='',stopped=false;
 const timer=setTimeout(()=>{stopped=true;child.kill('SIGTERM');reject(Error('CHECKPOINT_COMMAND_TIMEOUT: inspect commit and remote before retry'));},timeout);
 child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4*1024*1024){stopped=true;child.kill('SIGTERM');reject(Error('CHECKPOINT_OUTPUT_LIMIT'));}});
 child.stderr.on('data',chunk=>{if(errors.length<65536)errors+=chunk;});
 child.once('error',()=>{clearTimeout(timer);stopped=true;reject(Error('CHECKPOINT_COMMAND_UNAVAILABLE'));});
 child.once('exit',code=>{clearTimeout(timer);if(stopped)return;if(code!==0&&!allowFailure)reject(Error('CHECKPOINT_COMMAND_FAILED:'+command));else resolve({stdout:output,code});});
 });
}
export function validateCheckpointBinding(value,{instanceRoot,softwareRoot=SOFTWARE_ROOT}={}){
 if(!value||Object.keys(value).some(key=>!['schemaVersion','enabled','instanceId','instanceRoot','repositoryRoot','githubRepository','remote','remoteUrl','branch','snapshotPath','mediaPrefix','core','pollSeconds'].includes(key))||value.schemaVersion!=='1.0'||value.enabled!==true)throw Error('Explicit enabled checkpoint binding required');
 if(value.instanceRoot!==instanceRoot||typeof value.instanceId!=='string'||!value.instanceId||!path.isAbsolute(value.repositoryRoot)||!REPO.test(value.githubRepository)||!REPO.test(value.core?.repository)||value.core.repository===value.githubRepository)throw Error('Checkpoint must bind one instance and distinct project/core repositories');
 if(!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value.remote)||!['https://github.com/'+value.githubRepository+'.git','git@github.com:'+value.githubRepository+'.git'].includes(value.remoteUrl)||typeof value.branch!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(value.branch)||value.branch.includes('..'))throw Error('Only the exact configured GitHub remote and branch are supported');
 if(!SHA.test(value.core.commit)||!HASH.test(value.core.packageManifestSha256)||value.core.packageRoot!==softwareRoot||Object.keys(value.core).sort().join(',')!=='commit,packageManifestSha256,packageRoot,repository')throw Error('Worker must run from the explicitly pinned core distribution');
 safeRelative(value.snapshotPath);safeRelative(value.mediaPrefix);
 if(value.snapshotPath.startsWith('.')||value.snapshotPath.includes('/')||value.snapshotPath===value.mediaPrefix||!value.mediaPrefix.endsWith('/media'))throw Error('Use one dedicated top-level snapshot folder and the explicit instance media path');
 if(value.pollSeconds!==undefined&&(!Number.isSafeInteger(value.pollSeconds)||value.pollSeconds<10||value.pollSeconds>3600))throw Error('Checkpoint poll interval must be 10–3600 seconds');
 return value;
}
export async function loadCheckpointBinding(instanceRoot,{softwareRoot=SOFTWARE_ROOT}={}){
 if(process.env.REVIEW_DEPLOYMENT_MODE==='VPS'||process.env.REVIEW_GIT_CHECKPOINT_DISABLED==='1')return null;
 instanceRoot=await realpath(instanceRoot);let value;try{value=JSON.parse(await regular(path.join(instanceRoot,'runtime','git-checkpoint.json')));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(value.enabled===false)return null;
 const binding=validateCheckpointBinding(value,{instanceRoot,softwareRoot});
 if(await realpath(binding.repositoryRoot)!==binding.repositoryRoot||await realpath(path.join(binding.repositoryRoot,binding.mediaPrefix))!==path.join(instanceRoot,'media'))throw Error('Project media binding must resolve to this exact instance media');
 const boot=JSON.parse(await regular(path.join(instanceRoot,'instance.json')));if(boot.instanceId!==binding.instanceId||boot.schemaVersion!=='2.0')throw Error('Checkpoint instance binding differs');
 const bytes=await regular(path.join(softwareRoot,'software-manifest.json'),16*1024*1024),manifest=JSON.parse(bytes);
 if(sha256(bytes)!==binding.core.packageManifestSha256||manifest.kind!=='STORY_NEUTRAL_SOFTWARE'||manifest.copiedBusinessData!==false||manifest.softwareCommit!==binding.core.commit)throw Error('Core package and exact pin do not match');
 const verified=await verifySoftwarePin(binding.repositoryRoot);
 if(verified.software!==softwareRoot||verified.pin.commit!==binding.core.commit||verified.pin.softwareManifestSha256!==binding.core.packageManifestSha256||verified.pin.repository.replace(/^https:\/\/github\.com\//,'').replace(/\.git$/,'')!==binding.core.repository)throw Error('Portable core-lock and checkpoint software binding differ');
 return binding;
}
export async function verifyCheckpointRemote(binding,run=checkpointCommand){
 const git=(args,options={})=>run('git',['--literal-pathspecs','-C',binding.repositoryRoot,...args],options);
 if((await git(['rev-parse','--show-toplevel'])).stdout.trim()!==binding.repositoryRoot)throw Error('Configured repository is not the exact Git root');
 await git(['check-ref-format','--branch',binding.branch]);
 if((await git(['branch','--show-current'])).stdout.trim()!==binding.branch)throw Error('Detached or different Git branch; automatic checkpoint stopped');
 for(const args of [['remote','get-url','--all',binding.remote],['remote','get-url','--push','--all',binding.remote]])if((await git(args)).stdout.trim()!==binding.remoteUrl)throw Error('Git remote/rewrite/push URL differs from exact private binding');
 const response=await run('gh',['api','repos/'+binding.githubRepository],{cwd:binding.repositoryRoot,timeout:30000}),repository=JSON.parse(response.stdout);
 if(repository.full_name!==binding.githubRepository||repository.private!==true||repository.archived===true||repository.permissions?.push!==true)throw Error('GitHub repository is not the configured writable PRIVATE repository');
 const expectedLfs='https://github.com/'+binding.githubRepository+'.git/info/lfs';
 const overrides=await git(['config','--get-regexp','^(lfs\\.(url|pushurl)|remote\\..*\\.lfs(url|pushurl))$'],{allowFailure:true});
 if(overrides.code!==0&&overrides.code!==1)throw Error('Cannot verify LFS endpoint');
 for(const line of overrides.stdout.trim().split('\n').filter(Boolean))if(line.slice(line.indexOf(' ')+1)!==expectedLfs)throw Error('LFS endpoint points outside the configured private repository');
 try{await lstat(path.join(binding.repositoryRoot,'.lfsconfig'));const configured=await git(['config','--file','.lfsconfig','--get-regexp','^lfs\\.'],{allowFailure:true});if(configured.code!==0&&configured.code!==1)throw Error('Cannot inspect .lfsconfig');for(const line of configured.stdout.trim().split('\n').filter(Boolean))if(!line.startsWith('lfs.url ')||line.slice(8)!==expectedLfs)throw Error('Unsupported .lfsconfig override');}catch(error){if(error.code!=='ENOENT')throw error;}
 await git(['lfs','version']);await git(['ls-files','--error-unmatch','.gitattributes']);
 if((await git(['diff','HEAD','--name-only','--','.gitattributes','.lfsconfig'])).stdout.trim())throw Error('LFS routing rules must already be committed');
 return {git,repositoryId:repository.id};
}
const publicCore=binding=>({repository:binding.core.repository,commit:binding.core.commit,packageManifestSha256:binding.core.packageManifestSha256});
export function checkpointNeeded(current,manifest,binding){return !manifest||manifest.businessFingerprint!==current.fingerprint||canonicalJson(manifest.core)!==canonicalJson(publicCore(binding));}
async function readManifest(folder){try{const bytes=await regular(path.join(folder,'manifest.json'),16*1024*1024),manifest=JSON.parse(bytes),{manifestSha256,...body}=manifest;if(sha256(canonicalJson(body))!==manifestSha256||manifest.kind!=='REVIEW_GIT_BUSINESS_SNAPSHOT_1')throw Error('Existing snapshot manifest is not owned by this worker');return manifest;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function persistStatus(root,value){const destination=path.join(root,'runtime','git-checkpoint-status.json'),tmp=destination+'.'+randomUUID();await writeFile(tmp,JSON.stringify({...value,recordedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,destination);}
export async function checkpointOnce(instanceRoot,{binding,call=runInstanceCli,run=checkpointCommand,exporter=exportGitSnapshot}={}){
 binding ||= await loadCheckpointBinding(instanceRoot);if(!binding)return{status:'DISABLED'};
 await recoverCheckpointInstall(instanceRoot,binding);
 const current=await call(instanceRoot,['git-business-state']);
 if(current.instanceId!==binding.instanceId)throw Error('Live Git fingerprint belongs to another instance');
 const folder=path.join(binding.repositoryRoot,binding.snapshotPath),previous=await readManifest(folder);
 if(previous&&previous.instanceId!==binding.instanceId)throw Error('Snapshot belongs to a different instance');
 if(!previous){try{await lstat(folder);throw Error('Existing unowned snapshot folder must not be overwritten');}catch(error){if(error.code!=='ENOENT')throw error;}}
 const {git}=await verifyCheckpointRemote(binding,run);
 const baseFiles=['manifest.json','repository.jsonl.gz','RESTORE.md'],priorFiles=(previous?.files||[]).map(file=>binding.mediaPrefix+'/'+safeRelative(file.path).replace(/^media\//,''));
 const allowedPrior=new Set([...baseFiles.map(file=>binding.snapshotPath+'/'+file),...priorFiles]);
 const staged=(await git(['diff','--cached','--name-only','-z'])).stdout.split('\0').filter(Boolean);
 if(staged.some(file=>!allowedPrior.has(file)))throw Error('Unrelated staged changes belong to the user; automatic checkpoint stopped');
 let manifest=previous,exported=false;
 if(checkpointNeeded(current,previous,binding)){
  const staging=path.join(binding.repositoryRoot,binding.snapshotPath+'-staging-'+randomUUID());
  await exporter(instanceRoot,staging,{expectedFingerprint:current.fingerprint,mediaPrefix:binding.mediaPrefix,core:publicCore(binding)});
  manifest=await readManifest(staging);
  if(!manifest||manifest.businessFingerprint!==current.fingerprint||manifest.instanceId!==binding.instanceId||canonicalJson(manifest.core)!==canonicalJson(publicCore(binding)))throw Error('Export did not return the exact frozen business basis');
  await installCheckpointSnapshot(instanceRoot,binding,staging);
  exported=true;
 }
 if(!manifest)throw Error('Checkpoint manifest is missing');
 if(!exported&&(await git(['status','--porcelain','-z','--',binding.snapshotPath])).stdout)await verifyManagedSnapshot(folder,binding.instanceId,manifest.manifestSha256);
 const currentFiles=manifest.files.map(file=>binding.mediaPrefix+'/'+safeRelative(file.path).replace(/^media\//,''));
 const trackedPrior=[];for(let index=0;index<priorFiles.length;index+=100)trackedPrior.push(...(await git(['ls-files','-z','--',...priorFiles.slice(index,index+100)])).stdout.split('\0').filter(Boolean));
 const owned=[...new Set([...baseFiles.map(file=>binding.snapshotPath+'/'+file),...currentFiles,...trackedPrior])];
 const lfsFiles=[binding.snapshotPath+'/repository.jsonl.gz',...currentFiles];
 for(let index=0;index<lfsFiles.length;index+=100){
  const paths=lfsFiles.slice(index,index+100),attrs=(await git(['check-attr','-z','filter','--',...paths])).stdout.split('\0');
  if(attrs.at(-1)==='')attrs.pop();
  if(attrs.length!==paths.length*3||paths.some((file,i)=>attrs[i*3]!==file||attrs[i*3+1]!=='filter'||attrs[i*3+2]!=='lfs'))throw Error('Archive and every registered effective media file must use LFS');
 }
 await git(['status','--short','--branch']);
 for(let index=0;index<owned.length;index+=100)await git(['add','-A','--',...owned.slice(index,index+100)]);
 const changed=(await git(['diff','--cached','--name-only','-z'])).stdout.split('\0').filter(Boolean);
 if(changed.some(file=>!owned.includes(file)))throw Error('Concurrent user staging detected; no automatic commit or push');
 if(changed.length)await git(['commit','-m','content: checkpoint story business '+current.fingerprint.slice(0,12)]);
 const local=(await git(['rev-parse','HEAD'])).stdout.trim();if(!SHA.test(local))throw Error('Git HEAD is not one exact commit');
 const tracked=JSON.parse((await git(['show','HEAD:'+binding.snapshotPath+'/manifest.json'])).stdout);
 if(tracked.manifestSha256!==manifest.manifestSha256)throw Error('Committed manifest differs from verified checkpoint');
 const ref='refs/heads/'+binding.branch;
 let remote=(await git(['ls-remote',binding.remote,ref])).stdout.trim().split(/\s+/)[0]||null;
 if(remote!==local){
  // Ordinary non-force push is safely repeatable after a lost response: read the
  // remote first; divergent remote history remains an error, never auto-merged.
  await persistStatus(instanceRoot,{status:'COMMITTED_NOT_PUSHED',businessFingerprint:current.fingerprint,localCommit:local,githubRepository:binding.githubRepository,core:publicCore(binding)});
  await git(['push',binding.remote,'HEAD:'+ref]);
  remote=(await git(['ls-remote',binding.remote,ref])).stdout.trim().split(/\s+/)[0]||null;
  if(remote!==local)throw Error('Push is not confirmed at the exact remote ref');
 }
 const result={status:changed.length?'CHECKPOINT_PUSHED':exported?'CHECKPOINT_VERIFIED':'UNCHANGED_VERIFIED',businessFingerprint:current.fingerprint,localCommit:local,remoteCommit:remote,githubRepository:binding.githubRepository,core:publicCore(binding),mediaFiles:manifest.files.length,fullBackup:false};
 await persistStatus(instanceRoot,result);return result;
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export const checkpointPollDelay=binding=>(binding.pollSeconds??30)*1000;
export async function checkpointWorker(instanceRoot,{once=false}={}){
 instanceRoot=await realpath(instanceRoot);const binding=await loadCheckpointBinding(instanceRoot);if(!binding)return{status:'DISABLED'};
 const locks=await directory(path.join(instanceRoot,'runtime','locks')),lock=path.join(locks,'git-checkpoint-host.json'),workerId='git-checkpoint_'+randomUUID();
 const identity={workerId,pid:process.pid,root:instanceRoot,script:filename,scriptSha256:sha256(await readFile(filename))};
 try{await writeFile(lock,canonicalJson(identity),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const previous=JSON.parse(await regular(lock));if(alive(previous.pid))throw Error('This instance already has a Git checkpoint worker');await unlink(lock);await writeFile(lock,canonicalJson(identity),{flag:'wx',mode:0o600});}
 let stopped=false;const stop=()=>{stopped=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{do{
  if(sha256(await readFile(filename))!==identity.scriptSha256)throw Error('Worker distribution changed; restart required');
  try{const result=await checkpointOnce(instanceRoot);process.stdout.write(JSON.stringify(result)+'\n');}
  catch(error){const result={status:'CHECKPOINT_BLOCKED',message:error instanceof Error?error.message:'Checkpoint failed; no remote success claimed'};await persistStatus(instanceRoot,result);process.stderr.write(JSON.stringify(result)+'\n');if(once)throw error;}
  if(once||stopped)break;await wait(checkpointPollDelay(binding));
 }while(!stopped);}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);const current=JSON.parse(await readFile(lock,'utf8').catch(()=>'{}'));if(current.workerId===workerId)await unlink(lock);}
}
export async function startGitCheckpointWorker(instanceRoot){
 instanceRoot=await realpath(instanceRoot);const binding=await loadCheckpointBinding(instanceRoot);if(!binding)return{status:'DISABLED'};
 const lock=path.join(instanceRoot,'runtime','locks','git-checkpoint-host.json');
 try{const current=JSON.parse(await regular(lock));if(alive(current.pid)){if(current.root===instanceRoot&&current.script===filename&&current.scriptSha256===sha256(await readFile(filename)))return{status:'ALREADY_RUNNING',pid:current.pid};return{status:'RESTART_REQUIRED',pid:current.pid};}}catch(error){if(error.code!=='ENOENT')throw error;}
 await directory(path.join(instanceRoot,'runtime','logs'));const fd=openSync(path.join(instanceRoot,'runtime','logs','git-checkpoint.log'),'a',0o600);
 const child=spawn(process.execPath,[filename,'--instance',instanceRoot,'--watch'],{detached:true,stdio:['ignore',fd,fd],env:checkpointEnvironment()});child.unref();closeSync(fd);
 for(let i=0;i<50;i++){await wait(100);try{const current=JSON.parse(await regular(lock));if(current.pid===child.pid)return{status:'STARTED',pid:child.pid};}catch(error){if(error.code!=='ENOENT')throw error;}}
 return{status:'START_UNCONFIRMED'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{instance:{type:'string'},once:{type:'boolean'},watch:{type:'boolean'}}});
 if(!values.instance||values.once===values.watch)throw Error('Explicit --instance and exactly one of --once/--watch required');
 await checkpointWorker(values.instance,{once:values.once});
}
