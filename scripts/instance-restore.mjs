import { parseArgs } from 'node:util';
import { restoreInstance } from './instance-transfer.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';
if (await delegateInstanceMaintenance('instance-restore.mjs', process.argv.slice(2))) process.exit(0);
const { values } = parseArgs({ options: { backup: { type: 'string' }, output: { type: 'string' } } });
console.log(JSON.stringify(await restoreInstance(values.backup, values.output), null, 2));
