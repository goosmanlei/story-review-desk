import { startInstance } from './instance-start.mjs';
await startInstance(process.argv.slice(2), { forceRecreate: true, noCache: true });
