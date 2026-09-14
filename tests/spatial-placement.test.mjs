import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPATIAL_PLACEMENT_LIMITS,
  SpatialPlacementError,
  validateSpatialPlacementDraft,
  spatialPlacementReferences,
  assessSpatialPlacementDraft,
  projectSpatialPlacements,
} from '../web/presentation/spatial-placement.mjs';

// Synthetic permanent identities and hashes only; no project data or storage.
const clone = value => structuredClone(value);
const ref = (id, digit = 'a') => ({id, revisionId: `revision:${id}:1`, sha256: digit.repeat(64), expectedVersion: 1});
function draft(id = 'location-pending') {
  return {
    schemaVersion: '1.0', role: 'SPATIAL_PLACEMENT_DRAFT', status: 'PENDING_CONFIRMATION',
    location: ref(id), spatialSource: {...ref('source-spatial', 'b'), sourceSha256: 'c'.repeat(64)},
    coordinateSpace: 'CANVAS_ONLY', proposedSlot: [1536, 224], authority: 'A', entrance: 'UNKNOWN',
    sceneEvidence: {status: 'UNKNOWN', reason: '尚无精确场修订绑定'},
    unknowns: ['地理位置', '门向与路线'], note: '为独立地点提供可点击的示意卡槽',
  };
}
function withScenes(value = draft()) {
  value.sceneEvidence = {status: 'EXACT', references: [{...ref('scene-one', 'd'), locator: 'blocks[0]'}, ref('scene-two', 'e')]};
  return value;
}
function basis(values = [draft()]) {
  const scenes = new Map();
  for (const value of values) for (const {locator, ...r} of value.sceneEvidence.references || []) scenes.set(r.id, {...r, kind: 'SCENE', historical: false});
  return {
    spatialSource: values.length ? {...clone(values[0].spatialSource), kind: 'SOURCE', role: 'SPATIAL_SPECIFICATION', historical: false} : null,
    locations: values.map(value => ({...clone(value.location), kind: 'ENTITY', type: 'LOCATION', historical: false})),
    scenes: [...scenes.values()],
  };
}
const noteRow = (value = draft(), id = 'note-placement') => ({note: ref(id, 'f'), content: value});
function published() {
  return {
    orientation: '北上东右', version: 'synthetic-baseline',
    locations: Array.from({length: 14}, (_, i) => ({
      id: `published-${i + 1}`, name: `Synthetic ${i + 1}`, pos: [i * 3 - 18, 24 - i * 2],
      entrance: ['NORTH', 'WEST', 'UNKNOWN'][i % 3], fact: 'F', lock: 'L',
      extra: {sourcePointer: `locations[${i}]`},
    })),
    sceneRouteLocks: [{id: 'published-route', direction: 'NORTH'}],
  };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function invalid(value, code = 'SPATIAL_PLACEMENT_INVALID') {
  assert.throws(() => validateSpatialPlacementDraft(value), error => error instanceof SpatialPlacementError && error.code === code && error.path.startsWith('draft'));
}
function project(values = [draft()], spatial = published(), current = basis(values)) {
  return projectSpatialPlacements({spatial, drafts: values.map((v, i) => noteRow(v, `note-${i}`)), basis: current});
}

test('valid UNKNOWN and exact scene payloads stay pending and are detached from inputs', () => {
  for (const input of [draft(), withScenes()]) {
    input.authority = 'UNKNOWN'; freeze(input);
    const result = validateSpatialPlacementDraft(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
    assert.notEqual(result.location, input.location);
    assert.notEqual(result.spatialSource, input.spatialSource);
    assert.notEqual(result.proposedSlot, input.proposedSlot);
    assert.notEqual(result.sceneEvidence, input.sceneEvidence);
    result.proposedSlot[0] = 0;
    assert.equal(input.proposedSlot[0], 1536);
    const assessed = assessSpatialPlacementDraft(input, freeze(basis([input])));
    assert.equal(assessed.freshness, 'CURRENT');
    assert.equal(assessed.draft.status, 'PENDING_CONFIRMATION');
    assert.equal(assessed.draft.authority, 'UNKNOWN');
    assert.deepEqual(assessed.issues, []);
  }
});

test('revision dependency hashes are distinct from SOURCE original byte hash', () => {
  const input = freeze(withScenes());
  const references = spatialPlacementReferences(input);
  assert.deepEqual(references.map(r => [r.id, r.kind, r.purpose]), [
    ['location-pending', 'ENTITY', 'DEFINITION'], ['source-spatial', 'SOURCE', 'SOURCE'],
    ['scene-one', 'SCENE', 'CONTENT'], ['scene-two', 'SCENE', 'CONTENT'],
  ]);
  const source = references.find(r => r.kind === 'SOURCE');
  assert.equal(source.sha256, 'b'.repeat(64));
  assert.equal(source.sourceSha256, 'c'.repeat(64));
  const assertions = references.map(({id, expectedVersion}) => ({type: 'assert', id, expectedVersion}));
  const dependencies = references.map(({revisionId, sha256, purpose}) => ({revisionId, sha256, purpose}));
  assert.equal(assertions.length, 4);
  assert.equal(dependencies[1].sha256, input.spatialSource.sha256);
  assert.ok(references.every(r => !Object.hasOwn(r, 'locator')));
  assert.deepEqual(spatialPlacementReferences(draft()).map(r => r.kind), ['ENTITY', 'SOURCE']);
  references[0].revisionId = 'changed-return-only';
  assert.equal(input.location.revisionId, 'revision:location-pending:1');
});

test('F/L, production authority, published states and geographic fields are rejected', () => {
  for (const authority of ['F', 'L', 'U', 'ADOPTED', '', null]) invalid({...draft(), authority});
  for (const status of ['PUBLISHED', 'ADOPTED', 'CONFIRMED', 'DRAFT', 'F', 'L', null]) invalid({...draft(), status});
  for (const entrance of ['NORTH', 'EAST', '北', '', null]) invalid({...draft(), entrance});
  for (const coordinateSpace of ['GEOGRAPHIC', 'NORTH_UP_EAST_RIGHT', 'BASELINE', null]) invalid({...draft(), coordinateSpace});
  for (const key of ['pos', 'anchor', 'shadow', 'zone', 'lock', 'fact', 'publishedRevisionId', 'adoptedRevisionId', 'sceneRouteLocks', 'geometryEligible']) invalid({...draft(), [key]: 'forged'});
  invalid({...draft(), role: 'SPATIAL_SPECIFICATION'});
  invalid({...draft(), schemaVersion: '2.0'});
});

test('unknown fields, incomplete shapes, non-JSON objects and getters are rejected', () => {
  for (const value of [null, [], new Date(), Object.create({role: 'SPATIAL_PLACEMENT_DRAFT'})]) invalid(value);
  for (const key of Object.keys(draft())) {
    const value = draft(); delete value[key]; invalid(value);
  }
  for (const field of ['location', 'spatialSource', 'sceneEvidence']) {
    const value = draft(); value[field].unexpected = true; invalid(value);
  }
  const exactEvidence = withScenes(); exactEvidence.sceneEvidence.references[0].scope = 'PROJECT'; invalid(exactEvidence);
  const hidden = draft(); Object.defineProperty(hidden, 'hidden', {value: 1}); invalid(hidden);
  const symbol = draft(); symbol[Symbol('extra')] = 1; invalid(symbol);
  const proto = JSON.parse(JSON.stringify(draft()).replace('"schemaVersion"', '"__proto__":{},"schemaVersion"')); invalid(proto);
  let getterCalls = 0;
  const getter = draft(); Object.defineProperty(getter, 'authority', {enumerable: true, get() { getterCalls++; return 'A'; }});
  invalid(getter); assert.equal(getterCalls, 0);
  const arrayGetter = draft(); Object.defineProperty(arrayGetter.proposedSlot, '0', {enumerable: true, get() { getterCalls++; return 1; }});
  invalid(arrayGetter); assert.equal(getterCalls, 0);
});

test('identifiers, exact SHA values, versions and coordinates are strictly bounded', () => {
  for (const field of ['location', 'spatialSource']) {
    for (const id of ['', ' ', 'bad\u0000id', 'a'.repeat(1025)]) invalid({...draft(), [field]: {...draft()[field], id}});
    for (const revisionId of ['', 1, 'a'.repeat(1025)]) invalid({...draft(), [field]: {...draft()[field], revisionId}});
    for (const sha256 of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), null]) invalid({...draft(), [field]: {...draft()[field], sha256}});
    for (const expectedVersion of [0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) invalid({...draft(), [field]: {...draft()[field], expectedVersion}});
  }
  invalid({...draft(), spatialSource: {...draft().spatialSource, sourceSha256: 'invalid'}});
  for (const proposedSlot of [null, [], [1], [1, 2, 3], [NaN, 1], [1, Infinity], [-Infinity, 1], ['1', 1], [100001, 1], [1, -100001], Array(2)]) invalid({...draft(), proposedSlot});
  const extra = draft(); extra.proposedSlot.extra = 1; invalid(extra);
  for (const note of ['', ' ', '\u007f', 'a'.repeat(2001)]) invalid({...draft(), note});
  const edge = draft(); edge.proposedSlot = [-100000, 100000]; edge.location.expectedVersion = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(validateSpatialPlacementDraft(edge).proposedSlot, edge.proposedSlot);
  const exactIdentity = draft(' identity-with-spaces ');
  assert.equal(validateSpatialPlacementDraft(exactIdentity).location.id, ' identity-with-spaces ');
  assert.deepEqual(validateSpatialPlacementDraft({...draft(), proposedSlot: [-0, -1.25]}).proposedSlot, [0, -1.25]);
});

test('scene evidence requires exact bounded revisions or an explicit missing reason', () => {
  invalid({...draft(), sceneEvidence: {status: 'UNKNOWN', reason: ''}});
  invalid({...draft(), sceneEvidence: {status: 'UNKNOWN', reason: '未绑定', references: []}});
  invalid({...draft(), sceneEvidence: {status: 'EXACT', references: []}});
  invalid({...draft(), sceneEvidence: {status: 'CURRENT_SCRIPT_CONFIRMED', references: []}});
  const noVersion = withScenes(); delete noVersion.sceneEvidence.references[0].expectedVersion; invalid(noVersion);
  const repeated = withScenes(); repeated.sceneEvidence.references.push(clone(repeated.sceneEvidence.references[0])); invalid(repeated, 'SPATIAL_PLACEMENT_DUPLICATE');
  const sameRevision = withScenes(); sameRevision.sceneEvidence.references[1].revisionId = sameRevision.sceneEvidence.references[0].revisionId; invalid(sameRevision, 'SPATIAL_PLACEMENT_DUPLICATE');
  const sourceAlias = withScenes(); sourceAlias.sceneEvidence.references[0] = ref(sourceAlias.spatialSource.id); invalid(sourceAlias, 'SPATIAL_PLACEMENT_DUPLICATE');
  const targetAlias = draft(); targetAlias.spatialSource.id = targetAlias.location.id; invalid(targetAlias, 'SPATIAL_PLACEMENT_DUPLICATE');
  const many = draft(); many.sceneEvidence = {status: 'EXACT', references: Array.from({length: 21}, (_, i) => ref(`scene-${i}`))}; invalid(many);
  invalid({...draft(), unknowns: []});
  invalid({...draft(), unknowns: Array.from({length: 33}, (_, i) => `Unknown ${i}`)});
  invalid({...draft(), unknowns: ['重复', '重复']}, 'SPATIAL_PLACEMENT_DUPLICATE');
});

test('byte budgets reject oversized individual drafts and projection collections', () => {
  const large = draft(); large.unknowns = Array.from({length: 32}, (_, i) => `${i}${'界'.repeat(1900)}`);
  invalid(large, 'SPATIAL_PLACEMENT_TOO_LARGE');
  const values = Array.from({length: 40}, (_, i) => {
    const value = draft(`large-${i}`); value.unknowns = Array.from({length: 20}, (_, j) => `${j}${'x'.repeat(1490)}`);
    assert.ok(JSON.stringify(validateSpatialPlacementDraft(value)).length < SPATIAL_PLACEMENT_LIMITS.draftBytes);
    return value;
  });
  assert.throws(() => project(values), {code: 'SPATIAL_PLACEMENT_TOO_LARGE'});
  assert.throws(() => project(Array.from({length: 101}, (_, i) => draft(`many-${i}`))), {code: 'SPATIAL_PLACEMENT_INVALID'});
  const hugeBasis = basis(); hugeBasis.locations = Array.from({length: 5001}, (_, i) => ({...ref(`location-${i}`), kind: 'ENTITY', type: 'LOCATION', historical: false}));
  assert.throws(() => assessSpatialPlacementDraft(draft(), hugeBasis), {code: 'SPATIAL_PLACEMENT_INVALID'});
});

test('editing a NOTE keeps all exact bindings fixed, including source bytes and evidence', () => {
  const previous = withScenes(), changed = clone(previous);
  changed.proposedSlot = [42, -20]; changed.authority = 'UNKNOWN'; changed.note = '修改卡槽说明'; changed.unknowns.push('距离');
  changed.sceneEvidence.references.reverse();
  assert.deepEqual(validateSpatialPlacementDraft(changed, {previous}), changed);
  for (const mutate of [
    v => { v.location.id = 'different-permanent-location'; },
    v => { v.location.revisionId = 'different-location-revision'; },
    v => { v.location.expectedVersion++; },
    v => { v.spatialSource.id = 'different-source'; },
    v => { v.spatialSource.revisionId = 'different-source-revision'; },
    v => { v.spatialSource.sha256 = 'd'.repeat(64); },
    v => { v.spatialSource.sourceSha256 = 'e'.repeat(64); },
    v => { v.sceneEvidence.references[0].revisionId = 'new-scene-revision'; },
    v => { v.sceneEvidence.references[0].locator = 'blocks[99]'; },
    v => { v.sceneEvidence = {status: 'UNKNOWN', reason: '丢弃旧证据'}; },
  ]) {
    const value = clone(previous); mutate(value);
    assert.throws(() => validateSpatialPlacementDraft(value, {previous}), {code: 'SPATIAL_PLACEMENT_BINDING_IMMUTABLE'});
  }
  assert.throws(() => validateSpatialPlacementDraft(withScenes(), {previous: draft()}), {code: 'SPATIAL_PLACEMENT_BINDING_IMMUTABLE'});
  const unknownEdit = draft(); unknownEdit.sceneEvidence.reason = '补充缺项说明';
  assert.deepEqual(validateSpatialPlacementDraft(unknownEdit, {previous: draft()}), unknownEdit);
});

test('five pending overlays preserve all 14 published objects, positions, entrances, locks and north-up orientation', () => {
  const values = freeze(Array.from({length: 5}, (_, i) => ({...draft(`pending-${i}`), proposedSlot: [1536, 224 + i * 128]})));
  const spatial = freeze(published()), current = freeze(basis(values));
  const snapshot = JSON.stringify({values, spatial, current});
  const result = project(values, spatial, current);
  assert.equal(result.spatial, spatial); assert.equal(result.locations, spatial.locations);
  assert.equal(result.orientation, '北上东右');
  spatial.locations.forEach((location, i) => {
    assert.equal(result.locations[i], location); assert.equal(result.locations[i].pos, location.pos);
    assert.equal(result.locations[i].extra, location.extra);
  });
  assert.equal(result.pendingOverlays.length, 5); assert.equal(result.locations.length, 14);
  assert.deepEqual(result.staleDrafts, []); assert.deepEqual(result.conflicts, []); assert.deepEqual(result.unplacedLocationIds, []);
  assert.deepEqual(result.pendingOverlays.map(v => v.targetEntityId), values.map(v => v.location.id));
  for (const [i, overlay] of result.pendingOverlays.entries()) {
    assert.equal(overlay.status, 'PENDING_CONFIRMATION'); assert.equal(overlay.entrance, 'UNKNOWN');
    assert.equal(overlay.geometryEligible, false); assert.equal(overlay.statusLabel, '待确认示意位置');
    assert.equal(overlay.coordinateSpace, 'CANVAS_ONLY'); assert.match(overlay.zoneLabel, /非地理位置/);
    assert.deepEqual([overlay.x, overlay.y], values[i].proposedSlot);
    for (const field of ['pos', 'anchor', 'shadow', 'routes', 'edges', 'camera', 'zone', 'fixedGeometry', 'lock', 'fact']) assert.equal(Object.hasOwn(overlay, field), false, field);
  }
  assert.equal(JSON.stringify({values, spatial, current}), snapshot);
  result.pendingOverlays[0].x = 0; result.entries[0].content.note = '修改返回值';
  assert.equal(JSON.stringify({values, spatial, current}), snapshot);
});

test('fresh drafts cannot shadow an existing published anchor or create another location object', () => {
  const value = draft('published-1'), spatial = freeze(published()), result = project([value], spatial);
  assert.equal(result.locations[0], spatial.locations[0]); assert.equal(result.pendingOverlays.length, 0);
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].classification, 'PUBLISHED_ANCHOR_EXISTS');
  assert.equal(result.conflicts[0].content.status, 'PENDING_CONFIRMATION');
  assert.deepEqual(result.unplacedLocationIds, []);
  const unanchored = {orientation: 'UNKNOWN', locations: [{id: value.location.id, entrance: 'UNKNOWN'}]};
  const other = project([value], unanchored);
  assert.equal(other.locations, unanchored.locations); assert.equal(other.pendingOverlays.length, 1);
  assert.equal(Object.hasOwn(unanchored.locations[0], 'pos'), false);
});

