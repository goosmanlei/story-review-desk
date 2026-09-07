// Only immutable JSON responses from completed, top-level read transactions are
// shared. Writers and already pinned readers always execute their own query.
const repositories = new WeakMap();
const MAX_ENTRIES = 16;

export async function committedQueryJson(repository, queryKey, read) {
  if (repository.inTransaction) {
    return repository.readTransaction(async tx => JSON.stringify(await read(tx)));
  }
  let cache = repositories.get(repository);
  if (!cache) { cache = new Map(); repositories.set(repository, cache); }
  let owned;
  try {
    const json = await repository.readTransaction(async tx => {
      // The descriptor and factory share one repeatable-read snapshot. A commit
      // between requests can never put a new response under an older key.
      const m = await tx.getMetadata();
      const key = JSON.stringify([queryKey, m.instanceId, m.runtimeEpoch,
        m.releaseId, m.profileRevisionId, m.snapshotId,
        m.repositoryRevision, m.eventSequence]);
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
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      const value = JSON.stringify(await read(tx));
      if (typeof value !== 'string') throw new TypeError('Committed query must return JSON content');
      return value;
    });
    // Resolve followers only after the repository has completed COMMIT and its
    // final identity checks. No uncommitted or failed response enters the cache.
    owned?.entry.resolve(json);
    return json;
  } catch (error) {
    if (owned) {
      if (cache.get(owned.key) === owned.entry) cache.delete(owned.key);
      owned.entry.reject(error);
    }
    throw error;
  }
}
