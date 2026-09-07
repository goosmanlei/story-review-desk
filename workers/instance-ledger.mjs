import { createHash } from 'node:crypto';
import { openInstanceRepository, resolveInstance } from '../host/instance-runtime/index.mjs';

const repositories=new Map();
export async function workerRepository(root = process.env.REVIEW_INSTANCE_ROOT) {
  if (!root) throw new Error('REVIEW_INSTANCE_ROOT is required; no project-directory fallback');
  const instance = resolveInstance(root);
  let pending=repositories.get(instance.root);
  if(!pending){pending=Promise.resolve(openInstanceRepository(instance));repositories.set(instance.root,pending);pending.catch(()=>repositories.delete(instance.root));}
  return {root:instance.root,repository:await pending};
}
const keyFor = (requestId) => createHash('sha256').update(requestId).digest('hex') + '.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Persistent cost/idempotency receipts, with unsaved draft text in memory only.
 * Immutable database history must never be presented as erased draft plaintext.
 */
export class InstanceWorkerLedger {
  constructor(namespace, { successRetentionMs, unavailable, validate }) {
    if (!Number.isInteger(successRetentionMs) || successRetentionMs < 1000 || successRetentionMs > 86400000) throw unavailable();
    this.repository = workerRepository().then(value=>value.repository);
    this.namespace = namespace;
    this.successRetentionMs = successRetentionMs;
    this.unavailable = unavailable;
    this.validate = validate;
    this.cache = new Map();
  }
  decode(row, requestId) {
    if (!row || row.deleted) return null;
    if (hash(row.bytes) !== row.sha256) throw this.unavailable();
    return this.validate(JSON.parse(row.bytes.toString('utf8')), requestId);
  }
  async guarded(callback) { try { return await callback(); } catch { throw this.unavailable(); } }
  async checkWritable() { return this.guarded(async () => (await this.repository).writeTransaction(() => true)); }
  async ensureDirectory() { return this.checkWritable(); }
  async syncDirectory() { return this.checkWritable(); }
  async discardOrphanedTemporaryFiles() { /* No draft or temporary JSON files exist. */ }
  async redactExpiredSuccesses() {
    for (const [key, cached] of this.cache) if (cached.expiresAt <= Date.now()) this.cache.delete(key);
  }
  async get(requestId) {
    return this.guarded(async () => {
      const record = this.decode(await (await this.repository).getAux(this.namespace, keyFor(requestId)), requestId);
      const cached = this.cache.get(requestId);
      if (cached && cached.expiresAt > Date.now() && record?.state === 'SUCCEEDED_TOMBSTONE'
        && cached.requestHash === record.requestHash && hash(JSON.stringify(cached.result)) === record.tombstone.resultSha256) {
        return { ...record, state: 'SUCCEEDED', result: cached.result, resultExpiresAt: new Date(cached.expiresAt).toISOString() };
      }
      this.cache.delete(requestId);
      return record;
    });
  }
  async claim(requestId, requestHash) {
    return this.guarded(async () => {
      if (typeof requestId !== 'string' || !requestId || !/^[a-f0-9]{64}$/.test(requestHash)) throw this.unavailable();
      const result = await (await this.repository).writeTransaction(async (tx) => {
        const current = await tx.getAux(this.namespace, keyFor(requestId));
        if (current && !current.deleted) return { claimed: false, record: this.decode(current, requestId) };
        const now = new Date().toISOString();
        const record = { schemaVersion: '1.0', requestId, requestHash, state: 'STARTED', createdAt: now, updatedAt: now };
        await tx.putAux({ namespace: this.namespace, key: keyFor(requestId), expectedRevisionId: current?.revisionId ?? null, bytes: JSON.stringify(record) + '\n', mediaType: 'application/json' });
        return { claimed: true, record };
      });
      return result.claimed ? result : { claimed: false, record: await this.get(requestId) };
    });
  }
  async settle(requestId, requestHash, state, value) {
    return this.guarded(async () => {
      if (!['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(state)) throw this.unavailable();
      const record = await (await this.repository).writeTransaction(async (tx) => {
        const current = await tx.getAux(this.namespace, keyFor(requestId));
        const previous = this.decode(current, requestId);
        if (!previous || previous.requestHash !== requestHash || previous.state !== 'STARTED') throw this.unavailable();
        const next = { schemaVersion: '1.0', requestId, requestHash, state: state === 'SUCCEEDED' ? 'SUCCEEDED_TOMBSTONE' : state,
          createdAt: previous.createdAt, updatedAt: new Date().toISOString(),
          ...(state === 'SUCCEEDED' ? { tombstone: { resultSha256: hash(JSON.stringify(value)), model: String(value?.model || ''), providerRequestId: String(value?.providerRequestId || '') } } : { error: value }) };
        this.validate(next, requestId);
        await tx.putAux({ namespace: this.namespace, key: keyFor(requestId), expectedRevisionId: current.revisionId, bytes: JSON.stringify(next) + '\n', mediaType: 'application/json' });
        return next;
      });
      if (state === 'SUCCEEDED') this.cache.set(requestId, { requestHash, result: value, expiresAt: Date.now() + this.successRetentionMs });
      return state === 'SUCCEEDED' ? this.get(requestId) : record;
    });
  }
}
