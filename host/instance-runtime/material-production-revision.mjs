import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {inspectExecutionDefinitionHash,executionDefinitionHash} from './execution-definition-hash.mjs';
import {domainReferenceEligibility} from './domain-reference.mjs';

const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const latest=rows=>[...rows].sort((a,b)=>(Number(b.eventSequence)||0)-(Number(a.eventSequence)||0)||String(b.recordedAt||b.createdAt||'').localeCompare(String(a.recordedAt||a.createdAt||''))||String(b.eventId||'').localeCompare(String(a.eventId||'')))[0]||null;
const latestPer=(rows,key)=>[...new Set(rows.map(r=>r[key]).filter(Boolean))].map(id=>latest(rows.filter(r=>r[key]===id)));
const runState=r=>String(r?.runState||r?.state||'RESULT_UNKNOWN');
const eventBinding=e=>e?{eventId:e.eventId,eventSequence:e.eventSequence||null,sha256:domainHash(e)}:null;
const owned=(rows,id,label)=>{const found=(rows||[]).filter(r=>r.id===id);if(found.length!==1)fail(label+'必须精确且唯一');return found[0];};

/** Revision is available only for a host-authored native family, never a legacy shell. */
export async function materialProductionRevisionContext(tx,c){
 const plans=(c.model.materialProductionPlans||[]).filter(p=>p.requirementId===c.requirement.id);
 if(plans.length!==1)return null;
 const plan=plans[0],family=owned(c.model.assetFamilies,plan.familyId,'基础素材族'),work=owned(c.model.materialWorkItems,plan.workItemId,'基础素材工作项');
 if(!same(c.representation.assetFamilyIds,[family.id])||family.materialProductionPlanId!==plan.id||work.materialProductionPlanId!==plan.id||family.ownerRef!==work.id||work.outputAssetRef!==family.id||work.requirementRef!==c.requirement.id||c.requirement.materialWorkItemRef!==work.id||c.requirement.plannedAssetFamilyId!==family.id||work.requirementHash!==c.requirement.requirementHash||plan.requirementHash!==c.requirement.requirementHash)fail('当前需求已偏离首次制作建档闭包，不能借返修迁移归属');
 const definition=owned(c.view.recipes.executionDefinitions,work.executionDefinitionRef,'当前基础素材调用定义'),output=owned(c.model.expectedOutputs,family.currentExpectedOutputId,'当前预期产物');
 if(definition.materialProductionPlanId!==plan.id||definition.workItemRef!==work.id||definition.materialRequirementHash!==c.requirement.requirementHash||definition.output?.expectedOutputRef!==output.id||definition.output?.assetFamilyRef!==family.id||definition.output?.path!==output.targetPath||output.familyId!==family.id||output.materialProductionPlanId!==plan.id||output.executionDefinitionRef!==definition.id||!family.expectedOutputRefs.includes(output.id)||!inspectExecutionDefinitionHash(definition).valid)fail('当前素材调用定义、预期产物或固定哈希不一致');
 const sourceRow=definition.id===plan.definitionId?plan:(c.model.materialProductionRecipeRevisions||[]).find(r=>r.definitionId===definition.id&&r.materialProductionPlanId===plan.id);
 if(!sourceRow)fail('当前调用定义没有受控固定源');
 const source=await tx.readDocumentRevision(sourceRow.sourceRevisionId);
 if(!source||source.deleted||source.sha256!==sourceRow.sourceSha256||sha256(source.bytes)!==source.sha256||!source.aliases?.includes(sourceRow.sourcePath)||source.metadata?.sourceRole!==(definition.id===plan.definitionId?'MATERIAL_PRODUCTION_PLAN':'MATERIAL_PRODUCTION_RECIPE'))fail('当前素材调用定义的固定源不可验证');
 const sourceBody=JSON.parse(Buffer.from(source.bytes).toString('utf8'));
 if(!same(definition,{...sourceBody.executionDefinition,sourceRef:sourceRow.sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256}))fail('当前素材调用定义与固定源内容不同');
 const events=c.view.eventsByKind||{},candidates=(events['asset-version']||[]).filter(e=>e.familyId===family.id),parentCandidates=candidates.filter(e=>e.expectedOutputId===output.id),parent=latest(parentCandidates),blockers=[];
 if(!parent||new Set(parentCandidates.map(e=>e.versionId)).size!==1)blockers.push('当前素材预期产物尚未形成唯一实际候选，不能新建后继版本');
 let media=null;
 if(parent){
  media=await tx.getMedia(family.id,parent.versionId);const projected=c.state.assetVersionsById?.[parent.versionId];
  if(parent.executionDefinitionId!==definition.id||parent.callPackageHash!==definition.definitionHash||!projected||projected.familyId!==family.id||projected.sha256!==parent.sha256||projected.path!==output.targetPath||!media||media.sha256!==parent.sha256||media.relativePath!==output.targetPath||media.availability!=='PRESENT'||!['FORMAL','IMPORTED_EVIDENCE'].includes(media.metadata?.authorityDomain)||!['PUBLIC',undefined].includes(media.metadata?.visibility)||media.metadata?.sourceRole==='ORIGINAL_SOURCE'||(await mediaRetirementOverlay(tx,media)).state!=='ACTIVE')blockers.push('父版本必须是本调用包的精确实际候选及可用正式媒体');
 }
 const definitions=new Set((c.view.recipes.executionDefinitions||[]).filter(d=>d.workItemRef===work.id).map(d=>d.id));
 const requests=latestPer((events['execution-request']||[]).filter(e=>e.workItemId===work.id||e.familyId===family.id),'executionRequestId');
 const requestIds=new Set(requests.map(e=>e.executionRequestId));
 const runs=latestPer((events.run||[]).filter(e=>definitions.has(e.executionDefinitionId)||requestIds.has(e.executionRequestId)),'runId');
 for(const run of runs){
  const registered=candidates.some(e=>e.runId===run.runId&&e.executionRequestId===run.executionRequestId&&e.executionDefinitionId===run.executionDefinitionId&&e.callPackageHash===run.callPackageHash);
  if(['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN'].includes(runState(run))||runState(run)==='SUCCEEDED'&&!registered)blockers.push('素材仍有生成中或结果未核清的实际 Run：'+run.runId);
 }
 for(const request of requests){
  const state=String(request.requestState||request.status||'UNKNOWN'),requestRuns=runs.filter(r=>r.executionRequestId===request.executionRequestId),count=new Set(candidates.filter(e=>e.executionRequestId===request.executionRequestId).map(e=>e.versionId)).size;
  if(count>=Math.max(1,Number(request.maxOutputs)||1))continue;
  if(['AUTHORIZED','CLAIMED','RESULT_UNKNOWN','UNKNOWN'].includes(state)&&!requestRuns.length||['AUTHORIZED','CLAIMED'].includes(state)&&requestRuns.some(r=>!['FAILED','CANCELLED'].includes(runState(r))))blockers.push('素材仍有未完成的生成授权：'+request.executionRequestId);
 }
 if(parent){const run=runs.find(r=>r.runId===parent.runId);if(!run||runState(run)!=='SUCCEEDED'||run.executionDefinitionId!==definition.id||run.callPackageHash!==definition.definitionHash||run.executionRequestId!==parent.executionRequestId)blockers.push('父候选的实际成功 Run 闭包不完整');}
 const labels=(c.model.expectedOutputs||[]).filter(o=>o.familyId===family.id).map(o=>o.plannedVersionLabel);
 if(labels.some(label=>!/^V\d{3,}$/.test(label||''))||new Set(labels).size!==labels.length)fail('素材族历史版本标签不唯一或无效');
 const plannedVersionLabel='V'+String(Math.max(...labels.map(label=>Number(label.slice(1))))+1).padStart(3,'0');
 const reviews=(events.review||[]).filter(e=>e.applicationStatus==='APPLIED'&&e.effect==='APPLIED'&&e.subjectType==='ASSET'&&e.familyId===family.id);
 const adoptedId=c.state.assetFamiliesById?.[family.id]?.currentVersionId||null,adopted=adoptedId?c.state.assetVersionsById[adoptedId]:null,meta=await tx.getMetadata();
 const revisionBasis={materialProductionPlanId:plan.id,familyId:family.id,workItemId:work.id,definitionId:definition.id,definitionHash:definition.definitionHash,expectedOutputId:output.id,expectedOutputHash:domainHash(output),parentVersionId:parent?.versionId||null,parentVersionSha256:parent?.sha256||null,parentCandidate:eventBinding(parent),parentReview:eventBinding(latest(reviews.filter(e=>e.versionId===parent?.versionId&&e.versionSha256===parent?.sha256))),familyReviewHead:eventBinding(latest(reviews)),adoptedVersion:adopted?{versionId:adopted.id,sha256:adopted.sha256}:null,requestHeads:requests.map(eventBinding),runHeads:runs.map(eventBinding),plannedVersionLabel,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch};
 return {plan,family,work,definition,output,parent,media,revisionBasis,plannedVersionLabel,blockers:[...new Set(blockers)]};
}

