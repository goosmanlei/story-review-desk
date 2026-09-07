import type {InstanceReadUnit,InstanceUnit} from './index.mjs';
import type {SourceBinding} from './domain-model.mjs';
export type ExtractionState={capability?:{initialize:boolean;reason?:string};releaseId:string;input:{revisionId:string;baseReleaseId:string;sourceBindings:SourceBinding[]}|null;task:{taskId:string;state:string;error?:string}|null;sources:Array<SourceBinding&{title:string;textAvailable:boolean;observation:string}>;results:Array<{revisionId:string;taskId:string;summary:string;uncertainties:string[]}>;readOnly:boolean};
export function getExtraction(tx:InstanceReadUnit):Promise<ExtractionState>;
export function prepareExtraction(tx:InstanceUnit,input:{expectedReleaseId:string;expectedInputRevisionId:string|null;sourceBindings:unknown}):Promise<Record<string,unknown>>;
export function requestExtraction(tx:InstanceUnit,input:{inputRevisionId:string;requestId:string}):Promise<Record<string,unknown>>;
export function prepareAndRequestExtraction(tx:InstanceUnit,input:{expectedReleaseId:string;expectedInputRevisionId:string|null;sourceBindings:unknown;requestId:string}):Promise<Record<string,unknown>>;
