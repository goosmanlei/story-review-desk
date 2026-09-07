import { projectIdFor } from '../../instance-profile';
import { buildActionQueue, type ActionProgram, type ActionQueueItem, type ActionWorkstream } from './_action-queue';
import { operationalSnapshot, reviewData } from './_store';
import {productionDirectory} from './_production-directory';

export type JourneyScopeType = 'SCENE' | 'EPISODE' | 'PROJECT';

type UnknownRecord = Record<string, unknown>;

const programWorkstreams: Record<ActionProgram['id'], ActionWorkstream> = {
  EPISODE_PLAN: 'EPISODE_PLANNING',
  STORY_CONFIRMATION: 'STORY_CONFIRMATION',
  SCENE_COVERAGE: 'SCENE_COVERAGE',
  SHOT_PLAN_SET: 'SHOT_PLAN_SET',
  SHOT_INPUT_LOCK: 'SHOT_INPUT_LOCK',
};

function recordCount(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function actionMatchesScope(item: ActionQueueItem, scopeType: JourneyScopeType, scopeIds: Set<string>) {
  if (scopeType === 'PROJECT') return true;
  if (scopeType === 'EPISODE') return scopeIds.has(String(item.coordinates.episodeUid || ''))
    || scopeIds.has(String(item.coordinates.episodeId || ''));
  const scopeId = [...scopeIds][0];
  return item.coordinates.sceneId === scopeId
    || item.advisoryRefs.some((ref) => ref.type === 'SCENE' && ref.ref === scopeId);
}

function workMatchesScope(
  work: { episodeId?: string | null; episodeUid?: string | null; sceneId?: string | null },
  scopeType: JourneyScopeType,
  scopeIds: Set<string>,
) {
  if (scopeType === 'PROJECT') return true;
  if (scopeType === 'EPISODE') return scopeIds.has(String(work.episodeUid || ''))
    || scopeIds.has(String(work.episodeId || ''));
  return work.sceneId === [...scopeIds][0];
}

function explicitScopeRole(entity: UnknownRecord | null, productionGraph: UnknownRecord | undefined) {
  const value = entity?.scopeRole ?? productionGraph?.scopeRole;
  return typeof value === 'string' && value ? value : 'UNKNOWN';
}

function denominatorProjection(lock: UnknownRecord | null, expectedScopeType: string, expectedScopeId: string) {
  const lockState = String(lock?.lockState || lock?.scopeLockState || 'UNKNOWN');
  const denominatorState = String(lock?.denominatorState || 'UNKNOWN');
  const denominator = Number.isInteger(lock?.denominator) && Number(lock?.denominator) >= 0
    ? Number(lock?.denominator)
    : null;
  const known = Boolean(lock)
    && lockState === 'LOCKED'
    && denominatorState === 'KNOWN'
    && denominator !== null;
  const discoveredCount = Number.isInteger(lock?.discoveredCount) && Number(lock?.discoveredCount) >= 0
    ? Number(lock?.discoveredCount)
    : 0;
  return {
    state: known ? 'KNOWN' : 'UNKNOWN',
    denominatorState: known ? 'KNOWN' : 'UNKNOWN',
    value: known ? denominator : null,
    denominator: known ? denominator : null,
    discoveredCount,
    scopeType: expectedScopeType,
    scopeId: expectedScopeId,
    lockState,
    source: lock ? 'SCOPE_LOCK' : 'UNAVAILABLE',
    sourceRef: typeof lock?.id === 'string' ? lock.id : null,
    reasonCodes: known
      ? []
      : !lock
        ? ['SCOPE_LOCK_UNAVAILABLE']
        : lockState !== 'LOCKED'
          ? ['SCOPE_NOT_LOCKED']
          : ['DENOMINATOR_UNKNOWN'],
  };
}

function matchingScopeLock(
  locks: UnknownRecord[],
  scopeType: string,
  scopeId: string,
  phaseId: string,
  gateId?: string,
) {
  return locks.find((lock) => {
    if (String(lock.scopeType || '') !== scopeType || String(lock.scopeId || '') !== scopeId) return false;
    if (typeof lock.phaseId === 'string' && lock.phaseId !== phaseId) return false;
    if (gateId && typeof lock.gateId === 'string' && lock.gateId !== gateId) return false;
    if (gateId && Array.isArray(lock.gateIds) && !lock.gateIds.includes(gateId)) return false;
    return true;
  }) || null;
}

function projectedDenominators(
  projectId: string,
  locks: UnknownRecord[],
  scopeType: JourneyScopeType,
  scopeId: string,
  scopeAliases: string[],
  phaseId: string,
  gateId?: string,
) {
  const globalLock = matchingScopeLock(locks, 'PROJECT', projectId, phaseId, gateId);
  const scopeLock = [scopeId, ...scopeAliases]
    .map((candidate) => matchingScopeLock(locks, scopeType, candidate, phaseId, gateId))
    .find(Boolean) || null;
  return {
    globalDenominator: denominatorProjection(globalLock, 'PROJECT', projectId),
    scopeDenominator: denominatorProjection(scopeLock, scopeType, scopeId),
  };
}

function projectedStoryHandoff(
  scopeType: JourneyScopeType,
  scopeId: string,
  entity: UnknownRecord | null,
  operational: UnknownRecord | undefined,
) {
  if (scopeType === 'SCENE') {
    const sceneProjection = (operational?.sceneReleaseById as Record<string, UnknownRecord> | undefined)?.[scopeId];
    if (sceneProjection?.hasAppliedReviewEvent === true) return { ...sceneProjection, source: 'APPLIED_EVENT_PROJECTION' };
  }
  if (scopeType === 'PROJECT' && operational?.hasAppliedProjection === true) return { ...operational, source: 'APPLIED_EVENT_PROJECTION' };
  if (scopeType === 'EPISODE' && operational?.hasAppliedProjection === true) {
    const scoped = operational.episodeReleaseByUid as Record<string, UnknownRecord> | undefined;
    if (scoped && Object.keys(scoped).length) {
      const episode = scoped[scopeId];
      return episode ? {...episode, nextGateId: episode.canEnterProduction === true ? 'PG-01-01' : null}
        : {state:'UNKNOWN',canEnterProduction:false,nextGateId:null,reasonCodes:['EPISODE_NARRATIVE_RELEASE_REQUIRED'],source:'EPISODE_SCOPED_GATE'};
    }
    return {
      state: String(operational.state || 'UNKNOWN'),
      canEnterProduction: operational.canEnterEpisodeAssembly === true,
      nextGateId: operational.canEnterEpisodeAssembly === true ? 'PG-04-01' : null,
      reasonCodes: Array.isArray(operational.blockingReasons) ? operational.blockingReasons : ['STORY_HANDOFF_UNKNOWN'],
      source: 'APPLIED_EVENT_PROJECTION',
    };
  }
  const explicit = entity?.storyHandoff;
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    return { ...(explicit as UnknownRecord), source: 'BASE_SNAPSHOT_EXPLICIT' };
  }
  return {
    state: 'UNKNOWN',
    canEnterProduction: false,
    nextGateId: null,
    reasonCodes: ['STORY_HANDOFF_UNKNOWN'],
    source: 'UNAVAILABLE',
  };
}

