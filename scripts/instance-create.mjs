import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {postgresNames,ensurePostgres,runPostgresMaintenance} from './instance-postgres.mjs';
import {provisionBlankInstance} from './instance-provision.mjs';
import {requiredPhase} from '../host/instance-runtime/process-resources.mjs';
const {values}=parseArgs({options:{instance:{type:'string'},title:{type:'string'},backend:{type:'string'}}});
const backend=values.backend||'postgres';
if(!values.instance||!values.title?.trim()||!['sqlite','postgres'].includes(backend))throw new Error('Usage: instance-create --instance NEW_PATH --title TITLE [--backend postgres|sqlite]');
const root=path.resolve(values.instance),instanceId=`instance_${randomUUID()}`,phase=await requiredPhase(root);if(!phase||!await phase.ownOutput(root))await mkdir(root,{mode:0o700});
for(const folder of ['data','media','scratch','backups','runtime'])await mkdir(path.join(root,folder),{mode:0o700});
const bootstrap=backend==='postgres'?{schemaVersion:'2.0',instanceId,database:{kind:'postgres',database:'review',service:'postgres',volume:postgresNames(instanceId).volume}}:{schemaVersion:'1.0',instanceId,database:'data/review.sqlite'};
await writeFile(path.join(root,'instance.json'),JSON.stringify(bootstrap,null,2)+'\n',{flag:'wx',mode:0o600});
if(backend==='postgres'){await ensurePostgres(root,{create:true});const output=await runPostgresMaintenance(root,['scripts/instance-provision.mjs','--instance','/instance','--title',values.title.trim(),'--backend','postgres']);const result=JSON.parse(output);console.log(JSON.stringify({...result,instance:root}));}
else console.log(JSON.stringify(await provisionBlankInstance(root,values.title.trim(),'sqlite')));
