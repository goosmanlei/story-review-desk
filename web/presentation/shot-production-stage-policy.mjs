const list=value=>Array.isArray(value)?value:[];
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_INVALID'});};
export const PREVIS_FIRST_POLICY='PREVIS_FIRST_V1';
export function shotProductionPolicy(planOrContent){
 const content=planOrContent?.content||planOrContent;
 if(content?.schemaVersion==='1.0'&&content.stagePolicy===undefined)return 'LEGACY_V1';
 if(content?.schemaVersion==='2.0'&&content.stagePolicy===PREVIS_FIRST_POLICY)return PREVIS_FIRST_POLICY;
 return fail('镜头制作阶段合同版本无效');
}
export function shotProductionPurpose(deliverableKey){
 if(['STORYBOARD','ANIMATIC'].includes(deliverableKey))return 'PREVIS_ONLY';
 if(deliverableKey==='DIALOGUE_TEMP')return 'TEMPORARY';
 if(deliverableKey==='DIALOGUE_DRY')return 'FINAL';
 return 'FINAL_PRODUCTION';
}
export function shotProductionPolicyMarkers(deliverableKey){
 const productionPurpose=shotProductionPurpose(deliverableKey);
 return {productionSchemaVersion:'2.0',stagePolicy:PREVIS_FIRST_POLICY,productionPurpose,allowedUse:['PREVIS_ONLY','TEMPORARY'].includes(productionPurpose)?'PREVIS_TIMING':'PRODUCTION'};
}
export function shotProductionConsumerRole(work,plan){
 let v2=false;try{v2=plan?shotProductionPolicy(plan)===PREVIS_FIRST_POLICY:work?.productionSchemaVersion==='2.0'&&work.stagePolicy===PREVIS_FIRST_POLICY;}catch{return 'FINAL_PRODUCTION';}
 if(!v2)return 'FINAL_PRODUCTION';
 if(['STORYBOARD','DIALOGUE_TEMP','ANIMATIC'].includes(work?.deliverableKey))return 'PREVIS_TIMING';
 if(['SHOT_INPUT_LOCK','START_FRAME','END_FRAME','INTERMEDIATE_FRAME'].includes(work?.deliverableKey))return 'VISUAL_PRODUCTION';
 if(work?.deliverableKey==='DIALOGUE_DRY')return 'FINAL_DIALOGUE';
 if(work?.deliverableKey==='SHOT_VIDEO')return 'SHOT_VIDEO';
 if(work?.deliverableKey==='LOCKED_SHOT')return 'LOCKED_SHOT';
 return 'FINAL_PRODUCTION';
}
export function shotProductionConsumptionReasons({producerPurpose,allowedUse,consumerRole}={}){
 return (allowedUse==='PREVIS_TIMING'||['PREVIS_ONLY','TEMPORARY'].includes(producerPurpose))&&consumerRole!=='PREVIS_TIMING'?['PREVIS_INPUT_NOT_ALLOWED_FOR_PRODUCTION']:[];
}
function producerRows(model,binding){
 const familyId=binding?.familyId||binding?.assetFamilyRef;
 const families=list(model?.assetFamilies).filter(f=>f.id===familyId),family=families[0];
 const works=list(model?.workItems).filter(w=>w.id===family?.ownerRef),work=works[0];
 const marked=[family,work].some(r=>r?.stagePolicy!==undefined||r?.productionSchemaVersion!==undefined||r?.allowedUse!==undefined);
 return {familyId,family,work,marked,unique:families.length===1&&works.length===1&&work.outputAssetRef===familyId};
}
const sameMarkers=(row,expected)=>row&&Object.entries(expected).every(([key,value])=>row[key]===value);
/** Full source model: derive usage from the immutable originating plan, not caller labels. */
export function resolveShotProductionProducer(model,binding){
 const c=producerRows(model,binding),bad=()=>({producerPurpose:null,allowedUse:null,workItemId:c.work?.id||null,blockers:['SHOT_PRODUCTION_USAGE_BINDING_CHANGED']});
 if(!c.work?.shotProductionPlanId&&!c.marked)return {producerPurpose:null,allowedUse:null,workItemId:c.work?.id||null,blockers:[]};
 if(!c.unique)return bad();
 const plans=list(model?.shotProductionPlans).filter(p=>p.id===c.work.shotProductionPlanId);
 if(plans.length!==1){const legacyOwners=list(model?.shotProductionPlans).filter(p=>list(p.workItemIds).includes(c.work.id));if(!c.marked&&legacyOwners.length===1&&legacyOwners[0].content?.schemaVersion==='1.0'&&legacyOwners[0].content.stagePolicy===undefined)return {producerPurpose:null,allowedUse:null,workItemId:c.work.id,blockers:[]};return bad();}
 let policy;try{policy=shotProductionPolicy(plans[0]);}catch{return bad();}
 if(policy==='LEGACY_V1')return c.marked?bad():{producerPurpose:null,allowedUse:null,workItemId:c.work.id,blockers:[]};
 const expected=shotProductionPolicyMarkers(c.work.deliverableKey),outputs=list(model?.expectedOutputs).filter(o=>o.familyId===c.familyId);
 if(!list(plans[0].workItemIds).includes(c.work.id)||!sameMarkers(c.work,expected)||!sameMarkers(c.family,expected)||!outputs.length||outputs.some(o=>!sameMarkers(o,expected)))return bad();
 return {...expected,producerPurpose:expected.productionPurpose,workItemId:c.work.id,blockers:[]};
}
export function shotProductionInputConsumptionReasons(model,consumerWork,binding){
 const producer=resolveShotProductionProducer(model,binding);
 const plans=list(model?.shotProductionPlans).filter(p=>p.id===consumerWork?.shotProductionPlanId);
 const consumerRole=plans.length===1?shotProductionConsumerRole(consumerWork,plans[0]):'FINAL_PRODUCTION';
 return [...producer.blockers,...shotProductionConsumptionReasons({...producer,consumerRole})];
}
/** Trusted operational projection only; full source proof is checked at authorization/import. */
export function shotProductionProjectedConsumptionReasons(state,consumerWork,binding){
 const model={assetFamilies:Object.values(state?.assetFamiliesById||{}),workItems:Object.values(state?.workItemsById||{})};
 const c=producerRows(model,binding);if(!c.marked)return [];
 const expected=shotProductionPolicyMarkers(c.work?.deliverableKey);
 if(!c.unique||!sameMarkers(c.family,expected)||!sameMarkers(c.work,expected))return ['SHOT_PRODUCTION_USAGE_BINDING_CHANGED'];
 return shotProductionConsumptionReasons({...expected,producerPurpose:expected.productionPurpose,consumerRole:shotProductionConsumerRole(consumerWork)});
}
