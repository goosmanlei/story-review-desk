import { narrativeExcerpt, validateNarrativeRevision } from '../_narrative-revision';
import {assertScopedEpisodeSceneBasis} from '../episode-plan-reviews/_release';
import {scopedPlanningReviewSpec} from '../episode-plan-reviews/_planning';
import type { NarrativeRevision } from '../../../narrative-revision';
import {configHash,reviewSpec} from '../../../../host/instance-runtime/configuration-model.mjs';
import { episodeExcerptBlocks } from '../_episode-evidence';
import { episodePlanIdFor } from '../../../instance-profile';
import {
  appendEvent,
  assertCreativeRevisionBasisCurrent,
  assertShotPlanMaterialBasisCurrent,
  deriveCurrentAdoptedMaterialSet,
  deriveCurrentMaterialRequirementSet,
  assertJsonObject,
  assertSha256,
  assertStableId,
  assertString,
  currentCreativeSubjectBaseHash,
  errorResponse,
  eventLimit,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  operationalSnapshot,
  optionalString,
  replayIdempotentEvent,
  stableObjectHash,
  validateMutationRequest,
} from '../_store';

const subjectKinds = new Set([
  'SEQUENCE', 'EPISODE', 'SCENE', 'SHOT_INTENT',
  'EPISODE_PLAN', 'SCENE_COVERAGE', 'SHOT_PLAN_SET',
]);
const writableSubjectKinds = new Set(['EPISODE_PLAN', 'SCENE_COVERAGE', 'SHOT_PLAN_SET']);
const authorityClasses = new Set(['A', 'L']);
const scopeTypes = new Set(['SHOT', 'SCENE', 'EPISODE', 'PROJECT']);
const requiredBasisTypes: Record<string, string[]> = {
  EPISODE_PLAN: ['STORY_REVISION', 'SCRIPT_REVISION'],
  SCENE_COVERAGE: ['SCENE_SCRIPT_REVISION', 'EPISODE_PLAN_REVISION', 'CONTINUITY_SPEC'],
  SHOT_PLAN_SET: ['SCENE_COVERAGE_REVISION', 'ADOPTED_MATERIAL_SET'],
};

function validateSubject(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  subjectKind: string,
  subjectId: string,
) {
  if (subjectKind === 'SEQUENCE') {
    if (!/^SEQ-(?:0[1-9]|10)$/.test(subjectId)) throw new HttpError(422, 'unknown SEQUENCE subjectId');
    return;
  }
  if (subjectKind === 'EPISODE' && data.productionModel.episodes?.some((item) => item.id === subjectId)) return;
  if (subjectKind === 'SCENE' && data.productionModel.scenes?.some((item) => item.id === subjectId)) return;
  if (subjectKind === 'SHOT_INTENT' && data.productionModel.shots?.some((item) => item.id === subjectId)) return;
  if (subjectKind === 'EPISODE_PLAN' && data.productionModel.episodePlanRevisions?.some((item) => item.planId === subjectId)) return;
  if (subjectKind === 'SCENE_COVERAGE' && data.productionModel.sceneCoveragePlanRevisions?.some((item) => item.planId === subjectId)) return;
  if (subjectKind === 'SHOT_PLAN_SET' && data.productionModel.shotPlanSetRevisions?.some((item) => item.planId === subjectId)) return;
  throw new HttpError(422, `unknown ${subjectKind} subjectId`);
}

type BasisBinding = {
  bindingType: string;
  bindingId: string;
  bindingHash: string;
  scopeType?: string;
  scopeId?: string;
};

type EpisodeIdentity = {
  episodeUid: string;
  sceneIds: string[];
};

type EpisodePlanIdentityLedger = {
  predecessorEpisodes: EpisodeIdentity[];
  predecessorActiveUids: string[];
  retiredUids: string[];
};

const episodeUidPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

function assertEpisodeUid(value: unknown, name: string) {
  const episodeUid = assertString(value, name, 160);
  if (!episodeUidPattern.test(episodeUid)) {
    throw new HttpError(400, `${name} must be a stable episode UID`);
  }
  return episodeUid;
}

function recordId(record: Record<string, unknown>) {
  return String(record.id || record.revisionId || record.snapshotId || record.planId || '');
}

function recordHash(record: Record<string, unknown>) {
  return String(record.revisionHash || record.contentHash || record.snapshotHash || record.sourceSha256 || record.sha256 || '').toLowerCase();
}

function bindingRows(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  bindingType: string,
) {
  const rowsByType: Record<string, Array<Record<string, unknown>> | undefined> = {
    STORY_REVISION: data.productionModel.storyRevisions,
    SCRIPT_REVISION: data.productionModel.scriptRevisions,
    SCENE_SCRIPT_REVISION: data.productionModel.sceneScriptRevisions,
    EPISODE_PLAN_REVISION: data.productionModel.episodePlanRevisions,
    EPISODE_NARRATIVE_RELEASE: (data.productionModel as unknown as {episodeNarrativeReleases?:Array<Record<string,unknown>>}).episodeNarrativeReleases,
    SCENE_COVERAGE_REVISION: data.productionModel.sceneCoveragePlanRevisions,
    SCREENPLAY_RELEASE_SNAPSHOT: data.productionModel.screenplayReleaseSnapshots,
    SCOPE_LOCK: data.productionModel.scopeLocks,
    SHOT_PLAN_SET_REVISION: data.productionModel.shotPlanSetRevisions,
  };
  return rowsByType[bindingType] || [];
}

function nestedRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function materialRequirementClasses(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
) {
  const rows = data.productionModel.materialRequirements;
  if (!Array.isArray(rows)) {
    throw new HttpError(503, 'current MaterialRequirement projection is unavailable');
  }
  const classes = new Map<string, string>();
  for (const [index, rawRow] of rows.entries()) {
    const row = nestedRecord(rawRow);
    const requirementId = typeof row.id === 'string' ? row.id : '';
    const requirementClass = typeof row.requirementClass === 'string' ? row.requirementClass : '';
    if (!requirementId || !requirementClass || classes.has(requirementId)) {
      throw new HttpError(503, 'current MaterialRequirement projection is not canonical', {
        index,
        requirementId: requirementId || null,
      });
    }
    classes.set(requirementId, requirementClass);
  }
  return classes;
}

function assertRequiredMaterialRequirementRefs(
  refs: string[],
  classes: Map<string, string>,
  field: string,
  status = 422,
) {
  const invalidRefs = refs.filter((ref) => classes.get(ref) !== 'REQUIRED');
  if (invalidRefs.length) {
    throw new HttpError(status, `${field} must resolve only to current REQUIRED MaterialRequirements`, {
      invalidRefs,
      requirementClasses: Object.fromEntries(invalidRefs.map((ref) => [ref, classes.get(ref) || 'ORPHAN'])),
    });
  }
}

function staticRevisionIsCurrentAndSynced(row: Record<string, unknown>) {
  const review = nestedRecord(row.review);
  const sync = nestedRecord(row.sync);
  const current = row.scopeRole === 'CURRENT'
    && (row.revisionState === 'CURRENT' || row.releaseState === 'CURRENT' || row.isCurrent === true);
  const adopted = ['ADOPTED', 'RELEASED', 'CURRENT'].includes(String(review.state || ''))
    || ['RELEASED', 'CURRENT'].includes(String(review.decision || ''));
  const synced = ['SOURCE_CURRENT', 'SUCCEEDED'].includes(String(sync.state || row.sourceSyncState || ''));
  return current && adopted && synced;
}

