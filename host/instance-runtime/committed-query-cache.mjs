// Only immutable JSON responses from completed, top-level read transactions are
// shared. Writers and already pinned readers always execute their own query.
import {readBasis} from './read-basis.mjs';
const repositories = new WeakMap();
const projectionRepositories = new WeakMap();
const readUnits = new WeakMap();
const MAX_ENTRIES = 16;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_PROJECTIONS = 2;
const MAX_PROJECTION_BYTES = 8 * 1024 * 1024;

function trim(cache, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES) {
  let bytes = [...cache.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  for (const [key, entry] of cache) {
    if (cache.size <= maxEntries && bytes <= maxBytes) break;
    cache.delete(key); bytes -= entry.bytes || 0;
  }
}

/** Share a common projection across GETs only after its owning read commits.
 * Every caller parses its own mutable tree. Writers/other pinned readers stay private.
 */
export async function committedProjectionJson(tx, projectionKey, read) {
  const context = readUnits.get(tx);
  if (!context) return JSON.stringify(await read(tx));
  const key = JSON.stringify(['projection', projectionKey, context.basis]);
  if (context.local.has(key)) return context.local.get(key);
  const hit = context.cache.get(key);
  if (hit) { context.cache.delete(key); context.cache.set(key, hit); return hit.promise; }
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  const entry = {promise, resolve, reject};
  context.cache.set(key, entry);
  const pending = Promise.resolve().then(() => read(tx)).then(value => {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new TypeError('Committed projection must return JSON content');
    return json;
  });
  context.local.set(key, pending);
  context.owned.push({key, entry, pending});
  trim(context.cache, MAX_PROJECTIONS, MAX_PROJECTION_BYTES);
  return pending;
}

export async function committedQueryJson(repository, queryKey, read, observe = () => {}, describe = () => {}, metadataFor = tx => tx.getMetadata()) {
  if (repository.inTransaction) {
    return repository.readTransaction(async tx => { describe(await metadataFor(tx)); return JSON.stringify(await read(tx)); });
  }
  let cache = repositories.get(repository);
  if (!cache) { cache = new Map(); repositories.set(repository, cache); }
  // A run of cached scene/page responses must not evict their expensive common
  // directory before the next unseen scene. Both stores have independent caps.
  let projectionCache = projectionRepositories.get(repository);
  if (!projectionCache) { projectionCache = new Map(); projectionRepositories.set(repository, projectionCache); }
  let owned;
  let projections;
  try {
    const queued = performance.now();
    const json = await repository.readTransaction(async tx => {
      observe('db_wait', performance.now() - queued);
      // The descriptor and factory share one repeatable-read snapshot. A commit
      // between requests can never put a new response under an older key.
      const descriptorStart = performance.now();
      const m = await metadataFor(tx);
      describe(m);
      observe('version', performance.now() - descriptorStart);
      const basis=readBasis(m),key=JSON.stringify([queryKey,basis]);
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return hit.promise; }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // The owner propagates failures directly; the shared promise may have no
      // followers when its read transaction fails to commit.
      promise.catch(() => {});
      const entry = {promise, resolve, reject};
      owned = {key, entry};
      cache.set(key, entry);
      trim(cache);
      projections = {cache: projectionCache, basis, local: new Map(), owned: []};
      readUnits.set(tx, projections);
      const projectionStart = performance.now();
      let result;
      try { result = await read(tx); }
      finally { readUnits.delete(tx); }
      observe('projection', performance.now() - projectionStart);
      const serializeStart = performance.now();
      const value = JSON.stringify(result);
      observe('serialize', performance.now() - serializeStart);
      if (typeof value !== 'string') throw new TypeError('Committed query must return JSON content');
      return value;
    });
    // Resolve followers only after the repository has completed COMMIT and its
    // final identity checks. No uncommitted or failed response enters the cache.
    if (owned) {
      owned.entry.bytes = Buffer.byteLength(json);
      for (const projection of projections?.owned || []) {
        const value = await projection.pending;
        projection.entry.bytes = Buffer.byteLength(value);
        projection.entry.resolve(value);
      }
      trim(projectionCache, MAX_PROJECTIONS, MAX_PROJECTION_BYTES);
      trim(cache);
      owned.entry.resolve(json);
    }
    return json;
  } catch (error) {
    for (const projection of projections?.owned || []) {
      if (projectionCache.get(projection.key) === projection.entry) projectionCache.delete(projection.key);
      projection.entry.reject(error);
    }
    if (owned) {
      if (cache.get(owned.key) === owned.entry) cache.delete(owned.key);
      owned.entry.reject(error);
    }
    throw error;
  }
}
