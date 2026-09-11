import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readFile,readdir,realpath,rename,rm,chmod,statfs,writeFile} from 'node:fs/promises';
import path from 'node:path';

const missing=e=>e.code==='ENOENT';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const exists=async p=>Boolean(await lstat(p).catch(e=>{if(missing(e))return null;throw e;}));
const contains=(a,b)=>b===a||b.startsWith(a+path.sep);
const digest=value=>createHash('sha256').update(value).digest('hex');
const id=value=>{if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value||''))throw Error('Invalid process task/stage identity');return value;};
const run=(bin,args)=>execFileSync(bin,args,{encoding:'utf8',maxBuffer:16*1024**2,timeout:60000,stdio:['ignore','pipe','pipe']}).trim();
export function processIdentity(pid=process.pid){
 try{const match=run('ps',['-p',String(pid),'-o','lstart=','-o','stat=']).match(/^(.+?)\s+(\S+)$/);return !match||match[2].includes('Z')?null:{pid,birth:match[1]};}catch(e){if(e.status===1)return null;throw e;}
}
export function processAlive(owner){const now=owner&&processIdentity(owner.pid);return Boolean(now?.birth&&now.birth===owner.birth);}
async function atomic(p,value){const tmp=p+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(tmp,p);}finally{await rm(tmp,{force:true});}}
async function plain(p,{create=false}={}){
 const absolute=path.resolve(p);let cursor=path.parse(absolute).root;
 for(const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,part);let info=await lstat(cursor).catch(e=>{if(missing(e))return null;throw e;});
  if(!info&&create){try{await mkdir(cursor,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}info=await lstat(cursor);}
  if(!info||!info.isDirectory()||info.isSymbolicLink())throw Error('Process directory is missing, aliased or not a directory');
 }
 return absolute;
}
// Kernel locks disappear on exit, SIGKILL and reboot. Never unlink the lock
// inode: doing so could let two collectors acquire different locks for a phase.
export async function processLock(file,callback,python=process.env.REVIEW_PROCESS_PYTHON||'python3'){
 const child=spawn(python,['-u','-c',"import fcntl,sys,time; f=open(sys.argv[1],'a'); end=time.monotonic()+5\nwhile True:\n try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); break\n except BlockingIOError:\n  if time.monotonic()>end: sys.exit(75)\n  time.sleep(.05)\nprint('LOCKED',flush=True); sys.stdin.read()",file],{stdio:['pipe','pipe','pipe']});
 const done=new Promise(resolve=>child.once('close',resolve));
 try{await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',v=>v.toString()==='LOCKED\n'?resolve():reject(Error('Invalid process lock response')));child.once('exit',()=>reject(Error('Process resource lock is busy or unavailable')));});return await callback();}
 finally{child.stdin.end();await done;}
}
const lock=processLock;
export async function readProcessConfig(root){
 root=await realpath(path.resolve(root));let config;
 if(await exists(path.join(root,'instance/runtime/process-policy.json')))config=await json(path.join(root,'instance/runtime/process-policy.json'));
 else {const pkg=await json(path.join(root,'package.json'));if(pkg.name!=='story-review-desk')throw Error('Standard project process policy is missing');config={schemaVersion:'1.0',enabled:true,projectId:'story-review-desk',host:'local',maxTemporaryBytes:64*1024**3,reserveBytes:8*1024**3,registry:'.process/receipts',workspace:'.process/stages',parentTasks:'.process/tasks',temporaryRoots:['.process/shared'],protectedPaths:['server','web','tools','scripts','tests','docs','node_modules','README.md','AGENTS.md','STATE.md','package.json','package-lock.json']};} 
 if(config.schemaVersion!=='1.0'||config.enabled!==true||!config.projectId||!['local','vps-bj','fixture'].includes(config.host)
  ||!Number.isSafeInteger(config.maxTemporaryBytes)||config.maxTemporaryBytes<1||!Number.isSafeInteger(config.reserveBytes)||config.reserveBytes<0)throw Error('Invalid process cleanup policy');
 for(const value of [config.registry,config.workspace,config.parentTasks,config.retentionPolicy,...(config.temporaryRoots||[]),...(config.protectedPaths||[])].filter(v=>v!==undefined))if(typeof value!=='string'||path.isAbsolute(value)||value.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('Invalid process policy path');
 if(contains(path.join(root,config.workspace),path.join(root,config.registry)))throw Error('Process receipts cannot be inside temporary workspace');
 return {...config,root};
}
function locations(config,task,phase){return {directory:path.join(config.root,config.registry,id(task)),file:path.join(config.root,config.registry,id(task),id(phase)+'.json'),workspace:path.join(config.root,config.workspace,id(task),id(phase))};}
async function protectedPath(config,absolute){
 if(!contains(config.root,absolute)||absolute===config.root)throw Error('Temporary path escaped its project');
 const protectedPaths=[...(config.protectedPaths||[]),config.registry,'instance/runtime/process-policy.json','.git'];
 if(config.retentionPolicy){const policy=await json(path.join(config.root,config.retentionPolicy));protectedPaths.push(...policy.protectedHotPaths.map(p=>p.path));}
 for(const relative of protectedPaths){const p=path.resolve(config.root,relative);if(contains(p,absolute)||contains(absolute,p))throw Error('Temporary path overlaps a retained resource');}
}
export async function beginPhase(root,task,phase,{consumers=[]}={}){
 const config=await readProcessConfig(root),loc=locations(config,task,phase);await plain(loc.directory,{create:true});
 for(const relative of config.temporaryRoots||[]){const directory=path.join(config.root,relative);await plain(directory,{create:true});}
 return lock(loc.file+'.lock',async()=>{
  if(await exists(loc.file)||await exists(loc.workspace))throw Error('Process phase identity already exists');
  await protectedPath(config,loc.workspace);await plain(path.dirname(loc.workspace),{create:true});
  const record={schemaVersion:'1.0',kind:'PROCESS_PHASE',taskId:task,phaseId:phase,projectId:config.projectId,host:config.host,token:randomUUID(),owner:processIdentity(),status:'RUNNING',startedAt:new Date().toISOString(),consumers,resources:[{kind:'path',path:loc.workspace,state:'INTENT'}]};
  await atomic(loc.file,record);await mkdir(loc.workspace,{mode:0o700});const st=await lstat(loc.workspace);Object.assign(record.resources[0],{dev:st.dev,ino:st.ino,state:'TEMPORARY'});
  await atomic(loc.file,record);return new ProcessPhase(config,loc.file,record.token);
 });
}
export async function openPhase(context){
 const config=await readProcessConfig(context.root),loc=locations(config,context.taskId,context.phaseId),record=await json(loc.file);
 if(record.token!==context.token||record.projectId!==config.projectId||record.host!==config.host)throw Error('Process phase identity changed');
 return new ProcessPhase(config,loc.file,context.token);
}
export async function requiredPhase(selectedPath){
 if(process.env.REVIEW_PROCESS_CONTEXT){const phase=await openPhase(JSON.parse(process.env.REVIEW_PROCESS_CONTEXT));await phase.assertRunning();return phase;}
 let p=path.resolve(selectedPath||process.cwd());
 while(p!==path.dirname(p)){if(await exists(path.join(p,'instance/runtime/process-policy.json')))throw Error('TASK_REQUIRED: use the project task/stage runner before creating process resources');p=path.dirname(p);}
 return null;
}
export class ProcessPhase{
 constructor(config,file,token){this.config=config;this.file=file;this.token=token;}
 async read(){const r=await json(this.file);if(r.token!==this.token)throw Error('Process phase token changed');return r;}
 async update(fn){return lock(this.file+'.lock',async()=>{const r=await this.read(),result=await fn(r);await atomic(this.file,r);return result;});}
 async assertRunning(){const r=await this.read();if(r.status!=='RUNNING'||!processAlive(r.owner))throw Error('Process phase has no active owner');return r;}
 async context(){const r=await this.read();return {root:this.config.root,taskId:r.taskId,phaseId:r.phaseId,token:r.token};}
 async environment(){const r=await this.read(),workspace=r.resources[0].path;return {REVIEW_PROCESS_CONTEXT:JSON.stringify(await this.context()),REVIEW_TASK_ID:r.taskId,REVIEW_TASK_DIR:workspace,TMPDIR:workspace,TMP:workspace,TEMP:workspace,TEST_TMPDIR:workspace,XDG_CACHE_HOME:path.join(workspace,'cache'),npm_config_cache:path.join(workspace,'npm-cache'),PYTHONDONTWRITEBYTECODE:'1'};}
 async directory(destination){
  const absolute=path.resolve(destination);await protectedPath(this.config,absolute);
  const allowed=[this.config.workspace,...(this.config.temporaryRoots||[])].some(p=>contains(path.join(this.config.root,p),absolute));if(!allowed)throw Error('Temporary output is outside the configured process roots');
  await plain(path.dirname(absolute));
  return this.update(async r=>{if(r.status!=='RUNNING'||!processAlive(r.owner)||await exists(absolute))throw Error('Process output is not a new owned directory');
   const resource={kind:'path',path:absolute,state:'INTENT'};r.resources.push(resource);await atomic(this.file,r);
   await mkdir(absolute,{mode:0o700});const st=await lstat(absolute);Object.assign(resource,{dev:st.dev,ino:st.ino,state:'TEMPORARY'});return absolute;});
 }
 async ownOutput(destination){
  const absolute=path.resolve(destination),r=await this.assertRunning();
  if(r.resources.some(x=>x.kind==='path'&&x.state==='TEMPORARY'&&contains(x.path,absolute)&&x.path!==absolute))return false;
  await this.directory(absolute);return true;
 }
 async childStarted(pid){return this.update(r=>{r.child=processIdentity(pid);});}
 async childEnded(){return this.update(r=>{delete r.child;});}
 async hostReceipt(host,receipt){if(!['vps-bj','fixture'].includes(host))throw Error('Unconfigured process host');return this.update(r=>{r.hosts||={};r.hosts[host]={...receipt,at:new Date().toISOString()};});}
 docker(args){return run(this.config.dockerBinary||'docker',args);}
 builderObject(name){
  const rows=this.docker(['buildx','ls','--format','{{json .}}']).split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.Name===name);
  if(!rows.length)return null;
  const identity=row=>JSON.stringify({Name:row.Name,Driver:row.Driver,Nodes:row.Nodes?.map(n=>({Name:n.Name,Endpoint:n.Endpoint}))});
  if(new Set(rows.map(identity)).size!==1)throw Error('Ambiguous builder identity');return JSON.parse(identity(rows[0]));
 }
 object(kind,name){try{return JSON.parse(this.docker([kind,'inspect',name]))[0];}catch(e){const err=String(e.stderr||'');if(/No such|not found/i.test(err))return null;throw e;}}
 async expect(kind,name,{expectedId=null,pullDigest=null}={}){
  if(!['container','network','volume','image','builder'].includes(kind)||typeof name!=='string'||!name||name.startsWith('-'))throw Error('Unsupported temporary Docker resource');
  return this.update(async r=>{if(r.status!=='RUNNING'||!processAlive(r.owner))throw Error('Resource allocation requires an active phase');
   if(kind==='builder'){if(!name.startsWith('review-process-'+r.token+'-'))throw Error('Builder must have its unguessable phase namespace');try{this.docker(['buildx','inspect',name]);throw Error('Builder already exists');}catch(e){if(!/no builder|not found/i.test(String(e.stderr||'')))throw e;}}
   else if(this.object(kind,name))throw Error('Temporary Docker identity already exists');
   if(r.resources.some(x=>x.kind===kind&&x.name===name))throw Error('Duplicate process resource');
   if(pullDigest&&(kind!=='image'||!/^sha256:[a-f0-9]{64}$/.test(pullDigest)||!name.endsWith('@'+pullDigest)))throw Error('Pulled process image must use an immutable manifest digest');
   r.resources.push({kind,name,id:expectedId,...(pullDigest?{pullDigest}:{}),state:'INTENT'});
   return ['--label','review.process.project='+r.projectId,'--label','review.process.task='+r.taskId,'--label','review.process.phase='+r.phaseId,'--label','review.process.token='+r.token,'--label','review.process.temporary=true'];});
 }
 async capture(kind,name){return this.update(async r=>{const resource=r.resources.find(x=>x.kind===kind&&x.name===name);if(!resource)throw Error('Unregistered Docker resource');
  if(kind==='builder'){resource.identity=JSON.stringify(this.builderObject(name));}
  else{const object=this.object(kind,name);if(!object)throw Error('Allocated Docker resource is missing');this.assertObject(r,resource,object);resource.id=object.Id||object.Name;}
  resource.state='TEMPORARY';});}
 async builder(){
  const r=await this.assertRunning(),name='review-process-'+r.token+'-build';
  if(r.resources.some(x=>x.kind==='builder'&&x.name===name))return name;
  // Pull the builder helper by immutable registry digest. A helper that did
  // not exist before this phase is itself disposable after the builder exits.
  const manifest=JSON.parse(this.docker(['buildx','imagetools','inspect','moby/buildkit:buildx-stable-1','--format','{{json .Manifest}}']));
  if(!/^sha256:[a-f0-9]{64}$/.test(manifest.digest))throw Error('Builder helper has no immutable manifest');
  const helper='moby/buildkit@'+manifest.digest;
  if(!this.object('image',helper)){await this.expect('image',helper,{pullDigest:manifest.digest});this.docker(['pull',helper]);await this.capture('image',helper);}
  await this.expect('builder',name);
  this.docker(['buildx','create','--name',name,'--driver','docker-container','--driver-opt','image='+helper]);
  await this.capture('builder',name);return name;
 }
 assertObject(record,resource,object){
  if(resource.id&&resource.id!==(object.Id||object.Name))throw Error('Temporary Docker identity drift');
  if(resource.kind==='image'&&resource.id)return;
  if(resource.kind==='image'&&resource.pullDigest&&object.RepoDigests?.includes(resource.name))return;
  const labels=resource.kind==='container'||resource.kind==='image'?object.Config?.Labels:object.Labels;
  if(labels?.['review.process.token']!==record.token||labels?.['review.process.project']!==record.projectId||labels?.['review.process.temporary']!=='true')throw Error('Unowned Docker resource');
 }
 async retain(kind,key,reason){if(!reason?.trim())throw Error('Retention requires a concrete delivery/recovery reason');return this.update(r=>{const resource=r.resources.find(x=>x.kind===kind&&(x.path===path.resolve(key)||x.name===key));if(!resource)throw Error('Cannot retain an unregistered resource');resource.state='RETAINED';resource.reason=reason;});}
 async transfer(kind,key,consumer){id(consumer);return this.update(r=>{const resource=r.resources.find(x=>x.kind===kind&&(x.path===path.resolve(key)||x.name===key));if(!resource||resource===r.resources[0])throw Error('Transfer needs an explicit output outside the stage scratch root');if(resource.kind==='path'&&contains(r.resources[0].path,resource.path))throw Error('Transferred output must be outside stage scratch');resource.consumers=[...new Set([...(resource.consumers||[]),consumer])];});}
 async budget(){const usage=await measureProcessUsage(this.config.root);if(usage.temporaryBytes>this.config.maxTemporaryBytes||usage.freeBytes<this.config.reserveBytes)throw Error('PROCESS_STORAGE_BUDGET_EXCEEDED');return usage;}
 async finish({outcome='SUCCEEDED',recover=false}={}){
  return this.update(async record=>{
   if(record.status==='CLEANED')return record;
   if(record.owner.pid!==process.pid&&processAlive(record.owner)&&record.status==='RUNNING')throw Error('Cannot clean a live process owned by another runner');
   if(processAlive(record.child))throw Error('Process child is still running');
   record.outcome=outcome;record.status='CLEANING';await atomic(this.file,record);
   const failures=[];const order={container:0,network:1,volume:2,builder:3,image:4,path:5};
   for(const resource of [...record.resources].sort((a,b)=>order[a.kind]-order[b.kind]||(b.path?.length||0)-(a.path?.length||0))){
    if(['REMOVED','RETAINED'].includes(resource.state)||resource.consumers?.length)continue;
    try{await this.remove(record,resource);resource.state='REMOVED';delete resource.error;}
    catch(e){resource.error=String(e.message).slice(0,400);failures.push(resource.error);}
    await atomic(this.file,record);
   }
   for(const [host,receipt] of Object.entries(record.hosts||{}))if(receipt.status!=='CLEANED')failures.push(host+' cleanup has not been verified');
   record.status=failures.length?'CLEANUP_REQUIRED':record.resources.some(x=>x.consumers?.length)?'WAITING_CONSUMERS':'CLEANED';record.finishedAt=new Date().toISOString();
   record.failures=failures;return record;
  });
 }
 async remove(record,resource){
  if(resource.kind==='path'){
   if(!await exists(resource.path))return;await protectedPath(this.config,resource.path);await plain(path.dirname(resource.path));
   const st=await lstat(resource.path);if(st.dev!==resource.dev||st.ino!==resource.ino||st.isSymbolicLink())throw Error('Temporary directory identity drift');
   if(record.resources.some(x=>x!==resource&&x.state!=='REMOVED'&&(x.state==='RETAINED'||x.consumers?.length)&&x.path&&contains(resource.path,x.path)))throw Error('Stage scratch still contains retained output');
   const containers=this.docker(['ps','-aq','--no-trunc']).split('\n').filter(Boolean);
   for(const c of containers.map(n=>this.object('container',n))){if(c?.Mounts?.some(m=>{const p=m.Source.replace(/^\/host_mnt(?=\/)/,'');return contains(p,resource.path)||contains(resource.path,p);}))throw Error('Temporary path remains mounted');}
   try{const handles=run(process.platform==='darwin'?'/usr/sbin/lsof':'lsof',['-Fn','+D',resource.path]);if(handles)throw Error('Temporary path has open handles');}catch(e){if(e.status!==1)throw e;}
   let tracked='';try{tracked=run('git',['-C',this.config.root,'ls-files','-z','--',path.relative(this.config.root,resource.path)]);}catch(e){if(!String(e.stderr).includes('not a git repository'))throw e;}
   if(tracked)throw Error('Tracked work cannot be deleted as process scratch');
   const directories=[];const scan=async p=>{directories.push(p);for(const entry of await readdir(p,{withFileTypes:true})){if(entry.name==='.git')throw Error('Git work must be retired through its repository');if(entry.isDirectory()&&!entry.isSymbolicLink())await scan(path.join(p,entry.name));}};
   await scan(resource.path);for(const p of directories)await chmod(p,0o700);
   await rm(resource.path,{recursive:true});if(await exists(resource.path))throw Error('Temporary path survived deletion');return;
  }
  if(resource.kind==='builder'){
   const builder=this.builderObject(resource.name),identity=resource.identity&&JSON.parse(resource.identity);if(!builder)return;
   if(builder.Name!==resource.name||!resource.name.startsWith('review-process-'+record.token+'-')||builder.Driver!=='docker-container'||identity&&digest(JSON.stringify(builder.Nodes?.map(n=>[n.Name,n.Endpoint])))!==digest(JSON.stringify(identity.Nodes?.map(n=>[n.Name,n.Endpoint]))))throw Error('Builder identity is not verified');
   this.docker(['buildx','rm',resource.name]);
   if(this.builderObject(resource.name))throw Error('Builder survived deletion');return;
  }
  const object=this.object(resource.kind,resource.name);if(!object)return;this.assertObject(record,resource,object);
  if(resource.kind==='container'){if(object.State.Running)this.docker(['stop','--time','10',resource.name]);this.docker(['container','rm',resource.name]);}
  else if(resource.kind==='image'){
   const containers=this.docker(['ps','-aq','--no-trunc']).split('\n').filter(Boolean).map(n=>this.object('container',n));
   if(containers.some(c=>c?.Config?.Image===resource.name))throw Error('Temporary image tag still has a consumer');this.docker(['image','rm',resource.name]);
  }else{if(resource.kind==='volume'&&this.docker(['ps','-aq','--filter','volume='+resource.name]))throw Error('Temporary volume still has consumers');this.docker([resource.kind,'rm',resource.name]);}
  if(this.object(resource.kind,resource.name))throw Error('Docker resource survived deletion');
 }
}
export async function phaseRecords(root,taskId){
 const config=await readProcessConfig(root),base=path.join(config.root,config.registry),rows=[];
 for(const task of await readdir(base,{withFileTypes:true}).catch(e=>{if(missing(e))return [];throw e;})){
  if(!task.isDirectory()||task.name==='logs'||taskId&&task.name!==taskId)continue;
  for(const filename of await readdir(path.join(base,task.name))){if(!filename.endsWith('.json'))continue;const file=path.join(base,task.name,filename),record=await json(file);if(record.kind==='PROCESS_PHASE')rows.push({file,record});}
 }
 return rows;
}
export async function finishProcessTask(root,taskId){
 const config=await readProcessConfig(root),rows=await phaseRecords(root,taskId);
 if(rows.some(({record})=>record.status==='RUNNING'&&processAlive(record.owner)||processAlive(record.child)))throw Error('Process task has a running phase');
 const recoveryPending=rows.some(({record})=>Object.values(record.hosts||{}).some(h=>h.status!=='CLEANED'));
 for(const {file,record} of rows){const phase=new ProcessPhase(config,file,record.token);if(!recoveryPending)await phase.update(r=>{for(const x of r.resources)x.consumers=[];});await phase.finish({recover:true,outcome:record.outcome||'INTERRUPTED'});}
 return checkProcessTask(root,taskId);
}
export async function checkProcessTask(root,taskId){
 const config=await readProcessConfig(root),rows=await phaseRecords(root,taskId);
 for(const {file,record} of rows){if(record.status!=='CLEANED')throw Error('CLEANUP_REQUIRED: process resources remain');const phase=new ProcessPhase(config,file,record.token);
  for(const resource of record.resources.filter(r=>r.state==='REMOVED')){
   const present=resource.kind==='path'?await exists(resource.path):resource.kind==='builder'?phase.builderObject(resource.name):phase.object(resource.kind,resource.name);
   if(present)throw Error('CLEANUP_REQUIRED: a removed process resource reappeared');
  }
 }
 return {status:'CLEANED',phases:rows.length};
}
export async function sweepProcessTasks(root){
 const config=await readProcessConfig(root),results=[],seen=new Set();
 for(const {file,record} of await phaseRecords(root)){
  if(record.status==='CLEANED'||processAlive(record.owner)||seen.has(record.taskId))continue;seen.add(record.taskId);
  try{const rows=await phaseRecords(root,record.taskId);if(rows.some(x=>x.record.status==='RUNNING'&&processAlive(x.record.owner)||processAlive(x.record.child)))continue;
   // A producer can finish before a later consumer starts. Its handoff remains
   // leased by the explicit parent task until parent completion, not by a TTL.
   const parent=config.parentTasks&&await json(path.join(config.root,config.parentTasks,record.taskId,'task.json')).catch(e=>{if(missing(e))return null;throw e;});
   if(parent?.status==='OPEN'&&rows.some(x=>x.record.resources.some(r=>r.consumers?.length))&&(!parent.runnerIdentity||processAlive(parent.runnerIdentity)))continue;
   results.push({taskId:record.taskId,...await finishProcessTask(root,record.taskId)});}
  catch(e){results.push({taskId:record.taskId,status:'CLEANUP_REQUIRED',error:String(e.message).slice(0,400)});}
 }
 await trimProcessLogs(config);return {status:results.some(r=>r.status==='CLEANUP_REQUIRED')?'CLEANUP_REQUIRED':'CLEANED',results};
}
export async function reapRetiredProcessImages(root){
 const config=await readProcessConfig(root),removed=[];
 for(const {file,record} of await phaseRecords(root)){
  if(record.status!=='CLEANED')continue;const phase=new ProcessPhase(config,file,record.token);
  for(const image of record.resources.filter(x=>x.kind==='image'&&x.state==='RETAINED')){
   const actual=phase.object('image',image.name);if(!actual)continue;phase.assertObject(record,image,actual);
   const containers=phase.docker(['ps','-aq','--no-trunc']).split('\n').filter(Boolean).map(n=>phase.object('container',n));
   if(containers.some(c=>c?.Image===actual.Id||c?.Config?.Image===image.name))continue;
   await phase.update(r=>{r.resources.find(x=>x.kind==='image'&&x.name===image.name).state='TEMPORARY';r.status='CLEANUP_REQUIRED';});
   const result=await phase.finish({recover:true,outcome:record.outcome});if(result.status!=='CLEANED')throw Error('Retired runtime image cleanup failed');removed.push(image.name);
  }
 }
 return {status:'CLEANED',removed};
}
export async function releaseConsumer(root,taskId,consumer){
 const config=await readProcessConfig(root),results=[];
 for(const {file,record} of await phaseRecords(root,taskId)){
  if(!record.resources.some(x=>x.consumers?.includes(consumer)))continue;
  const phase=new ProcessPhase(config,file,record.token);await phase.update(r=>{for(const x of r.resources)x.consumers=x.consumers?.filter(c=>c!==consumer)||[];});
  if(record.status!=='RUNNING')results.push(await phase.finish({recover:true,outcome:record.outcome}));
 }
 return results;
}
export async function measureProcessUsage(root){
 const config=await readProcessConfig(root);let temporaryBytes=0,dockerBudgetBytes=0;const seen=new Set(),owned=(await phaseRecords(root)).flatMap(({record})=>record.resources.filter(r=>!['REMOVED','RETAINED'].includes(r.state)));
 const walk=async p=>{let st;try{st=await lstat(p);}catch(e){if(missing(e))return;throw e;}if(st.isSymbolicLink())return;if(st.isDirectory()){for(const n of await readdir(p))await walk(path.join(p,n));}else if(!seen.has(st.dev+':'+st.ino)){seen.add(st.dev+':'+st.ino);temporaryBytes+=st.blocks*512;}};
 for(const resource of owned.filter(r=>r.kind==='path'))await walk(resource.path);
 if(owned.some(r=>r.kind!=='path')){
  const client=new ProcessPhase(config,'',null),images=new Set(),volumes=new Set(owned.filter(r=>r.kind==='volume').map(r=>r.name));
  for(const image of owned.filter(r=>r.kind==='image')){const actual=client.object('image',image.name);if(actual&&!images.has(actual.Id)){images.add(actual.Id);dockerBudgetBytes+=actual.Size||0;}}
  for(const builder of owned.filter(r=>r.kind==='builder'))for(const node of client.builderObject(builder.name)?.Nodes||[])volumes.add('buildx_buildkit_'+node.Name+'_state');
  if(volumes.size){const rows=JSON.parse(client.docker(['system','df','-v','--format','{{json .Volumes}}']));for(const volume of rows.filter(v=>volumes.has(v.Name))){const m=volume.Size.match(/^([\d.]+)(B|kB|MB|GB|TB)$/);if(!m)throw Error('Unknown Docker volume budget units');dockerBudgetBytes+=Math.ceil(Number(m[1])*1000**(['B','kB','MB','GB','TB'].indexOf(m[2]))*1.01);}}
 }
 const fs=await statfs(config.root);return {temporaryBytes:temporaryBytes+dockerBudgetBytes,fileAllocatedBytes:temporaryBytes,dockerBudgetBytes,freeBytes:Number(fs.bavail*fs.bsize),maxTemporaryBytes:config.maxTemporaryBytes,reserveBytes:config.reserveBytes};
}
export async function trimProcessLogs(config){
 const directory=path.join(config.root,config.registry,'logs');if(!await exists(directory))return;
 await plain(directory);const files=[];for(const name of await readdir(directory)){const p=path.join(directory,name),st=await lstat(p);if(st.isFile()&&!st.isSymbolicLink())files.push({p,st});}
 files.sort((a,b)=>b.st.mtimeMs-a.st.mtimeMs);let bytes=0;for(const {p,st} of files){bytes+=st.size;if(Date.now()-st.mtimeMs>7*86400000||bytes>100*1024**2)await rm(p);}
}
