import {
  errorResponse,
  hostedReadOnlyMode,
  HttpError,
  jsonResponse,
  reviewData,
  sameOrigin,
} from '../_store';
import {
  appendCodexTurn,
  codexBridgeProjection,
  codexQueueProjection,
  listCodexConversations,
  projectCodexConversation,
  setCodexConversationArchived,
  startCodexConversation,
} from '../_codex-conversation-store';

const CONTEXT_FILES = ['README.md', 'AGENTS.md', 'STATE.md'] as const;
const MAX_BODY_BYTES = 32 * 1024;
const COMMON_FIELDS = new Set(['action', 'schemaVersion', 'snapshotId']);
const START_FIELDS = new Set([...COMMON_FIELDS, 'userMessage']);
const SEND_FIELDS = new Set([...START_FIELDS, 'conversationId', 'expectedTurnHeadHash']);
const CONVERSATION_ACTION_FIELDS = new Set([...COMMON_FIELDS, 'conversationId']);
const LIST_QUERY_FIELDS = new Set(['conversationId', 'cursor', 'limit', 'archived']);

function assertAllowedFields(body: Record<string, unknown>, allowed: Set<string>) {
  const rejected = Object.keys(body).filter((key) => !allowed.has(key));
  if (rejected.length) throw new HttpError(400, 'request contains unsupported fields', { rejectedFields: rejected });
}
function assertSnapshotId(value: unknown) {
  const snapshotId = typeof value === 'string' ? value.trim() : '';
  if (!snapshotId || snapshotId.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(snapshotId)) {
    throw new HttpError(400, 'snapshotId is invalid');
  }
  return snapshotId;
}

function assertLocalRequestTarget(request: Request) {
  const target = new URL(request.url);
  const hostname = target.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new HttpError(403, 'project Codex is available only through a loopback host');
  }
  const configured = process.env.REVIEW_ALLOWED_ORIGINS
    || process.env.SITE_BASE_URL
    || 'http://localhost:3000,http://127.0.0.1:3000';
  const allowedPorts = new Set(configured.split(',').flatMap((value) => {
    try {
      const origin = new URL(value.trim());
      if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname.toLowerCase())) return [];
      return [origin.port || (origin.protocol === 'https:' ? '443' : '80')];
    } catch {
      return [];
    }
  }));
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (!allowedPorts.has(targetPort)) {
    throw new HttpError(403, 'project Codex request port is not allowed');
  }
}

async function responseEnvelope(options: {
  conversationId?: string;
  cursor?: string;
  limit?: number;
  archived?: 'exclude' | 'only' | 'include';
} = {}) {
  const data = await reviewData();
  const [bridge, queue, conversationOrPage] = await Promise.all([
    codexBridgeProjection(),
    codexQueueProjection(),
    options.conversationId
      ? projectCodexConversation(options.conversationId, data.snapshotId)
      : listCodexConversations(data.snapshotId, options),
  ]);
  return {
    schemaVersion: '1.0',
    available: true,
    hostedReadOnly: false,
    capabilityProfile: 'READ_ONLY_ADVICE',
    currentSnapshotId: data.snapshotId,
    contextFiles: CONTEXT_FILES,
    bridge,
    queue,
    ...(options.conversationId
      ? { conversation: conversationOrPage }
      : {
        conversations: (conversationOrPage as Awaited<ReturnType<typeof listCodexConversations>>).items,
        pagination: {
          nextCursor: (conversationOrPage as Awaited<ReturnType<typeof listCodexConversations>>).nextCursor,
          limit: (conversationOrPage as Awaited<ReturnType<typeof listCodexConversations>>).limit,
          archived: (conversationOrPage as Awaited<ReturnType<typeof listCodexConversations>>).archived,
        },
      }),
  };
}

