import type {ShotProductionManifest} from './shot-production-locks.mjs';
export const SHOT_MANIFEST_NS:Record<string,string>;
export function previewShotProductionManifest(tx:unknown,input:{workItemId:string;api?:unknown;model?:unknown;state?:unknown}):Promise<ShotProductionManifest&{expectedReleaseId:string;manifestHash:string}>;
export function enqueueShotProductionManifest(tx:unknown,input:unknown,options?:{api?:unknown;model?:unknown;state?:unknown}):Promise<unknown>;
export function applyShotProductionManifestProjection<T>(tx:unknown,model:T):Promise<T>;
export function shotManifestCandidateMatchesJob(candidate:Record<string,unknown>,jobs:unknown[]):boolean;
export function runShotProductionManifestIteration(input:{repository:unknown;instanceRoot:string;workerId:string;api:unknown}):Promise<{processed:boolean;jobId?:string;status?:string}>;
