import { nativeMaterialCandidateProof, assertNativeCandidatePreservation } from './instance-native-candidate-proof.mjs';
import {legacyAudioCandidateProof,assertLegacyAudioCandidatePreservation} from './instance-legacy-audio-candidate-proof.mjs';
import { registeredMaterialCandidateProof } from './instance-registered-material-candidates.mjs';
import { assertSourceMediaReadScope, materializeSourceMedia } from './instance-source-media.mjs';
import { preserveConfigurationProjection } from './instance-runtime/configuration-service.mjs';
import { preserveDomainProjection } from './instance-runtime/domain-projection.mjs';
import {preserveScopedProductionProjection} from './instance-runtime/scoped-production-projection.mjs';
import {preserveShotProductionProjection,preserveShotRecipeProjection} from './instance-runtime/shot-production-preservation.mjs';
import {preserveMaterialProductionProjection,preserveMaterialProductionRequirementProvenance} from './instance-runtime/material-production-preservation.mjs';
import {preserveProductionSpatialProjection} from './instance-runtime/spatial-production.mjs';
import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, lstat, readFile, writeFile, rm, open, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { canonicalJson, sha256 } from './instance-runtime/index.mjs';
import { requireSource } from './instance-source-proof.mjs';
import { invokePinnedMapProxyReuse } from './instance-map-proxy-adapter.mjs';
import { invokeInstanceSemanticQa } from './instance-semantic-qa-adapter.mjs';
import { assertSourceProxyBindingPreservation } from './instance-source-proxy-binding.mjs';
import { normalizeRetiredProductionEvidence } from './instance-retired-production.mjs';
import { validateModernEventsInChild } from './instance-modern-event-bridge.mjs';

export function sourceRelative(value) {
  requireSource(typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').includes('..') && value !== '.', 'SOURCE_PATH', 'A normalized instance-relative path is required');
  return value;
}

const entryNames = {
  workflowPath: 'review_workflow.py', storyQaPath: 'qa_story_structure_v2.py',
  registryBuilderPath: 'build_production_control_registries.py', snapshotBuilderPath: 'build_review_site_data.py', semanticQaPath: 'qa_review_site_v8.py',
};
export function validateCompiler(compiler, documents) {
  requireSource(compiler && typeof compiler === 'object', 'COMPILER_REQUIRED', 'Manifest must explicitly identify the imported compiler entry points and output paths');
  const revisions = {};
  for (const [role, name] of Object.entries(entryNames)) {
    const alias = sourceRelative(compiler[role]); const document = documents.find((row) => row.aliases.includes(alias));
    requireSource(document?.metadata.sourceRole === 'INSTANCE_EXTENSION' && path.posix.basename(alias) === name, 'COMPILER_NOT_PINNED', `Compiler ${role} is not an approved imported extension in this release`);
    revisions[role] = { path: alias, revisionId: document.revisionId, sha256: document.sha256 };
  }
  for (const field of ['snapshotPath', 'recipesPath', 'eventDirectory']) sourceRelative(compiler[field]);
  requireSource(compiler.snapshotPath !== compiler.recipesPath, 'COMPILER_OUTPUT', 'Snapshot and recipe outputs must be distinct');
  return revisions;
}

async function checkedBytes(root, relative, hash) {
  const rootReal = await realpath(root); const target = path.join(rootReal, sourceRelative(relative));
  let cursor = rootReal;
  for (const part of relative.split('/')) { cursor = path.join(cursor, part); requireSource(!(await lstat(cursor)).isSymbolicLink(), 'SOURCE_SYMLINK', `Instance media path contains a symbolic link: ${relative}`); }
  const resolved = await realpath(target);
  requireSource(resolved.startsWith(rootReal + path.sep) && (await lstat(resolved)).isFile(), 'SOURCE_PATH', 'Media must be a regular file inside this instance');
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const bytes = await handle.readFile(); requireSource(sha256(bytes) === hash, 'SOURCE_MEDIA_HASH', `Media bytes differ: ${relative}`); return bytes; } finally { await handle.close(); }
}

