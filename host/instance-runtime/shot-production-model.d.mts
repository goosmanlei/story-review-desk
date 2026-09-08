export const SHOT_PRODUCTION_VERSION: '1.0';
export type ProductionMediaBinding = {familyId:string;versionId:string;sha256:string};
export type ProductionInputBinding = ProductionMediaBinding & {requirementId:string;purpose:string};
export type DialogueVoiceBinding = ProductionMediaBinding & {
  schemaVersion:'DIALOGUE_VOICE_BINDING_V1';speakerEntityId:string;speakerEntityHash:string;
  requirementId:string;requirementHash:string;representationId:string;representationHash:string;purpose:string;
};
export type ProductionDialogueLine = {id:string;text:string;speakerEntityId:string|null;purpose:'TEMPORARY'|'FINAL';performance:string;voiceBinding?:DialogueVoiceBinding};
export type ProductionKeyframeStrategy = {mode:'UNDECIDED'|'START_ONLY'|'START_END'|'MULTI_KEYFRAME';reason:string;intermediateFrameCount:number};
export type ProductionShotSettings = {
  shotId:string;keyframeStrategy:ProductionKeyframeStrategy;dialogueLines:ProductionDialogueLine[];inputs:ProductionInputBinding[];
  space:{loc:string;state:string;zone:string;camera:string;freeze:string};handles:{headFrames:number;tailFrames:number};
  videoBranch:'UNKNOWN'|'SILENT'|'AUDIO_DRIVEN'|'POST_LIP';
};
export type ShotProductionPlanContent = {schemaVersion:'1.0';sceneId:string;shotPlanRevisionId:string;shotPlanHash:string;shots:ProductionShotSettings[]};
export type ProductionScopeShot = Record<string,unknown> & {id:string;shotId:string;sceneId:string;order:number};
export type ShotProductionScope = {
  sceneId:string;episodeUid:string;
  plan:Record<string,unknown>&{id:string;contentHash:string;content:Record<string,unknown>};
  shots:ProductionScopeShot[];
  episodeRelease:Record<string,unknown>&{id:string;episodeUid:string};
  scopeLock:Record<string,unknown>&{id:string};materialModel:unknown;
};
export type CompiledShotProductionPlan = {
  workItems:Array<Record<string,unknown>>;workPackages:Array<Record<string,unknown>>;
  assetFamilies:Array<Record<string,unknown>>;expectedOutputs:Array<Record<string,unknown>>;
  reviewContexts:Array<Record<string,unknown>>;inputLockWorkItemId:string;animaticWorkItemId:string;
};
export type ShotProductionShotReadiness = {
  shotId:string;ready:boolean;blockers:string[];title?:string;timing?:Record<string,unknown>|null;
  requiredFrameCount?:number;workItemIds?:string[];videoWorkItemId?:string|null;
};
export type ShotProductionReadiness = {
  sceneId:string;episodeUid?:string;productionPlanId?:string;denominatorState:'UNKNOWN'|'KNOWN';
  shotCount:number|null;readyCount:number;ready:boolean;blockers:string[];shots:ShotProductionShotReadiness[];
};
export function productionHash(value:unknown):string;
export function productionId(value:unknown,label?:string):string;
export function exactProductionMedia(value:unknown):ProductionMediaBinding;
export function resolveShotProductionScope(model:unknown,sceneId:string):ShotProductionScope;
export function resolveDialogueVoiceBinding(model:unknown,line?:unknown,inputs?:unknown[]):{binding:DialogueVoiceBinding|null;blockers:string[]};
export function defaultShotProductionPlan(scope:ShotProductionScope):ShotProductionPlanContent;
export function validateShotProductionPlan(content:unknown,scope:ShotProductionScope):ShotProductionPlanContent;
export function productionOutputIdentity(planId:string,scopeId:string,deliverableKey:string,slot?:string):{workItemId:string;familyId:string;expectedOutputId:string;slot:string};
export function compileShotProductionPlan(scope:ShotProductionScope,content:unknown,identity:{id:string;revisionId:string;sourceRef:string}):CompiledShotProductionPlan;
export function productionBindingReasons(model:unknown,state:unknown,binding:unknown,options?:{requireAdopted?:boolean}):string[];
export function shotProductionReadiness(model:unknown,state:unknown,sceneId:string):ShotProductionReadiness;
export function shotProductionEntryGates(model:unknown,state:unknown):Record<string,string[]>;
