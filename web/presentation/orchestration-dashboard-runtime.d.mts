export type OrchestrationHeartbeat = {schemaVersion:'1.0';instanceId:string;runtimeEpoch:string;status:string;updatedAt:string;active:{kind:string;taskId:string;runId:string}[]};
export function readOrchestrationHeartbeat(root:string|undefined):Promise<OrchestrationHeartbeat|null>;
export function writeOrchestrationHeartbeat(root:string,value:Omit<OrchestrationHeartbeat,'schemaVersion'|'updatedAt'>):Promise<void>;
