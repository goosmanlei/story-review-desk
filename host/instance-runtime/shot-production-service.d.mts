export const SHOT_PRODUCTION_NS: {drafts:string;requests:string;jobs:string};
export function readCurrentShotProductionModel(tx:any,options:{api:any}):Promise<any>;
export function getShotProductionWorkspace(tx:any,input:{sceneId:string;api:any}):Promise<any>;
export function saveShotProductionDraft(tx:any,input:any,options:{api:any}):Promise<any>;
export function previewShotProduction(tx:any,input:any,options:{api:any}):Promise<any>;
export function enqueueShotProduction(tx:any,input:any,options:{api:any}):Promise<any>;
export function applyShotProductionJob(tx:any,input:{jobId:string;api:any}):Promise<any>;
