import type {InstanceReadUnit, RepositoryDocument, RepositoryView} from './index.mjs';

export type SpatialCameraOrigin = 'NORTH_INTERIOR'|'NORTHEAST_INTERIOR'|'EAST_INTERIOR'|'SOUTHEAST_INTERIOR'|'SOUTH_INTERIOR'|'SOUTHWEST_INTERIOR'|'WEST_INTERIOR'|'NORTHWEST_INTERIOR'|'CENTER_INTERIOR';
export type SpatialCameraDirection = 'NORTH'|'NORTHEAST'|'EAST'|'SOUTHEAST'|'SOUTH'|'SOUTHWEST'|'WEST'|'NORTHWEST';
export type SpatialCameraHeight = 'EYE_LEVEL'|'LOW'|'HIGH';
export type SpatialDressingKind = 'BED'|'BOWL_RACK'|'TABLE'|'CHAIR'|'SHELF'|'BENCH'|'CONTAINER';
export type SpatialDressingRelation = 'NORTH_OF'|'SOUTH_OF'|'EAST_OF'|'WEST_OF'|'AT';
export type SpatialDressingOrientation = 'EAST_WEST'|'NORTH_SOUTH'|'NONE';
export type SpatialShotViewAuthorContent = {
  viewId:string; sceneId:string; locationId:string; zoneId:string;
  camera:{origin:SpatialCameraOrigin;looks:SpatialCameraDirection;height:SpatialCameraHeight;purpose:string};
  dressing:Array<{id:string;kind:SpatialDressingKind;anchor:{kind:'CAMERA'|'ZONE';id:string};relation:SpatialDressingRelation;orientation:SpatialDressingOrientation;appearance:string}>;
  note:string;
};
export type SpatialSourceBinding = {sourceRef:string;sourceRevisionId:string;sourceSha256:string};
export type SpatialSceneBinding = {episodeUid:string;episodeNarrativeReleaseId:string;sceneId:string;sceneScriptRevisionId:string;sceneContentHash:string};
export type SpatialShotView = {
  id:string;schemaVersion:'SPATIAL_SHOT_VIEW_V1';viewId:string;
  sceneBinding:SpatialSceneBinding;
  base:SpatialSourceBinding & {locationId:string;zoneId:string;sliceHash:string};
  camera:SpatialShotViewAuthorContent['camera'] & {id:string};
  dressing:SpatialShotViewAuthorContent['dressing'];note:string;preserveBaseGeometry:true;
};
export type SpatialShotViewRow = SpatialSourceBinding & {id:string;viewId:string;scopeRole:'CURRENT'|'EVIDENCE_ONLY';contentHash:string;content:SpatialShotView};
export type ProductionSpatialEvidence = SpatialSourceBinding & {
  projectionSchemaVersion:'PRODUCTION_SPATIAL_V1';sourceDocumentId:string|null;version:string;orientation:unknown;
  locations:Array<Record<string,unknown> & {id:string}>;
  locationPackages:Array<{id:string;name?:string;factBoundary:unknown;lockBoundary:unknown;zones:Array<Record<string,unknown> & {id:string}>;cameras:Array<Record<string,unknown> & {id:string;zoneId?:string;zoneIds?:string[]}>;fixedGeometry:Record<string,unknown>;sourcePointer:string}>;
};
export type SpatialProjection = {
  spatialEvidence?:ProductionSpatialEvidence;
  spatialShotViewProofs:Record<string,{sourceRevisionId:string;sourceSha256:string;contentHash:string}>;
};
export const SPATIAL_SHOT_VIEW_SCHEMA:'SPATIAL_SHOT_VIEW_V1';
export const spatialCameraOrigins:SpatialCameraOrigin[];
export const spatialCameraDirections:SpatialCameraDirection[];
export const spatialDressingKinds:SpatialDressingKind[];
export function projectProductionSpatialSource<T extends object = object>(spec:unknown,binding:SpatialSourceBinding & {documentId?:string},previous?:T):T & ProductionSpatialEvidence;
export function validateSpatialShotViewAuthorContent(content:unknown):SpatialShotViewAuthorContent;
export function prepareSpatialShotView(model:unknown,content:SpatialShotViewAuthorContent):SpatialShotView;
export function assertSpatialShotView(body:unknown):SpatialShotView;
export function spatialShotViewProjection(body:unknown,sourceBinding:SpatialSourceBinding):SpatialShotViewRow;
export function spatialShotViewReasons(model:unknown,settings:unknown):string[];
export function applyProductionSpatialProjection<T extends object>(tx:InstanceReadUnit,model:T,options?:{view?:RepositoryView}):Promise<T & SpatialProjection>;
export function preserveProductionSpatialProjection<T extends object>(input:{snapshot:T;baseSnapshot:unknown;documents:RepositoryDocument[];readDocumentRevision?:(id:string)=>Promise<RepositoryDocument|null|undefined>}):Promise<T>;
