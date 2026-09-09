export const MATERIAL_REQUIREMENT_REPLACEMENT_PROTOCOL:'MATERIAL_REQUIREMENT_REPLACEMENT_V1';
export type RequirementSelectionUse='CURRENT_TARGET'|'CURRENT_INPUT'|'USAGE_SOURCE'|'ORIGINAL_ASSET_PROVENANCE'|'HISTORICAL_FROZEN';
export type RequirementDisposition={kind:'CURRENT_ATOMIC'|'CURRENT_AGGREGATE'|'REPLACED'|'INVALID_REPLACEMENT'|'HISTORICAL';currentSelectable:boolean;countsAsAtomic:boolean;replacedByRequirementId:string|null;replacementOf:{requirementId:string;requirementHash:string}|null;reasons:string[]};
export function materialRequirementDisposition(model:unknown,requirementId:string):RequirementDisposition;
export function materialRequirementSelectionReasons(model:unknown,requirementId:string,options?:{use?:RequirementSelectionUse}):string[];
export function currentMaterialRequirementRows<T extends {materialRequirements?:unknown[]}>(model:T,options?:{atomicOnly?:boolean}):NonNullable<T['materialRequirements']>;
export function projectMaterialRequirementDispositions<T extends {materialRequirements?:unknown[]}>(model:T):NonNullable<T['materialRequirements']>;
