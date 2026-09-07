import {isRestoredRuntime} from '../host/instance-runtime/execution-epoch.mjs';
import {parseArgs} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import {resolveInstance,importRepositoryState} from '../host/instance-runtime/index.mjs';
import {backupPostgresInstance} from './instance-transfer.mjs';
import {readArchiveFile} from '../host/instance-runtime/archive-file.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'},output:{type:'string'},format:{type:'string'}}});
if(positionals[0]==='backup')console.log(JSON.stringify(await backupPostgresInstance(values.instance,values.output)));
else if(positionals[0]==='import'){
 // No CLI-held original archive survives the import call.
 const repo=await importRepositoryState({...resolveInstance(values.instance),archive:await readArchiveFile(values.file,values.format||'REVIEW_REPOSITORY_ARCHIVE_1')});
 try{
  const proof=repo.importVerification;
  if(proof?.status!=='POSTGRES_IMPORT_VERIFIED'||proof.originalBytesPreserved!==true||proof.businessIdsPreserved!==true||proof.integrity?.ok!==true)throw new Error('PostgreSQL import did not return its exact verified proof');
  if(!isRestoredRuntime(proof.metadata.runtimeEpoch))throw new Error('PostgreSQL restore did not fence old execution authorizations');
  const result={status:'RESTORED_VERIFIED',...proof.metadata,originalBytesPreserved:true,businessIdsPreserved:true,oldPendingRequests:'INELIGIBLE_REQUIRES_RESULT_CHECK',productionAuthorization:'OLD_REQUESTS_BLOCKED_NEW_AUTHORIZATION_REQUIRED',providerCredentialsRestored:false,integrity:proof.integrity};
  if(values.output)await writeFile(values.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
 }finally{await repo.close();}
}else throw new Error('Expected backup or import');
