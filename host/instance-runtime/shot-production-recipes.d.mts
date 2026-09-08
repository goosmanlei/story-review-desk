export const SHOT_RECIPE_NS:{drafts:string;jobs:string;requests:string};
export function validateShotRecipeContent(value:unknown):any;
export function getShotRecipeWorkspace(tx:any,input:{workItemId:string;api:any}):Promise<any>;
export function saveShotRecipeDraft(tx:any,input:any,options:{api:any}):Promise<any>;
export function previewShotRecipe(tx:any,input:any,options:{api:any}):Promise<any>;
export function enqueueShotRecipe(tx:any,input:any,options:{api:any}):Promise<any>;
export function applyShotRecipeJob(tx:any,input:{jobId:string;api:any}):Promise<any>;
export function runShotRecipeIteration(input:{repository:any;api:any}):Promise<any>;
