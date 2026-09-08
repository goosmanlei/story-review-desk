import * as store from '../../../v8/_store';
import * as workflow from '../../../v8/_workflow';
import {configuredGates} from '../../../../gate-evaluation';
import {projectEpisodeNarrativeReleases} from '../../../v8/episode-plan-reviews/_release';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../../_domain';
import {getShotRecipeWorkspace,saveShotRecipeDraft,previewShotRecipe,enqueueShotRecipe} from '../../../../../host/instance-runtime/shot-production-recipes.mjs';
const api={...store,...workflow,configuredGates,projectEpisodeNarrativeReleases};
export async function GET(request:Request){try{
 const workItemId=new URL(request.url).searchParams.get('workItemId');if(!workItemId)throw new HttpError(422,'请选择制作项');
 if(store.hostedReadOnlyMode()){const data=await store.reviewData(),recipes=await store.recipeCatalog(),work=data.productionModel.workItems.find(w=>w.id===workItemId),definition=recipes.executionDefinitions.find(d=>d.id===work?.executionDefinitionRef);return jsonResponse({workItemId,readOnly:true,current:definition?{definitionId:definition.id,content:definition.authoringContent}:null,defaults:null,draft:null,draftHeadRevisionId:null,inputs:[],output:definition?.output||null,blockers:[],jobs:[]});}
 const repo=await domainRepository();return await repo.readTransaction(async tx=>jsonResponse({...await getShotRecipeWorkspace(tx,{workItemId,api}),readOnly:store.instanceReadOnlyMode()}));
 }catch(e){return domainError(e);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','workItemId','expectedReleaseId','expectedDraftRevisionId','content','draftRevisionId','previewHash','requestId']);
 if(body.requestId&&body.requestId!==idempotencyKey)throw new HttpError(422,'请求身份须与幂等头一致');
 const action=requiredString(body,'action'),workItemId=requiredString(body,'workItemId'),repo=await domainRepository();
 if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewShotRecipe(tx,{workItemId,draftRevisionId:requiredString(body,'draftRevisionId')},{api})));
 return await repo.writeTransaction(async tx=>{
  if((await store.operationalSnapshot()).etagValue!==ifMatch)throw new HttpError(412,'制作状态已变化，请重新核对');
  if(action==='save')return jsonResponse(await saveShotRecipeDraft(tx,{workItemId,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedDraftRevisionId:expectedRevision(body),content:body.content},{api}));
  if(action==='publish')return jsonResponse(await enqueueShotRecipe(tx,{workItemId,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey},{api}));
  throw new HttpError(422,'不支持的调用包操作');
 });}catch(e){return domainError(e);}}
