import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  lstat,
  link,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';

import { eventStorePath, HttpError, instanceMode, instanceRepository, reviewData } from './_store';
import { instanceProfile } from '../../instance-profile';
import type { AssistantContextRef, WorkContextResult } from '../../assistant/types';
import {validTurnExecution,type ExecutionGrant} from '../../../host/instance-runtime/assistant-execution-policy.mjs';

const STORE_SCHEMA_VERSION = '1.0';
let PROJECT_ID = process.env.REVIEW_PROJECT_ID || 'UNKNOWN';
const CAPABILITY_PROFILE = 'READ_ONLY_ADVICE';
let SCHEDULER_PROTOCOL = process.env.REVIEW_SCHEDULER_PROTOCOL || 'REVIEW_CODEX_SCHEDULER_V1';
let conversationHashNamespace = process.env.REVIEW_CONVERSATION_HASH_NAMESPACE || 'REVIEW_CODEX_CONVERSATION_V1';
let archiveHashNamespace = process.env.REVIEW_ARCHIVE_HASH_NAMESPACE || 'REVIEW_CODEX_ARCHIVE_EVENTS_V1';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_TURNS_PER_CONVERSATION = 100;
const DEFAULT_CONVERSATION_PAGE_SIZE = 12;
const MAX_CONVERSATION_PAGE_SIZE = 50;
const PENDING_TURN_LIMIT = 100;
const DEFAULT_BRIDGE_CONCURRENCY = 5;
const HARD_BRIDGE_CONCURRENCY_LIMIT = 8;
const BRIDGE_HEALTH_TTL_MS = 15_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 15_000;
const LOCK_HEARTBEAT_MS = Math.floor(LOCK_STALE_MS / 3);
const TURN_REQUEST_FIELDS = new Set([
  'schemaVersion', 'turnId', 'conversationId', 'projectId', 'snapshotId', 'sequence',
  'previousTurnHeadHash', 'capabilityProfile', 'schedulerProtocol', 'userMessage',
  'requestHash', 'idempotencyKeyHash', 'queuedAt',
  'assistantContext', 'mode', 'execution',
]);
const CODEX_CONTEXT_EVIDENCE_PATHS = new Set(['README.md', 'AGENTS.md', 'STATE.md']);
const CODEX_RESULT_FIELDS = new Set([
  'schemaVersion', 'turnId', 'conversationId', 'state', 'previousTurnHeadHash',
  'turnInputHash', 'contextManifestHash', 'policyHash', 'resultHash', 'turnHeadHash',
  'assistantMessage', 'evidence', 'unknowns', 'completedAt', 'errorCode',
  'errorMessage', 'suggestionOnly',
  'workContext',
]);

type ConversationRecord = {
  schemaVersion: '1.0';
  conversationId: string;
  projectId: string;
  assistantProtocol?: '1.0';
  snapshotId: string;
  initialHeadHash: string;
  initialRequestHash: string;
  createdAt: string;
};

type TurnRequestRecord = {
  mode?: 'DISCUSS'|'EXECUTE';
  execution?: ExecutionGrant;
  schemaVersion: '1.0';
  turnId: string;
  conversationId: string;
  projectId: string;
  assistantContext?: AssistantContextRef;
  snapshotId: string;
  sequence: number;
  previousTurnHeadHash: string;
  capabilityProfile: 'READ_ONLY_ADVICE'|'CONTROLLED_PROJECT_ACTIONS';
  schedulerProtocol?: string;
  userMessage: string;
  requestHash: string;
  idempotencyKeyHash: string;
  queuedAt: string;
};

type CurrentTurnRequestRecord = TurnRequestRecord & {
  schedulerProtocol: string;
};

type ConversationArchiveEvent = {
  schemaVersion: '1.0';
  eventId: string;
  conversationId: string;
  snapshotId: string;
  action: 'ARCHIVE' | 'RESTORE';
  sequence: number;
  previousEventHash: string;
  requestHash: string;
  idempotencyKeyHash: string;
  occurredAt: string;
  eventHash: string;
};

type TurnResultRecord = {
  workContext?: WorkContextResult;
  schemaVersion?: string;
  turnId?: string;
  conversationId?: string;
  state?: string;
  previousTurnHeadHash?: string;
  turnInputHash?: string;
  contextManifestHash?: string;
  policyHash?: string;
  resultHash?: string;
  turnHeadHash?: string;
  assistantMessage?: string;
  evidence?: Array<{ path?: string; note?: string }>;
  unknowns?: string[];
  completedAt?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  suggestionOnly?: boolean;
};

type IntegrityCheckedTurnResult = {
  workContext?: WorkContextResult;
  schemaVersion: '1.0';
  turnId: string;
  conversationId: string;
  state: 'SUCCEEDED' | 'FAILED' | 'RESULT_UNKNOWN' | 'STALE_CONTEXT' | 'CANCELLED';
  previousTurnHeadHash: string;
  turnInputHash: string;
  contextManifestHash: string;
  policyHash: string;
  resultHash: string;
  turnHeadHash: string;
  assistantMessage: string;
  evidence: Array<{ path?: string; note?: string }>;
  unknowns: string[];
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string;
  suggestionOnly: true;
};

export type CodexConversationMessage = {
  mode?: 'DISCUSS'|'EXECUTE';
  assistantContext?: AssistantContextRef;
  workContext?: WorkContextResult;
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
  status: string;
  evidence?: Array<{ path: string; note: string }>;
  unknowns?: string[];
  suggestionOnly?: boolean;
};

export type CodexConversationProjection = {
  assistantProtocol?: '1.0';
  id: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  state: 'EMPTY' | 'QUEUED' | 'RUNNING' | 'READY' | 'BLOCKED';
  headHash: string;
  activeTurnId: string | null;
  activeTurnStatus: 'QUEUED' | 'RUNNING' | null;
  queuePosition: number | null;
  blockedReason: string | null;
  canSend: boolean;
  archived: boolean;
  archivedAt: string | null;
  messages: CodexConversationMessage[];
};

export type CodexConversationSummary = {
  assistantProtocol?: '1.0';
  id: string;
  createdAt: string;
  updatedAt: string;
  state: CodexConversationProjection['state'];
  activeTurnStatus: CodexConversationProjection['activeTurnStatus'];
  queuePosition: number | null;
  messageCount: number;
  preview: string;
  archived: boolean;
  archivedAt: string | null;
};

export type CodexConversationPage = {
  items: CodexConversationSummary[];
  nextCursor: string | null;
  limit: number;
  archived: 'exclude' | 'only' | 'include';
};

export type CodexQueueProjection = {
  pendingTurnLimit: 100;
  pendingTurnCount: number;
  queuedTurnCount: number;
  runningTurnCount: number;
  availableQueueSlots: number;
};

export type CodexBridgeProjection = {
  executionProtocol: 'REVIEW_CONTROLLED_ACTIONS_V1'|null;
  workContextProtocol: 'REVIEW_WORK_CONTEXT_V1' | null;
  workContextCatalogVersions: string[];
  workContextPreflightVerified: boolean;
  online: boolean;
  status: 'OFFLINE' | 'READY' | 'PROCESSING' | 'DEGRADED';
  checkedAt: string | null;
  sdkVersion: string | null;
  runtimeVersion: string | null;
  model: string | null;
  mode: 'REAL' | 'MOCK' | null;
  schedulerProtocol: string | null;
  configuredConcurrency: number;
  hardConcurrencyLimit: 8;
  pendingTurnLimit: 100;
  queuedTurnCount: number | null;
  runnableSlotCount: number | null;
  activeSlotCount: number | null;
  readySlotCount: number | null;
  poisonedSlotCount: number | null;
  degradedSlotCount: number | null;
  activeConversationCount: number | null;
  slotPoisonEventCount: number | null;
};

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Value is not canonical JSON');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function requestHash(value: unknown) {
  return sha256(canonicalJson(value));
}

export function conversationStoreRoot() {
  if (instanceMode()) return path.join(path.resolve(process.env.REVIEW_INSTANCE_ROOT!), 'runtime', 'assistant', 'public');
  return path.resolve(
    process.env.CODEX_CONVERSATION_STORE_PATH
      || path.join(eventStorePath(), '.codex-conversations'),
  );
}

function storePaths() {
  const root = conversationStoreRoot();
  return {
    root,
    conversations: path.join(root, 'conversations'),
    turns: path.join(root, 'turns'),
    claims: path.join(root, 'claims'),
    results: path.join(root, 'results'),
    archiveEvents: path.join(root, 'archive-events'),
    lock: path.join(root, '.web-write.lock'),
    health: path.join(root, 'health.json'),
  };
}

