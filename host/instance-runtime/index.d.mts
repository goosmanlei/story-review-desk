/// <reference types="node" />
/** Storage transports several immutable legacy JSON protocols without coercion.
 * Route/domain validators own their schemas; this single opaque compatibility
 * alias keeps old DTO callers typed while the generic storage layer preserves
 * original fields. It is not permission to skip validation at an API boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Deliberate legacy JSON transport boundary, confined to repository DTOs.
export type OpaqueLegacyJson = any;
export type RepositoryRecord = { namespace: string; key: string; revisionId: string; revision: number; previousRevisionId: string | null; bytes: Buffer; sha256: string; mediaType: string; metadata: Record<string, OpaqueLegacyJson>; deleted: boolean; createdAt: string };
export type RepositoryDocument = RepositoryRecord & { documentId: string; aliases: string[] };
export type RepositoryView = { instanceId: string; runtimeEpoch: string; repositoryRevision: number; releaseId: string | null; profile: Record<string, OpaqueLegacyJson>; snapshot: Record<string, OpaqueLegacyJson> | null; recipes: Record<string, OpaqueLegacyJson> | null; eventsByKind: Record<string, Record<string, OpaqueLegacyJson>[]>; sourceRevisionIds: string[]; dataFingerprint: string; recipeFingerprint: string };
export type MediaRecord = { mediaId: string; versionId: string; relativePath: string | null; sha256: string; byteSize: number; availability: string; metadata: Record<string, OpaqueLegacyJson>; aliases: string[] };
export type RepositoryRelease = { releaseId: string; snapshotId: string; snapshotBytes: Buffer; snapshotSha256: string; recipesBytes: Buffer; recipesSha256: string; sourceRevisionIds: string[]; profileRevisionId: string; createdAt: string };
export type RepositoryLocation = { root?: string; dbPath?: string; instanceId?: string; backend?: 'sqlite'|'postgres'; database?: {kind: 'postgres';database:string;service:string;volume:string}; connection?: Record<string, unknown>; readOnly?: boolean };
export interface InstanceReadUnit {
  backend?: 'sqlite'|'postgres';
  getRecord(namespace:string,key:string,revisionId?:string):Promise<RepositoryRecord|null>;
  getMetadata():Promise<{instanceId:string;runtimeEpoch:string;repositoryRevision:number;releaseId:string|null;profileRevisionId:string|null;snapshotId:string|null;eventSequence:number}>;
  /** Exact selected AUX heads + registered media metadata, within the caller's read transaction. */
  getProjectionFingerprint(namespaces: readonly string[]):Promise<string>;
  listRecordRevisions(namespace:string,key:string):Promise<RepositoryRecord[]>;
  listPublishedDocumentMetadata():Promise<Array<{documentId:string;revisionId:string;sha256:string;byteSize:number;aliases:string[];metadata:Record<string,OpaqueLegacyJson>;mediaType:string}>>;
  getPublishedDocument(alias:string):Promise<RepositoryDocument|null>;
  readView(): Promise<RepositoryView>;
  readDocument(idOrAlias: string, options?: { revisionId?: string }): Promise<RepositoryDocument | null>;
  readDocumentRevision(revisionId: string): Promise<RepositoryDocument | null>;
  readRelease(releaseId?: string): Promise<RepositoryRelease | null>;
  /** Latest real publication strictly before an immutable event, across all snapshot IDs. */
  readPublishedReleaseTimeGroup(input:{recordedBefore:string;inclusive?:boolean}):Promise<Array<Omit<RepositoryRelease,'snapshotBytes'|'recipesBytes'>>>;
  readPublishedReleaseAt(input:{recordedBefore:string;snapshotId:string}):Promise<RepositoryRelease>;
  listDocuments(): Promise<RepositoryDocument[]>;
  getConfig(configId: string): Promise<(RepositoryRecord & { configId: string; value: OpaqueLegacyJson }) | null>;
  getProfile(): Promise<Record<string, OpaqueLegacyJson>>;
  getAux(namespace: string, key: string, options?: { revisionId?: string }): Promise<RepositoryRecord | null>;
  listAux(namespace: string, options?: { prefix?: string; includeDeleted?: boolean }): Promise<RepositoryRecord[]>;
  listEvents(kind?: string, options?: { authorityDomain?: string }): Promise<Record<string, OpaqueLegacyJson>[]>;
  findIdempotentEvent(kind: string, key: string, options?: { authorityDomain?: string }): Promise<Record<string, OpaqueLegacyJson> | null>;
  getMedia(mediaId: string, versionId: string): Promise<MediaRecord | null>;
  listMedia(): Promise<MediaRecord[]>;
  resolveMedia(alias: string, options?: { versionId?: string; sha256?: string }): Promise<MediaRecord | null>;
  exportState(): Promise<Record<string, OpaqueLegacyJson>>;
}
export interface InstanceUnit extends InstanceReadUnit {
  query(sql:string,params?:unknown[]):Promise<{rows:OpaqueLegacyJson[];rowCount:number|null}>;
  putRecord(namespace:string,key:string,bytes:string|Uint8Array,options:{expectedRevisionId:string|null;mediaType?:string;metadata?:Record<string,OpaqueLegacyJson>;deleted?:boolean}):Promise<RepositoryRecord>;
  resetRuntimeEpoch():Promise<OpaqueLegacyJson>;
  putDocument(input: { documentId: string; bytes: string | Uint8Array; expectedRevisionId: string | null; aliases?: string[]; mediaType?: string; metadata?: Record<string, OpaqueLegacyJson> }): Promise<RepositoryDocument>;
  putConfig(input: { configId: string; value?: OpaqueLegacyJson; bytes?: string | Uint8Array; expectedRevisionId: string | null; metadata?: Record<string, OpaqueLegacyJson> }): Promise<RepositoryRecord>;
  putAux(input: { namespace: string; key: string; bytes: string | Uint8Array; expectedRevisionId: string | null; mediaType?: string; metadata?: Record<string, OpaqueLegacyJson>; deleted?: boolean }): Promise<RepositoryRecord>;
  deleteAux(input: { namespace: string; key: string; expectedRevisionId: string; metadata?: Record<string, OpaqueLegacyJson> }): Promise<RepositoryRecord>;
  moveAux(input: { fromNamespace: string; fromKey: string; fromRevisionId: string; toNamespace: string; toKey: string }): Promise<{ source: RepositoryRecord; destination: RepositoryRecord }>;
  publishRelease(input: { snapshot?: OpaqueLegacyJson; recipes?: OpaqueLegacyJson; snapshotBytes?: string | Uint8Array; recipesBytes?: string | Uint8Array; expectedReleaseId: string | null; sourceRevisionIds?: string[] }): Promise<RepositoryView>;
  importEvent(input: { bytes: string | Uint8Array; sourceRef?: unknown; authorityDomain?: string }): Promise<Record<string, OpaqueLegacyJson>>;
  appendEvent(input: { kind: string; idempotencyKey: string; requestHash: string; payload: Record<string, OpaqueLegacyJson>; eventSchemaVersion?: string; authorityDomain?: string }): Promise<{ event: Record<string, OpaqueLegacyJson>; replayed: boolean }>;
  registerMedia(input: { mediaId: string; versionId: string; relativePath?: string | null; sha256: string; byteSize: number; aliases?: string[]; metadata?: Record<string, OpaqueLegacyJson>; availability?: string }): Promise<MediaRecord>;
}
export class RepositoryError extends Error { code: string; details?: unknown; constructor(code: string, message: string, details?: unknown); }
export class InstanceRepository implements InstanceReadUnit {
  constructor(options: RepositoryLocation);
  dbPath?: string; instanceId: string; backend?: 'sqlite'|'postgres'; readonly inTransaction: boolean; readonly transactionMode: 'READ'|'WRITE'|null;
  getRecord: InstanceReadUnit['getRecord']; getMetadata: InstanceReadUnit['getMetadata']; listRecordRevisions: InstanceReadUnit['listRecordRevisions']; listPublishedDocumentMetadata: InstanceReadUnit['listPublishedDocumentMetadata']; getPublishedDocument: InstanceReadUnit['getPublishedDocument'];
  readView: InstanceReadUnit['readView']; readDocument: InstanceReadUnit['readDocument']; listDocuments: InstanceReadUnit['listDocuments'];
  readDocumentRevision: InstanceReadUnit['readDocumentRevision']; readRelease: InstanceReadUnit['readRelease']; readPublishedReleaseAt: InstanceReadUnit['readPublishedReleaseAt']; readPublishedReleaseTimeGroup:InstanceReadUnit['readPublishedReleaseTimeGroup']; listMedia: InstanceReadUnit['listMedia'];
  getConfig: InstanceReadUnit['getConfig']; getProfile: InstanceReadUnit['getProfile']; getAux: InstanceReadUnit['getAux']; listAux: InstanceReadUnit['listAux'];
  listEvents: InstanceReadUnit['listEvents']; findIdempotentEvent: InstanceReadUnit['findIdempotentEvent']; getMedia: InstanceReadUnit['getMedia']; resolveMedia: InstanceReadUnit['resolveMedia'];
  getProjectionFingerprint: InstanceReadUnit['getProjectionFingerprint'];
  exportState: InstanceReadUnit['exportState'];
  readTransaction<T>(callback: (tx: InstanceReadUnit) => T | Promise<T>): Promise<T>;
  writeTransaction<T>(callback: (tx: InstanceUnit) => T | Promise<T>): Promise<T>;
  integrityCheck(): Promise<{ ok: true; instanceId: string; schemaVersion: number }>;
  backupTo(targetPath: string): Promise<{ path: string; sha256: string; instanceId: string; format?:string; integrity: { ok: true; instanceId: string; schemaVersion: number }; mediaIncluded: false }>;
  close(): Promise<void>;
}
export function canonicalJson(value: unknown): string;
export function sha256(bytes: string | Uint8Array): string;
export function createInstanceRepository(options: RepositoryLocation & {instanceId:string; profile?: OpaqueLegacyJson; profileBytes?: string | Uint8Array }): Promise<InstanceRepository>;
export function openInstanceRepository(options: RepositoryLocation): Promise<InstanceRepository>;
export function resolveInstance(root: string): RepositoryLocation & {root:string;instanceId:string};
export function restoreInstanceRepository(options: { backupPath: string; dbPath: string; instanceId: string; expectedSha256: string }): Promise<InstanceRepository>;
export function importRepositoryState(options: RepositoryLocation & {archive:Record<string,OpaqueLegacyJson>;instanceId:string}): Promise<InstanceRepository>;
