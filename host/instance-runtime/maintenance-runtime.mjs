import {lstat,realpath,mkdir,open,rename,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
async function healthPath(root,create=false){
 if(!root)return null;
 root=path.resolve(root);if(await realpath(root)!==root)throw new Error('实例路径不能经过符号链接');
 for(const directory of [root,path.join(root,'runtime'),path.join(root,'runtime','locks')]){
  if(create)await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('维护健康目录无效');
 }
 return path.join(root,'runtime','locks','maintenance-health.json');
}
export async function readMaintenanceHeartbeat(root){
 try{const file=await healthPath(root);if(!file)return null;const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return null;
 const value=JSON.parse(await readFile(file,'utf8'));
 return value&&['workerId','instanceId','runtimeEpoch','heartbeatAt'].every(key=>typeof value[key]==='string'&&value[key].length>0)&&Number.isFinite(Date.parse(value.heartbeatAt))?value:null;
 }catch{return null;}
}
export async function writeMaintenanceHeartbeat(root,worker){
 const file=await healthPath(root,true),temporary=file+'.'+randomUUID()+'.tmp';
 const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(worker));await handle.sync();await handle.close();await rename(temporary,file);}
 catch(error){await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
}
export async function clearMaintenanceHeartbeat(root,workerId){
 const current=await readMaintenanceHeartbeat(root);if(current?.workerId===workerId)await unlink(await healthPath(root)).catch(error=>{if(error.code!=='ENOENT')throw error;});
}
