import type {InstanceReadUnit, InstanceUnit, InstanceRepository} from './index.mjs';
import type {SpatialShotViewAuthorContent, SpatialShotView, SpatialShotViewRow, SpatialCameraOrigin, SpatialCameraDirection, SpatialCameraHeight, SpatialDressingKind, SpatialDressingRelation, SpatialDressingOrientation} from './spatial-production.mjs';

export const SPATIAL_SHOT_VIEW_NS:{drafts:string;jobs:string;requests:string};
export const spatialShotViewOptions:{cameraOrigins:SpatialCameraOrigin[];cameraDirections:SpatialCameraDirection[];cameraHeights:SpatialCameraHeight[];dressingKinds:SpatialDressingKind[];relations:SpatialDressingRelation[];orientations:SpatialDressingOrientation[]};
export type SpatialShotViewLocation = {id:string;name:string;zones:Array<{id:string;name:string}>;cameras:Array<{id:string;name:string;zoneId?:string;zoneIds?:string[]}>};
export type SpatialShotViewDraft = {sceneId:string;viewId:string;baseReleaseId:string;basisHash:string;content:SpatialShotViewAuthorContent;revisionId:string};
export type SpatialShotViewDefaults = Omit<SpatialShotViewAuthorContent,'camera'> & {camera:Omit<SpatialShotViewAuthorContent['camera'],'origin'|'looks'> & {origin:SpatialCameraOrigin|'';looks:SpatialCameraDirection|''}};
export type SpatialShotViewPublication = {releaseId:string;viewId:string;spatialShotViewId:string;sourceRevisionId:string;contentHash:string;modelCalls:0;formalAdoptionPerformed:false};
export type SpatialShotViewWorkspace = {
  sceneId:string;viewId:string;releaseId:string;basis:Record<string,unknown>;basisHash:string;draftHeadRevisionId:string|null;
  draft:SpatialShotViewDraft|null;staleDraft:(SpatialShotViewDraft & {reason:string})|null;
  defaults:SpatialShotViewDefaults;currentView:SpatialShotViewRow|null;availableLocations:SpatialShotViewLocation[];options:typeof spatialShotViewOptions;
  blockers:string[];jobs:Array<{jobId:string;status:string;error?:string;result?:SpatialShotViewPublication}>;readOnly:false;
};
export type SpatialShotViewPreviewInput = {sceneId:string;viewId:string;draftRevisionId:string};
export type SpatialShotViewEnqueueInput = SpatialShotViewPreviewInput & {previewHash:string;requestId:string};
export type SpatialShotViewQueueResult = {jobId:string;status:'QUEUED';modelCalls:0;formalAdoptionPerformed:false};
export function spatialShotViewDefaultId(sceneId:string):string;
export function spatialShotViewLocations(model:unknown):SpatialShotViewLocation[];
export function getSpatialShotViewWorkspace(tx:InstanceReadUnit,input:{sceneId:string;viewId?:string}):Promise<SpatialShotViewWorkspace>;
export function saveSpatialShotViewDraft(tx:InstanceUnit,input:{sceneId:string;viewId:string;expectedReleaseId:string;expectedBasisHash:string;expectedDraftRevisionId:string|null;content:unknown}):Promise<{revisionId:string;modelCalls:0;formalAdoptionPerformed:false}>;
export function previewSpatialShotView(tx:InstanceReadUnit,input:SpatialShotViewPreviewInput):Promise<{view:SpatialShotView;previewHash:string;modelCalls:0;formalAdoptionPerformed:false}>;
export function enqueueSpatialShotView(tx:InstanceUnit,input:SpatialShotViewEnqueueInput):Promise<SpatialShotViewQueueResult>;
export function applySpatialShotViewJob(tx:InstanceUnit,input:{jobId:string}):Promise<SpatialShotViewPublication>;
export function runSpatialShotViewIteration(input:{repository:InstanceRepository}):Promise<{processed:false}|({processed:true;status:'SUCCEEDED'} & SpatialShotViewPublication)|{processed:true;jobId:string;status:string}>;
