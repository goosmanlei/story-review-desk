import type {InstanceReadUnit,InstanceUnit} from './index.mjs';
export type AssistantActionReceipt={protocol:string;operationId:string;turnId:string;action:string;status:'SUCCEEDED';mutated:boolean;instanceId:string;runtimeEpoch:string;beforeReleaseId:string|null;resultReleaseId:string|null;resultRevisionId:string|null;resultHash:string};
export function executeAssistantAction(tx:InstanceUnit,input:unknown):Promise<{receipt:AssistantActionReceipt;result:Record<string,unknown>}>;
export function assistantActionReceipts(tx:InstanceReadUnit,turnId:string):Promise<AssistantActionReceipt[]>;
