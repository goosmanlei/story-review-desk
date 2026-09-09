import {canonicalJson,sha256} from './bytes.mjs';
import {domainHash} from './domain-model.mjs';
import {domainProductionSlice} from './domain-projection.mjs';
import {classifyDomainProductionCompatibility,domainProductionCompatibilityProofHash,validateDomainProductionCompatibilityRecord} from './domain-production-compatibility.mjs';
import {domainProductionProofs} from './domain-production-lineage.mjs';
import {executionDefinitionHash,inspectExecutionDefinitionHash} from './execution-definition-hash.mjs';
import {readRegisteredMediaBytes} from './media-read-lease.mjs';
import {mediaRetirementOverlay} from './media-retirement.mjs';
import {GUIDANCE_ALIASES,allowedGuidanceRole} from './guidance-aliases.mjs';
import {materialProductionPlanGraphClosure} from './material-production-preservation.mjs';

export const DOMAIN_COMPATIBILITY_NS='domain-production-compatibility';
const fail=message=>{throw Object.assign(new Error(message),{code:'DOMAIN_COMPATIBILITY_CONFLICT'});};
const ensure=(ok,message)=>{if(!ok)fail(message);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4000;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const unique=(rows,key)=>Array.isArray(rows)&&new Set(rows.map(r=>r?.[key])).size===rows.length;
const one=(rows,id,key='id')=>{const found=(rows||[]).filter(r=>r[key]===id);ensure(found.length===1,'对象不存在或身份不唯一：'+id);return found[0];};
const tuple=b=>({familyId:b.familyId||b.assetFamilyRef,versionId:b.versionId||b.assetVersionRef,sha256:b.sha256});
const ordered=rows=>[...rows].sort((a,b)=>(a.eventSequence||0)-(b.eventSequence||0)||String(a.recordedAt).localeCompare(String(b.recordedAt))||a.eventId.localeCompare(b.eventId));
const options=model=>({referencePolicies:model.domainReferencePolicyBindings||{},representationPolicies:model.domainRepresentationPolicyBindings||{},configuration:model.systemConfiguration?.config?.domain});
const refValid=ref=>exact(ref,['revisionId','sha256'])&&text(ref.revisionId)&&digest(ref.sha256);

function validateRequest(input){
 ensure(exact(input,['schemaVersion','operationId','expectedReleaseId','expectedRuntimeEpoch','beforeReleaseId','beforeGraphRef','afterGraphRef','versions','requirementIds','metadataApprovals','authorization','reason']), '须提供完整且精确的兼容确认清单');
 ensure(input.schemaVersion==='DOMAIN_PRODUCTION_COMPATIBILITY_REQUEST_V1'&&/^compatibility_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operationId||'')&&[input.expectedReleaseId,input.expectedRuntimeEpoch,input.beforeReleaseId,input.reason].every(text),'兼容确认身份或理由无效');
 ensure(refValid(input.beforeGraphRef)&&refValid(input.afterGraphRef),'必须绑定改前、改后领域图谱修订与 SHA');
 ensure(unique(input.versions,'versionId')&&input.versions.length<=100&&input.versions.every(v=>exact(v,['familyId','versionId','sha256'])&&text(v.familyId)&&text(v.versionId)&&digest(v.sha256)),'版本须为有限且不重复的精确族、版本、SHA');
 ensure(Array.isArray(input.requirementIds)&&input.requirementIds.length<=100&&input.requirementIds.every(text)&&new Set(input.requirementIds).size===input.requirementIds.length&&input.versions.length+input.requirementIds.length>0,'需求身份无效或确认范围为空');
 ensure(Array.isArray(input.metadataApprovals)&&input.metadataApprovals.length<=100&&input.metadataApprovals.every(a=>a&&typeof a==='object'&&!Array.isArray(a)),'叙事说明确认格式无效');
 const a=input.authorization;
 ensure(exact(a,['alias','revisionId','sha256','quote','confirmed'])&&[a.alias,a.revisionId,a.quote].every(text)&&GUIDANCE_ALIASES.includes(a.alias)&&digest(a.sha256)&&a.confirmed===true,'须绑定用户明确确认的已发布指引原句');
 return input;
}

