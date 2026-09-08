import * as store from '../../v8/_store';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../_domain';
import {getMaterialUsageWorkspace,listMaterialUsageSources,saveMaterialUsageDraft,previewMaterialUsage,enqueueMaterialUsage} from '../../../../host/instance-runtime/material-usage-service.mjs';
const api={projectOperationalState:store.projectOperationalState,safeGeneratedPath:store.safeGeneratedPath,hashStableFile:store.hashStableFile};
const target=(body:Record<string,unknown>)=>({requirementId:requiredString(body,'requirementId'),familyId:requiredString(body,'familyId'),versionId:requiredString(body,'versionId'),sha256:requiredString(body,'sha256')});
export async function GET(request:Request){try{
 if(store.hostedReadOnlyMode())return jsonResponse({protocol:'MATERIAL_USAGE_V1',supported:true,readOnly:true,workspace:null});
 const query=Object.fromEntries(new URL(request.url).searchParams),repo=await domainRepository();
 if(!['familyId','versionId','sha256'].some(k=>Object.hasOwn(query,k)))return await repo.readTransaction(async tx=>jsonResponse({...await listMaterialUsageSources(tx,{requirementId:requiredString(query,'requirementId')},{api}),readOnly:store.instanceReadOnlyMode()}));
 const input=target(query);
 return await repo.readTransaction(async tx=>jsonResponse({...await getMaterialUsageWorkspace(tx,input,{api}),readOnly:store.instanceReadOnlyMode()}));
}catch(error){return domainError(error);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','requirementId','familyId','versionId','sha256','expectedReleaseId','expectedBasisHash','expectedDraftRevisionId','content','draftRevisionId','previewHash']);
 const input=target(body),action=requiredString(body,'action'),repo=await domainRepository();
 if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewMaterialUsage(tx,{...input,draftRevisionId:requiredString(body,'draftRevisionId')},{api})));
 return await repo.writeTransaction(async tx=>{
  if((await store.operationalSnapshot()).etagValue!==ifMatch)throw new HttpError(412,'素材状态已变化，请重新核对');
  if(action==='save')return jsonResponse(await saveMaterialUsageDraft(tx,{...input,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedBasisHash:requiredString(body,'expectedBasisHash'),expectedDraftRevisionId:expectedRevision(body),content:body.content},{api}));
  if(action==='publish')return jsonResponse(await enqueueMaterialUsage(tx,{...input,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey},{api}));
  throw new HttpError(422,'不支持的新用途操作');
 });
}catch(error){return domainError(error);}}
