import {restoredRuntimeEpoch} from './execution-epoch.mjs';
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, chmodSync, constants } from 'node:fs';
import path from 'node:path';
import { APPLICATION_ID, MIGRATIONS, SCHEMA_VERSION } from './schema.mjs';

export class RepositoryError extends Error {
  constructor(code, message, details) { super(message); this.name = 'RepositoryError'; this.code = code; this.details = details; }
}
const ensure = (condition, code, message, details) => { if (!condition) throw new RepositoryError(code, message, details); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function validateConfigurationProjection(unit, profile, snapshot, recipes) {
  const ref = profile.configurationRef;
  if (!ref) {
    ensure(!snapshot?.productionModel?.systemConfiguration && !recipes?.configurationRef, 'CONFIGURATION_BINDING', 'Configuration projection requires a release-bound reference');
    return;
  }
  const record = unit.getRecord('settings', 'system-configuration', ref.revisionId);
  ensure(record && !record.deleted && record.sha256 === ref.sha256 && sha256(record.bytes) === ref.sha256, 'CONFIGURATION_BINDING', 'Configuration reference is invalid');
  const value = parse(record.bytes), projected = snapshot?.productionModel?.systemConfiguration;
  ensure(projected && canonicalJson(projected.reference) === canonicalJson(ref) && canonicalJson(recipes?.configurationRef) === canonicalJson(ref) && canonicalJson(projected.config) === canonicalJson(value.configuration), 'CONFIGURATION_BINDING', 'Snapshot, recipes and profile must use the same configuration revision');
  for (const row of [...(snapshot.productionModel.materialRequirements || []), ...(snapshot.productionModel.workItems || []), ...(snapshot.productionModel.episodePlanRevisions || []), ...(snapshot.productionModel.configurationCandidates || []), ...(snapshot.actionQueueInputs?.sceneReviewDossiers || [])]) {
    const binding = row.configurationBinding;
    if (!binding) continue;
    const {hash,...standard}=binding.reviewSpec;ensure(sha256(Buffer.from(canonicalJson(standard)))===hash,'CONFIGURATION_BINDING','Review standard hash is invalid');
    const saved = value.bindings[binding.key];
    ensure(!saved || canonicalJson(saved) === canonicalJson(binding), 'CONFIGURATION_BINDING', 'Existing object configuration was silently rebound');
    ensure(canonicalJson(row.reviewSpec) === canonicalJson(binding.reviewSpec), 'CONFIGURATION_BINDING', 'Object review standard differs from its binding');
  }
}
const jsonBytes = (value) => Buffer.from(canonicalJson(value));
const parse = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));
const text = (value, label) => { ensure(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'INVALID_INPUT', `${label} must be a nonempty string`); return value; };
const digest = (value) => { ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_SHA256', 'Expected SHA-256'); return value; };
const payloadBytes = (value) => { ensure(typeof value === 'string' || value instanceof Uint8Array, 'INVALID_BYTES', 'Original UTF-8 string or byte buffer required'); return Buffer.from(value); };
const now = () => new Date().toISOString();
export function publishedReleaseCutoff(value) {
  ensure(typeof value==='string'&&Number.isFinite(Date.parse(value)),'HISTORICAL_RELEASE_TIME','Historical event timestamp is required');
  return new Date(value).toISOString();
}
export function selectPublishedReleaseAt(rows,{recordedBefore,snapshotId}) {
  const cutoff=publishedReleaseCutoff(recordedBefore);text(snapshotId,'snapshotId');
  ensure(rows.length>0&&rows.length<=200,'HISTORICAL_RELEASE_MISSING','Latest historical publication is missing or exceeds the bounded tie limit');
  ensure(rows.every(r=>r.created_at<cutoff&&r.created_at===rows[0].created_at),'HISTORICAL_RELEASE_TIME','Historical publication timestamp differs');
  const signatures=new Set(rows.map(r=>canonicalJson([r.snapshot_id,r.snapshot_sha256,r.recipes_sha256,r.profile_revision_id,JSON.parse(r.source_revision_ids_json)])));
  ensure(signatures.size===1,'HISTORICAL_RELEASE_AMBIGUOUS','Simultaneous historical publications have different immutable bytes or source/profile bindings');
  ensure(rows[0].snapshot_id===snapshotId,'HISTORICAL_RELEASE_STALE','Creation snapshot was not the latest publication before this event');
  return rows[0].release_id;
}
const contexts = new AsyncLocalStorage();
const writerTails = new Map();
const exportTables = ['repository_meta', 'record_revisions', 'record_heads', 'document_aliases', 'releases', 'domain_events', 'media_versions', 'media_aliases'];
const schemaDefinition = (db) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
let expectedSchemaHash;
const meta = (db) => db.prepare('SELECT * FROM repository_meta WHERE singleton=1').get();
const bump = (db) => db.exec('UPDATE repository_meta SET repository_revision=repository_revision+1 WHERE singleton=1');
const safePath = (value) => { const p = path.resolve(text(value, 'database path')); if (existsSync(p)) ensure(lstatSync(p).isFile() && !lstatSync(p).isSymbolicLink(), 'UNSAFE_PATH', 'Database must be a regular non-symlink file'); return p; };
function physicalPath(filename) {
  let current = path.resolve(filename); const missing = [];
  while (!existsSync(current)) { missing.unshift(path.basename(current)); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  return path.join(realpathSync(current), ...missing);
}
function containerOwnsRoot(root) {
  if (process.env.REVIEW_SQLITE_OWNER !== 'CONTAINER' || process.platform !== 'linux' || !existsSync('/.dockerenv') || root !== '/instance') return false;
  try {
    const configured = resolveInstance('/instance');
    if (process.env.REVIEW_INSTANCE_ROOT && realpathSync(process.env.REVIEW_INSTANCE_ROOT) !== root) return false;
    if (process.env.REVIEW_INSTANCE_ID && process.env.REVIEW_INSTANCE_ID !== configured.instanceId) return false;
    if (process.env.REVIEW_INSTANCE_DB && physicalPath(process.env.REVIEW_INSTANCE_DB) !== configured.dbPath) return false;
    return readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some((line) => {
      const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));
      return mount && (mount === root || mount.startsWith(root + '/')) && (configured.dbPath === mount || configured.dbPath.startsWith(mount + '/'));
    });
  } catch { return false; }
}
// A running instance has exactly one OS owner. Host-side read-only SQLite is
// also forbidden: WAL shared memory and file locks cannot cross the VM boundary.
function assertSqliteOwner(filename) {
  const target = physicalPath(filename);
  let root = path.dirname(target);
  for (;;) {
    const markerPath = path.join(root, 'runtime', 'storage-owner.json');
    if (lstatSync(markerPath, { throwIfNoEntry: false })) {
      let owner;
      try {
        const info = lstatSync(markerPath); ensure(info.isFile() && !info.isSymbolicLink(), 'OWNER_RUNTIME_REQUIRED', 'Storage owner marker must be a regular file');
        owner = JSON.parse(readFileSync(markerPath, 'utf8'));
        const instance = resolveInstance(root);
        ensure(owner.schemaVersion === '1.0' && owner.mode === 'DOCKER' && owner.instanceId === instance.instanceId && owner.containerRoot === '/instance', 'OWNER_RUNTIME_REQUIRED', 'Storage owner marker does not match the instance bootstrap');
      } catch (error) { if (error instanceof RepositoryError && error.code === 'OWNER_RUNTIME_REQUIRED') throw error; throw new RepositoryError('OWNER_RUNTIME_REQUIRED', 'Storage ownership must be verified before opening SQLite'); }
      ensure(containerOwnsRoot(root), 'OWNER_RUNTIME_REQUIRED', 'This instance belongs to Docker; use its controlled container transport; native SQLite fallback is forbidden', { instanceId: owner.instanceId, mode: owner.mode });
      return;
    }
    if (root === '/instance' && existsSync(path.join(root, 'instance.json'))) {
      ensure(containerOwnsRoot(root), 'OWNER_RUNTIME_REQUIRED', 'Container SQLite requires the real single-instance database mount and matching bootstrap');
      return;
    }
    const parent = path.dirname(root); if (parent === root) return; root = parent;
  }
}
const openDb = (filename, readOnly) => {
  assertSqliteOwner(filename);
  const db = new DatabaseSync(filename, { readOnly, enableForeignKeyConstraints: true, allowExtension: false });
  try { db.exec('PRAGMA busy_timeout=5000'); return db; }
  catch (error) { db.close(); throw error; }
};
// Writable instances need SQLite to recreate WAL/SHM files after the last
// writer closes within the same Docker operating system. The connection
// is immediately query-only: this permits SQLite bookkeeping, never business SQL.
// Explicit read-only instances retain SQLite's OS-level read-only open mode.
const openReadDb = (filename, readOnly) => {
  const db = openDb(filename, readOnly);
  try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); return db; }
  catch (error) { db.close(); throw error; }
};
const processReadOnly = () => process.env.REVIEW_INSTANCE_READ_ONLY === '1' || process.env.REVIEW_REMOTE_READ_ONLY === '1';
const fileIdentity = (filename) => { const info = lstatSync(filename, { bigint: true }); ensure(info.isFile() && !info.isSymbolicLink(), 'UNSAFE_PATH', 'Database must be a regular non-symlink file'); return `${info.dev}:${info.ino}`; };

