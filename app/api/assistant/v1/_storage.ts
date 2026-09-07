import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { conversationStoreRoot, assistantRecordKey } from '../../v8/_codex-conversation-store';
import { HttpError, instanceMode, instanceRepository, reviewData } from '../../v8/_store';
import { canonicalJson, type AssistantContextRef, type ContextPacket, type ResourceCatalog } from '../../../assistant/types';

const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
import { instanceProfile } from '../../../instance-profile';

async function readRecord<T>(file: string, limit = MAX_CATALOG_BYTES): Promise<T> {
  if (instanceMode()) {
    const record = (await (await instanceRepository())!.getAux('assistant-public', assistantRecordKey(file)));
    if (!record || record.bytes.byteLength > limit) throw new HttpError(409, 'assistant evidence is missing or exceeds its size limit');
    return JSON.parse(Buffer.from(record.bytes).toString('utf8')) as T;
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new HttpError(409, 'assistant evidence file is invalid');
  const value = await readFile(file, 'utf8');
  if (Buffer.byteLength(value) > limit) throw new HttpError(409, 'assistant evidence exceeds its size limit');
  return JSON.parse(value) as T;
}

async function immutableWrite(directory: string, filename: string, value: unknown) {
  if (instanceMode()) {
    const bytes = Buffer.from(canonicalJson(value));
    if (bytes.byteLength > MAX_CATALOG_BYTES) throw new HttpError(413, 'assistant context exceeds the storage budget');
    const key = assistantRecordKey(path.join(directory, filename));
    await (await instanceRepository())!.writeTransaction(async (tx) => {
      const previous = (await tx.getAux('assistant-public', key));
      if (previous) {
        if (!Buffer.from(previous.bytes).equals(bytes)) throw new HttpError(409, 'immutable assistant evidence conflicts');
        return;
      }
      (await tx.putAux({namespace: 'assistant-public', key, bytes, expectedRevisionId: null, mediaType: 'application/json'}));
    });
    return;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new HttpError(409, 'assistant storage directory is invalid');
  const target = path.join(directory, filename);
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > MAX_CATALOG_BYTES) throw new HttpError(413, 'assistant context exceeds the storage budget');
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (digest(await readRecord(target)) !== digest(value)) throw new HttpError(409, 'immutable assistant evidence conflicts');
    }
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function persistAssistantContext(packet: ContextPacket, catalog: ResourceCatalog) {
  const profile = instanceProfile(await reviewData());
  if (packet.packetHash !== digest(packet.body) || packet.packetId !== `ctx_${packet.packetHash}` || packet.body.catalogHash !== digest(catalog)) throw new HttpError(409, 'assistant context hash is invalid');
  if (packet.body.projectId !== profile.projectId || catalog.projectId !== profile.projectId || packet.body.scopeKey !== profile.assistant.scopeKey || catalog.scopeKey !== packet.body.scopeKey) throw new HttpError(403, 'assistant project scope is not allowed');
  const root = conversationStoreRoot();
  await immutableWrite(path.join(root, 'catalogs'), `${packet.body.catalogHash}.json`, catalog);
  await immutableWrite(path.join(root, 'contexts'), `${packet.packetId}.json`, packet);
}

export async function readAssistantContext(ref: AssistantContextRef) {
  const profile = instanceProfile(await reviewData());
  if (!/^[a-f0-9]{64}$/.test(ref.packetHash) || ref.packetId !== `ctx_${ref.packetHash}`) throw new HttpError(400, 'context reference is invalid');
  const packet = await readRecord<ContextPacket>(path.join(conversationStoreRoot(), 'contexts', `${ref.packetId}.json`), 512 * 1024);
  if (packet.packetId !== ref.packetId || packet.packetHash !== ref.packetHash || digest(packet.body) !== ref.packetHash || packet.body.projectId !== profile.projectId || packet.body.scopeKey !== profile.assistant.scopeKey || !/^[a-f0-9]{64}$/.test(packet.body.catalogHash)) throw new HttpError(403, 'context binding is invalid');
  const catalog = await readRecord<ResourceCatalog>(path.join(conversationStoreRoot(), 'catalogs', `${packet.body.catalogHash}.json`));
  if (digest(catalog) !== packet.body.catalogHash || catalog.projectId !== packet.body.projectId || catalog.scopeKey !== packet.body.scopeKey || catalog.snapshotId !== packet.body.snapshotId) throw new HttpError(409, 'context resources are invalid');
  return { packet, catalog };
}

export async function assistantProgress(turnId: string, conversationId: string) {
  if (!/^turn_[a-f0-9]{32}$/.test(turnId)) return null;
  try {
    const value = await readRecord<Record<string, unknown>>(path.join(conversationStoreRoot(), 'progress', `${turnId}.json`), 128 * 1024);
    if (value.turnId !== turnId || value.conversationId !== conversationId || !['READING_CONTEXT', 'SEARCHING', 'READING', 'VIEWING_IMAGE', 'RESPONDING'].includes(String(value.phase))) return null;
    return { turnId, phase: value.phase, message: String(value.message || '').slice(0, 300), partialText: String(value.partialText || '').slice(0, 30000), sequence: value.sequence };
  } catch { return null; }
}
