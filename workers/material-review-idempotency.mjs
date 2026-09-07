import { InstanceWorkerLedger } from './instance-ledger.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MaterialReviewProviderError } from './material-review-core.mjs';

function unavailable() {
  return new MaterialReviewProviderError(503, 'IDEMPOTENCY_LEDGER_UNAVAILABLE', 'The material review idempotency ledger is unavailable; no provider call was made');
}

function filename(requestId) {
  return `${createHash('sha256').update(requestId).digest('hex')}.json`;
}

const temporaryRecordPattern = /^\.[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/;

export class MaterialReviewIdempotencyLedger {
  constructor(directory, { successRetentionMs = 10 * 60_000 } = {}) {
    if (process.env.REVIEW_INSTANCE_ROOT) return new InstanceWorkerLedger('worker-material-review', { successRetentionMs, unavailable: unavailable, validate: (record, requestId) => {
      if (!record || record.schemaVersion !== '1.0' || record.requestId !== requestId || !/^[a-f0-9]{64}$/.test(record.requestHash || '') || !['STARTED', 'SUCCEEDED', 'SUCCEEDED_TOMBSTONE', 'FAILED', 'UNKNOWN'].includes(record.state)) throw unavailable();
      return record;
    } });
    // Explicit filesystem fixtures only; production server requires an instance.
    if (typeof directory !== 'string' || !directory || directory.length > 4_096) throw unavailable();
    if (!Number.isInteger(successRetentionMs) || successRetentionMs < 1_000 || successRetentionMs > 24 * 60 * 60_000) throw unavailable();
    this.directory = directory;
    this.successRetentionMs = successRetentionMs;
  }

  async ensureDirectory() {
    try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); } catch { throw unavailable(); }
  }

  recordPath(requestId) { return path.join(this.directory, filename(requestId)); }

  async syncDirectory() {
    let handle;
    try { handle = await open(this.directory, 'r'); await handle.sync(); } catch { throw unavailable(); } finally { await handle?.close().catch(() => {}); }
  }

  async get(requestId) {
    await this.ensureDirectory();
    try {
      const parsed = JSON.parse(await readFile(this.recordPath(requestId), 'utf8'));
      if (!parsed || parsed.schemaVersion !== '1.0' || parsed.requestId !== requestId || !/^[a-f0-9]{64}$/.test(parsed.requestHash || '') || !['STARTED', 'SUCCEEDED', 'SUCCEEDED_TOMBSTONE', 'FAILED', 'UNKNOWN'].includes(parsed.state)) throw unavailable();
      if (parsed.state === 'SUCCEEDED' && this.successRecordExpired(parsed)) return this.redact(parsed);
      return parsed;
    } catch (reason) {
      if (reason?.code === 'ENOENT') return null;
      if (reason instanceof MaterialReviewProviderError) throw reason;
      throw unavailable();
    }
  }

  async replace(record) {
    await this.ensureDirectory();
    const temporary = path.join(this.directory, `.${filename(record.requestId)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.recordPath(record.requestId));
      await this.syncDirectory();
      return record;
    } catch {
      throw unavailable();
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  async redact(record) {
    if (record.state !== 'SUCCEEDED') return record;
    return this.replace({
      schemaVersion: '1.0', requestId: record.requestId, requestHash: record.requestHash,
      state: 'SUCCEEDED_TOMBSTONE', createdAt: record.createdAt, updatedAt: new Date().toISOString(),
      tombstone: { resultSha256: createHash('sha256').update(JSON.stringify(record.result ?? null)).digest('hex'), model: String(record.result?.model || ''), providerRequestId: String(record.result?.providerRequestId || '') },
    });
  }

  successRecordExpired(record, now = Date.now()) {
    const expiresAt = Date.parse(record.resultExpiresAt || '');
    const updatedAt = Date.parse(record.updatedAt || '');
    return !Number.isFinite(expiresAt)
      || !Number.isFinite(updatedAt)
      || expiresAt > updatedAt + this.successRetentionMs
      || expiresAt <= now;
  }

  async discardOrphanedTemporaryFiles() {
    await this.ensureDirectory();
    let names;
    try { names = await readdir(this.directory); } catch { throw unavailable(); }
    try {
      await Promise.all(names.filter((item) => temporaryRecordPattern.test(item)).map((item) => unlink(path.join(this.directory, item))));
    } catch {
      throw unavailable();
    }
  }

  async redactExpiredSuccesses() {
    await this.ensureDirectory();
    let names;
    try { names = await readdir(this.directory); } catch { throw unavailable(); }
    for (const name of names.filter((item) => /^[a-f0-9]{64}\.json$/.test(item))) {
      let record;
      try { record = JSON.parse(await readFile(path.join(this.directory, name), 'utf8')); } catch { throw unavailable(); }
      if (record?.state === 'SUCCEEDED' && this.successRecordExpired(record)) await this.redact(record);
    }
  }

  async checkWritable() {
    await this.ensureDirectory();
    const probe = path.join(this.directory, `.probe-${randomUUID()}`);
    let handle;
    try { handle = await open(probe, 'wx', 0o600); await handle.writeFile('ok'); await handle.sync(); return true; } catch { throw unavailable(); } finally { await handle?.close().catch(() => {}); await unlink(probe).catch(() => {}); }
  }

  async claim(requestId, requestHash) {
    await this.ensureDirectory();
    const existing = await this.get(requestId);
    if (existing) return { claimed: false, record: existing };
    const now = new Date().toISOString();
    const record = { schemaVersion: '1.0', requestId, requestHash, state: 'STARTED', createdAt: now, updatedAt: now };
    let handle;
    try {
      handle = await open(this.recordPath(requestId), 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.syncDirectory();
      return { claimed: true, record };
    } catch (reason) {
      if (reason?.code === 'EEXIST') return { claimed: false, record: await this.get(requestId) };
      throw unavailable();
    } finally { await handle?.close().catch(() => {}); }
  }

  async settle(requestId, requestHash, state, value) {
    if (!['SUCCEEDED', 'FAILED', 'UNKNOWN'].includes(state)) throw unavailable();
    const current = await this.get(requestId);
    if (!current || current.requestHash !== requestHash || current.state !== 'STARTED') throw unavailable();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    return this.replace({ schemaVersion: '1.0', requestId, requestHash, state, createdAt: current.createdAt, updatedAt: now, ...(state === 'SUCCEEDED' ? { result: value, resultExpiresAt: new Date(nowMs + this.successRetentionMs).toISOString() } : { error: value }) });
  }
}

export function replayMaterialReviewRecord(record) {
  if (record.state === 'SUCCEEDED') return { ...record.result, replayed: true };
  if (record.state === 'SUCCEEDED_TOMBSTONE') throw new MaterialReviewProviderError(409, 'IDEMPOTENCY_ALREADY_COMPLETED', 'The prior AI review completed, but its unsaved draft retention window ended; no repeated provider call was made');
  if (['FAILED', 'UNKNOWN'].includes(record.state)) throw new MaterialReviewProviderError(record.error.status, record.error.code, record.error.message, record.error.resultState, record.error.providerRequestId || '');
  throw new MaterialReviewProviderError(504, 'RESULT_UNKNOWN', 'A prior AI review may still have completed; no repeated provider call was made', 'UNKNOWN');
}
