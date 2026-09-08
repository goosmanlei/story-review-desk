import {canonicalJson,sha256} from './bytes.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';
import {compileShotProductionPlan,productionHash} from './shot-production-model.mjs';
const fail=message=>{throw Object.assign(new Error(message),{code:'SCOPED_SOURCE_CONFLICT'});};
const one=(rows,predicate,label)=>{const found=(rows||[]).filter(predicate);if(found.length!==1)fail(label+'必须精确且唯一');return found[0];};
const outputKey=work=>canonicalJson([work.scopeType,work.scopeId,work.deliverableKey,work.outputSlot]);
function assertPlanClosure(prior,plan){
 const design=one(prior.shotPlanSetRevisions,d=>d.id===plan.content.shotPlanRevisionId,'制作计划的历史镜头设计');
 if(design.scopeId!==plan.sceneId||design.episodeUid!==plan.episodeUid||design.contentHash!==plan.content.shotPlanHash||productionHash(design.content)!==design.contentHash)fail('制作计划与其固定镜头设计不一致');
 const scope={sceneId:plan.sceneId,episodeUid:plan.episodeUid,plan:design,shots:design.content.shots.map(spec=>({...spec,id:spec.shotId}))};
 let expected;try{expected=compileShotProductionPlan(scope,plan.content,{id:plan.id,revisionId:plan.sourceRevisionId,sourceRef:plan.sourcePath}).workItems;}catch{fail('制作计划的固定内容不能重建工作输出');}
 const works=plan.workItemIds.map(id=>one(prior.workItems,w=>w.id===id,'制作工作项'));
 if(works.length!==expected.length||new Set(works.map(outputKey)).size!==works.length)fail('制作计划的逻辑工作输出闭包不完整');
 const familyMap=new Map();
 for(const work of works){
  const target=one(expected,w=>outputKey(w)===outputKey(work),'制作计划输出槽');
  if(work.sceneId!==plan.sceneId||work.shotPlanSetRevisionId!==design.id||work.shotPlanSetRevisionHash!==design.contentHash||work.outputBasisHash!==target.outputBasisHash)fail('制作工作项与固定局部输入不一致');
  familyMap.set(target.outputAssetRef,work.outputAssetRef);
 }
 for(const work of works){
  const target=expected.find(w=>outputKey(w)===outputKey(work));
  if(productionHash(work.inputAssetRefs)!==productionHash(target.inputAssetRefs.map(id=>familyMap.get(id)||id)))fail('制作工作项的实际输入族闭包不一致');
 }
 return works;
}
function assertWorkClosure(prior,work){
 const owner=one(prior.shotProductionPlans,p=>p.id===work.shotProductionPlanId,'制作工作项的原始计划');
 if(work.shotProductionRevisionId!==owner.sourceRevisionId||work.sourceRef!==owner.sourcePath||!owner.workItemIds.includes(work.id))fail('制作工作项原始固定源缺失');
 const family=one(prior.assetFamilies,f=>f.id===work.outputAssetRef&&f.ownerRef===work.id,'制作输出素材族');
 const pkg=one(prior.workPackages,p=>p.workItemRefs?.includes(work.id),'制作工作包');
 if(pkg.workItemRefs.length!==1||pkg.scopeType!==work.scopeType||pkg.scopeId!==work.scopeId||pkg.sceneId!==work.sceneId||pkg.gateId!==work.gateId||pkg.phaseId!==work.phaseId||pkg.reviewContextRef!==work.reviewContextRef||pkg.shotProductionPlanId!==owner.id||pkg.shotProductionRevisionId!==owner.sourceRevisionId)fail('制作工作包不属于精确工作项');
 const context=one(prior.reviewContexts,c=>c.id===work.reviewContextRef,'制作审阅上下文');
 const contextHash=context.contextHash,contextContent=Object.fromEntries(Object.entries(context).filter(([key])=>!['contextHash','scopeRole','activeInCurrentProduction'].includes(key)));
 if(context.scopeType!==work.scopeType||context.scopeId!==work.scopeId||context.shotProductionPlanId!==owner.id||context.shotProductionRevisionId!==owner.sourceRevisionId||context.binding?.shotPlanRevisionId!==work.shotPlanSetRevisionId||contextHash!==productionHash(contextContent))fail('制作审阅上下文绑定或冻结哈希不一致');
 if(!Array.isArray(family.expectedOutputRefs)||!family.expectedOutputRefs.length||!family.expectedOutputRefs.includes(family.currentExpectedOutputId))fail('制作素材族缺少预期产物闭包');
 for(const id of family.expectedOutputRefs)one(prior.expectedOutputs,o=>o.id===id&&o.familyId===family.id,'制作预期产物');
 for(const id of [...new Set([...(family.versionRefs||[]),...(family.currentVersionId?[family.currentVersionId]:[])])])one(prior.assetVersions,v=>v.id===id&&v.familyId===family.id,'制作素材历史版本');
}