function parseRelease(release){
 ensure(release&&sha256(release.snapshotBytes)===release.snapshotSha256&&sha256(release.recipesBytes)===release.recipesSha256,'发布快照或配方原字节不匹配');
 return {snapshot:JSON.parse(release.snapshotBytes),recipes:JSON.parse(release.recipesBytes)};
}
async function verifiedGraph(tx,model,ref){
 ensure(same(model.domainGraphRef,ref),'领域图谱与发布来源绑定不一致');
 const source=await tx.getAux('domain-graph','current',{revisionId:ref.revisionId});
 ensure(source&&!source.deleted&&source.sha256===ref.sha256&&sha256(source.bytes)===ref.sha256&&same(JSON.parse(source.bytes),model.domainGraph),'领域图谱原修订无法精确回读');
 return model.domainGraph;
}
function eventsBefore(events,at){
 ensure(Number.isFinite(Date.parse(at)),'历史发布时间无效');
 return Object.fromEntries(Object.entries(events).map(([kind,rows])=>[kind,rows.filter(e=>Number.isFinite(Date.parse(e.recordedAt))&&Date.parse(e.recordedAt)<=Date.parse(at))]));
}
function stateFor(api,snapshot,events,recipes){
 ensure(typeof api?.projectOperationalState==='function','缺少正式运行态校验器');
 return api.projectOperationalState(snapshot,events.review||[],events['asset-version']||[],events.run||[],events['source-operation']||[],events['execution-request']||[],{executionDefinitions:recipes.executionDefinitions});
}
function causesFor(model,versions){
 const causes=new Map();
 (model.domainInvalidations||[]).forEach((row,index)=>{for(const id of row.versionIds||[])if(versions.get(id)?.familyId===row.familyId)causes.set(id,new Set([...(causes.get(id)||[]),index]));});
 let changed=true;
 while(changed){changed=false;for(const version of versions.values())for(const input of (version.inputVersionBindings||[]).map(tuple)){
  const parent=versions.get(input.versionId);if(!parent||parent.familyId!==input.familyId||parent.sha256!==input.sha256)continue;
  for(const index of causes.get(parent.id)||[]){const target=causes.get(version.id)||new Set();if(!target.has(index)){target.add(index);causes.set(version.id,target);changed=true;}}
 }}
 return causes;
}
function contractOf(requirement){
 // These are the original acceptance/configuration facts, not projected scene
 // membership or host-native ownership links, which have separate exact proofs.
 return Object.fromEntries(['id','requirementClass','sourceKind','representationRef','entityRef','stateRef','mediaType','mediaKind','acceptanceCriteria','acceptanceProfile','configurationBinding','reviewSpec','productionLane','reuseScope'].map(k=>[k,requirement[k]??null]));
}
async function sourceCatalog(tx,release,model,familyIds){
 const result=new Map();
 const rows=[...(model.materialProductionPlans||[]),...(model.materialProductionRecipeRevisions||[])].filter(r=>familyIds.has(r.familyId));
 for(const id of new Set(rows.map(r=>r.sourceRevisionId))){ensure(text(id)&&release.sourceRevisionIds.includes(id),'原制作来源未包含在该次发布中');const d=await tx.readDocumentRevision(id);ensure(d&&!d.deleted&&sha256(d.bytes)===d.sha256,'已发布来源原字节不可用：'+id);for(const alias of d.aliases||[]){ensure(!result.has(alias),'发布来源别名不唯一：'+alias);result.set(alias,d);}}
 return result;
}
function unchangedDocument(before,after,alias){
 const a=before.get(alias),b=after.get(alias);ensure(a&&b&&a.revisionId===b.revisionId&&a.sha256===b.sha256&&Buffer.from(a.bytes).equals(Buffer.from(b.bytes)),'原制作定义或 Prompt 来源发生变化：'+alias);
 return {alias,revisionId:a.revisionId,sha256:a.sha256};
}