test('source and target changes report exact changed fields without rebinding', () => {
  const value = freeze(draft());
  for (const [role, target, field, replacement] of [
    ['SPATIAL_SOURCE', 'spatialSource', 'id', 'replacement-source'],
    ['SPATIAL_SOURCE', 'spatialSource', 'revisionId', 'revision-source-next'],
    ['SPATIAL_SOURCE', 'spatialSource', 'sha256', 'd'.repeat(64)],
    ['SPATIAL_SOURCE', 'spatialSource', 'sourceSha256', 'e'.repeat(64)],
    ['SPATIAL_SOURCE', 'spatialSource', 'expectedVersion', 2],
    ['LOCATION', 'location', 'revisionId', 'revision-location-next'],
    ['LOCATION', 'location', 'sha256', 'f'.repeat(64)],
    ['LOCATION', 'location', 'expectedVersion', 2],
  ]) {
    const current = basis([value]), object = target === 'location' ? current.locations[0] : current.spatialSource;
    object[field] = replacement;
    const result = assessSpatialPlacementDraft(value, current);
    assert.equal(result.freshness, 'STALE'); assert.deepEqual(result.draft, value);
    assert.deepEqual(result.issues.map(i => [i.code, i.role, i.changedFields]), [['REFERENCE_CHANGED', role, [field]]]);
    assert.equal(result.issues[0].expected[field], value[target][field]);
    assert.equal(result.issues[0].actual[field], replacement);
  }
});

