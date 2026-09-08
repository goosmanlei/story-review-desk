import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {domainReferenceEligibility} from './domain-reference.mjs';
import {executionDefinitionHash,inspectExecutionDefinitionHash,SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA} from './execution-definition-hash.mjs';

export const LEGACY_AUDIO_MODE='LEGACY_AUDIO_REVISION';
export const LEGACY_AUDIO_SCHEMA='LEGACY_AUDIO_RECIPE_REVISION_V1';
export const LEGACY_AUDIO_SOURCE='LEGACY_MATERIAL_RECIPE_REVISION';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_CONFLICT'});};
const one=(rows,predicate,label)=>{const found=(rows||[]).filter(predicate);if(found.length!==1)fail(label+'必须精确且唯一');return found[0];};
const latest=rows=>[...rows].sort((a,b)=>(b.eventSequence||0)-(a.eventSequence||0))[0]||null;
const heads=(rows,key)=>[...new Set(rows.map(r=>r[key]))].map(id=>latest(rows.filter(r=>r[key]===id)));
const binding=e=>e?{eventId:e.eventId,eventSequence:e.eventSequence,sha256:domainHash(e)}:null;
const state=r=>r.runState||r.state;
const isSha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export function legacyAudioTarget(output,familyId,label=output.plannedVersionLabel){
 if(!/^[A-Za-z0-9_-]+$/.test(familyId)||!/^V\d{3,}$/.test(label||'')||!/^V\d{3,}$/.test(output.plannedVersionLabel||''))fail('旧声音族与版本标签不支持精确版本路径');
 const match=/^production\/generated\/05_audio\/([A-Za-z0-9_-]+)_V\d{3,}\.wav$/.exec(output.targetPath||'');
 if(!match||!output.targetPath.endsWith('_'+output.plannedVersionLabel+'.wav'))fail('旧声音输出必须是明确版本的受控 WAV 路径');
 const filename=match[1]+'_'+label+'.wav';
 return {logical:'production/generated/05_audio/'+filename,physical:'media/_review_pending/'+familyId+'/'+filename};
}
async function pinnedDocument(tx,view,path){
 const doc=await tx.getPublishedDocument(path);
 if(!doc||doc.deleted||!view.sourceRevisionIds.includes(doc.revisionId)||sha256(doc.bytes)!==doc.sha256||(await tx.readDocument(doc.documentId))?.revisionId!==doc.revisionId)fail('旧声音来源必须精确绑定当前发布修订：'+path);
 return doc;
}
function sourceBinding(doc,path){return {documentId:doc.documentId,revisionId:doc.revisionId,sha256:doc.sha256,path};}
async function initialSource(tx,c,definition,output){
 const source=definition.source;if(!source?.path||!source.jsonPath||!isSha(source.blockSha256))fail('旧声音配方缺少直接 Prompt 与机器规格来源');
 const direct=await pinnedDocument(tx,c.view,source.path),machine=await pinnedDocument(tx,c.view,source.jsonPath);
 for(const doc of [direct,machine]){const rows=(c.view.recipes.sourceCatalog||[]).filter(r=>doc.aliases.includes(r.path));if(rows.length!==1||rows[0].sha256!==doc.sha256)fail('旧声音来源与配方目录 SHA 不一致');}
 if(direct.metadata?.sourceRole!=='DIRECT_PROMPT'||sha256(definition.rawSourceBlock||'')!==source.blockSha256||!Buffer.from(direct.bytes).toString('utf8').includes(definition.rawSourceBlock))fail('旧声音直接 Prompt 段落与精确发布字节不一致');
 let spec,parameters;try{spec=JSON.parse(Buffer.from(machine.bytes).toString('utf8'));parameters=JSON.parse(definition.parametersRaw);}catch{fail('旧声音机器规格或参数不是合法 JSON');}
 const asset=one(spec.assets,a=>a.asset_id===c.family.id,'旧声音机器规格');
 if(asset.model!=='seed-audio-1.0'||asset.model!==definition.model?.branch||asset.text_prompt!==definition.prompt?.main||String(asset.negative_prompt||'').trim()!==String(definition.prompt?.negative||'').trim()||asset.output_path!==output.targetPath||!same(asset.audio_config,parameters.audio_config)||!same(asset.delivery,parameters.delivery)||!same(asset.watermark||{},{})||asset.metadata?.SUBJECT_ID!==c.representation.entityId||!asset.metadata?.VOICE_ID)fail('旧声音配方、身份、完整参数或固定输出与机器源不一致');
 return {sources:[sourceBinding(direct,source.path),sourceBinding(machine,source.jsonPath)],asset};
}
/** A migrated registry requirement may be referenced by the current graph without
 * becoming a DOMAIN_GRAPH demand. Preserve that provenance, never mint a demand. */
