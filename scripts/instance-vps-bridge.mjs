import {loadInstanceRuntime} from './instance-profile.mjs';
import {startManagedBridge,stopManagedBridge} from './instance-bridge.mjs';
const root=process.argv[3];
if(!root||!['start','stop'].includes(process.argv[2]))throw Error('Expected start|stop and an owned runtime root');
const result=process.argv[2]==='stop'?await stopManagedBridge(root):await startManagedBridge(await loadInstanceRuntime(root));
console.log(JSON.stringify(result));
