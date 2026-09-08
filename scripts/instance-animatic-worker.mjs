import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolveInstance,openInstanceRepository} from '../host/instance-runtime/index.mjs';
import {canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {ANIMATIC_NS,claimAnimaticRender,finishAnimaticRender} from '../host/instance-runtime/animatic-service.mjs';
import {runAnimaticReconciliationIteration} from '../host/instance-runtime/animatic-recovery.mjs';
import {renderAnimatic} from '../host/instance-runtime/animatic-render.mjs';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
import {readCurrentShotProductionModel} from '../host/instance-runtime/shot-production-service.mjs';
const read=r=>r&&!r.deleted?JSON.parse(Buffer.from(r.bytes).toString('utf8')):null;
export async function runAnimaticWorkerIteration({repository,instanceRoot,workerId,render=renderAnimatic,modelProvider}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能执行预演任务');
 const reconciled=await runAnimaticReconciliationIteration({repository,instanceRoot,workerId});if(reconciled.processed)return reconciled;
 const jobs=await repository.readTransaction(async tx=>(await tx.listAux(ANIMATIC_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)));if(!jobs.length)return{processed:false};
 // Claim and the entire render are fenced by one live shared media session.
 // An explicit recovery cannot declare absence while a renderer can still write.
 return repository.withMediaReadLease(async lease=>{
  await lease.assertHeld();let claimed;
  try{claimed=await repository.writeTransaction(tx=>claimAnimaticRender(tx,jobs[0].jobId,workerId));}catch(e){await lease.assertHeld();await repository.writeTransaction(async tx=>{const record=await tx.getAux(ANIMATIC_NS.jobs,jobs[0].jobId),job=read(record);if(job?.status!=='QUEUED')return;await tx.putAux({namespace:ANIMATIC_NS.jobs,key:job.jobId,expectedRevisionId:record.revisionId,bytes:canonicalJson({...job,status:'FAILED',error:String(e.message||e).slice(0,1000),completedAt:new Date().toISOString()})});});return{processed:true,jobId:jobs[0].jobId,status:'FAILED'};}
  if(!claimed)return{processed:false};let result;
  try{
   result=await render({repository,instanceRoot,...claimed,assertHeld:()=>lease.assertHeld()});await lease.assertHeld();
   const options=modelProvider?{model:await modelProvider(repository)}:{};
   await repository.writeTransaction(tx=>finishAnimaticRender(tx,{jobId:claimed.job.jobId,jobRevisionId:claimed.jobRevisionId,workerId,result},options));
   return{processed:true,jobId:claimed.job.jobId,status:'SUCCEEDED'};
  }catch(e){
   // Keep materialized output; never reclaim or retry a job whose result is unknown.
   await lease.assertHeld();const outputPresent=await lstat(path.join(instanceRoot,claimed.job.expectedOutput.targetPath)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),status=result||outputPresent?'RESULT_UNKNOWN':'FAILED';
   await repository.writeTransaction(async tx=>{const record=await tx.getAux(ANIMATIC_NS.jobs,claimed.job.jobId),job=read(record);if(record?.revisionId!==claimed.jobRevisionId||job?.workerId!==workerId||job.status!=='RUNNING')return;await tx.putAux({namespace:ANIMATIC_NS.jobs,key:job.jobId,expectedRevisionId:record.revisionId,bytes:canonicalJson({...job,status,error:String(e.message||e).slice(0,1500),result:result||null,completedAt:new Date().toISOString()})});});return{processed:true,jobId:claimed.job.jobId,status};
  }
 });
}
export async function animaticWorker(instanceRoot,{once=false}={}){
 const instance=resolveInstance(instanceRoot),repository=await openInstanceRepository(instance),workerId='animatic-worker_'+randomUUID(),api=loadModernEventRuntime(fileURLToPath(new URL('..',import.meta.url))).api;
 const modelProvider=repo=>repo.readTransaction(async tx=>(await readCurrentShotProductionModel(tx,{api})).model);
 let stopping=false;const stop=()=>{stopping=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{do{const result=await runAnimaticWorkerIteration({repository,instanceRoot:instance.root,workerId,modelProvider});process.stdout.write(JSON.stringify(result)+'\n');if(once||stopping)break;await new Promise(resolve=>setTimeout(resolve,3000));}while(!stopping);}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await repository.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const{values}=parseArgs({options:{instance:{type:'string'},once:{type:'boolean'}}});if(!values.instance)throw Error('必须指定 --instance');await animaticWorker(values.instance,{once:values.once});}
