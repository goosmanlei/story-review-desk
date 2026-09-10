import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VpsDriver} from '../host/instance-runtime/vps-driver.mjs';
import {command} from '../host/instance-runtime/vps-process.mjs';
import {emptyVpsState} from '../host/instance-runtime/vps-journal.mjs';
import {verifiedFileStream,writeJsonAtomic} from '../host/instance-runtime/vps-package.mjs';
import {validateRestoreMeasurement} from '../host/instance-runtime/vps-capacity.mjs';

/** Local-only, no ingress/web/workers/auth. Every volume and directory has an
 * exact random owner inventory; no full archive is staged in scratch. */
export async function measureVpsRestore({target,baselineRoot,baseline,softwareCommit,restoreContractSha256,appImage,postgresImage,architecture,auditPath}){
 const hostRoot=await mkdtemp(path.join(path.dirname(auditPath),'.vps-capacity-'));
 const local={...target,targetId:'capacity-'+randomUUID(),hostRoot};
 const driver=new VpsDriver(local,emptyVpsState(local));
 driver.docker=(args,options)=>command('docker',['run','create'].includes(args[0])?[args[0],'--platform',architecture,'--pull','never',...args.slice(1)]:args,options);
 driver.startWeb=async()=>{};
 const manifest={releaseId:'measurement_'+randomUUID(),softwareCommit,business:{instanceId:baseline.instanceId,sourceReleaseId:baseline.releaseId},baseline,images:[{role:'app',reference:appImage},{role:'postgres',reference:postgresImage}],files:[]};
 const source={manifest,open:relative=>{
  const file=[baseline.database,...baseline.files].find(f=>'baseline/'+f.path===relative);if(!file)throw Error('Unregistered measurement stream');return verifiedFileStream(baselineRoot,file);
 }};
 const runtime=await driver.runtimeIntent(manifest,randomUUID()),samples=[];
 const evidence={kind:'REVIEW_VPS_RESTORE_MEASUREMENT',schemaVersion:'1.0',status:'RESTORING',baselineManifestSha256:baseline.manifestSha256,databaseSha256:baseline.database.sha256,databaseArchiveBytes:baseline.database.bytes,softwareCommit,restoreContractSha256,architecture,postgresVersion:'18.6',startedAt:new Date().toISOString()};
 let measuring,measurementError;
 const sample=()=>measuring||=(async()=>{
  try{
   const output=await driver.docker(['exec',runtime.pg,'sh','-c','du -lsk "$PGDATA" "$PGDATA/pg_wal"']);
   const [total,wal]=output.split('\n').map(line=>Number(line.split(/\s+/)[0])*1024);
   if(!Number.isSafeInteger(total)||!Number.isSafeInteger(wal)||wal>total)throw Error('Invalid PostgreSQL allocation sample');
   samples.push({at:new Date().toISOString(),postgresBytes:total,dataBytes:total-wal,walBytes:wal});
   await writeJsonAtomic(auditPath,{...evidence,runtime,samples});
  }catch(error){if(!/No such|is not running/.test(error.message))measurementError=error;}
 })().finally(()=>{measuring=null;});
 await writeJsonAtomic(auditPath,{...evidence,runtime,samples});
 const timer=setInterval(sample,1000);
 try{
  await driver.restore(source,runtime);clearInterval(timer);await measuring;await sample();
  if(measurementError)throw measurementError;
  const proof=JSON.parse(await readFile(path.join(runtime.root,'runtime/restore-proof.json'),'utf8'));
  const maxWalSizeBytes=Number(await driver.docker(['exec',runtime.pg,'psql','-U','review','-d','review','-Atc',"SELECT pg_size_bytes(current_setting('max_wal_size'))"]));
  Object.assign(evidence,{status:proof.status,instanceId:proof.instanceId,sourceReleaseId:proof.releaseId,runtimeEpoch:proof.runtimeEpoch,originalBytesPreserved:proof.originalBytesPreserved,businessIdsPreserved:proof.businessIdsPreserved,streamPasses:proof.streamPasses,scratchArchiveBytes:proof.scratchArchiveBytes,sampleCount:samples.length,peakDataBytes:Math.max(...samples.map(s=>s.dataBytes)),peakWalBytes:Math.max(...samples.map(s=>s.walBytes)),peakPostgresBytes:Math.max(...samples.map(s=>s.postgresBytes)),maxWalSizeBytes,finishedAt:new Date().toISOString()});
  validateRestoreMeasurement(evidence,baseline,{restoreContractSha256});
  await writeJsonAtomic(auditPath,{...evidence,runtime,samples});return evidence;
 }catch(error){await writeJsonAtomic(auditPath,{...evidence,status:'FAILED',error:String(error.message),runtime,samples});throw error;}
 finally{clearInterval(timer);await measuring;await driver.removeRuntime(runtime);await rm(hostRoot,{recursive:true});}
}
