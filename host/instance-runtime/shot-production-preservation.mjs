import {canonicalJson,sha256} from './bytes.mjs';
import {productionHash} from './shot-production-model.mjs';
const fail=message=>{throw Object.assign(new Error(message),{code:'SCOPED_SOURCE_CONFLICT'});};
/** A legacy source compiler has no authority over current production objects. */
export function preserveShotProductionProjection({snapshot,baseSnapshot,documents}){
 const prior=baseSnapshot.productionModel||{},plans=prior.shotProductionPlans||[];if(!plans.length)return snapshot;
 const out=structuredClone(snapshot),model=out.productionModel,workIds=new Set();
 for(const plan of plans){
  const doc=documents.find(d=>d.revisionId===plan.sourceRevisionId&&d.sha256===plan.sourceSha256&&d.aliases.includes(plan.sourcePath));
  if(!doc||sha256(doc.bytes)!==doc.sha256||doc.metadata?.sourceRole!=='SHOT_PRODUCTION_PLAN')fail('镜头制作计划的固定源证据缺失');
  const body=JSON.parse(doc.bytes);if(body.productionPlanId!==plan.id||productionHash(body.content)!==plan.contentHash||productionHash(plan.content)!==plan.contentHash||body.contentHash!==plan.contentHash)fail('镜头制作计划源字节与发布记录不一致');
  if(!Array.isArray(plan.workItemIds)||new Set(plan.workItemIds).size!==plan.workItemIds.length)fail('镜头制作计划缺少唯一工作项闭包');
  for(const id of plan.workItemIds){if(!(prior.workItems||[]).some(w=>w.id===id))fail('镜头制作计划引用的工作项缺失');workIds.add(id);}
 }
 const works=(prior.workItems||[]).filter(w=>workIds.has(w.id)),familyIds=new Set(works.map(w=>w.outputAssetRef)),contextIds=new Set(works.map(w=>w.reviewContextRef));
 const merge=(key,rows)=>{for(const row of rows){const collision=(model[key]||[]).find(r=>r.id===row.id);if(collision&&canonicalJson(collision)!==canonicalJson(row))fail('源编译试图覆盖镜头制作对象：'+row.id);}model[key]=[...(model[key]||[]).filter(r=>!rows.some(x=>x.id===r.id)),...structuredClone(rows)];};
 merge('shotProductionPlans',plans);merge('workItems',works);merge('assetFamilies',(prior.assetFamilies||[]).filter(f=>familyIds.has(f.id)));merge('assetVersions',(prior.assetVersions||[]).filter(v=>familyIds.has(v.familyId)));merge('expectedOutputs',(prior.expectedOutputs||[]).filter(o=>familyIds.has(o.familyId)));merge('workPackages',(prior.workPackages||[]).filter(p=>p.workItemRefs?.some(id=>workIds.has(id))));merge('reviewContexts',(prior.reviewContexts||[]).filter(c=>contextIds.has(c.id)));
 for(const step of prior.workflowSteps||[])if(!(model.workflowSteps||[]).some(s=>s.id===step.id))model.workflowSteps=[...(model.workflowSteps||[]),structuredClone(step)];
 return out;
}

export function preserveShotRecipeProjection({snapshot,recipes,baseSnapshot,baseRecipes,documents}){
 const revisions=baseSnapshot.productionModel.shotProductionRecipeRevisions||[];if(!revisions.length)return {snapshot,recipes};
 const next=structuredClone(snapshot),catalog=structuredClone(recipes);
 for(const row of revisions){
  const doc=documents.find(d=>d.revisionId===row.sourceRevisionId&&d.sha256===row.sourceSha256&&d.aliases.includes(row.sourcePath));if(!doc||sha256(doc.bytes)!==doc.sha256||doc.metadata?.sourceRole!=='SHOT_EXECUTION_DEFINITION')fail('镜头调用包的固定源证据缺失');
  const definition=JSON.parse(doc.bytes),{definitionHash,...content}=definition,stored=(baseRecipes.executionDefinitions||[]).find(d=>d.id===row.id);
  if(definition.id!==row.id||definitionHash!==row.definitionHash||productionHash(content)!==definitionHash||!stored||stored.definitionHash!==definitionHash||stored.sourceSha256!==doc.sha256)fail('镜头调用包源字节与目录不一致');
  const {sourceRef,sourceRevisionId,sourceSha256,...storedContent}=stored;if(canonicalJson(storedContent)!==canonicalJson(definition))fail('镜头调用包目录内容与固定源不同');
  for(const [key,records] of [['executionDefinitions',[stored]],['promptRevisions',(baseRecipes.promptRevisions||[]).filter(p=>p.executionDefinitionId===row.id)]]){
   for(const record of records){const collision=(catalog[key]||[]).find(d=>d.id===record.id);if(collision&&canonicalJson(collision)!==canonicalJson(record))fail('源编译试图覆盖镜头调用包：'+record.id);}
   catalog[key]=[...(catalog[key]||[]).filter(d=>!records.some(r=>r.id===d.id)),...records];
  }
 }
 next.productionModel.shotProductionRecipeRevisions=structuredClone(revisions);return {snapshot:next,recipes:catalog};
}