test('missing/renamed references and historical/wrong-kind objects remain explicitly stale', () => {
  const value = withScenes();
  const cases = [
    ['LOCATION', current => { current.locations = []; }, 'REFERENCE_MISSING'],
    ['LOCATION', current => { current.locations[0].id = 'renamed-location'; }, 'REFERENCE_MISSING'],
    ['SPATIAL_SOURCE', current => { current.spatialSource = null; }, 'REFERENCE_MISSING'],
    ['SCENE_EVIDENCE', current => { current.scenes = current.scenes.slice(1); }, 'REFERENCE_MISSING'],
    ['LOCATION', current => { current.locations[0].historical = true; }, 'REFERENCE_HISTORICAL'],
    ['SPATIAL_SOURCE', current => { current.spatialSource.historical = true; }, 'REFERENCE_HISTORICAL'],
    ['SCENE_EVIDENCE', current => { current.scenes[0].historical = true; }, 'REFERENCE_HISTORICAL'],
    ['LOCATION', current => { current.locations[0].type = 'CHARACTER'; }, 'REFERENCE_KIND_CHANGED'],
    ['LOCATION', current => { current.locations[0].kind = 'NOTE'; }, 'REFERENCE_KIND_CHANGED'],
    ['SPATIAL_SOURCE', current => { current.spatialSource.role = 'OTHER'; }, 'REFERENCE_KIND_CHANGED'],
    ['SCENE_EVIDENCE', current => { current.scenes[0].kind = 'EPISODE'; }, 'REFERENCE_KIND_CHANGED'],
  ];
  for (const [role, change, code] of cases) {
    const current = basis([value]); change(current);
    const assessed = assessSpatialPlacementDraft(value, current);
    assert.equal(assessed.freshness, 'STALE'); assert.equal(assessed.issues[0].code, code); assert.equal(assessed.issues[0].role, role);
    assert.deepEqual(assessed.draft, value);
    if (code === 'REFERENCE_MISSING') assert.equal(assessed.issues[0].actual, null);
  }
});

