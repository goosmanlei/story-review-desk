import {listWorkerRuntimeJobs} from '../host/instance-runtime/execution-epoch.mjs';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {resolveInstance,openInstanceRepository} from '../host/instance-runtime/index.mjs';
import {canonicalJson} from '../host/instance-runtime/bytes.mjs';
import {SHOT_PRODUCTION_NS,applyShotProductionJob,readCurrentShotProductionModel} from '../host/instance-runtime/shot-production-service.mjs';
import {runAnimaticWorkerIteration} from './instance-animatic-worker.mjs';
import {runShotProductionManifestIteration} from '../host/instance-runtime/shot-production-manifest.mjs';
import {runShotRecipeIteration} from '../host/instance-runtime/shot-production-recipes.mjs';
import {runMaterialProductionIteration} from '../host/instance-runtime/material-production-service.mjs';
import {runMaterialUsageIteration} from '../host/instance-runtime/material-usage-service.mjs';
import {runAssetContextRevalidationIteration} from '../host/instance-runtime/asset-context-revalidation-service.mjs';
import {runSpatialShotViewIteration} from '../host/instance-runtime/spatial-shot-view-service.mjs';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
const read=r=>r&&!r.deleted?JSON.parse(r.bytes):null;
export async function runShotProductionWorkerIteration({repository,api}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能执行镜头制作任务');
 const queued=await repository.readTransaction(async tx=>(await listWorkerRuntimeJobs(tx,SHOT_PRODUCTION_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)));
 if(!queued.length)return {processed:false};const job=queued[0];
 try{const result=await repository.writeTransaction(tx=>applyShotProductionJob(tx,{jobId:job.jobId,api}));return {processed:true,jobId:job.jobId,status:'SUCCEEDED',result};}
 catch(e){
  // A failed transaction has not published any source or graph. Never retry its old basis.
  await repository.writeTransaction(async tx=>{const record=await tx.getAux(SHOT_PRODUCTION_NS.jobs,job.jobId),current=read(record);if(current?.status!=='QUEUED')return;await tx.putAux({namespace:SHOT_PRODUCTION_NS.jobs,key:job.jobId,expectedRevisionId:record.revisionId,bytes:canonicalJson({...current,status:'FAILED',error:String(e.message||e).slice(0,1200),completedAt:new Date().toISOString()})});});
  return {processed:true,jobId:job.jobId,status:'FAILED'};
 }
}
export async function shotProductionWorker(instanceRoot,{once=false}={}){
 const instance=resolveInstance(instanceRoot),repository=await openInstanceRepository(instance),{api}=loadModernEventRuntime(fileURLToPath(new URL('..',import.meta.url))),workerId='shot-production-worker_'+randomUUID();let stopping=false;
 const stop=()=>{stopping=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 try{do{
  const material=await runMaterialProductionIteration({repository,api});if(material.processed)process.stdout.write(JSON.stringify(material)+'\n');
  const usage=await runMaterialUsageIteration({repository,api});if(usage.processed)process.stdout.write(JSON.stringify(usage)+'\n');
  const revalidation=await runAssetContextRevalidationIteration({repository,api});if(revalidation.processed)process.stdout.write(JSON.stringify(revalidation)+'\n');
  const spatial=await runSpatialShotViewIteration({repository});if(spatial.processed)process.stdout.write(JSON.stringify(spatial)+'\n');
  const result=await runShotProductionWorkerIteration({repository,api});if(result.processed)process.stdout.write(JSON.stringify(result)+'\n');
  const recipe=await runShotRecipeIteration({repository,api});if(recipe.processed)process.stdout.write(JSON.stringify(recipe)+'\n');
  const manifest=await runShotProductionManifestIteration({repository,instanceRoot:instance.root,workerId,api});if(manifest.processed)process.stdout.write(JSON.stringify(manifest)+'\n');
  const animatic=await runAnimaticWorkerIteration({repository,instanceRoot:instance.root,workerId,modelProvider:repo=>repo.readTransaction(async tx=>(await readCurrentShotProductionModel(tx,{api})).model)});if(animatic.processed)process.stdout.write(JSON.stringify(animatic)+'\n');
  if(once||stopping)break;await new Promise(resolve=>setTimeout(resolve,3000));
 }while(!stopping);}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await repository.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const {values}=parseArgs({options:{instance:{type:'string'},once:{type:'boolean'}}});if(!values.instance)throw Error('必须指定 --instance');await shotProductionWorker(values.instance,{once:values.once});}
