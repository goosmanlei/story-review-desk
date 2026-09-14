/**
 * Pure NOTE payload / read projection shared by the server and Web.
 * One NOTE contains one pending placement. No I/O, clocks, generated identities,
 * source normalization, adoption, rebase, route or production geometry lives here.
 *
 * Integration (the adapter must perform these steps in workspace.change):
 * 1. Read an explicit current spatial SOURCE, ENTITY/type LOCATION and any SCENE
 *    evidence. sha256 always means revisions.sha256; sourceSha256 separately pins
 *    source_documents.original_sha256 and must be verified against the raw bytes.
 *    EXACT scene evidence identifies revisions; it does not assert script adoption.
 * 2. Validate the payload with {previous: oldPayload} when editing an existing NOTE.
 *    Bindings cannot be changed through that edit. A stale NOTE stays inspectable;
 *    a separately reviewed replacement must explicitly supersede it in the adapter.
 * 3. Check NOTE kind/role, nonhistorical state, expectedVersion AND draft revision,
 *    operationId/runtime epoch, and uniqueness of active NOTE per target. Lock the
 *    NOTE, target, selected SOURCE and evidence objects through transaction commands;
 *    re-read after locks, including the unique current SOURCE selection. Reject a
 *    STALE assessment. These pure functions cannot establish storage authenticity.
 * 4. Append only a NOTE draft, preserving all adopted heads and original sources.
 *    Use every spatialPlacementReferences() item for an assert(id, expectedVersion)
 *    and dependency(revisionId, sha256, purpose). Keep sourceSha256 in the payload;
 *    never substitute it for a dependency's revision-content sha256. Server metadata
 *    (e.g. reviewSpec) belongs outside this strict payload, or must be handled by an
 *    explicit storage adapter. Guard this role against generic submit/adopt/publish.
 *
 * Example with already-read, synthetic adapter values:
 *   const content = validateSpatialPlacementDraft(input, {previous: oldPayload});
 *   const assessment = assessSpatialPlacementDraft(content, currentBasis);
 *   // Adapter rejects assessment.freshness === 'STALE' before saving.
 *   const refs = spatialPlacementReferences(content);
 *   const assertions = refs.map(({id, expectedVersion}) =>
 *     ({type: 'assert', id, expectedVersion}));
 *   const dependencies = refs.map(({revisionId, sha256, purpose}) =>
 *     ({revisionId, sha256, purpose}));
 *   // Adapter combines assertions + a CAS NOTE save, with ENTITY/SOURCE/SCENE links.
 *   const map = projectSpatialPlacements({spatial, drafts: notePayloads, basis: currentBasis});
 *   // map.locations === spatial.locations; map.spatial === spatial.
 *   // Draw map.pendingOverlays as separate cards using x/y in canvas pixels;
 *   // onSelect(card.targetEntityId) opens the permanent ENTITY. Do not give these
 *   // cards anchors, shadows, entrance symbols, graph edges or geographic meaning.
 *   // Keep map.staleDrafts / map.conflicts readable, outside the live overlay.
 */

export const SPATIAL_PLACEMENT_ROLE = 'SPATIAL_PLACEMENT_DRAFT';
export const SPATIAL_PLACEMENT_STATUS = 'PENDING_CONFIRMATION';
export const SPATIAL_PLACEMENT_LIMITS = Object.freeze({
  drafts: 100,
  sceneReferences: 20,
  unknowns: 32,
  identifierLength: 1024,
  textLength: 2000,
  coordinateMagnitude: 100000,
  currentObjects: 5000,
  draftBytes: 64 * 1024,
  projectionDraftBytes: 1024 * 1024,
});

export class SpatialPlacementError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = 'SpatialPlacementError';
    this.code = code;
    this.status = 400;
    this.path = path;
  }
}

