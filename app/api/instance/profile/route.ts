import { instanceProfile } from '../../../instance-profile';
import { errorResponse, jsonResponse, reviewData } from '../../v8/_store';

export async function GET() {
  try { return jsonResponse(instanceProfile(await reviewData())); }
  catch (error) { return errorResponse(error); }
}
