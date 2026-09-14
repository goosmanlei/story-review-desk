export const SPATIAL_PLACEMENT_ROLE: 'SPATIAL_PLACEMENT_DRAFT';
export const SPATIAL_PLACEMENT_STATUS: 'PENDING_CONFIRMATION';
export const SPATIAL_PLACEMENT_LIMITS: Readonly<{
  drafts: number;
  sceneReferences: number;
  unknowns: number;
  identifierLength: number;
  textLength: number;
  coordinateMagnitude: number;
  currentObjects: number;
  draftBytes: number;
  projectionDraftBytes: number;
}>;

export class SpatialPlacementError extends Error {
  constructor(code: string, path: string, message: string);
  code: string;
  status: number;
  path: string;
}

/** Permanent object identity and an exact immutable revision; no aliases or heads. */
export type SpatialPlacementReference = {
  id: string;
  revisionId: string;
  /** revisions.sha256 (also for SOURCE); never the original source byte hash. */
  sha256: string;
  /** Positive object version read with the selected revision. */
  expectedVersion: number;
};
export type SpatialPlacementSourceReference = SpatialPlacementReference & {
  /** source_documents.original_sha256, independently verified against raw bytes. */
  sourceSha256: string;
};
export type SpatialPlacementSceneReference = SpatialPlacementReference & {locator?: string};
/** EXACT means exact revision evidence, and does not establish script adoption. */
export type SpatialPlacementSceneEvidence =
  | {status: 'UNKNOWN'; reason: string}
  | {status: 'EXACT'; references: SpatialPlacementSceneReference[]};

/** Strict payload for one versioned NOTE; object envelope/review metadata is external. */
export type SpatialPlacementDraft = {
  schemaVersion: '1.0';
  role: 'SPATIAL_PLACEMENT_DRAFT';
  status: 'PENDING_CONFIRMATION';
  location: SpatialPlacementReference;
  spatialSource: SpatialPlacementSourceReference;
  coordinateSpace: 'CANVAS_ONLY';
  /** Canvas pixels only; never spatial.locations[].pos or geographic coordinates. */
  proposedSlot: [number, number];
  authority: 'A' | 'UNKNOWN';
  entrance: 'UNKNOWN';
  sceneEvidence: SpatialPlacementSceneEvidence;
  /** Explicit unresolved facts; nonempty, bounded, no fabricated project scope. */
  unknowns: string[];
  note: string;
};

export type SpatialPlacementCurrentLocation = SpatialPlacementReference & {
  kind: string;
  type: string;
  historical: boolean;
};
export type SpatialPlacementCurrentSource = SpatialPlacementSourceReference & {
  kind: string;
  role: string;
  historical: boolean;
};
export type SpatialPlacementCurrentScene = SpatialPlacementReference & {
  kind: string;
  historical: boolean;
};
/**
 * Caller supplies explicit current revisions from one coherent read. Missing source
 * is null; missing target/evidence is absent from its array. No whole-story fallback.
 * Expected kinds: ENTITY/type LOCATION, SOURCE/role SPATIAL_SPECIFICATION, SCENE.
 */
export type SpatialPlacementBasis = {
  spatialSource: SpatialPlacementCurrentSource | null;
  locations: readonly SpatialPlacementCurrentLocation[];
  scenes: readonly SpatialPlacementCurrentScene[];
};
export type SpatialPlacementReferenceDescriptor =
  | (SpatialPlacementReference & {kind: 'ENTITY'; purpose: 'DEFINITION'})
  | (SpatialPlacementSourceReference & {kind: 'SOURCE'; purpose: 'SOURCE'})
  | (SpatialPlacementReference & {kind: 'SCENE'; purpose: 'CONTENT'});
