import {canonicalJson, sha256} from './bytes.mjs';
import {ROOT_GUIDANCE_ALIASES, TOPIC_GUIDANCE_ALIASES, GUIDANCE_ALIASES, allowedGuidanceRole} from './guidance-aliases.mjs';

export const GUIDANCE_NAMESPACE = 'instance-guidance-operations';
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const ensure = (condition, code, message) => { if (!condition) fail(code, message); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const identity = alias => 'project-guidance:' + alias;

function validate(input) {
  ensure(exact(input, ['schemaVersion', 'operationId', 'expectedReleaseId', 'changes']) &&
    ['1.0', '1.1'].includes(input.schemaVersion) &&
    /^guidance_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operationId || '') &&
    typeof input.expectedReleaseId === 'string' && input.expectedReleaseId.length > 0,
  'GUIDANCE_INPUT', 'An exact versioned guidance manifest is required');
  const aliases = input.schemaVersion === '1.0' ? ROOT_GUIDANCE_ALIASES : GUIDANCE_ALIASES;
  ensure(Array.isArray(input.changes) && input.changes.length > 0 && input.changes.length <= aliases.length,
    'GUIDANCE_INPUT', 'Guidance batch exceeds its versioned allowlist');
  const changes = input.changes.map(change => {
    ensure(exact(change, ['alias', 'expectedRevisionId', 'expectedSha256', 'newSha256', 'contentBase64']) &&
      aliases.includes(change.alias) && hash(change.newSha256) && typeof change.contentBase64 === 'string',
    'GUIDANCE_INPUT', 'Only fixed project guidance aliases and explicit UTF-8 bytes are accepted');
    const create = input.schemaVersion === '1.1' && TOPIC_GUIDANCE_ALIASES.includes(change.alias) &&
      change.expectedRevisionId === null && change.expectedSha256 === null;
    ensure(create || typeof change.expectedRevisionId === 'string' && change.expectedRevisionId.length > 0 && hash(change.expectedSha256),
      'GUIDANCE_INPUT', 'Only new topics accept both null preconditions; replacements require exact revision and SHA');
    const bytes = Buffer.from(change.contentBase64, 'base64');
    ensure(bytes.length > 0 && bytes.length <= 1024 * 1024 && bytes.toString('base64') === change.contentBase64 && sha256(bytes) === change.newSha256,
      'GUIDANCE_BYTES', 'Guidance bytes or declared hash differ');
    try {
      ensure(!new TextDecoder('utf-8', {fatal: true}).decode(bytes).includes('\0'), 'GUIDANCE_BYTES', 'Guidance must be plain UTF-8 text');
    } catch (error) {
      if (error.code === 'GUIDANCE_BYTES') throw error;
      fail('GUIDANCE_BYTES', 'Guidance must be plain UTF-8 text');
    }
    return {...change, bytes, create};
  });
  ensure(new Set(changes.map(x => x.alias)).size === changes.length, 'GUIDANCE_INPUT', 'Guidance aliases must be unique');
  return changes;
}

export async function inspectGuidance(tx, {includeTopics = false} = {}) {
  const meta = await tx.getMetadata(), published = await tx.listPublishedDocumentMetadata(), documents = [];
  for (const alias of includeTopics ? GUIDANCE_ALIASES : ROOT_GUIDANCE_ALIASES) {
    const matches = published.filter(x => x.aliases.includes(alias));
    ensure(matches.length <= 1, 'GUIDANCE_ALIAS', 'Guidance alias is ambiguous');
    const record = matches[0], head = await tx.readDocument(alias);
    const topic = TOPIC_GUIDANCE_ALIASES.includes(alias);
    const creatable = topic && !record && !head && !await tx.readDocument(identity(alias));
    documents.push({
      alias, documentId: record?.documentId || null, revisionId: record?.revisionId || null, sha256: record?.sha256 || null,
      headRevisionId: head?.revisionId || null, headMatchesPublished: Boolean(record && head?.revisionId === record.revisionId),
      sourceRole: record?.metadata.sourceRole || null, legacyExpectedSha256: record?.metadata.legacyExpectedSha256 || null,
      eligible: Boolean(record && head && !head.deleted && head.revisionId === record.revisionId &&
        allowedGuidanceRole(head, alias) && head.aliases.length === 1 && head.aliases[0] === alias),
      ...(topic ? {creatable} : {}),
    });
  }
  return {instanceId: meta.instanceId, releaseId: meta.releaseId, runtimeEpoch: meta.runtimeEpoch, documents};
}

