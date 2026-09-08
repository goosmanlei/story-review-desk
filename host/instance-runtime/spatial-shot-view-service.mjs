import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './bytes.mjs';
import {productionId} from './shot-production-model.mjs';
import {applyProductionSpatialProjection,prepareSpatialShotView,validateSpatialShotViewAuthorContent,spatialShotViewProjection,spatialCameraOrigins,spatialCameraDirections,spatialDressingKinds} from './spatial-production.mjs';

export const SPATIAL_SHOT_VIEW_NS={drafts:'spatial-shot-view-drafts',jobs:'spatial-shot-view-jobs',requests:'spatial-shot-view-requests'};
export const spatialShotViewOptions={cameraOrigins:spatialCameraOrigins,cameraDirections:spatialCameraDirections,cameraHeights:['EYE_LEVEL','LOW','HIGH'],dressingKinds:spatialDressingKinds,relations:['NORTH_OF','SOUTH_OF','EAST_OF','WEST_OF','AT'],orientations:['EAST_WEST','NORTH_SOUTH','NONE']};
const hash=value=>sha256(canonicalJson(value));
const read=row=>row&&!row.deleted?JSON.parse(row.bytes):null;
const fail=(message,code='DOMAIN_CONFLICT')=>{throw Object.assign(new Error(message),{code});};
const put=(tx,namespace,key,value,expectedRevisionId=null)=>tx.putAux({namespace,key,bytes:canonicalJson(value),mediaType:'application/json',expectedRevisionId});
export const spatialShotViewDefaultId=sceneId=>'SPATIAL-AUTHOR-'+hash({sceneId}).slice(0,24);
export function spatialShotViewLocations(model){return (model.spatialEvidence?.locationPackages||[]).map(pack=>({id:pack.id,name:String(pack.name||pack.id),zones:(pack.zones||[]).map(z=>({id:z.id,name:String(z.name||z.label||z.id)})),cameras:(pack.cameras||[]).map(c=>({id:c.id,name:String(c.name||c.id),...(c.zoneId?{zoneId:c.zoneId}:{}),...(Array.isArray(c.zoneIds)?{zoneIds:c.zoneIds}:{} )}))}));}
function authored(row){const body=row.content,{id:cameraId,...camera}=body.camera;void cameraId;return {viewId:body.viewId,sceneId:body.sceneBinding.sceneId,locationId:body.base.locationId,zoneId:body.base.zoneId,camera,dressing:structuredClone(body.dressing),note:body.note};}
async function context(tx,input){
 productionId(input.sceneId);const viewId=input.viewId||spatialShotViewDefaultId(input.sceneId);productionId(viewId);
 const view=await tx.readView();if(!view.snapshot)fail('实例尚无已发布制作资料');
 const model=await applyProductionSpatialProjection(tx,{...view.snapshot.productionModel,sourceHashes:view.snapshot.sourceHashes},{view});
 const versions=(model.spatialShotViews||[]).filter(row=>row.viewId===viewId);
 if(versions.some(row=>row.content.sceneBinding.sceneId!==input.sceneId))fail('局部空间视图不能换绑永久场');
 const current=versions.filter(row=>row.scopeRole==='CURRENT');if(current.length>1)fail('局部空间视图当前版本不唯一');
 const scripts=(model.sceneScriptRevisions||[]).filter(row=>row.sceneId===input.sceneId&&row.scopeRole==='CURRENT'),script=scripts.length===1?scripts[0]:null;
 const releases=(model.episodeNarrativeReleases||[]).filter(row=>row.id===script?.episodeNarrativeReleaseId&&row.scopeRole==='CURRENT'&&row.sourceSyncState==='SOURCE_CURRENT'),release=releases.length===1?releases[0]:null,blockers=[];
 if(!script||!release||(release.reviewInput?.scenes||[]).filter(s=>s.id===input.sceneId&&s.contentHash===script.contentHash).length!==1)blockers.push('当前永久场正文尚未通过本集正式审阅并同步');
 if(model.spatialEvidence?.projectionSchemaVersion!=='PRODUCTION_SPATIAL_V1')blockers.push('当前空间母版尚未精确发布');
 const meta=await tx.getMetadata(),basis={sceneId:input.sceneId,viewId,sceneBinding:script&&release?{sceneScriptRevisionId:script.id,sceneContentHash:script.contentHash,episodeNarrativeReleaseId:release.id,episodeUid:release.episodeUid}:null,sourceBinding:model.spatialEvidence?{sourceRef:model.spatialEvidence.sourceRef,sourceRevisionId:model.spatialEvidence.sourceRevisionId,sourceSha256:model.spatialEvidence.sourceSha256}:null,currentView:current[0]?{id:current[0].id,contentHash:current[0].contentHash,sourceRevisionId:current[0].sourceRevisionId,sourceSha256:current[0].sourceSha256}:null,instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch};
 return {view,model,viewId,currentView:current[0]||null,basis,basisHash:hash(basis),blockers};
}
export async function getSpatialShotViewWorkspace(tx,input){
 const c=await context(tx,input),record=await tx.getAux(SPATIAL_SHOT_VIEW_NS.drafts,c.viewId),draft=read(record),current=draft&&draft.basisHash===c.basisHash&&draft.baseReleaseId===c.view.releaseId;
 if(draft&&draft.sceneId!==input.sceneId)fail('空间草稿永久场归属冲突');
 return {sceneId:input.sceneId,viewId:c.viewId,releaseId:c.view.releaseId,basis:c.basis,basisHash:c.basisHash,draftHeadRevisionId:record?.revisionId||null,draft:current?{...draft,revisionId:record.revisionId}:null,staleDraft:draft&&!current?{...draft,revisionId:record.revisionId,reason:'场正文、空间母版或局部视图已变化；旧稿保留，核对当前依据后重新保存。'}:null,defaults:c.currentView?authored(c.currentView):{sceneId:input.sceneId,viewId:c.viewId,locationId:'',zoneId:'',camera:{origin:'',looks:'',height:'EYE_LEVEL',purpose:''},dressing:[],note:''},currentView:c.currentView,availableLocations:spatialShotViewLocations(c.model),options:spatialShotViewOptions,blockers:c.blockers,jobs:(await tx.listAux(SPATIAL_SHOT_VIEW_NS.jobs)).map(read).filter(j=>j?.viewId===c.viewId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20).map(({jobId,status,error,result})=>({jobId,status,error,result})),readOnly:false};
}
function contentFor(c,value){
 let content;try{content=validateSpatialShotViewAuthorContent(value);}catch(error){fail(error.message,'DOMAIN_INVALID');}
 if(content.viewId!==c.viewId||content.sceneId!==c.basis.sceneId)fail('空间作者内容与当前永久场或视图身份不一致');
 if(c.blockers.length)fail(c.blockers.join('、'));
 const body=prepareSpatialShotView(c.model,content);return {content,body};
}
export async function saveSpatialShotViewDraft(tx,input){
 productionId(input.viewId);
 const c=await context(tx,input);if(c.view.releaseId!==input.expectedReleaseId||c.basisHash!==input.expectedBasisHash)fail('空间制作基线已变化，请核对当前场正文和母版');
 const {content}=contentFor(c,input.content),record=await put(tx,SPATIAL_SHOT_VIEW_NS.drafts,c.viewId,{sceneId:input.sceneId,viewId:c.viewId,baseReleaseId:c.view.releaseId,basisHash:c.basisHash,content},input.expectedDraftRevisionId);
 return {revisionId:record.revisionId,modelCalls:0,formalAdoptionPerformed:false};
}
export async function previewSpatialShotView(tx,input){
 productionId(input.viewId);
 const c=await context(tx,input),record=await tx.getAux(SPATIAL_SHOT_VIEW_NS.drafts,c.viewId),draft=read(record);
 if(!draft||record.revisionId!==input.draftRevisionId||draft.sceneId!==input.sceneId||draft.baseReleaseId!==c.view.releaseId||draft.basisHash!==c.basisHash)fail('空间草稿、场正文或母版基线已变化');
 const {body}=contentFor(c,draft.content);if((c.model.spatialShotViews||[]).some(row=>row.id===body.id))fail('局部空间内容与已发布版本相同；如需重新制作，请注明本次设计依据');
 return {view:body,previewHash:hash({view:body,draftRevisionId:record.revisionId,baseReleaseId:c.view.releaseId,basisHash:c.basisHash}),modelCalls:0,formalAdoptionPerformed:false};
}
export async function enqueueSpatialShotView(tx,input){
 productionId(input.viewId);
 productionId(input.requestId);const previous=read(await tx.getAux(SPATIAL_SHOT_VIEW_NS.requests,input.requestId));if(previous){if(previous.requestHash!==hash(input))fail('请求身份已用于其他空间内容');return previous.result;}
 const preview=await previewSpatialShotView(tx,input);if(preview.previewHash!==input.previewHash)fail('空间预览已变化');
 if((await tx.listAux(SPATIAL_SHOT_VIEW_NS.jobs)).map(read).some(j=>j?.viewId===input.viewId&&['QUEUED','RUNNING','RESULT_UNKNOWN'].includes(j.status)))fail('本局部视图仍有待处理或结果未知的任务');
 const meta=await tx.getMetadata(),job={jobId:'spatial_shot_view_'+randomUUID(),sceneId:input.sceneId,viewId:input.viewId,createdAt:new Date().toISOString(),status:'QUEUED',instanceId:meta.instanceId,runtimeEpoch:meta.runtimeEpoch,input,preview};
 await put(tx,SPATIAL_SHOT_VIEW_NS.jobs,job.jobId,job);const result={jobId:job.jobId,status:'QUEUED',modelCalls:0,formalAdoptionPerformed:false};await put(tx,SPATIAL_SHOT_VIEW_NS.requests,input.requestId,{requestHash:hash(input),result});return result;
}
/** Host worker publication: append the local view source; never rewrite the map. */
export async function applySpatialShotViewJob(tx,{jobId}){
 const record=await tx.getAux(SPATIAL_SHOT_VIEW_NS.jobs,jobId),job=read(record);if(job?.status==='SUCCEEDED')return job.result;if(job?.status!=='QUEUED')fail('空间任务不能自动重试');
 const meta=await tx.getMetadata();if(meta.instanceId!==job.instanceId||meta.runtimeEpoch!==job.runtimeEpoch)fail('空间任务的实例或运行代次已经变化');
 const preview=await previewSpatialShotView(tx,job.input);if(preview.previewHash!==job.preview.previewHash)fail('工作器执行前空间预览已变化');
 const c=await context(tx,job.input),body=preview.view,sourceRef='story/spatial-views/'+body.id+'.json',source=await tx.putDocument({documentId:'spatial-shot-view:'+body.id,aliases:[sourceRef],expectedRevisionId:null,bytes:canonicalJson(body),mediaType:'application/json',metadata:{sourceRole:'SPATIAL_SHOT_VIEW'}}),row=spatialShotViewProjection(body,{sourceRef,sourceRevisionId:source.revisionId,sourceSha256:source.sha256});
 const snapshot=structuredClone(c.view.snapshot),model=snapshot.productionModel;
 model.spatialShotViews=[...(model.spatialShotViews||[]).map(previous=>previous.viewId===body.viewId?{...previous,scopeRole:'EVIDENCE_ONLY'}:previous),row];
 snapshot.snapshotId='snapshot_'+hash({previous:c.view.snapshot.snapshotId,viewId:body.id,sourceSha256:source.sha256}).slice(0,32);const recipes={...structuredClone(c.view.recipes),snapshotId:snapshot.snapshotId},sourceRevisionIds=[...c.view.sourceRevisionIds,source.revisionId];
 // Verify both the historical base bytes and every immutable view while still
 // inside the publication transaction. No client-supplied proof is persisted.
 await applyProductionSpatialProjection(tx,{...model,sourceHashes:snapshot.sourceHashes},{view:{...c.view,snapshot,sourceRevisionIds}});
 const release=await tx.publishRelease({snapshot,recipes,expectedReleaseId:c.view.releaseId,sourceRevisionIds}),result={releaseId:release.releaseId,viewId:body.viewId,spatialShotViewId:body.id,sourceRevisionId:source.revisionId,contentHash:row.contentHash,modelCalls:0,formalAdoptionPerformed:false};
 await put(tx,SPATIAL_SHOT_VIEW_NS.jobs,jobId,{...job,status:'SUCCEEDED',completedAt:new Date().toISOString(),result},record.revisionId);return result;
}
export async function runSpatialShotViewIteration({repository}){
 if(repository.readOnly||process.env.REVIEW_INSTANCE_READ_ONLY==='1'||process.env.REVIEW_REMOTE_READ_ONLY==='1')throw Error('只读实例不能发布空间视图');
 const job=await repository.readTransaction(async tx=>(await tx.listAux(SPATIAL_SHOT_VIEW_NS.jobs)).map(read).filter(j=>j?.status==='QUEUED').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]);if(!job)return {processed:false};
 try{return {processed:true,status:'SUCCEEDED',...await repository.writeTransaction(tx=>applySpatialShotViewJob(tx,{jobId:job.jobId}))};}catch(error){
  const recovered=await repository.writeTransaction(async tx=>{
   const record=await tx.getAux(SPATIAL_SHOT_VIEW_NS.jobs,job.jobId),current=read(record);
   if(current?.status==='SUCCEEDED')return {status:'SUCCEEDED',...current.result};
   if(current?.status==='QUEUED'){await put(tx,SPATIAL_SHOT_VIEW_NS.jobs,job.jobId,{...current,status:'FAILED',error:String(error.message||error).slice(0,1500)},record.revisionId);return {status:'FAILED'};}
   return {status:current?.status||'RESULT_UNKNOWN'};
  });return {processed:true,jobId:job.jobId,...recovered};
 }
}
