import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './bytes.mjs';
import {productionId} from './shot-production-model.mjs';
import {ASSET_CONTEXT_PROTOCOL,ASSET_CONTEXT_EVENT,ASSET_CONTEXT_SOURCE,ASSET_CONTEXT_SCHEMA,contextHash,contextCheck,assetContextEventManifest,assetContextId,assetContextTarget,assetContextCurrentBasis,validateAssetContextContent,assetContextEventPayload,assertAssetContextSource,assertLegacyAssetPublication} from './asset-context-revalidation-model.mjs';
import {loadAssetContextRevalidationEvidence} from './asset-context-revalidation-preservation.mjs';
import {materialUsageMediaCurrent} from './material-usage-preservation.mjs';
import {withRepositoryMediaRead} from './media-read-lease.mjs';
export const ASSET_CONTEXT_NS={drafts:'asset-context-revalidation-drafts',jobs:'asset-context-revalidation-jobs',requests:'asset-context-revalidation-requests'};
const read=row=>row&&!row.deleted?JSON.parse(row.bytes):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const put=(tx,ns,key,value,expectedRevisionId=null)=>tx.putAux({namespace:ns,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});
const exactTarget=assetContextTarget;
async function context(tx,input,api){
 const target=exactTarget(input),view=await tx.readView();contextCheck(view.snapshot&&api?.assetReviewContextHash&&api?.assetReviewTransitionProjection,'缺少当前已发布资料或原采用投影');
 const model=await loadAssetContextRevalidationEvidence(tx,view.snapshot.productionModel,{view}),current=assetContextCurrentBasis(model,target),snapshot={...view.snapshot,productionModel:model},events=await tx.listEvents(),e=view.eventsByKind||{},blockers=[];
 const state=api.projectOperationalState(snapshot,e.review||[],e['asset-version']||[],e.run||[],e['source-operation']||[],e['execution-request']||[],{executionDefinitions:view.recipes?.executionDefinitions||[]}),version=model.assetVersions.find(v=>v.id===target.versionId),family=model.assetFamilies.find(f=>f.id===target.familyId);
 const transition=api.assetReviewTransitionProjection(snapshot,target,{reviews:e.review||[],candidates:e['asset-version']||[],runs:e.run||[],executionRequests:e['execution-request']||[],sourceOperations:e['source-operation']||[]});
 const reasons=transition.lockReasons||[];if(transition.headEventId||(e.review||[]).some(r=>r.subjectType==='ASSET'&&r.familyId===target.familyId&&r.versionId===target.versionId))blockers.push('已有现代ASSET审阅；不能借旧采用关系复核另开链');
 for(const reason of reasons)if(reason.code!=='TARGET_ASSET_VERSION_ALREADY_ADVANCED')blockers.push(reason.code);
 const projected=state.assetVersionsById?.[target.versionId];if(!projected||!['RELEASED','REVISION_REQUIRED'].includes(projected.lifecycleState)||!['CLEAR','CLEAR_BY_USER_ATTESTATION','NOT_APPLICABLE'].includes(projected.projectRightsGate)||projected.promptSyncRequired&&projected.promptSyncState!=='CURRENT')blockers.push('原件独立权利、同步或撤销状态不允许复核');
 const registered=await tx.getMedia(target.familyId,target.versionId),source={...target,path:version.path,media:registered?{mediaId:registered.mediaId,versionId:registered.versionId,sha256:registered.sha256,relativePath:registered.relativePath,byteSize:registered.byteSize}:null,projectRightsGate:version.projectRightsGate};
 if(!await materialUsageMediaCurrent(tx,source))blockers.push('原件正式登记、可见性、退役或精确SHA不通过');
 const release=await tx.readRelease(view.releaseId);contextCheck(release&&sha256(release.snapshotBytes)===release.snapshotSha256&&sha256(release.recipesBytes)===release.recipesSha256,'当前发布字节不可核');
 const publication={release,snapshot:JSON.parse(release.snapshotBytes),recipes:JSON.parse(release.recipesBytes)},defs=(view.recipes.executionDefinitions||[]).filter(d=>d.id===version.executionDefinitionRef),definition=defs[0];contextCheck(defs.length===1,'原producer定义不唯一');
 contextCheck(typeof definition.source?.path==='string','仅支持可核原producer文档的旧采用对象');
 const doc=await tx.getPublishedDocument(definition.source.path);contextCheck(doc&&view.sourceRevisionIds.includes(doc.revisionId),'原producer固定来源未发布');
 const legacyAdoptionProof={releaseId:release.releaseId,snapshotId:release.snapshotId,snapshotSha256:release.snapshotSha256,recipesSha256:release.recipesSha256,profileRevisionId:release.profileRevisionId,familyHash:contextHash(family),versionHash:contextHash(version),definitionId:definition.id,definitionRowHash:contextHash(definition),producerSource:{sourceRef:definition.source.path,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256},inputBindings:(definition.upload?.items||[]).map(x=>({familyId:x.assetFamilyRef,versionId:x.assetVersionRef,sha256:x.sha256,path:x.path,mediaType:x.mediaType}))};
 const revalidationId=assetContextId(target),head=(model.assetContextRevalidationEvidence||[]).filter(r=>r.body.revalidationId===revalidationId).sort((a,b)=>b.event.eventSequence-a.event.eventSequence)[0]||null,meta=await tx.getMetadata();
 const basis={instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,source,legacyAdoptionProof,current,contextHash:api.assetReviewContextHash(snapshot,target.familyId,target.versionId,target.sha256),previousHead:head?{eventId:head.event.eventId,sha256:contextHash(head.event)}:null,consumerProof:{eventSetHash:contextHash(assetContextEventManifest(events)),transitionReasons:reasons}};
 assertLegacyAssetPublication({basis},publication,[doc]);
 if(head&&head.body.basis.contextHash===basis.contextHash)blockers.push('该原版当前关系已完成复核，无需重复确认');
 return{target,view,model,state,source,revalidationId,head,basis,basisHash:contextHash(basis),blockers,publication,documents:[doc]};
}
export async function getAssetContextRevalidationWorkspace(tx,input,{api}){
 const c=await context(tx,input,api),record=await tx.getAux(ASSET_CONTEXT_NS.drafts,c.revalidationId),draft=read(record),current=draft&&draft.basisHash===c.basisHash&&draft.baseReleaseId===c.view.releaseId;
 return {...c.target,protocol:ASSET_CONTEXT_PROTOCOL,supported:true,readOnly:false,revalidationId:c.revalidationId,releaseId:c.view.releaseId,basisHash:c.basisHash,domainContext:c.basis.current.domainContext,sourceVersion:c.source,legacyAdoptionProof:c.basis.legacyAdoptionProof,reviewSpec:c.basis.current.reviewSpec,head:c.head?.event||null,draftHeadRevisionId:record?.revisionId||null,draft:current?{...draft,revisionId:record.revisionId}:null,staleDraft:draft&&!current?{...draft,revisionId:record.revisionId,reason:'关系复核目标、原采用、规范或当前用途头已变化；旧稿保留，请按当前依据重新核对。'}:null,blockers:c.blockers,jobs:(await tx.listAux(ASSET_CONTEXT_NS.jobs)).map(read).filter(j=>j?.revalidationId===c.revalidationId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(({jobId,status,error,result,input})=>({jobId,requestId:input.requestId,status,error,result}))};
}
function contentFor(c,value){if(c.blockers.length)fail(c.blockers.join('、'));return validateAssetContextContent(value,c.basis);}
export async function saveAssetContextRevalidationDraft(tx,input,{api}){
 const c=await context(tx,input,api);if(input.expectedReleaseId!==c.view.releaseId||input.expectedBasisHash!==c.basisHash)fail('新复核基线已变化，请重新核对');
 if((await tx.listAux(ASSET_CONTEXT_NS.jobs)).map(read).some(j=>j?.revalidationId===c.revalidationId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('该关系复核仍有未完成或结果未知的任务');
 const content=contentFor(c,input.content),record=await put(tx,ASSET_CONTEXT_NS.drafts,c.revalidationId,{...c.target,revalidationId:c.revalidationId,baseReleaseId:c.view.releaseId,basisHash:c.basisHash,content},input.expectedDraftRevisionId);
 return {revisionId:record.revisionId,modelCalls:0,formalAdoptionPerformed:false,contextRevalidationPerformed:false};
}
export async function previewAssetContextRevalidation(tx,input,{api}){
 const c=await context(tx,input,api),record=await tx.getAux(ASSET_CONTEXT_NS.drafts,c.revalidationId),draft=read(record);
 if(!draft||record.revisionId!==input.draftRevisionId||draft.baseReleaseId!==c.view.releaseId||draft.basisHash!==c.basisHash||contextHash(exactTarget(draft))!==contextHash(c.target))fail('复核草稿或精确基线已变化');
 const content=contentFor(c,draft.content),base={schemaVersion:ASSET_CONTEXT_SCHEMA,revalidationId:c.revalidationId,baseReleaseId:c.view.releaseId,draftRevisionId:record.revisionId,basis:c.basis,content},body={...base,id:'ACTX-REV-'+contextHash(base).slice(0,32)};
 assertAssetContextSource(body);assertLegacyAssetPublication(body,c.publication,c.documents);return {revalidation:body,previewHash:contextHash(body),modelCalls:0,formalAdoptionPerformed:false,contextRevalidationPerformed:false};
}
export async function enqueueAssetContextRevalidation(tx,input,{api}){
 productionId(input.requestId);const old=read(await tx.getAux(ASSET_CONTEXT_NS.requests,input.requestId));if(old){if(old.requestHash!==contextHash(input))fail('请求身份已用于其他关系复核');return old.result;}
 const preview=await previewAssetContextRevalidation(tx,input,{api});if(preview.previewHash!==input.previewHash)fail('复核预览已变化');
 const revalidationId=preview.revalidation.revalidationId;if((await tx.listAux(ASSET_CONTEXT_NS.jobs)).map(read).some(j=>j?.revalidationId===revalidationId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('该关系复核有未完成或结果未知的任务');
 const meta=await tx.getMetadata(),job={jobId:'asset_context_'+randomUUID(),revalidationId,requirementId:preview.revalidation.basis.current.requirementId,status:'QUEUED',createdAt:new Date().toISOString(),instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,input,preview};
 await put(tx,ASSET_CONTEXT_NS.jobs,job.jobId,job);const result={jobId:job.jobId,status:'QUEUED',modelCalls:0,formalAdoptionPerformed:false,contextRevalidationPerformed:false};await put(tx,ASSET_CONTEXT_NS.requests,input.requestId,{requestHash:contextHash(input),result});return result;
}
export async function applyAssetContextRevalidationJob(tx,{jobId,api}){
 const record=await tx.getAux(ASSET_CONTEXT_NS.jobs,jobId),job=read(record);if(job?.status==='SUCCEEDED')return job.result;if(job?.status!=='QUEUED')fail('复核任务不能自动重试');
 const meta=await tx.getMetadata();if(meta.instanceId!==job.instanceId||meta.runtimeEpoch!==job.runtimeEpoch)fail('复核任务实例或运行代次已变化');
 const preview=await previewAssetContextRevalidation(tx,job.input,{api});if(preview.previewHash!==job.preview.previewHash||job.requirementId!==preview.revalidation.basis.current.requirementId)fail('执行前复核闭包已变化');
 const c=await context(tx,job.input,api),body=preview.revalidation;
 if(!api.safeGeneratedPath||!api.hashStableFile)fail('缺少受控原件实际读取验证器');
 const original=await api.safeGeneratedPath(c.source.path,{versionId:c.source.versionId,sha256:c.source.sha256}),file=await api.hashStableFile(original);if(file.sha256!==c.source.sha256||file.size!==c.source.media.byteSize)fail('原件实际字节已变化');
 const sourceRef='story/asset-context-revalidations/'+body.id+'.json',doc=await tx.putDocument({documentId:'asset-context-revalidation:'+body.id,aliases:[sourceRef],expectedRevisionId:null,bytes:canonicalJson(body),mediaType:'application/json',metadata:{sourceRole:ASSET_CONTEXT_SOURCE}}),source={sourceRef,sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256};
 const {event}=await tx.appendEvent({kind:ASSET_CONTEXT_EVENT,idempotencyKey:job.input.requestId,requestHash:contextHash(job.input),eventSchemaVersion:'1.0',payload:assetContextEventPayload(body,source)});
 const snapshot=structuredClone(c.view.snapshot),ledger={id:body.id,revalidationId:body.revalidationId,eventId:event.eventId,...source};snapshot.productionModel.assetContextRevalidationLedger=[...(snapshot.productionModel.assetContextRevalidationLedger||[]),ledger];delete snapshot.productionModel.assetContextRevalidationEvidence;
 snapshot.snapshotId='snapshot_'+contextHash({previous:c.view.snapshot.snapshotId,revalidation:body.id,eventId:event.eventId}).slice(0,32);const recipes={...structuredClone(c.view.recipes),snapshotId:snapshot.snapshotId},sourceRevisionIds=[...c.view.sourceRevisionIds,doc.revisionId];
 await loadAssetContextRevalidationEvidence(tx,snapshot.productionModel,{view:{...c.view,snapshot,sourceRevisionIds}});
 const release=await tx.publishRelease({snapshot,recipes,expectedReleaseId:c.view.releaseId,sourceRevisionIds}),result={releaseId:release.releaseId,revalidationId:body.revalidationId,revalidationRevisionId:body.id,eventId:event.eventId,action:event.action,...c.target,...source,modelCalls:0,formalAdoptionPerformed:false,contextRevalidationPerformed:true};
 await put(tx,ASSET_CONTEXT_NS.jobs,jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
export async function runAssetContextRevalidationIteration({repository,api}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能提交关系复核');
 const job=await repository.readTransaction(async tx=>(await tx.listAux(ASSET_CONTEXT_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]);if(!job)return {processed:false};
 try{return {processed:true,status:'SUCCEEDED',...await withRepositoryMediaRead(repository,()=>repository.writeTransaction(tx=>applyAssetContextRevalidationJob(tx,{jobId:job.jobId,api})))};}catch(error){
  const recovery=await repository.writeTransaction(async tx=>{const record=await tx.getAux(ASSET_CONTEXT_NS.jobs,job.jobId),current=read(record);if(current?.status==='SUCCEEDED')return {status:'SUCCEEDED',...current.result};if(current?.status==='QUEUED'){await put(tx,ASSET_CONTEXT_NS.jobs,job.jobId,{...current,status:'FAILED',error:String(error.message||error).slice(0,1500)},record.revisionId);return {status:'FAILED'};}return {status:current?.status||'RESULT_UNKNOWN'};});return {processed:true,jobId:job.jobId,...recovery};
 }
}
