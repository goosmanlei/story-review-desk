import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {verifySnapshot} from '../server/project/snapshot.mjs';

/** Snapshot mutations use the same queued maintenance API as the web client. */
export async function snapshotCommand(action,values){
 const project=path.resolve(values.project||'.');
 if(action==='verify'){
  const r=await verifySnapshot(path.resolve(values.file||path.join(project,'project-data/current')),{projectRoot:project});
  return {status:r.status,sha256:r.snapshot.package.transfer.sha256,media:r.snapshot.package.media.length,offlineBytes:r.bytes};
 }
 const machine=values.url?null:JSON.parse(await readFile(path.join(project,'instance/runtime/machine.json'),'utf8'));
 const base=new URL((values.url||machine.apiUrl).replace(/\/?$/,'/'));
 const read=async response=>{const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error?.message||value.message||'快照操作失败'),{code:value.error?.code});return value;};
 if(action==='status')return read(await fetch(new URL('api/v1/maintenance',base)));
 const kind={save:'MAINTENANCE_BACKUP',export:'MAINTENANCE_EXPORT',restore:'MAINTENANCE_RESTORE'}[action];
 if(!kind)throw Error('snapshot save|verify|status|export|restore');
 const extra=action==='restore'?JSON.parse(await readFile(values.file,'utf8')):{};
 const operationId=values['operation-id']||randomUUID();
 console.error('operationId: '+operationId);
 const health=await read(await fetch(new URL('api/v1/health',base)));
 return read(await fetch(new URL('api/v1/jobs',base),{method:'POST',headers:{'Content-Type':'application/json','x-review-runtime':health.project.runtimeEpoch},body:JSON.stringify({...extra,kind,operationId})}));
}