async function validateSemanticBasis(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  subjectKind: string,
  subjectId: string,
  bindings: BasisBinding[],
) {
  if (!['SCENE_COVERAGE', 'SHOT_PLAN_SET'].includes(subjectKind)) return;
  const operations = await operationalSnapshot();
  if (operations.snapshotId !== data.snapshotId) throw new HttpError(409, 'basis projection snapshot changed during validation');
  const state = operations.stateProjection as unknown as {
    episodeNarrativeReleasesByUid?: Record<string, Record<string, unknown> | undefined>;
    structuresById?: Record<string, Record<string, unknown> | undefined>;
    scriptScenesById?: Record<string, Record<string, unknown> | undefined>;
    assetFamiliesById?: Record<string, Record<string, unknown> | undefined>;
    assetVersionsById?: Record<string, Record<string, unknown> | undefined>;
    scopeLocksById?: Record<string, Record<string, unknown> | undefined>;
  };
  const bindingByType = new Map(bindings.map((binding) => [binding.bindingType, binding]));
  const scenePlanRows = subjectKind === 'SCENE_COVERAGE'
    ? data.productionModel.sceneCoveragePlanRevisions
    : data.productionModel.shotPlanSetRevisions;
  const subjectRow = scenePlanRows?.find((row) => row.planId === subjectId || row.id === subjectId);
  const sceneId = String(subjectRow?.scopeId || subjectRow?.sceneId || '');
  if (!subjectRow || subjectRow.scopeType !== 'SCENE' || !/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(sceneId)) {
    throw new HttpError(503, `${subjectKind} current scene scope is unavailable`);
  }

  if (subjectKind === 'SCENE_COVERAGE') {
    if (bindingByType.has('EPISODE_NARRATIVE_RELEASE')) {
      assertScopedEpisodeSceneBasis(data, state.episodeNarrativeReleasesByUid, sceneId, bindings);
      return;
    }
    const episodeBinding = bindingByType.get('EPISODE_PLAN_REVISION');
    const episodeRow = data.productionModel.episodePlanRevisions?.find((row) => recordId(row) === episodeBinding?.bindingId);
    const episodeProjection = state.structuresById?.[`EPISODE_PLAN::${episodePlanIdFor(data)}`];
    const projectedEpisodeIsCurrent = Boolean(
      episodeProjection
      && episodeProjection.subjectRevisionId === episodeBinding?.bindingId
      && episodeProjection.reviewDecision === 'RELEASED'
      && episodeProjection.sourceSyncState === 'SUCCEEDED'
      && episodeProjection.canFlowDownstream === true,
    );
    if (!episodeBinding || (!staticRevisionIsCurrentAndSynced(episodeRow || {}) && !projectedEpisodeIsCurrent)) {
      throw new HttpError(409, 'SCENE_COVERAGE requires the current adopted and source-synced EpisodePlanRevision', {
        reasonCode: 'CURRENT_SYNCED_EPISODE_PLAN_REQUIRED',
      });
    }
    const sceneBinding = bindingByType.get('SCENE_SCRIPT_REVISION');
    const sceneRevision = data.productionModel.sceneScriptRevisions?.find((row) => recordId(row) === sceneBinding?.bindingId);
    const sceneProjection = state.scriptScenesById?.[sceneId];
    if (
      !sceneBinding
      || !sceneRevision
      || sceneRevision.sceneId !== sceneId
      || sceneProjection?.reviewDecision !== 'RELEASED'
      || sceneProjection.lifecycleState !== 'RELEASED'
      || sceneProjection.canFlowDownstream !== true
    ) {
      throw new HttpError(409, 'SCENE_COVERAGE requires the released current SceneScriptRevision for the same scene', {
        reasonCode: 'RELEASED_SCENE_SCRIPT_REQUIRED',
        sceneId,
      });
    }
    const continuity = bindingByType.get('CONTINUITY_SPEC');
    const currentContinuityHash = String(data.sourceHashes?.productionMapSha256 || '').toLowerCase();
    if (
      !continuity
      || continuity.bindingId !== 'PRODUCTION-MAP-SPEC'
      || !currentContinuityHash
      || continuity.bindingHash !== currentContinuityHash
    ) {
      throw new HttpError(409, 'CONTINUITY_SPEC does not resolve to the current production map', {
        reasonCode: 'CURRENT_CONTINUITY_SPEC_REQUIRED',
        currentContinuityHash: currentContinuityHash || null,
      });
    }
    return;
  }

  const coverageBinding = bindingByType.get('SCENE_COVERAGE_REVISION');
  const sceneLock = Object.values(state.scopeLocksById || {}).find((row) => (
    row?.scopeType === 'SCENE'
    && row.scopeId === sceneId
    && row.lockPurpose === 'SHOT_PLAN_SET'
  ));
  const projectedCoverageReady = Boolean(
    coverageBinding
    && sceneLock
    && ['READY_TO_LOCK', 'LOCKED'].includes(String(sceneLock.lockState || sceneLock.scopeLockState || ''))
    && ['APPLIED_SYNCED_SCENE_COVERAGE_READY', 'APPLIED_SYNCED_SHOT_PLAN_SET'].includes(String(sceneLock.effectiveLockSource || ''))
    && sceneLock.readyRevisionId === coverageBinding?.bindingId
    && sceneLock.readyRevisionHash === coverageBinding?.bindingHash
  );
  const coverageScopeMatches = Boolean(
    coverageBinding
    && coverageBinding.scopeType === 'SCENE'
    && coverageBinding.scopeId === sceneId
  );
  if (
    !coverageBinding
    || !coverageScopeMatches
    || !sceneLock
    || !projectedCoverageReady
  ) {
    throw new HttpError(409, 'SHOT_PLAN_SET requires a released, source-synced SceneCoverageRevision ready for plan authoring', {
      reasonCode: 'RELEASED_SYNCED_SCENE_COVERAGE_REQUIRED',
      sceneId,
    });
  }
  assertShotPlanMaterialBasisCurrent(data, state, sceneId, bindings);
}

async function basisBindings(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  subjectKind: string,
  subjectId: string,
  value: unknown,
) {
  const required = (requiredBasisTypes[subjectKind] || []).map(type => {
    if (type === 'EPISODE_PLAN_REVISION' && Array.isArray(value) && value.some(b => b?.bindingType === 'EPISODE_NARRATIVE_RELEASE')) return 'EPISODE_NARRATIVE_RELEASE';
    if (type === 'ADOPTED_MATERIAL_SET' && Array.isArray(value) && value.some(b => b?.bindingType === 'MATERIAL_REQUIREMENT_SET')) return 'MATERIAL_REQUIREMENT_SET';
    return type;
  });
  if (value == null && !required.length) return [] as BasisBinding[];
  if (!Array.isArray(value) || value.length < (required.length ? 1 : 0) || value.length > 200) {
    throw new HttpError(400, 'basisBindings must be an array with at most 200 entries');
  }
  const bindings = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, `basisBindings[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const bindingType = assertStableId(row.bindingType ?? row.type, `basisBindings[${index}].bindingType`, 80);
    const bindingId = assertStableId(row.bindingId ?? row.id, `basisBindings[${index}].bindingId`);
    const bindingHash = assertSha256(row.bindingHash ?? row.hash, `basisBindings[${index}].bindingHash`);
    const scopeType = row.scopeType == null || row.scopeType === ''
      ? ''
      : assertStableId(row.scopeType, `basisBindings[${index}].scopeType`, 20);
    const scopeId = row.scopeId == null || row.scopeId === ''
      ? ''
      : assertStableId(row.scopeId, `basisBindings[${index}].scopeId`);
    if (Boolean(scopeType) !== Boolean(scopeId)) throw new HttpError(400, `basisBindings[${index}] scopeType and scopeId must be supplied together`);
    if (scopeType && !scopeTypes.has(scopeType)) throw new HttpError(400, `basisBindings[${index}].scopeType is invalid`);
    return {
      bindingType,
      bindingId,
      bindingHash,
      ...(scopeType ? { scopeType, scopeId } : {}),
    };
  });
  const keys = bindings.map((item) => `${item.bindingType}::${item.bindingId}`);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, 'basisBindings contains duplicate bindings');
  const bindingTypes = bindings.map((item) => item.bindingType);
  if (new Set(bindingTypes).size !== bindingTypes.length) {
    throw new HttpError(400, 'basisBindings contains duplicate bindingType values');
  }
  const presentTypes = new Set(bindings.map((item) => item.bindingType));
  const missingTypes = required.filter((type) => !presentTypes.has(type));
  if (missingTypes.length) {
    throw new HttpError(422, `${subjectKind} basisBindings are incomplete`, { missingBindingTypes: missingTypes });
  }
  for (const binding of bindings) {
    const rows = bindingRows(data, binding.bindingType);
    if (!rows.length) continue;
    const bound = rows.find((row) => recordId(row) === binding.bindingId);
    // SceneCoverage candidates are event-native revisions and therefore are
    // not copied into the immutable generated baseline.  Their exact
    // revision/hash/release/sync binding is resolved against structuresById in
    // validateSemanticBasis below.
    if (
      !bound
      && subjectKind === 'SHOT_PLAN_SET'
      && binding.bindingType === 'SCENE_COVERAGE_REVISION'
    ) continue;
    if (!bound) throw new HttpError(422, `basis binding ${binding.bindingType}:${binding.bindingId} does not resolve in the current business graph`);
    const currentHash = recordHash(bound);
    if (!currentHash || currentHash !== binding.bindingHash) {
      throw new HttpError(409, `basis binding ${binding.bindingType}:${binding.bindingId} is stale`, {
        currentBindingHash: currentHash || null,
      });
    }
  }
  await validateSemanticBasis(data, subjectKind, subjectId, bindings);
  return bindings.sort((left, right) => (
    left.bindingType.localeCompare(right.bindingType) || left.bindingId.localeCompare(right.bindingId)
  ));
}

function canonicalNarrativeClaim(value: unknown, path: string, allowedClasses: string[] = ['F', 'A', 'L', 'U']) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${path} must be an object`);
  const row = value as Record<string, unknown>;
  const claimClass = assertString(row.class, `${path}.class`, 1);
  if (!allowedClasses.includes(claimClass)) throw new HttpError(422, `${path}.class is invalid`);
  const text = assertString(row.text, `${path}.text`, 8_000);
  if (!Array.isArray(row.evidenceRefs)) throw new HttpError(400, `${path}.evidenceRefs must be an array`);
  const evidenceRefs = row.evidenceRefs.map((ref, index) => assertString(ref, `${path}.evidenceRefs[${index}]`, 2_000));
  if (claimClass !== 'U' && evidenceRefs.length === 0) throw new HttpError(422, `${path} non-U claims require evidenceRefs`);
  return { class: claimClass, text, evidenceRefs };
}

