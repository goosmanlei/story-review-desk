// Frozen v2 writer admission, copied from the v2 readLedger binding gate.
// Keep this independent of current task-ledger.mjs: a current reader is not
// evidence that an already-installed v2 writer refuses a future protocol.
import path from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
const root=process.argv[2];
const instance=JSON.parse(await readFile(path.join(root,'instance/instance.json'),'utf8'));
const binding=JSON.parse(await readFile(path.join(root,'tasks/project.json'),'utf8'));
if(![1,2].includes(binding.schemaVersion)||binding.projectId!==instance.id)throw Error('任务账本属于其他实例或版本；请升级 CLI');
// A sentinel demonstrates that no legacy mutation is reached on rejection.
await writeFile(path.join(root,'tasks/events/legacy-writer-must-not-append'),'admitted');