export async function legacyAudioRevisionContext(tx,{view,model,graph,current,state:operational,requirementId,api}){
 if((model.materialProductionPlans||[]).some(p=>p.requirementId===requirementId))return null;
 const requirements=(model.materialRequirements||[]).filter(r=>r.id===requirementId);if(requirements.length!==1)return null;
 const requirement=requirements[0],familyIds=requirement.assetFamilyRefs||[];
 if(!familyIds.length)return null;
 const family=one(model.assetFamilies,f=>familyIds.includes(f.id),'旧声音素材族');if(family.kind!=='AUDIO')return null;
 if(familyIds.length!==1||requirement.requirementClass!=='REQUIRED'||!['CURRENT',undefined].includes(requirement.scopeRole)||requirement.activeInCurrentProduction===false||requirement.bindingStale||family.scopeRole!=='CURRENT')fail('旧声音修订只支持当前精确必需需求');
 const representation=one(graph.representations,r=>(r.requirementIds||[]).includes(requirementId),'旧声音当前表现');
 if(!same(representation.assetFamilyIds,[family.id])||!same(representation.requirementIds,[requirementId])||representation.unresolved?.length||representation.entityId.startsWith('UNKNOWN:')||!graph.entities.some(e=>e.id===representation.entityId))fail('旧声音需求与当前表现、实体不闭合');
 if(graph.representations.filter(r=>(r.assetFamilyIds||[]).includes(family.id)).length!==1)fail('旧声音族关联多个表现');
 const work=one(model.materialWorkItems,w=>w.requirementRef===requirementId,'旧声音工作项');
 if(requirement.materialWorkItemRef!==work.id||family.ownerRef!==work.id||work.outputAssetRef!==family.id||work.scopeRole!=='CURRENT'||work.activeInCurrentProduction===false||work.requirementHash!==requirement.requirementHash||!isSha(requirement.requirementHash)||!requirement.reviewSpec?.hash)fail('旧声音当前工作、素材族或冻结标准不一致');
 const definition=one(view.recipes.executionDefinitions,d=>d.id===work.executionDefinitionRef,'旧声音当前调用定义'),output=one(model.expectedOutputs,o=>o.id===family.currentExpectedOutputId,'旧声音当前预期产物');
 if(definition.executorKind!=='AUDIO_MODEL'||definition.model?.branch!=='seed-audio-1.0'||!inspectExecutionDefinitionHash(definition).valid||definition.workItemRef!==work.id||definition.materialRequirementRef!==requirementId||definition.materialRequirementHash!==requirement.requirementHash||output.familyId!==family.id||output.executionDefinitionRef!==definition.id||definition.output?.expectedOutputRef!==output.id||definition.output?.assetFamilyRef!==family.id||definition.output?.mediaType!=='AUDIO'||definition.output?.path!==output.targetPath||!(family.expectedOutputRefs||[]).includes(output.id))fail('旧声音 EO、工作和完整调用定义哈希不闭合');
 const head=await tx.getAux('domain-graph','current');if(head?.revisionId!==current.revisionId||head.sha256!==model.domainGraphRef?.sha256||head.sha256!==domainHash(graph))fail('旧声音当前领域绑定已变化');
 const c={view,model,graph,requirement,representation,family,work,definition,output},rows=model.legacyMaterialRecipeRevisions||[],row=rows.find(r=>r.definitionId===definition.id);
 let origin;
 if(definition.legacyMaterialRecipeRevisionId){
  if(!row||row.id!==definition.legacyMaterialRecipeRevisionId)fail('旧声音后继配方缺少受控源记录');
  const doc=await pinnedDocument(tx,view,row.sourcePath),body=JSON.parse(Buffer.from(doc.bytes).toString('utf8'));
  if(doc.revisionId!==row.sourceRevisionId||doc.sha256!==row.sourceSha256||doc.metadata.sourceRole!==LEGACY_AUDIO_SOURCE||body.schemaVersion!==LEGACY_AUDIO_SCHEMA||!same(definition,{...body.executionDefinition,sourceRef:row.sourcePath,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256}))fail('旧声音后继固定源不一致');
  origin={sources:[sourceBinding(doc,row.sourcePath)],asset:body.seedAsset};
 }else origin=await initialSource(tx,c,definition,output);
 const sourceLease=await tx.getAux('source-operation-host','lease');
 const events=view.eventsByKind||{},candidates=(events['asset-version']||[]).filter(e=>e.familyId===family.id),parents=candidates.filter(e=>e.expectedOutputId===output.id),parent=latest(parents),blockers=[];
 if(sourceLease&&!sourceLease.deleted)blockers.push('源同步租约尚未释放，旧声音修订须等待当前任务完成');
 if(!parent||parents.length!==1)blockers.push('当前旧声音预期产物须有唯一实际候选');
 const requests=heads((events['execution-request']||[]).filter(e=>e.workItemId===work.id||e.familyId===family.id),'executionRequestId');
 const definitions=new Set(view.recipes.executionDefinitions.filter(d=>d.workItemRef===work.id).map(d=>d.id)),runs=heads((events.run||[]).filter(e=>definitions.has(e.executionDefinitionId)||requests.some(q=>q.executionRequestId===e.executionRequestId)),'runId');
 for(const run of runs)if(['PLANNED','SUBMITTED','RUNNING','RESULT_UNKNOWN'].includes(state(run))||state(run)==='SUCCEEDED'&&!candidates.some(e=>e.runId===run.runId&&e.executionRequestId===run.executionRequestId&&e.callPackageHash===run.callPackageHash))blockers.push('旧声音仍有未核清 Run：'+run.runId);
 for(const request of requests){const rr=runs.filter(r=>r.executionRequestId===request.executionRequestId),count=candidates.filter(e=>e.executionRequestId===request.executionRequestId).length;if(count>=Math.max(1,Number(request.maxOutputs)||1))continue;if(!['CONSUMED','FAILED','CANCELLED','REVOKED','COMPLETED'].includes(request.requestState||request.status)&&(!rr.length||rr.some(r=>!['FAILED','CANCELLED'].includes(state(r)))))blockers.push('旧声音仍有未完成授权：'+request.executionRequestId);}
 const reviews=(events.review||[]).filter(e=>e.subjectType==='ASSET'&&(e.familyId||e.subjectId)===family.id&&e.applicationStatus==='APPLIED'&&e.effect==='APPLIED'),review=latest(reviews);
 if(!parent||review?.action!=='REQUEST_REVISION'||review.versionId!==parent.versionId||review.versionSha256!==parent.sha256)blockers.push('旧声音后继须先对当前精确候选正式要求修改');
 let media=null;
 if(parent){
  const run=runs.find(r=>r.runId===parent.runId),request=requests.find(r=>r.executionRequestId===parent.executionRequestId),version=operational.assetVersionsById?.[parent.versionId];
  media=await tx.getMedia(family.id,parent.versionId);const resolved=await tx.resolveMedia(parent.path,{versionId:parent.versionId,sha256:parent.sha256});
  if(parent.versionId!==family.id+'@'+output.plannedVersionLabel||!isSha(parent.sha256)||parent.executionDefinitionId!==definition.id||parent.callPackageHash!==definition.definitionHash||parent.path!==output.targetPath||!run||state(run)!=='SUCCEEDED'||run.executionDefinitionId!==definition.id||run.callPackageHash!==definition.definitionHash||run.executionRequestId!==parent.executionRequestId||!request||request.executionDefinitionId!==definition.id||request.callPackageHash!==definition.definitionHash||!same(parent.inputBindings||[],request.inputBindings||[])||!version||version.sha256!==parent.sha256||!media||media.sha256!==parent.sha256||!resolved||resolved.mediaId!==media.mediaId||resolved.versionId!==media.versionId||resolved.relativePath!==media.relativePath||resolved.sha256!==media.sha256||media.availability!=='PRESENT'||!['FORMAL','IMPORTED_EVIDENCE'].includes(media.metadata?.authorityDomain)||!['PUBLIC',undefined].includes(media.metadata?.visibility)||media.metadata?.sourceRole==='ORIGINAL_SOURCE'||(await mediaRetirementOverlay(tx,media)).state!=='ACTIVE')blockers.push('旧声音父候选的真实 Run、请求或登记媒体闭包不完整');
  else {if(!api.safeGeneratedPath)fail('缺少旧声音实际文件 SHA 核验器');await api.safeGeneratedPath(parent.path,{versionId:parent.versionId,sha256:parent.sha256});}
 }
 const labels=(model.expectedOutputs||[]).filter(o=>o.familyId===family.id).map(o=>o.plannedVersionLabel);if(labels.some(l=>!/^V\d{3,}$/.test(l||''))||new Set(labels).size!==labels.length)fail('旧声音版本标签不唯一');
 const plannedVersionLabel='V'+String(Math.max(...labels.map(l=>Number(l.slice(1))))+1).padStart(3,'0'),target=legacyAudioTarget(output,family.id,plannedVersionLabel);
 if((model.expectedOutputs||[]).some(o=>o.targetPath===target.logical)||(await tx.listMedia()).some(m=>m.relativePath===target.physical))fail('旧声音后继输出路径已被占用');
 const meta=await tx.getMetadata(),revisionBasis={mode:LEGACY_AUDIO_MODE,sourceLeaseRevisionId:sourceLease&&!sourceLease.deleted?sourceLease.revisionId:null,familyId:family.id,workItemId:work.id,definitionId:definition.id,definitionHash:definition.definitionHash,expectedOutputId:output.id,expectedOutputHash:domainHash(output),sourceBindings:origin.sources,parentMedia:media?{mediaId:media.mediaId,versionId:media.versionId,relativePath:media.relativePath,sha256:media.sha256,byteSize:media.byteSize}:null,parentVersionId:parent?.versionId||null,parentVersionSha256:parent?.sha256||null,parentCandidate:binding(parent),parentReview:binding(review),requestHeads:requests.map(binding),runHeads:runs.map(binding),plannedVersionLabel,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch};
 const basis={requirementId,requirementHash:requirement.requirementHash,requirement,representation,graphRef:{revisionId:current.revisionId,sha256:head.sha256},revision:revisionBasis};
 const defaults={model:definition.model.branch,prompt:definition.prompt.main,negativePrompt:definition.prompt.negative||'',parameters:JSON.parse(definition.parametersRaw),inputBindings:(definition.upload?.items||[]).map(b=>({familyId:b.assetFamilyRef,versionId:b.assetVersionRef,sha256:b.sha256}))};
 return {...c,state:operational,demand:{mediaType:'AUDIO'},basis,basisHash:domainHash(basis),blockers:[...new Set(blockers)],mode:LEGACY_AUDIO_MODE,revision:{mode:LEGACY_AUDIO_MODE,...c,parent,media,revisionBasis,plannedVersionLabel,target,origin,defaults}};
}
export async function compileLegacyAudioRevision(tx,c,content,draftRevisionId,registeredInput){
 const r=c.revision;if(content.model!=='seed-audio-1.0')fail('旧声音修订保持 Seed Audio 模型契约');
 const p=content.parameters;if(!p||!same(Object.keys(p).filter(k=>k!=='watermark').sort(),['audio_config','delivery'])||!same(p.watermark||{},{})||!same(p.delivery,r.origin.asset.delivery)||!same(p.audio_config,r.origin.asset.audio_config))fail('旧声音修订须保留完整冻结 audio_config 与 delivery，不能单边改变技术规格');
 const inputs=[];for(const b of content.inputBindings)inputs.push({...await registeredInput(tx,c.model,c.state,b),order:inputs.length+1});
 const reasons=domainReferenceEligibility({...c.model,assetFamiliesById:c.state.assetFamiliesById,assetVersionsById:c.state.assetVersionsById},r.family.id,inputs);if(reasons.length)fail('旧声音参考输入不符合关系门禁：'+reasons.join('、'));
 // Initial MVP preserves the provider reference shape; adding/cloning a reference
 // needs its own consent and Seed schema authoring, not merely a family binding.
 if(inputs.length||r.origin.asset.references?.length)fail('旧声音修订当前仅支持无模型参考的原创母版；谱系父版本不作为模型附件');
 const key=domainHash({familyId:r.family.id,draftRevisionId}).slice(0,24),id='LA-RECIPE-'+key,definitionId='LA-CALL-'+key,outputId='LA-EO-'+key,sourcePath='production/prompts/direct/material-recipe-revisions/'+id+'.json';
 const target=r.target.logical,{inputBindings,...authoringContent}=content;
 const seedAsset={...structuredClone(r.origin.asset),name_zh:r.family.label+' '+r.plannedVersionLabel,model:content.model,text_prompt:content.prompt,negative_prompt:content.negativePrompt,output_path:target,references:[],audio_config:p.audio_config,delivery:p.delivery,watermark:{},execution_gate:'READY_TO_START',metadata:{...r.origin.asset.metadata,PARENT_ASSETS:[r.parent.versionId],PARENT_VERSION_SHA256:r.parent.sha256,QA_STATUS:'TODO',RIGHTS_STATUS:'UNKNOWN',EXECUTION_GATE:'READY_TO_START'}};
 const expectedOutput={...r.output,id:outputId,targetPath:target,plannedVersionLabel:r.plannedVersionLabel,legacyVersionId:r.family.id+'@'+r.plannedVersionLabel,expectationState:'PLANNED',realizedVersionId:null,sourceRef:sourcePath,promptRef:sourcePath,executionDefinitionRef:definitionId,legacyMaterialRecipeRevisionId:id};
 const executionDefinition={id:definitionId,title:r.family.label,pipelineStageCode:r.definition.pipelineStageCode,executorKind:'AUDIO_MODEL',definitionStatus:'DEFINED',workItemRef:r.work.id,currentRevisionId:definitionId+':r1',materialRequirementRef:c.requirement.id,materialRequirementHash:c.requirement.requirementHash,legacyMaterialRecipeRevisionId:id,upload:{rawText:'无模型参考；父版本仅作谱系。',items:inputs},model:{branch:content.model,rawRule:content.model,resolution:'JSON'},parameters:p,parametersRaw:canonicalJson(p),prompt:{main:content.prompt,negative:content.negativePrompt,negativeApplication:'APPLY_WITH_MAIN_PROMPT'},output:{path:target,mediaType:'AUDIO',assetFamilyRef:r.family.id,expectedOutputRef:outputId},declaredGate:'READY_TO_START',rawSourceBlock:canonicalJson(authoringContent),authoringContent,parentVersionId:r.parent.versionId,parentVersionSha256:r.parent.sha256,definitionHashSchemaVersion:SHOT_PRODUCTION_DEFINITION_HASH_SCHEMA};executionDefinition.definitionHash=executionDefinitionHash(executionDefinition);
 const promptRevision={id:executionDefinition.currentRevisionId,executionDefinitionId:definitionId,definitionHash:executionDefinition.definitionHash,prompt:executionDefinition.prompt};
 const assetFamily={...r.family,currentExpectedOutputId:outputId,executionDefinitionRef:definitionId,expectedOutputRefs:[...r.family.expectedOutputRefs,outputId]},materialWorkItem={...r.work,executionDefinitionRef:definitionId,promptRef:executionDefinition.currentRevisionId,inputAssetRefs:[]};
 return {plan:{schemaVersion:LEGACY_AUDIO_SCHEMA,id,sourcePath,requirementId:c.requirement.id,representationId:c.representation.id,draftRevisionId,baseReleaseId:c.view.releaseId,basis:c.basis,basisHash:c.basisHash,previousDefinitionId:r.definition.id,previousExpectedOutputId:r.output.id,parentVersionId:r.parent.versionId,parentVersionSha256:r.parent.sha256,parentCandidate:r.parent,requirementBefore:c.requirement,requirementAfter:c.requirement,previousFamily:r.family,previousWork:r.work,previousDefinition:r.definition,previousOutput:r.output,assetFamily,materialWorkItem,expectedOutput,executionDefinition,promptRevision,authoringContent:content,inputBindings,seedAsset,sourceBindings:r.origin.sources}};
}