function validateDb(db, instanceId) {
  ensure(db.prepare('PRAGMA application_id').get().application_id === APPLICATION_ID, 'WRONG_DATABASE', 'Not an instance business repository');
  ensure(db.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION, 'SCHEMA_MISMATCH', 'Unsupported business repository schema');
  if (!expectedSchemaHash) {
    const reference = new DatabaseSync(':memory:');
    try { for (const migration of MIGRATIONS) reference.exec(migration.sql); expectedSchemaHash = sha256(canonicalJson(schemaDefinition(reference))); } finally { reference.close(); }
  }
  ensure(sha256(canonicalJson(schemaDefinition(db))) === expectedSchemaHash, 'SCHEMA_DEFINITION_MISMATCH', 'Repository tables and immutable guards differ from the published schema');
  const row = meta(db);
  ensure(row && (!instanceId || row.instance_id === instanceId), 'INSTANCE_MISMATCH', 'Database belongs to a different instance');
  return row;
}
function record(row) {
  return row ? { namespace: row.namespace, key: row.record_key, revisionId: row.revision_id, revision: row.revision_number,
    previousRevisionId: row.previous_revision_id, bytes: Buffer.from(row.content_bytes), sha256: row.content_sha256,
    mediaType: row.media_type, metadata: JSON.parse(row.metadata_json), deleted: Boolean(row.deleted), createdAt: row.created_at } : null;
}
function orderedEvents(rows) {
  return rows.map((row) => parse(row.event_bytes)).sort((a, b) => {
    const left = Number.isSafeInteger(a.eventSequence) && a.eventSequence > 0 ? a.eventSequence : null;
    const right = Number.isSafeInteger(b.eventSequence) && b.eventSequence > 0 ? b.eventSequence : null;
    if (left !== null && right !== null && left !== right) return right - left;
    if (left !== null && right === null) return -1;
    if (left === null && right !== null) return 1;
    return String(b.recordedAt).localeCompare(String(a.recordedAt)) || String(b.eventId).localeCompare(String(a.eventId));
  });
}
function media(row, db) {
  return row ? { mediaId: row.media_id, versionId: row.version_id, relativePath: row.relative_path,
    sha256: row.sha256, byteSize: row.byte_size, availability: row.availability, metadata: JSON.parse(row.metadata_json),
    aliases: db.prepare('SELECT alias FROM media_aliases WHERE media_id=? AND version_id=? ORDER BY alias').all(row.media_id, row.version_id).map((x) => x.alias) } : null;
}

// Lightweight read watermark: immutable AUX head identities (including deletions),
// and registered-media metadata, never record bodies or media bytes.
export function projectionFingerprintNamespaces(namespaces) {
  ensure(Array.isArray(namespaces)&&namespaces.length<=64,'INVALID_INPUT','At most 64 projection namespaces required');
  return [...new Set(namespaces.map(value=>text(value,'namespace')))].sort();
}
export function projectionFingerprintRows(namespaces,heads,mediaRows,aliases) {
  const sorted=rows=>rows.map(row=>canonicalJson(row)).sort();
  return sha256(canonicalJson({namespaces,heads:sorted(heads.map(r=>[r.namespace,r.record_key,r.revision_id])),
    media:sorted(mediaRows.map(r=>[r.media_id,r.version_id,r.relative_path,r.sha256,Number(r.byte_size),r.availability,JSON.parse(r.metadata_json)])),
    aliases:sorted(aliases.map(r=>[r.alias,r.media_id,r.version_id]))}));
}

