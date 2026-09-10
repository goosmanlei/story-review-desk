import {committedGet} from '../../../instance/_committed-get';
import {instanceRepository,hostedReadOnlyMode} from '../../_store';
import { HttpError, errorResponse, jsonResponse, operationalSnapshot, reviewData } from '../../_store';
import { resolveEpisodePlan } from '../../_episode-plan';

async function readResponse(request: Request) {
  try {
    const [data, operations] = await Promise.all([reviewData(), operationalSnapshot()]);
    const requested = new URL(request.url).searchParams.get('revisionId');
    return jsonResponse({ plan: resolveEpisodePlan(data, operations, requested) });
  } catch (reason) { return errorResponse(reason, '分集审阅上下文读取失败'); }
}

export async function GET(request:Request) {
 try {
  const repo=hostedReadOnlyMode()?null:await instanceRepository();
  if(!repo)return readResponse(request);
  return await committedGet(repo,`episode-plan:${new URL(request.url).search}`,async()=>{const response=await readResponse(request);const value=await response.json() as {error?:string;message?:string};if(!response.ok)throw new HttpError(response.status,value.error||value.message||"读取失败");return value;},request);
 } catch(error){return errorResponse(error,"工作区读取失败");}
}
