/** Read-only catalog projection. Counts are unique REQUIRED needs, never versions,
 * episode occurrences, or independent trial records. No identity is rewritten. */
export type MaterialCatalogFacet = 'mediaType' | 'entityType' | 'entityId' | 'stateId' | 'episodeUid' | 'sceneId' | 'creatorStage';
export type MaterialCatalogFilters = Record<MaterialCatalogFacet, string> & {search: string};
export type MaterialCatalogRow = {
  id: string;
  required: boolean;
  mediaType: string;
  entityType: string;
  entityId: string;
  stateId: string;
  episodeUids: string[];
  sceneIds: string[];
  usagePairs?: Array<{episodeUid:string;sceneId:string}>;
  creatorStage: string;
  searchText: string;
};
export const allMaterialCatalogFilters = (): MaterialCatalogFilters => ({mediaType:'ALL',entityType:'ALL',entityId:'ALL',stateId:'ALL',episodeUid:'ALL',sceneId:'ALL',creatorStage:'ALL',search:''});
export const isAllCatalogValue = (value: string) => value === 'ALL' || value === '全部' || !value;
export function uniqueMaterialCatalogRows<T extends MaterialCatalogRow>(rows: T[]): T[] {
  const unique = new Map<string,T>();
  for (const row of rows) {
    const key = `${row.required ? 'requirement' : 'trial'}:${row.id}`;
    if (!unique.has(key)) unique.set(key,row);
  }
  return [...unique.values()];
}
export function matchesMaterialCatalogRow(row: MaterialCatalogRow, filters: MaterialCatalogFilters): boolean {
  for (const facet of ['mediaType','entityType','entityId','stateId','creatorStage'] as const) {
    if (!isAllCatalogValue(filters[facet]) && row[facet] !== filters[facet]) return false;
  }
  if (!isAllCatalogValue(filters.episodeUid) && !row.episodeUids.includes(filters.episodeUid)) return false;
  if (!isAllCatalogValue(filters.sceneId) && !row.sceneIds.includes(filters.sceneId)) return false;
  // A reusable requirement may occur in several episodes. Both axes must match
  // one exact occurrence, not a Cartesian product of unrelated episode/scene IDs.
  if (!isAllCatalogValue(filters.episodeUid) && !isAllCatalogValue(filters.sceneId)
    && !row.usagePairs?.some(pair=>pair.episodeUid===filters.episodeUid&&pair.sceneId===filters.sceneId)) return false;
  const needle = filters.search.trim().toLocaleLowerCase();
  return !needle || row.searchText.toLocaleLowerCase().includes(needle);
}
export function filterMaterialCatalogRows<T extends MaterialCatalogRow>(rows:T[],filters:MaterialCatalogFilters):T[] {
  return uniqueMaterialCatalogRows(rows.filter(row=>matchesMaterialCatalogRow(row,filters)));
}
export function countMaterialCatalogRequirements(rows: MaterialCatalogRow[], filters: MaterialCatalogFilters): number {
  return new Set(rows.filter(row=>row.required&&matchesMaterialCatalogRow(row,filters)).map(row=>row.id)).size;
}
export function materialCatalogFacetCounts<T extends {value:string;label:string}>(rows:MaterialCatalogRow[],filters:MaterialCatalogFilters,facet:MaterialCatalogFacet,options:readonly T[]):Array<T&{count:number}> {
  return options.map(option=>({...option,count:countMaterialCatalogRequirements(rows,{...filters,[facet]:option.value})}));
}
export function materialCatalogEntityGroups<T extends MaterialCatalogRow>(rows:T[]):Array<{entityId:string;rows:T[];requirementCount:number;trialCount:number}> {
  const groups=new Map<string,T[]>();
  for(const row of uniqueMaterialCatalogRows(rows))groups.set(row.entityId,[...(groups.get(row.entityId)||[]),row]);
  return [...groups].map(([entityId,items])=>({entityId,rows:items,requirementCount:new Set(items.filter(r=>r.required).map(r=>r.id)).size,trialCount:items.filter(r=>!r.required).length}));
}
export function materialCatalogStateGroups<T extends MaterialCatalogRow>(rows:T[]):Array<{stateId:string;rows:T[]}> {
  const groups=new Map<string,T[]>();
  for(const row of uniqueMaterialCatalogRows(rows))groups.set(row.stateId,[...(groups.get(row.stateId)||[]),row]);
  return [...groups].map(([stateId,items])=>({stateId,rows:items}));
}
export type MaterialCatalogPreparation = {
  stale?:boolean;
  materialLinksStale?:boolean;
  candidate?:{revisionId:string;contentHash:string;episodes:Array<{episodeUid:string;displayId:string;title:string;sceneIds:string[]}>;scenes:Array<{id:string;title:string;displayId:string;contentHash:string}>};
  materialLinks?:{projectionPolicy?:'PER_OCCURRENCE_V2';pending?:Array<{sceneId:string;requirementId:string|null;reason:string}>;scenes:Array<{sceneId:string;sceneContentHash:string;references:Array<{requirementId:string;requirementHash:string;reason:string;matchKind:string;uncoveredConditions?:string[]}>;unboundNeeds?:Array<string|{description:string}>}>}|null;
};
/** Candidate use links must match BOTH permanent scene revision and exact need hash.
 * Old requirement.sceneIds are intentionally not a fallback for a new candidate. */
export function materialCatalogUsage(requirement:{id:string;requirementHash:string},preparation:MaterialCatalogPreparation|null):{sceneIds:string[];episodeUids:string[]} {
  if(!preparation?.candidate||preparation.materialLinks?.projectionPolicy!=='PER_OCCURRENCE_V2'&&(preparation.stale||preparation.materialLinksStale))return {sceneIds:[],episodeUids:[]};
  const candidate=preparation.candidate;
  const sceneIds=[...new Set((preparation.materialLinks?.scenes||[]).filter(link=>candidate.scenes.some(scene=>scene.id===link.sceneId&&scene.contentHash===link.sceneContentHash)&&link.references.some(ref=>ref.requirementId===requirement.id&&ref.requirementHash===requirement.requirementHash)).map(link=>link.sceneId))];
  const episodeUids=[...new Set(candidate.episodes.filter(episode=>episode.sceneIds.some(id=>sceneIds.includes(id))).map(episode=>episode.episodeUid))];
  return {sceneIds,episodeUids};
}