export async function compileMaterialProductionRevision(tx,c,content,draftRevisionId,registeredInput){
 const r=c.revision,key=domainHash({workItemId:r.work.id,draftRevisionId}).slice(0,24),id='MP-RECIPE-'+key,definitionId='MP-CALL-'+key,outputId='MP-EO-'+key,sourcePath='story/material-production/recipes/'+id+'.json';
 if((c.model.expectedOutputs||[]).some(o=>o.id===outputId)||(c.view.recipes.executionDefinitions||[]).some(d=>d.id===definitionId))fail('本次后继版本身份已经存在');
 const inputs=[];for(const b of content.inputBindings)inputs.push({...await registeredInput(tx,c.model,c.state,b),order:inputs.length+1});
 const reasons=domainReferenceEligibility({...c.model,assetFamiliesById:c.state.assetFamiliesById,assetVersionsById:c.state.assetVersionsById},r.family.id,inputs);if(reasons.length)fail('参考母版或关系未满足：'+reasons.join('、'));
 const targetPath='media/_review_pending/material-production/'+r.family.id+'/'+r.plannedVersionLabel+(r.family.kind==='IMAGE'?'.png':'.wav');
 const expectedOutput={...r.output,id:outputId,targetPath,plannedVersionLabel:r.plannedVersionLabel,legacyVersionId:r.plan.expectedOutputId,expectationState:'PLANNED',realizedVersionId:null,sourceRef:sourcePath,executionDefinitionRef:definitionId};
 const {inputBindings,...authoringContent}=content;
 const previousDefinition=Object.fromEntries(Object.entries(r.definition).filter(([key])=>!['sourceRef','sourceRevisionId','sourceSha256'].includes(key)));
 const executionDefinition={...previousDefinition,id:definitionId,currentRevisionId:definitionId+':r1',upload:{rawText:inputs.map(b=>b.path).join('\n'),items:inputs},model:{branch:content.model,rawRule:content.model,resolution:String(content.parameters.resolution||'EXPLICIT_PARAMETERS')},parameters:content.parameters,parametersRaw:canonicalJson(content.parameters),prompt:{main:content.prompt,negative:content.negativePrompt,negativeApplication:content.negativePrompt?'APPLY_WITH_MAIN_PROMPT':'NONE'},output:{path:targetPath,mediaType:r.family.kind,assetFamilyRef:r.family.id,expectedOutputRef:outputId},rawSourceBlock:canonicalJson(authoringContent),authoringContent,parentVersionId:r.parent.versionId,parentVersionSha256:r.parent.sha256};
 executionDefinition.definitionHash=executionDefinitionHash(executionDefinition);
 const promptRevision={id:executionDefinition.currentRevisionId,executionDefinitionId:definitionId,definitionHash:executionDefinition.definitionHash,prompt:executionDefinition.prompt};
 const assetFamily={...structuredClone(r.family),currentExpectedOutputId:outputId,expectedOutputRefs:[...r.family.expectedOutputRefs,outputId]},materialWorkItem={...structuredClone(r.work),executionDefinitionRef:definitionId,promptRef:executionDefinition.currentRevisionId,inputAssetRefs:inputBindings.map(b=>b.familyId)};
 return {plan:{schemaVersion:'MATERIAL_PRODUCTION_RECIPE_V1',id,materialProductionPlanId:r.plan.id,requirementId:c.requirement.id,representationId:c.representation.id,draftRevisionId,baseReleaseId:c.view.releaseId,basis:c.basis,basisHash:c.basisHash,previousDefinitionId:r.definition.id,previousExpectedOutputId:r.output.id,parentVersionId:r.parent.versionId,parentVersionSha256:r.parent.sha256,parentCandidate:r.parent,requirementBefore:c.requirement,requirementAfter:c.requirement,assetFamily,expectedOutput,materialWorkItem,executionDefinition,promptRevision,authoringContent:content,inputBindings,sourcePath}};
}
