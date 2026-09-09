import {preserveLegacyAudioProjection} from './material-legacy-audio-preservation.mjs';
import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';
import {materialProductionRevisionClosures} from './material-production-revision-preservation.mjs';
import {materialProductionRebaseClosures} from './material-production-rebase-preservation.mjs';

export {materialProductionRevisionClosures as materialProductionLegacyRevisionClosures};

const fail=message=>{throw Object.assign(new Error(message),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});};
const same=(left,right)=>canonicalJson(left)===canonicalJson(right);
const one=(rows,predicate,label)=>{
 const found=(rows||[]).filter(predicate);
 if(found.length!==1)fail(label+'必须精确且唯一');
 return found[0];
};
const unique=(values,label)=>{
 if(!Array.isArray(values)||values.some(value=>typeof value!=='string'||!value)||new Set(values).size!==values.length)fail(label+'必须包含唯一的明确身份');
 return values;
};
const without=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
function sourceBody(plan,documents){
 const doc=one(documents,document=>document.revisionId===plan.sourceRevisionId,'基础素材建档的固定源修订');
 if(doc.deleted||doc.sha256!==plan.sourceSha256||sha256(doc.bytes)!==doc.sha256
  ||!doc.aliases?.includes(plan.sourcePath)||doc.metadata?.sourceRole!=='MATERIAL_PRODUCTION_PLAN')fail('基础素材建档的固定源身份、路径或 SHA 不一致');
 let body;try{body=JSON.parse(Buffer.from(doc.bytes).toString('utf8'));}catch{fail('基础素材建档固定源不是合法 JSON');}
 if(body.schemaVersion!=='MATERIAL_PRODUCTION_PLAN_V1'||body.id!==plan.id||body.requirementId!==plan.requirementId
  ||body.representationId!==plan.representationId||body.basisHash!==plan.basisHash||domainHash(body.basis)!==body.basisHash)fail('基础素材建档源与发布记录的身份或输入哈希不一致');
 return {body,doc};
}
function assertGraphBinding(plan,body){
 const binding=body.graphBinding,before=binding?.beforeRepresentation,after=binding?.afterRepresentation;
 if(!binding||binding.representationId!==plan.representationId||before?.id!==plan.representationId||after?.id!==plan.representationId
  ||binding.after?.sha256!==plan.graphSha256||!plan.graphRevisionId
  ||!binding.before?.revisionId||!/^[a-f0-9]{64}$/.test(binding.before?.sha256||'')||!/^[a-f0-9]{64}$/.test(plan.graphSha256||''))fail('基础素材建档缺少精确领域图修订和表现绑定');
 unique(before.assetFamilyIds,'建档前表现素材族');unique(after.assetFamilyIds,'建档后表现素材族');
 if(before.assetFamilyIds.length||!same(after.assetFamilyIds,[plan.familyId])||!same(without(before,['assetFamilyIds']),without(after,['assetFamilyIds'])))fail('首次素材建档只能为既有空表现增加本次素材族');
 if(body.requirementBefore?.id!==plan.requirementId||body.requirementAfter?.id!==plan.requirementId
  ||body.requirementAfter.representationRef!==plan.representationId||body.requirementAfter.requirementHash!==plan.requirementHash
  ||!same(body.requirementBefore.assetFamilyRefs,[])||!same(body.requirementAfter.assetFamilyRefs,[plan.familyId]))fail('基础素材需求的建档前后闭包不一致');
 const demand=binding.requirement;
 if(demand?.id!==plan.requirementId||demand.representationId!==plan.representationId
  ||domainHash({demand,representation:before})!==body.requirementBefore.requirementHash
  ||domainHash({demand,representation:after})!==body.requirementAfter.requirementHash)fail('基础素材需求哈希不能从固定需求与表现复算');
 const directory=body.directoryBinding;
 if(directory!=null){
  if(directory.requirementId!==plan.requirementId||directory.beforeBinding?.requirementId!==plan.requirementId
   ||directory.beforeBinding.representationId!==plan.representationId||!directory.before?.revisionId
   ||!/^[a-f0-9]{64}$/.test(directory.before.sha256||'')||!/^[a-f0-9]{64}$/.test(directory.after?.sha256||'')
   ||directory.beforeBinding.requirementHash!==body.requirementBefore.requirementHash
   ||directory.beforeBinding.representationHash!==domainHash(before)
   ||!same(directory.afterBinding,{...directory.beforeBinding,requirementHash:body.requirementAfter.requirementHash,representationHash:domainHash(after)}))fail('基础素材目录绑定只能更新同一需求和表现的精确哈希');
  const previous=one(directory.beforeContent?.directoryBindings,row=>row.requirementId===plan.requirementId,'建档前固定目录绑定');
  if(!same(previous,directory.beforeBinding)||domainHash(directory.beforeContent)!==directory.before.sha256
   ||domainHash(directory.afterContent)!==directory.after.sha256||plan.directorySha256!==directory.after.sha256||!plan.directoryRevisionId
   ||!same(directory.afterContent,{...directory.beforeContent,directoryBindings:directory.beforeContent.directoryBindings.map(row=>row.requirementId===plan.requirementId?directory.afterBinding:row)}))fail('基础素材目录完整前后字节或发布修订与固定源不一致');
 }else if(plan.directoryRevisionId!=null||plan.directorySha256!=null){
  fail('没有固定目录变更的建档源不能声明目录发布修订');
 }
}

