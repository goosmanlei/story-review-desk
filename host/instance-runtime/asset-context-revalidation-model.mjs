import {canonicalJson,sha256} from './bytes.mjs';
import {materialRequirementSelectionReasons} from './material-requirement-disposition.mjs';
export const ASSET_CONTEXT_PROTOCOL='ASSET_CONTEXT_REVALIDATION_V1';
export const ASSET_CONTEXT_EVENT='asset-context-revalidation';
export const ASSET_CONTEXT_SOURCE='ASSET_CONTEXT_REVALIDATION';
export const ASSET_CONTEXT_SCHEMA='ASSET_CONTEXT_REVALIDATION_SOURCE_V1';
export const contextHash=value=>sha256(canonicalJson(value));
const list=value=>Array.isArray(value)?value:[];
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const hash=value=>/^[a-f0-9]{64}$/.test(value||'');
const imageKind=(family,requirement)=>family.kind==='IMAGE'||family.kind==='VISUAL'&&requirement?.mediaType==='IMAGE';
export function contextCheck(condition,message){if(!condition)throw Object.assign(Error(message),{code:'DOMAIN_CONFLICT'});}
function object(value,keys,label){contextCheck(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),label+'字段不完整或未知');return value;}
function text(value,label,max=4000){contextCheck(typeof value==='string'&&value.trim()&&value.length<=max,label+'无效');}
export const assetContextId=({familyId,versionId,sha256})=>'ACTX-'+contextHash({familyId,versionId,sha256}).slice(0,32);
export function assetContextTarget(input){for(const k of ['familyId','versionId'])contextCheck(typeof input?.[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(input[k]),'复核对象身份无效');contextCheck(hash(input.sha256),'复核对象SHA无效');return Object.fromEntries(['familyId','versionId','sha256'].map(k=>[k,input[k]]));}
export function assetContextCurrentBasis(model,target){
 const families=list(model.assetFamilies).filter(f=>f.id===target.familyId),versions=list(model.assetVersions).filter(v=>v.id===target.versionId),family=families[0],version=versions[0];
 contextCheck(families.length===1&&versions.length===1&&version.familyId===family.id&&version.sha256===target.sha256&&family.currentVersionId===version.id,'复核必须是同一当前采用IMAGE版本/SHA');
 const requirements=list(model.materialRequirements).filter(r=>list(r.assetFamilyRefs).includes(family.id));contextCheck(requirements.length===1,'原制作需求归属必须唯一可核');const requirement=requirements[0];
 contextCheck(imageKind(family,requirement),'复核必须是同一当前采用IMAGE版本/SHA');
 contextCheck(!materialRequirementSelectionReasons(model,requirement.id,{use:'CURRENT_INPUT'}).length,'原需求已被替代、撤销或当前归属不可核');
 const invalidations=list(model.domainInvalidations).filter(r=>r.familyId===family.id&&list(r.versionIds).includes(version.id));
 contextCheck(invalidations.length>0&&hash(family.domainContext?.hash)&&invalidations.at(-1).currentHash===family.domainContext.hash,'必须有本版本真实当前DOMAIN变化记录');
 const reviewSpec=requirement.reviewSpec;contextCheck(reviewSpec&&list(reviewSpec.criteria).length&&hash(reviewSpec.hash)&&contextHash(Object.fromEntries(Object.entries(reviewSpec).filter(([k])=>k!=='hash')))===reviewSpec.hash,'当前完整冻结审阅标准不可核');
 return {requirementId:requirement.id,requirementHash:requirement.requirementHash,reviewSpec:structuredClone(reviewSpec),configurationBinding:structuredClone(requirement.configurationBinding||null),domainContext:structuredClone(family.domainContext),invalidations:structuredClone(invalidations),invalidationHash:contextHash(invalidations)};
}
export function validateAssetContextContent(value,basis){
 const c=object(value,['purpose','action','criterionFindings','observedVersionId','observedSha256','note'],'关系复核内容');
 contextCheck(c.purpose==='LEGACY_ADOPTION_DOMAIN_REVALIDATION'&&c.action==='CONFIRM_CURRENT_DOMAIN','复核用途或动作不符');
 contextCheck(c.observedVersionId===basis.source.versionId&&c.observedSha256===basis.source.sha256,'实际观察必须明确绑定原版本/SHA');text(c.note,'原图实际观察及复核说明');
 const expected=basis.current.reviewSpec.criteria,findings=list(c.criterionFindings);contextCheck(findings.length===expected.length&&new Set(findings.map(f=>f?.criterionId)).size===expected.length,'必须完整逐项复核原审阅标准');
 for(const f of findings){object(f,['criterionId','verdict','note'],'复核判断');const criterion=expected.find(c=>c.id===f.criterionId);contextCheck(criterion&&['PASS','FAIL','NA'].includes(f.verdict)&&!(f.verdict==='NA'&&!criterion.allowNA),'复核判断无效');text(f.note,'逐项实际观察说明');}
 contextCheck(findings.every(f=>f.verdict==='PASS'||f.verdict==='NA'),'确认当前关系不得包含未通过项');return structuredClone(c);
}
export function assertAssetContextSource(body){
 object(body,['schemaVersion','id','revalidationId','baseReleaseId','draftRevisionId','basis','content'],'复核固定来源');
 contextCheck(body.schemaVersion===ASSET_CONTEXT_SCHEMA&&body.id==='ACTX-REV-'+contextHash(Object.fromEntries(Object.entries(body).filter(([k])=>k!=='id'))).slice(0,32),'复核固定来源身份错误');
 const b=object(body.basis,['instanceId','runtimeEpoch','source','legacyAdoptionProof','current','contextHash','previousHead','consumerProof'],'复核基线');
 text(b.instanceId,'实例');text(b.runtimeEpoch,'运行代次');text(body.baseReleaseId,'基准发布');text(body.draftRevisionId,'草稿修订');
 const source=object(b.source,['familyId','versionId','sha256','path','media','projectRightsGate'],'原版本');assetContextTarget(source);text(source.path,'原件路径');
 object(source.media,['mediaId','versionId','sha256','relativePath','byteSize'],'原登记');contextCheck(source.media.mediaId===source.familyId&&source.media.versionId===source.versionId&&source.media.sha256===source.sha256&&Number.isSafeInteger(source.media.byteSize)&&source.media.byteSize>0,'原登记身份不符');
 contextCheck(['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(source.projectRightsGate),'原权利未通过');
 const p=object(b.legacyAdoptionProof,['releaseId','snapshotId','snapshotSha256','recipesSha256','profileRevisionId','familyHash','versionHash','definitionId','definitionRowHash','producerSource','inputBindings'],'原采用发布证明');
 contextCheck(p.releaseId===body.baseReleaseId&&['snapshotSha256','recipesSha256','familyHash','versionHash','definitionRowHash'].every(k=>hash(p[k])),'原发布证明哈希不全');
 object(p.producerSource,['sourceRef','sourceRevisionId','sourceSha256'],'原producer来源');contextCheck(hash(p.producerSource.sourceSha256),'原producer来源SHA不全');
 const current=object(b.current,['requirementId','requirementHash','reviewSpec','configurationBinding','domainContext','invalidations','invalidationHash'],'当前需求/关系');
 contextCheck(hash(current.requirementHash)&&hash(current.domainContext?.hash)&&list(current.invalidations).length&&current.invalidationHash===contextHash(current.invalidations)&&current.invalidations.every(r=>r.familyId===source.familyId&&list(r.versionIds).includes(source.versionId))&&current.invalidations.at(-1).currentHash===current.domainContext.hash,'当前关系/局部历史证明不符');
 contextCheck(current.reviewSpec&&hash(current.reviewSpec.hash)&&contextHash(Object.fromEntries(Object.entries(current.reviewSpec).filter(([k])=>k!=='hash')))===current.reviewSpec.hash&&hash(b.contextHash),'复核规范或上下文哈希不符');
 object(b.consumerProof,['eventSetHash','transitionReasons'],'消费者证明');contextCheck(hash(b.consumerProof.eventSetHash)&&Array.isArray(b.consumerProof.transitionReasons)&&b.consumerProof.transitionReasons.every(r=>r.code==='TARGET_ASSET_VERSION_ALREADY_ADVANCED'),'存在未核消费者或活动执行');
 if(b.previousHead!==null){object(b.previousHead,['eventId','sha256'],'复核前序');contextCheck(hash(b.previousHead.sha256),'复核前序SHA不符');}
 contextCheck(body.revalidationId===assetContextId(source),'复核身份不符');validateAssetContextContent(body.content,b);return body;
}
/** Actual immutable publication bytes are required; the source's self-declared
 * legacy flags or hashes are never an authority for the old adoption. */
export function assetContextEventManifest(events){return [...events].sort((a,b)=>String(a.eventId).localeCompare(String(b.eventId))).map(e=>({eventId:e.eventId,sha256:contextHash(e)}));}
export function assetContextRuntimeHash(model,target){
 const materialRequirements=list(model.materialRequirements).filter(r=>list(r.assetFamilyRefs).includes(target.familyId)).map(r=>({id:r.id,requirementHash:r.requirementHash})).sort((a,b)=>a.id.localeCompare(b.id));
 const invalidations=list(model.domainInvalidations).filter(r=>r.familyId===target.familyId&&list(r.versionIds).includes(target.versionId)),family=list(model.assetFamilies).find(f=>f.id===target.familyId);
 return contextHash({subjectType:'ASSET',familyId:target.familyId,versionId:target.versionId,versionSha256:target.sha256,materialRequirements,...(invalidations.length?{domainContextHash:family?.domainContext?.hash||null,domainInvalidationHash:contextHash(invalidations)}:{})});
}
/** Extract bounded facts while the archive's genuine release bytes are in
 * scope. This is not a source-supplied certificate and cannot authorize a UI. */
export function assetContextPublicationFacts({snapshot,recipes}){
 const model=snapshot.productionModel||{},facts=[];
 for(const f of list(model.assetFamilies)){
  if(!['IMAGE','VISUAL'].includes(f.kind)||!f.currentVersionId)continue;
  const matches=list(model.assetVersions).filter(v=>v.id===f.currentVersionId),v=matches[0];if(matches.length!==1||!v||v.familyId!==f.id||!hash(v.sha256))continue;
  if(!(f.reviewDecision==='RELEASED'&&v.reviewDecision==='RELEASED'&&f.lifecycleState==='RELEASED'&&v.lifecycleState==='RELEASED'&&f.canFlowDownstream===true&&v.canFlowDownstream===true&&v.outputState==='PRESENT'&&v.legacyState?.approvalStatus==='APPROVED'&&v.legacyState?.qaStatus==='PASS'&&v.legacyState?.materializationState==='GENERATED'))continue;
  const defs=list(recipes.executionDefinitions).filter(d=>d.id===v.executionDefinitionRef),def=defs[0];if(defs.length!==1||f.executionDefinitionRef!==def.id||def.output?.assetFamilyRef!==f.id||def.output?.assetVersionRef!==v.id||def.output?.path!==v.path||def.materialProductionPlanId||def.shotProductionPlanId)continue;
  let current;try{current=assetContextCurrentBasis(model,{familyId:f.id,versionId:v.id,sha256:v.sha256});}catch{continue;}
  const inputs=list(def.upload?.items).map(x=>({familyId:x.assetFamilyRef,versionId:x.assetVersionRef,sha256:x.sha256,path:x.path,mediaType:x.mediaType}));
  const inputsValid=inputs.every(input=>hash(input.sha256)&&input.familyId&&input.versionId&&input.path&&input.mediaType&&list(model.assetVersions).filter(v=>v.id===input.versionId&&v.familyId===input.familyId&&v.sha256===input.sha256&&v.path===input.path).length===1);
  facts.push({familyId:f.id,versionId:v.id,sha256:v.sha256,path:v.path,projectRightsGate:v.projectRightsGate,familyHash:contextHash(f),versionHash:contextHash(v),definitionId:def.id,definitionRowHash:contextHash(def),source:structuredClone(def.source||{}),rawSourceBlock:def.rawSourceBlock,inputBindings:inputs,inputsValid,currentHash:contextHash(current),contextHash:assetContextRuntimeHash(model,{familyId:f.id,versionId:v.id,sha256:v.sha256})});
 }
 return {snapshotId:snapshot.snapshotId,recipesSnapshotId:recipes.snapshotId,instanceIds:[snapshot.instance?.instanceId,model.instance?.instanceId].filter(v=>v!==undefined),domainGraphRef:structuredClone(model.domainGraphRef||null),domainGraphHash:model.domainGraph?contextHash(model.domainGraph):null,configuration:model.systemConfiguration?{reference:structuredClone(model.systemConfiguration.reference),configHash:contextHash(model.systemConfiguration.config),recipesRef:structuredClone(recipes.configurationRef)}:null,versions:facts};
}
export function assertAssetContextPublicationFacts(body,release,facts,documents){
 const b=body.basis,p=b.legacyAdoptionProof,target=b.source;
 contextCheck(release&&release.releaseId===p.releaseId&&release.snapshotId===p.snapshotId&&release.snapshotSha256===p.snapshotSha256&&release.recipesSha256===p.recipesSha256&&release.profileRevisionId===p.profileRevisionId,'原采用不是精确实际已发布基线');
 contextCheck(facts?.snapshotId===p.snapshotId&&facts.recipesSnapshotId===p.snapshotId&&facts.instanceIds.every(id=>id===b.instanceId),'原发布快照/配方/实例身份不符');
 const matches=facts.versions.filter(v=>v.familyId===target.familyId&&v.versionId===target.versionId&&v.sha256===target.sha256&&v.path===target.path&&v.projectRightsGate===target.projectRightsGate),v=matches[0];contextCheck(matches.length===1,'实际发布缺少同一旧已采用原版');
 contextCheck(['familyHash','versionHash','definitionId','definitionRowHash'].every(k=>v[k]===p[k])&&v.currentHash===contextHash(b.current)&&v.contextHash===b.contextHash,'原采用、producer或当前关系行被改写');
 const source=p.producerSource,docs=list(documents).filter(d=>d.revisionId===source.sourceRevisionId),doc=docs[0];contextCheck(docs.length===1&&!doc.deleted&&doc.sha256===source.sourceSha256&&sha256(doc.bytes)===source.sourceSha256&&list(release.sourceRevisionIds).includes(doc.revisionId)&&list(doc.aliases).includes(source.sourceRef)&&v.source.path===source.sourceRef,'原producer固定来源未实际发布/缺失/改写');
 contextCheck(typeof v.rawSourceBlock==='string'&&v.rawSourceBlock.length&&sha256(v.rawSourceBlock)===v.source.blockSha256&&Buffer.from(doc.bytes).toString('utf8').includes(v.rawSourceBlock),'原producer原文及段落SHA不符');
 contextCheck(v.inputsValid&&same(v.inputBindings,p.inputBindings),'旧附件未冻结或实际原版本/SHA不符');return true;
}
export function assertLegacyAssetPublication(body,publication,documents){return assertAssetContextPublicationFacts(body,publication?.release,assetContextPublicationFacts(publication||{}),documents);}
export function assetContextEventPayload(body,source){return {schemaVersion:'1.0',subjectType:'ASSET_CONTEXT',subjectId:body.revalidationId,revalidationId:body.revalidationId,revalidationRevisionId:body.id,creationSnapshotId:body.basis.legacyAdoptionProof.snapshotId,snapshotId:body.basis.legacyAdoptionProof.snapshotId,baseReleaseId:body.baseReleaseId,baseSnapshotSha256:body.basis.legacyAdoptionProof.snapshotSha256,baseRecipesSha256:body.basis.legacyAdoptionProof.recipesSha256,familyId:body.basis.source.familyId,versionId:body.basis.source.versionId,versionSha256:body.basis.source.sha256,purpose:body.content.purpose,action:body.content.action,contextHash:body.basis.contextHash,domainContextHash:body.basis.current.domainContext.hash,invalidationHash:body.basis.current.invalidationHash,reviewSpecHash:body.basis.current.reviewSpec.hash,criterionFindings:body.content.criterionFindings,note:body.content.note,previousRevalidationEventId:body.basis.previousHead?.eventId||null,sourceRef:source.sourceRef,sourceRevisionId:source.sourceRevisionId,sourceSha256:source.sourceSha256,effect:'APPLIED',applicationStatus:'APPLIED',originalAdoptionChanged:false,originalRightsChanged:false};}
export function assertAssetContextConsumerHistory(body,events){
 const target=body.basis.source,refs=value=>list(value).some(b=>(b.familyId||b.assetFamilyRef)===target.familyId&&(b.versionId||b.assetVersionRef)===target.versionId&&b.sha256===target.sha256);
 contextCheck(!events.some(e=>e.eventKind==='asset-version'&&e.versionId!==target.versionId&&refs(e.inputBindings)),'原版已有实际下游候选消费，不能复核迁移旧输出');
 const requests=new Map();for(const e of [...events].sort((a,b)=>Number(a.eventSequence||0)-Number(b.eventSequence||0)))if(e.eventKind==='execution-request')requests.set(e.executionRequestId,e);
 for(const request of requests.values()){
  if(request.familyId!==target.familyId&&!refs(request.inputBindings))continue;
  if(['REVOKE','REVOKED','CANCEL','CANCELLED','EXPIRE','EXPIRED'].includes(request.action)||['REVOKED','CANCELLED','EXPIRED'].includes(request.requestState||request.state))continue;
  const runs=events.filter(e=>e.eventKind==='run'&&e.executionRequestId===request.executionRequestId).sort((a,b)=>Number(a.eventSequence||0)-Number(b.eventSequence||0));
  contextCheck(runs.at(-1)?.state==='FAILED','原版存在活动或结果未知的当前/历史执行');
 }
}
export function validateAssetContextLedger({snapshot,documents,events,releaseContext,validatePublication,eventManifest}){
 const model=snapshot?.productionModel||{};if(Object.hasOwn(model,'assetContextRevalidationLedger'))contextCheck(Array.isArray(model.assetContextRevalidationLedger),'复核ledger须为数组');
 const refs=list(model.assetContextRevalidationLedger),selected=list(events).filter(e=>e.eventKind===ASSET_CONTEXT_EVENT||e.subjectType==='ASSET_CONTEXT'||Object.hasOwn(e,'revalidationRevisionId')),sources=list(documents).filter(d=>d.metadata?.sourceRole===ASSET_CONTEXT_SOURCE||list(d.aliases).some(a=>a.startsWith('story/asset-context-revalidations/')));
 contextCheck(refs.length===selected.length&&refs.length===sources.length,'复核来源/事件/ledger缺失或孤儿');contextCheck(new Set(refs.map(r=>r.id)).size===refs.length&&new Set(refs.map(r=>r.eventId)).size===refs.length,'复核身份重复');
 const rows=refs.map(ref=>{object(ref,['id','revalidationId','eventId','sourceRef','sourceRevisionId','sourceSha256'],'复核ledger');const docs=sources.filter(d=>d.revisionId===ref.sourceRevisionId),matches=selected.filter(e=>e.eventId===ref.eventId);contextCheck(docs.length===1&&matches.length===1,'复核来源/事件不唯一');const doc=docs[0],event=matches[0];contextCheck(!doc.deleted&&doc.metadata?.sourceRole===ASSET_CONTEXT_SOURCE&&doc.sha256===ref.sourceSha256&&sha256(doc.bytes)===ref.sourceSha256&&list(doc.aliases).includes(ref.sourceRef)&&event.eventKind===ASSET_CONTEXT_EVENT,'复核来源字节/角色/别名或事件kind错误');const body=JSON.parse(Buffer.from(doc.bytes).toString());assertAssetContextSource(body);contextCheck(ref.id===body.id&&ref.revalidationId===body.revalidationId&&ref.sourceRef==='story/asset-context-revalidations/'+body.id+'.json','复核来源路径/身份错误');
  for(const id of [snapshot.instance?.instanceId,model.instance?.instanceId].filter(v=>v!==undefined))contextCheck(id===body.basis.instanceId,'复核实例不符');
  const payload=assetContextEventPayload(body,ref),actual=Object.fromEntries(Object.entries(event).filter(([k])=>!['eventId','eventKind','idempotencyKeyHash','requestHash','recordedAt','eventSequence'].includes(k)));
  contextCheck(same(actual,payload),'复核事件与来源不一致');contextCheck(hash(event.requestHash)&&hash(event.idempotencyKeyHash)&&Number.isSafeInteger(event.eventSequence)&&event.eventSequence>0&&Number.isFinite(Date.parse(event.recordedAt)),'复核事件外壳错误');
  if(validatePublication){contextCheck(validatePublication(body,event)===true,'复核实际发布证明失败');}else{contextCheck(typeof releaseContext==='function','复核缺少独立实际发布证明');const historical=releaseContext(event,body);assertLegacyAssetPublication(body,historical,documents);contextCheck(Date.parse(historical.release.createdAt)<Date.parse(event.recordedAt),'复核基准发布不早于实际事件');}
  const previousEvents=list(events).filter(e=>e.eventSequence==null||e.eventSequence<event.eventSequence);
  assertAssetContextConsumerHistory(body,previousEvents);
  if(!eventManifest)contextCheck(body.basis.consumerProof.eventSetHash===contextHash(assetContextEventManifest(previousEvents)),'复核之前实际事件闭包不符');
  else contextCheck(body.basis.consumerProof.eventSetHash===contextHash(eventManifest(event)),'复核之前归档事件闭包不符');
  contextCheck(!list(events).some(e=>e.eventSequence<event.eventSequence&&e.eventKind==='review'&&e.subjectType==='ASSET'&&e.familyId===body.basis.source.familyId&&e.versionId===body.basis.source.versionId),'已有现代ASSET历史不能伪装旧采用复核');
  return {ref:structuredClone(ref),body,event:structuredClone(event)};
 });
 const heads=new Map();for(const row of [...rows].sort((a,b)=>a.event.eventSequence-b.event.eventSequence)){const old=heads.get(row.body.revalidationId);contextCheck(same(row.body.basis.previousHead,old?{eventId:old.event.eventId,sha256:contextHash(old.event)}:null),'复核前序链不完整');heads.set(row.body.revalidationId,row);}
 return rows;
}