class ReadUnit {
  constructor(db) { this.db = db; this.backend = 'sqlite'; }
  getMetadata() { const m=meta(this.db),r=m.current_release_id?this.db.prepare('SELECT profile_revision_id,snapshot_id FROM releases WHERE release_id=?').get(m.current_release_id):null; return {instanceId:m.instance_id,runtimeEpoch:m.runtime_epoch,repositoryRevision:m.repository_revision,releaseId:m.current_release_id,profileRevisionId:r?.profile_revision_id||null,snapshotId:r?.snapshot_id||null,eventSequence:this.db.prepare('SELECT COALESCE(max(storage_sequence),0) AS n FROM domain_events').get().n}; }
  getProjectionFingerprint(namespaces) {
    const selected=projectionFingerprintNamespaces(namespaces),parameters=selected.map(value=>'aux:'+value);
    const heads=parameters.length?this.db.prepare('SELECT namespace,record_key,revision_id FROM record_heads WHERE namespace IN ('+parameters.map(()=>'?').join(',')+')').all(...parameters):[];
    const mediaRows=this.db.prepare('SELECT media_id,version_id,relative_path,sha256,byte_size,availability,metadata_json FROM media_versions').all();
    const aliases=this.db.prepare('SELECT alias,media_id,version_id FROM media_aliases').all();
    return projectionFingerprintRows(selected,heads,mediaRows,aliases);
  }
  listRecordRevisions(namespace,key) { return this.db.prepare('SELECT * FROM record_revisions WHERE namespace=? AND record_key=? ORDER BY revision_number').all(namespace,key).map(record); }
  listPublishedDocumentMetadata() {
    const release=this.db.prepare('SELECT source_revision_ids_json FROM releases WHERE release_id=(SELECT current_release_id FROM repository_meta WHERE singleton=1)').get();
    if(!release)return [];
    return JSON.parse(release.source_revision_ids_json).map(id=>this.db.prepare("SELECT record_key,revision_id,content_sha256,length(content_bytes) AS byte_size,metadata_json,media_type FROM record_revisions WHERE namespace='documents' AND revision_id=? AND deleted=0").get(id)).filter(Boolean).map(r=>({documentId:r.record_key,revisionId:r.revision_id,sha256:r.content_sha256,byteSize:r.byte_size,metadata:JSON.parse(r.metadata_json),mediaType:r.media_type,aliases:this.db.prepare('SELECT alias FROM document_aliases WHERE document_id=? ORDER BY alias').all(r.record_key).map(x=>x.alias)}));
  }
  getPublishedDocument(alias) { const rows=this.listPublishedDocumentMetadata().filter(r=>r.documentId===alias||r.aliases.includes(alias));ensure(rows.length<=1,'SOURCE_ALIAS_AMBIGUOUS','Published document alias is ambiguous');return rows[0]?this.readDocumentRevision(rows[0].revisionId):null; }
  getRecord(namespace, key, revisionId) {
    const row = revisionId ? this.db.prepare('SELECT * FROM record_revisions WHERE revision_id=? AND namespace=? AND record_key=?').get(revisionId, namespace, key)
      : this.db.prepare('SELECT r.* FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace=? AND h.record_key=?').get(namespace, key);
    return record(row);
  }
  readDocument(idOrAlias, { revisionId } = {}) {
    const id = this.db.prepare('SELECT document_id FROM document_aliases WHERE alias=?').get(idOrAlias)?.document_id || idOrAlias;
    const item = this.getRecord('documents', id, revisionId);
    return item ? { ...item, documentId: id, aliases: this.db.prepare('SELECT alias FROM document_aliases WHERE document_id=? ORDER BY alias').all(id).map((x) => x.alias) } : null;
  }
  listDocuments() { return this.db.prepare("SELECT record_key FROM record_heads WHERE namespace='documents' ORDER BY record_key").all().map((row) => this.readDocument(row.record_key)); }
  readDocumentRevision(revisionId) {
    const row = this.db.prepare("SELECT record_key FROM record_revisions WHERE revision_id=? AND namespace='documents'").get(text(revisionId, 'revisionId'));
    return row ? this.readDocument(row.record_key, { revisionId }) : null;
  }
  readRelease(releaseId = meta(this.db).current_release_id) {
    if (!releaseId) return null;
    const row = this.db.prepare('SELECT * FROM releases WHERE release_id=?').get(text(releaseId, 'releaseId'));
    return row ? { releaseId: row.release_id, snapshotId: row.snapshot_id, snapshotBytes: Buffer.from(row.snapshot_bytes), snapshotSha256: row.snapshot_sha256,
      recipesBytes: Buffer.from(row.recipes_bytes), recipesSha256: row.recipes_sha256, sourceRevisionIds: JSON.parse(row.source_revision_ids_json), profileRevisionId: row.profile_revision_id, createdAt: row.created_at } : null;
  }
  readPublishedReleaseAt({recordedBefore,snapshotId}) {
    const cutoff=publishedReleaseCutoff(recordedBefore);
    // Do not filter by snapshotId: a newer publication with a different snapshot
    // is evidence that the requested creation context was already stale.
    const rows=this.db.prepare('SELECT release_id,snapshot_id,snapshot_sha256,recipes_sha256,source_revision_ids_json,profile_revision_id,created_at FROM releases WHERE created_at=(SELECT max(created_at) FROM releases WHERE created_at<=?) ORDER BY release_id LIMIT 201').all(cutoff);
    const id=selectPublishedReleaseAt(rows,{recordedBefore:cutoff,snapshotId});
    return this.readRelease(id);
  }
  getConfig(configId) { const item = this.getRecord('settings', configId); return item ? { ...item, configId, value: parse(item.bytes) } : null; }
  getProfile() { const config = this.getConfig('instance-profile'); ensure(config && !config.deleted, 'PROFILE_MISSING', 'Instance profile is required'); ensure(config.value.instanceId === meta(this.db).instance_id, 'INSTANCE_MISMATCH', 'Profile instance identity mismatch'); return config.value; }
  getAux(namespace, key, options = {}) { return this.getRecord(`aux:${text(namespace, 'namespace')}`, text(key, 'key'), options.revisionId); }
  listAux(namespace, { prefix = '', includeDeleted = false } = {}) {
    return this.db.prepare('SELECT r.* FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace=? AND substr(h.record_key,1,length(?))=? ORDER BY h.record_key').all(`aux:${text(namespace, 'namespace')}`,prefix,prefix)
      .filter((row) => includeDeleted || !row.deleted).map(record);
  }
  listEvents(kind, { authorityDomain = 'FORMAL' } = {}) {
    const rows = kind ? this.db.prepare('SELECT * FROM domain_events WHERE authority_domain=? AND event_kind=?').all(authorityDomain, kind)
      : this.db.prepare('SELECT * FROM domain_events WHERE authority_domain=?').all(authorityDomain);
    return orderedEvents(rows);
  }
  findIdempotentEvent(kind, key, { authorityDomain = 'FORMAL' } = {}) {
    const keyHash = sha256(`${kind}:${key}`);
    const row = this.db.prepare('SELECT event_bytes FROM domain_events WHERE authority_domain=? AND event_kind=? AND idempotency_key_hash=?').get(authorityDomain, kind, keyHash);
    return row ? parse(row.event_bytes) : null;
  }
  getMedia(mediaId, versionId) { return media(this.db.prepare('SELECT * FROM media_versions WHERE media_id=? AND version_id=?').get(mediaId, versionId), this.db); }
  listMedia() { return this.db.prepare('SELECT * FROM media_versions ORDER BY media_id,version_id').all().map((row) => media(row, this.db)); }
  resolveMedia(alias, { versionId, sha256: expectedSha } = {}) {
    const rows = this.db.prepare('SELECT m.* FROM media_versions m WHERE m.version_id=? OR EXISTS(SELECT 1 FROM media_aliases a WHERE a.media_id=m.media_id AND a.version_id=m.version_id AND a.alias=?)').all(alias, alias)
      .filter((row) => (!versionId || row.version_id === versionId) && (!expectedSha || row.sha256 === expectedSha));
    ensure(rows.length <= 1, 'AMBIGUOUS_MEDIA_ALIAS', 'A historical path requires an exact version and SHA');
    return media(rows[0], this.db);
  }
  readView() {
    const state = meta(this.db);
    const release = state.current_release_id ? this.db.prepare('SELECT * FROM releases WHERE release_id=?').get(state.current_release_id) : null;
    ensure(!state.current_release_id || release, 'RELEASE_MISSING', 'Active release pointer is invalid');
    const profileRecord = release ? this.db.prepare("SELECT * FROM record_revisions WHERE revision_id=? AND namespace='settings' AND record_key='instance-profile'").get(release.profile_revision_id) : null;
    ensure(!release || profileRecord, 'PROFILE_MISSING', 'Release-bound profile revision is unavailable');
    const profile = profileRecord ? parse(profileRecord.content_bytes) : this.getProfile();
    ensure(profile.instanceId === state.instance_id, 'INSTANCE_MISMATCH', 'Active release profile belongs to another instance');
    const snapshot = release ? parse(release.snapshot_bytes) : null;
    if (release) validateConfigurationProjection(this, profile, snapshot, parse(release.recipes_bytes));
    const publicProfile = Object.fromEntries(['schemaVersion', 'instanceId', 'projectId', 'title', 'storyTitle', 'episodePlanId', 'locale', 'branding', 'assistant', 'sourceBindings', 'capabilities', 'configurationRef'].filter((key) => profile[key] !== undefined).map((key) => [key, profile[key]]));
    if (snapshot) { snapshot.instance = publicProfile; snapshot.productionModel = { ...snapshot.productionModel, instance: publicProfile }; }
    const eventsByKind = {};
    for (const event of this.listEvents()) (eventsByKind[event.eventKind] ||= []).push(event);
    return { instanceId: state.instance_id, runtimeEpoch: state.runtime_epoch, repositoryRevision: state.repository_revision,
      releaseId: state.current_release_id, profile, snapshot, recipes: release ? parse(release.recipes_bytes) : null,
      eventsByKind, sourceRevisionIds: release ? JSON.parse(release.source_revision_ids_json) : [],
      dataFingerprint: release ? `${state.runtime_epoch}:${release.release_id}:${release.snapshot_sha256}` : '',
      recipeFingerprint: release ? `${state.runtime_epoch}:${release.release_id}:${release.recipes_sha256}` : '' };
  }
  exportState() {
    const tables = {};
    for (const table of exportTables) tables[table] = this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { encoding: 'base64', bytes: Buffer.from(value).toString('base64') } : value])));
    const body = { schemaVersion: SCHEMA_VERSION, applicationId: APPLICATION_ID, instanceId: meta(this.db).instance_id, tables,
      sequence: this.db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all(), mediaIncluded: false };
    return { ...body, exportSha256: sha256(canonicalJson(body)) };
  }
}