function canonicalEpisodeReviewDossier(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  value: unknown,
  episodeUid: string,
  sceneIds: string[],
  path: string,
  narrative?: NarrativeRevision,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${path} must be an object`);
  const row = value as Record<string, unknown>;
  if (!['1.0', '1.1'].includes(String(row.schemaVersion))) throw new HttpError(422, `${path}.schemaVersion must be 1.0 or 1.1`);
  const enhanced = row.schemaVersion === '1.1';
  if (enhanced && Object.keys(row).some((key) => !['schemaVersion','purpose','progressionSlices','informationLayers','payoff','comedyBeats','causalChainIds','sceneFlow','boundaryEvidence','authoringUnknowns'].includes(key))) throw new HttpError(422, 'Unknown review dossier fields cannot be silently discarded');
  const purpose = row.purpose && typeof row.purpose === 'object' && !Array.isArray(row.purpose)
    ? row.purpose as Record<string, unknown>
    : {};
  const information = row.informationLayers && typeof row.informationLayers === 'object' && !Array.isArray(row.informationLayers)
    ? row.informationLayers as Record<string, unknown>
    : {};
  const payoff = row.payoff && typeof row.payoff === 'object' && !Array.isArray(row.payoff)
    ? row.payoff as Record<string, unknown>
    : {};
  if (!Array.isArray(payoff.unresolvedQuestions) || !enhanced && payoff.unresolvedQuestions.length < 1) {
    throw new HttpError(422, `${path}.payoff.unresolvedQuestions must be non-empty`);
  }
  const sequences = narrative ? narrative.sequences : Array.isArray(data.creativeLineage?.storyStructure?.sequences)
    ? data.creativeLineage.storyStructure.sequences as Array<Record<string, unknown>>
    : [];
  const expectedSlices = sequences.flatMap((sequence) => {
    const sequenceSceneIds = Array.isArray(sequence.sceneIds) ? sequence.sceneIds.map(String) : [];
    const scopedSceneIds = sequenceSceneIds.filter((sceneId) => sceneIds.includes(sceneId));
    return scopedSceneIds.length ? [{ sequence, sequenceSceneIds, scopedSceneIds }] : [];
  });
  if (!Array.isArray(row.progressionSlices) || row.progressionSlices.length !== expectedSlices.length) {
    throw new HttpError(422, `${path}.progressionSlices must cover every episode × SEQ intersection exactly once`);
  }
  const progressionSlices = row.progressionSlices.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, `${path}.progressionSlices[${index}] must be an object`);
    const slice = item as Record<string, unknown>;
    const expected = expectedSlices[index];
    const sequenceId = assertStableId(expected.sequence.id, `${path}.progressionSlices[${index}].sequenceId`, 40);
    const sliceId = assertStableId(slice.sliceId, `${path}.progressionSlices[${index}].sliceId`, 220);
    const suppliedSequenceId = assertStableId(slice.sequenceId, `${path}.progressionSlices[${index}].sequenceId`, 40);
    const suppliedSceneIds = Array.isArray(slice.sceneIds) ? slice.sceneIds.map(String) : [];
    const coverageRole = expected.scopedSceneIds.length === expected.sequenceSceneIds.length ? 'FULL_SEQUENCE' : 'EPISODE_SLICE';
    if (
      sliceId !== `${episodeUid}:${sequenceId}`
      || suppliedSequenceId !== sequenceId
      || suppliedSceneIds.join('|') !== expected.scopedSceneIds.join('|')
      || slice.coverageRole !== coverageRole
    ) throw new HttpError(422, `${path}.progressionSlices[${index}] identity or scene scope diverges`);
    return {
      sliceId,
      sequenceId,
      sequenceTitle: canonicalNarrativeClaim(slice.sequenceTitle, `${path}.progressionSlices[${index}].sequenceTitle`, ['A']),
      sceneIds: suppliedSceneIds,
      coverageRole,
      structuralRole: canonicalNarrativeClaim(slice.structuralRole, `${path}.progressionSlices[${index}].structuralRole`, ['A']),
      turningPoint: canonicalNarrativeClaim(slice.turningPoint, `${path}.progressionSlices[${index}].turningPoint`, ['F', 'A', 'L']),
      audienceGain: canonicalNarrativeClaim(slice.audienceGain, `${path}.progressionSlices[${index}].audienceGain`, ['A']),
      outputState: canonicalNarrativeClaim(slice.outputState, `${path}.progressionSlices[${index}].outputState`),
    };
  });
  const comedyBeatsRaw = row.comedyBeats;
  if (!Array.isArray(comedyBeatsRaw)) throw new HttpError(400, `${path}.comedyBeats must be an array`);
  const comedyBeats = comedyBeatsRaw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, `${path}.comedyBeats[${index}] must be an object`);
    const beat = item as Record<string, unknown>;
    const canonicalStoryId = assertStableId(beat.canonicalStoryId, `${path}.comedyBeats[${index}].canonicalStoryId`, 120);
    const beatSceneIds = Array.isArray(beat.sceneIds) ? beat.sceneIds.map(String) : [];
    if (!beatSceneIds.length || beatSceneIds.some((sceneId) => !sceneIds.includes(sceneId))) {
      throw new HttpError(422, `${path}.comedyBeats[${index}] escapes the episode scene scope`);
    }
    return {
      canonicalStoryId,
      sceneIds: beatSceneIds,
      role: canonicalNarrativeClaim(beat.role, `${path}.comedyBeats[${index}].role`, ['A']),
    };
  });
  if (!Array.isArray(row.causalChainIds)) throw new HttpError(400, `${path}.causalChainIds must be an array`);
  const causalChainIds = row.causalChainIds.map((item, index) => assertStableId(item, `${path}.causalChainIds[${index}]`, 120));
  if (new Set(causalChainIds).size !== causalChainIds.length) throw new HttpError(422, `${path}.causalChainIds contains duplicates`);
  const causalChains = narrative ? narrative.causalChains : Array.isArray(data.creativeLineage?.causalChains)
    ? data.creativeLineage.causalChains
    : [];
  const validChains = new Set(causalChains.map((chain) => String(nestedRecord(chain).id || '')));
  if (causalChainIds.some((chainId) => !validChains.has(chainId))) throw new HttpError(422, `${path}.causalChainIds contains an unknown chain`);
  const additions: Record<string, unknown> = {};
  if (enhanced) {
    if (!Array.isArray(row.sceneFlow) || row.sceneFlow.length !== sceneIds.length) throw new HttpError(422, 'sceneFlow must cover this episode exactly once');
    additions.sceneFlow = row.sceneFlow.map((item, index) => {
      const flow = nestedRecord(item);
      if (flow.sceneId !== sceneIds[index]) throw new HttpError(422, 'sceneFlow is not in episode scene order');
      return { sceneId: sceneIds[index], function: canonicalNarrativeClaim(flow.function, `${path}.sceneFlow[${index}].function`, ['A']) };
    });
    const boundary = nestedRecord(row.boundaryEvidence);
    additions.boundaryEvidence = Object.fromEntries(['opening', 'ending'].map((side) => {
      const value = nestedRecord(boundary[side]);
      const sceneId = side === 'opening' ? sceneIds[0] : sceneIds.at(-1)!;
      if (value.sceneId !== sceneId || !Array.isArray(value.blockIds)) throw new HttpError(422, 'boundaryEvidence must bind the actual first or last scene');
      const ref = { sceneId, sceneScriptRevisionId: assertStableId(value.sceneScriptRevisionId, 'sceneScriptRevisionId'),
        sceneContentHash: assertSha256(value.sceneContentHash, 'sceneContentHash'),
        blockIds: value.blockIds.map((id) => assertStableId(id, 'blockId', 300)), excerptSha256: assertSha256(value.excerptSha256, 'excerptSha256') };
      if (narrative) narrativeExcerpt(narrative, ref, side as 'opening' | 'ending');
      else episodeExcerptBlocks(data, ref, side as 'opening' | 'ending');
      return [side, ref];
    }));
    if (!Array.isArray(row.authoringUnknowns)) throw new HttpError(422, 'authoringUnknowns must be an array');
    additions.authoringUnknowns = row.authoringUnknowns.map((claim, index) => canonicalNarrativeClaim(claim, `${path}.authoringUnknowns[${index}]`, ['U']));
    if (!Array.isArray(information.characterKnowledge) || !information.characterKnowledge.length) throw new HttpError(422, 'characterKnowledge must be non-empty');
    if (new Set(information.characterKnowledge.map((item) => nestedRecord(item).subjectId)).size !== information.characterKnowledge.length) throw new HttpError(422, 'characterKnowledge contains duplicate subjects');
  }
  const canonical = {
    schemaVersion: enhanced ? '1.1' : '1.0',
    ...additions,
    purpose: {
      episodeTask: canonicalNarrativeClaim(purpose.episodeTask, `${path}.purpose.episodeTask`, ['A']),
      characterAction: canonicalNarrativeClaim(purpose.characterAction, `${path}.purpose.characterAction`, ['A']),
      expressionFocus: canonicalNarrativeClaim(purpose.expressionFocus, `${path}.purpose.expressionFocus`, ['A']),
    },
    progressionSlices,
    informationLayers: {
      visibleAction: canonicalNarrativeClaim(information.visibleAction, `${path}.informationLayers.visibleAction`, ['F', 'A']),
      hiddenTruth: canonicalNarrativeClaim(information.hiddenTruth, `${path}.informationLayers.hiddenTruth`, ['F', 'U']),
      audiencePosition: canonicalNarrativeClaim(information.audiencePosition, `${path}.informationLayers.audiencePosition`, ['A']),
      ...(enhanced ? { characterKnowledge: (information.characterKnowledge as unknown[]).map((item, index) => {
        const value = nestedRecord(item);
        return { subjectId: assertStableId(value.subjectId, 'character subjectId'), ...(value.displayName ? { displayName: assertString(value.displayName, 'character displayName', 100) } : {}), knowledge: canonicalNarrativeClaim(value.knowledge, `${path}.characterKnowledge[${index}]`, ['F', 'A', 'U']) };
      }) } : {}),
    },
    payoff: {
      deliveredResult: canonicalNarrativeClaim(payoff.deliveredResult, `${path}.payoff.deliveredResult`, ['A', 'F']),
      changedState: canonicalNarrativeClaim(payoff.changedState, `${path}.payoff.changedState`),
      unresolvedQuestions: payoff.unresolvedQuestions.map((item, index) => (
        canonicalNarrativeClaim(item, `${path}.payoff.unresolvedQuestions[${index}]`, enhanced ? ['A'] : ['A', 'U'])
      )),
    },
    comedyBeats,
    causalChainIds,
  };
  if (enhanced && stableObjectHash(row) !== stableObjectHash(canonical)) throw new HttpError(422, 'v1.1 dossier must be canonical; unknown or normalized-away fields are forbidden');
  return canonical;
}

function canonicalEpisodePlanContent(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  subjectId: string,
  value: Record<string, unknown>,
  ledger: EpisodePlanIdentityLedger,
) {
  const planId = assertStableId(value.planId, 'content.planId');
  if (planId !== subjectId || planId !== episodePlanIdFor(data)) {
    throw new HttpError(422, 'EPISODE_PLAN content.planId must equal the configured instance plan identity');
  }
  const narrative = value.narrativeRevision == null ? undefined : validateNarrativeRevision(data, value.narrativeRevision);
  if (!Array.isArray(value.episodes) || value.episodes.length < 1 || value.episodes.length > (narrative?.scenes || data.productionModel.scenes || []).length) {
    throw new HttpError(400, 'content.episodes must be non-empty and cannot exceed the current scene count');
  }
  const episodes = value.episodes.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, `content.episodes[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    const episodeUid = assertEpisodeUid(row.episodeUid, `content.episodes[${index}].episodeUid`);
    const displayId = assertStableId(row.displayId, `content.episodes[${index}].displayId`, 20);
    const expectedDisplayId = `E${String(index + 1).padStart(2, '0')}`;
    if (displayId !== expectedDisplayId) throw new HttpError(422, `content.episodes[${index}].displayId must be ${expectedDisplayId}`);
    if (!Array.isArray(row.sceneIds) || row.sceneIds.length < 1) throw new HttpError(422, `content.episodes[${index}].sceneIds must not be empty`);
    const sceneIds = row.sceneIds.map((sceneId, sceneIndex) => assertStableId(sceneId, `content.episodes[${index}].sceneIds[${sceneIndex}]`, 160));
    if (new Set(sceneIds).size !== sceneIds.length) throw new HttpError(422, `content.episodes[${index}].sceneIds contains duplicates`);
    return {
      episodeUid,
      displayId,
      title: assertString(row.title, `content.episodes[${index}].title`, 1000),
      sceneIds,
      openingHook: assertString(row.openingHook, `content.episodes[${index}].openingHook`, 4000),
      coreAdvance: assertString(row.coreAdvance, `content.episodes[${index}].coreAdvance`, 4000),
      endingCliffhanger: assertString(row.endingCliffhanger, `content.episodes[${index}].endingCliffhanger`, 4000),
      reviewQuestion: assertString(row.reviewQuestion, `content.episodes[${index}].reviewQuestion`, 4000),
      reviewDossier: canonicalEpisodeReviewDossier(
        data, row.reviewDossier, episodeUid, sceneIds, `content.episodes[${index}].reviewDossier`, narrative,
      ),
    };
  });
  const episodeUids = episodes.map((episode) => episode.episodeUid);
  if (new Set(episodeUids).size !== episodeUids.length) throw new HttpError(422, 'content.episodes episodeUid values must be globally unique');
  const reusedRetiredUids = episodeUids.filter((episodeUid) => ledger.retiredUids.includes(episodeUid));
  if (reusedRetiredUids.length) {
    throw new HttpError(409, 'retired episodeUid values can never become active again', {
      reusedRetiredUids: [...new Set(reusedRetiredUids)].sort(),
    });
  }
  const retiredEpisodeUids = [...new Set([
    ...ledger.retiredUids,
    ...ledger.predecessorActiveUids.filter((episodeUid) => !episodeUids.includes(episodeUid)),
  ])].sort();
  if (value.retiredEpisodeUids != null) {
    if (!Array.isArray(value.retiredEpisodeUids)) throw new HttpError(400, 'content.retiredEpisodeUids must be an array');
    const suppliedRetired = value.retiredEpisodeUids.map((item, index) => (
      assertEpisodeUid(item, `content.retiredEpisodeUids[${index}]`)
    ));
    if (
      suppliedRetired.length !== new Set(suppliedRetired).size
      || suppliedRetired.join('|') !== retiredEpisodeUids.join('|')
    ) {
      throw new HttpError(409, 'content.retiredEpisodeUids does not match the append-only episode identity ledger', {
        expectedRetiredEpisodeUids: retiredEpisodeUids,
      });
    }
  }
  const canonicalSceneIds = (narrative?.scenes || data.creativeLineage?.scenes || []).map((scene) => String(scene.id || '')).filter(Boolean);
  const expectedSceneIds = canonicalSceneIds;
  if (!canonicalSceneIds.length || new Set(canonicalSceneIds).size !== canonicalSceneIds.length) {
    throw new HttpError(503, 'the current canonical screenplay scene order is unavailable');
  }
  const submittedSceneIds = episodes.flatMap((episode) => episode.sceneIds);
  if (submittedSceneIds.join('|') !== expectedSceneIds.join('|')) {
    throw new HttpError(422, 'EPISODE_PLAN must cover 全部当前场次 exactly once in canonical order', {
      expectedSceneIds,
      submittedSceneIds,
    });
  }
  if (narrative) {
    // A complete screenplay restructuring creates new scene and episode identities.
    // Every predecessor is explicitly retired; no historical submission is rebound.
    if (episodeUids.some((uid) => ledger.predecessorActiveUids.includes(uid))) throw new HttpError(409, '整剧重构不得复用前方案集身份');
  } else validateEpisodeUidTransition(ledger.predecessorEpisodes, episodes);
  const changeSummary = value.changeSummary == null || value.changeSummary === ''
    ? undefined
    : assertString(value.changeSummary, 'content.changeSummary', 20_000);
  if (new Set(episodes.map((episode) => episode.reviewDossier.schemaVersion)).size !== 1) throw new HttpError(422, 'A complete episode plan must use one dossier schema version');
  return { planId, episodes, retiredEpisodeUids, ...(changeSummary ? { changeSummary } : {}), ...(narrative ? { narrativeRevision: narrative } : {}) };
}

