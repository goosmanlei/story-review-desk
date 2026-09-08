import {readAnimaticState,readPublicAnimaticState,saveAnimaticTimeline,enqueueAnimaticRender} from '../../../../../host/instance-runtime/animatic-service.mjs';
import {hostedReadOnlyMode,reviewData,instanceReadOnlyMode,operationalSnapshot,HttpError} from '../../../v8/_store';
import * as store from '../../../v8/_store';
import {projectEpisodeNarrativeReleases} from '../../../v8/episode-plan-reviews/_release';
import {readCurrentShotProductionModel} from '../../../../../host/instance-runtime/shot-production-service.mjs';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,jsonResponse} from '../../_domain';
const api={...store,projectEpisodeNarrativeReleases};
export async function GET(request:Request){try{
 const sceneId=new URL(request.url).searchParams.get('sceneId')||'';
 if(hostedReadOnlyMode())return jsonResponse(readPublicAnimaticState((await reviewData()).productionModel,sceneId));
 const repo=await domainRepository();return repo.readTransaction(async tx=>jsonResponse({...await readAnimaticState(tx,{sceneId,model:(await readCurrentShotProductionModel(tx,{api})).model}),readOnly:instanceReadOnlyMode()}));
 }catch(e){return domainError(e);}}
export async function POST(request:Request){try{
 const {idempotencyKey,ifMatch}=await domainMutation(request),body=domainBody(await request.json(),['action','sceneId','expectedReleaseId','expectedRevisionId','timelineRevisionId','content']);requiredString(body,'sceneId');
 const repo=await domainRepository();return repo.writeTransaction(async tx=>{const operations=await operationalSnapshot();if(operations.etagValue!==ifMatch)throw new HttpError(412,'制作状态已变化，请核对当前时间线');const options={model:(await readCurrentShotProductionModel(tx,{api})).model},input={...body,requestId:idempotencyKey};if(body.action==='save')return jsonResponse(await saveAnimaticTimeline(tx,input,options));if(body.action==='render')return jsonResponse(await enqueueAnimaticRender(tx,input,options));throw new HttpError(422,'仅支持保存时间线和生成审阅预演；锁时须正式审阅');});
 }catch(e){return domainError(e);}}
