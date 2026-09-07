export const EXECUTION_PROTOCOL:'REVIEW_CONTROLLED_ACTIONS_V1';
export const DRAFT_ACTIONS:readonly string[];
export const EXECUTION_ACTIONS:readonly string[];
export type ExecutionGrant={protocol:typeof EXECUTION_PROTOCOL;instanceId:string;runtimeEpoch:string;baseReleaseId:string;allowedActions:string[]};
export function validExecutionGrant(value:unknown):value is ExecutionGrant;
export function validTurnExecution(turn:{mode?:unknown;execution?:unknown;assistantContext?:unknown}|null):boolean;
export function createExecutionGrant(metadata:{instanceId:string;runtimeEpoch:string;releaseId:string|null},options?:{allowSettingsPublish?:boolean}):ExecutionGrant;