/** Caller must use one repository write transaction: all documents + release + receipt commit atomically. */
export async function updateGuidance(tx, input) {
  const changes = validate(input), requestHash = sha256(canonicalJson(input)), prior = await tx.getAux(GUIDANCE_NAMESPACE, input.operationId);
  if (prior) {
    const proof = JSON.parse(prior.bytes);
    ensure(!prior.deleted && proof.requestHash === requestHash, 'GUIDANCE_CONFLICT', 'Operation identity was used for different guidance bytes');
    return {...proof, replayed: true};
  }
  const release = await tx.readRelease();
  ensure(release?.releaseId === input.expectedReleaseId, 'GUIDANCE_CONFLICT', 'Current release changed');
  ensure((await tx.getConfig('instance-profile'))?.revisionId === release.profileRevisionId,
    'GUIDANCE_CONFLICT', 'Unpublished profile head must be resolved first');
  const published = await tx.listPublishedDocumentMetadata(), replacements = new Map(), additions = [], rows = [];
  for (const change of changes) {
    const matches = published.filter(x => x.aliases.includes(change.alias)), head = await tx.readDocument(change.alias);
    let previous = null;
    if (change.create) {
      ensure(matches.length === 0 && !head && !await tx.readDocument(identity(change.alias)),
        'GUIDANCE_CONFLICT', 'New topic alias or permanent identity already exists, including unpublished or deleted records');
    } else {
      ensure(matches.length === 1, 'GUIDANCE_ALIAS', 'The replacement alias must exist in this release');
      const binding = matches[0];
      ensure(head && !head.deleted && head.documentId === binding.documentId && head.revisionId === binding.revisionId &&
        head.revisionId === change.expectedRevisionId && head.sha256 === change.expectedSha256 && sha256(head.bytes) === change.expectedSha256,
      'GUIDANCE_CONFLICT', 'Published revision, head and original SHA must match exactly');
      ensure(head.aliases.length === 1 && head.aliases[0] === change.alias && allowedGuidanceRole(head, change.alias),
        'GUIDANCE_ROLE', 'Only established project guidance roles may use this service');
      previous = head;
    }
    const metadata = {
      ...(previous?.metadata || {sourceRole: 'PROJECT_GUIDANCE', role: 'PROJECT_GUIDANCE'}),
      actualSha256: change.newSha256, guidanceChangeOnly: true, guidanceUpdateId: input.operationId, authoringEntry: 'GUIDANCE_UPDATE',
    };
    const next = await tx.putDocument({
      documentId: previous?.documentId || identity(change.alias), bytes: change.bytes, aliases: [change.alias],
      expectedRevisionId: previous?.revisionId || null, mediaType: previous?.mediaType || 'text/markdown', metadata,
    });
    if (previous) replacements.set(previous.revisionId, next.revisionId); else additions.push(next.revisionId);
    rows.push({
      alias: change.alias, documentId: next.documentId, previousRevisionId: previous?.revisionId || null, revisionId: next.revisionId,
      previousSha256: previous?.sha256 || null, sha256: next.sha256, sourceRole: metadata.sourceRole,
      legacyExpectedSha256: metadata.legacyExpectedSha256 ?? null,
    });
  }
  const next = await tx.publishRelease({
    snapshotBytes: release.snapshotBytes, recipesBytes: release.recipesBytes, expectedReleaseId: release.releaseId,
    sourceRevisionIds: [...release.sourceRevisionIds.map(id => replacements.get(id) || id), ...additions],
  });
  const proof = {
    schemaVersion: input.schemaVersion, operationType: 'GUIDANCE_UPDATE', operationId: input.operationId, requestHash,
    instanceId: next.instanceId, runtimeEpoch: next.runtimeEpoch, baseReleaseId: release.releaseId, releaseId: next.releaseId, documents: rows,
    snapshotSha256: release.snapshotSha256, recipesSha256: release.recipesSha256, originalSnapshotBytesPreserved: true,
    originalRecipesBytesPreserved: true, formalAdoptionPerformed: false, productionAuthorizationCreated: false, recordedAt: new Date().toISOString(),
  };
  await tx.putAux({namespace: GUIDANCE_NAMESPACE, key: input.operationId, bytes: canonicalJson(proof), expectedRevisionId: null,
    mediaType: 'application/json', metadata: {operationType: 'GUIDANCE_UPDATE'}});
  return proof;
}
