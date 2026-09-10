import {listWorkerRuntimeJobs} from './execution-epoch.mjs';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from './bytes.mjs';
import {productionId} from './shot-production-model.mjs';
import {MATERIAL_USAGE_PROTOCOL,MATERIAL_USAGE_EVENT,MATERIAL_USAGE_SOURCE,MATERIAL_USAGE_SCHEMA,usageHash,materialUsageId,materialUsageRequirementBasis,validateMaterialUsageContent,materialUsageEventPayload} from './material-usage-model.mjs';
import {loadMaterialUsageEvidence,materialUsageMediaCurrent} from './material-usage-preservation.mjs';
import {withRepositoryMediaRead} from './media-read-lease.mjs';

export const MATERIAL_USAGE_NS={drafts:'material-usage-drafts',jobs:'material-usage-jobs',requests:'material-usage-requests'};
const read=row=>row&&!row.deleted?JSON.parse(row.bytes):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const put=(tx,ns,key,value,expectedRevisionId=null)=>tx.putAux({namespace:ns,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});
const exactTarget=input=>{for(const k of ['requirementId','familyId','versionId'])productionId(input[k]);if(!/^[a-f0-9]{64}$/.test(input.sha256||''))fail('用途目标须精确绑定原文件SHA','DOMAIN_INVALID');return Object.fromEntries(['requirementId','familyId','versionId','sha256'].map(k=>[k,input[k]]));};
export async function listMaterialUsageSources(tx,{requirementId},{api}){
 productionId(requirementId);const view=await tx.readView();if(!view.snapshot||!api?.projectOperationalState)fail('缺少已发布资料或原采用投影');
 const model=await loadMaterialUsageEvidence(tx,view.snapshot.productionModel,{view}),requirement=materialUsageRequirementBasis(model,requirementId),events=view.eventsByKind||{},state=api.projectOperationalState({...view.snapshot,productionModel:model},events.review||[],events['asset-version']||[],events.run||[],events['source-operation']||[],events['execution-request']||[],{executionDefinitions:view.recipes?.executionDefinitions||[]}),eligibleSources=[];
 for(const sourceFamily of model.assetFamilies||[]){
  if(sourceFamily.kind!=='IMAGE')continue;const family=state.assetFamiliesById?.[sourceFamily.id],version=state.assetVersionsById?.[family?.currentVersionId];
  if(!version?.sha256||!version.path||!family.canFlowDownstream||!version.canFlowDownstream||version.lifecycleState!=='RELEASED'||!['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(version.projectRightsGate))continue;
  const head=version.reviewCorrection?.headEventId,adoption=(events.review||[]).filter(e=>e.eventId===head);if(adoption.length!==1||adoption[0].subjectType!=='ASSET'||['reviewPurpose','usageBindingId','usageId'].some(k=>Object.hasOwn(adoption[0],k))||adoption[0].familyId!==sourceFamily.id||adoption[0].versionId!==version.id||adoption[0].versionSha256!==version.sha256||adoption[0].action!=='APPROVE_AND_RELEASE'||adoption[0].effect!=='APPLIED'||adoption[0].applicationStatus!=='APPLIED')continue;
  if(!await materialUsageMediaCurrent(tx,{familyId:sourceFamily.id,versionId:version.id,sha256:version.sha256,path:version.path}))continue;
  eligibleSources.push({familyId:sourceFamily.id,versionId:version.id,sha256:version.sha256,title:sourceFamily.label||sourceFamily.id,sameEntity:(sourceFamily.domainContext?.entityIds||[]).includes(requirement.entity.id),...(version.mediaToken?{mediaToken:version.mediaToken,mediaUrl:'/api/v8/media/'+version.mediaToken}:{})});
 }
 eligibleSources.sort((a,b)=>Number(b.sameEntity)-Number(a.sameEntity)||a.title.localeCompare(b.title)||a.familyId.localeCompare(b.familyId));
 return {protocol:MATERIAL_USAGE_PROTOCOL,supported:true,readOnly:false,requirementId,releaseId:view.releaseId,requirement,reviewSpec:requirement.reviewSpec,eligibleSources,blockers:eligibleSources.length?[]:['暂无具备精确原正式采用事件的可用图片']};
}
async function context(tx,input,api){
 const target=exactTarget(input),view=await tx.readView();if(!view.snapshot||!api?.projectOperationalState)fail('缺少当前已发布资料或正式原采用投影器');
 const model=await loadMaterialUsageEvidence(tx,view.snapshot.productionModel,{view}),requirement=materialUsageRequirementBasis(model,target.requirementId),events=view.eventsByKind||{},snapshot={...view.snapshot,productionModel:model};
 const state=api.projectOperationalState(snapshot,events.review||[],events['asset-version']||[],events.run||[],events['source-operation']||[],events['execution-request']||[],{executionDefinitions:view.recipes?.executionDefinitions||[]});
 const family=state.assetFamiliesById?.[target.familyId],version=state.assetVersionsById?.[target.versionId],blockers=[];
 if(model.assetFamilies.find(f=>f.id===target.familyId)?.kind!=='IMAGE')blockers.push('UNSUPPORTED_MEDIA_TYPE：本版用途绑定仅支持IMAGE');
 if(!family||!version||version.familyId!==target.familyId||version.sha256!==target.sha256||!version.path||family.currentVersionId!==version.id||family.canFlowDownstream!==true||version.canFlowDownstream!==true||version.lifecycleState!=='RELEASED'||!['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(version.projectRightsGate))blockers.push('原版本当前未精确采用放行；用途审阅不能豁免原权利或失效');
 const adoptionId=version?.reviewCorrection?.headEventId,adoptions=(events.review||[]).filter(e=>e.eventId===adoptionId),adoption=adoptions[0];
 if(adoptions.length!==1||adoption.subjectType!=='ASSET'||['reviewPurpose','usageBindingId','usageId'].some(k=>Object.hasOwn(adoption,k))||adoption.familyId!==target.familyId||adoption.versionId!==target.versionId||adoption.versionSha256!==target.sha256||adoption.action!=='APPROVE_AND_RELEASE'||adoption.effect!=='APPLIED'||adoption.applicationStatus!=='APPLIED')blockers.push('缺少当前精确有效的原正式ASSET采用事件');
 const registered=await tx.getMedia(target.familyId,target.versionId),source={familyId:target.familyId,versionId:target.versionId,sha256:target.sha256,path:version?.path||null,media:registered?{mediaId:registered.mediaId,versionId:registered.versionId,sha256:registered.sha256,relativePath:registered.relativePath,byteSize:registered.byteSize}:null,adoption:adoption?{eventId:adoption.eventId,sha256:usageHash(adoption)}:null,projectRightsGate:version?.projectRightsGate||'UNKNOWN',domainContextHash:family?.domainContextHash||null};
 if(!await materialUsageMediaCurrent(tx,source))blockers.push('原件缺少可用正式登记，或已私有/试制/原始来源/退役');
 const usageId=materialUsageId(target.requirementId,target.familyId),head=(model.materialUsageEvidence||[]).filter(r=>r.body.usageId===usageId).sort((a,b)=>b.event.eventSequence-a.event.eventSequence)[0]||null,meta=await tx.getMetadata();
 const basis={requirement,source,previousHead:head?{eventId:head.event.eventId,sha256:usageHash(head.event)}:null,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch};
 return {target,view,model,state,source,adoption,usageId,head,basis,basisHash:usageHash(basis),blockers};
}
export async function getMaterialUsageWorkspace(tx,input,{api}){
 const c=await context(tx,input,api),record=await tx.getAux(MATERIAL_USAGE_NS.drafts,c.usageId),draft=read(record),current=draft&&draft.basisHash===c.basisHash&&draft.baseReleaseId===c.view.releaseId;
 return {...c.target,protocol:MATERIAL_USAGE_PROTOCOL,supported:true,readOnly:false,usageId:c.usageId,releaseId:c.view.releaseId,basisHash:c.basisHash,requirement:c.basis.requirement,sourceVersion:c.source,sourceAdoption:c.adoption,reviewSpec:c.basis.requirement.reviewSpec,head:c.head?.event||null,draftHeadRevisionId:record?.revisionId||null,draft:current?{...draft,revisionId:record.revisionId}:null,staleDraft:draft&&!current?{...draft,revisionId:record.revisionId,reason:'用途目标、原采用、规范或当前用途头已变化；旧稿保留，请按当前依据重新核对。'}:null,blockers:c.blockers,jobs:(await tx.listAux(MATERIAL_USAGE_NS.jobs)).map(read).filter(j=>j?.usageId===c.usageId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(({jobId,status,error,result,input})=>({jobId,requestId:input.requestId,status,error,result}))};
}
function contentFor(c,value){if(c.blockers.length)fail(c.blockers.join('、'));return validateMaterialUsageContent(value,c.basis);}
export async function saveMaterialUsageDraft(tx,input,{api}){
 const c=await context(tx,input,api);if(input.expectedReleaseId!==c.view.releaseId||input.expectedBasisHash!==c.basisHash)fail('新用途基线已变化，请重新核对');
 if((await tx.listAux(MATERIAL_USAGE_NS.jobs)).map(read).some(j=>j?.usageId===c.usageId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('该用途仍有未完成或结果未知的任务');
 const content=contentFor(c,input.content),record=await put(tx,MATERIAL_USAGE_NS.drafts,c.usageId,{...c.target,usageId:c.usageId,baseReleaseId:c.view.releaseId,basisHash:c.basisHash,content},input.expectedDraftRevisionId);
 return {revisionId:record.revisionId,modelCalls:0,formalAdoptionPerformed:false,formalUsageReviewPerformed:false};
}
export async function previewMaterialUsage(tx,input,{api}){
 const c=await context(tx,input,api),record=await tx.getAux(MATERIAL_USAGE_NS.drafts,c.usageId),draft=read(record);
 if(!draft||record.revisionId!==input.draftRevisionId||draft.baseReleaseId!==c.view.releaseId||draft.basisHash!==c.basisHash||usageHash(exactTarget(draft))!==usageHash(c.target))fail('用途草稿或精确基线已变化');
 const content=contentFor(c,draft.content),base={schemaVersion:MATERIAL_USAGE_SCHEMA,usageId:c.usageId,baseReleaseId:c.view.releaseId,draftRevisionId:record.revisionId,basis:c.basis,content},body={...base,id:'MUSE-REV-'+usageHash(base).slice(0,32)};
 return {usage:body,previewHash:usageHash(body),modelCalls:0,formalAdoptionPerformed:false,formalUsageReviewPerformed:false};
}
export async function enqueueMaterialUsage(tx,input,{api}){
 productionId(input.requestId);const old=read(await tx.getAux(MATERIAL_USAGE_NS.requests,input.requestId));if(old){if(old.requestHash!==usageHash(input))fail('请求身份已用于其他用途判断');return old.result;}
 const preview=await previewMaterialUsage(tx,input,{api});if(preview.previewHash!==input.previewHash)fail('用途预览已变化');
 const usageId=preview.usage.usageId;if((await tx.listAux(MATERIAL_USAGE_NS.jobs)).map(read).some(j=>j?.usageId===usageId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('该用途有未完成或结果未知的任务');
 const meta=await tx.getMetadata(),job={jobId:'material_usage_'+randomUUID(),usageId,status:'QUEUED',createdAt:new Date().toISOString(),instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,input,preview};
 await put(tx,MATERIAL_USAGE_NS.jobs,job.jobId,job);const result={jobId:job.jobId,status:'QUEUED',modelCalls:0,formalAdoptionPerformed:false,formalUsageReviewPerformed:false};await put(tx,MATERIAL_USAGE_NS.requests,input.requestId,{requestHash:usageHash(input),result});return result;
}
export async function applyMaterialUsageJob(tx,{jobId,api}){
 const record=await tx.getAux(MATERIAL_USAGE_NS.jobs,jobId),job=read(record);if(job?.status==='SUCCEEDED')return job.result;if(job?.status!=='QUEUED')fail('用途任务不能自动重试');
 const meta=await tx.getMetadata();if(meta.instanceId!==job.instanceId||meta.runtimeEpoch!==job.runtimeEpoch)fail('用途任务实例或运行代次已变化');
 const preview=await previewMaterialUsage(tx,job.input,{api});if(preview.previewHash!==job.preview.previewHash)fail('执行前用途闭包已变化');
 const c=await context(tx,job.input,api),body=preview.usage;
 if(!api.safeGeneratedPath||!api.hashStableFile)fail('缺少受控原件实际读取验证器');
 const original=await api.safeGeneratedPath(c.source.path,{versionId:c.source.versionId,sha256:c.source.sha256}),file=await api.hashStableFile(original);if(file.sha256!==c.source.sha256||file.size!==c.source.media.byteSize)fail('原件实际字节已变化');
 const sourceRef='story/material-usages/'+body.id+'.json',doc=await tx.putDocument({documentId:'material-usage:'+body.id,aliases:[sourceRef],expectedRevisionId:null,bytes:canonicalJson(body),mediaType:'application/json',metadata:{sourceRole:MATERIAL_USAGE_SOURCE}}),source={sourceRef,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
 const {event}=await tx.appendEvent({kind:MATERIAL_USAGE_EVENT,idempotencyKey:job.input.requestId,requestHash:usageHash(job.input),eventSchemaVersion:'1.0',payload:materialUsageEventPayload(body,source)});
 const snapshot=structuredClone(c.view.snapshot),ledger={id:body.id,usageId:body.usageId,eventId:event.eventId,...source};snapshot.productionModel.materialUsageLedger=[...(snapshot.productionModel.materialUsageLedger||[]),ledger];delete snapshot.productionModel.materialUsageEvidence;
 snapshot.snapshotId='snapshot_'+usageHash({previous:c.view.snapshot.snapshotId,usage:body.id,eventId:event.eventId}).slice(0,32);const recipes={...structuredClone(c.view.recipes),snapshotId:snapshot.snapshotId},sourceRevisionIds=[...c.view.sourceRevisionIds,doc.revisionId];
 await loadMaterialUsageEvidence(tx,snapshot.productionModel,{view:{...c.view,snapshot,sourceRevisionIds}});
 const release=await tx.publishRelease({snapshot,recipes,expectedReleaseId:c.view.releaseId,sourceRevisionIds}),result={releaseId:release.releaseId,usageId:body.usageId,usageRevisionId:body.id,eventId:event.eventId,action:event.action,...c.target,...source,modelCalls:0,formalAdoptionPerformed:false,formalUsageReviewPerformed:true};
 await put(tx,MATERIAL_USAGE_NS.jobs,jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
export async function runMaterialUsageIteration({repository,api}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能提交用途判断');
 const job=await repository.readTransaction(async tx=>(await listWorkerRuntimeJobs(tx,MATERIAL_USAGE_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]);if(!job)return {processed:false};
 try{return {processed:true,status:'SUCCEEDED',...await withRepositoryMediaRead(repository,()=>repository.writeTransaction(tx=>applyMaterialUsageJob(tx,{jobId:job.jobId,api})))};}catch(error){
  const recovery=await repository.writeTransaction(async tx=>{const record=await tx.getAux(MATERIAL_USAGE_NS.jobs,job.jobId),current=read(record);if(current?.status==='SUCCEEDED')return {status:'SUCCEEDED',...current.result};if(current?.status==='QUEUED'){await put(tx,MATERIAL_USAGE_NS.jobs,job.jobId,{...current,status:'FAILED',error:String(error.message||error).slice(0,1500)},record.revisionId);return {status:'FAILED'};}return {status:current?.status||'RESULT_UNKNOWN'};});return {processed:true,jobId:job.jobId,...recovery};
 }
}
