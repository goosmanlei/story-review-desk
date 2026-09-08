import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(new Error(message),{code:'MATERIAL_PRODUCTION_SOURCE_CONFLICT'});};
const one=(rows,id,label)=>{const found=(rows||[]).filter(r=>r.id===id);if(found.length!==1)fail(label+'必须精确且唯一');return found[0];};
const without=(v,keys)=>Object.fromEntries(Object.entries(v).filter(([key])=>!keys.includes(key)));
const familyMutable=['versionRefs','currentVersionId','latestVersionId','expectedOutputRefs','currentExpectedOutputId','domainContext','lifecycleState','reviewDecision','publishState','referenceEligible','generationAllowed'];
const workMutable=['executionDefinitionRef','promptRef','inputAssetRefs','lifecycleState','reviewDecision','publishState','generationAllowed'];
const outputMutable=['id','targetPath','plannedVersionLabel','legacyVersionId','expectationState','realizedVersionId','sourceRef','executionDefinitionRef'];

/** Verify each immutable native successor source and its exact predecessor chain. */
export function materialProductionRevisionClosures({model,recipes,documents,initialClosures}){
 const rows=model.materialProductionRecipeRevisions||[];
 if(new Set(rows.map(r=>r.id)).size!==rows.length||new Set(rows.map(r=>r.definitionId)).size!==rows.length||new Set(rows.map(r=>r.expectedOutputId)).size!==rows.length)fail('基础素材后继版本记录不能重复');
 const closures=rows.map(row=>{
  const initial=initialClosures.find(c=>c.plan.id===row.materialProductionPlanId);if(!initial)fail('基础素材后继版本缺少原始建档计划');
  const doc=(documents||[]).filter(d=>d.revisionId===row.sourceRevisionId);
  if(doc.length!==1||doc[0].deleted||doc[0].sha256!==row.sourceSha256||sha256(doc[0].bytes)!==row.sourceSha256||doc[0].metadata?.sourceRole!=='MATERIAL_PRODUCTION_RECIPE'||!doc[0].aliases?.includes(row.sourcePath))fail('基础素材后继调用定义缺少精确受控固定源');
  let body;try{body=JSON.parse(Buffer.from(doc[0].bytes).toString('utf8'));}catch{fail('基础素材后继固定源不是合法 JSON');}
  const plan=initial.plan;
  if(body.schemaVersion!=='MATERIAL_PRODUCTION_RECIPE_V1'||body.id!==row.id||body.sourcePath!==row.sourcePath||row.sourcePath!=='story/material-production/recipes/'+row.id+'.json'||body.materialProductionPlanId!==plan.id||row.requirementId!==plan.requirementId||row.representationId!==plan.representationId||row.familyId!==plan.familyId||row.workItemId!==plan.workItemId||row.requirementHash!==plan.requirementHash||body.requirementId!==row.requirementId||body.representationId!==row.representationId||body.basisHash!==row.basisHash||domainHash(body.basis)!==row.basisHash||body.basis.requirementHash!==row.requirementHash)fail('基础素材后继源身份、需求或输入闭包不一致');
  const rb=body.basis.revision,candidate=body.parentCandidate;
  if(!rb||rb.materialProductionPlanId!==plan.id||rb.familyId!==plan.familyId||rb.workItemId!==plan.workItemId||rb.parentVersionId!==row.parentVersionId||rb.parentVersionSha256!==row.parentVersionSha256||body.parentVersionId!==row.parentVersionId||body.parentVersionSha256!==row.parentVersionSha256||rb.definitionId!==row.previousDefinitionId||rb.expectedOutputId!==row.previousExpectedOutputId||body.previousDefinitionId!==row.previousDefinitionId||body.previousExpectedOutputId!==row.previousExpectedOutputId||candidate?.versionId!==row.parentVersionId||candidate.familyId!==row.familyId||candidate.sha256!==row.parentVersionSha256||candidate.expectedOutputId!==row.previousExpectedOutputId||candidate.executionDefinitionId!==row.previousDefinitionId||candidate.callPackageHash!==rb.definitionHash||rb.parentCandidate?.eventId!==candidate.eventId||rb.parentCandidate?.sha256!==domainHash(candidate)||!/^[a-f0-9]{64}$/.test(row.parentVersionSha256||''))fail('基础素材后继版本缺少精确实际父候选和旧调用包证据');
  const definition=one(recipes.executionDefinitions,row.definitionId,'后继调用定义'),output=one(model.expectedOutputs,row.expectedOutputId,'后继预期产物'),work=body.materialWorkItem,family=body.assetFamily,source={sourceRef:row.sourcePath,sourceRevisionId:row.sourceRevisionId,sourceSha256:row.sourceSha256};
  if(!inspectExecutionDefinitionHash(definition).valid||definition.definitionHash!==row.definitionHash||!same(definition,{...body.executionDefinition,...source})||definition.id!==row.definitionId||definition.workItemRef!==row.workItemId||definition.materialProductionPlanId!==plan.id||definition.materialRequirementRef!==row.requirementId||definition.materialRequirementHash!==row.requirementHash||definition.parentVersionId!==row.parentVersionId||definition.output?.assetFamilyRef!==row.familyId||definition.output?.expectedOutputRef!==row.expectedOutputId||definition.output?.path!==output.targetPath||definition.output?.mediaType!==initial.body.assetFamily.kind)fail('基础素材后继调用定义与固定源、父版本或输出不一致');
  const prompt=one(recipes.promptRevisions,definition.currentRevisionId,'后继提示词');
  if(!same(prompt,{...body.promptRevision,...source})||prompt.executionDefinitionId!==definition.id||prompt.definitionHash!==definition.definitionHash||!same(prompt.prompt,definition.prompt))fail('基础素材后继提示词未绑定精确定义');
  if(!same(without(output,['expectationState','realizedVersionId']),without(body.expectedOutput,['expectationState','realizedVersionId']))||output.familyId!==row.familyId||output.legacyVersionId!==plan.expectedOutputId||output.executionDefinitionRef!==definition.id||output.materialProductionPlanId!==plan.id||output.sourceRef!==row.sourcePath||output.plannedVersionLabel!==rb.plannedVersionLabel||!/^V\d{3,}$/.test(output.plannedVersionLabel||'')||output.targetPath!=='media/_review_pending/material-production/'+row.familyId+'/'+output.plannedVersionLabel+(definition.output.mediaType==='IMAGE'?'.png':'.wav'))fail('基础素材后继预期产物或实际文件边界不一致');
  if(!same(without(family,familyMutable),without(initial.body.assetFamily,familyMutable))||family.id!==row.familyId||family.currentExpectedOutputId!==output.id||!same(without(work,workMutable),without(initial.body.materialWorkItem,workMutable))||work.id!==row.workItemId||work.executionDefinitionRef!==definition.id||work.promptRef!==definition.currentRevisionId)fail('基础素材后继源不能重建素材族、工作项或改变归属');
  const inputs=body.inputBindings;
  if(!Array.isArray(inputs)||!same(inputs,body.authoringContent?.inputBindings)||new Set(inputs.map(b=>b.familyId)).size!==inputs.length||!same(work.inputAssetRefs,inputs.map(b=>b.familyId))||!same((definition.upload?.items||[]).map(b=>({familyId:b.assetFamilyRef,versionId:b.assetVersionRef,sha256:b.sha256})),inputs))fail('基础素材后继参考输入与调用定义不一致');
  return {row,body,definition,output,initial};
 });
 for(const initial of initialClosures){
  const chain=closures.filter(c=>c.row.materialProductionPlanId===initial.plan.id);let previousDefinition=initial.body.executionDefinition,previousOutput=initial.body.expectedOutput,previousFamily=initial.body.assetFamily,previousWork=initial.body.materialWorkItem;const visited=new Set();
  while(true){
   const next=chain.filter(c=>c.row.previousDefinitionId===previousDefinition.id);if(next.length>1)fail('同素材族后继调用包不得分叉');if(!next.length)break;
   const c=next[0];if(visited.has(c.row.id))fail('素材后继调用包形成循环');visited.add(c.row.id);
   const number=Number(String(previousOutput.plannedVersionLabel).slice(1))+1;
   if(c.row.previousExpectedOutputId!==previousOutput.id||c.body.basis.revision.definitionHash!==previousDefinition.definitionHash||c.body.basis.revision.expectedOutputHash!==domainHash(previousOutput)||c.row.parentVersionId!==c.row.familyId+'@'+previousOutput.plannedVersionLabel||c.output.plannedVersionLabel!=='V'+String(number).padStart(3,'0')||!same(without(c.output,outputMutable),without(previousOutput,outputMutable))||!same(c.body.assetFamily.expectedOutputRefs,[...previousFamily.expectedOutputRefs,c.output.id]))fail('素材后继调用包没有按精确版本和预期产物顺序追加');
   previousDefinition=c.body.executionDefinition;previousOutput=c.body.expectedOutput;previousFamily=c.body.assetFamily;previousWork=c.body.materialWorkItem;
  }
  if(visited.size!==chain.length)fail('素材后继调用包存在脱离原始计划的分支');
  const currentWork=one(model.materialWorkItems,initial.plan.workItemId,'当前基础素材工作项'),currentFamily=one(model.assetFamilies,initial.plan.familyId,'当前基础素材族');
  if(currentWork.executionDefinitionRef!==previousDefinition.id||currentWork.promptRef!==previousDefinition.currentRevisionId||!same(currentWork.inputAssetRefs,previousWork.inputAssetRefs))fail('当前素材调用包没有指向已发布后继链末端');
  if(chain.length&&(currentFamily.currentExpectedOutputId!==previousOutput.id||!same(currentFamily.expectedOutputRefs,previousFamily.expectedOutputRefs)||!same((model.expectedOutputs||[]).filter(o=>o.familyId===initial.plan.familyId).map(o=>o.id).sort(),[...previousFamily.expectedOutputRefs].sort())))fail('当前素材预期产物没有指向完整后继链末端');
 }
 return closures;
}
