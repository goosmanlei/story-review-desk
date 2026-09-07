export type MaintenanceHeartbeat={workerId:string;instanceId:string;runtimeEpoch:string;heartbeatAt:string;pid?:number};
export function readMaintenanceHeartbeat(root:string|undefined):Promise<MaintenanceHeartbeat|null>;
export function writeMaintenanceHeartbeat(root:string,worker:MaintenanceHeartbeat):Promise<void>;
export function clearMaintenanceHeartbeat(root:string,workerId:string):Promise<void>;
