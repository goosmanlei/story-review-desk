import {resolveInstance,openInstanceRepository} from '../host/instance-runtime/index.mjs';
import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
const repository=await openInstanceRepository(resolveInstance('/instance'));
const unsettled=new Set(['QUEUED','RUNNING','STARTED','SUBMITTED','RESULT_UNKNOWN','UNKNOWN','CLAIMED','PROCESSING']);
function active(value){return value&&typeof value==='object'&&(unsettled.has(value.status)||unsettled.has(value.state)||unsettled.has(value.runState));}
try{
 const result=await repository.readTransaction(async tx=>{
  const metadata=await tx.getMetadata(),profile=await tx.getProfile();
  const blockers=[];
  const transactions=await tx.all("SELECT pid,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL");
  for(const transaction of transactions)blockers.push({namespace:'database-transactions',key:String(transaction.pid),state:'RUNNING'});
  // Only current auxiliary heads, never superseded historical revisions.
  const rows=await tx.all("SELECT h.namespace,h.record_key,r.content_bytes FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace LIKE 'aux:%' AND r.deleted=0");
  for(const row of rows){let value;try{value=JSON.parse(row.content_bytes);}catch{continue;}if(active(value))blockers.push({namespace:row.namespace,key:row.record_key,state:value.status||value.state||value.runState});}
  // Formal execution events are append-only; project the latest state per run.
  const runs=new Map();for(const event of await tx.listEvents())if(event.runId&&event.runState&&!runs.has(event.runId))runs.set(event.runId,event);
  for(const [key,value] of runs)if(active(value))blockers.push({namespace:'formal-executions',key,state:value.runState});
  return {metadata,projectId:profile.projectId,blockers};
 });
 const scan=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw Error('Runtime session symlink is forbidden');if(entry.isDirectory())await scan(file);else if(entry.isFile()&&entry.name.endsWith('.json')&&(await lstat(file)).size<=1024**2){let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch{continue;}if(active(value)||value.activeTurnCount>0||value.queuedTurnCount>0||value.activeSlotCount>0)result.blockers.push({namespace:'runtime-sessions',key:entry.name,state:value.state||value.status||'ACTIVE'});}}};
 // Private SDK homes can contain target credentials and are intentionally
 // masked from application containers. Their task/health facts are in AUX.
 await scan('/instance/runtime/assistant/public');
 const health=await fetch('http://127.0.0.1:3000/__review_health').then(r=>r.json());
 if(health.activeRequests>0)result.blockers.push({namespace:'http-requests',key:'gateway',state:'RUNNING',count:health.activeRequests});
 if(process.argv.includes('--verify-media')){
  const manifest=JSON.parse(await readFile('/instance/runtime/restore-manifest.json','utf8'));
  for(const file of manifest.files){const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(path.join('/instance',file.path))){hash.update(chunk);bytes+=chunk.length;}if(bytes!==file.bytes||hash.digest('hex')!==file.sha256)throw Error('Restored media differs');}
  result.integrity=await repository.integrityCheck();result.mediaFiles=manifest.files.length;
 }
 console.log(JSON.stringify(result));
}finally{await repository.close();}
