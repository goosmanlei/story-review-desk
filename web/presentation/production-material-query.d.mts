import type {ProductionModel,OperationalStateProjection} from '../app/production-workbench';
import type {PagedProductionPayload} from '../app/paged-production-data';
import type {ProductionMaterialRow,ProductionMaterialFilters,ProductionMaterialProjection,ProductionMaterialKind} from './production-materials.mjs';
export type ProductionMaterialQuery={filters:ProductionMaterialFilters;limit:number;filterHash:string;version:string;after:string|null;versionId:string|null;summary:boolean};
export type ProductionMaterialPage={schemaVersion:string;entries:ProductionMaterialRow[];total:number;count:number;hasMore:boolean;nextCursor:string|null;appliedFilters:ProductionMaterialFilters;detailState:'SUMMARY'|'COMPLETE';issues:ProductionMaterialProjection['issues'];facets:{kinds:Array<{id:ProductionMaterialKind;label:string;mediaType:string;count:number}>;lifecycleStates:string[];episodeUids:string[];sceneIds:string[]};page:PagedProductionPayload['page']};
export function parseProductionMaterialQuery(url:URL,basis:unknown):ProductionMaterialQuery;
export function queryProductionMaterialPage(model:unknown,projection:unknown,query:ProductionMaterialQuery):ProductionMaterialPage;