const refKeys = ['id', 'revisionId', 'sha256', 'expectedVersion'];
const sourceKeys = [...refKeys, 'sourceSha256'];
const limits = SPATIAL_PLACEMENT_LIMITS;
function fail(path, message, code = 'SPATIAL_PLACEMENT_INVALID') {
  throw new SpatialPlacementError(code, path, message);
}
function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, '必须是普通数据对象');
  }
}
function exact(value, required, optional, path) {
  record(value, path);
  const keys = Reflect.ownKeys(value), allowed = [...required, ...optional];
  if (keys.length > allowed.length || keys.some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key)) || keys.some(key => {
        const d = Object.getOwnPropertyDescriptor(value, key);
        return !d.enumerable || !Object.hasOwn(d, 'value');
      })) fail(path, '字段必须完整，不能含未知字段、访问器或隐藏字段');
  return value;
}
function array(value, max, path, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, `数组长度必须为 ${min}–${max}`);
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(path, '数组不能有缺项或额外字段');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) fail(path, '数组不能有缺项或访问器');
  }
  return value;
}
function text(value, path, max = limits.textLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value)) fail(path, '请填写有界文本，不得含控制字符');
  return value;
}
function id(value, path) { return text(value, path, limits.identifierLength); }
function sha(value, path) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(path, '必须是精确的小写 SHA-256');
  return value;
}
function choice(value, values, path) {
  if (!values.includes(value)) fail(path, '不支持此值');
  return value;
}
function boolean(value, path) {
  if (typeof value !== 'boolean') fail(path, '必须明确提供布尔值');
  return value;
}
function reference(value, path, extra = [], optional = []) {
  exact(value, [...refKeys, ...extra], optional, path);
  if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) fail(`${path}.expectedVersion`, '必须是已存在对象的正整数版本');
  return {
    id: id(value.id, `${path}.id`),
    revisionId: id(value.revisionId, `${path}.revisionId`),
    sha256: sha(value.sha256, `${path}.sha256`),
    expectedVersion: value.expectedVersion,
  };
}
function sourceReference(value, path, extra = []) {
  return {...reference(value, path, ['sourceSha256', ...extra]), sourceSha256: sha(value.sourceSha256, `${path}.sourceSha256`)};
}
function duplicate(path, message) { fail(path, message, 'SPATIAL_PLACEMENT_DUPLICATE'); }
function uniqueReferences(refs, path) {
  const ids = new Set(), revisions = new Set();
  for (const ref of refs) {
    if (ids.has(ref.id) || revisions.has(ref.revisionId)) duplicate(path, '对象或修订身份重复，不能选择其一或换绑');
    ids.add(ref.id); revisions.add(ref.revisionId);
  }
}
function byteLength(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function sceneEvidence(value, path) {
  record(value, path);
  const status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
  if (status === 'UNKNOWN') {
    exact(value, ['status', 'reason'], [], path);
    return {status, reason: text(value.reason, `${path}.reason`)};
  }
  exact(value, ['status', 'references'], [], path);
  choice(status, ['EXACT'], `${path}.status`);
  const references = array(value.references, limits.sceneReferences, `${path}.references`, 1).map((r, i) => {
    const p = `${path}.references[${i}]`, ref = reference(r, p, [], ['locator']);
    return Object.hasOwn(r, 'locator') ? {...ref, locator: text(r.locator, `${p}.locator`)} : ref;
  });
  uniqueReferences(references, path);
  return {status, references};
}
function canonicalDraft(value) {
  const path = 'draft';
  exact(value, ['schemaVersion', 'role', 'status', 'location', 'spatialSource', 'coordinateSpace', 'proposedSlot', 'authority', 'entrance', 'sceneEvidence', 'unknowns', 'note'], [], path);
  const slot = array(value.proposedSlot, 2, `${path}.proposedSlot`, 2).map((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limits.coordinateMagnitude) fail(`${path}.proposedSlot[${i}]`, '必须是有界的有限画布像素值');
    return v === 0 ? 0 : v;
  });
  const unknowns = array(value.unknowns, limits.unknowns, `${path}.unknowns`, 1).map((v, i) => text(v, `${path}.unknowns[${i}]`));
  if (new Set(unknowns).size !== unknowns.length) duplicate(`${path}.unknowns`, '缺项说明重复');
  const draft = {
    schemaVersion: choice(value.schemaVersion, ['1.0'], `${path}.schemaVersion`),
    role: choice(value.role, [SPATIAL_PLACEMENT_ROLE], `${path}.role`),
    status: choice(value.status, [SPATIAL_PLACEMENT_STATUS], `${path}.status`),
    location: reference(value.location, `${path}.location`),
    spatialSource: sourceReference(value.spatialSource, `${path}.spatialSource`),
    coordinateSpace: choice(value.coordinateSpace, ['CANVAS_ONLY'], `${path}.coordinateSpace`),
    proposedSlot: slot,
    authority: choice(value.authority, ['A', 'UNKNOWN'], `${path}.authority`),
    entrance: choice(value.entrance, ['UNKNOWN'], `${path}.entrance`),
    sceneEvidence: sceneEvidence(value.sceneEvidence, `${path}.sceneEvidence`),
    unknowns,
    note: text(value.note, `${path}.note`),
  };
  uniqueReferences([draft.location, draft.spatialSource, ...(draft.sceneEvidence.references || [])], path);
  if (byteLength(draft) > limits.draftBytes) fail(path, '草稿超过字节上限', 'SPATIAL_PLACEMENT_TOO_LARGE');
  return draft;
}
const equalReference = (a, b, keys = refKeys) => keys.every(key => a[key] === b[key]);
function evidenceIdentity(evidence) {
  return evidence.status === 'UNKNOWN' ? 'UNKNOWN' : JSON.stringify([...evidence.references].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Returns a detached payload. Editing a NOTE can change the slot/proposal only. */
export function validateSpatialPlacementDraft(value, options = {}) {
  exact(options, [], ['previous'], 'options');
  const draft = canonicalDraft(value);
  if (options.previous !== undefined && options.previous !== null) {
    const previous = canonicalDraft(options.previous);
    if (!equalReference(draft.location, previous.location) ||
        !equalReference(draft.spatialSource, previous.spatialSource, sourceKeys) ||
        evidenceIdentity(draft.sceneEvidence) !== evidenceIdentity(previous.sceneEvidence)) {
      fail('draft', '已有草稿的地点、空间来源与场证据绑定不可换绑', 'SPATIAL_PLACEMENT_BINDING_IMMUTABLE');
    }
  }
  return draft;
}

/** Pure descriptors for adapter CAS assertions and exact revision dependencies. */
export function spatialPlacementReferences(value) {
  const draft = validateSpatialPlacementDraft(value);
  return [
    {...draft.location, kind: 'ENTITY', purpose: 'DEFINITION'},
    {...draft.spatialSource, kind: 'SOURCE', purpose: 'SOURCE'},
    ...(draft.sceneEvidence.references || []).map(({locator, ...ref}) => ({...ref, kind: 'SCENE', purpose: 'CONTENT'})),
  ];
}

function currentObject(value, path, role) {
  const extra = role === 'SPATIAL_SOURCE' ? ['kind', 'role', 'historical'] : role === 'LOCATION' ? ['kind', 'type', 'historical'] : ['kind', 'historical'];
  const ref = role === 'SPATIAL_SOURCE' ? sourceReference(value, path, extra) : reference(value, path, extra);
  return {
    ...ref, kind: text(value.kind, `${path}.kind`, 100), historical: boolean(value.historical, `${path}.historical`),
    ...(role === 'LOCATION' ? {type: text(value.type, `${path}.type`, 100)} : {}),
    ...(role === 'SPATIAL_SOURCE' ? {role: text(value.role, `${path}.role`, 100)} : {}),
  };
}
function currentBasis(value) {
  exact(value, ['spatialSource', 'locations', 'scenes'], [], 'basis');
  const source = value.spatialSource === null ? null : currentObject(value.spatialSource, 'basis.spatialSource', 'SPATIAL_SOURCE');
  const locations = array(value.locations, limits.currentObjects, 'basis.locations').map((v, i) => currentObject(v, `basis.locations[${i}]`, 'LOCATION'));
  const scenes = array(value.scenes, limits.currentObjects, 'basis.scenes').map((v, i) => currentObject(v, `basis.scenes[${i}]`, 'SCENE_EVIDENCE'));
  uniqueReferences([...(source ? [source] : []), ...locations, ...scenes], 'basis');
  return {spatialSource: source, locations, scenes, locationIndex: new Map(locations.map(v => [v.id, v])), sceneIndex: new Map(scenes.map(v => [v.id, v]))};
}
function assess(draft, basis) {
  const issues = [];
  function compare(role, expected, actual) {
    const add = (code, changedFields, message) => issues.push({code, role, expected: {...expected}, actual: actual ? {...actual} : null, changedFields, message});
    if (!actual) { add('REFERENCE_MISSING', [], '精确依据缺失，保留原稿供核对'); return; }
    const requiredKind = {LOCATION: 'ENTITY', SPATIAL_SOURCE: 'SOURCE', SCENE_EVIDENCE: 'SCENE'}[role];
    const kindFields = [...(actual.kind !== requiredKind ? ['kind'] : []), ...(role === 'LOCATION' && actual.type !== 'LOCATION' ? ['type'] : []), ...(role === 'SPATIAL_SOURCE' && actual.role !== 'SPATIAL_SPECIFICATION' ? ['role'] : [])];
    if (kindFields.length) add('REFERENCE_KIND_CHANGED', kindFields, '依据不是所需的永久地点、空间来源或场');
    if (actual.historical) add('REFERENCE_HISTORICAL', ['historical'], '依据已退出当前目录，保留原稿供核对');
    const changed = (role === 'SPATIAL_SOURCE' ? sourceKeys : refKeys).filter(key => expected[key] !== actual[key]);
    if (changed.length) add('REFERENCE_CHANGED', changed, '依据身份、精确修订或版本已变化，未套用新稿');
  }
  compare('LOCATION', draft.location, basis.locationIndex.get(draft.location.id));
  compare('SPATIAL_SOURCE', draft.spatialSource, basis.spatialSource);
  for (const ref of draft.sceneEvidence.references || []) compare('SCENE_EVIDENCE', ref, basis.sceneIndex.get(ref.id));
  return {draft, freshness: issues.length ? 'STALE' : 'CURRENT', issues};
}

/** A CURRENT basis never upgrades the draft's PENDING_CONFIRMATION status. */
export function assessSpatialPlacementDraft(value, basis) {
  return assess(validateSpatialPlacementDraft(value), currentBasis(basis));
}

/**
 * spatial/locations are passed through by identity, including positions, entrances,
 * locks, orientation and all source-specific fields. Only fresh unanchored targets
 * get cards. Stale payloads are returned verbatim in meaning with their NOTE ref.
 */
export function projectSpatialPlacements(input) {
  exact(input, ['spatial', 'drafts', 'basis'], [], 'projection');
  const basis = currentBasis(input.basis), spatial = input.spatial;
  if (spatial !== null) record(spatial, 'projection.spatial');
  const locations = spatial?.locations === undefined ? [] : array(spatial.locations, limits.currentObjects, 'projection.spatial.locations');
  const declaredIds = new Set(), anchoredIds = new Set();
  for (const location of locations) {
    record(location, 'projection.spatial.locations[]');
    id(location.id, 'projection.spatial.locations[].id');
    if (declaredIds.has(location.id)) duplicate('projection.spatial.locations', '来源地点身份重复');
    declaredIds.add(location.id);
    if (Array.isArray(location.pos) && location.pos.length === 2 && Number.isFinite(location.pos[0]) && Number.isFinite(location.pos[1])) anchoredIds.add(location.id);
  }
  const noteIds = new Set(), noteRevisions = new Set(), targetIds = new Set();
  const inputIds = new Set(), inputRevisions = new Set();
  const entries = [], pendingOverlays = [];
  let bytes = 0;
  for (const [i, row] of array(input.drafts, limits.drafts, 'projection.drafts').entries()) {
    const path = `projection.drafts[${i}]`;
    exact(row, ['note', 'content'], [], path);
    const note = reference(row.note, `${path}.note`), content = validateSpatialPlacementDraft(row.content);
    if (noteIds.has(note.id) || noteRevisions.has(note.revisionId) || targetIds.has(content.location.id)) duplicate(path, 'NOTE 或永久地点重复，不隐式选择最新草稿');
    // A NOTE cannot masquerade as any draft's input, even when projection is stale.
    const inputs = [content.location, content.spatialSource, ...(content.sceneEvidence.references || [])];
    uniqueReferences([note, ...inputs], path);
    if (inputIds.has(note.id) || inputRevisions.has(note.revisionId) || inputs.some(r => noteIds.has(r.id) || noteRevisions.has(r.revisionId))) duplicate(path, 'NOTE 与依据对象或修订身份冲突');
    for (const ref of inputs) { inputIds.add(ref.id); inputRevisions.add(ref.revisionId); }
    noteIds.add(note.id); noteRevisions.add(note.revisionId); targetIds.add(content.location.id);
    bytes += byteLength({note, content});
    if (bytes > limits.projectionDraftBytes) fail('projection.drafts', '草稿集合超过字节上限', 'SPATIAL_PLACEMENT_TOO_LARGE');
    const {freshness, issues} = assess(content, basis);
    const classification = freshness === 'STALE' ? 'STALE_DRAFT' : anchoredIds.has(content.location.id) ? 'PUBLISHED_ANCHOR_EXISTS' : 'PENDING_OVERLAY';
    const entry = {note, content, freshness, issues, classification};
    entries.push(entry);
    if (classification === 'PENDING_OVERLAY') pendingOverlays.push({
      note: {...note}, targetEntityId: content.location.id,
      status: SPATIAL_PLACEMENT_STATUS, authority: content.authority,
      coordinateSpace: 'CANVAS_ONLY', x: content.proposedSlot[0], y: content.proposedSlot[1],
      statusLabel: '待确认示意位置', zoneLabel: '待确认示意区（非地理位置）',
      entrance: 'UNKNOWN', geometryEligible: false,
    });
  }
  const visiblePendingIds = new Set(pendingOverlays.map(v => v.targetEntityId));
  return {
    spatial, locations, orientation: typeof spatial?.orientation === 'string' && spatial.orientation.trim() ? spatial.orientation : 'UNKNOWN',
    pendingOverlays, entries,
    staleDrafts: entries.filter(v => v.classification === 'STALE_DRAFT'),
    conflicts: entries.filter(v => v.classification === 'PUBLISHED_ANCHOR_EXISTS'),
    unplacedLocationIds: basis.locations.filter(v => v.kind === 'ENTITY' && v.type === 'LOCATION' && !v.historical && !anchoredIds.has(v.id) && !visiblePendingIds.has(v.id)).map(v => v.id),
  };
}
