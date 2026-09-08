import {legacyAudioRevisionContext,compileLegacyAudioRevision,LEGACY_AUDIO_MODE,LEGACY_AUDIO_SOURCE,LEGACY_AUDIO_SCHEMA} from './material-legacy-audio.mjs';
import {materialProductionRevisionContext,compileMaterialProductionRevision} from './material-production-revision.mjs';
import {preserveMaterialProductionProjection} from './material-production-preservation.mjs';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {domainHash,validateDomainGraph,defaultDomainConfiguration} from './domain-model.mjs';
import {currentGraph,evidenceBindings,verifyQuotes,validateIdentities} from './domain-service.mjs';
import {verifyDomainWorkspaceEvidence} from './domain-workspace-evidence.mjs';
import {projectDomainGraph} from './domain-projection.mjs';
import {materialDirectorySource} from './material-directory.mjs';
import {refreshDirectoryProjection} from './directory-projection.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {domainReferenceEligibility} from './domain-reference.mjs';
import {validateShotRecipeContent} from './shot-production-recipes.mjs';
import {executionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from './execution-definition-hash.mjs';
import {productionBindingReasons,productionId} from './shot-production-model.mjs';
import {loadMaterialUsageEvidence} from './material-usage-preservation.mjs';
import {materialUsageBindingsFor} from './material-usage-model.mjs';

export const MATERIAL_PRODUCTION_NS={drafts:'material-production-drafts',jobs:'material-production-jobs',requests:'material-production-requests'};
const read=r=>r&&!r.deleted?JSON.parse(r.bytes):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const put=(tx,namespace,key,value,expectedRevisionId=null)=>tx.putAux({namespace,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});
const hashPattern=/^[a-f0-9]{64}$/;
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

export function validateMaterialProductionContent(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='inputBindings,model,negativePrompt,parameters,prompt')fail('建档内容须包含模型、提示词、负面提示、参数和明确参考输入','DOMAIN_INVALID');
 const {inputBindings,...author}=value,content=validateShotRecipeContent(author);
 if(!Array.isArray(inputBindings)||inputBindings.length>30)fail('参考输入须为有限的精确版本列表','DOMAIN_INVALID');
 const families=new Set();
 for(const b of inputBindings){if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='familyId,sha256,versionId')fail('参考输入须精确绑定素材族、版本和 SHA','DOMAIN_INVALID');productionId(b.familyId);productionId(b.versionId);if(!hashPattern.test(b.sha256||'')||families.has(b.familyId))fail('参考 SHA 无效或素材族重复','DOMAIN_INVALID');families.add(b.familyId);}
 return {...content,inputBindings:structuredClone(inputBindings)};
}
function operationalState(view,api){
 if(!api?.projectOperationalState)fail('缺少正式运行态验证器');
 const e=view.eventsByKind||{};
 return api.projectOperationalState(view.snapshot,e.review||[],e['asset-version']||[],e.run||[],e['source-operation']||[],e['execution-request']||[]);
}
async function registeredInput(tx,model,state,binding){
 const reasons=productionBindingReasons(model,state,binding);if(reasons.length)fail('参考版本尚未按精确 SHA 正式放行：'+reasons.join('、'));
 const media=await tx.getMedia(binding.familyId,binding.versionId),version=state.assetVersionsById[binding.versionId];
 if(!media||media.sha256!==binding.sha256||media.availability!=='PRESENT'||media.metadata?.sourceRole==='ORIGINAL_SOURCE'||!['FORMAL','IMPORTED_EVIDENCE'].includes(media.metadata?.authorityDomain)||!['PUBLIC',undefined].includes(media.metadata?.visibility)||(await mediaRetirementOverlay(tx,media)).state!=='ACTIVE')fail('参考输入缺少可用的正式受管媒体登记');
 // Published paths are logical aliases; migrated originals live in immutable
 // blobs. Resolve the exact version and SHA, then require this same registry row.
 const resolved=await tx.resolveMedia(version.path,{versionId:binding.versionId,sha256:binding.sha256});
 if(!resolved||resolved.mediaId!==binding.familyId||resolved.versionId!==binding.versionId||resolved.sha256!==media.sha256||resolved.relativePath!==media.relativePath||resolved.byteSize!==media.byteSize)fail('参考逻辑路径未精确绑定同族版本和已登记 SHA');
 return {order:0,path:version.path,assetFamilyRef:binding.familyId,assetVersionRef:binding.versionId,sha256:binding.sha256};
}
async function context(tx,requirementId,api){
 productionId(requirementId);const view=await tx.readView();if(!view.snapshot)fail('当前实例没有已发布资料');
 const model=await loadMaterialUsageEvidence(tx,view.snapshot.productionModel,{view}),current=await currentGraph(tx,view),graph=current.graph,state=operationalState({...view,snapshot:{...view.snapshot,productionModel:model}},api);
 const legacy=await legacyAudioRevisionContext(tx,{view,model,graph,current,state,requirementId,api});if(legacy)return legacy;
 const rows=(model.materialRequirements||[]).filter(r=>r.id===requirementId);let requirement=rows[0];const demand=graph.requirements.find(r=>r.id===requirementId),representation=graph.representations.find(r=>r.id===demand?.representationId);
 if(rows.length!==1||requirement?.requirementClass!=='REQUIRED'||requirement.sourceKind!=='DOMAIN_GRAPH'||!demand||!representation||requirement.scopeRole==='EVIDENCE_ONLY'||requirement.activeInCurrentProduction===false)fail('仅支持当前领域图谱中的正式必需素材需求');
 if(requirement.representationRef!==representation.id||requirement.requirementHash!==domainHash({demand,representation})||!same(requirement.assetFamilyRefs||[],representation.assetFamilyIds))fail('需求与表现的精确基线不一致');
 const head=await tx.getAux('domain-graph','current');if(head?.revisionId!==current.revisionId||head.sha256!==model.domainGraphRef?.sha256||head.sha256!==domainHash(graph))fail('领域图谱发布基线或当前头已变化');
 const entity=graph.entities.find(e=>e.id===representation.entityId),domainState=representation.stateId?graph.states.find(s=>s.id===representation.stateId&&s.entityId===entity?.id):null;
 const blockers=[],base={view,model,state,graph,requirement,demand,representation,api};
 const revision=await materialProductionRevisionContext(tx,base);
 if(revision){requirement=revision.requirement;base.requirement=requirement;}
 if(!revision&&((representation.assetFamilyIds||[]).length||requirement.materialWorkItemRef||requirement.plannedAssetFamilyId||(model.materialWorkItems||[]).some(w=>w.requirementRef===requirementId)))blockers.push('此需求已有制作对象，请沿既有素材版本流程处理');
 if(revision)blockers.push(...revision.blockers);
 if(requirement.composition)blockers.push('组合需求须由全部必需子需求齐套，请为子需求分别建档制作');
 if(materialUsageBindingsFor(state,requirement).length)blockers.push('该需求已有精确通过的图片用途绑定，不重复创建生产族');
 if(!['IMAGE','AUDIO'].includes(demand.mediaType))blockers.push('首次建档当前仅支持图片或声音基础素材');
 if(graph.requirements.filter(r=>r.representationId===representation.id).length!==1||(representation.requirementIds||[]).some(id=>id!==requirementId))blockers.push('此表现关联多个需求，须先明确独立的制作归属');
 if(!entity||representation.stateId&&!domainState)blockers.push('当前实体或状态归属不完整');
 if(!requirement.configurationBinding?.reviewSpec?.hash||!requirement.reviewSpec?.hash)blockers.push('当前需求缺少冻结审阅标准和配置');
 const basis={requirementId,requirementHash:requirement.requirementHash,demand,representation,entity:entity||null,state:domainState,graphRef:{revisionId:current.revisionId,sha256:head.sha256},configurationBinding:requirement.configurationBinding||null,domainContext:requirement.domainContext||null};
 if(revision)basis.revision=revision.revisionBasis;
 return {...base,basis,basisHash:domainHash(basis),blockers,revision,mode:revision?'REVISION':'FIRST_SETUP'};
}
export async function getMaterialProductionWorkspace(tx,{requirementId,api}){
 const c=await context(tx,requirementId,api),record=await tx.getAux(MATERIAL_PRODUCTION_NS.drafts,requirementId),draft=read(record),availableInputs=[];
 for(const [familyId,f] of Object.entries(c.state.assetFamiliesById||{})){const v=c.state.assetVersionsById?.[f.currentVersionId];if(!v?.sha256)continue;const binding={familyId,versionId:v.id,sha256:v.sha256};try{await registeredInput(tx,c.model,c.state,binding);const source=(c.model.assetFamilies||[]).find(x=>x.id===familyId);availableInputs.push({...binding,label:source?.label||familyId,kind:source?.kind||'UNKNOWN'});}catch{}}
 const draftCurrent=draft&&draft.basisHash===c.basisHash&&draft.baseReleaseId===c.view.releaseId;
 const defaults=c.revision?.defaults||(c.revision?{...c.revision.definition.authoringContent,inputBindings:(c.revision.definition.upload?.items||[]).map(b=>({familyId:b.assetFamilyRef,versionId:b.assetVersionRef,sha256:b.sha256}))}:{model:'',prompt:[c.requirement.title,...(c.requirement.acceptanceCriteria||[])].join('\n'),negativePrompt:'',parameters:{},inputBindings:[]});
 return {requirementId,mode:c.mode,familyId:c.revision?.family.id||null,parentVersionId:c.revision?.parent?.versionId||null,parentVersionSha256:c.revision?.parent?.sha256||null,plannedVersionLabel:c.revision?.plannedVersionLabel||'V001',currentDefinitionId:c.revision?.definition.id||null,releaseId:c.view.releaseId,requirement:c.requirement,representation:c.representation,basis:c.basis,basisHash:c.basisHash,draftHeadRevisionId:record?.revisionId||null,draft:draftCurrent?{...draft,revisionId:record.revisionId}:null,staleDraft:draft&&!draftCurrent?{...draft,revisionId:record.revisionId,reason:'制作基线已变化；旧稿保留，须核对当前父版本和参考后重新保存。'}:null,defaults,availableInputs,blockers:c.blockers,currentRegistration:(c.model.materialProductionPlans||[]).find(p=>p.requirementId===requirementId)||null,jobs:(await tx.listAux(MATERIAL_PRODUCTION_NS.jobs)).map(read).filter(j=>j?.requirementId===requirementId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(({jobId,status,error,result})=>({jobId,status,error,result})),readOnly:false};
}
export async function saveMaterialProductionDraft(tx,input,{api}){
 const c=await context(tx,input.requirementId,api);if(c.view.releaseId!==input.expectedReleaseId)fail('发布版本已变化');if(c.revision&&input.expectedBasisHash!==c.basisHash)fail('素材父版本、审阅或运行基线已变化，请重新核对当前素材建档状态');if(c.blockers.length)fail(c.blockers.join('、'));
 const content=validateMaterialProductionContent(input.content);for(const b of content.inputBindings)await registeredInput(tx,c.model,c.state,b);
 const record=await put(tx,MATERIAL_PRODUCTION_NS.drafts,input.requirementId,{requirementId:input.requirementId,baseReleaseId:c.view.releaseId,basisHash:c.basisHash,content},input.expectedDraftRevisionId);
 return {revisionId:record.revisionId,formalAdoptionPerformed:false,modelCalls:0};
}
async function compile(tx,c,content,draftRevisionId){
 content=validateMaterialProductionContent(content);if(c.mode===LEGACY_AUDIO_MODE)return compileLegacyAudioRevision(tx,c,content,draftRevisionId,registeredInput);if(c.revision)return compileMaterialProductionRevision(tx,c,content,draftRevisionId,registeredInput);const id='MP-PLAN-'+domainHash({requirementId:c.requirement.id,draftRevisionId}).slice(0,24),key=domainHash({requirementId:c.requirement.id}).slice(0,24),familyId='MP-AF-'+key,workId='MP-WI-'+key,outputId='MP-EO-'+key,definitionId='MP-CALL-'+key,contextId='MP-CTX-'+key,sourcePath='story/material-production/plans/'+id+'.json';
 for(const [rows,objectId] of [[c.model.assetFamilies,familyId],[c.model.materialWorkItems,workId],[c.model.workItems,workId],[c.model.expectedOutputs,outputId],[c.view.recipes.executionDefinitions,definitionId],[c.model.reviewContexts,contextId]])if((rows||[]).some(r=>r.id===objectId))fail('首次素材制作身份已经存在');
 const graph=structuredClone(c.graph),afterRepresentation=graph.representations.find(r=>r.id===c.representation.id);afterRepresentation.assetFamilyIds=[familyId];
 const configuration=c.model.systemConfiguration?.config?.domain||defaultDomainConfiguration();validateDomainGraph(graph,{configuration,sourceBindings:evidenceBindings(graph),knownFamilyIds:[...c.model.assetFamilies.map(r=>r.id),familyId],knownRequirementIds:c.model.materialRequirements.map(r=>r.id)});await verifyDomainWorkspaceEvidence(tx,graph,c.graph);await verifyQuotes(tx,graph);await validateIdentities(tx,graph,c.view);
 const graphHash=domainHash(graph),configurationBinding=structuredClone(c.requirement.configurationBinding),reviewSpec=configurationBinding.reviewSpec;
 const lifecycle={lifecycleState:'READY_TO_START',outputState:'NOT_PRODUCED',reviewDecision:null,projectRightsGate:'UNKNOWN',canFlowDownstream:false,flowBlockReasons:['OUTPUT_NOT_PRESENT']};
 const targetPath='media/_review_pending/material-production/'+familyId+'/V001'+(c.demand.mediaType==='IMAGE'?'.png':'.wav');
 const assetFamily={id:familyId,label:c.requirement.title,kind:c.demand.mediaType,subtype:c.representation.type,ownerRef:workId,reviewOwner:'MATERIAL',episodeIds:c.requirement.episodeIds||[],episodeUids:c.requirement.episodeUids||[],sceneIds:c.requirement.sceneIds||[],shotIds:c.requirement.shotIds||[],segmentIds:[],usedByRefs:[],requirementRefs:[c.requirement.id],materialRequirementRefs:[c.requirement.id],currentVersionId:null,versionRefs:[],currentExpectedOutputId:outputId,expectedOutputRefs:[outputId],sourceRef:sourcePath,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',materialProductionPlanId:id,...lifecycle};
 const base=structuredClone(c.view.snapshot);base.productionModel.assetFamilies.push(assetFamily);const directorySource=await materialDirectorySource(tx,c.model);
 const projected=projectDomainGraph(base,graph,{revisionId:'material-production:'+id,sha256:graphHash},{eventVersions:c.view.eventsByKind?.['asset-version']||[],preserveReferencePolicies:true,directorySource:directorySource.content||c.model.materialDirectory?directorySource:undefined});
 const family=projected.productionModel.assetFamilies.find(r=>r.id===familyId),requirementAfter={...projected.productionModel.materialRequirements.find(r=>r.id===c.requirement.id),sourceRef:sourcePath+'#requirement',materialWorkItemRef:workId,plannedAssetFamilyId:familyId};
 const inputs=[];for(const b of content.inputBindings)inputs.push({...await registeredInput(tx,c.model,c.state,b),order:inputs.length+1});
 const referenceReasons=domainReferenceEligibility({...projected.productionModel,assetFamiliesById:{...c.state.assetFamiliesById,[familyId]:family},assetVersionsById:c.state.assetVersionsById},familyId,inputs);if(referenceReasons.length)fail('参考母版或关系未满足：'+referenceReasons.join('、'));
 const workContext={id:contextId,schemaVersion:'2.0',scopeType:'PROJECT',scopeId:c.view.profile.instanceId,semanticStatus:'AUTHORED_DRAFT',reviewable:true,requirementId:c.requirement.id,requirementHash:requirementAfter.requirementHash,representationId:c.representation.id,sourceRefs:[sourcePath],binding:{requirementId:c.requirement.id,requirementHash:requirementAfter.requirementHash,domainContextHash:family.domainContext.hash,bindingStatus:'CURRENT',mismatchReasons:[]},judgment:{purpose:{class:'A',text:c.requirement.title,evidenceRefs:[sourcePath]},acceptanceCriteria:c.requirement.acceptanceCriteria||[]}};workContext.contextHash=domainHash(workContext);
 const materialWorkItem={id:workId,label:c.requirement.title,lane:'MATERIAL_PREP',workflowStepId:null,requirementRef:c.requirement.id,requirementHash:requirementAfter.requirementHash,isNewRequirement:true,scopeType:c.requirement.reuseScope||'PROJECT',scopeId:c.requirement.id,episodeIds:c.requirement.episodeIds||[],episodeUids:c.requirement.episodeUids||[],sceneIds:c.requirement.sceneIds||[],shotIds:c.requirement.shotIds||[],inputAssetRefs:content.inputBindings.map(b=>b.familyId),outputAssetRef:familyId,additionalOutputAssetRefs:[],consumerWorkItemRefs:[],sourceRef:sourcePath,executionDefinitionRef:definitionId,promptRef:definitionId+':r1',reviewContextRef:contextId,definitionAuthoringState:'DEFINED',definitionStatus:'DEFINED',declaredExecutionGate:'READY_TO_START',applicabilityState:'REQUIRED',scopeRole:'CURRENT',activeInCurrentProduction:true,activityRole:'CURRENT_PRODUCTION',materialProductionPlanId:id,configurationBinding,reviewSpec,requiredSceneConfirmationIds:(configurationBinding.workflow?.materialPrerequisites||[]).filter(r=>r.requirementIds.includes(c.requirement.id)).flatMap(r=>r.requiredSceneIds),...lifecycle};
 const expectedOutput={id:outputId,familyId,label:c.requirement.title,mediaType:c.demand.mediaType,targetPath,plannedVersionLabel:'V001',legacyVersionId:outputId,expectationState:'PLANNED',realizedVersionId:null,sourceRef:sourcePath,executionDefinitionRef:definitionId,scopeRole:'CURRENT',activityRole:'CURRENT_PRODUCTION',materialProductionPlanId:id};
 const {inputBindings,...authoringContent}=content;
 const executionDefinition={id:definitionId,title:c.requirement.title,pipelineStageCode:'MATERIAL_PREP',executorKind:'MODEL_CALL',definitionStatus:'DEFINED',workItemRef:workId,currentRevisionId:definitionId+':r1',materialRequirementRef:c.requirement.id,materialRequirementHash:requirementAfter.requirementHash,materialProductionPlanId:id,upload:{rawText:inputs.map(b=>b.path).join('\n'),items:inputs},model:{branch:content.model,rawRule:content.model,resolution:String(content.parameters.resolution||'EXPLICIT_PARAMETERS')},parameters:content.parameters,parametersRaw:canonicalJson(content.parameters),prompt:{main:content.prompt,negative:content.negativePrompt,negativeApplication:content.negativePrompt?'APPLY_WITH_MAIN_PROMPT':'NONE'},output:{path:targetPath,mediaType:c.demand.mediaType,assetFamilyRef:familyId,expectedOutputRef:outputId},declaredGate:'READY_TO_START',rawSourceBlock:canonicalJson(authoringContent),authoringContent,parentVersionId:null,definitionHashSchemaVersion:SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA};executionDefinition.definitionHash=executionDefinitionHash(executionDefinition);
 const promptRevision={id:executionDefinition.currentRevisionId,executionDefinitionId:definitionId,definitionHash:executionDefinition.definitionHash,prompt:executionDefinition.prompt};
 let directoryBinding=null;const targetBindings=(directorySource.content?.directoryBindings||[]).filter(b=>b.requirementId===c.requirement.id);
 if(targetBindings.length>1)fail('素材目录需求归属不唯一');
 if(targetBindings.length){
  const beforeBinding=targetBindings[0];if(beforeBinding.representationId!==c.representation.id||beforeBinding.requirementHash!==c.requirement.requirementHash||beforeBinding.representationHash!==domainHash(c.representation))fail('素材目录绑定已失效，不能借建档更新陈旧归属');
  const afterBinding={...beforeBinding,requirementHash:requirementAfter.requirementHash,representationHash:domainHash(afterRepresentation)},afterContent={...structuredClone(directorySource.content),directoryBindings:directorySource.content.directoryBindings.map(b=>b.requirementId===c.requirement.id?afterBinding:structuredClone(b))};
  directoryBinding={requirementId:c.requirement.id,before:{revisionId:directorySource.revisionId,sha256:directorySource.sha256},after:{sha256:domainHash(afterContent)},beforeBinding,afterBinding,beforeContent:directorySource.content,afterContent};
 }
 const plan={schemaVersion:'MATERIAL_PRODUCTION_PLAN_V1',id,requirementId:c.requirement.id,representationId:c.representation.id,draftRevisionId,baseReleaseId:c.view.releaseId,basis:c.basis,basisHash:c.basisHash,graphBinding:{before:c.basis.graphRef,after:{sha256:graphHash},requirement:c.demand,representationId:c.representation.id,beforeRepresentation:c.representation,afterRepresentation},directoryBinding,requirementBefore:c.requirement,requirementAfter,assetFamily:family,expectedOutput,materialWorkItem,workContext,executionDefinition,promptRevision,configurationBinding,reviewSpecRef:reviewSpec.hash,authoringContent:content,inputBindings};
 return {plan,graph,projected};
}
export async function previewMaterialProduction(tx,input,{api}){
 const c=await context(tx,input.requirementId,api),record=await tx.getAux(MATERIAL_PRODUCTION_NS.drafts,input.requirementId),draft=read(record);
 if(!draft||record.revisionId!==input.draftRevisionId||draft.baseReleaseId!==c.view.releaseId||draft.basisHash!==c.basisHash)fail('建档草稿、发布基线或需求输入已变化');if(c.blockers.length)fail(c.blockers.join('、'));
 const {plan}=await compile(tx,c,draft.content,record.revisionId);return {plan,previewHash:domainHash(plan),modelCalls:0,formalAdoptionPerformed:false};
}
export async function enqueueMaterialProduction(tx,input,{api}){
 productionId(input.requestId);const previous=read(await tx.getAux(MATERIAL_PRODUCTION_NS.requests,input.requestId));if(previous){if(previous.requestHash!==domainHash(input))fail('请求身份已经用于其他建档内容');return previous.result;}
 const preview=await previewMaterialProduction(tx,input,{api});if(preview.previewHash!==input.previewHash)fail('建档预览已经变化');
 if((await tx.listAux(MATERIAL_PRODUCTION_NS.jobs)).map(read).some(j=>j?.requirementId===input.requirementId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('此需求已有待处理任务');
 const meta=await tx.getMetadata(),job={jobId:'material_production_'+randomUUID(),requirementId:input.requirementId,createdAt:new Date().toISOString(),status:'QUEUED',instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,input,preview};await put(tx,MATERIAL_PRODUCTION_NS.jobs,job.jobId,job);const result={jobId:job.jobId,status:job.status,modelCalls:0};await put(tx,MATERIAL_PRODUCTION_NS.requests,input.requestId,{requestHash:domainHash(input),result});return result;
}
/** Host worker only. This transaction publishes definitions, never media or reviews. */
export async function applyMaterialProductionJob(tx,{jobId,api}){
 const record=await tx.getAux(MATERIAL_PRODUCTION_NS.jobs,jobId),job=read(record);if(job?.status==='SUCCEEDED')return job.result;if(job?.status!=='QUEUED')fail('建档任务不能自动重试');
 const meta=await tx.getMetadata();if(meta.instanceId!==job.instanceId||meta.runtimeEpoch!==job.runtimeEpoch)fail('建档任务的实例或运行代次已变化');
 const preview=await previewMaterialProduction(tx,job.input,{api});if(preview.previewHash!==job.preview.previewHash)fail('工作器执行前建档预览已变化');
 const c=await context(tx,job.requirementId,api),draft=read(await tx.getAux(MATERIAL_PRODUCTION_NS.drafts,job.requirementId)),compiled=await compile(tx,c,draft.content,job.input.draftRevisionId),plan=compiled.plan;
 if(c.revision)return publishRevision(tx,c,plan,job,record);
 const graphRecord=await put(tx,'domain-graph','current',compiled.graph,plan.graphBinding.before.revisionId);if(graphRecord.sha256!==plan.graphBinding.after.sha256)fail('领域图谱写入 SHA 不一致');
 const sourcePath='story/material-production/plans/'+plan.id+'.json',source=await tx.putDocument({documentId:'material-production:'+plan.id,aliases:[sourcePath],expectedRevisionId:null,bytes:canonicalJson(plan),mediaType:'application/json',metadata:{sourceRole:'MATERIAL_PRODUCTION_PLAN'}});
 const snapshot=compiled.projected,model=snapshot.productionModel;model.domainGraphRef={revisionId:graphRecord.revisionId,sha256:graphRecord.sha256};snapshot.creativeLineage={...snapshot.creativeLineage,domainGraphRef:model.domainGraphRef};
 // Projection may attach new source references to every domain row. Preserve all
 // unrelated frozen rows exactly; only the explicit target acquires this family.
 model.materialRequirements=c.model.materialRequirements.map(r=>r.id===plan.requirementId?plan.requirementAfter:structuredClone(r));
 model.assetFamilies=model.assetFamilies.map(f=>f.id===plan.assetFamily.id?plan.assetFamily:structuredClone(c.model.assetFamilies.find(old=>old.id===f.id)||f));
 let directoryRecord=null;if(plan.directoryBinding){const binding=plan.directoryBinding;directoryRecord=await put(tx,'material-directory','current',binding.afterContent,binding.before.revisionId);if(directoryRecord.sha256!==binding.after.sha256)fail('素材目录写入 SHA 不一致');model.materialDirectory=refreshDirectoryProjection(model,{content:binding.afterContent,revisionId:directoryRecord.revisionId,sha256:directoryRecord.sha256});if(model.materialDirectory.staleIds.includes(plan.requirementId))fail('建档后素材目录归属未能保持');}
 model.expectedOutputs=[...(model.expectedOutputs||[]),plan.expectedOutput];model.materialWorkItems=[...(model.materialWorkItems||[]),plan.materialWorkItem];model.reviewContexts=[...(model.reviewContexts||[]),plan.workContext];
 const sourceEnvelope={sourceRef:sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256},recipes=structuredClone(c.view.recipes);recipes.executionDefinitions.push({...plan.executionDefinition,...sourceEnvelope});recipes.promptRevisions=[...(recipes.promptRevisions||[]),{...plan.promptRevision,...sourceEnvelope}];
 model.materialProductionPlans=[...(model.materialProductionPlans||[]),{id:plan.id,requirementId:plan.requirementId,representationId:plan.representationId,familyId:plan.assetFamily.id,workItemId:plan.materialWorkItem.id,expectedOutputId:plan.expectedOutput.id,definitionId:plan.executionDefinition.id,requirementHash:plan.requirementAfter.requirementHash,basisHash:plan.basisHash,graphRevisionId:graphRecord.revisionId,graphSha256:graphRecord.sha256,...(directoryRecord?{directoryRevisionId:directoryRecord.revisionId,directorySha256:directoryRecord.sha256}:{}),sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256}];
 snapshot.snapshotId='snapshot_'+domainHash({previous:c.view.snapshot.snapshotId,plan:plan.id,sourceSha256:source.sha256}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
 const release=await tx.publishRelease({snapshot,recipes,expectedReleaseId:c.view.releaseId,sourceRevisionIds:[...c.view.sourceRevisionIds,source.revisionId]}),result={releaseId:release.releaseId,planId:plan.id,familyId:plan.assetFamily.id,workItemId:plan.materialWorkItem.id,expectedOutputId:plan.expectedOutput.id,definitionId:plan.executionDefinition.id,sourceRevisionId:source.revisionId,requirementHash:plan.requirementAfter.requirementHash,modelCalls:0,actualMediaCreated:false,formalAdoptionPerformed:false};
 await put(tx,MATERIAL_PRODUCTION_NS.jobs,jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
export async function runMaterialProductionIteration({repository,api}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能发布素材建档');
 const job=await repository.readTransaction(async tx=>(await tx.listAux(MATERIAL_PRODUCTION_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]);if(!job)return {processed:false};
 try{return {processed:true,status:'SUCCEEDED',...await repository.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:job.jobId,api}))};}catch(e){await repository.writeTransaction(async tx=>{const record=await tx.getAux(MATERIAL_PRODUCTION_NS.jobs,job.jobId),current=read(record);if(current?.status==='QUEUED')await put(tx,MATERIAL_PRODUCTION_NS.jobs,job.jobId,{...current,status:'FAILED',error:String(e.message||e).slice(0,1500)},record.revisionId);});return {processed:true,jobId:job.jobId,status:'FAILED'};}
}

async function publishRevision(tx,c,plan,job,record){
 const source=await tx.putDocument({documentId:'material-production-recipe:'+plan.id,aliases:[plan.sourcePath],expectedRevisionId:null,bytes:canonicalJson(plan),mediaType:'application/json',metadata:{sourceRole:plan.schemaVersion===LEGACY_AUDIO_SCHEMA?LEGACY_AUDIO_SOURCE:'MATERIAL_PRODUCTION_RECIPE'}});
 const snapshot=structuredClone(c.view.snapshot),model=snapshot.productionModel,recipes=structuredClone(c.view.recipes),sourceEnvelope={sourceRef:plan.sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256};
 model.assetFamilies=model.assetFamilies.map(f=>f.id===plan.assetFamily.id?plan.assetFamily:f);
 model.materialWorkItems=model.materialWorkItems.map(w=>w.id===plan.materialWorkItem.id?plan.materialWorkItem:w);
 model.expectedOutputs.push(plan.expectedOutput);
 recipes.executionDefinitions.push({...plan.executionDefinition,...sourceEnvelope});recipes.promptRevisions.push({...plan.promptRevision,...sourceEnvelope});
 const revisionKey=plan.schemaVersion===LEGACY_AUDIO_SCHEMA?'legacyMaterialRecipeRevisions':'materialProductionRecipeRevisions';
 model[revisionKey]=[...(model[revisionKey]||[]),{id:plan.id,...(plan.materialProductionPlanId?{materialProductionPlanId:plan.materialProductionPlanId}:{}),requirementId:plan.requirementId,representationId:plan.representationId,familyId:plan.assetFamily.id,workItemId:plan.materialWorkItem.id,expectedOutputId:plan.expectedOutput.id,definitionId:plan.executionDefinition.id,definitionHash:plan.executionDefinition.definitionHash,previousDefinitionId:plan.previousDefinitionId,previousExpectedOutputId:plan.previousExpectedOutputId,parentVersionId:plan.parentVersionId,parentVersionSha256:plan.parentVersionSha256,requirementHash:plan.requirementAfter.requirementHash,basisHash:plan.basisHash,sourcePath:plan.sourcePath,sourceRevisionId:source.revisionId,sourceSha256:source.sha256}];
 const documents=[...await Promise.all(c.view.sourceRevisionIds.map(id=>tx.readDocumentRevision(id))),source];
 // Publication must itself prove that the entire old/new immutable closure can
 // survive source synchronization; do not defer that validation to the next sync.
 preserveMaterialProductionProjection({snapshot,recipes,baseSnapshot:snapshot,baseRecipes:recipes,documents});
 snapshot.snapshotId='snapshot_'+domainHash({previous:c.view.snapshot.snapshotId,revision:plan.id,sourceSha256:source.sha256}).slice(0,32);recipes.snapshotId=snapshot.snapshotId;
 const release=await tx.publishRelease({snapshot,recipes,expectedReleaseId:c.view.releaseId,sourceRevisionIds:[...c.view.sourceRevisionIds,source.revisionId]}),result={releaseId:release.releaseId,mode:plan.schemaVersion===LEGACY_AUDIO_SCHEMA?LEGACY_AUDIO_MODE:'REVISION',planId:plan.materialProductionPlanId||plan.id,recipeRevisionId:plan.id,familyId:plan.assetFamily.id,workItemId:plan.materialWorkItem.id,expectedOutputId:plan.expectedOutput.id,definitionId:plan.executionDefinition.id,sourceRevisionId:source.revisionId,requirementHash:plan.requirementAfter.requirementHash,parentVersionId:plan.parentVersionId,plannedVersionLabel:plan.expectedOutput.plannedVersionLabel,modelCalls:0,actualMediaCreated:false,formalAdoptionPerformed:false};
 await put(tx,MATERIAL_PRODUCTION_NS.jobs,job.jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