class WriteUnit extends ReadUnit {
  resetRuntimeEpoch() { this.db.prepare('UPDATE repository_meta SET runtime_epoch=?,repository_revision=repository_revision+1 WHERE singleton=1').run(restoredRuntimeEpoch(randomUUID()));return this.getMetadata(); }
  putRecord(namespace, key, bytes, { expectedRevisionId, mediaType = 'application/octet-stream', metadata = {}, deleted = false } = {}) {
    text(namespace, 'namespace'); text(key, 'key');
    ensure(expectedRevisionId === null || typeof expectedRevisionId === 'string', 'CAS_REQUIRED', 'Explicit expectedRevisionId required; null creates a new identity');
    const previous = this.getRecord(namespace, key); ensure((previous?.revisionId ?? null) === expectedRevisionId, 'HEAD_CONFLICT', 'Record head changed', { currentRevisionId: previous?.revisionId ?? null });
    const content = payloadBytes(bytes); const hash = sha256(content); const metadataJson = canonicalJson(metadata);
    if (previous && previous.sha256 === hash && canonicalJson(previous.metadata) === metadataJson && previous.mediaType === mediaType && previous.deleted === deleted) return previous;
    const revisionId = `irv_${randomUUID()}`; const revision = (previous?.revision ?? 0) + 1;
    this.db.prepare('INSERT INTO record_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(revisionId, namespace, key, revision, previous?.revisionId ?? null, content, hash, mediaType, metadataJson, Number(deleted), now());
    this.db.prepare('INSERT INTO record_heads VALUES(?,?,?) ON CONFLICT(namespace,record_key) DO UPDATE SET revision_id=excluded.revision_id').run(namespace, key, revisionId);
    bump(this.db); return this.getRecord(namespace, key);
  }
  putDocument({ documentId, bytes, aliases = [], ...options }) {
    const item = this.putRecord('documents', documentId, bytes, options);
    for (const alias of aliases) {
      text(alias, 'alias'); const old = this.db.prepare('SELECT document_id FROM document_aliases WHERE alias=?').get(alias);
      ensure(!old || old.document_id === documentId, 'ALIAS_CONFLICT', 'Document alias belongs to another identity');
      if (!old) { this.db.prepare('INSERT INTO document_aliases VALUES(?,?)').run(alias, documentId); bump(this.db); }
    }
    return this.readDocument(item.key);
  }
  putConfig({ configId, value, bytes, ...options }) {
    const content = bytes === undefined ? jsonBytes(value) : payloadBytes(bytes);
    if (value !== undefined) ensure(canonicalJson(parse(content)) === canonicalJson(value), 'CONFIG_BYTES_MISMATCH', 'Configuration value and original bytes differ');
    if (configId === 'instance-profile') {
      const next = parse(content); const previous = this.getConfig(configId)?.value;
      ensure(next.instanceId === meta(this.db).instance_id, 'INSTANCE_MISMATCH', 'Cannot replace instance identity');
      if (previous) for (const key of ['instanceId', 'projectId', 'episodePlanId']) ensure(next[key] === previous[key], 'INSTANCE_IDENTITY_IMMUTABLE', `${key} is immutable`);
    }
    return this.putRecord('settings', configId, content, { ...options, mediaType: 'application/json' });
  }
  putAux({ namespace, key, bytes, ...options }) { return this.putRecord(`aux:${text(namespace, 'namespace')}`, key, bytes, options); }
  deleteAux({ namespace, key, expectedRevisionId, metadata = {} }) {
    const current = this.getAux(namespace, key); ensure(current, 'RECORD_NOT_FOUND', 'Auxiliary record does not exist');
    return this.putAux({ namespace, key, bytes: current.bytes, expectedRevisionId, mediaType: current.mediaType, metadata: { ...current.metadata, ...metadata }, deleted: true });
  }
  moveAux({ fromNamespace, fromKey, fromRevisionId, toNamespace, toKey }) {
    const current = this.getAux(fromNamespace, fromKey);
    ensure(current && !current.deleted && current.revisionId === fromRevisionId, 'HEAD_CONFLICT', 'Move source changed or is unavailable');
    const destination = this.putAux({ namespace: toNamespace, key: toKey, bytes: current.bytes, expectedRevisionId: null,
      mediaType: current.mediaType, metadata: { ...current.metadata, movedFrom: { namespace: fromNamespace, key: fromKey, revisionId: current.revisionId } } });
    const source = this.deleteAux({ namespace: fromNamespace, key: fromKey, expectedRevisionId: fromRevisionId,
      metadata: { movedTo: { namespace: toNamespace, key: toKey, revisionId: destination.revisionId } } });
    return { source, destination };
  }
  publishRelease({ snapshot, recipes, snapshotBytes, recipesBytes, expectedReleaseId, sourceRevisionIds = [] }) {
    const state = meta(this.db); ensure(expectedReleaseId === null || typeof expectedReleaseId === 'string', 'CAS_REQUIRED', 'Explicit expectedReleaseId required');
    ensure(state.current_release_id === expectedReleaseId, 'RELEASE_CONFLICT', 'Current release changed');
    const data = snapshotBytes === undefined ? jsonBytes(snapshot) : payloadBytes(snapshotBytes);
    const recipe = recipesBytes === undefined ? jsonBytes(recipes) : payloadBytes(recipesBytes);
    const parsed = parse(data); const catalog = parse(recipe);
    ensure(parsed.snapshotId && parsed.snapshotId === catalog.snapshotId, 'RELEASE_MISMATCH', 'Snapshot and recipes must belong to one release');
    if (snapshot !== undefined) ensure(canonicalJson(parsed) === canonicalJson(snapshot), 'RELEASE_BYTES_MISMATCH', 'Snapshot bytes and value differ');
    if (recipes !== undefined) ensure(canonicalJson(catalog) === canonicalJson(recipes), 'RELEASE_BYTES_MISMATCH', 'Recipe bytes and value differ');
    if (parsed.instance) ensure(parsed.instance.instanceId === state.instance_id, 'INSTANCE_MISMATCH', 'Snapshot belongs to another instance');
    const profile = this.getConfig('instance-profile'); this.getProfile();
    validateConfigurationProjection(this, profile.value, parsed, catalog);
    for (const id of sourceRevisionIds) ensure(this.db.prepare('SELECT 1 FROM record_revisions WHERE revision_id=?').get(id), 'SOURCE_REVISION_MISSING', 'Release source revision is unavailable');
    const releaseId = `release_${randomUUID()}`;
    this.db.prepare('INSERT INTO releases VALUES(?,?,?,?,?,?,?,?,?)').run(releaseId, parsed.snapshotId, data, sha256(data), recipe, sha256(recipe), canonicalJson(sourceRevisionIds), profile.revisionId, now());
    this.db.prepare('UPDATE repository_meta SET current_release_id=? WHERE singleton=1').run(releaseId); bump(this.db);
    return this.readView();
  }
  importEvent({ bytes, sourceRef = null, authorityDomain = 'FORMAL' }) {
    const content = payloadBytes(bytes); const event = parse(content);
    const kind = event.eventKind || event.eventType;
    const recordedAt = event.recordedAt || (Number.isSafeInteger(event.createdAt) ? new Date(event.createdAt).toISOString() : event.createdAt);
    text(event.eventId, 'eventId'); text(kind, 'eventKind'); text(recordedAt, 'recordedAt'); text(authorityDomain, 'authorityDomain');
    ensure(authorityDomain !== 'FORMAL' || (event.eventKind && event.recordedAt), 'EVENT_DOMAIN_MISMATCH', 'Formal events must retain the original formal protocol');
    const old = this.db.prepare('SELECT * FROM domain_events WHERE event_id=?').get(event.eventId);
    if (old) { ensure(old.event_sha256 === sha256(content) && old.authority_domain === authorityDomain, 'EVENT_CONFLICT', 'Event identity already contains different bytes'); return event; }
    if (event.idempotencyKeyHash) digest(event.idempotencyKeyHash);
    if (event.idempotencyKeyHash) ensure(!this.db.prepare('SELECT 1 FROM domain_events WHERE authority_domain=? AND event_kind=? AND idempotency_key_hash=?').get(authorityDomain, kind, event.idempotencyKeyHash), 'IDEMPOTENCY_CONFLICT', 'Imported idempotency identity collides');
    const sequence = Number.isSafeInteger(event.eventSequence) && event.eventSequence > 0 ? event.eventSequence : null;
    this.db.prepare('INSERT INTO domain_events(event_id,authority_domain,event_kind,original_sequence,recorded_at,event_bytes,event_sha256,idempotency_key_hash,request_hash,raw_request_hash,source_ref_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(event.eventId, authorityDomain, kind, sequence, recordedAt, content, sha256(content), event.idempotencyKeyHash || null, event.requestHash || null, event.rawRequestHash || null, canonicalJson(sourceRef));
    bump(this.db); return event;
  }
  appendEvent({ kind, idempotencyKey, requestHash, payload, eventSchemaVersion = '1.1', authorityDomain = 'FORMAL' }) {
    text(kind, 'event kind'); text(idempotencyKey, 'idempotency key'); digest(requestHash);
    const prior = this.findIdempotentEvent(kind, idempotencyKey, { authorityDomain });
    if (prior) { ensure(prior.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with different content'); return { event: prior, replayed: true }; }
    for (const key of ['eventId', 'eventKind', 'idempotencyKeyHash', 'requestHash', 'recordedAt', 'eventSequence']) ensure(!Object.hasOwn(payload, key), 'RESERVED_EVENT_FIELD', `Event payload cannot override ${key}`);
    ensure(!Object.hasOwn(payload, 'schemaVersion') || payload.schemaVersion === eventSchemaVersion, 'RESERVED_EVENT_FIELD', 'Event schemaVersion differs from the command protocol');
    const count = this.db.prepare('SELECT count(*) AS n,max(original_sequence) AS seq FROM domain_events WHERE authority_domain=?').get(authorityDomain);
    const event = { schemaVersion: eventSchemaVersion, eventId: `evt_${randomUUID()}`, eventKind: kind,
      idempotencyKeyHash: sha256(`${kind}:${idempotencyKey}`), requestHash, recordedAt: now(), ...payload, eventSequence: Math.max(count.n, count.seq || 0) + 1 };
    this.importEvent({ bytes: Buffer.from(JSON.stringify(event, null, 2) + '\n'), authorityDomain }); return { event, replayed: false };
  }
  registerMedia({ mediaId, versionId, relativePath, sha256: hash, byteSize, aliases = [], metadata = {}, availability = 'PRESENT' }) {
    text(mediaId, 'mediaId'); text(versionId, 'versionId'); digest(hash);
    ensure(Number.isSafeInteger(byteSize) && byteSize >= 0, 'INVALID_SIZE', 'Invalid media byte size');
    ensure(['PRESENT', 'MISSING_HISTORY'].includes(availability), 'INVALID_AVAILABILITY', 'Invalid availability');
    if (relativePath !== null && relativePath !== undefined) {
      text(relativePath, 'relativePath'); ensure(!path.posix.isAbsolute(relativePath) && !relativePath.includes('\\') && !relativePath.split('/').some((x) => !x || x === '.' || x === '..'), 'PATH_ESCAPE', 'Media path must be a safe instance-relative path');
      ensure(relativePath.startsWith('media/'), 'PATH_ESCAPE', 'Media files must be inside the instance media directory');
    } else ensure(availability === 'MISSING_HISTORY', 'MEDIA_PATH_REQUIRED', 'Present media requires an immutable file path');
    const old = this.getMedia(mediaId, versionId);
    if (old) ensure(canonicalJson({ relativePath: old.relativePath, sha256: old.sha256, byteSize: old.byteSize, availability: old.availability, metadata: old.metadata }) === canonicalJson({ relativePath: relativePath ?? null, sha256: hash, byteSize, availability, metadata }), 'MEDIA_CONFLICT', 'Media version cannot be overwritten');
    else {
      if (relativePath) ensure(!this.db.prepare('SELECT 1 FROM media_versions WHERE relative_path=? AND sha256!=?').get(relativePath, hash), 'MEDIA_PATH_CONFLICT', 'One immutable physical path cannot contain two hashes');
      this.db.prepare('INSERT INTO media_versions VALUES(?,?,?,?,?,?,?,?)').run(mediaId, versionId, relativePath ?? null, hash, byteSize, availability, canonicalJson(metadata), now()); bump(this.db);
    }
    for (const alias of aliases) { const added = this.db.prepare('INSERT OR IGNORE INTO media_aliases VALUES(?,?,?)').run(text(alias, 'media alias'), mediaId, versionId); if (added.changes) bump(this.db); }
    return this.getMedia(mediaId, versionId);
  }
}

export class InstanceRepository {
  constructor({ dbPath, instanceId, readOnly = false }) {
    this.backend = 'sqlite'; this.dbPath = safePath(dbPath); ensure(existsSync(this.dbPath), 'DATABASE_MISSING', 'Instance database is required; legacy fallback is forbidden');
    this.readOnly = readOnly || processReadOnly(); this.fileIdentity = fileIdentity(this.dbPath); const db = openReadDb(this.dbPath, this.readOnly);
    try { const row = validateDb(db, instanceId); this.instanceId = row.instance_id; } finally { db.close(); }
  }
  assertCurrentFile() { assertSqliteOwner(this.dbPath); ensure(fileIdentity(this.dbPath) === this.fileIdentity, 'DATABASE_REPLACED', 'Database file was replaced; restart this runtime before reading or writing'); }
  get inTransaction() { return contexts.getStore()?.dbPath === this.dbPath; }
  get transactionMode() { const current=contexts.getStore();return current?.dbPath===this.dbPath?(current.writable?'WRITE':'READ'):null; }
  _read(method, args) {
    this.assertCurrentFile();
    const current = contexts.getStore(); if (current?.dbPath === this.dbPath) return current.unit[method](...args);
    const db = openReadDb(this.dbPath, this.readOnly || processReadOnly());
    try { validateDb(db, this.instanceId); db.exec('BEGIN'); const result = new ReadUnit(db)[method](...args); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
  }
  getRecord(...args) { return this._read('getRecord',args); }
  getMetadata() { return this._read('getMetadata', []); }
  getProjectionFingerprint(...args) { return this._read('getProjectionFingerprint', args); }
  listRecordRevisions(...args) { return this._read('listRecordRevisions', args); }
  listPublishedDocumentMetadata() { return this._read('listPublishedDocumentMetadata', []); }
  getPublishedDocument(...args) { return this._read('getPublishedDocument', args); }
  readView() { return this._read('readView', []); }
  readDocument(...args) { return this._read('readDocument', args); }
  readDocumentRevision(...args) { return this._read('readDocumentRevision', args); }
  readRelease(...args) { return this._read('readRelease', args); }
  readPublishedReleaseAt(...args) { return this._read('readPublishedReleaseAt', args); }
  listDocuments(...args) { return this._read('listDocuments', args); }
  getConfig(...args) { return this._read('getConfig', args); }
  getProfile() { return this._read('getProfile', []); }
  getAux(...args) { return this._read('getAux', args); }
  listAux(...args) { return this._read('listAux', args); }
  listEvents(...args) { return this._read('listEvents', args); }
  findIdempotentEvent(...args) { return this._read('findIdempotentEvent', args); }
  getMedia(...args) { return this._read('getMedia', args); }
  listMedia(...args) { return this._read('listMedia', args); }
  resolveMedia(...args) { return this._read('resolveMedia', args); }
  exportState() { return this._read('exportState', []); }
  async readTransaction(callback) {
    this.assertCurrentFile();
    if (this.inTransaction) return callback(contexts.getStore().unit);
    const db = openReadDb(this.dbPath, this.readOnly || processReadOnly());
    try { validateDb(db, this.instanceId); db.exec('BEGIN'); const result = await contexts.run({ dbPath: this.dbPath, unit: new ReadUnit(db), writable: false }, () => callback(new ReadUnit(db))); this.assertCurrentFile(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
  }
  async writeTransaction(callback) {
    ensure(!this.readOnly && !processReadOnly(), 'READ_ONLY', 'Read-only repository cannot mutate');
    this.assertCurrentFile();
    if (this.inTransaction) { ensure(contexts.getStore().writable, 'READ_ONLY_TRANSACTION', 'Cannot promote a read view to a writer'); return callback(contexts.getStore().unit); }
    const previous = writerTails.get(this.dbPath) || Promise.resolve(); let done;
    const gate = new Promise((resolve) => { done = resolve; }); const tail = previous.catch(() => {}).then(() => gate); writerTails.set(this.dbPath, tail);
    await previous.catch(() => {});
    let db;
    try {
      this.assertCurrentFile();
      db = openDb(this.dbPath, false); validateDb(db, this.instanceId); db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const unit = new WriteUnit(db); const result = await contexts.run({ dbPath: this.dbPath, unit, writable: true }, () => callback(unit)); this.assertCurrentFile(); ensure(!processReadOnly(), 'READ_ONLY', 'Runtime became read-only during transaction'); db.exec('COMMIT'); return result;
    } catch (error) { if (db) try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { db?.close(); done(); if (writerTails.get(this.dbPath) === tail) writerTails.delete(this.dbPath); }
  }
  integrityCheck() {
    this.assertCurrentFile();
    const db = openReadDb(this.dbPath, this.readOnly || processReadOnly());
    try {
      validateDb(db, this.instanceId); const errors = [];
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') errors.push('SQLITE_INTEGRITY');
      if (db.prepare('PRAGMA foreign_key_check').all().length) errors.push('FOREIGN_KEYS');
      const latest = new Map();
      for (const row of db.prepare('SELECT * FROM record_revisions ORDER BY namespace,record_key,revision_number').all()) {
        if (sha256(row.content_bytes) !== row.content_sha256) errors.push(`RECORD_BYTES:${row.revision_id}`);
        const key = canonicalJson([row.namespace, row.record_key]); const previous = latest.get(key);
        if (row.revision_number !== (previous?.revision_number ?? 0) + 1 || row.previous_revision_id !== (previous?.revision_id ?? null)) errors.push(`RECORD_CHAIN:${row.revision_id}`);
        latest.set(key, row);
      }
      for (const head of db.prepare('SELECT * FROM record_heads').all()) {
        const key = canonicalJson([head.namespace, head.record_key]);
        if (latest.get(key)?.revision_id !== head.revision_id) errors.push(`RECORD_HEAD:${key}`);
        latest.delete(key);
      }
      if (latest.size) errors.push('MISSING_RECORD_HEAD');
      for (const alias of db.prepare('SELECT * FROM document_aliases').all()) if (!db.prepare("SELECT 1 FROM record_heads WHERE namespace='documents' AND record_key=?").get(alias.document_id)) errors.push(`DOCUMENT_ALIAS:${alias.alias}`);
      for (const row of db.prepare('SELECT * FROM domain_events').all()) {
        const event = parse(row.event_bytes);
        if (sha256(row.event_bytes) !== row.event_sha256 || event.eventId !== row.event_id || (event.eventKind || event.eventType) !== row.event_kind || (event.idempotencyKeyHash || null) !== row.idempotency_key_hash) errors.push(`EVENT_BYTES:${row.event_id}`);
      }
      for (const row of db.prepare('SELECT * FROM releases').all()) if (sha256(row.snapshot_bytes) !== row.snapshot_sha256 || sha256(row.recipes_bytes) !== row.recipes_sha256 || parse(row.snapshot_bytes).snapshotId !== parse(row.recipes_bytes).snapshotId) errors.push(`RELEASE_BYTES:${row.release_id}`);
      new ReadUnit(db).readView();
      ensure(errors.length === 0, 'INTEGRITY_FAILED', 'Repository integrity failed', errors); return { ok: true, instanceId: this.instanceId, schemaVersion: SCHEMA_VERSION };
    } finally { db.close(); }
  }
  backupTo(targetPath) {
    this.assertCurrentFile();
    ensure(!this.inTransaction, 'ACTIVE_TRANSACTION', 'Backup must run outside a transaction'); const target = safePath(targetPath);
    ensure(!existsSync(target), 'BACKUP_EXISTS', 'Backup destination must be new'); mkdirSync(path.dirname(target), { recursive: true });
    const pending = `${target}.pending-${randomUUID()}`; const db = openDb(this.dbPath, false);
    try {
      validateDb(db, this.instanceId); db.prepare('VACUUM INTO ?').run(pending); chmodSync(pending, 0o600);
      const descriptor = openSync(pending, 'r'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const check = openInstanceRepository({ dbPath: pending, instanceId: this.instanceId, readOnly: true }).integrityCheck();
      linkSync(pending, target); return { path: target, sha256: sha256(readFileSync(target)), instanceId: this.instanceId, integrity: check, mediaIncluded: false };
    } finally { db.close(); if (existsSync(pending)) unlinkSync(pending); }
  }
  close() { /* Connections are scoped to individual read views and write units. */ }
}

export function createInstanceRepository(options) {
  if(options.backend==='postgres'||options.database?.kind==='postgres')return import('./postgres.mjs').then(m=>m.createPostgresRepository(options));
  const { dbPath, instanceId, profile, profileBytes }=options;
  ensure(!processReadOnly(), 'READ_ONLY', 'Read-only runtime cannot initialize a database');
  text(instanceId, 'instanceId'); const filename = safePath(dbPath); assertSqliteOwner(filename);
  ensure(!existsSync(filename) && !existsSync(`${filename}-wal`) && !existsSync(`${filename}-shm`), 'DATABASE_EXISTS', 'Instance initialization requires an empty target');
  mkdirSync(path.dirname(filename), { recursive: true }); const fd = openSync(filename, 'wx', 0o600); closeSync(fd);
  const db = openDb(filename, false);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
    db.prepare('INSERT INTO repository_meta VALUES(1,?,?,0,NULL,?)').run(instanceId, randomUUID(), now());
    new WriteUnit(db).putConfig({ configId: 'instance-profile', value: profile, bytes: profileBytes, expectedRevisionId: null });
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
  return openInstanceRepository({ dbPath: filename, instanceId });
}
export function openInstanceRepository(options) { return options.backend==='postgres'||options.database?.kind==='postgres' ? import('./postgres.mjs').then(m=>m.openPostgresRepository(options)) : new InstanceRepository(options); }
export function resolveInstance(instanceRoot) {
  const root = realpathSync(text(instanceRoot, 'instance root')); const bootstrapPath = path.join(root, 'instance.json');
  ensure(lstatSync(bootstrapPath).isFile() && !lstatSync(bootstrapPath).isSymbolicLink(), 'UNSAFE_BOOTSTRAP', 'Instance bootstrap must be a regular file');
  const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8'));
  if(bootstrap.schemaVersion==='2.0'){ensure(Object.keys(bootstrap).sort().join(',')==='database,instanceId,schemaVersion'&&bootstrap.database?.kind==='postgres'&&Object.keys(bootstrap.database).sort().join(',')==='database,kind,service,volume','INVALID_BOOTSTRAP','Invalid PostgreSQL locator');for(const key of ['database','service','volume'])ensure(/^[a-z][a-z0-9_-]{0,62}$/.test(bootstrap.database[key]),'INVALID_BOOTSTRAP','Invalid PostgreSQL locator identity');text(bootstrap.instanceId,'instanceId');return {root,instanceId:bootstrap.instanceId,backend:'postgres',database:bootstrap.database};}
  ensure(bootstrap.schemaVersion === '1.0' && Object.keys(bootstrap).sort().join(',') === 'database,instanceId,schemaVersion', 'INVALID_BOOTSTRAP', 'Bootstrap contains only schemaVersion, instanceId and database');
  text(bootstrap.instanceId, 'instanceId'); text(bootstrap.database, 'database');
  ensure(!path.isAbsolute(bootstrap.database) && !bootstrap.database.includes('\\') && !bootstrap.database.split('/').some((part) => !part || part === '.' || part === '..'), 'PATH_ESCAPE', 'Database path must be instance-relative');
  const dbPath = realpathSync(path.join(root, bootstrap.database)); ensure(dbPath.startsWith(root + path.sep), 'PATH_ESCAPE', 'Database escapes instance root');
  return { root, instanceId: bootstrap.instanceId, dbPath };
}
export async function restoreInstanceRepository({ backupPath, dbPath, instanceId, expectedSha256 }) {
  ensure(!processReadOnly(), 'READ_ONLY', 'Read-only runtime cannot restore a database');
  const source = safePath(backupPath); const target = safePath(dbPath); assertSqliteOwner(source); assertSqliteOwner(target); digest(expectedSha256);
  ensure(sha256(readFileSync(source)) === expectedSha256, 'BACKUP_HASH_MISMATCH', 'Backup hash mismatch');
  openInstanceRepository({ dbPath: source, instanceId, readOnly: true }).integrityCheck();
  ensure(!existsSync(target) && !existsSync(`${target}-wal`) && !existsSync(`${target}-shm`), 'RESTORE_TARGET_EXISTS', 'Restore requires a new target');
  mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(source, target, constants.COPYFILE_EXCL); chmodSync(target, 0o600);
  ensure(sha256(readFileSync(target)) === expectedSha256, 'BACKUP_CHANGED', 'Backup changed during copy');
  const repo = openInstanceRepository({ dbPath: target, instanceId });
  await repo.writeTransaction((tx) => { tx.db.prepare('UPDATE repository_meta SET runtime_epoch=?,repository_revision=repository_revision+1 WHERE singleton=1').run(restoredRuntimeEpoch(randomUUID())); });
  repo.integrityCheck(); return repo;
}

/** Import a complete, hash-bound business archive into a new instance target.
 * This is a restore of the same identity, never a clean-template operation. */
export function importRepositoryState(options) {
  if(options.backend==='postgres'||options.database?.kind==='postgres')return import('./postgres.mjs').then(m=>m.importPostgresState(options));
  const {dbPath,archive,instanceId}=options;
  ensure(!processReadOnly(), 'READ_ONLY', 'Read-only runtime cannot import a database');
  const { exportSha256, ...body } = archive;
  ensure(digest(exportSha256) === sha256(canonicalJson(body)), 'EXPORT_HASH_MISMATCH', 'Business archive was modified');
  ensure(body.schemaVersion === SCHEMA_VERSION && body.applicationId === APPLICATION_ID && body.instanceId === instanceId, 'INSTANCE_MISMATCH', 'Archive schema or instance identity mismatch');
  ensure(Object.keys(body.tables).sort().join(',') === [...exportTables].sort().join(','), 'EXPORT_TABLES_MISMATCH', 'Archive must contain the exact business table set');
  const target = safePath(dbPath); assertSqliteOwner(target); ensure(!existsSync(target) && !existsSync(`${target}-wal`) && !existsSync(`${target}-shm`), 'RESTORE_TARGET_EXISTS', 'Archive import requires a new target');
  mkdirSync(path.dirname(target), { recursive: true }); const fd = openSync(target, 'wx', 0o600); closeSync(fd); const db = openDb(target, false);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
    for (const table of exportTables) {
      const fields = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      const statement = db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`);
      ensure(Array.isArray(body.tables[table]), 'EXPORT_TABLES_MISMATCH', 'Archive table must be an array');
      for (const row of body.tables[table]) {
        ensure(Object.keys(row).sort().join(',') === [...fields].sort().join(','), 'EXPORT_ROW_MISMATCH', 'Archive row columns differ');
        statement.run(...fields.map((key) => { const value = row[key]; if (!value || typeof value !== 'object') return value; ensure(value.encoding === 'base64' && typeof value.bytes === 'string', 'EXPORT_BYTES_MISMATCH', 'Invalid archive byte record'); const bytes = Buffer.from(value.bytes, 'base64'); ensure(bytes.toString('base64') === value.bytes, 'EXPORT_BYTES_MISMATCH', 'Invalid base64'); return bytes; }));
      }
    }
    for (const item of body.sequence || []) {
      ensure(item.name === 'domain_events' && Number.isSafeInteger(item.seq) && item.seq >= 0, 'EXPORT_SEQUENCE_MISMATCH', 'Invalid event high-water mark');
      const actual = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(item.name);
      ensure(!actual || actual.seq <= item.seq, 'EXPORT_SEQUENCE_MISMATCH', 'Event high-water mark precedes existing rows');
      if (actual) db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(item.seq, item.name);
      else db.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(item.name, item.seq);
    }
    db.prepare('UPDATE repository_meta SET runtime_epoch=?,repository_revision=repository_revision+1 WHERE singleton=1').run(restoredRuntimeEpoch(randomUUID()));
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } finally { db.close(); }
  const repository = openInstanceRepository({ dbPath: target, instanceId }); repository.integrityCheck(); return repository;
}
