export type ShotRecipeProductionBasis={workItemId:string;outputBasisHash:string;shotPlanRevisionId:string;inputs:Array<Record<string,unknown>>;timing?:Record<string,unknown>|null;frameSetId?:string|null;keyframeMembers?:Array<Record<string,unknown>>;handles?:{headFrames:number;tailFrames:number};videoBranch?:string;keyframeStrategy?:{mode:string;reason:string;intermediateFrameCount:number}};
export function selectShotRecipeInputFamilies(model:unknown,work:unknown,settings:unknown):{familyIds:string[];blockers:string[]};
export function shotRecipeProductionBasis(model:unknown,work:unknown,plan:unknown,inputs:unknown[]):ShotRecipeProductionBasis;
export function shotRecipeDefinitionBindingReasons(model:unknown,state:unknown,definition:unknown):string[];
