import { parseArgs } from 'node:util';
import { restoreInstance } from './instance-transfer.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';
import {requiredPhase} from '../host/instance-runtime/process-resources.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {postgresNames} from './instance-postgres.mjs';
const task=await requiredPhase(process.cwd());
if (await delegateInstanceMaintenance('instance-restore.mjs', process.argv.slice(2))) process.exit(0);
const { values } = parseArgs({ options: { backup: { type: 'string' }, output: { type: 'string' },consumer:{type:'string'},'retain-reason':{type:'string'},temporary:{type:'boolean'} } });
if(task&&[values.consumer,values['retain-reason'],values.temporary].filter(Boolean).length!==1)throw Error('Restore needs one --consumer, --retain-reason, or --temporary disposition');
console.log(JSON.stringify(await restoreInstance(values.backup, values.output), null, 2));
if(task&&!values.temporary){
 const bootstrap=JSON.parse(await readFile(path.join(values.output,'instance.json'))),names=bootstrap.schemaVersion==='2.0'?postgresNames(bootstrap.instanceId,bootstrap.database.volume):null;
 const selected=[['path',values.output],...(names?[['container',names.container],['network',names.network],['volume',names.volume]]:[])];
 for(const [kind,key] of selected){if(values.consumer)await task.transfer(kind,key,values.consumer);else await task.retain(kind,key,values['retain-reason']);}
}
