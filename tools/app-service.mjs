import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,mkdir,lstat,realpath,unlink,copyFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {plainDirectory} from './io.mjs';
import {durableExecutionFile as atomic,readExecutionFile as read,executionLocation as location,bindExecutionScope,bootStamp,compareBootIdentity} from './execution-runtime.mjs';
const requireTask=(ok,message)=>{if(!ok)throw Error(message);};
import {processLock,processAlive,processIdentity} from './process-resources.mjs';
import {connectNative} from './task-native.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function serverPaths(project,{readOnly=false}={}){
 const loc=await location(project),directory=path.join(loc.runtime,'server');
 if(!readOnly){await mkdir(directory,{recursive:true,mode:0o700});await plainDirectory(directory);await bindExecutionScope(loc);}
 const key=hash(loc.projectId+'\n'+loc.root).slice(0,20),socketDirectory=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'app-server-control');
 if(!readOnly){await mkdir(socketDirectory,{recursive:true,mode:0o700});await plainDirectory(socketDirectory);}
 return {...loc,directory,record:path.join(directory,'server.json'),socket:path.join(socketDirectory,'review-'+key+'.sock'),serviceId:'review-tasks-'+key};
}
async function verifyService(project,{connect=connectNative,legacyRecovery=false}={}){
 const p=await serverPaths(project),record=await read(p.record);
 requireTask(record&&record.projectId===p.projectId&&record.root===p.root&&record.serviceId===p.serviceId&&record.socket===p.socket,'SERVER_IDENTITY：缺少本项目服务绑定');
 let recoveryIdentity;
 try {requireTask(processAlive(record.process),'SERVER_NOT_RUNNING：专属服务未运行');}
 catch(error) {
  if(!legacyRecovery||process.platform!=='darwin'||record.process?.birthSource||record.process?.bootSource||!error.message.startsWith('EXECUTION_BOOT_UNKNOWN'))throw error;
  const current=processIdentity(record.process.pid,{includeLegacy:true});
  requireTask(current&&current.legacyBirth===record.process.birth&&record.socketIdentity,'SERVER_RECOVERY_IDENTITY：原显示身份或 socket 回执无法匹配，保留现场');
  recoveryIdentity={bootComparison:'UNKNOWN',originalProcess:record.process,observedProcess:current,observedAt:new Date().toISOString()};
 }
 const stat=await lstat(p.socket);requireTask(stat.isSocket()&&!stat.isSymbolicLink(),'SERVER_SOCKET：专属socket无效');
 requireTask(!record.socketIdentity||record.socketIdentity.dev===stat.dev&&record.socketIdentity.ino===stat.ino,'SERVER_SOCKET_IDENTITY：socket已被替换');
 const command=execFileSync('ps',['-p',String(record.process.pid),'-o','command='],{encoding:'utf8'});
 requireTask(command.includes(record.binary)&&command.includes('unix://'+p.socket)&&command.includes(record.sqliteHome),'SERVER_PROCESS_IDENTITY：进程参数不属于本项目');
 requireTask(hash(await readFile(record.binary))===record.binarySha256,'SERVER_BINARY_CHANGED：原服务二进制已改变');
 const client=connect({socket:p.socket});
 try{
  const info=await client.initialize();requireTask(info.userAgent?.includes('/'+record.version+' '),'SERVER_VERSION：RPC版本与所登记进程不符');
  const config=await client.call('config/read',{includeLayers:false});
  requireTask(config.config?.sqlite_home===record.sqliteHome,'SERVER_CONFIGURATION：RPC未返回本项目隔离状态目录');
  if(recoveryIdentity)requireTask(processAlive(recoveryIdentity.observedProcess),'SERVER_RECOVERY_IDENTITY：核查期间进程身份变化');
  return {paths:p,record,client,info,config,socketIdentity:{dev:stat.dev,ino:stat.ino},...(recoveryIdentity?{recoveryIdentity}:{})};
 }catch(e){client.close();throw e;}
}
export async function verifyAppService(project,{connect=connectNative}={}){
 return verifyService(project,{connect});
}
async function awaitOriginalService(project,connect) {
 let failure;
 for(let i=0;i<250;i++){
  try{return await verifyAppService(project,{connect});}
  catch(error){failure=error;if(error.code!=='ENOENT'&&!error.message.includes('SERVER_NOT_RUNNING'))throw error;}
  await wait(200);
 }
 throw failure;
}
// A legacy boottime mismatch cannot establish process death or authorize a
// replacement service. This separate, restricted connection can only inspect
// and close explicitly named, already owned threads in the observed service.
// It never upgrades the historical boot claim or writes a new process binding.
export async function verifyAppServiceRecovery(project,{threads,connect=connectNative}={}) {
 requireTask(Array.isArray(threads)&&threads.length>0,'SERVER_RECOVERY_SCOPE：需要精确原线程范围');
 const p=await serverPaths(project),scope=new Map();
 for(const row of threads){
  requireTask(typeof row.threadId==='string'&&row.threadId&&typeof row.turnId==='string'&&row.turnId&&typeof row.workspace==='string'&&path.isAbsolute(row.workspace)&&row.workspace.startsWith(path.join(p.root,'.process')+path.sep)&&!scope.has(row.threadId),'SERVER_RECOVERY_SCOPE：原线程、轮次或工作区范围无效');
  scope.set(row.threadId,row);
 }
 const v=await verifyService(project,{connect,legacyRecovery:true}),raw=v.client;
 const observed=v.recoveryIdentity?.observedProcess||v.record.process;
 const readOnly=new Set(['thread/read','thread/turns/list','thread/items/list','thread/goal/get','thread/backgroundTerminals/list']);
 const terminals=new Map();
 const call=async(method,params={})=>{
  requireTask(processAlive(observed),'SERVER_RECOVERY_IDENTITY：观察到的进程已结束');
  const st=await lstat(p.socket);requireTask(st.isSocket()&&st.dev===v.socketIdentity.dev&&st.ino===v.socketIdentity.ino,'SERVER_SOCKET_IDENTITY：恢复期间 socket 改变');
  if(method==='thread/loaded/list')return raw.call(method,params);
  const row=scope.get(params.threadId);requireTask(row,'SERVER_RECOVERY_SCOPE：不能操作范围外线程');
  const only=(...keys)=>Object.keys(params).every(key=>keys.includes(key));
  const allowed=readOnly.has(method)||method==='thread/archive'&&only('threadId')||method==='thread/resume'&&only('threadId','cwd','excludeTurns','approvalPolicy')&&params.cwd===row.workspace&&params.excludeTurns===true&&params.approvalPolicy==='never'||method==='thread/goal/set'&&only('threadId','status')&&params.status==='paused'||method==='turn/interrupt'&&only('threadId','turnId')&&params.turnId===row.turnId||method==='thread/backgroundTerminals/terminate'&&only('threadId','processId')&&terminals.get(row.threadId)?.has(params.processId);
  requireTask(allowed,'SERVER_RECOVERY_METHOD：恢复连接只可核查与关闭原执行，禁止新派工和答复');
  const result=await raw.call(method,params);
  if(method==='thread/backgroundTerminals/list'){
   if(!params.cursor)terminals.set(row.threadId,new Set());
   for(const terminal of result.data||[])if(terminal.processId)terminals.get(row.threadId)?.add(terminal.processId);
  }
  return result;
 };
 return {...v,client:{call,flush:()=>raw.flush(),close:()=>raw.close()},recoveryScope:threads};
}
export async function ensureAppService(project,{binary='codex',connect=connectNative}={}){
 const p=await serverPaths(project);
 return processLock(path.join(p.directory,'startup.lock'),async()=>{
  let record=await read(p.record);
  if(record)requireTask(record.projectId===p.projectId&&record.root===p.root&&record.serviceId===p.serviceId&&record.socket===p.socket,'SERVER_IDENTITY：服务绑定不符');
  if(record?.status==='STARTING'&&!record.supervisor){
   const receipt=await read(path.join(p.directory,'launch-process.json'));
   if(receipt?.generation===record.generation&&receipt.process){record={...record,supervisor:receipt.process};await atomic(p.record,record);}
   else requireTask(compareBootIdentity(record)==='DIFFERENT','SERVER_START_UNKNOWN：原启动回执未知，禁止重复启动');
  }
  // The supervisor may have spawned its child just before losing both
  // receipts. Its death in this boot does not prove the child never ran.
  if(record&&!record.process&&['STARTING','LISTENING'].includes(record.status)&&!processAlive(record.supervisor))
   requireTask(compareBootIdentity(record)==='DIFFERENT','SERVER_START_UNKNOWN：原子进程创建结果未知，禁止重复启动');
  if(record&&processAlive(record.supervisor)||record&&processAlive(record.process)){
   if(!record.process&&processAlive(record.supervisor)){
    requireTask(record.projectId===p.projectId&&record.root===p.root&&record.socket===p.socket,'SERVER_IDENTITY：启动恢复绑定不符');
    const children=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(row=>row&&Number(row[2])===record.supervisor.pid&&row[3].includes(record.binary)&&row[3].includes('unix://'+p.socket)&&row[3].includes(record.sqliteHome));
    requireTask(children.length===1,'SERVER_START_UNKNOWN：无法唯一核查原启动进程，禁止重复启动');
    record={...record,process:processIdentity(Number(children[0][1])),reconciledAt:new Date().toISOString()};await atomic(p.record,record);
   }
   const verified=await awaitOriginalService(project,connect);verified.client.close();record={...record,socketIdentity:verified.socketIdentity,status:'READY'};await atomic(p.record,record);return {...record,reused:true};
  }
  const socket=await lstat(p.socket).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(socket){requireTask(record?.socketIdentity&&record.serviceId===p.serviceId&&record.root===p.root&&record.socketIdentity.dev===socket.dev&&record.socketIdentity.ino===socket.ino&&!processAlive(record.process)&&!processAlive(record.supervisor),'SERVER_SOCKET_OCCUPIED：未知socket占用，保留现场');await unlink(p.socket);}
  const resolved=await realpath(execFileSync('/bin/sh',['-c','command -v "$1"','task-server',binary],{encoding:'utf8'}).trim());
  const version=execFileSync(resolved,['--version'],{encoding:'utf8'}).trim().replace(/^codex-cli\s+/,'');
  requireTask(/^\d+\.\d+\.\d+/.test(version),'SERVER_VERSION：无法识别Codex版本');
  if(record){requireTask(record.root===p.root&&record.projectId===p.projectId&&record.serviceId===p.serviceId,'SERVER_IDENTITY：不能接管其他实例记录');await atomic(path.join(p.directory,'generations',record.generation+'.json'),record);}
  const generation=randomUUID(),sqliteHome=path.join(p.directory,'state');await mkdir(sqliteHome,{recursive:true,mode:0o700});
  const identity={schemaVersion:2,...bootStamp(),serviceId:p.serviceId,projectId:p.projectId,root:p.root,generation,socket:p.socket,binary:resolved,binarySha256:hash(await readFile(resolved)),version,sqliteHome,retention:'项目专属长期执行服务；不包含未关闭Agent池'};
  const daemon=path.join(p.directory,'daemon.mjs'),launch=path.join(p.directory,'launch.json');
  await copyFile(fileURLToPath(new URL('./task-server-daemon.mjs',import.meta.url)),daemon);
  await copyFile(fileURLToPath(new URL('./execution-runtime.mjs',import.meta.url)),path.join(p.directory,'execution-runtime.mjs'));
  await copyFile(fileURLToPath(new URL('./process-identity.mjs',import.meta.url)),path.join(p.directory,'process-identity.mjs'));
  const args=['app-server','--listen','unix://'+p.socket,'-c','sqlite_home='+JSON.stringify(sqliteHome)];
  await atomic(launch,{root:p.root,record:p.record,identity,binary:resolved,args,log:path.join(p.directory,'server.log')});
  // Intent precedes spawn. An absent PID is never evidence that spawn did not run.
  await atomic(p.record,{...identity,status:'STARTING',launchOwner:processIdentity(),startedAt:new Date().toISOString()});
  const env={...process.env};for(const key of ['REVIEW_PROCESS_CONTEXT','REVIEW_TASK_ID','REVIEW_TASK_DIR','TMPDIR','TMP','TEMP','TEST_TMPDIR','XDG_CACHE_HOME','npm_config_cache','CODEX_THREAD_ID','CODEX_SESSION_ID'])delete env[key];
  const child=spawn(process.execPath,[daemon,launch],{cwd:p.root,env,detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  await atomic(path.join(p.directory,'launch-process.json'),{generation,process:processIdentity(child.pid)});
  let failure;
  for(let i=0;i<250;i++){await wait(200);record=await read(p.record);if(record?.generation!==generation)continue;if(record.status==='STOPPED')throw Error('SERVER_START_FAILED：专属服务退出 '+record.exitCode);
   try{const verified=await verifyAppService(project,{connect});verified.client.close();record={...record,socketIdentity:verified.socketIdentity,verifiedAt:new Date().toISOString(),status:'READY'};await atomic(p.record,record);return {...record,reused:false};}catch(e){failure=e;if(!['ENOENT'].includes(e.code)&&!e.message.includes('SERVER_NOT_RUNNING'))break;}
  }
  throw Error('SERVER_START_FAILED：'+(failure?.message||'未取得可验证服务回执')+'；保留本项目启动记录，不启动第二个实例');
 });
}
export async function stopAppService(project,{assertIdle,connect=connectNative}={}) {
 const p=await serverPaths(project);
 return processLock(path.join(p.directory,'startup.lock'),async()=>{
  requireTask(typeof assertIdle==='function','SERVER_STOP_POLICY：调用方须核查全部执行占用');
  await assertIdle(p);
  const verified=await verifyAppService(project,{connect});
  try{const loaded=await verified.client.call('thread/loaded/list',{limit:100});requireTask(!loaded.data.length,'SERVER_BUSY：仍有已加载执行会话');}finally{verified.client.close();}
  // Signal only the verified child; an orphan supervisor is not permission to kill a reused PID.
  process.kill(verified.record.process.pid,'SIGTERM');
  for(let i=0;i<50&&(processAlive(verified.record.process)||processAlive(verified.record.supervisor));i++)await wait(100);
  requireTask(!processAlive(verified.record.supervisor)&&!processAlive(verified.record.process),'SERVER_STOP_UNKNOWN：原进程尚未确认退出');
  await atomic(p.record,{...verified.record,status:'STOPPED',stoppedAt:new Date().toISOString()});
  return {serviceId:p.serviceId,status:'STOPPED',history:'PRESERVED'};
 });
}
