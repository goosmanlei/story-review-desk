import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { activeMediaForExport, mediaRetirementOverlay, manifestHash, targetSetHash, RETIREMENT_NAMESPACES } from './instance-runtime/media-retirement.mjs';
import { objectHash, requireSource } from './instance-source-proof.mjs';

const scopes = new AsyncLocalStorage();
const liveScopes = new WeakSet();

/** The scope spans capture, materialization, ALL compiler passes and final CAS.
 * Reuse our enclosing scope or an already-held repository transaction: never
 * request a nested PostgreSQL session lease from inside its transaction.
 */
export async function withSourceMediaReadScope(repository, callback) {
  const parent = scopes.getStore();
  if (parent?.repository === repository) {
    await assertSourceMediaReadScope(parent.scope);
    return callback(parent.scope);
  }
  const run = async assertHeld => {
    const scope = Object.freeze({ assertHeld });
    liveScopes.add(scope);
    try {
      return await scopes.run({ repository, scope }, async () => {
        await assertSourceMediaReadScope(scope);
        const result = await callback(scope);
        await assertSourceMediaReadScope(scope);
        return result;
      });
    } finally { liveScopes.delete(scope); }
  };
  if (repository.inTransaction) return run(async () => {
    requireSource(repository.inTransaction, 'SOURCE_MEDIA_SCOPE_LOST', 'Outer media-locking transaction ended during compilation');
  });
  if (typeof repository.withMediaReadLease === 'function') return repository.withMediaReadLease(lease => {
    requireSource(lease?.instanceId === repository.instanceId && lease.exclusive === false && typeof lease.assertHeld === 'function',
      'SOURCE_MEDIA_LEASE', 'An exact shared instance media lease is required');
    return run(lease.assertHeld);
  });
  // Retirement is PostgreSQL-only; legacy isolated SQLite remains compatible.
  requireSource(repository.backend === 'sqlite', 'SOURCE_MEDIA_LEASE_REQUIRED', 'PostgreSQL source compilation requires an installed shared media lease');
  return run(async () => {});
}

export async function assertSourceMediaReadScope(scope) {
  requireSource(scope && liveScopes.has(scope), 'SOURCE_MEDIA_SCOPE_REQUIRED', 'Media materialization must execute within its live capture/compile read scope');
  await scope.assertHeld();
}

