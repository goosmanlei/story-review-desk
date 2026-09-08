export const MATERIAL_PRODUCTION_NS:{drafts:string;jobs:string;requests:string};
export function validateMaterialProductionContent(value:unknown):any;
export function getMaterialProductionWorkspace(tx:any,input:{requirementId:string;api:any}):Promise<any>;
export function saveMaterialProductionDraft(tx:any,input:any,options:{api:any}):Promise<any>;
export function previewMaterialProduction(tx:any,input:any,options:{api:any}):Promise<any>;
export function enqueueMaterialProduction(tx:any,input:any,options:{api:any}):Promise<any>;
export function applyMaterialProductionJob(tx:any,input:{jobId:string;api:any}):Promise<any>;
export function runMaterialProductionIteration(input:{repository:any;api:any}):Promise<any>;
