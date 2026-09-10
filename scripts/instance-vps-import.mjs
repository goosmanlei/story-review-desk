import {readFile} from 'node:fs/promises';
import {resolveInstance} from '../host/instance-runtime/index.mjs';
import {importPostgresRows,createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {openRepeatableArchive,ExactStreamInput} from '../host/instance-runtime/archive-repeatable-stream.mjs';
import {validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';
import {validateRetirementBackupManifestFromFrozenRows} from '../host/instance-runtime/media-retirement-transfer.mjs';
import {isRestoredRuntime} from '../host/instance-runtime/execution-epoch.mjs';

const manifest=JSON.parse(await readFile('/instance/runtime/restore-manifest.json','utf8'));
const input=new ExactStreamInput(process.stdin);
const reader=await openRepeatableArchive(()=>input.take(manifest.database.bytes),{sha256:manifest.database.sha256,bytes:manifest.database.bytes});
let repository;
try{
 const frozen=await validateArchiveRows(reader,{instanceId:manifest.instanceId,createValidator:createArchiveStreamValidator});
 await validateRetirementBackupManifestFromFrozenRows(frozen.frozenRetirement,manifest);
 repository=await importPostgresRows({...resolveInstance('/instance'),reader});
 const proof=repository.importVerification;
 if(proof?.status!=='POSTGRES_IMPORT_VERIFIED'||!proof.originalBytesPreserved||!proof.businessIdsPreserved||!proof.integrity?.ok||!isRestoredRuntime(proof.metadata.runtimeEpoch))throw Error('Missing complete restoration proof');
 console.log(JSON.stringify({status:'RESTORED_VERIFIED',...proof.metadata,originalBytesPreserved:true,businessIdsPreserved:true,integrity:proof.integrity,streamPasses:reader.passes,scratchArchiveBytes:0}));
}finally{await repository?.close();await reader.close();}
