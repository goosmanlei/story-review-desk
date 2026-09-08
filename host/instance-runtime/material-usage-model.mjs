import {materialRequirementSelectionReasons} from './material-requirement-disposition.mjs';
import {canonicalJson,sha256} from './bytes.mjs';

export const MATERIAL_USAGE_PROTOCOL='MATERIAL_USAGE_V1';
export const MATERIAL_USAGE_EVENT='material-usage-review';
export const MATERIAL_USAGE_SOURCE='MATERIAL_USAGE_REVIEW';
export const MATERIAL_USAGE_SCHEMA='MATERIAL_USAGE_REVIEW_V1';
export const usageHash=value=>sha256(canonicalJson(value));
const list=value=>Array.isArray(value)?value:[];
const isHash=value=>/^[a-f0-9]{64}$/.test(value||'');
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const check=(condition,message)=>{if(!condition)fail(message);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
function object(value,keys,label){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(','),label+'字段不完整或含未知字段');return value;}
function text(value,label,max=4000){check(typeof value==='string'&&value.trim()&&value.length<=max,label+'无效');return value;}
export function materialUsageId(requirementId,familyId){return 'MUSE-'+usageHash({requirementId,familyId}).slice(0,32);}
export function assertMaterialUsageSource(body){
 object(body,['schemaVersion','id','usageId','baseReleaseId','draftRevisionId','basis','content'],'用途来源');
 check(body.schemaVersion===MATERIAL_USAGE_SCHEMA&&body.id==='MUSE-REV-'+usageHash(Object.fromEntries(Object.entries(body).filter(([k])=>k!=='id'))).slice(0,32),'用途来源身份必须由完整冻结内容派生');
 const b=object(body.basis,['requirement','source','previousHead','instanceId','runtimeEpoch'],'用途基线');text(b.instanceId,'实例身份');text(b.runtimeEpoch,'实例运行代次');text(body.baseReleaseId,'发布基线');text(body.draftRevisionId,'草稿版本');
 const r=object(b.requirement,['requirementId','requirementHash','demand','representation','entity','state','domainContext','scopeBindings','reviewSpec','configurationBinding'],'冻结用途定义');
 const source=object(b.source,['familyId','versionId','sha256','path','media','adoption','projectRightsGate','domainContextHash'],'原采用来源');
 check(isHash(source.sha256)&&['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(source.projectRightsGate),'原采用来源SHA或权利基线无效');text(source.path,'原件路径');
 object(source.media,['mediaId','versionId','sha256','relativePath','byteSize'],'原媒体登记');check(source.media.mediaId===source.familyId&&source.media.versionId===source.versionId&&source.media.sha256===source.sha256&&Number.isSafeInteger(source.media.byteSize)&&source.media.byteSize>0,'原媒体登记身份无效');text(source.media.relativePath,'原登记物理路径');
 object(source.adoption,['eventId','sha256'],'原采用事件');check(isHash(source.adoption.sha256),'原采用事件哈希无效');
 if(b.previousHead!==null){object(b.previousHead,['eventId','sha256'],'前序用途头');check(isHash(b.previousHead.sha256),'前序用途头哈希无效');}
 check(body.usageId===materialUsageId(r.requirementId,source.familyId),'用途身份与目标不匹配');
 const frozenModel={domainGraph:{requirements:[r.demand],representations:[r.representation],entities:[r.entity],states:r.state?[r.state]:[]},materialRequirements:[{id:r.requirementId,requirementClass:'REQUIRED',sourceKind:'DOMAIN_GRAPH',representationRef:r.representation?.id,requirementHash:r.requirementHash,assetFamilyRefs:[],domainContext:r.domainContext,scopeBindings:r.scopeBindings,reviewSpec:r.reviewSpec,configurationBinding:r.configurationBinding}]};
 check(!r.demand?.composition&&same(materialUsageRequirementBasis(frozenModel,r.requirementId),r),'冻结用途仅限IMAGE新叶且须能复算全部定义');
 validateMaterialUsageContent(body.content,b);return body;
}
export function materialUsageRequirementBasis(model,requirementId){
 check(!materialRequirementSelectionReasons(model,requirementId,{use:'CURRENT_TARGET'}).length,'用途目标已拆分或替代关系异常');
 const requirements=list(model.materialRequirements).filter(r=>r.id===requirementId),requirement=requirements[0],graph=model.domainGraph;
 check(requirements.length===1&&requirement.requirementClass==='REQUIRED'&&requirement.sourceKind==='DOMAIN_GRAPH'&&!requirement.composition&&requirement.scopeRole!=='EVIDENCE_ONLY'&&requirement.activeInCurrentProduction!==false,'用途绑定仅支持当前DOMAIN_REQUIRED叶需求');
 const demand=list(graph?.requirements).filter(r=>r.id===requirementId),representations=list(graph?.representations).filter(r=>r.id===demand[0]?.representationId),representation=representations[0];
 check(demand.length===1&&representations.length===1&&requirement.representationRef===representation.id&&requirement.requirementHash===usageHash({demand:demand[0],representation}),'用途需求定义与当前表现哈希不一致');
 check(demand[0].mediaType==='IMAGE','UNSUPPORTED_MEDIA_TYPE：本版用途绑定仅支持IMAGE');
 check(!list(requirement.assetFamilyRefs).length&&!list(representation.assetFamilyIds).length&&!requirement.materialProductionPlanId&&!requirement.materialWorkItemRef&&!requirement.plannedAssetFamilyId,'用途绑定仅用于尚无生产族的新准确叶需求，不更改已有制作闭包');
 const entity=list(graph.entities).filter(r=>r.id===representation.entityId),states=representation.stateId?list(graph.states).filter(r=>r.id===representation.stateId&&r.entityId===representation.entityId):[];
 check(entity.length===1&&(!representation.stateId||states.length===1),'用途目标实体或状态不唯一');
 const spec=requirement.reviewSpec;
 check(spec&&isHash(spec.hash)&&list(spec.criteria).length&&usageHash(Object.fromEntries(Object.entries(spec).filter(([k])=>k!=='hash')))===spec.hash,'用途目标缺少完整当前审阅标准');
 return {requirementId,requirementHash:requirement.requirementHash,demand:structuredClone(demand[0]),representation:structuredClone(representation),entity:structuredClone(entity[0]),state:states[0]?structuredClone(states[0]):null,domainContext:structuredClone(requirement.domainContext||null),scopeBindings:structuredClone(requirement.scopeBindings||[]),reviewSpec:structuredClone(spec),configurationBinding:structuredClone(requirement.configurationBinding||null)};
}
export function validateMaterialUsageContent(value,basis){
 const content=object(value,['purposeNote','authorization','observation','decision'],'新用途内容');text(content.purposeNote,'新用途说明');
 object(content.authorization,['scope','basis'],'用途授权');check(content.authorization.scope==='PROJECT_INTERNAL_ONLY','用途授权只能限本项目内部');text(content.authorization.basis,'本轮授权依据');
 object(content.observation,['versionId','sha256','originalViewed','note'],'实际观察');check(content.observation.versionId===basis.source.versionId&&content.observation.sha256===basis.source.sha256&&content.observation.originalViewed===true,'实际观察必须明确绑定同一原版本和SHA');text(content.observation.note,'实际观察说明');
 const d=object(content.decision,['action','reviewSpecHash','criterionFindings','note'],'用途判断');check(['APPROVE_AND_RELEASE','REQUEST_REVISION','DO_NOT_USE'].includes(d.action),'用途判断动作无效');text(d.note,'用途判断说明');check(d.reviewSpecHash===basis.requirement.reviewSpec.hash,'目标审阅标准已变化');
 const expected=basis.requirement.reviewSpec.criteria,findings=list(d.criterionFindings);check(findings.length===expected.length&&new Set(findings.map(f=>f?.criterionId)).size===expected.length,'必须逐项完成目标需求全部审阅标准');
 for(const f of findings){object(f,['criterionId','verdict','note'],'用途逐项判断');const criterion=expected.find(c=>c.id===f.criterionId);check(criterion&&['PASS','FAIL','NA'].includes(f.verdict)&&!(f.verdict==='NA'&&!criterion.allowNA),'判断项不属于目标完整标准');check(typeof f.note==='string'&&f.note.length<=4000,'判断说明无效');if(f.verdict==='FAIL'||criterion.noteRequiredOnFail&&f.verdict!=='PASS')text(f.note,'未通过说明');}
 check(d.action!=='APPROVE_AND_RELEASE'||!findings.some(f=>f.verdict==='FAIL'),'用途通过不得包含未通过项');check(d.action==='APPROVE_AND_RELEASE'||findings.some(f=>f.verdict==='FAIL'),'用途拒绝或修改须至少一个明确未通过项');
 return structuredClone(content);
}
export function materialUsageEventPayload(body,source){return {
 schemaVersion:'1.0',subjectType:'MATERIAL_USAGE',subjectId:body.usageId,usageId:body.usageId,usageRevisionId:body.id,
 requirementId:body.basis.requirement.requirementId,requirementHash:body.basis.requirement.requirementHash,
 familyId:body.basis.source.familyId,versionId:body.basis.source.versionId,versionSha256:body.basis.source.sha256,
 action:body.content.decision.action,reviewSpecHash:body.content.decision.reviewSpecHash,criterionFindings:body.content.decision.criterionFindings,
 note:body.content.decision.note,usageContextHash:usageHash(body.basis),supersedesUsageReviewEventId:body.basis.previousHead?.eventId||null,
 sourceAdoptionEventId:body.basis.source.adoption.eventId,sourceAdoptionEventHash:body.basis.source.adoption.sha256,
 sourceRef:source.sourceRef,sourceRevisionId:source.sourceRevisionId,sourceSha256:source.sourceSha256,
 effect:'APPLIED',applicationStatus:'APPLIED',originalAssetAdoptionPerformed:false,originalRightsChanged:false,
 };}
/** Pure integrity check over every source/event, including obsolete usage decisions. */
export function validateMaterialUsageLedger({snapshot,documents,events}){
 if(Object.hasOwn(snapshot?.productionModel||{},'materialUsageLedger'))check(Array.isArray(snapshot.productionModel.materialUsageLedger),'用途ledger必须为数组');
 const refs=list(snapshot?.productionModel?.materialUsageLedger),usageEvents=list(events).filter(e=>e.eventKind===MATERIAL_USAGE_EVENT||e.subjectType==='MATERIAL_USAGE'||Object.hasOwn(e,'usageRevisionId'));
 const sources=list(documents).filter(d=>d.metadata?.sourceRole===MATERIAL_USAGE_SOURCE||list(d.aliases).some(a=>a.startsWith('story/material-usages/')));
 check(refs.length===usageEvents.length&&refs.length===sources.length,'用途ledger、不可变来源或事件缺失/存在孤儿');
 check(new Set(refs.map(r=>r.id)).size===refs.length&&new Set(refs.map(r=>r.eventId)).size===refs.length,'用途ledger身份重复');
 const rows=refs.map(ref=>{
  object(ref,['id','usageId','eventId','sourceRef','sourceRevisionId','sourceSha256'],'用途ledger');
  const docs=sources.filter(d=>d.revisionId===ref.sourceRevisionId),matches=usageEvents.filter(e=>e.eventId===ref.eventId);check(docs.length===1&&matches.length===1,'用途精确来源或事件不唯一');
  const doc=docs[0],event=matches[0];check(doc.metadata?.sourceRole===MATERIAL_USAGE_SOURCE&&event.eventKind===MATERIAL_USAGE_EVENT&&!doc.deleted&&doc.sha256===ref.sourceSha256&&sha256(doc.bytes)===doc.sha256&&list(doc.aliases).includes(ref.sourceRef),'用途来源原字节、角色、事件kind或别名不匹配');
  const body=JSON.parse(Buffer.from(doc.bytes).toString('utf8'));
  assertMaterialUsageSource(body);
  for(const instanceId of [snapshot?.instance?.instanceId,snapshot?.productionModel?.instance?.instanceId].filter(v=>v!==undefined))check(body.basis.instanceId===instanceId,'用途来源属于其他实例');
  check(body.schemaVersion===MATERIAL_USAGE_SCHEMA&&body.id===ref.id&&body.usageId===ref.usageId&&body.usageId===materialUsageId(body.basis?.requirement?.requirementId,body.basis?.source?.familyId),'用途来源合同或身份不匹配');
  check(ref.sourceRef==='story/material-usages/'+body.id+'.json','用途来源路径不匹配');
  check(body.basis.requirement.requirementHash===usageHash({demand:body.basis.requirement.demand,representation:body.basis.requirement.representation}),'用途冻结需求哈希无法复算');
  validateMaterialUsageContent(body.content,body.basis);
  const payload=materialUsageEventPayload(body,ref),actual=Object.fromEntries(Object.entries(event).filter(([key])=>!['eventId','eventKind','idempotencyKeyHash','requestHash','recordedAt','eventSequence'].includes(key)));
  check(same(actual,payload),'用途事件与冻结来源不匹配或携带原ASSET采用字段');
  check(typeof event.eventId==='string'&&event.eventId.trim()&&typeof event.recordedAt==='string'&&Number.isFinite(Date.parse(event.recordedAt))&&isHash(event.idempotencyKeyHash)&&isHash(event.requestHash)&&Number.isSafeInteger(event.eventSequence)&&event.eventSequence>0,'用途事件外壳不完整');
  const adoption=list(events).filter(e=>e.eventKind==='review'&&e.eventId===body.basis.source.adoption.eventId);
  check(adoption.length===1&&usageHash(adoption[0])===body.basis.source.adoption.sha256&&adoption[0].subjectType==='ASSET'&&!['reviewPurpose','usageBindingId','usageId'].some(k=>Object.hasOwn(adoption[0],k))&&adoption[0].familyId===body.basis.source.familyId&&adoption[0].versionId===body.basis.source.versionId&&adoption[0].versionSha256===body.basis.source.sha256&&adoption[0].action==='APPROVE_AND_RELEASE'&&adoption[0].effect==='APPLIED'&&adoption[0].applicationStatus==='APPLIED'&&adoption[0].eventSequence<event.eventSequence,'用途缺少精确原正式采用证据');
  return {ref:structuredClone(ref),body,event:structuredClone(event)};
 });
 const heads=new Map();for(const row of [...rows].sort((a,b)=>a.event.eventSequence-b.event.eventSequence)){
  const previous=heads.get(row.body.usageId),expected=previous?{eventId:previous.event.eventId,sha256:usageHash(previous.event)}:null;
  check(same(row.body.basis.previousHead,expected),'用途事件不是精确追加后继链');heads.set(row.body.usageId,row);
 }
 return rows;
}
/** This cannot elevate a source asset: all source lifecycle and rights gates precede it. */
export function projectMaterialUsages(model,state){
 const refs=list(model.materialUsageLedger),rows=list(model.materialUsageEvidence).filter(row=>refs.some(ref=>same(ref,row.ref))),heads=new Map();for(const row of rows){const old=heads.get(row.body.usageId);if(!old||old.event.eventSequence<row.event.eventSequence)heads.set(row.body.usageId,row);}
 const projected=[];
 for(const row of heads.values()){
  const {body,event}=row,b=body.basis,source=b.source,reasons=[];
  if(event.action!=='APPROVE_AND_RELEASE')reasons.push('USAGE_'+event.action);
  let current;try{current=materialUsageRequirementBasis(model,b.requirement.requirementId);}catch{reasons.push('USAGE_REQUIREMENT_CHANGED');}
  if(current&&!same(current,b.requirement))reasons.push('USAGE_REQUIREMENT_CHANGED');
  const family=state.assetFamiliesById?.[source.familyId],version=state.assetVersionsById?.[source.versionId];
  if(!family||!version||family.currentVersionId!==source.versionId||version.familyId!==source.familyId||version.sha256!==source.sha256||version.path!==source.path||!family.canFlowDownstream||!version.canFlowDownstream||version.lifecycleState!=='RELEASED'||!['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(version.projectRightsGate))reasons.push('USAGE_SOURCE_NOT_CURRENT_RELEASED');
  if((state.materialUsageSourceReviewHeads?.[source.versionId]||version?.reviewCorrection?.headEventId)!==source.adoption.eventId)reasons.push('USAGE_SOURCE_ADOPTION_CHANGED');
  if(row.mediaCurrent!==true)reasons.push(row.mediaAvailabilityScope==='HOSTED_EXPORT'&&row.mediaCurrentInSourceProjection===true?'HOSTED_SOURCE_MEDIA_NOT_INCLUDED':'USAGE_SOURCE_MEDIA_UNAVAILABLE');
  projected.push({usageId:body.usageId,eventId:event.eventId,requirementId:b.requirement.requirementId,requirementHash:b.requirement.requirementHash,familyId:source.familyId,versionId:source.versionId,sha256:source.sha256,usageContextHash:event.usageContextHash,reviewSpecHash:event.reviewSpecHash,sourceAdoptionEventId:source.adoption.eventId,eligible:reasons.length===0,reasons});
 }
 return projected;
}
export function materialUsageBindingsFor(state,requirement){return list(state.materialUsageBindings).filter(b=>b.eligible===true&&b.requirementId===requirement.id&&b.requirementHash===requirement.requirementHash);}
export function effectiveRequirementFamilyIds(state,requirement){return [...new Set([...list(requirement.assetFamilyRefs),...materialUsageBindingsFor(state,requirement).map(b=>b.familyId)])];}
export function exactRequirementUsageBinding(state,requirement,binding){return materialUsageBindingsFor(state,requirement).some(b=>b.familyId===binding.familyId&&b.versionId===binding.versionId&&b.sha256===binding.sha256);}
