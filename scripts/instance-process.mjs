import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {beginPhase,openPhase,phaseRecords,readProcessConfig,releaseConsumer,sweepProcessTasks,finishProcessTask,checkProcessTask,trimProcessLogs} from '../host/instance-runtime/process-resources.mjs';

export async function runPhase({root,task,phase,command,env=process.env,owned:existing}){
 if(!command?.length)throw Error('A process command is required');
 const owned=existing||await beginPhase(root,task,phase);let code=1,signal=null,failure=null,child,childDone,timer,escalation;
 const handlers=new Map();
 const stop=s=>{signal=s;try{if(child?.pid)process.kill(-child.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}
  escalation||=setTimeout(()=>{try{if(child?.pid)process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}},10000);escalation.unref();};
 try{
  await owned.budget();
  child=spawn(command[0],command.slice(1),{cwd:root,env:{...env,...await owned.environment()},detached:true,stdio:['inherit','pipe','pipe']});
  childDone=new Promise(resolve=>{child.once('error',error=>{failure=error.message;resolve(127);});child.once('close',(exit,s)=>{signal||=s;resolve(exit??(s==='SIGINT'?130:143));});});
  const append=(bytes,stream)=>stream.write(bytes);
  child.stdout.on('data',b=>append(b,process.stdout));child.stderr.on('data',b=>append(b,process.stderr));
  for(const s of ['SIGINT','SIGTERM','SIGHUP']){const handler=()=>stop(s);handlers.set(s,handler);process.on(s,handler);}
  if(child.pid)await owned.childStarted(child.pid);
  let checking=false;
  timer=setInterval(async()=>{if(checking)return;checking=true;try{await owned.budget();}catch(e){failure=e.message;stop('SIGTERM');}finally{checking=false;}},30000);timer.unref();
  code=await childDone;
 }catch(error){failure=error.message;}
 finally{
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){stop('SIGTERM');await childDone;}
  clearInterval(timer);clearTimeout(escalation);for(const [s,h] of handlers)process.off(s,h);
  await owned.childEnded();
 }
 const outcome=signal?'CANCELLED':code===0&&!failure?'SUCCEEDED':'FAILED';
 const receipt=await owned.finish({outcome});
 if(receipt.status!=='CLEANUP_REQUIRED')await releaseConsumer(root,task,phase);
 // Persist only exit diagnostics, never arbitrary command output or arguments
 // (which can contain credentials or private database rows).
 if(outcome!=='SUCCEEDED'){
  const config=await readProcessConfig(root),directory=path.join(root,config.registry,'logs');await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(path.join(directory,task+'--'+phase+'.log'),JSON.stringify({task,phase,code,signal,outcome})+'\n',{mode:0o600});await trimProcessLogs(config);
 }
 const result={taskId:task,phaseId:phase,commandExitCode:code,signal,outcome,status:receipt.status,...(failure?{error:failure}:{}),receipt:owned.file};
 if(!['CLEANED','WAITING_CONSUMERS'].includes(receipt.status)||failure)code||=1;
 return {...result,exitCode:code};
}

export async function main(argv=process.argv.slice(2)){
 const separator=argv.indexOf('--'),args=separator<0?argv:argv.slice(0,separator),command=separator<0?[]:argv.slice(separator+1);
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{root:{type:'string'},task:{type:'string'},phase:{type:'string'},kind:{type:'string'},key:{type:'string'},reason:{type:'string'},consumer:{type:'string'},manifest:{type:'string'}}});
 const action=positionals[0],root=path.resolve(values.root||process.cwd());
 if(action==='run')return runPhase({root,task:values.task,phase:values.phase,command});
 if(action==='sweep')return sweepProcessTasks(root);
 if(action==='finish')return finishProcessTask(root,values.task);
 if(action==='check')return checkProcessTask(root,values.task);
 const phase=await openPhase(JSON.parse(process.env.REVIEW_PROCESS_CONTEXT||'null'));
 if(action==='retain')return phase.retain(values.kind,values.key,values.reason);
 if(action==='transfer')return phase.transfer(values.kind,values.key,values.consumer);
 if(action==='allocate')return {labels:await phase.expect(values.kind,values.key)};
 if(action==='capture')return phase.capture(values.kind,values.key);
 throw Error('instance-process run|sweep|finish|check|allocate|capture|transfer|retain --root ROOT --task ID --phase ID -- COMMAND');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(result=>{console.log(JSON.stringify(result));process.exitCode=result?.exitCode||(['CLEANUP_REQUIRED'].includes(result?.status)?1:0);}).catch(error=>{console.error(JSON.stringify({status:'CLEANUP_REQUIRED',error:error.message}));process.exitCode=1;});
