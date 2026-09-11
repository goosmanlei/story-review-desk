import type {InstanceRepository} from './index.mjs';
export function retainReadValidator(repository:InstanceRepository,request:Request,response:Response):void;
export function conditionalWorkspaceRead(repository:InstanceRepository,request:Request):Promise<Response|null>;
