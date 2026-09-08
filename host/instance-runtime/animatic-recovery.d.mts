export const ANIMATIC_RECOVERY_NS:Record<string,string>;
export function enqueueAnimaticReconciliation(tx:unknown,input:unknown):Promise<{reconciliationId:string;status:string;automaticRetry:false}>;
export function inspectAnimaticOutput(instanceRoot:string,relativePath:string,options?:unknown):Promise<Record<string,unknown>>;
export function runAnimaticReconciliationIteration(options:unknown):Promise<Record<string,unknown>>;
