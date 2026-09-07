import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {openInstanceRepository,resolveInstance} from '../host/instance-runtime/index.mjs';
import {episodeSourceCompiler} from '../host/instance-runtime/episode-source-sync.mjs';
import {loadModernEventRuntime} from '../host/instance-modern-event-validator.mjs';
import {delegateInstanceMaintenance} from './instance-maintenance.mjs';

if(!await delegateInstanceMaintenance('instance-episode-source.mjs',process.argv.slice(2))) {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{instance:{type:'string'},file:{type:'string'}}});
  if(!values.instance||!values.file||positionals.length!==1||!['preview','apply'].includes(positionals[0]))throw new Error('Usage: instance-episode-source.mjs preview|apply --instance ROOT --file exact-manifest.json');
  const input=JSON.parse(await readFile(values.file,'utf8'));
  const compiler=episodeSourceCompiler(loadModernEventRuntime(fileURLToPath(new URL('..',import.meta.url))).api);
  const repo=await openInstanceRepository({...resolveInstance(values.instance),readOnly:positionals[0]==='preview'});
  try {console.log(JSON.stringify(await (positionals[0]==='preview'?repo.readTransaction(tx=>compiler.preview(tx,input)):repo.writeTransaction(tx=>compiler.apply(tx,input))),null,2));}finally{await repo.close();}
}
