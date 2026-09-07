import {getDomainWorkspace,workspaceProjection,saveDomainWorkspace,previewDomainWorkspace,publishDomainWorkspace,confirmDomainOwnership,transferLegacyDraft,rebaseDomainWorkspace} from '../../../../host/instance-runtime/domain-workspaces.mjs';
import {emptyDomainGraph} from '../../../../host/instance-runtime/domain-defaults.mjs';
import {hostedReadOnlyMode,reviewData,instanceReadOnlyMode,operationalSnapshot} from '../../v8/_store';
import {readingProjection} from '../../../../host/instance-runtime/domain-reading.mjs';
import {domainRepository,domainMutation,domainError,domainBody,requiredString,expectedRevision,jsonResponse,HttpError} from '../_domain';

export async function GET(request:Request){try{
  const owner=new URL(request.url).searchParams.get('owner')||'SETTINGS';
  if(!['SETTINGS','MATERIAL'].includes(owner))throw new HttpError(422,'维护范围无效');
  if(hostedReadOnlyMode()){
    const data=await reviewData(),model=data.productionModel as typeof data.productionModel & {domainGraphRef?:{revisionId:string}};
    return jsonResponse({...workspaceProjection(data,model.domainGraph||emptyDomainGraph(),owner),releaseId:'HOSTED_READ_ONLY',revisionId:model.domainGraphRef?.revisionId||null,draft:null,draftHeadRevisionId:null,legacyDrafts:[],readOnly:true});
  }
  const repo=await domainRepository();return await repo.readTransaction(async tx=>{const workspace=await getDomainWorkspace(tx,owner),view=await tx.readView(),operations=await operationalSnapshot();return jsonResponse({...workspace,...readingProjection(view.snapshot,workspace.graph,workspace.configuration,operations.stateProjection),readOnly:instanceReadOnlyMode()});});
}catch(error){return domainError(error);}}

export async function POST(request:Request){try{
  const {idempotencyKey}=await domainMutation(request);
  const body=domainBody(await request.json(),['action','owner','expectedReleaseId','expectedDraftRevisionId','changes','draftRevisionId','previewHash','collection','id','recordHash','reason','kind','legacyRevisionId']);
  const action=requiredString(body,'action'),owner=requiredString(body,'owner'),repo=await domainRepository();
  if(action==='preview')return await repo.readTransaction(async tx=>jsonResponse(await previewDomainWorkspace(tx,{owner,draftRevisionId:requiredString(body,'draftRevisionId')})));
  return await repo.writeTransaction(async tx=>{
    if(action==='rebase')return jsonResponse(await rebaseDomainWorkspace(tx,{owner,expectedReleaseId:requiredString(body,'expectedReleaseId'),draftRevisionId:requiredString(body,'draftRevisionId')}));
    if(action==='save')return jsonResponse(await saveDomainWorkspace(tx,{owner,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedDraftRevisionId:expectedRevision(body),changes:body.changes}));
    if(action==='publish')return jsonResponse(await publishDomainWorkspace(tx,{owner,draftRevisionId:requiredString(body,'draftRevisionId'),previewHash:requiredString(body,'previewHash'),requestId:idempotencyKey}));
    if(action==='claim')return jsonResponse(await confirmDomainOwnership(tx,{owner,expectedReleaseId:requiredString(body,'expectedReleaseId'),collection:requiredString(body,'collection'),id:requiredString(body,'id'),recordHash:requiredString(body,'recordHash'),reason:requiredString(body,'reason'),requestId:idempotencyKey}));
    if(action==='transfer')return jsonResponse(await transferLegacyDraft(tx,{owner,expectedReleaseId:requiredString(body,'expectedReleaseId'),expectedDraftRevisionId:expectedRevision(body),kind:requiredString(body,'kind'),legacyRevisionId:requiredString(body,'legacyRevisionId')}));
    throw new HttpError(422,'不支持的工作区操作');
  });
}catch(error){return domainError(error);}}