/** Read-only reuse of the immutable native source/graph/directory contract.
 * This validates history; it does not restore media eligibility or adoption. */
export function materialProductionPlanGraphClosure({plan,document}){
 const result=sourceBody(plan,document?[document]:[]);
 assertGraphBinding(plan,result.body);
 return result;
}

const familyMutable=['versionRefs','currentVersionId','latestVersionId','expectedOutputRefs','currentExpectedOutputId','domainContext','lifecycleState','reviewDecision','publishState','referenceEligible','generationAllowed'];
const workMutable=['executionDefinitionRef','promptRef','inputAssetRefs','lifecycleState','reviewDecision','publishState','generationAllowed'];
function assertFrozen(actual,declared,mutable,label){
 if(!declared||!actual||!same(without(actual,mutable),without(declared,mutable)))fail(label+'与初次建档的固定源不一致');
}
function assertRecipe(catalog,body,plan,doc){
 const definition=one(catalog.executionDefinitions,row=>row.id===plan.definitionId,'建档调用定义');
 const source={sourceRef:plan.sourcePath,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
 if(!inspectExecutionDefinitionHash(definition).valid||!same(definition,{...body.executionDefinition,...source})
  ||definition.workItemRef!==plan.workItemId||definition.output?.assetFamilyRef!==plan.familyId
  ||definition.output?.expectedOutputRef!==plan.expectedOutputId
  ||definition.materialProductionPlanId!==plan.id||definition.materialRequirementRef!==plan.requirementId
  ||definition.materialRequirementHash!==plan.requirementHash)fail('基础素材调用定义与固定源、需求或产物归属不一致');
 const prompt=one(catalog.promptRevisions,row=>row.id===body.promptRevision?.id,'建档提示词修订');
 if(!same(prompt,{...body.promptRevision,...source})||prompt.executionDefinitionId!==definition.id
  ||prompt.id!==definition.currentRevisionId||!same(prompt.prompt,definition.prompt))fail('基础素材提示词修订与固定调用定义不一致');
 return definition;
}
function assertMaterialClosure(prior,catalog,{plan,body,doc}){
 if(body.assetFamily?.id!==plan.familyId||body.materialWorkItem?.id!==plan.workItemId
  ||body.expectedOutput?.id!==plan.expectedOutputId||body.executionDefinition?.id!==plan.definitionId)fail('基础素材建档记录的成员身份与固定源不一致');
 const family=one(prior.assetFamilies,row=>row.id===plan.familyId,'基础素材族');
 const work=one(prior.materialWorkItems,row=>row.id===plan.workItemId,'基础素材工作目录项');
 if((prior.workItems||[]).some(row=>row.id===work.id))fail('基础素材工作项不得重复进入全剧制作审阅目录');
 const output=one(prior.expectedOutputs,row=>row.id===plan.expectedOutputId&&row.familyId===plan.familyId,'基础素材原始预期产物');
 const context=one(prior.reviewContexts,row=>row.id===work.reviewContextRef,'基础素材审阅上下文');
 assertFrozen(family,body.assetFamily,familyMutable,'基础素材族');
 assertFrozen(work,body.materialWorkItem,workMutable,'基础素材工作项');
 assertFrozen(output,body.expectedOutput,['expectationState','realizedVersionId'],'基础素材原始预期产物');
 if(!same(context,body.workContext)||work.reviewContextRef!==body.workContext.id
  ||work.outputAssetRef!==family.id||work.requirementRef!==plan.requirementId||family.reviewOwner!=='MATERIAL')fail('基础素材工作项的审阅或输出归属不一致');
 const expectedIds=unique(family.expectedOutputRefs,'基础素材预期产物闭包');
 if(!expectedIds.includes(plan.expectedOutputId)||!expectedIds.includes(family.currentExpectedOutputId))fail('基础素材原始或当前预期产物未包含在完整闭包中');
 for(const id of expectedIds)one(prior.expectedOutputs,row=>row.id===id&&row.familyId===family.id,'基础素材历史预期产物');
 const versionIds=unique(family.versionRefs,'基础素材历史版本闭包');
 if(family.currentVersionId&&!versionIds.includes(family.currentVersionId))fail('基础素材当前版本不在其历史闭包中');
 for(const id of versionIds)one(prior.assetVersions,row=>row.id===id&&row.familyId===family.id,'基础素材历史版本');
 assertRecipe(catalog,body,plan,doc);
 // Updated authoring must have its own preserved fixed source. A changed ref
 // alone never grants legacy compilation authority over a new definition.
 const current=one(catalog.executionDefinitions,row=>row.id===work.executionDefinitionRef&&row.workItemRef===work.id,'基础素材当前调用定义');
 one(catalog.promptRevisions,row=>row.id===work.promptRef&&row.executionDefinitionId===current.id,'基础素材当前提示词修订');
}
function preserveMembers(model,catalog,prior,baseRecipes,closures,revisions,historicalContextIds=[]){
 const familyIds=new Set(closures.map(({plan})=>plan.familyId)),workIds=new Set(closures.map(({plan})=>plan.workItemId));
 const workRows=(prior.materialWorkItems||[]).filter(row=>workIds.has(row.id)),contextIds=new Set([...workRows.map(row=>row.reviewContextRef),...historicalContextIds]);
 for(const id of contextIds)one(prior.reviewContexts,row=>row.id===id,'基础素材历史审阅上下文');
 if((model.workItems||[]).some(row=>workIds.has(row.id)))fail('源编译不能把基础素材工作项复制为全剧制作工作项');
 for(const [key,rows] of [
  ['assetFamilies',(prior.assetFamilies||[]).filter(row=>familyIds.has(row.id))],
  ['assetVersions',(prior.assetVersions||[]).filter(row=>familyIds.has(row.familyId))],
  ['expectedOutputs',(prior.expectedOutputs||[]).filter(row=>familyIds.has(row.familyId))],
  ['materialWorkItems',workRows],
  ['reviewContexts',(prior.reviewContexts||[]).filter(row=>contextIds.has(row.id))],
 ])mergeFrozen(model,key,rows);
 const definitions=(baseRecipes.executionDefinitions||[]).filter(row=>workIds.has(row.workItemRef));
 const declaredIds=new Set([...closures.map(({plan})=>plan.definitionId),...revisions.map(({row})=>row.definitionId)]);
 for(const definition of definitions)if(!declaredIds.has(definition.id))fail('基础素材后续调用定义缺少受控固定源保留适配：'+definition.id);
 const definitionIds=new Set(definitions.map(row=>row.id));
 mergeFrozen(catalog,'executionDefinitions',definitions);
 mergeFrozen(catalog,'promptRevisions',(baseRecipes.promptRevisions||[]).filter(row=>definitionIds.has(row.executionDefinitionId)));
}
function mergeFrozen(target,key,rows){
 unique(rows.map(row=>row.id),key+'历史对象');
 for(const row of rows){
  const matches=(target[key]||[]).filter(record=>record.id===row.id);
  if(matches.length>1||matches.length===1&&!same(matches[0],row))fail('源编译试图覆盖基础素材历史对象：'+row.id);
 }
 target[key]=[...(target[key]||[]).filter(record=>!rows.some(row=>row.id===record.id)),...structuredClone(rows)];
}

/** Preserve a host-authored material closure before reapplying the current domain graph.
 * A plan proves its original binding; it cannot reinstate a subsequently removed relation. */
export function preserveMaterialProductionProjection({snapshot,recipes,baseSnapshot,baseRecipes,documents}){
 ({snapshot,recipes}=preserveLegacyAudioProjection({snapshot,recipes,baseSnapshot,baseRecipes,documents}));
 const prior=baseSnapshot.productionModel||{},plans=prior.materialProductionPlans||[];
 if(!plans.length)return {snapshot,recipes};
 unique(plans.map(plan=>plan.id),'基础素材建档计划');
 if(!prior.domainGraphRef||domainHash(prior.domainGraph)!==prior.domainGraphRef.sha256)fail('当前领域图与其固定修订 SHA 不一致');
 const next=structuredClone(snapshot),catalog=structuredClone(recipes),model=next.productionModel;
 const closures=plans.map(plan=>{const {body,doc}=sourceBody(plan,documents);assertGraphBinding(plan,body);return {plan,body,doc};});
 // Member and recipe validation is deliberately independent of the current
 // graph: subsequent explicit domain changes invalidate current eligibility,
 // while the original production source and history remain immutable.
 const proof=materialProductionRebaseClosures({model:prior,recipes:baseRecipes,documents,initialClosures:closures,validateLegacySegment:materialProductionRevisionClosures,instanceId:baseSnapshot.instance?.instanceId});
 const revisions=proof.revisions;
 for(const closure of closures){
  const anchor=proof.anchors.find(value=>value.plan.id===closure.plan.id);
  if(anchor?.body.schemaVersion==='MATERIAL_PRODUCTION_REQUIREMENT_REBASE_V1'){
   // The complete current member is validated against the explicit chain above.
   // Check original immutable source members with only the separately proven
   // semantic fields restored in this local audit view; no stored row changes.
   const view={...prior,materialWorkItems:prior.materialWorkItems.map(work=>{
    if(work.id!==closure.plan.workItemId)return work;
    const original={...work,requirementHash:closure.body.materialWorkItem.requirementHash,reviewContextRef:closure.body.materialWorkItem.reviewContextRef};
    delete original.materialProductionRequirementRebaseId;return original;
   })};
   assertMaterialClosure(view,baseRecipes,closure);
  }else assertMaterialClosure(prior,baseRecipes,closure);
 }
 mergeFrozen(model,'materialProductionPlans',plans);
 if(revisions.length)mergeFrozen(model,'materialProductionRecipeRevisions',revisions.map(({row})=>row));
 preserveMembers(model,catalog,prior,baseRecipes,closures,revisions,proof.contextIds);
 return {snapshot:next,recipes:catalog};
}

/** Keep unchanged source provenance without restoring stale scope eligibility. */
export function preserveMaterialProductionRequirementProvenance({snapshot,baseSnapshot}){
 const prior=baseSnapshot.productionModel||{};
 if(!(prior.materialProductionPlans||[]).length)return snapshot;
 const result=structuredClone(snapshot),model=result.productionModel;
 if(!same(model.domainGraph,prior.domainGraph)||!same(model.domainGraphRef,prior.domainGraphRef))fail('源编译不得用历史建档计划替换当前已确认领域图');
 for(const requirement of model.materialRequirements||[]){
  const previous=(prior.materialRequirements||[]).find(row=>row.id===requirement.id);
  if(requirement.sourceKind!=='DOMAIN_GRAPH'){
   // A compiler pass must not add an empty modern hash to an unrelated legacy
   // record that was never part of the domain graph. Actual relations still
   // receive their current projected context.
   const context=requirement.domainContext;
   if(previous&&!previous.domainContext&&context&&!context.representationIds?.length&&!context.entityIds?.length&&!context.relationIds?.length
    &&same(without(previous,['domainContext']),without(requirement,['domainContext'])))delete requirement.domainContext;
   continue;
  }
  const demand=one(model.domainGraph.requirements,row=>row.id===requirement.id,'当前领域需求');
  const representation=one(model.domainGraph.representations,row=>row.id===demand.representationId,'当前需求表现');
  if(requirement.requirementHash!==domainHash({demand,representation})||!same(requirement.assetFamilyRefs,representation.assetFamilyIds))fail('源同步后的需求哈希或素材族引用未由当前领域图重投');
  if(previous?.requirementHash===requirement.requirementHash){
   if(previous.sourceRef!==undefined)requirement.sourceRef=previous.sourceRef;
   if(previous.materialWorkItemRef!==undefined){
    const work=one(model.materialWorkItems,row=>row.id===previous.materialWorkItemRef&&row.requirementRef===requirement.id,'当前需求素材工作项');
    if(!requirement.assetFamilyRefs.includes(work.outputAssetRef)||previous.plannedAssetFamilyId!==undefined&&previous.plannedAssetFamilyId!==work.outputAssetRef)fail('需求建档关联与当前素材输出闭包不一致');
   }
   if(previous.plannedAssetFamilyId!==undefined&&!requirement.assetFamilyRefs.includes(previous.plannedAssetFamilyId))fail('需求的建档素材族已脱离当前表现');
   for(const key of ['materialWorkItemRef','plannedAssetFamilyId'])if(previous[key]!==undefined)requirement[key]=previous[key];
  }
 }
 return result;
}
