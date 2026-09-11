import {spawn,execFileSync} from 'node:child_process';
import {lstat,readFile,writeFile,rename,rm,mkdir,readdir,open} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import {fileSha} from '../server/transport-contract.mjs';
export const exists=async p=>Boolean(await lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;}));
export const json=async p=>JSON.parse(await readFile(p,'utf8'));
export function requireValue(value,message){if(!value)throw Error(message);return value;}
export function run(bin,args,{cwd,input,timeout=60000}={}){return execFileSync(bin,args,{cwd,input,encoding:'utf8',timeout,maxBuffer:16*1024*1024,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']}).trim();}
export async function command(bin,args,{cwd,env=process.env,input,stdout=process.stdout,stderr=process.stderr}={}){
 const child=spawn(bin,args,{cwd,env,stdio:['pipe','pipe','pipe']});child.stdout.pipe(stdout,{end:false});child.stderr.pipe(stderr,{end:false});child.stdin.end(input);
 const [code,signal]=await once(child,'exit');requireValue(code===0,`${path.basename(bin)} 执行失败 (${code??signal})`);
}
export async function atomic(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,file);}finally{await rm(temp,{force:true});}}
export async function plainDirectory(directory){let parent=path.parse(path.resolve(directory)).root;for(const name of path.resolve(directory).slice(parent.length).split(path.sep).filter(Boolean)){parent=path.join(parent,name);const info=await lstat(parent);requireValue(info.isDirectory()&&!info.isSymbolicLink(),'目录路径被替换或使用符号链接');}return parent;}
export async function freePort(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
export async function treeManifest(directory,{exclude=[]}={}){
 const files=[];async function walk(relative){for(const name of (await readdir(path.join(directory,relative))).sort()){const child=relative?relative+'/'+name:name;if(exclude.some(x=>child===x||child.startsWith(x+'/')))continue;const info=await lstat(path.join(directory,child));requireValue(!info.isSymbolicLink(),'受管交付中不能包含符号链接');if(info.isDirectory())await walk(child);else{requireValue(info.isFile(),'受管交付中出现特殊文件');files.push({path:child,bytes:info.size,mode:info.mode&0o777,sha256:await fileSha(path.join(directory,child))});}}}await walk('');return files;
}
export async function verifyTree(directory,manifest,{exclude=[]}={}){const actual=await treeManifest(directory,{exclude});requireValue(JSON.stringify(actual)===JSON.stringify(manifest),'受管目录出现无法确认归属的修改；保留原文件并停止');return true;}
export function shellQuote(value){return "'"+String(value).replaceAll("'","'\\''")+"'";}
export function token(value){return createHash('sha256').update(value).digest('hex').slice(0,16);}
export async function health(base,{commit,instanceId,worker=false}={}){const response=await fetch(new URL('api/v1/health',base),{signal:AbortSignal.timeout(5000)});requireValue(response.ok,'API 健康检查失败');const value=await response.json();requireValue(!commit||value.softwareCommit===commit,'运行软件 SHA 与本次提交不符');requireValue(!instanceId||value.project?.instanceId===instanceId,'运行实例身份不符');requireValue(!worker||value.worker?.value?.softwareCommit===commit&&Date.now()-Date.parse(value.worker.updatedAt)<15000,'后台工作器版本或心跳不符');return value;}
