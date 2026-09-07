export type ExecutionRuntime={instanceId:string;runtimeEpoch:string};
export const RESTORED_EPOCH_PREFIX:'restore_v1_';
export function restoredRuntimeEpoch(uuid:string):string;
export function isRestoredRuntime(epoch:unknown):boolean;
export function executionRuntimeReason(runtime:ExecutionRuntime|null|undefined,request:Record<string,unknown>):string|null;
export function restoredRunUpdateAllowed(runtime:ExecutionRuntime|null|undefined,request:Record<string,unknown>,previousState:string,nextState:string,hasReconciliationEvidence?:boolean):boolean;
export function restoredUnresolvedRunsForWorkItem(runtime:ExecutionRuntime|null|undefined,requestEvents:Record<string,unknown>[],runEvents:Record<string,unknown>[],workItemId:string):Record<string,unknown>[];
export function executionRequestsForRuntimeQueue(runtime:ExecutionRuntime|null|undefined,current:Record<string,unknown>[],requestEvents?:Record<string,unknown>[],runEvents?:Record<string,unknown>[]):Record<string,unknown>[];
