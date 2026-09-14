// Local execution identity and durable records. No task policy or story data.
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {readFile,lstat,realpath,mkdir,open,rename,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error(message);};
let boot,host;
export function detectBootIdentity({platform=process.platform,read=readFileSync,exec=execFileSync}={}) {
 let value,bootSource;
 try {
  if(platform==='linux'){value=read('/proc/sys/kernel/random/boot_id','utf8').trim();bootSource='linux-boot-id-v1';}
  else if(platform==='darwin'){value=exec('sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'}).trim().toUpperCase();bootSource='darwin-boot-session-uuid-v1';}
 } catch {throw Error('EXECUTION_BOOT_UNKNOWN：无法读取稳定机器启动身份');}
 demand(typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value),'EXECUTION_BOOT_UNKNOWN：缺少有效机器启动 UUID');
 return {bootId:hash(value),bootSource};
}
export function bootStamp() {boot||=detectBootIdentity();return {...boot};}
export function bootIdentity() {return bootStamp().bootId;}
// Old macOS records hashed kern.boottime, whose microseconds can change during
// the same boot. A mismatch is uncertainty, never proof of process death.
export function compareBootIdentity(previous,{current=bootStamp(),platform=process.platform,legacyId}={}) {
 if(typeof previous?.bootId!=='string'||!previous.bootId)return 'UNKNOWN';
 if(previous.bootSource===current.bootSource)return previous.bootId===current.bootId?'SAME':'DIFFERENT';
 if(previous.bootSource)return 'UNKNOWN';
 if(platform==='linux'&&current.bootSource==='linux-boot-id-v1')return previous.bootId===current.bootId?'SAME':'DIFFERENT';
 if(platform==='darwin'&&current.bootSource==='darwin-boot-session-uuid-v1'){
  try {const legacy=legacyId??hash(execFileSync('sysctl',['-n','kern.boottime'],{encoding:'utf8'}).trim());return previous.bootId===legacy?'SAME':'UNKNOWN';}
  catch{return 'UNKNOWN';}
 }
 return 'UNKNOWN';
}
export function machineIdentity() {
 if(!host){
  const value=process.platform==='linux'?readFileSync('/etc/machine-id','utf8').trim():process.platform==='darwin'?execFileSync('ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8'}).match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]:null;
  demand(value,'EXECUTION_HOST_UNKNOWN：无法核验本机身份');host=hash(value);
 }
 return host;
}
export async function readExecutionFile(file) {
 try{const st=await lstat(file);demand(st.isFile()&&!st.isSymbolicLink(),'执行记录不是普通文件');return JSON.parse(await readFile(file,'utf8'));}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function durableExecutionFile(file,value) {
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.'+randomUUID()+'.tmp';
 try{
  const f=await open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
  await rename(tmp,file);
  const directory=await open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
 }finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function executionLocation(project) {
 const root=await realpath(path.resolve(project));
 const instance=await readExecutionFile(path.join(root,'instance/instance.json'));
 demand(instance?.id,'必须显式指向含 instance/instance.json 的故事项目根目录');
 // Keep the established runtime address so upgrades preserve original receipts.
 return {root,projectId:instance.id,events:path.join(root,'tasks/events'),runtime:path.join(root,'instance/runtime/task-execution')};
}
export async function bindExecutionScope(loc) {
 const file=path.join(loc.runtime,'scope.json'),scope=await readExecutionFile(file);
 const expected={schemaVersion:1,root:loc.root,projectId:loc.projectId,machineId:machineIdentity()};
 if(scope){demand(Object.entries(expected).every(([k,v])=>scope[k]===v),'EXECUTION_SCOPE：复制或导入的运行态不能继承执行资格');return scope;}
 // Legacy adoption checks every available local origin before adding a stamp.
 for(const name of ['run.json','server/server.json']){
  const previous=await readExecutionFile(path.join(loc.runtime,name));
  if(previous)demand(previous.root===loc.root&&previous.projectId===loc.projectId&&(!previous.host||previous.host===os.hostname()),'EXECUTION_SCOPE：旧运行态归属不符，保留现场');
 }
 await durableExecutionFile(file,expected);return expected;
}
