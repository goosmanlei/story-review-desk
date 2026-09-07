import type {InstanceReadUnit,InstanceUnit} from './index.mjs';
export type AuthoringAdoptionInput={expectedReleaseId:string;rootId:string;expectedRevisionId:string;creativeRevisionId:string;reviewEventId:string};
export function previewAuthoringAdoption(tx:InstanceReadUnit,input:AuthoringAdoptionInput):Promise<AuthoringAdoptionInput&{previewHash:string;checks:string[];sceneCount:number;episodeCount:number}>;
export function adoptAuthoringPlan(tx:InstanceUnit,input:AuthoringAdoptionInput&{previewHash:string;requestId:string}):Promise<Record<string,unknown>>;
