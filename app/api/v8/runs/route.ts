import { executionRuntimeReason, restoredRunUpdateAllowed, restoredUnresolvedRunsForWorkItem } from '../../../../host/instance-runtime/execution-epoch.mjs';
import { createHash } from 'node:crypto';
import {
  appendEvent,
  currentExecutionRuntime,
  assertStableId,
  assertSha256,
  errorResponse,
  eventLimit,
  HttpError,
  jsonResponse,
  listAllEvents,
  mutationRequestHash,
  optionalString,
  recipeCatalog,
  replayIdempotentEvent,
  validateMutationRequest,
  type EventRecord,
} from '../_store';
import {
  assertCallPackageHash,
  assertExecutionEligibility,
  assertExecutionRequestBinding,
  executionRequestId as parseExecutionRequestId,
  latestAggregateEvent,
  projectedExecutionRequests,
  unresolvedResultUnknownRunsForWorkItem,
} from '../_workflow';

const runStates = new Set(['PLANNED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_UNKNOWN']);
const transitions: Record<string, Set<string>> = {
  PLANNED: new Set(['PLANNED', 'SUBMITTED', 'CANCELLED']),
  SUBMITTED: new Set(['SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_UNKNOWN']),
  RUNNING: new Set(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_UNKNOWN']),
  RESULT_UNKNOWN: new Set(['RESULT_UNKNOWN', 'SUCCEEDED', 'FAILED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
};

function runState(event: EventRecord) {
  return String(event.runState || event.state || '');
}

function requestState(event: EventRecord) {
  return String(event.requestState || event.status || '');
}

type ReconciliationEvidence = {
  requestId: string;
  logId: string;
  providerStatusCheckedAt: string;
  providerConclusion: 'SUCCEEDED' | 'FAILED';
};

function reconciliationEvidence(value: unknown, terminalState: string): ReconciliationEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(422, 'resolving RESULT_UNKNOWN requires structured reconciliationEvidence');
  }
  const record = value as Record<string, unknown>;
  const requestId = optionalString(record.requestId, 1000);
  const logId = optionalString(record.logId, 1000);
  const providerStatusCheckedAt = optionalString(record.providerStatusCheckedAt, 100);
  const providerConclusion = optionalString(record.providerConclusion, 32);
  if (!requestId || !logId || !providerStatusCheckedAt || !providerConclusion) {
    throw new HttpError(422, 'reconciliationEvidence requires non-empty requestId, logId, providerStatusCheckedAt and providerConclusion');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(providerStatusCheckedAt)) {
    throw new HttpError(422, 'reconciliationEvidence.providerStatusCheckedAt must be an RFC3339 UTC timestamp');
  }
  const checkedAtMs = Date.parse(providerStatusCheckedAt);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > Date.now() + 5 * 60_000) {
    throw new HttpError(422, 'reconciliationEvidence.providerStatusCheckedAt is invalid or in the future');
  }
  if (!['SUCCEEDED', 'FAILED'].includes(providerConclusion) || providerConclusion !== terminalState) {
    throw new HttpError(422, 'reconciliationEvidence.providerConclusion must match the resolved terminal run state');
  }
  return {
    requestId,
    logId,
    providerStatusCheckedAt,
    providerConclusion: providerConclusion as ReconciliationEvidence['providerConclusion'],
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = eventLimit(url.searchParams.get('limit'));
    const definitionId = url.searchParams.get('executionDefinitionId');
    const executionRequestId = url.searchParams.get('executionRequestId');
    const runId = url.searchParams.get('runId');
    const state = url.searchParams.get('state');
    if (state && !runStates.has(state)) throw new HttpError(400, 'state is invalid');
    const events = (await listAllEvents('run'))
      .filter((event) => !definitionId || event.executionDefinitionId === definitionId)
      .filter((event) => !executionRequestId || event.executionRequestId === executionRequestId)
      .filter((event) => !runId || event.runId === runId)
      .filter((event) => !state || runState(event) === state)
      .slice(0, limit);
    return jsonResponse({ events, count: events.length });
  } catch (reason) {
    return errorResponse(reason, 'run events are unavailable');
  }
}

