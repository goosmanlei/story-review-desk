import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,lstat,realpath,unlink,copyFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomic,plainDirectory} from './io.mjs';
import {location,readBindings,readLedger,requireTask} from './task-ledger.mjs';
import {processLock,processAlive,processIdentity} from './process-resources.mjs';
import {connectNative,closeNativeThread} from './task-native.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async f=>{try{const s=await lstat(f);requireTask(s.isFile()&&!s.isSymbolicLink(),'服务记录不是普通文件');return JSON.parse(await readFile(f,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function serverPaths(project){
 const loc=await location(project),directory=path.join(loc.runtime,'server');
 await mkdir(directory,{recursive:true,mode:0o700});await plainDirectory(directory);
 const key=hash(loc.projectId+'\n'+loc.root).slice(0,20),socketDirectory=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'app-server-control');
 await mkdir(socketDirectory,{recursive:true,mode:0o700});await plainDirectory(socketDirectory);
 return {...loc,directory,record:path.join(directory,'server.json'),socket:path.join(socketDirectory,'review-'+key+'.sock'),serviceId:'review-tasks-'+key};
}
export async function verifyTaskServer(project,{connect=connectNative}={}){
 const p=await serverPaths(project),record=await read(p.record);
 requireTask(record&&record.projectId===p.projectId&&record.root===p.root&&record.serviceId===p.serviceId&&record.socket===p.socket,'SERVER_IDENTITY：缺少本项目服务绑定');
 requireTask(processAlive(record.supervisor)&&processAlive(record.process),'SERVER_NOT_RUNNING：专属服务未运行');
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
  return {paths:p,record,client,info,config,socketIdentity:{dev:stat.dev,ino:stat.ino}};
 }catch(e){client.close();throw e;}
}
export async function ensureTaskServer(project,{binary='codex',connect=connectNative}={}){
 const p=await serverPaths(project);
 return processLock(path.join(p.directory,'startup.lock'),async()=>{
  let record=await read(p.record);
  if(record&&processAlive(record.supervisor)||record&&processAlive(record.process)){
   if(!record.process&&processAlive(record.supervisor)){
    requireTask(record.projectId===p.projectId&&record.root===p.root&&record.socket===p.socket,'SERVER_IDENTITY：启动恢复绑定不符');
    const children=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(row=>row&&Number(row[2])===record.supervisor.pid&&row[3].includes(record.binary)&&row[3].includes('unix://'+p.socket)&&row[3].includes(record.sqliteHome));
    requireTask(children.length===1,'SERVER_START_UNKNOWN：无法唯一核查原启动进程，禁止重复启动');
    record={...record,process:processIdentity(Number(children[0][1])),reconciledAt:new Date().toISOString()};await atomic(p.record,record);
   }
   const verified=await verifyTaskServer(project,{connect});verified.client.close();record={...record,socketIdentity:verified.socketIdentity,status:'READY'};await atomic(p.record,record);return {...record,reused:true};
  }
  const socket=await lstat(p.socket).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(socket){requireTask(record?.socketIdentity&&record.serviceId===p.serviceId&&record.root===p.root&&record.socketIdentity.dev===socket.dev&&record.socketIdentity.ino===socket.ino&&!processAlive(record.process)&&!processAlive(record.supervisor),'SERVER_SOCKET_OCCUPIED：未知socket占用，保留现场');await unlink(p.socket);}
  const resolved=await realpath(execFileSync('/bin/sh',['-c','command -v "$1"','task-server',binary],{encoding:'utf8'}).trim());
  const version=execFileSync(resolved,['--version'],{encoding:'utf8'}).trim().replace(/^codex-cli\s+/,'');
  requireTask(/^\d+\.\d+\.\d+/.test(version),'SERVER_VERSION：无法识别Codex版本');
  const generation=randomUUID(),sqliteHome=path.join(p.directory,'state');await mkdir(sqliteHome,{recursive:true,mode:0o700});
  const identity={schemaVersion:1,serviceId:p.serviceId,projectId:p.projectId,root:p.root,generation,socket:p.socket,binary:resolved,binarySha256:hash(await readFile(resolved)),version,sqliteHome,retention:'项目专属长期执行服务；不包含未关闭Agent池'};
  const daemon=path.join(p.directory,'daemon.mjs'),launch=path.join(p.directory,'launch.json');
  await copyFile(fileURLToPath(new URL('./task-server-daemon.mjs',import.meta.url)),daemon);
  const args=['app-server','--listen','unix://'+p.socket,'-c','sqlite_home='+JSON.stringify(sqliteHome),'-c','agents.max_threads=3'];
  await atomic(launch,{root:p.root,record:p.record,identity,binary:resolved,args,log:path.join(p.directory,'server.log')});
  const child=spawn(process.execPath,[daemon,launch],{cwd:p.root,detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  let failure;
  for(let i=0;i<50;i++){await wait(200);record=await read(p.record);if(record?.generation!==generation)continue;if(record.status==='STOPPED')throw Error('SERVER_START_FAILED：专属服务退出 '+record.exitCode);
   try{const verified=await verifyTaskServer(project,{connect});verified.client.close();record={...record,socketIdentity:verified.socketIdentity,verifiedAt:new Date().toISOString(),status:'READY'};await atomic(p.record,record);return {...record,reused:false};}catch(e){failure=e;if(!['ENOENT'].includes(e.code)&&!e.message.includes('SERVER_NOT_RUNNING'))break;}
  }
  throw Error('SERVER_START_FAILED：'+(failure?.message||'未取得可验证服务回执')+'；保留本项目启动记录，不启动第二个实例');
 });
}
export async function stopTaskServer(project){
 const p=await serverPaths(project);
 return processLock(path.join(p.directory,'startup.lock'),async()=>{
  const ledger=await readLedger(p),bindings=await readBindings(p);
  requireTask(!Object.values(ledger.tasks).some(t=>t.assignments?.some(a=>a.status!=='CLOSED'&&bindings.assignments[a.id]?.backendServiceId===p.serviceId)),'SERVER_BUSY：仍有未关闭派工');
  const verified=await verifyTaskServer(project);try{const loaded=await verified.client.call('thread/loaded/list',{limit:100});requireTask(!loaded.data.length,'SERVER_BUSY：仍有已加载执行会话');}finally{verified.client.close();}
  process.kill(verified.record.supervisor.pid,'SIGTERM');for(let i=0;i<50&&processAlive(verified.record.supervisor);i++)await wait(100);
  requireTask(!processAlive(verified.record.supervisor)&&!processAlive(verified.record.process),'SERVER_STOP_UNKNOWN：原进程尚未确认退出');
  await atomic(p.record,{...verified.record,status:'STOPPED',stoppedAt:new Date().toISOString()});
  return {serviceId:p.serviceId,status:'STOPPED',history:'PRESERVED'};
 });
}
export async function probeTaskServer(project){
 const record=await ensureTaskServer(project),v=await verifyTaskServer(project);let probeId;
 try{
  const models=await v.client.call('model/list',{}),loaded=await v.client.call('thread/loaded/list',{limit:100});
  const thread=await v.client.call('thread/start',{cwd:v.paths.directory,ephemeral:false});probeId=thread.thread.id;
  const closure=await closeNativeThread(v.client,probeId,null,{probe:true});
  const cpu=os.availableParallelism(),memory=os.totalmem(),configured=v.config.config.agents?.max_concurrent_threads_per_session??v.config.config.agents?.max_threads;
  requireTask(Number.isInteger(configured)&&configured>0,'SERVER_CAPACITY：服务未返回已配置执行上限');
  const availableSlots=Math.min(3,configured,cpu,Math.max(1,Math.floor(memory/(2*1024**3))));
  return {checkedAt:new Date().toISOString(),backend:'PROJECT_APP_SERVER',backendServiceId:record.serviceId,backendGeneration:record.generation,socket:record.socket,delegation:true,closeVerified:true,goalVerified:false,executionVerified:false,availableSlots,capacityEvidence:{configured,cpu,totalMemoryBytes:memory,limit:3,loadedThreads:loaded.data.length},models:models.data.map(m=>({model:m.model||m.id,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)})),closureProbe:closure,limitation:'专属服务及空线程关闭已核验；真实软件派工与并行重叠须独立验收，长任务使用FOLLOWUP'};
 }catch(error){throw Error('SERVER_PROBE_FAILED：'+error.message+(probeId?'；保留探测会话 '+probeId:''));}finally{v.client.close();}
}