export async function GET(request: Request) {
  try {
    if (hostedReadOnlyMode()) {
      return jsonResponse({
        schemaVersion: '1.0',
        available: false,
        hostedReadOnly: true,
        reason: '项目 Codex 仅在 localhost 审阅台可用',
      });
    }
    assertLocalRequestTarget(request);
    const url = new URL(request.url);
    const rejectedQueryFields = [...url.searchParams.keys()].filter((key) => !LIST_QUERY_FIELDS.has(key));
    if (rejectedQueryFields.length) {
      throw new HttpError(400, 'request contains unsupported query fields', { rejectedQueryFields });
    }
    const conversationId = url.searchParams.get('conversationId') || undefined;
    const cursor = url.searchParams.get('cursor') || undefined;
    const rawLimit = url.searchParams.get('limit');
    const archivedValue = url.searchParams.get('archived') || 'exclude';
    if (!['exclude', 'only', 'include'].includes(archivedValue)) {
      throw new HttpError(400, 'archived must be exclude, only, or include');
    }
    if (conversationId && (cursor || rawLimit || archivedValue !== 'exclude')) {
      throw new HttpError(400, 'conversationId cannot be combined with list pagination fields');
    }
    const limit = rawLimit == null ? undefined : Number(rawLimit);
    if (limit != null && (!/^\d+$/.test(rawLimit || '') || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
      throw new HttpError(400, 'limit must be an integer from 1 to 50');
    }
    return jsonResponse(await responseEnvelope({
      conversationId,
      cursor,
      limit,
      archived: archivedValue as 'exclude' | 'only' | 'include',
    }));
  } catch (reason) {
    return errorResponse(reason, 'Codex conversation is unavailable');
  }
}

export async function POST(request: Request) {
  try {
    // This guard intentionally runs before body parsing so the hosted mirror
    // never accepts or persists local Codex conversation content.
    if (hostedReadOnlyMode()) {
      throw new HttpError(405, 'chatgpt.site is a read-only mirror; project Codex is available only on http://localhost:3000');
    }
    assertLocalRequestTarget(request);
    if (!sameOrigin(request)) throw new HttpError(403, 'mutation origin is not allowed');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin') throw new HttpError(403, 'cross-site Codex requests are not allowed');
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
    const idempotencyKey = request.headers.get('idempotency-key')?.trim() || '';
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
      throw new HttpError(400, 'valid Idempotency-Key header is required');
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'request body is too large');
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'request body must be a JSON object');
    const body = parsed as Record<string, unknown>;
    const action = body.action;
    if (!['START', 'SEND', 'ARCHIVE', 'RESTORE'].includes(String(action))) {
      throw new HttpError(400, 'action must be START, SEND, ARCHIVE, or RESTORE');
    }
    assertAllowedFields(
      body,
      action === 'START' ? START_FIELDS : action === 'SEND' ? SEND_FIELDS : CONVERSATION_ACTION_FIELDS,
    );
    if (body.schemaVersion != null && body.schemaVersion !== '1.0') throw new HttpError(409, 'schemaVersion must be 1.0');
    const snapshotId = assertSnapshotId(body.snapshotId);
    const data = await reviewData();
    if (snapshotId !== data.snapshotId) throw new HttpError(409, 'review snapshot changed; reload before sending a Codex turn', {
      currentSnapshotId: data.snapshotId,
    });

    const conversation = action === 'START'
      ? await startCodexConversation({ snapshotId, userMessage: body.userMessage, idempotencyKey })
      : action === 'SEND'
        ? await appendCodexTurn({
        snapshotId,
        conversationId: body.conversationId,
        expectedTurnHeadHash: body.expectedTurnHeadHash,
        userMessage: body.userMessage,
        idempotencyKey,
      })
        : await setCodexConversationArchived({
          snapshotId,
          conversationId: body.conversationId,
          action: action as 'ARCHIVE' | 'RESTORE',
          idempotencyKey,
        });
    const [bridge, queue] = await Promise.all([codexBridgeProjection(), codexQueueProjection()]);
    return jsonResponse({
      schemaVersion: '1.0',
      available: true,
      hostedReadOnly: false,
      capabilityProfile: 'READ_ONLY_ADVICE',
      currentSnapshotId: data.snapshotId,
      contextFiles: CONTEXT_FILES,
      bridge,
      queue,
      conversation,
    }, { status: action === 'START' || action === 'SEND' ? 202 : 200 });
  } catch (reason) {
    return errorResponse(reason, 'Codex conversation request failed');
  }
}
