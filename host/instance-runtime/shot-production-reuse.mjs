import {productionHash} from './shot-production-model.mjs';

/** Compare each output's semantic input closure; display IDs and plan revision are not inputs. */
export function reuseShotProductionObjects(model,previousPlan,compiled){
 const oldIds=new Set(previousPlan?(previousPlan.workItemIds||(model.workItems||[]).filter(w=>w.shotProductionPlanId===previousPlan.id).map(w=>w.id)):[]);
 const previous=(model.workItems||[]).filter(w=>oldIds.has(w.id)&&w.scopeRole==='CURRENT'&&w.activeInCurrentProduction!==false),reuse=new Map(),families=new Map();
 for(const item of compiled.workItems){
  if(!item.outputBasisHash)continue;
  const matches=previous.filter(w=>w.scopeType===item.scopeType&&w.scopeId===item.scopeId&&w.deliverableKey===item.deliverableKey&&w.outputSlot===item.outputSlot&&w.outputBasisHash===item.outputBasisHash);
  if(matches.length!==1)continue;const old=matches[0];
  const packages=(model.workPackages||[]).filter(p=>p.workItemRefs?.includes(old.id)&&p.scopeRole==='CURRENT');
  if(packages.length!==1||packages[0].workItemRefs.length!==1)continue;
  const family=(model.assetFamilies||[]).find(f=>f.id===old.outputAssetRef&&f.ownerRef===old.id),context=(model.reviewContexts||[]).find(c=>c.id===old.reviewContextRef);
  if(!family||!context)continue;
  reuse.set(item.id,{item:old,package:packages[0],family,context});families.set(item.outputAssetRef,old.outputAssetRef);
 }
 const mapped=compiled.workItems.map(w=>({...w,inputAssetRefs:w.inputAssetRefs.map(id=>families.get(id)||id)}));
 // Hash equality alone is insufficient if the resolved media identity changed.
 for(const item of mapped){const old=reuse.get(item.id)?.item;if(old&&productionHash(old.inputAssetRefs)!==productionHash(item.inputAssetRefs))throw Object.assign(new Error('复用项的实际输入身份与语义闭包不一致'),{code:'DOMAIN_CONFLICT'});}
 const reused=[...reuse.values()],newItems=mapped.filter(w=>!reuse.has(w.id)),newIds=new Set(newItems.map(w=>w.id));
 const additions={workItems:newItems,workPackages:compiled.workPackages.filter(p=>p.workItemRefs.every(id=>newIds.has(id))),assetFamilies:compiled.assetFamilies.filter(f=>newIds.has(f.ownerRef)).map(f=>({...f,usedByRefs:mapped.filter(w=>w.inputAssetRefs.includes(f.id)).map(w=>reuse.get(w.id)?.item.id||w.id)})),expectedOutputs:compiled.expectedOutputs.filter(o=>newItems.some(w=>w.outputAssetRef===o.familyId)),reviewContexts:compiled.reviewContexts.filter(c=>newItems.some(w=>w.reviewContextRef===c.id))};
 const retained={workItems:new Set(reused.map(r=>r.item.id)),workPackages:new Set(reused.map(r=>r.package.id)),assetFamilies:new Set(reused.map(r=>r.family.id)),reviewContexts:new Set(reused.map(r=>r.context.id)),expectedOutputs:new Set((model.expectedOutputs||[]).filter(o=>reused.some(r=>r.family.id===o.familyId)).map(o=>o.id))};
 const workItemIds=compiled.workItems.map(w=>reuse.get(w.id)?.item.id||w.id);
 return {additions,retained,workItemIds,reusedWorkItemIds:[...retained.workItems],retiredWorkItemIds:previous.filter(w=>!retained.workItems.has(w.id)).map(w=>w.id)};
}
