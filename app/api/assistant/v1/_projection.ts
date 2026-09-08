import {resolveCatalogResource} from '../../../../host/instance-runtime/assistant-source.mjs';
import {assistantActionReceipts} from '../../../../host/instance-runtime/assistant-action-service.mjs';
import type { ContextPacket, ResourceCatalog } from '../../../assistant/types';
import type { CodexConversationProjection } from '../../v8/_codex-conversation-store';
import { assistantProgress, readAssistantContext } from './_storage';
import { isAssistantContextCurrent } from './_context';
import { mediaToken, instanceRepository } from '../../v8/_store';

export function publicAssistantContext(packet: ContextPacket, catalog: ResourceCatalog, additionalIds: string[] = []) {
  const ids = new Set([...packet.body.initialResourceIds, ...additionalIds]);
  return {
    packetId: packet.packetId, packetHash: packet.packetHash,
    focus: packet.body.focus, focusKey: packet.body.focusKey,
    dependencyHash: packet.body.dependencyHash, missing: packet.body.missing,
    draftTargets: packet.body.draftTargets,
    resources: [...ids].map(id=>resolveCatalogResource(catalog,id)).filter((resource):resource is NonNullable<typeof resource>=>Boolean(resource)).map((resource) => ({
      id: resource.id, title: resource.title, kind: resource.kind, versionId: resource.versionId,
      sha256: resource.sha256, href: resource.href.startsWith('/') && !resource.href.startsWith('//') ? resource.href : '',
      role: resource.role, characterCount: resource.text.length,
      ...(resource.bodyBinding?{bodyDeferred:!resource.bodyRange,bodyOf:resource.bodyOf||resource.id,bodySection:resource.bodySection||null,bodySha256:resource.bodyBinding.sha256,bodyByteSize:resource.bodyBinding.byteSize,bodyRange:resource.bodyRange||null}:{}),
      ...(resource.media ? { media: { kind: resource.media.kind, sha256: resource.media.sha256, mimeType: resource.media.mimeType,
        ...(resource.media.kind === 'image' && resource.versionId ? { previewUrl: `/api/v8/media/${mediaToken(resource.versionId)}` } : {}),
      } } : {}),
    })),
  };
}

export async function enrichAssistantConversation(conversation: CodexConversationProjection) {
  const repo=await instanceRepository();
  const receiptsByTurn=repo?await repo.readTransaction(async tx=>new Map(await Promise.all(conversation.messages.filter(message=>message.role==='user'&&message.mode==='EXECUTE').map(async message=>[message.id,await assistantActionReceipts(tx,message.id)] as const)))):new Map();
  const packets = new Map<string, Awaited<ReturnType<typeof readAssistantContext>>>();
  const messages = await Promise.all(conversation.messages.map(async (message) => {
    const turnId=message.role==='user'?message.id:message.id.replace(/:assistant$/, '');
    const executionReceipts=receiptsByTurn.get(turnId)||[];
    const withReceipts={...message,...(executionReceipts.length?{executionReceipts,suggestionOnly:false}:{})};
    if (!message.assistantContext) return withReceipts;
    try {
      let bundle = packets.get(message.assistantContext.packetId);
      if (!bundle) { bundle = await readAssistantContext(message.assistantContext); packets.set(message.assistantContext.packetId, bundle); }
      if (message.workContext?.evidenceIds.some((id) => !resolveCatalogResource(bundle!.catalog,id))) throw new Error('unknown resource');
      if (message.workContext?.suggestions.some((item) => !bundle!.packet.body.draftTargets.some((target) => target.id === item.targetId))) throw new Error('unknown draft target');
      const current = message.workContext ? await isAssistantContextCurrent(bundle.packet, message.workContext.evidenceIds, bundle.catalog).catch(() => false) : true;
      return { ...withReceipts, ...(message.workContext ? { workContext: { ...message.workContext, stale: message.workContext.stale || !current } } : {}), context: publicAssistantContext(bundle.packet, bundle.catalog, message.workContext?.evidenceIds) };
    } catch {
      return { ...withReceipts, workContext: undefined, evidence: [], contextUnavailable: true };
    }
  }));
  return { ...conversation, messages, progress: conversation.activeTurnId ? await assistantProgress(conversation.activeTurnId, conversation.id) : null };
}
