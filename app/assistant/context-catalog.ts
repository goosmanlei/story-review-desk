import { createHash } from 'node:crypto';
import { validateSourceBinding } from '../../host/instance-runtime/assistant-source.mjs';
import type { AssistantResource, ContextPacket, ResourceCatalog } from './types';

export const ASSISTANT_CONTEXT_LIMITS = Object.freeze({
  resourceCharacters: 80_000,
  catalogBytes: 12 * 1024 * 1024,
  catalogResources: 4_000,
  initialCharacters: 72_000,
  initialResources: 48,
  explicitReferences: 8,
});

export function canonicalContextJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalContextJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContextJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function contextTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contextObjectHash(value: unknown): string {
  return contextTextHash(canonicalContextJson(value));
}

export function contextResource(input: Omit<AssistantResource, 'sha256'>): AssistantResource {
  if (input.text.length > ASSISTANT_CONTEXT_LIMITS.resourceCharacters) {
    throw new Error(`CONTEXT_RESOURCE_TOO_LARGE:${input.id}`);
  }
  return { ...input, sha256: contextTextHash(input.text) };
}

export function validateResourceCatalog(catalog: ResourceCatalog): ResourceCatalog {
  if (!catalog.projectId || !catalog.scopeKey || !catalog.snapshotId) throw new Error('CONTEXT_SCOPE_MISSING');
  if (catalog.resources.length > ASSISTANT_CONTEXT_LIMITS.catalogResources) throw new Error('CONTEXT_CATALOG_TOO_LARGE');
  const ids = new Set<string>();
  for (const resource of catalog.resources) {
    if (ids.has(resource.id)) throw new Error(`CONTEXT_RESOURCE_ID_DUPLICATE:${resource.id}`);
    ids.add(resource.id);
    if (resource.sha256 !== contextTextHash(resource.text)) throw new Error(`CONTEXT_RESOURCE_HASH_INVALID:${resource.id}`);
    if (resource.sourceBinding) {
      if (catalog.schemaVersion !== '1.1') throw new Error('CONTEXT_SOURCE_SCHEMA_INVALID');
      validateSourceBinding(resource.sourceBinding);
      if (resource.versionId !== resource.sourceBinding.revisionId || contextObjectHash(JSON.parse(resource.text).sourceBinding) !== contextObjectHash(resource.sourceBinding)) throw new Error('CONTEXT_SOURCE_BINDING_INVALID');
    }
    if (resource.text.length > ASSISTANT_CONTEXT_LIMITS.resourceCharacters) throw new Error(`CONTEXT_RESOURCE_TOO_LARGE:${resource.id}`);
    if (!resource.href.startsWith('/?') || resource.href.startsWith('//')) throw new Error(`CONTEXT_RESOURCE_LINK_INVALID:${resource.id}`);
  }
  if (Buffer.byteLength(canonicalContextJson(catalog)) > ASSISTANT_CONTEXT_LIMITS.catalogBytes) throw new Error('CONTEXT_CATALOG_TOO_LARGE');
  return catalog;
}

/** Deferred source bodies use a conservative byte upper bound until the worker verifies them. */
export function resourceReadCharacters(resource: AssistantResource): number {
  return resource.text.length + (resource.sourceBinding ? resource.sourceBinding.byteEnd - resource.sourceBinding.byteStart + 3 : 0);
}

/** Initial evidence is whole-resource only. Omitted optional evidence stays discoverable by ID. */
export function selectInitialResources(catalog: ResourceCatalog, required: string[], optional: string[]) {
  const byId = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  const selected: string[] = [];
  const deferred: string[] = [];
  let characters = 0;
  for (const id of [...new Set(required)]) {
    const resource = byId.get(id);
    if (!resource) throw new Error(`CONTEXT_RESOURCE_NOT_FOUND:${id}`);
    selected.push(id);
    characters += resourceReadCharacters(resource);
  }
  if (characters > ASSISTANT_CONTEXT_LIMITS.initialCharacters || selected.length > ASSISTANT_CONTEXT_LIMITS.initialResources) {
    throw new Error('CONTEXT_REQUIRED_EVIDENCE_TOO_LARGE');
  }
  for (const id of [...new Set(optional)]) {
    if (selected.includes(id)) continue;
    const resource = byId.get(id);
    if (!resource) continue;
    if (characters + resourceReadCharacters(resource) > ASSISTANT_CONTEXT_LIMITS.initialCharacters || selected.length === ASSISTANT_CONTEXT_LIMITS.initialResources) {
      deferred.push(id);
      continue;
    }
    selected.push(id);
    characters += resourceReadCharacters(resource);
  }
  return { selected, deferred, characters };
}

/** Snapshot IDs are provenance. Only the exact discussion dependencies determine staleness. */
export function contextDependencyHash(catalog: ResourceCatalog, ids: string[]): string {
  const byId = new Map(catalog.resources.map((resource) => [resource.id, resource]));
  return contextObjectHash([...new Set(ids)].sort().map((id) => {
    const resource = byId.get(id);
    if (!resource) throw new Error(`CONTEXT_RESOURCE_NOT_FOUND:${id}`);
    const source = resource.sourceBinding;
    const evidenceSha = source ? contextObjectHash({documentId:source.documentId,revisionId:source.revisionId,sha256:source.sha256,byteSize:source.byteSize,byteStart:source.byteStart,byteEnd:source.byteEnd}) : resource.sha256;
    return { id, sha256: evidenceSha, versionId: resource.versionId || null, mediaSha256: resource.media?.sha256 || null };
  }));
}

export function sealContextPacket(body: ContextPacket['body']): ContextPacket {
  const packetHash = contextObjectHash(body);
  return { packetId: `ctx_${packetHash}`, packetHash, body };
}
