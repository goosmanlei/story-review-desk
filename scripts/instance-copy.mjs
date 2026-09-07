import { parseArgs } from 'node:util';
import { backupInstance, restoreInstance } from './instance-transfer.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';
if (await delegateInstanceMaintenance('instance-copy.mjs', process.argv.slice(2))) process.exit(0);
const { values } = parseArgs({ options: { instance: { type: 'string' }, backup: { type: 'string' }, output: { type: 'string' } } });
if (!values.backup || !values.output) throw new Error('Explicit new --backup and --output paths are required');
const backup = await backupInstance(values.instance, values.backup);
const restored = await restoreInstance(backup.output, values.output);
console.log(JSON.stringify({ backup, restored, identityPolicy: 'SAME_STORY_ALL_BUSINESS_IDS_PRESERVED' }, null, 2));
