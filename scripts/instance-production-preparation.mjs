import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {openInstanceRepository,resolveInstance} from '../host/instance-runtime/index.mjs';
import {readProductionPreparation,saveProductionPreparation,savePreparationMaterialLinks,previewProductionPreparationRevalidation,applyProductionPreparationRevalidation} from '../host/instance-runtime/production-preparation.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';

if(!await delegateInstanceMaintenance('instance-production-preparation.mjs',process.argv.slice(2))){
 const {values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'}}});
 const command=positionals[0],readOnly=['inspect','revalidate-preview'].includes(command);
 if(!values.instance||positionals.length!==1||!['inspect','apply','apply-links','revalidate-preview','revalidate-apply'].includes(command))throw new Error('Use inspect|apply|apply-links|revalidate-preview|revalidate-apply --instance ROOT [--file INPUT]');
 if(command!=='inspect'&&!values.file)throw new Error('This operation requires an exact input file');
 const repo=await openInstanceRepository({...resolveInstance(values.instance),readOnly});
 try{
  if(command==='inspect'){
   const s=await repo.readTransaction(readProductionPreparation);
   console.log(JSON.stringify({releaseId:s.releaseId,revisionId:s.revisionId,materialLinksRevisionId:s.materialLinksRevisionId,directoryRevisionId:s.directoryRevisionId,candidateId:s.candidate?.revisionId,contentHash:s.candidate?.contentHash,sceneCount:s.content?.scenes?.length||0,stale:s.stale,sceneValidity:s.sceneValidity,pendingUsage:s.materialLinks?.pending||[]}));
  }else{
   const input=JSON.parse(await readFile(values.file,'utf8'));
   const operation={'apply':saveProductionPreparation,'apply-links':savePreparationMaterialLinks,'revalidate-preview':previewProductionPreparationRevalidation,'revalidate-apply':applyProductionPreparationRevalidation}[command];
   console.log(JSON.stringify(await (readOnly?repo.readTransaction(tx=>operation(tx,input)):repo.writeTransaction(tx=>operation(tx,input)))));
  }
 }finally{await repo.close();}
}
