import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {openInstanceRepository,resolveInstance} from '../host/instance-runtime/index.mjs';
import {inspectGuidance,updateGuidance} from '../host/instance-runtime/guidance-service.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';
if(!await delegateInstanceMaintenance('instance-guidance.mjs',process.argv.slice(2))){
 const{values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'},'include-topics':{type:'boolean'}}});
 if(!values.instance||positionals.length!==1||!['inspect','apply'].includes(positionals[0])||positionals[0]==='apply'&&(!values.file||values['include-topics'])||positionals[0]==='inspect'&&values.file)throw new Error('Usage: instance-guidance.mjs inspect --instance ROOT [--include-topics] | apply --instance ROOT --file MANIFEST.json');
 const input=values.file?JSON.parse(await readFile(values.file,'utf8')):null,repo=await openInstanceRepository({...resolveInstance(values.instance),readOnly:positionals[0]==='inspect'});
 try{const result=await (positionals[0]==='inspect'?repo.readTransaction(tx=>inspectGuidance(tx,{includeTopics:values['include-topics']})):repo.writeTransaction(tx=>updateGuidance(tx,input)));console.log(JSON.stringify(result,null,2));}finally{await repo.close();}
}
