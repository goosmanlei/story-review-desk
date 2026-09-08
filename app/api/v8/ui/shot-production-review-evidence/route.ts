import * as api from '../../_store';
import {readShotProductionReviewEvidence} from '../../../../../host/instance-runtime/shot-production-locks.mjs';

export async function GET(request:Request){
 try{
  const url=new URL(request.url),workItemId=api.assertStableId(url.searchParams.get('workItemId'),'workItemId'),versionId=api.assertString(url.searchParams.get('versionId'),'versionId',300),repository=await api.instanceRepository();
  if(!repository)throw new api.HttpError(405,'只读镜像不提交正式制作验收');
  const result=await repository.readTransaction(async tx=>{const view=await tx.readView();if(!view.snapshot)throw new api.HttpError(503,'当前实例尚未发布');return{snapshotId:view.snapshot.snapshotId,...await readShotProductionReviewEvidence(tx,{workItemId,versionId,api})};});
  return api.jsonResponse(result,{headers:{'Cache-Control':'no-store'}});
 }catch(reason){return api.errorResponse(reason instanceof Error&&'code' in reason&&reason.code==='DOMAIN_CONFLICT'?new api.HttpError(409,reason.message):reason,'制作验收输入不可用');}
}