/** Host-only: reconstructs every proof from published history and registered
 * media under the repository transaction/lease. No client supplied proof is
 * accepted, and no candidate, review, run or generation authority is created. */
export async function previewDomainProductionCompatibility(tx,input,{api,instanceRoot}={}){
 validateRequest(input);ensure(text(instanceRoot),'缺少受管实例媒体根目录');
 const currentRelease=await tx.readRelease(),meta=await tx.getMetadata();
 ensure(currentRelease?.releaseId===input.expectedReleaseId&&meta.runtimeEpoch===input.expectedRuntimeEpoch,'发布版本或运行期已变化，请重新核验');
 ensure((await tx.getConfig('instance-profile'))?.revisionId===currentRelease.profileRevisionId,'存在未发布的实例配置');
 const oldRelease=await tx.readRelease(input.beforeReleaseId),before=parseRelease(oldRelease),after=parseRelease(currentRelease),view=await tx.readView();
 ensure(view.releaseId===currentRelease.releaseId&&view.instanceId===meta.instanceId,'当前事务发布视图不一致');
 const oldModel=before.snapshot.productionModel,model=after.snapshot.productionModel;
 ensure(before.snapshot.instance?.instanceId===meta.instanceId&&after.snapshot.instance?.instanceId===meta.instanceId,'历史与当前实例身份不一致');
 const oldGraph=await verifiedGraph(tx,oldModel,input.beforeGraphRef),graph=await verifiedGraph(tx,model,input.afterGraphRef),head=await tx.getAux('domain-graph','current');
 ensure(head?.revisionId===input.afterGraphRef.revisionId&&head.sha256===input.afterGraphRef.sha256,'存在未发布的领域图谱头');
 const authorization=await tx.getPublishedDocument(input.authorization.alias);
 ensure(authorization&&!authorization.deleted&&authorization.revisionId===input.authorization.revisionId&&authorization.sha256===input.authorization.sha256&&sha256(authorization.bytes)===authorization.sha256&&allowedGuidanceRole(authorization,input.authorization.alias)&&authorization.bytes.toString('utf8').includes(input.authorization.quote),'用户确认来源已变化或不属于项目指引');
 const authorizationRef=input.authorization.revisionId+':'+input.authorization.sha256;
 ensure(input.metadataApprovals.every(a=>a.authorizationRef===authorizationRef),'叙事兼容确认未绑定本次明确授权');
 const events=view.eventsByKind||{},historicEvents=eventsBefore(events,oldRelease.createdAt);
 const previousState=stateFor(api,before.snapshot,historicEvents,before.recipes),currentState=stateFor(api,after.snapshot,events,after.recipes);
 const versions=new Map(Object.values(currentState.assetVersionsById).map(v=>{
  const candidates=(events['asset-version']||[]).filter(c=>c.versionId===v.id),base=(model.assetVersions||[]).filter(c=>c.id===v.id);
  const definitionId=candidates.length===1?candidates[0].executionDefinitionId:candidates.length===0&&base.length===1?base[0].executionDefinitionRef:null;
  return [v.id,{...v,...(definitionId?{executionDefinitionRef:definitionId}:{})}];
 }));
 const causes=causesFor(model,versions),indexes=new Set(input.versions.flatMap(v=>[...(causes.get(v.versionId)||[])]));
 const oldInvalidations=oldModel.domainInvalidations||[],all=model.domainInvalidations||[];
 ensure(same(all.slice(0,oldInvalidations.length),oldInvalidations),'正式领域失效历史被改写');
 const occurrences=[...indexes].sort((a,b)=>a-b).map(index=>{
  const row=all[index];ensure(index>=oldInvalidations.length,'本次确认不能越过基线前的其他失效发生项');
  const old=one(oldModel.assetFamilies,row.familyId),now=one(model.assetFamilies,row.familyId);
  ensure(row.previousHash===old.domainContext?.hash&&row.currentHash===now.domainContext?.hash,'发生项与改前、改后局部契约不一致');
  ensure(all.filter((o,i)=>i>=oldInvalidations.length&&o.familyId===row.familyId).length===1,'同族经历多次变化，须逐次独立核验');
  return {index,hash:domainHash(row),familyId:row.familyId,previousHash:row.previousHash,currentHash:row.currentHash};
 });
 const familyIds=new Set([...input.versions.map(v=>v.familyId),...occurrences.map(o=>o.familyId)]),repIds=new Set(graph.representations.filter(r=>(r.assetFamilyIds||[]).some(id=>familyIds.has(id))).map(r=>r.id));
 for(const id of input.requirementIds)repIds.add(one(graph.requirements,id).representationId);
 const beforeSlice=domainProductionSlice(oldGraph,[...repIds],options(oldModel)),afterSlice=domainProductionSlice(graph,[...repIds],options(model));
 const classification=classifyDomainProductionCompatibility(beforeSlice,afterSlice,{metadataApprovals:input.metadataApprovals});
 ensure(classification.compatible&&classification.kind!=='EXACT','变化未被证明为兼容：'+classification.reasons.join('、'));
 const requirementBindings=input.requirementIds.map(id=>{
  const beforeDemand=one(oldGraph.requirements,id),afterDemand=one(graph.requirements,id),representation=one(graph.representations,afterDemand.representationId),oldRep=one(oldGraph.representations,beforeDemand.representationId);
  ensure(same(representation,oldRep),'表现定义发生变化');
  const beforeHash=domainHash({demand:beforeDemand,representation}),afterHash=domainHash({demand:afterDemand,representation});
  ensure(beforeHash!==afterHash&&one(model.materialRequirements,id).requirementHash===afterHash&&one(oldModel.materialRequirements,id).requirementHash===beforeHash,'范围桥须绑定真实新旧完整需求 Hash');
  return {requirementId:id,beforeHash,afterHash,representationId:representation.id,representationHash:domainHash(representation),beforeDemand,afterDemand};
 });
 const beforeDocs=await sourceCatalog(tx,oldRelease,oldModel,familyIds),afterDocs=await sourceCatalog(tx,currentRelease,model,familyIds),contractAudit=[],mediaAudit=[];
 const productionProofs=domainProductionProofs({candidates:events['asset-version']||[],requests:events['execution-request']||[],runs:events.run||[],versions,allowInputless:true});
 const mediaCache=new Map();
 async function actualMedia(binding,version){
  const key=binding.versionId+':'+binding.sha256;if(mediaCache.has(key))return;
  const media=await tx.getMedia(binding.familyId,binding.versionId);
  ensure(media&&media.availability==='PRESENT'&&media.sha256===binding.sha256&&media.metadata?.sourceRole!=='ORIGINAL_SOURCE'&&['FORMAL','IMPORTED_EVIDENCE'].includes(media.metadata?.authorityDomain)&&(await mediaRetirementOverlay(tx,media)).state==='ACTIVE','媒体登记缺失、非受管产物、已退役或 SHA 改变：'+binding.versionId);
  const resolved=await tx.resolveMedia(version.path,{versionId:binding.versionId,sha256:binding.sha256});
  ensure(resolved?.mediaId===media.mediaId&&resolved.versionId===media.versionId&&resolved.relativePath===media.relativePath&&resolved.byteSize===media.byteSize,'逻辑路径未精确绑定登记媒体');
  const bytes=await readRegisteredMediaBytes(instanceRoot,media);ensure(sha256(bytes)===binding.sha256,'实际媒体 SHA 不一致');
  mediaCache.set(key,true);mediaAudit.push({...binding,relativePath:media.relativePath,byteSize:media.byteSize,actualSha256:sha256(bytes)});
 }
 const versionBindings=[];
 for(const target of input.versions){
  const version=versions.get(target.versionId),old=previousState.assetVersionsById[target.versionId],family=one(model.assetFamilies,target.familyId),oldFamily=one(oldModel.assetFamilies,target.familyId);
  ensure(version&&old&&version.familyId===target.familyId&&old.familyId===target.familyId&&version.sha256===target.sha256&&old.sha256===target.sha256&&version.path===old.path,'版本身份、原登记路径或字节变化');
  ensure(old.canFlowDownstream===true&&old.outputState==='PRESENT'&&previousState.assetFamiliesById[target.familyId]?.currentVersionId===target.versionId,'只能复用改前已放行的当前原版本，不能采用候选或复活旧版');
  const inputs=(version.inputVersionBindings||[]).map(tuple);ensure(same(inputs,(old.inputVersionBindings||[]).map(tuple)),'历史实际参考输入发生变化');
  ensure(same(family.materialRequirementRefs||[],oldFamily.materialRequirementRefs||[]),'素材的需求归属发生变化');
  for(const id of family.materialRequirementRefs||[]){
   const a=one(oldModel.materialRequirements,id),b=one(model.materialRequirements,id);ensure(same(contractOf(a),contractOf(b)),'验收、权利配置或生产条件发生变化：'+id);
   ensure(a.requirementHash===b.requirementHash||requirementBindings.some(x=>x.requirementId===id&&x.beforeHash===a.requirementHash&&x.afterHash===b.requirementHash),'需求变化缺少精确范围桥');
  }
  const occurrenceIndexes=[...(causes.get(target.versionId)||[])].sort((a,b)=>a-b);ensure(occurrenceIndexes.length>0,'指定版本没有待解释的领域失效发生项');
  const binding={...target,domainContextHash:family.domainContext?.hash,occurrenceIndexes,inputBindings:inputs};
  const candidateRows=(events['asset-version']||[]).filter(c=>c.versionId===target.versionId),definitionId=version.executionDefinitionRef||version.executionDefinitionId;
  const audit={...target,mode:candidateRows.length?'EXACT_REGISTERED_EXECUTION':'LEGACY_APPROVED_VERSION',requirementsHash:domainHash((family.materialRequirementRefs||[]).map(id=>contractOf(one(model.materialRequirements,id)))),sources:[]};
  if(candidateRows.length){
   const candidate=one(candidateRows,target.versionId,'versionId'),definition=one(after.recipes.executionDefinitions,definitionId),oldDefinition=one(before.recipes.executionDefinitions,definitionId);
   ensure(productionProofs.has(target.versionId)&&same(definition,oldDefinition)&&definition.definitionHash===executionDefinitionHash(definition)&&candidate.executionDefinitionHash===definition.definitionHash&&candidate.executionDefinitionId===definitionId,'原生素材缺少真实执行闭包或原定义已变化');
   ensure(same((definition.upload?.items||[]).map(tuple),inputs),'原配方输入与真实候选不一致');
   binding.executionDefinitionId=definitionId;binding.executionDefinitionHash=definition.definitionHash;
   const plans=(model.materialProductionPlans||[]).filter(p=>p.familyId===target.familyId||p.requirementId&&family.materialRequirementRefs?.includes(p.requirementId));
   ensure(plans.length===1,'原生素材首次计划不唯一');
   const plan=plans[0],oldPlan=one(oldModel.materialProductionPlans,plan.id);ensure(same(plan,oldPlan),'原生首次计划发生变化');
   audit.sources.push(unchangedDocument(beforeDocs,afterDocs,plan.sourcePath));
   materialProductionPlanGraphClosure({plan,document:afterDocs.get(plan.sourcePath)});
   const revision=(model.materialProductionRecipeRevisions||[]).find(r=>r.definitionId===definitionId);
   if(revision){ensure(same(revision,one(oldModel.materialProductionRecipeRevisions,revision.id)),'历史配方修订变化');audit.sources.push(unchangedDocument(beforeDocs,afterDocs,revision.sourcePath));}
   const definitionSource=revision||plan,doc=afterDocs.get(definitionSource.sourcePath);
   ensure(definitionSource.definitionId===definitionId&&doc?.revisionId===definitionSource.sourceRevisionId&&doc.sha256===definitionSource.sourceSha256&&same(definition,{...JSON.parse(doc.bytes).executionDefinition,sourceRef:definitionSource.sourcePath,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256}),'真实执行定义未精确绑定原发布源字节');
   audit.candidateHash=domainHash(candidate);audit.executionProof=productionProofs.get(target.versionId);audit.definitionHash=definition.definitionHash;
  }else{
   ensure(same(one(oldModel.assetVersions,target.versionId),one(model.assetVersions,target.versionId)),'原导入版本事实发生变化');
   const definition=one(after.recipes.executionDefinitions,definitionId);
   ensure(same(one(before.recipes.executionDefinitions,definitionId),definition)&&inspectExecutionDefinitionHash(definition).valid,'既有定义或 Prompt 变化');
   binding.executionDefinitionId=definitionId;binding.executionDefinitionHash=definition.definitionHash;
   audit.legacyVersionHash=domainHash(one(model.assetVersions,target.versionId));audit.actualGenerationObserved=false;
  }
  const reviews=ordered((events.review||[]).filter(r=>r.subjectType==='ASSET'&&r.versionId===target.versionId&&r.familyId===target.familyId)),review=reviews.at(-1);
  if(review){
   ensure(review.action==='APPROVE_AND_RELEASE'&&review.versionSha256===target.sha256&&review.canFlowDownstream===true&&historicEvents.review?.some(r=>r.eventId===review.eventId)&&old.reviewCorrection?.headEventId===review.eventId,'原正式通过缺失、被更新或不属于本次改前状态');
   binding.reviewEventId=review.eventId;binding.reviewContextHash=review.contextHash;binding.reviewEventHash=domainHash(review);
  }else ensure(!candidateRows.length,'原生候选没有正式通过事件');
  await actualMedia(target,version);
  for(const input of inputs){const parent=versions.get(input.versionId),oldParent=previousState.assetVersionsById[input.versionId];ensure(parent&&oldParent&&parent.familyId===input.familyId&&parent.sha256===input.sha256&&oldParent.sha256===input.sha256&&oldParent.canFlowDownstream===true,'原输入身份、SHA 或原放行缺失');await actualMedia(input,parent);}
  versionBindings.push(binding);contractAudit.push(audit);
 }
 for(const binding of versionBindings)for(const parent of binding.inputBindings){const v=versions.get(parent.versionId);ensure(input.versions.some(t=>same(t,parent))||!causes.get(parent.versionId)?.size&&v.canFlowDownstream===true,'受影响父输入没有纳入逐版本兼容核验');}
 const record={schemaVersion:'DOMAIN_PRODUCTION_COMPATIBILITY_V1',compatibilityId:input.operationId,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,beforeGraphRef:input.beforeGraphRef,afterGraphRef:input.afterGraphRef,beforeSlice,afterSlice,metadataApprovals:input.metadataApprovals,occurrences,requirementBindings,versionBindings,approval:{confirmed:true,reason:input.reason},contractAudit:{authorization:input.authorization,beforeReleaseId:oldRelease.releaseId,afterReleaseId:currentRelease.releaseId,versions:contractAudit,media:mediaAudit,oldScopesOnly:true,formalAdoptionPerformed:false,modelCalls:0}};
 record.proofHash=domainProductionCompatibilityProofHash(record);
 const valid=validateDomainProductionCompatibilityRecord(record,{model,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,requireCurrentEpoch:true,versions,executionDefinitions:after.recipes.executionDefinitions});
 ensure(valid&&valid.currentVersionBindings.length===versionBindings.length&&valid.currentRequirementBindings.length===requirementBindings.length,'兼容记录未通过当前局部、版本或完整需求后验');
 const projected=structuredClone(after.snapshot);projected.productionModel.domainProductionCompatibilities=[...(model.domainProductionCompatibilities||[]),record];
 const postState=stateFor(api,projected,events,after.recipes),targetIds=new Set(input.versions.map(v=>v.versionId));
 const status=v=>Object.fromEntries(['id','familyId','sha256','path','lifecycleState','reviewDecision','projectRightsGate','canFlowDownstream'].map(k=>[k,v?.[k]??null]));
 for(const target of input.versions){const v=postState.assetVersionsById[target.versionId];ensure(v?.sha256===target.sha256&&v.canFlowDownstream===true&&postState.assetFamiliesById[target.familyId]?.currentVersionId===target.versionId,'原版本仍有未解决门禁或不是当前版本：'+target.versionId);}
 for(const [id,v]of Object.entries(currentState.assetVersionsById))if(!targetIds.has(id))ensure(same(status(v),status(postState.assetVersionsById[id])),'兼容确认意外改变未指定版本状态：'+id);
 const projectionChecks={restoredVersions:input.versions.map(v=>status(postState.assetVersionsById[v.versionId])),unlistedVersionsUnchanged:true,formalAdoptionPerformed:false};
 const body={operationId:input.operationId,requestHash:domainHash(input),baseReleaseId:currentRelease.releaseId,runtimeEpoch:meta.runtimeEpoch,eventSequence:meta.eventSequence,record,classification,projectionChecks};
 return {...body,previewHash:domainHash(body),formalAdoptionPerformed:false,modelCalls:0};
}

