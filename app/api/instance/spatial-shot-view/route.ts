import * as store from '../../v8/_store';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../_domain';
import {getSpatialShotViewWorkspace,saveSpatialShotViewDraft,previewSpatialShotView,enqueueSpatialShotView,spatialShotViewDefaultId,spatialShotViewOptions,spatialShotViewLocations} from '../../../../host/instance-runtime/spatial-shot-view-service.mjs';
function spatialError(error:unknown){if(error instanceof Error&&'code' in error&&error.code==='SPATIAL_CONFLICT')return jsonResponse({error:error.message},{status:409});return domainError(error);}
export async function GET(request:Request){try{
 const url=new URL(request.url),sceneId=url.searchParams.get('sceneId'),viewId=url.searchParams.get('viewId')||undefined;if(!sceneId)throw new HttpError(422,'请选择当前永久场');
 if(store.hostedReadOnlyMode()){
  const data=await store.reviewData(),model=data.productionModel as unknown as {spatialShotViews?:Array<{viewId:string;scopeRole:string;content:{sceneBinding:{sceneId:string}}}>},id=viewId||spatialShotViewDefaultId(sceneId),currentView=model.spatialShotViews?.find(r=>r.viewId===id&&r.scopeRole==='CURRENT'&&r.content.sceneBinding.sceneId===sceneId)||null;
  return jsonResponse({sceneId,viewId:id,readOnly:true,releaseId:null,basisHash:null,draft:null,staleDraft:null,draftHeadRevisionId:null,defaults:null,currentView,availableLocations:spatialShotViewLocations(model),options:spatialShotViewOptions,blockers:['镜像仅展示已发布空间视图'],jobs:[]});
 }
 const repo=await domainRepository();return await repo.readTransaction(async tx=>jsonResponse({...await getSpatialShotViewWorkspace(tx,{sceneId,viewId}),readOnly:store.instanceReadOnlyMode()}));
 }catch(error){return spatialError(error);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','sceneId','viewId','expectedReleaseId','expectedBasisHash','expectedDraftRevisionId','content','draftRevisionId','previewHash','requestId']);
 if(body.requestId&&body.requestId!==idempotencyKey)throw new HttpError(422,'请求身份须与幂等头一致');
 const action=requiredString(body,'action'),sceneId=requiredString(body,'sceneId'),viewId=requiredString(body,'viewId'),repo=await domainRepository();
 if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewSpatialShotView(tx,{sceneId,viewId,draftRevisionId:requiredString(body,'draftRevisionId')})));
 return await repo.writeTransaction(async tx=>{
  if((await store.operationalSnapshot()).etagValue!==ifMatch)throw new HttpError(412,'制作状态已变化，请核对当前空间依据');
  if(action==='save')return jsonResponse(await saveSpatialShotViewDraft(tx,{sceneId,viewId,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedBasisHash:requiredString(body,'expectedBasisHash'),expectedDraftRevisionId:expectedRevision(body),content:body.content}));
  if(action==='publish')return jsonResponse(await enqueueSpatialShotView(tx,{sceneId,viewId,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey}));
  throw new HttpError(422,'不支持的空间视图操作');
 });}catch(error){return spatialError(error);}}
