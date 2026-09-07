import {workflowOverview} from '../../../../host/instance-runtime/workflow-overview.mjs';
import {readProductionPreparation} from '../../../../host/instance-runtime/production-preparation.mjs';
import {buildActionQueue} from '../../v8/_action-queue';
import {hostedReadOnlyMode,reviewData,operationalSnapshot,HttpError} from '../../v8/_store';
import {domainRepository,domainError,jsonResponse} from '../_domain';
export async function GET(request:Request){
 try{
  const combined=new URL(request.url).searchParams.get('workspace')==='1';
  if(hostedReadOnlyMode()){
   const [data,queue,operations]=await Promise.all([reviewData(),buildActionQueue(),operationalSnapshot()]);
   if(queue.snapshotId!==data.snapshotId||operations.snapshotId!==data.snapshotId||queue.operationRevision!==operations.operationRevision)throw new HttpError(409,'已发布工作投影不一致，请重新读取');
   const workflow=workflowOverview(data.productionModel,(data.productionModel as unknown as Record<string,unknown>).productionPreparation,{queue,operations,readOnly:true,snapshotId:data.snapshotId});
   return jsonResponse(combined?{schemaVersion:'1.0',queue,workflow}:workflow);
  }
  const repo=await domainRepository();
  return await repo.readTransaction(async tx=>{
   // Repository methods reuse this repeatable-read transaction, including nested
   // action-queue, operational snapshot and preparation reads.
   const [data,queue,operations,metadata,preparation]=await Promise.all([reviewData(),buildActionQueue(),operationalSnapshot(),tx.getMetadata(),readProductionPreparation(tx)]);
   if(queue.snapshotId!==data.snapshotId||operations.snapshotId!==data.snapshotId||queue.operationRevision!==operations.operationRevision||metadata.snapshotId!==data.snapshotId)throw new HttpError(409,'工作依据已变化，请重新读取');
   const workflow=workflowOverview(data.productionModel,preparation,{queue,operations,metadata,snapshotId:data.snapshotId});
   return jsonResponse(combined?{schemaVersion:'1.0',queue,workflow}:workflow);
  });
 }catch(error){return domainError(error);}
}
