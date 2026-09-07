import {getConfiguration,previewConfiguration,publishConfiguration} from '../../../../host/instance-runtime/configuration-service.mjs';
import { errorResponse, hostedReadOnlyMode, HttpError, instanceRepository, jsonResponse, validateMutationRequest, operationalSnapshot, stableObjectHash } from '../../v8/_store';

export async function GET() {
  try {
    if (hostedReadOnlyMode()) throw new HttpError(405,'只读镜像不提供实例配置写入');
    const repo = await instanceRepository();
    if (!repo) throw new HttpError(503,'当前入口尚未启用独立实例');
    return await repo.readTransaction(async tx=>{
      const record=(await tx.getConfig('instance-profile'));const release=(await tx.readRelease());
      if(!release || record?.revisionId!==release.profileRevisionId)throw new HttpError(409,'存在尚未发布的实例配置，请先由主机核对处理');
      return jsonResponse({revisionId:release.profileRevisionId,profile:(await tx.readView()).profile});
    });
  } catch (error) { return errorResponse(error,'实例配置读取失败'); }
}
export async function POST(request: Request) {
  try {
    const {ifMatch,idempotencyKey} = await validateMutationRequest(request);
    const body = await request.json() as Record<string,unknown>;
    const allowed = ['revisionId','storyTitle','title','mark','description','landingView','preferredCollaborator','assistantEnabled'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(422,'配置包含未支持的字段');
    for (const key of ['storyTitle','title','mark','description']) if(typeof body[key] !== 'string' || !body[key].trim() || (body[key] as string).length > (key==='mark'?4:300)) throw new HttpError(422,`${key}内容为空或过长`);
    if (!['overview','story','settings','materials','pipeline','system'].includes(String(body.landingView)) || !['HUMAN_AI','HUMAN_FIRST','AI_FIRST'].includes(String(body.preferredCollaborator)) || typeof body.assistantEnabled !== 'boolean') throw new HttpError(422,'协作或导航配置无效');
    const repo = await instanceRepository();
    if (!repo) throw new HttpError(503,'当前入口尚未启用独立实例');
    const result = await repo.writeTransaction(async tx => {
      const previousRequest = (await tx.getAux('instance-settings-requests',idempotencyKey));
      const requestHash = stableObjectHash(body);
      if (previousRequest) {
        const saved = JSON.parse(Buffer.from(previousRequest.bytes).toString('utf8')) as {requestHash:string;result:unknown};
        if(saved.requestHash!==requestHash)throw new HttpError(409,'该请求编号已经用于不同的配置');
        return saved.result;
      }
      const operations=await operationalSnapshot();
      if(operations.mutationEtag.replace(/^"|"$/g,'')!==ifMatch)throw new HttpError(409,'审阅数据已变化，请刷新后保存');
      const previous = (await tx.getConfig('instance-profile'));
      const view = (await tx.readView());
      if(!view.snapshot)throw new HttpError(503,'当前实例没有有效快照');
      if (!previous || previous.revisionId !== (await tx.readRelease())?.profileRevisionId || previous.revisionId !== body.revisionId) throw new HttpError(409,'配置已变化，请刷新后再保存');
      if(view.profile.configurationRef){
        const state=(await getConfiguration(tx));const configuration=structuredClone(state.configuration);
        Object.assign(configuration.presentation,{title:body.title,storyTitle:body.storyTitle,mark:body.mark,description:body.description,landingView:body.landingView});
        Object.assign(configuration.collaboration,{preferredCollaborator:body.preferredCollaborator,assistantEnabled:body.assistantEnabled});
        const input={configuration,expectedReleaseId:state.releaseId,expectedConfigurationRevisionId:state.revisionId,upgradeKeys:[]};
        const preview=(await previewConfiguration(tx,input));(await publishConfiguration(tx,{...input,previewHash:preview.previewHash,requestId:`settings:${idempotencyKey}`}));
        const result={revisionId:(await tx.getConfig('instance-profile'))!.revisionId,profile:(await tx.readView()).profile};
        (await tx.putAux({namespace:'instance-settings-requests',key:idempotencyKey,bytes:Buffer.from(JSON.stringify({requestHash,result})),expectedRevisionId:null,mediaType:'application/json'}));return result;
      }
      const profile = {...view.profile,title:body.title,storyTitle:body.storyTitle,branding:{...view.profile.branding,mark:body.mark,title:body.title,description:body.description},capabilities:{...view.profile.capabilities,landingView:body.landingView,preferredCollaborator:body.preferredCollaborator,assistantEnabled:body.assistantEnabled}};
      const record = (await tx.putConfig({configId:'instance-profile',value:profile,expectedRevisionId:previous.revisionId}));
      (await tx.publishRelease({snapshot:{...view.snapshot,instance:profile,productionModel:{...view.snapshot.productionModel,instance:profile}},recipes:view.recipes,expectedReleaseId:view.releaseId,sourceRevisionIds:view.sourceRevisionIds}));
      const result={revisionId:record.revisionId,profile};
      (await tx.putAux({namespace:'instance-settings-requests',key:idempotencyKey,bytes:Buffer.from(JSON.stringify({requestHash,result})),expectedRevisionId:null,mediaType:'application/json'}));
      return result;
    });
    return jsonResponse(result);
  } catch(error) {return errorResponse(error,'实例配置保存失败');}
}
