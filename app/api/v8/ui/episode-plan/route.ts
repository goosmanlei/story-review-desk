import { errorResponse, jsonResponse, operationalSnapshot, reviewData } from '../../_store';
import { resolveEpisodePlan } from '../../_episode-plan';

export async function GET(request: Request) {
  try {
    const [data, operations] = await Promise.all([reviewData(), operationalSnapshot()]);
    const requested = new URL(request.url).searchParams.get('revisionId');
    return jsonResponse({ plan: resolveEpisodePlan(data, operations, requested) });
  } catch (reason) { return errorResponse(reason, '分集审阅上下文读取失败'); }
}