/** Same transaction as source capture/CAS. Immutable registrations remain intact. */
export async function captureSourceMedia(tx) {
  const gate = await tx.getAux('media-maintenance-gates', 'current');
  requireSource(!gate || JSON.parse(gate.bytes).phase === 'CLOSED', 'SOURCE_MEDIA_PENDING', 'Media maintenance requires explicit completion or recovery');
  const latest = new Map();
  for (const row of await tx.listAux(RETIREMENT_NAMESPACES.journal)) {
    const event = JSON.parse(row.bytes), prior = latest.get(event.planId);
    if (!prior || event.sequence > prior.sequence) latest.set(event.planId, event);
  }
  requireSource([...latest.values()].every(e => ['QUARANTINED', 'PURGED'].includes(e.phase)),
    'SOURCE_MEDIA_PENDING', 'Retirement result is unresolved; do not compile or infer successful cleanup');
  const media = await tx.listMedia();
  const activeMedia = await activeMediaForExport(tx, media);
  const retiredMedia = [];
  const activeIdentities = new Set(activeMedia.map(m => objectHash([m.mediaId, m.versionId])));
  const instanceId = (await tx.readView()).instanceId;
  for (const registration of media) {
    if (activeIdentities.has(objectHash([registration.mediaId, registration.versionId]))) continue;
    const overlay = await mediaRetirementOverlay(tx, registration), t = overlay.tombstone;
    const bound = t?.registrations.find(r => r.mediaId === registration.mediaId && r.versionId === registration.versionId && r.sha256 === registration.sha256);
    const last = latest.get(t?.planId), record = t && await tx.getAux(RETIREMENT_NAMESPACES.plans, t.planId);
    const plan = record && !record.deleted ? JSON.parse(record.bytes) : null;
    const target = plan?.manifest.targets.find(row => row.instanceRelativePath === registration.relativePath);
    requireSource(['PURGED', 'QUARANTINED'].includes(overlay.state) && t?.phase === overlay.state
      && last?.phase === t.phase && last?.sequence === t.sequence && bound
      && objectHash([...(bound.aliases || [])].sort()) === objectHash([...registration.aliases].sort())
      && t.originalRelativePath === registration.relativePath && t.sha256 === registration.sha256 && t.byteSize === registration.byteSize
      && plan?.instanceId === instanceId && plan.manifest?.instanceId === instanceId && plan.planId === t.planId && plan.manifestHash === manifestHash(plan.manifest) && plan.targetSetHash === targetSetHash(plan.manifest)
      && plan.manifestHash === t.manifestHash && plan.targetSetHash === t.targetSetHash
      && target?.sha256 === registration.sha256 && target.byteSize === registration.byteSize
      && target.registrations.some(r => r.mediaId === registration.mediaId && r.versionId === registration.versionId && r.sha256 === registration.sha256),
      'SOURCE_RETIRED_MEDIA_BINDING', 'Historical media preservation requires its exact completed plan, journal, path/version/SHA and alias closure');
    const selected = { mediaId: registration.mediaId, versionId: registration.versionId, relativePath: registration.relativePath,
      sha256: registration.sha256, byteSize: registration.byteSize, aliases: [...registration.aliases].sort() };
    const retirement = { mediaId: registration.mediaId, versionId: registration.versionId, phase: t.phase, planId: t.planId,
      operationId: t.operationId, sequence: t.sequence, originalRelativePath: t.originalRelativePath, quarantineRelativePath: t.quarantineRelativePath,
      sha256: t.sha256, byteSize: t.byteSize, manifestHash: t.manifestHash, targetSetHash: t.targetSetHash };
    const proof = { registration: selected, retirement };
    retiredMedia.push({ ...proof, bindingHash: objectHash(proof) });
  }
  const retiredContactMedia = retiredMedia.filter(row => row.registration.aliases.some(alias => alias.startsWith('review-site/public/media/storyboard-contact-sheets/')));
  return { media, activeMedia, retiredMedia, retiredContactMedia, retiredMediaFingerprint: objectHash(retiredMedia), mediaFingerprint: objectHash(media),
    activeMediaFingerprint: objectHash(activeMedia), retiredContactMediaFingerprint: objectHash(retiredContactMedia) };
}

/** Only the active projection may cause original-file IO. readBytes still verifies
 * the exact SHA, and put retains the existing compiler path/collision rules.
 */
export async function materializeSourceMedia({ activeMedia, mediaReadScope, readBytes, put }) {
  await assertSourceMediaReadScope(mediaReadScope);
  requireSource(Array.isArray(activeMedia), 'SOURCE_ACTIVE_MEDIA_REQUIRED', 'Use the transaction-frozen active media projection; never fall back to all registrations');
  const hashes = {};
  for (const row of activeMedia) {
    if (row.availability !== 'PRESENT' || !row.relativePath || row.metadata?.authorityDomain === 'LOCAL_TRIAL') continue;
    const aliases = [...new Set([row.metadata?.sourcePath, row.metadata?.legacyVersion?.path,
      ...(row.aliases || []).filter(alias => alias.includes('/') && !alias.includes(':') && !path.posix.isAbsolute(alias))].filter(Boolean))];
    if (!aliases.length) continue;
    await assertSourceMediaReadScope(mediaReadScope);
    const bytes = await readBytes(row);
    await assertSourceMediaReadScope(mediaReadScope);
    for (const alias of aliases) { await put(alias, bytes); hashes[alias] = row.sha256; }
  }
  await assertSourceMediaReadScope(mediaReadScope);
  return hashes;
}
