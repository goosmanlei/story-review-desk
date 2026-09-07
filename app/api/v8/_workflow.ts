import {
  assertJsonArray,
  assertSha256,
  assertStableId,
  HttpError,
  projectedExecutionRequests,
  type EventRecord,
  type RecipeCatalog,
  type ReviewData,
  stableObjectHash,
} from './_store';

export { projectedExecutionRequests };

export const executionRequestStatuses = new Set(['AUTHORIZED', 'CLAIMED', 'FULFILLED', 'CANCELLED', 'EXPIRED']);
export const executionRequestExecutors = new Set(['CODEX', 'USER_EXTERNAL']);

type Definition = RecipeCatalog['executionDefinitions'][number];

export type InputBinding = {
  order: number;
  path: string;
  assetFamilyRef: string;
  assetVersionRef: string;
  sha256: string;
};

function record(value: unknown, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${name} must be an object`);
  return value as Record<string, unknown>;
}

export function latestAggregateEvent(events: EventRecord[], field: string, id: string) {
  return events.find((event) => event[field] === id) || null;
}

export function unresolvedResultUnknownRunsForWorkItem(
  requestEvents: EventRecord[],
  runEvents: EventRecord[],
  workItemId: string,
) {
  // Both event arrays are newest-first.  Resolve the work-item binding through
  // every historical execution request, rather than only the current snapshot
  // or the definition that happens to be active now.  This prevents rebuilding
  // the snapshot / definition (or cancelling an old lease) from laundering an
  // unknown provider result into a retryable state.
  const requestWorkItems = new Map<string, string>();
  for (const event of requestEvents) {
    const requestId = String(event.executionRequestId || '');
    if (requestId && !requestWorkItems.has(requestId)) {
      requestWorkItems.set(requestId, String(event.workItemId || ''));
    }
  }
  const runsById = new Map<string, EventRecord[]>();
  for (const event of runEvents) {
    const runId = String(event.runId || '');
    if (!runId) continue;
    const history = runsById.get(runId) || [];
    history.push(event);
    runsById.set(runId, history);
  }
  const unresolved: EventRecord[] = [];
  for (const history of runsById.values()) {
    const latest = history[0];
    const requestId = String(latest.executionRequestId || '');
    if (requestWorkItems.get(requestId) !== workItemId) continue;
    const unknown = history.find((event) => String(event.runState || event.state || '') === 'RESULT_UNKNOWN');
    if (!unknown) continue;
    const latestState = String(latest.runState || latest.state || '');
    if (latestState === 'RESULT_UNKNOWN') {
      unresolved.push(latest);
      continue;
    }
    const evidence = latest.reconciliationEvidence;
    const record = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? evidence as Record<string, unknown>
      : {};
    const checkedAt = String(record.providerStatusCheckedAt || '');
    const checkedAtMs = Date.parse(checkedAt);
    const reconciled = ['SUCCEEDED', 'FAILED'].includes(latestState)
      && ['requestId', 'logId', 'providerStatusCheckedAt', 'providerConclusion']
        .every((field) => typeof record[field] === 'string' && Boolean(String(record[field]).trim()))
      && record.providerConclusion === latestState
      && Number.isFinite(checkedAtMs)
      && checkedAtMs <= Date.now() + 5 * 60_000;
    if (!reconciled) {
      unresolved.push({
        ...unknown,
        attemptedResolutionEventId: latest.eventId,
        attemptedResolutionState: latestState,
      });
    }
  }
  return unresolved;
}

export function definitionForWorkItem(data: ReviewData, catalog: RecipeCatalog, workItemId: string) {
  const workItem = [...data.productionModel.workItems, ...(data.productionModel.materialWorkItems || [])]
    .find((item) => item.id === workItemId);
  if (!workItem) throw new HttpError(422, 'unknown workItemId');
  if (!workItem.executionDefinitionRef) throw new HttpError(422, 'work item has no execution definition');
  const definition = catalog.executionDefinitions.find((item) => item.id === workItem.executionDefinitionRef);
  if (!definition) throw new HttpError(422, 'work item execution definition is unavailable');
  if (definition.definitionStatus !== 'DEFINED') throw new HttpError(422, 'execution definition is not ready');
  if (definition.workItemRef && definition.workItemRef !== workItemId) {
    throw new HttpError(409, 'execution definition and work item binding diverge');
  }
  return { workItem, definition };
}

export function definitionHash(definition: Definition) {
  return assertSha256(definition.definitionHash, 'executionDefinition.definitionHash');
}

export function assertCallPackageHash(value: unknown, definition: Definition) {
  const supplied = assertSha256(value, 'callPackageHash');
  const current = definitionHash(definition);
  if (supplied !== current) {
    throw new HttpError(409, 'call package is stale; reload the current execution recipe', {
      currentCallPackageHash: current,
    });
  }
  return current;
}

export function canonicalInputBindings(
  data: ReviewData,
  definition: Definition,
  value: unknown,
  candidates: EventRecord[] = [],
): InputBinding[] {
  const supplied = assertJsonArray(value, 'inputBindings', 500, 500_000);
  const upload = definition.upload && typeof definition.upload === 'object' && !Array.isArray(definition.upload)
    ? definition.upload as Record<string, unknown>
    : {};
  const expected = Array.isArray(upload.items) ? upload.items : [];
  if (supplied.length !== expected.length) {
    throw new HttpError(422, 'inputBindings must exactly match the ordered recipe upload list');
  }

  const versionById = new Map<string, { sha256?: string | null }>(
    data.productionModel.assetVersions.map((item) => [item.id, item]),
  );
  for (const candidate of [...candidates].reverse()) {
    const versionId = String(candidate.versionId || '');
    const sha256 = String(candidate.sha256 || '');
    if (versionId && /^[a-f0-9]{64}$/i.test(sha256)) versionById.set(versionId, { sha256 });
  }
  return expected.map((rawExpected, index) => {
    const expectedItem = record(rawExpected, `executionDefinition.upload.items[${index}]`);
    const actualRaw = supplied[index];
    const actual = typeof actualRaw === 'string'
      ? { path: actualRaw }
      : record(actualRaw, `inputBindings[${index}]`);
    const order = Number(expectedItem.order ?? index + 1);
    const expectedPath = String(expectedItem.path || '');
    const expectedFamily = String(expectedItem.assetFamilyRef || '');
    const expectedVersion = String(expectedItem.assetVersionRef || '');
    const actualOrder = Number(actual.order ?? order);
    const actualPath = String(actual.path || '');
    const actualFamily = String(actual.assetFamilyRef || actual.familyId || '');
    const actualVersion = String(actual.assetVersionRef || actual.versionId || '');
    if (
      !Number.isInteger(order) || order < 1 || actualOrder !== order
      || actualPath !== expectedPath
      || (expectedFamily && actualFamily !== expectedFamily)
      || (expectedVersion && actualVersion !== expectedVersion)
    ) {
      throw new HttpError(422, `inputBindings[${index}] does not match the ordered recipe input`);
    }
    const version = expectedVersion ? versionById.get(expectedVersion) : null;
    const sha256 = version?.sha256 ? assertSha256(version.sha256, `inputBindings[${index}].sha256`) : '';
    if (expectedVersion && !sha256) {
      throw new HttpError(422, `inputBindings[${index}] references a version that is not materialized with SHA-256`);
    }
    if (actual.sha256 != null && String(actual.sha256).trim()) {
      const suppliedSha = assertSha256(actual.sha256, `inputBindings[${index}].sha256`);
      if (!sha256 || suppliedSha !== sha256) throw new HttpError(409, `inputBindings[${index}] SHA-256 is stale`);
    }
    return {
      order,
      path: expectedPath,
      assetFamilyRef: expectedFamily,
      assetVersionRef: expectedVersion,
      sha256,
    };
  });
}

export {executionEligibilityReasons} from '../../gate-evaluation';
import {executionEligibilityReasons,type EligibilitySnapshot} from '../../gate-evaluation';

export function assertExecutionEligibility(
  snapshot: EligibilitySnapshot,
  definition: Definition,
  request: Record<string, unknown>,
) {
  const reasons = executionEligibilityReasons(snapshot, definition, request);
  if (reasons.length) {
    throw new HttpError(422, 'execution authorization is no longer eligible', { eligibilityReasons: reasons });
  }
}

export function inputBindingsHash(bindings: InputBinding[]) {
  return stableObjectHash(bindings);
}

export function assertExecutionRequestBinding(
  event: EventRecord,
  fields: {
    executionRequestId: string;
    executionDefinitionId?: string;
    callPackageHash?: string;
    familyId?: string;
  },
) {
  if (!event || event.executionRequestId !== fields.executionRequestId) throw new HttpError(422, 'unknown executionRequestId');
  if (fields.executionDefinitionId && event.executionDefinitionId !== fields.executionDefinitionId) {
    throw new HttpError(409, 'executionRequestId is bound to another execution definition');
  }
  if (fields.callPackageHash && event.callPackageHash !== fields.callPackageHash) {
    throw new HttpError(409, 'executionRequestId is bound to another call package');
  }
  if (fields.familyId && event.familyId !== fields.familyId) {
    throw new HttpError(409, 'executionRequestId is bound to another asset family');
  }
  return event;
}

export function executionRequestId(value: unknown) {
  const id = assertStableId(value, 'executionRequestId', 300);
  if (!id.startsWith('xreq_')) throw new HttpError(400, 'executionRequestId is invalid');
  return id;
}