test('only actually cited scene revisions cause staleness; unrelated object changes do not', () => {
  const value = withScenes();
  for (const [field, changed] of [['revisionId', 'new-scene-revision'], ['sha256', 'f'.repeat(64)], ['expectedVersion', 2]]) {
    const current = basis([value]); current.scenes[1][field] = changed;
    const result = assessSpatialPlacementDraft(value, current);
    assert.equal(result.freshness, 'STALE'); assert.equal(result.issues[0].role, 'SCENE_EVIDENCE');
    assert.deepEqual(result.issues[0].changedFields, [field]);
    assert.equal(result.issues[0].expected.id, 'scene-two');
  }
  const current = basis([value]);
  current.locations.push({...ref('unrelated-location'), expectedVersion: 999, kind: 'ENTITY', type: 'LOCATION', historical: false});
  current.scenes.push({...ref('unrelated-scene'), expectedVersion: 999, kind: 'SCENE', historical: true});
  assert.equal(assessSpatialPlacementDraft(value, current).freshness, 'CURRENT');
  const unknown = draft(), unknownCurrent = basis([unknown]); unknownCurrent.scenes = current.scenes;
  assert.equal(assessSpatialPlacementDraft(unknown, unknownCurrent).freshness, 'CURRENT');
  assert.equal(spatialPlacementReferences(unknown).length, 2);
});