async function ensureStore() {
  const profile = instanceProfile(await reviewData());
  PROJECT_ID = profile.projectId;
  SCHEDULER_PROTOCOL = profile.assistant.schedulerProtocol;
  conversationHashNamespace = profile.assistant.conversationHashNamespace;
  archiveHashNamespace = profile.assistant.archiveHashNamespace;
  const paths = storePaths();
  if (instanceMode()) return paths;
  await Promise.all([
    mkdir(paths.conversations, { recursive: true, mode: 0o700 }),
    mkdir(paths.turns, { recursive: true, mode: 0o700 }),
    mkdir(paths.claims, { recursive: true, mode: 0o700 }),
    mkdir(paths.results, { recursive: true, mode: 0o700 }),
    mkdir(paths.archiveEvents, { recursive: true, mode: 0o700 }),
  ]);
  return paths;
}

function assertInternalId(value: unknown, label: string) {
  const candidate = typeof value === 'string' ? value : '';
  if (!/^[a-z][a-z0-9_-]{7,79}$/.test(candidate)) throw new HttpError(400, `${label} is invalid`);
  return candidate;
}

function assertSha(value: unknown, label: string) {
  const candidate = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new HttpError(409, `${label} is invalid`);
  return candidate;
}

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeMessage(value: unknown) {
  if (typeof value !== 'string') throw new HttpError(422, 'userMessage is required');
  const normalized = value.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
  if (!normalized) throw new HttpError(422, 'userMessage must not be blank');
  if (normalized.length > 12_000) throw new HttpError(413, 'userMessage is too long');
  if (!isWellFormedUnicode(normalized)) throw new HttpError(422, 'userMessage must be well-formed Unicode');
  return normalized;
}

export function assistantRecordKey(filename: string) {
  const relative = path.relative(conversationStoreRoot(), path.resolve(filename));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.'))) throw new HttpError(409, 'assistant record path is invalid');
  return relative.split(path.sep).join('/');
}

async function recordNames(directory: string): Promise<string[]> {
  if (!instanceMode()) return readdir(directory);
  const prefix = `${assistantRecordKey(directory)}/`;
  return (await (await instanceRepository())!.listAux('assistant-public', { prefix })).map((record: {key: string}) => record.key.slice(prefix.length)).filter((name: string) => name && !name.includes('/'));
}

async function readJson<T>(filename: string): Promise<T | null> {
  if (instanceMode()) {
    const value = (await (await instanceRepository())!.getAux('assistant-public', assistantRecordKey(filename)));
    if (!value) return null;
    if (value.bytes.byteLength > MAX_JSON_BYTES) throw new HttpError(413, 'assistant record exceeds its size limit');
    return JSON.parse(Buffer.from(value.bytes).toString('utf8')) as T;
  }
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) return null;
    return JSON.parse(await readFile(filename, 'utf8')) as T;
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw reason;
  }
}

