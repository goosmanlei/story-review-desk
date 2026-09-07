import {readSpatialSettings,type SpatialSettings} from '../../../../host/instance-runtime/domain-spatial.mjs';
import {hostedReadOnlyMode,reviewData} from '../../v8/_store';
import {domainRepository,domainError,jsonResponse} from '../_domain';
export async function GET(){try{
  if(hostedReadOnlyMode()){const data=await reviewData(),lineage=data.creativeLineage as unknown as {spatialSettings?:SpatialSettings};return jsonResponse(lineage.spatialSettings||{status:'NOT_CONFIGURED',snapshotId:data.snapshotId,sourceBinding:null,specification:null});}
  const repository=await domainRepository();return await repository.readTransaction(async tx=>jsonResponse(await readSpatialSettings(tx,await tx.readView())));
}catch(error){return domainError(error);}}
