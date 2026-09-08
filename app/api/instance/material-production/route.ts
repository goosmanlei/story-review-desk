import * as store from '../../v8/_store';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../_domain';
import {getMaterialProductionWorkspace,saveMaterialProductionDraft,previewMaterialProduction,enqueueMaterialProduction} from '../../../../host/instance-runtime/material-production-service.mjs';
const api={projectOperationalState:store.projectOperationalState,safeGeneratedPath:store.safeGeneratedPath,safeReviewPendingPath:store.safeReviewPendingPath};
export async function GET(request:Request){try{
 const requirementId=new URL(request.url).searchParams.get('requirementId');if(!requirementId)throw new HttpError(422,'请选择素材需求');
 if(store.hostedReadOnlyMode()){
  const data=await store.reviewData(),model=data.productionModel,requirement=(model.materialRequirements||[]).find(r=>r.id===requirementId);if(!requirement)throw new HttpError(404,'素材需求不存在');
  return jsonResponse({requirementId,requirement,representation:(model.domainGraph?.representations||[]).find(r=>r.id===requirement.representationRef)||null,readOnly:true,defaults:null,draft:null,draftHeadRevisionId:null,availableInputs:[],blockers:[],currentRegistration:((model as unknown as {materialProductionPlans?:Array<{requirementId:string}>}).materialProductionPlans||[]).find(p=>p.requirementId===requirementId)||null,jobs:[]});
 }
 const repo=await domainRepository();return await repo.readTransaction(async tx=>jsonResponse({...await getMaterialProductionWorkspace(tx,{requirementId,api}),readOnly:store.instanceReadOnlyMode()}));
 }catch(e){return domainError(e);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','requirementId','expectedReleaseId','expectedBasisHash','expectedDraftRevisionId','content','draftRevisionId','previewHash','requestId']);
 if(body.requestId&&body.requestId!==idempotencyKey)throw new HttpError(422,'请求身份须与幂等头一致');
 const action=requiredString(body,'action'),requirementId=requiredString(body,'requirementId'),repo=await domainRepository();
 if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewMaterialProduction(tx,{requirementId,draftRevisionId:requiredString(body,'draftRevisionId')},{api})));
 return await repo.writeTransaction(async tx=>{
  if((await store.operationalSnapshot()).etagValue!==ifMatch)throw new HttpError(412,'素材状态已变化，请重新核对');
  if(action==='save')return jsonResponse(await saveMaterialProductionDraft(tx,{requirementId,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedBasisHash:body.expectedBasisHash,expectedDraftRevisionId:expectedRevision(body),content:body.content},{api}));
  if(action==='publish')return jsonResponse(await enqueueMaterialProduction(tx,{requirementId,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey},{api}));
  throw new HttpError(422,'不支持的素材建档操作');
 });}catch(e){return domainError(e);}}