test('stale NOTE and original proposed slot remain inspectable, outside the live overlay', () => {
  const old = freeze(withScenes()), other = draft('second-pending'), spatial = freeze(published());
  const current = basis([old, other]); current.scenes[0].revisionId = 'new-evidence-revision';
  const result = project([old, other], spatial, freeze(current));
  assert.deepEqual(result.pendingOverlays.map(v => v.targetEntityId), [other.location.id]);
  assert.equal(result.staleDrafts.length, 1);
  const stale = result.staleDrafts[0];
  assert.equal(stale.classification, 'STALE_DRAFT'); assert.deepEqual(stale.content, old);
  assert.deepEqual(stale.note, ref('note-0', 'f')); assert.equal(stale.content.status, 'PENDING_CONFIRMATION');
  assert.equal(stale.issues[0].expected.revisionId, old.sceneEvidence.references[0].revisionId);
  assert.equal(stale.issues[0].actual.revisionId, 'new-evidence-revision');
  assert.equal(Object.hasOwn(stale, 'x'), false); assert.deepEqual(result.unplacedLocationIds, [old.location.id]);
  assert.equal(result.spatial, spatial); assert.equal(result.locations, spatial.locations);
  const changedSource = basis([old]); changedSource.spatialSource = {...changedSource.spatialSource, id: 'other-source', revisionId: 'other-source-revision'};
  const replaced = project([old], spatial, changedSource);
  assert.equal(replaced.pendingOverlays.length, 0); assert.deepEqual(replaced.staleDrafts[0].content.spatialSource, old.spatialSource);
});

