import {canonicalJson} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {materialProductionPlanGraphClosure} from './material-production-preservation.mjs';
import {findCompatibleRequirementBinding} from './domain-production-compatibility.mjs';

const fail=()=>{throw Object.assign(new Error('当前需求已偏离首次制作建档闭包，不能借返修迁移归属'),{code:'DOMAIN_CONFLICT'});};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

/** Validate a frozen native hash against the complete current definition.
 * A bridge never replaces either hash and never authorizes a new scene use. */
export function currentMaterialRequirementBridge(model,{requirement,demand,representation,beforeHash,instanceId,runtimeEpoch}){
 if(requirement.requirementHash!==domainHash({demand,representation}))fail();
 if(beforeHash===requirement.requirementHash)return null;
 const bridge=findCompatibleRequirementBinding(model,{requirementId:requirement.id,beforeHash,afterHash:requirement.requirementHash,representationId:representation.id,representationHash:domainHash(representation),instanceId,runtimeEpoch});
 if(!bridge||bridge.eligibility!=='CURRENT'||!same(bridge.afterDemand,demand))fail();
 return bridge;
}

/** Recover only omitted host links from the original, hash-verified plan.
 * The published snapshot and immutable sources remain unchanged. Explicit
 * conflicting links are never repaired, and current domain input must still
 * equal the frozen baseline or have a separately verified current bridge. */
export async function resolveMaterialProductionRequirement(tx,{model,plan,requirement,family,work,demand,representation,requirementBaseline}){
 const links={materialWorkItemRef:work.id,plannedAssetFamilyId:family.id};
 for(const [key,value] of Object.entries(links))if(Object.hasOwn(requirement,key)&&requirement[key]!==value)fail();
 if(requirementBaseline){
  const before=requirementBaseline.authority;
  if(requirement.id!==plan.requirementId||requirement.requirementHash!==domainHash({demand,representation})||!same(representation,before.representation)||requirementBaseline.requirementAfter.materialWorkItemRef!==work.id||requirementBaseline.requirementAfter.plannedAssetFamilyId!==family.id)fail();
  if(requirement.requirementHash!==requirementBaseline.requirementHash||!same(demand,before.demand)){
   if(!model||!tx.getMetadata)fail();
   const meta=await tx.getMetadata(),bridge=currentMaterialRequirementBridge(model,{requirement,demand,representation,beforeHash:requirementBaseline.requirementHash,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch});
   if(!bridge||!same(bridge.beforeDemand,before.demand))fail();
  }
  return {...requirement,...links};
 }
 const {body}=materialProductionPlanGraphClosure({plan,document:await tx.readDocumentRevision(plan.sourceRevisionId)});
 const exact=requirement.requirementHash===plan.requirementHash&&same(demand,body.graphBinding.requirement);
 if(!exact){
  if(!model||!tx.getMetadata)fail();
  const meta=await tx.getMetadata();
  const bridge=currentMaterialRequirementBridge(model,{requirement,demand,representation,beforeHash:plan.requirementHash,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch});
  if(!bridge||!same(bridge.beforeDemand,body.graphBinding.requirement))fail();
 }
 if(requirement.id!==plan.requirementId||requirement.requirementHash!==domainHash({demand,representation})
  ||!same(representation,body.graphBinding.afterRepresentation)
  ||body.requirementAfter.materialWorkItemRef!==work.id||body.requirementAfter.plannedAssetFamilyId!==family.id
  ||body.materialWorkItem?.id!==work.id||body.materialWorkItem.requirementRef!==requirement.id
  ||body.materialWorkItem.outputAssetRef!==family.id||body.materialWorkItem.materialProductionPlanId!==plan.id
  ||body.assetFamily?.id!==family.id||body.assetFamily.ownerRef!==work.id||body.assetFamily.materialProductionPlanId!==plan.id)fail();
 return Object.keys(links).every(key=>Object.hasOwn(requirement,key))?requirement:{...requirement,...links};
}
