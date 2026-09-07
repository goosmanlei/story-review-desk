import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openInstanceRepository,resolveInstance} from './index.mjs';
import {delegateInstanceMaintenance,flagValue} from '../../scripts/instance-maintenance.mjs';
import {listDomainSources,prepareSourceImport,importSource,registerPublishedSource} from './domain-sources.mjs';
import * as domain from './domain-service.mjs';
import {previewAuthoringAdoption,adoptAuthoringPlan} from './domain-authoring-sync.mjs';
import {getAuthoring,saveAuthoringRoot} from './domain-authoring.mjs';

/** CLI and browser call the same transactional domain functions. */
export async function runDomainCli(kind,argv=process.argv.slice(2)){
 const script=`instance-${kind}.mjs`;if(kind==='sources'&&flagValue(argv,'--source')&&!flagValue(argv,'--filename'))argv=[...argv,'--filename',path.basename(flagValue(argv,'--source'))];
 if(await delegateInstanceMaintenance(script,argv))return;
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'},source:{type:'string'},filename:{type:'string'},title:{type:'string'},role:{type:'string'},'expected-release':{type:'string'}}});
 if(!values.instance||positionals.length!==1)throw new Error(`Usage: ${script} ACTION --instance PATH [--file PAYLOAD.json]`);const action=positionals[0];
 if(['relations','initialize'].includes(kind)&&!['inspect','list'].includes(action))throw new Error('旧整图与初始化写入已停用；请在故事设定、素材管理或系统配置的独立工作区操作。');
 const input=values.file?JSON.parse(await readFile(values.file,'utf8')):{};if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Payload must be an object');
 const readOnly=['inspect','list','preview'].includes(action),repo=await openInstanceRepository({...resolveInstance(values.instance),readOnly});
 try{
  const execute=async tx=>{
  let prepared;if(kind==='sources'&&action==='import')prepared=await prepareSourceImport({...input,title:values.title||input.title,role:values.role||input.role,filename:values.filename||input.filename,expectedReleaseId:values['expected-release']||input.expectedReleaseId,...(values.source?{bytes:await readFile(values.source)}:{})},values.instance);
   if(kind==='sources'){if(['inspect','list'].includes(action))return listDomainSources(tx);if(action==='import')return importSource(tx,prepared);if(action==='register')return registerPublishedSource(tx,input);}
   if(kind==='relations'){if(['inspect','list'].includes(action))return domain.getRelations(tx,input);if(action==='save')return domain.saveRelationsDraft(tx,input);if(action==='preview')return domain.previewRelations(tx,input.draftRevisionId);if(action==='publish')return domain.publishRelations(tx,{...input,requestId:input.requestId||`cli_${randomUUID()}`});}
   if(kind==='initialize'){if(['inspect','list'].includes(action))return domain.getInitialization(tx);if(action==='prepare')return domain.prepareInitialization(tx,input);if(action==='save')return domain.saveInitializationDraft(tx,input);if(action==='preview'){const preview=await domain.previewInitialization(tx,input.draftRevisionId);delete preview.configInput;return preview;}if(action==='publish')return domain.publishInitialization(tx,{...input,requestId:input.requestId||`cli_${randomUUID()}`});if(action==='run')return domain.requestInitializationTask(tx,input);if(action==='claim')return domain.claimInitializationTask(tx,input);if(action==='submit')return domain.submitInitializationTask(tx,input);}
   if(kind==='authoring'){if(['inspect','list'].includes(action))return getAuthoring(tx);if(action==='preview')return previewAuthoringAdoption(tx,input);if(action==='adopt')return adoptAuthoringPlan(tx,{...input,requestId:input.requestId||`cli_${randomUUID()}`});if(action==='save')return saveAuthoringRoot(tx,{...input,requestId:input.requestId||`cli_${randomUUID()}`});}
   throw new Error(`Unsupported ${kind} action: ${action}`);
  };
  const result=await (readOnly?repo.readTransaction(execute):repo.writeTransaction(execute));process.stdout.write(JSON.stringify(result,null,2)+'\n');
 }finally{await repo.close();}
}
