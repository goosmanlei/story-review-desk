import type {InstanceReadUnit} from './index.mjs';
import type {OrchestrationHeartbeat} from './orchestration-dashboard-runtime.mjs';
export type WorkerKind = 'CREATIVE' | 'CREATIVE_QA' | 'DEVELOP' | 'DEVELOP_QA';
export type DashboardTask = {
  id:string|null; title:string; kind:WorkerKind|'UNKNOWN'; kindLabel:string; status:string; statusLabel:string; progress:string;
  result:string|null; createdAt:string|null; updatedAt:string|null; finishedAt:string|null; rootId:string|null; parentId:string|null;
  isRework:boolean; qaFailures:number; currentEpoch:boolean; dependencies:{id:string|null;title:string;completed:boolean}[];
};
export type OrchestrationDashboard = {
  schemaVersion:'1.0'; readOnly:true; instanceId:string|null; observedAt:string;
  mode:{enabled:boolean;status:string}; scheduler:{hostStatus:string;heartbeatAt:string|null;blocked:boolean};
  pools:{kind:WorkerKind;label:string;configured:number;running:number;held:number;waiting:number;available:number;dispatching:boolean}[];
  workers:{id:string|null;workerId:string|null;taskId:string|null;title:string;kind:WorkerKind|'UNKNOWN';status:string;phase:string;model:string|null;effort:string|null;startedAt:string|null;observed:boolean}[];
  processing:DashboardTask[]; queue:DashboardTask[]; completed:{tasks:DashboardTask[];total:number;page:number;pageSize:number};
  decisions:{id:string|null;taskId:string|null;title:string;reason:string;createdAt:string|null}[]; autoRefresh:boolean;
};
export const WORKER_LABELS:Record<WorkerKind,string>;
export const TASK_STATUS_LABELS:Readonly<Record<string,string>>;
export function dashboardText(value:unknown,fallback?:string):string;
export function readOrchestrationDashboard(tx:InstanceReadUnit,options?:{heartbeat?:OrchestrationHeartbeat|null;now?:number;completedPage?:number}):Promise<OrchestrationDashboard>;
