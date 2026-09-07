// Pure archive adapter: no filesystem, database connection, process launch or writes.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalSha256 } from './archive-integrity.mjs';
import { RETIREMENT_NAMESPACES as NS, retirementAwareMediaManifest, manifestHash, targetSetHash } from './media-retirement.mjs';

const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, sort(value[k])]));
  return value;
}
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { code: 'RETIREMENT_ARCHIVE_INVALID' }); };
const pending = () => { throw Object.assign(new Error('Retirement result is pending; reconcile before backup or restore'), { code: 'RETIREMENT_RESULT_UNKNOWN' }); };
const equal = (a, b) => canonical(a) === canonical(b);
const rank = { QUARANTINE_INTENT: 10, QUARANTINED: 20, PURGE_INTENT: 30, PURGED: 40 };
const names = new Set(Object.values(NS).map(n => 'aux:' + n));
const keyOf = row => canonical([row.namespace, row.record_key]);
const pair = row => canonical([row.mediaId, row.versionId]);
function mediaPath(value, quarantine = false) {
  check(typeof value === 'string' && value.startsWith('media/') && !path.posix.isAbsolute(value)
    && !/[\\\\\u0000-\u001f%?#]/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..'), 'Unsafe media path');
  check(quarantine || !value.startsWith('media/.retirement/'), 'Quarantine cannot be an original registration');
  return value;
}
function decode(row) {
  const encoded = row.content_bytes;
  check(encoded?.encoding === 'base64' && typeof encoded.bytes === 'string', 'Missing archived aux bytes');
  const bytes = Buffer.from(encoded.bytes, 'base64');
  check(bytes.toString('base64') === encoded.bytes && sha(bytes) === row.content_sha256, 'Archived aux bytes/hash differ');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { check(false, 'Invalid archived aux JSON'); }
  return { row, bytes, value };
}
function archiveAdapter(archive) {
  const { exportSha256, ...body } = archive;
  check(canonicalSha256(body) === exportSha256, 'Archive hash differs');
  const tables = archive.tables;
  for (const name of ['repository_meta', 'record_heads', 'record_revisions', 'media_versions', 'media_aliases']) check(Array.isArray(tables?.[name]), 'Missing archive table: ' + name);
  check(tables.repository_meta.length === 1 && tables.repository_meta[0].instance_id === archive.instanceId, 'Archive metadata identity differs');
  const revisions = new Map(), heads = new Map(), aux = new Map();
  for (const row of tables.record_revisions) {
    check(!revisions.has(row.revision_id), 'Duplicate archived revision');
    revisions.set(row.revision_id, row);
  }
  for (const head of tables.record_heads) {
    check(!heads.has(keyOf(head)), 'Duplicate archived head');
    heads.set(keyOf(head), head);
    if (!names.has(head.namespace)) continue;
    const row = revisions.get(head.revision_id);
    check(row && keyOf(row) === keyOf(head) && !row.deleted, 'Deleted or mismatched retirement head');
    // Retirement evidence is append-only: no later revision may be hidden by a stale head.
    check(!tables.record_revisions.some(r => keyOf(r) === keyOf(row) && r.revision_number > row.revision_number), 'Stale retirement head');
    const record = decode(row);
    aux.set(keyOf(head), record);
  }
  for (const row of tables.record_revisions) if (names.has(row.namespace)) check(heads.has(keyOf(row)), 'Retirement evidence has no head');
  const media = tables.media_versions.map(row => ({
    mediaId: row.media_id, versionId: row.version_id, relativePath: row.relative_path,
    sha256: row.sha256, byteSize: row.byte_size, availability: row.availability,
    aliases: tables.media_aliases.filter(a => a.media_id === row.media_id && a.version_id === row.version_id).map(a => a.alias).sort(),
  })).sort((a, b) => a.mediaId.localeCompare(b.mediaId) || a.versionId.localeCompare(b.versionId));
  const mediaIds = new Set();
  for (const row of media) {
    check(typeof row.mediaId === 'string' && typeof row.versionId === 'string' && !mediaIds.has(pair(row)), 'Invalid/duplicate media identity');
    mediaIds.add(pair(row));
    check(/^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.byteSize) && row.byteSize >= 0, 'Invalid media hash/size');
    if (row.availability === 'PRESENT') mediaPath(row.relativePath);
  }
  const list = ns => [...aux.values()].filter(r => r.row.namespace === 'aux:' + ns).sort((a, b) => a.row.record_key.localeCompare(b.row.record_key));
  const get = (ns, key) => aux.get(canonical(['aux:' + ns, key]));
  return { tables, media, list, get, tx: {
    listMedia: async () => media,
    listAux: async (ns, { prefix = '' } = {}) => list(ns).filter(r => r.row.record_key.startsWith(prefix)).map(r => ({ bytes: r.bytes })),
  } };
}
function validateRetirementEvidence(archive, adapter) {
  const plans = new Map();
  for (const { row, value: plan } of adapter.list(NS.plans)) {
    check(plan.planId === row.record_key && plan.instanceId === archive.instanceId && plan.manifest?.instanceId === archive.instanceId
      && plan.manifestHash === manifestHash(plan.manifest) && plan.targetSetHash === targetSetHash(plan.manifest)
      && plan.planId === 'retirement_' + plan.manifestHash, 'Retirement plan binding differs');
    check(Array.isArray(plan.manifest.targets) && plan.manifest.targets.length > 0, 'Retirement plan has no targets');
    plans.set(plan.planId, plan);
  }
  const journals = new Map();
  for (const { row, value: event } of adapter.list(NS.journal)) {
    const plan = plans.get(event.planId);
    check(plan && event.instanceId === archive.instanceId && Number.isSafeInteger(event.sequence) && event.sequence > 0
      && row.record_key === event.planId + ':' + String(event.sequence).padStart(8, '0')
      && event.manifestHash === plan.manifestHash && event.targetSetHash === plan.targetSetHash
      && (rank[event.phase] || event.phase === 'RESULT_UNKNOWN'), 'Retirement journal binding differs');
    const events = journals.get(event.planId) || []; events.push(event); journals.set(event.planId, events);
  }
  for (const events of journals.values()) {
    events.sort((a, b) => a.sequence - b.sequence);
    check(events.every((e, i) => e.sequence === i + 1), 'Retirement journal sequence is incomplete');
    if (!['QUARANTINED', 'PURGED'].includes(events.at(-1).phase)) pending();
    check(events.length === 2 || events.length === 4, 'Unexpected committed retirement sequence');
    check(events.every((e, i) => e.phase === ['QUARANTINE_INTENT', 'QUARANTINED', 'PURGE_INTENT', 'PURGED'][i]
      && e.action === (i < 2 ? 'QUARANTINE' : 'PURGE') && e.operationId === events[i < 2 ? 0 : 2].operationId), 'Retirement phase/operation sequence differs');
  }
  const tombstones = adapter.list(NS.tombstones);
  for (const { row, value: tombstone } of tombstones) {
    const plan = plans.get(tombstone.planId);
    const target = plan?.manifest.targets.find(t => t.instanceRelativePath === tombstone.originalRelativePath);
    const event = journals.get(tombstone.planId)?.find(e => e.sequence === tombstone.sequence);
    check(target && rank[tombstone.phase] && event && event.phase === tombstone.phase && event.operationId === tombstone.operationId
      && tombstone.manifestHash === plan.manifestHash && tombstone.targetSetHash === plan.targetSetHash
      && row.record_key === sha(target.instanceRelativePath) + ':' + String(rank[tombstone.phase]).padStart(3, '0') + ':' + tombstone.operationId,
      'Tombstone has no matching plan/journal authority');
    const expectedRegistrations = target.registrations.map(r => ({ mediaId: r.mediaId, versionId: r.versionId, sha256: r.sha256, aliases: [...(r.aliases || [])].sort() }));
    check(tombstone.sha256 === target.sha256 && tombstone.byteSize === target.byteSize
      && equal(tombstone.registrations, expectedRegistrations), 'Tombstone target registration differs');
    mediaPath(tombstone.originalRelativePath);
    const quarantine = 'media/.retirement/' + plan.planId + '/' + sha(target.instanceRelativePath) + path.posix.extname(target.instanceRelativePath);
    check(mediaPath(tombstone.quarantineRelativePath, true) === quarantine, 'Quarantine path binding differs');
    const registered = adapter.media.filter(m => m.relativePath === target.instanceRelativePath);
    const closure = registered.map(m => ({ mediaId: m.mediaId, versionId: m.versionId, sha256: m.sha256, aliases: m.aliases })).sort((a, b) => pair(a).localeCompare(pair(b)));
    check(equal(closure, [...expectedRegistrations].sort((a, b) => pair(a).localeCompare(pair(b))))
      && registered.every(m => m.sha256 === target.sha256 && m.byteSize === target.byteSize && m.availability === 'PRESENT'), 'Retired registration/alias closure differs');
    check(equal(tombstone.fileFact, event.files?.find(f => f.targetId === target.targetId) || null), 'Tombstone file receipt differs');
    if (tombstone.phase === 'QUARANTINED') check(tombstone.fileFact?.relativePath === quarantine
      && tombstone.fileFact.sha256 === target.sha256 && tombstone.fileFact.size === target.byteSize, 'Quarantine receipt has no exact file fact');
    if (tombstone.phase === 'PURGED') check(tombstone.fileFact?.originalAbsent === true && tombstone.fileFact?.quarantineAbsent === true
      && tombstone.fileFact.sha256 === target.sha256 && tombstone.fileFact.byteSize === target.byteSize, 'Purge receipt has no verified absence fact');
  }
  // A final journal receipt must contain the tombstone for EVERY target.
  for (const [planId, events] of journals) {
    const last = events.at(-1), plan = plans.get(planId);
    for (const target of plan.manifest.targets) {
      const matches = tombstones.filter(({ value: t }) => t.planId === planId && t.originalRelativePath === target.instanceRelativePath && t.sequence === last.sequence && t.phase === last.phase);
      check(matches.length === 1, 'Committed retirement receipt has missing/duplicate target tombstones');
    }
  }
}

/** Caller must also use validateArchive for the complete repository schema/history. */
export async function retirementManifestFromArchive(archive) {
  const adapter = archiveAdapter(archive);
  validateRetirementEvidence(archive, adapter);
  return retirementAwareMediaManifest(adapter.tx, adapter.media);
}

/** Exactly one read-only transaction; no live aux reads after the archive is frozen. */
export async function freezeRetirementBackup(repository, instanceId, validateArchive) {
  return repository.readTransaction(async tx => {
    const archive = await tx.exportState();
    validateArchive(archive, instanceId);
    const meta = archive.tables.repository_meta[0];
    return { archive, metadata: { instanceId: archive.instanceId, releaseId: meta.current_release_id, repositoryRevision: meta.repository_revision },
      media: archive.tables.media_versions, mediaRetirement: await retirementManifestFromArchive(archive) };
  });
}
const registrationColumns = ['media_id', 'version_id', 'relative_path', 'sha256', 'byte_size', 'availability'];
const registrationManifest = rows => rows.map(r => Object.fromEntries(registrationColumns.map(k => [k, r[k]])))
  .sort((a, b) => a.media_id.localeCompare(b.media_id) || a.version_id.localeCompare(b.version_id));

/** Never trust the package's physical file list or retirement claims over its archived aux. */
export async function validateRetirementBackupManifest(archive, manifest) {
  check(manifest.instanceId === archive.instanceId, 'Backup instance differs');
  const metadata = archive.tables.repository_meta[0];
  check(manifest.releaseId === metadata.current_release_id && manifest.repositoryRevision === metadata.repository_revision, 'Backup release/repository snapshot differs');
  check(equal(registrationManifest(archive.tables.media_versions), registrationManifest(manifest.media)), 'Backup media differs from database authority');
  const overlay = await retirementManifestFromArchive(archive);
  check(equal(manifest.files, overlay.files), 'Backup files differ from archive retirement authority');
  // Legacy packages remain valid only when no media has retirement state.
  check(manifest.mediaRetirement === undefined ? overlay.retired.length === 0 : equal(manifest.mediaRetirement, overlay), 'Backup retirement projection differs/missing');
  return overlay;
}
