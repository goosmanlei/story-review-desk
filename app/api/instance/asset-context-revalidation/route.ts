import * as store from '../../v8/_store';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../_domain';
import {getAssetContextRevalidationWorkspace,saveAssetContextRevalidationDraft,previewAssetContextRevalidation,enqueueAssetContextRevalidation} from '../../../../host/instance-runtime/asset-context-revalidation-service.mjs';
const api={assetReviewContextHash:store.assetReviewContextHash,assetReviewTransitionProjection:store.assetReviewTransitionProjection,projectOperationalState:store.projectOperationalState,safeGeneratedPath:store.safeGeneratedPath,hashStableFile:store.hashStableFile};
const target=(body:Record<string,unknown>)=>({familyId:requiredString(body,'familyId'),versionId:requiredString(body,'versionId'),sha256:requiredString(body,'sha256')});
export async function GET(request:Request){try{
 if(store.hostedReadOnlyMode())return jsonResponse({protocol:'ASSET_CONTEXT_REVALIDATION_V1',supported:true,readOnly:true,workspace:null});
 const query=Object.fromEntries(new URL(request.url).searchParams),repo=await domainRepository();
 const input=target(query);
 return await repo.readTransaction(async tx=>jsonResponse({...await getAssetContextRevalidationWorkspace(tx,input,{api}),readOnly:store.instanceReadOnlyMode()}));
}catch(error){return domainError(error);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','familyId','versionId','sha256','expectedReleaseId','expectedBasisHash','expectedDraftRevisionId','content','draftRevisionId','previewHash']);
 const input=target(body),action=requiredString(body,'action'),repo=await domainRepository();
 if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewAssetContextRevalidation(tx,{...input,draftRevisionId:requiredString(body,'draftRevisionId')},{api})));
 return await repo.writeTransaction(async tx=>{
  if((await store.operationalSnapshot()).etagValue!==ifMatch)throw new HttpError(412,'素材状态已变化，请重新核对');
  if(action==='save')return jsonResponse(await saveAssetContextRevalidationDraft(tx,{...input,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedBasisHash:requiredString(body,'expectedBasisHash'),expectedDraftRevisionId:expectedRevision(body),content:body.content},{api}));
  if(action==='publish')return jsonResponse(await enqueueAssetContextRevalidation(tx,{...input,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey},{api}));
  throw new HttpError(422,'不支持的新用途操作');
 });
}catch(error){return domainError(error);}}