function python(root, code, args, timeoutMs = 900_000) {
  return new Promise((resolve, reject) => {
    // Imported extensions receive no provider credentials, host home, or old project root.
    const child = spawn('python3', ['-B', '-I', '-c', code, ...args], { cwd: root, env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let finished = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-32_000); });
    child.on('error', (error) => { finished = true; clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); if (finished) return; if (code !== 0) reject(new Error(`Instance compiler failed (${code ?? signal}): ${output}`)); else resolve({ returnCode: 0, outputSha256: sha256(output) }); });
  });
}
const invokeScript = 'import sys,runpy; from pathlib import Path; p=Path(sys.argv[1]); sys.path.insert(0,str(p.parent)); sys.argv=sys.argv[1:]; runpy.run_path(str(p),run_name="__main__")';
// Disposable, hash-pinned inputs have no filesystem chronology. Equal timestamps
// keep database alias order from invalidating already verified review proxies.
const materializedInputTimestamp = 946684800;
const invokeWorkflow = `import sys,json,importlib.util
from pathlib import Path
root=Path.cwd(); p=root/sys.argv[1]; sys.path.insert(0,str(p.parent))
spec=importlib.util.spec_from_file_location("instance_review_workflow",p); w=importlib.util.module_from_spec(spec); sys.modules[spec.name]=w; spec.loader.exec_module(w)
w.CREATIVE_REVISION_SOURCE_PATH_BY_SUBJECT_KIND=json.loads(sys.argv[4])
m,changes=w.prepare_manifest(root,root/sys.argv[2]) if sys.argv[3]=="prepare" else (json.loads((root/sys.argv[2]).read_text()),[])
if sys.argv[3]=="prepare":
 for change in changes: w.write_project_change(root,change)
else: w.validate_prospective_creative_revision_binding(json.loads((root/sys.argv[5]).read_text()),m)
`;

