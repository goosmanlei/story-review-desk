import type {ProductionModel,OperationalStateProjection} from '../../app/production-workbench';
export type ProductionMaterialKind = 'INPUT_LOCK'|'STORYBOARD'|'TEMP_DIALOGUE'|'DIALOGUE'|'ANIMATIC'|'START_FRAME'|'END_FRAME'|'MIDDLE_FRAME'|'KEYFRAME_SET'|'SHOT_VIDEO'|'LOCKED_SHOT'|'OTHER';
export type ProductionMaterialRow = {
 id:string;familyId:string;title:string;workItemId:string;workPackageId:string;producerOwnerRef:string|null;
 scopeOwner:{type:'SHOT'|'SCENE'|'EPISODE'|'PROJECT';id:string;revisionId:string|null};
 kind:ProductionMaterialKind;kindLabel:string;mediaType:string;deliverableKey:string|null;usageRole:string|null;gateId:string|null;phaseId:string|null;
 episodeUids:string[];sceneIds:string[];shotIds:string[];currentVersionId:string|null;currentExpectedOutputId:string|null;
 versionIds:string[];expectedOutputIds:string[];presentVersionIds:string[];lifecycleState:string;canFlowDownstream:boolean;flowBlockReasons:string[];
 inputFamilyIds:string[];inputVersionBindings:Array<Record<string,unknown>>;declaredConsumerWorkItemIds:string[];
 actualConsumers:Array<{familyId:string;versionId:string;inputVersionId:string;sha256:string}>;
 materialRequirementIds:string[];sourceRef:string|null;outputState:'PRESENT'|'CANDIDATES'|'NOT_PRODUCED';
};
export type ProductionMaterialFilters = {search?:string;familyId?:string;workItemId?:string;kind?:string;mediaType?:string;lifecycleState?:string;gateId?:string;episodeUid?:string;sceneId?:string;shotId?:string};
export type ProductionMaterialProjection = {schemaVersion:string;rows:ProductionMaterialRow[];issues:Array<{familyId:string;code:string}>};
export const productionMaterialKinds:ReadonlyArray<{id:ProductionMaterialKind;label:string;mediaType:string}>;
export function overlayProductionMaterialModel(model:ProductionModel,projection?:Partial<OperationalStateProjection>):ProductionModel;
export function projectProductionMaterials(model:ProductionModel,projection?:Partial<OperationalStateProjection>):ProductionMaterialProjection;
export function filterProductionMaterials(rows:ProductionMaterialRow[],filters?:ProductionMaterialFilters):ProductionMaterialRow[];
export function productionMaterialLocation(row:Pick<ProductionMaterialRow,'familyId'>,versionId?:string|null):string;
