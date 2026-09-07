import { errorResponse, HttpError, jsonResponse, reviewData } from '../../../../v8/_store';
import { projectCodexConversation } from '../../../../v8/_codex-conversation-store';
import { assistantBody } from '../../_http';
import { readAssistantContext } from '../../_storage';
import { isAssistantContextCurrent } from '../../_context';
import type { AssistantContextRef } from '../../../../../assistant/types';

export async function POST(request: Request) {
  try {
    const body = await assistantBody(request, ['assistantContext', 'targetId', 'expectedDraftHash', 'conversationId', 'messageId']);
    const data = await reviewData();
    const conversation = await projectCodexConversation(String(body.conversationId || ''), data.snapshotId);
    const message = conversation.messages.find((item) => item.id === body.messageId && item.role === 'assistant');
    const ref = body.assistantContext as AssistantContextRef;
    if (!message?.workContext || message.assistantContext?.packetId !== ref?.packetId || message.assistantContext?.packetHash !== ref?.packetHash || !message.workContext.suggestions.some((item) => item.targetId === body.targetId)) throw new HttpError(409, '建议不属于这轮已完成的回答。');
    const { packet, catalog } = await readAssistantContext(ref);
    const target = packet.body.draftTargets.find((item) => item.id === body.targetId);
    if (!target || target.baseHash !== body.expectedDraftHash) throw new HttpError(409, '建议与原草稿绑定不一致。');
    if (message.workContext.stale || !await isAssistantContextCurrent(packet, message.workContext.evidenceIds, catalog)) throw new HttpError(409, '对象或依据已更新；建议可供参考，请针对当前版本重新讨论。');
    return jsonResponse({ current: true, targetId: target.id });
  } catch (error) { return errorResponse(error, '建议暂不能采用'); }
}
