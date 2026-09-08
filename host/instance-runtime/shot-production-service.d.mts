import type {InstanceReadUnit,InstanceUnit,RepositoryView} from './index.mjs';
import type {ProductionScopeShot,ShotProductionPlanContent,ShotProductionReadiness} from './shot-production-model.mjs';
export const SHOT_PRODUCTION_NS:{drafts:string;requests:string;jobs:string};
export type ShotProductionApiOptions = {api:unknown};
export type ShotProductionDraftInput = {sceneId:string;expectedReleaseId:string;expectedDraftRevisionId:string|null;content:unknown};
export type ShotProductionPreviewInput = {sceneId:string;draftRevisionId:string};
export type ShotProductionPublishInput = ShotProductionPreviewInput & {previewHash:string;requestId:string};
export type ShotProductionPreview = {
  schemaVersion:'1.0';sceneId:string;expectedReleaseId:string;draftRevisionId:string;contentHash:string;
  productionPlanId:string;shotPlanRevisionId:string;shotCount:number;workItemCount:number;outputCount:number;
  replacedProductionPlanId:string|null;previousWorkItemIds:string[];reusedWorkItemIds:string[];previewHash:string;checks:string[];
};
export type ShotProductionWorkspace = {
  sceneId:string;releaseId:string|null;
  basis:{sceneId:string;episodeUid:string;shotPlanRevisionId:string;shotPlanHash:string;shots:ProductionScopeShot[]}|null;
  blockers:string[];draft:(Record<string,unknown>&{revisionId:string})|null;draftHeadRevisionId:string|null;
  defaultContent:ShotProductionPlanContent|null;currentPlan:Record<string,unknown>|null;readiness:ShotProductionReadiness;
  availableInputs:Array<{requirementId:string;familyId:string;versionId:string;sha256:string;label:string;canFlowDownstream:boolean}>;
  availableSpace:{sourceSha256:string|null;version:string|null;locations:Array<{id:string;label:string;zones:Array<{id:string;label:string}>;cameras:Array<{id:string;label:string;zoneIds:string[]}>}>;states:Array<{id:string;label:string}>;localViews:Array<{id:string;viewId:string;label:string;locationId:string;zoneId:string;cameraId:string;sourceRevisionId:string;sourceSha256:string}>};
  manifestTargets:Array<{workItemId:string;shotId:string|null;gateId:string;label:string}>;
  manifestJobs:Array<{jobId:string;workItemId:string;status:string;error?:string}>;jobs:Array<Record<string,unknown>>;
};
export function readCurrentShotProductionModel(tx:InstanceReadUnit,options?:ShotProductionApiOptions):Promise<{view:RepositoryView;model:Record<string,unknown>;state:Record<string,unknown>}>;
export function getShotProductionWorkspace(tx:InstanceReadUnit,input:{sceneId:string;api:unknown}):Promise<ShotProductionWorkspace>;
export function saveShotProductionDraft(tx:InstanceUnit,input:ShotProductionDraftInput,options:ShotProductionApiOptions):Promise<{revisionId:string;contentHash:string;formalAdoptionPerformed:false}>;
export function previewShotProduction(tx:InstanceReadUnit,input:ShotProductionPreviewInput,options:ShotProductionApiOptions):Promise<ShotProductionPreview>;
export function enqueueShotProduction(tx:InstanceUnit,input:ShotProductionPublishInput,options:ShotProductionApiOptions):Promise<{jobId:string;status:'QUEUED'}>;
export function applyShotProductionJob(tx:InstanceUnit,input:{jobId:string;api:unknown}):Promise<{releaseId:string;productionPlanId:string;sourceRevisionId:string;workItemCount:number;actualMediaCreated:false}>;