export async function POST(request: Request) {
  try {
    const { data, idempotencyKey, ifMatch } = await validateMutationRequest(request);
    const body = await request.json() as Record<string, unknown>;
    const rawRequestHash = mutationRequestHash('run', body);
    const replay = await replayIdempotentEvent('run', idempotencyKey, rawRequestHash);
    if (replay) {
      return jsonResponse({
        eventId: replay.event.eventId,
        runId: replay.event.runId,
        state: replay.event.runState,
        replayed: true,
        event: replay.event,
        operationRevision: replay.operations.operationRevision,
        operationalRevision: replay.operations.operationalRevision,
        etag: replay.operations.etag,
        mutationEtag: replay.operations.mutationEtag,
      }, { headers: { ETag: replay.operations.etag } });
    }
    const snapshotId = assertStableId(body.snapshotId, 'snapshotId', 200);
    const executionRequestId = parseExecutionRequestId(body.executionRequestId);
    const executionDefinitionId = assertStableId(body.executionDefinitionId, 'executionDefinitionId');
    const state = assertStableId(body.state, 'state', 40);
    const providerRunId = optionalString(body.providerRunId, 500);
    const note = optionalString(body.note, 20_000);
    const suppliedReconciliationEvidence = body.reconciliationEvidence;
    const suppliedRunId = body.runId == null || body.runId === '' ? '' : assertStableId(body.runId, 'runId', 200);
    if (!runStates.has(state)) throw new HttpError(400, 'invalid run state');
    if (suppliedRunId && !suppliedRunId.startsWith('run_')) throw new HttpError(400, 'runId is invalid');
    if (['FAILED', 'CANCELLED', 'RESULT_UNKNOWN'].includes(state) && !note) {
      throw new HttpError(400, `${state} requires a concrete note`);
    }

    const catalog = await recipeCatalog();
    const definition = catalog.executionDefinitions.find((item) => item.id === executionDefinitionId);
    const callPackageHash = assertSha256(body.callPackageHash, 'callPackageHash');
    const [requestEvents, candidateEvents] = await Promise.all([
      listAllEvents('execution-request'),
      listAllEvents('asset-version'),
    ]);
    const currentRequest = projectedExecutionRequests(requestEvents, candidateEvents)
      .find((event) => event.executionRequestId === executionRequestId) || null;
    if (!currentRequest) throw new HttpError(422, 'unknown executionRequestId');
    const runtimeBlocked = executionRuntimeReason(await currentExecutionRuntime(), currentRequest);
    if (!runtimeBlocked) {
      if (snapshotId !== data.snapshotId) throw new HttpError(412, 'body snapshotId does not match the current base snapshot');
      if (!definition) throw new HttpError(422, 'unknown executionDefinitionId');
      assertCallPackageHash(callPackageHash, definition);
    }
    assertExecutionRequestBinding(currentRequest, { executionRequestId, executionDefinitionId, callPackageHash });
    if (currentRequest.snapshotId !== snapshotId) throw new HttpError(409, 'execution request belongs to another base snapshot');
    const currentRequestState = requestState(currentRequest);
    if (!['AUTHORIZED', 'CLAIMED'].includes(currentRequestState)) {
      throw new HttpError(409, `execution request in ${currentRequestState} cannot start or update a run`);
    }
    if (currentRequest.executor === 'CODEX' && currentRequestState !== 'CLAIMED') {
      throw new HttpError(409, 'CODEX must claim the execution request before reporting a run');
    }

    const runId = suppliedRunId || `run_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
    const existingRunEvents = (await listAllEvents('run')).filter((event) => event.runId === runId);
    const previous = existingRunEvents[0] || null;
    if (previous) {
      if (previous.executionRequestId !== executionRequestId || previous.executionDefinitionId !== executionDefinitionId) {
        throw new HttpError(409, 'runId is already bound to another execution request or definition');
      }
      if (previous.callPackageHash !== callPackageHash) throw new HttpError(409, 'runId is bound to another call package');
      if (previous.providerRunId && providerRunId && previous.providerRunId !== providerRunId) {
        throw new HttpError(409, 'providerRunId cannot change within one run');
      }
    }
    const previousStateBeforeLock = previous ? runState(previous) : '';
    const normalizedReconciliationEvidence = (previousStateBeforeLock === 'RESULT_UNKNOWN' || (previous && runtimeBlocked)) && ['SUCCEEDED', 'FAILED'].includes(state)
      ? reconciliationEvidence(suppliedReconciliationEvidence, state)
      : null;
    if (suppliedReconciliationEvidence != null && normalizedReconciliationEvidence == null) {
      throw new HttpError(422, 'reconciliationEvidence is only valid when resolving an uncertain or restored historical run to SUCCEEDED or FAILED');
    }
    const effectiveProviderRunId = providerRunId || String(previous?.providerRunId || '');
    const semanticRequest = {
      snapshotId,
      executionRequestId,
      runId,
      executionDefinitionId,
      executionDefinitionHash: callPackageHash,
      promptRevisionId: currentRequest.promptRevisionId || (typeof definition?.currentRevisionId === 'string' ? definition.currentRevisionId : ''),
      callPackageHash,
      inputBindingsHash: currentRequest.inputBindingsHash,
      state,
      providerRunId: effectiveProviderRunId,
      note,
      reconciliationEvidence: normalizedReconciliationEvidence,
    };
    const { event, replayed, operations } = await appendEvent(
      'run',
      idempotencyKey,
      mutationRequestHash('run', semanticRequest),
      ifMatch,
      { ...semanticRequest, rawRequestHash, runState: state, modelInvocationPerformedByReviewSite: false },
      '2.0',
      async (locked) => {
        const lockedRequest = projectedExecutionRequests(locked.executionRequests.events, locked.candidates.events)
          .find((item) => item.executionRequestId === executionRequestId) || null;
        if (!lockedRequest) throw new HttpError(422, 'unknown executionRequestId');
        const runtimeReason = executionRuntimeReason(locked.executionRuntime, lockedRequest);
        const currentCatalog = await recipeCatalog();
        const lockedDefinition = currentCatalog.executionDefinitions.find((item) => item.id === executionDefinitionId);
        if (!runtimeReason && (!lockedDefinition || lockedDefinition.definitionHash !== callPackageHash)) {
          throw new HttpError(409, 'run call package changed while the update was in flight');
        }
        assertExecutionRequestBinding(lockedRequest, { executionRequestId, executionDefinitionId, callPackageHash });
        const lockedRequestState = requestState(lockedRequest);
        if (!['AUTHORIZED', 'CLAIMED'].includes(lockedRequestState)) {
          throw new HttpError(409, `execution request in ${lockedRequestState} cannot update a run`);
        }
        if (lockedRequest.executor === 'CODEX' && lockedRequestState !== 'CLAIMED') {
          throw new HttpError(409, 'CODEX must claim the execution request before reporting a run');
        }
        const lockedPrevious = latestAggregateEvent(locked.runs.events, 'runId', runId);
        if (!restoredRunUpdateAllowed(locked.executionRuntime, lockedRequest, lockedPrevious ? runState(lockedPrevious) : '', state, normalizedReconciliationEvidence != null)) {
          throw new HttpError(409, 'restored execution request cannot start, retry or advance execution; reconcile old evidence and create a new explicit authorization', { reasonCode: runtimeReason });
        }
        if (!lockedPrevious) {
          const workItemId = String(lockedRequest.workItemId || '');
          const unresolvedRuns = unresolvedResultUnknownRunsForWorkItem(
            locked.executionRequests.events,
            locked.runs.events,
            workItemId,
          ).concat(restoredUnresolvedRunsForWorkItem(locked.executionRuntime, locked.executionRequests.events, locked.runs.events, workItemId));
          if (unresolvedRuns.length) {
            throw new HttpError(409, 'work item has an unresolved RESULT_UNKNOWN or restored pending run; a new run is forbidden across requests, definitions and snapshots', {
              blockingRuns: unresolvedRuns.map((item) => ({
                runId: item.runId,
                executionRequestId: item.executionRequestId,
                snapshotId: item.snapshotId,
                executionDefinitionId: item.executionDefinitionId,
              })),
            });
          }
          if (!lockedDefinition) throw new HttpError(422, 'unknown executionDefinitionId');
          assertExecutionEligibility(locked, lockedDefinition, lockedRequest);
          if (!['PLANNED', 'SUBMITTED'].includes(state)) {
            throw new HttpError(409, `a new run cannot start at ${state}`);
          }
          const latestByRun = new Map<string, EventRecord>();
          for (const item of locked.runs.events) {
            const itemRunId = String(item.runId || '');
            if (itemRunId && !latestByRun.has(itemRunId)) latestByRun.set(itemRunId, item);
          }
          const blockingRun = [...latestByRun.values()].find((item) => (
            item.executionRequestId === executionRequestId
            && ['PLANNED', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'RESULT_UNKNOWN'].includes(runState(item))
          ));
          if (blockingRun) {
            throw new HttpError(409, 'execution request already has a non-retryable run', { runId: blockingRun.runId, state: runState(blockingRun) });
          }
          return;
        }
        const previousState = runState(lockedPrevious);
        const restoredReconciliation = Boolean(runtimeReason) && ['PLANNED', 'SUBMITTED', 'RUNNING', 'RESULT_UNKNOWN'].includes(previousState) && ['RESULT_UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(state);
        if (!restoredReconciliation && !transitions[previousState]?.has(state)) {
          throw new HttpError(409, `run cannot transition from ${previousState} to ${state}`);
        }
        if ((previousState === 'RESULT_UNKNOWN' || runtimeReason) && ['SUCCEEDED', 'FAILED'].includes(state)) {
          const lockedEvidence = reconciliationEvidence(suppliedReconciliationEvidence, state);
          if (JSON.stringify(lockedEvidence) !== JSON.stringify(normalizedReconciliationEvidence)) {
            throw new HttpError(409, 'RESULT_UNKNOWN reconciliation evidence changed while the update was in flight');
          }
        }
      },
    );
    return jsonResponse(
      {
        eventId: event.eventId,
        runId: event.runId,
        state: event.runState,
        replayed,
        event,
        operationRevision: operations.operationRevision,
        operationalRevision: operations.operationalRevision,
        etag: operations.etag,
        mutationEtag: operations.mutationEtag,
      },
      { status: replayed ? 200 : 201, headers: { ETag: operations.etag } },
    );
  } catch (reason) {
    return errorResponse(reason, 'invalid run event');
  }
}
