// Run: node --test output/implementation/entity-workflow-20260907/media-retirement-transfer.test.mjs
// Pure in-memory fixtures only. Does not import instance-transfer or open any instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { retirementManifestFromArchive, freezeRetirementBackup, validateRetirementBackupManifest } from '../host/instance-runtime/media-retirement-transfer.mjs';
import { manifestHash, targetSetHash, RETIREMENT_NAMESPACES as NS } from '../host/instance-runtime/media-retirement.mjs';

const canonical = x => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; }
const sha = x => createHash('sha256').update(x).digest('hex');
const mediaHash = sha('historical image original bytes');
const seal = archive => { const { exportSha256, ...body } = archive; archive.exportSha256 = sha(canonical(body)); return archive; };
const record = (archive, namespace, key, value) => {
  const content = Buffer.from(canonical(value));
  const revision = { namespace: 'aux:' + namespace, record_key: key, revision_id: 'irv_' + sha(namespace + ':' + key),
    revision_number: 1, previous_revision_id: null, deleted: 0,
    content_bytes: { encoding: 'base64', bytes: content.toString('base64') }, content_sha256: sha(content) };
  archive.tables.record_revisions.push(revision);
  archive.tables.record_heads.push({ namespace: revision.namespace, record_key: key, revision_id: revision.revision_id });
};
function fixture(phase = 'ACTIVE', shared = false) {
  const media = { media_id: 'IMG-HISTORY', version_id: 'V001', relative_path: 'media/generated/frame.png', sha256: mediaHash, byte_size: 123, availability: 'PRESENT' };
  const archive = { schemaVersion: '1.0', applicationId: 'unit-fixture', instanceId: 'unit-instance',
    tables: { repository_meta: [{ instance_id: 'unit-instance', repository_revision: 7, current_release_id: 'release-fixed' }],
      record_revisions: [], record_heads: [], media_versions: [media], media_aliases: [{ alias: 'historical/frame', media_id: media.media_id, version_id: media.version_id }] } };
  if (shared) archive.tables.media_versions.push({ ...media, media_id: 'IMG-SHARED' });
  if (phase === 'ACTIVE') return seal(archive);
  const target = { targetId: 'historical-frame', instanceRelativePath: media.relative_path, sha256: mediaHash, byteSize: 123,
    registrations: archive.tables.media_versions.map(m => ({ mediaId: m.media_id, versionId: m.version_id, sha256: m.sha256,
      aliases: archive.tables.media_aliases.filter(a => a.media_id === m.media_id).map(a => a.alias) })) };
  const manifest = { instanceId: archive.instanceId, targets: [target] };
  const mh = manifestHash(manifest), th = targetSetHash(manifest), planId = 'retirement_' + mh;
  record(archive, NS.plans, planId, { planId, instanceId: archive.instanceId, manifestHash: mh, targetSetHash: th, manifest });
  const quarantine = 'media/.retirement/' + planId + '/' + sha(media.relative_path) + '.png';
  const phases = ['QUARANTINE_INTENT', 'QUARANTINED', 'PURGE_INTENT', 'PURGED'];
  const last = phase === 'RESULT_UNKNOWN' ? 0 : phases.indexOf(phase);
  for (let i = 0; i <= last; i++) {
    const p = phases[i], sequence = i + 1, operationId = i < 2 ? 'op-quarantine' : 'op-purge';
    const fileFact = p === 'QUARANTINED' ? { targetId: target.targetId, relativePath: quarantine, sha256: mediaHash, size: 123 }
      : p === 'PURGED' ? { targetId: target.targetId, originalAbsent: true, quarantineAbsent: true, sha256: mediaHash, byteSize: 123 } : null;
    record(archive, NS.journal, planId + ':' + String(sequence).padStart(8, '0'), { planId, instanceId: archive.instanceId,
      operationId, action: i < 2 ? 'QUARANTINE' : 'PURGE', phase: p, sequence, manifestHash: mh, targetSetHash: th, files: fileFact ? [fileFact] : null });
    record(archive, NS.tombstones, sha(media.relative_path) + ':' + String(sequence * 10).padStart(3, '0') + ':' + operationId,
      { planId, operationId, phase: p, sequence, originalRelativePath: media.relative_path, quarantineRelativePath: quarantine,
        sha256: mediaHash, byteSize: 123, registrations: target.registrations, manifestHash: mh, targetSetHash: th, fileFact });
  }
  if (phase === 'RESULT_UNKNOWN') record(archive, NS.journal, planId + ':00000002', { planId, instanceId: archive.instanceId,
    operationId: 'op-quarantine', action: 'QUARANTINE', phase, sequence: 2, manifestHash: mh, targetSetHash: th, files: [{ automaticRetry: false }] });
  return seal(archive);
}
function editAux(archive, ns, edit, predicate = () => true) {
  const row = archive.tables.record_revisions.find(r => r.namespace === 'aux:' + ns && predicate(JSON.parse(Buffer.from(r.content_bytes.bytes, 'base64'))));
  const value = JSON.parse(Buffer.from(row.content_bytes.bytes, 'base64')); edit(value);
  const bytes = Buffer.from(canonical(value)); row.content_bytes.bytes = bytes.toString('base64'); row.content_sha256 = sha(bytes); seal(archive);
}
async function packageFor(archive) { const overlay = await retirementManifestFromArchive(archive); return { instanceId: archive.instanceId,
  releaseId: archive.tables.repository_meta[0].current_release_id, repositoryRevision: archive.tables.repository_meta[0].repository_revision,
  media: structuredClone(archive.tables.media_versions), files: overlay.files, mediaRetirement: overlay }; }

