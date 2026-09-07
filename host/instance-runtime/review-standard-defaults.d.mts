import type { Configuration, ReviewSpec } from './configuration-model.mjs';
export function standardDefaults(configuration:Configuration):Configuration;
export function reorganizeStandards(configuration:Configuration, defaults:Configuration, frozenSpecs?:ReviewSpec[]):{configuration:Configuration;audit:Array<{profileId:string;label:string;action:string;replacementProfileId:string|null;frozenReferenceCount:number;reason:string}>};
