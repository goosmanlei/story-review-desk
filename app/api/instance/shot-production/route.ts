import {committedGet} from '../_committed-get';
import * as store from '../../v8/_store';
import * as workflow from '../../v8/_workflow';
import {configuredGates} from '../../../gate-evaluation';
import {projectEpisodeNarrativeReleases} from '../../v8/episode-plan-reviews/_release';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../_domain';
import {getShotProductionWorkspace,saveShotProductionDraft,previewShotProduction,enqueueShotProduction} from '../../../../host/instance-runtime/shot-production-service.mjs';
import {shotProductionReadiness} from '../../../../host/instance-runtime/shot-production-model.mjs';
import {previewShotProductionManifest,enqueueShotProductionManifest} from '../../../../host/instance-runtime/shot-production-manifest.mjs';
const api={...store,...workflow,configuredGates,projectEpisodeNarrativeReleases};
export async function GET(request:Request){try{
 const sceneId=new URL(request.url).searchParams.get('sceneId');if(!sceneId)throw new HttpError(422,'请选择永久场');
 if(store.hostedReadOnlyMode()){const data=await store.reviewData(),operations=await store.operationalSnapshot();return jsonResponse({sceneId,readOnly:true,basis:null,defaultContent:null,draft:null,draftHeadRevisionId:null,jobs:[],availableInputs:[],blockers:[],currentPlan:(data.productionModel as unknown as {shotProductionPlans?:Array<{sceneId:string;scopeRole:string}>}).shotProductionPlans?.find(p=>p.sceneId===sceneId&&p.scopeRole==='CURRENT')||null,readiness:shotProductionReadiness(data.productionModel,operations.stateProjection,sceneId)});}
 const repo=await domainRepository();return await committedGet(repo,`shot-production:${sceneId}:${store.instanceReadOnlyMode()}`,async tx=>({...await getShotProductionWorkspace(tx,{sceneId,api}),readOnly:store.instanceReadOnlyMode()}),request);
 }catch(error){return domainError(error);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','sceneId','expectedReleaseId','expectedDraftRevisionId','content','draftRevisionId','previewHash','workItemId','manifestHash']);
 const action=requiredString(body,'action'),sceneId=requiredString(body,'sceneId'),repo=await domainRepository();
 if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewShotProduction(tx,{sceneId,draftRevisionId:requiredString(body,'draftRevisionId')},{api})));
 if(action==='manifest-preview')return await repo.readTransaction(async tx=>jsonResponse(await previewShotProductionManifest(tx,{workItemId:requiredString(body,'workItemId'),api})));
 return await repo.writeTransaction(async tx=>{
  if((await store.operationalSnapshot()).etagValue!==ifMatch)throw new HttpError(412,'制作状态已经变化，请重新核对');
  if(action==='save')return jsonResponse(await saveShotProductionDraft(tx,{sceneId,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedDraftRevisionId:expectedRevision(body),content:body.content},{api}));
  if(action==='publish')return jsonResponse(await enqueueShotProduction(tx,{sceneId,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey},{api}));
  if(action==='manifest-render')return jsonResponse(await enqueueShotProductionManifest(tx,{workItemId:requiredString(body,'workItemId'),expectedReleaseId:requiredString(body,'expectedReleaseId'),manifestHash:requiredString(body,'manifestHash'),requestId:idempotencyKey},{api}));
  throw new HttpError(422,'不支持的镜头制作操作');
 });
 }catch(error){return domainError(error);}}
