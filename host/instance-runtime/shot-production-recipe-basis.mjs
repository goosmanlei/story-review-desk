import {productionHash,productionBindingReasons,resolveDialogueVoiceBinding} from './shot-production-model.mjs';
import {selectAnimaticLockForShot} from './animatic-model.mjs';

/** Dialogue references belong to the line's speaker, never all audio in a shot. */
export function selectShotRecipeInputFamilies(model,work,settings){
 if(work.deliverableKey!=='DIALOGUE_DRY')return{familyIds:[...new Set(work.inputAssetRefs||[])],blockers:[]};
 const {binding,blockers}=resolveDialogueVoiceBinding(model,work.dialogue||{},settings.inputs||[]);
 return{familyIds:binding?[binding.familyId]:[],blockers};
}
export function shotRecipeProductionBasis(model,work,plan,inputs){
 const settings=plan.content.shots.find(s=>s.shotId===work.shotId),timing=selectAnimaticLockForShot(model.animaticLocks,{sceneId:plan.sceneId,shotPlanRevisionId:plan.content.shotPlanRevisionId,shotId:work.shotId})?.slice||null;
 const frameSet=(model.shotKeyframeSets||[]).find(s=>s.scopeRole==='CURRENT'&&s.shotId===work.shotId&&s.sceneId===plan.sceneId)||null;
 return{workItemId:work.id,outputBasisHash:work.outputBasisHash,shotPlanRevisionId:plan.content.shotPlanRevisionId,inputs:inputs.map(input=>Object.fromEntries(Object.entries(input).filter(([key])=>key!=='label'))),...(work.deliverableKey==='SHOT_VIDEO'?{timing,frameSetId:frameSet?.id||null,keyframeMembers:frameSet?.members||[],handles:settings.handles,videoBranch:settings.videoBranch}:['START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(work.deliverableKey)?{timing,keyframeStrategy:settings.keyframeStrategy}:{})};
}
/** Server gate: a still-adopted image SHA does not validate an older timing/strategy call package. */
export function shotRecipeDefinitionBindingReasons(model,state,definition){
 const work=(model.workItems||[]).find(w=>w.id===definition.workItemRef);if(!work?.shotProductionPlanId)return[];
 const plans=(model.shotProductionPlans||[]).filter(p=>p.scopeRole==='CURRENT'&&(p.workItemIds?p.workItemIds.includes(work.id):p.id===work.shotProductionPlanId));
 if(work.scopeRole!=='CURRENT'||work.activeInCurrentProduction!==true||plans.length!==1||work.executionDefinitionRef!==definition.id)return['SHOT_RECIPE_WORK_BINDING_CHANGED'];
 const plan=plans[0],settings=plan.content.shots.find(s=>s.shotId===work.shotId),family=(model.assetFamilies||[]).find(f=>f.id===work.outputAssetRef);if(!settings||!family)return['SHOT_RECIPE_WORK_BINDING_CHANGED'];
 const selected=selectShotRecipeInputFamilies(model,work,settings),inputs=[],reasons=[...selected.blockers];
 for(const familyId of selected.familyIds){const f=state.assetFamiliesById?.[familyId],v=state.assetVersionsById?.[f?.currentVersionId];if(family.kind==='IMAGE'&&f?.kind==='AUDIO')continue;
  const binding={familyId,versionId:v?.id,sha256:v?.sha256};if(productionBindingReasons(model,state,binding).length){reasons.push('SHOT_RECIPE_INPUT_BASIS_CHANGED');continue;}
  inputs.push({order:inputs.length+1,path:v.path,assetFamilyRef:familyId,assetVersionRef:v.id,sha256:v.sha256});
 }
 if(!definition.productionBasisHash||productionHash(definition.productionBasis||{})!==definition.productionBasisHash||productionHash(shotRecipeProductionBasis(model,work,plan,inputs))!==definition.productionBasisHash)reasons.push('SHOT_RECIPE_INPUT_BASIS_CHANGED');
 return[...new Set(reasons)];
}