export async function buildJourney(scopeType: JourneyScopeType, requestedScopeId: string) {
  const [data, operations, queue] = await Promise.all([reviewData(), operationalSnapshot(), buildActionQueue()]);
  if (queue.snapshotId !== data.snapshotId || queue.operationRevision !== operations.operationRevision) {
    throw new Error('journey projection sources changed during read');
  }
  const directory=productionDirectory(data,operations.creativeRevisions.events);
  const episodes = directory.episodes as unknown as UnknownRecord[];
  const scenes = directory.scenes as unknown as UnknownRecord[];
  const projection = operations.stateProjection as unknown as {
    configuredGatesByWorkItem?: Record<string,import("../../gate-evaluation").ConfiguredGate>;
    workItemsById: Record<string, Record<string, unknown> | undefined>;
    scopeLocksById?: Record<string, UnknownRecord | undefined>;
    storyHandoff?: UnknownRecord;
  };
  const scopeLocks = Object.values(projection.scopeLocksById || {})
    .filter((lock): lock is UnknownRecord => Boolean(lock));
  const requestedId = scopeType === 'PROJECT' ? requestedScopeId || projectIdFor(data) : requestedScopeId;
  const currentEpisodePlan = data.creativeLineage?.storyStructure?.planStatus === 'CURRENT';
  const episode = scopeType === 'EPISODE' ? episodes.find((entry) => (
    currentEpisodePlan || entry.identityMode==='PERMANENT_ONLY'
      ? [entry.canonicalScopeId, entry.episodeUid].includes(requestedId)
      : [entry.canonicalScopeId, entry.episodeUid, entry.id, entry.displayId].includes(requestedId)
  )) || null : null;
  const scene = scopeType === 'SCENE' ? scenes.find((entry) => entry.id === requestedId) || null : null;
  if (scopeType === 'EPISODE' && !episode) throw new Error(`unknown episode scope: ${requestedId}`);
  if (scopeType === 'SCENE' && !scene) throw new Error(`unknown scene scope: ${requestedId}`);
  const scopeId = scopeType === 'EPISODE'
    ? String(episode?.canonicalScopeId || episode?.episodeUid || episode?.id || requestedId)
    : requestedId;
  const displayEpisodeId = scopeType === 'EPISODE' ? String(episode?.displayId || episode?.id || '') : '';
  const scopeAliases = scopeType === 'EPISODE'
    ? currentEpisodePlan || episode?.identityMode==='PERMANENT_ONLY'
      ? [String(episode?.canonicalScopeId || ''), String(episode?.episodeUid || '')].filter(Boolean)
      : [String(episode?.episodeUid || ''), String(episode?.id || ''), String(episode?.displayId || '')].filter(Boolean)
    : [];
  const matchingScopeIds = new Set([scopeId, ...scopeAliases]);
  if (scopeType === 'PROJECT' && scopeId !== projectIdFor(data)) throw new Error(`unknown project scope: ${scopeId}`);
  const entity = scene || episode;

  const scopedActions = queue.items.filter((entry) => actionMatchesScope(entry, scopeType, matchingScopeIds));
  const scopedWorks = data.productionModel.workItems.filter((work) => (
    work.activeInCurrentProduction === true
    && projection.workItemsById[work.id]?.activeInCurrentProduction !== false
    && workMatchesScope(work, scopeType, matchingScopeIds)
  ));
  const gateComplete = (work: {id:string}) => { const gate = projection.configuredGatesByWorkItem?.[work.id]; return projection.workItemsById[work.id]?.canFlowDownstream === true && !gate?.entryReasons.length && !gate?.exitReasons.length; };
  const gateDefinitions = data.productionModel.productionGates || [];
  const phases = (data.productionModel.productionPhases || []).slice().sort((left, right) => left.order - right.order).map((phase) => {
    const works = scopedWorks.filter((work) => work.phaseId === phase.id);
    const actions = scopedActions.filter((entry) => entry.productionPhaseId === phase.id);
    const lifecycleStates = works.map((work) => String(projection.workItemsById[work.id]?.lifecycleState || work.lifecycleState || 'UNKNOWN'));
    const phaseDenominators = projectedDenominators(projectIdFor(data), scopeLocks, scopeType, scopeId, scopeAliases, phase.id);
    const gates = gateDefinitions
      .filter((gate) => gate.phaseId === phase.id)
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((gate) => {
        const gateWorks = works.filter((work) => work.gateId === gate.id);
        const gateActions = actions.filter((entry) => entry.productionGateId === gate.id);
        const gateLifecycleStates = gateWorks.map((work) => String(projection.workItemsById[work.id]?.lifecycleState || work.lifecycleState || 'UNKNOWN'));
        const gateDenominators = projectedDenominators(projectIdFor(data), scopeLocks, scopeType, scopeId, scopeAliases, phase.id, gate.id);
        return {
          id: gate.id,
          slug: gate.slug,
          order: gate.order,
          label: gate.label,
          purpose: gate.purpose || '',
          scopeType: gate.scopeType || 'UNKNOWN',
          denominatorState: gateDenominators.globalDenominator.denominatorState,
          denominator: gateDenominators.globalDenominator.denominator,
          ...gateDenominators,
          workItemCount: gateWorks.length,
          gateCompleteWorkItemCount: gateWorks.filter(gateComplete).length,
          workItemIds: gateWorks.map((work) => work.id),
          lifecycleCounts: recordCount(gateLifecycleStates),
          actionCounts: {
            actionable: gateActions.filter((entry) => entry.actionability === 'ACTIONABLE').length,
            waiting: gateActions.filter((entry) => entry.actionability === 'WAITING_DEPENDENCY').length,
            blocked: gateActions.filter((entry) => entry.actionability === 'BLOCKED').length,
          },
          candidateAvailabilityCounts: recordCount(gateActions.map((entry) => entry.candidateAvailability)),
          actionKeys: gateActions.map((entry) => entry.actionKey),
        };
      });
    return {
      id: phase.id,
      slug: phase.slug,
      order: phase.order,
      label: phase.label,
      purpose: phase.purpose || '',
      denominatorState: phaseDenominators.globalDenominator.denominatorState,
      denominator: phaseDenominators.globalDenominator.denominator,
      ...phaseDenominators,
      workItemCount: works.length,
      gateCompleteWorkItemCount: works.filter(gateComplete).length,
      workItemIds: works.map((work) => work.id),
      lifecycleCounts: recordCount(lifecycleStates),
      actionCounts: {
        actionable: actions.filter((entry) => entry.actionability === 'ACTIONABLE').length,
        waiting: actions.filter((entry) => entry.actionability === 'WAITING_DEPENDENCY').length,
        blocked: actions.filter((entry) => entry.actionability === 'BLOCKED').length,
      },
      candidateAvailabilityCounts: recordCount(actions.map((entry) => entry.candidateAvailability)),
      actionKeys: actions.map((entry) => entry.actionKey),
      gates,
    };
  });
  const programs = queue.programs.map((program) => {
    const workstream = programWorkstreams[program.id];
    const entries = scopedActions.filter((entry) => entry.workstream === workstream);
    return {
      ...program,
      totalCount: scopeType === 'PROJECT' ? program.totalCount : program.id === 'STORY_CONFIRMATION'
        ? scopeType === 'EPISODE'
            ? scenes.filter((entry) => matchingScopeIds.has(String(entry.episodeUid || '')) || matchingScopeIds.has(String(entry.episodeId || ''))).length
            : 1
        : entries.length,
      openCount: entries.length,
      actionableCount: entries.filter((entry) => entry.actionability === 'ACTIONABLE').length,
      waitingCount: entries.filter((entry) => entry.actionability === 'WAITING_DEPENDENCY').length,
      blockedCount: entries.filter((entry) => entry.actionability === 'BLOCKED').length,
      nextActionKey: entries.find((entry) => entry.actionability === 'ACTIONABLE')?.actionKey || entries[0]?.actionKey || null,
    };
  });
  const actionable = scopedActions.filter((entry) => entry.actionability === 'ACTIONABLE').length;
  const waiting = scopedActions.filter((entry) => entry.actionability === 'WAITING_DEPENDENCY').length;
  const blocked = scopedActions.filter((entry) => entry.actionability === 'BLOCKED').length;
  const currentProductionPhase = phases.find((phase) => phase.actionCounts.actionable > 0)
    || phases.find((phase) => phase.workItemCount > phase.gateCompleteWorkItemCount)
    || null;
  const currentProductionGate = currentProductionPhase?.gates.find((gate) => gate.actionCounts.actionable > 0)
    || currentProductionPhase?.gates.find((gate) => gate.workItemCount > gate.gateCompleteWorkItemCount)
    || null;
  const currentProductionPhaseId = currentProductionPhase?.id || null;
  const currentProductionGateId = currentProductionGate?.id || null;
  const currentPhaseDenominators = currentProductionPhase
    ? projectedDenominators(projectIdFor(data), scopeLocks, scopeType, scopeId, scopeAliases, currentProductionPhase.id, currentProductionGate?.id)
    : projectedDenominators(projectIdFor(data), scopeLocks, scopeType, scopeId, scopeAliases, 'UNKNOWN');
  const storyHandoff = projectedStoryHandoff(scopeType, scopeId, entity, projection.storyHandoff);
  return {
    schemaVersion: '1.2',
    projectionSource: 'ACTION_QUEUE_1.4',
    snapshotId: data.snapshotId,
    operationRevision: operations.operationRevision,
    etag: operations.etag,
    scope: {
      scopeType,
      scopeId,
      requestedScopeId: requestedId,
      scopeResolution: scopeType === 'EPISODE' && requestedId !== scopeId ? 'PROPOSAL_ALIAS' : 'CANONICAL',
      scopeRole: explicitScopeRole(entity, data.productionModel.productionGraph),
      label: scopeType === 'SCENE' ? `${scopeId} · ${String(scene?.title || '场次')}` : scopeType === 'EPISODE' ? `${displayEpisodeId} · ${Array.isArray(episode?.sceneIds) ? episode.sceneIds.length : 0}场` : '全剧',
      episodeId: scopeType === 'SCENE' ? scene?.episodeId : scopeType === 'EPISODE' ? displayEpisodeId : null,
      episodeUid: scopeType === 'SCENE' ? scene?.episodeUid : scopeType === 'EPISODE' ? episode?.episodeUid : null,
    },
    storyHandoff,
    globalDenominator: currentPhaseDenominators.globalDenominator,
    scopeDenominator: currentPhaseDenominators.scopeDenominator,
    summary: {
      currentProductionPhaseId,
      currentProductionGateId,
      actionCount: scopedActions.length,
      actionable,
      waiting,
      blocked,
      workItemCount: scopedWorks.length,
    },
    programs,
    phases,
    actions: scopedActions,
  };
}
