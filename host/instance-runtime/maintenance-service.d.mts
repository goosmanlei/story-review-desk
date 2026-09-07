import type {InstanceReadUnit,InstanceUnit} from './index.mjs';
export const MAINTENANCE_NAMESPACE:string;
export type MaintenanceInput={action:'backup'|'verify'|'export'|'restore'|'import';backupId?:string;target?:string;uploadId?:string;sourcePath?:string};
export type MaintenanceOperation={schemaVersion:string;operationId:string;instanceId:string;runtimeEpoch:string;requestedReleaseId:string;action:MaintenanceInput['action'];status:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED';createdAt:string;input:MaintenanceInput;workerId:string|null;result:Record<string,unknown>|null;error:string|null};
export function validateMaintenanceRequest(input:unknown):MaintenanceInput;
export function maintenanceState(tx:InstanceReadUnit,options?:{worker?:import('./maintenance-runtime.mjs').MaintenanceHeartbeat|null}):Promise<unknown>;
export function enqueueMaintenance(tx:InstanceUnit,input:unknown,options:{requestId:string;expectedEtag?:string}):Promise<MaintenanceOperation>;
export function claimMaintenance(operation:MaintenanceOperation,options:{instanceId:string;runtimeEpoch:string;workerId:string;now?:string}):MaintenanceOperation;
export function finishMaintenance(operation:MaintenanceOperation,options:{workerId:string;status:'SUCCEEDED'|'FAILED';result?:Record<string,unknown>;error?:string;now?:string}):MaintenanceOperation;
