import {readFile} from 'node:fs/promises';
import {runDecisionChannel} from './task-decision-channel.mjs';
const spec=JSON.parse(await readFile(process.argv[2],'utf8'));
runDecisionChannel(spec).catch(()=>{process.exitCode=1;});
