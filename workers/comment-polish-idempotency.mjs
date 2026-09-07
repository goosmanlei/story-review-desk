import { InstanceWorkerLedger } from './instance-ledger.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CommentPolishProviderError } from './comment-polish-core.mjs';

const settledStates = new Set(['SUCCEEDED', 'FAILED', 'UNKNOWN']);
const allStates = new Set(['STARTED', 'SUCCEEDED_TOMBSTONE', ...settledStates]);

function ledgerUnavailable() {
  return new CommentPolishProviderError(
    503,
    'IDEMPOTENCY_LEDGER_UNAVAILABLE',
    'The AI polishing idempotency ledger is unavailable; no provider call was made',
  );
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validText(value, max, required = true) {
  return typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()));
}

function validateStoredResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return validText(value.polishedComment, 4_000)
    && validText(value.model, 128)
    && validText(value.providerRequestId, 256, false)
    && Number.isFinite(value.elapsedMs)
    && Number.isFinite(value.inputCharacterCount)
    && Number.isFinite(value.outputCharacterCount);
}

function validateStoredError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Number.isInteger(value.status) && value.status >= 400 && value.status <= 599
    && validText(value.code, 128)
    && validText(value.message, 500)
    && ['FAILED', 'UNKNOWN'].includes(value.resultState)
    && validText(value.providerRequestId, 256, false);
}

function validateSuccessTombstone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return validHash(value.resultSha256)
    && validText(value.model, 128)
    && validText(value.providerRequestId, 256, false);
}

function validateRecord(value, expectedRequestId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== '1.0'
    || value.requestId !== expectedRequestId
    || !validHash(value.requestHash)
    || !allStates.has(value.state)
    || !validText(value.createdAt, 64)
    || !validText(value.updatedAt, 64)) {
    throw ledgerUnavailable();
  }
  if (value.state === 'SUCCEEDED' && (
    !validateStoredResult(value.result)
    || !validText(value.resultExpiresAt, 64)
    || !Number.isFinite(Date.parse(value.resultExpiresAt))
  )) throw ledgerUnavailable();
  if (value.state === 'SUCCEEDED_TOMBSTONE' && !validateSuccessTombstone(value.tombstone)) throw ledgerUnavailable();
  if (['FAILED', 'UNKNOWN'].includes(value.state) && !validateStoredError(value.error)) throw ledgerUnavailable();
  return value;
}

function filenameForRequest(requestId) {
  return `${createHash('sha256').update(requestId).digest('hex')}.json`;
}

export class CommentPolishIdempotencyLedger {
  constructor(directory, { successRetentionMs = 10 * 60_000 } = {}) {
    if (process.env.REVIEW_INSTANCE_ROOT) return new InstanceWorkerLedger('worker-comment-polish', { successRetentionMs, unavailable: ledgerUnavailable, validate: validateRecord });
    // Explicit filesystem fixtures only; production server requires an instance.
    if (!validText(directory, 4_096)) throw ledgerUnavailable();
    if (!Number.isInteger(successRetentionMs) || successRetentionMs < 1_000 || successRetentionMs > 24 * 60 * 60_000) {
      throw ledgerUnavailable();
    }
    this.directory = path.resolve(directory);
    this.successRetentionMs = successRetentionMs;
  }

  recordPath(requestId) {
    return path.join(this.directory, filenameForRequest(requestId));
  }

