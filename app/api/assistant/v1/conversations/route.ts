import {createExecutionGrant} from '../../../../../host/instance-runtime/assistant-execution-policy.mjs';
import { errorResponse, HttpError, jsonResponse, reviewData, instanceRepository } from '../../../v8/_store';
import { appendCodexTurn, cancelCodexTurn, codexBridgeProjection, codexQueueProjection, listCodexConversations, projectCodexConversation, setCodexConversationArchived, startCodexConversation } from '../../../v8/_codex-conversation-store';
import { assistantBody, assistantIdempotencyKey, assertAssistantLocal } from '../_http';
import { buildAssistantContext } from '../_context';
import { persistAssistantContext } from '../_storage';
import { enrichAssistantConversation } from '../_projection';
import type { ClientDraft, WorkFocus } from '../../../../assistant/types';

export async function GET(request: Request) {
  try {
    assertAssistantLocal(request);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !['conversationId', 'cursor', 'archived'].includes(key))) throw new HttpError(400, '不支持的会话查询字段。');
    const data = await reviewData();
    const [bridge, queue] = await Promise.all([codexBridgeProjection(), codexQueueProjection()]);
    const id = url.searchParams.get('conversationId');
    if (id) return jsonResponse({ schemaVersion: '1.0', bridge, queue, currentSnapshotId: data.snapshotId, conversation: await enrichAssistantConversation(await projectCodexConversation(id, data.snapshotId)) });
    const archived = url.searchParams.get('archived') || 'exclude';
    if (!['exclude', 'only', 'include'].includes(archived)) throw new HttpError(400, '归档筛选无效。');
    const page = await listCodexConversations(data.snapshotId, { cursor: url.searchParams.get('cursor') || undefined, archived: archived as 'exclude' | 'only' | 'include' });
    return jsonResponse({ schemaVersion: '1.0', bridge, queue, currentSnapshotId: data.snapshotId, conversations: page.items, pagination: { nextCursor: page.nextCursor } });
  } catch (error) { return errorResponse(error, '助手会话暂不可用'); }
}

export async function POST(request: Request) {
  try {
    const body = await assistantBody(request, ['action', 'conversationId', 'expectedTurnHeadHash', 'userMessage', 'focus', 'draftTargets', 'expectedDependencyHash', 'turnId', 'mode', 'allowSettingsPublish']);
    const idempotencyKey = assistantIdempotencyKey(request);
    const data = await reviewData();
    if (body.action === 'CANCEL') return jsonResponse(await cancelCodexTurn(String(body.conversationId || ''), String(body.turnId || ''), data.snapshotId));
    if (body.action === 'ARCHIVE' || body.action === 'RESTORE') {
      const conversation = await setCodexConversationArchived({ conversationId: body.conversationId, snapshotId: data.snapshotId, action: body.action, idempotencyKey });
      return jsonResponse({ conversation: await enrichAssistantConversation(conversation) });
    }
    if (!['START', 'SEND'].includes(String(body.action)) || typeof body.userMessage !== 'string' || !body.userMessage.trim()) throw new HttpError(400, '请填写本轮问题。');
    const mode = body.mode === undefined ? 'DISCUSS' : body.mode;
    if (!['DISCUSS','EXECUTE'].includes(String(mode)) || body.allowSettingsPublish !== undefined && typeof body.allowSettingsPublish !== 'boolean' || mode !== 'EXECUTE' && body.allowSettingsPublish === true) throw new HttpError(400, '本轮模式或发布授权无效。');
    const bridge = await codexBridgeProjection();
    if (!bridge.online || bridge.workContextProtocol !== 'REVIEW_WORK_CONTEXT_V1' || !bridge.workContextPreflightVerified) throw new HttpError(503, '本机助手尚未通过工作上下文检查，请启动或更新 Codex Bridge。');
    if (!body.focus || !Array.isArray(body.draftTargets ?? [])) throw new HttpError(400, '缺少本轮工作对象。');
    const { packet, catalog } = await buildAssistantContext(body.focus as WorkFocus, (body.draftTargets || []) as ClientDraft[]);
    if (!bridge.workContextCatalogVersions.includes(packet.body.schemaVersion)) throw new HttpError(503, '本机Codex工作器需要更新后才能读取当前分块资料；尚未发送模型请求。');
    if (body.expectedDependencyHash && body.expectedDependencyHash !== packet.body.dependencyHash) throw new HttpError(409, '本轮依据已变化，请核对更新后的上下文再发送。');
    let execution;
    if (mode === 'EXECUTE') {
      if (bridge.executionProtocol !== 'REVIEW_CONTROLLED_ACTIONS_V1') throw new HttpError(503, '本机工作器尚不支持受控执行；没有发送模型请求。');
      const repo=await instanceRepository();if(!repo)throw new HttpError(503,'执行模式只支持已绑定的独立实例');
      execution=createExecutionGrant(await repo.getMetadata(),{allowSettingsPublish:body.allowSettingsPublish===true});
    }
    await persistAssistantContext(packet, catalog);
    const input = { mode:mode as 'DISCUSS'|'EXECUTE',...(execution?{execution}:{}),snapshotId: packet.body.snapshotId, userMessage: body.userMessage, idempotencyKey, assistantContext: { packetId: packet.packetId, packetHash: packet.packetHash } };
    const conversation = body.action === 'START'
      ? await startCodexConversation(input)
      : await appendCodexTurn({ ...input, conversationId: body.conversationId, expectedTurnHeadHash: body.expectedTurnHeadHash });
    return jsonResponse({ schemaVersion: '1.0', conversation: await enrichAssistantConversation(conversation) });
  } catch (error) { return errorResponse(error, '助手请求未完成'); }
}