test('mixed source revisions are classified individually, never replaced by the newer draft', () => {
  const old = draft('old-target'), fresh = draft('fresh-target');
  fresh.spatialSource.revisionId = 'new-source-revision'; fresh.spatialSource.expectedVersion = 2;
  const current = basis([fresh, old]), result = project([old, fresh], published(), current);
  assert.deepEqual(result.pendingOverlays.map(v => v.targetEntityId), ['fresh-target']);
  assert.deepEqual(result.staleDrafts.map(v => v.content.location.id), ['old-target']);
  assert.deepEqual(result.staleDrafts[0].content.spatialSource, old.spatialSource);
});

test('duplicate NOTE, target, current or published identities fail instead of selecting a winner', () => {
  const value = draft(), second = draft('second-target'), current = basis([value, second]);
  for (const rows of [
    [noteRow(value), noteRow(second)],
    [noteRow(value, 'first-note'), noteRow(value, 'second-note')],
    [noteRow(value, 'first-note'), {...noteRow(second, 'second-note'), note: {...ref('second-note'), revisionId: ref('first-note').revisionId}}],
    [noteRow(value, value.location.id)],
    [noteRow(value, second.location.id), noteRow(second, 'second-note')],
    [noteRow(value, 'first-note'), noteRow(second, value.spatialSource.id)],
  ]) assert.throws(() => projectSpatialPlacements({spatial: published(), drafts: rows, basis: current}), {code: 'SPATIAL_PLACEMENT_DUPLICATE'});
  const repeatedBasis = basis([value]); repeatedBasis.locations.push(clone(repeatedBasis.locations[0]));
  assert.throws(() => assessSpatialPlacementDraft(value, repeatedBasis), {code: 'SPATIAL_PLACEMENT_DUPLICATE'});
  const reusedRevision = basis([value, second]); reusedRevision.locations[1].revisionId = reusedRevision.locations[0].revisionId;
  assert.throws(() => assessSpatialPlacementDraft(value, reusedRevision), {code: 'SPATIAL_PLACEMENT_DUPLICATE'});
  const spatial = published(); spatial.locations.push(clone(spatial.locations[0]));
  assert.throws(() => project([value], spatial), {code: 'SPATIAL_PLACEMENT_DUPLICATE'});
});