function episodeIdentitiesFromContent(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [] as EpisodeIdentity[];
  const episodes = (value as Record<string, unknown>).episodes;
  if (!Array.isArray(episodes)) return [] as EpisodeIdentity[];
  return episodes.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const episodeUid = row.episodeUid;
    const sceneIds = row.sceneIds;
    if (
      typeof episodeUid !== 'string'
      || !episodeUidPattern.test(episodeUid)
      || !Array.isArray(sceneIds)
      || !sceneIds.length
      || sceneIds.some((sceneId) => typeof sceneId !== 'string' || !sceneId)
    ) return [];
    return [{ episodeUid, sceneIds: sceneIds as string[] }];
  });
}

function intersects(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function validateEpisodeUidTransition(
  predecessorEpisodes: EpisodeIdentity[],
  successorEpisodes: EpisodeIdentity[],
) {
  const predecessorByUid = new Map(predecessorEpisodes.map((episode) => [episode.episodeUid, episode]));
  const successorByUid = new Map(successorEpisodes.map((episode) => [episode.episodeUid, episode]));
  const retainedUids = [...predecessorByUid.keys()].filter((episodeUid) => successorByUid.has(episodeUid));
  const retainedUidSet = new Set(retainedUids);
  const addedUids = [...successorByUid.keys()].filter((episodeUid) => !predecessorByUid.has(episodeUid));
  const removedUids = [...predecessorByUid.keys()].filter((episodeUid) => !successorByUid.has(episodeUid));

  const retainedWithoutPredecessorOverlap = retainedUids.filter((episodeUid) => (
    !intersects(predecessorByUid.get(episodeUid)!.sceneIds, successorByUid.get(episodeUid)!.sceneIds)
  ));
  const addedWithoutSplitPredecessor = addedUids.filter((episodeUid) => {
    const successor = successorByUid.get(episodeUid)!;
    return !retainedUids.some((retainedUid) => (
      intersects(successor.sceneIds, predecessorByUid.get(retainedUid)!.sceneIds)
    ));
  });
  const removedWithoutMergeSuccessor = removedUids.filter((episodeUid) => {
    const predecessor = predecessorByUid.get(episodeUid)!;
    return !retainedUids.some((retainedUid) => (
      intersects(predecessor.sceneIds, successorByUid.get(retainedUid)!.sceneIds)
    ));
  });
  const fullReidentification = predecessorEpisodes.length > 0
    && successorEpisodes.length > 0
    && retainedUidSet.size === 0;

  if (
    fullReidentification
    || retainedWithoutPredecessorOverlap.length
    || addedWithoutSplitPredecessor.length
    || removedWithoutMergeSuccessor.length
  ) {
    throw new HttpError(409, 'EpisodePlan episodeUid transition violates split/merge identity continuity', {
      reasonCode: fullReidentification
        ? 'FULL_REIDENTIFICATION_FORBIDDEN'
        : 'EPISODE_UID_LINEAGE_VIOLATION',
      retainedWithoutPredecessorOverlap: retainedWithoutPredecessorOverlap.sort(),
      addedWithoutSplitPredecessor: addedWithoutSplitPredecessor.sort(),
      removedWithoutMergeSuccessor: removedWithoutMergeSuccessor.sort(),
    });
  }
}

async function episodePlanIdentityLedger(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
) {
  const staticPlan = data.productionModel.episodePlanRevisions?.find((item) => item.planId === episodePlanIdFor(data));
  const predecessorEpisodes = episodeIdentitiesFromContent(staticPlan);
  const rawEpisodeCount = Array.isArray(staticPlan?.episodes) ? staticPlan.episodes.length : 0;
  if (!staticPlan && !(await listAllEvents('creative-revision')).some(event=>event.subjectKind==='EPISODE_PLAN')) return {predecessorEpisodes:[],predecessorActiveUids:[],retiredUids:[]};
  if (!rawEpisodeCount || predecessorEpisodes.length !== rawEpisodeCount) {
    throw new HttpError(500, 'the generated EpisodePlan lacks a complete episode identity lineage');
  }
  const predecessorActiveUids = predecessorEpisodes.map((episode) => episode.episodeUid);
  if (new Set(predecessorActiveUids).size !== predecessorActiveUids.length) {
    throw new HttpError(500, 'the generated EpisodePlan contains duplicate active episodeUid values');
  }
  const rawRetired = staticPlan?.retiredEpisodeUids;
  if (
    !Array.isArray(rawRetired)
    || rawRetired.some((episodeUid) => typeof episodeUid !== 'string' || !episodeUidPattern.test(episodeUid))
    || rawRetired.length !== new Set(rawRetired).size
    || rawRetired.join('|') !== [...rawRetired].sort().join('|')
  ) {
    throw new HttpError(500, 'the generated EpisodePlan lacks a canonical retired episodeUid ledger');
  }
  const retired = new Set(rawRetired as string[]);
  if (predecessorActiveUids.some((episodeUid) => retired.has(episodeUid))) {
    throw new HttpError(500, 'the generated EpisodePlan reactivates a retired episodeUid');
  }
  return { predecessorEpisodes, predecessorActiveUids, retiredUids: [...retired].sort() };
}

export function canonicalSceneScopedContent(
  data: Awaited<ReturnType<typeof validateMutationRequest>>['data'],
  subjectKind: 'SCENE_COVERAGE' | 'SHOT_PLAN_SET',
  subjectId: string,
  value: Record<string, unknown>,
  planBasisBindings: BasisBinding[],
) {
  const requirementClasses = materialRequirementClasses(data);
  const rows = (subjectKind === 'SCENE_COVERAGE'
    ? data.productionModel.sceneCoveragePlanRevisions
    : data.productionModel.shotPlanSetRevisions) || [];
  const subject = rows?.find((row) => row.planId === subjectId);
  const expectedSceneId = String(subject?.scopeId || subject?.sceneId || '');
  if (!subject || subject.scopeType !== 'SCENE' || !/^[A-Za-z0-9][A-Za-z0-9@._:-]{0,299}$/.test(expectedSceneId)) {
    throw new HttpError(503, `${subjectKind} current scene scope is unavailable`);
  }
  const sceneId = assertStableId(value.sceneId, 'content.sceneId', 300);
  if (sceneId !== expectedSceneId) {
    throw new HttpError(422, `${subjectKind} content.sceneId must match the subject scene`, {
      expectedSceneId,
    });
  }
  if (subjectKind === 'SCENE_COVERAGE') {
    if (Object.keys(value).some((key) => !['sceneId', 'beats'].includes(key)) || !Array.isArray(value.beats)) {
      throw new HttpError(422, 'SCENE_COVERAGE content must contain exactly sceneId and beats');
    }
    const forbiddenShotKey = (candidate: unknown): boolean => {
      if (Array.isArray(candidate)) return candidate.some(forbiddenShotKey);
      if (!candidate || typeof candidate !== 'object') return false;
      const record = candidate as Record<string, unknown>;
      return Object.keys(record).some((key) => ['shotId', 'shot_id', 'shots'].includes(key))
        || Object.values(record).some(forbiddenShotKey);
    };
    if (value.beats.length < 1 || value.beats.length > 500 || forbiddenShotKey(value.beats)) {
      throw new HttpError(422, 'SCENE_COVERAGE must contain 1 to 500 beats and must not create formal shot identities');
    }
    const beatIds = new Set<string>();
    const beatFields = [
      'beatId', 'order', 'narrativeBeat', 'audienceTakeaway', 'visualIntent', 'actionIntent',
      'soundIntent', 'dialogueContext', 'materialRequirementRefs',
    ];
    const beats = value.beats.map((item, beatIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !beatFields.includes(key))) {
        throw new HttpError(422, `content.beats[${beatIndex}] does not match the SceneCoverage beat contract`);
      }
      const beat = item as Record<string, unknown>;
      const beatId = assertStableId(beat.beatId, `content.beats[${beatIndex}].beatId`);
      if (!beatId.startsWith(`${sceneId}-B`) || !/^\d{2,3}$/.test(beatId.slice(sceneId.length + 2)) || beatIds.has(beatId)) {
        throw new HttpError(422, `content.beats[${beatIndex}].beatId must be unique and belong to ${sceneId}`);
      }
      beatIds.add(beatId);
      if (!Number.isInteger(beat.order) || beat.order !== beatIndex + 1) {
        throw new HttpError(422, `content.beats[${beatIndex}].order must be the stable 1-based array order`);
      }
      const texts = Object.fromEntries([
        'narrativeBeat', 'audienceTakeaway', 'visualIntent', 'actionIntent',
        'soundIntent', 'dialogueContext',
      ].map((field) => [field, assertString(beat[field], `content.beats[${beatIndex}].${field}`, 20_000)]));
      if (!Array.isArray(beat.materialRequirementRefs) || beat.materialRequirementRefs.length > 200) {
        throw new HttpError(422, `content.beats[${beatIndex}].materialRequirementRefs must be an array`);
      }
      const materialRequirementRefs = beat.materialRequirementRefs.map((ref, refIndex) => (
        assertStableId(ref, `content.beats[${beatIndex}].materialRequirementRefs[${refIndex}]`)
      ));
      if (new Set(materialRequirementRefs).size !== materialRequirementRefs.length) {
        throw new HttpError(422, `content.beats[${beatIndex}].materialRequirementRefs contains duplicates`);
      }
      assertRequiredMaterialRequirementRefs(
        materialRequirementRefs,
        requirementClasses,
        `content.beats[${beatIndex}].materialRequirementRefs`,
      );
      return { beatId, order: beat.order, ...texts, materialRequirementRefs };
    });
    return { sceneId, beats };
  }

  if (
    Object.keys(value).some((key) => !['sceneId', 'identityChangeReason', 'shots'].includes(key))
    || !Array.isArray(value.shots)
    || value.shots.length < 1
    || value.shots.length > 999
  ) {
    throw new HttpError(422, 'SHOT_PLAN_SET content must contain exactly sceneId, identityChangeReason and shots');
  }
  const identityChangeReason = assertString(value.identityChangeReason, 'content.identityChangeReason', 2_000);
  const predecessorContent = nestedRecord(subject.content);
  const predecessorContentShots = Array.isArray(predecessorContent.shots) ? predecessorContent.shots : [];
  const predecessorShotIds = new Set(
    predecessorContentShots.flatMap((shot) => (
      shot && typeof shot === 'object' && !Array.isArray(shot) && typeof (shot as Record<string, unknown>).shotId === 'string'
        ? [String((shot as Record<string, unknown>).shotId)]
        : []
    )),
  );
  const retiredShotIds = new Set(
    rows.flatMap((row) => (
      Array.isArray(row.retiredShotIds)
        ? row.retiredShotIds.filter((shotId): shotId is string => typeof shotId === 'string' && Boolean(shotId))
        : []
    )),
  );
  const shotIds = new Set<string>();
  const coverageBinding = planBasisBindings.find((binding) => binding.bindingType === 'SCENE_COVERAGE_REVISION');
  const coverageRevision = data.productionModel.sceneCoveragePlanRevisions?.find((row) => (
    row.id === coverageBinding?.bindingId
    && row.scopeRole === 'CURRENT'
    && row.revisionState === 'CURRENT'
    && row.contentHash === coverageBinding?.bindingHash
  ));
  const coverageContent = nestedRecord(coverageRevision?.content);
  const coverageBeats = Array.isArray(coverageContent.beats) ? coverageContent.beats : [];
  const coverageBeatIds = new Set(coverageBeats.flatMap((beat) => (
    beat && typeof beat === 'object' && !Array.isArray(beat) && typeof (beat as Record<string, unknown>).beatId === 'string'
      ? [String((beat as Record<string, unknown>).beatId)]
      : []
  )));
  if (!coverageRevision || !coverageBeatIds.size) {
    throw new HttpError(409, 'SHOT_PLAN_SET requires canonical CURRENT SceneCoverage beats in the deployed runtime');
  }
  const coverageMaterialRefsByBeat = new Map<string, string[]>();
  for (const [beatIndex, rawBeat] of coverageBeats.entries()) {
    const beat = nestedRecord(rawBeat);
    const beatId = typeof beat.beatId === 'string' ? beat.beatId : '';
    const rawRefs = beat.materialRequirementRefs;
    if (
      !beatId
      || !Array.isArray(rawRefs)
      || rawRefs.some((ref) => typeof ref !== 'string')
      || rawRefs.length !== new Set(rawRefs).size
    ) {
      throw new HttpError(503, 'CURRENT SceneCoverage materialRequirementRefs are not canonical', {
        beatIndex,
      });
    }
    const refs = rawRefs as string[];
    assertRequiredMaterialRequirementRefs(
      refs,
      requirementClasses,
      `CURRENT SceneCoverage beats[${beatIndex}].materialRequirementRefs`,
      503,
    );
    coverageMaterialRefsByBeat.set(beatId, refs);
  }
  const approvedInputByKey = new Map(planBasisBindings.map((binding) => [
    `${binding.bindingType}::${binding.bindingId}`,
    binding.bindingHash,
  ]));
  const shots = value.shots.map((item, shotIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(422, `content.shots[${shotIndex}] must be a ShotSpec object`);
    }
    const shot = item as Record<string, unknown>;
    const shotFields = [
      'shotId', 'sceneId', 'order', 'title', 'coverageBeatRefs', 'visualIntent', 'actionIntent',
      'soundIntent', 'dialogueContext', 'narrativeBeat', 'audienceTakeaway',
      'materialRequirementRefs', 'inputBindings',
    ];
    if (Object.keys(shot).some((key) => !shotFields.includes(key))) {
      throw new HttpError(422, `content.shots[${shotIndex}] does not match the ShotSpec contract`);
    }
    const shotId = assertStableId(shot.shotId, `content.shots[${shotIndex}].shotId`);
    if (!shotId.startsWith(`${sceneId}-SH`) || !/^\d{2,3}$/.test(shotId.slice(sceneId.length + 3))) {
      throw new HttpError(422, `content.shots[${shotIndex}].shotId must belong to ${sceneId}`);
    }
    if (retiredShotIds.has(shotId)) {
      throw new HttpError(409, `content.shots[${shotIndex}].shotId is permanently retired and may not be reused`);
    }
    if (data.productionModel.shots?.some((existing) => existing.id === shotId) && !predecessorShotIds.has(shotId)) {
      throw new HttpError(409, `content.shots[${shotIndex}].shotId may not reuse a historical or current shot identity`);
    }
    if (shotIds.has(shotId)) throw new HttpError(422, 'SHOT_PLAN_SET contains duplicate shotId values');
    shotIds.add(shotId);
    if (!Number.isInteger(shot.order) || shot.order !== shotIndex + 1) {
      throw new HttpError(422, `content.shots[${shotIndex}].order must be the stable 1-based array order`);
    }
    if (shot.sceneId !== sceneId) {
      throw new HttpError(422, `content.shots[${shotIndex}].sceneId must match content.sceneId`);
    }
    const title = assertString(shot.title, `content.shots[${shotIndex}].title`, 2_000);
    const narrativeBeat = assertString(shot.narrativeBeat, `content.shots[${shotIndex}].narrativeBeat`, 20_000);
    const audienceTakeaway = assertString(shot.audienceTakeaway, `content.shots[${shotIndex}].audienceTakeaway`, 20_000);
    const visualIntent = assertString(shot.visualIntent, `content.shots[${shotIndex}].visualIntent`, 20_000);
    const actionIntent = assertString(shot.actionIntent, `content.shots[${shotIndex}].actionIntent`, 20_000);
    const soundIntent = assertString(shot.soundIntent, `content.shots[${shotIndex}].soundIntent`, 20_000);
    const dialogueContext = assertString(shot.dialogueContext, `content.shots[${shotIndex}].dialogueContext`, 20_000);
    if (!Array.isArray(shot.coverageBeatRefs) || !shot.coverageBeatRefs.length) {
      throw new HttpError(422, `content.shots[${shotIndex}].coverageBeatRefs must be non-empty`);
    }
    const coverageBeatRefs = shot.coverageBeatRefs.map((ref, refIndex) => (
      assertStableId(ref, `content.shots[${shotIndex}].coverageBeatRefs[${refIndex}]`)
    ));
    if (
      new Set(coverageBeatRefs).size !== coverageBeatRefs.length
      || coverageBeatRefs.some((ref) => !coverageBeatIds.has(ref))
    ) {
      throw new HttpError(422, `content.shots[${shotIndex}].coverageBeatRefs must resolve to this CURRENT SceneCoverage`);
    }
    if (!Array.isArray(shot.materialRequirementRefs) || shot.materialRequirementRefs.length > 200) {
      throw new HttpError(422, `content.shots[${shotIndex}].materialRequirementRefs must be an array`);
    }
    const materialRequirementRefs = shot.materialRequirementRefs.map((ref, refIndex) => (
      assertStableId(ref, `content.shots[${shotIndex}].materialRequirementRefs[${refIndex}]`)
    ));
    if (new Set(materialRequirementRefs).size !== materialRequirementRefs.length) {
      throw new HttpError(422, `content.shots[${shotIndex}].materialRequirementRefs contains duplicates`);
    }
    assertRequiredMaterialRequirementRefs(
      materialRequirementRefs,
      requirementClasses,
      `content.shots[${shotIndex}].materialRequirementRefs`,
    );
    const allowedMaterialRequirementRefs = new Set(
      coverageBeatRefs.flatMap((beatId) => coverageMaterialRefsByBeat.get(beatId) || []),
    );
    const crossBeatRefs = materialRequirementRefs.filter((ref) => !allowedMaterialRequirementRefs.has(ref));
    if (crossBeatRefs.length) {
      throw new HttpError(
        422,
        `content.shots[${shotIndex}].materialRequirementRefs must be a subset of its coverageBeatRefs requirements`,
        { crossBeatRefs, coverageBeatRefs },
      );
    }
    if (!Array.isArray(shot.inputBindings) || !shot.inputBindings.length) {
      throw new HttpError(422, `content.shots[${shotIndex}].inputBindings must freeze at least one exact input`);
    }
    const inputBindings = shot.inputBindings.map((rawBinding, bindingIndex) => {
      if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) {
        throw new HttpError(422, `content.shots[${shotIndex}].inputBindings[${bindingIndex}] must be an object`);
      }
      const input = rawBinding as Record<string, unknown>;
      const bindingType = assertStableId(input.bindingType, `content.shots[${shotIndex}].inputBindings[${bindingIndex}].bindingType`, 80);
      const bindingId = assertStableId(input.bindingId, `content.shots[${shotIndex}].inputBindings[${bindingIndex}].bindingId`);
      const bindingHash = assertSha256(input.bindingHash, `content.shots[${shotIndex}].inputBindings[${bindingIndex}].bindingHash`);
      return { bindingType, bindingId, bindingHash };
    }).sort((left, right) => left.bindingType.localeCompare(right.bindingType) || left.bindingId.localeCompare(right.bindingId));
    const bindingKeys = inputBindings.map((binding) => `${binding.bindingType}::${binding.bindingId}`);
    if (new Set(bindingKeys).size !== bindingKeys.length) {
      throw new HttpError(422, `content.shots[${shotIndex}].inputBindings contains duplicates`);
    }
    if (
      inputBindings.length !== approvedInputByKey.size
      || inputBindings.some((binding) => approvedInputByKey.get(`${binding.bindingType}::${binding.bindingId}`) !== binding.bindingHash)
    ) {
      throw new HttpError(422, `content.shots[${shotIndex}].inputBindings must exactly freeze the approved ShotPlanSet basis`);
    }
    return {
      shotId,
      sceneId,
      order: shot.order,
      title,
      coverageBeatRefs,
      narrativeBeat,
      audienceTakeaway,
      visualIntent,
      actionIntent,
      soundIntent,
      dialogueContext,
      materialRequirementRefs,
      inputBindings,
    };
  });
  if (planBasisBindings.some(binding => binding.bindingType === 'MATERIAL_REQUIREMENT_SET')) {
    for (const [beatId, refs] of coverageMaterialRefsByBeat) {
      const beatShots = shots.filter(shot => shot.coverageBeatRefs.includes(beatId));
      if (!beatShots.length || refs.some(ref => !beatShots.some(shot => shot.materialRequirementRefs.includes(ref)))) {
        throw new HttpError(422, '镜头设计 V2 必须完整覆盖各节拍及其素材需求，不可删除缺项以通过', {beatId});
      }
    }
  }
  const nextShotIds = new Set(shots.map((shot) => shot.shotId));
  const identityChanged = predecessorShotIds.size > 0 && (
    predecessorShotIds.size !== nextShotIds.size
    || [...predecessorShotIds].some((shotId) => !nextShotIds.has(shotId))
  );
  if (identityChanged && ['UNKNOWN', 'NO_IDENTITY_CHANGE'].includes(identityChangeReason)) {
    throw new HttpError(422, 'SHOT_PLAN_SET identity changes require an explicit reviewed identityChangeReason');
  }
  return { sceneId, identityChangeReason, shots };
}

