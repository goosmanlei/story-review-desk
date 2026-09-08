import {isRestoredRuntime} from '../host/instance-runtime/execution-epoch.mjs';
import {parseArgs} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {resolveInstance,importRepositoryState} from '../host/instance-runtime/index.mjs';
import {backupPostgresInstance} from './instance-transfer.mjs';
import {readArchiveFile,ARCHIVE_FILE_FORMAT} from '../host/instance-runtime/archive-file.mjs';
import {openArchiveRowsWithBinding} from '../host/instance-runtime/archive-stream-validation.mjs';
import {importPostgresRows} from '../host/instance-runtime/postgres.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'},output:{type:'string'},format:{type:'string'},'file-sha':{type:'string'},'file-bytes':{type:'string'}}});
if(positionals[0]==='backup')console.log(JSON.stringify(await backupPostgresInstance(values.instance,values.output)));
else if(positionals[0]==='import'){
 // NDJSON has a bounded indexed path. Legacy object/JSON import is unchanged.
 const format=values.format||'REVIEW_REPOSITORY_ARCHIVE_1';let reader,repo;
 try{
  const instance=resolveInstance(values.instance);
  if(format===ARCHIVE_FILE_FORMAT&&instance.backend==='postgres'){const declared=values['file-sha']!==undefined||values['file-bytes']!==undefined;let binding={};if(declared){if(!/^[1-9][0-9]*$/.test(values['file-bytes']||''))throw Error('Exact positive --file-bytes required');binding={sha256:values['file-sha'],bytes:Number(values['file-bytes'])};}reader=await openArchiveRowsWithBinding(values.file,binding);repo=await importPostgresRows({...instance,reader});}
  else {if(values['file-sha']!==undefined||values['file-bytes']!==undefined)throw Error('Stream file bindings require PostgreSQL NDJSON format');repo=await importRepositoryState({...instance,archive:await readArchiveFile(values.file,format)});}
  const proof=repo.importVerification;
  if(proof?.status!=='POSTGRES_IMPORT_VERIFIED'||proof.originalBytesPreserved!==true||proof.businessIdsPreserved!==true||proof.integrity?.ok!==true)throw new Error('PostgreSQL import did not return its exact verified proof');
  if(!isRestoredRuntime(proof.metadata.runtimeEpoch))throw new Error('PostgreSQL restore did not fence old execution authorizations');
  const result={status:'RESTORED_VERIFIED',...proof.metadata,originalBytesPreserved:true,businessIdsPreserved:true,oldPendingRequests:'INELIGIBLE_REQUIRES_RESULT_CHECK',productionAuthorization:'OLD_REQUESTS_BLOCKED_NEW_AUTHORIZATION_REQUIRED',providerCredentialsRestored:false,integrity:proof.integrity};
  if(values.output)await writeFile(values.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
 }finally{try{await repo?.close();}finally{await reader?.close();}}
}else throw new Error('Expected backup or import');
