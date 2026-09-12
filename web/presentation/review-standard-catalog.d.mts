import type { Configuration, ReviewProfile } from './configuration-model.mjs';
export type ReviewCatalogNode = { id:string; label:string; children:ReviewCatalogNode[]; profileIds?:string[]; subjectKind?:string; condition?:string };
export const materialStandards: string[][];
export const productionGroups: Array<[string,string,Array<[string,string,string[]]>]>;
export const deliveryAliases: Record<string,string>;
export const deliveryLabels: Record<string,string>;
export function standardLabel(profile?: ReviewProfile): string;
export function reviewCatalog(configuration:Configuration): ReviewCatalogNode[];
export function leafForProfile(nodes:ReviewCatalogNode[], id:string): ReviewCatalogNode | null;