function evidenceRefs(value: unknown) {
  if (value == null) return [] as string[];
  if (!Array.isArray(value) || value.length > 200) throw new HttpError(400, 'evidenceRefs must contain at most 200 entries');
  const refs = value.map((item, index) => {
    const ref = optionalString(item, 2000);
    if (!ref) throw new HttpError(400, `evidenceRefs[${index}] is invalid`);
    return ref;
  });
  if (new Set(refs).size !== refs.length) throw new HttpError(400, 'evidenceRefs contains duplicates');
  return refs;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'));
    const subjectKind = url.searchParams.get('subjectKind');
    const subjectId = url.searchParams.get('subjectId');
    const creativeRevisionId = url.searchParams.get('creativeRevisionId') || url.searchParams.get('revisionId');
    if (subjectKind && !subjectKinds.has(subjectKind)) throw new HttpError(400, 'subjectKind is invalid');
    if (subjectId) assertStableId(subjectId, 'subjectId');
    if (creativeRevisionId) assertStableId(creativeRevisionId, 'creativeRevisionId');
    const events = (await listAllEvents('creative-revision'))
      .filter((event) => !subjectKind || event.subjectKind === subjectKind)
      .filter((event) => !subjectId || event.subjectId === subjectId)
      .filter((event) => !creativeRevisionId || event.creativeRevisionId === creativeRevisionId)
      .slice(0, limit);
    const seen = new Set<string>();
    const revisions = events.filter((event) => {
      const key = `${event.subjectKind || ''}::${event.subjectId || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return jsonResponse({ events, revisions, count: revisions.length, totalEvents: events.length });
  } catch (reason) {
    return errorResponse(reason, 'creative revision events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('creative-revision', body);
    const replay = await replayIdempotentEvent('creative-revision', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        creativeRevisionId: replay.event.creativeRevisionId,
        revisionId: replay.event.creativeRevisionId,
        contentHash: replay.event.contentHash,
        contextHash: replay.event.contextHash,
        replayed: true,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        operationalRevision: replay.operations.operationalRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
      }, { headers: { ETag: replay.operations.etag } });
    }
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const subjectKind = assertStableId(body.subjectKind, 'subjectKind', 32);
    const subjectId = assertStableId(body.subjectId, 'subjectId');
    const baseRevisionHash = assertSha256(body.baseRevisionHash, 'baseRevisionHash');
    const rawContent = assertJsonObject(body.content, 'content', subjectKind === 'EPISODE_PLAN' ? 5_000_000 : 250_000);
    const note = optionalString(body.note, 20_000);
    const authorityClass = body.authorityClass == null || body.authorityClass === ''
      ? 'A'
      : assertStableId(body.authorityClass, 'authorityClass', 8);
    const refs = evidenceRefs(body.evidenceRefs);
    if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
    if (!subjectKinds.has(subjectKind)) throw new HttpError(400, 'subjectKind is invalid');
    if (!writableSubjectKinds.has(subjectKind)) {
      throw new HttpError(422, 'legacy SEQUENCE, EPISODE, SCENE and SHOT_INTENT revisions are read-only; create EPISODE_PLAN, SCENE_COVERAGE or SHOT_PLAN_SET');
    }
    if (!authorityClasses.has(authorityClass)) throw new HttpError(400, 'authorityClass must be A or L');
    validateSubject(data, subjectKind, subjectId);
    const episodePlanLedger = subjectKind === 'EPISODE_PLAN'
      ? await episodePlanIdentityLedger(data)
      : null;
    const canonicalBasisBindings = await basisBindings(data, subjectKind, subjectId, body.basisBindings);
    const content = subjectKind === 'EPISODE_PLAN'
      ? canonicalEpisodePlanContent(data, subjectId, rawContent, episodePlanLedger!)
      : canonicalSceneScopedContent(
        data,
        subjectKind as 'SCENE_COVERAGE' | 'SHOT_PLAN_SET',
        subjectId,
        rawContent,
        canonicalBasisBindings,
      );
    const basisBindingsHash = stableObjectHash(canonicalBasisBindings);
    const requirementBased = subjectKind === 'SHOT_PLAN_SET' && canonicalBasisBindings.some(binding => binding.bindingType === 'MATERIAL_REQUIREMENT_SET');
    if (requirementBased && !data.productionModel.shotPlanSetRevisions?.some(row => row.planId === subjectId && row.episodeNarrativeReleaseId)) {
      throw new HttpError(422, '镜头设计 V2 必须从独立已发布的分集场正文进入；旧全剧 V1 同步契约保持不变');
    }
    const materialRequirementSet = requirementBased ? deriveCurrentMaterialRequirementSet(data, String((content as {sceneId:string}).sceneId)) : null;
    const adoptedMaterialSet = subjectKind === 'SHOT_PLAN_SET' && !requirementBased
      ? deriveCurrentAdoptedMaterialSet(
        data,
        (await operationalSnapshot()).stateProjection,
        String((content as Record<string, unknown>).sceneId || ''),
      )
      : null;
    const currentBaseRevisionHash = currentCreativeSubjectBaseHash(data, subjectKind, subjectId);
    if (baseRevisionHash !== currentBaseRevisionHash) {
      throw new HttpError(409, 'baseRevisionHash is stale', {
        currentBaseRevisionHash,
      });
    }

    const computedContentHash = stableObjectHash(content);
    const suppliedContentHash = body.contentHash == null || body.contentHash === ''
      ? ''
      : assertSha256(body.contentHash, 'contentHash');
    if (suppliedContentHash && suppliedContentHash !== computedContentHash) {
      throw new HttpError(409, 'contentHash does not match the canonical creative content');
    }
    const contentHash = computedContentHash;
    const creativeRevisionId = `cr_${stableObjectHash({
      subjectKind,
      subjectId,
      baseRevisionHash,
      contentHash,
      authorityClass,
      evidenceRefs: refs,
      basisBindingsHash,
      adoptedMaterialSet,
      ...(requirementBased ? {planningContractVersion:'2.0',materialRequirementSet} : {}),
    }).slice(0, 32)}`;
    const criteriaVersion = subjectKind === 'EPISODE_PLAN' && (content as { episodes?: Array<{ reviewDossier: { schemaVersion: string } }> }).episodes?.every((episode) => episode.reviewDossier.schemaVersion === '1.1') ? '2.0' : undefined;
    const contextHash = stableObjectHash({ subjectKind, subjectId, baseRevisionHash, basisBindingsHash, ...(criteriaVersion ? { criteriaVersion } : {}) });
    const semanticRequest = {
      snapshotId,
      creationSnapshotId: snapshotId,
      creativeRevisionId,
      revisionId: creativeRevisionId,
      subjectKind,
      subjectId,
      baseRevisionHash,
      content,
      contentHash,
      contextHash,
      businessContextHash: contextHash,
      bindingVersion: '2.0',
      ...(criteriaVersion ? { criteriaVersion } : {}),
      ...(subjectKind==='EPISODE_PLAN'&&data.productionModel.systemConfiguration?(()=>{const c=data.productionModel.systemConfiguration.config;const spec=reviewSpec(c,'EPISODE_PLAN',{});return {reviewSpec:spec,configurationBinding:{key:`candidate:${creativeRevisionId}`,kind:'EPISODE_PLAN',reviewSpec:spec,technical:c.technical,workflow:c.workflow,sources:c.sources,configurationHash:configHash(c),createdBy:'CANDIDATE_REGISTRATION'}};})():{}),
      basisBindings: canonicalBasisBindings,
      ...(['SCENE_COVERAGE','SHOT_PLAN_SET'].includes(subjectKind) && (subjectKind==='SCENE_COVERAGE'?data.productionModel.sceneCoveragePlanRevisions:data.productionModel.shotPlanSetRevisions)?.some(row=>row.planId===subjectId&&row.episodeNarrativeReleaseId) ? {scopeType:'SCENE',scopeId:(content as {sceneId:string}).sceneId,scopedReviewSpec:scopedPlanningReviewSpec(subjectKind as 'SCENE_COVERAGE'|'SHOT_PLAN_SET', requirementBased ? '2.0' : '1.0')} : {}),
      basisBindingsHash,
      adoptedMaterialSet,
      ...(requirementBased ? {planningContractVersion:'2.0',materialRequirementSet} : {}),
      authorityClass,
      evidenceRefs: refs,
      note,
    };
    const { event, replayed, operations } = await appendEvent(
      'creative-revision',
      idempotencyKey,
      mutationRequestHash('creative-revision', semanticRequest),
      ifMatch,
      {
        ...semanticRequest,
        rawRequestHash,
        revisionState: 'CANDIDATE',
        adoptionPerformed: false,
      },
      '2.0',
      async (locked) => {
        if (subjectKind === 'EPISODE_PLAN') {
          const lockedContent = canonicalEpisodePlanContent(
            data,
            subjectId,
            rawContent,
            await episodePlanIdentityLedger(data),
          );
          if (stableObjectHash(lockedContent) !== contentHash) {
            throw new HttpError(409, 'EpisodePlan identity ledger changed before the candidate append; reload and retry');
          }
        }
        assertCreativeRevisionBasisCurrent(data, locked.stateProjection, semanticRequest, {
          requireCurrentPredecessor: true,
        });
      },
    );
    return jsonResponse({
      eventId: event.eventId,
      creativeRevisionId: event.creativeRevisionId,
      revisionId: event.creativeRevisionId,
      contentHash: event.contentHash,
      contextHash: event.contextHash,
      replayed,
      event,
      operationRevision: operations.operationRevision,
      operationalRevision: operations.operationalRevision,
      etag: operations.etag,
      mutationEtag: operations.mutationEtag,
    }, { status: replayed ? 200 : 201, headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'invalid creative revision event');
  }
}
