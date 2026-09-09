import {domainHash} from './domain-model.mjs';
/** Current execution gate only. Historical event/source validation deliberately
 * keeps its own frozen release context and never calls this current predicate. */
export function materialProductionCurrentBasisReasons(model,work,definition){
 const plans=(model.materialProductionPlans||[]).filter(p=>p.workItemId===work.id);
 if(!plans.length&&!work.materialProductionPlanId&&!definition?.materialProductionPlanId)return [];
 const reason=['MATERIAL_REQUIREMENT_BASIS_CHANGED'];
 if(plans.length!==1)return reason;
 const plan=plans[0],requirements=(model.materialRequirements||[]).filter(r=>r.id===plan.requirementId),families=(model.assetFamilies||[]).filter(f=>f.id===plan.familyId),contexts=(model.reviewContexts||[]).filter(c=>c.id===work.reviewContextRef);
 const graph=model.domainGraph,demands=(graph?.requirements||[]).filter(d=>d.id===plan.requirementId),representations=(graph?.representations||[]).filter(r=>r.id===plan.representationId);
 if(requirements.length!==1||families.length!==1||contexts.length!==1||demands.length!==1||representations.length!==1)return reason;
 const requirement=requirements[0],family=families[0],context=contexts[0],hash=domainHash({demand:demands[0],representation:representations[0]});
 if(!model.domainGraphRef||domainHash(graph)!==model.domainGraphRef.sha256||requirement.requirementHash!==hash||work.requirementHash!==hash||definition?.materialRequirementHash!==hash||definition.materialRequirementRef!==plan.requirementId||definition.materialProductionPlanId!==plan.id||work.materialProductionPlanId!==plan.id||work.requirementRef!==plan.requirementId||work.outputAssetRef!==plan.familyId||family.ownerRef!==work.id||family.reviewOwner!=='MATERIAL'||definition.id!==work.executionDefinitionRef||definition.workItemRef!==work.id||definition.output?.assetFamilyRef!==family.id||definition.output?.expectedOutputRef!==family.currentExpectedOutputId||context.requirementHash!==hash||context.binding?.requirementHash!==hash||context.binding?.domainContextHash!==family.domainContext?.hash)return reason;
 return [];
}
