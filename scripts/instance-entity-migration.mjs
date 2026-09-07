import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {openInstanceRepository,resolveInstance,canonicalJson,sha256} from '../host/instance-runtime/index.mjs';
import {applyMaterialDirectory} from '../host/instance-runtime/material-directory.mjs';
import {saveProductionPreparation,savePreparationMaterialLinks,readProductionPreparation} from '../host/instance-runtime/production-preparation.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';
if(!await delegateInstanceMaintenance('instance-entity-migration.mjs',process.argv.slice(2))){
 const {values}=parseArgs({options:{instance:{type:'string'},file:{type:'string'}}});if(!values.instance||!values.file)throw new Error('Explicit instance and input required');
 const manifest=JSON.parse(await readFile(values.file,'utf8')),input={requestId:manifest.requestId,expectedReleaseId:manifest.expectedReleaseId};
 for(const key of ['directory','preparation','materialLinks'])input[key]=manifest[key]||JSON.parse(await readFile(path.resolve(path.dirname(values.file),manifest[key+'File']),'utf8'));
 const requestHash=sha256(canonicalJson(input)),repo=await openInstanceRepository(resolveInstance(values.instance));
 try{const result=await repo.writeTransaction(async tx=>{
 const prior=await tx.getAux('entity-workflow-migrations',input.requestId);if(prior){const p=JSON.parse(prior.bytes);if(p.requestHash!==requestHash)throw new Error('Migration request differs');return p.result;}
 const view=await tx.readView();if(view.releaseId!==input.expectedReleaseId)throw new Error('Migration release baseline changed');
 const directory=await applyMaterialDirectory(tx,{requestId:input.requestId+':directory',expectedReleaseId:view.releaseId,expectedRevisionId:null,content:input.directory});
 const preparation=await saveProductionPreparation(tx,{requestId:input.requestId+':preparation',expectedReleaseId:directory.releaseId,expectedRevisionId:null,content:input.preparation});
 const links=await savePreparationMaterialLinks(tx,{expectedReleaseId:directory.releaseId,expectedRevisionId:null,content:input.materialLinks});
 const result={directory,preparation,links,formalAdoptionPerformed:false,mediaMutation:false};await tx.putAux({namespace:'entity-workflow-migrations',key:input.requestId,bytes:canonicalJson({requestHash,result}),expectedRevisionId:null});return result;
 });console.log(JSON.stringify(result));console.log(JSON.stringify(await repo.readTransaction(async tx=>{const s=await readProductionPreparation(tx);return{releaseId:s.releaseId,preparationRevisionId:s.revisionId,scenes:s.content?.scenes.length,links:s.materialLinks?.scenes.length,stale:s.stale};})));}finally{await repo.close();}
}