/** Caller owns one write transaction. Preview CAS includes event high water,
 * media bytes and exact original review/producer history; replay is read-only. */
export async function applyDomainProductionCompatibility(tx,input,{expectedPreviewHash,...dependencies}={}){
 validateRequest(input);ensure(digest(expectedPreviewHash),'必须提供已核对预览的精确 SHA');
 const existing=await tx.getAux(DOMAIN_COMPATIBILITY_NS,input.operationId);
 if(existing){const receipt=JSON.parse(existing.bytes);ensure(!existing.deleted&&receipt.requestHash===domainHash(input)&&receipt.previewHash===expectedPreviewHash,'确认操作身份已被其他内容占用');return {...receipt,replayed:true};}
 const preview=await previewDomainProductionCompatibility(tx,input,dependencies);ensure(preview.previewHash===expectedPreviewHash,'预览后来源、事件或媒体变化，请重新核验');
 const release=await tx.readRelease(),snapshot=JSON.parse(release.snapshotBytes),model=snapshot.productionModel;
 ensure(!(model.domainProductionCompatibilities||[]).some(r=>r.compatibilityId===input.operationId),'快照已包含同名确认但缺少回执');
 model.domainProductionCompatibilities=[...(model.domainProductionCompatibilities||[]),preview.record];
 const next=await tx.publishRelease({snapshotBytes:canonicalJson(snapshot),recipesBytes:release.recipesBytes,sourceRevisionIds:release.sourceRevisionIds,expectedReleaseId:release.releaseId});
 const receipt={schemaVersion:'1.0',operationType:'DOMAIN_PRODUCTION_COMPATIBILITY',operationId:input.operationId,requestHash:preview.requestHash,previewHash:preview.previewHash,proofHash:preview.record.proofHash,instanceId:preview.record.instanceId,runtimeEpoch:preview.runtimeEpoch,baseReleaseId:release.releaseId,releaseId:next.releaseId,versions:input.versions,requirementIds:input.requirementIds,oldScopesOnly:true,originalEventsAndMediaPreserved:true,formalAdoptionPerformed:false,modelCalls:0,recordedAt:new Date().toISOString()};
 await tx.putAux({namespace:DOMAIN_COMPATIBILITY_NS,key:input.operationId,bytes:canonicalJson(receipt),expectedRevisionId:null,mediaType:'application/json',metadata:{operationType:receipt.operationType}});
 return receipt;
}
