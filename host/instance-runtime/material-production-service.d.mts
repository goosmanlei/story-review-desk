import type {InstanceReadUnit, InstanceUnit, InstanceRepository} from './index.mjs';
import type {projectOperationalState} from '../../app/api/v8/_store';

export const MATERIAL_PRODUCTION_NS:{drafts:string;jobs:string;requests:string};
export type MaterialProductionApi = {projectOperationalState:typeof projectOperationalState;safeReviewPendingPath?:(path:string,familyId?:string)=>Promise<string>;safeGeneratedPath?:(path:string,binding:{versionId?:string;sha256?:string})=>Promise<string>};
export type MaterialProductionInputBinding = {familyId:string;versionId:string;sha256:string};
export type MaterialProductionContent = {model:string;prompt:string;negativePrompt:string;parameters:Record<string,unknown>;inputBindings:MaterialProductionInputBinding[]};
export type MaterialProductionDraft = {requirementId:string;baseReleaseId:string;basisHash:string;content:MaterialProductionContent;revisionId:string};
export type MaterialProductionRegistration = Record<string,unknown> & {id:string;requirementId:string;representationId:string;familyId:string;workItemId:string;expectedOutputId:string;definitionId:string;requirementHash:string;basisHash:string;sourcePath:string;sourceRevisionId:string;sourceSha256:string};
export type MaterialProductionPlan = Record<string,unknown> & {id:string;schemaVersion:'MATERIAL_PRODUCTION_PLAN_V1'|'MATERIAL_PRODUCTION_RECIPE_V1'|'LEGACY_AUDIO_RECIPE_REVISION_V1';requirementId:string;draftRevisionId:string;baseReleaseId:string;basisHash:string;expectedOutput:Record<string,unknown> & {id:string;familyId:string};executionDefinition:Record<string,unknown> & {id:string;definitionHash:string}};
export type MaterialProductionPublication = {releaseId:string;planId:string;familyId:string;workItemId:string;expectedOutputId:string;definitionId:string;sourceRevisionId:string;requirementHash:string;modelCalls:0;actualMediaCreated:false;formalAdoptionPerformed:false;mode?:'REVISION'|'LEGACY_AUDIO_REVISION';recipeRevisionId?:string;parentVersionId?:string;plannedVersionLabel?:string};
export type MaterialProductionWorkspace = {
  requirementId:string;mode:'FIRST_SETUP'|'REVISION'|'LEGACY_AUDIO_REVISION';parentVersionId:string|null;parentVersionSha256:string|null;plannedVersionLabel:string;currentDefinitionId:string|null;
  releaseId:string;requirement:Record<string,unknown> & {id:string};representation:Record<string,unknown> & {id:string};basis:Record<string,unknown>;basisHash:string;
  draftHeadRevisionId:string|null;draft:MaterialProductionDraft|null;staleDraft:(MaterialProductionDraft & {reason:string})|null;defaults:MaterialProductionContent;
  availableInputs:Array<MaterialProductionInputBinding & {label:string;kind:string}>;blockers:string[];currentRegistration:MaterialProductionRegistration|null;
  jobs:Array<{jobId:string;status:string;error?:string;result?:MaterialProductionPublication}>;readOnly:false;
};
export type MaterialProductionPreviewInput = {requirementId:string;draftRevisionId:string};
export function validateMaterialProductionContent(value:unknown):MaterialProductionContent;
export function getMaterialProductionWorkspace(tx:InstanceReadUnit,input:{requirementId:string;api:MaterialProductionApi}):Promise<MaterialProductionWorkspace>;
export function saveMaterialProductionDraft(tx:InstanceUnit,input:{requirementId:string;expectedReleaseId:string;expectedBasisHash?:unknown;expectedDraftRevisionId:string|null;content:unknown},options:{api:MaterialProductionApi}):Promise<{revisionId:string;formalAdoptionPerformed:false;modelCalls:0}>;
export function previewMaterialProduction(tx:InstanceReadUnit,input:MaterialProductionPreviewInput,options:{api:MaterialProductionApi}):Promise<{plan:MaterialProductionPlan;previewHash:string;modelCalls:0;formalAdoptionPerformed:false}>;
export function enqueueMaterialProduction(tx:InstanceUnit,input:MaterialProductionPreviewInput & {previewHash:string;requestId:string},options:{api:MaterialProductionApi}):Promise<{jobId:string;status:'QUEUED';modelCalls:0}>;
export function applyMaterialProductionJob(tx:InstanceUnit,input:{jobId:string;api:MaterialProductionApi}):Promise<MaterialProductionPublication>;
export function runMaterialProductionIteration(input:{repository:InstanceRepository;api:MaterialProductionApi}):Promise<{processed:false}|({processed:true;status:'SUCCEEDED'} & MaterialProductionPublication)|{processed:true;jobId:string;status:'FAILED'}>;
