import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openInstanceRepository, resolveInstance } from '../host/instance-runtime/index.mjs';
import { delegateInstanceMaintenance } from './instance-maintenance.mjs';

function safeAlias(alias) {
  if (typeof alias !== 'string' || !alias || alias.startsWith('/') || /[\\\x00-\x1f]/.test(alias) || alias.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('An exact, safe instance-relative alias is required');
}
export async function publishedInstanceDocuments(tx) {
  const release = (await tx.readRelease());
  if (!release) throw new Error('The instance has no published release');
  return Promise.all(release.sourceRevisionIds.map(async id => {
    const document = (await tx.readDocumentRevision(id));
    if (!document || document.deleted) throw new Error('Published document revision is unavailable');
    return document;
  }));
}

/** Authoring evidence only. Formal source/compiler inputs must use controlled sync. */
export async function putInstanceDocument(repo, { alias, bytes, expectedRevisionId, title, sourceRole = 'AUTHORING_DRAFT' }) {
  safeAlias(alias);
  if (!['AUTHORING_DRAFT', 'SOURCE_DOCUMENT', 'INSTANCE_GUIDANCE'].includes(sourceRole)) throw new Error('This command does not adopt creative revisions, prompts or executable extensions');
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error('Document bytes must be explicit');
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Source document exceeds 32 MiB; register large media separately');
  if (expectedRevisionId !== null && (typeof expectedRevisionId !== 'string' || !expectedRevisionId)) throw new Error('An explicit expected revision is required');
  if (!['.md', '.txt', '.json', '.yaml', '.yml', '.csv'].includes(path.posix.extname(alias).toLowerCase())) throw new Error('Only non-executable authoring documents may be imported here');
  return repo.writeTransaction(async tx => {
    const release = (await tx.readRelease()); const view = (await tx.readView());
    if (!release || (await tx.getConfig('instance-profile'))?.revisionId !== release.profileRevisionId) throw new Error('Publish the current profile through its controlled settings path first');
    const old = (await tx.readDocument(alias)); const aliases = [...new Set([alias, ...(old?.aliases || [])])];
    const sourceBindings = view.profile.sourceBindings || {};
    const recipes = JSON.parse(release.recipesBytes);
    const protectedAliases = new Set([
      ...Object.values(sourceBindings.creativeRevisionPaths || {}), ...(sourceBindings.derivedRegistryPaths || []),
      ...(recipes.sourceCatalog || []).map(row => row.path).filter(Boolean),
    ]);
    if (aliases.some(value => protectedAliases.has(value) || /^production\/prompts\/direct\//.test(value))) throw new Error('Creative sources, derived registries and execution sources require controlled source sync');
    if (old) {
      const ownDraft = old.metadata.authoringEntry === 'EXPLICIT_HOST_CLI' && old.metadata.reviewState === 'DRAFT' && ['AUTHORING_DRAFT', 'SOURCE_DOCUMENT'].includes(old.metadata.sourceRole) && !old.metadata.sourceOperationId;
      const guidance = old.metadata.sourceRole === 'INSTANCE_GUIDANCE' && aliases.every(value => ['README.md', 'AGENTS.md', 'STATE.md'].includes(value));
      if (!ownDraft && !guidance) throw new Error('Existing authoritative/imported documents require controlled source sync; create a separate authoring draft');
      if (sourceRole === 'INSTANCE_GUIDANCE' && !guidance) throw new Error('A draft cannot be relabeled as instance guidance');
    } else if (sourceRole === 'INSTANCE_GUIDANCE') throw new Error('This command can only update already registered instance guidance');
    const documents = (await publishedInstanceDocuments(tx)); const publishedOld = old && documents.find(row => row.documentId === old.documentId);
    if (old && publishedOld?.revisionId !== old.revisionId) throw new Error('An unpublished document head must be resolved explicitly before this authoring update');
    const role = old?.metadata.sourceRole === 'INSTANCE_GUIDANCE' ? 'INSTANCE_GUIDANCE' : sourceRole;
    const record = (await tx.putDocument({ documentId: old?.documentId || `document:${alias}`, bytes, aliases: [alias], expectedRevisionId, mediaType: alias.endsWith('.json') ? 'application/json' : 'text/markdown', metadata: { ...old?.metadata, title: title || old?.metadata.title || alias, sourceRole: role, reviewState: 'DRAFT', authoringEntry: 'EXPLICIT_HOST_CLI' } }));
    const sourceRevisionIds = publishedOld ? release.sourceRevisionIds.map(id => id === publishedOld.revisionId ? record.revisionId : id) : [...release.sourceRevisionIds, record.revisionId];
    // Preserve all unrelated release bindings and original snapshot/recipe bytes.
    (await tx.publishRelease({ snapshotBytes: release.snapshotBytes, recipesBytes: release.recipesBytes, expectedReleaseId: release.releaseId, sourceRevisionIds }));
    return { documentId: record.documentId, revisionId: record.revisionId, sha256: record.sha256, sourceRole: role, formalAdoptionPerformed: false };
  });
}

export async function instanceDocumentCli(argv) {
  if (await delegateInstanceMaintenance('instance-document.mjs', argv)) return;
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { instance: { type: 'string' }, alias: { type: 'string' }, file: { type: 'string' }, 'expected-revision': { type: 'string' }, title: { type: 'string' }, role: { type: 'string' } } });
  const command = positionals[0];
  if (!values.instance || !['list', 'read', 'put'].includes(command) || positionals.length !== 1) throw new Error('Usage: instance-document.mjs list|read|put --instance PATH [--alias LOGICAL_PATH --file FILE --expected-revision NULL|REVISION]');
  const location = resolveInstance(values.instance); const repo = (await openInstanceRepository({ ...location, readOnly: command !== 'put' }));
  try {
    if (command === 'list') console.log(JSON.stringify(await repo.readTransaction(async tx => (await publishedInstanceDocuments(tx)).map(item => ({ documentId: item.documentId, revisionId: item.revisionId, aliases: item.aliases, sha256: item.sha256, metadata: item.metadata }))), null, 2));
    else {
      safeAlias(values.alias);
      if (command === 'read') {
        const item = await repo.readTransaction(async tx => (await publishedInstanceDocuments(tx)).find(row => row.documentId === values.alias || row.aliases.includes(values.alias)));
        if (!item) throw new Error('Document is not registered in the active release'); process.stdout.write(Buffer.from(item.bytes));
      } else {
        if (!values.file || !values['expected-revision']) throw new Error('Write requires an explicit file and expected revision; use NULL to create');
        const result = await putInstanceDocument(repo, { alias: values.alias, bytes: await readFile(values.file), expectedRevisionId: values['expected-revision'] === 'NULL' ? null : values['expected-revision'], title: values.title, sourceRole: values.role });
        console.log(JSON.stringify(result));
      }
    }
  } finally { (await repo.close()); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await instanceDocumentCli(process.argv.slice(2));
