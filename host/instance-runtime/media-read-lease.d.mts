import type {InstanceRepository,MediaRecord} from './index.mjs';
export function withRepositoryMediaRead<T>(repository:InstanceRepository|null|undefined,operation:()=>T|Promise<T>,options?:{signal?:AbortSignal}):Promise<T>;
export function readRegisteredMediaBytes(root:string,media:MediaRecord,options?:{maxBytes?:number}):Promise<Buffer>;
