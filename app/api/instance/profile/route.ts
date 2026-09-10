import { instanceProfile } from '../../../instance-profile';
import { errorResponse, instanceRepository, jsonResponse, reviewData } from '../../v8/_store';
import {deploymentPublicFacts} from '../../../../host/instance-runtime/deployment-http.mjs';

export async function GET() {
  try { const data=await reviewData();const repo=await instanceRepository();const metadata=repo?await repo.getMetadata():null;return jsonResponse({...instanceProfile(data),deployment:deploymentPublicFacts(metadata?.runtimeEpoch||'HOSTED_READ_ONLY')}); }
  catch (error) { return errorResponse(error); }
}