async function atomicWriteJson(filename: string, value: unknown) {
  if (instanceMode()) {
    const repo = (await instanceRepository())!;
    const key = assistantRecordKey(filename);
    await repo.writeTransaction(async (tx) => {
      const head = (await tx.getAux('assistant-public', key));
      (await tx.putAux({namespace: 'assistant-public', key, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), expectedRevisionId: head?.revisionId ?? null, mediaType: 'application/json', metadata: {...(head?.metadata || {}), runtimeEpoch: (await tx.readView()).runtimeEpoch}}));
    });
    return;
  }
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, filename);
    await syncDirectory(path.dirname(filename));
  } catch (reason) {
    await unlink(temp).catch(() => undefined);
    throw reason;
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pause(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type StoreLockRecord = {
  schemaVersion: '1.0';
  ownerToken: string;
  ownerPid: number;
  acquiredAt: string;
};

type StoreLockLease = StoreLockRecord & {
  ownerPath: string;
};

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readStoreLockRecord(filename: string): Promise<StoreLockRecord | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) return null;
    const raw = await readFile(filename, 'utf8');
    try {
      const parsed = JSON.parse(raw) as Partial<StoreLockRecord>;
      if (
        parsed.schemaVersion === STORE_SCHEMA_VERSION
        && typeof parsed.ownerToken === 'string'
        && /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(parsed.ownerToken)
        && Number.isSafeInteger(parsed.ownerPid)
        && Number(parsed.ownerPid) > 0
        && typeof parsed.acquiredAt === 'string'
        && !Number.isNaN(Date.parse(parsed.acquiredAt))
      ) return parsed as StoreLockRecord;
    } catch {
      // Fall through to the legacy two-line lock format for safe migration.
    }
    const [legacyPid, legacyTimestamp] = raw.trim().split(/\r?\n/, 2);
    const ownerPid = Number(legacyPid);
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && !Number.isNaN(Date.parse(legacyTimestamp || ''))) {
      return {
        schemaVersion: STORE_SCHEMA_VERSION,
        ownerToken: `legacy-${sha256(raw)}`,
        ownerPid,
        acquiredAt: legacyTimestamp,
      };
    }
    return null;
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function reclaimStaleStoreLock(lockPath: string, observed: { dev: number; ino: number; mtimeMs: number }) {
  if (Date.now() - observed.mtimeMs <= LOCK_STALE_MS) return false;
  const record = await readStoreLockRecord(lockPath);
  if (!record) return false;

  const reclaimPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.reclaim.${record.ownerToken}.${randomUUID()}`,
  );
  try {
    await link(lockPath, reclaimPath);
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    throw reason;
  }

  try {
    const [currentInfo, reclaimInfo, currentRecord] = await Promise.all([
      lstat(lockPath).catch(() => null),
      lstat(reclaimPath).catch(() => null),
      readStoreLockRecord(reclaimPath),
    ]);
    if (
      !currentInfo
      || !reclaimInfo
      || !sameFileIdentity(currentInfo, reclaimInfo)
      || !sameFileIdentity(currentInfo, observed)
      || currentRecord?.ownerToken !== record.ownerToken
      || currentRecord.ownerPid !== record.ownerPid
      || Date.now() - currentInfo.mtimeMs <= LOCK_STALE_MS
    ) return false;

    // Re-read immediately before the unlink. A heartbeat that refreshed the
    // same inode after the first observation cancels this takeover.
    const [verifiedInfo, verifiedReclaimInfo, verifiedRecord] = await Promise.all([
      lstat(lockPath).catch(() => null),
      lstat(reclaimPath).catch(() => null),
      readStoreLockRecord(lockPath),
    ]);
    if (
      !verifiedInfo
      || !verifiedReclaimInfo
      || !sameFileIdentity(verifiedInfo, verifiedReclaimInfo)
      || !sameFileIdentity(verifiedInfo, observed)
      || verifiedInfo.mtimeMs !== currentInfo.mtimeMs
      || verifiedRecord?.ownerToken !== record.ownerToken
      || verifiedRecord.ownerPid !== record.ownerPid
      || Date.now() - verifiedInfo.mtimeMs <= LOCK_STALE_MS
    ) return false;

    await unlink(lockPath);
    await syncDirectory(path.dirname(lockPath));

    if (!record.ownerToken.startsWith('legacy-')) {
      const abandonedOwnerPath = path.join(
        path.dirname(lockPath),
        `.${path.basename(lockPath)}.owner.${record.ownerPid}.${record.ownerToken}.lease`,
      );
      const abandonedOwnerInfo = await lstat(abandonedOwnerPath).catch(() => null);
      if (abandonedOwnerInfo && sameFileIdentity(abandonedOwnerInfo, reclaimInfo)) {
        await unlink(abandonedOwnerPath).catch(() => undefined);
      }
    }
    return true;
  } finally {
    await unlink(reclaimPath).catch(() => undefined);
  }
}

async function releaseStoreLock(lockPath: string, lease: StoreLockLease) {
  const [currentInfo, ownerInfo, currentRecord] = await Promise.all([
    lstat(lockPath).catch(() => null),
    lstat(lease.ownerPath).catch(() => null),
    readStoreLockRecord(lockPath),
  ]);
  if (
    currentInfo
    && ownerInfo
    && sameFileIdentity(currentInfo, ownerInfo)
    && currentRecord?.ownerToken === lease.ownerToken
    && currentRecord.ownerPid === lease.ownerPid
  ) {
    await unlink(lockPath).catch(() => undefined);
    await syncDirectory(path.dirname(lockPath)).catch(() => undefined);
  }
  await unlink(lease.ownerPath).catch(() => undefined);
}

function startStoreLockHeartbeat(lockPath: string, lease: StoreLockLease) {
  let stopped = false;
  let refreshing = false;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const [currentInfo, ownerInfo, currentRecord] = await Promise.all([
        lstat(lockPath).catch(() => null),
        lstat(lease.ownerPath).catch(() => null),
        readStoreLockRecord(lockPath),
      ]);
      if (
        !currentInfo
        || !ownerInfo
        || !sameFileIdentity(currentInfo, ownerInfo)
        || currentRecord?.ownerToken !== lease.ownerToken
        || currentRecord.ownerPid !== lease.ownerPid
      ) {
        stopped = true;
        return;
      }
      const now = new Date();
      await utimes(lease.ownerPath, now, now);
    } catch {
      // Stop renewal on an ownership or filesystem error. Release still checks
      // the inode and owner token before it can unlink the public lock path.
      stopped = true;
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => void refresh(), LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  if (instanceMode()) {
    await ensureStore();
    return (await instanceRepository())!.writeTransaction(operation);
  }
  const paths = await ensureStore();
  const startedAt = Date.now();
  const ownerToken = randomUUID();
  const ownerPath = path.join(paths.root, `.${path.basename(paths.lock)}.owner.${process.pid}.${ownerToken}.lease`);
  const lease: StoreLockLease = {
    schemaVersion: STORE_SCHEMA_VERSION,
    ownerToken,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
    ownerPath,
  };
  await atomicWriteJson(ownerPath, {
    schemaVersion: lease.schemaVersion,
    ownerToken: lease.ownerToken,
    ownerPid: lease.ownerPid,
    acquiredAt: lease.acquiredAt,
  });
  let acquired = false;
  let stopHeartbeat: (() => void) | null = null;
  try {
    while (!acquired) {
      try {
        await link(ownerPath, paths.lock);
        acquired = true;
        await syncDirectory(paths.root);
        stopHeartbeat = startStoreLockHeartbeat(paths.lock, lease);
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason;
        const lockInfo = await lstat(paths.lock).catch(() => null);
        if (lockInfo && await reclaimStaleStoreLock(paths.lock, lockInfo)) continue;
        if (Date.now() - startedAt >= LOCK_WAIT_MS) throw new HttpError(503, 'Codex conversation store is busy');
        await pause(25);
      }
    }
    return await operation();
  } finally {
    stopHeartbeat?.();
    if (acquired) await releaseStoreLock(paths.lock, lease).catch(() => undefined);
    else await unlink(ownerPath).catch(() => undefined);
  }
}

export async function withCodexConversationStoreLockForTest<T>(operation: () => Promise<T>) {
  if (process.env.NODE_ENV !== 'test' && !process.env.REVIEW_E2E_RUNTIME_ROOT) {
    throw new Error('Codex conversation store lock test hook is unavailable');
  }
  return withStoreLock(operation);
}

function conversationIdFor(idempotencyKey: string) {
  return `codx_${sha256(`conversation\0${idempotencyKey}`).slice(0, 32)}`;
}

function turnIdFor(idempotencyKey: string) {
  return `turn_${sha256(`turn\0${idempotencyKey}`).slice(0, 32)}`;
}

function archiveEventIdFor(idempotencyKey: string) {
  return `cact_${sha256(`conversation-action\0${idempotencyKey}`).slice(0, 32)}`;
}

function initialArchiveEventHash(conversationId: string) {
  return sha256(`${archiveHashNamespace}\0${conversationId}`);
}

function archiveEventHash(event: Omit<ConversationArchiveEvent, 'eventHash'>) {
  return sha256(canonicalJson(event));
}

function initialHeadHash(conversationId: string, snapshotId: string) {
  return sha256(`${conversationHashNamespace}\0${conversationId}\0${snapshotId}`);
}

function validConversation(value: ConversationRecord | null): value is ConversationRecord {
  return Boolean(
    value
      && value.schemaVersion === STORE_SCHEMA_VERSION
      && value.projectId === PROJECT_ID
      && (value.assistantProtocol === undefined || value.assistantProtocol === '1.0')
      && /^[a-z][a-z0-9_-]{7,79}$/.test(value.conversationId)
      && typeof value.snapshotId === 'string'
      && /^[a-f0-9]{64}$/.test(value.initialHeadHash)
      && /^[a-f0-9]{64}$/.test(value.initialRequestHash)
      && !Number.isNaN(Date.parse(value.createdAt)),
  );
}

function validTurn(value: TurnRequestRecord | null): value is CurrentTurnRequestRecord {
  return validReadableTurn(value) && value.schedulerProtocol === SCHEDULER_PROTOCOL;
}

function validReadableTurn(value: TurnRequestRecord | null): value is TurnRequestRecord {
  const fields = value && typeof value === 'object' ? Object.keys(value) : [];
  const hasSchedulerProtocol = fields.includes('schedulerProtocol');
  return Boolean(
    value
      && fields.every((field) => TURN_REQUEST_FIELDS.has(field))
      && fields.length === TURN_REQUEST_FIELDS.size - (hasSchedulerProtocol ? 0 : 1) - (value.assistantContext ? 0 : 1) - (value.mode === undefined ? 1 : 0) - (value.execution === undefined ? 1 : 0)
      && (value.assistantContext === undefined || validAssistantRef(value.assistantContext))
      && value.schemaVersion === STORE_SCHEMA_VERSION
      && value.projectId === PROJECT_ID
      && validTurnExecution(value)
      && value.capabilityProfile === (value.mode === 'EXECUTE' ? 'CONTROLLED_PROJECT_ACTIONS' : CAPABILITY_PROFILE)
      && (value.schedulerProtocol === undefined || value.schedulerProtocol === SCHEDULER_PROTOCOL)
      && /^[a-z][a-z0-9_-]{7,79}$/.test(value.turnId)
      && /^[a-z][a-z0-9_-]{7,79}$/.test(value.conversationId)
      && typeof value.snapshotId === 'string'
      && value.snapshotId.length > 0
      && value.snapshotId.length <= 200
      && isWellFormedUnicode(value.snapshotId)
      && Number.isSafeInteger(value.sequence)
      && value.sequence > 0
      && value.sequence <= MAX_TURNS_PER_CONVERSATION
      && typeof value.userMessage === 'string'
      && value.userMessage.length > 0
      && value.userMessage.length <= 12_000
      && value.userMessage === value.userMessage.trim()
      && !value.userMessage.includes('\0')
      && isWellFormedUnicode(value.userMessage)
      && /^[a-f0-9]{64}$/.test(value.previousTurnHeadHash)
      && /^[a-f0-9]{64}$/.test(value.requestHash)
      && /^[a-f0-9]{64}$/.test(value.idempotencyKeyHash)
      && !Number.isNaN(Date.parse(value.queuedAt)),
  );
}

function validArchiveEvent(value: ConversationArchiveEvent | null): value is ConversationArchiveEvent {
  return Boolean(
    value
      && value.schemaVersion === STORE_SCHEMA_VERSION
      && /^cact_[a-f0-9]{32}$/.test(value.eventId)
      && /^[a-z][a-z0-9_-]{7,79}$/.test(value.conversationId)
      && typeof value.snapshotId === 'string'
      && value.snapshotId.length > 0
      && value.snapshotId.length <= 200
      && (value.action === 'ARCHIVE' || value.action === 'RESTORE')
      && Number.isSafeInteger(value.sequence)
      && value.sequence > 0
      && /^[a-f0-9]{64}$/.test(value.previousEventHash)
      && /^[a-f0-9]{64}$/.test(value.requestHash)
      && /^[a-f0-9]{64}$/.test(value.idempotencyKeyHash)
      && !Number.isNaN(Date.parse(value.occurredAt))
      && /^[a-f0-9]{64}$/.test(value.eventHash),
  );
}

async function listArchiveEvents(conversationId: string) {
  const paths = await ensureStore();
  const directory = path.join(paths.archiveEvents, conversationId);
  const names = await (await recordNames(directory).catch((reason) => {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw reason;
  }));
  const events: ConversationArchiveEvent[] = [];
  for (const name of names) {
    const matched = /^(\d{12})_(cact_[a-f0-9]{32})\.json$/.exec(name);
    if (!matched) continue;
    const event = await readJson<ConversationArchiveEvent>(path.join(directory, name));
    if (
      !validArchiveEvent(event)
      || event.conversationId !== conversationId
      || event.sequence !== Number(matched[1])
      || event.eventId !== matched[2]
    ) {
      throw new HttpError(503, 'Codex conversation archive marker is invalid');
    }
    events.push(event);
  }
  events.sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
  let previousEventHash = initialArchiveEventHash(conversationId);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const { eventHash, ...hashPayload } = event;
    if (
      event.sequence !== index + 1
      || event.previousEventHash !== previousEventHash
      || eventHash !== archiveEventHash(hashPayload)
    ) {
      throw new HttpError(503, 'Codex conversation archive marker chain is invalid');
    }
    previousEventHash = eventHash;
  }
  return events;
}

async function conversationArchiveState(conversationId: string) {
  const events = await listArchiveEvents(conversationId);
  const latest = events.at(-1) || null;
  return {
    events,
    archived: latest?.action === 'ARCHIVE',
    archivedAt: latest?.action === 'ARCHIVE' ? latest.occurredAt : null,
  };
}

type PendingTurnProjection = {
  turn: TurnRequestRecord;
  status: 'QUEUED' | 'RUNNING';
  queuePosition: number | null;
};

async function turnCanExecuteInCurrentRuntime(turnId: string) {
  if (!instanceMode()) return true;
  const repo = (await instanceRepository())!;
  const record = (await repo.getAux('assistant-public', `turns/${turnId}.json`));
  return record?.metadata.runtimeEpoch === (await repo.readView()).runtimeEpoch;
}

async function pendingTurnProjections() {
  const paths = await ensureStore();
  const [turnNames, resultNames, claimNames] = await Promise.all([
    (await recordNames(paths.turns).catch(() => [])),
    (await recordNames(paths.results).catch(() => [])),
    (await recordNames(paths.claims).catch(() => [])),
  ]);
  const terminalTurnIds = new Set(
    resultNames.flatMap((name) => /^((?:turn_)[a-f0-9]{32})\.json$/.exec(name)?.[1] || []),
  );
  const claimedTurnIds = new Set(
    claimNames.flatMap((name) => /^((?:turn_)[a-f0-9]{32})\.json$/.exec(name)?.[1] || []),
  );
  const pending: Array<Omit<PendingTurnProjection, 'queuePosition'>> = [];
  for (const name of turnNames) {
    const matched = /^(turn_[a-f0-9]{32})\.json$/.exec(name);
    if (!matched || terminalTurnIds.has(matched[1])) continue;
    const turn = await readJson<TurnRequestRecord>(path.join(paths.turns, name));
    if (validReadableTurn(turn) && await turnCanExecuteInCurrentRuntime(turn.turnId)) {
      pending.push({ turn, status: claimedTurnIds.has(turn.turnId) ? 'RUNNING' : 'QUEUED' });
    }
  }
  pending.sort((left, right) => left.turn.queuedAt.localeCompare(right.turn.queuedAt) || left.turn.turnId.localeCompare(right.turn.turnId));
  let queuedPosition = 0;
  return pending.map((item): PendingTurnProjection => {
    if (item.status === 'RUNNING') return { ...item, queuePosition: null };
    queuedPosition += 1;
    return { ...item, queuePosition: queuedPosition };
  });
}

async function assertPendingTurnCapacity() {
  const pending = await pendingTurnProjections();
  if (pending.length >= PENDING_TURN_LIMIT) {
    throw new HttpError(429, 'Codex conversation queue is full; wait for a queued turn to finish', {
      pendingTurnLimit: PENDING_TURN_LIMIT,
      pendingTurnCount: pending.length,
    });
  }
}

async function listTurns(conversationId: string) {
  const paths = await ensureStore();
  const names = await (await recordNames(paths.turns).catch(() => []));
  const turns: TurnRequestRecord[] = [];
  for (const name of names) {
    if (!/^turn_[a-f0-9]{32}\.json$/.test(name)) continue;
    const turn = await readJson<TurnRequestRecord>(path.join(paths.turns, name));
    if (validReadableTurn(turn) && turn.conversationId === conversationId) turns.push(turn);
  }
  return turns.sort((left, right) => left.sequence - right.sequence || left.queuedAt.localeCompare(right.queuedAt));
}

function validAssistantRef(value: AssistantContextRef) {
  return Boolean(value && Object.keys(value).length === 2 && /^[a-f0-9]{64}$/.test(value.packetHash) && value.packetId === `ctx_${value.packetHash}`);
}

function validWorkContext(value: WorkContextResult) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => ['packetId', 'packetHash', 'focusKey', 'evidenceIds', 'observedImageIds', 'suggestions', 'stale'].includes(key))
    && validAssistantRef({ packetId: value.packetId, packetHash: value.packetHash })
    && typeof value.focusKey === 'string' && value.focusKey.length <= 1000
    && typeof value.stale === 'boolean'
    && Array.isArray(value.evidenceIds) && value.evidenceIds.length <= 100 && value.evidenceIds.every((id) => typeof id === 'string' && id.length <= 500)
    && Array.isArray(value.observedImageIds) && value.observedImageIds.length <= 8 && value.observedImageIds.every((id) => value.evidenceIds.includes(id))
    && Array.isArray(value.suggestions) && value.suggestions.length <= 8
    && value.suggestions.every((item) => item && Object.keys(item).every((key) => key === 'targetId' || key === 'text') && typeof item.targetId === 'string' && item.targetId.length <= 4096 && !/[\x00-\x1f\x7f]/.test(item.targetId) && typeof item.text === 'string' && item.text.length <= 20000));
}

function allowedEvidencePath(value: string, context?: WorkContextResult) {
  return CODEX_CONTEXT_EVIDENCE_PATHS.has(value) || Boolean(context && value.startsWith('resource:') && context.evidenceIds.includes(value.slice(9)));
}

function safeEvidence(value: unknown, context?: WorkContextResult) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as { path?: unknown; note?: unknown };
    const itemPath = typeof entry.path === 'string' ? entry.path.trim() : '';
    const note = typeof entry.note === 'string' ? entry.note.trim().slice(0, 1_000) : '';
    if (!allowedEvidencePath(itemPath, context)) return [];
    return [{ path: itemPath, note }];
  });
}

function safeUnknowns(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 20).map((item) => item.slice(0, 1_000));
}

function terminalState(value: unknown) {
  const candidate = typeof value === 'string' ? value : '';
  return ['SUCCEEDED', 'FAILED', 'RESULT_UNKNOWN', 'STALE_CONTEXT', 'CANCELLED'].includes(candidate) ? candidate : '';
}

function integrityCheckedResult(value: TurnResultRecord | null): IntegrityCheckedTurnResult | null {
  const state = terminalState(value?.state);
  if (
    !value
    || Object.keys(value).some((key) => !CODEX_RESULT_FIELDS.has(key))
    || value.schemaVersion !== STORE_SCHEMA_VERSION
    || (value.workContext !== undefined && !validWorkContext(value.workContext))
    || !state
    || typeof value.turnId !== 'string'
    || typeof value.conversationId !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.previousTurnHeadHash || '')
    || !/^[a-f0-9]{64}$/.test(value.turnInputHash || '')
    || !/^[a-f0-9]{64}$/.test(value.contextManifestHash || '')
    || !/^[a-f0-9]{64}$/.test(value.policyHash || '')
    || !/^[a-f0-9]{64}$/.test(value.resultHash || '')
    || !/^[a-f0-9]{64}$/.test(value.turnHeadHash || '')
    || typeof value.assistantMessage !== 'string'
    || !Array.isArray(value.evidence)
    || !value.evidence.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const entry = item as Record<string, unknown>;
      return Object.keys(entry).every((key) => key === 'path' || key === 'note')
        && typeof entry.path === 'string'
        && allowedEvidencePath(entry.path, value.workContext)
        && typeof entry.note === 'string';
    })
    || !Array.isArray(value.unknowns)
    || !value.unknowns.every((item) => typeof item === 'string')
    || (value.errorCode !== null && typeof value.errorCode !== 'string')
    || (value.errorMessage !== null && typeof value.errorMessage !== 'string')
    || typeof value.completedAt !== 'string'
    || Number.isNaN(Date.parse(value.completedAt))
    || value.suggestionOnly !== true
  ) return null;
  return value as IntegrityCheckedTurnResult;
}

function turnInputHash(turn: TurnRequestRecord, result: IntegrityCheckedTurnResult) {
  return sha256(canonicalJson({
    conversationId: turn.conversationId,
    previousTurnHeadHash: turn.previousTurnHeadHash,
    snapshotId: turn.snapshotId,
    contextManifestHash: result.contextManifestHash,
    policyHash: result.policyHash,
    userMessage: turn.userMessage,
    ...(turn.assistantContext ? { assistantContext: turn.assistantContext } : {}),
    ...(turn.mode ? {mode:turn.mode}:{}),...(turn.execution ? {execution:turn.execution}:{}),
  }));
}

function resultHash(result: IntegrityCheckedTurnResult) {
  return sha256(canonicalJson({
    schemaVersion: result.schemaVersion,
    turnId: result.turnId,
    conversationId: result.conversationId,
    state: result.state,
    previousTurnHeadHash: result.previousTurnHeadHash,
    turnInputHash: result.turnInputHash,
    contextManifestHash: result.contextManifestHash,
    policyHash: result.policyHash,
    assistantMessage: result.assistantMessage,
    evidence: result.evidence,
    unknowns: result.unknowns,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    completedAt: result.completedAt,
    suggestionOnly: result.suggestionOnly,
    ...(result.workContext ? { workContext: result.workContext } : {}),
  }));
}

function turnHeadHash(previousTurnHeadHash: string, inputHash: string, terminalResultHash: string) {
  return sha256(`${previousTurnHeadHash}\0${inputHash}\0${terminalResultHash}`);
}

export async function projectCodexConversation(conversationIdInput: string, currentSnapshotId: string) {
  const conversationId = assertInternalId(conversationIdInput, 'conversationId');
  const paths = await ensureStore();
  const conversation = await readJson<ConversationRecord>(path.join(paths.conversations, `${conversationId}.json`));
  if (!validConversation(conversation)) throw new HttpError(404, 'Codex conversation was not found');

  const [turns, archiveState] = await Promise.all([
    (await listTurns(conversationId)),
    conversationArchiveState(conversationId),
  ]);
  let headHash = conversation.initialHeadHash;
  let activeTurnId: string | null = null;
  let activeTurnStatus: CodexConversationProjection['activeTurnStatus'] = null;
  let blockedReason: string | null = null;
  let updatedAt = conversation.createdAt;
  const messages: CodexConversationMessage[] = [];

  for (const turn of turns) {
    updatedAt = turn.queuedAt > updatedAt ? turn.queuedAt : updatedAt;
    messages.push({
      id: turn.turnId,
      role: 'user',
      mode: turn.mode || 'DISCUSS',
      text: turn.userMessage,
      createdAt: turn.queuedAt,
      status: 'QUEUED',
      ...(turn.assistantContext ? { assistantContext: turn.assistantContext } : {}),
    });

    const rawResult = await readJson<TurnResultRecord>(path.join(paths.results, `${turn.turnId}.json`));
    if (!rawResult) {
      if (!(await turnCanExecuteInCurrentRuntime(turn.turnId))) {
        messages[messages.length - 1].status = 'RESULT_UNKNOWN';
        blockedReason = 'RUNTIME_EPOCH_CHANGED';
        messages.push({id:`${turn.turnId}:runtime`,role:'system',status:'RESULT_UNKNOWN',createdAt:turn.queuedAt,text:'此请求来自导入或恢复前的运行期，已停止自动执行；请先核查旧结果，再明确新建请求。'});
        continue;
      }
      const claim = await readJson<Record<string, unknown>>(path.join(paths.claims, `${turn.turnId}.json`));
      messages[messages.length - 1].status = claim ? 'RUNNING' : 'QUEUED';
      activeTurnId = turn.turnId;
      activeTurnStatus = claim ? 'RUNNING' : 'QUEUED';
      continue;
    }

    const result = integrityCheckedResult(rawResult);
    const state = result?.state || '';
    const expectedTurnInputHash = result ? turnInputHash(turn, result) : '';
    const expectedResultHash = result ? resultHash(result) : '';
    const expectedTurnHeadHash = result
      ? turnHeadHash(headHash, expectedTurnInputHash, expectedResultHash)
      : '';
    if (
      !result
      || turn.previousTurnHeadHash !== headHash
      || result.turnId !== turn.turnId
      || result.conversationId !== conversationId
      || result.previousTurnHeadHash !== headHash
      || result.turnInputHash !== expectedTurnInputHash
      || result.resultHash !== expectedResultHash
      || result.turnHeadHash !== expectedTurnHeadHash
      || (turn.assistantContext && result.state === 'SUCCEEDED' && (result.workContext?.packetHash !== turn.assistantContext.packetHash || result.workContext?.packetId !== turn.assistantContext.packetId))
    ) {
      messages[messages.length - 1].status = 'INVALID_RESULT';
      blockedReason = 'INVALID_RESULT_CHAIN';
      messages.push({
        id: `${turn.turnId}:system`, role: 'system', status: 'INVALID_RESULT', createdAt: turn.queuedAt,
        text: '该轮结果未通过完整性校验，请新建对话。',
      });
      break;
    }

    headHash = result.turnHeadHash;
    const completedAt = result.completedAt;
    updatedAt = completedAt > updatedAt ? completedAt : updatedAt;
    messages[messages.length - 1].status = state;
    if (state === 'SUCCEEDED') {
      const answer = typeof result.assistantMessage === 'string' ? result.assistantMessage.trim().slice(0, 30_000) : '';
      if (!answer) {
        blockedReason = 'INVALID_EMPTY_RESULT';
        messages.push({
          id: `${turn.turnId}:system`, role: 'system', status: 'INVALID_RESULT', createdAt: completedAt,
          text: 'Codex 返回了空结果，请新建对话。',
        });
        break;
      }
      messages.push({
        id: `${turn.turnId}:assistant`,
        role: 'assistant',
        mode: turn.mode || 'DISCUSS',
        text: answer,
        createdAt: completedAt,
        status: state,
        evidence: safeEvidence(result.evidence, result.workContext),
        ...(turn.assistantContext ? { assistantContext: turn.assistantContext } : {}),
        ...(result.workContext ? { workContext: result.workContext } : {}),
        unknowns: safeUnknowns(result.unknowns),
        suggestionOnly: true,
      });
    } else {
      blockedReason = state;
      const safeMessage = typeof result.errorMessage === 'string' ? result.errorMessage.slice(0, 1_000) : '';
      messages.push({
        id: `${turn.turnId}:system`,
        role: 'system',
        text: state === 'STALE_CONTEXT'
          ? '项目上下文或审阅快照已变化，请基于当前上下文新建对话。'
          : state === 'RESULT_UNKNOWN'
            ? '该轮执行结果未知，为避免重复调用不会自动重试。请核查后新建对话。'
            : safeMessage || '该轮未完成，请新建对话后重试。',
        createdAt: completedAt,
        status: state,
      });
    }
  }

  if (!conversation.assistantProtocol && conversation.snapshotId !== currentSnapshotId) blockedReason ||= 'STALE_SNAPSHOT';
  if (archiveState.archived) blockedReason ||= 'ARCHIVED';
  const archiveUpdatedAt = archiveState.events.at(-1)?.occurredAt || '';
  if (archiveUpdatedAt > updatedAt) updatedAt = archiveUpdatedAt;
  const pending = activeTurnId ? await pendingTurnProjections() : [];
  const activePending = activeTurnId
    ? pending.find((item) => item.turn.turnId === activeTurnId) || null
    : null;
  if (activePending) activeTurnStatus = activePending.status;
  const state: CodexConversationProjection['state'] = blockedReason
    ? 'BLOCKED'
    : activeTurnId
      ? activeTurnStatus === 'RUNNING' ? 'RUNNING' : 'QUEUED'
      : turns.length ? 'READY' : 'EMPTY';
  return {
    id: conversation.conversationId,
    ...(conversation.assistantProtocol ? { assistantProtocol: conversation.assistantProtocol } : {}),
    snapshotId: conversation.snapshotId,
    createdAt: conversation.createdAt,
    updatedAt,
    state,
    headHash,
    activeTurnId,
    activeTurnStatus,
    queuePosition: activePending?.queuePosition || null,
    blockedReason,
    canSend: !activeTurnId && !blockedReason && !archiveState.archived,
    archived: archiveState.archived,
    archivedAt: archiveState.archivedAt,
    messages,
  } satisfies CodexConversationProjection;
}

export async function startCodexConversation(input: {
  snapshotId: string;
  userMessage: unknown;
  idempotencyKey: string;
  assistantContext?: AssistantContextRef;
  mode?: 'DISCUSS'|'EXECUTE';
  execution?: ExecutionGrant;
}) {
  return withStoreLock(async () => {
    const paths = storePaths();
    if (input.assistantContext && !validAssistantRef(input.assistantContext)) throw new HttpError(400, 'invalid assistant context reference');
    if (!validTurnExecution(input)) throw new HttpError(400, 'invalid per-turn execution authority');
    const userMessage = normalizeMessage(input.userMessage);
    const semanticRequest = {
      action: 'START',
      schedulerProtocol: SCHEDULER_PROTOCOL,
      snapshotId: input.snapshotId,
      userMessage,
      ...(input.assistantContext ? { assistantContext: input.assistantContext } : {}),
      ...(input.mode ? {mode:input.mode}:{}),...(input.execution ? {execution:input.execution}:{}),
    };
    const semanticHash = requestHash(semanticRequest);
    const conversationId = conversationIdFor(input.idempotencyKey);
    const turnId = turnIdFor(input.idempotencyKey);
    const conversationPath = path.join(paths.conversations, `${conversationId}.json`);
    const turnPath = path.join(paths.turns, `${turnId}.json`);
    const existing = await readJson<ConversationRecord>(conversationPath);
    const existingTurn = await readJson<TurnRequestRecord>(turnPath);
    const firstHead = initialHeadHash(conversationId, input.snapshotId);
    const idempotencyKeyHash = sha256(input.idempotencyKey);
    const validExistingInitialTurn = Boolean(
      validTurn(existingTurn)
      && existingTurn.turnId === turnId
      && existingTurn.conversationId === conversationId
      && existingTurn.snapshotId === input.snapshotId
      && existingTurn.sequence === 1
      && existingTurn.previousTurnHeadHash === firstHead
      && existingTurn.userMessage === userMessage
      && existingTurn.requestHash === semanticHash
      && existingTurn.idempotencyKeyHash === idempotencyKeyHash,
    );
    if (existing) {
      if (
        !validConversation(existing)
        || existing.conversationId !== conversationId
        || existing.snapshotId !== input.snapshotId
        || existing.initialHeadHash !== firstHead
        || existing.initialRequestHash !== semanticHash
      ) {
        throw new HttpError(409, 'Idempotency-Key was already used with a different Codex conversation request');
      }
      if (existingTurn && !validExistingInitialTurn) {
        throw new HttpError(409, 'Idempotency-Key was already used with a different Codex turn request');
      }
      if (!existingTurn) {
        await atomicWriteJson(turnPath, {
          schemaVersion: STORE_SCHEMA_VERSION,
          turnId,
          conversationId,
          projectId: PROJECT_ID,
          snapshotId: input.snapshotId,
          sequence: 1,
          previousTurnHeadHash: firstHead,
          capabilityProfile: input.mode === 'EXECUTE' ? 'CONTROLLED_PROJECT_ACTIONS' : CAPABILITY_PROFILE,
          schedulerProtocol: SCHEDULER_PROTOCOL,
          userMessage,
          ...(input.assistantContext ? { assistantContext: input.assistantContext } : {}),
      ...(input.mode ? {mode:input.mode}:{}),...(input.execution ? {execution:input.execution}:{}),
          requestHash: semanticHash,
          idempotencyKeyHash,
          queuedAt: existing.createdAt,
        } satisfies CurrentTurnRequestRecord);
      }
      return (await projectCodexConversation(conversationId, input.snapshotId));
    }
    if (existingTurn && !validExistingInitialTurn) {
      throw new HttpError(409, 'Idempotency-Key was already used with a different incomplete Codex conversation request');
    }

    if (!existingTurn) await assertPendingTurnCapacity();
    const createdAt = existingTurn?.queuedAt || new Date().toISOString();
    const conversation: ConversationRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      ...(input.assistantContext ? { assistantProtocol: '1.0' as const } : {}),
      conversationId,
      projectId: PROJECT_ID,
      snapshotId: input.snapshotId,
      initialHeadHash: firstHead,
      initialRequestHash: semanticHash,
      createdAt,
    };
    const turn: CurrentTurnRequestRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      turnId,
      conversationId,
      projectId: PROJECT_ID,
      snapshotId: input.snapshotId,
      sequence: 1,
      previousTurnHeadHash: firstHead,
      capabilityProfile: input.mode === 'EXECUTE' ? 'CONTROLLED_PROJECT_ACTIONS' : CAPABILITY_PROFILE,
      schedulerProtocol: SCHEDULER_PROTOCOL,
      userMessage,
      ...(input.assistantContext ? { assistantContext: input.assistantContext } : {}),
      ...(input.mode ? {mode:input.mode}:{}),...(input.execution ? {execution:input.execution}:{}),
      requestHash: semanticHash,
      idempotencyKeyHash,
      queuedAt: createdAt,
    };
    // A Turn is the worker-visible commit marker. Persist and fsync its parent
    // Conversation first so a process or machine crash cannot publish an orphan.
    await atomicWriteJson(conversationPath, conversation);
    if (!existingTurn) await atomicWriteJson(turnPath, turn);
    return (await projectCodexConversation(conversationId, input.snapshotId));
  });
}

export async function appendCodexTurn(input: {
  conversationId: unknown;
  snapshotId: string;
  expectedTurnHeadHash: unknown;
  userMessage: unknown;
  idempotencyKey: string;
  assistantContext?: AssistantContextRef;
  mode?: 'DISCUSS'|'EXECUTE';
  execution?: ExecutionGrant;
}) {
  return withStoreLock(async () => {
    const paths = storePaths();
    if (input.assistantContext && !validAssistantRef(input.assistantContext)) throw new HttpError(400, 'invalid assistant context reference');
    if (!validTurnExecution(input)) throw new HttpError(400, 'invalid per-turn execution authority');
    const conversationId = assertInternalId(input.conversationId, 'conversationId');
    const expectedTurnHeadHash = assertSha(input.expectedTurnHeadHash, 'expectedTurnHeadHash');
    const userMessage = normalizeMessage(input.userMessage);
    const semanticRequest = {
      action: 'SEND',
      schedulerProtocol: SCHEDULER_PROTOCOL,
      snapshotId: input.snapshotId,
      conversationId,
      expectedTurnHeadHash,
      userMessage,
      ...(input.assistantContext ? { assistantContext: input.assistantContext } : {}),
      ...(input.mode ? {mode:input.mode}:{}),...(input.execution ? {execution:input.execution}:{}),
    };
    const semanticHash = requestHash(semanticRequest);
    const turnId = turnIdFor(input.idempotencyKey);
    const turnPath = path.join(paths.turns, `${turnId}.json`);
    const existingTurn = await readJson<TurnRequestRecord>(turnPath);
    if (existingTurn) {
      if (!validTurn(existingTurn) || existingTurn.requestHash !== semanticHash || existingTurn.conversationId !== conversationId) {
        throw new HttpError(409, 'Idempotency-Key was already used with a different Codex turn request');
      }
      return (await projectCodexConversation(conversationId, input.snapshotId));
    }

    const projection = await projectCodexConversation(conversationId, input.snapshotId);
    if (Boolean(input.assistantContext) !== Boolean(projection.assistantProtocol)) throw new HttpError(409, 'conversation capability cannot be changed; start a new conversation');
    if (!projection.assistantProtocol && projection.snapshotId !== input.snapshotId) throw new HttpError(409, 'conversation belongs to a different review snapshot');
    if (projection.archived) throw new HttpError(409, 'conversation is archived; restore it before sending');
    if (projection.activeTurnId) throw new HttpError(409, 'conversation already has an active turn');
    if (projection.blockedReason) throw new HttpError(409, 'conversation can no longer be resumed; create a new conversation', {
      blockedReason: projection.blockedReason,
    });
    if (projection.headHash !== expectedTurnHeadHash) throw new HttpError(409, 'expectedTurnHeadHash is stale; reload the conversation', {
      currentTurnHeadHash: projection.headHash,
    });
    const turnCount = projection.messages.filter((message) => message.role === 'user').length;
    if (turnCount >= MAX_TURNS_PER_CONVERSATION) {
      throw new HttpError(409, 'conversation reached the maximum turn count; create a new conversation');
    }
    await assertPendingTurnCapacity();
    const turn: CurrentTurnRequestRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      turnId,
      conversationId,
      projectId: PROJECT_ID,
      snapshotId: input.snapshotId,
      sequence: turnCount + 1,
      previousTurnHeadHash: projection.headHash,
      capabilityProfile: input.mode === 'EXECUTE' ? 'CONTROLLED_PROJECT_ACTIONS' : CAPABILITY_PROFILE,
      schedulerProtocol: SCHEDULER_PROTOCOL,
      userMessage,
      ...(input.assistantContext ? { assistantContext: input.assistantContext } : {}),
      ...(input.mode ? {mode:input.mode}:{}),...(input.execution ? {execution:input.execution}:{}),
      requestHash: semanticHash,
      idempotencyKeyHash: sha256(input.idempotencyKey),
      queuedAt: new Date().toISOString(),
    };
    await atomicWriteJson(turnPath, turn);
    return (await projectCodexConversation(conversationId, input.snapshotId));
  });
}

export async function setCodexConversationArchived(input: {
  conversationId: unknown;
  snapshotId: string;
  action: 'ARCHIVE' | 'RESTORE';
  idempotencyKey: string;
}) {
  return withStoreLock(async () => {
    const paths = storePaths();
    const conversationId = assertInternalId(input.conversationId, 'conversationId');
    const semanticHash = requestHash({
      action: input.action,
      conversationId,
      snapshotId: input.snapshotId,
    });
    const eventId = archiveEventIdFor(input.idempotencyKey);
    const idempotencyKeyHash = sha256(input.idempotencyKey);
    const archiveState = await conversationArchiveState(conversationId);
    const existingEvent = archiveState.events.find((event) => event.eventId === eventId);
    if (existingEvent) {
      if (
        existingEvent.requestHash !== semanticHash
        || existingEvent.idempotencyKeyHash !== idempotencyKeyHash
        || existingEvent.action !== input.action
      ) {
        throw new HttpError(409, 'Idempotency-Key was already used with a different Codex conversation action');
      }
      return (await projectCodexConversation(conversationId, input.snapshotId));
    }

    const projection = await projectCodexConversation(conversationId, input.snapshotId);
    if (input.action === 'ARCHIVE' && projection.activeTurnId) {
      throw new HttpError(409, 'a conversation with an active turn cannot be archived');
    }
    const sequence = (archiveState.events.at(-1)?.sequence || 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > 999_999_999_999) {
      throw new HttpError(409, 'Codex conversation archive history is exhausted');
    }
    const eventPayload: Omit<ConversationArchiveEvent, 'eventHash'> = {
      schemaVersion: STORE_SCHEMA_VERSION,
      eventId,
      conversationId,
      snapshotId: input.snapshotId,
      action: input.action,
      sequence,
      previousEventHash: archiveState.events.at(-1)?.eventHash || initialArchiveEventHash(conversationId),
      requestHash: semanticHash,
      idempotencyKeyHash,
      occurredAt: new Date().toISOString(),
    };
    const event: ConversationArchiveEvent = {
      ...eventPayload,
      eventHash: archiveEventHash(eventPayload),
    };
    const eventDirectory = path.join(paths.archiveEvents, conversationId);
    if (!instanceMode()) await mkdir(eventDirectory, { recursive: true, mode: 0o700 });
    await atomicWriteJson(
      path.join(eventDirectory, `${String(sequence).padStart(12, '0')}_${eventId}.json`),
      event,
    );
    return (await projectCodexConversation(conversationId, input.snapshotId));
  });
}

function encodeConversationCursor(record: Pick<ConversationRecord, 'createdAt' | 'conversationId'>) {
  return Buffer.from(`${record.createdAt}\0${record.conversationId}`, 'utf8').toString('base64url');
}

function decodeConversationCursor(value: string) {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, 'Codex conversation cursor is invalid');
  }
  let decoded = '';
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new HttpError(400, 'Codex conversation cursor is invalid');
  }
  const separator = decoded.indexOf('\0');
  const createdAt = decoded.slice(0, separator);
  const conversationId = decoded.slice(separator + 1);
  if (
    separator < 1
    || Number.isNaN(Date.parse(createdAt))
    || !/^[a-z][a-z0-9_-]{7,79}$/.test(conversationId)
    || encodeConversationCursor({ createdAt, conversationId }) !== value
  ) {
    throw new HttpError(400, 'Codex conversation cursor is invalid');
  }
  return { createdAt, conversationId };
}

async function turnsForConversationPage(conversationIds: Set<string>) {
  const paths = await ensureStore();
  const names = await (await recordNames(paths.turns).catch(() => []));
  const grouped = new Map<string, TurnRequestRecord[]>();
  for (const name of names) {
    if (!/^turn_[a-f0-9]{32}\.json$/.test(name)) continue;
    const turn = await readJson<TurnRequestRecord>(path.join(paths.turns, name));
    if (!validReadableTurn(turn) || !conversationIds.has(turn.conversationId)) continue;
    const turns = grouped.get(turn.conversationId) || [];
    turns.push(turn);
    grouped.set(turn.conversationId, turns);
  }
  for (const turns of grouped.values()) {
    turns.sort((left, right) => left.sequence - right.sequence || left.queuedAt.localeCompare(right.queuedAt));
  }
  return grouped;
}

async function summarizeCodexConversation(
  conversation: ConversationRecord,
  turns: TurnRequestRecord[],
  currentSnapshotId: string,
  archiveState: Awaited<ReturnType<typeof conversationArchiveState>>,
  pendingByTurnId: Map<string, PendingTurnProjection>,
): Promise<CodexConversationSummary> {
  const paths = storePaths();
  let headHash = conversation.initialHeadHash;
  let activeTurnId: string | null = null;
  let activeTurnStatus: CodexConversationProjection['activeTurnStatus'] = null;
  let blockedReason: string | null = null;
  let updatedAt = conversation.createdAt;
  let messageCount = 0;
  for (const turn of turns) {
    messageCount += 1;
    if (turn.queuedAt > updatedAt) updatedAt = turn.queuedAt;
    const rawResult = await readJson<TurnResultRecord>(path.join(paths.results, `${turn.turnId}.json`));
    if (!rawResult) {
      if (!(await turnCanExecuteInCurrentRuntime(turn.turnId))) { blockedReason = 'RUNTIME_EPOCH_CHANGED'; messageCount += 1; continue; }
      const pending = pendingByTurnId.get(turn.turnId);
      activeTurnId = turn.turnId;
      activeTurnStatus = pending?.status || 'QUEUED';
      continue;
    }
    const result = integrityCheckedResult(rawResult);
    const expectedTurnInputHash = result ? turnInputHash(turn, result) : '';
    const expectedResultHash = result ? resultHash(result) : '';
    const expectedTurnHeadHash = result
      ? turnHeadHash(headHash, expectedTurnInputHash, expectedResultHash)
      : '';
    if (
      !result
      || turn.previousTurnHeadHash !== headHash
      || result.turnId !== turn.turnId
      || result.conversationId !== conversation.conversationId
      || result.previousTurnHeadHash !== headHash
      || result.turnInputHash !== expectedTurnInputHash
      || result.resultHash !== expectedResultHash
      || result.turnHeadHash !== expectedTurnHeadHash
      || (turn.assistantContext && result.state === 'SUCCEEDED' && (result.workContext?.packetHash !== turn.assistantContext.packetHash || result.workContext?.packetId !== turn.assistantContext.packetId))
    ) {
      blockedReason = 'INVALID_RESULT_CHAIN';
      messageCount += 1;
      break;
    }
    headHash = result.turnHeadHash;
    if (result.completedAt > updatedAt) updatedAt = result.completedAt;
    messageCount += 1;
    if (result.state === 'SUCCEEDED') {
      if (!result.assistantMessage.trim()) {
        blockedReason = 'INVALID_EMPTY_RESULT';
        break;
      }
    } else {
      blockedReason = result.state;
      break;
    }
  }
  if (!conversation.assistantProtocol && conversation.snapshotId !== currentSnapshotId) blockedReason ||= 'STALE_SNAPSHOT';
  if (archiveState.archived) blockedReason ||= 'ARCHIVED';
  const archiveUpdatedAt = archiveState.events.at(-1)?.occurredAt || '';
  if (archiveUpdatedAt > updatedAt) updatedAt = archiveUpdatedAt;
  const activePending = activeTurnId ? pendingByTurnId.get(activeTurnId) || null : null;
  if (activePending) activeTurnStatus = activePending.status;
  const state: CodexConversationProjection['state'] = blockedReason
    ? 'BLOCKED'
    : activeTurnId
      ? activeTurnStatus === 'RUNNING' ? 'RUNNING' : 'QUEUED'
      : turns.length ? 'READY' : 'EMPTY';
  return {
    id: conversation.conversationId,
    ...(conversation.assistantProtocol ? { assistantProtocol: conversation.assistantProtocol } : {}),
    createdAt: conversation.createdAt,
    updatedAt,
    state,
    activeTurnStatus,
    queuePosition: activePending?.queuePosition || null,
    messageCount,
    preview: turns[0]?.userMessage.slice(0, 100) || '',
    archived: archiveState.archived,
    archivedAt: archiveState.archivedAt,
  };
}

export async function listCodexConversations(
  currentSnapshotId: string,
  options: {
    cursor?: string;
    limit?: number;
    archived?: 'exclude' | 'only' | 'include';
  } = {},
): Promise<CodexConversationPage> {
  const paths = await ensureStore();
  const names = await (await recordNames(paths.conversations).catch(() => []));
  const records: ConversationRecord[] = [];
  for (const name of names) {
    if (!/^codx_[a-f0-9]{32}\.json$/.test(name)) continue;
    const record = await readJson<ConversationRecord>(path.join(paths.conversations, name));
    if (validConversation(record)) records.push(record);
  }
  records.sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
    || right.conversationId.localeCompare(left.conversationId)
  ));
  const archiveMode = options.archived || 'exclude';
  const recordsWithArchive = await Promise.all(records.map(async (record) => ({
    record,
    archiveState: await conversationArchiveState(record.conversationId),
  })));
  const filtered = recordsWithArchive.filter(({ archiveState }) => (
    archiveMode === 'include'
    || (archiveMode === 'only' ? archiveState.archived : !archiveState.archived)
  ));
  let startIndex = 0;
  if (options.cursor) {
    const cursor = decodeConversationCursor(options.cursor);
    const cursorIndex = filtered.findIndex(({ record }) => (
      record.createdAt === cursor.createdAt && record.conversationId === cursor.conversationId
    ));
    if (cursorIndex < 0) throw new HttpError(409, 'Codex conversation cursor is stale; reload the list');
    startIndex = cursorIndex + 1;
  }
  const requestedLimit = options.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE;
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(MAX_CONVERSATION_PAGE_SIZE, Math.max(1, requestedLimit))
    : DEFAULT_CONVERSATION_PAGE_SIZE;
  const page = filtered.slice(startIndex, startIndex + limit);
  const pageIds = new Set(page.map(({ record }) => record.conversationId));
  const [groupedTurns, pending] = await Promise.all([
    (await turnsForConversationPage(pageIds)),
    (await pendingTurnProjections()),
  ]);
  const pendingByTurnId = new Map(pending.map((item) => [item.turn.turnId, item]));
  const items = await Promise.all(page.map(({ record, archiveState }) => summarizeCodexConversation(
    record,
    groupedTurns.get(record.conversationId) || [],
    currentSnapshotId,
    archiveState,
    pendingByTurnId,
  )));
  const hasNextPage = startIndex + page.length < filtered.length;
  return {
    items,
    nextCursor: hasNextPage && page.length ? encodeConversationCursor(page[page.length - 1].record) : null,
    limit,
    archived: archiveMode,
  };
}

export async function cancelCodexTurn(conversationId: string, turnId: string, snapshotId: string) {
  return withStoreLock(async () => {
    assertInternalId(turnId, 'turnId');
    const projection = await projectCodexConversation(conversationId, snapshotId);
    if (!projection.assistantProtocol) throw new HttpError(409, 'legacy conversation is read-only');
    if (projection.activeTurnId !== turnId) throw new HttpError(409, 'this turn is no longer active');
    const turn = await readJson<TurnRequestRecord>(path.join(storePaths().turns, `${turnId}.json`));
    if (!validTurn(turn) || turn.conversationId !== conversationId) throw new HttpError(409, 'turn binding is invalid');
    const directory = path.join(conversationStoreRoot(), 'cancel');
    if (!instanceMode()) await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${turnId}.json`);
    const existing = await readJson<Record<string, unknown>>(target);
    const cancel = { schemaVersion: '1.0', turnId, conversationId, requestHash: turn.requestHash };
    if (existing && canonicalJson(existing) !== canonicalJson(cancel)) throw new HttpError(409, 'cancel request conflicts');
    if (!existing) await atomicWriteJson(target, cancel);
    return { requested: true, turnId };
  });
}