test('ACTIVE keeps exact original; history registration bytes remain unchanged', async () => {
  const a = fixture(), before = canonical(a), result = await retirementManifestFromArchive(a);
  assert.deepEqual(result.files, [{ path: 'media/generated/frame.png', sha256: mediaHash, bytes: 123 }]);
  assert.deepEqual(result.retired, []); assert.equal(canonical(a), before);
});
test('PURGED restores immutable registrations and tombstones, requiring zero original files', async () => {
  const a = fixture('PURGED'), before = canonical(a), manifest = await packageFor(a);
  assert.deepEqual(manifest.files, []); assert.equal(manifest.media[0].availability, 'PRESENT');
  assert.equal(manifest.mediaRetirement.retired[0].state, 'PURGED');
  await validateRetirementBackupManifest(a, manifest);
  assert.equal(canonical(a), before); assert.equal(manifest.mediaRetirement.archiveMediaVersionsUnmodified, true);
});
test('QUARANTINED includes exact quarantine file, never original path', async () => {
  const a = fixture('QUARANTINED'), manifest = await packageFor(a);
  assert.equal(manifest.files.length, 1); assert.match(manifest.files[0].path, /^media\/\.retirement\//);
  assert.equal(manifest.files[0].sha256, mediaHash); assert.equal(manifest.files[0].bytes, 123);
  await validateRetirementBackupManifest(a, manifest);
  await assert.rejects(validateRetirementBackupManifest(a, { ...manifest, files: [] }));
});
for (const phase of ['QUARANTINE_INTENT', 'PURGE_INTENT', 'RESULT_UNKNOWN']) {
  test(phase + ' fails closed before a file list exists', async () => {
    await assert.rejects(retirementManifestFromArchive(fixture(phase)), { code: 'RETIREMENT_RESULT_UNKNOWN' });
  });
}
test('shared registrations deduplicate the quarantine file, retain both histories', async () => {
  const result = await retirementManifestFromArchive(fixture('QUARANTINED', true));
  assert.equal(result.files.length, 1); assert.equal(result.retired.length, 2);
});
test('added shared registration/alias cannot inherit a stale purge exemption', async () => {
  for (const change of [a => a.tables.media_versions.push({ ...a.tables.media_versions[0], version_id: 'V002' }),
    a => a.tables.media_aliases.push({ ...a.tables.media_aliases[0], alias: 'new/current/input' })]) {
    const a = fixture('PURGED'); change(a); seal(a);
    await assert.rejects(retirementManifestFromArchive(a), /closure differs/);
  }
});
test('tampered outer archive hash and aux hash fail independently', async () => {
  const a = fixture('PURGED'); a.tables.repository_meta[0].repository_revision++;
  await assert.rejects(retirementManifestFromArchive(a), /Archive hash differs/);
  const b = fixture('PURGED'); b.tables.record_revisions[0].content_sha256 = '0'.repeat(64); seal(b);
  await assert.rejects(retirementManifestFromArchive(b), /bytes\/hash differ/);
});
test('mismatched head namespace and missing retirement head fail closed', async () => {
  const a = fixture('PURGED'); a.tables.record_heads[0].record_key = 'wrong'; seal(a);
  await assert.rejects(retirementManifestFromArchive(a), /mismatched retirement head/);
  const b = fixture('PURGED'); b.tables.record_heads.pop(); seal(b);
  await assert.rejects(retirementManifestFromArchive(b), /no head/);
});
test('deleted retirement head cannot resurrect original', async () => {
  const a = fixture('PURGED'); a.tables.record_revisions.at(-1).deleted = 1; seal(a);
  await assert.rejects(retirementManifestFromArchive(a), /Deleted/);
});
test('stale head cannot hide a newer retirement revision', async () => {
  const a = fixture('PURGED'), row = structuredClone(a.tables.record_revisions.at(-1));
  row.previous_revision_id = row.revision_id; row.revision_id += '-later'; row.revision_number++;
  a.tables.record_revisions.push(row); seal(a);
  await assert.rejects(retirementManifestFromArchive(a), /Stale retirement head/);
});
test('missing receipt tombstone does not infer completed purge from journal', async () => {
  const a = fixture('PURGED'); const last = a.tables.record_revisions.pop();
  a.tables.record_heads = a.tables.record_heads.filter(h => h.revision_id !== last.revision_id); seal(a);
  await assert.rejects(retirementManifestFromArchive(a), /missing\/duplicate target tombstones/);
});
test('exact quarantine path required, traversal is rejected even after rehash', async () => {
  const a = fixture('QUARANTINED'); editAux(a, NS.tombstones, t => { t.quarantineRelativePath = 'media/../outside.png'; });
  await assert.rejects(retirementManifestFromArchive(a), /Unsafe media path/);
});
test('receipt absence and registration SHA cannot be fabricated in projection', async () => {
  const a = fixture('PURGED'); editAux(a, NS.tombstones, t => { t.fileFact.originalAbsent = false; }, t => t.phase === 'PURGED');
  await assert.rejects(retirementManifestFromArchive(a), /receipt differs/);
  const b = fixture('PURGED'), p = await packageFor(b); p.mediaRetirement.retired[0].sha256 = 'a'.repeat(64);
  await assert.rejects(validateRetirementBackupManifest(b, p), /retirement projection differs/);
});
test('package file list cannot resurrect or omit purged/quarantined evidence', async () => {
  const a = fixture('PURGED'), p = await packageFor(a);
  p.files = [{ path: 'media/generated/frame.png', sha256: mediaHash, bytes: 123 }];
  await assert.rejects(validateRetirementBackupManifest(a, p), /files differ/);
  const q = await packageFor(a); delete q.mediaRetirement;
  await assert.rejects(validateRetirementBackupManifest(a, q), /projection differs\/missing/);
});
test('legacy no-retirement package remains accepted without new overlay field', async () => {
  const a = fixture(), p = await packageFor(a); delete p.mediaRetirement;
  await validateRetirementBackupManifest(a, p);
});
test('manifest cannot relabel the frozen release/repository revision', async () => {
  const a = fixture('PURGED'), p = await packageFor(a); p.repositoryRevision++;
  await assert.rejects(validateRetirementBackupManifest(a, p), /snapshot differs/);
});
test('conflicting ACTIVE registrations cannot share a physical backup path', async () => {
  const a = fixture(); a.tables.media_versions.push({ ...a.tables.media_versions[0], version_id: 'V002', byte_size: 999 }); seal(a);
  await assert.rejects(retirementManifestFromArchive(a), { code: 'RETIREMENT_MANIFEST_CONFLICT' });
});
test('all backup authority is frozen in ONE read-only transaction and archive; no live aux reads', async () => {
  const frozenArchive = fixture('QUARANTINED'), before = canonical(frozenArchive);
  let txCount = 0, exportCount = 0, inRead = false, validateCount = 0;
  const repository = { readTransaction: async callback => {
    txCount++; inRead = true;
    try { return await callback({ exportState: async () => { assert.equal(inRead, true); exportCount++; return structuredClone(frozenArchive); },
      listAux: () => assert.fail('Must not read live aux separately'), listMedia: () => assert.fail('Must not read live media separately'),
      putAux: () => assert.fail('No writes') }); } finally { inRead = false; }
  }, writeTransaction: () => assert.fail('No write transaction') };
  const frozen = await freezeRetirementBackup(repository, 'unit-instance', (a, id) => {
    validateCount++; assert.equal(inRead, true); assert.equal(a.instanceId, id);
  });
  assert.equal(txCount, 1); assert.equal(exportCount, 1); assert.equal(validateCount, 1); assert.equal(inRead, false);
  assert.equal(frozen.metadata.releaseId, 'release-fixed'); assert.equal(frozen.mediaRetirement.retired[0].state, 'QUARANTINED');
  assert.equal(canonical(frozenArchive), before);
});
test('pending archive aborts frozen backup, without a mutation or file action', async () => {
  let writes = 0;
  const repo = { readTransaction: cb => cb({ exportState: () => fixture('PURGE_INTENT') }), writeTransaction: () => { writes++; } };
  await assert.rejects(freezeRetirementBackup(repo, 'unit-instance', () => {}), { code: 'RETIREMENT_RESULT_UNKNOWN' });
  assert.equal(writes, 0);
});
