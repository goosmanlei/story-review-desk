import {WireInput} from '../host/instance-runtime/vps-wire.mjs';
import {openRepeatableArchive} from '../host/instance-runtime/archive-repeatable-stream.mjs';
import {validateArchiveRows} from '../host/instance-runtime/archive-stream-validation.mjs';
import {createArchiveStreamValidator} from '../host/instance-runtime/postgres.mjs';
import {validateRetirementBackupManifestFromFrozenRows} from '../host/instance-runtime/media-retirement-transfer.mjs';
const input=new WireInput(process.stdin),manifest=await input.json();
const reader=await openRepeatableArchive(()=>input.take(manifest.database.bytes),{sha256:manifest.database.sha256,bytes:manifest.database.bytes});
try{
 const frozen=await validateArchiveRows(reader,{instanceId:manifest.instanceId,createValidator:createArchiveStreamValidator});
 await validateRetirementBackupManifestFromFrozenRows(frozen.frozenRetirement,manifest);
 console.log(JSON.stringify({status:'BASELINE_STREAM_VERIFIED',instanceId:manifest.instanceId,sourceReleaseId:manifest.releaseId,streamPasses:reader.passes,exportSha256:frozen.exportSha256}));
}finally{await reader.close();}
