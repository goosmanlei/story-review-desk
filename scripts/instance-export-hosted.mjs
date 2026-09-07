import { parseArgs } from 'node:util';
import { exportHostedInstance } from './instance-hosted-export.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';
if (await delegateInstanceMaintenance('instance-export-hosted.mjs', process.argv.slice(2))) process.exit(0);
const { values }=parseArgs({options:{instance:{type:'string'},output:{type:'string'}}});
console.log(JSON.stringify(await exportHostedInstance(values.instance,values.output),null,2));
