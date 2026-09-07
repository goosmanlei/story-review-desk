import type {InstanceReadUnit,InstanceUnit,OpaqueLegacyJson} from './index.mjs';
export const QUERY_MODEL_VERSION:number;
export function ensureQueryModel(tx:InstanceUnit,input:{releaseId:string}):Promise<void>;
export function objectSummary(value:Record<string,OpaqueLegacyJson>):Record<string,OpaqueLegacyJson>;
export function installQueryModel(tx:InstanceUnit):Promise<void>;
export function rebuildQueryModel(tx:InstanceUnit,input:{releaseId:string;snapshot:Record<string,OpaqueLegacyJson>;recipes:Record<string,OpaqueLegacyJson>}):Promise<void>;
export function queryObjects(tx:InstanceReadUnit,input:{releaseId:string;collection:string;ids?:string[];scopeType?:string|null;scopeId?:string|null;familyIds?:string[];requirementIds?:string[];after?:string;offset?:number;limit?:number;summary?:boolean;required?:boolean;search?:string}):Promise<{items:Record<string,OpaqueLegacyJson>[];total:number;lastId:string|null}>;
export function updateOperationalProjection(tx:InstanceUnit,input:{releaseId:string;eventSequence:number;stateProjection:Record<string,OpaqueLegacyJson>}):Promise<void>;
