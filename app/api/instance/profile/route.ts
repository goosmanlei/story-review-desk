import { instanceProfile } from '../../../instance-profile';
import { errorResponse, hostedReadOnlyMode, HttpError, instanceRepository, jsonResponse, reviewData } from '../../v8/_store';
import {deploymentPublicFacts} from '../../../../host/instance-runtime/deployment-http.mjs';
import {sha256} from '../../../../host/instance-runtime/bytes.mjs';

export async function GET() {
  try {
    const repo=hostedReadOnlyMode()?null:await instanceRepository();
    if(repo)return await repo.readTransaction(async tx=>{
      const metadata=await tx.getMetadata();
      const row=metadata.releaseId
        ?await tx.getRecord('settings','instance-profile',metadata.profileRevisionId!)
        :await tx.getConfig('instance-profile');
      if(!row||row.deleted||sha256(row.bytes)!==row.sha256)throw new HttpError(503,'已发布项目身份无法核验');
      const profile=JSON.parse(Buffer.from(row.bytes).toString('utf8'));
      if(profile.instanceId!==metadata.instanceId)throw new HttpError(503,'已发布项目身份与实例不一致');
      // Polling the public identity needs no material evidence or production
      // projection. Only legacy profiles with absent explicit IDs need the graph.
      const data=profile.projectId&&profile.episodePlanId?{instance:profile}:await reviewData();
      return jsonResponse({...instanceProfile(data),deployment:deploymentPublicFacts(metadata.runtimeEpoch)});
    });
    return jsonResponse({...instanceProfile(await reviewData()),deployment:deploymentPublicFacts('HOSTED_READ_ONLY')});
  }
  catch (error) { return errorResponse(error); }
}
