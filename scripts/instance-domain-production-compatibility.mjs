import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openInstanceRepository,resolveInstance} from '../host/instance-runtime/index.mjs';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
import {previewDomainProductionCompatibility,applyDomainProductionCompatibility} from '../host/instance-runtime/domain-production-compatibility-service.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';

if(!await delegateInstanceMaintenance('instance-domain-production-compatibility.mjs',process.argv.slice(2))){
 const {values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'},'preview-hash':{type:'string'}}});
 const action=positionals[0];
 if(positionals.length!==1||!['preview','apply'].includes(action)||!values.instance||!values.file||action==='apply'&&!values['preview-hash']||action==='preview'&&values['preview-hash'])throw new Error('用法：instance-domain-production-compatibility.mjs preview|apply --instance ROOT --file REQUEST.json [apply 时提供 --preview-hash SHA]');
 const bytes=await readFile(values.file);if(bytes.length>1024*1024)throw new Error('兼容请求超过 1 MiB');
 const input=JSON.parse(bytes),instance=resolveInstance(values.instance),repo=await openInstanceRepository({...instance,readOnly:action==='preview'}),{api}=loadModernEventRuntime(fileURLToPath(new URL('..',import.meta.url)));
 try{
  const dependencies={api,instanceRoot:instance.root};
  const result=action==='preview'?await repo.readTransaction(tx=>previewDomainProductionCompatibility(tx,input,dependencies)):await repo.writeTransaction(tx=>applyDomainProductionCompatibility(tx,input,{...dependencies,expectedPreviewHash:values['preview-hash']}));
  console.log(JSON.stringify(result,null,2));
 }finally{await repo.close();}
}
