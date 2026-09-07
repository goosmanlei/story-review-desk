#!/usr/bin/env node
/** Explicit, one-way legacy import. Never changes the source or activates a service. */
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstanceRepository, canonicalJson, sha256 } from '../host/instance-runtime/index.mjs';

const FORMAL_KINDS = new Set(['review', 'episode-plan-submission', 'run', 'asset-version', 'creative-revision', 'execution-request', 'source-operation', 'verification', 'script-comment']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.txt', '.csv', '.srt', '.vtt', '.py', '.toml']);
const GUIDE_DOCUMENTS = new Set(['README.md', 'AGENTS.md', 'STATE.md']);
const TRIAL_TABLES = { meta: 'key', recipes: 'id', executions: 'id', reservations: 'id', assets: 'id', events: 'sequence', idempotency: 'key' };
const ignoredTransient = (name) => name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('.lock') || name.endsWith('.tmp');
const transientHealth = (namespace, key) => namespace === 'assistant-public' && key === 'health.json';
const credentialFile = (name) => /^(auth\.json|credentials?(\..*)?|secrets?(\..*)?|\.env(\..*)?|config\.toml)$/i.test(name);
const mime = (p) => ({ '.md': 'text/markdown', '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.txt': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' }[path.extname(p).toLowerCase()] || 'application/octet-stream');
const must = (value, message) => { if (!value) throw new Error(message); };
const fingerprint = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
async function confined(root, relative) {
  must(typeof relative === 'string' && relative && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.split('/').some((p) => !p || p === '.' || p === '..'), `Unsafe source alias: ${relative}`);
  const resolved = await realpath(path.join(root, relative)); must(resolved.startsWith(root + path.sep), `Source escapes selected root: ${relative}`);
  must((await lstat(resolved)).isFile(), `Source is not a regular file: ${relative}`); return resolved;
}
async function hashFile(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function capture(root, relative, includeBytes = false) {
  const file = await confined(root, relative); const before = await stat(file, { bigint: true });
  const bytes = includeBytes ? await readFile(file) : null; const hash = bytes ? sha256(bytes) : await hashFile(file);
  const after = await stat(file, { bigint: true }); must(fingerprint(before) === fingerprint(after), `Source changed while reading: ${relative}`);
  return { path: relative, absolutePath: file, sha256: hash, byteSize: Number(after.size), fingerprint: fingerprint(after), ...(bytes ? { bytes } : {}) };
}
async function walk(root, relative, { optional = true } = {}) {
  must(relative && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.split('/').some((part) => !part || part === '.' || part === '..'), `Unsafe source directory: ${relative}`);
  const directory = path.join(root, relative); let entries;
  try { must(!(await lstat(directory)).isSymbolicLink(), `Source directory is a symlink: ${relative}`); const actual = await realpath(directory); must(actual.startsWith(root + path.sep), `Source directory escapes root: ${relative}`); entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (optional && error.code === 'ENOENT') return []; throw error; }
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (credentialFile(entry.name) || ignoredTransient(entry.name)) continue;
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Source contains a symlink requiring explicit classification: ${file}`);
    if (entry.isDirectory()) output.push(...await walk(root, file)); else if (entry.isFile()) output.push(file);
  }
  return output;
}
function captureTrialRows(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x) => x.name);
    must(canonicalJson(names) === canonicalJson(Object.keys(TRIAL_TABLES).sort()), 'Trial database contains unknown or missing tables');
    const tables = Object.fromEntries(Object.entries(TRIAL_TABLES).map(([table, primary]) => [table, db.prepare(`SELECT rowid AS importer_rowid,* FROM ${table} ORDER BY rowid`).all().map((raw) => { const { importer_rowid, ...row } = raw; return { row, sourceRowid: importer_rowid, key: String(row[primary]) }; })]));
    const sequence = db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all();
    const config = JSON.parse(tables.meta.find((entry) => entry.row.key === 'config')?.row.value || '{}');
    must(config.mode === 'LOCAL_TRIAL' && config.scope?.id && config.scope.countsTowardFormalProject === false, 'Trial authority scope is missing or unsafe');
    let previous = '0'.repeat(64);
    for (const { row } of tables.events) {
      const parsed = JSON.parse(row.body);
      must(row.previous_hash === previous && parsed.previousHash === previous && row.hash === sha256(canonicalJson(parsed)), 'Trial immutable event chain mismatch');
      previous = row.hash;
    }
    db.exec('COMMIT'); return { config, tables, sequence, rowsHash: sha256(canonicalJson({ tables, sequence })) };
  } finally { db.close(); }
}
async function sqliteBackup(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const code = 'import sqlite3,sys,pathlib\nsrc=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True)\ndst=sqlite3.connect(sys.argv[2])\nsrc.backup(dst)\nassert dst.execute("PRAGMA integrity_check").fetchone()[0]=="ok"\ndst.close();src.close()\n';
  const result = spawnSync('python3', ['-B', '-c', code, source, destination], { encoding: 'utf8' });
  must(result.status === 0, `Read-only SQLite backup failed: ${path.basename(source)}`);
}

export async function planInstanceImport(options) {
  const root = await realpath(options.projectRoot); const profileBytes = await readFile(options.profileFile); const profile = JSON.parse(profileBytes);
  must(profile.schemaVersion === '1.0' && profile.instanceId && profile.projectId && profile.episodePlanId, 'Explicit instance profile identity required');
  const snapshotPath = options.snapshot || 'review-site/app/review-data.generated.json';
  const recipesPath = options.recipes || 'review-site/data/review-recipes.generated.json';
  const eventDirectory = options.events || 'production/00_control/review_site_store/events';
  const assistantPublic = options.assistantPublic || `${eventDirectory}/.codex-conversations`;
  const assistantPrivate = options.assistantPrivate || 'production/00_control/review_site_store/codex_sdk_state';
  const snapshotFile = await capture(root, snapshotPath, true); const recipesFile = await capture(root, recipesPath, true);
  const snapshot = JSON.parse(snapshotFile.bytes); const recipes = JSON.parse(recipesFile.bytes);
  must(snapshot.snapshotId && snapshot.snapshotId === recipes.snapshotId && Array.isArray(recipes.sourceCatalog), 'Snapshot and recipe catalog do not match');
  const entries = new Map(); const issues = []; const rebases = [];
  for (const source of recipes.sourceCatalog) {
    must(source.path, 'Source catalog entry has no path'); const old = entries.get(source.path);
    must(!old || old.sha256 === source.sha256, `Conflicting source hashes: ${source.path}`); entries.set(source.path, source);
  }
  for (const source of Object.values(snapshot.storySources || {})) if (source?.sourcePath) entries.set(source.sourcePath, { ...entries.get(source.sourcePath), ...source, path: source.sourcePath });
  for (const name of GUIDE_DOCUMENTS) if (!entries.has(name)) entries.set(name, { path: name, role: 'INSTANCE_GUIDANCE' });
  for (const directory of ['data', 'docs', 'production/00_control/registries', 'production/prompts/direct', 'scripts']) {
    for (const name of await walk(root, directory)) if (TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) && !entries.has(name)) entries.set(name, { path: name, role: 'ADDITIONAL_BUSINESS_SOURCE' });
  }
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.md') && !entries.has(entry.name)) entries.set(entry.name, { path: entry.name, role: 'PROJECT_DOCUMENT' });
  const sources = [];
  for (const entry of [...entries.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    try {
      const item = await capture(root, entry.path, TEXT_EXTENSIONS.has(path.extname(entry.path).toLowerCase()));
      const mismatch = entry.sha256 && entry.sha256 !== item.sha256;
      const metadata = { ...entry, legacyExpectedSha256: entry.sha256 || null, actualSha256: item.sha256,
        sourceRole: entry.path.startsWith('scripts/') && entry.path.endsWith('.py') ? 'INSTANCE_EXTENSION' : entry.path.startsWith('production/prompts/direct/') && entry.path.endsWith('.md') ? 'DIRECT_PROMPT' : entry.role || 'SOURCE_DOCUMENT',
        migrationRebase: mismatch && GUIDE_DOCUMENTS.has(entry.path) ? 'GUIDANCE_REBASE_TO_ACTUAL_BYTES' : null };
      if (mismatch) (GUIDE_DOCUMENTS.has(entry.path) ? rebases : issues).push({ code: 'SOURCE_HASH_MISMATCH', path: entry.path, legacyExpectedSha256: entry.sha256, actualSha256: item.sha256 });
      sources.push({ ...item, metadata });
    } catch (error) { issues.push({ code: 'SOURCE_UNAVAILABLE', path: entry.path, reason: error.message }); }
  }
  const eventPaths = (await readdir(path.join(root, eventDirectory), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => `${eventDirectory}/${entry.name}`).sort();
  const events = [];
  for (const relative of eventPaths) { const item = await capture(root, relative, true); const event = JSON.parse(item.bytes); must(FORMAL_KINDS.has(event.eventKind) && event.eventId && event.recordedAt, `Unclassified top-level event: ${relative}`); events.push({ ...item, event }); }
  const auxiliary = []; const auxiliaryDirectories = [];
  for (const [namespace, directory] of [['assistant-public', assistantPublic], ['assistant-private', assistantPrivate]]) {
    const paths = await walk(root, directory, { optional: false }); auxiliaryDirectories.push({ namespace, directory, paths });
    for (const relative of paths) {
      const key = relative.slice(directory.length + 1); const isSqlite = ['.sqlite', '.db'].includes(path.extname(relative));
      auxiliary.push({ namespace, key, ...(await capture(root, relative, !isSqlite)), isSqlite, transientHealth: transientHealth(namespace, key) });
    }
  }
  const assets = [...(snapshot.productionModel?.assetVersions || []), ...events.filter((item) => item.event.eventKind === 'asset-version').map(({ event }) => ({ ...event, id: event.versionId, sha256: event.sha256, path: event.path || event.projectPath }))];
  const media = []; const seen = new Map();
  for (const version of assets) {
    if (!version.id || !version.familyId || !/^[a-f0-9]{64}$/.test(version.sha256 || '')) continue;
    const key = `${version.familyId}\0${version.id}`; const prior = seen.get(key);
    must(!prior || prior.sha256 === version.sha256, `Conflicting media version: ${version.id}`); if (prior) continue; seen.set(key, version);
    let file;
    try { if (version.path) file = await capture(root, version.path); } catch { /* Missing history is explicitly recorded below. */ }
    const available = file && file.sha256 === version.sha256;
    if (!available && (version.historyRole === 'CURRENT' || version.lifecycleState === 'RELEASED')) issues.push({ code: 'CURRENT_MEDIA_UNAVAILABLE', versionId: version.id, path: version.path });
    media.push({ version, file: available ? file : null, availability: available ? 'PRESENT' : 'MISSING_HISTORY' });
  }
  let trial = null;
  const trialRelative = options.trial || 'workspaces/review-foundation/pilot/local-trial/trial.sqlite';
  try { const file = await confined(root, trialRelative); trial = { file, path: trialRelative, ...captureTrialRows(file) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (trial) for (const item of trial.tables.assets) {
    const asset = JSON.parse(item.row.body); const relative = asset.file || asset.relativePath || asset.path;
    try {
      must(relative && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.split('/').some((part) => !part || part === '.' || part === '..'), 'Invalid trial media relative path');
      const file = await capture(root, path.posix.join(path.posix.dirname(trial.path), relative));
      must(file.sha256 === item.row.sha256, 'Trial registered media SHA does not match file'); item.asset = asset; item.file = file;
    } catch (error) { issues.push({ code: 'TRIAL_MEDIA_UNAVAILABLE', assetId: item.key, reason: error.message }); }
  }
  // Proxies and trial attachments are files, but cannot become independent
  // lifecycle facts. Preserve their aliases and hashes as evidence artifacts.
  const evidenceMedia = [];
  const extraPaths = new Set(await walk(root, 'review-site/public/media'));
  if (trial) {
    const pilotRoot = path.posix.dirname(path.posix.dirname(trialRelative));
    for (const dir of ['audio-preparation', 'references', 'artifacts/_review_pending', 'production/generated']) for (const name of await walk(root, `${pilotRoot}/${dir}`)) extraPaths.add(name);
    for (const item of [trial.config.candidate, trial.config.approvalEvidence, trial.config.preparationEvidence]) if (item?.path) extraPaths.add(item.path);
    for (const { row } of trial.tables.recipes) for (const binding of JSON.parse(row.body).sourceBindings || []) if (binding.path) extraPaths.add(binding.path);
    for (const { row } of trial.tables.events) { const evidence = JSON.parse(row.body).payload?.evidence; if (evidence?.path) extraPaths.add(evidence.path); }
  }
  const recordedSources = new Set(sources.map((item) => item.path));
  for (const relative of [...extraPaths].sort()) {
    if (recordedSources.has(relative)) continue;
    const item = await capture(root, relative, TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()));
    if (item.bytes) { sources.push({ ...item, metadata: { sourceRole: 'IMPORTED_EVIDENCE', authorityDomain: relative.startsWith('review-site/public/') ? 'DERIVED_MEDIA' : 'LOCAL_TRIAL' } }); recordedSources.add(relative); }
    else evidenceMedia.push({ ...item, aliases: [relative, ...(relative.startsWith('review-site/public/') ? [`/${relative.slice('review-site/public/'.length)}`] : [])] });
  }
  const report = { schemaVersion: '1.0', mode: 'ONE_WAY_INSTANCE_IMPORT', sourceWriteCount: 0, instanceId: profile.instanceId, snapshotId: snapshot.snapshotId,
    counts: { sources: sources.length, formalEvents: events.length, registeredMedia: media.length, presentMedia: media.filter((x) => x.file).length, assistantAuxiliary: auxiliary.length,
      evidenceMedia: evidenceMedia.length, trialTables: trial ? Object.fromEntries(Object.entries(trial.tables).map(([key, value]) => [key, value.length])) : null },
    assistantSources: auxiliaryDirectories.map(({ namespace, directory, paths }) => ({ namespace, directory, count: paths.length })),
    rebases, issues, readyForImport: issues.length === 0, cutoverPerformed: false, cutoverReady: false };
  return { root, profile, profileBytes, snapshotFile, recipesFile, snapshot, recipes, sources, events, eventPaths, eventDirectory, auxiliary, auxiliaryDirectories, media, evidenceMedia, trial, report };
}

export async function importInstance(plan, { instance }) {
  must(plan.report.readyForImport, 'Business source conflicts must be resolved before import; inspect dry-run issues');
  const destination = path.resolve(instance); must(destination !== plan.root, 'Instance target cannot be the legacy root');
  for (let part = destination; path.dirname(part) !== part; part = path.dirname(part)) { try { must(!(await lstat(part)).isSymbolicLink(), `Instance target has symlink ancestor: ${part}`); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  await mkdir(path.dirname(destination), { recursive: true }); await mkdir(destination, { mode: 0o700 });
  const repository = createInstanceRepository({ dbPath: path.join(destination, 'data', 'review.sqlite'), instanceId: plan.profile.instanceId, profile: plan.profile, profileBytes: plan.profileBytes });
  const copied = new Map(); const archiveRows = [];
  async function copyBlob(file, extra = {}) {
    const suffix = path.extname(file.path).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
    const relativePath = `media/blobs/${file.sha256}${suffix}`;
    if (!copied.has(relativePath)) {
      const target = path.join(destination, relativePath); await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file.absolutePath, target, constants.COPYFILE_EXCL);
      must(await hashFile(target) === file.sha256 && (await stat(target)).size === file.byteSize, `Media copy changed: ${file.path}`); copied.set(relativePath, file.sha256);
    }
    return { relativePath, ...extra };
  }
  try {
    for (const item of plan.media) if (item.file) item.managed = await copyBlob(item.file);
    for (const source of plan.sources) if (!source.bytes) source.managed = await copyBlob(source);
    for (const file of plan.evidenceMedia) file.managed = await copyBlob(file);
    for (const item of plan.auxiliary) if (item.isSqlite) {
      const target = path.join(destination, 'media', 'archive', 'assistant-private', item.key);
      await sqliteBackup(item.absolutePath, target); const bytes = await readFile(target);
      item.bytes = bytes; item.archiveSha256 = sha256(bytes); archiveRows.push({ namespace: item.namespace, key: item.key, sha256: item.archiveSha256, consistentSqliteBackup: true });
    }
    if (plan.trial) {
      const target = path.join(destination, 'media', 'archive', 'local-trial', 'trial.sqlite'); await sqliteBackup(plan.trial.file, target);
      must(captureTrialRows(target).rowsHash === plan.trial.rowsHash, 'Trial changed between capture and consistent backup');
      plan.trial.archiveSha256 = await hashFile(target);
      for (const item of plan.trial.tables.assets) item.managed = await copyBlob(item.file);
    }
    for (const file of [plan.snapshotFile, plan.recipesFile, ...plan.sources, ...plan.events, ...plan.evidenceMedia, ...plan.auxiliary.filter((x) => !x.isSqlite && !x.transientHealth)]) {
      must(fingerprint(await stat(file.absolutePath, { bigint: true })) === file.fingerprint, `Source changed after capture: ${file.path}`);
    }
    for (const { namespace, directory, paths } of plan.auxiliaryDirectories) {
      const stable = (files) => files.filter((file) => !transientHealth(namespace, file.slice(directory.length + 1)));
      must(canonicalJson(stable(await walk(plan.root, directory, { optional: false }))) === canonicalJson(stable(paths)), `Assistant file set changed during import: ${directory}`);
    }
    const finalEvents = (await readdir(path.join(plan.root, plan.eventDirectory), { withFileTypes: true })).filter((x) => x.isFile() && x.name.endsWith('.json')).map((x) => `${plan.eventDirectory}/${x.name}`).sort();
    must(canonicalJson(finalEvents) === canonicalJson(plan.eventPaths), 'Formal event set changed during import');
    await repository.writeTransaction((tx) => {
      const revisions = [];
      for (const source of plan.sources) {
        if (source.bytes) revisions.push(tx.putDocument({ documentId: `legacy-source:${source.path}`, bytes: source.bytes, mediaType: mime(source.path), aliases: [source.path], metadata: source.metadata, expectedRevisionId: null }).revisionId);
        else tx.registerMedia({ mediaId: `source-artifact:${source.path}`, versionId: `source-artifact:${source.path}@${source.sha256}`, ...source.managed, sha256: source.sha256, byteSize: source.byteSize,
          aliases: [source.path, ...(source.path === plan.snapshot.storySources?.audio?.sourcePath ? ['/review-audio/story-source.mp3'] : [])], metadata: { ...source.metadata, evidenceOnly: true } });
      }
      for (const event of plan.events) tx.importEvent({ bytes: event.bytes, sourceRef: { path: event.path, sha256: event.sha256 }, authorityDomain: 'FORMAL' });
      for (const item of plan.media) tx.registerMedia({ mediaId: item.version.familyId, versionId: item.version.id, relativePath: item.managed?.relativePath || null, sha256: item.version.sha256,
        byteSize: item.file?.byteSize || item.version.byteSize || 0, availability: item.availability, aliases: [item.version.id, ...(item.version.path ? [item.version.path] : [])], metadata: { legacyVersion: item.version, authorityDomain: 'FORMAL' } });
      for (const file of plan.evidenceMedia) tx.registerMedia({ mediaId: `evidence-artifact:${file.path}`, versionId: `evidence-artifact:${file.path}@${file.sha256}`, ...file.managed,
        sha256: file.sha256, byteSize: file.byteSize, aliases: file.aliases, metadata: { evidenceOnly: true, authorityDomain: 'IMPORTED_EVIDENCE', sourcePath: file.path } });
      for (const item of plan.auxiliary) tx.putAux({ namespace: item.transientHealth ? 'assistant-runtime-history' : item.namespace, key: item.key, bytes: item.bytes, expectedRevisionId: null, mediaType: mime(item.path),
        metadata: { legacyPath: item.path, legacySha256: item.sha256, ...(item.transientHealth ? { legacyNamespace: item.namespace, stale: true, notActiveHealth: true } : {}), ...(item.isSqlite ? { archivedProviderState: true, consistentBackupSha256: item.archiveSha256, notActiveBusinessDatabase: true } : {}) } });
      if (plan.trial) {
        const scopeId = plan.trial.config.scope.id; const namespace = `local-trial:${scopeId}`;
        for (const [table, rows] of Object.entries(plan.trial.tables)) for (const item of rows) tx.putAux({ namespace, key: `${table}/${item.key}`, bytes: JSON.stringify(item.row), expectedRevisionId: null, mediaType: 'application/json',
          metadata: { sourceTable: table, sourcePrimaryKey: item.key, sourceRowid: item.sourceRowid, authorityDomain: 'LOCAL_TRIAL', deliveryScopeId: scopeId, legacyDatabaseSha256: plan.trial.archiveSha256 } });
        tx.putAux({ namespace, key: '_schema/sqlite_sequence', bytes: JSON.stringify(plan.trial.sequence), expectedRevisionId: null });
        tx.putAux({ namespace: 'local-trial-index', key: 'scopes', bytes: JSON.stringify([scopeId]), expectedRevisionId: null });
        for (const { row } of plan.trial.tables.events) tx.importEvent({ bytes: row.body, authorityDomain: 'LOCAL_TRIAL', sourceRef: { scopeId, sequence: row.sequence, previousHash: row.previous_hash, hash: row.hash } });
        for (const item of plan.trial.tables.assets) tx.registerMedia({ mediaId: item.row.media_id, versionId: item.row.version_id, relativePath: item.managed.relativePath, sha256: item.row.sha256, byteSize: item.file.byteSize,
          aliases: [item.row.id, item.row.version_id, item.file.path], metadata: { authorityDomain: 'LOCAL_TRIAL', deliveryScopeId: scopeId, legacyAssetId: item.row.id } });
      }
      tx.putAux({ namespace: 'migration', key: 'import-report', bytes: JSON.stringify({ ...plan.report, archiveRows, importedAt: new Date().toISOString(), managedMediaCount: copied.size }), expectedRevisionId: null });
      tx.publishRelease({ snapshotBytes: plan.snapshotFile.bytes, recipesBytes: plan.recipesFile.bytes, expectedReleaseId: null, sourceRevisionIds: revisions });
    });
    repository.integrityCheck();
    await writeFile(path.join(destination, 'instance.json'), JSON.stringify({ schemaVersion: '1.0', instanceId: plan.profile.instanceId, database: 'data/review.sqlite' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const report = { ...plan.report, imported: true, repositoryRevision: repository.readView().repositoryRevision, managedMediaCount: copied.size, integrity: repository.integrityCheck(), sourceWriteCount: 0 };
    await writeFile(path.join(destination, 'migration-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); return report;
  } catch (error) {
    await writeFile(path.join(destination, 'import-failed.json'), JSON.stringify({ imported: false, cutoverReady: false, sourceWriteCount: 0, reason: error.message }, null, 2) + '\n', { flag: 'wx' }); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {}; const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) { const key = args[i]; must(key.startsWith('--'), 'Expected named arguments'); if (key === '--dry-run') options.dryRun = true; else { must(args[i + 1], `Value required: ${key}`); options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = args[++i]; } }
  try {
    must(options.projectRoot && options.instance && options.profileFile, '--project-root, --instance and --profile-file are required');
    const plan = await planInstanceImport(options); const result = options.dryRun ? plan.report : await importInstance(plan, options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (!result.readyForImport) process.exitCode = 2;
  } catch (error) { process.stderr.write(JSON.stringify({ error: error.message, sourceWriteCount: 0, cutoverPerformed: false }) + '\n'); process.exitCode = 1; }
}
