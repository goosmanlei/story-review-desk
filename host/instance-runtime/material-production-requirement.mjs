import {canonicalJson} from './bytes.mjs';
import {materialProductionPlanGraphClosure} from './material-production-preservation.mjs';

const fail=()=>{throw Object.assign(new Error('当前需求已偏离首次制作建档闭包，不能借返修迁移归属'),{code:'DOMAIN_CONFLICT'});};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

/** Recover only omitted host links from the original, hash-verified plan.
 * The published snapshot and immutable sources remain unchanged. Explicit
 * conflicting links are never repaired, and current domain input must still
 * equal the exact first-setup demand/representation closure. */
export async function resolveMaterialProductionRequirement(tx,{plan,requirement,family,work,demand,representation}){
 const links={materialWorkItemRef:work.id,plannedAssetFamilyId:family.id};
 for(const [key,value] of Object.entries(links))if(Object.hasOwn(requirement,key)&&requirement[key]!==value)fail();
 if(Object.keys(links).every(key=>Object.hasOwn(requirement,key)))return requirement;
 const {body}=materialProductionPlanGraphClosure({plan,document:await tx.readDocumentRevision(plan.sourceRevisionId)});
 if(requirement.id!==plan.requirementId||requirement.requirementHash!==plan.requirementHash
  ||!same(demand,body.graphBinding.requirement)||!same(representation,body.graphBinding.afterRepresentation)
  ||body.requirementAfter.materialWorkItemRef!==work.id||body.requirementAfter.plannedAssetFamilyId!==family.id
  ||body.materialWorkItem?.id!==work.id||body.materialWorkItem.requirementRef!==requirement.id
  ||body.materialWorkItem.outputAssetRef!==family.id||body.materialWorkItem.materialProductionPlanId!==plan.id
  ||body.assetFamily?.id!==family.id||body.assetFamily.ownerRef!==work.id||body.assetFamily.materialProductionPlanId!==plan.id)fail();
 return {...requirement,...links};
}
