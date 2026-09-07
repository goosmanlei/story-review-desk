import { parseArgs } from 'node:util';
import { backupInstance } from './instance-transfer.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';
if (await delegateInstanceMaintenance('instance-backup.mjs', process.argv.slice(2))) process.exit(0);
const { values } = parseArgs({ options: { instance: { type: 'string' }, output: { type: 'string' } } });
console.log(JSON.stringify(await backupInstance(values.instance, values.output), null, 2));
