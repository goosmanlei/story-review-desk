import {errorResponse,hostedReadOnlyMode,HttpError,instanceRepository} from '../../v8/_store';
import {committedGet} from '../_committed-get';
import {deploymentPublicFacts} from '../../../../host/instance-runtime/deployment-http.mjs';
export async function GET(){
 try{
  if(hostedReadOnlyMode())throw new HttpError(405,'此接口只提供本地实例运行证明');
  const repo=await instanceRepository();if(!repo)throw new HttpError(503,'独立实例未启用');
  return await committedGet(repo,`runtime:${process.env.REVIEW_SOFTWARE_COMMIT||'UNKNOWN'}`,async tx=>{
   const view=(await tx.readView());
   const sourceDocumentCount = view.sourceRevisionIds.length;
   return {configurationRef:view.profile.configurationRef||null,schemaVersion:'1.0',storageMode:repo.backend === 'postgres' ? 'SINGLE_INSTANCE_POSTGRESQL' : 'SINGLE_INSTANCE_SQLITE',instanceId:view.instanceId,projectId:view.profile.projectId,releaseId:view.releaseId,runtimeEpoch:view.runtimeEpoch,repositoryRevision:view.repositoryRevision,snapshotId:view.snapshot?.snapshotId,reviewSchemaVersion:view.snapshot?.schemaVersion,dataFingerprint:view.dataFingerprint,recipeFingerprint:view.recipeFingerprint,sourceRevisionIds:view.sourceRevisionIds,sourceDocumentCount,formalEventCounts:Object.fromEntries(Object.entries(view.eventsByKind).map(([kind,events])=>[kind,(events as unknown[]).length])),softwareCommit:process.env.REVIEW_SOFTWARE_COMMIT||'UNKNOWN',deployment:deploymentPublicFacts(view.runtimeEpoch),legacySourceFallback:false};
  });
 }catch(error){return errorResponse(error,'实例运行证明读取失败');}
}