/** Materialize only release-pinned records. Never consult a legacy project directory. */
export async function compileInstanceSource(input) { return compilePinnedInstance(input, 'SOURCE_SYNC'); }
export async function compileInstanceExtension(input) { return compilePinnedInstance(input, 'EXTENSION_COMPATIBILITY'); }
async function compilePinnedInstance({ instanceRoot, documents, activeMedia, retiredMedia, retiredContactMedia, mediaReadScope, events, manifest, profile, baseRelease }, mode) {
  await assertSourceMediaReadScope(mediaReadScope);
  validateCompiler(manifest.compiler, documents);
  const scratchParent = path.join(await realpath(instanceRoot), 'scratch');
  try { requireSource(!(await lstat(scratchParent)).isSymbolicLink(), 'SOURCE_SYMLINK', 'Instance scratch directory cannot be a link'); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(scratchParent); }
  const scratch = await mkdtemp(path.join(scratchParent, 'source-'));
  const occupied = new Map();
  const materializedDocuments = new Map();
  const pinnedMediaHashes = {};
  const pinnedDocumentHashes = {};
  const put = async (relative, bytes, { replace = false } = {}) => {
    sourceRelative(relative); const digest = sha256(bytes);
    requireSource(replace || !occupied.has(relative) || occupied.get(relative) === digest, 'SOURCE_ALIAS_AMBIGUOUS', `Multiple revisions claim compiler path: ${relative}`);
    occupied.set(relative, digest); const target = path.join(scratch, relative);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: replace ? 'w' : 'w' });
    await utimes(target, materializedInputTimestamp, materializedInputTimestamp);
  };
  try {
    for (const document of documents) {
      requireSource(document && !document.deleted && sha256(document.bytes) === document.sha256, 'SOURCE_REVISION_MISSING', 'A pinned source revision is unavailable');
      // Unadopted authoring evidence cannot shadow a source/config imported by Python.
      // It remains materialized and hash-checked, under a separate evidence directory.
      const unadopted = document.metadata.authoringEntry === 'EXPLICIT_HOST_CLI' && document.metadata.reviewState === 'DRAFT' && document.metadata.sourceRole !== 'INSTANCE_GUIDANCE' && !document.metadata.sourceOperationId;
      const aliases = unadopted ? [`.instance-drafts/${sha256(document.documentId)}.txt`] : document.aliases.filter((alias) => !alias.startsWith('legacy-source:') && !alias.includes('://'));
      requireSource(aliases.length, 'SOURCE_ALIAS_MISSING', `Pinned document has no compiler alias: ${document.documentId}`);
      for (const alias of aliases) { await put(alias, document.bytes); pinnedDocumentHashes[alias] = document.sha256; }
      materializedDocuments.set(document.documentId, aliases);
    }
    Object.assign(pinnedMediaHashes, await materializeSourceMedia({ activeMedia, mediaReadScope,
      readBytes: row => checkedBytes(instanceRoot, row.relativePath, row.sha256), put }));
    // Compiler compatibility files are disposable views of the same DB authority.
    await put(manifest.compiler.snapshotPath, baseRelease.snapshotBytes, { replace: true });
    await put(manifest.compiler.recipesPath, baseRelease.recipesBytes, { replace: true });
    const eventPaths = new Set();
    for (const event of events) {
      requireSource(/^[A-Za-z0-9._:-]+$/.test(event.eventId) && /^[a-z0-9-]+$/.test(event.eventKind), 'SOURCE_EVENT_ID', 'Unsafe compiler event identity');
      requireSource(/^[a-f0-9]{64}$/.test(event.idempotencyKeyHash), 'SOURCE_EVENT_IDEMPOTENCY', 'Compiler event requires its original idempotency hash');
      const eventPath = `${manifest.compiler.eventDirectory}/${event.eventKind}-${event.idempotencyKeyHash}.json`;
      requireSource(!eventPaths.has(eventPath), 'SOURCE_EVENT_COLLISION', 'Compiler event filename must be unique');
      eventPaths.add(eventPath);
      await put(eventPath, canonicalJson(event));
    }
    const manifestPath = '.instance-source-manifest.json';
    requireSource(!occupied.has(manifestPath), 'SOURCE_COLLISION', 'Reserved compiler manifest path is occupied');
    await put(manifestPath, canonicalJson(manifest));
    const mapPinsPath = '.instance-map-proxy-pins.json';
    const mapReportPath = '.instance-map-proxy-report.json';
    const semanticReportPath = '.instance-semantic-qa-report.json';
    requireSource(!occupied.has(mapPinsPath) && !occupied.has(mapReportPath) && !occupied.has(semanticReportPath), 'SOURCE_COLLISION', 'Reserved map adapter paths are occupied');
    const publishedSnapshot = JSON.parse(baseRelease.snapshotBytes);
    const nativeCandidateProof = nativeMaterialCandidateProof({documents,events,activeMedia,pinnedMediaHashes,baseRelease,compiler:manifest.compiler});
    const legacyAudioProof = legacyAudioCandidateProof({documents,events,activeMedia,pinnedMediaHashes,baseRelease,compiler:manifest.compiler});
    const registeredCandidateProof = registeredMaterialCandidateProof({documents,events,activeMedia,pinnedMediaHashes,baseRelease,compiler:manifest.compiler});
    const modernEventProof = await validateModernEventsInChild({ events, baseRelease, eventDirectory: manifest.compiler.eventDirectory });
    const retiredAliases = new Set((retiredMedia || []).flatMap(row => row.registration.aliases));
    const retiredVersions = (publishedSnapshot.productionModel?.assetVersions || []).filter(row => retiredAliases.has(row.path));
    const retiredFamilyIds = new Set(retiredVersions.map(row => row.familyId));
    const retiredProductionEvidence = normalizeRetiredProductionEvidence({ schemaVersion: '1.0', releaseId: baseRelease.releaseId, snapshotSha256: sha256(baseRelease.snapshotBytes), recipesSha256: sha256(baseRelease.recipesBytes), media: retiredMedia || [],
      audioAssets: (publishedSnapshot.audioAssets || []).filter(row => retiredAliases.has(row.path)),
      historicalInvalidationCounts: JSON.parse(baseRelease.recipesBytes).counts || {},
      families: (publishedSnapshot.productionModel?.assetFamilies || []).filter(row => retiredFamilyIds.has(row.id)), versions: retiredVersions,
      sources: (JSON.parse(baseRelease.recipesBytes).sourceCatalog || []).filter(row => retiredAliases.has(row.path)) }, { canonicalJson, sha256, requireSource });
    const historicalEvidence = { releaseId: baseRelease.releaseId, snapshotSha256: sha256(baseRelease.snapshotBytes), priorBindings: { storyRewrite: publishedSnapshot.storyRewrite?.prior_script_evidence ?? null, characterPerformance: publishedSnapshot.characterPerformance?.prior_script_evidence ?? null }, catalog: publishedSnapshot.productionModel?.reviewContextCatalog?.evidenceCatalog || {} };
    historicalEvidence.guidanceBindings = documents.filter(row => row.aliases.length === 1 && ['README.md', 'AGENTS.md', 'STATE.md'].includes(row.aliases[0]) && row.metadata?.migrationRebase === 'GUIDANCE_REBASE_TO_ACTUAL_BYTES').map(({ documentId, revisionId, sha256: digest, aliases, metadata }) => {
      const binding = { documentId, revisionId, sha256: digest, aliases, metadata };
      return { ...binding, bindingHash: sha256(canonicalJson(binding)) };
    });
    const productionReferences = { releaseId: baseRelease.releaseId, snapshotSha256: sha256(baseRelease.snapshotBytes), families: (publishedSnapshot.productionModel?.assetFamilies || []).filter(row => row.assetRole === 'PRODUCTION_REFERENCE'), versions: (publishedSnapshot.productionModel?.assetVersions || []).filter(row => row.assetRole === 'PRODUCTION_REFERENCE') };
    await put(mapPinsPath, canonicalJson({ ...pinnedMediaHashes, __candidateSnapshotPath: manifest.compiler.snapshotPath, __nativeMaterialCandidates: nativeCandidateProof, __legacyAudioCandidates: legacyAudioProof, __registeredMaterialCandidates: registeredCandidateProof, __modernEvents: modernEventProof, __documentHashes: pinnedDocumentHashes, __historicalEvidence: historicalEvidence, __productionReferences: productionReferences, __retiredProductionEvidence: retiredProductionEvidence, __retiredContactEvidence: { schemaVersion: '1.0', releaseId: baseRelease.releaseId, snapshotSha256: sha256(baseRelease.snapshotBytes), contactSheets: publishedSnapshot.p07?.contactSheets || {}, media: retiredContactMedia || [] } }));
    const commands = [];
    const workflowArgs = [manifest.compiler.workflowPath, manifestPath, 'prepare', canonicalJson(profile.sourceBindings.creativeRevisionPaths), manifest.compiler.snapshotPath];
    if (mode === 'SOURCE_SYNC') commands.push({ role: 'source-mutation-mask', ...(await python(scratch, invokeWorkflow, workflowArgs)) });
    for (const [role, flags] of [['storyQaPath', ['--json']], ['registryBuilderPath', []], ['registryBuilderPath', ['--check']], ['snapshotBuilderPath', []], ['snapshotBuilderPath', ['--check']], ['semanticQaPath', ['--json']]]) {
      const commandFlags = role === 'semanticQaPath' ? [...flags, '--event-store', path.join(scratch, manifest.compiler.eventDirectory)] : flags;
      const wrapper = role === 'snapshotBuilderPath' ? invokePinnedMapProxyReuse : role === 'semanticQaPath' ? invokeInstanceSemanticQa : invokeScript;
      const wrapperArgs = role === 'snapshotBuilderPath' ? [path.join(scratch, mapPinsPath), path.join(scratch, mapReportPath)] : role === 'semanticQaPath' ? [path.join(scratch, mapPinsPath), path.join(scratch, mapReportPath), path.join(scratch, semanticReportPath)] : [];
      commands.push({ role, flags, ...(await python(scratch, wrapper, [path.join(scratch, manifest.compiler[role]), ...wrapperArgs, ...commandFlags])) });
    }
    if (mode === 'SOURCE_SYNC') commands.push({ role: 'approved-candidate-canonical-hash', ...(await python(scratch, invokeWorkflow, [manifest.compiler.workflowPath, manifestPath, 'verify', canonicalJson(profile.sourceBindings.creativeRevisionPaths), manifest.compiler.snapshotPath])) });
    const output = async (alias) => {
      sourceRelative(alias); let target = scratch;
      for (const part of alias.split('/')) { target = path.join(target, part); requireSource(!(await lstat(target)).isSymbolicLink(), 'COMPILER_OUTPUT', `Compiler output path cannot contain a link: ${alias}`); }
      requireSource((await lstat(target)).isFile(), 'COMPILER_OUTPUT', `Compiler output must be a regular file: ${alias}`);
      return readFile(target);
    };
    const mapProxyAdapter = JSON.parse(await output(mapReportPath));
    const semanticQaAdapter = JSON.parse(await output(semanticReportPath));
    requireSource(nativeCandidateProof ? mapProxyAdapter?.nativeMaterialCandidates?.proofSha256 === nativeCandidateProof.proofSha256 && mapProxyAdapter.nativeMaterialCandidates.originalEventFilesPreserved === true && mapProxyAdapter.nativeMaterialCandidates.baseCandidateVersionsCreated === 0 : !mapProxyAdapter?.nativeMaterialCandidates, 'SOURCE_NATIVE_CANDIDATE_PROOF', 'Native candidate delegation proof was not preserved');
    requireSource(legacyAudioProof ? mapProxyAdapter?.legacyAudioCandidates?.proofSha256 === legacyAudioProof.proofSha256 && mapProxyAdapter.legacyAudioCandidates.originalEventFilesPreserved === true && mapProxyAdapter.legacyAudioCandidates.baseCandidateVersionsCreated === 0 : !mapProxyAdapter?.legacyAudioCandidates, 'SOURCE_LEGACY_AUDIO_CANDIDATE_PROOF', 'Legacy audio candidate delegation proof was not preserved');
    requireSource(registeredCandidateProof ? mapProxyAdapter?.registeredMaterialCandidates?.proofSha256 === registeredCandidateProof.proofSha256 && mapProxyAdapter.registeredMaterialCandidates.sourceBytesPreserved === true && mapProxyAdapter.registeredMaterialCandidates.baseCandidateVersionsCreated === 0 : !mapProxyAdapter?.registeredMaterialCandidates, 'SOURCE_REGISTERED_CANDIDATE_PROOF', 'Registered candidate compatibility proof was not preserved');
    if (modernEventProof) {
      requireSource(canonicalJson(semanticQaAdapter?.modernEvents?.modernRuntimeProof) === canonicalJson(modernEventProof.proof)
        && semanticQaAdapter.modernEvents.proofSha256 === modernEventProof.proofSha256
        && semanticQaAdapter.modernEvents.originalEventBytesPreserved === true,
        'SOURCE_MODERN_EVENT_QA_DRIFT', 'Semantic QA must retain the exact independently executed modern-event proof');
      for (const alias of eventPaths) requireSource(sha256(await output(alias)) === occupied.get(alias), 'SOURCE_EVENT_BYTES_CHANGED', 'Compiler changed original frozen event bytes');
      requireSource(sha256(await output(mapPinsPath)) === occupied.get(mapPinsPath), 'SOURCE_EVENT_PROOF_CHANGED', 'Compiler changed the original pinned proof');
    } else requireSource(!semanticQaAdapter?.modernEvents, 'SOURCE_MODERN_EVENT_QA_UNEXPECTED', 'Unexpected modern event proof');
    for (const report of semanticQaAdapter?.productionReferences?.reports || []) requireSource(report.releaseId === baseRelease.releaseId && report.snapshotSha256 === sha256(baseRelease.snapshotBytes), 'SOURCE_REFERENCE_PARITY_UNBOUND', 'Preserved production references must bind this exact published release');
    for (const row of [...(mapProxyAdapter?.missingOriginals || []), ...(mapProxyAdapter?.historicalContacts || [])]) {
      requireSource(!manifest.changes.some(change => change.path === row.sourcePath || change.path === row.proxyPath), 'SOURCE_MAP_PROXY_INPUT_CHANGED', 'Source synchronization cannot change a missing map original or its retained proxy');
      requireSource(pinnedMediaHashes[row.proxyPath] === row.proxySha256, 'SOURCE_MAP_PROXY_UNBOUND', 'Map cache reuse must retain an exact current instance media binding');
    }
    for (const row of mapProxyAdapter?.retiredContacts || []) {
      const proof = (retiredContactMedia || []).find(p => p.bindingHash === row.retirementBindingHash && p.registration.aliases.includes(row.proxyPath));
      const historical = publishedSnapshot.p07?.contactSheets?.[row.key];
      requireSource(proof && historical?.historyRole === 'EVIDENCE_ONLY'
        && proof.registration.sha256 === row.proxySha256 && proof.retirement.phase === row.retirementState
        && sha256(canonicalJson(historical)) === row.publishedContactHash && row.proxyActualSha256 === null
        && row.cacheReleaseId === baseRelease.releaseId && row.cacheSnapshotSha256 === sha256(baseRelease.snapshotBytes)
        && row.historyRole === 'EVIDENCE_ONLY' && row.mode === 'RETAIN_PUBLISHED_CONTACT_METADATA_WITH_RETIRED_MEDIA'
        && !manifest.changes.some(change => change.path === row.sourcePath || change.path === row.proxyPath),
        'SOURCE_RETIRED_CONTACT_UNBOUND', 'Retired contact metadata must bind exact historical release and retirement evidence; no media QA may be inferred');
    }
    for (const row of mapProxyAdapter?.historicalEvidence || []) {
      requireSource(!manifest.changes.some(change => change.path === row.sourcePath), 'SOURCE_HISTORICAL_CACHE_INPUT_CHANGED', 'Source synchronization cannot use a cached historical excerpt for a changed current source');
      requireSource(row.cacheReleaseId === baseRelease.releaseId && row.cacheSnapshotSha256 === sha256(baseRelease.snapshotBytes), 'SOURCE_HISTORICAL_CACHE_UNBOUND', 'Historical excerpt cache must remain bound to this exact published release');
    }
    let snapshotBytes = await output(manifest.compiler.snapshotPath); let recipesBytes = await output(manifest.compiler.recipesPath);
    const snapshot = JSON.parse(snapshotBytes); const recipes = JSON.parse(recipesBytes);
    const sourceProxyBindings = mode === 'SOURCE_SYNC' ? assertSourceProxyBindingPreservation({ baseSnapshot: publishedSnapshot, proposedSnapshot: snapshot, pinnedMediaHashes }) : null;
    requireSource(snapshot.snapshotId && snapshot.snapshotId === recipes.snapshotId, 'COMPILER_RELEASE', 'Compiler snapshot and recipes must form one release');
    const derived = [];
    for (const alias of profile.sourceBindings.derivedRegistryPaths) derived.push({ path: alias, bytes: await output(alias) });
    // A compiler cannot silently expand the authorized source mutation list.
    const mutable = new Set([...manifest.changes.map((row) => row.path), ...derived.map((row) => row.path), manifest.compiler.snapshotPath, manifest.compiler.recipesPath]);
    for (const document of documents) for (const alias of materializedDocuments.get(document.documentId)) {
      if (mutable.has(alias)) continue;
      requireSource(sha256(await output(alias)) === document.sha256, 'COMPILER_UNAUTHORIZED_MUTATION', `Compiler altered an unapproved source: ${alias}`);
    }
    for (const change of manifest.changes) requireSource(sha256(await output(change.path)) === change.newSha256, 'COMPILER_SOURCE_HASH', `Compiler changed approved source bytes: ${change.path}`);
    if (mode === 'EXTENSION_COMPATIBILITY') {
      requireSource(manifest.changes.length === 0, 'EXTENSION_NO_SOURCE_CHANGES', 'Extension compilation cannot carry business source changes');
      // No event, media, compiler input or other materialized bytes may change.
      for (const [alias, digest] of occupied) {
        if (mutable.has(alias)) continue;
        requireSource(sha256(await output(alias)) === digest, 'EXTENSION_COMPILER_UNAUTHORIZED_MUTATION', `Extension altered pinned compiler input: ${alias}`);
      }
    }
    const projected=profile.configurationRef?preserveConfigurationProjection({snapshot,recipes,baseSnapshot:publishedSnapshot,profile,events}):{snapshot,recipes};
    const scoped=preserveScopedProductionProjection({snapshot:projected.snapshot,baseSnapshot:publishedSnapshot,documents,events});
    const production=preserveShotProductionProjection({snapshot:scoped,baseSnapshot:publishedSnapshot,documents});
    const productionRecipes=preserveShotRecipeProjection({snapshot:production,recipes:projected.recipes,baseSnapshot:publishedSnapshot,baseRecipes:JSON.parse(baseRelease.recipesBytes),documents});
    const materialProduction=preserveMaterialProductionProjection({snapshot:productionRecipes.snapshot,recipes:productionRecipes.recipes,baseSnapshot:publishedSnapshot,baseRecipes:JSON.parse(baseRelease.recipesBytes),documents});
    const domain=preserveDomainProjection({snapshot:materialProduction.snapshot,baseSnapshot:publishedSnapshot,events});
    const materialProvenance=preserveMaterialProductionRequirementProvenance({snapshot:domain,baseSnapshot:publishedSnapshot});
    snapshotBytes=Buffer.from(canonicalJson(await preserveProductionSpatialProjection({snapshot:materialProvenance,baseSnapshot:publishedSnapshot,documents})));recipesBytes=Buffer.from(canonicalJson(materialProduction.recipes));
    const nativeCandidatePreservation = assertNativeCandidatePreservation({proof:nativeCandidateProof,snapshot:JSON.parse(snapshotBytes),recipes:JSON.parse(recipesBytes),events});
    const legacyAudioCandidatePreservation = assertLegacyAudioCandidatePreservation({proof:legacyAudioProof,snapshot:JSON.parse(snapshotBytes),recipes:JSON.parse(recipesBytes),events});
    return { snapshotBytes, recipesBytes, derived, qa: { mapProxyAdapter, semanticQaAdapter, ...(nativeCandidatePreservation ? { nativeCandidatePreservation } : {}), ...(legacyAudioCandidatePreservation ? {legacyAudioCandidatePreservation} : {}), ...(sourceProxyBindings ? { sourceProxyBindings } : {}), status: 'PASS', mode: mode === 'SOURCE_SYNC' ? 'INSTANCE_PINNED_EXTENSION_SOURCE_MASK_COMPILER_SEMANTIC_QA' : 'INSTANCE_EXTENSION_READ_ONLY_COMPILER_SEMANTIC_QA', commands } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