/** A legacy source compiler has no authority over current production objects. */
export function preserveShotProductionProjection({snapshot,baseSnapshot,documents}){
 const prior=baseSnapshot.productionModel||{},plans=prior.shotProductionPlans||[];if(!plans.length)return snapshot;
 const out=structuredClone(snapshot),model=out.productionModel,workIds=new Set();
 for(const plan of plans){
  const doc=documents.find(d=>d.revisionId===plan.sourceRevisionId&&d.sha256===plan.sourceSha256&&d.aliases.includes(plan.sourcePath));
  if(!doc||sha256(doc.bytes)!==doc.sha256||doc.metadata?.sourceRole!=='SHOT_PRODUCTION_PLAN')fail('镜头制作计划的固定源证据缺失');
  const body=JSON.parse(doc.bytes);if(body.schemaVersion!=='1.0'||body.shotPlanRevisionId!==plan.content.shotPlanRevisionId||body.productionPlanId!==plan.id||productionHash(body.content)!==plan.contentHash||productionHash(plan.content)!==plan.contentHash||body.contentHash!==plan.contentHash)fail('镜头制作计划源字节与发布记录不一致');
  if(!Array.isArray(plan.workItemIds)||new Set(plan.workItemIds).size!==plan.workItemIds.length)fail('镜头制作计划缺少唯一工作项闭包');
  for(const work of assertPlanClosure(prior,plan))workIds.add(work.id);
 }
 const works=(prior.workItems||[]).filter(w=>workIds.has(w.id)),familyIds=new Set(works.map(w=>w.outputAssetRef)),contextIds=new Set(works.map(w=>w.reviewContextRef));
 for(const work of works)assertWorkClosure(prior,work);
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
  const definition=JSON.parse(doc.bytes),{definitionHash}=definition,stored=(baseRecipes.executionDefinitions||[]).find(d=>d.id===row.id);
  if(definition.id!==row.id||definitionHash!==row.definitionHash||!inspectExecutionDefinitionHash(definition).valid||!stored||stored.definitionHash!==definitionHash||stored.sourceSha256!==doc.sha256)fail('镜头调用包源字节与目录不一致');
  const {sourceRef,sourceRevisionId,sourceSha256,...storedContent}=stored;if(sourceRef!==row.sourcePath||sourceRevisionId!==doc.revisionId||sourceSha256!==doc.sha256||canonicalJson(storedContent)!==canonicalJson(definition))fail('镜头调用包目录内容与固定源不同');
  const prompt=one(baseRecipes.promptRevisions,p=>p.id===definition.currentRevisionId&&p.executionDefinitionId===row.id,'调用包的冻结提示词修订');
  if(prompt.definitionHash!==definitionHash||productionHash(prompt.prompt)!==productionHash(definition.prompt)||prompt.sourceRef!==row.sourcePath||prompt.sourceRevisionId!==doc.revisionId||prompt.sourceSha256!==doc.sha256)fail('调用包提示词修订与固定源不一致');
  const work=one(baseSnapshot.productionModel.workItems,w=>w.id===row.workItemId,'调用包原始工作项');if(definition.workItemRef!==work.id||definition.output?.assetFamilyRef!==work.outputAssetRef)fail('调用包与原始产物归属不一致');
  for(const [key,records] of [['executionDefinitions',[stored]],['promptRevisions',(baseRecipes.promptRevisions||[]).filter(p=>p.executionDefinitionId===row.id)]]){
   for(const record of records){const collision=(catalog[key]||[]).find(d=>d.id===record.id);if(collision&&canonicalJson(collision)!==canonicalJson(record))fail('源编译试图覆盖镜头调用包：'+record.id);}
   catalog[key]=[...(catalog[key]||[]).filter(d=>!records.some(r=>r.id===d.id)),...records];
  }
 }
 for(const row of next.productionModel.shotProductionRecipeRevisions||[])if(!revisions.some(r=>r.id===row.id&&canonicalJson(r)===canonicalJson(row)))fail('源编译试图改写镜头调用包历史');
 next.productionModel.shotProductionRecipeRevisions=structuredClone(revisions);return {snapshot:next,recipes:catalog};
}