test('no implicit source, scene binding, orientation or project scope is supplied', () => {
  const value = draft(), current = basis([value]); current.spatialSource = null;
  const result = project([value], null, current);
  assert.equal(result.spatial, null); assert.equal(result.orientation, 'UNKNOWN');
  assert.deepEqual(result.locations, []); assert.deepEqual(result.pendingOverlays, []);
  assert.equal(result.staleDrafts[0].issues[0].role, 'SPATIAL_SOURCE');
  assert.deepEqual(project([], null, basis([])).unplacedLocationIds, []);
  assert.equal(project([], {orientation: '方向待核'}, basis([])).orientation, '方向待核');
  for (const orientation of ['', null, 123, {}]) {
    const spatial = {orientation}, output = project([], spatial, basis([]));
    assert.equal(output.orientation, 'UNKNOWN'); assert.equal(output.spatial, spatial);
  }
  const incomplete = basis([value]); delete incomplete.spatialSource;
  assert.throws(() => assessSpatialPlacementDraft(value, incomplete), {code: 'SPATIAL_PLACEMENT_INVALID'});
  const missingHistory = basis([value]); delete missingHistory.locations[0].historical;
  assert.throws(() => assessSpatialPlacementDraft(value, missingHistory), {code: 'SPATIAL_PLACEMENT_INVALID'});
  const extraField = basis([value]); extraField.releaseId = 'whole-story-release';
  assert.throws(() => assessSpatialPlacementDraft(value, extraField), {code: 'SPATIAL_PLACEMENT_INVALID'});
});