export async function codexQueueProjection(): Promise<CodexQueueProjection> {
  const pending = await pendingTurnProjections();
  const runningTurnCount = pending.filter((item) => item.status === 'RUNNING').length;
  return {
    pendingTurnLimit: PENDING_TURN_LIMIT,
    pendingTurnCount: pending.length,
    queuedTurnCount: pending.length - runningTurnCount,
    runningTurnCount,
    availableQueueSlots: Math.max(0, PENDING_TURN_LIMIT - pending.length),
  };
}

function healthInteger(value: unknown, maximum: number) {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

export async function codexBridgeProjection(): Promise<CodexBridgeProjection> {
  const paths = await ensureStore();
  const health = await readJson<Record<string, unknown>>(paths.health);
  const checkedAt = typeof health?.checkedAt === 'string' && !Number.isNaN(Date.parse(health.checkedAt))
    ? health.checkedAt
    : null;
  const rawStatus = typeof health?.status === 'string' ? health.status : '';
  const isFresh = Boolean(checkedAt && Date.now() - Date.parse(checkedAt) <= BRIDGE_HEALTH_TTL_MS);
  const acceptedStatus = ['READY', 'PROCESSING', 'DEGRADED'].includes(rawStatus) ? rawStatus : 'OFFLINE';
  const configuredConcurrency = healthInteger(health?.configuredConcurrency, HARD_BRIDGE_CONCURRENCY_LIMIT)
    || DEFAULT_BRIDGE_CONCURRENCY;
  const runnableSlotCount = healthInteger(health?.runnableSlotCount, HARD_BRIDGE_CONCURRENCY_LIMIT);
  const online = isFresh && (
    acceptedStatus === 'READY'
    || acceptedStatus === 'PROCESSING'
    || (acceptedStatus === 'DEGRADED' && runnableSlotCount != null && runnableSlotCount > 0)
  );
  return {
    online,
    executionProtocol: isFresh && health?.executionProtocol === 'REVIEW_CONTROLLED_ACTIONS_V1' ? 'REVIEW_CONTROLLED_ACTIONS_V1' : null,
    workContextProtocol: health?.workContextProtocol === 'REVIEW_WORK_CONTEXT_V1' ? 'REVIEW_WORK_CONTEXT_V1' : null,
    workContextCatalogVersions: Array.isArray(health?.workContextCatalogVersions) ? health.workContextCatalogVersions.filter((value): value is string => value === '1.0' || value === '1.1' || value === '1.2') : ['1.0'],
    workContextPreflightVerified: isFresh && health?.workContextPreflightVerified === true,
    status: isFresh ? acceptedStatus as CodexBridgeProjection['status'] : 'OFFLINE',
    checkedAt,
    sdkVersion: typeof health?.sdkVersion === 'string' ? health.sdkVersion.slice(0, 80) : null,
    runtimeVersion: typeof health?.runtimeVersion === 'string' ? health.runtimeVersion.slice(0, 80) : null,
    model: typeof health?.model === 'string' && /^[A-Za-z0-9._-]{2,80}$/.test(health.model) ? health.model : null,
    mode: health?.mode === 'REAL' || health?.mode === 'MOCK' ? health.mode : null,
    schedulerProtocol: health?.schedulerProtocol === SCHEDULER_PROTOCOL
      ? SCHEDULER_PROTOCOL
      : null,
    configuredConcurrency,
    hardConcurrencyLimit: HARD_BRIDGE_CONCURRENCY_LIMIT,
    pendingTurnLimit: PENDING_TURN_LIMIT,
    queuedTurnCount: healthInteger(health?.queuedTurnCount, PENDING_TURN_LIMIT),
    runnableSlotCount,
    activeSlotCount: healthInteger(health?.activeSlotCount, HARD_BRIDGE_CONCURRENCY_LIMIT),
    readySlotCount: healthInteger(health?.readySlotCount, HARD_BRIDGE_CONCURRENCY_LIMIT),
    poisonedSlotCount: healthInteger(health?.poisonedSlotCount, HARD_BRIDGE_CONCURRENCY_LIMIT),
    degradedSlotCount: healthInteger(health?.degradedSlotCount, HARD_BRIDGE_CONCURRENCY_LIMIT),
    activeConversationCount: healthInteger(health?.activeConversationCount, HARD_BRIDGE_CONCURRENCY_LIMIT),
    slotPoisonEventCount: healthInteger(health?.slotPoisonEventCount, Number.MAX_SAFE_INTEGER),
  };
}