  async ensureDirectory() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
    } catch {
      throw ledgerUnavailable();
    }
  }

  async syncDirectory() {
    const directoryHandle = await open(this.directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  async checkWritable() {
    await this.ensureDirectory();
    const probe = path.join(this.directory, `.health-${process.pid}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(probe, 'wx', 0o600);
      await handle.writeFile('ok\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await unlink(probe);
      await this.syncDirectory();
      await this.redactExpiredSuccesses();
      return true;
    } catch {
      throw ledgerUnavailable();
    } finally {
      await handle?.close().catch(() => {});
      await unlink(probe).catch(() => {});
    }
  }

  async replaceRecord(record) {
    validateRecord(record, record.requestId);
    const target = this.recordPath(record.requestId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await this.syncDirectory();
      return record;
    } catch {
      throw ledgerUnavailable();
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  async redactExpiredSuccess(record) {
    if (record.state !== 'SUCCEEDED' || Date.parse(record.resultExpiresAt) > Date.now()) return record;
    return this.replaceRecord({
      schemaVersion: '1.0',
      requestId: record.requestId,
      requestHash: record.requestHash,
      state: 'SUCCEEDED_TOMBSTONE',
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
      tombstone: {
        resultSha256: createHash('sha256').update(JSON.stringify(record.result)).digest('hex'),
        model: record.result.model,
        providerRequestId: record.result.providerRequestId,
      },
    });
  }

  async redactExpiredSuccesses() {
    await this.ensureDirectory();
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch {
      throw ledgerUnavailable();
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      try {
        const raw = await readFile(path.join(this.directory, entry.name), 'utf8');
        const parsed = JSON.parse(raw);
        if (!validText(parsed?.requestId, 160)
          || filenameForRequest(parsed.requestId) !== entry.name) throw ledgerUnavailable();
        const record = validateRecord(parsed, parsed.requestId);
        await this.redactExpiredSuccess(record);
      } catch (reason) {
        if (reason instanceof CommentPolishProviderError) throw reason;
        throw ledgerUnavailable();
      }
    }
  }

  async get(requestId) {
    const recordPath = this.recordPath(requestId);
    try {
      const raw = await readFile(recordPath, 'utf8');
      const record = validateRecord(JSON.parse(raw), requestId);
      return this.redactExpiredSuccess(record);
    } catch (reason) {
      if (reason?.code === 'ENOENT') return null;
      if (reason instanceof CommentPolishProviderError) throw reason;
      throw ledgerUnavailable();
    }
  }

  async claim(requestId, requestHash) {
    await this.ensureDirectory();
    const existing = await this.get(requestId);
    if (existing) return { claimed: false, record: existing };
    const now = new Date().toISOString();
    const record = {
      schemaVersion: '1.0',
      requestId,
      requestHash,
      state: 'STARTED',
      createdAt: now,
      updatedAt: now,
    };
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
      if (reason?.code === 'EEXIST') {
        const raced = await this.get(requestId);
        if (raced) return { claimed: false, record: raced };
      }
      throw ledgerUnavailable();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async settle(requestId, requestHash, state, value) {
    if (!settledStates.has(state)) throw ledgerUnavailable();
    const existing = await this.get(requestId);
    if (!existing || existing.requestHash !== requestHash) throw ledgerUnavailable();
    const record = {
      schemaVersion: '1.0',
      requestId,
      requestHash,
      state,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      ...(state === 'SUCCEEDED'
        ? {
            result: value,
            resultExpiresAt: new Date(Date.now() + this.successRetentionMs).toISOString(),
          }
        : { error: value }),
    };
    return this.replaceRecord(record);
  }
}

export function replayCommentPolishRecord(record) {
  if (record.state === 'SUCCEEDED') return { ...record.result, replayed: true };
  if (record.state === 'SUCCEEDED_TOMBSTONE') {
    throw new CommentPolishProviderError(
      409,
      'IDEMPOTENCY_ALREADY_COMPLETED',
      'The prior OpenAI request completed, but its unsaved suggestion retention window has ended; no repeated provider call was made',
    );
  }
  if (record.state === 'FAILED' || record.state === 'UNKNOWN') {
    const error = record.error;
    throw new CommentPolishProviderError(
      error.status,
      error.code,
      error.message,
      error.resultState,
      error.providerRequestId,
    );
  }
  throw new CommentPolishProviderError(
    504,
    'RESULT_UNKNOWN',
    'A prior OpenAI request with this requestId may still have completed; no repeated provider call was made',
    'UNKNOWN',
  );
}
