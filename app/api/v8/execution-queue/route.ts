import {
  errorResponse,
  eventLimit,
  HttpError,
  jsonResponse,
  listAllEvents,
  operationalSnapshot,
  recipeCatalog,
  reviewData,
} from '../_store';
import {
  executionEligibilityReasons,
  executionRequestExecutors,
  executionRequestStatuses,
  projectedExecutionRequests,
} from '../_workflow';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const executor = url.searchParams.get('executor') || 'CODEX';
    const status = url.searchParams.get('status') || 'AUTHORIZED';
    const limit = eventLimit(url.searchParams.get('limit'));
    if (!executionRequestExecutors.has(executor)) throw new HttpError(400, 'executor is invalid');
    if (!executionRequestStatuses.has(status)) throw new HttpError(400, 'status is invalid');
    const [data, operations, catalog, events, candidates] = await Promise.all([
      reviewData(),
      operationalSnapshot(),
      recipeCatalog(),
      listAllEvents('execution-request'),
      listAllEvents('asset-version'),
    ]);
    const definitions = new Map(catalog.executionDefinitions.map((definition) => [definition.id, definition]));
    let excludedStale = 0;
    const items = projectedExecutionRequests(events, candidates)
      .filter((event) => event.executor === executor)
      .filter((event) => String(event.requestState || event.status || '') === status)
      .filter((event) => event.snapshotId === data.snapshotId)
      .filter((event) => {
        const definition = definitions.get(String(event.executionDefinitionId || ''));
        return Boolean(definition && definition.definitionHash === event.callPackageHash);
      })
      .filter((event) => {
        const definition = definitions.get(String(event.executionDefinitionId || ''));
        if (!definition) return false;
        const reasons = executionEligibilityReasons(operations, definition, event);
        if (!reasons.length) return true;
        excludedStale += 1;
        return false;
      })
      .slice(0, limit)
      .map((event) => ({
        ...event,
        lifecycleState: operations.stateProjection.workItemsById[String(event.workItemId || '')]?.lifecycleState
          || operations.stateProjection.materialWorkItemsById?.[String(event.workItemId || '')]?.lifecycleState
          || 'UNKNOWN',
        recipeUrl: `/api/v8/recipes/${encodeURIComponent(String(event.executionDefinitionId || ''))}`,
      }));
    return jsonResponse({
      snapshotId: data.snapshotId,
      executor,
      status,
      items,
      count: items.length,
      excludedStale,
      operationRevision: operations.operationRevision,
      etag: operations.etag,
      mutationEtag: operations.mutationEtag,
    }, { headers: { ETag: operations.etag } });
  } catch (reason) {
    return errorResponse(reason, 'execution queue is unavailable');
  }
}
