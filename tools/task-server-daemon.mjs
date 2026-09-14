// Standalone supervisor copied into project runtime, so worktrees can be retired.
import {readFile,writeFile,rename,open} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const file=process.argv[2],spec=JSON.parse(await readFile(file,'utf8'));
const identity=pid=>({pid,birth:execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim()});
const save=async value=>{const tmp=spec.record+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,spec.record);};
let record={...spec.identity,supervisor:identity(process.pid),status:'STARTING',startedAt:new Date().toISOString()};
await save(record);
const log=await open(spec.log,'a',0o600);let logBytes=(await log.stat()).size;
const child=spawn(spec.binary,spec.args,{cwd:spec.root,env:process.env,stdio:['ignore','pipe','pipe']});
const logging=data=>{const kept=data.subarray(0,Math.max(0,1024*1024-logBytes));logBytes+=kept.length;if(kept.length)void log.write(kept);};
child.stdout.on('data',logging);child.stderr.on('data',logging);
child.on('error',error=>{record.error={code:error.code||'SPAWN_FAILED',message:'专属AppServer启动失败'};});
child.once('spawn',()=>{record={...record,process:identity(child.pid),status:'LISTENING'};void save(record);});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref();});
child.once('close',async(code,signal)=>{const stored=JSON.parse(await readFile(spec.record,'utf8'));if(stored.generation===record.generation)record={...stored,...record,socketIdentity:stored.socketIdentity};record={...record,status:'STOPPED',exitCode:code,signal,stoppedAt:new Date().toISOString()};await save(record);await log.close();process.exit(code||0);});
