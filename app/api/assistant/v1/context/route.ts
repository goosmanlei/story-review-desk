import { errorResponse, HttpError, jsonResponse } from '../../../v8/_store';
import { assistantBody } from '../_http';
import { buildAssistantContext } from '../_context';
import { publicAssistantContext } from '../_projection';
import type { ClientDraft, WorkFocus } from '../../../../assistant/types';

export async function POST(request: Request) {
  try {
    const body = await assistantBody(request, ['focus', 'draftTargets']);
    if (!body.focus || !Array.isArray(body.draftTargets ?? [])) throw new HttpError(400, '缺少当前工作对象。');
    const { packet, catalog } = await buildAssistantContext(body.focus as WorkFocus, (body.draftTargets || []) as ClientDraft[]);
    return jsonResponse({ schemaVersion: '1.0', context: publicAssistantContext(packet, catalog) });
  } catch (error) { return errorResponse(error, '当前工作上下文暂不可用'); }
}