export type SpatialPlacementIssue = {
  code: 'REFERENCE_MISSING' | 'REFERENCE_CHANGED' | 'REFERENCE_KIND_CHANGED' | 'REFERENCE_HISTORICAL';
  role: 'LOCATION' | 'SPATIAL_SOURCE' | 'SCENE_EVIDENCE';
  expected: SpatialPlacementReference | SpatialPlacementSourceReference | SpatialPlacementSceneReference;
  actual: SpatialPlacementCurrentLocation | SpatialPlacementCurrentSource | SpatialPlacementCurrentScene | null;
  changedFields: string[];
  message: string;
};
export type SpatialPlacementAssessment = {
  draft: SpatialPlacementDraft;
  freshness: 'CURRENT' | 'STALE';
  issues: SpatialPlacementIssue[];
};
export type SpatialPlacementNote = {note: SpatialPlacementReference; content: SpatialPlacementDraft};
export type SpatialPlacementEntry = SpatialPlacementNote & {
  freshness: 'CURRENT' | 'STALE';
  classification: 'PENDING_OVERLAY' | 'STALE_DRAFT' | 'PUBLISHED_ANCHOR_EXISTS';
  issues: SpatialPlacementIssue[];
};
/** Intentionally has no pos, anchor, shadow, route or production geometry fields. */
export type SpatialPlacementOverlay = {
  note: SpatialPlacementReference;
  targetEntityId: string;
  status: 'PENDING_CONFIRMATION';
  authority: 'A' | 'UNKNOWN';
  coordinateSpace: 'CANVAS_ONLY';
  x: number;
  y: number;
  statusLabel: '待确认示意位置';
  zoneLabel: '待确认示意区（非地理位置）';
  entrance: 'UNKNOWN';
  geometryEligible: false;
};
export type SpatialPlacementPublishedLocation = {id: string; pos?: readonly number[]};
export type SpatialPlacementSpatial = {
  locations?: readonly SpatialPlacementPublishedLocation[];
  orientation?: string;
};
export type SpatialPlacementProjection<S extends SpatialPlacementSpatial | null> = {
  /** Same object passed by the caller, without normalization or added fields. */
  spatial: S;
  /** Same source array when present; original objects and positions are untouched. */
  locations: S extends {locations: infer L extends readonly SpatialPlacementPublishedLocation[]} ? L : readonly SpatialPlacementPublishedLocation[];
  orientation: string;
  pendingOverlays: SpatialPlacementOverlay[];
  entries: SpatialPlacementEntry[];
  staleDrafts: SpatialPlacementEntry[];
  conflicts: SpatialPlacementEntry[];
  unplacedLocationIds: string[];
};

/** Returns a detached validated payload, never trims identities or fills unknowns. */
export function validateSpatialPlacementDraft(value: unknown, options?: {previous?: unknown}): SpatialPlacementDraft;
/** Descriptors only. Storage/CAS/locks/dependency inserts remain the caller's job. */
export function spatialPlacementReferences(value: unknown): SpatialPlacementReferenceDescriptor[];
/** Does not change PENDING_CONFIRMATION, select newer evidence or rebase stale data. */
export function assessSpatialPlacementDraft(value: unknown, basis: SpatialPlacementBasis): SpatialPlacementAssessment;
export function projectSpatialPlacements<S extends SpatialPlacementSpatial | null>(input: {
  spatial: S;
  drafts: readonly {note: unknown; content: unknown}[];
  basis: SpatialPlacementBasis;
}): SpatialPlacementProjection<S>;

/** Server storage adapter projection; malformed and historical notes remain readable. */
export type StoredSpatialPlacementEntry = {
  note: SpatialPlacementReference;
  title: string;
  historical: boolean;
  state: string;
  draftHeadRevisionId: string | null;
  adoptedRevisionId: string | null;
  content: SpatialPlacementDraft | null;
  classification: SpatialPlacementEntry['classification'] | 'CONFLICT' | 'INVALID_DRAFT';
  freshness: 'CURRENT' | 'STALE';
  issues: Array<{code:string;message:string}>;
};
export type SpatialPlacementWorkspace = {
  status: string;
  basis: SpatialPlacementBasis;
  entries: StoredSpatialPlacementEntry[];
  pendingOverlays: SpatialPlacementOverlay[];
  staleDrafts: StoredSpatialPlacementEntry[];
  conflicts: StoredSpatialPlacementEntry[];
  issues: Array<{code:string;message:string}>;
  unplacedLocationIds: string[];
  locations: Array<{id:string;title:string;historical:boolean}>;
  formalAdoptionPerformed: false;
};
