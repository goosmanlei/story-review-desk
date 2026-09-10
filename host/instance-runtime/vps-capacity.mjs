import {canonicalJson,sha256} from './bytes.mjs';
import {isRestoredRuntime} from './execution-epoch.mjs';

const MiB=1024**2;
const bytes=(value,name)=>{if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid capacity '+name);return value;};
export function validateRestoreMeasurement(value,baseline,{restoreContractSha256}={}){
 if(value?.kind!=='REVIEW_VPS_RESTORE_MEASUREMENT'||value.schemaVersion!=='1.0'||value.status!=='RESTORED_VERIFIED')throw Error('Complete local restore measurement required');
 if(value.baselineManifestSha256!==baseline.manifestSha256||value.databaseSha256!==baseline.database.sha256||value.databaseArchiveBytes!==baseline.database.bytes)throw Error('Capacity measurement belongs to a different frozen baseline');
 if(!/^[a-f0-9]{64}$/.test(value.restoreContractSha256||'')||restoreContractSha256&&value.restoreContractSha256!==restoreContractSha256)throw Error('Capacity restoration contract changed');
 if(!/^linux\/(amd64|arm64)$/.test(value.architecture)||value.postgresVersion!=='18.6'||!Number.isSafeInteger(value.sampleCount)||value.sampleCount<2)throw Error('Unsupported capacity measurement environment');
 for(const key of ['peakDataBytes','peakWalBytes','peakPostgresBytes','maxWalSizeBytes'])if(bytes(value[key],key)===0)throw Error('Incomplete restore storage samples');
 if(value.peakPostgresBytes<Math.max(value.peakDataBytes,value.peakWalBytes)||value.peakPostgresBytes>value.peakDataBytes+value.peakWalBytes||value.scratchArchiveBytes!==0||value.streamPasses!==4)throw Error('Capacity measurement is not a complete streaming restoration');
 if(value.instanceId!==baseline.instanceId||value.sourceReleaseId!==baseline.releaseId||value.originalBytesPreserved!==true||value.businessIdsPreserved!==true||!isRestoredRuntime(value.runtimeEpoch))throw Error('Capacity restore identity proof differs');
 // Local ownership paths and verbose samples stay in the local audit, not in
 // the release. Only the measurement/binding facts are portable.
 return Object.fromEntries(['kind','schemaVersion','status','baselineManifestSha256','databaseSha256','databaseArchiveBytes','restoreContractSha256','architecture','postgresVersion','instanceId','sourceReleaseId','runtimeEpoch','originalBytesPreserved','businessIdsPreserved','streamPasses','scratchArchiveBytes','sampleCount','peakDataBytes','peakWalBytes','peakPostgresBytes','maxWalSizeBytes'].map(key=>[key,value[key]]));
}

/** Logical JSON length is not PostgreSQL allocation. Use a successful isolated
 * restoration, with explicit allowances for layout/architecture and checkpoint
 * variation. These are planning allowances, not a bound on future user writes. */
export function runtimeCapacity(measurement,baseline,files){
 measurement=validateRestoreMeasurement(measurement,baseline);
 const components={
  databaseDataAndIndexesBytes:measurement.peakDataBytes,
  databaseLayoutHeadroomBytes:Math.max(256*MiB,Math.ceil(measurement.peakDataBytes*0.20)),
  databaseWalBytes:Math.max(measurement.peakWalBytes,measurement.maxWalSizeBytes),
  databaseWalHeadroomBytes:measurement.maxWalSizeBytes,
  mediaBytes:baseline.files.reduce((n,f)=>n+f.bytes,0),
  softwareBytes:files.filter(f=>f.path.startsWith('software/')).reduce((n,f)=>n+f.bytes,0),
  runtimeFilesHeadroomBytes:256*MiB,
 };
 const runtimeBudgetBytes=Object.entries(components).reduce((n,[key,value])=>n+bytes(value,key),0);
 return {schemaVersion:'1.0',basis:'MEASURED_STREAM_RESTORE',measurement,components,runtimeBudgetBytes};
}

export function validateRuntimeCapacity(capacity,baseline,files,runtimeBudgetBytes){
 const expected=runtimeCapacity(capacity?.measurement,baseline,files);
 if(canonicalJson(capacity)!==canonicalJson(expected)||runtimeBudgetBytes!==expected.runtimeBudgetBytes)throw Error('Measured runtime capacity inventory differs');
 return capacity;
}

// Changes to database schema/import/derived query code invalidate reused
// measurements; publisher transport, UI-only and documentation fixes do not.
export function restoreMethodSha256(source){
 const start=source.indexOf('\n async restore('),end=source.indexOf('\n async startWeb(',start+1);
 if(start<0||end<0)throw Error('Cannot bind VPS restore implementation');
 return sha256(source.slice(start,end));
}
export function restoreContractFromFiles(files,restoreImplementationSha256){
 if(!/^[a-f0-9]{64}$/.test(restoreImplementationSha256||''))throw Error('Missing restore implementation digest');
 const selected=files.filter(f=>f.path==='scripts/instance-vps-import.mjs'||f.path==='package-lock.json'||f.path.startsWith('host/instance-runtime/')&&!f.path.split('/').at(-1).startsWith('vps-')).map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(!selected.some(f=>f.path==='host/instance-runtime/postgres-schema.mjs')||!selected.some(f=>f.path==='scripts/instance-vps-import.mjs'))throw Error('Missing restore contract files');
 return sha256(canonicalJson({files:selected,restoreImplementationSha256,postgresVersion:'18.6',postgresSettings:'IMAGE_DEFAULTS',streamPasses:4,scratchArchiveBytes:0}));
}
