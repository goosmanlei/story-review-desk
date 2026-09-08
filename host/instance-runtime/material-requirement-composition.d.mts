export type RequirementComposition={schemaVersion:'1.0';mode:'ALL';requiredComponents:Array<{id:string;requirementId:string}>};
export type RequirementCoverageRow={id:string;requirementHash?:string;requirementClass?:string|null;scopeRole?:string|null;activeInCurrentProduction?:boolean;assetFamilyRefs?:string[];coverageSatisfied?:boolean;bindingStale?:boolean;coverageReasons?:string[];coveredByFamilyRefs?:string[];coveredByVersionRefs?:string[];composition?:unknown};
export type CompositionCoverage={schemaVersion:'1.0';mode:'ALL';compositionHash:string;requiredCount:number;coveredCount:number;components:Array<{id:string;requirementId:string;requirementHash:string|null;coverageSatisfied:boolean;reasons:string[];coveredByFamilyRefs:string[];coveredByVersionRefs:string[]}>};
export function validateRequirementComposition(value:unknown):RequirementComposition;
export function validateRequirementCompositions(rows:Array<{id:string;composition?:unknown}>,options?:{knownRequirementIds?:string[]}):void;
export function applyRequirementCompositionCoverage<T extends RequirementCoverageRow>(rows:T[]):Array<T&{compositionCoverage?:CompositionCoverage}>;
